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

/**
 * The first four groups of an IPv6 address as "a:b:c:d::/64", or null when the
 * text is not one. An IPv4-mapped address (::ffff:a.b.c.d) is its IPv4 address.
 */
function ipv6Network(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const last = tail.length > 0 ? tail : head;
  const dotted = last[last.length - 1]?.includes('.') ? last.pop()! : null;
  const explicit = head.length + tail.length + (dotted ? 2 : 0);
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const groups = [...head, ...new Array<string>(8 - explicit).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const values = groups.map((group) => Number.parseInt(group, 16));
  if (dotted && values.slice(0, 5).every((value) => value === 0) && values[5] === 0xffff) return dotted;
  return `${values.slice(0, 4).map((value) => value.toString(16)).join(':')}::/64`;
}

/**
 * Who a per-IP limit counts as one client. Cloudflare sets CF-Connecting-IP on
 * every request. An IPv4 address is itself. An IPv6 address is its /64: one
 * home line or server is handed at least that much, so limiting single
 * addresses would let it pick a fresh one for every request.
 */
export function clientIp(request: Request): string {
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim().toLowerCase();
  if (ip === '') return 'unknown';
  return ip.includes(':') ? (ipv6Network(ip) ?? ip) : ip;
}
