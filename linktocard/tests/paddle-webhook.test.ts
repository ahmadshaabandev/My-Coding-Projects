// Paddle webhooks, entitlements and the REST client. Payloads are Paddle's
// official examples (tests/fixtures/paddle, copied from the OpenAPI spec) with
// only ids, prices, status and dates replaced, signed here with the test secret.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDLED_EVENT_TYPES,
  WEBHOOK_TOLERANCE_SECONDS,
  applyPaddleEvent,
  changeSubscriptionPlan,
  createPortalSession,
  paddleClientConfig,
  parsePaddleEvent,
  parseTimestamp,
  planForPriceId,
  verifyPaddleSignature,
  webhookSecrets,
} from '../src/billing/paddle';
import { TOPUP } from '../src/billing/plans';
import { DAY_MS } from '../src/config';
import { all, first, getUserById, run } from '../src/db/client';
import { hmacSha256Hex } from '../src/lib/crypto';
import { ApiError } from '../src/lib/errors';
import { getUsage } from '../src/lib/quota';
import { paddleWebhookRouter } from '../src/routes/webhooks/paddle';
import type { Env, TopupRow, UserRow } from '../src/types';
import adjustmentCreated from './fixtures/paddle/adjustment.created.json';
import adjustmentUpdated from './fixtures/paddle/adjustment.updated.json';
import subscriptionActivated from './fixtures/paddle/subscription.activated.json';
import subscriptionCanceled from './fixtures/paddle/subscription.canceled.json';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';
import subscriptionPastDue from './fixtures/paddle/subscription.past_due.json';
import subscriptionPaused from './fixtures/paddle/subscription.paused.json';
import subscriptionResumed from './fixtures/paddle/subscription.resumed.json';
import subscriptionTrialing from './fixtures/paddle/subscription.trialing.json';
import subscriptionUpdated from './fixtures/paddle/subscription.updated.json';
import transactionCompleted from './fixtures/paddle/transaction.completed.json';
import transactionPaid from './fixtures/paddle/transaction.paid.json';

interface PaddleFixture {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

interface AuditRow {
  event_id: string;
  event_type: string;
  occurred_at: number | null;
  received_at: number;
  processed_at: number | null;
  user_id: string | null;
  result: string | null;
}

const db = env.DB;
const NOW = Date.UTC(2026, 10, 22, 12);
const MINUTE = 60_000;
const SECRET = env.PADDLE_WEBHOOK_SECRET ?? '';
const PRICE = {
  starter: env.PADDLE_PRICE_STARTER ?? '',
  pro: env.PADDLE_PRICE_PRO ?? '',
  topup: env.PADDLE_PRICE_TOPUP ?? '',
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let sequence = 0;
/** Storage is shared by the whole file, so every id is unique. */
const nextId = (prefix: string): string => `${prefix}_test${String(++sequence).padStart(4, '0')}`;

/** A Free account plus the Paddle ids its checkout will produce. */
interface Account {
  userId: string;
  customerId: string;
  subscriptionId: string;
}

async function makeAccount(): Promise<Account> {
  const userId = nextId('u');
  await run(db, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, ?3, 'free')", userId, `${userId}@example.com`, NOW - DAY_MS);
  return { userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };
}

async function userRow(userId: string): Promise<UserRow> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

const topupsOf = (userId: string): Promise<TopupRow[]> => all<TopupRow>(db, 'SELECT * FROM topups WHERE user_id = ?1', userId);

async function audit(eventId: string): Promise<AuditRow | null> {
  return first<AuditRow>(db, 'SELECT * FROM webhook_events WHERE event_id = ?1', eventId);
}

interface SubscriptionChanges {
  /** Sent as custom_data.user_id, the way our checkout does. Omitted = custom_data null. */
  userId?: string;
  priceId?: string;
  status?: string;
  /** occurred_at */
  at?: number;
  scheduledCancelAt?: number;
}

function subscriptionEvent(fixture: PaddleFixture, account: Account, changes: SubscriptionChanges = {}): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  event.occurred_at = new Date(changes.at ?? NOW).toISOString();
  event.data.id = account.subscriptionId;
  event.data.customer_id = account.customerId;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  // Only the first item is ours; the fixture's other items keep Paddle's example price ids.
  (event.data.items as Array<{ price: { id: string } }>)[0]!.price.id = changes.priceId ?? PRICE.starter;
  if (changes.status) event.data.status = changes.status;
  if (changes.scheduledCancelAt) {
    event.data.scheduled_change = { action: 'cancel', effective_at: new Date(changes.scheduledCancelAt).toISOString(), resume_at: null };
  }
  return event;
}

/** The official transaction examples have three items; the third is a one-time price, which becomes the top-up. */
function transactionEvent(
  fixture: PaddleFixture,
  account: Account,
  changes: { userId?: string; transactionId?: string; quantity?: number; topup?: boolean } = {},
): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  event.occurred_at = new Date(NOW).toISOString();
  event.data.id = changes.transactionId ?? nextId('txn');
  event.data.customer_id = account.customerId;
  event.data.subscription_id = null;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  const oneTime = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[2]!;
  if (changes.topup !== false) oneTime.price.id = PRICE.topup;
  oneTime.quantity = changes.quantity ?? 1;
  return event;
}

