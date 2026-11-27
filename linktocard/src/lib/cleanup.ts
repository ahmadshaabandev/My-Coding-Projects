/**
 * Daily housekeeping (cron trigger). Every step is bounded, so one run costs a
 * handful of statements however much has piled up; the next run continues.
 * Stored PDFs have ledger rows like images and expire with them. Bulk documents: rows whose
 * queue message can no longer arrive are failed, finished batches go once their PDFs expired,
 * and certificate records BATCH.revokedRetentionDays after they were revoked. A deleted
 * account's batches, batch rows and certificate records go with it (in bounded steps first), and
 * so do its email image charge records (tool_usage rows, src/lib/open-fields.ts "Charge once"),
 * which have no foreign key to cascade from; expired ones go with the other tool_usage rows.
 *
 * Nothing here is needed for correctness - expired sessions, tokens and images
 * are already ignored by the code that reads them - it only keeps D1 and R2
 * from growing forever.
 */
import { purgeRevokedCertificates } from '../batch/certificates';
import { failStaleRows, purgeExpiredBatches } from '../batch/store';
import { BATCH, DAY_MS, PDF } from '../config';
import { all, isMissingTableError, run } from '../db/client';
import type { Env } from '../types';
import { emailChargeRange } from './open-fields';

export const CLEANUP_LIMITS = {
  /** Rows touched by any single statement. */
  rowsPerStatement: 500,
  /**
   * R2 objects deleted per run, per kind (expired renders, old playground images).
   * It has to stay above what can expire in a day: one Pro account alone renders
   * about 330 images a day, and the privacy page promises that images are kept
   * for the plan's cache period, not longer.
   */
  r2DeletesPerRun: 6000,
  /** Pages of 500 keys listed under p/ per run while looking for old playground images. */
  playgroundListPages: 20,
  /**
   * Old sign-in requests deleted per run. Each row holds an email address and an
   * IP, which the privacy page says are kept only briefly, and anyone can create
   * them: one client at the hourly cap alone makes 480 a day.
   */
  loginTokenDeletesPerRun: 20_000,
  /** Accounts whose deletion was requested, purged per run (each may need several runs if it stored many images). */
  accountDeletionsPerRun: 5,
  /**
   * Expired OG checker rows (og_checks results, tool_usage counters) deleted per run, per
   * table. Anyone can create them: 20 checks per client per hour, kept 10 minutes.
   */
  toolRowDeletesPerRun: 20_000,
  /** browser_usage rows older than PDF.browserUsageRetentionDays deleted per run (one row per PDF render attempt). */
  browserUsageDeletesPerRun: 20_000,
  /** Unfinished batches older than BATCH.staleAfterDays whose leftover rows are failed per run. */
  staleBatchesPerRun: 50,
  /** Expired batches deleted per statement: each takes up to BATCH.maxRows.pro rows with it (ON DELETE CASCADE). */
  batchesPerStatement: 20,
  /** Expired batches deleted per run. */
  batchDeletesPerRun: 500,
  /** Certificate records revoked more than BATCH.revokedRetentionDays ago deleted per run. */
  revokedCertificateDeletesPerRun: 20_000,
  /** Certificate records of deleted accounts deleted per run (their batches count against batchDeletesPerRun). */
  accountCertificateDeletesPerRun: 20_000,
  /** Email image charge records (one per charged image, kept EMAIL_FIELDS.chargeMemoryDays) of deleted accounts deleted per run. */
  accountEmailChargeDeletesPerRun: 20_000,
} as const;

const LOGIN_TOKEN_KEEP_MS = DAY_MS;
const PLAYGROUND_KEEP_MS = DAY_MS;
const WEBHOOK_EVENT_KEEP_MS = 90 * DAY_MS;
const PLAYGROUND_PREFIX = 'p/';
const LIST_PAGE_SIZE = 500;
/** D1 allows 100 bound parameters per statement. */
const KEYS_PER_DELETE = 90;
/** Keys per R2 delete call (R2 takes at most 1000) and expired renders handled per pass. */
const R2_DELETE_BATCH = 500;

