/**
 * Thin D1 helpers + the user accessors shared by auth, billing and the API.
 * Table-specific queries live next to the code that owns the table
 * (auth/*, lib/quota.ts, billing/*); this file stays small on purpose.
 */
import { isPlanId } from '../billing/plans';
import { randomId } from '../lib/crypto';
import type { UserRow } from '../types';

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all<T>();
  return results ?? [];
}

/** Runs a write and returns the number of rows changed. */
export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const result = await db.prepare(sql).bind(...params).run();
  return result.meta.changes ?? 0;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Lower-cases and validates an email address. Returns null when it is not usable. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const email = input.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

function fixUser(row: UserRow | null): UserRow | null {
  if (!row) return null;
  if (!isPlanId(row.plan)) row.plan = 'free';
  return row;
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return fixUser(await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id));
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return fixUser(await first<UserRow>(db, 'SELECT * FROM users WHERE email = ?', email));
}

/**
 * Sign-up is implicit: the first successful sign-in for an address creates the
 * account on the Free plan. Safe under concurrency (unique index on email).
 */
export async function findOrCreateUserByEmail(
  db: D1Database,
  email: string,
  now: number,
): Promise<{ user: UserRow; created: boolean }> {
  const existing = await getUserByEmail(db, email);
  if (existing) return { user: existing, created: false };
  const id = randomId('u');
  const changes = await run(
    db,
    "INSERT INTO users (id, email, created_at, plan) VALUES (?, ?, ?, 'free') ON CONFLICT (email) DO NOTHING",
    id,
    email,
    now,
  );
  const user = await getUserByEmail(db, email);
  if (!user) throw new Error('failed to create user');
  return { user, created: changes === 1 };
}
