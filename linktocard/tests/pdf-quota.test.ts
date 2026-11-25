// PDF quota (src/lib/quota.ts chargePdf, pdfCapacity, getPdfUsage): pages -> images, and the
// block rule - a PDF is taken whole from the monthly allowance, or whole from one top-up, or
// not at all. Images keep their own tests (quota.test.ts) and must charge exactly as before.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PLANS, TOPUP } from '../src/billing/plans';
import { DAY_MS, PDF, pdfUnits } from '../src/config';
import { all, first, getUserById, run } from '../src/db/client';
import { chargePdf, chargeRender, creditTopup, getPdfUsage, getUsage, listRecentRenders, pdfCapacity, type ChargeResult, type PdfCharge, type Period } from '../src/lib/quota';
import type { RenderRow, UsagePeriodRow, UserRow } from '../src/types';

const db = env.DB;
/** 22 Nov 2026 12:00 UTC. */
const NOW = Date.UTC(2026, 10, 22, 12);
const NOV: Period = { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) };
const FREE = PLANS.free.monthlyImages;
const STARTER = PLANS.starter.monthlyImages;
const PADDLE: Period = { start: Date.UTC(2026, 10, 10, 9, 30), end: Date.UTC(2026, 11, 10, 9, 30) };

let userSeq = 0;
let keySeq = 0;
let txnSeq = 0;

async function makeUser(plan: 'free' | 'starter' = 'free'): Promise<UserRow> {
  const id = `u_pdfquota${++userSeq}`;
  const period = plan === 'free' ? { start: null, end: null } : PADDLE;
  await run(db, 'INSERT INTO users (id, email, created_at, plan, period_start, period_end) VALUES (?, ?, ?, ?, ?, ?)', id, `${id}@example.test`, NOW, plan, period.start, period.end);
  return (await getUserById(db, id))!;
}

function pdf(units: number, overrides: Partial<PdfCharge> = {}): PdfCharge {
  const cacheKey = overrides.cacheKey ?? `pdfck_${++keySeq}`;
  return { cacheKey, siteId: null, source: 'api', template: 'invoice', bytes: 4321, r2Key: `r/u/${cacheKey}.pdf`, ttlMs: 7 * DAY_MS, units, ...overrides };
}

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

async function giveTopup(user: UserRow, remaining: number, creditedAt = NOW): Promise<string> {
  const transactionId = `txn_pdfquota${++txnSeq}`;
  await creditTopup(db, { userId: user.id, transactionId, images: TOPUP.images, now: creditedAt });
  await run(db, 'UPDATE topups SET remaining = ? WHERE paddle_transaction_id = ?', remaining, transactionId);
  return transactionId;
}

const remainingOf = async (transactionId: string): Promise<number> =>
  (await first<{ remaining: number }>(db, 'SELECT remaining FROM topups WHERE paddle_transaction_id = ?', transactionId))!.remaining;
const periodRow = (user: UserRow, period: Period): Promise<UsagePeriodRow | null> =>
  first<UsagePeriodRow>(db, 'SELECT * FROM usage_periods WHERE user_id = ? AND period_start = ?', user.id, period.start);
const ledger = (user: UserRow): Promise<RenderRow[]> => all<RenderRow>(db, 'SELECT * FROM renders WHERE user_id = ? ORDER BY created_at, cache_key', user.id);

function expectCharged(result: ChargeResult): Extract<ChargeResult, { status: 'charged' }> {
  if (result.status !== 'charged') throw new Error(`expected a charge, got ${result.status}`);
  return result;
}

describe('pdfUnits', () => {
  it.each([
    [1, 2],
    [10, 2],
    [11, 3],
    [20, 3],
    [21, 4],
    [30, 4],
    [31, 5],
    [41, 6],
    [50, 6],
  ])('%i pages count as %i images', (pages, units) => {
    expect(pdfUnits(pages)).toBe(units);
  });

  it('follows the numbers in src/config.ts', () => {
    expect(pdfUnits(PDF.basePages)).toBe(PDF.baseUnits);
    expect(pdfUnits(PDF.basePages + 1)).toBe(PDF.baseUnits + 1);
    expect(pdfUnits(PDF.basePages + PDF.extraPagesPerUnit + 1)).toBe(PDF.baseUnits + 2);
  });

  it('refuses zero, negative and fractional page counts', () => {
    expect(() => pdfUnits(0)).toThrow(RangeError);
    expect(() => pdfUnits(-1)).toThrow(RangeError);
    expect(() => pdfUnits(1.5)).toThrow(RangeError);
  });
});

