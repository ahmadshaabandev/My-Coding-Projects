/**
 * Paddle Billing: webhook signature check, entitlement mirroring and the few
 * REST calls the dashboard needs.
 *
 * Paddle is the source of truth for money; `users` only mirrors what the
 * webhooks say. Payload shapes follow Paddle's OpenAPI examples (copies live
 * in tests/fixtures/paddle); everything read from a payload goes through the
 * small readers below because the wire JSON is untyped.
 */
import { first, run } from '../db/client';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { creditTopup, markTopupRefunded } from '../lib/quota';
import type { Env, TopupRow, UserRow } from '../types';
import { PLANS, TOPUP } from './plans';

/* ------------------------------------------------------------------ */
/* Catalog mapping                                                     */
/* ------------------------------------------------------------------ */

export type PaidPlanId = 'starter' | 'pro';
export type PaddleProduct = PaidPlanId | 'topup';

const PRODUCTS: readonly PaddleProduct[] = ['starter', 'pro', 'topup'];

/** wrangler.toml declares unset vars as "", so empty counts as missing. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function configuredPriceId(env: Env, product: PaddleProduct): string | null {
  const key = product === 'topup' ? TOPUP.paddlePriceEnv : PLANS[product].paddlePriceEnv;
  return key ? nonEmpty(env[key]) : null;
}

export function planForPriceId(env: Env, priceId: string): PaddleProduct | null {
  return PRODUCTS.find((product) => configuredPriceId(env, product) === priceId) ?? null;
}

export interface PaddleClientConfig {
  environment: 'sandbox' | 'production';
  clientToken: string;
  prices: Record<PaddleProduct, string>;
}

function paddleEnvironment(env: Env): 'sandbox' | 'production' {
  return env.PADDLE_ENV === 'production' ? 'production' : 'sandbox';
}

/** What Paddle.js needs in the browser. Client-side tokens and price ids are public by design. */
export function paddleClientConfig(env: Env): PaddleClientConfig | null {
  const clientToken = nonEmpty(env.PADDLE_CLIENT_TOKEN);
  const starter = configuredPriceId(env, 'starter');
  const pro = configuredPriceId(env, 'pro');
  const topup = configuredPriceId(env, 'topup');
  if (!clientToken || !starter || !pro || !topup) return null;
  return { environment: paddleEnvironment(env), clientToken, prices: { starter, pro, topup } };
}

/* ------------------------------------------------------------------ */
/* Webhook signature                                                   */
/* ------------------------------------------------------------------ */

/**
 * Paddle's SDKs reject a webhook whose `ts` is more than 5 s away from the
 * local clock. We allow 5 minutes instead: replays are already harmless
 * because every event id is applied once (webhook_events), so the window only
 * has to bound how long a captured request stays valid, and a wider one keeps
 * clock skew or a slow delivery from turning into a missed billing event.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type SignatureVerdict = 'valid' | 'malformed' | 'stale' | 'mismatch';

/**
 * PADDLE_WEBHOOK_SECRET may hold several comma-separated secrets, so a
 * notification destination can be replaced (which changes its secret) without
 * a window in which deliveries fail.
 */
export function webhookSecrets(env: Env): string[] {
  return (env.PADDLE_WEBHOOK_SECRET ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
}

function parseSignatureHeader(header: string): { ts: string; h1: string[] } | null {
  let ts: string | null = null;
  const h1: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'h1') h1.push(value);
  }
  if (ts === null || !/^\d{1,12}$/.test(ts) || h1.length === 0) return null;
  return { ts, h1 };
}

/**
 * Paddle-Signature is `ts=<unix seconds>;h1=<hex>`, where h1 is
 * HMAC-SHA256(secret, ts + ":" + raw body). Any h1 matching any secret passes,
 * which covers a header carrying one signature per secret during rotation.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null | undefined,
  secrets: readonly string[],
  now: number,
): Promise<SignatureVerdict> {
  const parsed = header ? parseSignatureHeader(header) : null;
  if (!parsed) return 'malformed';
  if (Math.abs(now - Number(parsed.ts) * 1000) > WEBHOOK_TOLERANCE_SECONDS * 1000) return 'stale';
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, `${parsed.ts}:${rawBody}`);
    if (parsed.h1.some((candidate) => timingSafeEqual(candidate, expected))) return 'valid';
  }
  return 'mismatch';
}

/* ------------------------------------------------------------------ */
/* Payload readers                                                     */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** RFC 3339 (Paddle sends microseconds) to epoch milliseconds. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The webhook envelope. `data` is the full entity named by `event_type`. */
export interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Json;
}

