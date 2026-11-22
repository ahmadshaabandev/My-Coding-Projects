import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PLANS, TOPUP } from '../src/billing/plans';
import { DAY_MS } from '../src/config';
import { all, first, getUserById, run } from '../src/db/client';
import {
  chargeRender,
  creditTopup,
  currentPeriod,
  getUsage,
  hasQuota,
  listRecentRenders,
  markTopupRefunded,
  type ChargeResult,
  type Period,
  type RenderCharge,
} from '../src/lib/quota';
import type { RenderRow, TopupRow, UsagePeriodRow, UserRow } from '../src/types';

const db = env.DB;

/** 22 Nov 2026 12:00 UTC. D1 never sees a clock: every timestamp is bound from here. */
const NOW = Date.UTC(2026, 10, 22, 12);
const NOV: Period = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) };
const DEC: Period = { start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) };
/** A Paddle billing period that straddles two calendar months. */
const PADDLE: Period = { start: Date.UTC(2026, 10, 10, 9, 30), end: Date.UTC(2026, 11, 10, 9, 30) };

const FREE = PLANS.free.monthlyImages;
const STARTER = PLANS.starter.monthlyImages;
const PRO = PLANS.pro.monthlyImages;
const TOPUP_TTL = TOPUP.validDays * DAY_MS;

type Charged = Extract<ChargeResult, { status: 'charged' }>;

let userSeq = 0;
let keySeq = 0;
let txnSeq = 0;

async function makeUser(overrides: Partial<Pick<UserRow, 'plan' | 'period_start' | 'period_end'>> = {}): Promise<UserRow> {
  const id = `u_quota${++userSeq}`;
  await run(
    db,
    'INSERT INTO users (id, email, created_at, plan, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    `${id}@example.test`,
    NOW,
    overrides.plan ?? 'free',
    overrides.period_start ?? null,
    overrides.period_end ?? null,
  );
  const user = await getUserById(db, id);
  if (!user) throw new Error('test user was not created');
  return user;
}

function render(overrides: Partial<RenderCharge> = {}): RenderCharge {
  const cacheKey = overrides.cacheKey ?? `ck_${++keySeq}`;
  return {
    cacheKey,
    siteId: 's_quota',
    source: 'og',
    template: 'blog',
    width: 1200,
    height: 630,
    format: 'png',
    bytes: 12_345,
    r2Key: `renders/${cacheKey}.png`,
    ttlMs: 7 * DAY_MS,
    ...overrides,
  };
}

const nextTxn = (): string => `txn_quota${++txnSeq}`;

async function setUsed(user: UserRow, period: Period, used: number): Promise<void> {
  await run(
    db,
    `INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, period_start) DO UPDATE SET used = excluded.used`,
    user.id,
    period.start,
    period.end,
    used,
  );
}

const periodRow = (user: UserRow, period: Period): Promise<UsagePeriodRow | null> =>
  first<UsagePeriodRow>(db, 'SELECT * FROM usage_periods WHERE user_id = ? AND period_start = ?', user.id, period.start);

const periodRows = (user: UserRow): Promise<UsagePeriodRow[]> =>
  all<UsagePeriodRow>(db, 'SELECT * FROM usage_periods WHERE user_id = ? ORDER BY period_start', user.id);

const ledger = (user: UserRow): Promise<RenderRow[]> =>
  all<RenderRow>(db, 'SELECT * FROM renders WHERE user_id = ? ORDER BY created_at, cache_key', user.id);

const topup = async (transactionId: string): Promise<TopupRow> => {
  const row = await first<TopupRow>(db, 'SELECT * FROM topups WHERE paddle_transaction_id = ?', transactionId);
  if (!row) throw new Error(`no top-up for ${transactionId}`);
  return row;
};

/** Credits a top-up and optionally lowers what is left of it. */
async function giveTopup(user: UserRow, options: { creditedAt?: number; remaining?: number; images?: number } = {}): Promise<string> {
  const transactionId = nextTxn();
  const credited = await creditTopup(db, {
    userId: user.id,
    transactionId,
    images: options.images ?? TOPUP.images,
    now: options.creditedAt ?? NOW,
  });
  expect(credited).toBe(true);
  if (options.remaining !== undefined) {
    await run(db, 'UPDATE topups SET remaining = ? WHERE paddle_transaction_id = ?', options.remaining, transactionId);
  }
  return transactionId;
}

