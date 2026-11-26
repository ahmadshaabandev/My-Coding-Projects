// Helpers for the bulk-documents tests (src/batch): settings, a recording queue producer, a
// scripted render function, stored batches and driving the consumer with cloudflare:test.
//
// The test pool runs the REAL local queue from the top-level wrangler.toml once the integrator
// adds it: a send() would reach the Worker's queue() in the background with the pool's own env.
// So these tests never use env.BATCH_QUEUE: producers get recordingQueue(), and the consumer is
// called directly with createMessageBatch (research notes, section 9).
import { createExecutionContext, createMessageBatch, getQueueResult, type QueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi, type MockInstance } from 'vitest';
import type { PlanId } from '../src/billing/plans';
import { BATCH } from '../src/config';
import { consumeBatchMessages, type BatchConsumerDeps } from '../src/batch/consumer';
import { parseBatchRequest } from '../src/batch/rows';
import { createBatch } from '../src/batch/store';
import type { BatchQueueSettings, BatchRecord, BatchRender, BatchRenderRequest, BatchRenderResult, ParsedBatchRequest } from '../src/batch/types';
import { ApiError } from '../src/lib/errors';
import type { JsonObject } from '../src/lib/http';
import type { BatchQueueMessage, Env, UserRow } from '../src/types';
import { createUser } from './app-helpers';
import { mockBrowser } from './pdf-helpers';

export const QUEUE_NAME = 'linktocard-batch-dev';
export const DAY = 24 * 60 * 60 * 1000;

/** The Worker's own settings (BATCH in src/config.ts), with minRowMs 0 so tests do not wait (pacing has its own test). */
export const SETTINGS: BatchQueueSettings = { ...BATCH, minRowMs: 0 };

/** The env a consumer sees with bulk documents and PDFs switched on (a mock Browser Run binding). */
export function batchEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, PDF_ENABLED: 'true', BATCH_ENABLED: 'true', BROWSER: mockBrowser().binding, ...overrides };
}

/** A producer binding that records what was sent instead of delivering it (no background consumer). */
export function recordingQueue<Body>(options: { failOnCall?: number } = {}): Queue<Body> & { sent: MessageSendRequest<Body>[]; calls: number } {
  const sent: MessageSendRequest<Body>[] = [];
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: undefined } };
  const queue = {
    sent,
    calls: 0,
    async send(body: Body, sendOptions?: QueueSendOptions) {
      queue.calls++;
      if (options.failOnCall === queue.calls) throw new Error('Unknown Internal Error (15000)');
      sent.push({ body, ...sendOptions });
      return { metadata };
    },
    async sendBatch(messages: Iterable<MessageSendRequest<Body>>, batchOptions?: QueueSendBatchOptions) {
      queue.calls++;
      if (options.failOnCall === queue.calls) throw new Error('Unknown Internal Error (15000)');
      for (const message of messages) sent.push({ ...message, delaySeconds: message.delaySeconds ?? batchOptions?.delaySeconds });
      return { metadata };
    },
    async metrics() {
      return metadata.metrics;
    },
  };
  return queue as unknown as Queue<Body> & { sent: MessageSendRequest<Body>[]; calls: number };
}

/** n rows of the certificate starter template's fields. */
export function certificateRows(n: number, extra: Record<string, string | number> = {}): JsonObject[] {
  return Array.from({ length: n }, (_, i) => ({
    title: 'Certificate of Completion',
    recipient_name: `Recipient ${i + 1}`,
    achievement: 'for completing the workshop.',
    issuer_name: 'Lanternworks Training',
    date: 'November 26, 2026',
    ...extra,
  }));
}

export interface StoredBatch {
  user: UserRow;
  batch: BatchRecord;
  request: ParsedBatchRequest;
}

