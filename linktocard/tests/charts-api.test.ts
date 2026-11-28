// POST /v1/charts (API key), POST /api/tools/chart (the free chart maker's endpoint) and the
// CHARTS_ENABLED kill switch. Real app, real D1 and R2, the real renderer.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHARTS, FEATURE_FLAGS, RATE_LIMITS } from '../src/config';
import * as chartRender from '../src/charts/render';
import { parseChart } from '../src/charts/spec';
import { all } from '../src/db/client';
import { featureEnabled } from '../src/lib/features';
import * as rateLimit from '../src/lib/rate-limit';
import type { Env } from '../src/types';
import { apiKeyFor, bearer, bytesOf, call, createSite, createUser, errorOf, isJpeg, isPng, pngDimensions, renderCount, usageOf } from './app-helpers';
import { CHART, chartNamed, chartPath, postChart, postTool, show } from './charts-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Limits on: tests switch rate limits off by default. */
const limited: Env = { ...env, RATE_LIMITS_DISABLED: '' };

async function account(plan: 'free' | 'starter' | 'pro' = 'starter') {
  const user = await createUser(plan);
  const key = await apiKeyFor(user.id);
  return { user, key };
}

interface ChartAnswer {
  id: string;
  url: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  cached: boolean;
  credits_used: number;
  created_at: string;
  expires_at: string;
  warnings: string[];
  usage: { used: number; limit: number };
}

