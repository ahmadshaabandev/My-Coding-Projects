// Independent review of the plan-change allowance (commit 8ea7bf7): the images of
// a billing period must follow the money Paddle collects for it.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS } from '../src/config';
import { all, first, getUserById, run } from '../src/db/client';
import { hmacSha256Hex } from '../src/lib/crypto';
import { getUsage } from '../src/lib/quota';
import { paddleWebhookRouter } from '../src/routes/webhooks/paddle';
import type { UserRow } from '../src/types';
import { dashboard, requestUrl, sessionCookieFor } from './app-helpers';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';
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
const STARTER = PLANS.starter.monthlyImages;
const PRO = PLANS.pro.monthlyImages;
const at = (share: number): number => PERIOD.start + Math.round((PERIOD.end - PERIOD.start) * share);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_va${String(++sequence).padStart(4, '0')}`;

interface Account {
  userId: string;
  customerId: string;
  subscriptionId: string;
}

async function userRow(userId: string): Promise<UserRow> {
  const user = await getUserById(db, userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user;
}

function subscriptionEvent(
  fixture: PaddleFixture,
  account: Account,
  changes: { plan: 'starter' | 'pro'; at: number; userId?: string; period?: { start: number; end: number } | null },
): PaddleFixture {
  const event = structuredClone(fixture);
  event.event_id = nextId('evt');
  event.occurred_at = new Date(changes.at).toISOString();
  event.data.id = account.subscriptionId;
  event.data.customer_id = account.customerId;
  event.data.custom_data = changes.userId ? { user_id: changes.userId } : null;
  event.data.status = 'active';
  const template = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[0]!;
  event.data.items = [{ ...structuredClone(template), price: { ...template.price, id: PRICE[changes.plan] }, quantity: 1 }];
  const period = changes.period === undefined ? PERIOD : changes.period;
  event.data.current_billing_period = period
    ? { starts_at: new Date(period.start).toISOString(), ends_at: new Date(period.end).toISOString() }
    : null;
  event.data.scheduled_change = null;
  return event;
}

async function deliver(event: PaddleFixture): Promise<string | undefined> {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `ts=${timestamp};h1=${await hmacSha256Hex(SECRET, `${timestamp}:${raw}`)}`;
  const response = await paddleWebhookRouter.request(
    '/paddle',
    { method: 'POST', headers: { 'content-type': 'application/json', 'Paddle-Signature': signature }, body: raw },
    env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { result?: string }).result;
}

/** The plan change as the dashboard's webhook would see it, at `when`. */
const change = async (account: Account, plan: 'starter' | 'pro', when: number) => {
  vi.setSystemTime(when);
  expect(await deliver(subscriptionEvent(subscriptionUpdated, account, { plan, at: when }))).toBe('ok');
};

async function subscriber(plan: 'starter' | 'pro'): Promise<Account> {
  const userId = nextId('u');
  await run(db, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, ?3, 'free')", userId, `${userId}@example.com`, NOW - 40 * DAY_MS);
  const account = { userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };
  vi.setSystemTime(PERIOD.start);
  expect(await deliver(subscriptionEvent(subscriptionCreated, account, { userId, plan, at: PERIOD.start }))).toBe('ok');
  return account;
}

const limitAt = async (account: Account, when: number) => (await getUsage(db, await userRow(account.userId), when)).limit;

/** What the dashboard asks Paddle for, with Paddle answering 200. */
async function dashboardChange(account: Account, plan: 'starter' | 'pro', when: number): Promise<unknown[]> {
  vi.setSystemTime(when);
  const bodies: unknown[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (requestUrl(input).origin !== 'https://sandbox-api.paddle.com') throw new Error('unexpected fetch');
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ data: { id: account.subscriptionId } });
  });
  const response = await dashboard(await sessionCookieFor(account.userId, when), 'POST', '/api/billing/change-plan', { plan });
  spy.mockRestore();
  expect(response.status).toBe(200);
  return bodies;
}

const mode = (bodies: unknown[]) => (bodies[0] as { proration_billing_mode?: string } | undefined)?.proration_billing_mode;

describe('switching down and back up inside one period', () => {
  it('a Pro customer cannot buy the Pro allowance again by switching to Starter and back', async () => {
    const account = await subscriber('pro');
    // Two cycles in the first hours of the period. Each "upgrade" back to Pro
    // currently adds about 8,000 images (for at most $20 of proration each).
    for (const hour of [1, 3]) {
      await change(account, 'starter', PERIOD.start + hour * HOUR);
      expect(await limitAt(account, PERIOD.start + hour * HOUR + MINUTE)).toBe(PRO);
      await change(account, 'pro', PERIOD.start + (hour + 1) * HOUR);
    }
    expect(await limitAt(account, PERIOD.start + 5 * HOUR)).toBe(PRO);
  });

  it('switching back to Pro after a downgrade is not charged when it adds no images', async () => {
    const account = await subscriber('pro');
    await change(account, 'starter', at(0.25));
    expect(mode(await dashboardChange(account, 'pro', at(0.5)))).toBe('do_not_bill');
  });

  it('Starter, Pro, Starter, Pro: the second upgrade adds nothing and is not charged', async () => {
    const account = await subscriber('starter');
    expect(mode(await dashboardChange(account, 'pro', at(0.25)))).toBe('prorated_immediately');
    await change(account, 'pro', at(0.25));
    const paidFor = STARTER + ((PRO - STARTER) * 3) / 4;
    expect(await limitAt(account, at(0.25) + MINUTE)).toBe(paidFor);
    expect(mode(await dashboardChange(account, 'starter', at(0.3)))).toBe('do_not_bill');
    await change(account, 'starter', at(0.3));
    expect(mode(await dashboardChange(account, 'pro', at(0.5)))).toBe('do_not_bill');
    await change(account, 'pro', at(0.5));
    expect(await limitAt(account, at(0.5) + MINUTE)).toBe(paidFor);
  });

  it('a first upgrade is still prorated: integer images, rounded by at most one in the customer\'s favour', async () => {
    const account = await subscriber('starter');
    const when = PERIOD.start + 7 * DAY_MS + 12_345;
    expect(mode(await dashboardChange(account, 'pro', when))).toBe('prorated_immediately');
    await change(account, 'pro', when);
    const exact = PRO - ((PRO - STARTER) * (when - PERIOD.start)) / (PERIOD.end - PERIOD.start);
    const limit = await limitAt(account, when + MINUTE);
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit - exact).toBeGreaterThanOrEqual(0);
    expect(limit - exact).toBeLessThan(1);
    const stored = await first<{ kind: string }>(db, 'SELECT typeof(allowance_adjust) AS kind FROM usage_periods WHERE user_id = ?1', account.userId);
    expect(stored?.kind).toBe('integer');
  });
});

describe('events that must not adjust the allowance', () => {
  it("a stranger's subscription refused as other_subscription leaves the period untouched", async () => {
    const victim = await subscriber('starter');
    const stranger: Account = { userId: victim.userId, customerId: nextId('ctm'), subscriptionId: nextId('sub') };
    vi.setSystemTime(at(0.5));
    const event = subscriptionEvent(subscriptionCreated, stranger, { userId: victim.userId, plan: 'pro', at: at(0.5) });
    expect(await deliver(event)).toBe('ignored:other_subscription');
    expect(await all(db, 'SELECT allowance_adjust FROM usage_periods WHERE user_id = ?1 AND allowance_adjust <> 0', victim.userId)).toEqual([]);
    expect(await limitAt(victim, at(0.5) + MINUTE)).toBe(STARTER);
  });

  it('a zero-length or missing period neither adjusts nor breaks the webhook', async () => {
    const account = await subscriber('starter');
    vi.setSystemTime(at(0.5));
    const empty = { start: at(0.5), end: at(0.5) };
    expect(await deliver(subscriptionEvent(subscriptionUpdated, account, { plan: 'starter', at: at(0.5), period: empty }))).toBe('ok');
    expect(await deliver(subscriptionEvent(subscriptionUpdated, account, { plan: 'pro', at: at(0.5) + MINUTE, period: null }))).toBe('ok');
    expect(await all(db, 'SELECT allowance_adjust FROM usage_periods WHERE user_id = ?1 AND allowance_adjust <> 0', account.userId)).toEqual([]);
  });

  it('the same change delivered twice at the same instant adjusts once', async () => {
    const account = await subscriber('starter');
    vi.setSystemTime(at(0.5));
    const event = subscriptionEvent(subscriptionUpdated, account, { plan: 'pro', at: at(0.5) });
    expect(await deliver(event)).toBe('ok');
    expect(await deliver({ ...structuredClone(event), event_id: nextId('evt') })).toBe('ok');
    expect(await limitAt(account, at(0.5) + MINUTE)).toBe(STARTER + (PRO - STARTER) / 2);
  });

  it('Free to paid starts from the full allowance', async () => {
    expect(await limitAt(await subscriber('starter'), PERIOD.start + MINUTE)).toBe(STARTER);
  });
});
