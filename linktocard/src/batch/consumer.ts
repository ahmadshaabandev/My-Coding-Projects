/**
 * The bulk-documents queue consumer: the logic behind the Worker's queue() handler. It renders
 * the rows named by each BatchQueueMessage through an injected BatchRender (in production a thin
 * wrapper of getPdf with source "batch", so each row is rendered and charged exactly like a
 * POST /v1/pdf), and it never throws.
 *
 * Why it is shaped like this (Cloudflare Queues facts from the research notes,
 * scratchpad/prep/research/queues.md, read from the cloudflare-docs source on 2026-11-26):
 *
 *   - Delivery is at least once and a message can arrive twice, in any order. So a row is
 *     claimed in D1 before it is rendered (src/batch/store.ts): a row that is done, failed or
 *     cancelled is skipped, one that another consumer is rendering right now is left to it, and
 *     only the claim holder may finish it. A row is therefore never rendered twice at once and
 *     never again once finished. A consumer that dies after its render was charged but before it
 *     marked the row leaves a claim that times out; the next claim renders again and finds the
 *     PDF stored (getPdf's R2 cache), so nothing is charged twice.
 *   - If queue() throws, the whole batch of messages is retried, and a message whose retries run
 *     out is deleted without a trace (there is no dead-letter queue). So every message is acked or
 *     retried explicitly, errors are caught per message, and the consumer gives up on a row
 *     itself (marks it failed, acks) before the platform would drop its message: at
 *     BatchQueueSettings.maxRowAttempts renders of the row, or on the message's last delivery.
 *   - Only Browser Run failing or being busy (and our own transient failures) is retried, with
 *     a growing delay. A document error fails the row at once; a quota error fails the row and
 *     every row still queued with quota_exceeded, so the batch ends partial (the contract).
 *   - Browser Run on Workers Paid allows 30 quick actions per second (browser-run/limits), shared
 *     by staging, production and interactive PDFs. Rows are rendered one after another, and each
 *     rendered row takes at least minRowMs, so one environment stays at max_concurrency rows per
 *     second at most.
 *   - The kill switches stop spending: with BATCH_ENABLED or PDFs off, a message's rows fail with
 *     not_configured, uncharged, instead of rendering (a row being rendered right then finishes).
 */
import { getUserById } from '../db/client';
import { ApiError, isApiError } from '../lib/errors';
import { featureEnabled } from '../lib/features';
import type { Background } from '../lib/http';
import { pdfEnabled } from '../pdf/render';
import type { BatchQueueMessage, Env, UserRow } from '../types';
import { verificationFields } from './certificates';
import { cancelClaimedRow, claimRow, completeRow, failQueuedRows, failRow, releaseRow, type ClaimedRow, type RowClaim } from './store';
import type { BatchQueueSettings, BatchRecord, BatchRender, BatchRenderResult, RowError, RowFailureCause } from './types';

/** Longest delay Queues accepts for a message or a retry: 24 hours (queues/platform/limits). */
const QUEUES_MAX_DELAY_SECONDS = 86_400;
/** A render that threw: the row fails, or goes back to the queue when the cause is worth another try. */
async function renderFailed(ctx: RowContext, batch: BatchRecord, row: ClaimedRow, key: RowClaim, thrown: unknown): Promise<Outcome> {
  const { env, deps } = ctx;
  const { failure, error, retryAfterSeconds } = classifyRowError(thrown);
  if (failure === 'quota') {
    await failRow(env.DB, key, error, deps.now());
    await failQueuedRows(env.DB, batch.id, error, deps.now());
    return { kind: 'ack' };
  }
  const decision = retryDecision(failure, row.attempts, ctx.messageAttempts, deps.settings, retryAfterSeconds);
  if (decision.retry && (await releaseRow(env.DB, key, error))) return { kind: 'retry', delaySeconds: decision.delaySeconds };
  await failRow(env.DB, key, error, deps.now());
  return { kind: 'ack' };
}

/**
 * Marks a rendered row done. A D1 failure here comes after the charge (review BQ-2), so it is not
 * a render failure: completeRow is tried again, then the row goes back to the queue carrying what
 * it was charged (the delivery that finds its PDF stored, charged 0, reports that instead), or,
 * with no tries left, fails with a message that says it was counted. Should those writes fail too,
 * the error reaches the message: it is retried and the row stays claimed until its claim times out.
 */
