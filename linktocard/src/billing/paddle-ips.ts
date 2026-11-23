/**
 * Paddle's webhook sender addresses, read from GET {api}/ips (no API key needed;
 * the sandbox and live APIs each return their own environment's addresses). The
 * list is fetched, never hard-coded: Paddle says the endpoint is the source of
 * truth and the addresses can change.
 *
 * Cached per isolate for an hour. When Paddle cannot be reached, the last list
 * that was fetched keeps being used; with no list at all the caller refuses the
 * webhook, and Paddle retries it later.
 */
const CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const cache = new Map<string, { cidrs: string[]; fetchedAt: number }>();

/** Forgets every fetched list (tests, and nothing else, need a clean start). */
export function clearPaddleSenderCache(): void {
  cache.clear();
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/** True when `ip` (dotted IPv4) is inside `cidr` (a.b.c.d/n). Anything malformed is false. */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const match = CIDR_RE.exec(cidr);
  const address = ipv4ToInt(ip);
  if (!match || address === null) return false;
  const base = ipv4ToInt(match.slice(1, 5).join('.'));
  const bits = Number(match[5]);
  if (base === null || bits > 32) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(base / size);
}

export function isPaddleSender(ip: string | null | undefined, cidrs: readonly string[]): boolean {
  return typeof ip === 'string' && cidrs.some((cidr) => ipv4InCidr(ip, cidr));
}

async function fetchCidrs(apiBase: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${apiBase}/ips`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { ipv4_cidrs?: unknown } };
    const list = body.data?.ipv4_cidrs;
    if (!Array.isArray(list)) return null;
    const cidrs = list.filter((value): value is string => typeof value === 'string' && CIDR_RE.test(value));
    return cidrs.length > 0 ? cidrs : null;
  } catch {
    return null;
  }
}

/** The sender CIDRs for the Paddle environment at `apiBase`, or null when none could ever be fetched. */
export async function paddleSenderCidrs(apiBase: string, now: number): Promise<string[] | null> {
  const cached = cache.get(apiBase);
  if (cached && now - cached.fetchedAt < CACHE_MS) return cached.cidrs;
  const fresh = await fetchCidrs(apiBase);
  if (fresh) {
    cache.set(apiBase, { cidrs: fresh, fetchedAt: now });
    return fresh;
  }
  return cached?.cidrs ?? null;
}
