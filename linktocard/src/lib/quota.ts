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
 *
 * PDFs (chargePdf) follow the same three steps with one difference: a PDF counts
 * as pdfUnits(pages) images (src/config.ts) and is charged as ONE block. The
 * block is taken whole from the monthly allowance when it fits there, otherwise
 * whole from the one top-up (oldest expiry first) that has enough left,
 * otherwise nothing is taken and the caller answers 402. A block is never split
 * between the allowance and a top-up or between two top-ups, so no counter can
 * go past its limit.
 *
 * A PDF's ledger row is claimed as charged_to = 'pending' BEFORE the PDF is
 * rendered (claimPdf) and becomes 'plan' or 'topup' in the same batch that takes
 * the block (chargeClaimedPdf), so a row that says it is paid always is. An
 * identical request that finds a pending row renders nothing and is not served:
 * the block may not fit, and the row may be released a moment later
 * (src/pdf/service.ts waits for the row to be paid or gone).
 */
import { effectivePlanId, getPlan, PLANS, TOPUP, type PlanId } from '../billing/plans';
import { DAY_MS, type ImageFormat } from '../config';
import { all, first, isMissingTableError, run } from '../db/client';
import type { RenderRow, UsageSummary, UserRow } from '../types';
import { randomId } from './crypto';

export interface Period {
  start: number;
  end: number;
}

/**
 * The columns of a user row that quota depends on (a full UserRow fits).
 * `cancel_at` is optional only so that a hand-built row still type-checks;
 * every row read from the database carries it.
 */
export type QuotaUser = Pick<UserRow, 'id' | 'plan' | 'period_start' | 'period_end'> & { cancel_at?: number | null };

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

/** A rendered PDF about to be stored; charged as one block of `units` images (pdfUnits(pages)). */
export interface PdfCharge {
  cacheKey: string;
  siteId: string | null;
  source: 'api' | 'signed';
  template: string;
  bytes: number;
  r2Key: string;
  ttlMs: number;
  units: number;
}

/** A ledger row as the dashboard lists it: images only (a PDF row has format 'pdf'). */
export type ImageRenderRow = RenderRow & { format: ImageFormat };

export type ChargeResult =
  | {
      status: 'charged';
      chargedTo: 'plan' | 'topup';
      usage: UsageSummary;
      /** Thresholds of the monthly allowance crossed by THIS image; each fires once per period and allowance. */
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
  /** usage_periods.allowance_adjust: set by a plan change inside the period. */
  adjust: number;
  topup_remaining: number;
}

interface AllowanceRow {
  used: number;
  /** The period's allowance: the plan's monthly images plus the adjustment. */
  allowance: number;
  notified_90: number;
  notified_100: number;
}

const MAX_RECENT_RENDERS = 100;

/* SQL. Shared convention: ?1 = user id, ?2 = now (epoch ms). */

const USABLE_TOPUP = 'user_id = ?1 AND refunded_at IS NULL AND remaining > 0 AND expires_at > ?2';
const NEXT_TOPUP = `SELECT id FROM topups WHERE ${USABLE_TOPUP} ORDER BY expires_at, created_at, id LIMIT 1`;

