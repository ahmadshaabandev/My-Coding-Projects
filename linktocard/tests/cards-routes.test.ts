/// <reference path="./fixtures/og/raw.d.ts" />
// "Link in, card out" through HTTP, mounted the way the integration steps describe
// (tests/cards-helpers.ts cardsApp): POST /v1/cards/from-url, the signed GET /v1/link/...,
// and the checker's GET /playground/from-check/... preview. Real D1, R2, inspector and
// card engine; every outbound request is a mocked fetch.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLinkUrl } from '../src/cards/link-url';
import { DAY_MS, INSPECT } from '../src/config';
import { all, first, run } from '../src/db/client';
import { runInspection, storeResult } from '../src/inspect/check';
import type { CheckResult } from '../src/inspect/types';
import type { Env, SiteRow, UserRow } from '../src/types';
import { apiKeyFor, bytesOf, createSite, createTemplate, createUser, dashboard, errorOf, isPng, pngDimensions, renderCount, requestUrl, sessionCookieFor, siteSecret, usageOf } from './app-helpers';
import { SETTINGS, bytes, callCards, enabled, host, html, mockNet, postFromUrl, probePng, solidPng, type Handler } from './cards-helpers';
import goodHtml from './fixtures/og/good.html?raw';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DAY = (now: number): number => Math.floor(now / DAY_MS);

/** The good fixture page at https://<site>/widgets, `title` as og:title, with a real icon and a probe-only og:image. */
async function goodSite(site: string, title = 'Acme Widgets', icon: Handler | null = null): Promise<Record<string, Handler>> {
  const page = goodHtml
    .replaceAll('https://cdn.ogfixtures.com', `https://${site}`)
    .replaceAll('https://shop.ogfixtures.com', `https://${site}`)
    .replace('content="Acme Widgets"', `content="${title}"`);
  return {
    [`https://${site}/widgets`]: html(page),
    [`https://${site}/card.png`]: probePng(),
    [`https://${site}/static/icon-32.png`]: icon ?? bytes(await solidPng(8, 8)),
  };
}

/** The error body, for a failing status assertion; image bodies are not read as text. */
async function why(response: Response): Promise<string> {
  return (response.headers.get('content-type') ?? '').startsWith('application/json') ? response.clone().text() : '';
}

const pageFetches = (seen: { url: URL; method: string }[], site: string): number => seen.filter((s) => s.url.hostname === site && s.url.pathname === '/widgets').length;

interface CardJson {
  id: string;
  url: string;
  width: number;
  height: number;
  format: string;
  cached: boolean;
  template: string;
  usage: { used: number };
  link: { url: string; final_url: string; check_id: string; check_cached: boolean; data: Record<string, string> };
}

describe('kill switch: LINK_CARDS_ENABLED', () => {
  it('every link-card route answers 503 not_configured while it is not "true", before anything else', async () => {
    const seen = mockNet({});
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      const bindings: Env = { ...env, LINK_CARDS_ENABLED: flag };
      const responses = [
        await callCards('/v1/cards/from-url', { method: 'POST', body: '{}' }, bindings),
        await callCards('/v1/link/s_x/blog.png?url=https%3A%2F%2Fexample.com%2F&sig=00', {}, bindings),
        await callCards('/playground/from-check/chk_0000000000000000/blog.png', {}, bindings),
      ];
      for (const response of responses) {
        expect(response.status, String(flag)).toBe(503);
        expect((await errorOf(response)).code).toBe('not_configured');
      }
    }
    expect(seen).toEqual([]);
  });
});

