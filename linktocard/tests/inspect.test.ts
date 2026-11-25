/// <reference path="./fixtures/og/raw.d.ts" />
// The OG checker through the real Worker: GET /api/tools/og-check, the image proxy,
// GET /v1/inspect, the SSRF guard, the D1 cache and every limit. All outbound HTTP
// (DoH, pages, images, robots.txt, Turnstile) is a mocked fetch.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSPECT } from '../src/config';
import { first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import type { CheckResult } from '../src/inspect/types';
import type { Env } from '../src/types';
import { apiKeyFor, bearer, call, createUser, dohAnswer, errorOf, requestUrl, usageOf } from './app-helpers';
import goodHtml from './fixtures/og/good.html?raw';
import httpImageHtml from './fixtures/og/http-image.html?raw';
import hugeImageHtml from './fixtures/og/huge-image.html?raw';
import { imageFile } from './fixtures/og/images';
import missingHtml from './fixtures/og/missing-tags.html?raw';
import nonHtml from './fixtures/og/non-html.json';
import redirectChain from './fixtures/og/redirect-chain.json';
import relativeHtml from './fixtures/og/relative-image.html?raw';

const MB = 1024 * 1024;
const UA = 'LinkToCardBot/1.0 (+https://linktocard.com/bot)';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Unique host names: the DoH answers are cached in memory for up to a minute. */
let serial = 0;
const host = (label: string): string => `${label}-${++serial}.ogfixtures.com`;

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body?: BodyInit | null;
}

type Handler = (url: URL, method: string) => Response | Promise<Response>;

/**
 * Mocks every outbound request. `routes` maps an exact URL (no query) to a handler;
 * `dns` maps a host name to the addresses DoH should return; anything else resolves
 * to a public address. Unknown URLs are 404 (so robots.txt is "no rules" by default).
 */
function mockNet(routes: Record<string, Handler>, dns: Record<string, string[] | 'servfail'> = {}): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const answer = dns[name];
      if (answer === 'servfail') return Response.json({ Status: 2 });
      if (!answer) return dohAnswer(url);
      const type = url.searchParams.get('type') === 'A' ? 1 : 28;
      const records = answer.filter((ip) => (type === 1) === !ip.includes(':'));
      return Response.json({ Status: 0, Answer: records.map((data) => ({ name, type, TTL: 60, data })) });
    }
    const method = init?.method ?? 'GET';
    seen.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
    const handler = routes[`${url.origin}${url.pathname}`];
    return handler ? handler(url, method) : new Response('not found', { status: 404 });
  });
  return seen;
}

const html = (body: string): Handler => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const png = (width = 1200, height = 630, bytes = 0, headers: Record<string, string> = {}): Handler => () =>
  new Response(imageFile('png', width, height, bytes), { headers: { 'content-type': 'image/png', ...headers } });
const redirect = (location: string, status = 302): Handler => () => new Response(null, { status, headers: { location } });

function check(url: string, extra: Record<string, string> = {}, bindings: Env = env, ip = '203.0.113.9'): Promise<Response> {
  const query = new URLSearchParams({ url, ...extra });
  return call(`/api/tools/og-check?${query.toString()}`, { headers: { 'cf-connecting-ip': ip } }, bindings);
}

async function result(response: Response): Promise<CheckResult> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CheckResult;
}

const statusOf = (body: CheckResult, id: string): string | undefined => body.checks.find((item) => item.id === id)?.status;

/** The good fixture page served at https://<site>/widgets with its images on the same site. */
function goodSite(site: string): Record<string, Handler> {
  const page = goodHtml.replaceAll('https://cdn.ogfixtures.com', `https://${site}`).replaceAll('https://shop.ogfixtures.com', `https://${site}`);
  return {
    [`https://${site}/widgets`]: html(page),
    [`https://${site}/card.png`]: png(),
    [`https://${site}/static/icon-32.png`]: png(32, 32),
  };
}

