// Email images are charged once (owner decision of 2026-11-27): the first render of a unique
// signed email image (a /v1/og URL with open fields) is charged 1 image and stored; every later
// request is served from the edge cache or R2 at no charge; once the stored copy has expired it is
// rendered and stored again without a new charge while the charge is remembered
// (EMAIL_FIELDS.chargeMemoryDays). Re-renders still take one of the site's unique renders of the
// day. Real app, real D1 and R2, the real renderer; Date is faked to let stored copies expire.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS, EMAIL_FIELDS } from '../src/config';
import { all, first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import { emailChargeBucket, hasEmailCharge, openRenderBucket } from '../src/lib/open-fields';
import * as renderModule from '../src/render';
import type { Env } from '../src/types';
import { bytesOf, call, createSite, createUser, dashboard, isPng, renderCount, sessionCookieFor, setUsed, signedPath, usageOf } from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Limits on: the daily cap is a limit, and tests switch limits off by default. */
const limited: Env = { ...env, RATE_LIMITS_DISABLED: '' };
/** The first day of a month, so that the Free plan's 7 cache days end inside the same usage period. */
const T0 = Date.UTC(2027, 2, 1, 9, 0);
const FREE_TTL = PLANS.free.cacheDays * DAY_MS;
const MEMORY_MS = EMAIL_FIELDS.chargeMemoryDays * DAY_MS;

function at(time: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
}

async function account(plan: 'free' | 'starter' | 'pro' = 'free') {
  const user = await createUser(plan, Date.now());
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
  cache: string | null;
  credits: string | null;
  key: string;
}

/** One open of an email image, body read. */
async function open(path: string, bindings: Env = env, init: RequestInit = {}): Promise<Open> {
  const response = await call(path, init, bindings);
  const body = await bytesOf(response);
  if (response.status === 200 && init.method !== 'HEAD') expect(isPng(body)).toBe(true);
  return {
    status: response.status,
    cache: response.headers.get('x-ltc-cache'),
    credits: response.headers.get('x-ltc-credits-used'),
    key: (response.headers.get('etag') ?? '').replaceAll('"', ''),
  };
}

const ledgerOf = (userId: string, cacheKey: string) =>
  first<{ charged_to: string; created_at: number; expires_at: number }>(env.DB, 'SELECT charged_to, created_at, expires_at FROM renders WHERE cache_key = ?1 AND user_id = ?2', cacheKey, userId);
const memoryOf = (userId: string, cacheKey: string) =>
  first<{ count: number; expires_at: number }>(env.DB, 'SELECT count, expires_at FROM tool_usage WHERE bucket = ?1', emailChargeBucket(userId, cacheKey));
const memoriesOf = async (userId: string): Promise<number> =>
  (await all<{ bucket: string }>(env.DB, "SELECT bucket FROM tool_usage WHERE bucket > ?1 AND bucket < ?2", `emailpaid:${userId}:`, `emailpaid:${userId};`)).length;
const usedToday = async (siteId: string): Promise<number> =>
  (await first<{ count: number }>(env.DB, 'SELECT count FROM tool_usage WHERE bucket = ?1', openRenderBucket(siteId, Date.now())))?.count ?? 0;
/** Every request misses the edge cache, so it is answered from R2 or rendered. */
const withoutEdgeCache = () => vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

describe('email images are charged once', () => {
  it('the first open renders, stores and charges 1 image, and the charge is remembered for chargeMemoryDays', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);

    const maya = await open(`${path}Maya`);
    expect(maya).toMatchObject({ status: 200, cache: 'miss', credits: '1' });
    expect((await usageOf(user.id)).used).toBe(1);
    const ledger = await ledgerOf(user.id, maya.key);
    expect(ledger).toEqual({ charged_to: 'plan', created_at: T0, expires_at: T0 + FREE_TTL });
    expect(await memoryOf(user.id, maya.key)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS });
    expect(await env.BUCKET.head(`r/${user.id}/${maya.key}.png`)).not.toBeNull();

    // The same URL again: the copy at the edge, no charge.
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'hit', credits: '0', key: maya.key });
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('50 repeat opens served from R2 (the edge cache missing) charge nothing and render nothing', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const maya = await open(`${path}Maya`, limited);
    expect(maya).toMatchObject({ status: 200, credits: '1' });
    expect(await usedToday(site.id)).toBe(1);

    const edge = withoutEdgeCache();
    const renders = vi.spyOn(renderModule, 'renderCard');
    const puts = vi.spyOn(env.BUCKET, 'put');
    for (let n = 0; n < 50; n++) {
      // Every spelling of the same value is the same image.
      const value = n % 2 === 0 ? 'Maya' : `${'+'.repeat(n % 5)}Maya+`;
      expect(await open(`${path}${value}`, limited), `open ${n}`).toEqual({ status: 200, cache: 'hit', credits: '0', key: maya.key });
    }
    expect(edge).toHaveBeenCalledTimes(50);
    expect(renders).not.toHaveBeenCalled();
    expect(puts).not.toHaveBeenCalled();
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);
    // Served from storage, so not one of the day's unique renders either.
    expect(await usedToday(site.id)).toBe(1);
  });

  it('simultaneous first opens of one image charge exactly once', async () => {
    const { user, cookie, site } = await account('starter');
    const path = await openUrl(cookie, site.id);
    const opens = await Promise.all(Array.from({ length: 6 }, () => open(`${path}Zoe`, limited)));
    for (const response of opens) expect(response.status).toBe(200);
    expect(new Set(opens.map((response) => response.key)).size).toBe(1);
    expect(opens.map((response) => Number(response.credits)).reduce((sum, credits) => sum + credits, 0)).toBe(1);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);
    expect(await ledgerOf(user.id, opens[0]!.key)).toMatchObject({ charged_to: 'plan' });
    expect(await memoryOf(user.id, opens[0]!.key)).not.toBeNull();
    // The requests that were not charged gave their unique render of the day back.
    expect(await usedToday(site.id)).toBe(1);
  });

  it('an expired copy is rendered and stored again without a new charge, also with no images left', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const maya = await open(`${path}Maya`);
    expect(maya.credits).toBe('1');
    const memory = await memoryOf(user.id, maya.key);
    withoutEdgeCache();
    const renders = vi.spyOn(renderModule, 'renderCard');

    // The Free plan's cache days are over: the stored copy and its ledger row have expired.
    const later = T0 + FREE_TTL + DAY_MS;
    vi.setSystemTime(later);
    expect(await open(`${path}Maya`)).toEqual({ status: 200, cache: 'miss', credits: '0', key: maya.key });
    expect(renders).toHaveBeenCalledTimes(1);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, maya.key)).toEqual({ charged_to: 'none', created_at: later, expires_at: later + FREE_TTL });
    expect(Number((await env.BUCKET.head(`r/${user.id}/${maya.key}.png`))?.customMetadata?.expiresAt)).toBe(later + FREE_TTL);
    // The record keeps the time of the one charge: a free render does not extend it.
    expect(await memoryOf(user.id, maya.key)).toEqual(memory);

    // Stored again: repeats are served from R2, nothing rendered, nothing charged.
    for (let n = 0; n < 5; n++) expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'hit', credits: '0' });
    expect(renders).toHaveBeenCalledTimes(1);

    // No images left: the image paid for renders again for free after its next expiry, a new one is refused.
    await setUsed(user, PLANS.free.monthlyImages);
    vi.setSystemTime(later + FREE_TTL + DAY_MS);
    expect((await open(`${path}Maya`, env, { method: 'HEAD' })).status).toBe(200);
    expect((await open(`${path}Eve`, env, { method: 'HEAD' })).status).toBe(402);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: maya.key });
    expect((await open(`${path}Eve`)).status).toBe(402);
    expect((await usageOf(user.id)).used).toBe(PLANS.free.monthlyImages);
    expect(await memoriesOf(user.id)).toBe(1);
  });

  it('once the charge is no longer remembered, the next render is charged again and remembered anew', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const maya = await open(`${path}Maya`);
    expect(maya.credits).toBe('1');
    withoutEdgeCache();

    // Still remembered on its last day.
    vi.setSystemTime(T0 + MEMORY_MS - DAY_MS);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '0' });
    expect(await hasEmailCharge(env.DB, user.id, maya.key, Date.now())).toBe(true);

    const afterMemory = T0 + MEMORY_MS + PLANS.free.cacheDays * DAY_MS;
    vi.setSystemTime(afterMemory);
    expect(await hasEmailCharge(env.DB, user.id, maya.key, afterMemory)).toBe(false);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '1', key: maya.key });
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, maya.key)).toMatchObject({ charged_to: 'plan', created_at: afterMemory });
    // The expired record (not yet removed by the cleanup) is replaced by the new charge's.
    expect(await memoryOf(user.id, maya.key)).toEqual({ count: 1, expires_at: afterMemory + MEMORY_MS });
  });

  it('distinct open values are distinct images, each charged once', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const keys = new Set<string>();
    for (const value of ['Maya', 'Eve', encodeURIComponent('Zoë & Jo')]) {
      const first = await open(`${path}${value}`);
      expect(first, value).toMatchObject({ status: 200, cache: 'miss', credits: '1' });
      keys.add(first.key);
      expect(await open(`${path}${value}`), value).toMatchObject({ status: 200, cache: 'hit', credits: '0' });
    }
    expect(keys.size).toBe(3);
    expect((await usageOf(user.id)).used).toBe(3);
    expect(await memoriesOf(user.id)).toBe(3);
  });

  it('re-renders after expiry still take one of the site\'s unique renders of the day', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const fallback = await open(path, limited);
    const maya = await open(`${path}Maya`, limited);
    expect([fallback.credits, maya.credits]).toEqual(['1', '1']);
    withoutEdgeCache();
    const limit = EMAIL_FIELDS.maxUniqueRendersPerDay.free;

    // Both copies expired; the site has used every unique render of the new day.
    vi.setSystemTime(T0 + FREE_TTL + DAY_MS);
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', openRenderBucket(site.id, Date.now()), limit, Date.now() + DAY_MS);
    const capped = await call(`${path}Maya`, {}, limited);
    expect(capped.status).toBe(200);
    await capped.arrayBuffer();
    // Not Maya's image: the default card (paid before, so also rendered again for free), not kept by mail proxies.
    expect(capped.headers.get('etag')).toBe(`"${fallback.key}"`);
    expect(capped.headers.get('x-ltc-open-fields')).toBe('daily-limit');
    expect(capped.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(capped.headers.get('x-ltc-credits-used')).toBe('0');
    expect(await ledgerOf(user.id, maya.key)).toMatchObject({ charged_to: 'plan', expires_at: T0 + FREE_TTL });

    // One render left today: Maya's free re-render takes it and keeps it.
    await run(env.DB, 'UPDATE tool_usage SET count = ?2 WHERE bucket = ?1', openRenderBucket(site.id, Date.now()), limit - 1);
    expect(await open(`${path}Maya`, limited)).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: maya.key });
    expect(await usedToday(site.id)).toBe(limit);
    expect(await ledgerOf(user.id, maya.key)).toMatchObject({ charged_to: 'none' });
    expect((await usageOf(user.id)).used).toBe(2);
  });

  it('cards without open fields are charged as before: no record, charged again after their copy expired', async () => {
    at(T0);
    const { user, site } = await account();
    const blog = await signedPath(site, 'blog', { title: 'Not an email image' });
    // An email starter signed without "open" is an ordinary card too.
    const banner = await signedPath(site, 'email-banner', { title: 'All signed', name: 'Maya', size: 'email' });
    for (const path of [blog, banner]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(response.headers.get('x-ltc-credits-used')).toBeNull();
    }
    expect((await usageOf(user.id)).used).toBe(2);
    expect(await memoriesOf(user.id)).toBe(0);

    withoutEdgeCache();
    vi.setSystemTime(T0 + FREE_TTL + DAY_MS);
    for (const path of [blog, banner]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-ltc-cache')).toBe('miss');
      await response.arrayBuffer();
    }
    expect((await usageOf(user.id)).used).toBe(4);
    expect(await memoriesOf(user.id)).toBe(0);
  });

  // Behaviour change (review ECQ-1): this test was "the record is written from a paid ledger row
  // only, and restored from one charged before it existed". A duplicate render used to write the
  // record from the image's ledger row, but an image row says 'plan' from its claim, before
  // anything is taken, so a twin of a claim that then failed was remembered as paid for 400 days.
  // The record is now written only in the D1 batch that takes the image, so a duplicate never
  // writes one. The cost is the restore for an image charged before charge-once: it is charged
  // once more after its row expires. Production has had EMAIL_FIELDS_ENABLED "false" since
  // bbecc80, so no email image there predates charge-once.
  it('a duplicate render never writes the record: an image charged before charge-once is charged once more after its row expires', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const maya = await open(`${path}Maya`);
    expect(maya.credits).toBe('1');

    // A charge from before charge-once (a paid row, no record) whose object is gone: the duplicate
    // render serves and stores it at no charge, and writes no record.
    await run(env.DB, 'DELETE FROM tool_usage WHERE bucket = ?1', emailChargeBucket(user.id, maya.key));
    await env.BUCKET.delete(`r/${user.id}/${maya.key}.png`);
    withoutEdgeCache();
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: maya.key });
    expect(await memoryOf(user.id, maya.key)).toBeNull();
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await ledgerOf(user.id, maya.key)).toMatchObject({ charged_to: 'plan', created_at: T0 });

    // After the row expired it is charged once more, and that charge is remembered.
    const later = T0 + FREE_TTL + DAY_MS;
    vi.setSystemTime(later);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '1', key: maya.key });
    expect((await usageOf(user.id)).used).toBe(2);
    expect(await memoryOf(user.id, maya.key)).toEqual({ count: 1, expires_at: later + MEMORY_MS });
    vi.setSystemTime(later + FREE_TTL + DAY_MS);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: maya.key });
    expect((await usageOf(user.id)).used).toBe(2);
  });

  it('records go with the account, and expired ones with the daily cleanup', async () => {
    const now = Date.UTC(2027, 5, 1, 3);
    const leaving = await createUser('free', now);
    const staying = await createUser('free', now);
    // An id that starts with the leaving account's id must not be caught by its range.
    const lookalike = `${leaving.id}0`;
    const rows: [string, number][] = [
      [emailChargeBucket(leaving.id, 'c'.repeat(64)), now + DAY_MS],
      [emailChargeBucket(leaving.id, 'd'.repeat(64)), now + 300 * DAY_MS],
      [emailChargeBucket(staying.id, 'c'.repeat(64)), now + DAY_MS],
      [emailChargeBucket(staying.id, 'e'.repeat(64)), now - 1],
      [emailChargeBucket(lookalike, 'c'.repeat(64)), now + DAY_MS],
    ];
    for (const [bucket, expiresAt] of rows) await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 1, ?2)', bucket, expiresAt);
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?2, suspended_at = ?2 WHERE id = ?1', leaving.id, now);

    const report = await runCleanup(env, now);
    expect(report.deletedAccounts).toBeGreaterThanOrEqual(1);
    const left = (await all<{ bucket: string }>(env.DB, 'SELECT bucket FROM tool_usage WHERE bucket IN (?1, ?2, ?3, ?4, ?5) ORDER BY bucket', ...rows.map(([bucket]) => bucket))).map((row) => row.bucket);
    expect(left).toEqual([emailChargeBucket(lookalike, 'c'.repeat(64)), emailChargeBucket(staying.id, 'c'.repeat(64))].sort());
    expect(await first(env.DB, 'SELECT id FROM users WHERE id = ?1', leaving.id)).toBeNull();
  });
});

