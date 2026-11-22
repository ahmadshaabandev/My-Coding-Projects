// Billing review: the money rules the owner stated, attacked with hostile and
// out-of-order Paddle events. Payloads are Paddle's official examples
// (tests/fixtures/paddle) with ids, prices, status and dates replaced.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP, effectivePlanId } from '../src/billing/plans';
import { DAY_MS } from '../src/config';
import { all, first, getUserById, run } from '../src/db/client';
import { hmacSha256Hex } from '../src/lib/crypto';
import { chargeRender, creditTopup, currentPeriod, getUsage, type RenderCharge } from '../src/lib/quota';
import { paddleWebhookRouter } from '../src/routes/webhooks/paddle';
import type { TopupRow, UserRow } from '../src/types';
import { apiKeyFor, bearer, call, dashboard, requestUrl, sessionCookieFor } from './app-helpers';
import adjustmentUpdated from './fixtures/paddle/adjustment.updated.json';
import subscriptionCanceled from './fixtures/paddle/subscription.canceled.json';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';
import subscriptionPastDue from './fixtures/paddle/subscription.past_due.json';
import subscriptionPaused from './fixtures/paddle/subscription.paused.json';
import subscriptionResumed from './fixtures/paddle/subscription.resumed.json';
import subscriptionTrialing from './fixtures/paddle/subscription.trialing.json';
import subscriptionUpdated from './fixtures/paddle/subscription.updated.json';
import transactionCompleted from './fixtures/paddle/transaction.completed.json';

interface PaddleFixture {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

const db = env.DB;
const NOW = Date.UTC(2026, 10, 22, 12);
const MINUTE = 60_000;
const SECRET = env.PADDLE_WEBHOOK_SECRET ?? '';
const PRICE = { starter: env.PADDLE_PRICE_STARTER ?? '', pro: env.PADDLE_PRICE_PRO ?? '', topup: env.PADDLE_PRICE_TOPUP ?? '' };
/** The billing period every subscription event below carries unless it says otherwise. */
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
const nextId = (prefix: string): string => `${prefix}_rb${String(++sequence).padStart(4, '0')}`;

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

/** The row exactly as stored, without any read-time correction. */
async function storedRow(userId: string): Promise<UserRow> {
  const user = await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?1', userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

interface Changes {
  userId?: string;
  priceIds?: string[];
  quantity?: number;
  status?: string;
  at?: number;
  scheduledCancelAt?: number;
  period?: { start: number; end: number } | null;
  currency?: string;
}

function subscriptionEvent(fixture: PaddleFixture, account: Account, changes: Changes = {}): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  event.occurred_at = new Date(changes.at ?? NOW).toISOString();
  event.data.id = account.subscriptionId;
  event.data.customer_id = account.customerId;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  const template = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[0]!;
  event.data.items = (changes.priceIds ?? [PRICE.starter]).map((id) => ({
    ...structuredClone(template),
    price: { ...template.price, id },
    quantity: changes.quantity ?? 1,
  }));
  if (changes.status) event.data.status = changes.status;
  if (changes.currency) event.data.currency_code = changes.currency;
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

function topupEvent(account: Account, changes: { userId?: string; transactionId?: string; quantity?: number } = {}): PaddleFixture {
  const event = structuredClone(transactionCompleted) as PaddleFixture;
  event.event_id = nextId('evt');
  event.occurred_at = new Date(NOW).toISOString();
  event.data.id = changes.transactionId ?? nextId('txn');
  event.data.customer_id = account.customerId;
  event.data.subscription_id = null;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  const oneTime = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[2]!;
  oneTime.price.id = PRICE.topup;
  oneTime.quantity = changes.quantity ?? 1;
  return event;
}

async function sign(body: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return `ts=${timestamp};h1=${await hmacSha256Hex(SECRET, `${timestamp}:${body}`)}`;
}

async function deliver(event: PaddleFixture): Promise<{ status: number; result?: string; duplicate?: boolean }> {
  const raw = JSON.stringify(event);
  const response = await paddleWebhookRouter.request(
    '/paddle',
    { method: 'POST', headers: { 'content-type': 'application/json', 'Paddle-Signature': await sign(raw) }, body: raw },
    env,
  );
  const body = (await response.json()) as { result?: string; duplicate?: boolean };
  return { status: response.status, ...body };
}

async function apply(event: PaddleFixture): Promise<void> {
  expect(await deliver(event)).toEqual({ status: 200, ok: true, result: 'ok' });
}

/** A Starter (or Pro) subscriber whose checkout carried their own account id. */
async function subscriber(plan: 'starter' | 'pro' = 'starter', at: number = NOW - 10 * DAY_MS): Promise<Account> {
  const account = await makeAccount();
  await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceIds: [PRICE[plan]], at }));
  return account;
}

