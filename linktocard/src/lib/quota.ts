/**
 * Quota: the hard stop.
 *
 * One image = one successful, uncached render of one size. Failed renders and
 * cache hits never count; unused monthly quota does not roll over. An image is
 * taken from the plan's monthly allowance first and, once that is exhausted,
 * from purchased top-ups (oldest expiry first). When neither has an image left
 * the caller answers HTTP 402.
 *
 * D1 has no interactive transactions, so every counter change is a single
 * conditional statement or one atomic db.batch(), and a charge runs in this
 * order:
 *
 *   1. claim the ledger row for the cache key   (stops double charging)
 *   2. take one image from the allowance, else from a top-up   (atomic)
 *   3. if nothing was left, release the ledger row
 *
 * A crash or D1 error after step 1 leaves a ledger row with no counter change:
 * the customer keeps a cached image they were never charged for. That is the
 * deliberate direction of failure - this module can under-count in rare
 * failures but can never over-count.
 */
import { getPlan, TOPUP } from '../billing/plans';
import { DAY_MS, type ImageFormat } from '../config';
import { all, first, run } from '../db/client';
import type { RenderRow, UsageSummary, UserRow } from '../types';
import { randomId } from './crypto';

export interface Period {
  start: number;
  end: number;
}

/** The columns of a user row that quota depends on (a full UserRow fits). */
export type QuotaUser = Pick<UserRow, 'id' | 'plan' | 'period_start' | 'period_end'>;

/** A successful render about to be cached; cacheKey must already be scoped to the account. */
export interface RenderCharge {
  cacheKey: string;
  siteId: string | null;
  source: 'og' | 'api';
  template: string;
  width: number;
  height: number;
  format: ImageFormat;
  bytes: number;
  r2Key: string;
  /** How long the image stays cached, i.e. how long the same cache key is not charged again. */
  ttlMs: number;
}

export type ChargeResult =
  | {
      status: 'charged';
      chargedTo: 'plan' | 'topup';
      usage: UsageSummary;
      /** Thresholds of the monthly allowance crossed by THIS image; each fires once per period. */
      crossed90: boolean;
      crossed100: boolean;
    }
  | { status: 'duplicate' }
  | { status: 'quota_exceeded'; usage: UsageSummary };

export interface TopupCredit {
  userId: string;
  /** Paddle transaction id (txn_...): the idempotency key. */
  transactionId: string;
  images: number;
  now: number;
}

interface Counters {
  used: number;
  topup_remaining: number;
}

interface AllowanceRow {
  used: number;
  notified_90: number;
  notified_100: number;
}

const MAX_RECENT_RENDERS = 100;

/* SQL. Shared convention: ?1 = user id, ?2 = now (epoch ms). */

const USABLE_TOPUP = 'user_id = ?1 AND refunded_at IS NULL AND remaining > 0 AND expires_at > ?2';
const NEXT_TOPUP = `SELECT id FROM topups WHERE ${USABLE_TOPUP} ORDER BY expires_at, created_at, id LIMIT 1`;

const COUNTERS_SQL = `SELECT
  COALESCE((SELECT used FROM usage_periods WHERE user_id = ?1 AND period_start = ?3), 0) AS used,
  COALESCE((SELECT SUM(remaining) FROM topups WHERE ${USABLE_TOPUP}), 0) AS topup_remaining`;

// Inserts the ledger row, or takes over an expired one. Returns no row when an
// unexpired row exists, i.e. when this cached image has already been paid for.
const CLAIM_LEDGER_SQL = `INSERT INTO renders
    (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'plan', ?11, ?12, ?13)
  ON CONFLICT (cache_key) DO UPDATE SET
    user_id = excluded.user_id, site_id = excluded.site_id, source = excluded.source, template = excluded.template,
    width = excluded.width, height = excluded.height, format = excluded.format, bytes = excluded.bytes,
    r2_key = excluded.r2_key, charged_to = excluded.charged_to, period_start = excluded.period_start,
    created_at = excluded.created_at, expires_at = excluded.expires_at
  WHERE renders.expires_at <= excluded.created_at
  RETURNING cache_key`;

const RELEASE_LEDGER_SQL = 'DELETE FROM renders WHERE cache_key = ?1 AND user_id = ?2 AND created_at = ?3';

const OPEN_PERIOD_SQL =
  'INSERT INTO usage_periods (user_id, period_start, period_end) VALUES (?1, ?2, ?3) ON CONFLICT (user_id, period_start) DO NOTHING';

