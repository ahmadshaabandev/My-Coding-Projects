// Helpers for tests that drive the real Worker app: accounts, sessions, API keys,
// signed URLs and small byte checks. Storage is shared by a whole test file, so
// every id made here is unique.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createApiKey } from '../src/auth/api-keys';
import { createSession } from '../src/auth/session';
import type { PlanId } from '../src/billing/plans';
import { AUTH } from '../src/config';
import { first, getUserById, run } from '../src/db/client';
import { app } from '../src/index';
import { hmacSha256Hex, randomId } from '../src/lib/crypto';
import { getUsage } from '../src/lib/quota';
import { buildSignedUrl, deriveSiteSecret, type OgExtension } from '../src/lib/signed-url';
import type { Env, SiteRow, UsageSummary, UserRow } from '../src/types';

export const ORIGIN = new URL(env.APP_URL).origin;

/** One request through the real app with an ExecutionContext; background work is finished on return. */
export async function call(path: string, init: RequestInit = {}, bindings: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export interface ErrorJson {
  error: { code: string; message: string; docs: string; details?: Record<string, unknown> };
}

export async function errorOf(response: Response): Promise<ErrorJson['error']> {
  return ((await response.json()) as ErrorJson).error;
}

export async function createUser(plan: PlanId = 'free', now: number = Date.now()): Promise<UserRow> {
  const id = randomId('u');
  await run(env.DB, 'INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, ?3, ?4)', id, `${id}@example.com`, now, plan);
  return userRow(id);
}

export async function userRow(id: string): Promise<UserRow> {
  const user = await getUserById(env.DB, id);
  if (!user) throw new Error(`no user ${id}`);
  return user;
}

export async function usageOf(userId: string, now: number = Date.now()): Promise<UsageSummary> {
  return getUsage(env.DB, await userRow(userId), now);
}

export async function renderCount(userId: string): Promise<number> {
  const row = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM renders WHERE user_id = ?1', userId);
  return row?.n ?? 0;
}

/** Pretends the account has already used this many images of the current period. */
export async function setUsed(user: UserRow, used: number, now: number = Date.now()): Promise<void> {
  const usage = await getUsage(env.DB, user, now);
  await run(
    env.DB,
    `INSERT INTO usage_periods (user_id, period_start, period_end, used) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id, period_start) DO UPDATE SET used = excluded.used`,
    user.id,
    usage.period_start,
    usage.period_end,
    used,
  );
}

/** Cookie header value of a fresh session for the account. */
export async function sessionCookieFor(userId: string, now: number = Date.now()): Promise<string> {
  const session = await createSession(env.DB, userId, now);
  return `${AUTH.sessionCookie}=${session.id}`;
}

export async function apiKeyFor(userId: string, now: number = Date.now()): Promise<{ id: string; secret: string }> {
  const { row, secret } = await createApiKey(env.DB, userId, 'test key', now);
  return { id: row.id, secret };
}

export const bearer = (secret: string): Record<string, string> => ({ authorization: `Bearer ${secret}` });

export async function createSite(userId: string, now: number = Date.now()): Promise<SiteRow> {
  const id = randomId('s');
  await run(env.DB, 'INSERT INTO sites (id, user_id, name, secret_version, created_at) VALUES (?1, ?2, ?3, 1, ?4)', id, userId, 'Test site', now);
  const site = await first<SiteRow>(env.DB, 'SELECT * FROM sites WHERE id = ?1', id);
  if (!site) throw new Error('site was not created');
  return site;
}

export function siteSecret(site: SiteRow): Promise<string> {
  return deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version);
}

/** Path + query of a correctly signed card URL; parameters keep the given order. */
export async function signedPath(
  site: SiteRow,
  template: string,
  params: Record<string, string>,
  ext: OgExtension = 'png',
  secret?: string,
): Promise<string> {
  const url = await buildSignedUrl({
    baseUrl: 'http://localhost',
    siteId: site.id,
    template,
    ext,
    params,
    secret: secret ?? (await siteSecret(site)),
  });
  return url.slice('http://localhost'.length);
}

/** A dashboard request the way the browser sends it: session cookie, same-origin, JSON body. */
export function dashboard(cookie: string | null, method: string, path: string, body?: unknown, bindings: Env = env): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, bindings);
}

export function postImage(secret: string, body: unknown): Promise<Response> {
  return call('/v1/images', {
    method: 'POST',
    headers: { ...bearer(secret), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Paddle-Signature header for a raw webhook body, signed with the test secret. */
export async function paddleSignature(rawBody: string, secret: string = env.PADDLE_WEBHOOK_SECRET ?? ''): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return `ts=${timestamp};h1=${await hmacSha256Hex(secret, `${timestamp}:${rawBody}`)}`;
}

export async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isWebp(bytes: Uint8Array): boolean {
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}
