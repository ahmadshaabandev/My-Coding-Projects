// Chart images are charged once (owner decision of 2026-11-28: "1 credit per new chart, repeat
// views free"). A chart is one account + one chart JSON (canonical form) + one output format. It
// is charged 1 image the first time it is drawn; repeat views are answered from the edge cache or
// R2; once the stored copy's period has ended it is drawn and stored again without a new charge
// while the charge is remembered (CHARTS.chargeMemoryDays). Real app, real D1 and R2, the real
// renderer; Date is faked to let stored copies expire.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { CHARTS, DAY_MS } from '../src/config';
import * as chartRender from '../src/charts/render';
import { chartKeys, CHART_LABEL } from '../src/charts/service';
import { parseChart } from '../src/charts/spec';
import { first, run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import { renderR2Key } from '../src/lib/images';
import { emailChargeRange } from '../src/lib/open-fields';
import { chargeRecordBucket } from '../src/lib/quota';
import type { UserRow } from '../src/types';
import { apiKeyFor, createSite, createUser, errorOf, isPng, renderCount, setUsed, usageOf, userRow } from './app-helpers';
import { CHART, chartNamed, chartPath, postChart, show } from './charts-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The first day of a month, so that the Free plan's 7 cache days end inside the same usage period. */
const T0 = Date.UTC(2027, 2, 1, 9, 0);
const FREE_TTL = PLANS.free.cacheDays * DAY_MS;
const MEMORY_MS = CHARTS.chargeMemoryDays * DAY_MS;

function at(time: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
}

async function account(plan: 'free' | 'starter' | 'pro' = 'free') {
  const user = await createUser(plan, Date.now());
  const site = await createSite(user.id, Date.now());
  return { user, site };
}

/** Every request misses the edge cache, so it is answered from R2 or drawn. */
const withoutEdgeCache = () => vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

const keysOf = (user: UserRow, chart: unknown = CHART, format: 'png' | 'jpeg' | 'webp' = 'png') => chartKeys({ user, chart: parseChart(chart), format });
const ledgerOf = (userId: string, cacheKey: string) =>
  first<{ charged_to: string; template: string; source: string; site_id: string | null; created_at: number; expires_at: number }>(
    env.DB,
    'SELECT charged_to, template, source, site_id, created_at, expires_at FROM renders WHERE cache_key = ?1 AND user_id = ?2',
    cacheKey,
    userId,
  );
const memoryOf = (userId: string, chargeKey: string) =>
  first<{ count: number; expires_at: number }>(env.DB, 'SELECT count, expires_at FROM tool_usage WHERE bucket = ?1', chargeRecordBucket(userId, chargeKey));
const storedObject = (userId: string, cacheKey: string) => env.BUCKET.head(renderR2Key(userId, cacheKey, 'png'));

describe('a chart is charged once', () => {
  it('charges 1 image for the first draw and nothing for repeat views', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    const path = await chartPath(site);
    const keys = await keysOf(user);

    const firstView = await show(path);
    expect([firstView.status, firstView.cache, firstView.credits]).toEqual([200, 'miss', '1']);
    expect(isPng(firstView.bytes)).toBe(true);
    expect(firstView.key).toBe(keys.cacheKey);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, keys.cacheKey)).toEqual({ charged_to: 'plan', template: CHART_LABEL, source: 'og', site_id: site.id, created_at: T0, expires_at: T0 + FREE_TTL });
    // The charge is remembered CHARTS.chargeMemoryDays from the charge, under a key that holds no text of the chart.
    expect(await memoryOf(user.id, keys.chargeKey)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS });
    expect(await storedObject(user.id, keys.cacheKey)).not.toBeNull();

    for (let n = 0; n < 3; n++) {
      at(T0 + (n + 1) * DAY_MS);
      const again = await show(path);
      expect([again.status, again.cache, again.credits]).toEqual([200, 'hit', '0']);
      expect(again.bytes).toEqual(firstView.bytes);
    }
    expect(renders).toHaveBeenCalledTimes(1);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);
  });

  it('is the same chart whatever the order of its keys, its white space or a default written out', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const first = await show(await chartPath(site, CHART));
    expect(first.credits).toBe('1');
    const reordered = '{"height":200,"width":300,"series":[{"data":[4200,5100.0,48e2],"name":"Revenue"}],"labels":["Jan","Feb","Mar"],"title":"Monthly revenue","type":"bar"}';
    const spaced = JSON.stringify(CHART).replaceAll(',', ', ').replaceAll(':', ': ');
    const withDefaults = JSON.stringify({ ...CHART, scale: 1, subtitle: '', options: { legend: false, theme: 'light', values: false } });
    for (const json of [reordered, spaced, withDefaults]) {
      const same = await show(await chartPath(site, json));
      expect([same.status, same.cache, same.credits, same.key], json).toEqual([200, 'hit', '0', first.key]);
    }
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('draws it again for free after the stored period, while the charge is remembered', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    const path = await chartPath(site);
    const keys = await keysOf(user);
    expect((await show(path)).credits).toBe('1');

    // The last moment of the stored period: still the stored copy.
    at(T0 + FREE_TTL - 1);
    expect((await show(path)).cache).toBe('hit');

    at(T0 + FREE_TTL);
    const redrawn = await show(path);
    expect([redrawn.status, redrawn.cache, redrawn.credits]).toEqual([200, 'miss', '0']);
    expect(isPng(redrawn.bytes)).toBe(true);
    expect(renders).toHaveBeenCalledTimes(2);
    expect((await usageOf(user.id)).used).toBe(1);
    // The new copy has a ledger row without a charge, and is stored for a new period.
    expect(await ledgerOf(user.id, keys.cacheKey)).toMatchObject({ charged_to: 'none', created_at: T0 + FREE_TTL, expires_at: T0 + 2 * FREE_TTL });
    // The memory still counts from the first charge.
    expect(await memoryOf(user.id, keys.chargeKey)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS });
    expect((await show(path)).cache).toBe('hit');

    // And again, many periods later, in another month: still free.
    at(T0 + 300 * DAY_MS);
    const later = await show(path);
    expect([later.status, later.cache, later.credits]).toEqual([200, 'miss', '0']);
    expect((await usageOf(user.id)).used).toBe(0);
    expect(renders).toHaveBeenCalledTimes(3);
  });

  it('charges it again once the memory has ended', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const path = await chartPath(site);
    const keys = await keysOf(user);
    expect((await show(path)).credits).toBe('1');

    // The last moment of the memory: free.
    at(T0 + MEMORY_MS - 1);
    expect((await show(path)).credits).toBe('0');
    // Its copy is stored until past the end of the memory; after that the chart is new again.
    at(T0 + MEMORY_MS - 1 + FREE_TTL);
    const charged = await show(path);
    expect([charged.status, charged.cache, charged.credits]).toEqual([200, 'miss', '1']);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, keys.cacheKey)).toMatchObject({ charged_to: 'plan' });
    expect(await memoryOf(user.id, keys.chargeKey)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS - 1 + FREE_TTL + MEMORY_MS });
  });

  it('counts the format, the account and every change to the chart as another chart', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account('starter');
    expect((await show(await chartPath(site, CHART, 'png'))).credits).toBe('1');
    expect((await show(await chartPath(site, CHART, 'webp'))).credits).toBe('1');
    // jpg and jpeg are one format.
    expect((await show(await chartPath(site, CHART, 'jpg'))).credits).toBe('1');
    expect((await show(await chartPath(site, CHART, 'jpeg'))).credits).toBe('0');
    expect((await show(await chartPath(site, { ...CHART, width: 301 }))).credits).toBe('1');
    expect((await show(await chartPath(site, { ...CHART, scale: 2 }))).credits).toBe('1');
    expect((await show(await chartPath(site, chartNamed('Another title')))).credits).toBe('1');
    expect((await usageOf(user.id)).used).toBe(6);
    // Another site of the same account: the same chart, already charged.
    const secondSite = await createSite(user.id, Date.now());
    const shared = await show(await chartPath(secondSite, CHART));
    expect([shared.cache, shared.credits]).toEqual(['hit', '0']);
    // Another account pays for its own.
    const other = await account('starter');
    expect((await show(await chartPath(other.site, CHART))).credits).toBe('1');
    expect((await usageOf(other.user.id)).used).toBe(1);
    expect((await usageOf(user.id)).used).toBe(6);
  });

  it('shares the charge between the signed URL and the API', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const key = await apiKeyFor(user.id, Date.now());
    const viaApi = (await (await postChart(key.secret, chartNamed('Shared'))).json()) as { cached: boolean; credits_used: number; id: string };
    expect(viaApi).toMatchObject({ cached: false, credits_used: 1 });
    const viaUrl = await show(await chartPath(site, chartNamed('Shared')));
    expect([viaUrl.cache, viaUrl.credits, viaUrl.key]).toEqual(['hit', '0', viaApi.id]);
    // After the stored period, the API draws it again for free too.
    at(T0 + FREE_TTL);
    const again = (await (await postChart(key.secret, chartNamed('Shared'))).json()) as { cached: boolean; credits_used: number };
    expect(again).toMatchObject({ cached: false, credits_used: 0 });
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('does not charge a chart again when the account changes plan', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account('free');
    const path = await chartPath(site);
    const free = await show(path);
    expect(free.credits).toBe('1');
    const freeKeys = await keysOf(user);

    await run(env.DB, "UPDATE users SET plan = 'starter' WHERE id = ?1", user.id);
    const paidKeys = await keysOf(await userRow(user.id));
    // Same charge, another stored copy: the paid one has no mark.
    expect(paidKeys.chargeKey).toBe(freeKeys.chargeKey);
    expect(paidKeys.cacheKey).not.toBe(freeKeys.cacheKey);
    const paid = await show(path);
    expect([paid.status, paid.cache, paid.credits, paid.key]).toEqual([200, 'miss', '0', paidKeys.cacheKey]);
    expect(paid.bytes).not.toEqual(free.bytes);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, paidKeys.cacheKey)).toMatchObject({ charged_to: 'none' });
  });
});