describe('GET /api/tools/og-check: a good page', () => {
  it('returns parsed fields, the image probe and a passing checklist, never the HTML', async () => {
    const site = host('good');
    const seen = mockNet(goodSite(site));
    const body = await result(await check(`https://${site.toUpperCase()}/widgets#top`));

    expect(body.id).toMatch(/^chk_[0-9a-z]{16}$/);
    expect(body).toMatchObject({ url: `https://${site}/widgets`, final_url: `https://${site}/widgets`, status: 200, cached: false });
    expect(Date.parse(body.expires_at) - Date.parse(body.fetched_at)).toBe(INSPECT.cacheTtlMs);
    expect(body.page).toEqual({
      title: 'Acme Widgets & Gadgets',
      description: 'Hand-made widgets, shipped worldwide.',
      canonical: `https://${site}/widgets`,
      favicon: `https://${site}/static/icon-32.png`,
      theme_color: '#0f766e',
    });
    expect(body.og.title).toBe('Acme Widgets');
    expect(body.twitter.card).toBe('summary_large_image');
    expect(body.image).toMatchObject({ url: `https://${site}/card.png`, status: 200, content_type: 'image/png', width: 1200, height: 630, aspect_ratio: 1.905 });
    expect(body.robots).toEqual({ checked: true, allowed: true, note: expect.stringContaining('404') });
    expect(body.checks.map((item) => item.id)).toHaveLength(12);
    expect(body.checks.filter((item) => item.status !== 'pass')).toEqual([]);
    expect(body.preview).toEqual({
      title: 'Acme Widgets',
      description: 'Hand-made widgets, shipped worldwide.',
      domain: site,
      site_name: 'Acme',
      image: `/api/tools/og-check/${body.id}/image`,
      favicon: `/api/tools/og-check/${body.id}/favicon`,
    });
    expect(JSON.stringify(body)).not.toContain('SECRET-BODY-MARKER');
    expect(JSON.stringify(body)).not.toContain('<meta');

    // One page, one HEAD + GET of the image, one robots.txt; every request carries our User-Agent.
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`).sort()).toEqual(['GET /card.png', 'GET /robots.txt', 'GET /widgets', 'HEAD /card.png']);
    for (const request of seen) expect(request.headers.get('user-agent')).toBe(UA);
    expect(INSPECT.userAgent).toBe(UA);
  });

  it('serves the second check of the same URL from the cache without fetching', async () => {
    const site = host('cache');
    const seen = mockNet(goodSite(site));
    const firstResult = await result(await check(`https://${site}/widgets`));
    const fetches = seen.length;
    const second = await result(await check(`https://${site}/widgets`));
    expect(second).toEqual({ ...firstResult, cached: true });
    expect(seen.length).toBe(fetches);
  });
});