function expectCharged(result: ChargeResult): Charged {
  if (result.status !== 'charged') throw new Error(`expected a charge, got ${result.status}`);
  return result;
}

function tally(results: ChargeResult[]): Record<'plan' | 'topup' | 'duplicate' | 'quota_exceeded', number> {
  const counts = { plan: 0, topup: 0, duplicate: 0, quota_exceeded: 0 };
  for (const result of results) counts[result.status === 'charged' ? result.chargedTo : result.status]++;
  return counts;
}

/** N different images requested at the same instant. */
const concurrentCharges = (user: UserRow, count: number, now = NOW): Promise<ChargeResult[]> =>
  Promise.all(Array.from({ length: count }, () => chargeRender(db, user, render(), now)));

/** A D1 handle whose batch() fails, standing in for a crash right after the ledger claim. */
function failingBatch(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, property) {
      if (property === 'batch') return () => Promise.reject(new Error('simulated D1 failure'));
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('currentPeriod', () => {
  const free = { plan: 'free', period_start: null, period_end: null } as const;

  it('uses the UTC calendar month containing now for a Free account', () => {
    expect(currentPeriod(free, NOW)).toEqual(NOV);
    expect(currentPeriod(free, NOV.start)).toEqual(NOV);
    expect(currentPeriod(free, NOV.end - 1)).toEqual(NOV);
    expect(currentPeriod(free, NOV.end)).toEqual(DEC);
  });

  it('rolls over the year end and handles a leap-year February', () => {
    expect(currentPeriod(free, Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toEqual(DEC);
    expect(currentPeriod(free, Date.UTC(2027, 0, 1))).toEqual({ start: Date.UTC(2027, 0, 1), end: Date.UTC(2027, 1, 1) });
    const february = currentPeriod(free, Date.UTC(2028, 1, 29, 12));
    expect(february).toEqual({ start: Date.UTC(2028, 1, 1), end: Date.UTC(2028, 2, 1) });
    expect((february.end - february.start) / DAY_MS).toBe(29);
  });

  it('ignores Paddle period columns left behind on a Free account', () => {
    expect(currentPeriod({ plan: 'free', period_start: PADDLE.start, period_end: PADDLE.end }, NOW)).toEqual(NOV);
  });

  it('uses the Paddle billing period for a paid account inside it (start inclusive, end exclusive)', () => {
    const paid = { plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end } as const;
    expect(currentPeriod(paid, NOW)).toEqual(PADDLE);
    expect(currentPeriod(paid, PADDLE.start)).toEqual(PADDLE);
    expect(currentPeriod(paid, PADDLE.end - 1)).toEqual(PADDLE);
  });

  it('falls back to the calendar month when a paid period is stale, not started or missing', () => {
    const paid = { plan: 'pro', period_start: PADDLE.start, period_end: PADDLE.end } as const;
    expect(currentPeriod(paid, PADDLE.end)).toEqual(DEC);
    expect(currentPeriod(paid, PADDLE.start - 1)).toEqual(NOV);
    expect(currentPeriod({ plan: 'pro', period_start: null, period_end: null }, NOW)).toEqual(NOV);
    expect(currentPeriod({ plan: 'pro', period_start: PADDLE.start, period_end: null }, NOW)).toEqual(NOV);
  });
});

describe('getUsage and hasQuota', () => {
  it('reports a fresh Free account without creating any rows', async () => {
    const user = await makeUser();
    expect(await getUsage(db, user, NOW)).toEqual({
      plan: 'free',
      period_start: NOV.start,
      period_end: NOV.end,
      limit: FREE,
      used: 0,
      remaining: FREE,
      topup_remaining: 0,
      total_remaining: FREE,
      cache_days: PLANS.free.cacheDays,
      watermark: true,
    });
    expect(await hasQuota(db, user, NOW)).toBe(true);
    expect(await periodRows(user)).toEqual([]);
  });

  it('adds up: remaining, usable top-ups only, total, cache days and watermark', async () => {
    const user = await makeUser({ plan: 'pro', period_start: PADDLE.start, period_end: PADDLE.end });
    await setUsed(user, PADDLE, 1234);
    await giveTopup(user);
    await giveTopup(user, { remaining: 250 });
    await giveTopup(user, { remaining: 0 });
    await giveTopup(user, { creditedAt: NOW - TOPUP_TTL });
    await markTopupRefunded(db, await giveTopup(user), NOW);

    const usage = await getUsage(db, user, NOW);
    expect(usage).toEqual({
      plan: 'pro',
      period_start: PADDLE.start,
      period_end: PADDLE.end,
      limit: PRO,
      used: 1234,
      remaining: PRO - 1234,
      topup_remaining: 1250,
      total_remaining: PRO - 1234 + 1250,
      cache_days: PLANS.pro.cacheDays,
      watermark: false,
    });
    expect(usage.remaining + usage.topup_remaining).toBe(usage.total_remaining);
  });

  it('never reports a negative remaining when usage is above the limit (downgrade mid-month)', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, 500);
    const usage = await getUsage(db, user, NOW);
    expect(usage).toMatchObject({ limit: FREE, used: 500, remaining: 0, total_remaining: 0 });
    expect(await hasQuota(db, user, NOW)).toBe(false);
  });

  it('hasQuota follows total_remaining: allowance, then top-ups until they expire', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    expect(await hasQuota(db, user, NOW)).toBe(false);

    await giveTopup(user, { remaining: 1 });
    expect(await hasQuota(db, user, NOW)).toBe(true);
    expect(await hasQuota(db, user, NOW + TOPUP_TTL - 1)).toBe(true);
    // At the expiry instant the top-up is gone, but so is November: a new month has its own allowance.
    expect(await getUsage(db, user, NOW + TOPUP_TTL)).toMatchObject({ used: 0, topup_remaining: 0, total_remaining: FREE });
  });
});