describe('chargePdf - the block rule', () => {
  it('takes the whole block from the allowance and counts PDFs and their images', async () => {
    const user = await makeUser();
    const charged = expectCharged(await chargePdf(db, user, pdf(3), NOW));
    expect(charged).toMatchObject({ chargedTo: 'plan', usage: { used: 3, remaining: FREE - 3 } });
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 1, images: 3 });
    expectCharged(await chargePdf(db, user, pdf(2), NOW));
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 2, images: 5 });
    expect((await periodRow(user, NOV))?.used).toBe(5);
  });

  it('writes a ledger row with format "pdf" that the dashboard list of images leaves out', async () => {
    const user = await makeUser();
    const charge = pdf(4, { siteId: 's_x', source: 'signed' });
    expectCharged(await chargePdf(db, user, charge, NOW));
    expect(await ledger(user)).toMatchObject([
      { cache_key: charge.cacheKey, format: 'pdf', width: 0, height: 0, source: 'signed', site_id: 's_x', charged_to: 'plan', expires_at: NOW + 7 * DAY_MS },
    ]);
    expect(await listRecentRenders(db, user.id, 10)).toEqual([]);
  });

  it('fits exactly: the last images of the allowance can be one block', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 3);
    expectCharged(await chargePdf(db, user, pdf(3), NOW));
    expect((await getUsage(db, user, NOW)).remaining).toBe(0);
  });

  it('never splits: with 2 images left a 3-image PDF is refused and nothing moves', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 2);
    const result = await chargePdf(db, user, pdf(3), NOW);
    expect(result).toMatchObject({ status: 'quota_exceeded', usage: { used: FREE - 2, remaining: 2 } });
    expect((await periodRow(user, NOV))?.used).toBe(FREE - 2);
    expect(await ledger(user)).toEqual([]);
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 0, images: 0 });
  });

  it('takes the block whole from one top-up when the allowance cannot hold it', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER - 1);
    const txn = await giveTopup(user, 10);
    const charged = expectCharged(await chargePdf(db, user, pdf(4), NOW));
    expect(charged.chargedTo).toBe('topup');
    expect(await remainingOf(txn)).toBe(6);
    // The allowance keeps its last image: nothing was split.
    expect(await periodRow(user, PADDLE)).toMatchObject({ used: STARTER - 1, topup_used: 4 });
    expect((await ledger(user))[0]?.charged_to).toBe('topup');
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 1, images: 4 });
  });

  it('skips a top-up with too little left and uses the next one with enough', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER);
    const small = await giveTopup(user, 2, NOW - 2 * DAY_MS);
    const big = await giveTopup(user, 50, NOW - DAY_MS);
    expectCharged(await chargePdf(db, user, pdf(5), NOW));
    expect(await remainingOf(small)).toBe(2);
    expect(await remainingOf(big)).toBe(45);
  });

  it('uses the top-up that expires first when several have enough', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER);
    const older = await giveTopup(user, 10, NOW - 10 * DAY_MS);
    const newer = await giveTopup(user, 10, NOW - DAY_MS);
    expectCharged(await chargePdf(db, user, pdf(3), NOW));
    expect([await remainingOf(older), await remainingOf(newer)]).toEqual([7, 10]);
  });

  it('refuses when no single top-up has the block, even if together they would', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER - 2);
    const a = await giveTopup(user, 2);
    const b = await giveTopup(user, 2);
    const result = await chargePdf(db, user, pdf(3), NOW);
    expect(result).toMatchObject({ status: 'quota_exceeded', usage: { remaining: 2, topup_remaining: 4, total_remaining: 6 } });
    expect([await remainingOf(a), await remainingOf(b)]).toEqual([2, 2]);
    expect(await periodRow(user, PADDLE)).toMatchObject({ used: STARTER - 2, topup_used: 0 });
  });

  it('ignores refunded and expired top-ups', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER);
    const refunded = await giveTopup(user, 10);
    await run(db, 'UPDATE topups SET refunded_at = ? WHERE paddle_transaction_id = ?', NOW - 1, refunded);
    const expired = await giveTopup(user, 10);
    await run(db, 'UPDATE topups SET expires_at = ? WHERE paddle_transaction_id = ?', NOW, expired);
    expect((await chargePdf(db, user, pdf(2), NOW)).status).toBe('quota_exceeded');
  });

  it('respects a plan-change allowance adjustment', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 5);
    await run(db, 'UPDATE usage_periods SET allowance_adjust = -3 WHERE user_id = ? AND period_start = ?', user.id, NOV.start);
    expect((await chargePdf(db, user, pdf(3), NOW)).status).toBe('quota_exceeded');
    expectCharged(await chargePdf(db, user, pdf(2), NOW));
  });

  it('charges a cached PDF once: the same cache key is a duplicate while its ledger row lives', async () => {
    const user = await makeUser();
    const charge = pdf(2);
    expectCharged(await chargePdf(db, user, charge, NOW));
    expect((await chargePdf(db, user, charge, NOW + 1000)).status).toBe('duplicate');
    expect((await getUsage(db, user, NOW)).used).toBe(2);
    // After the cache period the same PDF is charged again.
    expectCharged(await chargePdf(db, user, charge, NOW + 7 * DAY_MS));
  });

  it('crosses the 90% and 100% notices once, like images', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE * 0.9 - 2);
    expect(expectCharged(await chargePdf(db, user, pdf(2), NOW))).toMatchObject({ crossed90: true, crossed100: false });
    await setUsed(user, NOV, FREE - 2);
    expect(expectCharged(await chargePdf(db, user, pdf(2), NOW))).toMatchObject({ crossed90: false, crossed100: true });
  });

  it('refuses a block that is not a positive whole number', async () => {
    const user = await makeUser();
    await expect(chargePdf(db, user, pdf(0), NOW)).rejects.toThrow(RangeError);
  });

  it('leaves image charging as it was: one image, from the allowance first', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 3);
    expectCharged(await chargePdf(db, user, pdf(2), NOW));
    const image = expectCharged(
      await chargeRender(db, user, { cacheKey: 'img_after_pdf', siteId: null, source: 'api', template: 'blog', width: 1200, height: 630, format: 'png', bytes: 1, r2Key: 'x', ttlMs: DAY_MS }, NOW),
    );
    expect(image.usage.used).toBe(FREE);
    expect((await listRecentRenders(db, user.id, 10)).map((row) => row.cache_key)).toEqual(['img_after_pdf']);
  });
});

