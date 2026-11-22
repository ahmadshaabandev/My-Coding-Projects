/**
 * Rate limiting.
 *
 * Production uses Cloudflare's Rate Limiting bindings (RL_IP, RL_KEY, ...)
 * declared in wrangler.toml: counters live at the edge location, cost nothing
 * extra and need no storage writes. They are deliberately approximate
 * (per-location, eventually consistent) - good for abuse control, not for
 * billing. Billing-grade counting is the D1 quota in src/lib/quota.ts.
 *
 * If a binding is missing (local scripts, a mis-configured deploy) or throws,
 * we fall back to a small in-memory fixed-window limiter so the limit still
 * exists per isolate instead of silently disappearing.
 */
import { RATE_LIMITS, type RateLimitName } from '../config';
import type { Env } from '../types';
import { ApiError } from './errors';

interface Window {
  count: number;
  resetAt: number;
}

const memory = new Map<string, Window>();
const MEMORY_MAX_KEYS = 5000;

function memoryLimit(name: RateLimitName, key: string, now: number): boolean {
  const { limit, periodSeconds } = RATE_LIMITS[name];
  const id = `${name}:${key}`;
  const current = memory.get(id);
  if (!current || current.resetAt <= now) {
    if (memory.size >= MEMORY_MAX_KEYS) {
      for (const [k, w] of memory) if (w.resetAt <= now) memory.delete(k);
      if (memory.size >= MEMORY_MAX_KEYS) memory.clear();
    }
    memory.set(id, { count: 1, resetAt: now + periodSeconds * 1000 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

/** Test hook. */
export function resetMemoryRateLimits(): void {
  memory.clear();
}

/** Returns true when the request is allowed. */
export async function checkRateLimit(
  env: Env,
  name: RateLimitName,
  key: string,
  now: number = Date.now(),
): Promise<boolean> {
  // Tests that are not about rate limiting switch it off explicitly.
  if (env.ENVIRONMENT === 'test' && env.RATE_LIMITS_DISABLED === '1') {
    return true;
  }
  const binding = env[name];
  if (binding && typeof binding.limit === 'function') {
    try {
      const { success } = await binding.limit({ key });
      return success;
    } catch {
      // fall through to the in-memory limiter
    }
  }
  return memoryLimit(name, key, now);
}

/** Throws 429 rate_limited when the limit is exceeded. */
export async function enforceRateLimit(env: Env, name: RateLimitName, key: string): Promise<void> {
  if (await checkRateLimit(env, name, key)) return;
  const { limit, periodSeconds } = RATE_LIMITS[name];
  throw new ApiError('rate_limited', `Too many requests. Limit: ${limit} per ${periodSeconds} seconds. Retry shortly.`, {
    headers: { 'retry-after': String(periodSeconds) },
    details: { limit, period_seconds: periodSeconds },
  });
}

/** Best client IP we can know. Cloudflare sets CF-Connecting-IP on every request. */
export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}