describe('GET /api/tools/og-check: fixture pages', () => {
  it('missing tags: og_image, og_title fail; twitter_card, og_description warn; default favicon', async () => {
    const site = host('missing');
    mockNet({ [`https://${site}/`]: html(missingHtml) });
    const body = await result(await check(`https://${site}/`));
    expect(body.image).toBeNull();
    expect(statusOf(body, 'og_image')).toBe('fail');
    expect(statusOf(body, 'og_title')).toBe('fail');
    expect(statusOf(body, 'twitter_card')).toBe('warn');
    expect(statusOf(body, 'og_description')).toBe('warn');
    expect(body.page.favicon).toBe(`https://${site}/favicon.ico`);
    expect(body.preview).toMatchObject({ title: 'Only a title', image: null });
  });

  it('relative og:image: resolved against the final URL, but reported', async () => {
    const site = host('relative');
    mockNet({
      [`https://${site}/old`]: redirect('/blog/post'),
      [`https://${site}/blog/post`]: html(relativeHtml),
      [`https://${site}/blog/images/card.png`]: png(),
    });
    const body = await result(await check(`https://${site}/old`));
    expect(body.final_url).toBe(`https://${site}/blog/post`);
    expect(body.og.image).toBe('images/card.png');
    expect(body.image?.url).toBe(`https://${site}/blog/images/card.png`);
    expect(body.image?.status).toBe(200);
    expect(statusOf(body, 'og_image_absolute')).toBe('fail');
    expect(body.checks.find((item) => item.id === 'og_image_absolute')?.detail).toContain(`https://${site}/blog/images/card.png`);
    expect(body.page.favicon).toBe(`https://${site}/blog/favicon-16.ico`);
  });

  it('http og:image: og_image_https fails, the image is still probed', async () => {
    const site = host('http');
    const page = httpImageHtml.replace('http://cdn.ogfixtures.com', `http://${site}`);
    mockNet({ [`https://${site}/`]: html(page), [`http://${site}/card.png`]: png() });
    const body = await result(await check(`https://${site}/`));
    expect(statusOf(body, 'og_image_https')).toBe('fail');
    expect(statusOf(body, 'og_image_reachable')).toBe('pass');
  });

  it('huge image: a 6 MB image warns, a 9 MB one is read only up to 8 MB', async () => {
    const site = host('huge');
    const page = hugeImageHtml.replace('https://cdn.ogfixtures.com', `https://${site}`);
    mockNet({ [`https://${site}/`]: html(page), [`https://${site}/huge.png`]: png(1200, 630, 6 * MB) });
    const body = await result(await check(`https://${site}/`));
    expect(body.image).toMatchObject({ bytes: 6 * MB, width: 1200, height: 630 });
    expect(statusOf(body, 'og_image_size')).toBe('warn');

    const big = host('bigger');
    mockNet({ [`https://${big}/`]: html(hugeImageHtml.replace('https://cdn.ogfixtures.com', `https://${big}`)), [`https://${big}/huge.png`]: png(1200, 630, 9 * MB) });
    const bigger = await result(await check(`https://${big}/`));
    expect(bigger.image).toMatchObject({ bytes: null, width: 1200 });
    expect(statusOf(bigger, 'og_image_size')).toBe('warn');
    expect(bigger.checks.find((item) => item.id === 'og_image_size')?.detail).toContain('8 MB');
  });

  it('a 100 px image fails og_image_dimensions; image formats are measured', async () => {
    const site = host('small');
    const page = (image: string): string => `<meta property="og:image" content="https://${site}/${image}"><meta property="og:title" content="t">`;
    mockNet({
      [`https://${site}/small`]: html(page('small.png')),
      [`https://${site}/small.png`]: png(100, 100),
      [`https://${site}/jpeg`]: html(page('a.jpg')),
      [`https://${site}/a.jpg`]: () => new Response(imageFile('jpeg', 1200, 630), { headers: { 'content-type': 'image/jpeg' } }),
      [`https://${site}/webp`]: html(page('a.webp')),
      [`https://${site}/a.webp`]: () => new Response(imageFile('webp-vp8x', 1200, 630), { headers: { 'content-type': 'image/webp' } }),
      [`https://${site}/gif`]: html(page('a.gif')),
      [`https://${site}/a.gif`]: () => new Response(imageFile('gif', 1080, 1080), { headers: { 'content-type': 'image/gif' } }),
    });
    const small = await result(await check(`https://${site}/small`));
    expect(statusOf(small, 'og_image_dimensions')).toBe('fail');
    expect((await result(await check(`https://${site}/jpeg`))).image).toMatchObject({ width: 1200, height: 630, content_type: 'image/jpeg' });
    expect((await result(await check(`https://${site}/webp`))).image).toMatchObject({ width: 1200, height: 630 });
    const gif = await result(await check(`https://${site}/gif`));
    expect(gif.image).toMatchObject({ width: 1080, height: 1080, aspect_ratio: 1 });
    expect(statusOf(gif, 'og_image_ratio')).toBe('warn');
  });

  it('an image URL that is not an image fails og_image_reachable and has no preview image', async () => {
    const site = host('notimage');
    mockNet({
      [`https://${site}/`]: html(`<meta property="og:image" content="https://${site}/card">`),
      [`https://${site}/card`]: html('<p>an HTML error page</p>'),
    });
    const body = await result(await check(`https://${site}/`));
    expect(statusOf(body, 'og_image_reachable')).toBe('fail');
    expect(body.preview.image).toBeNull();
  });

  it('non-HTML response: 422 page_fetch_failed / not_html', async () => {
    const site = host('json');
    mockNet({ [`https://${site}/api`]: () => new Response(nonHtml.body, { headers: { 'content-type': nonHtml.contentType } }) });
    const response = await check(`https://${site}/api`);
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error).toMatchObject({ code: 'page_fetch_failed', details: { reason: 'not_html' } });
    expect(error.message).toContain('application/json');
  });

  it('HTTP error from the site: 422 with the status', async () => {
    const site = host('gone');
    mockNet({ [`https://${site}/`]: () => new Response('no', { status: 503 }) });
    expect(await errorOf(await check(`https://${site}/`))).toMatchObject({ code: 'page_fetch_failed', details: { reason: 'http_error', status: 503 } });
  });

  it('redirect chain: three hops are followed, each re-checked; a fourth is too many', async () => {
    const routes: Record<string, Handler> = {};
    for (const hop of redirectChain.hops) routes[hop.from] = redirect(hop.location, hop.status);
    routes[redirectChain.final] = html(goodHtml);
    const seen = mockNet(routes);
    const body = await result(await check(redirectChain.start));
    expect(body.final_url).toBe(redirectChain.final);
    expect(seen.filter((s) => s.url.pathname !== '/robots.txt' && !s.url.hostname.startsWith('cdn')).map((s) => s.url.href)).toEqual([
      ...redirectChain.hops.map((hop) => hop.from),
      redirectChain.final,
    ]);

    const site = host('loop');
    mockNet({
      [`https://${site}/1`]: redirect('/2'),
      [`https://${site}/2`]: redirect('/3'),
      [`https://${site}/3`]: redirect('/4'),
      [`https://${site}/4`]: redirect('/5'),
      [`https://${site}/5`]: html(goodHtml),
    });
    const response = await check(`https://${site}/1`);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'too_many_redirects' });
  });
});

