/**
 * Browser sessions. The cookie carries a 32-byte random id; D1 stores only its
 * SHA-256, so a leaked database cannot be replayed as live sessions.
 */
import { AUTH } from '../config';
import { first, getUserById, run } from '../db/client';
import { base64UrlEncode, sha256Hex } from '../lib/crypto';
import type { Env, UserRow } from '../types';

/** 32 random bytes, base64url without padding. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** A Request, or anything shaped like a Hono Context (whatever its generics). */
export type RequestSource = Request | { req: { raw: Request } };

export interface Session {
  /** The cookie value. Never stored and never logged. */
  id: string;
  expiresAt: number;
}

export async function createSession(db: D1Database, userId: string, now: number): Promise<Session> {
  const id = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + AUTH.sessionTtlMs;
  // Sessions that were never signed out are only cleaned up here, at the user's next sign-in.
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(userId, now),
    db
      .prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(id), userId, now, expiresAt),
  ]);
  return { id, expiresAt };
}

function cookieAttributes(env: Pick<Env, 'APP_URL'>, maxAgeSeconds: number): string {
  // Browsers drop Secure cookies on plain http, which is what `wrangler dev` serves.
  const secure = env.APP_URL.startsWith('http://') ? '' : '; Secure';
  return `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

/** Set-Cookie value that signs the browser in. */
export function sessionCookie(env: Pick<Env, 'APP_URL'>, sessionId: string): string {
  return `${AUTH.sessionCookie}=${sessionId}; ${cookieAttributes(env, Math.floor(AUTH.sessionTtlMs / 1000))}`;
}

/** Set-Cookie value that signs the browser out. */
export function clearedSessionCookie(env: Pick<Env, 'APP_URL'>): string {
  return `${AUTH.sessionCookie}=; ${cookieAttributes(env, 0)}`;
}

/** The session id from the Cookie header, or null when absent or not shaped like one of ours. */
export function readSessionId(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== AUTH.sessionCookie) continue;
    const value = part.slice(separator + 1).trim();
    return SESSION_ID_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * The signed-in user, or null. Suspended users are returned as-is: whether a
 * suspended account may proceed is the caller's decision (see middleware.ts).
 */
export async function getSessionUser(
  source: RequestSource,
  env: Env,
  now: number = Date.now(),
): Promise<UserRow | null> {
  const id = readSessionId(source instanceof Request ? source : source.req.raw);
  if (!id) return null;
  const idHash = await sha256Hex(id);
  const session = await first<{ user_id: string; expires_at: number }>(
    env.DB,
    'SELECT user_id, expires_at FROM sessions WHERE id_hash = ?',
    idHash,
  );
  if (!session) return null;
  if (session.expires_at <= now) {
    await run(env.DB, 'DELETE FROM sessions WHERE id_hash = ?', idHash);
    return null;
  }
  return getUserById(env.DB, session.user_id);
}

export async function destroySession(db: D1Database, sessionId: string): Promise<void> {
  await run(db, 'DELETE FROM sessions WHERE id_hash = ?', await sha256Hex(sessionId));
}
