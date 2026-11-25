// Security review of the OG checker backend. Each test here failed before the fix it
// names (see the comment above it); all outbound HTTP is a mocked fetch.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSPECT } from '../src/config';
import { first, run } from '../src/db/client';
import { enforcePublicLimit } from '../src/inspect/limits';
import { robotsAllows } from '../src/inspect/robots';
import type { CheckResult } from '../src/inspect/types';
import type { Env } from '../src/types';
import { call, dohAnswer, errorOf, requestUrl } from './app-helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

let serial = 0;
const host = (label: string): string => `${label}-${++serial}.ogreview.com`;
const HOUR_MS = 3_600_000;

type Handler = () => Response;

/** Every outbound request: DoH answers a public address, `routes` by exact origin + path, else 404. */
function mockNet(routes: Record<string, Handler>): URL[] {
  const seen: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (url.hostname === 'cloudflare-dns.com') return dohAnswer(url);
    seen.push(url);
    const handler = routes[`${url.origin}${url.pathname}`];
    return handler ? handler() : new Response('not found', { status: 404 });
  });
  return seen;
}

const html = (body: string): Handler => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
const png: Handler = () => new Response(PNG_1x1, { headers: { 'content-type': 'image/png' } });

function check(url: string, ip: string, bindings: Env = env): Promise<Response> {
  return call(`/api/tools/og-check?${new URLSearchParams({ url }).toString()}`, { headers: { 'cf-connecting-ip': ip } }, bindings);
}

describe('robots.txt matching cannot be made to backtrack (ReDoS)', () => {
  // Before the fix every rule became a RegExp with one ".*" per "*": the site that is
  // being checked chose both the rule and (through the URL) the path, and seven stars
  // against a 60-character path took seconds of CPU, blocking the isolate (the 5 s
  // budget cannot interrupt synchronous code); eight stars took about 20 s.
  it('a rule with many stars against a long path is judged at once', () => {
    const robots = `User-agent: *\nDisallow: /${'*a'.repeat(7)}b$\n`;
    const started = Date.now();
    const decision = robotsAllows(robots, `/${'a'.repeat(60)}`);
    expect(Date.now() - started).toBeLessThan(250);
    expect(decision.allowed).toBe(true);
    // A far worse rule and the longest path a check can have still finish quickly.
    const worse = `User-agent: *\nDisallow: /${'*a'.repeat(200)}b$\nDisallow: /${'*a'.repeat(200)}\n`;
    const started2 = Date.now();
    expect(robotsAllows(worse, `/${'a'.repeat(2040)}`)).toMatchObject({ allowed: false });
    expect(Date.now() - started2).toBeLessThan(250);
  });

  it('keeps the RFC 9309 semantics of "*" and "$"', () => {
    const cases: [string, string, boolean][] = [
      ['/*.pdf$', '/files/a.pdf', false],
      ['/*.pdf$', '/files/a.pdf?x', true],
      ['/*.pdf', '/files/a.pdf?x', false],
      ['/a*b*c', '/a-c-b-c', false],
      ['/a*b*c', '/a-c-b', true],
      ['/a*b$', '/ab', false],
      ['/a*b$', '/abab', false],
      ['/a*b$', '/aba', true],
      ['/x$', '/x', false],
      ['/x$', '/xy', true],
      ['/*', '/anything', false],
      ['*', '/anything', false],
      ['/a**b', '/a-b', false],
      ['/p.h+p(x)', '/p.h+p(x)/1', false],
      ['/p.h+p', '/pXh+p', true],
      ['/$x', '/$x', false],
    ];
    for (const [pattern, path, allowed] of cases) {
      expect(robotsAllows(`User-agent: *\nDisallow: ${pattern}\n`, path).allowed, `${pattern} vs ${path}`).toBe(allowed);
    }
  });
});

