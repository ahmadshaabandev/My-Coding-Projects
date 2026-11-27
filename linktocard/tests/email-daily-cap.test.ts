// The daily cap of unique open-field renders counts images, not requests (audit CHG-1). Every
// request for an image that is not stored takes or shares that image's slot of the UTC day, so a
// burst of identical first opens holds one slot, renders that reader's image for every request and
// charges it once, also with one slot left; distinct values still stop at the plan's daily limit,
// and past it they get the default card. Real app, real D1 and R2, the real renderer.
//
// Each test fills a site's day with real opens of distinct values, not with rows written by hand,
// so that it describes what a site really goes through and checks the route end to end.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, EMAIL_FIELDS } from '../src/config';
import { all, first } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import * as openFieldsModule from '../src/lib/open-fields';
import * as renderModule from '../src/render';
import type { Env } from '../src/types';
import { bytesOf, call, createSite, createUser, dashboard, isPng, renderCount, sessionCookieFor, usageOf } from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Limits on: the daily cap is a limit, and tests switch limits off by default. */
const limited: Env = { ...env, RATE_LIMITS_DISABLED: '' };
const LIMIT = EMAIL_FIELDS.maxUniqueRendersPerDay.free;

async function account() {
  const user = await createUser('free', Date.now());
  const cookie = await sessionCookieFor(user.id, Date.now());
  const site = await createSite(user.id, Date.now());
  return { user, cookie, site };
}

/** Path + query of the email banner signed with "name" open, ending in "&name=" for the value. */
async function openUrl(cookie: string, siteId: string): Promise<string> {
  const response = await dashboard(cookie, 'POST', '/api/sign', {
    site_id: siteId,
    template: 'email-banner',
    data: { title: 'Your spring picks are ready', greeting: 'Hi', name_default: 'there' },
    open: ['name'],
  });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return new URL(url).pathname + new URL(url).search;
}

interface Open {
  status: number;
  key: string;
  credits: string | null;
  /** X-LTC-Open-Fields: "daily-limit" on the default card served past the cap, else null. */
  openFields: string | null;
  cacheControl: string | null;
}

/** One open of an email image with limits on, body read. */
async function open(path: string): Promise<Open> {
  const response = await call(path, {}, limited);
  const body = await bytesOf(response);
  if (response.status === 200) expect(isPng(body)).toBe(true);
  return {
    status: response.status,
    key: (response.headers.get('etag') ?? '').replaceAll('"', ''),
    credits: response.headers.get('x-ltc-credits-used'),
    openFields: response.headers.get('x-ltc-open-fields'),
    cacheControl: response.headers.get('cache-control'),
  };
}

/** Opens `count` new distinct values one after another: each renders, is charged and takes a slot of the day. */
async function openDistinct(path: string, count: number, prefix = 'Reader'): Promise<Open[]> {
  const opens: Open[] = [];
  for (let n = 0; n < count; n++) {
    const response = await open(`${path}${prefix}${n}`);
    expect(response, `${prefix}${n}`).toMatchObject({ status: 200, credits: '1', openFields: null });
    opens.push(response);
  }
  return opens;
}

/*
 * The slots as src/lib/open-fields.ts stores them: one tool_usage row "emailr:{site}:{day}:{cache
 * key}" per image, strictly between "emailr:{site}:{day}:" and "emailr:{site}:{day};". Spelled
 * out here rather than imported, so that the test pins the format the cleanup and the privacy
 * page rely on.
 */
const dayPrefix = (siteId: string, at: number): string => `emailr:${siteId}:${Math.floor(at / DAY_MS)}`;
const slotsOf = async (siteId: string, at = Date.now()): Promise<string[]> =>
  (await all<{ bucket: string }>(env.DB, 'SELECT bucket FROM tool_usage WHERE bucket > ?1 AND bucket < ?2', `${dayPrefix(siteId, at)}:`, `${dayPrefix(siteId, at)};`)).map(
    (row) => row.bucket.slice(dayPrefix(siteId, at).length + 1),
  );
const slotRowOf = (siteId: string, cacheKey: string, at = Date.now()) =>
  first<{ count: number; expires_at: number }>(env.DB, 'SELECT count, expires_at FROM tool_usage WHERE bucket = ?1', `${dayPrefix(siteId, at)}:${cacheKey}`);

/** Every request misses the edge cache, so it is answered from R2 or rendered. */
const withoutEdgeCache = () => vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