/** A batch stored for a new account (or `user`), as POST /v1/batches would store it. */
export async function storeBatch(
  body: JsonObject,
  options: { plan?: PlanId; user?: UserRow; now?: number; maxActive?: number; templateVersion?: number | null } = {},
): Promise<StoredBatch> {
  const now = options.now ?? Date.now();
  const user = options.user ?? (await createUser(options.plan ?? 'pro', now));
  const request = parseBatchRequest(body, { plan: options.plan ?? user.plan, appUrl: env.APP_URL });
  const batch = await createBatch(
    env.DB,
    { userId: user.id, request, templateVersion: options.templateVersion ?? null, expiresAt: now + 7 * DAY },
    { maxActive: options.maxActive ?? 100, now },
  );
  return { user, batch, request };
}

export interface RenderCall {
  request: BatchRenderRequest;
}

type Script = (request: BatchRenderRequest, call: number) => BatchRenderResult | Error | Promise<BatchRenderResult | Error>;

/** A fake BatchRender: answers from `script` (default: a 1-page PDF per row) and records every call. */
export function fakeRender(script?: Script): BatchRender & { calls: RenderCall[] } {
  const calls: RenderCall[] = [];
  const render = async (_env: Env, request: BatchRenderRequest): Promise<BatchRenderResult> => {
    calls.push({ request });
    const answer = script ? await script(request, calls.length) : renderResult(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(render, { calls });
}

export function renderResult(request: Pick<BatchRenderRequest, 'row' | 'now'>, overrides: Partial<BatchRenderResult> = {}): BatchRenderResult {
  return {
    cacheKey: request.row.index.toString(16).padStart(64, '0'),
    pages: 1,
    creditsUsed: 2,
    bytes: 1234,
    expiresAt: request.now + 30 * DAY,
    cached: false,
    ...overrides,
  };
}

export const busy = (): ApiError =>
  new ApiError('rate_limited', 'The PDF renderer is busy. Retry in a few seconds.', { details: { retry_after_seconds: 10 } });
export const providerDown = (): ApiError => new ApiError('render_failed', 'The PDF renderer failed (HTTP 500).');
export const documentBroken = (): ApiError => new ApiError('template_error', 'The browser could not render this document.');
export const quotaGone = (): ApiError => new ApiError('quota_exceeded', 'This PDF counts as 2 images; not enough is left.');

export interface Delivery {
  id?: string;
  attempts?: number;
  body: unknown;
}

/** One queue() invocation of the consumer with these messages; the platform's view of it. */
export async function deliver(
  messages: Delivery[],
  deps: Partial<BatchConsumerDeps> & Pick<BatchConsumerDeps, 'render'>,
  bindings: Env = batchEnv(),
): Promise<{ result: QueueResult; batch: MessageBatch<unknown> }> {
  const batch = createMessageBatch<unknown>(
    QUEUE_NAME,
    messages.map((message, i) => ({ id: message.id ?? `m${i}`, timestamp: new Date(), attempts: message.attempts ?? 1, body: message.body })),
  );
  const ctx = createExecutionContext();
  await consumeBatchMessages(batch, bindings, ctx, { settings: SETTINGS, ...deps });
  return { result: await getQueueResult(batch, ctx), batch };
}

/**
 * One delivery of one message whose ack() and retry() are spied on before the consumer runs
 * (getQueueResult does not record a retry's delaySeconds).
 */
export async function deliverOne(
  message: Delivery & { id: string },
  deps: Partial<BatchConsumerDeps> & Pick<BatchConsumerDeps, 'render'>,
  bindings: Env = batchEnv(),
): Promise<{ retry: MockInstance; ack: MockInstance }> {
  const batch = createMessageBatch<unknown>(QUEUE_NAME, [{ id: message.id, timestamp: new Date(), attempts: message.attempts ?? 1, body: message.body }]);
  const retry = vi.spyOn(batch.messages[0]!, 'retry');
  const ack = vi.spyOn(batch.messages[0]!, 'ack');
  await consumeBatchMessages(batch, bindings, createExecutionContext(), { settings: SETTINGS, ...deps });
  return { retry, ack };
}

/** The message for these rows of a batch. */
export function messageFor(batchId: string, rows: number[]): BatchQueueMessage {
  return { batchId, rows, attempt: 1 };
}
