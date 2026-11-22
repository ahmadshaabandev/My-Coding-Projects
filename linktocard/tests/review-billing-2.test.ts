// Second billing review: attacks one step sideways of the first review's fixes.
// Payloads are Paddle's official examples (tests/fixtures/paddle) with ids,
// prices, status and dates replaced.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS } from '../src/config';
import { first, getUserById, run } from '../src/db/client';
import { hmacSha256Hex } from '../src/lib/crypto';
import { chargeRender, getUsage, type RenderCharge } from '../src/lib/quota';
import { paddleWebhookRouter } from '../src/routes/webhooks/paddle';
import type { UserRow } from '../src/types';
import subscriptionCanceled from './fixtures/paddle/subscription.canceled.json';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';
import subscriptionPaused from './fixtures/paddle/subscription.paused.json';
import subscriptionUpdated from './fixtures/paddle/subscription.updated.json';

interface PaddleFixture {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

const db = env.DB;
const NOW = Date.UTC(2026, 10, 22, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SECRET = env.PADDLE_WEBHOOK_SECRET ?? '';
const PRICE = { starter: env.PADDLE_PRICE_STARTER ?? '', pro: env.PADDLE_PRICE_PRO ?? '' };
const PERIOD = { start: NOW - 10 * DAY_MS, end: NOW + 20 * DAY_MS };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_rb2${String(++sequence).padStart(4, '0')}`;

interface Account {
  userId: string;
  customerId: string;
  subscriptionId: string;
}

async function makeAccount(): Promise<Account> {
  const userId = nextId('u');
  await run(db, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, ?3, 'free')", userId, `${userId}@example.com`, NOW - 40 * DAY_MS);
  return { userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };
}

async function userRow(userId: string): Promise<UserRow> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

async function storedRow(userId: string): Promise<UserRow> {
  const user = await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?1', userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

interface Changes {
  userId?: string;
  priceIds?: string[];
  status?: string;
  at?: number;
  scheduledCancelAt?: number;
  period?: { start: number; end: number } | null;
}

function subscriptionEvent(fixture: PaddleFixture, account: Account, changes: Changes = {}): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  event.occurred_at = new Date(changes.at ?? Date.now()).toISOString();
  event.data.id = account.subscriptionId;
  event.data.customer_id = account.customerId;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  const template = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[0]!;
  event.data.items = (changes.priceIds ?? [PRICE.starter]).map((id) => ({ ...structuredClone(template), price: { ...template.price, id }, quantity: 1 }));
  if (changes.status) event.data.status = changes.status;
  const ended = event.data.status === 'canceled' || event.data.status === 'paused';
  const period = changes.period === undefined ? (ended ? null : PERIOD) : changes.period;
  event.data.current_billing_period = period
    ? { starts_at: new Date(period.start).toISOString(), ends_at: new Date(period.end).toISOString() }
    : null;
  event.data.scheduled_change = changes.scheduledCancelAt
    ? { action: 'cancel', effective_at: new Date(changes.scheduledCancelAt).toISOString(), resume_at: null }
    : null;
  return event;
}

async function deliver(event: PaddleFixture): Promise<{ status: number; result?: string }> {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `ts=${timestamp};h1=${await hmacSha256Hex(SECRET, `${timestamp}:${raw}`)}`;
  const response = await paddleWebhookRouter.request(
    '/paddle',
    { method: 'POST', headers: { 'content-type': 'application/json', 'Paddle-Signature': signature }, body: raw },
    env,
  );
  return { status: response.status, ...((await response.json()) as { result?: string }) };
}

async function apply(event: PaddleFixture): Promise<void> {
  expect(await deliver(event)).toMatchObject({ status: 200, result: 'ok' });
}

function render(): RenderCharge {
  const cacheKey = nextId('ck');
  return { cacheKey, siteId: null, source: 'api', template: 'inline', width: 1200, height: 630, format: 'png', bytes: 1000, r2Key: `renders/${cacheKey}.png`, ttlMs: 7 * DAY_MS };
}

/** A subscriber whose checkout carried their own account id. */
async function subscriber(plan: 'starter' | 'pro' = 'starter'): Promise<Account> {
  const account = await makeAccount();
  await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceIds: [PRICE[plan]], at: PERIOD.start }));
  return account;
}

describe('the forged-account-id guard, one step sideways', () => {
  it('a paying customer in the dunning window (past_due) cannot be replaced or ended by a stranger\'s subscription', async () => {
    const victim = await subscriber('pro');
    await apply(subscriptionEvent(subscriptionUpdated, victim, { priceIds: [PRICE.pro], status: 'past_due', at: NOW - HOUR }));
    const stranger: Account = { userId: victim.userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };

    for (const [fixture, status] of [
      [subscriptionCreated, 'active'],
      [subscriptionUpdated, 'trialing'],
      [subscriptionPaused, 'paused'],
      [subscriptionCanceled, 'canceled'],
    ] as const) {
      expect(await deliver(subscriptionEvent(fixture, stranger, { userId: victim.userId, status })), status).toMatchObject({
        status: 200,
        result: 'ignored:other_subscription',
      });
    }
    expect(await storedRow(victim.userId)).toMatchObject({
      plan: 'pro',
      subscription_status: 'past_due',
      paddle_subscription_id: victim.subscriptionId,
      paddle_customer_id: victim.customerId,
    });
  });

  it('the end of a subscription never attaches a Paddle customer that another account holds', async () => {
    const victim = await subscriber('starter');
    const intruder = await makeAccount();
    const forged: Account = { userId: intruder.userId, customerId: victim.customerId, subscriptionId: nextId('sub') };
    await apply(subscriptionEvent(subscriptionCanceled, forged, { userId: intruder.userId, status: 'canceled' }));
    expect(await storedRow(intruder.userId)).toMatchObject({ plan: 'free', paddle_customer_id: null });
    expect((await storedRow(victim.userId)).paddle_customer_id).toBe(victim.customerId);
  });
});

describe('the automatic return to Free cannot undo a renewal it did not see', () => {
  it('a request holding the row from before an un-cancel and renewal does not put the renewed account on Free', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - DAY_MS, scheduledCancelAt: PERIOD.end }));
    const stale = await userRow(account.userId);

    // The customer removed the cancellation and Paddle renewed; this request loaded the row before that.
    vi.setSystemTime(PERIOD.end + MINUTE);
    const renewed = { start: PERIOD.end, end: PERIOD.end + 30 * DAY_MS };
    await apply(subscriptionEvent(subscriptionUpdated, account, { period: renewed }));

    expect((await getUsage(db, stale, PERIOD.end + 2 * MINUTE)).plan).toBe('free');
    expect((await chargeRender(db, stale, render(), PERIOD.end + 2 * MINUTE)).status).toBe('charged');
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'starter', subscription_status: 'active', cancel_at: null, period_end: renewed.end });
    expect(await getUsage(db, await userRow(account.userId), PERIOD.end + 3 * MINUTE)).toMatchObject({
      plan: 'starter',
      limit: PLANS.starter.monthlyImages,
      period_start: new Date(renewed.start).getTime(),
    });
  });
});

describe('plan changes inside one billing period', () => {
  // An upgrade is charged prorated for the time left, so it adds Pro images only for
  // that time. A downgrade is not credited (do_not_bill), so the allowance already
  // paid for stays until the period ends. See changeSubscriptionPlan.
  const STARTER = PLANS.starter.monthlyImages;
  const PRO = PLANS.pro.monthlyImages;
  const usageNow = async (account: Account, at: number) => getUsage(db, await userRow(account.userId), at);
  const useImages = (account: Account, count: number) =>
    run(
      db,
      'INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, period_start) DO UPDATE SET used = excluded.used',
      account.userId,
      PERIOD.start,
      PERIOD.end,
      count,
    );

  it('an upgrade one hour before the period ends adds about one hour of the Pro allowance, not 8,000 images', async () => {
    const account = await subscriber('starter');
    await useImages(account, STARTER);
    const at = PERIOD.end - HOUR;
    vi.setSystemTime(at);
    expect((await chargeRender(db, await userRow(account.userId), render(), at)).status).toBe('quota_exceeded');

    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at }));
    const usage = await usageNow(account, at + MINUTE);
    const extra = Math.ceil(((PRO - STARTER) * HOUR) / (PERIOD.end - PERIOD.start));
    expect(usage).toMatchObject({ plan: 'pro', used: STARTER });
    expect(usage.limit).toBeGreaterThanOrEqual(STARTER + extra - 1);
    expect(usage.limit).toBeLessThanOrEqual(STARTER + extra + 1);

    // The few images that hour paid for can be used, and then it stops again.
    for (let i = 0; i < usage.limit - STARTER; i++) {
      expect((await chargeRender(db, await userRow(account.userId), render(), at + MINUTE)).status).toBe('charged');
    }
    expect((await chargeRender(db, await userRow(account.userId), render(), at + MINUTE)).status).toBe('quota_exceeded');
  });

  it('an upgrade at the start of the period gives the whole Pro allowance', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at: PERIOD.start }));
    expect((await usageNow(account, PERIOD.start + MINUTE)).limit).toBe(PRO);
  });

  it('a downgrade keeps the allowance already paid for until the period ends, then the new plan applies', async () => {
    const account = await subscriber('pro');
    await useImages(account, 5000);
    const halfway = PERIOD.start + (PERIOD.end - PERIOD.start) / 2;
    vi.setSystemTime(halfway);
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.starter], at: halfway }));
    expect(await usageNow(account, halfway + MINUTE)).toMatchObject({ plan: 'starter', limit: PRO, used: 5000, remaining: PRO - 5000 });

    const renewed = { start: PERIOD.end, end: PERIOD.end + 30 * DAY_MS };
    vi.setSystemTime(renewed.start + MINUTE);
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.starter], period: renewed, at: renewed.start }));
    expect(await usageNow(account, renewed.start + 2 * MINUTE)).toMatchObject({ plan: 'starter', limit: STARTER, used: 0 });
  });

  it('upgrade then downgrade in the same period: the downgrade keeps what the upgrade paid for, nothing more', async () => {
    const account = await subscriber('starter');
    const quarter = PERIOD.start + (PERIOD.end - PERIOD.start) / 4;
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at: quarter }));
    const afterUpgrade = (await usageNow(account, quarter + MINUTE)).limit;
    expect(afterUpgrade).toBe(STARTER + ((PRO - STARTER) * 3) / 4);

    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.starter], at: quarter + HOUR }));
    expect((await usageNow(account, quarter + 2 * HOUR)).limit).toBe(afterUpgrade);
  });

  it('a redelivered or late copy of the plan change does not adjust the allowance again', async () => {
    const account = await subscriber('starter');
    const at = PERIOD.start + (PERIOD.end - PERIOD.start) / 2;
    const change = subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at });
    await apply(change);
    const once = (await usageNow(account, at + MINUTE)).limit;
    expect(once).toBe(STARTER + (PRO - STARTER) / 2);

    // The same change under another event id (Paddle can send several events for one change).
    await apply({ ...structuredClone(change), event_id: nextId('evt') });
    // An older event for the previous plan arrives late: refused by the ordering guard.
    expect(await deliver(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.starter], at: at - HOUR }))).toMatchObject({ status: 200 });
    expect((await usageNow(account, at + 2 * MINUTE)).limit).toBe(once);
    expect((await storedRow(account.userId)).plan).toBe('pro');
  });
});
