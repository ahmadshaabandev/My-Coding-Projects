/**
 * Bounds on Browser Run time that request rate limits alone do not give.
 *
 * A render that reaches the browser and ends without a charged PDF (more than PDF.maxPages
 * pages, a timeout, a browser error, a page count that cannot be read, or a PDF the account
 * cannot pay for) uses browser time and charges nothing, by design. Without a bound, one account
 * could repeat such renders all day. So:
 *
 *   per account  after PDF.maxFailedRendersPerDay renders like that in one UTC day, the
 *                account's new renders answer 429 until the day ends. Stored PDFs are still
 *                served: a cache hit never gets this far. Counted in D1 (tool_usage, bucket
 *                "pdff:<user id>:<UTC day>"), so it holds across isolates.
 *   free brake   while all PDF renders of the last 24 hours used more than
 *                PDF.freeBrakeBudgetMultiple daily budgets of browser time (the alarm's budget,
 *                src/pdf/alarm.ts), Free-plan renders and the free tools answer 429; Starter and
 *                Pro keep rendering. Read at most once per BRAKE_CHECK_MS per isolate.
 *
 * Browser time is X-Browser-Ms-Used, or the measured wall time of the call when the browser did
 * not report it (timeouts and 5xx answers).
 */
import { DAY_MS, PDF } from '../config';
import { first } from '../db/client';
import { ApiError } from '../lib/errors';
import { bumpCounter, limitsDisabled, peekCounter } from '../inspect/limits';
import type { Env } from '../types';
import { BROWSER_MS_SQL, dailyBudgetMs } from './alarm';

const BRAKE_CHECK_MS = 60_000;
const BRAKE_RETRY_SECONDS = 3600;

const failedBucket = (userId: string, day: number): string => `pdff:${userId}:${day}`;

/** The day's allowance of failed renders for a plan id ('free', 'starter', 'pro'). */
export function failedRendersPerDay(planId: string): number {
  return planId === 'free' ? PDF.maxFailedRendersPerDay.free : PDF.maxFailedRendersPerDay.paid;
}

/** 429 when the account already had its failed renders for this UTC day. */
export async function assertFailedRenderAllowance(env: Env, userId: string, planId: string, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const day = Math.floor(now / DAY_MS);
  const limit = failedRendersPerDay(planId);
  if ((await peekCounter(env.DB, failedBucket(userId, day))) < limit) return;
  const retryAfter = Math.max(1, Math.ceil(((day + 1) * DAY_MS - now) / 1000));
  throw new ApiError(
    'rate_limited',
    `This account has had ${limit} PDF renders today that produced no PDF (too many pages, a timeout or an error). New PDFs can be made again after 00:00 UTC; stored PDFs keep working.`,
    { headers: { 'retry-after': String(retryAfter) }, details: { limit, period_seconds: DAY_MS / 1000 } },
  );
}

/** Counts one render of this account that reached the browser and charged nothing. Never throws. */
export async function noteUnchargedRender(env: Env, userId: string, now: number): Promise<void> {
  const day = Math.floor(now / DAY_MS);
  try {
    await bumpCounter(env.DB, failedBucket(userId, day), (day + 2) * DAY_MS);
  } catch (error) {
    console.error('counting a failed PDF render failed:', error);
  }
}

let brake: { checkedAt: number; engaged: boolean } | null = null;

/** Tests only: forget the isolate's last reading of the brake. */
export function resetFreeBrake(): void {
  brake = null;
}

/** 429 for Free-plan renders and the free tools while the last 24 hours used too much browser time. */
export async function assertFreeBrowserCapacity(env: Env, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  if (brake === null || now - brake.checkedAt >= BRAKE_CHECK_MS || now < brake.checkedAt) {
    const row = await first<{ ms: number }>(
      env.DB,
      `SELECT ${BROWSER_MS_SQL} AS ms FROM browser_usage WHERE created_at > ?1 AND created_at <= ?2`,
      now - DAY_MS,
      now,
    );
    brake = { checkedAt: now, engaged: (row?.ms ?? 0) > PDF.freeBrakeBudgetMultiple * dailyBudgetMs(env) };
  }
  if (!brake.engaged) return;
  throw new ApiError(
    'rate_limited',
    'PDF rendering on the Free plan and in the free tools is paused for a while because of heavy use. Try again later; Starter and Pro are not affected.',
    { headers: { 'retry-after': String(BRAKE_RETRY_SECONDS) }, details: { retry_after_seconds: BRAKE_RETRY_SECONDS } },
  );
}