const TAKE_FROM_ALLOWANCE_SQL =
  'UPDATE usage_periods SET used = used + 1 WHERE user_id = ?1 AND period_start = ?2 AND used < ?3 RETURNING used, notified_90, notified_100';

const CLAIM_NOTIFIED_90_SQL =
  'UPDATE usage_periods SET notified_90 = 1 WHERE user_id = ?1 AND period_start = ?2 AND notified_90 = 0';
const CLAIM_NOTIFIED_100_SQL =
  'UPDATE usage_periods SET notified_100 = 1 WHERE user_id = ?1 AND period_start = ?2 AND notified_100 = 0';

// The three top-up statements run in one batch. The first two are guarded by the
// same "a usable top-up exists" test that the third acts on, and run before it
// changes anything, so inside the batch either all three apply or none does.
const LABEL_LEDGER_TOPUP_SQL = `UPDATE renders SET charged_to = 'topup' WHERE cache_key = ?3 AND EXISTS (${NEXT_TOPUP})`;
const COUNT_TOPUP_USE_SQL = `UPDATE usage_periods SET topup_used = topup_used + 1 WHERE user_id = ?1 AND period_start = ?3 AND EXISTS (${NEXT_TOPUP})`;
const TAKE_FROM_TOPUP_SQL = `UPDATE topups SET remaining = remaining - 1 WHERE id = (${NEXT_TOPUP})`;

/**
 * A paid account inside its Paddle billing period uses that period. Everyone
 * else - Free, or a paid row whose period is stale because a renewal webhook
 * has not arrived yet - uses the UTC calendar month containing `now`.
 */
export function currentPeriod(user: Pick<UserRow, 'plan' | 'period_start' | 'period_end'>, now: number): Period {
  const { period_start: start, period_end: end } = user;
  if (user.plan !== 'free' && start !== null && end !== null && start <= now && now < end) return { start, end };
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
}

function summarize(user: QuotaUser, period: Period, counters: Counters): UsageSummary {
  const plan = getPlan(user.plan);
  const remaining = Math.max(0, plan.monthlyImages - counters.used);
  return {
    plan: plan.id,
    period_start: period.start,
    period_end: period.end,
    limit: plan.monthlyImages,
    used: counters.used,
    remaining,
    topup_remaining: counters.topup_remaining,
    total_remaining: remaining + counters.topup_remaining,
    cache_days: plan.cacheDays,
    watermark: plan.watermark,
  };
}

function countersStatement(db: D1Database, userId: string, period: Period, now: number): D1PreparedStatement {
  return db.prepare(COUNTERS_SQL).bind(userId, now, period.start);
}

function rowsOf<T>(results: D1Result[], index: number): T[] {
  return (results[index]?.results ?? []) as T[];
}

/** The counters query is a SELECT without FROM: it always yields exactly one row. */
function countersFrom(results: D1Result[], index: number): Counters {
  const row = rowsOf<Counters>(results, index)[0];
  if (!row) throw new Error('usage counters query returned no row');
  return row;
}

export async function getUsage(db: D1Database, user: QuotaUser, now: number): Promise<UsageSummary> {
  const period = currentPeriod(user, now);
  const result = await countersStatement(db, user.id, period, now).all<Counters>();
  return summarize(user, period, countersFrom([result], 0));
}

/** Cheap pre-check before spending CPU on a render. chargeRender remains the authority. */
export async function hasQuota(db: D1Database, user: QuotaUser, now: number): Promise<boolean> {
  return (await getUsage(db, user, now)).total_remaining > 0;
}

async function claimLedgerRow(db: D1Database, userId: string, period: Period, render: RenderCharge, now: number): Promise<boolean> {
  const claimed = await first<{ cache_key: string }>(
    db,
    CLAIM_LEDGER_SQL,
    render.cacheKey,
    userId,
    render.siteId,
    render.source,
    render.template,
    render.width,
    render.height,
    render.format,
    render.bytes,
    render.r2Key,
    period.start,
    now,
    now + render.ttlMs,
  );
  return claimed !== null;
}

async function takeFromAllowance(
  db: D1Database,
  userId: string,
  period: Period,
  limit: number,
  now: number,
): Promise<{ taken: AllowanceRow | null; counters: Counters }> {
  const results = await db.batch([
    db.prepare(OPEN_PERIOD_SQL).bind(userId, period.start, period.end),
    db.prepare(TAKE_FROM_ALLOWANCE_SQL).bind(userId, period.start, limit),
    countersStatement(db, userId, period, now),
  ]);
  return { taken: rowsOf<AllowanceRow>(results, 1)[0] ?? null, counters: countersFrom(results, 2) };
}

