/**
 * Auth middleware. Failures throw ApiError; the app-level onError (src/index.ts)
 * turns them into the JSON error body.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from '../lib/errors';
import type { AppEnv, UserRow } from '../types';
import { authenticateApiKey } from './api-keys';
import { getSessionUser } from './session';

const BEARER_RE = /^Bearer +(\S+)$/i;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_REALM = 'Bearer realm="Link To Card API"';

function assertNotSuspended(c: Context<AppEnv>, user: UserRow): void {
  if (user.suspended_at !== null) {
    throw new ApiError('account_suspended', `This account is suspended. Contact ${c.env.SUPPORT_EMAIL}.`);
  }
}

async function sessionUser(c: Context<AppEnv>): Promise<UserRow> {
  const user = await getSessionUser(c, c.env);
  if (!user) throw new ApiError('unauthorized', 'Sign in to continue.');
  return user;
}

/** Dashboard routes: a signed-in, non-suspended account. Sets c.var.user. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await sessionUser(c);
  assertNotSuspended(c, user);
  c.set('user', user);
  await next();
};

/**
 * Like requireSession but lets a suspended account through. Meant for the one
 * read-only route (GET /api/me) that tells such a user why nothing else works.
 */
export const requireSessionAllowSuspended: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', await sessionUser(c));
  await next();
};

/** /v1 routes: "Authorization: Bearer <key>". Sets c.var.user and c.var.apiKey. */
export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const presented = BEARER_RE.exec((c.req.header('authorization') ?? '').trim())?.[1];
  if (!presented) {
    throw new ApiError('invalid_api_key', 'Missing API key. Send the header "Authorization: Bearer <your key>".', {
      headers: { 'www-authenticate': API_REALM },
    });
  }
  const authenticated = await authenticateApiKey(c.env.DB, presented, Date.now());
  if (!authenticated) {
    throw new ApiError('invalid_api_key', 'This API key is not valid or has been revoked.', {
      headers: { 'www-authenticate': `${API_REALM}, error="invalid_token"` },
    });
  }
  assertNotSuspended(c, authenticated.user);
  c.set('user', authenticated.user);
  c.set('apiKey', authenticated.key);
  await next();
};

/**
 * CSRF guard for state-changing requests that rely on the session cookie (or
 * set it). Browsers attach Origin to every cross-site non-GET request, and a
 * cross-site page cannot send application/json without a CORS preflight that
 * this Worker never answers. Requests without Origin (curl, server-side) pass.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const request = c.req.raw;
  if (!SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(c.env.APP_URL).origin) {
      throw new ApiError('forbidden', 'Cross-site requests are not allowed.');
    }
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    // "Content-Length: 0" is how real workerd delivers a bodyless POST or DELETE.
    const hasBody = request.body !== null && request.headers.get('content-length') !== '0';
    if (hasBody && contentType !== 'application/json') {
      throw new ApiError('forbidden', 'Send the request body as application/json.');
    }
  }
  await next();
};