function render(cacheKey: string = nextId('ck')): RenderCharge {
  return {
    cacheKey,
    siteId: null,
    source: 'api',
    template: 'inline',
    width: 1200,
    height: 630,
    format: 'png',
    bytes: 1000,
    r2Key: `renders/${cacheKey}.png`,
    ttlMs: 7 * DAY_MS,
  };
}

async function setUsed(userId: string, used: number, now: number): Promise<void> {
  const period = currentPeriod(await userRow(userId), now);
  await run(
    db,
    `INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id, period_start) DO UPDATE SET used = excluded.used`,
    userId,
    period.start,
    period.end,
    used,
  );
}

describe('cancellation at period end needs no further webhook', () => {
  it('the plan stays until cancel_at and is Free one second later, even if subscription.canceled never arrives', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - DAY_MS, scheduledCancelAt: PERIOD.end }));
    const key = await apiKeyFor(account.userId);
    const usageAt = async (now: number): Promise<Record<string, unknown>> => {
      vi.setSystemTime(now);
      const response = await call('/v1/usage', { headers: bearer(key.secret) });
      expect(response.status).toBe(200);
      return response.json();
    };

    await setUsed(account.userId, 150, PERIOD.end - 1000);
    expect(await usageAt(PERIOD.end - 1000)).toMatchObject({
      plan: 'starter',
      limit: PLANS.starter.monthlyImages,
      used: 150,
      period_end: new Date(PERIOD.end).toISOString(),
    });
    const before = await chargeRender(db, await userRow(account.userId), render(), PERIOD.end - 1000);
    expect(before.status).toBe('charged');

    // One second after the paid period: no event has arrived, and none is needed.
    const after = await usageAt(PERIOD.end + 1000);
    expect(after).toMatchObject({ plan: 'free', limit: PLANS.free.monthlyImages, used: 0, watermark: true });
    expect(after.period_start).toBe(new Date(Date.UTC(2026, 11, 1)).toISOString());

    // The stored row has caught up, so everything that reads users.plan agrees (watermark, fonts, dashboard).
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'free', subscription_status: 'canceled', cancel_at: null, period_end: null });

    // The Free hard stop applies: 100 images, then 402 territory.
    const user = await userRow(account.userId);
    await setUsed(account.userId, PLANS.free.monthlyImages, PERIOD.end + 1000);
    expect((await chargeRender(db, user, render(), PERIOD.end + 1000)).status).toBe('quota_exceeded');
  });

  it('the quota enforcer itself refuses the paid allowance after cancel_at, whatever row it is handed', async () => {
    const stale = { id: nextId('u'), plan: 'starter' as const, period_start: PERIOD.start, period_end: PERIOD.end, cancel_at: PERIOD.end };
    expect(effectivePlanId(stale, PERIOD.end - 1)).toBe('starter');
    expect(effectivePlanId(stale, PERIOD.end)).toBe('free');
    expect(effectivePlanId({ plan: 'pro', cancel_at: null }, PERIOD.end)).toBe('pro');
    expect((await getUsage(db, stale, PERIOD.end)).limit).toBe(PLANS.free.monthlyImages);
  });

  it('a late subscription.canceled after the automatic return to Free changes nothing, and an un-cancel restores the plan', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - DAY_MS, scheduledCancelAt: PERIOD.end }));
    await getUsage(db, await userRow(account.userId), PERIOD.end + MINUTE);
    expect((await storedRow(account.userId)).plan).toBe('free');

    // The customer had in fact removed the cancellation; that event was delayed and Paddle renewed.
    vi.setSystemTime(PERIOD.end + 2 * MINUTE);
    const renewed = { start: PERIOD.end, end: PERIOD.end + 30 * DAY_MS };
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: PERIOD.end + MINUTE, period: renewed }));
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'starter', subscription_status: 'active', cancel_at: null, period_end: renewed.end });

    const other = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, other, { at: NOW - DAY_MS, scheduledCancelAt: PERIOD.end }));
    await getUsage(db, await userRow(other.userId), PERIOD.end + MINUTE);
    await apply(subscriptionEvent(subscriptionCanceled, other, { status: 'canceled', at: PERIOD.end + MINUTE }));
    expect(await storedRow(other.userId)).toMatchObject({ plan: 'free', subscription_status: 'canceled' });
  });

  it('scheduled cancel then un-cancel inside the period keeps the plan past the old cancel date', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - 2 * DAY_MS, scheduledCancelAt: PERIOD.end }));
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - DAY_MS }));
    expect((await getUsage(db, await userRow(account.userId), PERIOD.end + MINUTE)).plan).toBe('starter');
    expect((await storedRow(account.userId)).plan).toBe('starter');
  });
});

