// Security review of the request path: every test here drives the real Worker app
// (or the exact function a route calls) with a hostile or confused client's input.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR, safeNextPath } from '../src/auth/magic-link';
import { DAY_MS, RATE_LIMITS } from '../src/config';
import { first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import { checkRateLimit, clientIp } from '../src/lib/rate-limit';
import type { Env, RateLimitBinding } from '../src/types';
import {
  ORIGIN,
  apiKeyFor,
  bearer,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  errorOf,
  postImage,
  renderCount,
  requestUrl,
  sessionCookieFor,
  signedPath,
  usageOf,
} from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let serial = 0;
const unique = (label: string): string => `${label}-${Date.now().toString(36)}-${++serial}`;

interface SentEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  reply_to?: string;
}

/** Stands in for Resend and records what would have been mailed. */
function mockResend(): SentEmail[] {
  const sent: SentEmail[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected outbound request: ${url.href}`);
    sent.push(JSON.parse(String(init?.body)) as SentEmail);
    return Response.json({ id: `email_${sent.length}` });
  });
  return sent;
}

function authPost(path: string, body: unknown, headers: Record<string, string> = {}, bindings: Env = env): Promise<Response> {
  return call(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, bindings);
}

function linkIn(email: SentEmail | undefined): URL {
  const match = /https?:\/\/\S+\/login\/verify\?\S+/.exec(email?.text ?? '');
  if (!match) throw new Error('no sign-in link in the email');
  return new URL(match[0]);
}

/** A limiter that really counts, so a test can see which requests share a bucket. */
function countingLimiter(limit: number): { binding: RateLimitBinding; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    binding: {
      limit: async ({ key }) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return { success: next <= limit };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

describe('sign-in: the redirect after verification', () => {
  // The URL parser removes "." and ".." segments, so a path that looks same-site
  // before parsing can come out as "//host", which browsers read as another site.
  const OFF_SITE = ['/.//evil.example', '/..//evil.example/login', '/a/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example?x=1', '/./\\evil.example'];

  it('refuses a next path that normalises to another site', () => {
    for (const next of OFF_SITE) expect(safeNextPath(next), next).toBeNull();
    // Dot segments that stay on the site are still fine, and come back normalised.
    expect(safeNextPath('/dashboard/./keys')).toBe('/dashboard/keys');
    expect(safeNextPath('/docs/../dashboard?tab=1#x')).toBe('/dashboard?tab=1#x');
  });

  it('never mails or returns an off-site destination, end to end', async () => {
    const sent = mockResend();
    for (const next of OFF_SITE) {
      const before = sent.length;
      expect((await authPost('/auth/magic-link', { email: `${unique('redir')}@example.com`, next })).status).toBe(200);
      const link = linkIn(sent[before]);
      expect(link.searchParams.get('next'), next).toBeNull();

      // The verify page forwards whatever "next" its own URL carries.
      const verified = await authPost('/auth/verify', { token: link.searchParams.get('token'), next });
      expect(verified.status).toBe(200);
      expect(((await verified.json()) as { redirect: string }).redirect, next).toBe('/dashboard');
    }
  });
});

describe('sign-in: request bodies', () => {
  it('stops reading a body once it is over the cap instead of buffering all of it', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await call('/auth/magic-link', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('payload_too_large');
    // 200 chunks = 12.8 MB were on offer; a capped reader takes one or two.
    expect(pulled).toBeLessThan(10);
  });
});

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

describe('rate limits', () => {
  it('counts every address of one IPv6 /64 as one client', async () => {
    const withIp = (ip: string): Request => new Request('http://localhost/', { headers: { 'cf-connecting-ip': ip } });
    // IPv4 is one address, one client.
    expect(clientIp(withIp('203.0.113.9'))).toBe('203.0.113.9');
    // A home line or a VPS owns a whole /64: 2^64 addresses must not be 2^64 clients.
    const a = clientIp(withIp('2001:db8:77:1::1'));
    expect(clientIp(withIp('2001:db8:77:1:aaaa:bbbb:cccc:dddd'))).toBe(a);
    expect(clientIp(withIp('2001:0DB8:0077:0001:0:0:0:2'))).toBe(a);
    expect(clientIp(withIp('2001:db8:77:2::1'))).not.toBe(a);
    expect(clientIp(withIp('2001:db8:77::1'))).not.toBe(a);
    expect(clientIp(withIp('2001:db8:77:1::'))).toBe(a);
    expect(a).toBe('2001:db8:77:1::/64');
    expect(clientIp(withIp('::1'))).toBe('0:0:0:0::/64');
    // An IPv4 client written as IPv6 is the same client as its plain form.
    expect(clientIp(withIp('::ffff:203.0.113.9'))).toBe('203.0.113.9');
    // Anything unexpected is still a key of its own, never an error.
    expect(clientIp(withIp('not:an:address'))).toBe('not:an:address');
    expect(clientIp(withIp('1:2:3:4:5:6:7:8:9'))).toBe('1:2:3:4:5:6:7:8:9');
    expect(clientIp(new Request('http://localhost/'))).toBe('unknown');
  });

  it('does not let one IPv6 network request sign-in mail without limit by rotating addresses', async () => {
    const sent = mockResend();
    const { binding, counts } = countingLimiter(RATE_LIMITS.RL_AUTH.limit);
    const limited: Env = { ...env, RATE_LIMITS_DISABLED: '0', RL_AUTH: binding };
    const statuses: number[] = [];
    for (let i = 1; i <= RATE_LIMITS.RL_AUTH.limit + 3; i++) {
      const headers = { 'cf-connecting-ip': `2001:db8:99:5::${i.toString(16)}` };
      statuses.push((await authPost('/auth/magic-link', { email: `${unique('v6')}@example.com` }, headers, limited)).status);
    }
    expect(counts.size).toBe(1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(3);
    expect(sent).toHaveLength(RATE_LIMITS.RL_AUTH.limit);
  });

  it('caps the sign-in emails one client can have sent in an hour, whatever the addresses', async () => {
    const sent = mockResend();
    const start = Date.UTC(2026, 10, 22, 9);
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const from = (ip: string): Promise<Response> => authPost('/auth/magic-link', { email: `${unique('bomb')}@example.com` }, { 'cf-connecting-ip': ip });

    // Paced below the per-minute limiter (off in this suite anyway): one request every 20 s.
    for (let i = 0; i < MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR; i++) {
      vi.setSystemTime(start + i * 20_000);
      expect((await from('198.51.100.77')).status).toBe(200);
    }
    const refused = await from('198.51.100.77');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('3600');
    expect((await errorOf(refused)).code).toBe('rate_limited');
    expect(sent).toHaveLength(MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR);

    // Another client is not affected, and the first one can ask again an hour later.
    expect((await from('198.51.100.78')).status).toBe(200);
    vi.setSystemTime(start + 60 * 60 * 1000 + MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR * 20_000);
    expect((await from('198.51.100.77')).status).toBe(200);
    expect(sent).toHaveLength(MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR + 2);
  });

  it('honours RATE_LIMITS_DISABLED only when ENVIRONMENT is "test"', async () => {
    const deny: RateLimitBinding = { limit: async () => ({ success: false }) };
    for (const environment of ['production', 'staging', 'development'] as const) {
      const bindings: Env = { ...env, ENVIRONMENT: environment, RATE_LIMITS_DISABLED: '1', RL_IP: deny };
      expect(await checkRateLimit(bindings, 'RL_IP', 'x'), environment).toBe(false);
    }
    expect(await checkRateLimit({ ...env, RATE_LIMITS_DISABLED: '1', RL_IP: deny }, 'RL_IP', 'x')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* SSRF through the product                                            */
/* ------------------------------------------------------------------ */

describe('SSRF: nothing a customer writes makes the Worker contact a non-public address', () => {
  const DOH = 'https://cloudflare-dns.com/dns-query';
  const REDIRECTOR = 'https://public.review.example.org/redirect';
  const svgWithRemoteImage = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="http://127.0.0.1/nested.png" width="10" height="10"/></svg>');

  /** [what is tried, html, css, data] */
  const VECTORS: Array<[string, string, string?, Record<string, string>?]> = [
    ['loopback', '<img src="http://127.0.0.1/a.png" width="10" height="10">'],
    ['loopback short form', '<img src="http://127.1/a.png" width="10" height="10">'],
    ['zero address', '<img src="http://0/a.png" width="10" height="10">'],
    ['decimal IPv4', '<img src="http://2130706433/a.png" width="10" height="10">'],
    ['hex IPv4', '<img src="http://0x7f.1/a.png" width="10" height="10">'],
    ['octal IPv4', '<img src="http://017700000001/a.png" width="10" height="10">'],
    ['full-width digits', '<img src="http://１２７.0.0.1/a.png" width="10" height="10">'],
    ['IPv6 loopback', '<img src="http://[::1]/a.png" width="10" height="10">'],
    ['IPv4-mapped IPv6 metadata', '<img src="http://[::ffff:169.254.169.254]/a.png" width="10" height="10">'],
    ['NAT64 private', '<img src="http://[64:ff9b::a00:5]/a.png" width="10" height="10">'],
    ['6to4 private', '<img src="http://[2002:a00:5::1]/a.png" width="10" height="10">'],
    ['unique local IPv6', '<img src="http://[fd00::1]/a.png" width="10" height="10">'],
    ['link-local IPv6', '<img src="http://[fe80::1]/a.png" width="10" height="10">'],
    ['localhost with a trailing dot', '<img src="http://localhost./a.png" width="10" height="10">'],
    ['internal suffix', '<img src="http://metadata.google.internal/computeMetadata/v1/" width="10" height="10">'],
    ['userinfo', '<img src="https://user:pass@public.review.example.org/a.png" width="10" height="10">'],
    ['non-default port', '<img src="https://public.review.example.org:8443/a.png" width="10" height="10">'],
    ['protocol-relative', '<img src="//127.0.0.1/a.png" width="10" height="10">'],
    ['file scheme', '<img src="file:///etc/passwd" width="10" height="10">'],
    ['ftp scheme', '<img src="ftp://127.0.0.1/a.png" width="10" height="10">'],
    ['a public name that resolves privately', '<img src="https://rebind.review.example.org/a.png" width="10" height="10">'],
    ['a redirect to a private address', `<img src="${REDIRECTOR}" width="10" height="10">`],
    ['a name whose DNS lookup fails', '<img src="https://nodns.review.example.org/a.png" width="10" height="10">'],
    ['srcset', '<img srcset="http://127.0.0.1/ss.png 1x" width="10" height="10">'],
    ['stylesheet link', '<link rel="stylesheet" href="http://127.0.0.1/l.css"><div class="c">x</div>'],
    ['iframe, object, video', '<div class="c"><iframe src="http://127.0.0.1/f"></iframe><object data="http://127.0.0.1/o"></object><video poster="http://127.0.0.1/p.png"></video></div>'],
    ['inline style', '<div class="c" style="background-image:url(http://127.0.0.1/s.png)">x</div>'],
    ['inline svg image', '<svg width="10" height="10" viewBox="0 0 10 10"><image href="http://127.0.0.1/i.png" width="10" height="10"/></svg>'],
    ['svg data URI with a remote image inside', `<img src="data:image/svg+xml;base64,${svgWithRemoteImage}" width="10" height="10">`],
    ['substituted image URL', '<img src="{{image}}" width="10" height="10">', undefined, { image: 'http://169.254.169.254/latest/meta-data/' }],
    ['substituted into inline style', '<div class="c" style="background-image:url({{image}})">x</div>', undefined, { image: 'http://10.0.0.5/b.png' }],
    ['css background', '<div class="c">x</div>', '.c { display: flex; background-image: url(http://169.254.169.254/latest/meta-data/); }'],
    ['css mask', '<div class="c">x</div>', '.c { display: flex; mask-image: url("http://127.0.0.1/m.png"); }'],
    ['css @import', '<div class="c">x</div>', '@import url(http://127.0.0.1/x.css); .c { display: flex; }'],
    ['css @font-face', '<div class="c">x</div>', '@font-face { font-family: X; src: url(http://127.0.0.1/f.ttf); } .c { display: flex; font-family: X; }'],
  ];

  function mockNetwork(): () => string[] {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.origin + url.pathname === DOH) {
        const name = url.searchParams.get('name') ?? '';
        const isA = url.searchParams.get('type') === 'A';
        if (name.startsWith('nodns.')) return new Response('upstream error', { status: 502 });
        const address = name.startsWith('rebind.') ? '10.0.0.5' : '93.184.216.34';
        return Response.json({ Status: 0, Answer: isA ? [{ name, type: 1, TTL: 0, data: address }] : [] });
      }
      if (url.href === REDIRECTOR) return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret.png' } });
      throw new Error(`unexpected fetch ${url.href}`);
    });
    return () => fetchMock.mock.calls.map(([input]) => requestUrl(input).href);
  }

  const allowed = (url: string): boolean => url.startsWith(`${DOH}?`) || url === REDIRECTOR;

  it('holds for the dashboard preview, whatever the markup or CSS', async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user.id);
    const fetched = mockNetwork();
    const outcomes: string[] = [];
    for (const [label, html, css, data] of VECTORS) {
      const response = await dashboard(cookie, 'POST', '/api/preview', { html, ...(css ? { css } : {}), ...(data ? { data } : {}) });
      outcomes.push(`${label}: ${response.status}`);
      // Whatever the answer, it is never a server error, and no request left for a refused target.
      expect(response.status, label).toBeLessThan(500);
      expect(fetched().filter((url) => !allowed(url)), label).toEqual([]);
      await response.arrayBuffer();
    }
    // The three that depend on the network were refused, not drawn.
    for (const label of ['a public name that resolves privately', 'a redirect to a private address', 'a name whose DNS lookup fails']) {
      expect(outcomes).toContain(`${label}: 422`);
    }
    expect(fetched()).toContain(REDIRECTOR);
  });

  it('holds for POST /v1/images and for a signed URL, and a refused image is never counted', async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user.id);
    const key = await apiKeyFor(user.id);
    const site = await createSite(user.id);
    const templateId = await createTemplate(cookie, '<div style="display:flex"><img src="{{image}}" width="100" height="100"></div>', '');
    const fetched = mockNetwork();

    for (const image of ['http://[::ffff:10.0.0.1]/a.png', 'https://rebind.review.example.org/a.png', REDIRECTOR, 'https://nodns.review.example.org/a.png']) {
      const viaApi = await postImage(key.secret, { template: templateId, data: { image } });
      expect(viaApi.status, image).toBe(422);
      expect((await errorOf(viaApi)).code, image).toBe('image_fetch_failed');

      const viaUrl = await call(await signedPath(site, templateId, { image }));
      expect(viaUrl.status, image).toBe(422);
      expect(viaUrl.headers.get('cache-control')).toBe('no-store');
      await viaUrl.arrayBuffer();
    }
    expect(fetched().filter((url) => !allowed(url))).toEqual([]);
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Signed URLs                                                         */
/* ------------------------------------------------------------------ */

describe('signed URLs: nothing unsigned reaches the renderer', () => {
  it('rejects an invalid signature before any quota read, render or outbound request', async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user.id);
    const site = await createSite(user.id);
    const templateId = await createTemplate(cookie, '<div style="display:flex"><img src="{{image}}" width="100" height="100"></div>', '');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`unexpected fetch ${requestUrl(input).href}`);
    });
    const good = await signedPath(site, templateId, { image: 'https://cdn.review.example.org/a.png' });
    const forged = good.replace(/sig=[0-9a-f]{4}/, (match) => `sig=${match.endsWith('0000') ? '1111' : '0000'}`);
    const statements = vi.spyOn(env.DB, 'prepare');

    const response = await call(forged);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('invalid_signature');
    expect(fetchMock).not.toHaveBeenCalled();
    // Only the site and its owner were read: no usage, top-up, template or ledger query ran.
    const sql = statements.mock.calls.map(([text]) => text).join('\n');
    expect(sql).not.toMatch(/usage_periods|topups|renders|templates/);
    expect(await renderCount(user.id)).toBe(0);
  });

  it('refuses smuggled, duplicated and re-typed parameters, and a signature made for another path', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const good = await signedPath(site, 'blog', { title: 'Smuggle' });
    const [path, query] = good.split('?') as [string, string];
    const tampered: Array<[string, string, number]> = [
      ['an extra unsigned parameter', `${good}&utm_source=x`, 403],
      ['an extra unsigned size', `${good}&size=portrait`, 403],
      ['a duplicated parameter', `${good}&title=Other`, 403],
      ['a duplicated signature', `${good}&sig=${'0'.repeat(64)}`, 403],
      ['an empty parameter name', `${good}&=x`, 403],
      ['an encoded separator inside a value', `${path}?title=Smuggle%26size%3Dportrait&${query.split('&')[1]}`, 403],
      ['a line break inside a value', `${path}?title=Smuggle%0Asize%3Dportrait&${query.split('&')[1]}`, 403],
      ['bytes that are not UTF-8', `${path}?title=Smuggle%FF&${query.split('&')[1]}`, 403],
      ['the same signature on .jpg', good.replace('/blog.png', '/blog.jpg'), 403],
      ['the same signature on another template', good.replace('/blog.png', '/dark.png'), 403],
      ['an upper-case extension', good.replace('/blog.png', '/blog.PNG'), 404],
      ['a trailing path segment', good.replace('/blog.png', '/blog.png/x'), 404],
    ];
    for (const [label, url, status] of tampered) {
      const response = await call(url);
      expect(response.status, label).toBe(status);
      await response.arrayBuffer();
    }
    expect(await renderCount(user.id)).toBe(0);
  });

  it('charges one image for one card however the same signed URL is re-encoded', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const good = await signedPath(site, 'blog', { title: 'Two words' });
    expect(good).toContain('title=Two+words');
    const variants = [good, good.replace('Two+words', 'Two%20words'), good.replace('Two+words', '%54wo+words'), good.replace(/sig=([0-9a-f]+)/, (_, hex: string) => `sig=${hex.toUpperCase()}`)];
    for (const url of variants) {
      const response = await call(url);
      expect(response.status, url).toBe(200);
      await response.arrayBuffer();
    }
    expect(await renderCount(user.id)).toBe(1);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('answers 404 for a deleted site even with a signature that used to be valid', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const good = await signedPath(site, 'blog', { title: unique('deleted') });
    await run(env.DB, 'UPDATE sites SET deleted_at = ?1 WHERE id = ?2', Date.now(), site.id);
    expect((await call(good)).status).toBe(404);
    expect(await renderCount(user.id)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* CSRF and API keys                                                   */
/* ------------------------------------------------------------------ */

describe('CSRF: a cross-site page cannot write with the visitor\'s session', () => {
  it('refuses cross-site, origin-less-with-wrong-type and method-override attempts on every kind of write', async () => {
    const user = await createUser('starter');
    const cookie = await sessionCookieFor(user.id);
    const site = await createSite(user.id);
    const key = await apiKeyFor(user.id);
    const evil = 'https://evil.example';
    const attempts: Array<[string, string, RequestInit]> = [
      ['form post', '/api/keys', { method: 'POST', headers: { cookie, origin: evil, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' }],
      ['text/plain JSON', '/api/keys', { method: 'POST', headers: { cookie, origin: evil, 'content-type': 'text/plain' }, body: '{"name":"x"}' }],
      ['text/plain JSON without Origin', '/api/keys', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{"name":"x"}' }],
      ['body without a content type', '/api/keys', { method: 'POST', headers: { cookie }, body: new TextEncoder().encode('{"name":"x"}') }],
      ['JSON with a foreign Origin', '/api/keys', { method: 'POST', headers: { cookie, origin: evil, 'content-type': 'application/json' }, body: '{"name":"x"}' }],
      ['JSON from the opaque origin', '/api/keys', { method: 'POST', headers: { cookie, origin: 'null', 'content-type': 'application/json' }, body: '{"name":"x"}' }],
      ['empty cross-site post', `/api/sites/${site.id}/rotate`, { method: 'POST', headers: { cookie, origin: evil, 'content-length': '0' } }],
      ['empty cross-site delete', `/api/sites/${site.id}`, { method: 'DELETE', headers: { cookie, origin: evil } }],
      ['cross-site logout', '/auth/logout', { method: 'POST', headers: { cookie, origin: evil, 'content-length': '0' } }],
      ['font upload from another origin', '/api/fonts?family=Evil', { method: 'POST', headers: { cookie, origin: evil, 'content-type': 'font/woff' }, body: new Uint8Array([0x77, 0x4f, 0x46, 0x46]) }],
      ['font upload without Origin', '/api/fonts?family=Evil', { method: 'POST', headers: { cookie, 'content-type': 'font/woff' }, body: new Uint8Array([0x77, 0x4f, 0x46, 0x46]) }],
      ['font upload as a form', '/api/fonts?family=Evil', { method: 'POST', headers: { cookie, origin: evil, 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' }],
    ];
    for (const [label, path, init] of attempts) {
      const response = await call(path, init);
      expect(response.status, label).toBe(403);
      expect((await errorOf(response)).code, label).toBe('forbidden');
    }
    // A GET (which needs no Origin) cannot be turned into a write.
    for (const path of [`/api/keys/${key.id}?_method=DELETE`, `/api/sites/${site.id}?_method=DELETE`]) {
      const response = await call(path, { headers: { cookie, 'x-http-method-override': 'DELETE', 'x-method-override': 'DELETE' } });
      expect(response.status, path).toBe(404);
    }

    // Nothing changed: the session, the key and the site (with its secret version) are all still there.
    const keys = (await (await dashboard(cookie, 'GET', '/api/keys')).json()) as { keys: Array<{ id: string }> };
    expect(keys.keys.map((entry) => entry.id)).toEqual([key.id]);
    const sites = (await (await dashboard(cookie, 'GET', '/api/sites')).json()) as { sites: Array<{ id: string; secret_version: number }> };
    expect(sites.sites).toMatchObject([{ id: site.id, secret_version: 1 }]);
    expect(((await (await dashboard(cookie, 'GET', '/api/fonts')).json()) as { fonts: unknown[] }).fonts).toEqual([]);
  });
});

describe('API keys', () => {
  it('are accepted only in the Authorization header and never echoed back', async () => {
    const user = await createUser();
    const key = await apiKeyFor(user.id);
    for (const path of [`/v1/usage?api_key=${key.secret}`, `/v1/usage?key=${key.secret}`, `/v1/usage?access_token=${key.secret}`, `/v1/usage?authorization=Bearer%20${key.secret}`]) {
      const response = await call(path);
      expect(response.status, path).toBe(401);
      expect(await response.text()).not.toContain(key.secret.slice(8));
    }
    const elsewhere: Array<Record<string, string>> = [{ 'x-api-key': key.secret }, { cookie: `ltc_session=${key.secret}` }, { authorization: `Basic ${btoa(`${key.secret}:`)}` }];
    for (const headers of elsewhere) {
      expect((await call('/v1/usage', { headers })).status).toBe(401);
    }
    const wrong = `${key.secret.slice(0, -4)}${key.secret.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`;
    const refused = await call('/v1/usage', { headers: bearer(wrong) });
    expect(refused.status).toBe(401);
    const text = await refused.text();
    expect(text).not.toContain(wrong);
    expect(text).not.toContain(wrong.slice(4, 20));
    expect((await call('/v1/usage', { headers: bearer(key.secret) })).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Contact form                                                        */
/* ------------------------------------------------------------------ */

describe('contact form', () => {
  it('cannot be used to inject headers or markup, or to mail anyone but support', async () => {
    const sent = mockResend();
    const post = (body: unknown): Promise<Response> => authPost('/api/contact', body);

    for (const email of ['a@b.example\r\nBcc: victim@example.org', 'a@b.example\nSubject: x', 'a@b.example, victim@example.org', '"x" <victim@example.org>', 'victim@example.org;a@b.example']) {
      expect((await post({ email, message: 'hello' })).status, email).toBe(400);
    }
    expect(sent).toHaveLength(0);

    const message = '<img src=x onerror=alert(1)><a href="https://evil.example">click</a>\r\nBcc: victim@example.org';
    expect((await post({ email: 'Visitor@Example.org', message, to: 'victim@example.org', subject: 'Hacked', from: 'ceo@example.org' })).status).toBe(200);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(env.SUPPORT_EMAIL);
    expect(mail.reply_to).toBe('visitor@example.org');
    expect(mail.subject).toBe('Contact form: visitor@example.org');
    expect((mail as unknown as { from: string }).from).toBe(env.MAIL_FROM);
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<a href');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

describe('cleanup', () => {
  it('keeps pace with a busy day: 1,000 expired images are gone after one run, live ones stay', async () => {
    const now = Date.UTC(2026, 10, 22, 3, 17);
    const user = await createUser('pro', now - 200 * DAY_MS);
    await runCleanup(env, now);
    // More than the 330 or so images a single Pro account renders (and so expires) per day.
    const expiredRows = 1000;
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
       SELECT 'review_expired_' || i, ?2, NULL, 'og', 'blog', 1200, 630, 'png', 1, 'r/' || ?2 || '/review_expired_' || i || '.png', 'plan', 0, 0, ?3 FROM n`,
      expiredRows,
      user.id,
      now,
    );
    const insertOne = (key: string, expiresAt: number): Promise<number> =>
      run(
        env.DB,
        `INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
         VALUES (?1, ?2, NULL, 'og', 'blog', 1200, 630, 'png', 1, ?3, 'plan', 0, 0, ?4)`,
        key,
        user.id,
        `r/${user.id}/${key}.png`,
        expiresAt,
      );
    // One millisecond of life left: the reader still serves it, so the cleanup must not touch it.
    await insertOne('review_live', now + 1);
    for (const key of ['review_expired_1', 'review_expired_1000', 'review_live']) {
      await env.BUCKET.put(`r/${user.id}/${key}.png`, new Uint8Array([1]), { customMetadata: { expiresAt: String(key === 'review_live' ? now + 1 : now) } });
    }
    // Objects of other kinds under the same account must never be swept up with them.
    await env.BUCKET.put(`f/${user.id}/f_review`, new Uint8Array([2]));

    const report = await runCleanup(env, now);
    expect(report.renders).toBe(expiredRows);
    const left = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM renders WHERE user_id = ?1', user.id);
    expect(left?.n).toBe(1);
    expect(await env.BUCKET.head(`r/${user.id}/review_expired_1.png`)).toBeNull();
    expect(await env.BUCKET.head(`r/${user.id}/review_expired_1000.png`)).toBeNull();
    expect(await env.BUCKET.head(`r/${user.id}/review_live.png`)).not.toBeNull();
    expect(await env.BUCKET.head(`f/${user.id}/f_review`)).not.toBeNull();
  });
});
