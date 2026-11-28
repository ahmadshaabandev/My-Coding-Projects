// Signed chart URLs: GET and HEAD /v1/chart/{siteId}.{ext}?c=<chart JSON>&sig=. Signed by the
// recipe of card URLs; nothing but c and sig is accepted; a URL that is not signed correctly is
// refused before its chart is parsed or drawn. Real app, real D1 and R2, the real renderer.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { CHARTS, DAY_MS } from '../src/config';
import * as chartRender from '../src/charts/render';
import { buildChartUrl, describeChartUrlFailure, parseChartPath, verifyChartUrl, type ChartUrlFailure } from '../src/charts/url';
import { run } from '../src/db/client';
import { hmacSha256Hex } from '../src/lib/crypto';
import { buildSignedUrl } from '../src/lib/signed-url';
import { call, createSite, createUser, errorOf, isJpeg, isPng, isWebp, pngDimensions, siteSecret, usageOf } from './app-helpers';
import { CHART, chartNamed, chartPath, show } from './charts-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = 'ltcs_test-secret';
const JSON_TEXT = JSON.stringify(CHART);
const sign = (chartJson: string = JSON_TEXT, ext: 'png' | 'jpg' | 'jpeg' | 'webp' = 'png', siteId = 's_abc') =>
  buildChartUrl({ baseUrl: 'https://linktocard.test', siteId, ext, chartJson, secret: SECRET });
const reasonOf = async (url: URL, secret = SECRET): Promise<ChartUrlFailure | 'ok'> => {
  const result = await verifyChartUrl(url, secret);
  return result.ok ? 'ok' : result.reason;
};