describe('an account id in custom_data is not proof of ownership', () => {
  it('a stranger\'s subscription carrying a paying customer\'s account id cannot replace or end that customer\'s plan', async () => {
    const victim = await subscriber('pro');
    const attacker: Account = { userId: victim.userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };

    expect(await deliver(subscriptionEvent(subscriptionCreated, attacker, { userId: victim.userId, priceIds: [PRICE.starter] }))).toMatchObject({
      status: 200,
      result: 'ignored:other_subscription',
    });
    expect(await storedRow(victim.userId)).toMatchObject({
      plan: 'pro',
      paddle_subscription_id: victim.subscriptionId,
      paddle_customer_id: victim.customerId,
      period_start: PERIOD.start,
    });

    expect(
      await deliver(subscriptionEvent(subscriptionCanceled, attacker, { userId: victim.userId, status: 'canceled', at: NOW + MINUTE })),
    ).toMatchObject({ result: 'ignored:other_subscription' });
    expect((await storedRow(victim.userId)).plan).toBe('pro');

    // The victim's own subscription keeps working afterwards (the ordering guard was not poisoned).
    await apply(subscriptionEvent(subscriptionUpdated, victim, { priceIds: [PRICE.starter], at: NOW + 2 * MINUTE }));
    expect((await storedRow(victim.userId)).plan).toBe('starter');
  });

  it('a second subscription is mirrored once the first one has ended', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionCanceled, account, { status: 'canceled', at: NOW - DAY_MS }));
    const second: Account = { ...account, subscriptionId: nextId('sub') };
    await apply(subscriptionEvent(subscriptionCreated, second, { userId: account.userId, priceIds: [PRICE.pro] }));
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'pro', paddle_subscription_id: second.subscriptionId });
  });

  it('a new subscription is accepted when the mirrored one is past its scheduled cancellation', async () => {
    const account = await subscriber('starter');
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW - DAY_MS, scheduledCancelAt: NOW - MINUTE }));
    const second: Account = { ...account, subscriptionId: nextId('sub') };
    await apply(subscriptionEvent(subscriptionCreated, second, { userId: account.userId, priceIds: [PRICE.pro] }));
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'pro', paddle_subscription_id: second.subscriptionId, cancel_at: null });
  });

  it('a Paddle customer that belongs to one account is never attached to another account', async () => {
    const victim = await subscriber('starter');
    const intruder = await makeAccount();
    // A checkout opened with the victim's email lands on the victim's Paddle customer, but carries the intruder's account id.
    const forged: Account = { userId: intruder.userId, customerId: victim.customerId, subscriptionId: nextId('sub') };
    await apply(subscriptionEvent(subscriptionCreated, forged, { userId: intruder.userId }));
    await apply(topupEvent(forged, { userId: intruder.userId }));
    expect(await storedRow(intruder.userId)).toMatchObject({ plan: 'starter', paddle_customer_id: null });
    expect((await storedRow(victim.userId)).paddle_customer_id).toBe(victim.customerId);

    // So "Manage billing" can never mint a portal session for somebody else's Paddle customer.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      throw new Error(`unexpected outbound request to ${requestUrl(input).href}`);
    });
    const response = await dashboard(await sessionCookieFor(intruder.userId), 'POST', '/api/billing/portal', {});
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a top-up paid with a forged account id is a gift, and cannot be bought twice by replay', async () => {
    const victim = await subscriber('starter');
    const stranger: Account = { userId: victim.userId, customerId: nextId('ctm'), subscriptionId: '' };
    const event = topupEvent(stranger, { userId: victim.userId, quantity: 2 });
    await apply(event);
    expect(await deliver(event)).toMatchObject({ status: 200, duplicate: true });
    expect(await deliver({ ...event, event_id: nextId('evt') })).toMatchObject({ result: 'ignored:already_credited' });
    const topups = await all<TopupRow>(db, 'SELECT * FROM topups WHERE user_id = ?1', victim.userId);
    expect(topups.map((topup) => topup.remaining)).toEqual([2 * TOPUP.images]);
    expect((await storedRow(victim.userId)).paddle_customer_id).toBe(victim.customerId);
  });
});

