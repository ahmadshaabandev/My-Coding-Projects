/**
 * Which URLs a QR code may point to (AI-SPEC.md section 6). Rules first, from the text alone:
 * http or https, at most AI.qr.maxUrlChars characters, no user:password@, no IP-address host, a
 * public-looking host name, not a known URL shortener (AI.shorteners, the host or a parent
 * domain). Then three lookups, in this order:
 *
 *   our blocklist          ai_url_blocklist: the host or a parent domain
 *   Cloudflare security    DNS over HTTPS to security.cloudflare-dns.com: a blocked domain answers
 *   resolver               0.0.0.0 with EDE 16 "Censored"; no such domain is refused too
 *   Google Web Risk        only when WEB_RISK_API_KEY is set (Lookup API, uris:search)
 *
 * A lookup that cannot be made answers 502 ai_unavailable: a QR code is never made for a URL that
 * was not checked. Every refusal of a safety reason is logged in ai_abuse_log (no IP address).
 * The code is static: it holds the URL itself, never a redirect of ours.
 */
import { AI } from '../config';
import { all, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { Env } from '../types';

export type UrlRefusalReason = 'not_http' | 'invalid_url' | 'too_long' | 'credentials' | 'ip_address' | 'not_public_host' | 'shortener' | 'blocked_domain' | 'blocked_url' | 'no_such_domain';

/** Refusals that say something about the URL's safety, not a typing mistake: these are logged. */
const LOGGED: readonly UrlRefusalReason[] = ['credentials', 'ip_address', 'shortener', 'blocked_domain', 'blocked_url', 'no_such_domain'];

const MESSAGES: Record<UrlRefusalReason, string> = {
  not_http: 'A QR code here can only hold an http:// or https:// address.',
  invalid_url: 'This is not a valid web address.',
  too_long: `The address is longer than ${AI.qr.maxUrlChars} characters.`,
  credentials: 'Addresses with a user name or password in them are not accepted.',
  ip_address: 'Addresses with an IP address instead of a domain name are not accepted.',
  not_public_host: 'The address must use a public domain name.',
  shortener: 'Addresses of URL shorteners are not accepted: use the address the short link leads to.',
  blocked_domain: 'This domain is listed as unsafe, so no QR code is made for it.',
  blocked_url: 'This address is listed as unsafe, so no QR code is made for it.',
  no_such_domain: 'This domain does not exist.',
};

export function urlRefused(reason: UrlRefusalReason, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError('url_refused', MESSAGES[reason], { details: { reason, ...extra } });
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'invalid', 'example', 'onion', 'arpa'];

/** The host and every parent domain of it with at least two labels: a.b.example.com -> a.b.example.com, b.example.com, example.com. */
export function hostAndParents(host: string): string[] {
  const labels = host.split('.');
  const out: string[] = [];
  for (let start = 0; start <= labels.length - 2; start++) out.push(labels.slice(start).join('.'));
  return out;
}

/**
 * The URL a QR code will hold, after the rules above. It is the normalised form (WHATWG URL:
 * lower-case scheme and host, punycode, percent-encoding), which is what the code encodes and what
 * the scan check must decode exactly. Throws 400 for a missing value, 422 url_refused otherwise.
 */
export function parseQrUrl(value: unknown): { url: URL; text: string } {
  if (typeof value !== 'string' || value.trim() === '') throw new ApiError('invalid_request', '"url" must be the web address the QR code should open.', { details: { field: 'url' } });
  const input = value.trim();
  if ([...input].length > AI.qr.maxUrlChars) throw urlRefused('too_long', { max_chars: AI.qr.maxUrlChars });
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw urlRefused(/^[a-z][a-z0-9+.-]*:/i.test(input) ? 'invalid_url' : 'not_http');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw urlRefused('not_http');
  if (url.username !== '' || url.password !== '') throw urlRefused('credentials');
  const host = url.hostname.replace(/\.$/, '');
  if (host.startsWith('[') || IPV4.test(host)) throw urlRefused('ip_address');
  const labels = host.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) || PRIVATE_SUFFIXES.includes(tld)) {
    throw urlRefused('not_public_host');
  }
  if (hostAndParents(host).some((name) => (AI.shorteners as readonly string[]).includes(name))) throw urlRefused('shortener');
  const text = url.href;
  if (text.length > AI.qr.maxUrlChars) throw urlRefused('too_long', { max_chars: AI.qr.maxUrlChars });
  return { url, text };
}

export interface UrlSafetyDeps {
  fetch: typeof fetch;
}

const defaultDeps = (): UrlSafetyDeps => ({ fetch: (input, init) => fetch(input, init) });

function checkUnavailable(): ApiError {
  return new ApiError('ai_unavailable', 'The address could not be checked right now, so no QR code was made. Nothing was charged; try again in a minute.');
}