async function takeFromTopup(
  db: D1Database,
  userId: string,
  period: Period,
  cacheKey: string,
  now: number,
): Promise<{ taken: boolean; counters: Counters }> {
  const results = await db.batch([
    db.prepare(LABEL_LEDGER_TOPUP_SQL).bind(userId, now, cacheKey),
    db.prepare(COUNT_TOPUP_USE_SQL).bind(userId, now, period.start),
    db.prepare(TAKE_FROM_TOPUP_SQL).bind(userId, now),
    countersStatement(db, userId, period, now),
  ]);
  return { taken: results[2]?.meta.changes === 1, counters: countersFrom(results, 3) };
}

/** Sets a notified_* flag if it is still unset; true for exactly one caller per period. */
async function claimFlag(db: D1Database, sql: string, userId: string, period: Period): Promise<boolean> {
  return (await run(db, sql, userId, period.start)) === 1;
}

/**
 * Charges one image for a render that has just succeeded.
 *
 *   charged         one image was taken from the allowance or a top-up
 *   duplicate       an unexpired ledger row already covers this cache key: no charge
 *   quota_exceeded  nothing left; the ledger row was released again
 *
 * If D1 fails after the ledger row is claimed the error propagates and the row
 * is intentionally left in place: we cannot know whether the charge committed,
 * and removing the row could charge the customer twice for one image.
 */
export async function chargeRender(db: D1Database, user: QuotaUser, render: RenderCharge, now: number): Promise<ChargeResult> {
  const period = currentPeriod(user, now);
  if (!(await claimLedgerRow(db, user.id, period, render, now))) return { status: 'duplicate' };

  const limit = getPlan(user.plan).monthlyImages;
  const allowance = await takeFromAllowance(db, user.id, period, limit, now);
  if (allowance.taken) {
    const { used, notified_90: notified90, notified_100: notified100 } = allowance.taken;
    const crossed90 = notified90 === 0 && used * 10 >= limit * 9 && (await claimFlag(db, CLAIM_NOTIFIED_90_SQL, user.id, period));
    const crossed100 = notified100 === 0 && used >= limit && (await claimFlag(db, CLAIM_NOTIFIED_100_SQL, user.id, period));
    return { status: 'charged', chargedTo: 'plan', usage: summarize(user, period, allowance.counters), crossed90, crossed100 };
  }

  const topup = await takeFromTopup(db, user.id, period, render.cacheKey, now);
  const usage = summarize(user, period, topup.counters);
  if (topup.taken) return { status: 'charged', chargedTo: 'topup', usage, crossed90: false, crossed100: false };

  await run(db, RELEASE_LEDGER_SQL, render.cacheKey, user.id, now);
  return { status: 'quota_exceeded', usage };
}

/**
 * Records a purchased top-up. Idempotent on the Paddle transaction id, so a
 * redelivered webhook cannot credit twice. False when it already existed.
 */
export async function creditTopup(db: D1Database, credit: TopupCredit): Promise<boolean> {
  if (!Number.isInteger(credit.images) || credit.images <= 0) {
    throw new RangeError('top-up images must be a positive integer');
  }
  const inserted = await first<{ id: string }>(
    db,
    `INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
     ON CONFLICT (paddle_transaction_id) DO NOTHING
     RETURNING id`,
    randomId('tu'),
    credit.userId,
    credit.transactionId,
    credit.images,
    credit.now,
    credit.now + TOPUP.validDays * DAY_MS,
  );
  return inserted !== null;
}

/** Stops a refunded top-up from being used. `remaining` is kept as the audit trail. False if unknown or already refunded. */
export async function markTopupRefunded(db: D1Database, transactionId: string, now: number): Promise<boolean> {
  const changes = await run(
    db,
    'UPDATE topups SET refunded_at = ?1 WHERE paddle_transaction_id = ?2 AND refunded_at IS NULL',
    now,
    transactionId,
  );
  return changes === 1;
}

/** Newest first; `limit` is clamped to 1..100. */
export function listRecentRenders(db: D1Database, userId: string, limit: number): Promise<RenderRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_RECENT_RENDERS);
  return all<RenderRow>(db, 'SELECT * FROM renders WHERE user_id = ?1 ORDER BY created_at DESC, cache_key LIMIT ?2', userId, capped);
}