async function recordRow(ctx: RowContext, batch: BatchRecord, row: ClaimedRow, key: RowClaim, result: BatchRenderResult): Promise<Outcome> {
  const { env, deps } = ctx;
  const certificate = batch.verify && row.certificateId !== null ? { id: row.certificateId, userId: batch.userId, data: row.data } : null;
  let lastError: unknown;
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
    try {
      if (!(await completeRow(env.DB, key, result, deps.now(), certificate))) {
        console.error(`batch ${batch.id} row ${row.index}: claim ${key.attempt} was lost before the row was marked done`);
      }
      return { kind: 'ack' };
    } catch (error) {
      lastError = error;
    }
  }
  console.error(`batch ${batch.id} row ${row.index}: the PDF was made (${result.creditsUsed} images) but the row could not be marked done:`, lastError);
  const decision = retryDecision('provider', row.attempts, ctx.messageAttempts, deps.settings, null);
  if (decision.retry && (await releaseRow(env.DB, key, RECORD_RETRY_ERROR, result.creditsUsed))) return { kind: 'retry', delaySeconds: decision.delaySeconds };
  await failRow(env.DB, key, RECORD_FAILED_ERROR, deps.now(), result.creditsUsed);
  return { kind: 'ack' };
}

/** Message bodies are ours, but a malformed one must not be retried forever. */
const BATCH_ID_RE = /^bat_[0-9a-z]{1,64}$/;
const MAX_ROWS_PER_MESSAGE = 100;

export const SWITCHED_OFF_ERROR: RowError = {
  code: 'not_configured',
  message: 'Bulk documents were switched off before this row was rendered. Nothing was charged for it.',
};
const ACCOUNT_UNAVAILABLE_ERROR: RowError = {
  code: 'account_suspended',
  message: 'The account is suspended or being deleted, so this row was not rendered. Nothing was charged for it.',
};
const INTERNAL_ROW_ERROR: RowError = {
  code: 'internal_error',
  message: 'Something went wrong on our side while rendering this row. Nothing was charged for it.',
};
/**
 * The row's PDF was made and charged, but marking the row done failed (D1). Never INTERNAL_ROW_ERROR:
 * that says nothing was charged (review BQ-2).
 */
export const RECORD_RETRY_ERROR: RowError = {
  code: 'internal_error',
  message: 'The PDF of this row was made and counted, but an error on our side kept it from being recorded in the batch. It is being recorded again and is not charged again.',
};
export const RECORD_FAILED_ERROR: RowError = {
  code: 'internal_error',
  message:
    'The PDF of this row was made and counted, but an error on our side kept it from being recorded in the batch, so the batch has no link to it. Contact support with the batch id and the row number.',
};
/** completeRow tries per render; it is guarded by the claim's attempt, so running it again is safe. */
const RECORD_ATTEMPTS = 2;

/**
 * A render failure that names its cause, for a render function that knows better than the
 * error code (for example a provider failure reported as render_failed).
 */
export class BatchRowError extends Error {
  readonly failure: RowFailureCause;
  readonly error: ApiError;

  constructor(failure: RowFailureCause, error: ApiError) {
    super(error.message);
    this.name = 'BatchRowError';
    this.failure = failure;
    this.error = error;
  }
}

export interface ClassifiedFailure {
  failure: RowFailureCause;
  error: RowError;
  /** The renderer's own "retry after" (a busy Browser Run says 10 s), when it gave one. */
  retryAfterSeconds: number | null;
}

/** Error codes that mean "later" or "not us": everything else an ApiError says is final. */
const CAUSE_BY_CODE: Partial<Record<ApiError['code'], RowFailureCause>> = {
  quota_exceeded: 'quota',
  // Browser Run's 429, the failed-render cap, the free brake and the Free render rate limit.
  rate_limited: 'busy',
  // Browser Run failed or could not be reached (src/pdf/render.ts failureCause: 'provider').
  render_failed: 'provider',
  internal_error: 'provider',
  not_configured: 'stop',
};