export interface CleanupReport {
  loginTokens: number;
  sessions: number;
  renders: number;
  playgroundImages: number;
  webhookEvents: number;
  deletedAccounts: number;
  /** Expired OG checker results; present only when some were deleted. */
  ogChecks?: number;
  /** Ended OG checker / inspect counter windows; present only when some were deleted. */
  toolUsage?: number;
  /** PDF browser-time rows past their retention; present only when some were deleted. */
  browserUsage?: number;
  /** Batch rows failed because their queue message can no longer arrive; present only when some were. */
  staleBatchRows?: number;
  /** Finished batches whose PDFs expired, deleted with their rows; present only when some were. */
  batches?: number;
  /** Certificate records past their retention after revocation; present only when some were deleted. */
  revokedCertificates?: number;
}

/** R2 prefixes that hold one account's files: rendered images and uploaded fonts. */
export const accountPrefixes = (userId: string): string[] => [`r/${userId}/`, `f/${userId}/`];

/**
 * Deletes one account's R2 objects, at most `budget` of them. True when nothing
 * is left under its prefixes, so its rows may go.
 */
async function deleteAccountObjects(bucket: R2Bucket, userId: string, budget: { left: number }): Promise<boolean> {
  for (const prefix of accountPrefixes(userId)) {
    for (;;) {
      if (budget.left <= 0) return false;
      const listing = await bucket.list({ prefix, limit: Math.min(LIST_PAGE_SIZE, budget.left) });
      if (listing.objects.length === 0) break;
      await bucket.delete(listing.objects.map((object) => object.key));
      budget.left -= listing.objects.length;
    }
  }
  return true;
}

interface BatchBudget {
  batches: number;
  certificates: number;
}

/** Deletes `table` rows of one account, `step` per statement, until none is left (true) or the budget is spent (false). */
async function deleteAccountRows(db: D1Database, table: 'batches' | 'certificates', userId: string, budget: BatchBudget, key: keyof BatchBudget, step: number): Promise<boolean> {
  for (;;) {
    if (budget[key] <= 0) return false;
    const limit = Math.min(step, budget[key]);
    const changes = await run(db, `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE user_id = ?1 LIMIT ?2)`, userId, limit);
    budget[key] -= changes;
    if (changes < limit) return true;
  }
}

/**
 * One account's bulk documents before its users row goes: its batches (each takes up to
 * BATCH.maxRows.pro batch rows with it, ON DELETE CASCADE) and its certificate records, in
 * bounded statements, so the final cascade from users never has to delete them all in one
 * statement. True when none is left. The PDFs are ordinary stored PDFs, deleted with the
 * account's other files. A database without the batches migration has none.
 */
async function deleteAccountBatches(db: D1Database, userId: string, budget: BatchBudget): Promise<boolean> {
  try {
    return (
      (await deleteAccountRows(db, 'batches', userId, budget, 'batches', CLEANUP_LIMITS.batchesPerStatement)) &&
      (await deleteAccountRows(db, 'certificates', userId, budget, 'certificates', CLEANUP_LIMITS.rowsPerStatement))
    );
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    return true;
  }
}

/**
 * One account's email image charge records, in bounded statements: tool_usage rows have no user
 * id column to cascade from, so they are found by their bucket range. True when none is left.
 */
async function deleteAccountEmailCharges(db: D1Database, userId: string, budget: { left: number }): Promise<boolean> {
  const { from, to } = emailChargeRange(userId);
  for (;;) {
    if (budget.left <= 0) return false;
    const limit = Math.min(CLEANUP_LIMITS.rowsPerStatement, budget.left);
    const changes = await run(db, 'DELETE FROM tool_usage WHERE bucket IN (SELECT bucket FROM tool_usage WHERE bucket > ?1 AND bucket < ?2 LIMIT ?3)', from, to, limit);
    budget.left -= changes;
    if (changes < limit) return true;
  }
}

/**
 * Accounts the operator marked for deletion (users.deletion_requested_at; the
 * same command suspends them, so they already serve nothing). Files go first,
 * then bulk documents and email image charge records, rows last: every table
 * that references users cascades, and sign-in requests and the webhook log,
 * which do not, are deleted by email and id. An account with more files,
 * batches or charge records than this run's budget is finished by the next run.
 */
