/**
 * Passwordless sign-in: a single-use link mailed to the address. Only the
 * SHA-256 of the token is stored, so the login_tokens table cannot be used to
 * sign in as anyone.
 */
import { AUTH } from '../config';
import { first } from '../db/client';
import { base64UrlEncode, sha256Hex } from '../lib/crypto';
import { magicLinkEmail, sendEmail, type SendEmailResult } from '../lib/email';
import type { Env } from '../types';

const HOUR_MS = 60 * 60 * 1000;
/** 32 random bytes, base64url without padding. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_NEXT_CHARS = 512;
/** Printable ASCII only, one leading "/", and no "//" or "/\" (browsers read both as a host). */
const NEXT_PATH_RE = /^\/(?![/\\])[\x21-\x7e]*$/;
const PARSE_BASE = 'https://next.invalid';

/** Where a sign-in lands when no (valid) next path was asked for. */
export const DEFAULT_REDIRECT = '/dashboard';

/**
 * Accepts only a same-site path for the post-sign-in redirect, so a crafted
 * sign-in link can never bounce the user to another site. Anything else is null.
 */
export function safeNextPath(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > MAX_NEXT_CHARS) return null;
  if (!NEXT_PATH_RE.test(input) || input.includes('\\')) return null;
  const url = new URL(input, PARSE_BASE);
  if (url.origin !== PARSE_BASE) return null;
  // Parsing removes "." and ".." segments, so "/.//evil.example" comes out as
  // "//evil.example" - another site to a browser. The rule is applied again to
  // what is actually returned.
  const path = `${url.pathname}${url.search}${url.hash}`;
  return NEXT_PATH_RE.test(path) ? path : null;
}

/**
 * Sign-in emails one client (see clientIp) may request per hour, over all
 * addresses together. The per-minute limiter alone would let a single visitor
 * have 300 emails an hour sent to 300 strangers from our domain.
 */
export const MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR = 20;

/** True when this client already had the hourly maximum of sign-in emails requested. */
export async function clientAtMagicLinkCap(db: D1Database, ip: string, now: number): Promise<boolean> {
  // No CF-Connecting-IP means local development: every request would share one bucket.
  if (ip === 'unknown') return false;
  const row = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM login_tokens WHERE ip = ? AND created_at > ?', ip, now - HOUR_MS);
  return (row?.n ?? 0) >= MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR;
}

export interface MagicLinkRequest {
  /** Already normalised (see normalizeEmail). */
  email: string;
  /** Already validated (see safeNextPath). */
  next: string | null;
  ip: string;
  now: number;
}

export interface IssuedMagicLink {
  link: string;
  delivery: SendEmailResult;
}

/**
 * Stores a new token and mails the link. Returns null, sending nothing, when
 * the address already received AUTH.maxMagicLinksPerEmailPerHour links in the
 * last hour.
 */
export async function issueMagicLink(env: Env, request: MagicLinkRequest): Promise<IssuedMagicLink | null> {
  const { email, next, ip, now } = request;
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const windowStart = now - HOUR_MS;
  // The cap is checked inside the INSERT so concurrent requests cannot overshoot it.
  // Rows older than the window are useless (long expired) and are dropped on the way.
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM login_tokens WHERE email = ? AND created_at <= ?').bind(email, windowStart),
    env.DB.prepare(
      `INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM login_tokens WHERE email = ? AND created_at > ?) < ?`,
    ).bind(await sha256Hex(token), email, now, now + AUTH.magicLinkTtlMs, ip, email, windowStart, AUTH.maxMagicLinksPerEmailPerHour),
  ]);
  if (inserted?.meta.changes !== 1) return null;

  const query = new URLSearchParams({ token });
  if (next) query.set('next', next);
  const link = `${env.APP_URL.replace(/\/+$/, '')}/login/verify?${query}`;
  const delivery = await sendEmail(env, {
    to: email,
    ...magicLinkEmail({ link, ttlMinutes: Math.round(AUTH.magicLinkTtlMs / 60_000) }),
  });
  return { link, delivery };
}

/**
 * Burns the token and returns the address it was issued to, or null when it is
 * unknown, expired or already used. One atomic UPDATE: of two concurrent
 * attempts with the same token exactly one gets the row back.
 */
export async function consumeMagicLink(db: D1Database, token: unknown, now: number): Promise<string | null> {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const row = await first<{ email: string }>(
    db,
    'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email',
    now,
    await sha256Hex(token),
    now,
  );
  return row?.email ?? null;
}
