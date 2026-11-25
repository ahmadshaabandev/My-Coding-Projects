/**
 * Limits of the OG checker, counted in D1 (tool_usage) so they hold across isolates and
 * locations: uncached checks per client per clock hour (public page, with optional
 * Turnstile after the first few) and per API key per UTC day (GET /v1/inspect). Cached
 * answers are never counted; callers only count right before a real fetch.
 */
import { DAY_MS, INSPECT } from '../config';
import { first, run } from '../db/client';
import { ApiError } from '../lib/errors';
import type { Env, UserRow } from '../types';

const HOUR_MS = 60 * 60 * 1000;
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_CHARS = 2048;

/** Same switch as src/lib/rate-limit.ts: tests that are not about limits turn them off. */
export function limitsDisabled(env: Pick<Env, 'ENVIRONMENT' | 'RATE_LIMITS_DISABLED'>): boolean {
  return env.ENVIRONMENT === 'test' && env.RATE_LIMITS_DISABLED === '1';
}

/** Adds one to a fixed-window counter and returns the new count (atomic). */
export async function bumpCounter(db: D1Database, bucket: string, expiresAt: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 1, ?2)
       ON CONFLICT (bucket) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(bucket, expiresAt)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function peekCounter(db: D1Database, bucket: string): Promise<number> {
  return (await first<{ count: number }>(db, 'SELECT count FROM tool_usage WHERE bucket = ?1', bucket))?.count ?? 0;
}

function windowOf(now: number, size: number): { index: number; end: number; retryAfter: number } {
  const index = Math.floor(now / size);
  const end = (index + 1) * size;
  return { index, end, retryAfter: Math.max(1, Math.ceil((end - now) / 1000)) };
}

function minutes(seconds: number): string {
  const value = Math.ceil(seconds / 60);
  return value === 1 ? '1 minute' : `${value} minutes`;
}

/** True when Cloudflare accepts the token. Network or format problems count as "no". */
export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<boolean> {
  if (token === '' || token.length > MAX_TOKEN_CHARS) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  try {
    const response = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(INSPECT.turnstileTimeoutMs) });
    if (!response.ok) return false;
    const body: { success?: unknown } = await response.json();
    return body.success === true;
  } catch {
    return false;
  }
}

/**
 * Public checker, before an uncached check: 429 once the client used its checks for the
 * hour; Turnstile from the (turnstileAfterChecks + 1)-th check when TURNSTILE_SECRET_KEY
 * is set. Counts the check when it is allowed.
 */
export async function enforcePublicLimit(env: Env, client: string, remoteIp: string | null, token: string | null, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const window = windowOf(now, HOUR_MS);
  const bucket = `ogc:${client}:${window.index}`;
  const limit = INSPECT.publicChecksPerHour;
  const tooMany = (): ApiError =>
    new ApiError('rate_limited', `You have used the ${limit} free checks for this hour. Try again in ${minutes(window.retryAfter)}, or use GET /v1/inspect with an API key.`, {
      headers: { 'retry-after': String(window.retryAfter) },
      details: { limit, period_seconds: HOUR_MS / 1000 },
    });

  const verificationRequired = (): ApiError =>
    new ApiError('verification_required', 'Please complete the quick check that you are not a bot, then try again.', {
      details: { site_key: env.TURNSTILE_SITE_KEY || null },
    });

  const used = await peekCounter(env.DB, bucket);
  if (used >= limit) throw tooMany();
  const secret = env.TURNSTILE_SECRET_KEY;
  let verified = false;
  if (secret && used >= INSPECT.turnstileAfterChecks) {
    if (!token || !(await verifyTurnstile(secret, token, remoteIp))) throw verificationRequired();
    verified = true;
  }
  // Requests sent together all pass the peek with the same count; the atomic count
  // decides both the limit and whether this one needed Turnstile after all.
  const count = await bumpCounter(env.DB, bucket, window.end);
  if (count > limit) throw tooMany();
  if (secret && !verified && count > INSPECT.turnstileAfterChecks) {
    await run(env.DB, 'UPDATE tool_usage SET count = count - 1 WHERE bucket = ?1 AND count > 0', bucket);
    throw verificationRequired();
  }
}

/**
 * GET /api/tools/og-check/{id}/image|favicon fetch the remote file again on every
 * request; this caps those fetches per client and clock hour, so one rate-limited check
 * cannot be replayed into unlimited requests to the hosts its page names.
 */
export async function enforceProxyLimit(env: Env, client: string, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const window = windowOf(now, HOUR_MS);
  const limit = INSPECT.proxyFetchesPerHour;
  if ((await bumpCounter(env.DB, `ogp:${client}:${window.index}`, window.end)) > limit) {
    throw new ApiError('rate_limited', `Too many preview images loaded from this address. Try again in ${minutes(window.retryAfter)}.`, {
      headers: { 'retry-after': String(window.retryAfter) },
      details: { limit, period_seconds: HOUR_MS / 1000 },
    });
  }
}

/** GET /v1/inspect, before an uncached check: the key's daily allowance for its plan. */
export async function enforceInspectLimit(env: Env, user: UserRow, keyId: string, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const window = windowOf(now, DAY_MS);
  const limit = INSPECT.dailyInspectionsByPlan[user.plan] ?? INSPECT.dailyInspectionsByPlan.free;
  if ((await bumpCounter(env.DB, `inspect:${keyId}:${window.index}`, window.end)) > limit) {
    throw new ApiError('rate_limited', `This API key has used its ${limit} inspections for today (UTC). Cached results do not count.`, {
      headers: { 'retry-after': String(window.retryAfter) },
      details: { limit, period_seconds: DAY_MS / 1000 },
    });
  }
}