describe('GET /api/tools/og-check: SSRF guard', () => {
  const blocked = [
    'https://127.0.0.1/',
    'https://10.1.2.3/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://[fd00::1]/',
    'https://[::ffff:10.0.0.1]/',
    'https://100.64.0.1/',
    'https://localhost/',
    'https://printer.internal/',
    'https://2130706433/',
  ];
  for (const url of blocked) {
    it(`refuses ${url} with 403 and fetches nothing`, async () => {
      const seen = mockNet({});
      const response = await check(url);
      expect(response.status).toBe(403);
      const error = await errorOf(response);
      expect(error.code).toBe('forbidden');
      expect(error.details).toBeUndefined();
      expect(seen).toEqual([]);
    });
  }

  it('refuses a host name that resolves to a private address (mocked DoH), without revealing it', async () => {
    const name = host('private');
    const seen = mockNet({ [`https://${name}/`]: html(goodHtml) }, { [name]: ['93.184.216.34', '10.0.0.5'] });
    const response = await check(`https://${name}/`);
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain('10.0.0.5');
    expect(text).toContain('forbidden');
    expect(seen).toEqual([]);
  });

  it('refuses a host whose AAAA record is unique-local', async () => {
    const name = host('ula');
    const seen = mockNet({}, { [name]: ['fd12:3456::1'] });
    expect((await check(`https://${name}/`)).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('fails closed when DoH cannot answer', async () => {
    const name = host('servfail');
    const seen = mockNet({ [`https://${name}/`]: html(goodHtml) }, { [name]: 'servfail' });
    const response = await check(`https://${name}/`);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'dns_failed' });
    expect(seen).toEqual([]);
  });

  it('refuses a redirect to a private address before following it', async () => {
    const name = host('redir');
    const inside = host('inside');
    const seen = mockNet(
      { [`https://${name}/`]: redirect(`https://${inside}/admin`), [`https://169.254.169.254/`]: html('') },
      { [inside]: ['192.168.1.1'] },
    );
    expect((await check(`https://${name}/`)).status).toBe(403);
    expect(seen.map((s) => s.url.hostname)).toEqual([name]);

    const literal = host('redir-literal');
    const seenLiteral = mockNet({ [`https://${literal}/`]: redirect('https://169.254.169.254/latest/meta-data/') });
    expect((await check(`https://${literal}/`)).status).toBe(403);
    expect(seenLiteral.map((s) => s.url.hostname)).toEqual([literal]);
  });

  it('refuses a redirect to http://', async () => {
    const name = host('downgrade');
    mockNet({ [`https://${name}/`]: redirect(`http://${name}/`) });
    expect((await errorOf(await check(`https://${name}/`))).details).toMatchObject({ reason: 'insecure_redirect' });
  });

  it('refuses http://, other schemes, ports, credentials, junk and URLs over 2048 characters with 400', async () => {
    const seen = mockNet({});
    for (const url of ['http://plain.ogfixtures.com/', 'ftp://files.ogfixtures.com/', 'https://port.ogfixtures.com:8443/', 'https://u:p@creds.ogfixtures.com/', 'not a url', '']) {
      const response = await check(url);
      expect(response.status, url).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect((await check(`https://long.ogfixtures.com/${'a'.repeat(2048)}`)).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('reads at most 2 MB of a 3 MB page: tags after the cut are not seen', async () => {
    const site = host('big-page');
    let pulled = 0;
    const encoder = new TextEncoder();
    const headPart = encoder.encode('<html><head><meta property="og:title" content="Early">');
    const tail = encoder.encode('<meta property="og:description" content="Late"></head></html>');
    const chunk = 64 * 1024;
    const total = 3 * MB;
    mockNet({
      [`https://${site}/`]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulled >= total) return controller.close();
              const part = new Uint8Array(chunk).fill(0x20);
              if (pulled === 0) part.set(headPart);
              if (pulled + chunk >= total) part.set(tail, chunk - tail.byteLength);
              pulled += chunk;
              controller.enqueue(part);
            },
          }),
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    const body = await result(await check(`https://${site}/`));
    expect(body.og.title).toBe('Early');
    expect(body.og.description).toBeNull();
    expect(pulled).toBeGreaterThanOrEqual(INSPECT.pageMaxBytes);
    expect(pulled).toBeLessThanOrEqual(INSPECT.pageMaxBytes + 3 * chunk);
  });
});

describe('image proxy: /api/tools/og-check/{id}/image and /favicon', () => {
  it('streams the recorded image with safe headers and never takes a URL', async () => {
    const site = host('proxy');
    const seen = mockNet(goodSite(site));
    const body = await result(await check(`https://${site}/widgets`));
    seen.length = 0;

    const image = await call(`${body.preview.image}?url=https://evil.ogfixtures.com/x.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('public, max-age=600');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageFile('png', 1200, 630));
    const favicon = await call(body.preview.favicon!);
    expect(favicon.status).toBe(200);
    expect(seen.map((s) => s.url.href)).toEqual([`https://${site}/card.png`, `https://${site}/static/icon-32.png`]);
    for (const request of seen) expect(request.headers.get('user-agent')).toBe(UA);
  });

  it('404s once the result has expired, and for unknown or malformed ids', async () => {
    const site = host('expire');
    mockNet(goodSite(site));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
    const body = await result(await check(`https://${site}/widgets`));
    vi.setSystemTime(new Date('2026-11-25T10:09:00Z'));
    expect((await call(body.preview.image!)).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-25T10:10:01Z'));
    const expired = await call(body.preview.image!);
    expect(expired.status).toBe(404);
    expect((await errorOf(expired)).code).toBe('not_found');
    expect((await call('/api/tools/og-check/chk_0000000000000000/image')).status).toBe(404);
    expect((await call('/api/tools/og-check/..%2F..%2Fx/image')).status).toBe(404);
  });

  it('refuses a recorded image that is now SVG or too large', async () => {
    const site = host('swap');
    let served: Handler = png();
    mockNet({ ...goodSite(site), [`https://${site}/card.png`]: (url, method) => served(url, method) });
    const body = await result(await check(`https://${site}/widgets`));
    served = () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } });
    expect((await errorOf(await call(body.preview.image!))).details).toMatchObject({ reason: 'not_image' });
    served = png(1200, 630, 6 * MB);
    expect((await errorOf(await call(body.preview.image!))).details).toMatchObject({ reason: 'too_large' });
  });
});

describe('limits of the public checker', () => {
  const limited: Env = { ...env, RATE_LIMITS_DISABLED: '0' };

  it('the 21st uncached check in an hour is 429 with Retry-After to the next hour; cached checks do not count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:15:00Z'));
    const site = host('limit');
    const routes: Record<string, Handler> = {};
    for (let i = 1; i <= 21; i++) routes[`https://${site}/p${i}`] = html('<title>t</title>');
    mockNet(routes);
    const ip = '198.51.100.21';
    for (let i = 1; i <= 20; i++) expect((await check(`https://${site}/p${i}`, {}, limited, ip)).status, `check ${i}`).toBe(200);
    // Cached: still answered at the limit, and not counted.
    expect((await result(await check(`https://${site}/p1`, {}, limited, ip))).cached).toBe(true);
    const response = await check(`https://${site}/p21`, {}, limited, ip);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(45 * 60));
    expect((await errorOf(response)).code).toBe('rate_limited');
    // Another client is not affected; the next hour starts afresh.
    expect((await check(`https://${site}/p21`, {}, limited, '198.51.100.22')).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-25T11:00:00Z'));
    expect((await check(`https://${site}/p20`, {}, limited, ip)).status).toBe(200);
  });

  it('IPv6 clients are counted per /64', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 20, ?2)', `ogc:2001:db8:1:2::/64:${Math.floor(Date.now() / 3_600_000)}`, Date.now() + 3_600_000);
    const site = host('v6');
    mockNet({ [`https://${site}/`]: html('<title>t</title>') });
    expect((await check(`https://${site}/`, {}, limited, '2001:db8:1:2:aaaa::1')).status).toBe(429);
  });

  it('without TURNSTILE_SECRET_KEY no token is ever needed', async () => {
    const site = host('noturnstile');
    const routes: Record<string, Handler> = {};
    for (let i = 1; i <= 7; i++) routes[`https://${site}/p${i}`] = html('<title>t</title>');
    const seen = mockNet(routes);
    for (let i = 1; i <= 7; i++) expect((await check(`https://${site}/p${i}`, {}, limited, '198.51.100.30')).status).toBe(200);
    expect(seen.some((s) => s.url.hostname === 'challenges.cloudflare.com')).toBe(false);
  });

  it('with TURNSTILE_SECRET_KEY, the 6th uncached check needs a valid token', async () => {
    const withTurnstile: Env = { ...limited, TURNSTILE_SECRET_KEY: 'turnstile-test-secret', TURNSTILE_SITE_KEY: '0x4AAAAAAAtestsitekey' };
    const site = host('turnstile');
    const routes: Record<string, Handler> = {
      'https://challenges.cloudflare.com/turnstile/v0/siteverify': () => Response.json({ success: verdict }),
    };
    for (let i = 1; i <= 8; i++) routes[`https://${site}/p${i}`] = html('<title>t</title>');
    let verdict = false;
    const seen = mockNet(routes);
    const ip = '198.51.100.40';
    for (let i = 1; i <= 5; i++) expect((await check(`https://${site}/p${i}`, {}, withTurnstile, ip)).status).toBe(200);
    expect(seen.some((s) => s.url.hostname === 'challenges.cloudflare.com')).toBe(false);

    const missing = await check(`https://${site}/p6`, {}, withTurnstile, ip);
    expect(missing.status).toBe(403);
    expect(await errorOf(missing)).toMatchObject({ code: 'verification_required', details: { site_key: '0x4AAAAAAAtestsitekey' } });

    const rejected = await check(`https://${site}/p6`, { turnstile: 'bad-token' }, withTurnstile, ip);
    expect((await errorOf(rejected)).code).toBe('verification_required');

    verdict = true;
    expect((await check(`https://${site}/p6`, { turnstile: 'good-token' }, withTurnstile, ip)).status).toBe(200);
    const verify = seen.filter((s) => s.url.hostname === 'challenges.cloudflare.com');
    expect(verify).toHaveLength(2);
    expect(verify[1]!.method).toBe('POST');
    const form = verify[1]!.body as FormData;
    expect(form.get('secret')).toBe('turnstile-test-secret');
    expect(form.get('response')).toBe('good-token');
    expect(form.get('remoteip')).toBe(ip);
    // Failed attempts were not counted: 6 checks used.
    const row = await first<{ count: number }>(env.DB, "SELECT count FROM tool_usage WHERE bucket LIKE ?1", `ogc:${ip}:%`);
    expect(row?.count).toBe(6);
  });
});