describe('chargeRender - the Free hard stop', () => {
  it('charges exactly 100 images; the 101st is refused with used = 100', async () => {
    const user = await makeUser();
    const results: ChargeResult[] = [];
    for (let i = 0; i < FREE + 1; i++) results.push(await chargeRender(db, user, render(), NOW + i));

    const charged = results.slice(0, FREE).map(expectCharged);
    expect(charged.every((result) => result.chargedTo === 'plan')).toBe(true);
    expect(charged.map((result) => result.usage.used)).toEqual(Array.from({ length: FREE }, (_, i) => i + 1));
    expect(charged.map((result) => result.usage.remaining)).toEqual(Array.from({ length: FREE }, (_, i) => FREE - i - 1));

    expect(results[FREE]).toEqual({
      status: 'quota_exceeded',
      usage: {
        plan: 'free',
        period_start: NOV.start,
        period_end: NOV.end,
        limit: FREE,
        used: FREE,
        remaining: 0,
        topup_remaining: 0,
        total_remaining: 0,
        cache_days: PLANS.free.cacheDays,
        watermark: true,
      },
    });

    // The thresholds fire on the 90th and the 100th image and at no other time.
    expect(charged.flatMap((result, i) => (result.crossed90 ? [i + 1] : []))).toEqual([90]);
    expect(charged.flatMap((result, i) => (result.crossed100 ? [i + 1] : []))).toEqual([100]);

    expect(await periodRow(user, NOV)).toEqual({
      user_id: user.id,
      period_start: NOV.start,
      period_end: NOV.end,
      used: FREE,
      topup_used: 0,
      notified_90: 1,
      notified_100: 1,
    });
    // The refused image left no ledger row behind.
    expect(await ledger(user)).toHaveLength(FREE);
    expect(await hasQuota(db, user, NOW)).toBe(false);
  });

  it('keeps refusing without moving the counter', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    for (let i = 0; i < 5; i++) {
      expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ status: 'quota_exceeded', usage: { used: FREE } });
    }
    expect((await periodRow(user, NOV))?.used).toBe(FREE);
    expect(await ledger(user)).toEqual([]);
  });

  it('writes the ledger row for a charged image', async () => {
    const user = await makeUser();
    const image = render({ siteId: null, source: 'api', template: 'inline', width: 1080, height: 1350, format: 'webp', bytes: 777, ttlMs: 3 * DAY_MS });
    expectCharged(await chargeRender(db, user, image, NOW));
    expect(await ledger(user)).toEqual([
      {
        cache_key: image.cacheKey,
        user_id: user.id,
        site_id: null,
        source: 'api',
        template: 'inline',
        width: 1080,
        height: 1350,
        format: 'webp',
        bytes: 777,
        r2_key: image.r2Key,
        charged_to: 'plan',
        period_start: NOV.start,
        created_at: NOW,
        expires_at: NOW + 3 * DAY_MS,
      },
    ]);
  });
});