describe('the mark', () => {
  it('is on a Free chart and not on a paid one', async () => {
    withoutEdgeCache();
    const chart = parseChart(CHART);
    const marked = (await chartRender.renderChart(chart, { format: 'png', mark: 'free' })).bytes;
    const plain = (await chartRender.renderChart(chart, { format: 'png', mark: 'none' })).bytes;
    expect(marked).not.toEqual(plain);
    for (const [plan, expected] of [['free', marked], ['starter', plain], ['pro', plain]] as const) {
      const { user, site } = await account(plan);
      const viaUrl = await show(await chartPath(site));
      expect(viaUrl.status).toBe(200);
      expect(viaUrl.bytes, plan).toEqual(expected);
      // The API stores the same image.
      const key = await apiKeyFor(user.id);
      const { url, cached } = (await (await postChart(key.secret, CHART)).json()) as { url: string; cached: boolean };
      expect(cached).toBe(true);
      expect((await show(new URL(url).pathname)).bytes, plan).toEqual(expected);
    }
  });
});

describe('at the limit', () => {
  it('answers 402 for a new chart, with the remedies of images, and draws nothing', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    // Using the last image sends the "allowance used up" email; the mail API is not called for real.
    const mail = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'email_test' }));
    await setUsed(user, PLANS.free.monthlyImages - 1, Date.now());
    expect((await show(await chartPath(site, chartNamed('Last one')))).credits).toBe('1');
    expect(renders).toHaveBeenCalledTimes(1);
    expect(mail).toHaveBeenCalledTimes(1);

    const refused = await show(await chartPath(site, chartNamed('One too many')));
    expect(refused.status).toBe(402);
    const error = (JSON.parse(new TextDecoder().decode(refused.bytes)) as { error: { code: string; message: string; details: { usage: { used: number; limit: number } } } }).error;
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toContain(`${PLANS.free.monthlyImages} images`);
    expect(error.details.usage).toMatchObject({ used: PLANS.free.monthlyImages, limit: PLANS.free.monthlyImages });
    expect(renders).toHaveBeenCalledTimes(1);
    const keys = await keysOf(user, chartNamed('One too many'));
    expect(await ledgerOf(user.id, keys.cacheKey)).toBeNull();
    expect(await memoryOf(user.id, keys.chargeKey)).toBeNull();
    // The API says the same.
    const key = await apiKeyFor(user.id, Date.now());
    const viaApi = await postChart(key.secret, chartNamed('One too many'));
    expect(viaApi.status).toBe(402);
    expect((await errorOf(viaApi)).code).toBe('quota_exceeded');
  });

  it('keeps serving a chart that was already charged, from the store and drawn again', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const path = await chartPath(site);
    expect((await show(path)).credits).toBe('1');
    await setUsed(user, PLANS.free.monthlyImages, Date.now());
    expect((await usageOf(user.id)).total_remaining).toBe(0);

    const stored = await show(path);
    expect([stored.status, stored.cache, stored.credits]).toEqual([200, 'hit', '0']);
    at(T0 + FREE_TTL);
    await setUsed(await userRow(user.id), PLANS.free.monthlyImages, Date.now());
    const redrawn = await show(path);
    expect([redrawn.status, redrawn.cache, redrawn.credits]).toEqual([200, 'miss', '0']);
    expect(isPng(redrawn.bytes)).toBe(true);
    expect((await usageOf(user.id)).used).toBe(PLANS.free.monthlyImages);
  });
});