describe('POST /v1/charts', () => {
  it('draws a chart and answers like POST /v1/images', async () => {
    const { user, key } = await account();
    const response = await postChart(key.secret, { ...CHART, scale: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = (await response.json()) as ChartAnswer;
    expect(Object.keys(answer).sort()).toEqual(['bytes', 'cached', 'created_at', 'credits_used', 'expires_at', 'format', 'height', 'id', 'url', 'usage', 'warnings', 'width']);
    expect(answer).toMatchObject({ width: 600, height: 400, format: 'png', cached: false, credits_used: 1, warnings: [] });
    expect(answer.id).toMatch(/^[0-9a-f]{64}$/);
    expect(answer.url).toBe(`${env.APP_URL}/i/${user.id}/${answer.id}.png`);
    expect(answer.usage.used).toBe(1);
    expect(Date.parse(answer.expires_at)).toBeGreaterThan(Date.parse(answer.created_at));

    // The URL serves the stored image; fetching it draws and charges nothing.
    const image = await call(new URL(answer.url).pathname);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    const bytes = await bytesOf(image);
    expect(bytes.byteLength).toBe(answer.bytes);
    expect(pngDimensions(bytes)).toEqual({ width: 600, height: 400 });

    const again = (await (await postChart(key.secret, { ...CHART, scale: 2 })).json()) as ChartAnswer;
    expect(again).toMatchObject({ id: answer.id, url: answer.url, cached: true, credits_used: 0 });
    expect(again.usage.used).toBe(1);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);
  });

  it('takes "format" beside the chart: png, jpeg (or jpg) and webp', async () => {
    const { key } = await account();
    const jpeg = (await (await postChart(key.secret, { ...CHART, format: 'jpg' })).json()) as ChartAnswer;
    expect(jpeg.format).toBe('jpeg');
    expect(jpeg.url.endsWith('.jpg')).toBe(true);
    const image = await call(new URL(jpeg.url).pathname);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(isJpeg(await bytesOf(image))).toBe(true);
    expect(((await (await postChart(key.secret, { ...CHART, format: 'webp' })).json()) as ChartAnswer).format).toBe('webp');

    const unsupported = await postChart(key.secret, { ...CHART, format: 'gif' });
    expect(unsupported.status).toBe(400);
    expect((await errorOf(unsupported)).code).toBe('unsupported_format');
    const transparent = await postChart(key.secret, { ...CHART, options: { background: 'transparent' }, format: 'jpeg' });
    expect(transparent.status).toBe(400);
    expect((await errorOf(transparent)).details).toEqual({ field: 'options.background' });
  });

  it('refuses what is not a valid chart, naming the field, without a charge', async () => {
    const { user, key } = await account();
    for (const [body, field] of [
      [{ ...CHART, response: 'binary' }, 'response'],
      [{ ...CHART, type: 'scatter' }, 'type'],
      [{ ...CHART, series: [{ data: [1, 2, 'x'] }] }, 'series[0].data[2]'],
      [{ ...CHART, options: { background: 'https://example.com/bg.png' } }, 'options.background'],
      [{ ...CHART, width: CHARTS.maxWidth + 1 }, 'width'],
    ] as const) {
      const response = await postChart(key.secret, body);
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe('invalid_request');
      expect(error.details).toEqual({ field });
      expect(error.message.startsWith(`${field}: `)).toBe(true);
    }
    expect((await postChart(key.secret, '[1]')).status).toBe(400);
    expect((await postChart(key.secret, '{"type":')).status).toBe(400);
    const tooLarge = await postChart(key.secret, JSON.stringify({ ...CHART, title: 'x'.repeat(CHARTS.maxJsonBytes) }));
    expect(tooLarge.status).toBe(413);
    expect((await errorOf(tooLarge)).details).toEqual({ max_bytes: CHARTS.maxJsonBytes });
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('wants an API key', async () => {
    expect((await postChart(null, CHART)).status).toBe(401);
    const wrong = await postChart('ltc_not-a-real-key', CHART);
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).code).toBe('invalid_api_key');
    expect((await call('/v1/charts')).status).toBe(404);
  });

  it('counts against the limits of POST /v1/images: RL_IP per client, RL_KEY per API key', async () => {
    const { key } = await account();
    const limits = vi.spyOn(rateLimit, 'enforceRateLimit');
    expect((await call('/v1/charts', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9' }, body: JSON.stringify(CHART) })).status).toBe(200);
    expect(limits.mock.calls.map(([, name, bucket]) => [name, bucket])).toEqual([
      ['RL_IP', '198.51.100.9'],
      ['RL_KEY', key.id],
    ]);
  });

  it('applies RL_KEY per site to a signed URL only when a chart has to be drawn', async () => {
    const user = await createUser('starter');
    const site = await createSite(user.id);
    vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
    const limits = vi.spyOn(rateLimit, 'enforceRateLimit');
    const path = await chartPath(site, chartNamed('Limits'));
    expect((await show(path)).status).toBe(200);
    expect(limits.mock.calls.map(([, name, bucket]) => [name, bucket])).toEqual([
      ['RL_IP', 'unknown'],
      ['RL_KEY', site.id],
    ]);
    limits.mockClear();
    expect((await show(path)).cache).toBe('hit');
    expect(limits.mock.calls.map(([, name]) => name)).toEqual(['RL_IP']);
  });
});

/** Every row of every table that could show that something was kept. */
async function storedRows(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['renders', 'usage_periods', 'tool_usage', 'users', 'og_checks']) {
    counts[table] = (await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table}`))[0]!.n;
  }
  counts.objects = (await env.BUCKET.list()).objects.length;
  return counts;
}

describe('POST /api/tools/chart (the free chart maker)', () => {
  it('answers the PNG, always with the Free corner mark', async () => {
    const response = await postTool({ ...CHART, scale: 2 });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-ltc-warnings') ?? ''))).toEqual([]);
    const bytes = await bytesOf(response);
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(isPng(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 600, height: 400 });
    const chart = parseChart({ ...CHART, scale: 2 });
    expect(bytes).toEqual((await chartRender.renderChart(chart, { format: 'png', mark: 'free' })).bytes);
    expect(bytes).not.toEqual((await chartRender.renderChart(chart, { format: 'png', mark: 'none' })).bytes);
  });

  it('keeps nothing: no R2 object, no usage row, no row of any kind', async () => {
    const before = await storedRows();
    const putSpy = vi.spyOn(env.BUCKET, 'put');
    for (const title of ['One', 'Two', 'Three']) expect((await postTool(chartNamed(title))).status).toBe(200);
    expect((await postTool({ ...CHART, type: 'nope' })).status).toBe(400);
    expect(putSpy).not.toHaveBeenCalled();
    expect(await storedRows()).toEqual(before);
  });

  it('says what is wrong with a chart, naming the field', async () => {
    const response = await postTool({ ...CHART, series: [{ data: [1, 2] }] });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error).toMatchObject({ code: 'invalid_request', details: { field: 'series[0].data' } });
    expect(error.message).toContain('2 values but there are 3 labels');
    // "format" is not part of the chart JSON: the free endpoint answers PNG.
    expect((await errorOf(await postTool({ ...CHART, format: 'webp' }))).details).toEqual({ field: 'format' });
    expect((await postTool(JSON.stringify({ ...CHART, title: 'x'.repeat(CHARTS.maxJsonBytes) }))).status).toBe(413);
  });

  it('reports text it cannot draw in x-ltc-warnings', async () => {
    const response = await postTool({ ...CHART, title: '売上高' });
    expect(response.status).toBe(200);
    const warnings = JSON.parse(decodeURIComponent(response.headers.get('x-ltc-warnings') ?? '')) as string[];
    expect(warnings.join(' ')).toMatch(/No bundled font covers/);
  });

  it('is for this site\'s pages: another origin and other body types are refused; it needs no account', async () => {
    expect((await postTool(CHART, env, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/tools/chart', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(CHART) })).status).toBe(403);
    // No Origin (a server-side caller) passes, like the other free tools.
    expect((await call('/api/tools/chart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CHART) })).status).toBe(200);
    expect((await call('/api/tools/chart')).status).not.toBe(200);
  });

  it('is limited per client by RL_PLAYGROUND, counted apart from the playground', async () => {
    const checks = vi.spyOn(rateLimit, 'enforceRateLimit');
    expect((await postTool(CHART, limited, { 'cf-connecting-ip': '203.0.113.50' })).status).toBe(200);
    expect(checks.mock.calls.map(([, name, bucket]) => [name, bucket])).toEqual([['RL_PLAYGROUND', 'chart:203.0.113.50']]);
    checks.mockRestore();

    const { limit, periodSeconds } = RATE_LIMITS.RL_PLAYGROUND;
    const statuses: number[] = [];
    for (let n = 0; n < limit + 1; n++) statuses.push((await postTool({ ...CHART, width: 200, height: 200 }, limited, { 'cf-connecting-ip': '203.0.113.51' })).status);
    expect(statuses.slice(0, limit).every((status) => status === 200)).toBe(true);
    const refused = await postTool(CHART, limited, { 'cf-connecting-ip': '203.0.113.51' });
    expect(statuses[limit]).toBe(429);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(periodSeconds));
    expect((await errorOf(refused)).code).toBe('rate_limited');
    // Another client is not affected.
    expect((await postTool(CHART, limited, { 'cf-connecting-ip': '203.0.113.52' })).status).toBe(200);
  });
});

describe('the kill switch CHARTS_ENABLED', () => {
  it('is one of the feature switches and must be exactly "true"', () => {
    expect(FEATURE_FLAGS.charts).toBe('CHARTS_ENABLED');
    expect(featureEnabled(env, 'charts')).toBe(true);
    for (const value of ['false', 'TRUE', '1', '', undefined]) expect(featureEnabled({ CHARTS_ENABLED: value }, 'charts')).toBe(false);
  });

  it('off: every chart route answers 503 not_configured, whatever the method, and draws nothing', async () => {
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const key = await apiKeyFor(user.id);
    const path = await chartPath(site, chartNamed('Switch'));
    // Stored and at the edge while the switch is on.
    expect((await show(path)).status).toBe(200);
    const stored = (await (await postChart(key.secret, chartNamed('Switch'))).json()) as ChartAnswer;
    const renders = vi.spyOn(chartRender, 'renderChart');

    for (const value of ['false', 'TRUE', undefined]) {
      const off: Env = { ...env, CHARTS_ENABLED: value };
      const requests: Array<[string, RequestInit]> = [
        [path, {}],
        [path, { method: 'HEAD' }],
        [path, { method: 'POST' }],
        ['/v1/chart/s_unknown.png', {}],
        ['/v1/chart', {}],
        ['/v1/charts', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify(CHART) }],
        ['/v1/charts', { method: 'POST' }],
        ['/v1/charts', {}],
        ['/v1/charts/anything', { method: 'DELETE' }],
        ['/api/tools/chart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CHART) }],
        ['/api/tools/chart', {}],
        ['/api/tools/chart/anything', { method: 'PUT' }],
      ];
      for (const [target, init] of requests) {
        const response = await call(target, init, off);
        expect(response.status, `${init.method ?? 'GET'} ${target}`).toBe(503);
        if (init.method !== 'HEAD') expect((await errorOf(response)).code).toBe('not_configured');
      }
      // Everything else is as it was: the other free tools, the API, and images that are already stored.
      expect((await call('/v1/usage', { headers: bearer(key.secret) }, off)).status).toBe(200);
      expect((await call('/api/tools/og-check', {}, off)).status).toBe(400);
      expect((await call(new URL(stored.url).pathname, {}, off)).status).toBe(200);
    }
    expect(renders).not.toHaveBeenCalled();
    expect((await usageOf(user.id)).used).toBe(1);
  });
});