describe('chargeRender - duplicates and expiry', () => {
  it('does not charge the same cached image twice', async () => {
    const user = await makeUser();
    const image = render();
    expect(expectCharged(await chargeRender(db, user, image, NOW)).usage.used).toBe(1);
    const before = await ledger(user);

    expect(await chargeRender(db, user, image, NOW)).toEqual({ status: 'duplicate' });
    expect(await chargeRender(db, user, { ...image, bytes: 1 }, NOW + image.ttlMs - 1)).toEqual({ status: 'duplicate' });

    expect((await getUsage(db, user, NOW)).used).toBe(1);
    expect(await ledger(user)).toEqual(before);
  });

  it('charges again once the cached image has expired, replacing the ledger row', async () => {
    const user = await makeUser();
    const image = render({ ttlMs: DAY_MS });
    expectCharged(await chargeRender(db, user, image, NOW));

    const later = NOW + DAY_MS;
    const again = expectCharged(await chargeRender(db, user, { ...image, bytes: 999 }, later));
    expect(again.usage.used).toBe(2);
    expect(await ledger(user)).toMatchObject([{ cache_key: image.cacheKey, bytes: 999, created_at: later, expires_at: later + DAY_MS }]);
    expect(await chargeRender(db, user, image, later + 1)).toEqual({ status: 'duplicate' });
  });

  it('an expired image re-rendered when nothing is left is refused and its stale row removed', async () => {
    const user = await makeUser();
    const image = render({ ttlMs: DAY_MS });
    expectCharged(await chargeRender(db, user, image, NOW));
    await setUsed(user, NOV, FREE);

    expect(await chargeRender(db, user, image, NOW + DAY_MS)).toMatchObject({ status: 'quota_exceeded', usage: { used: FREE } });
    expect(await ledger(user)).toEqual([]);
  });
});

describe('chargeRender - concurrency', () => {
  it('20 simultaneous images with 5 left charge exactly 5', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 5);

    const results = await concurrentCharges(user, 20);
    expect(tally(results)).toEqual({ plan: 5, topup: 0, duplicate: 0, quota_exceeded: 15 });
    expect((await periodRow(user, NOV))?.used).toBe(FREE);
    expect(await ledger(user)).toHaveLength(5);
    expect(results.filter((result) => result.status === 'quota_exceeded').every((result) => result.usage.used === FREE)).toBe(true);
  });

  it('12 simultaneous requests for the same image charge exactly once', async () => {
    const user = await makeUser();
    const image = render();
    const results = await Promise.all(Array.from({ length: 12 }, () => chargeRender(db, user, image, NOW)));
    expect(tally(results)).toEqual({ plan: 1, topup: 0, duplicate: 11, quota_exceeded: 0 });
    expect((await getUsage(db, user, NOW)).used).toBe(1);
    expect(await ledger(user)).toHaveLength(1);
  });

  it('spills from the allowance into a top-up without losing or inventing an image', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    await setUsed(user, PADDLE, STARTER - 3);
    const txn = await giveTopup(user, { remaining: 4 });

    const results = await concurrentCharges(user, 20);
    expect(tally(results)).toEqual({ plan: 3, topup: 4, duplicate: 0, quota_exceeded: 13 });
    expect(await periodRow(user, PADDLE)).toMatchObject({ used: STARTER, topup_used: 4 });
    expect((await topup(txn)).remaining).toBe(0);
    const labels = (await ledger(user)).map((row) => row.charged_to).sort();
    expect(labels).toEqual(['plan', 'plan', 'plan', 'topup', 'topup', 'topup', 'topup']);
  });

  it('first use of a new period by many requests at once creates one row and counts every image', async () => {
    const user = await makeUser();
    const results = await concurrentCharges(user, 25);
    expect(tally(results)).toEqual({ plan: 25, topup: 0, duplicate: 0, quota_exceeded: 0 });
    expect(await periodRows(user)).toMatchObject([{ period_start: NOV.start, used: 25 }]);
  });

  it('reports each threshold exactly once even when many images cross it together', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 15);
    const results = (await concurrentCharges(user, 15)).map(expectCharged);
    expect(results.filter((result) => result.crossed90)).toHaveLength(1);
    expect(results.filter((result) => result.crossed100)).toHaveLength(1);
  });
});

