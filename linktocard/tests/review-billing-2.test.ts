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
  // Paddle prorates both directions to the minute (prorated_immediately), but
  // the allowance switches in full. See the billing-2 review: needs a stored
  // per-period allowance adjustment (a migration) before it can be pinned.
  it.todo('an upgrade one hour before the period ends adds about one hour of the Pro allowance, not 8,000 images');
  it.todo('a downgrade after using the Pro allowance leaves only the time-weighted allowance');
});
