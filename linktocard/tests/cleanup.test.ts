// Daily housekeeping: what the cron run deletes, what it must keep, and that
// every run is bounded. Storage is shared by the file, so each test uses its
// own ids and asserts on those only.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { BATCH, DAY_MS } from '../src/config';
import { first, run } from '../src/db/client';
import worker from '../src/index';
import { CLEANUP_LIMITS, runCleanup } from '../src/lib/cleanup';
import { apiKeyFor, bearer, call, createSite, createUser, sessionCookieFor } from './app-helpers';
import { storeBatch } from './batch-helpers';

const NOW = Date.UTC(2027, 8, 1, 3, 17);

async function exists(table: string, column: string, value: string): Promise<boolean> {
  return (await first(env.DB, `SELECT 1 AS found FROM ${table} WHERE ${column} = ?1`, value)) !== null;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return (await first<{ n: number }>(env.DB, sql, ...params))?.n ?? 0;
}

async function addRender(userId: string, cacheKey: string, expiresAt: number, withObject = true): Promise<string> {
  const r2Key = `r/${userId}/${cacheKey}.png`;
  await run(
    env.DB,
    `INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
     VALUES (?1, ?2, NULL, 'api', 'blog', 1200, 630, 'png', 3, ?3, 'plan', 0, ?4, ?5)`,
    cacheKey,
    userId,
    r2Key,
    expiresAt - 7 * DAY_MS,
    expiresAt,
  );
  if (withObject) await env.BUCKET.put(r2Key, new Uint8Array([1, 2, 3]), { customMetadata: { expiresAt: String(expiresAt) } });
  return r2Key;
}