describe('chargeRender - periods', () => {
  it('starts the next UTC month at 0 and leaves last month\'s row untouched', async () => {
    const user = await makeUser();
    for (let i = 0; i < 3; i++) expectCharged(await chargeRender(db, user, render(), NOW));
    const november = await periodRow(user, NOV);
    expect(november?.used).toBe(3);

    expect(await getUsage(db, user, DEC.start)).toMatchObject({ period_start: DEC.start, period_end: DEC.end, used: 0, remaining: FREE });
    const first = expectCharged(await chargeRender(db, user, render(), DEC.start));
    expect(first.usage).toMatchObject({ period_start: DEC.start, used: 1 });

    expect(await periodRow(user, NOV)).toEqual(november);
    expect(await periodRows(user)).toMatchObject([
      { period_start: NOV.start, used: 3 },
      { period_start: DEC.start, period_end: DEC.end, used: 1 },
    ]);
    // Unused November images did not roll over.
    expect((await getUsage(db, user, DEC.start)).total_remaining).toBe(FREE - 1);
  });

  it('an exhausted Free account can render again when the month turns, with fresh thresholds', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    expect((await chargeRender(db, user, render(), DEC.start - 1)).status).toBe('quota_exceeded');
    expect((await chargeRender(db, user, render(), DEC.start)).status).toBe('charged');

    await setUsed(user, DEC, FREE - 11);
    const ninetieth = expectCharged(await chargeRender(db, user, render(), DEC.start + 1));
    expect(ninetieth).toMatchObject({ crossed90: true, crossed100: false, usage: { used: 90 } });
  });

  it('a paid account is counted per Paddle billing period against its plan limit', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    const charged = expectCharged(await chargeRender(db, user, render(), NOW));
    expect(charged.usage).toMatchObject({
      plan: 'starter',
      period_start: PADDLE.start,
      period_end: PADDLE.end,
      limit: STARTER,
      used: 1,
      remaining: STARTER - 1,
      watermark: false,
      cache_days: PLANS.starter.cacheDays,
    });
    expect(await periodRows(user)).toMatchObject([{ period_start: PADDLE.start, period_end: PADDLE.end, used: 1 }]);

    // 5 December is a new calendar month but still the same billing period.
    const december = expectCharged(await chargeRender(db, user, render(), Date.UTC(2026, 11, 5)));
    expect(december.usage).toMatchObject({ period_start: PADDLE.start, used: 2 });

    await setUsed(user, PADDLE, STARTER - 1);
    expect(expectCharged(await chargeRender(db, user, render(), NOW)).usage.used).toBe(STARTER);
    expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ status: 'quota_exceeded', usage: { used: STARTER, limit: STARTER } });

    // Renewal: the webhook moves the period forward and the counter starts again.
    const renewed: UserRow = { ...user, period_start: PADDLE.end, period_end: PADDLE.end + 30 * DAY_MS };
    expect(expectCharged(await chargeRender(db, renewed, render(), PADDLE.end)).usage).toMatchObject({ period_start: PADDLE.end, used: 1 });
    expect((await periodRow(user, PADDLE))?.used).toBe(STARTER);
  });

  it('a paid account whose period is stale is counted per calendar month until the renewal arrives', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    const afterEnd = PADDLE.end + DAY_MS;
    const charged = expectCharged(await chargeRender(db, user, render(), afterEnd));
    expect(charged.usage).toMatchObject({ period_start: DEC.start, period_end: DEC.end, limit: STARTER, used: 1 });
  });

  it('upgrading inside a billing period raises the limit and keeps what was used', async () => {
    const starter = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    await setUsed(starter, PADDLE, STARTER);
    expect((await chargeRender(db, starter, render(), NOW)).status).toBe('quota_exceeded');

    const pro: UserRow = { ...starter, plan: 'pro' };
    expect(await getUsage(db, pro, NOW)).toMatchObject({ plan: 'pro', limit: PRO, used: STARTER, remaining: PRO - STARTER });
    const charged = expectCharged(await chargeRender(db, pro, render(), NOW));
    expect(charged).toMatchObject({ chargedTo: 'plan', usage: { used: STARTER + 1, limit: PRO } });
  });

  it('upgrading from Free before Paddle has sent a period keeps the month\'s usage', async () => {
    const free = await makeUser();
    await setUsed(free, NOV, FREE);
    const starter: UserRow = { ...free, plan: 'starter' };
    const charged = expectCharged(await chargeRender(db, starter, render(), NOW));
    expect(charged.usage).toMatchObject({ period_start: NOV.start, limit: STARTER, used: FREE + 1 });
  });
});

