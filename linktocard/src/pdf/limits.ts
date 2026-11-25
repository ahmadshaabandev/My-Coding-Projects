/**
 * The free PDF tools' hourly allowance (POST /api/tools/pdf): PDF.toolPdfsPerHour per client
 * (IPv4 address or IPv6 /64) per clock hour, counted in D1 (tool_usage, the OG checker's
 * table) so it holds across isolates and locations. When TURNSTILE_SECRET_KEY is set, a
 * Turnstile token is required after the first PDF.toolTurnstileAfterPdfs PDFs of the hour,
 * the same rule as the OG checker. The RL_TOOLS_PDF binding limits bursts on top of this.
 *
 * Callers count right before the work that costs something (downloading images, the
 * browser), after the request has been validated, so a typo in the HTML does not use up a PDF.
 */
import { PDF } from '../config';
import { ApiError } from '../lib/errors';
import { bumpCounter, limitsDisabled, peekCounter, verifyTurnstile } from '../inspect/limits';
import { run } from '../db/client';
import type { Env } from '../types';

const HOUR_MS = 60 * 60 * 1000;

function minutes(seconds: number): string {
  const value = Math.ceil(seconds / 60);
  return value === 1 ? '1 minute' : `${value} minutes`;
}

export async function enforceToolPdfLimit(env: Env, client: string, remoteIp: string | null, token: string | null, now: number): Promise<void> {
  if (limitsDisabled(env)) return;
  const index = Math.floor(now / HOUR_MS);
  const end = (index + 1) * HOUR_MS;
  const retryAfter = Math.max(1, Math.ceil((end - now) / 1000));
  const bucket = `pdft:${client}:${index}`;
  const limit = PDF.toolPdfsPerHour;
  const tooMany = (): ApiError =>
    new ApiError('rate_limited', `You have made the ${limit} free PDFs for this hour. Try again in ${minutes(retryAfter)}, or use POST /v1/pdf with an API key.`, {
      headers: { 'retry-after': String(retryAfter) },
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
  if (secret && used >= PDF.toolTurnstileAfterPdfs) {
    if (!token || !(await verifyTurnstile(secret, token, remoteIp))) throw verificationRequired();
    verified = true;
  }
  // Requests sent together all pass the peek with the same count; the atomic count decides
  // both the limit and whether this one needed Turnstile after all.
  const count = await bumpCounter(env.DB, bucket, end);
  if (count > limit) throw tooMany();
  if (secret && !verified && count > PDF.toolTurnstileAfterPdfs) {
    await run(env.DB, 'UPDATE tool_usage SET count = count - 1 WHERE bucket = ?1 AND count > 0', bucket);
    throw verificationRequired();
  }
}