describe('POST /v1/cards/from-url', () => {
  it('makes the card from the page and answers like POST /v1/images, plus the link it read', async () => {
    const site = host('from-url');
    const seen = mockNet(await goodSite(site));
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);

    const response = await postFromUrl(key.secret, { url: `https://${site.toUpperCase()}/widgets#top` });
    expect(response.status, await why(response)).toBe(200);
    const body = (await response.json()) as CardJson;
    expect(body).toMatchObject({ width: 1200, height: 630, format: 'png', cached: false, template: 'blog', usage: { used: 1 } });
    expect(body.url).toBe(`${env.APP_URL}/i/${user.id}/${body.id}.png`);
    expect(body.link).toEqual({
      url: `https://${site}/widgets`,
      final_url: `https://${site}/widgets`,
      check_id: expect.stringMatching(/^chk_/),
      check_cached: false,
      data: {
        title: 'Acme Widgets',
        description: 'Hand-made widgets, shipped worldwide.',
        site,
        author: 'Acme',
        image: `https://${site}/static/icon-32.png`,
        theme: 'dark',
      },
    });
    expect(seen.some((s) => s.url.pathname === '/static/icon-32.png')).toBe(true);
    expect(await renderCount(user.id)).toBe(1);
    const ledger = await first<{ source: string; site_id: string | null }>(env.DB, 'SELECT source, site_id FROM renders WHERE user_id = ?1', user.id);
    expect(ledger).toEqual({ source: 'api', site_id: null });

    // Again: the check comes from the checker's cache and the card from R2; nothing is fetched or charged.
    const fetches = seen.length;
    const again = (await (await postFromUrl(key.secret, { url: `https://${site}/widgets` })).json()) as CardJson;
    expect(again).toMatchObject({ id: body.id, cached: true, usage: { used: 1 }, link: { check_cached: true } });
    expect(seen.length).toBe(fetches);
  });

  it('a template, size, format and overrides; fields the template lacks are ignored', async () => {
    const site = host('options');
    mockNet(await goodSite(site));
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const response = await postFromUrl(key.secret, {
      url: `https://${site}/widgets`,
      template: 'launch',
      size: 'square',
      format: 'webp',
      data: { title: 'Mine', tag: 'New', image: '', unknown_field: 'x' },
    });
    expect(response.status, await why(response)).toBe(200);
    const body = (await response.json()) as CardJson;
    expect(body).toMatchObject({ width: 1080, height: 1080, format: 'webp', template: 'launch' });
    expect(body.link.data).toEqual({ title: 'Mine', description: 'Hand-made widgets, shipped worldwide.', site, author: 'Acme', image: '', tag: 'New', theme: 'dark' });
  });

  it('a broken page icon does not cost the card: it is made without the icon, and charged once', async () => {
    const site = host('broken-icon');
    const seen = mockNet(await goodSite(site, 'Acme Widgets', () => new Response('gone', { status: 404 })));
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const body = (await (await postFromUrl(key.secret, { url: `https://${site}/widgets` })).json()) as CardJson;
    expect(body.link.data.image).toBeUndefined();
    expect(body.usage.used).toBe(1);
    expect(seen.filter((s) => s.url.pathname === '/static/icon-32.png').length).toBe(1);
  });

  it('an icon the caller sets is not dropped: its failure is the answer', async () => {
    const site = host('own-icon');
    mockNet(await goodSite(site));
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const response = await postFromUrl(key.secret, { url: `https://${site}/widgets`, data: { image: `https://${site}/missing.png` } });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('image_fetch_failed');
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('binary answers the image itself', async () => {
    const site = host('binary');
    mockNet(await goodSite(site));
    const user = await createUser('pro');
    const key = await apiKeyFor(user.id);
    const response = await postFromUrl(key.secret, { url: `https://${site}/widgets`, response: 'binary' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-ltc-image-url')).toMatch(new RegExp(`/i/${user.id}/[0-9a-f]{64}\\.png$`));
    const png = await bytesOf(response);
    expect(isPng(png)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
  });

  it('checks the whole body before the page is read', async () => {
    const seen = mockNet({});
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const cases: [unknown, number, string][] = [
      [{}, 400, 'invalid_request'],
      [{ url: 42 }, 400, 'invalid_request'],
      [{ url: 'http://example.com/' }, 400, 'invalid_request'],
      [{ url: 'https://127.0.0.1/' }, 403, 'forbidden'],
      [{ url: 'https://example.com/', html: '<div></div>' }, 400, 'invalid_request'],
      [{ url: 'https://example.com/', tempalte: 'blog' }, 400, 'invalid_request'],
      [{ url: 'https://example.com/', template: 'nope' }, 404, 'not_found'],
      [{ url: 'https://example.com/', size: 'huge' }, 400, 'unsupported_size'],
      [{ url: 'https://example.com/', format: 'gif' }, 400, 'unsupported_format'],
      [{ url: 'https://example.com/', data: { title: 1 } }, 400, 'invalid_request'],
      [{ url: 'https://example.com/', response: 'xml' }, 400, 'invalid_request'],
    ];
    for (const [body, status, code] of cases) {
      const response = await postFromUrl(key.secret, body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect((await errorOf(response)).code, JSON.stringify(body)).toBe(code);
    }
    expect(seen).toEqual([]);
    expect((await callCards('/v1/cards/from-url', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('a page that cannot be read is a 422 and costs nothing', async () => {
    const site = host('down');
    mockNet({ [`https://${site}/widgets`]: () => new Response('oops', { status: 500 }) });
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const response = await postFromUrl(key.secret, { url: `https://${site}/widgets` });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('page_fetch_failed');
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it("uncached checks count against the key's daily inspections, like GET /v1/inspect", async () => {
    const site = host('limit');
    const seen = mockNet(await goodSite(site));
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const now = Date.now();
    const limit = INSPECT.dailyInspectionsByPlan.free;
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', `inspect:${key.id}:${DAY(now)}`, limit, (DAY(now) + 1) * DAY_MS);
    const response = await postFromUrl(key.secret, { url: `https://${site}/widgets` }, { ...enabled, RATE_LIMITS_DISABLED: '0' });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).message).toContain(`${limit} inspections`);
    expect(pageFetches(seen, site)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* GET /v1/link                                                        */
/* ------------------------------------------------------------------ */

async function linkPath(site: SiteRow, page: string, options: { template?: string; data?: Record<string, string>; size?: string; ext?: 'png' | 'jpg' | 'webp' } = {}): Promise<string> {
  const { url } = await buildLinkUrl({
    baseUrl: 'http://localhost',
    siteId: site.id,
    template: options.template ?? 'blog',
    ext: options.ext ?? 'png',
    url: page,
    ...(options.data ? { data: options.data } : {}),
    ...(options.size ? { size: options.size } : {}),
    secret: await siteSecret(site),
  });
  return url.slice('http://localhost'.length);
}

/** The same signed link under another URL (the edge cache is keyed by the exact URL): the query reversed. */
function reordered(path: string, extra = 0): string {
  const [pathname, query = ''] = path.split('?');
  const parts = query.split('&').reverse();
  // Repeat the rotation to get several distinct spellings of one link.
  for (let i = 0; i < extra; i++) parts.push(parts.shift()!);
  return `${pathname}?${parts.join('&')}`;
}

async function pointerOf(user: UserRow): Promise<{ key: string; cacheKey: string; checkedAt: number }[]> {
  const listing = await env.BUCKET.list({ prefix: `r/${user.id}/link/`, include: ['customMetadata'] });
  return listing.objects.map((object) => ({
    key: object.key,
    cacheKey: object.customMetadata?.cacheKey ?? '',
    checkedAt: Number(object.customMetadata?.checkedAt),
  }));
}

describe('GET /v1/link/{siteId}/{template}.{ext}', () => {
  it('renders the card from the page, charges one unit to the site, and then answers from the pointer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 1, 3, 9);
    vi.setSystemTime(start);
    const domain = host('link');
    const seen = mockNet(await goodSite(domain));
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, `https://${domain}/widgets`);

    const first_ = await callCards(path);
    expect(first_.status, await why(first_)).toBe(200);
    expect(first_.headers.get('content-type')).toBe('image/png');
    expect(first_.headers.get('x-ltc-cache')).toBe('miss');
    expect(first_.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(isPng(await bytesOf(first_))).toBe(true);
    expect((await usageOf(user.id, start)).used).toBe(1);
    expect(await first<{ source: string; site_id: string }>(env.DB, 'SELECT source, site_id FROM renders WHERE user_id = ?1', user.id)).toEqual({ source: 'og', site_id: site.id });
    const etag = first_.headers.get('etag')!;
    const [pointer] = await pointerOf(user);
    expect(pointer).toMatchObject({ cacheKey: etag.replaceAll('"', ''), checkedAt: start });
    expect(pageFetches(seen, domain)).toBe(1);

    // Hours later, past the checker's 10-minute cache: the pointer answers, the page is not read again.
    vi.setSystemTime(start + 6 * 60 * 60 * 1000);
    const fetches = seen.length;
    const second = await callCards(reordered(path));
    expect(second.status).toBe(200);
    expect(second.headers.get('x-ltc-cache')).toBe('hit');
    expect(second.headers.get('etag')).toBe(etag);
    // Until the refresh is due (18 h left), not the full day.
    expect(second.headers.get('cache-control')).toBe(`public, max-age=${18 * 60 * 60}`);
    expect(seen.length).toBe(fetches);
    expect((await usageOf(user.id, start)).used).toBe(1);

    const conditional = await callCards(reordered(path, 1), { headers: { 'if-none-match': etag } });
    expect(conditional.status).toBe(304);
    const head = await callCards(reordered(path, 1), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0);
    expect(seen.length).toBe(fetches);
  });

  it('reads the page again once the refresh is due: a changed page is a new card and a new unit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 1, 4, 9);
    vi.setSystemTime(start);
    const domain = host('refresh');
    const routes = await goodSite(domain);
    const seen = mockNet(routes);
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, `https://${domain}/widgets`);
    const before = await callCards(path);
    expect(before.status).toBe(200);

    Object.assign(routes, await goodSite(domain, 'Acme Widgets, new and improved'));
    vi.setSystemTime(start + SETTINGS.refreshAfterMs + 1);
    const after = await callCards(reordered(path));
    expect(after.status).toBe(200);
    expect(after.headers.get('x-ltc-cache')).toBe('miss');
    expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
    expect(pageFetches(seen, domain)).toBe(2);
    expect((await usageOf(user.id, start + SETTINGS.refreshAfterMs + 1)).used).toBe(2);
    const [pointer] = await pointerOf(user);
    expect(pointer).toMatchObject({ cacheKey: after.headers.get('etag')!.replaceAll('"', ''), checkedAt: start + SETTINGS.refreshAfterMs + 1 });
  });

  it('keeps serving the last card when the page is down, and asks the page again only after the checker cache period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 1, 5, 9);
    vi.setSystemTime(start);
    const domain = host('stale');
    const routes = await goodSite(domain);
    const seen = mockNet(routes);
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, `https://${domain}/widgets`);
    const original = await callCards(path);
    const etag = original.headers.get('etag');

    routes[`https://${domain}/widgets`] = () => new Response('down', { status: 503 });
    const due = start + SETTINGS.refreshAfterMs + 1;
    vi.setSystemTime(due);
    const stale = await callCards(reordered(path));
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-ltc-cache')).toBe('stale');
    expect(stale.headers.get('etag')).toBe(etag);
    expect(stale.headers.get('cache-control')).toBe(`public, max-age=${INSPECT.cacheTtlMs / 1000}`);
    expect(pageFetches(seen, domain)).toBe(2);

    // Within the back-off the pointer answers without trying the page.
    vi.setSystemTime(due + INSPECT.cacheTtlMs - 1000);
    expect((await callCards(reordered(path, 1))).headers.get('x-ltc-cache')).toBe('hit');
    expect(pageFetches(seen, domain)).toBe(2);
    // After it, the page is tried again.
    vi.setSystemTime(due + INSPECT.cacheTtlMs + 1000);
    expect((await callCards(reordered(path, 2))).headers.get('x-ltc-cache')).toBe('stale');
    expect(pageFetches(seen, domain)).toBe(3);
    expect((await usageOf(user.id, due)).used).toBe(1);
  });

  it('without a card yet, a page that cannot be read is the error', async () => {
    const domain = host('never');
    mockNet({ [`https://${domain}/widgets`]: () => new Response('down', { status: 500 }) });
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const response = await callCards(await linkPath(site, `https://${domain}/widgets`));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('page_fetch_failed');
  });

  it("uncached checks count against the site's daily page checks, with a message about the site", async () => {
    const domain = host('site-limit');
    const seen = mockNet(await goodSite(domain));
    const user = await createUser('free');
    const site = await createSite(user.id);
    const now = Date.now();
    const limit = INSPECT.dailyInspectionsByPlan.free;
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', `inspect:site:${site.id}:${DAY(now)}`, limit, (DAY(now) + 1) * DAY_MS);
    const response = await callCards(await linkPath(site, `https://${domain}/widgets`), {}, { ...enabled, RATE_LIMITS_DISABLED: '0' });
    expect(response.status).toBe(429);
    const error = await errorOf(response);
    expect(error.message).toContain(`read ${limit} pages today`);
    expect(error.details).toMatchObject({ limit });
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(pageFetches(seen, domain)).toBe(0);
  });

  it('refuses tampered, extended and unsigned URLs before reading anything', async () => {
    const seen = mockNet({});
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, 'https://example.com/widgets', { data: { tag: 'News' } });
    const tampered = path.replace('example.com', 'evil.example');
    const extended = `${path}&title=Injected`;
    const unsigned = path.replace(/&sig=[0-9a-f]+/, '');
    for (const [candidate, reason] of [
      [tampered, 'signature_mismatch'],
      [extended, 'signature_mismatch'],
      [unsigned, 'missing_sig'],
    ] as const) {
      const response = await callCards(candidate);
      expect(response.status, candidate).toBe(403);
      expect(await errorOf(response)).toMatchObject({ code: 'invalid_signature', details: { reason } });
    }
    expect(seen).toEqual([]);
    expect(await all(env.DB, 'SELECT 1 FROM renders WHERE user_id = ?1', user.id)).toEqual([]);
  });

  it('unknown sites and paths are 404, suspended owners 403, and HEAD of a new link reads nothing', async () => {
    const seen = mockNet({});
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, 'https://example.com/widgets');
    expect((await callCards(path.replace(site.id, 's_missing'))).status).toBe(404);
    expect((await callCards(`/v1/link/${site.id}/blog.gif?url=x&sig=${'0'.repeat(64)}`)).status).toBe(404);
    // The template is part of the signed path: changing it is tampering; signing a missing one is a 404.
    expect((await callCards(path.replace('/blog.png', '/dark.png'))).status).toBe(403);
    expect((await callCards(await linkPath(site, 'https://example.com/widgets', { template: 'nope' }))).status).toBe(404);

    const head = await callCards(path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(head.headers.get('etag')).toBeNull();
    expect(seen).toEqual([]);

    await run(env.DB, 'UPDATE users SET suspended_at = ?1 WHERE id = ?2', Date.now(), user.id);
    const suspended = await callCards(path);
    expect(suspended.status).toBe(403);
    expect((await errorOf(suspended)).code).toBe('account_suspended');
  });

  it('signed size, extension and overrides shape the card', async () => {
    const domain = host('shape');
    mockNet(await goodSite(domain));
    const user = await createUser('pro');
    const site = await createSite(user.id);
    const response = await callCards(await linkPath(site, `https://${domain}/widgets`, { size: 'square', ext: 'webp', data: { title: 'Fixed title' } }));
    expect(response.status, await why(response)).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    const row = await first<{ width: number; height: number; format: string }>(env.DB, 'SELECT width, height, format FROM renders WHERE user_id = ?1', user.id);
    expect(row).toEqual({ width: 1080, height: 1080, format: 'webp' });
  });

  it('the kill switch wins over the edge cache: a card served before is a 503 once switched off', async () => {
    const domain = host('switch');
    mockNet(await goodSite(domain));
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const path = await linkPath(site, `https://${domain}/widgets`);
    expect((await callCards(path)).status).toBe(200);
    expect((await callCards(path)).headers.get('x-ltc-cache')).toBe('hit');
    // Explicitly off: wrangler.toml turns LINK_CARDS_ENABLED on for dev and the test pool.
    const off = await callCards(path, {}, { ...env, LINK_CARDS_ENABLED: 'false' });
    expect(off.status).toBe(503);
    expect((await errorOf(off)).code).toBe('not_configured');
  });

  it("editing a custom template makes a new card for the link (the template's version is part of the pointer)", async () => {
    const domain = host('custom');
    const seen = mockNet(await goodSite(domain));
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const cookie = await sessionCookieFor(user.id);
    const templateId = await createTemplate(
      cookie,
      '<div class="card"><div class="t">{{title}}</div><div class="d">{{domain}}</div><div class="c" style="background: {{theme_color}}"></div></div>',
      '.card { display: flex; flex-direction: column; width: 100%; height: 100%; padding: 40px; } .c { width: 40px; height: 40px; }',
    );
    const path = await linkPath(site, `https://${domain}/widgets`, { template: templateId });
    const before = await callCards(path);
    expect(before.status, await why(before)).toBe(200);
    expect((await usageOf(user.id)).used).toBe(1);

    const saved = await dashboard(cookie, 'PUT', `/api/templates/${templateId}`, { name: 'Edited', html: '<div class="card">{{title}} on {{site_name}}</div>', css: '.card { display: flex; width: 100%; height: 100%; }' });
    expect(saved.status, await why(saved)).toBe(200);
    const after = await callCards(reordered(path));
    expect(after.status, await why(after)).toBe(200);
    expect(after.headers.get('x-ltc-cache')).toBe('miss');
    expect((await usageOf(user.id)).used).toBe(2);
    expect((await pointerOf(user)).length).toBe(2);
    expect(pageFetches(seen, domain)).toBe(1);
  });

  it('a plan change makes a new pointer, so the watermarked Free card is not served after an upgrade', async () => {
    const domain = host('plan');
    const seen = mockNet(await goodSite(domain));
    const user = await createUser('free');
    const site = await createSite(user.id);
    const path = await linkPath(site, `https://${domain}/widgets`);
    const free = await callCards(path);
    expect(free.status).toBe(200);
    await run(env.DB, "UPDATE users SET plan = 'pro' WHERE id = ?1", user.id);
    const pro = await callCards(reordered(path));
    expect(pro.status).toBe(200);
    expect(pro.headers.get('etag')).not.toBe(free.headers.get('etag'));
    expect((await pointerOf(user)).length).toBe(2);
    // The second request found the page in the checker's cache: one page read for both.
    expect(pageFetches(seen, domain)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* GET /playground/from-check                                          */
/* ------------------------------------------------------------------ */

async function storedCheck(domain: string): Promise<CheckResult> {
  const routes = await goodSite(domain);
  const fetchImpl: typeof fetch = async (input) => {
    const url = requestUrl(input);
    return routes[`${url.origin}${url.pathname}`]?.(url, 'GET') ?? new Response('not found', { status: 404 });
  };
  const outcome = await runInspection(new URL(`https://${domain}/widgets`), { fetchImpl, resolveHost: async () => ['93.184.216.34'], now: () => Date.now() });
  await storeResult(env.DB, outcome, Date.now());
  return outcome.result;
}

describe('GET /playground/from-check/{checkId}/{template}.png', () => {
  it('previews a watermarked card from a stored check without any fetch or charge', async () => {
    const check = await storedCheck(host('preview'));
    const seen = mockNet({});
    const renders = async (): Promise<number> => (await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM renders'))?.n ?? 0;
    const rendersBefore = await renders();
    const response = await callCards(`/playground/from-check/${check.id}/blog.png`);
    expect(response.status, await why(response)).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-ltc-cache')).toBe('miss');
    const png = await bytesOf(response);
    expect(isPng(png)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
    // Not the page, not its icon, not its og:image.
    expect(seen).toEqual([]);
    expect(await renders()).toBe(rendersBefore);

    const etag = response.headers.get('etag')!;
    expect((await env.BUCKET.head(`p/${etag.replaceAll('"', '')}.png`))?.customMetadata?.createdAt).toBeDefined();
    const again = await callCards(`/playground/from-check/${check.id}/blog.png`);
    expect(again.headers.get('x-ltc-cache')).toBe('hit');
    expect((await callCards(`/playground/from-check/${check.id}/blog.png`, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await callCards(`/playground/from-check/${check.id}/blog.png?theme=light`)).headers.get('etag')).not.toBe(etag);
  });

  it('every starter template, and HEAD never renders', async () => {
    const check = await storedCheck(host('preview-all'));
    mockNet({});
    for (const template of ['blog', 'dark', 'quote', 'launch', 'docs']) {
      const head = await callCards(`/playground/from-check/${check.id}/${template}.png?theme=dark`, { method: 'HEAD' });
      expect(head.status, template).toBe(200);
      expect(head.headers.get('cache-control'), template).toBe('no-store');
      const response = await callCards(`/playground/from-check/${check.id}/${template}.png?theme=dark`);
      expect(response.status, template).toBe(200);
      expect(isPng(await bytesOf(response)), template).toBe(true);
    }
  });

  it('expired or unknown checks, other templates and themes are refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 1, 6, 9);
    vi.setSystemTime(start);
    const check = await storedCheck(host('preview-expiry'));
    mockNet({});
    const cases: [string, number][] = [
      [`/playground/from-check/${check.id}/nope.png`, 404],
      [`/playground/from-check/${check.id}/blog.webp`, 404],
      [`/playground/from-check/${check.id}/Blog.png`, 404],
      [`/playground/from-check/${check.id}/blog.png?theme=blue`, 400],
      ['/playground/from-check/chk_zzzzzzzzzzzzzzzz/blog.png', 404],
      ["/playground/from-check/x' OR 1=1 --/blog.png", 404],
    ];
    for (const [path, status] of cases) expect((await callCards(path)).status, path).toBe(status);
    vi.setSystemTime(start + INSPECT.cacheTtlMs + 1);
    const expired = await callCards(`/playground/from-check/${check.id}/blog.png`);
    expect(expired.status).toBe(404);
    expect((await errorOf(expired)).message).toContain(`kept ${INSPECT.cacheTtlMs / 60_000} minutes`);
  });
});