describe('the signature', () => {
  it('is the card recipe: HMAC-SHA256 over the path, the parameter names and name=value lines', async () => {
    const url = new URL(await sign());
    expect(url.pathname).toBe('/v1/chart/s_abc.png');
    expect([...url.searchParams.keys()]).toEqual(['c', 'sig']);
    expect(url.searchParams.get('c')).toBe(JSON_TEXT);
    expect(url.searchParams.get('sig')).toBe(await hmacSha256Hex(SECRET, `/v1/chart/s_abc.png\nc\nc=${JSON_TEXT}`));
    expect(await verifyChartUrl(url, SECRET)).toEqual({ ok: true, chartJson: JSON_TEXT });
  });

  it('is what a customer\'s card signing code produces for the same path and parameter', async () => {
    // buildSignedUrl signs card URLs; its message for one parameter "c" has the same shape.
    const card = new URL(await buildSignedUrl({ baseUrl: 'https://linktocard.test', siteId: 's_abc', template: 'blog', ext: 'png', params: { c: 'x' }, secret: SECRET }));
    expect(card.searchParams.get('sig')).toBe(await hmacSha256Hex(SECRET, '/v1/og/s_abc/blog.png\nc\nc=x'));
    const chart = new URL(await sign('x'));
    expect(chart.searchParams.get('sig')).toBe(await hmacSha256Hex(SECRET, '/v1/chart/s_abc.png\nc\nc=x'));
  });

  it('accepts the two parameters in either order and an upper-case signature', async () => {
    const url = new URL(await sign());
    const swapped = new URL(`${url.origin}${url.pathname}?sig=${url.searchParams.get('sig')!.toUpperCase()}&c=${encodeURIComponent(JSON_TEXT)}`);
    expect(await reasonOf(swapped)).toBe('ok');
  });

  it('refuses everything else, each with its reason', async () => {
    const url = new URL(await sign());
    const sig = url.searchParams.get('sig')!;
    const withQuery = (query: string): URL => new URL(`${url.origin}${url.pathname}?${query}`);
    const c = encodeURIComponent(JSON_TEXT);
    expect(await reasonOf(withQuery(`c=${c}`))).toBe('missing_sig');
    expect(await reasonOf(withQuery(`c=${c}&sig=abc`))).toBe('malformed_sig');
    expect(await reasonOf(withQuery(`c=${c}&sig=${sig}&sig=${sig}`))).toBe('duplicate_param');
    expect(await reasonOf(withQuery(`c=${c}&c=${c}&sig=${sig}`))).toBe('duplicate_param');
    expect(await reasonOf(withQuery(`sig=${sig}`))).toBe('missing_chart');
    expect(await reasonOf(withQuery(`c=${c}&sig=${sig}&size=og`))).toBe('unknown_param');
    expect(await reasonOf(withQuery(`c=${c}&sig=${sig}&open=title`))).toBe('unknown_param');
    expect(await reasonOf(withQuery(`c=${c}&sig=${sig}&format=webp`))).toBe('unknown_param');
    expect(await reasonOf(withQuery(`c=${encodeURIComponent(JSON_TEXT.replace('Monthly', 'Yearly'))}&sig=${sig}`))).toBe('signature_mismatch');
    expect(await reasonOf(new URL(url.href.replace('.png', '.webp')))).toBe('signature_mismatch');
    expect(await reasonOf(new URL(url.href.replace('s_abc', 's_abd')))).toBe('signature_mismatch');
    expect(await reasonOf(url, 'ltcs_another-secret')).toBe('signature_mismatch');
    for (const reason of ['missing_sig', 'malformed_sig', 'duplicate_param', 'missing_chart', 'unknown_param', 'signature_mismatch', 'bad_value', 'url_too_long'] as const) {
      expect(describeChartUrlFailure(reason).length).toBeGreaterThan(20);
    }
    expect(describeChartUrlFailure('url_too_long')).toContain(String(CHARTS.maxSignedUrlChars));
  });

  it('wants the chart JSON on one line, when signing and when verifying', async () => {
    const pretty = JSON.stringify(CHART, null, 2);
    await expect(sign(pretty)).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'bad_value' } });
    const sig = await hmacSha256Hex(SECRET, `/v1/chart/s_abc.png\nc\nc=${pretty}`);
    expect(await reasonOf(new URL(`https://linktocard.test/v1/chart/s_abc.png?c=${encodeURIComponent(pretty)}&sig=${sig}`))).toBe('bad_value');
    // A line break inside a string is escaped by JSON.stringify, so it is fine.
    expect(await reasonOf(new URL(await sign(JSON.stringify({ ...CHART, title: 'Two\nlines' }))))).toBe('ok');
  });

  it('keeps to CHARTS.maxSignedUrlChars', async () => {
    const long = JSON.stringify({ ...CHART, title: 'x'.repeat(CHARTS.maxSignedUrlChars) });
    await expect(sign(long)).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'url_too_long' } });
    const sig = await hmacSha256Hex(SECRET, `/v1/chart/s_abc.png\nc\nc=${long}`);
    expect(await reasonOf(new URL(`https://linktocard.test/v1/chart/s_abc.png?c=${encodeURIComponent(long)}&sig=${sig}`))).toBe('url_too_long');
    // A URL above the card limit of 4,096 characters is fine for a chart.
    const medium = JSON.stringify({ ...CHART, labels: Array.from({ length: 150 }, (_, i) => `Label number ${i}`), series: [{ data: Array.from({ length: 150 }, (_, i) => i * 1000) }] });
    const url = await sign(medium);
    expect(new URL(url).pathname.length + new URL(url).search.length).toBeGreaterThan(4096);
    expect(await reasonOf(new URL(url))).toBe('ok');
  });

  it('knows a chart path', () => {
    expect(parseChartPath('/v1/chart/s_abc.png')).toEqual({ siteId: 's_abc', ext: 'png' });
    expect(parseChartPath('/v1/chart/s_abc.jpeg')).toEqual({ siteId: 's_abc', ext: 'jpeg' });
    for (const path of ['/v1/chart/s_abc', '/v1/chart/s_abc.gif', '/v1/chart/s_abc/blog.png', '/v1/chart/.png', '/v1/charts/s_abc.png', '/v1/chart/s abc.png']) {
      expect(parseChartPath(path), path).toBeNull();
    }
  });
});