function adjustmentEvent(fixture: PaddleFixture, transactionId: string, changes: Record<string, unknown>): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  Object.assign(event.data, { transaction_id: transactionId, subscription_id: null, ...changes });
  return event;
}

async function sign(body: string, secret: string = SECRET, timestamp: number = Math.floor(Date.now() / 1000)): Promise<string> {
  return `ts=${timestamp};h1=${await hmacSha256Hex(secret, `${timestamp}:${body}`)}`;
}

function post(body: string, signature: string | null, bindings: Env = env): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['Paddle-Signature'] = signature;
  return Promise.resolve(paddleWebhookRouter.request('/paddle', { method: 'POST', headers, body }, bindings));
}

interface Delivery {
  status: number;
  body: { ok?: boolean; result?: string; duplicate?: boolean; error?: { code: string } };
}

async function deliver(event: PaddleFixture, bindings: Env = env): Promise<Delivery> {
  const raw = JSON.stringify(event);
  const response = await post(raw, await sign(raw), bindings);
  return { status: response.status, body: await response.json() };
}

/** Delivers and insists the event was applied. */
async function apply(event: PaddleFixture): Promise<void> {
  expect(await deliver(event)).toEqual({ status: 200, body: { ok: true, result: 'ok' } });
}

/** An event the handler has no use for: a correctly signed transaction.paid. */
const unhandledEvent = (): PaddleFixture => transactionEvent(transactionPaid, { userId: 'u_nobody', customerId: nextId('ctm'), subscriptionId: '' });