export function parsePaddleEvent(rawBody: string): PaddleEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const root = asRecord(value);
  const eventId = asString(root?.event_id);
  const eventType = asString(root?.event_type);
  const occurredAt = asString(root?.occurred_at);
  const data = asRecord(root?.data);
  if (!eventId || !eventType || !occurredAt || !data) return null;
  return { event_id: eventId, event_type: eventType, occurred_at: occurredAt, data };
}

interface LineItem {
  priceId: string;
  quantity: number;
}

/** Subscription and transaction items share the `{ price: { id }, quantity }` shape. */
function readItems(value: unknown): LineItem[] {
  if (!Array.isArray(value)) return [];
  const items: LineItem[] = [];
  for (const entry of value) {
    const item = asRecord(entry);
    const priceId = asString(asRecord(item?.price)?.id);
    const quantity = item?.quantity;
    if (priceId && typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 0) {
      items.push({ priceId, quantity });
    }
  }
  return items;
}

/** Our checkout passes `customData: { user_id }`; Paddle copies it onto the transaction and the subscription. */
function customUserId(data: Json): string | null {
  return asString(asRecord(data.custom_data)?.user_id);
}

/* ------------------------------------------------------------------ */
/* Entitlements                                                        */
/* ------------------------------------------------------------------ */

export interface ApplyResult {
  /** 'ok' or 'ignored:<reason>'; stored in webhook_events.result. */
  result: string;
  userId?: string;
}

const SUBSCRIPTION_EVENTS: readonly string[] = [
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.past_due',
  'subscription.paused',
  'subscription.resumed',
  'subscription.trialing',
  'subscription.canceled',
];
const TOPUP_EVENT = 'transaction.completed';
const ADJUSTMENT_EVENTS: readonly string[] = ['adjustment.created', 'adjustment.updated'];

/** Every event type that changes state here: the list to subscribe the notification destination to. */
export const HANDLED_EVENT_TYPES: readonly string[] = [...SUBSCRIPTION_EVENTS, TOPUP_EVENT, ...ADJUSTMENT_EVENTS];

/**
 * Paddle's own access rule: active, trialing and past_due keep the plan
 * (past_due is the dunning window, during which Paddle retries the payment).
 */
const ENTITLED_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];
const ENDED_STATUSES: readonly string[] = ['canceled', 'paused'];

type BillingUser = Pick<UserRow, 'id' | 'paddle_subscription_id' | 'subscription_status' | 'cancel_at' | 'subscription_event_at'>;
type UserKey = 'id' | 'paddle_subscription_id' | 'paddle_customer_id';

/** First user matched by the given keys, tried in order. */
async function findUser(db: D1Database, keys: ReadonlyArray<[UserKey, string | null]>): Promise<BillingUser | null> {
  for (const [column, value] of keys) {
    if (!value) continue;
    const user = await first<BillingUser>(
      db,
      `SELECT id, paddle_subscription_id, subscription_status, cancel_at, subscription_event_at
       FROM users WHERE ${column} = ?1 ORDER BY created_at LIMIT 1`,
      value,
    );
    if (user) return user;
  }
  return null;
}

interface Subscription {
  id: string;
  status: string;
  customerId: string | null;
  userId: string | null;
  priceIds: string[];
  period: { start: number; end: number } | null;
  /** When a scheduled cancellation takes effect; the subscription stays active until then. */
  cancelAt: number | null;
}

function readSubscription(data: Json): Subscription | null {
  const id = asString(data.id);
  const status = asString(data.status);
  if (!id || !status) return null;
  const period = asRecord(data.current_billing_period);
  const start = parseTimestamp(period?.starts_at);
  const end = parseTimestamp(period?.ends_at);
  const change = asRecord(data.scheduled_change);
  return {
    id,
    status,
    customerId: asString(data.customer_id),
    userId: customUserId(data),
    priceIds: readItems(data.items).map((item) => item.priceId),
    period: start !== null && end !== null ? { start, end } : null,
    cancelAt: change?.action === 'cancel' ? parseTimestamp(change.effective_at) : null,
  };
}

interface PlanPrice {
  plan: PaidPlanId;
  priceId: string;
}