/** The error's own wait: details.retry_after_seconds, else its Retry-After header (seconds). */
function retryAfterOf(error: ApiError): number | null {
  const detail = error.details?.retry_after_seconds;
  const seconds = typeof detail === 'number' ? detail : Number(error.headers?.['retry-after'] ?? Number.NaN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * What a thrown render error means for the row. An ApiError's message is customer-facing and is
 * kept; anything else is our bug or an outage, logged here and shown as a generic message.
 */
export function classifyRowError(error: unknown): ClassifiedFailure {
  if (error instanceof BatchRowError) {
    return { failure: error.failure, error: { code: error.error.code, message: error.error.message }, retryAfterSeconds: retryAfterOf(error.error) };
  }
  if (isApiError(error)) {
    return { failure: CAUSE_BY_CODE[error.code] ?? 'document', error: { code: error.code, message: error.message }, retryAfterSeconds: retryAfterOf(error) };
  }
  console.error('batch row render failed unexpectedly:', error);
  return { failure: 'provider', error: INTERNAL_ROW_ERROR, retryAfterSeconds: null };
}

export type RetryDecision = { retry: true; delaySeconds: number } | { retry: false };

/**
 * Whether a failed row is tried again: only for a provider or busy cause, only while the row has
 * had fewer than maxRowAttempts renders, and never on the message's last delivery (a retry()
 * then would delete the message and strand the row). The delay grows with the row's attempts
 * (attempt n waits n x retryDelaySeconds), or is the renderer's own retry-after when longer.
 *
 * A retry-after longer than the row's whole retry budget (maxRowAttempts x retryDelaySeconds)
 * fails the row now instead: the failed-render cap says "after 00:00 UTC" and the Free brake an
 * hour, and a batch should end with that message rather than sit unfinished for hours. The Free
 * render rate limit (a minute) and a busy Browser Run (seconds) are waited out.
 */
export function retryDecision(
  failure: RowFailureCause,
  rowAttempts: number,
  messageAttempts: number,
  settings: Pick<BatchQueueSettings, 'maxRowAttempts' | 'queueMaxRetries' | 'retryDelaySeconds'>,
  retryAfterSeconds: number | null = null,
): RetryDecision {
  if (failure !== 'provider' && failure !== 'busy') return { retry: false };
  if (rowAttempts >= settings.maxRowAttempts || isLastDelivery(messageAttempts, settings)) return { retry: false };
  if ((retryAfterSeconds ?? 0) > settings.maxRowAttempts * settings.retryDelaySeconds) return { retry: false };
  return { retry: true, delaySeconds: clampDelay(Math.max(settings.retryDelaySeconds * rowAttempts, retryAfterSeconds ?? 0)) };
}

/** Message.attempts starts at 1; the platform delivers a message max_retries + 1 times at most. */
export function isLastDelivery(messageAttempts: number, settings: Pick<BatchQueueSettings, 'queueMaxRetries'>): boolean {
  return messageAttempts > settings.queueMaxRetries;
}

function clampDelay(seconds: number): number {
  return Math.min(QUEUES_MAX_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));
}

export function isBatchQueueMessage(body: unknown): body is BatchQueueMessage {
  if (typeof body !== 'object' || body === null) return false;
  const { batchId, rows } = body as Partial<BatchQueueMessage>;
  return (
    typeof batchId === 'string' &&
    BATCH_ID_RE.test(batchId) &&
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= MAX_ROWS_PER_MESSAGE &&
    rows.every((row) => Number.isSafeInteger(row) && row >= 0)
  );
}

/* ------------------------------------------------------------------ */
/* The handler                                                         */
/* ------------------------------------------------------------------ */

export interface BatchConsumerDeps {
  render: BatchRender;
  settings: BatchQueueSettings;
  /** Clock and sleep, replaceable in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** What to do with a message once its rows were handled. */
type Outcome = { kind: 'ack' } | { kind: 'retry'; delaySeconds: number };

interface RowContext {
  env: Env;
  deps: Required<BatchConsumerDeps>;
  background: Background;
  messageAttempts: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The queue() handler's body: every message is acked or retried here, and nothing is thrown.
 * Messages are handled one after another (rows must not render in parallel: Browser Run's rate).
 */
export async function consumeBatchMessages(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext, deps: BatchConsumerDeps): Promise<void> {
  const full: Required<BatchConsumerDeps> = { now: Date.now, sleep: defaultSleep, ...deps };
  // waitUntil work that rejects would make the platform retry the whole batch: it is logged instead.
  const background: Background = (work) => ctx.waitUntil(work.catch((error: unknown) => console.error('batch background work failed:', error)));
  for (const message of batch.messages) {
    let outcome: Outcome;
    try {
      outcome = await handleMessage(message.body, { env, deps: full, background, messageAttempts: message.attempts });
    } catch (error) {
      // D1 or the queue itself failed; a claimed row stays claimed and times out (store.ts).
      console.error(`batch queue message ${message.id} failed (delivery ${message.attempts}):`, error);
      outcome = isLastDelivery(message.attempts, full.settings)
        ? { kind: 'ack' }
        : { kind: 'retry', delaySeconds: clampDelay(full.settings.retryDelaySeconds * message.attempts) };
    }
    if (outcome.kind === 'retry') message.retry({ delaySeconds: outcome.delaySeconds });
    else message.ack();
  }
}

async function handleMessage(body: unknown, ctx: RowContext): Promise<Outcome> {
  if (!isBatchQueueMessage(body)) {
    console.error('batch queue: dropping a message that is not a BatchQueueMessage:', JSON.stringify(body)?.slice(0, 200));
    return { kind: 'ack' };
  }
  const { env, deps } = ctx;
  if (!featureEnabled(env, 'batch') || !pdfEnabled(env)) {
    // Claimed first, so a row whose consumer died is failed too; one being rendered is left to it.
    for (const index of body.rows) {
      const claim = await claimRow(env.DB, body.batchId, index, deps.now(), deps.settings.claimTimeoutMinutes * 60_000);
      if (claim.kind === 'claimed') await failRow(env.DB, { batchId: body.batchId, index, attempt: claim.row.attempts }, SWITCHED_OFF_ERROR, deps.now());
    }
    return { kind: 'ack' };
  }
  // Rows of one message share its fate: retried rows come back with the message, and the rows
  // that finished are skipped then. The longest delay any row asked for wins.
  let delaySeconds: number | null = null;
  for (const index of body.rows) {
    const outcome = await handleRow(body.batchId, index, ctx);
    if (outcome.kind === 'retry') delaySeconds = Math.max(delaySeconds ?? 0, outcome.delaySeconds);
  }
  return delaySeconds === null ? { kind: 'ack' } : { kind: 'retry', delaySeconds };
}

async function handleRow(batchId: string, index: number, ctx: RowContext): Promise<Outcome> {
  const { env, deps } = ctx;
  const timeoutMs = deps.settings.claimTimeoutMinutes * 60_000;
  const claimedAt = deps.now();
  const claim = await claimRow(env.DB, batchId, index, claimedAt, timeoutMs);
  if (claim.kind === 'missing' || claim.kind === 'finished') return { kind: 'ack' };
  if (claim.kind === 'held') {
    // Another consumer is rendering it, or a dead one held it: look again once its claim times out.
    if (isLastDelivery(ctx.messageAttempts, deps.settings)) {
      console.error(`batch ${batchId} row ${index}: still claimed on the message's last delivery; left to its claim holder or the daily sweep`);
      return { kind: 'ack' };
    }
    return { kind: 'retry', delaySeconds: clampDelay((claim.claimedAt + timeoutMs - claimedAt) / 1000 + 1) };
  }
  const { batch, row } = claim;
  const key: RowClaim = { batchId, index, attempt: row.attempts };
  if (batch.status === 'cancelled') {
    await cancelClaimedRow(env.DB, key, deps.now());
    return { kind: 'ack' };
  }
  const user = await getUserById(env.DB, batch.userId);
  if (!user || user.suspended_at !== null || user.deletion_requested_at !== null) {
    await failRow(env.DB, key, ACCOUNT_UNAVAILABLE_ERROR, deps.now());
    return { kind: 'ack' };
  }
  return renderRow(ctx, batch, row, key, user);
}

async function renderRow(ctx: RowContext, batch: BatchRecord, row: ClaimedRow, key: RowClaim, user: UserRow): Promise<Outcome> {
  const { env, deps } = ctx;
  // The verification fields are trusted values, added after the row's data (decision D13).
  const verification = batch.verify && row.certificateId !== null ? verificationFields(env.APP_URL, row.certificateId) : null;
  const started = deps.now();
  let cached = false;
  try {
    let result: BatchRenderResult;
    try {
      result = await deps.render(env, {
        user,
        batch,
        row: { index: row.index, filename: row.filename, certificateId: row.certificateId },
        data: row.data,
        verification,
        now: started,
        background: ctx.background,
      });
    } catch (thrown) {
      return await renderFailed(ctx, batch, row, key, thrown);
    }
    cached = result.cached;
    // From here the PDF exists and is paid for: only the bookkeeping is left, apart from the render's errors.
    return await recordRow(ctx, batch, row, key, result);
  } finally {
    // Pacing: a row that may have reached the browser takes at least minRowMs.
    if (!cached) {
      const wait = deps.settings.minRowMs - (deps.now() - started);
      if (wait > 0) await deps.sleep(wait);
    }
  }
}
