// Independent review of account deletion (GO-LIVE.md section 8 + purgeDeletedAccounts).
// Storage is shared by the file, so each test uses its own ids and asserts on those only.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/config';
import { all, findOrCreateUserByEmail, first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
// @ts-expect-error -- Vite raw import; the suite has no vite/client types.
import goLive from '../GO-LIVE.md?raw';
import { apiKeyFor, createSite, createUser, sessionCookieFor } from './app-helpers';

const NOW = Date.UTC(2027, 8, 1, 3, 17);
const CHILD_TABLES = ['sessions', 'api_keys', 'sites', 'templates', 'fonts', 'usage_periods', 'topups', 'renders', 'webhook_events'];

const n = async (sql: string, ...params: unknown[]): Promise<number> => (await first<{ n: number }>(env.DB, sql, ...params))?.n ?? 0;
const rowsOf = (table: string, userId: string) => n(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?1`, userId);
const keysUnder = async (prefix: string) => (await env.BUCKET.list({ prefix })).objects.map((object) => object.key);

/** The wrangler commands of GO-LIVE.md section 8, as written, with the doc's placeholder address replaced. */
function section8Commands(customerEmailAsWritten: string): string[] {
  const section = (goLive as string).split('## 8.')[1]!.split('\n## ')[0]!;
  const commands = [...section.matchAll(/--command "([^"]+)"/g)].map((match) => match[1]!);
  expect(commands.length).toBe(2);
  return commands.map((sql) => sql.replaceAll('customer@example.com', customerEmailAsWritten));
}

async function fillEveryTable(userId: string, email: string): Promise<void> {
  await sessionCookieFor(userId, NOW - DAY_MS);
  await apiKeyFor(userId, NOW - DAY_MS);
  await createSite(userId, NOW - DAY_MS);
  await run(env.DB, "INSERT INTO templates (id, user_id, name, html, created_at, updated_at) VALUES (?1, ?2, 'n', '<div/>', 0, 0)", `t_${userId}`, userId);
  await run(
    env.DB,
    "INSERT INTO fonts (id, user_id, family, format, bytes, sha256, r2_key, created_at) VALUES (?1, ?2, 'Fam', 'woff', 1, 'x', ?3, 0)",
    `f_${userId}`,
    userId,
    `f/${userId}/f_${userId}`,
  );
  await env.BUCKET.put(`f/${userId}/f_${userId}`, new Uint8Array([1]));
  await run(env.DB, 'INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?1, 0, 1, 3)', userId);
  await run(env.DB, 'INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at) VALUES (?1, ?2, ?3, 1, 1, 0, 1)', `tu_${userId}`, userId, `txn_${userId}`);
  await run(
    env.DB,
    `INSERT INTO renders (cache_key, user_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
     VALUES (?1, ?2, 'api', 'blog', 1, 1, 'png', 1, ?3, 'plan', 0, 0, ?4)`,
    `ck_${userId}`,
    userId,
    `r/${userId}/ck.png`,
    NOW + 20 * DAY_MS,
  );
  await env.BUCKET.put(`r/${userId}/ck.png`, new Uint8Array([1]));
  await run(env.DB, "INSERT INTO webhook_events (event_id, event_type, received_at, user_id) VALUES (?1, 'x', ?2, ?3)", `evt_${userId}`, NOW, userId);
  await run(env.DB, "INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?1, ?2, ?3, ?3)", `th_${userId}`, email, NOW);
}

describe('account deletion, independent review', () => {
  it('local D1 enforces foreign keys, and the purge empties every table and both R2 prefixes', async () => {
    expect((await first<{ foreign_keys: number }>(env.DB, 'PRAGMA foreign_keys'))?.foreign_keys).toBe(1);
    const user = await createUser('pro', NOW - 40 * DAY_MS);
    await fillEveryTable(user.id, user.email);
    for (const table of CHILD_TABLES) expect(await rowsOf(table, user.id), table).toBeGreaterThan(0);

    await run(env.DB, section8Commands(user.email)[0]!);
    expect((await runCleanup(env, NOW)).deletedAccounts).toBe(1);

    expect(await n('SELECT COUNT(*) AS n FROM users WHERE id = ?1', user.id)).toBe(0);
    for (const table of CHILD_TABLES) expect(await rowsOf(table, user.id), table).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ?1', user.email)).toBe(0);
    expect(await keysUnder(`r/${user.id}/`)).toEqual([]);
    expect(await keysUnder(`f/${user.id}/`)).toEqual([]);
  });

  it('the GO-LIVE command stamps milliseconds and suspends; its check reports the account gone only when it is', async () => {
    const stored = 'mixed.case@example.com';
    const asWritten = '  Mixed.Case@Example.COM ';
    const before = Date.now();
    await run(env.DB, "INSERT INTO users (id, email, created_at, plan) VALUES ('u_mixedcase000001', ?1, 0, 'free')", stored);
    const [mark, check] = section8Commands(asWritten);
    // The check must not report "gone" for an account that exists.
    const counted = async () => Object.values((await env.DB.prepare(check!).all()).results[0] as Record<string, number>)[0];
    expect(await counted()).toBe(1);

    // The customer's address as they typed it in their email must still find their (lower-cased) account.
    await env.DB.prepare(mark!).all();
    const row = await first<{ suspended_at: number; deletion_requested_at: number }>(env.DB, "SELECT * FROM users WHERE id = 'u_mixedcase000001'");
    expect(row?.deletion_requested_at).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(row?.deletion_requested_at).toBeLessThanOrEqual(Date.now());
    expect(row?.suspended_at).toBe(row?.deletion_requested_at);

    expect(await counted()).toBe(1);
    await runCleanup(env, NOW);
    expect(await counted()).toBe(0);
  });

  it('a user id that is a prefix of another keeps the other account untouched', async () => {
    await run(env.DB, "INSERT INTO users (id, email, created_at) VALUES ('u_abc', 'abc@example.com', 0), ('u_abcd', 'abcd@example.com', 0)");
    await env.BUCKET.put('r/u_abc/x.png', new Uint8Array([1]));
    await env.BUCKET.put('r/u_abcd/y.png', new Uint8Array([1]));
    await env.BUCKET.put('f/u_abcd/f_1', new Uint8Array([1]));
    await run(env.DB, "UPDATE users SET deletion_requested_at = 1, suspended_at = 1 WHERE id = 'u_abc'");
    await runCleanup(env, NOW);
    expect(await keysUnder('r/u_abc/')).toEqual([]);
    expect(await keysUnder('r/u_abcd/')).toEqual(['r/u_abcd/y.png']);
    expect(await keysUnder('f/u_abcd/')).toEqual(['f/u_abcd/f_1']);
    expect(await n("SELECT COUNT(*) AS n FROM users WHERE id = 'u_abcd'")).toBe(1);
  });

  it('an R2 delete or a D1 batch that fails keeps the rows; the next run finishes', async () => {
    const user = await createUser('pro', NOW - 40 * DAY_MS);
    await fillEveryTable(user.id, user.email);
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?1, suspended_at = ?1 WHERE id = ?2', NOW, user.id);

    let failR2 = true;
    const flakyBucket = new Proxy(env.BUCKET, {
      get: (target, prop) =>
        prop === 'delete' && failR2
          ? () => {
              failR2 = false;
              throw new Error('R2 down');
            }
          : Reflect.get(target, prop).bind(target),
    });
    // The other cleanup steps delete nothing here, so the first R2 delete is the purge's.
    await expect(runCleanup({ DB: env.DB, BUCKET: flakyBucket }, NOW)).rejects.toThrow('R2 down');
    expect(await n('SELECT COUNT(*) AS n FROM users WHERE id = ?1', user.id)).toBe(1);

    let failD1 = true;
    const flakyDb = new Proxy(env.DB, {
      get: (target, prop) =>
        prop === 'batch' && failD1
          ? () => {
              failD1 = false;
              throw new Error('D1 down');
            }
          : Reflect.get(target, prop).bind(target),
    });
    await expect(runCleanup({ DB: flakyDb, BUCKET: env.BUCKET }, NOW)).rejects.toThrow('D1 down');
    expect(await n('SELECT COUNT(*) AS n FROM users WHERE id = ?1', user.id)).toBe(1);
    expect(await keysUnder(`r/${user.id}/`)).toEqual([]);

    expect((await runCleanup(env, NOW)).deletedAccounts).toBe(1);
    for (const table of CHILD_TABLES) expect(await rowsOf(table, user.id), table).toBe(0);
  });

  it('after deletion the same address signs up as a new, empty account', async () => {
    const user = await createUser('pro', NOW - 40 * DAY_MS);
    await fillEveryTable(user.id, user.email);
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?1, suspended_at = ?1 WHERE id = ?2', NOW, user.id);
    await runCleanup(env, NOW);

    const { user: fresh, created } = await findOrCreateUserByEmail(env.DB, user.email, NOW + 1);
    expect(created).toBe(true);
    expect(fresh.id).not.toBe(user.id);
    expect(fresh).toMatchObject({ plan: 'free', suspended_at: null, deletion_requested_at: null, paddle_customer_id: null });
    for (const table of CHILD_TABLES) expect(await rowsOf(table, fresh.id), table).toBe(0);
    expect(await all(env.DB, 'SELECT * FROM topups WHERE paddle_transaction_id = ?1', `txn_${user.id}`)).toEqual([]);
  });
});