async function purgeDeletedAccounts(env: Pick<Env, 'DB' | 'BUCKET'>): Promise<number> {
  const accounts = await all<{ id: string; email: string }>(
    env.DB,
    'SELECT id, email FROM users WHERE deletion_requested_at IS NOT NULL ORDER BY deletion_requested_at LIMIT ?1',
    CLEANUP_LIMITS.accountDeletionsPerRun,
  );
  const budget = { left: CLEANUP_LIMITS.r2DeletesPerRun };
  const batchBudget: BatchBudget = { batches: CLEANUP_LIMITS.batchDeletesPerRun, certificates: CLEANUP_LIMITS.accountCertificateDeletesPerRun };
  const chargeBudget = { left: CLEANUP_LIMITS.accountEmailChargeDeletesPerRun };
  let purged = 0;
  for (const account of accounts) {
    if (!(await deleteAccountObjects(env.BUCKET, account.id, budget))) break;
    if (!(await deleteAccountBatches(env.DB, account.id, batchBudget))) break;
    if (!(await deleteAccountEmailCharges(env.DB, account.id, chargeBudget))) break;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_tokens WHERE email = ?1').bind(account.email),
      env.DB.prepare('DELETE FROM webhook_events WHERE user_id = ?1').bind(account.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?1 AND deletion_requested_at IS NOT NULL').bind(account.id),
    ]);
    purged++;
  }
  return purged;
}

/**
 * Expired ledger rows and their images. The R2 objects go first and the rows
 * only afterwards: a row whose object could not be deleted stays, so no object
 * is ever left behind without the row that points at it.
 */
async function deleteExpiredRenders(env: Pick<Env, 'DB' | 'BUCKET'>, now: number): Promise<number> {
  let deleted = 0;
  // Several passes per run, oldest first. `seen` bounds the loop even if a pass deletes nothing.
  for (let seen = 0; seen < CLEANUP_LIMITS.r2DeletesPerRun; ) {
    const expired = await all<{ cache_key: string; r2_key: string }>(
      env.DB,
      'SELECT cache_key, r2_key FROM renders WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2',
      now,
      Math.min(R2_DELETE_BATCH, CLEANUP_LIMITS.r2DeletesPerRun - seen),
    );
    if (expired.length === 0) break;
    seen += expired.length;
    await env.BUCKET.delete(expired.map((row) => row.r2_key));
    const statements: D1PreparedStatement[] = [];
    for (let start = 0; start < expired.length; start += KEYS_PER_DELETE) {
      const keys = expired.slice(start, start + KEYS_PER_DELETE).map((row) => row.cache_key);
      const placeholders = keys.map((_, index) => `?${index + 2}`).join(', ');
      // "expires_at <= now" again: a row that was re-charged since the SELECT is live and must stay.
      statements.push(env.DB.prepare(`DELETE FROM renders WHERE expires_at <= ?1 AND cache_key IN (${placeholders})`).bind(now, ...keys));
    }
    const results = await env.DB.batch(statements);
    const changed = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
    deleted += changed;
    // Rows that could not be deleted would be selected again: stop and leave them to the next run.
    if (changed < expired.length) break;
  }
  return deleted;
}

function createdAt(object: R2Object): number {
  const stamped = Number(object.customMetadata?.createdAt);
  return Number.isFinite(stamped) ? stamped : object.uploaded.getTime();
}

