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

export async function runCleanup(env: Pick<Env, 'DB' | 'BUCKET'>, now: number): Promise<CleanupReport> {
  const limit = CLEANUP_LIMITS.rowsPerStatement;
  // Sign-in tokens are kept a day, well past the hour in which they feed the per-address cap.
  const loginTokens = await run(
    env.DB,
    'DELETE FROM login_tokens WHERE token_hash IN (SELECT token_hash FROM login_tokens WHERE created_at <= ?1 LIMIT ?2)',
    now - LOGIN_TOKEN_KEEP_MS,
    limit,
  );
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
  return { loginTokens, sessions, renders, playgroundImages, webhookEvents };
}
