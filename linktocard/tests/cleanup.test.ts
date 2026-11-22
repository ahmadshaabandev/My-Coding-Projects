// Daily housekeeping: what the cron run deletes, what it must keep, and that
// every run is bounded. Storage is shared by the file, so each test uses its
// own ids and asserts on those only.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS } from '../src/config';
import { first, run } from '../src/db/client';
import worker from '../src/index';
import { CLEANUP_LIMITS, runCleanup } from '../src/lib/cleanup';
import { createUser } from './app-helpers';

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
    expect(await runCleanup(env, NOW)).toEqual({ loginTokens: 0, sessions: 0, renders: 0, playgroundImages: 0, webhookEvents: 0 });
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
