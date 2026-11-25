/**
 * Daily housekeeping (cron trigger). Every step is bounded, so one run costs a
 * handful of statements however much has piled up; the next run continues.
 *
 * Nothing here is needed for correctness - expired sessions, tokens and images
 * are already ignored by the code that reads them - it only keeps D1 and R2
 * from growing forever.
 */
import { DAY_MS } from '../config';
import { all, run } from '../db/client';
import type { Env } from '../types';

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

/**
 * Accounts the operator marked for deletion (users.deletion_requested_at; the
 * same command suspends them, so they already serve nothing). Files go first,
 * rows last: every table that references users cascades, and sign-in requests
 * and the webhook log, which do not, are deleted by email and id. An account
 * with more files than this run's budget is finished by the next run.
 */
async function purgeDeletedAccounts(env: Pick<Env, 'DB' | 'BUCKET'>): Promise<number> {
  const accounts = await all<{ id: string; email: string }>(
    env.DB,
    'SELECT id, email FROM users WHERE deletion_requested_at IS NOT NULL ORDER BY deletion_requested_at LIMIT ?1',
    CLEANUP_LIMITS.accountDeletionsPerRun,
  );
  const budget = { left: CLEANUP_LIMITS.r2DeletesPerRun };
  let purged = 0;
  for (const account of accounts) {
    if (!(await deleteAccountObjects(env.BUCKET, account.id, budget))) break;
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
  return {
    loginTokens,
    sessions,
    renders,
    playgroundImages,
    webhookEvents,
    deletedAccounts,
    ...(ogChecks > 0 ? { ogChecks } : {}),
    ...(toolUsage > 0 ? { toolUsage } : {}),
  };
}
