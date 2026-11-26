/**
 * Bounds on Browser Run time that request rate limits alone do not give.
 *
 * A render that reaches the browser and ends without a charged PDF because of the document
 * (more than PDF.maxPages pages, a PDF over PDF.maxPdfBytes, a timeout, a document the browser
 * cannot render, a page count that cannot be read) or because the account cannot pay for it
 * (402 after rendering) uses browser time and charges nothing, by design. Without a bound, one
 * caller could repeat such renders all day. So:
 *
 *   failed-render cap  PDF.maxFailedRendersPerDay renders like that per UTC day and scope, by
 *                      the owner's plan. The scope is the account for POST /v1/pdf
 *                      ("pdff:<user id>:<day>"), and for signed links both the site
 *                      ("pdffs:<site id>:<day>") and all sites of its owner together
 *                      ("pdffo:<user id>:<day>", PDF.maxFailedSignedRendersPerDay). Visitors of
 *                      failing signed links can so stop new signed PDFs (of one site, or of two
 *                      or more sites together), never the owner's API; and a site deleted and
 *                      created again starts no new count for its owner. Before it starts, a render
 *                      takes a place under every cap of its scope: a row "<counter>:r:<id>" whose
 *                      count is the time until which it is presumed alive. Kept failures, places
 *                      of renders running and places of renders cut off (alive time over, never
 *                      ended) together stay under the limit, decided in one batch, so concurrent
 *                      renders cannot pass the cap together. Refused: 429 until 00:00 UTC when
 *                      kept failures and cut-off renders fill the cap, otherwise 429 for a few
 *                      seconds ("renders still running"). A place is freed when the render turns
 *                      out to be a charged PDF, a PDF already paid for, or a failure of Browser
 *                      Run itself (5xx, unreachable, busy), and turned into a kept failure when
 *                      the document failed or the PDF did not fit. A render cut off before it ends
 *                      (the runtime stops a request about 30 s after its client went away) keeps
 *                      its place for the day: its browser time is unknown and unrecorded, so it
 *                      must not be free. Stored PDFs are still served: a cache hit never gets
 *                      this far.
 *   failure memory     a document failure and a 402 after rendering are remembered for
 *                      PDF.failedRenderMemoryMs by cache key (tool_usage, bucket
 *                      "pdfm:<cache key>:<JSON of the answer>", count = the images a 402 needed).
 *                      The identical request gets the same answer without rendering and without
 *                      being counted again; a remembered 402 is checked again against what is
 *                      left now, so a top-up bought in the meantime renders normally. Failures of
 *                      Browser Run itself are never remembered.
 *   free brake         while the free tools and Free accounts used more than
 *                      PDF.freeBrakeBudgetMultiple daily budgets of browser time in the last 24
 *                      hours (the alarm's budget, src/pdf/alarm.ts), Free-plan renders and the
 *                      free tools answer 429; Starter and Pro keep rendering, and their own
 *                      browser time never engages it. Read at most once per BRAKE_CHECK_MS per
 *                      isolate.
 *
 * Browser time is X-Browser-Ms-Used, or the measured wall time of the call when the browser did
 * not report it (in practice always: Browser Run reports 0 for PDF quick actions).
 *
 * Every tool_usage row here expires and is removed by the daily cleanup (src/lib/cleanup.ts).
 */