describe('runCleanup', () => {
  it('deletes expired sign-in tokens, sessions and old webhook events, and keeps live ones', async () => {
    const user = await createUser('free', NOW - 100 * DAY_MS);
    await run(
      env.DB,
      `INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES
       ('tok_old', 'a@example.com', ?1, ?1), ('tok_recent', 'a@example.com', ?2, ?2)`,
      NOW - DAY_MS,
      NOW - DAY_MS + 1,
    );
    await run(
      env.DB,
      `INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES
       ('ses_expired', ?1, 0, ?2), ('ses_live', ?1, 0, ?3)`,
      user.id,
      NOW,
      NOW + 1,
    );
    await run(
      env.DB,
      `INSERT INTO webhook_events (event_id, event_type, received_at) VALUES
       ('evt_ancient', 'transaction.completed', ?1), ('evt_kept', 'transaction.completed', ?2)`,
      NOW - 90 * DAY_MS,
      NOW - 90 * DAY_MS + 1,
    );

    const report = await runCleanup(env, NOW);
    expect(report).toMatchObject({ loginTokens: 1, sessions: 1, webhookEvents: 1 });
    expect(await exists('login_tokens', 'token_hash', 'tok_old')).toBe(false);
    expect(await exists('login_tokens', 'token_hash', 'tok_recent')).toBe(true);
    expect(await exists('sessions', 'id_hash', 'ses_expired')).toBe(false);
    expect(await exists('sessions', 'id_hash', 'ses_live')).toBe(true);
    expect(await exists('webhook_events', 'event_id', 'evt_ancient')).toBe(false);
    expect(await exists('webhook_events', 'event_id', 'evt_kept')).toBe(true);
  });

  it('deletes expired renders together with their R2 objects and keeps everything still cached', async () => {
    const user = await createUser('free', NOW - 100 * DAY_MS);
    const expired = await addRender(user.id, 'c'.repeat(63) + '1', NOW);
    const live = await addRender(user.id, 'c'.repeat(63) + '2', NOW + 1);
    const orphanRow = await addRender(user.id, 'c'.repeat(63) + '3', NOW - 5, false);

    const report = await runCleanup(env, NOW);
    expect(report.renders).toBe(2);
    expect(await env.BUCKET.head(expired)).toBeNull();
    expect(await exists('renders', 'r2_key', expired)).toBe(false);
    expect(await exists('renders', 'r2_key', orphanRow)).toBe(false);
    expect(await env.BUCKET.head(live)).not.toBeNull();
    expect(await exists('renders', 'r2_key', live)).toBe(true);
  });

  it('never deletes a render row before its R2 object: a failed R2 delete leaves the rows for the next run', async () => {
    const user = await createUser('free', NOW - 100 * DAY_MS);
    const r2Key = await addRender(user.id, 'd'.repeat(64), NOW - 1);
    const order: string[] = [];
    const failing = {
      ...env,
      BUCKET: {
        delete: () => {
          order.push('r2 delete');
          return Promise.reject(new Error('R2 is unavailable'));
        },
        list: (options: R2ListOptions) => env.BUCKET.list(options),
      } as unknown as R2Bucket,
    };
    await expect(runCleanup(failing, NOW)).rejects.toThrow('R2 is unavailable');
    expect(order).toEqual(['r2 delete']);
    expect(await exists('renders', 'r2_key', r2Key)).toBe(true);
    expect(await env.BUCKET.head(r2Key)).not.toBeNull();

    // The next healthy run finishes the job, object first.
    const deletes = vi.spyOn(env.BUCKET, 'delete');
    await runCleanup(env, NOW);
    expect(deletes.mock.calls[0]?.[0]).toContain(r2Key);
    expect(await exists('renders', 'r2_key', r2Key)).toBe(false);
    expect(await env.BUCKET.head(r2Key)).toBeNull();
    vi.restoreAllMocks();
  });

  it('is bounded per run and continues on the next run', async () => {
    const user = await createUser('free', NOW - 100 * DAY_MS);
    await runCleanup(env, NOW);
    const sessionsToAdd = CLEANUP_LIMITS.rowsPerStatement + 20;
    const rendersToAdd = CLEANUP_LIMITS.r2DeletesPerRun + 50;
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO sessions (id_hash, user_id, created_at, expires_at) SELECT 'bulk_ses_' || i, ?2, 0, ?3 FROM n`,
      sessionsToAdd,
      user.id,
      NOW - 1,
    );
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
       SELECT 'bulk_render_' || i, ?2, NULL, 'og', 'blog', 1200, 630, 'png', 1, 'r/' || ?2 || '/bulk_' || i || '.png', 'plan', 0, 0, ?3 FROM n`,
      rendersToAdd,
      user.id,
      NOW - 1,
    );
    const deletes = vi.spyOn(env.BUCKET, 'delete');

    const firstRun = await runCleanup(env, NOW);
    expect(firstRun.sessions).toBe(CLEANUP_LIMITS.rowsPerStatement);
    expect(firstRun.renders).toBe(CLEANUP_LIMITS.r2DeletesPerRun);
    expect(deletes.mock.calls.flatMap(([keys]) => keys)).toHaveLength(CLEANUP_LIMITS.r2DeletesPerRun);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE id_hash LIKE 'bulk_ses_%'")).toBe(20);
    expect(await count("SELECT COUNT(*) AS n FROM renders WHERE cache_key LIKE 'bulk_render_%'")).toBe(50);

    const secondRun = await runCleanup(env, NOW);
    expect(secondRun).toMatchObject({ sessions: 20, renders: 50 });
    expect(await runCleanup(env, NOW)).toEqual({ loginTokens: 0, sessions: 0, renders: 0, playgroundImages: 0, webhookEvents: 0, deletedAccounts: 0 });
    vi.restoreAllMocks();
  });

  it('fails stranded batch rows, deletes expired batches and old revoked certificate records', async () => {
    const day = (n: number): number => NOW - n * DAY_MS;
    // Unfinished and older than BATCH.staleAfterDays: its queue messages cannot arrive any more.
    const stale = await storeBatch({ template: 'invoice', rows: [{}, {}] }, { now: day(BATCH.staleAfterDays + 1) });
    const recent = await storeBatch({ template: 'invoice', rows: [{}] }, { now: day(1) });
    // Finished, and its newest PDF expired.
    const expired = await storeBatch({ template: 'invoice', rows: [{}] }, { now: day(60) });
    await run(env.DB, "UPDATE batches SET status = 'done', finished_at = ?2, expires_at = ?3 WHERE id = ?1", expired.batch.id, day(59), day(2));
    const user = await createUser('pro');
    const insert = 'INSERT INTO certificates (id, user_id, batch_id, row_index, created_at, revoked_at) VALUES (?1, ?2, NULL, NULL, ?3, ?4)';
    await run(env.DB, insert, 'crt_cleanupoldrevoked00', user.id, day(400), day(BATCH.revokedRetentionDays + 1));
    await run(env.DB, insert, 'crt_cleanupnewrevoked00', user.id, day(400), day(BATCH.revokedRetentionDays - 1));
    await run(env.DB, insert, 'crt_cleanupvalidrecord0', user.id, day(400), null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = await runCleanup(env, NOW);
    expect(report.staleBatchRows).toBeGreaterThanOrEqual(2);
    expect(report.batches).toBeGreaterThanOrEqual(1);
    expect(report.revokedCertificates).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id = ?1 AND status = 'failed'", stale.batch.id)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id = ?1 AND status = 'queued'", recent.batch.id)).toBe(1);
    expect(await exists('batches', 'id', expired.batch.id)).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id = ?1', expired.batch.id)).toBe(0);
    expect(await exists('certificates', 'id', 'crt_cleanupoldrevoked00')).toBe(false);
    expect(await exists('certificates', 'id', 'crt_cleanupnewrevoked00')).toBe(true);
    expect(await exists('certificates', 'id', 'crt_cleanupvalidrecord0')).toBe(true);
    vi.restoreAllMocks();
  });

  it('deletes playground images older than a day, by their stamp or their upload time', async () => {
    // Real time here: an object without a stamp is aged by R2's own upload time.
    const now = Date.now();
    const put = (key: string, createdAt?: number): Promise<R2Object> =>
      env.BUCKET.put(key, new Uint8Array([1]), createdAt === undefined ? {} : { customMetadata: { createdAt: String(createdAt) } });
    await put('p/old.png', now - DAY_MS);
    await put('p/fresh.png', now - DAY_MS + 1);
    await put('p/unstamped.png');
    await put('q/not-a-playground-image.png', now - 10 * DAY_MS);

    expect((await runCleanup(env, now)).playgroundImages).toBe(1);
    expect(await env.BUCKET.head('p/old.png')).toBeNull();
    expect(await env.BUCKET.head('p/fresh.png')).not.toBeNull();
    expect(await env.BUCKET.head('p/unstamped.png')).not.toBeNull();
    expect(await env.BUCKET.head('q/not-a-playground-image.png')).not.toBeNull();

    // Two days on, the fresh one and the unstamped one are both old.
    expect((await runCleanup(env, now + 2 * DAY_MS)).playgroundImages).toBe(2);
    expect(await env.BUCKET.head('p/unstamped.png')).toBeNull();
    expect(await env.BUCKET.head('q/not-a-playground-image.png')).not.toBeNull();
  });
});