/** The plan a subscription pays for. With several plan items the highest one counts, whatever their order. */
function subscriptionPlan(env: Env, priceIds: readonly string[]): PlanPrice | null {
  for (const plan of ['pro', 'starter'] as const) {
    const priceId = priceIds.find((id) => planForPriceId(env, id) === plan);
    if (priceId) return { plan, priceId };
  }
  return null;
}

/**
 * A Paddle customer belongs to one account. The customer id on an event is
 * chosen by whoever paid (Paddle attaches a checkout to the existing customer
 * with the email typed into it), and "Manage billing" mints a signed-in portal
 * session for the stored id. So an id that another account already holds is
 * never copied onto this one. ?N placeholders: customer id, user id.
 */
const adoptCustomerSql = (customer: string, user: string): string =>
  `CASE WHEN ${customer} IS NULL
          OR EXISTS (SELECT 1 FROM users AS other WHERE other.paddle_customer_id = ${customer} AND other.id <> ${user})
        THEN paddle_customer_id ELSE ${customer} END`;

/**
 * One handler for every subscription.* event: the payload always carries the
 * whole subscription, so state is driven by `data.status`, not by the event
 * name. (A recovered payment, for example, has no event of its own - it is a
 * subscription.updated whose status is back to active.)
 */
async function applySubscription(env: Env, db: D1Database, event: PaddleEvent, now: number): Promise<ApplyResult> {
  const sub = readSubscription(event.data);
  const occurredAt = parseTimestamp(event.occurred_at);
  if (!sub || occurredAt === null) return { result: 'ignored:malformed' };

  const user = await findUser(db, [
    ['id', sub.userId],
    ['paddle_subscription_id', sub.id],
    ['paddle_customer_id', sub.customerId],
  ]);
  if (!user) return { result: 'ignored:no_user' };
  const ignored = (reason: string): ApplyResult => ({ result: `ignored:${reason}`, userId: user.id });

  // Paddle does not deliver in order. The guard deliberately spans subscriptions:
  // a late "active" event of a subscription the user has since replaced would
  // otherwise bring the old one back, with nothing left to end it.
  if (user.subscription_event_at !== null && occurredAt < user.subscription_event_at) return ignored('stale');

  const isCurrent = user.paddle_subscription_id === sub.id;
  const matched = subscriptionPlan(env, sub.priceIds);
  const mirrored = {
    customerId: sub.customerId,
    subscriptionId: sub.id,
    status: sub.status,
    priceId: matched?.priceId ?? sub.priceIds[0] ?? null,
    occurredAt,
  };

  if (ENDED_STATUSES.includes(sub.status)) {
    // The end of an old subscription must not take the plan away from a user who is on a newer one.
    if (!isCurrent && user.paddle_subscription_id !== null) return ignored('other_subscription');
    // The end of the mirrored subscription always applies, even if its price id
    // has since been rotated out of the configuration.
    if (!isCurrent && !matched) return ignored('unknown_price');
    return (await revokePlan(db, user.id, mirrored)) ? { result: 'ok', userId: user.id } : ignored('stale');
  }
  if (!ENTITLED_STATUSES.includes(sub.status)) return ignored('unknown_status');
  // custom_data.user_id is set by the browser that opened the checkout, and
  // account ids are public (they are in image URLs). Without this, anyone could
  // buy a subscription "for" a paying customer, have it replace the mirrored
  // one, and cancel it again - leaving that customer on Free while their own
  // subscription keeps billing. While the mirrored subscription is in force no
  // other subscription can take its place; once it has ended, any can.
  const currentInForce =
    user.paddle_subscription_id !== null &&
    user.subscription_status !== null &&
    ENTITLED_STATUSES.includes(user.subscription_status) &&
    (user.cancel_at === null || now < user.cancel_at);
  if (!isCurrent && currentInForce) return ignored('other_subscription');
  if (!matched) return ignored('unknown_price');
  const granted = await grantPlan(db, user.id, mirrored, matched.plan, sub.period, sub.cancelAt);
  return granted ? { result: 'ok', userId: user.id } : ignored('stale');
}

interface MirroredSubscription {
  customerId: string | null;
  subscriptionId: string;
  status: string;
  priceId: string | null;
  occurredAt: number;
}

/**
 * Both writers repeat the ordering guard in the WHERE clause so that two
 * events handled concurrently cannot leave the older one on top. They return
 * false when a newer event got there first.
 */