interface DohAnswer {
  Status?: number;
  Answer?: { type?: number; data?: string }[];
  Comment?: string | string[];
}

/** Cloudflare's security resolver: 'blocked' (0.0.0.0 / EDE 16 Censored), 'missing' (NXDOMAIN) or 'ok'. */
export async function securityResolverVerdict(host: string, deps: UrlSafetyDeps): Promise<'ok' | 'blocked' | 'missing'> {
  const url = `${AI.urlSafety.resolverUrl}?name=${encodeURIComponent(host)}&type=A`;
  let answer: DohAnswer;
  try {
    const response = await deps.fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(AI.urlSafety.resolverTimeoutMs) });
    if (!response.ok) throw new Error(`resolver answered ${response.status}`);
    answer = await response.json();
  } catch (error) {
    console.error('[ai] security resolver failed:', error instanceof Error ? error.message : error);
    throw checkUnavailable();
  }
  const comments = Array.isArray(answer.Comment) ? answer.Comment : answer.Comment ? [answer.Comment] : [];
  if (comments.some((comment) => /EDE\(16\)|censored/i.test(comment))) return 'blocked';
  if ((answer.Answer ?? []).some((record) => record.type === 1 && record.data === '0.0.0.0')) return 'blocked';
  if (answer.Status === 3) return 'missing';
  return 'ok';
}

/** Google Web Risk Lookup API: true when the URL is listed under one of AI.urlSafety.webRiskThreatTypes. */
export async function webRiskListed(text: string, key: string, deps: UrlSafetyDeps): Promise<boolean> {
  const query = new URLSearchParams();
  for (const type of AI.urlSafety.webRiskThreatTypes) query.append('threatTypes', type);
  query.set('uri', text);
  query.set('key', key);
  try {
    const response = await deps.fetch(`${AI.urlSafety.webRiskUrl}?${query}`, { signal: AbortSignal.timeout(AI.urlSafety.webRiskTimeoutMs) });
    if (!response.ok) throw new Error(`Web Risk answered ${response.status}`);
    const body: { threat?: { threatTypes?: unknown[] } } = await response.json();
    return Array.isArray(body.threat?.threatTypes) && body.threat.threatTypes.length > 0;
  } catch (error) {
    console.error('[ai] Web Risk lookup failed:', error instanceof Error ? error.message : error);
    throw checkUnavailable();
  }
}

/** Logs a refusal (kind 'refusal') or a public report (kind 'report'). Never stores an IP address. */
export async function logAbuse(db: D1Database, entry: { kind: 'refusal' | 'report'; target: string; reason: string; email?: string | null; userId?: string | null }, now: number): Promise<void> {
  await run(
    db,
    'INSERT INTO ai_abuse_log (id, kind, target, reason, email, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    randomId('abu'),
    entry.kind,
    entry.target.slice(0, AI.abuse.maxTargetChars),
    entry.reason.slice(0, AI.abuse.maxReasonChars),
    entry.email ?? null,
    entry.userId ?? null,
    now,
  );
}

/**
 * The rules and the three lookups for one QR target. Returns the text the code will hold. A
 * refusal is logged (safety reasons only) and thrown as 422 url_refused.
 */
export async function checkQrTarget(env: Env, value: unknown, userId: string | null, now: number, deps: UrlSafetyDeps = defaultDeps()): Promise<string> {
  let parsed: { url: URL; text: string };
  try {
    parsed = parseQrUrl(value);
  } catch (error) {
    const reason = error instanceof ApiError ? (error.details?.reason as UrlRefusalReason | undefined) : undefined;
    if (reason && LOGGED.includes(reason) && typeof value === 'string') await logAbuse(env.DB, { kind: 'refusal', target: value.trim(), reason, userId }, now);
    throw error;
  }
  const host = parsed.url.hostname.replace(/\.$/, '');
  const refuse = async (reason: UrlRefusalReason, source: string): Promise<never> => {
    await logAbuse(env.DB, { kind: 'refusal', target: parsed.text, reason: `${reason}:${source}`, userId }, now);
    throw urlRefused(reason, { source });
  };

  const names = hostAndParents(host);
  const placeholders = names.map((_, index) => `?${index + 1}`).join(', ');
  const listed = await all<{ host: string }>(env.DB, `SELECT host FROM ai_url_blocklist WHERE host IN (${placeholders}) LIMIT 1`, ...names);
  if (listed.length > 0) await refuse('blocked_domain', 'blocklist');

  const verdict = await securityResolverVerdict(host, deps);
  if (verdict === 'blocked') await refuse('blocked_domain', 'cloudflare');
  if (verdict === 'missing') await refuse('no_such_domain', 'cloudflare');

  const key = env.WEB_RISK_API_KEY?.trim();
  if (key && (await webRiskListed(parsed.text, key, deps))) await refuse('blocked_url', 'web_risk');
  return parsed.text;
}