describe('GET /v1/inspect', () => {
  it('needs an API key', async () => {
    expect((await call('/v1/inspect?url=https://a.ogfixtures.com/')).status).toBe(401);
  });

  it('returns the same CheckResult and counts no images', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const site = host('api');
    mockNet(goodSite(site));
    const response = await call(`/v1/inspect?url=${encodeURIComponent(`https://${site}/widgets`)}`, { headers: bearer(key.secret) });
    const body = await result(response);
    expect(body.og.title).toBe('Acme Widgets');
    expect(body.preview.image).toBe(`/api/tools/og-check/${body.id}/image`);
    expect((await usageOf(user.id)).used).toBe(0);
  });

  for (const [plan, limit] of Object.entries(INSPECT.dailyInspectionsByPlan) as [keyof typeof INSPECT.dailyInspectionsByPlan, number][]) {
    it(`${plan}: ${limit} uncached inspections per key per UTC day; cached ones are free`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-25T18:00:00Z'));
      const limited: Env = { ...env, RATE_LIMITS_DISABLED: '0' };
      const user = await createUser(plan);
      const key = await apiKeyFor(user.id);
      const day = Math.floor(Date.now() / 86_400_000);
      await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', `inspect:${key.id}:${day}`, limit - 1, (day + 1) * 86_400_000);
      const site = host(`daily-${plan}`);
      mockNet({ [`https://${site}/a`]: html('<title>a</title>'), [`https://${site}/b`]: html('<title>b</title>') });
      const inspect = (path: string): Promise<Response> => call(`/v1/inspect?url=${encodeURIComponent(`https://${site}${path}`)}`, { headers: bearer(key.secret) }, limited);
      expect((await inspect('/a')).status).toBe(200);
      expect((await result(await inspect('/a'))).cached).toBe(true);
      const over = await inspect('/b');
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBe(String(6 * 3600));
      expect((await errorOf(over)).code).toBe('rate_limited');
    });
  }
});

