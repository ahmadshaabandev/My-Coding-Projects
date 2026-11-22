/**
 * Sign-in routes, mounted at /auth:
 *
 *   POST /auth/magic-link  { email, next? }  -> { ok: true }            (mails a link)
 *   POST /auth/verify      { token, next? }  -> { ok: true, redirect }  (sets the session cookie)
 *   POST /auth/logout                        -> { ok: true }            (clears it)
 *
 * Verifying is a POST on purpose: mail scanners pre-fetch GET links and would
 * burn the single-use token. The emailed link opens the static /login/verify
 * page, which POSTs the token (and the next path from its own URL) when the
 * human clicks a button.
 */
import { Hono, type Context } from 'hono';
import {
  DEFAULT_REDIRECT,
  consumeMagicLink,
  issueMagicLink,
  safeNextPath,
} from '../auth/magic-link';
import { requireSameOrigin } from '../auth/middleware';
import {
  clearedSessionCookie,
  createSession,
  destroySession,
  readSessionId,
  sessionCookie,
} from '../auth/session';
import { findOrCreateUserByEmail, normalizeEmail } from '../db/client';
import { isLocalEnvironment } from '../lib/email';
import { ApiError } from '../lib/errors';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import type { AppEnv } from '../types';

/** These bodies hold an email address or a token; anything bigger is not a sign-in request. */
const MAX_BODY_CHARS = 4096;

async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_CHARS) {
    throw new ApiError('payload_too_large', 'The request body is too large.');
  }
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_CHARS) throw new ApiError('payload_too_large', 'The request body is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError('invalid_request', 'The request body must be a JSON object.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('invalid_request', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export const authRouter = new Hono<AppEnv>();

// Also covers the routes that set the cookie: without it a hostile page could
// sign a visitor in to the attacker's account (login CSRF).
authRouter.use('*', requireSameOrigin);
authRouter.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

authRouter.post('/magic-link', async (c) => {
  const ip = clientIp(c.req.raw);
  await enforceRateLimit(c.env, 'RL_AUTH', ip);
  const body = await readJsonObject(c);
  const email = normalizeEmail(body.email);
  if (!email) throw new ApiError('invalid_request', 'Enter a valid email address.');

  // The answer is the same whether or not an account exists, a link was sent or
  // the hourly cap was hit: it must not reveal anything about the address.
  const issued = await issueMagicLink(c.env, { email, next: safeNextPath(body.next), ip, now: Date.now() });
  // Local development works without a mail provider: the link that could not be mailed is handed back.
  const unsent = issued !== null && !issued.delivery.ok && issued.delivery.error === 'not_configured';
  const devLink = unsent && isLocalEnvironment(c.env) ? issued.link : null;
  return c.json({ ok: true, ...(devLink ? { dev_link: devLink } : {}) });
});

authRouter.post('/verify', async (c) => {
  // Same limiter, separate counter: a sign-in must not be blocked by link requests from the same IP.
  await enforceRateLimit(c.env, 'RL_AUTH', `verify:${clientIp(c.req.raw)}`);
  const body = await readJsonObject(c);
  const now = Date.now();
  const email = await consumeMagicLink(c.env.DB, body.token, now);
  if (!email) {
    throw new ApiError(
      'invalid_request',
      'This sign-in link is not valid: it has expired, was already used or is incomplete. Request a new one.',
    );
  }
  const { user } = await findOrCreateUserByEmail(c.env.DB, email, now);
  const session = await createSession(c.env.DB, user.id, now);
  c.header('Set-Cookie', sessionCookie(c.env, session.id));
  return c.json({ ok: true, redirect: safeNextPath(body.next) ?? DEFAULT_REDIRECT });
});

authRouter.post('/logout', async (c) => {
  const sessionId = readSessionId(c.req.raw);
  if (sessionId) await destroySession(c.env.DB, sessionId);
  c.header('Set-Cookie', clearedSessionCookie(c.env));
  return c.json({ ok: true });
});