describe('signature', () => {
  it('accepts a correctly signed event', async () => {
    const result = await deliver(unhandledEvent());
    expect(result).toEqual({ status: 200, body: { ok: true, result: 'ignored:unhandled' } });
  });

  it('rejects a wrong secret, an altered body, a missing header and a malformed header', async () => {
    const event = unhandledEvent();
    const raw = JSON.stringify(event);
    const responses = [
      await post(raw, await sign(raw, 'pdl_ntfset_some_other_secret')),
      await post(raw.replace('"paid"', '"completed"'), await sign(raw)),
      await post(raw, null),
      await post(raw, 'h1=only-a-hash'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(((await response.json()) as Delivery['body']).error?.code).toBe('unauthorized');
    }
    expect(await audit(event.event_id)).toBeNull();
  });

  it('rejects a timestamp outside the tolerance in either direction and accepts one at the edge', async () => {
    const seconds = NOW / 1000;
    const raw = JSON.stringify(unhandledEvent());
    expect((await post(raw, await sign(raw, SECRET, seconds - WEBHOOK_TOLERANCE_SECONDS - 1))).status).toBe(401);
    expect((await post(raw, await sign(raw, SECRET, seconds + WEBHOOK_TOLERANCE_SECONDS + 1))).status).toBe(401);
    expect((await post(raw, await sign(raw, SECRET, seconds - WEBHOOK_TOLERANCE_SECONDS))).status).toBe(200);
  });

  it('accepts two h1 values when one of them is valid', async () => {
    const raw = JSON.stringify(unhandledEvent());
    const [timestamp, valid] = (await sign(raw)).split(';');
    expect((await post(raw, `${timestamp};h1=${'0'.repeat(64)};${valid}`)).status).toBe(200);
    expect((await post(raw, `${timestamp};h1=${'0'.repeat(64)};h1=${'1'.repeat(64)}`)).status).toBe(401);
  });

  it('accepts either secret while two are configured for a rotation', async () => {
    const rotating: Env = { ...env, PADDLE_WEBHOOK_SECRET: `${SECRET}, pdl_ntfset_next_secret` };
    expect(webhookSecrets(rotating)).toEqual([SECRET, 'pdl_ntfset_next_secret']);
    const raw = JSON.stringify(unhandledEvent());
    expect((await post(raw, await sign(raw, 'pdl_ntfset_next_secret'), rotating)).status).toBe(200);
    expect((await post(raw, await sign(raw, 'pdl_ntfset_next_secret'))).status).toBe(401);
  });

  it('answers 503 until the secret is configured, so Paddle keeps retrying', async () => {
    const event = unhandledEvent();
    const raw = JSON.stringify(event);
    for (const secret of [undefined, '']) {
      const response = await post(raw, await sign(raw), { ...env, PADDLE_WEBHOOK_SECRET: secret });
      expect(response.status).toBe(503);
      expect(((await response.json()) as Delivery['body']).error?.code).toBe('not_configured');
    }
    expect(await audit(event.event_id)).toBeNull();
  });

  it('answers 400 to a signed body that is not an event', async () => {
    for (const raw of ['{"event_id": "evt_broken", ', '[]', JSON.stringify({ event_id: 'evt_x', event_type: 'subscription.created' })]) {
      const response = await post(raw, await sign(raw));
      expect(response.status).toBe(400);
    }
  });

  it('reports why a signature failed', async () => {
    const body = '{"a":1}';
    const header = await sign(body);
    expect(await verifyPaddleSignature(body, header, [SECRET], NOW)).toBe('valid');
    expect(await verifyPaddleSignature(body, header, ['another-secret'], NOW)).toBe('mismatch');
    expect(await verifyPaddleSignature(body, header, [], NOW)).toBe('mismatch');
    expect(await verifyPaddleSignature(body, header, [SECRET], NOW + 301_000)).toBe('stale');
    for (const malformed of [null, undefined, '', 'ts=abc;h1=00', `ts=${NOW / 1000}`]) {
      expect(await verifyPaddleSignature(body, malformed, [SECRET], NOW)).toBe('malformed');
    }
  });
});

describe('subscriptions', () => {
  it('Starter checkout: subscription.created with custom_data.user_id moves the account to Starter and stores the billing period', async () => {
    const account = await makeAccount();
    const event = subscriptionEvent(subscriptionCreated, account, { userId: account.userId, at: NOW - MINUTE });
    await apply(event);

    expect(await userRow(account.userId)).toMatchObject({
      plan: 'starter',
      paddle_customer_id: account.customerId,
      paddle_subscription_id: account.subscriptionId,
      subscription_status: 'active',
      subscription_price_id: PRICE.starter,
      // current_billing_period of the official example (microseconds are truncated to ms).
      period_start: Date.UTC(2024, 3, 12, 10, 18, 47, 635),
      period_end: Date.UTC(2024, 4, 12, 10, 18, 47, 635),
      cancel_at: null,
      subscription_event_at: NOW - MINUTE,
    });
    expect(await audit(event.event_id)).toEqual({
      event_id: event.event_id,
      event_type: 'subscription.created',
      occurred_at: NOW - MINUTE,
      received_at: NOW,
      processed_at: NOW,
      user_id: account.userId,
      result: 'ok',
    });
  });

  it('upgrade to Pro: subscription.updated with the Pro price, matched by subscription id', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionUpdated, account, { priceId: PRICE.pro, at: NOW + MINUTE }));

    expect(await userRow(account.userId)).toMatchObject({
      plan: 'pro',
      subscription_price_id: PRICE.pro,
      period_start: Date.UTC(2024, 3, 12, 10, 37, 59, 556),
      period_end: Date.UTC(2024, 4, 12, 10, 37, 59, 556),
    });
  });

  it('scheduled cancel keeps the plan and sets cancel_at; undoing it clears cancel_at', async () => {
    const account = await makeAccount();
    const periodEnd = NOW + 20 * DAY_MS;
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW + MINUTE, scheduledCancelAt: periodEnd }));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'starter', subscription_status: 'active', cancel_at: periodEnd });

    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW + 2 * MINUTE }));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'starter', cancel_at: null });
  });

  it('subscription.canceled at the end of the period returns the account to Free', async () => {
    const account = await makeAccount();
    const periodEnd = NOW + 20 * DAY_MS;
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionUpdated, account, { at: NOW + MINUTE, scheduledCancelAt: periodEnd }));
    await apply(subscriptionEvent(subscriptionCanceled, account, { at: periodEnd }));

    expect(await userRow(account.userId)).toMatchObject({
      plan: 'free',
      subscription_status: 'canceled',
      paddle_subscription_id: account.subscriptionId,
      period_start: null,
      period_end: null,
      cancel_at: null,
      subscription_event_at: periodEnd,
    });
  });

  it('immediate cancel: subscription.canceled with no scheduled change returns the account to Free at once', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceId: PRICE.pro }));
    expect((await userRow(account.userId)).plan).toBe('pro');
    await apply(subscriptionEvent(subscriptionCanceled, account, { priceId: PRICE.pro, at: NOW + MINUTE }));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'free', subscription_status: 'canceled', period_end: null });
  });

  it('past_due keeps access while Paddle retries the payment', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionPastDue, account, { at: NOW + 30 * DAY_MS }));

    expect(await userRow(account.userId)).toMatchObject({
      plan: 'starter',
      subscription_status: 'past_due',
      period_start: Date.UTC(2024, 4, 12, 10, 18, 47, 635),
      period_end: Date.UTC(2024, 5, 12, 10, 18, 47, 635),
    });
  });

  it('payment recovered: subscription.updated back to active after past_due', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionPastDue, account, { at: NOW + 30 * DAY_MS }));
    await apply(subscriptionEvent(subscriptionUpdated, account, { status: 'active', at: NOW + 32 * DAY_MS }));

    expect(await userRow(account.userId)).toMatchObject({ plan: 'starter', subscription_status: 'active' });
  });

  it('out-of-order delivery: an older subscription.updated arriving after subscription.canceled is ignored', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionCanceled, account, { at: NOW + 2 * MINUTE }));

    const late = subscriptionEvent(subscriptionUpdated, account, { userId: account.userId, priceId: PRICE.pro, at: NOW + MINUTE });
    expect(await deliver(late)).toEqual({ status: 200, body: { ok: true, result: 'ignored:stale' } });
    expect(await userRow(account.userId)).toMatchObject({ plan: 'free', subscription_status: 'canceled', subscription_event_at: NOW + 2 * MINUTE });
    expect(await audit(late.event_id)).toMatchObject({ processed_at: NOW, user_id: account.userId, result: 'ignored:stale' });
  });

  it('unknown price: a subscription to something else changes nothing', async () => {
    const account = await makeAccount();
    const before = await userRow(account.userId);
    const event = subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceId: 'pri_some_other_product' });
    expect(await deliver(event)).toEqual({ status: 200, body: { ok: true, result: 'ignored:unknown_price' } });
    expect(await userRow(account.userId)).toEqual(before);

    const canceled = subscriptionEvent(subscriptionCanceled, account, { userId: account.userId, priceId: 'pri_some_other_product', at: NOW + MINUTE });
    expect((await deliver(canceled)).body.result).toBe('ignored:unknown_price');
    expect(await userRow(account.userId)).toEqual(before);
  });

  it('a canceled event for an old subscription does not downgrade a user on a newer one', async () => {
    const account = await makeAccount();
    const old = { ...account, subscriptionId: nextId('sub') };
    // The old subscription was set to cancel and its paid period is over; Paddle's final event for it is late.
    await apply(subscriptionEvent(subscriptionCreated, old, { userId: account.userId, at: NOW - 2 * DAY_MS }));
    await apply(subscriptionEvent(subscriptionUpdated, old, { at: NOW - DAY_MS, scheduledCancelAt: NOW - MINUTE }));
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceId: PRICE.pro, at: NOW }));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'pro', paddle_subscription_id: account.subscriptionId, cancel_at: null });

    const oldCanceled = subscriptionEvent(subscriptionCanceled, old, { userId: account.userId, at: NOW + MINUTE });
    expect((await deliver(oldCanceled)).body.result).toBe('ignored:other_subscription');
    // A late "active" event of the old subscription must not bring it back either.
    const oldRenewal = subscriptionEvent(subscriptionUpdated, old, { userId: account.userId, at: NOW - MINUTE });
    expect((await deliver(oldRenewal)).body.result).toBe('ignored:stale');

    expect(await userRow(account.userId)).toMatchObject({
      plan: 'pro',
      paddle_subscription_id: account.subscriptionId,
      subscription_status: 'active',
      subscription_event_at: NOW,
    });
  });

  it('while the mirrored subscription is in force, another subscription cannot take its place', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId, priceId: PRICE.pro, at: NOW - DAY_MS }));
    const second = { ...account, customerId: nextId('ctm'), subscriptionId: nextId('sub') };
    const created = subscriptionEvent(subscriptionCreated, second, { userId: account.userId, at: NOW });
    expect((await deliver(created)).body.result).toBe('ignored:other_subscription');
    expect(await userRow(account.userId)).toMatchObject({
      plan: 'pro',
      paddle_subscription_id: account.subscriptionId,
      paddle_customer_id: account.customerId,
      subscription_event_at: NOW - DAY_MS,
    });
    expect((await audit(created.event_id))?.user_id).toBe(account.userId);
  });

  it('the end of the current subscription applies even after its price id left the configuration', async () => {
    const account = await makeAccount();
    await apply(subscriptionEvent(subscriptionCreated, account, { userId: account.userId }));
    await apply(subscriptionEvent(subscriptionCanceled, account, { priceId: 'pri_retired_starter_price', at: NOW + MINUTE }));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'free', subscription_status: 'canceled' });
  });

  it('falls back to the Paddle customer id when there is no custom_data and the subscription is new', async () => {
    const account = await makeAccount();
    await run(db, 'UPDATE users SET paddle_customer_id = ?1 WHERE id = ?2', account.customerId, account.userId);
    await apply(subscriptionEvent(subscriptionCreated, account));
    expect(await userRow(account.userId)).toMatchObject({ plan: 'starter', paddle_subscription_id: account.subscriptionId });
  });

  it.each([
    { fixture: subscriptionCreated, status: 'active', plan: 'starter' },
    { fixture: subscriptionUpdated, status: 'active', plan: 'starter' },
    { fixture: subscriptionActivated, status: 'active', plan: 'starter' },
    { fixture: subscriptionResumed, status: 'active', plan: 'starter' },
    { fixture: subscriptionTrialing, status: 'trialing', plan: 'starter' },
    { fixture: subscriptionPastDue, status: 'past_due', plan: 'starter' },
    { fixture: subscriptionPaused, status: 'paused', plan: 'free' },
    { fixture: subscriptionCanceled, status: 'canceled', plan: 'free' },
  ])('mirrors the official $fixture.event_type example: status $status gives plan $plan', async ({ fixture, status, plan }) => {
    const account = await makeAccount();
    await run(db, "UPDATE users SET plan = 'starter', period_start = 1, period_end = 2 WHERE id = ?1", account.userId);
    await apply(subscriptionEvent(fixture, account, { userId: account.userId }));

    const user = await userRow(account.userId);
    expect(user).toMatchObject({ plan, subscription_status: status, paddle_subscription_id: account.subscriptionId });
    expect(user.period_start === null).toBe(plan === 'free');
  });

  it('events for an unknown user are acknowledged and ignored', async () => {
    const stranger: Account = { userId: 'u_does_not_exist', customerId: nextId('ctm'), subscriptionId: nextId('sub') };
    const event = subscriptionEvent(subscriptionCreated, stranger, { userId: stranger.userId });
    expect(await deliver(event)).toEqual({ status: 200, body: { ok: true, result: 'ignored:no_user' } });
    expect(await audit(event.event_id)).toMatchObject({ processed_at: NOW, user_id: null, result: 'ignored:no_user' });
  });

  it('ignores a status it does not know and a payload it cannot read, without failing the delivery', async () => {
    const account = await makeAccount();
    const odd = subscriptionEvent(subscriptionUpdated, account, { userId: account.userId, status: 'archived' });
    expect((await deliver(odd)).body.result).toBe('ignored:unknown_status');

    const unreadable = subscriptionEvent(subscriptionUpdated, account, { userId: account.userId });
    delete unreadable.data.id;
    expect(await deliver(unreadable)).toEqual({ status: 200, body: { ok: true, result: 'ignored:malformed' } });
    expect((await userRow(account.userId)).plan).toBe('free');
  });
});