describe('Turnstile cannot be skipped by sending checks in parallel', () => {
  // Before the fix the "is Turnstile due?" decision read the counter before counting:
  // checks sent together after the 5th all saw 5 and none was asked for a token, so a
  // bot got all 20 checks of the hour without ever solving a challenge.
  it('only the 6th uncached check of the hour passes without a token, however many arrive together', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:15:00Z'));
    const now = Date.now();
    const withTurnstile: Env = { ...env, RATE_LIMITS_DISABLED: '0', TURNSTILE_SECRET_KEY: 'turnstile-test-secret', TURNSTILE_SITE_KEY: '0x4AAAAAAAtestsitekey' };
    const client = '198.51.100.77';
    const bucket = `ogc:${client}:${Math.floor(now / HOUR_MS)}`;
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', bucket, INSPECT.turnstileAfterChecks - 1, now + HOUR_MS);
    const verify = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: false }));

    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => enforcePublicLimit(withTurnstile, client, client, null, now)));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes.filter((o) => o.status === 'rejected')) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'verification_required' });
    }
    // Refused attempts are not counted, and no token was sent to Cloudflare.
    expect((await first<{ count: number }>(env.DB, 'SELECT count FROM tool_usage WHERE bucket = ?1', bucket))?.count).toBe(INSPECT.turnstileAfterChecks);
    expect(verify).not.toHaveBeenCalled();

    // With a valid token the next one passes.
    verify.mockImplementation(async () => Response.json({ success: true }));
    await expect(enforcePublicLimit(withTurnstile, client, client, 'good-token', now)).resolves.toBeUndefined();
  });
});

describe('the image and favicon proxy cannot be used as an unmetered fetcher', () => {
  // Before the fix GET /api/tools/og-check/{id}/favicon re-fetched the recorded favicon
  // on every request, with no limit: the favicon is never probed, so one rate-limited
  // check turned into unlimited GETs of any public URL the checked page names.
  it(`counts proxy fetches per client: request ${INSPECT.proxyFetchesPerHour + 1} in an hour is 429 and fetches nothing`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:15:00Z'));
    const site = host('proxyflood');
    const victim = host('victim');
    const seen = mockNet({
      [`https://${site}/`]: html(`<title>t</title><link rel="icon" href="https://${victim}/expensive?q=1">`),
      [`https://${victim}/expensive`]: png,
    });
    const ip = '198.51.100.88';
    const response = await check(`https://${site}/`, ip);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CheckResult;
    const limited: Env = { ...env, RATE_LIMITS_DISABLED: '0' };
    seen.length = 0;
    for (let i = 1; i <= INSPECT.proxyFetchesPerHour; i++) {
      expect((await call(body.preview.favicon!, { headers: { 'cf-connecting-ip': ip } }, limited)).status, `fetch ${i}`).toBe(200);
    }
    const over = await call(body.preview.favicon!, { headers: { 'cf-connecting-ip': ip } }, limited);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe(String(45 * 60));
    expect((await errorOf(over)).code).toBe('rate_limited');
    expect(seen.filter((url) => url.hostname === victim)).toHaveLength(INSPECT.proxyFetchesPerHour);
    // Another client is not affected.
    expect((await call(body.preview.favicon!, { headers: { 'cf-connecting-ip': '198.51.100.89' } }, limited)).status).toBe(200);
  });
});

describe('oversized tag values', () => {
  // Before the fix a 1.5 MB og:title was returned twice (og.title and preview.title) and
  // stored in D1 as one result row of over 3 MB.
  it('a page with a 1.5 MB og:title still gets a result of bounded size', async () => {
    const site = host('hugetitle');
    const title = 'T'.repeat(1_500_000);
    mockNet({ [`https://${site}/`]: html(`<meta property="og:title" content="${title}"><meta property="og:image" content="/i.png">`), [`https://${site}/i.png`]: png });
    const response = await check(`https://${site}/`, '198.51.100.90');
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    expect(text.length).toBeLessThan(200_000);
    const body = JSON.parse(text) as CheckResult;
    expect(body.og.title!.startsWith('TTTT')).toBe(true);
    const ogTitle = body.checks.find((item) => item.id === 'og_title')!;
    expect(ogTitle.status).toBe('warn');
    const row = await first<{ size: number }>(env.DB, 'SELECT length(result) AS size FROM og_checks WHERE id = ?1', body.id);
    expect(row!.size).toBeLessThan(200_000);
  });
});