const COUNTERS_SQL = `SELECT
  COALESCE((SELECT used FROM usage_periods WHERE user_id = ?1 AND period_start = ?3), 0) AS used,
  COALESCE((SELECT allowance_adjust FROM usage_periods WHERE user_id = ?1 AND period_start = ?3), 0) AS adjust,
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

// ?3 is the plan's monthly images; the period's allowance adds allowance_adjust.
const TAKE_FROM_ALLOWANCE_SQL = `UPDATE usage_periods SET used = used + 1
  WHERE user_id = ?1 AND period_start = ?2 AND used < MAX(0, ?3 + allowance_adjust)
  RETURNING used, MAX(0, ?3 + allowance_adjust) AS allowance, notified_90, notified_100`;

// notified_* hold the allowance (?3) the notice was sent for, 0 = not sent. A
// plan change inside one period keeps the counter, so after an upgrade the
// customer must be warned again at 90% and 100% of the larger allowance.
const CLAIM_NOTIFIED_90_SQL =
  'UPDATE usage_periods SET notified_90 = ?3 WHERE user_id = ?1 AND period_start = ?2 AND notified_90 < ?3';
const CLAIM_NOTIFIED_100_SQL =
  'UPDATE usage_periods SET notified_100 = ?3 WHERE user_id = ?1 AND period_start = ?2 AND notified_100 < ?3';

// A scheduled cancellation has taken effect: the row returns to Free without
// waiting for Paddle's final event. subscription_event_at is left alone so a
// later event (a renewal after an un-cancel we never heard of) still applies.
const SETTLE_ENDED_PLAN_SQL = `UPDATE users SET
    plan = 'free', subscription_status = 'canceled', period_start = NULL, period_end = NULL, cancel_at = NULL
  WHERE id = ?1 AND plan <> 'free' AND cancel_at IS NOT NULL AND cancel_at <= ?2`;

// The three top-up statements run in one batch. The first two are guarded by the
// same "a usable top-up exists" test that the third acts on, and run before it
// changes anything, so inside the batch either all three apply or none does.
const LABEL_LEDGER_TOPUP_SQL = `UPDATE renders SET charged_to = 'topup' WHERE cache_key = ?3 AND EXISTS (${NEXT_TOPUP})`;
const COUNT_TOPUP_USE_SQL = `UPDATE usage_periods SET topup_used = topup_used + 1 WHERE user_id = ?1 AND period_start = ?3 AND EXISTS (${NEXT_TOPUP})`;
const TAKE_FROM_TOPUP_SQL = `UPDATE topups SET remaining = remaining - 1 WHERE id = (${NEXT_TOPUP})`;

/*
 * PDFs: a block of ?4 images. In each batch the statements that label the ledger row and count
 * the PDF run before the statement that takes the block and test exactly its condition, so
 * inside the batch (one transaction) either all of them apply or none does - the same rule as
 * the image top-up batch above.
 */

// ?1 user, ?2 period start, ?3 plan monthly images, ?4 units.
const PDF_FITS_ALLOWANCE = 'user_id = ?1 AND period_start = ?2 AND used + ?4 <= MAX(0, ?3 + allowance_adjust)';

// ?1 user, ?2 now, ?4 units. Only a top-up with the whole block left qualifies.
const NEXT_TOPUP_FOR_BLOCK = `SELECT id FROM topups
  WHERE user_id = ?1 AND refunded_at IS NULL AND remaining >= ?4 AND expires_at > ?2
  ORDER BY expires_at, created_at, id LIMIT 1`;

/*
 * The PDF ledger row. It is claimed unpaid ('pending') before the PDF is rendered, so identical
 * requests wait for that one render instead of making their own (src/pdf/service.ts). A claim
 * takes over an expired row or a pending row whose claimant has been gone for
 * PDF_PENDING_STALE_MS, and is refused while the cache key's failure is remembered (a live
 * tool_usage row with ?14 < bucket < ?15, src/pdf/guard.ts). It is labelled 'plan' or 'topup'
 * inside the batch that takes the block. The counting statements of each batch also require
 * that label, so a block is never taken for a row this request does not hold.
 *
 * PDF_PENDING_STALE_MS is measured from the claim (created_at is the time of the claim, also
 * for a request that claims after waiting for another one) and must be longer than anything a
 * live claimant does between its claim and its charge: up to 30 remote images (4 at a time,
 * 4 s each, about 30-50 s), the browser call (at most 75 s, CALL_TIMEOUT_MS in
 * src/pdf/render.ts) and a few D1 round trips. Taking over a live claimant only costs it its
 * charge (its batches no longer match), never a double charge.
 */
export const PDF_PENDING_STALE_MS = 180_000;
const PDF_LEDGER_STATE_SQL = 'SELECT charged_to, created_at, expires_at FROM renders WHERE cache_key = ?1';
const PDF_REMEMBERED_SQL =
  'SELECT bucket, count, expires_at FROM tool_usage WHERE bucket > ?1 AND bucket < ?2 AND expires_at > ?3 ORDER BY expires_at DESC LIMIT 1';
const CLAIM_PDF_LEDGER_SQL = `INSERT INTO renders
    (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?13
  WHERE NOT EXISTS (SELECT 1 FROM tool_usage WHERE bucket > ?14 AND bucket < ?15 AND expires_at > ?12)
  ON CONFLICT (cache_key) DO UPDATE SET
    user_id = excluded.user_id, site_id = excluded.site_id, source = excluded.source, template = excluded.template,
    width = excluded.width, height = excluded.height, format = excluded.format, bytes = excluded.bytes,
    r2_key = excluded.r2_key, charged_to = excluded.charged_to, period_start = excluded.period_start,
    created_at = excluded.created_at, expires_at = excluded.expires_at
  WHERE renders.expires_at <= excluded.created_at
     OR (renders.charged_to = 'pending' AND renders.created_at < excluded.created_at - ${PDF_PENDING_STALE_MS})
  RETURNING cache_key`;
// Releasing a claim. A row this claim inserted is deleted. A row that replaced an older one is
// expired instead (expires_at 0): the older row's PDF may still be in R2 at the same r2_key, and
// the daily cleanup removes the row and that object together. An object is never left behind
// without a row that points at it.
const RELEASE_PDF_LEDGER_SQL = "DELETE FROM renders WHERE cache_key = ?1 AND user_id = ?2 AND created_at = ?3 AND charged_to = 'pending'";
const EXPIRE_PDF_LEDGER_SQL = "UPDATE renders SET expires_at = 0 WHERE cache_key = ?1 AND user_id = ?2 AND created_at = ?3 AND charged_to = 'pending'";
// Remembers why a PDF failed; written only while this request still holds its claim, in the
// batch that then releases it, so an identical request sees either the claim or the note.
const NOTE_PDF_FAILURE_SQL = `INSERT INTO tool_usage (bucket, count, expires_at)
  SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM renders WHERE cache_key = ?4 AND user_id = ?5 AND created_at = ?6 AND charged_to = 'pending')
  ON CONFLICT (bucket) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`;

// Allowance batch: ?1 user, ?2 period start, ?3 plan monthly images, ?4 units, ?5 cache key, ?6 claim time, ?7 bytes.
const OUR_PDF_ROW = (label: 'plan' | 'topup', key: string, at: string): string =>
  `EXISTS (SELECT 1 FROM renders WHERE cache_key = ${key} AND user_id = ?1 AND created_at = ${at} AND charged_to = '${label}')`;
const LABEL_PDF_LEDGER_PLAN_SQL = `UPDATE renders SET charged_to = 'plan', bytes = ?7
  WHERE cache_key = ?5 AND user_id = ?1 AND created_at = ?6 AND charged_to = 'pending'
    AND EXISTS (SELECT 1 FROM usage_periods WHERE ${PDF_FITS_ALLOWANCE})`;
const COUNT_PAID_PDF_IN_ALLOWANCE_SQL = `INSERT INTO pdf_usage (user_id, period_start, pdfs, units)
  SELECT ?1, ?2, 1, ?4 WHERE EXISTS (SELECT 1 FROM usage_periods WHERE ${PDF_FITS_ALLOWANCE}) AND ${OUR_PDF_ROW('plan', '?5', '?6')}
  ON CONFLICT (user_id, period_start) DO UPDATE SET pdfs = pdfs + 1, units = units + excluded.units`;
const TAKE_PAID_BLOCK_FROM_ALLOWANCE_SQL = `UPDATE usage_periods SET used = used + ?4
  WHERE ${PDF_FITS_ALLOWANCE} AND ${OUR_PDF_ROW('plan', '?5', '?6')}
  RETURNING used, MAX(0, ?3 + allowance_adjust) AS allowance, notified_90, notified_100`;

// Top-up batch: ?1 user, ?2 now (the claim time), ?3 period start, ?4 units, ?5 cache key, ?6 bytes.
const LABEL_PDF_LEDGER_TOPUP_PAID_SQL = `UPDATE renders SET charged_to = 'topup', bytes = ?6
  WHERE cache_key = ?5 AND user_id = ?1 AND created_at = ?2 AND charged_to = 'pending' AND EXISTS (${NEXT_TOPUP_FOR_BLOCK})`;
const COUNT_PAID_BLOCK_TOPUP_USE_SQL = `UPDATE usage_periods SET topup_used = topup_used + ?4
  WHERE user_id = ?1 AND period_start = ?3 AND EXISTS (${NEXT_TOPUP_FOR_BLOCK}) AND ${OUR_PDF_ROW('topup', '?5', '?2')}`;
const COUNT_PAID_PDF_FROM_TOPUP_SQL = `INSERT INTO pdf_usage (user_id, period_start, pdfs, units)
  SELECT ?1, ?3, 1, ?4 WHERE EXISTS (${NEXT_TOPUP_FOR_BLOCK}) AND ${OUR_PDF_ROW('topup', '?5', '?2')}
  ON CONFLICT (user_id, period_start) DO UPDATE SET pdfs = pdfs + 1, units = units + excluded.units`;
const TAKE_PAID_BLOCK_FROM_TOPUP_SQL = `UPDATE topups SET remaining = remaining - ?4
  WHERE id = (${NEXT_TOPUP_FOR_BLOCK}) AND ${OUR_PDF_ROW('topup', '?5', '?2')}`;

const LARGEST_TOPUP_SQL = `SELECT COALESCE(MAX(remaining), 0) AS largest FROM topups WHERE ${USABLE_TOPUP}`;

/**
 * A paid account inside its Paddle billing period uses that period. Everyone
 * else - Free (including a paid row whose scheduled cancellation has taken
 * effect), or a paid row whose period is stale because a renewal webhook has
 * not arrived yet - uses the UTC calendar month containing `now`.
 */
export function currentPeriod(user: Pick<QuotaUser, 'plan' | 'period_start' | 'period_end' | 'cancel_at'>, now: number): Period {
  const { period_start: start, period_end: end } = user;
  if (effectivePlanId(user, now) !== 'free' && start !== null && end !== null && start <= now && now < end) return { start, end };
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
}

function summarize(planId: PlanId, period: Period, counters: Counters): UsageSummary {
  const plan = PLANS[planId];
  const limit = Math.max(0, plan.monthlyImages + counters.adjust);
  const remaining = Math.max(0, limit - counters.used);
  return {
    plan: plan.id,
    period_start: period.start,
    period_end: period.end,
    limit,
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

/**
 * The plan to count against at `now`. When a scheduled cancellation has taken
 * effect and Paddle's final event has not arrived, this also writes the return
 * to Free into the row, so that everything else that reads users.plan
 * (watermark, cache period, fonts, dashboard) agrees from the next request on.
 */
async function planInForce(db: D1Database, user: QuotaUser, now: number): Promise<PlanId> {
  const planId = effectivePlanId(user, now);
  if (planId === 'free' && getPlan(user.plan).id !== 'free') await run(db, SETTLE_ENDED_PLAN_SQL, user.id, now);
  return planId;
}

export async function getUsage(db: D1Database, user: QuotaUser, now: number): Promise<UsageSummary> {
  const planId = await planInForce(db, user, now);
  const period = currentPeriod(user, now);
  const result = await countersStatement(db, user.id, period, now).all<Counters>();
  return summarize(planId, period, countersFrom([result], 0));
}

/** Cheap pre-check before spending CPU on a render. chargeRender remains the authority. */
export async function hasQuota(db: D1Database, user: QuotaUser, now: number): Promise<boolean> {
  return (await getUsage(db, user, now)).total_remaining > 0;
}

/**
 * What a PDF can be charged against right now: the usage summary and the largest block that
 * fits in one place (the allowance left, or the fullest usable top-up). A PDF counts as at
 * least PDF.baseUnits images, so it is not rendered when the largest block is smaller.
 */
export async function pdfCapacity(db: D1Database, user: QuotaUser, now: number): Promise<{ usage: UsageSummary; largestBlock: number }> {
  const usage = await getUsage(db, user, now);
  const largestTopup = (await first<{ largest: number }>(db, LARGEST_TOPUP_SQL, user.id, now))?.largest ?? 0;
  return { usage, largestBlock: Math.max(usage.remaining, largestTopup) };
}

/**
 * PDFs charged in the current period and the images they counted as (GET /api/me usage.pdf).
 * Zero when the pdf_usage table does not exist yet (this code deployed before migration 0006):
 * the dashboard must not break over a PDF number while PDFs are off.
 */
export async function getPdfUsage(db: D1Database, user: QuotaUser, now: number): Promise<{ count: number; images: number }> {
  const period = currentPeriod(user, now);
  let row: { pdfs: number; units: number } | null;
  try {
    row = await first<{ pdfs: number; units: number }>(db, 'SELECT pdfs, units FROM pdf_usage WHERE user_id = ?1 AND period_start = ?2', user.id, period.start);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    console.error('pdf_usage is missing: apply migration 0006_pdf.sql');
    row = null;
  }
  return { count: row?.pdfs ?? 0, images: row?.units ?? 0 };
}

type LedgerEntry = Pick<RenderCharge, 'cacheKey' | 'siteId' | 'template' | 'bytes' | 'r2Key' | 'ttlMs'> & {
  source: RenderRow['source'];
  width: number;
  height: number;
  format: RenderRow['format'];
};

async function claimLedgerRow(db: D1Database, userId: string, period: Period, render: LedgerEntry, now: number): Promise<boolean> {
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

/** Records that a notice was sent for this allowance; true for exactly one caller per period and allowance. */
async function claimFlag(db: D1Database, sql: string, userId: string, period: Period, limit: number): Promise<boolean> {
  return (await run(db, sql, userId, period.start, limit)) === 1;
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
  const planId = await planInForce(db, user, now);
  const period = currentPeriod(user, now);
  if (!(await claimLedgerRow(db, user.id, period, render, now))) return { status: 'duplicate' };

  const allowance = await takeFromAllowance(db, user.id, period, PLANS[planId].monthlyImages, now);
  if (allowance.taken) {
    const { used, allowance: limit, notified_90: notified90, notified_100: notified100 } = allowance.taken;
    const crossed90 = notified90 < limit && used * 10 >= limit * 9 && (await claimFlag(db, CLAIM_NOTIFIED_90_SQL, user.id, period, limit));
    const crossed100 = notified100 < limit && used >= limit && (await claimFlag(db, CLAIM_NOTIFIED_100_SQL, user.id, period, limit));
    return { status: 'charged', chargedTo: 'plan', usage: summarize(planId, period, allowance.counters), crossed90, crossed100 };
  }

  const topup = await takeFromTopup(db, user.id, period, render.cacheKey, now);
  const usage = summarize(planId, period, topup.counters);
  if (topup.taken) return { status: 'charged', chargedTo: 'topup', usage, crossed90: false, crossed100: false };

  await run(db, RELEASE_LEDGER_SQL, render.cacheKey, user.id, now);
  return { status: 'quota_exceeded', usage };
}

function crossedThresholds(taken: AllowanceRow): { crossed90: boolean; crossed100: boolean; limit: number } {
  const { used, allowance: limit, notified_90: notified90, notified_100: notified100 } = taken;
  return { crossed90: notified90 < limit && used * 10 >= limit * 9, crossed100: notified100 < limit && used >= limit, limit };
}

/** What a PDF claim records before the PDF exists; the bytes are filled in when it is paid. */
export type PdfClaimInput = Omit<PdfCharge, 'bytes' | 'units'> & { bytes?: number };

/** A ledger row this request holds 'pending', created at the request's time. */
export interface PdfClaim {
  cacheKey: string;
  userId: string;
  createdAt: number;
  planId: PlanId;
  period: Period;
  /** The claim replaced an older row (expired, or pending and abandoned): releasing it expires it instead of deleting it. */
  tookOver: boolean;
}

/** The ledger row of a PDF as a claim sees it: whether it is paid, and for how long. */
export interface PdfLedgerState {
  charged_to: 'plan' | 'topup' | 'pending';
  created_at: number;
  expires_at: number;
}

/** A tool_usage row that remembers why a PDF failed (written by releasePdfClaim; meaning in src/pdf/guard.ts). */
export interface PdfFailureNote {
  bucket: string;
  count: number;
  expiresAt: number;
}

/** The tool_usage buckets strictly between `from` and `to`: one cache key's remembered failure. */
export interface PdfFailureRange {
  from: string;
  to: string;
}

export interface PdfRememberedRow {
  bucket: string;
  count: number;
  expires_at: number;
}

export type PdfClaimResult =
  | { status: 'claimed'; claim: PdfClaim }
  /** Another request holds the cache key: the row is paid, or pending and its claimant not gone. */
  | { status: 'held'; ledger: PdfLedgerState }
  /** The cache key's failure is remembered (a live row in the range): nothing is claimed while it lasts. */
  | { status: 'remembered'; row: PdfRememberedRow };

const NO_RANGE: PdfFailureRange = { from: '', to: '' };

/** True when this row keeps a claim at `now` from taking it over (the complement of the claim's ON CONFLICT ... WHERE). */
function holdsCacheKey(row: PdfLedgerState, now: number): boolean {
  return row.expires_at > now && (row.charged_to !== 'pending' || row.created_at >= now - PDF_PENDING_STALE_MS);
}

/**
 * Claims the ledger row of a PDF before it is rendered (see the module comment). The state
 * before the claim, the remembered failure and the claim itself are one batch, so they see one
 * snapshot: an identical request finds either this claim, the PDF paid, or the failure note
 * that the claimant wrote when it released the row.
 */
export async function claimPdf(
  db: D1Database,
  user: QuotaUser,
  pdf: PdfClaimInput,
  now: number,
  unlessRemembered: PdfFailureRange = NO_RANGE,
): Promise<PdfClaimResult> {
  const planId = await planInForce(db, user, now);
  const period = currentPeriod(user, now);
  const { from, to } = unlessRemembered;
  const results = await db.batch([
    db.prepare(PDF_LEDGER_STATE_SQL).bind(pdf.cacheKey),
    db.prepare(PDF_REMEMBERED_SQL).bind(from, to, now),
    db
      .prepare(CLAIM_PDF_LEDGER_SQL)
      .bind(pdf.cacheKey, user.id, pdf.siteId, pdf.source, pdf.template, 0, 0, 'pdf', pdf.bytes ?? 0, pdf.r2Key, period.start, now, now + pdf.ttlMs, from, to),
  ]);
  const before = rowsOf<PdfLedgerState>(results, 0)[0] ?? null;
  const remembered = rowsOf<PdfRememberedRow>(results, 1)[0] ?? null;
  if (rowsOf(results, 2).length === 1) {
    return { status: 'claimed', claim: { cacheKey: pdf.cacheKey, userId: user.id, createdAt: now, planId, period, tookOver: before !== null } };
  }
  if (before !== null && holdsCacheKey(before, now)) return { status: 'held', ledger: before };
  if (remembered !== null) return { status: 'remembered', row: remembered };
  throw new Error(`PDF ledger claim of ${pdf.cacheKey}: neither claimed, held nor remembered`);
}

/**
 * What a claim would find, read only: another request holds the cache key, its failure is
 * remembered, or it can be claimed ('free'). Requests that wait for an identical request look
 * with this and send the claim (a write) only when it can succeed.
 */
export async function peekPdfClaim(
  db: D1Database,
  cacheKey: string,
  now: number,
  unlessRemembered: PdfFailureRange = NO_RANGE,
): Promise<Exclude<PdfClaimResult, { status: 'claimed' }> | { status: 'free' }> {
  const results = await db.batch([db.prepare(PDF_LEDGER_STATE_SQL).bind(cacheKey), db.prepare(PDF_REMEMBERED_SQL).bind(unlessRemembered.from, unlessRemembered.to, now)]);
  const ledger = rowsOf<PdfLedgerState>(results, 0)[0] ?? null;
  const remembered = rowsOf<PdfRememberedRow>(results, 1)[0] ?? null;
  if (ledger !== null && holdsCacheKey(ledger, now)) return { status: 'held', ledger };
  if (remembered !== null) return { status: 'remembered', row: remembered };
  return { status: 'free' };
}

/**
 * Releases a claim that ends without a paid PDF, optionally remembering why (the note is
 * written only if the claim is still this request's, in the same batch). True when the claim
 * was still held; false when another request had taken it over.
 */
export async function releasePdfClaim(db: D1Database, claim: PdfClaim, note?: PdfFailureNote): Promise<boolean> {
  const release = db.prepare(claim.tookOver ? EXPIRE_PDF_LEDGER_SQL : RELEASE_PDF_LEDGER_SQL).bind(claim.cacheKey, claim.userId, claim.createdAt);
  const statements = note
    ? [db.prepare(NOTE_PDF_FAILURE_SQL).bind(note.bucket, note.count, note.expiresAt, claim.cacheKey, claim.userId, claim.createdAt), release]
    : [release];
  const results = await db.batch(statements);
  return results[statements.length - 1]?.meta.changes === 1;
}

export type PdfChargeResult = Exclude<ChargeResult, { status: 'duplicate' }> | { status: 'lost' };

/**
 * Charges a claimed PDF that has just been rendered, as one block of `pdf.units` images (see
 * the module comment):
 *
 *   charged         the block was taken from the allowance or from one top-up; the row is paid
 *   quota_exceeded  no single place has the whole block left; nothing was taken, the claim is
 *                   released and `onExceeded` remembered
 *   lost            the claim had been taken over by another request (this one took longer than
 *                   PDF_PENDING_STALE_MS); nothing was taken
 */
export async function chargeClaimedPdf(
  db: D1Database,
  claim: PdfClaim,
  pdf: { units: number; bytes: number },
  onExceeded?: PdfFailureNote,
): Promise<PdfChargeResult> {
  if (!Number.isInteger(pdf.units) || pdf.units < 1) throw new RangeError('a PDF must be charged a positive whole number of images');
  const { userId, period, planId, cacheKey, createdAt: now } = claim;
  const limit = PLANS[planId].monthlyImages;
  const allowance = await db.batch([
    db.prepare(OPEN_PERIOD_SQL).bind(userId, period.start, period.end),
    db.prepare(LABEL_PDF_LEDGER_PLAN_SQL).bind(userId, period.start, limit, pdf.units, cacheKey, now, pdf.bytes),
    db.prepare(COUNT_PAID_PDF_IN_ALLOWANCE_SQL).bind(userId, period.start, limit, pdf.units, cacheKey, now),
    db.prepare(TAKE_PAID_BLOCK_FROM_ALLOWANCE_SQL).bind(userId, period.start, limit, pdf.units, cacheKey, now),
    countersStatement(db, userId, period, now),
  ]);
  const taken = rowsOf<AllowanceRow>(allowance, 3)[0];
  if (taken) {
    const thresholds = crossedThresholds(taken);
    const crossed90 = thresholds.crossed90 && (await claimFlag(db, CLAIM_NOTIFIED_90_SQL, userId, period, thresholds.limit));
    const crossed100 = thresholds.crossed100 && (await claimFlag(db, CLAIM_NOTIFIED_100_SQL, userId, period, thresholds.limit));
    return { status: 'charged', chargedTo: 'plan', usage: summarize(planId, period, countersFrom(allowance, 4)), crossed90, crossed100 };
  }

  const topup = await db.batch([
    db.prepare(LABEL_PDF_LEDGER_TOPUP_PAID_SQL).bind(userId, now, period.start, pdf.units, cacheKey, pdf.bytes),
    db.prepare(COUNT_PAID_BLOCK_TOPUP_USE_SQL).bind(userId, now, period.start, pdf.units, cacheKey),
    db.prepare(COUNT_PAID_PDF_FROM_TOPUP_SQL).bind(userId, now, period.start, pdf.units, cacheKey),
    db.prepare(TAKE_PAID_BLOCK_FROM_TOPUP_SQL).bind(userId, now, period.start, pdf.units, cacheKey),
    countersStatement(db, userId, period, now),
  ]);
  const usage = summarize(planId, period, countersFrom(topup, 4));
  if (topup[3]?.meta.changes === 1) return { status: 'charged', chargedTo: 'topup', usage, crossed90: false, crossed100: false };

  return (await releasePdfClaim(db, claim, onExceeded)) ? { status: 'quota_exceeded', usage } : { status: 'lost' };
}

/**
 * Claims and charges a PDF in one go, as one block of `pdf.units` images. Same results and the
 * same ledger guarantees as chargeRender:
 *
 *   charged         the block was taken from the allowance or from one top-up
 *   duplicate       a ledger row already covers this cache key (paid, or another request's
 *                   pending claim): no charge
 *   quota_exceeded  no single place has the whole block left; nothing was taken
 *
 * src/pdf/service.ts claims before rendering instead (claimPdf, then chargeClaimedPdf).
 */
export async function chargePdf(db: D1Database, user: QuotaUser, pdf: PdfCharge, now: number): Promise<ChargeResult> {
  if (!Number.isInteger(pdf.units) || pdf.units < 1) throw new RangeError('a PDF must be charged a positive whole number of images');
  const claimed = await claimPdf(db, user, pdf, now);
  if (claimed.status !== 'claimed') return { status: 'duplicate' };
  const result = await chargeClaimedPdf(db, claimed.claim, pdf);
  return result.status === 'lost' ? { status: 'duplicate' } : result;
}

export function readPdfLedger(db: D1Database, userId: string, cacheKey: string): Promise<PdfLedgerState | null> {
  return first<PdfLedgerState>(db, 'SELECT charged_to, created_at, expires_at FROM renders WHERE cache_key = ?1 AND user_id = ?2', cacheKey, userId);
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

/** Stored images, newest first; `limit` is clamped to 1..100. Stored PDFs are not listed. */
export function listRecentRenders(db: D1Database, userId: string, limit: number): Promise<ImageRenderRow[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_RECENT_RENDERS);
  return all<ImageRenderRow>(
    db,
    "SELECT * FROM renders WHERE user_id = ?1 AND format <> 'pdf' ORDER BY created_at DESC, cache_key LIMIT ?2",
    userId,
    capped,
  );
}