describe('top-ups', () => {
  it('transaction.completed credits exactly TOPUP.images x quantity and backfills the customer id', async () => {
    const account = await makeAccount();
    const event = transactionEvent(transactionCompleted, account, { userId: account.userId, quantity: 3 });
    await apply(event);

    const topups = await topupsOf(account.userId);
    expect(topups).toHaveLength(1);
    expect(topups[0]).toMatchObject({
      paddle_transaction_id: event.data.id,
      images: 3 * TOPUP.images,
      remaining: 3 * TOPUP.images,
      created_at: NOW,
      expires_at: NOW + TOPUP.validDays * DAY_MS,
      refunded_at: null,
    });
    const user = await userRow(account.userId);
    expect(user).toMatchObject({ plan: 'free', paddle_customer_id: account.customerId, paddle_subscription_id: null });
    expect((await getUsage(db, user, NOW)).topup_remaining).toBe(3 * TOPUP.images);
  });

  it('replaying the same event id does not double-credit', async () => {
    const account = await makeAccount();
    const event = transactionEvent(transactionCompleted, account, { userId: account.userId });
    await apply(event);
    expect(await deliver(event)).toEqual({ status: 200, body: { ok: true, duplicate: true } });

    const topups = await topupsOf(account.userId);
    expect(topups.map((topup) => topup.images)).toEqual([TOPUP.images]);
  });

  it('a different event id for the same transaction does not double-credit', async () => {
    const account = await makeAccount();
    const transactionId = nextId('txn');
    await apply(transactionEvent(transactionCompleted, account, { userId: account.userId, transactionId }));
    const again = transactionEvent(transactionCompleted, account, { userId: account.userId, transactionId });
    expect(await deliver(again)).toEqual({ status: 200, body: { ok: true, result: 'ignored:already_credited' } });

    const topups = await topupsOf(account.userId);
    expect(topups.map((topup) => topup.remaining)).toEqual([TOPUP.images]);
  });

  it('transaction.paid does not credit', async () => {
    const account = await makeAccount();
    const paid = transactionEvent(transactionPaid, account, { userId: account.userId });
    expect(await deliver(paid)).toEqual({ status: 200, body: { ok: true, result: 'ignored:unhandled' } });
    expect(await topupsOf(account.userId)).toEqual([]);
  });

  it('a completed transaction without the top-up price is not a top-up', async () => {
    const account = await makeAccount();
    const other = transactionEvent(transactionCompleted, account, { userId: account.userId, topup: false });
    expect(await deliver(other)).toEqual({ status: 200, body: { ok: true, result: 'ignored:not_topup' } });
    expect(await topupsOf(account.userId)).toEqual([]);
    expect((await userRow(account.userId)).plan).toBe('free');
  });

  it('finds the buyer by Paddle customer id when the transaction carries no custom_data', async () => {
    const account = await makeAccount();
    await run(db, 'UPDATE users SET paddle_customer_id = ?1 WHERE id = ?2', account.customerId, account.userId);
    await apply(transactionEvent(transactionCompleted, account));
    expect(await topupsOf(account.userId)).toHaveLength(1);

    const unknown = transactionEvent(transactionCompleted, { ...account, customerId: nextId('ctm') });
    expect((await deliver(unknown)).body.result).toBe('ignored:no_user');
  });

  it('refund adjustment zeroes the top-up once Paddle approves a full refund', async () => {
    const account = await makeAccount();
    const transactionId = nextId('txn');
    await apply(transactionEvent(transactionCompleted, account, { userId: account.userId, transactionId }));

    const pending = adjustmentEvent(adjustmentCreated, transactionId, { type: 'full' });
    expect((await deliver(pending)).body.result).toBe('ignored:not_approved');
    const partial = adjustmentEvent(adjustmentUpdated, transactionId, { status: 'approved' });
    expect((await deliver(partial)).body.result).toBe('ignored:partial_refund');
    const credit = adjustmentEvent(adjustmentUpdated, transactionId, { action: 'credit', status: 'approved', type: 'full' });
    expect((await deliver(credit)).body.result).toBe('ignored:not_refund');
    expect((await topupsOf(account.userId))[0]?.refunded_at).toBeNull();

    const approved = adjustmentEvent(adjustmentUpdated, transactionId, { status: 'approved', type: 'full' });
    await apply(approved);
    expect((await topupsOf(account.userId))[0]?.refunded_at).toBe(NOW);
    expect((await getUsage(db, await userRow(account.userId), NOW)).topup_remaining).toBe(0);
    expect(await audit(approved.event_id)).toMatchObject({ user_id: account.userId, result: 'ok' });

    const repeated = adjustmentEvent(adjustmentUpdated, transactionId, { status: 'approved', type: 'full' });
    expect((await deliver(repeated)).body.result).toBe('ignored:already_refunded');
  });

  it('a chargeback revokes the top-up; adjustments of other transactions are ignored', async () => {
    const account = await makeAccount();
    const transactionId = nextId('txn');
    await apply(transactionEvent(transactionCompleted, account, { userId: account.userId, transactionId }));

    const unrelated = adjustmentEvent(adjustmentUpdated, nextId('txn'), { status: 'approved', type: 'full' });
    expect((await deliver(unrelated)).body.result).toBe('ignored:not_topup');
    await apply(adjustmentEvent(adjustmentCreated, transactionId, { action: 'chargeback', status: 'approved' }));
    expect((await topupsOf(account.userId))[0]?.refunded_at).toBe(NOW);
  });
});