describe('hostile and unusual subscription payloads', () => {
  it('two plan items: the higher plan wins whatever their order', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceIds: [PRICE.starter, PRICE.pro] }));
    expect(await storedRow(account.userId)).toMatchObject({ plan: 'pro', subscription_price_id: PRICE.pro });
  });

  it('quantity above 1 and a currency other than USD grant the plan once: the price id decides, not the amount', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, quantity: 5, currency: 'EUR' }));
    expect((await getUsage(db, await userRow(account.userId), NOW)).limit).toBe(PLANS.starter.monthlyImages);
  });

  it('status walk: trialing, active, past_due keep the plan; paused and canceled end it; resumed brings it back', async () => {
    const account = await makeAccount();
    const step = async (fixture: PaddleFixture, status: string, minute: number, plan: string): Promise<void> => {
      await apply(subscriptionEvent(fixture, account, { userId: account.userId, status, at: NOW + minute * MINUTE }));
      expect((await storedRow(account.userId)).plan, status).toBe(plan);
    };
    await step(subscriptionTrialing, 'trialing', 1, 'starter');
    await step(subscriptionUpdated, 'active', 2, 'starter');
    await step(subscriptionPastDue, 'past_due', 3, 'starter');
    await step(subscriptionPaused, 'paused', 4, 'free');
    await step(subscriptionResumed, 'active', 5, 'starter');
    await step(subscriptionCanceled, 'canceled', 6, 'free');
    // An older "active" delivered late must not resurrect it.
    expect(await deliver(subscriptionEvent(subscriptionUpdated, account, { userId: account.userId, at: NOW + 5 * MINUTE }))).toMatchObject({
      result: 'ignored:stale',
    });
    expect((await storedRow(account.userId)).plan).toBe('free');
  });

  it('plan change down mid-period keeps the period, what was used and the allowance paid for; up again adds nothing more', async () => {
    const account = await subscriber('pro');
    await setUsed(account.userId, 2500, NOW);
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.starter], at: NOW + MINUTE }));
    // A downgrade is not credited (do_not_bill), so the Pro allowance stays until the period ends.
    expect(await getUsage(db, await userRow(account.userId), NOW)).toMatchObject({
      plan: 'starter',
      used: 2500,
      limit: PLANS.pro.monthlyImages,
      remaining: PLANS.pro.monthlyImages - 2500,
      period_start: PERIOD.start,
    });
    expect((await chargeRender(db, await userRow(account.userId), render(), NOW)).status).toBe('charged');
    // Back to Pro: the period already holds the Pro allowance, so the upgrade adds nothing
    // (the dashboard sends it as do_not_bill). Otherwise every down-and-up cycle would re-sell it.
    const at = NOW + 2 * MINUTE;
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at }));
    expect(await getUsage(db, await userRow(account.userId), at)).toMatchObject({ plan: 'pro', limit: PLANS.pro.monthlyImages });
  });
});

