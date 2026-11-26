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
 *                      ("pdff:<user id>:<day>") and the site for its signed links
 *                      ("pdffs:<site id>:<day>"), so visitors of a failing signed link can stop
 *                      that site's new signed PDFs, never the owner's API. A render reserves one
 *                      before it starts (the atomic bump decides; over the limit the bump is
 *                      undone and the answer is 429 until 00:00 UTC) and gives it back when it
 *                      turns out to be a charged PDF, a PDF already paid for, or a failure of
 *                      Browser Run itself (5xx, unreachable, busy). Stored PDFs are still served:
 *                      a cache hit never gets this far.
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
import { first, run } from '../db/client';
import { ApiError, ERROR_STATUS, type ErrorCode } from '../lib/errors';
import type { PdfFailureNote, PdfFailureRange } from '../lib/quota';
import { bumpCounter, limitsDisabled, peekCounter } from '../inspect/limits';
import type { Env } from '../types';
import { BROWSER_MS_SQL, dailyBudgetMs } from './alarm';

const BRAKE_CHECK_MS = 60_000;
const BRAKE_RETRY_SECONDS = 3600;
/** Longest message kept in the failure memory; a browser's own message is at most 300 characters. */
const MEMORY_MESSAGE_CHARS = 1000;

/* ------------------------------------------------------------------ */
/* Failed-render cap                                                   */
/* ------------------------------------------------------------------ */

/** Whose cap a render counts against: the account (POST /v1/pdf) or the site (its signed links). */
export type FailureScope = { kind: 'account'; id: string } | { kind: 'site'; id: string };

/** A failed-render slot held by one render while it runs; null when limits are off. */
export type FailedRenderReservation = { bucket: string } | null;

const failedBucket = (scope: FailureScope, day: number): string => `${scope.kind === 'site' ? 'pdffs' : 'pdff'}:${scope.id}:${day}`;

/** The day's allowance of failed renders for a plan id ('free', 'starter', 'pro'). */
export function failedRendersPerDay(planId: string): number {
  return planId === 'free' ? PDF.maxFailedRendersPerDay.free : PDF.maxFailedRendersPerDay.paid;
}

/** "15 h 4 min", "12 min": how long until a Retry-After. */
function untilText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function capReached(scope: FailureScope, limit: number, day: number, now: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  const causes =
    `more than ${PDF.maxPages} pages, a PDF over ${PDF.maxPdfBytes / (1024 * 1024)} MB, a timeout, a document the browser could not render, ` +
    'or a PDF that needed more images than were left';
  const when = `after 00:00 UTC (in ${untilText(retryAfter)})`;
  const message =
    scope.kind === 'site'
      ? `The signed PDF links of this site have had ${limit} renders today that produced no PDF (${causes}). New signed PDFs of this site can be made again ${when}; stored PDFs keep working, and POST /v1/pdf is not affected.`
      : `This account has had ${limit} PDF renders today that produced no PDF (${causes}). New PDFs can be made again ${when}; stored PDFs keep working. Signed PDF links are counted separately, per site.`;
  return new ApiError('rate_limited', message, {
    headers: { 'retry-after': String(retryAfter) },
    details: { limit, scope: scope.kind, period_seconds: DAY_MS / 1000, retry_after_seconds: retryAfter },
  });
}

/** 429 when the scope already used its failed renders for this UTC day. Reads only (HEAD, pre-checks). */
export async function assertFailedRenderAllowance(env: Env, scope: FailureScope, planId: string, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const day = Math.floor(now / DAY_MS);
  const limit = failedRendersPerDay(planId);
  if ((await peekCounter(env.DB, failedBucket(scope, day))) >= limit) throw capReached(scope, limit, day, now);
}

/**
 * Takes one failed-render slot before a render starts. The atomic bump decides: over the limit
 * it is undone and the answer is 429, so concurrent renders can never pass the cap together.
 */
export async function reserveFailedRender(env: Env, scope: FailureScope, planId: string, now: number): Promise<FailedRenderReservation> {
  if (limitsDisabled(env)) return null;
  const day = Math.floor(now / DAY_MS);
  const limit = failedRendersPerDay(planId);
  const bucket = failedBucket(scope, day);
  if ((await bumpCounter(env.DB, bucket, (day + 2) * DAY_MS)) <= limit) return { bucket };
  await giveBackFailedRender(env, { bucket });
  throw capReached(scope, limit, day, now);
}

/** Returns a slot: the render produced a PDF, or failed for a reason that is not the document's. Never throws. */
export async function giveBackFailedRender(env: Env, reservation: FailedRenderReservation): Promise<void> {
  if (reservation === null) return;
  try {
    await run(env.DB, 'UPDATE tool_usage SET count = count - 1 WHERE bucket = ?1 AND count > 0', reservation.bucket);
  } catch (error) {
    console.error('returning a failed-render slot failed:', error);
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

// Browser time of the free tools and of accounts on Free. A paid account's renders never count.
const FREE_BROWSER_MS_SQL = `SELECT ${BROWSER_MS_SQL} AS ms
  FROM browser_usage AS b LEFT JOIN users AS u ON u.id = b.user_id
  WHERE b.created_at > ?1 AND b.created_at <= ?2 AND (b.source = 'tool' OR u.plan = 'free')`;

/** 429 for Free-plan renders and the free tools while their browser time of the last 24 hours is too high. */
export async function assertFreeBrowserCapacity(env: Env, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  if (brake === null || now - brake.checkedAt >= BRAKE_CHECK_MS || now < brake.checkedAt) {
    const row = await first<{ ms: number }>(env.DB, FREE_BROWSER_MS_SQL, now - DAY_MS, now);
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