describe('HEAD', () => {
  it('never draws and never charges', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const renders = vi.spyOn(chartRender, 'renderChart');
    const path = await chartPath(site);
    const keys = await keysOf(user);

    // Before the first draw: what a GET would most likely say, without a length, not cacheable.
    const before = await show(path, env, { method: 'HEAD' });
    expect([before.status, before.cache, before.credits, before.key]).toEqual([200, 'miss', '0', keys.cacheKey]);
    expect(before.headers.get('content-type')).toBe('image/png');
    expect(before.headers.get('cache-control')).toBe('no-store');
    expect(before.headers.get('content-length')).toBeNull();
    expect(before.bytes.byteLength).toBe(0);
    expect(renders).not.toHaveBeenCalled();
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await renderCount(user.id)).toBe(0);
    expect(await memoryOf(user.id, keys.chargeKey)).toBeNull();
    expect(await storedObject(user.id, keys.cacheKey)).toBeNull();

    // Stored: the stored copy's headers and length.
    const get = await show(path);
    expect(get.credits).toBe('1');
    const stored = await show(path, env, { method: 'HEAD' });
    expect([stored.status, stored.cache, stored.credits]).toEqual([200, 'hit', '0']);
    expect(stored.headers.get('content-length')).toBe(String(get.bytes.byteLength));
    expect(stored.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);

    // With no images left: 402 for a new chart, 200 for one that was charged and whose copy expired.
    await setUsed(user, PLANS.free.monthlyImages, Date.now());
    expect((await show(await chartPath(site, chartNamed('New')), env, { method: 'HEAD' })).status).toBe(402);
    at(T0 + FREE_TTL);
    await setUsed(await userRow(user.id), PLANS.free.monthlyImages, Date.now());
    const expired = await show(path, env, { method: 'HEAD' });
    expect([expired.status, expired.cache, expired.credits]).toEqual([200, 'miss', '0']);
    expect(renders).toHaveBeenCalledTimes(1);
    expect((await usageOf(user.id)).used).toBe(PLANS.free.monthlyImages);
  });
});