/**
 * Holds every render until `requests` requests have asked for their slot of the day, so that all
 * of them miss storage and meet the cap together: the timing of a real burst (a mail proxy and a
 * prefetch fetching one image at once), made the same on every run. After 20 s the renders go
 * ahead anyway, and the assertions say what happened.
 */
function holdRendersUntilReserved(requests: number): void {
  const reserve = openFieldsModule.reserveOpenFieldRender;
  const render = renderModule.renderCard;
  let reserved = 0;
  let go!: () => void;
  const allReserved = new Promise<void>((resolve) => (go = resolve));
  const timer = setTimeout(() => go(), 20_000);
  vi.spyOn(openFieldsModule, 'reserveOpenFieldRender').mockImplementation(async (...args: Parameters<typeof reserve>) => {
    const reservation = await reserve(...args);
    if (++reserved === requests) {
      clearTimeout(timer);
      go();
    }
    return reservation;
  });
  vi.spyOn(renderModule, 'renderCard').mockImplementation(async (...args: Parameters<typeof render>) => {
    await allReserved;
    return render(...args);
  });
}

const sum = (opens: Open[]): number => opens.map((response) => Number(response.credits ?? 0)).reduce((total, credits) => total + credits, 0);

describe('the daily cap counts images, not requests (audit CHG-1)', () => {
  it('a burst of 10 simultaneous first opens of one value, one slot below the cap: all 10 get that value, 1 image is charged, 1 slot is taken', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const earlier = await openDistinct(path, LIMIT - 1);
    expect((await usageOf(user.id)).used).toBe(LIMIT - 1);

    withoutEdgeCache();
    holdRendersUntilReserved(10);
    const burst = await Promise.all(Array.from({ length: 10 }, () => open(`${path}Maya`)));
    for (const [n, response] of burst.entries()) {
      // Maya's own image, kept by mail proxies: not the default card served past the cap.
      expect(response, `request ${n}`).toMatchObject({ status: 200, openFields: null, key: burst[0]!.key });
      expect(response.cacheControl, `request ${n}`).toMatch(/^public, max-age=\d+$/);
    }
    expect(earlier.map((response) => response.key)).not.toContain(burst[0]!.key);
    expect(sum(burst)).toBe(1);
    expect((await usageOf(user.id)).used).toBe(LIMIT);
    // Nothing else was rendered and charged: no default card, one ledger row per image.
    expect(await renderCount(user.id)).toBe(LIMIT);
    // One slot per image: the earlier values' and the one that every request of the burst held. The day is full.
    expect((await slotsOf(site.id)).sort()).toEqual([...earlier, burst[0]!].map((response) => response.key).sort());
    expect(await open(`${path}Eve`)).toMatchObject({ status: 200, openFields: 'daily-limit' });
  });

  it('distinct values still stop at the cap: with 2 slots left, 4 simultaneous opens of each of 3 new values render 2 of them, the third gets the default card', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    await openDistinct(path, LIMIT - 2);

    withoutEdgeCache();
    holdRendersUntilReserved(12);
    const names = ['Ana', 'Ben', 'Cy', 'Ana', 'Ben', 'Cy', 'Ana', 'Ben', 'Cy', 'Ana', 'Ben', 'Cy'];
    const burst = await Promise.all(names.map((name) => open(`${path}${name}`)));
    for (const response of burst) expect(response.status).toBe(200);
    const byName = new Map<string, Open[]>();
    names.forEach((name, n) => byName.set(name, [...(byName.get(name) ?? []), burst[n]!]));

    // Each value is one image: all of its requests got it, or all got the default card.
    const rendered = [...byName].filter(([, opens]) => opens.every((response) => response.openFields === null));
    const capped = [...byName].filter(([, opens]) => opens.every((response) => response.openFields === 'daily-limit'));
    expect(rendered.length).toBe(2);
    expect(capped.length).toBe(1);
    for (const [name, opens] of rendered) {
      expect(new Set(opens.map((response) => response.key)).size, name).toBe(1);
      for (const response of opens) expect(response.cacheControl, name).toMatch(/^public, max-age=\d+$/);
    }
    const [cappedName, defaults] = capped[0]!;
    for (const response of defaults) expect(response.cacheControl, cappedName).toBe('no-store, max-age=0');
    const fallbackKey = defaults[0]!.key;
    expect(new Set(defaults.map((response) => response.key))).toEqual(new Set([fallbackKey]));
    expect(rendered.map(([, opens]) => opens[0]!.key)).not.toContain(fallbackKey);

    // Two slots for the two images; the default card takes none and is charged once, as documented.
    expect((await slotsOf(site.id)).length).toBe(LIMIT);
    expect(await slotsOf(site.id)).not.toContain(fallbackKey);
    expect(sum(burst)).toBe(3);
    expect((await usageOf(user.id)).used).toBe(LIMIT - 2 + 3);

    // Another new value: the default card again, served from storage at no charge, no slot.
    expect(await open(`${path}Dee`)).toMatchObject({ status: 200, key: fallbackKey, credits: '0', openFields: 'daily-limit', cacheControl: 'no-store, max-age=0' });
    expect((await slotsOf(site.id)).length).toBe(LIMIT);
    expect((await usageOf(user.id)).used).toBe(LIMIT + 1);
  });

  it('a value that took its slot earlier the same day renders again at the cap without a new slot', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const earlier = await openDistinct(path, LIMIT);
    // The day is full: a new value gets the default card.
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, openFields: 'daily-limit' });

    // The stored copy of an earlier value is gone (as after a failed R2 write).
    const reader0 = earlier[0]!;
    await env.BUCKET.delete(`r/${user.id}/${reader0.key}.png`);
    withoutEdgeCache();
    const again = await open(`${path}Reader0`);
    // Its own image, not the default card; the ledger already covers it, so it is not charged again.
    expect(again).toMatchObject({ status: 200, key: reader0.key, credits: '0', openFields: null });
    expect(await env.BUCKET.head(`r/${user.id}/${reader0.key}.png`)).not.toBeNull();
    // The earlier values and the default card (rendered and charged once past the cap) were charged; Reader0 again was not.
    expect((await usageOf(user.id)).used).toBe(LIMIT + 1);
    // Still one slot per earlier value, none for the default card, and still no room for a new value.
    expect((await slotsOf(site.id)).sort()).toEqual(earlier.map((response) => response.key).sort());
    expect(await open(`${path}Eve`)).toMatchObject({ status: 200, openFields: 'daily-limit' });
  });

  it('slots of the previous UTC day do not count: a full day is followed by a day with every slot free', async () => {
    const day = Date.UTC(2027, 3, 1, 20, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const earlier = await openDistinct(path, LIMIT);
    expect(await open(`${path}Late`)).toMatchObject({ status: 200, openFields: 'daily-limit' });

    // The next UTC day, 4 hours later: new values render, and take that day's slots.
    const next = day + 4 * 3_600_000;
    vi.setSystemTime(next);
    expect((await slotsOf(site.id, next)).length).toBe(0);
    const maya = await open(`${path}Maya`);
    expect(maya).toMatchObject({ status: 200, credits: '1', openFields: null });
    expect(await slotsOf(site.id, next)).toEqual([maya.key]);
    // An image that held a slot yesterday and is not stored any more takes one of today's.
    await env.BUCKET.delete(`r/${user.id}/${earlier[0]!.key}.png`);
    withoutEdgeCache();
    expect(await open(`${path}Reader0`)).toMatchObject({ status: 200, key: earlier[0]!.key, credits: '0', openFields: null });
    expect((await slotsOf(site.id, next)).sort()).toEqual([maya.key, earlier[0]!.key].sort());
    expect((await slotsOf(site.id, day)).length).toBe(LIMIT);
  });

  it('slots expire at the end of the next UTC day and the daily cleanup removes them', async () => {
    const day = Date.UTC(2027, 4, 3, 10, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day);
    const { cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    withoutEdgeCache();
    holdRendersUntilReserved(3);
    const burst = await Promise.all([open(`${path}Maya`), open(`${path}Maya`), open(`${path}Eve`)]);
    expect(burst.map((response) => response.openFields)).toEqual([null, null, null]);
    const keys = [...new Set(burst.map((response) => response.key))].sort();
    expect(keys.length).toBe(2);
    expect((await slotsOf(site.id)).sort()).toEqual(keys);
    const endOfNextDay = (Math.floor(day / DAY_MS) + 2) * DAY_MS;
    for (const key of keys) expect((await slotRowOf(site.id, key))?.expires_at).toBe(endOfNextDay);

    await runCleanup(env, endOfNextDay - 1);
    expect((await slotsOf(site.id, day)).sort()).toEqual(keys);
    await runCleanup(env, endOfNextDay);
    expect(await slotsOf(site.id, day)).toEqual([]);
  });
});