describe('retries and audit trail', () => {
  /** env whose database fails every statement containing `fragment`. */
  function failingEnv(fragment: string): Env {
    const broken = {
      prepare(sql: string): D1PreparedStatement {
        if (sql.includes(fragment)) throw new Error('D1 is unavailable');
        return db.prepare(sql);
      },
    };
    return { ...env, DB: broken as unknown as D1Database };
  }

  it('a failed attempt answers 500, leaves the event unprocessed, and the retry applies it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const account = await makeAccount();
    const event = subscriptionEvent(subscriptionCreated, account, { userId: account.userId });

    const failed = await deliver(event, failingEnv('UPDATE users'));
    expect(failed.status).toBe(500);
    expect(failed.body.error?.code).toBe('internal_error');
    expect(await audit(event.event_id)).toMatchObject({ processed_at: null, result: 'error:D1 is unavailable' });
    expect((await userRow(account.userId)).plan).toBe('free');

    await apply(event);
    expect((await userRow(account.userId)).plan).toBe('starter');
    expect(await audit(event.event_id)).toMatchObject({ processed_at: NOW, user_id: account.userId, result: 'ok' });
    expect(await deliver(event)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
  });

  it('answers 500 when the event cannot even be recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = unhandledEvent();
    expect((await deliver(event, failingEnv('webhook_events'))).status).toBe(500);
    expect(await audit(event.event_id)).toBeNull();
  });

  it('every handled event type is acted on, everything else is ignored as unhandled', async () => {
    expect(HANDLED_EVENT_TYPES).toHaveLength(11);
    const envelope = { event_id: 'evt_direct', occurred_at: new Date(NOW).toISOString(), data: {} };
    for (const eventType of HANDLED_EVENT_TYPES) {
      const outcome = await applyPaddleEvent(env, db, { ...envelope, event_type: eventType }, NOW);
      expect(outcome.result, eventType).not.toBe('ignored:unhandled');
    }
    for (const eventType of ['transaction.paid', 'transaction.payment_failed', 'customer.created', 'something.new']) {
      expect(await applyPaddleEvent(env, db, { ...envelope, event_type: eventType }, NOW)).toEqual({ result: 'ignored:unhandled' });
    }
  });

  it('parses the envelope and Paddle timestamps', () => {
    expect(parsePaddleEvent(JSON.stringify(subscriptionCreated))).toMatchObject({
      event_id: 'evt_01hv8x2acma2gz7he8kg2s0hna',
      event_type: 'subscription.created',
      occurred_at: '2024-04-12T10:18:49.621022Z',
      data: { id: 'sub_01hv8x29kz0t586xy6zn1a62ny' },
    });
    expect(parsePaddleEvent('not json')).toBeNull();
    expect(parsePaddleEvent('{"event_id":"evt_1","event_type":"x","occurred_at":"2024-01-01T00:00:00Z","data":[]}')).toBeNull();
    expect(parseTimestamp('2024-04-12T10:18:49.621022Z')).toBe(Date.UTC(2024, 3, 12, 10, 18, 49, 621));
    expect(parseTimestamp('soon')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
  });
});