async function deleteOldPlaygroundImages(bucket: R2Bucket, now: number): Promise<number> {
  const cutoff = now - PLAYGROUND_KEEP_MS;
  const old: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CLEANUP_LIMITS.playgroundListPages && old.length < CLEANUP_LIMITS.r2DeletesPerRun; page++) {
    const listing = await bucket.list({ prefix: PLAYGROUND_PREFIX, limit: LIST_PAGE_SIZE, cursor, include: ['customMetadata'] });
    for (const object of listing.objects) {
      if (createdAt(object) <= cutoff && old.length < CLEANUP_LIMITS.r2DeletesPerRun) old.push(object.key);
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  for (let start = 0; start < old.length; start += R2_DELETE_BATCH) await bucket.delete(old.slice(start, start + R2_DELETE_BATCH));
  return old.length;
}

/** Deletes expired rows in statements of `limit`, until a short one shows the end or the cap is reached. */
async function deleteExpiredRows(db: D1Database, table: 'og_checks' | 'tool_usage', key: 'id' | 'bucket', now: number, limit: number): Promise<number> {
  let deleted = 0;
  while (deleted < CLEANUP_LIMITS.toolRowDeletesPerRun) {
    const changes = await run(
      db,
      `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= ?1 LIMIT ?2)`,
      now,
      Math.min(limit, CLEANUP_LIMITS.toolRowDeletesPerRun - deleted),
    );
    deleted += changes;
    if (changes < limit) break;
  }
  return deleted;
}

/** browser_usage rows (cost tracking of PDF renders) are kept PDF.browserUsageRetentionDays days. */
async function deleteOldBrowserUsage(db: D1Database, now: number, limit: number): Promise<number> {
  let deleted = 0;
  while (deleted < CLEANUP_LIMITS.browserUsageDeletesPerRun) {
    let changes: number;
    try {
      changes = await run(
        db,
        'DELETE FROM browser_usage WHERE id IN (SELECT id FROM browser_usage WHERE created_at <= ?1 LIMIT ?2)',
        now - PDF.browserUsageRetentionDays * DAY_MS,
        Math.min(limit, CLEANUP_LIMITS.browserUsageDeletesPerRun - deleted),
      );
    } catch (error) {
      // Deployed before migration 0006: nothing to clean, and the rest of the report still counts.
      if (!isMissingTableError(error)) throw error;
      console.error('browser_usage is missing: apply migration 0006_pdf.sql');
      return deleted;
    }
    deleted += changes;
    if (changes < limit) break;
  }
  return deleted;
}

export async function runCleanup(env: Pick<Env, 'DB' | 'BUCKET'>, now: number): Promise<CleanupReport> {
  const limit = CLEANUP_LIMITS.rowsPerStatement;
  // Sign-in tokens are kept a day, well past the hour in which they feed the per-address
  // and per-client caps. Several statements per run, until a short one shows the end.
  let loginTokens = 0;
  while (loginTokens < CLEANUP_LIMITS.loginTokenDeletesPerRun) {
    const changes = await run(
      env.DB,
      'DELETE FROM login_tokens WHERE token_hash IN (SELECT token_hash FROM login_tokens WHERE created_at <= ?1 LIMIT ?2)',
      now - LOGIN_TOKEN_KEEP_MS,
      Math.min(limit, CLEANUP_LIMITS.loginTokenDeletesPerRun - loginTokens),
    );
    loginTokens += changes;
    if (changes < limit) break;
  }
  const sessions = await run(
    env.DB,
    'DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at <= ?1 LIMIT ?2)',
    now,
    limit,
  );
  const webhookEvents = await run(
    env.DB,
    'DELETE FROM webhook_events WHERE event_id IN (SELECT event_id FROM webhook_events WHERE received_at <= ?1 LIMIT ?2)',
    now - WEBHOOK_EVENT_KEEP_MS,
    limit,
  );
  const renders = await deleteExpiredRenders(env, now);
  const playgroundImages = await deleteOldPlaygroundImages(env.BUCKET, now);
  const deletedAccounts = await purgeDeletedAccounts(env);
  const ogChecks = await deleteExpiredRows(env.DB, 'og_checks', 'id', now, limit);
  const toolUsage = await deleteExpiredRows(env.DB, 'tool_usage', 'bucket', now, limit);
  const browserUsage = await deleteOldBrowserUsage(env.DB, now, limit);
  const staleBatchRows = await failStaleRows(env.DB, now - BATCH.staleAfterDays * DAY_MS, now, CLEANUP_LIMITS.staleBatchesPerRun);
  const batches = await purgeExpiredBatches(env.DB, now, CLEANUP_LIMITS.batchesPerStatement, CLEANUP_LIMITS.batchDeletesPerRun);
  const revokedCertificates = await purgeRevokedCertificates(env.DB, now, limit, CLEANUP_LIMITS.revokedCertificateDeletesPerRun);
  return {
    loginTokens,
    sessions,
    renders,
    playgroundImages,
    webhookEvents,
    deletedAccounts,
    ...(ogChecks > 0 ? { ogChecks } : {}),
    ...(toolUsage > 0 ? { toolUsage } : {}),
    ...(browserUsage > 0 ? { browserUsage } : {}),
    ...(staleBatchRows > 0 ? { staleBatchRows } : {}),
    ...(batches > 0 ? { batches } : {}),
    ...(revokedCertificates > 0 ? { revokedCertificates } : {}),
  };
}