/**
 * A change between Starter and Pro inside the current billing period adjusts
 * that period's allowance the way the money moves (see changeSubscriptionPlan):
 *
 *   upgrade    Paddle charges the price difference for the time left, so the
 *              allowance grows by (new - old) x the share of the period left.
 *   downgrade  nothing is credited, so the allowance already paid for stays
 *              until the period ends: the adjustment is (old - new).
 *
 * An upgrade never takes the period above what the new plan pays for in the
 * time left, nor below what the period already has: after a downgrade (which
 * kept the larger allowance) switching back adds nothing, and the dashboard
 * does not bill it (upgradeAddsImages). Otherwise switching down and back up
 * would sell the Pro allowance again for the price difference, over and over.
 *
 * It runs in the same batch as the grant, before it, under the same ordering
 * guard and only while the row still holds the other paid plan in the same
 * period, so a redelivered or late event cannot apply it twice. A new period
 * (a renewal, or Free to paid) starts from the plan's full allowance instead.
 * ?1 user, ?2 new plan, ?3 new plan's images, ?4 Starter images, ?5 Pro images,
 * ?6 event time, ?7 the event's period start (null = unchanged).
 */
const ADJUST_ALLOWANCE_SQL = `INSERT INTO usage_periods (user_id, period_start, period_end, allowance_adjust)
  SELECT id, period_start, period_end,
    CASE WHEN ?3 > old_images
      THEN MAX(adjust + old_images - ?3, -CAST((?3 - old_images) * (?6 - period_start) / (period_end - period_start) AS INTEGER))
      ELSE adjust + old_images - ?3
    END
  FROM (SELECT *, CASE plan WHEN 'starter' THEN ?4 ELSE ?5 END AS old_images,
      COALESCE((SELECT allowance_adjust FROM usage_periods WHERE user_id = ?1 AND usage_periods.period_start = users.period_start), 0) AS adjust
    FROM users WHERE id = ?1)
  WHERE plan IN ('starter', 'pro') AND plan <> ?2
    AND period_start IS NOT NULL AND period_start <= ?6 AND period_end > ?6
    AND period_start = COALESCE(?7, period_start)
    AND (cancel_at IS NULL OR cancel_at > ?6)
    AND (subscription_event_at IS NULL OR subscription_event_at <= ?6)
  ON CONFLICT (user_id, period_start) DO UPDATE SET allowance_adjust = excluded.allowance_adjust`;

async function grantPlan(
  db: D1Database,
  userId: string,
  sub: MirroredSubscription,
  plan: PaidPlanId,
  period: { start: number; end: number } | null,
  cancelAt: number | null,
): Promise<boolean> {
  const adjust = db
    .prepare(ADJUST_ALLOWANCE_SQL)
    .bind(userId, plan, PLANS[plan].monthlyImages, PLANS.starter.monthlyImages, PLANS.pro.monthlyImages, sub.occurredAt, period?.start ?? null);
  const grant = db
    .prepare(
      `UPDATE users SET
       plan = ?1,
       paddle_customer_id = ${adoptCustomerSql('?2', '?10')},
       paddle_subscription_id = ?3,
       subscription_status = ?4,
       subscription_price_id = ?5,
       period_start = COALESCE(?6, period_start),
       period_end = COALESCE(?7, period_end),
       cancel_at = ?8,
       subscription_event_at = ?9
     WHERE id = ?10 AND (subscription_event_at IS NULL OR subscription_event_at <= ?9)`,
    )
    .bind(
      plan,
      sub.customerId,
      sub.subscriptionId,
      sub.status,
      sub.priceId,
      period?.start ?? null,
      period?.end ?? null,
      cancelAt,
      sub.occurredAt,
      userId,
    );
  const results = await db.batch([adjust, grant]);
  return results[1]?.meta.changes === 1;
}

async function revokePlan(db: D1Database, userId: string, sub: MirroredSubscription): Promise<boolean> {
  const changes = await run(
    db,
    `UPDATE users SET
       plan = 'free',
       paddle_customer_id = ${adoptCustomerSql('?1', '?6')},
       paddle_subscription_id = ?2,
       subscription_status = ?3,
       subscription_price_id = ?4,
       period_start = NULL,
       period_end = NULL,
       cancel_at = NULL,
       subscription_event_at = ?5
     WHERE id = ?6
       AND (paddle_subscription_id IS NULL OR paddle_subscription_id = ?2)
       AND (subscription_event_at IS NULL OR subscription_event_at <= ?5)`,
    sub.customerId,
    sub.subscriptionId,
    sub.status,
    sub.priceId,
    sub.occurredAt,
    userId,
  );
  return changes === 1;
}