describe('chargeRender - top-ups', () => {
  it('uses a top-up only after the monthly allowance is exhausted', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    await setUsed(user, PADDLE, STARTER - 2);
    const txn = await giveTopup(user);

    for (let i = 0; i < 2; i++) {
      expect(expectCharged(await chargeRender(db, user, render(), NOW)).chargedTo).toBe('plan');
    }
    expect((await topup(txn)).remaining).toBe(TOPUP.images);

    const image = render();
    const third = expectCharged(await chargeRender(db, user, image, NOW));
    expect(third).toEqual({
      status: 'charged',
      chargedTo: 'topup',
      crossed90: false,
      crossed100: false,
      usage: {
        plan: 'starter',
        period_start: PADDLE.start,
        period_end: PADDLE.end,
        limit: STARTER,
        used: STARTER,
        remaining: 0,
        topup_remaining: TOPUP.images - 1,
        total_remaining: TOPUP.images - 1,
        cache_days: PLANS.starter.cacheDays,
        watermark: false,
      },
    });
    expect((await topup(txn)).remaining).toBe(TOPUP.images - 1);
    expect(await periodRow(user, PADDLE)).toMatchObject({ used: STARTER, topup_used: 1 });
    expect((await ledger(user)).find((row) => row.cache_key === image.cacheKey)?.charged_to).toBe('topup');
    // A top-up image is cached like any other: asking again is free.
    expect(await chargeRender(db, user, image, NOW)).toEqual({ status: 'duplicate' });
    expect((await topup(txn)).remaining).toBe(TOPUP.images - 1);
  });

  it('drains the top-up that expires first, whatever order they were bought in', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    const newer = await giveTopup(user, { creditedAt: NOW - 10 * DAY_MS });
    const older = await giveTopup(user, { creditedAt: NOW - 100 * DAY_MS, remaining: 2 });

    for (let i = 0; i < 2; i++) expectCharged(await chargeRender(db, user, render(), NOW));
    expect((await topup(older)).remaining).toBe(0);
    expect((await topup(newer)).remaining).toBe(TOPUP.images);

    expect(expectCharged(await chargeRender(db, user, render(), NOW)).chargedTo).toBe('topup');
    expect((await topup(older)).remaining).toBe(0);
    expect((await topup(newer)).remaining).toBe(TOPUP.images - 1);
  });

  it('never uses an expired top-up', async () => {
    const user = await makeUser({ plan: 'pro', period_start: NOW - DAY_MS, period_end: NOW + 2 * TOPUP_TTL });
    const period = { start: NOW - DAY_MS, end: NOW + 2 * TOPUP_TTL };
    await setUsed(user, period, PRO);
    const txn = await giveTopup(user);
    const expiry = (await topup(txn)).expires_at;
    expect(expiry).toBe(NOW + TOPUP_TTL);

    expect(expectCharged(await chargeRender(db, user, render(), expiry - 1)).chargedTo).toBe('topup');
    expect(await chargeRender(db, user, render(), expiry)).toMatchObject({
      status: 'quota_exceeded',
      usage: { topup_remaining: 0, total_remaining: 0 },
    });
    expect((await topup(txn)).remaining).toBe(TOPUP.images - 1);
  });

  it('never uses a refunded top-up, and skips it for the next one', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    const refunded = await giveTopup(user, { creditedAt: NOW - 50 * DAY_MS });
    expect(await markTopupRefunded(db, refunded, NOW)).toBe(true);

    expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ status: 'quota_exceeded', usage: { topup_remaining: 0 } });
    expect(await ledger(user)).toEqual([]);
    expect(await periodRow(user, NOV)).toMatchObject({ used: FREE, topup_used: 0 });

    const valid = await giveTopup(user);
    expect(expectCharged(await chargeRender(db, user, render(), NOW)).chargedTo).toBe('topup');
    expect((await topup(refunded)).remaining).toBe(TOPUP.images);
    expect((await topup(valid)).remaining).toBe(TOPUP.images - 1);
  });

  it('stops hard when the last top-up image is gone', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    const txn = await giveTopup(user, { remaining: 2 });

    const results: ChargeResult[] = [];
    for (let i = 0; i < 4; i++) results.push(await chargeRender(db, user, render(), NOW));
    expect(tally(results)).toEqual({ plan: 0, topup: 2, duplicate: 0, quota_exceeded: 2 });
    expect((await topup(txn)).remaining).toBe(0);
    expect(await periodRow(user, NOV)).toMatchObject({ used: FREE, topup_used: 2 });
    expect(await ledger(user)).toHaveLength(2);
  });

  it('does not touch another account\'s top-ups', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await setUsed(other, NOV, FREE);
    const txn = await giveTopup(owner);
    expect((await chargeRender(db, other, render(), NOW)).status).toBe('quota_exceeded');
    expect((await topup(txn)).remaining).toBe(TOPUP.images);
  });
});