describe('/api/config and cleanup', () => {
  it('publishes turnstile_site_key, null when unset', async () => {
    expect(((await (await call('/api/config')).json()) as { turnstile_site_key: unknown }).turnstile_site_key).toBeNull();
    const configured = await call('/api/config', {}, { ...env, TURNSTILE_SITE_KEY: '0x4AAAAAAAtestsitekey', TURNSTILE_SECRET_KEY: 'never-published' });
    const text = await configured.text();
    expect(JSON.parse(text).turnstile_site_key).toBe('0x4AAAAAAAtestsitekey');
    expect(text).not.toContain('never-published');
  });

  it('the daily cleanup deletes expired results and ended counter windows only', async () => {
    const now = Date.parse('2026-12-01T03:17:00Z');
    await run(env.DB, "INSERT INTO og_checks (id, url_key, result, created_at, expires_at) VALUES ('chk_cleanupold00000', 'u', '{}', 1, ?1)", now - 1);
    await run(env.DB, "INSERT INTO og_checks (id, url_key, result, created_at, expires_at) VALUES ('chk_cleanuplive0000', 'u', '{}', 1, ?1)", now + 60_000);
    await run(env.DB, "INSERT INTO tool_usage (bucket, count, expires_at) VALUES ('cleanup:old', 3, ?1), ('cleanup:live', 3, ?2)", now - 1, now + 60_000);
    const report = await runCleanup(env, now);
    expect(report.ogChecks).toBeGreaterThanOrEqual(1);
    expect(report.toolUsage).toBeGreaterThanOrEqual(1);
    expect(await first(env.DB, "SELECT id FROM og_checks WHERE id = 'chk_cleanupold00000'")).toBeNull();
    expect(await first(env.DB, "SELECT id FROM og_checks WHERE id = 'chk_cleanuplive0000'")).not.toBeNull();
    expect(await first(env.DB, "SELECT bucket FROM tool_usage WHERE bucket = 'cleanup:old'")).toBeNull();
    expect(await first(env.DB, "SELECT bucket FROM tool_usage WHERE bucket = 'cleanup:live'")).not.toBeNull();
  });
});