/*
 * The record and the charge commit together (review ECQ-1, ECQ-2). An image's ledger row says
 * 'plan' from its claim, before anything is taken from the allowance, and is deleted again when
 * nothing was left. The record that an email image was paid for is therefore written only inside
 * the D1 batch that takes the image, guarded by the take's own condition: it exists if and only if
 * the image was taken.
 */

/** A D1 binding that runs `hook` once, before the first batch that takes an image from the allowance. */
function dbPausedBeforeTake(real: D1Database, hook: () => Promise<void>): D1Database {
  let takePrepared = false;
  let fired = false;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('SET used = used + 1')) takePrepared = true;
          return target.prepare(sql);
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (takePrepared && !fired) {
            fired = true;
            await hook();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A D1 binding on which the statement that writes an email image's charge record fails with a D1
 * error when it runs (it is pointed at a table that does not exist). Matched by its bound bucket,
 * so it is the same statement whatever its SQL or where it runs. Reads of the record still work.
 */
function dbFailingChargeRecord(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          const writesRecord = /^\s*INSERT INTO tool_usage/.test(sql);
          return new Proxy(statement, {
            get(inner, key) {
              if (key === 'bind') {
                return (...args: unknown[]) =>
                  writesRecord && args.some((arg) => typeof arg === 'string' && arg.startsWith('emailpaid:'))
                    ? target.prepare(sql.replace('INSERT INTO tool_usage', 'INSERT INTO tool_usage_unavailable')).bind(...args)
                    : inner.bind(...args);
              }
              const value = Reflect.get(inner, key);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A D1 binding on which every batch that takes an image from the allowance fails (a D1 error after the claim). */
function dbFailingTake(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => (sql.includes('SET used = used + 1') ? target.prepare(sql.replace('UPDATE usage_periods', 'UPDATE usage_periods_unavailable')) : target.prepare(sql));
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const paidRowsOf = (userId: string) =>
  all<{ cache_key: string; charged_to: string }>(env.DB, "SELECT cache_key, charged_to FROM renders WHERE user_id = ?1 AND charged_to IN ('plan', 'topup')", userId);
const recordKeysOf = async (userId: string): Promise<string[]> =>
  (await all<{ bucket: string }>(env.DB, 'SELECT bucket FROM tool_usage WHERE bucket > ?1 AND bucket < ?2', `emailpaid:${userId}:`, `emailpaid:${userId};`)).map((row) =>
    row.bucket.slice(`emailpaid:${userId}:`.length),
  );

describe('the charge record exists only for an image that was taken', () => {
  it('a burst of first opens at the last image leaves a record only for the image that was charged', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const allowance = PLANS.free.monthlyImages;
    await setUsed(user, allowance - 1);
    withoutEdgeCache();

    // Two simultaneous opens of each of three images (Apple MPP prefetch, a proxy's double fetch), one image left.
    const names = ['Maya', 'Maya', 'Eve', 'Eve', 'Zoe', 'Zoe'];
    const burst = await Promise.all(names.map((name) => open(`${path}${name}`)));
    expect(burst.map((response) => Number(response.credits ?? 0)).reduce((sum, credits) => sum + credits, 0)).toBe(1);
    expect((await usageOf(user.id)).used).toBe(allowance);
    const charged = burst.find((response) => response.credits === '1')!;
    const chargedName = names[burst.indexOf(charged)]!;

    // One paid row, one record, both for the image that was taken.
    expect(await paidRowsOf(user.id)).toEqual([{ cache_key: charged.key, charged_to: 'plan' }]);
    expect(await recordKeysOf(user.id)).toEqual([charged.key]);

    // The stored copies expire; with no images left only the image that was paid for renders again.
    vi.setSystemTime(T0 + FREE_TTL + DAY_MS);
    for (const name of ['Maya', 'Eve', 'Zoe']) {
      const again = await open(`${path}${name}`);
      if (name === chargedName) expect(again, name).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: charged.key });
      else expect(again.status, name).toBe(402);
    }
    expect((await usageOf(user.id)).used).toBe(allowance);
    expect(await recordKeysOf(user.id)).toEqual([charged.key]);
  });

  it('a twin open while the first open waits before its charge writes no record, and none is left when that charge fails', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const allowance = PLANS.free.monthlyImages;
    await setUsed(user, allowance - 1);
    withoutEdgeCache();

    let atTake!: () => void;
    const reachedTake = new Promise<void>((resolve) => (atTake = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const paused: Env = {
      ...env,
      DB: dbPausedBeforeTake(env.DB, async () => {
        atTake();
        await gate;
        // Meanwhile another image of the send took the last image of the month.
        await setUsed(user, allowance);
      }),
    };

    // A: the first open of Maya renders, claims the ledger row (charged_to 'plan', nothing taken yet) and waits.
    const first = open(`${path}Maya`, paused);
    await reachedTake;
    expect(await emailRowOf(user.id)).toEqual({ charged_to: 'plan' });
    expect((await usageOf(user.id)).used).toBe(allowance - 1);

    // B: a twin open. The ledger row covers it, so it is served at no charge, and it remembers nothing.
    const twin = await open(`${path}Maya`);
    expect(twin).toMatchObject({ status: 200, cache: 'miss', credits: '0' });
    expect(await memoryOf(user.id, twin.key)).toBeNull();

    // A takes nothing (nothing is left), releases the row and answers 402: still no record.
    release();
    expect((await first).status).toBe(402);
    expect(await ledgerOf(user.id, twin.key)).toBeNull();
    expect(await memoryOf(user.id, twin.key)).toBeNull();

    // After the copy expired, with no images left, Maya is refused like any image never paid for.
    vi.setSystemTime(T0 + FREE_TTL + DAY_MS);
    expect((await open(`${path}Maya`)).status).toBe(402);
    expect((await open(`${path}Eve`)).status).toBe(402);
    expect((await usageOf(user.id)).used).toBe(allowance);
    expect(await memoriesOf(user.id)).toBe(0);
  });

  it('a twin open while the first open waits before a charge that succeeds: one record, written by the charge', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    withoutEdgeCache();
    let atTake!: () => void;
    const reachedTake = new Promise<void>((resolve) => (atTake = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const paused: Env = { ...env, DB: dbPausedBeforeTake(env.DB, async () => { atTake(); await gate; }) };

    const first = open(`${path}Maya`, paused);
    await reachedTake;
    const twin = await open(`${path}Maya`);
    expect(twin).toMatchObject({ status: 200, credits: '0' });
    expect(await memoryOf(user.id, twin.key)).toBeNull();
    release();
    expect(await first).toMatchObject({ status: 200, credits: '1', key: twin.key });
    expect(await memoryOf(user.id, twin.key)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS });
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('a D1 error after the claim leaves the unpaid row but no record: the image is charged once, after that row expires', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    withoutEdgeCache();

    // The batch that takes the image fails right after the ledger row was claimed.
    const failed = await open(`${path}Maya`, { ...env, DB: dbFailingTake(env.DB) });
    expect(failed.status).toBe(500);
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await emailRowOf(user.id)).toEqual({ charged_to: 'plan' });

    // The row is kept on purpose (src/lib/quota.ts): the next open is a duplicate, free, and remembers nothing.
    const next = await open(`${path}Maya`);
    expect(next).toMatchObject({ status: 200, credits: '0' });
    expect(await memoryOf(user.id, next.key)).toBeNull();

    // With no images left after the row expired, it is refused: it was never paid for.
    await setUsed(user, PLANS.free.monthlyImages);
    vi.setSystemTime(T0 + FREE_TTL + DAY_MS);
    expect((await open(`${path}Maya`)).status).toBe(402);
    // With images again, it is charged once and remembered from that charge.
    await setUsed(user, 0);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '1', key: next.key });
    expect(await memoryOf(user.id, next.key)).toEqual({ count: 1, expires_at: T0 + FREE_TTL + DAY_MS + MEMORY_MS });
  });

  it('when the record cannot be written the charge rolls back with it: the image is charged exactly once in total', async () => {
    at(T0);
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    withoutEdgeCache();

    // The first open: the record statement fails inside the batch that takes the image, so nothing is taken.
    const failed = await open(`${path}Maya`, { ...env, DB: dbFailingChargeRecord(env.DB) });
    expect(failed.status).toBe(500);
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await memoriesOf(user.id)).toBe(0);

    // The next open is a duplicate of the unpaid row: served and stored, not charged.
    const next = await open(`${path}Maya`);
    expect(next).toMatchObject({ status: 200, credits: '0' });
    for (let n = 0; n < 3; n++) expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'hit', credits: '0' });
    expect((await usageOf(user.id)).used).toBe(0);

    // After the copy expired: charged once, with its record.
    const later = T0 + FREE_TTL + DAY_MS;
    vi.setSystemTime(later);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '1', key: next.key });
    expect(await memoryOf(user.id, next.key)).toEqual({ count: 1, expires_at: later + MEMORY_MS });
    // And never again while it is remembered.
    vi.setSystemTime(later + FREE_TTL + DAY_MS);
    expect(await open(`${path}Maya`)).toMatchObject({ status: 200, cache: 'miss', credits: '0', key: next.key });
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('an image taken from a top-up is remembered by the top-up batch; one refused for want of images is not', async () => {
    at(T0);
    const { user, cookie, site } = await account('starter');
    const path = await openUrl(cookie, site.id);
    await setUsed(user, PLANS.starter.monthlyImages);
    await run(
      env.DB,
      'INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at) VALUES (?1, ?2, ?3, 1, 1, ?4, ?5)',
      `tu_${user.id}`,
      user.id,
      `txn_${user.id}`,
      T0,
      T0 + 365 * DAY_MS,
    );

    const maya = await open(`${path}Maya`);
    expect(maya).toMatchObject({ status: 200, credits: '1' });
    expect(await ledgerOf(user.id, maya.key)).toMatchObject({ charged_to: 'topup' });
    expect(await memoryOf(user.id, maya.key)).toEqual({ count: 1, expires_at: T0 + MEMORY_MS });
    expect((await usageOf(user.id)).topup_remaining).toBe(0);

    // The top-up is used up: a new image is refused, and nothing is remembered for it.
    const eve = await open(`${path}Eve`);
    expect(eve.status).toBe(402);
    expect(await memoriesOf(user.id)).toBe(1);
  });
});

/** The one email-banner ledger row of an account, as charged_to. */
function emailRowOf(userId: string): Promise<{ charged_to: string } | null> {
  return first<{ charged_to: string }>(env.DB, "SELECT charged_to FROM renders WHERE user_id = ?1 AND template = 'email-banner'", userId);
}