describe('chargePdf - concurrency', () => {
  it('never goes past the allowance when many PDFs race for the last images', async () => {
    const user = await makeUser();
    await setUsed(user, NOV, FREE - 7);
    const results = await Promise.all(Array.from({ length: 12 }, () => chargePdf(db, user, pdf(2), NOW)));
    const charged = results.filter((result) => result.status === 'charged').length;
    expect(charged).toBe(3);
    expect(results.filter((result) => result.status === 'quota_exceeded')).toHaveLength(9);
    expect((await periodRow(user, NOV))?.used).toBe(FREE - 1);
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 3, images: 6 });
    expect(await ledger(user)).toHaveLength(3);
  });

  it('never takes a top-up below zero', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER);
    const txn = await giveTopup(user, 10);
    const results = await Promise.all(Array.from({ length: 8 }, () => chargePdf(db, user, pdf(3), NOW)));
    expect(results.filter((result) => result.status === 'charged')).toHaveLength(3);
    expect(await remainingOf(txn)).toBe(1);
    expect(await periodRow(user, PADDLE)).toMatchObject({ topup_used: 9 });
    expect(await getPdfUsage(db, user, NOW)).toEqual({ count: 3, images: 9 });
  });

  it('charges one of several identical requests', async () => {
    const user = await makeUser();
    const charge = pdf(3);
    const results = await Promise.all(Array.from({ length: 6 }, () => chargePdf(db, user, charge, NOW)));
    expect(results.filter((result) => result.status === 'charged')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'duplicate')).toHaveLength(5);
    expect((await getUsage(db, user, NOW)).used).toBe(3);
  });
});

describe('pdfCapacity', () => {
  it('is the larger of the allowance left and the fullest usable top-up', async () => {
    const user = await makeUser('starter');
    await setUsed(user, PADDLE, STARTER - 1);
    expect((await pdfCapacity(db, user, NOW)).largestBlock).toBe(1);
    await giveTopup(user, 1);
    await giveTopup(user, 1);
    // 3 images left in total, but no place holds the minimum block of PDF.baseUnits.
    expect((await pdfCapacity(db, user, NOW)).largestBlock).toBeLessThan(PDF.baseUnits);
    await giveTopup(user, 7);
    expect((await pdfCapacity(db, user, NOW)).largestBlock).toBe(7);
  });
});