describe('creditTopup and markTopupRefunded', () => {
  it('credits once per Paddle transaction, valid for TOPUP.validDays', async () => {
    const user = await makeUser();
    const transactionId = nextTxn();
    expect(await creditTopup(db, { userId: user.id, transactionId, images: TOPUP.images, now: NOW })).toBe(true);
    const row = await topup(transactionId);
    expect(row).toMatchObject({
      user_id: user.id,
      paddle_transaction_id: transactionId,
      images: TOPUP.images,
      remaining: TOPUP.images,
      created_at: NOW,
      expires_at: NOW + TOPUP.validDays * DAY_MS,
      refunded_at: null,
    });
    expect(row.id).toMatch(/^tu_[0-9a-z]{16}$/);

    // A redelivered webhook, even with different numbers, changes nothing.
    expect(await creditTopup(db, { userId: user.id, transactionId, images: 5000, now: NOW + DAY_MS })).toBe(false);
    expect(await topup(transactionId)).toEqual(row);
    expect((await getUsage(db, user, NOW)).topup_remaining).toBe(TOPUP.images);
  });

  it('credits a transaction only once when the webhook is delivered twice at the same time', async () => {
    const user = await makeUser();
    const transactionId = nextTxn();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => creditTopup(db, { userId: user.id, transactionId, images: TOPUP.images, now: NOW })),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await getUsage(db, user, NOW)).topup_remaining).toBe(TOPUP.images);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a credit of %s images', async (images) => {
    const user = await makeUser();
    const transactionId = nextTxn();
    await expect(creditTopup(db, { userId: user.id, transactionId, images, now: NOW })).rejects.toBeInstanceOf(RangeError);
    expect(await first(db, 'SELECT id FROM topups WHERE paddle_transaction_id = ?', transactionId)).toBeNull();
  });

  it('marks a top-up refunded once and keeps its numbers for the audit trail', async () => {
    const user = await makeUser();
    const txn = await giveTopup(user, { remaining: 400 });
    expect((await getUsage(db, user, NOW)).topup_remaining).toBe(400);

    expect(await markTopupRefunded(db, txn, NOW + 5)).toBe(true);
    expect(await topup(txn)).toMatchObject({ refunded_at: NOW + 5, remaining: 400, images: TOPUP.images });
    expect((await getUsage(db, user, NOW)).topup_remaining).toBe(0);

    expect(await markTopupRefunded(db, txn, NOW + 99)).toBe(false);
    expect((await topup(txn)).refunded_at).toBe(NOW + 5);
    expect(await markTopupRefunded(db, 'txn_does_not_exist', NOW)).toBe(false);
  });
});

