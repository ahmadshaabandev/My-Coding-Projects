/**
 * Free previews (no account): Turnstile on every request, and per client (IPv4 address or IPv6
 * /64) per UTC day at most AI.freePreviewsPerIpPerDay previews over both tools, and
 * AI.freePreviewsPerPagePerIpPerDay of one page (the checked page's URL, or the QR code's URL).
 * Counted in D1 (tool_usage) so the limits hold across isolates; the route adds an existing
 * rate-limit binding (RL_PLAYGROUND) against bursts. A page is named in the counter by a hash, so
 * no URL is stored there.
 */
import { AI, DAY_MS } from '../config';
import { run } from '../db/client';
import { sha256Hex } from '../lib/crypto';
import { isLocalEnvironment } from '../lib/email';
import { ApiError } from '../lib/errors';
import { bumpCounter, limitsDisabled, verifyTurnstile } from '../inspect/limits';
import type { Env } from '../types';

/**
 * 403 turnstile_failed unless Cloudflare accepts the token. Without TURNSTILE_SECRET_KEY the free
 * previews are not set up (503), except under wrangler dev and in tests, where any token passes.
 */
export async function assertTurnstile(env: Env, token: unknown, remoteIp: string | null, fetchImpl?: typeof fetch): Promise<void> {
  const failed = (): ApiError =>
    new ApiError('turnstile_failed', 'Please complete the check that you are not a bot, then try again.', { details: { site_key: env.TURNSTILE_SITE_KEY || null } });
  if (typeof token !== 'string' || token.trim() === '') throw failed();
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (isLocalEnvironment(env)) return;
    throw new ApiError('not_configured', 'Free AI previews are not set up on this deployment yet.');
  }
  if (!(await verifyTurnstile(secret, token, remoteIp, fetchImpl))) throw failed();
}

const utcDay = (now: number): number => Math.floor(now / DAY_MS);

function secondsToMidnight(now: number): number {
  return Math.max(1, Math.ceil(((utcDay(now) + 1) * DAY_MS - now) / 1000));
}

/** A held free preview: give it back when the generation failed for a reason that is not the visitor's. */
export interface PreviewReservation {
  release(): Promise<void>;
}

const NOTHING: PreviewReservation = { release: async () => undefined };

/**
 * Counts one free preview for this client (and page) today, or throws 429 rate_limited. Counted
 * before the model is called, so parallel requests cannot pass together.
 */
export async function reserveFreePreview(env: Env, client: string, page: string | null, now: number): Promise<PreviewReservation> {
  if (limitsDisabled(env)) return NOTHING;
  const day = utcDay(now);
  const expires = (day + 2) * DAY_MS;
  const ipBucket = `ai-free:${client}:${day}`;
  const pageBucket = page === null ? null : `ai-free-page:${client}:${day}:${(await sha256Hex(page)).slice(0, 32)}`;
  const tooMany = (limit: number, what: string): ApiError =>
    new ApiError('rate_limited', `${what} Try again after 00:00 UTC, or sign in to make covers with your images.`, {
      headers: { 'retry-after': String(secondsToMidnight(now)) },
      details: { limit, period_seconds: DAY_MS / 1000 },
    });
  const undo = async (bucket: string): Promise<void> => {
    await run(env.DB, 'UPDATE tool_usage SET count = count - 1 WHERE bucket = ?1 AND count > 0', bucket);
  };

  if ((await bumpCounter(env.DB, ipBucket, expires)) > AI.freePreviewsPerIpPerDay) {
    await undo(ipBucket);
    throw tooMany(AI.freePreviewsPerIpPerDay, `You have used the ${AI.freePreviewsPerIpPerDay} free AI previews for today.`);
  }
  if (pageBucket !== null && (await bumpCounter(env.DB, pageBucket, expires)) > AI.freePreviewsPerPagePerIpPerDay) {
    await undo(pageBucket);
    await undo(ipBucket);
    throw tooMany(AI.freePreviewsPerPagePerIpPerDay, 'You already made a free preview for this page today.');
  }
  return {
    release: async () => {
      await undo(ipBucket);
      if (pageBucket !== null) await undo(pageBucket);
    },
  };
}