describe('a failed render', () => {
  it('is never charged, stored or remembered', async () => {
    at(T0);
    withoutEdgeCache();
    const { user, site } = await account();
    const key = await apiKeyFor(user.id, Date.now());
    const path = await chartPath(site);
    const keys = await keysOf(user);
    for (const failure of [new ApiError('render_failed', 'The chart could not be drawn.'), new ApiError('render_timeout', 'Rendering took too long.'), new ApiError('template_error', 'The chart is too complex.')]) {
      const renders = vi.spyOn(chartRender, 'renderChart').mockRejectedValue(failure);
      expect((await show(path)).status).toBe(failure.status);
      expect((await postChart(key.secret, CHART)).status).toBe(failure.status);
      expect(renders).toHaveBeenCalledTimes(2);
      renders.mockRestore();
    }
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await renderCount(user.id)).toBe(0);
    expect(await ledgerOf(user.id, keys.cacheKey)).toBeNull();
    expect(await memoryOf(user.id, keys.chargeKey)).toBeNull();
    expect(await storedObject(user.id, keys.cacheKey)).toBeNull();
    // Nothing is left in the way: the next request draws and is charged once.
    const drawn = await show(path);
    expect([drawn.status, drawn.credits]).toEqual([200, '1']);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('a refused chart is not charged either', async () => {
    const { user, site } = await account();
    expect((await show(await chartPath(site, { ...CHART, type: 'radar' }))).status).toBe(400);
    expect((await show(await chartPath(site, { ...CHART, options: { background: 'transparent' } }, 'webp'))).status).toBe(400);
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await renderCount(user.id)).toBe(0);
  });
});

describe('the charge record', () => {
  it('lies in the range that is deleted with the account, and holds no text of the chart', async () => {
    const { user } = await account();
    const keys = await keysOf(user, chartNamed('Secret title'));
    const bucket = chargeRecordBucket(user.id, keys.chargeKey);
    const range = emailChargeRange(user.id);
    expect(bucket > range.from && bucket < range.to).toBe(true);
    expect(bucket).not.toContain('Secret');
    expect(keys.chargeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.cacheKey).not.toBe(keys.chargeKey);
  });
});