describe('the scheduled handler', () => {
  it('runs the cleanup in the background and never throws', async () => {
    const user = await createUser('free', 0);
    await run(env.DB, "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ('ses_cron', ?1, 0, 1)", user.id);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await exists('sessions', 'id_hash', 'ses_cron')).toBe(false);
    expect(log.mock.calls.some(([label]) => label === 'cleanup:')).toBe(true);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { ...env, DB: { prepare: () => { throw new Error('D1 is down'); } } as unknown as D1Database };
    const failingCtx = createExecutionContext();
    await worker.scheduled(createScheduledController(), broken, failingCtx);
    await waitOnExecutionContext(failingCtx);
    expect(errors).toHaveBeenCalledWith('cleanup failed:', expect.any(Error));
    vi.restoreAllMocks();
  });
});

describe('account deletion on request', () => {
  // The command GO-LIVE.md gives the operator, with a fixed time instead of the clock.
  const markForDeletion = (email: string, at: number) =>
    run(env.DB, "UPDATE users SET suspended_at = ?1, suspended_reason = 'deletion requested', deletion_requested_at = ?1 WHERE email = ?2", at, email);
  const rowsOf = (table: string, userId: string) => count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`, userId);
  const keysUnder = async (prefix: string) => (await env.BUCKET.list({ prefix })).objects.map((object) => object.key);

  it('stops the account at once, then removes its files and every row that belongs to it, and nothing of anyone else', async () => {
    const doomed = await createUser('starter', NOW - 40 * DAY_MS);
    const other = await createUser('free', NOW - 40 * DAY_MS);
    const cookie = await sessionCookieFor(doomed.id, NOW - DAY_MS);
    const key = await apiKeyFor(doomed.id, NOW - DAY_MS);
    await createSite(doomed.id, NOW - DAY_MS);
    await addRender(doomed.id, 'ck_doomed_live', NOW + 20 * DAY_MS);
    await env.BUCKET.put(`f/${doomed.id}/f_font.woff`, new Uint8Array([1]));
    await run(env.DB, 'INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?1, 0, 1, 3)', doomed.id);
    await run(env.DB, "INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip) VALUES ('th_doomed', ?1, ?2, ?3, '192.0.2.1')", doomed.email, NOW - 60_000, NOW + 60_000);
    await run(env.DB, "INSERT INTO webhook_events (event_id, event_type, received_at, user_id, result) VALUES ('evt_doomed', 'subscription.created', ?1, ?2, 'ok')", NOW - DAY_MS, doomed.id);
    const othersImage = await addRender(other.id, 'ck_other_live', NOW + 20 * DAY_MS);

    await markForDeletion(doomed.email, NOW);
    // Suspended at once: the API key and the dashboard's write routes refuse it before any purge.
    expect((await call('/v1/usage', { headers: bearer(key.secret) })).status).toBe(403);
    expect((await call('/api/keys', { method: 'POST', headers: { cookie, origin: new URL(env.APP_URL).origin, 'content-type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(403);

    const report = await runCleanup(env, NOW);
    expect(report.deletedAccounts).toBe(1);
    expect(await exists('users', 'id', doomed.id)).toBe(false);
    for (const table of ['sessions', 'api_keys', 'sites', 'renders', 'usage_periods', 'webhook_events']) {
      expect(await rowsOf(table, doomed.id), table).toBe(0);
    }
    expect(await exists('login_tokens', 'email', doomed.email)).toBe(false);
    expect(await keysUnder(`r/${doomed.id}/`)).toEqual([]);
    expect(await keysUnder(`f/${doomed.id}/`)).toEqual([]);

    expect(await exists('users', 'id', other.id)).toBe(true);
    expect(await keysUnder(`r/${other.id}/`)).toEqual([othersImage]);
    expect((await runCleanup(env, NOW)).deletedAccounts).toBe(0);
  });

  it('an account with more files than one run may delete keeps its rows until a later run has removed every file', async () => {
    const big = await createUser('pro', NOW - 40 * DAY_MS);
    const files = CLEANUP_LIMITS.r2DeletesPerRun + 3;
    for (let start = 0; start < files; start += 500) {
      await Promise.all(
        Array.from({ length: Math.min(500, files - start) }, (_, i) => env.BUCKET.put(`r/${big.id}/k${start + i}.png`, new Uint8Array([1]))),
      );
    }
    await markForDeletion(big.email, NOW);

    expect((await runCleanup(env, NOW)).deletedAccounts).toBe(0);
    expect(await exists('users', 'id', big.id)).toBe(true);
    expect(await keysUnder(`r/${big.id}/`)).toHaveLength(3);

    expect((await runCleanup(env, NOW)).deletedAccounts).toBe(1);
    expect(await exists('users', 'id', big.id)).toBe(false);
    expect(await keysUnder(`r/${big.id}/`)).toEqual([]);
  });
});