describe('quota periods at the edges', () => {
  it('upgrade mid-month starts the paid period at zero; the return to Free finds the calendar month it left', async () => {
    const account = await makeAccount();
    await setUsed(account.userId, 100, NOW);
    expect((await chargeRender(db, await userRow(account.userId), render(), NOW)).status).toBe('quota_exceeded');

    const period = { start: NOW, end: NOW + 30 * DAY_MS };
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, period }));
    expect(await getUsage(db, await userRow(account.userId), NOW + MINUTE)).toMatchObject({ plan: 'starter', used: 0, remaining: 2000 });

    // Immediate cancellation in the same calendar month: the Free month is still used up, not refilled.
    await apply(subscriptionEvent(subscriptionCanceled, account, { status: 'canceled', at: NOW + 2 * MINUTE }));
    expect(await getUsage(db, await userRow(account.userId), NOW + 3 * MINUTE)).toMatchObject({ plan: 'free', used: 100, remaining: 0 });
  });

  it('a refunded top-up that is partly used stops at once and never goes negative', async () => {
    const account = await subscriber('starter');
    const user = await userRow(account.userId);
    await creditTopup(db, { userId: user.id, transactionId: 'txn_rb_partly_used', images: TOPUP.images, now: NOW });
    await setUsed(user.id, PLANS.starter.monthlyImages, NOW);
    expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ status: 'charged', chargedTo: 'topup' });

    const refund = structuredClone(adjustmentUpdated) as PaddleFixture;
    refund.event_id = nextId('evt');
    Object.assign(refund.data, { transaction_id: 'txn_rb_partly_used', subscription_id: null, action: 'refund', type: 'full', status: 'approved' });
    await apply(refund);
    expect(await getUsage(db, user, NOW)).toMatchObject({ topup_remaining: 0, total_remaining: 0 });
    expect((await chargeRender(db, user, render(), NOW)).status).toBe('quota_exceeded');
    const [topup] = await all<TopupRow>(db, 'SELECT * FROM topups WHERE user_id = ?1', user.id);
    expect(topup).toMatchObject({ remaining: TOPUP.images - 1 });
    expect(topup?.refunded_at).not.toBeNull();
  });
});

describe('quota emails after a plan change inside one period', () => {
  it('an account warned at Starter levels is warned again at 90% and 100% of the Pro allowance, once each', async () => {
    const account = await subscriber('starter');
    const starter = await userRow(account.userId);
    await setUsed(starter.id, PLANS.starter.monthlyImages - 1, NOW);
    expect(await chargeRender(db, starter, render(), NOW)).toMatchObject({ crossed90: true, crossed100: true });

    await apply(subscriptionEvent(subscriptionUpdated, account, { priceIds: [PRICE.pro], at: NOW + MINUTE }));
    const pro = await userRow(account.userId);
    expect(await chargeRender(db, pro, render(), NOW)).toMatchObject({ status: 'charged', crossed90: false, crossed100: false });

    // The allowance after a mid-period upgrade is time-weighted (see the plan-change tests).
    const { limit } = await getUsage(db, pro, NOW);
    expect(limit).toBeGreaterThan(PLANS.starter.monthlyImages);
    await setUsed(pro.id, Math.ceil(limit * 0.9) - 1, NOW);
    expect(await chargeRender(db, pro, render(), NOW)).toMatchObject({ crossed90: true, crossed100: false });
    expect(await chargeRender(db, pro, render(), NOW)).toMatchObject({ crossed90: false, crossed100: false });
    await setUsed(pro.id, limit - 1, NOW);
    expect(await chargeRender(db, pro, render(), NOW)).toMatchObject({ crossed90: false, crossed100: true });
  });

  it('buying a top-up does not repeat a warning', async () => {
    const account = await subscriber('starter');
    const user = await userRow(account.userId);
    await setUsed(user.id, PLANS.starter.monthlyImages - 1, NOW);
    expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ crossed100: true });
    await creditTopup(db, { userId: user.id, transactionId: nextId('txn'), images: TOPUP.images, now: NOW });
    expect(await chargeRender(db, user, render(), NOW)).toMatchObject({ chargedTo: 'topup', crossed90: false, crossed100: false });
  });
});

describe('webhook route', () => {
  it('refuses an oversized body before reading or hashing it', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const text = vi.spyOn(Request.prototype, 'text');
    const response = await paddleWebhookRouter.request(
      '/paddle',
      { method: 'POST', headers: { 'content-type': 'application/json', 'Paddle-Signature': 'ts=1;h1=00' }, body: huge },
      env,
    );
    expect(response.status).toBe(413);
    expect(text).not.toHaveBeenCalled();
  });

  it('verifies the exact bytes: a re-serialised body with the same meaning is rejected', async () => {
    const account = await makeAccount();
    const event = subscriptionEvent(subscriptionCreated, account, { userId: account.userId });
    const raw = JSON.stringify(event);
    const pretty = JSON.stringify(event, null, 1);
    const signature = await sign(raw);
    const post = (body: string): Promise<Response> =>
      Promise.resolve(paddleWebhookRouter.request('/paddle', { method: 'POST', headers: { 'Paddle-Signature': signature }, body }, env));
    expect((await post(pretty)).status).toBe(401);
    expect((await post(raw)).status).toBe(200);
  });
});