async function account(plan: 'free' | 'starter' | 'pro' = 'free') {
  const user = await createUser(plan);
  const site = await createSite(user.id);
  return { user, site };
}

describe('GET /v1/chart/{siteId}.{ext}', () => {
  it('draws a signed chart: PNG of the right size, with the headers of a card image', async () => {
    const { user, site } = await account('starter');
    const before = Date.now();
    const shown = await show(await chartPath(site, { ...CHART, scale: 2 }));
    expect(shown.status).toBe(200);
    expect(isPng(shown.bytes)).toBe(true);
    expect(pngDimensions(shown.bytes)).toEqual({ width: 600, height: 400 });
    expect(shown.headers.get('content-type')).toBe('image/png');
    expect(shown.cache).toBe('miss');
    expect(shown.credits).toBe('1');
    expect(shown.key).toMatch(/^[0-9a-f]{64}$/);
    expect(shown.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    // Cacheable by a mail proxy for CHARTS.maxAgeSeconds at most, never past the stored copy (Starter: 30 days).
    const maxAge = Number(/^public, max-age=(\d+)$/.exec(shown.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeLessThanOrEqual(CHARTS.maxAgeSeconds);
    expect(maxAge).toBeGreaterThan(Math.min(CHARTS.maxAgeSeconds, (PLANS.starter.cacheDays * DAY_MS) / 1000) - 60 - (Date.now() - before) / 1000);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('never lets the cache lifetime pass the stored copy\'s expiry', async () => {
    const { site } = await account('free');
    const shown = await show(await chartPath(site, chartNamed('Free plan')));
    const maxAge = Number(/max-age=(\d+)/.exec(shown.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeLessThanOrEqual((PLANS.free.cacheDays * DAY_MS) / 1000);
    expect(maxAge).toBeGreaterThan((PLANS.free.cacheDays * DAY_MS) / 1000 - 60);
  });

  it.each([
    ['jpg', 'image/jpeg', isJpeg],
    ['jpeg', 'image/jpeg', isJpeg],
    ['webp', 'image/webp', isWebp],
  ] as const)('.%s answers %s', async (ext, type, check) => {
    const { site } = await account('starter');
    const shown = await show(await chartPath(site, CHART, ext));
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe(type);
    expect(check(shown.bytes)).toBe(true);
  });

  it('refuses a tampered URL with 403 before anything is parsed, drawn or charged', async () => {
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    const path = await chartPath(site, chartNamed('Signed'));
    const cases: Array<[string, string]> = [
      [path.replace('Signed', 'Forged'), 'signature_mismatch'],
      [path.replace('.png', '.webp'), 'signature_mismatch'],
      [path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'), 'signature_mismatch'],
      [path.replace(/&sig=.*/, ''), 'missing_sig'],
      [`${path}&size=og`, 'unknown_param'],
      // Not even JSON: a forged URL is told about its signature, not about its chart.
      [path.replace(/c=[^&]*/, 'c=%7Bnot-json'), 'signature_mismatch'],
      [await chartPath(site, chartNamed('Signed'), 'png', 'ltcs_wrong-secret'), 'signature_mismatch'],
    ];
    for (const [forged, reason] of cases) {
      const response = await show(forged);
      expect(response.status, forged).toBe(403);
      const error = (JSON.parse(new TextDecoder().decode(response.bytes)) as { error: { code: string; details: { reason: string } } }).error;
      expect(error.code).toBe('invalid_signature');
      expect(error.details.reason, forged).toBe(reason);
    }
    expect(renders).not.toHaveBeenCalled();
    expect((await usageOf(user.id)).used).toBe(0);
    // Another site's secret does not sign for this site either.
    const other = await account();
    expect((await show(await chartPath(site, CHART, 'png', await siteSecret(other.site)))).status).toBe(403);
  });

  it('answers 400 for a signed chart that is not valid, naming the field, without a charge', async () => {
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    for (const [chart, field] of [
      [{ ...CHART, type: 'radar' }, 'type'],
      [{ ...CHART, colour: 'red' }, 'colour'],
      [{ ...CHART, series: [{ data: [1, 2] }] }, 'series[0].data'],
      ['{"type":', 'chart'],
      ['[1,2]', 'chart'],
    ] as const) {
      const response = await show(await chartPath(site, chart));
      expect(response.status).toBe(400);
      const error = (JSON.parse(new TextDecoder().decode(response.bytes)) as { error: { code: string; message: string; details: { field: string } } }).error;
      expect(error.code).toBe('invalid_request');
      expect(error.details.field).toBe(field);
      expect(error.message.startsWith(`${field}: `)).toBe(true);
    }
    // "transparent" is a PNG matter: the same signed chart is refused as JPEG.
    const transparent = { ...CHART, options: { background: 'transparent' } };
    expect((await show(await chartPath(site, transparent, 'jpg'))).status).toBe(400);
    expect(renders).not.toHaveBeenCalled();
    expect((await show(await chartPath(site, transparent, 'png'))).status).toBe(200);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('answers 404 for a path that is not a chart URL and for an unknown or deleted site', async () => {
    const { site } = await account();
    for (const path of ['/v1/chart', '/v1/chart/', '/v1/chart/s_x.gif?c=1&sig=2', '/v1/chart/a/b.png', '/v1/chart/s_unknown.png?c=%7B%7D&sig=' + '0'.repeat(64)]) {
      const response = await show(path);
      expect(response.status, path).toBe(404);
    }
    const path = await chartPath(site);
    await run(env.DB, 'UPDATE sites SET deleted_at = ?1 WHERE id = ?2', Date.now(), site.id);
    expect((await show(path)).status).toBe(404);
    expect((await show('/v1/chart/s_x.png', env, { method: 'POST' })).status).toBe(404);
  });

  it('answers 403 for a suspended account', async () => {
    const { user, site } = await account();
    await run(env.DB, 'UPDATE users SET suspended_at = ?1 WHERE id = ?2', Date.now(), user.id);
    const response = await show(await chartPath(site));
    expect(response.status).toBe(403);
    expect((JSON.parse(new TextDecoder().decode(response.bytes)) as { error: { code: string } }).error.code).toBe('account_suspended');
  });

  it('answers repeat requests from the edge cache and a conditional request with 304', async () => {
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    const path = await chartPath(site, chartNamed('Edge'));
    const first = await show(path);
    expect([first.status, first.cache, first.credits]).toEqual([200, 'miss', '1']);
    const second = await show(path);
    expect([second.status, second.cache, second.credits]).toEqual([200, 'hit', '0']);
    expect(second.bytes).toEqual(first.bytes);
    const conditional = await show(path, env, { headers: { 'if-none-match': `"${first.key}"` } });
    expect(conditional.status).toBe(304);
    expect(conditional.bytes.byteLength).toBe(0);
    // Without the edge copy, the stored copy answers; the conditional request needs no body from R2.
    vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
    const stored = await show(path);
    expect([stored.status, stored.cache, stored.credits]).toEqual([200, 'hit', '0']);
    expect((await show(path, env, { headers: { 'if-none-match': `"${first.key}"` } })).status).toBe(304);
    expect(renders).toHaveBeenCalledTimes(1);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('answers an error as JSON with the docs link', async () => {
    const { site } = await account();
    const response = await call((await chartPath(site)).replace(/sig=[0-9a-f]{4}/, 'sig=ffff'));
    const error = await errorOf(response);
    expect(error.code).toBe('invalid_signature');
    expect(error.docs).toContain('/docs/');
  });
});