/**
 * Top-ups are credited on transaction.completed only. transaction.paid fires
 * for the same payment a moment earlier; crediting on both would double the
 * purchase. The topups table is unique on the transaction id, so a replay
 * under a different event id cannot credit twice either.
 */
async function applyCompletedTransaction(env: Env, db: D1Database, event: PaddleEvent, now: number): Promise<ApplyResult> {
  const transactionId = asString(event.data.id);
  const topupPriceId = configuredPriceId(env, 'topup');
  const units = readItems(event.data.items)
    .filter((item) => item.priceId === topupPriceId)
    .reduce((sum, item) => sum + item.quantity, 0);
  if (!transactionId || units === 0) return { result: 'ignored:not_topup' };

  const customerId = asString(event.data.customer_id);
  const user = await findUser(db, [
    ['id', customUserId(event.data)],
    ['paddle_customer_id', customerId],
  ]);
  if (!user) return { result: 'ignored:no_user' };

  const credited = await creditTopup(db, { userId: user.id, transactionId, images: units * TOPUP.images, now });
  if (customerId) {
    await run(
      db,
      `UPDATE users SET paddle_customer_id = ?1 WHERE id = ?2 AND paddle_customer_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM users AS other WHERE other.paddle_customer_id = ?1 AND other.id <> ?2)`,
      customerId,
      user.id,
    );
  }
  return { result: credited ? 'ok' : 'ignored:already_credited', userId: user.id };
}

/**
 * A refunded or charged-back top-up stops being usable. Refunds start as
 * pending_approval and only count once Paddle approves them. Partial refunds
 * (for example tax handed back after a VAT number is added) leave the top-up
 * alone: the customer still paid for the images.
 */
async function applyAdjustment(db: D1Database, event: PaddleEvent, now: number): Promise<ApplyResult> {
  const { action, status, type } = event.data;
  if (action !== 'refund' && action !== 'chargeback') return { result: 'ignored:not_refund' };
  if (status !== 'approved') return { result: 'ignored:not_approved' };
  if (action === 'refund' && type !== 'full') return { result: 'ignored:partial_refund' };

  const transactionId = asString(event.data.transaction_id);
  const topup = transactionId
    ? await first<Pick<TopupRow, 'user_id'>>(db, 'SELECT user_id FROM topups WHERE paddle_transaction_id = ?1', transactionId)
    : null;
  if (!transactionId || !topup) return { result: 'ignored:not_topup' };

  const refunded = await markTopupRefunded(db, transactionId, now);
  return { result: refunded ? 'ok' : 'ignored:already_refunded', userId: topup.user_id };
}

/**
 * Applies one verified webhook event. Safe to call again for the same event:
 * subscription writes are plain mirrors and top-ups are unique per transaction.
 */
export async function applyPaddleEvent(env: Env, db: D1Database, event: PaddleEvent, now: number): Promise<ApplyResult> {
  if (SUBSCRIPTION_EVENTS.includes(event.event_type)) return applySubscription(env, db, event, now);
  if (event.event_type === TOPUP_EVENT) return applyCompletedTransaction(env, db, event, now);
  if (ADJUSTMENT_EVENTS.includes(event.event_type)) return applyAdjustment(db, event, now);
  return { result: 'ignored:unhandled' };
}

/* ------------------------------------------------------------------ */
/* REST client                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
} as const;

const API_TIMEOUT_MS = 10_000;

function billingUnavailable(details: Record<string, unknown>): ApiError {
  return new ApiError('internal_error', 'The billing provider could not complete the request. Try again in a moment.', {
    details,
  });
}

/**
 * Calls the Paddle API and returns the `data` member of the response.
 * `conflicts` maps Paddle error codes the customer can act on to the message
 * to show; every other failure is an internal_error carrying Paddle's code.
 */