import { DAY_MS, PDF } from '../config';
import { first, isMissingColumnError, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { ApiError, ERROR_STATUS, type ErrorCode } from '../lib/errors';
import { PDF_PENDING_STALE_MS, type PdfFailureNote, type PdfFailureRange } from '../lib/quota';
import { limitsDisabled } from '../inspect/limits';
import type { Env } from '../types';
import { BROWSER_MS_SQL, dailyBudgetMs } from './alarm';

const BRAKE_CHECK_MS = 60_000;
const BRAKE_RETRY_SECONDS = 3600;
/** Retry-After when renders still running hold the last places under a cap. */
const IN_PROGRESS_RETRY_SECONDS = 5;
/** Longest message kept in the failure memory; a browser's own message is at most 300 characters. */
const MEMORY_MESSAGE_CHARS = 1000;

/* ------------------------------------------------------------------ */
/* Failed-render cap                                                   */
/* ------------------------------------------------------------------ */

/** Whose cap a render counts against: the account (POST /v1/pdf), or a site and all of its owner's sites (signed links). */
export type FailureScope = { kind: 'account'; id: string } | { kind: 'site'; id: string; ownerId: string };

/** One counter a render takes a place under: the account, one site, or all sites of an account. */
type CapKind = 'account' | 'site' | 'sites';

interface Cap {
  kind: CapKind;
  /** Kept failures: "pdff:<user id>:<day>", "pdffs:<site id>:<day>", "pdffo:<user id>:<day>". */
  counter: string;
  limit: number;
}

/**
 * The places one render holds while it runs: a tool_usage row "<counter>:r:<random>" per cap,
 * whose count is the time until which the render is presumed alive (PDF_PENDING_STALE_MS after
 * it started). null when limits are off.
 */
export type FailedRenderReservation = { rows: Array<{ counter: string; row: string }>; day: number } | null;

const COUNTER_PREFIX: Record<CapKind, string> = { account: 'pdff', site: 'pdffs', sites: 'pdffo' };

/** The day's allowance of failed renders for a plan id ('free', 'starter', 'pro'). */
export function failedRendersPerDay(planId: string): number {
  return planId === 'free' ? PDF.maxFailedRendersPerDay.free : PDF.maxFailedRendersPerDay.paid;
}

function capsOf(scope: FailureScope, planId: string, day: number): Cap[] {
  const cap = (kind: CapKind, id: string, limit: number): Cap => ({ kind, counter: `${COUNTER_PREFIX[kind]}:${id}:${day}`, limit });
  if (scope.kind === 'account') return [cap('account', scope.id, failedRendersPerDay(planId))];
  const sites = planId === 'free' ? PDF.maxFailedSignedRendersPerDay.free : PDF.maxFailedSignedRendersPerDay.paid;
  return [cap('site', scope.id, failedRendersPerDay(planId)), cap('sites', scope.ownerId, sites)];
}

/** The rows of renders in progress (or cut off) under one counter: strictly between these two buckets. */
const placesFrom = (counter: string): string => `${counter}:r:`;
const placesTo = (counter: string): string => `${counter}:r;`;

/** "15 h 4 min", "12 min": how long until a Retry-After. */
function untilText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function capReached(cap: Cap, day: number, now: number): ApiError {
  const { limit } = cap;
  const retryAfter = Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  const causes =
    `more than ${PDF.maxPages} pages, a PDF over ${PDF.maxPdfBytes / (1024 * 1024)} MB, a timeout, a document the browser could not render, ` +
    'a render cut off before it ended, or a PDF that needed more images than were left';
  const when = `after 00:00 UTC (in ${untilText(retryAfter)})`;
  const messages: Record<CapKind, string> = {
    account: `This account has had ${limit} PDF renders today that produced no PDF (${causes}). New PDFs can be made again ${when}; stored PDFs keep working. Signed PDF links are counted separately.`,
    site: `The signed PDF links of this site have had ${limit} renders today that produced no PDF (${causes}). New signed PDFs of this site can be made again ${when}; stored PDFs keep working, and POST /v1/pdf is not affected.`,
    sites: `The signed PDF links of this account's sites together have had ${limit} renders today that produced no PDF (${causes}). New signed PDFs can be made again ${when}; stored PDFs keep working, and POST /v1/pdf is not affected.`,
  };
  return new ApiError('rate_limited', messages[cap.kind], {
    headers: { 'retry-after': String(retryAfter) },
    details: { limit, scope: cap.kind, period_seconds: DAY_MS / 1000, retry_after_seconds: retryAfter },
  });
}

/** Renders still running take the last places: a short wait, not the day's end. */
function placesInUse(cap: Cap, running: number): ApiError {
  const whose = cap.kind === 'account' ? 'this account' : cap.kind === 'site' ? "this site's signed links" : "this account's signed links";
  return new ApiError(
    'rate_limited',
    `${running} PDF ${running === 1 ? 'render is' : 'renders are'} still running for ${whose}. Together with today's renders that produced no PDF they hold all ${cap.limit} places ` +
      `of the daily cap on failed renders, because each of them could still fail. Retry in ${IN_PROGRESS_RETRY_SECONDS} s: a render that ends with a PDF frees its place.`,
    {
      headers: { 'retry-after': String(IN_PROGRESS_RETRY_SECONDS) },
      details: { limit: cap.limit, scope: cap.kind, running, retry_after_seconds: IN_PROGRESS_RETRY_SECONDS },
    },
  );
}

const CAP_STATE_SQL = `SELECT COALESCE((SELECT count FROM tool_usage WHERE bucket = ?1), 0) AS failed,
    (SELECT COUNT(*) FROM tool_usage WHERE bucket > ?2 AND bucket < ?3 AND count <= ?4) AS cut_off,
    (SELECT COUNT(*) FROM tool_usage WHERE bucket > ?2 AND bucket < ?3 AND count > ?4) AS running`;

/** Kept failures (with renders that were cut off and never ended) and renders running now, under one counter. */
async function capState(db: D1Database, cap: Cap, now: number): Promise<{ used: number; running: number }> {
  const row = await first<{ failed: number; cut_off: number; running: number }>(db, CAP_STATE_SQL, cap.counter, placesFrom(cap.counter), placesTo(cap.counter), now);
  return { used: (row?.failed ?? 0) + (row?.cut_off ?? 0), running: row?.running ?? 0 };
}

/**
 * 429 when the scope already used its failed renders for this UTC day. Reads only (HEAD,
 * pre-checks): renders still running do not count here, renders cut off before they ended do.
 */
export async function assertFailedRenderAllowance(env: Env, scope: FailureScope, planId: string, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const day = Math.floor(now / DAY_MS);
  for (const cap of capsOf(scope, planId, day)) {
    if ((await capState(env.DB, cap, now)).used >= cap.limit) throw capReached(cap, day, now);
  }
}

// Takes a place: ?1 the new row, ?2 alive until, ?3 expiry, ?4 counter, ?5/?6 its places, ?7 limit, ?8 the previous row of this reservation ('' for the first).
const TAKE_PLACE_SQL = `INSERT INTO tool_usage (bucket, count, expires_at)
  SELECT ?1, ?2, ?3
  WHERE COALESCE((SELECT count FROM tool_usage WHERE bucket = ?4), 0) + (SELECT COUNT(*) FROM tool_usage WHERE bucket > ?5 AND bucket < ?6) < ?7
    AND (?8 = '' OR EXISTS (SELECT 1 FROM tool_usage WHERE bucket = ?8))
  RETURNING bucket`;
// Undoes the earlier places of a reservation whose last place was not free.
const UNDO_PLACE_SQL = 'DELETE FROM tool_usage WHERE bucket = ?1 AND NOT EXISTS (SELECT 1 FROM tool_usage WHERE bucket = ?2)';

/**
 * Takes a place under every cap of the scope before a render starts: kept failures, renders cut
 * off and renders running together stay under the limit. One batch (one transaction) decides,
 * so concurrent renders can never pass a cap together. Refused: 429 until 00:00 UTC when kept
 * failures fill the cap, otherwise a 429 of a few seconds (renders still running hold the rest).
 */
export async function reserveFailedRender(env: Env, scope: FailureScope, planId: string, now: number): Promise<FailedRenderReservation> {
  if (limitsDisabled(env)) return null;
  const day = Math.floor(now / DAY_MS);
  const caps = capsOf(scope, planId, day);
  const id = randomId('r');
  const rows = caps.map((cap) => ({ counter: cap.counter, row: `${placesFrom(cap.counter)}${id}` }));
  const aliveUntil = now + PDF_PENDING_STALE_MS;
  const expiresAt = (day + 2) * DAY_MS;
  const last = rows[rows.length - 1]!.row;
  const results = await env.DB.batch([
    ...caps.map((cap, i) =>
      env.DB.prepare(TAKE_PLACE_SQL).bind(rows[i]!.row, aliveUntil, expiresAt, cap.counter, placesFrom(cap.counter), placesTo(cap.counter), cap.limit, i === 0 ? '' : rows[i - 1]!.row),
    ),
    ...rows.slice(0, -1).map(({ row }) => env.DB.prepare(UNDO_PLACE_SQL).bind(row, last)),
  ]);
  if ((results[caps.length - 1]?.results ?? []).length === 1) return { rows, day };
  for (const cap of caps) {
    const state = await capState(env.DB, cap, now);
    if (state.used >= cap.limit) throw capReached(cap, day, now);
    if (state.used + state.running >= cap.limit) throw placesInUse(cap, state.running);
  }
  // The places were freed in the meantime.
  throw placesInUse(caps[0]!, 0);
}

/** Returns the places: the render produced a PDF, or failed for a reason that is not the document's. Never throws. */
export async function giveBackFailedRender(env: Env, reservation: FailedRenderReservation): Promise<void> {
  if (reservation === null) return;
  try {
    await env.DB.batch(reservation.rows.map(({ row }) => env.DB.prepare('DELETE FROM tool_usage WHERE bucket = ?1').bind(row)));
  } catch (error) {
    console.error('returning a failed-render place failed:', error);
  }
}

// Keeps a failure: counted under its counter, in the batch that frees the place (only while the place is still held).
const KEEP_FAILURE_SQL = `INSERT INTO tool_usage (bucket, count, expires_at)
  SELECT ?1, 1, ?2 WHERE EXISTS (SELECT 1 FROM tool_usage WHERE bucket = ?3)
  ON CONFLICT (bucket) DO UPDATE SET count = count + 1`;

/** The render failed because of the document, or needed more images than were left: it counts. Never throws. */
export async function keepFailedRender(env: Env, reservation: FailedRenderReservation): Promise<void> {
  if (reservation === null) return;
  const expiresAt = (reservation.day + 2) * DAY_MS;
  try {
    await env.DB.batch(
      reservation.rows.flatMap(({ counter, row }) => [
        env.DB.prepare(KEEP_FAILURE_SQL).bind(counter, expiresAt, row),
        env.DB.prepare('DELETE FROM tool_usage WHERE bucket = ?1').bind(row),
      ]),
    );
  } catch (error) {
    // The place stays taken: once its time is up it counts as a render that was cut off.
    console.error('counting a failed render failed:', error);
  }
}

/* ------------------------------------------------------------------ */
/* Failure memory                                                      */
/* ------------------------------------------------------------------ */

/** What the identical request is answered with, without rendering, while it is remembered. */
export type RememberedFailure =
  | { kind: 'quota'; units: number; at: number; until: number }
  | { kind: 'document'; error: ApiError; at: number; until: number };

interface StoredAnswer {
  code: ErrorCode;
  message?: string;
  details?: Record<string, unknown>;
}

const memoryPrefix = (cacheKey: string): string => `pdfm:${cacheKey}:`;

/** The tool_usage buckets that hold the remembered failure of one cache key (':' + 1 is ';'). */
export function failureRange(cacheKey: string): PdfFailureRange {
  return { from: memoryPrefix(cacheKey), to: `pdfm:${cacheKey};` };
}

function note(cacheKey: string, answer: StoredAnswer, count: number, now: number): PdfFailureNote {
  return { bucket: `${memoryPrefix(cacheKey)}${JSON.stringify(answer)}`, count, expiresAt: now + PDF.failedRenderMemoryMs };
}

/** The row that remembers a document failure (the error as it was answered). */
export function documentFailureNote(cacheKey: string, error: ApiError, now: number): PdfFailureNote {
  const message = error.message.length > MEMORY_MESSAGE_CHARS ? `${error.message.slice(0, MEMORY_MESSAGE_CHARS - 3)}...` : error.message;
  return note(cacheKey, { code: error.code, message, ...(error.details ? { details: error.details } : {}) }, 0, now);
}

/** The row that remembers a 402 after rendering, with the images the PDF needed. */
export function quotaFailureNote(cacheKey: string, units: number, now: number): PdfFailureNote {
  return note(cacheKey, { code: 'quota_exceeded' }, units, now);
}

const clock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** Decodes a remembered row; null for one this code cannot read (it is then forgotten). */
export function recallFailure(cacheKey: string, row: { bucket: string; count: number; expires_at: number }): RememberedFailure | null {
  const prefix = memoryPrefix(cacheKey);
  if (!row.bucket.startsWith(prefix)) return null;
  let answer: StoredAnswer;
  try {
    answer = JSON.parse(row.bucket.slice(prefix.length)) as StoredAnswer;
  } catch {
    return null;
  }
  const until = row.expires_at;
  const at = until - PDF.failedRenderMemoryMs;
  if (answer.code === 'quota_exceeded') {
    return Number.isInteger(row.count) && row.count >= 1 ? { kind: 'quota', units: row.count, at, until } : null;
  }
  if (typeof answer.code !== 'string' || !(answer.code in ERROR_STATUS) || typeof answer.message !== 'string') return null;
  const message = `${answer.message} (An identical request failed like this at ${clock(at)}; until ${clock(until)} it gets this answer without being rendered again.)`;
  return { kind: 'document', error: new ApiError(answer.code, message, answer.details ? { details: answer.details } : {}), at, until };
}

const MEMORY_SQL = 'SELECT bucket, count, expires_at FROM tool_usage WHERE bucket > ?1 AND bucket < ?2 AND expires_at > ?3 ORDER BY expires_at DESC LIMIT 1';

/** The remembered failure of a cache key, if any (HEAD of a signed link; renders read it while claiming). */
export async function readRememberedFailure(db: D1Database, cacheKey: string, now: number): Promise<RememberedFailure | null> {
  const range = failureRange(cacheKey);
  const row = await first<{ bucket: string; count: number; expires_at: number }>(db, MEMORY_SQL, range.from, range.to, now);
  return row ? recallFailure(cacheKey, row) : null;
}

/** Forgets a cache key's failure: a remembered 402 that fits now, or a row this code cannot read. */
export async function forgetFailure(db: D1Database, cacheKey: string): Promise<void> {
  const range = failureRange(cacheKey);
  await run(db, 'DELETE FROM tool_usage WHERE bucket > ?1 AND bucket < ?2', range.from, range.to);
}

/* ------------------------------------------------------------------ */
/* Free brake                                                          */
/* ------------------------------------------------------------------ */

let brake: { checkedAt: number; engaged: boolean } | null = null;

/** Tests only: forget the isolate's last reading of the brake. */
export function resetFreeBrake(): void {
  brake = null;
}

// Browser time of the free tools and of renders made on the Free plan: by the plan recorded with
// the render (migration 0007), so a paid account that moves to Free later does not bring its paid
// renders along; rows from before that column by the account's plan today.
const FREE_BROWSER_MS_SQL = `SELECT ${BROWSER_MS_SQL} AS ms
  FROM browser_usage AS b LEFT JOIN users AS u ON u.id = b.user_id
  WHERE b.created_at > ?1 AND b.created_at <= ?2 AND (b.source = 'tool' OR b.plan = 'free' OR (b.plan IS NULL AND u.plan = 'free'))`;
const FREE_BROWSER_MS_BEFORE_0007_SQL = `SELECT ${BROWSER_MS_SQL} AS ms
  FROM browser_usage AS b LEFT JOIN users AS u ON u.id = b.user_id
  WHERE b.created_at > ?1 AND b.created_at <= ?2 AND (b.source = 'tool' OR u.plan = 'free')`;

/** 429 for Free-plan renders and the free tools while their browser time of the last 24 hours is too high. */
export async function assertFreeBrowserCapacity(env: Env, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  if (brake === null || now - brake.checkedAt >= BRAKE_CHECK_MS || now < brake.checkedAt) {
    const row = await first<{ ms: number }>(env.DB, FREE_BROWSER_MS_SQL, now - DAY_MS, now).catch((error: unknown) => {
      if (!isMissingColumnError(error)) throw error;
      console.error('browser_usage.plan is missing: apply migration 0007_browser_usage_plan.sql');
      return first<{ ms: number }>(env.DB, FREE_BROWSER_MS_BEFORE_0007_SQL, now - DAY_MS, now);
    });
    brake = { checkedAt: now, engaged: (row?.ms ?? 0) > PDF.freeBrakeBudgetMultiple * dailyBudgetMs(env) };
  }
  if (!brake.engaged) return;
  throw new ApiError(
    'rate_limited',
    'PDF rendering on the Free plan and in the free tools is paused: together they used much more browser time than usual in the last 24 hours. ' +
      'It resumes on its own as that use ages out of the 24-hour window, at the latest 24 hours after it stopped. Starter and Pro are not affected, and stored PDFs keep working.',
    { headers: { 'retry-after': String(BRAKE_RETRY_SECONDS) }, details: { retry_after_seconds: BRAKE_RETRY_SECONDS } },
  );
}