describe('thresholds', () => {
  it('fire once per period on a paid plan, at 90% and 100% of that plan\'s allowance', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    const ninety = STARTER * 0.9;
    await setUsed(user, PADDLE, ninety - 2);

    const flags: Array<[number, boolean, boolean]> = [];
    for (let i = 0; i < 4; i++) {
      const result = expectCharged(await chargeRender(db, user, render(), NOW));
      flags.push([result.usage.used, result.crossed90, result.crossed100]);
    }
    expect(flags).toEqual([
      [ninety - 1, false, false],
      [ninety, true, false],
      [ninety + 1, false, false],
      [ninety + 2, false, false],
    ]);

    await setUsed(user, PADDLE, STARTER - 1);
    expect(expectCharged(await chargeRender(db, user, render(), NOW))).toMatchObject({ crossed90: false, crossed100: true });
    expect(await periodRow(user, PADDLE)).toMatchObject({ used: STARTER, notified_90: 1, notified_100: 1 });
  });

  it('a top-up image never reports a threshold', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE);
    await giveTopup(user);
    expect(expectCharged(await chargeRender(db, user, render(), NOW))).toMatchObject({ chargedTo: 'topup', crossed90: false, crossed100: false });
    expect(await periodRow(user, NOV)).toMatchObject({ notified_90: 0, notified_100: 0 });
  });

  it('a jump straight past 90% (usage restored above the mark) still reports it once', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, 95);
    expect(expectCharged(await chargeRender(db, user, render(), NOW))).toMatchObject({ crossed90: true, crossed100: false });
    expect(expectCharged(await chargeRender(db, user, render(), NOW))).toMatchObject({ crossed90: false, crossed100: false });
  });
});

describe('failure between statements', () => {
  it('does not charge when D1 fails after the ledger row was claimed, and never charges that image later', async () => {
    const user = await makeUser();
    const image = render({ ttlMs: DAY_MS });

    await expect(chargeRender(failingBatch(db), user, image, NOW)).rejects.toThrow('simulated D1 failure');
    expect(await getUsage(db, user, NOW)).toMatchObject({ used: 0, remaining: FREE });
    expect(await periodRows(user)).toEqual([]);

    // The image stays covered by its ledger row for the cache lifetime: served, not charged.
    expect(await chargeRender(db, user, image, NOW + 1)).toEqual({ status: 'duplicate' });
    expect((await getUsage(db, user, NOW)).used).toBe(0);

    // After it expires the normal rules apply again.
    expect(expectCharged(await chargeRender(db, user, image, NOW + DAY_MS)).usage.used).toBe(1);
  });
});

describe('listRecentRenders', () => {
  it('returns the account\'s own renders, newest first, up to the limit', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const image = render();
      keys.push(image.cacheKey);
      expectCharged(await chargeRender(db, user, image, NOW + i * 1000));
    }
    expectCharged(await chargeRender(db, other, render(), NOW + 10_000));

    const recent = await listRecentRenders(db, user.id, 3);
    expect(recent.map((row) => row.cache_key)).toEqual([keys[4], keys[3], keys[2]]);
    expect(recent[0]).toMatchObject({ user_id: user.id, created_at: NOW + 4000, charged_to: 'plan', format: 'png' });
    expect((await listRecentRenders(db, user.id, 50)).map((row) => row.cache_key)).toEqual([...keys].reverse());
  });

  it('clamps the limit to 1..100', async () => {
    const user = await makeUser({ plan: 'starter', period_start: PADDLE.start, period_end: PADDLE.end });
    await concurrentCharges(user, 105);
    expect(await listRecentRenders(db, user.id, 1000)).toHaveLength(100);
    expect(await listRecentRenders(db, user.id, 0)).toHaveLength(1);
    expect(await listRecentRenders(db, user.id, -5)).toHaveLength(1);
    expect(await listRecentRenders(db, user.id, Number.NaN)).toHaveLength(1);
    expect(await listRecentRenders(db, user.id, 2.9)).toHaveLength(2);
  });
});