describe('REST client', () => {
  interface Call {
    url: string;
    method: string | undefined;
    headers: Headers;
    body: unknown;
  }

  /** Replaces fetch; every call is recorded and answered by `respond`. */
  function mockPaddleApi(respond: (url: string) => Response): Call[] {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.includes('paddle.com/')) throw new Error(`unexpected fetch ${url}`);
      calls.push({ url, method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return respond(url);
    });
    return calls;
  }

  const paddleError = (status: number, code: string): Response =>
    Response.json({ error: { type: 'request_error', code, detail: 'detail' }, meta: { request_id: 'req_1' } }, { status });

  async function rejection(promise: Promise<unknown>): Promise<ApiError> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );
    if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`);
    return error;
  }

  const portalResponse = (): Response =>
    Response.json(
      {
        data: {
          id: 'cpls_1',
          customer_id: 'ctm_1',
          urls: {
            general: { overview: 'https://customer-portal.paddle.com/cpl_1?action=overview' },
            subscriptions: [
              {
                id: 'sub_1',
                cancel_subscription: 'https://customer-portal.paddle.com/cpl_1?action=cancel_subscription',
                update_subscription_payment_method: 'https://customer-portal.paddle.com/cpl_1?action=update_subscription_payment_method',
                view_subscription: 'https://customer-portal.paddle.com/cpl_1?action=view_subscription',
              },
            ],
          },
        },
        meta: { request_id: 'req_1' },
      },
      { status: 201 },
    );

  it('createPortalSession posts to the sandbox API with the key and returns the portal links', async () => {
    const calls = mockPaddleApi(portalResponse);
    expect(await createPortalSession(env, 'ctm_1', ['sub_1'])).toEqual({
      overviewUrl: 'https://customer-portal.paddle.com/cpl_1?action=overview',
      cancelUrl: 'https://customer-portal.paddle.com/cpl_1?action=cancel_subscription',
      updatePaymentMethodUrl: 'https://customer-portal.paddle.com/cpl_1?action=update_subscription_payment_method',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://sandbox-api.paddle.com/customers/ctm_1/portal-sessions',
      method: 'POST',
      body: { subscription_ids: ['sub_1'] },
    });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${env.PADDLE_API_KEY}`);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('createPortalSession without subscriptions sends an empty object, and uses the live API in production', async () => {
    const calls = mockPaddleApi(portalResponse);
    expect(await createPortalSession({ ...env, PADDLE_ENV: 'production' }, 'ctm_1')).toEqual({
      overviewUrl: 'https://customer-portal.paddle.com/cpl_1?action=overview',
    });
    expect(calls[0]).toMatchObject({ url: 'https://api.paddle.com/customers/ctm_1/portal-sessions', body: {} });
  });

  it('changeSubscriptionPlan patches the subscription with the target price, prorated immediately', async () => {
    const calls = mockPaddleApi(() => Response.json({ data: { id: 'sub_1', status: 'active' }, meta: { request_id: 'req_1' } }));
    await expect(changeSubscriptionPlan(env, 'sub_1', 'pro')).resolves.toBeUndefined();
    await changeSubscriptionPlan(env, 'sub_1', 'starter');
    expect(calls[0]).toMatchObject({
      url: 'https://sandbox-api.paddle.com/subscriptions/sub_1',
      method: 'PATCH',
      body: { items: [{ price_id: PRICE.pro, quantity: 1 }], proration_billing_mode: 'prorated_immediately' },
    });
    expect(calls[1]?.body).toEqual({ items: [{ price_id: PRICE.starter, quantity: 1 }], proration_billing_mode: 'prorated_immediately' });
  });

  it.each(['subscription_locked_renewal', 'subscription_update_when_past_due', 'subscription_payment_declined'])(
    'changeSubscriptionPlan turns %s into a conflict the dashboard can show',
    async (code) => {
      mockPaddleApi(() => paddleError(409, code));
      const error = await rejection(changeSubscriptionPlan(env, 'sub_1', 'pro'));
      expect(error.code).toBe('conflict');
      expect(error.status).toBe(409);
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.details).toEqual({ paddle_status: 409, paddle_code: code });
    },
  );

  it('other Paddle errors become internal_error with the Paddle code in details', async () => {
    mockPaddleApi(() => paddleError(403, 'forbidden'));
    const planError = await rejection(changeSubscriptionPlan(env, 'sub_1', 'pro'));
    expect(planError.code).toBe('internal_error');
    expect(planError.details).toEqual({ paddle_status: 403, paddle_code: 'forbidden' });
    // The plan-change messages do not leak into other calls.
    vi.restoreAllMocks();
    mockPaddleApi(() => paddleError(409, 'subscription_locked_renewal'));
    expect((await rejection(createPortalSession(env, 'ctm_1'))).code).toBe('internal_error');
  });

  it('an unreachable API, a non-JSON error and an unexpected body are internal errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    expect((await rejection(createPortalSession(env, 'ctm_1'))).details).toEqual({ reason: 'unreachable' });

    vi.restoreAllMocks();
    mockPaddleApi(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect((await rejection(createPortalSession(env, 'ctm_1'))).details).toEqual({ paddle_status: 502, paddle_code: null });

    vi.restoreAllMocks();
    mockPaddleApi(() => Response.json({ data: { urls: {} } }));
    const unexpected = await rejection(createPortalSession(env, 'ctm_1'));
    expect(unexpected.code).toBe('internal_error');
    expect(unexpected.details).toEqual({ reason: 'unexpected_response' });
  });

  it('is not_configured without an API key or the target price id, and never calls Paddle then', async () => {
    const calls = mockPaddleApi(portalResponse);
    expect((await rejection(createPortalSession({ ...env, PADDLE_API_KEY: '' }, 'ctm_1'))).code).toBe('not_configured');
    expect((await rejection(changeSubscriptionPlan({ ...env, PADDLE_API_KEY: undefined }, 'sub_1', 'pro'))).code).toBe('not_configured');
    expect((await rejection(changeSubscriptionPlan({ ...env, PADDLE_PRICE_PRO: '' }, 'sub_1', 'pro'))).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('paddleClientConfig exposes the token and price ids, or null while anything is missing', () => {
    expect(paddleClientConfig(env)).toEqual({
      environment: 'sandbox',
      clientToken: env.PADDLE_CLIENT_TOKEN,
      prices: { starter: PRICE.starter, pro: PRICE.pro, topup: PRICE.topup },
    });
    expect(paddleClientConfig({ ...env, PADDLE_ENV: 'production' })?.environment).toBe('production');
    expect(paddleClientConfig({ ...env, PADDLE_CLIENT_TOKEN: '' })).toBeNull();
    expect(paddleClientConfig({ ...env, PADDLE_PRICE_STARTER: undefined })).toBeNull();
    expect(paddleClientConfig({ ...env, PADDLE_PRICE_PRO: '' })).toBeNull();
    expect(paddleClientConfig({ ...env, PADDLE_PRICE_TOPUP: ' ' })).toBeNull();
  });

  it('planForPriceId maps the configured price ids and nothing else', () => {
    expect(planForPriceId(env, PRICE.starter)).toBe('starter');
    expect(planForPriceId(env, PRICE.pro)).toBe('pro');
    expect(planForPriceId(env, PRICE.topup)).toBe('topup');
    expect(planForPriceId(env, 'pri_unknown')).toBeNull();
    // An unset price id ("" in wrangler.toml) must not match an empty id.
    expect(planForPriceId({ ...env, PADDLE_PRICE_TOPUP: '' }, '')).toBeNull();
  });
});