async function paddleRequest(
  env: Env,
  method: 'POST' | 'PATCH',
  path: string,
  body: Json,
  conflicts: Readonly<Record<string, string>> = {},
): Promise<Json> {
  const apiKey = nonEmpty(env.PADDLE_API_KEY);
  if (!apiKey) throw new ApiError('not_configured', 'Billing is not configured yet.');

  let response: Response;
  try {
    response = await fetch(`${API_BASE[paddleEnvironment(env)]}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw billingUnavailable({ reason: 'unreachable' });
  }

  const payload = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    const code = asString(asRecord(payload?.error)?.code);
    const details = { paddle_status: response.status, paddle_code: code };
    const conflict = code ? conflicts[code] : undefined;
    throw conflict ? new ApiError('conflict', conflict, { details }) : billingUnavailable(details);
  }
  const data = asRecord(payload?.data);
  if (!data) throw billingUnavailable({ reason: 'unexpected_response' });
  return data;
}

export interface PortalSession {
  overviewUrl: string;
  cancelUrl?: string;
  updatePaymentMethodUrl?: string;
}

/**
 * Mints a customer-portal session. The links are short-lived: create one per
 * click and redirect, never store them. The deep links are returned for the
 * first subscription id passed in.
 */
export async function createPortalSession(
  env: Env,
  customerId: string,
  subscriptionIds: readonly string[] = [],
): Promise<PortalSession> {
  const body: Json = subscriptionIds.length > 0 ? { subscription_ids: subscriptionIds } : {};
  const data = await paddleRequest(env, 'POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, body);
  const urls = asRecord(data.urls);
  const overviewUrl = asString(asRecord(urls?.general)?.overview);
  if (!overviewUrl) throw billingUnavailable({ reason: 'unexpected_response' });

  const subscriptions = Array.isArray(urls?.subscriptions) ? urls.subscriptions : [];
  const links = subscriptions.map(asRecord).find((entry) => entry?.id === subscriptionIds[0]);
  const cancelUrl = asString(links?.cancel_subscription);
  const updatePaymentMethodUrl = asString(links?.update_subscription_payment_method);
  return {
    overviewUrl,
    ...(cancelUrl ? { cancelUrl } : {}),
    ...(updatePaymentMethodUrl ? { updatePaymentMethodUrl } : {}),
  };
}

/** Paddle error codes a customer can act on, with the message the dashboard shows. */
const PLAN_CHANGE_CONFLICTS: Readonly<Record<string, string>> = {
  subscription_locked_renewal:
    'Your subscription is renewing right now, so the plan cannot be changed for about 30 minutes. Try again after that.',
  subscription_update_when_past_due:
    'Your last payment failed. Update your payment method first, then change plan.',
  subscription_payment_declined:
    'The payment for the new plan was declined, so nothing was changed. Update your payment method and try again.',
};

/**
 * Whether switching to `target` at `now` adds images to the period whose usage
 * is given, by the rule of ADJUST_ALLOWANCE_SQL. False for a downgrade, and for
 * an upgrade back to a plan whose allowance the period already kept.
 */
export function upgradeAddsImages(
  current: PaidPlanId,
  target: PaidPlanId,
  usage: { limit: number; period_start: number; period_end: number },
  now: number,
): boolean {
  const extra = PLANS[target].monthlyImages - PLANS[current].monthlyImages;
  if (extra <= 0) return false;
  const length = usage.period_end - usage.period_start;
  if (!(length > 0) || now < usage.period_start || now >= usage.period_end) return true;
  return PLANS[target].monthlyImages - Math.trunc((extra * (now - usage.period_start)) / length) > usage.limit;
}

/**
 * Switches a subscription between Starter and Pro now. An upgrade is charged
 * the prorated difference immediately; a downgrade is not billed at all (no
 * credit for the rest of the paid period, which keeps its allowance) and the
 * lower price applies from the next renewal. Crediting a downgrade would let a
 * customer upgrade, use the larger allowance in an hour and get the money back.
 * An upgrade that adds no images (`addsImages` false, see upgradeAddsImages) is
 * not billed either. The new plan reaches `users` through the subscription.updated webhook.
 */
export async function changeSubscriptionPlan(
  env: Env,
  subscriptionId: string,
  currentPlan: PaidPlanId,
  targetPlan: PaidPlanId,
  addsImages = true,
): Promise<void> {
  const priceId = configuredPriceId(env, targetPlan);
  if (!priceId) throw new ApiError('not_configured', 'Billing is not configured yet.');
  const upgrade = addsImages && PLANS[targetPlan].priceUsd > PLANS[currentPlan].priceUsd;
  await paddleRequest(
    env,
    'PATCH',
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { items: [{ price_id: priceId, quantity: 1 }], proration_billing_mode: upgrade ? 'prorated_immediately' : 'do_not_bill' },
    PLAN_CHANGE_CONFLICTS,
  );
}
