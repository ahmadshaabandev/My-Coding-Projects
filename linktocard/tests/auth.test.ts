import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from '../src/auth/api-keys';
import { DEFAULT_REDIRECT, consumeMagicLink, issueMagicLink, safeNextPath } from '../src/auth/magic-link';
import {
  requireApiKey,
  requireSameOrigin,
  requireSession,
  requireSessionAllowSuspended,
} from '../src/auth/middleware';
import {
  clearedSessionCookie,
  createSession,
  destroySession,
  getSessionUser,
  readSessionId,
  sessionCookie,
} from '../src/auth/session';
import { API_KEY_PREFIX, AUTH, LIMITS } from '../src/config';
import { all, findOrCreateUserByEmail, first, getUserByEmail, run } from '../src/db/client';
import { sha256Hex } from '../src/lib/crypto';
import { ApiError, errorResponse, type ErrorBody } from '../src/lib/errors';
import { authRouter } from '../src/routes/auth';
import type { AppEnv, Env, UserRow } from '../src/types';

const db = env.DB;
const ORIGIN = 'https://linktocard.test';
/** 22 Nov 2026 12:00 UTC. Handlers read this through the faked Date. */
const NOW = Date.UTC(2026, 10, 22, 12);
const HOUR_MS = 60 * 60 * 1000;

/** The routers under test, behind the same error handler the real entry point installs. */
const app = new Hono<AppEnv>();
app.route('/auth', authRouter);
app.get('/api/me', requireSessionAllowSuspended, (c) => c.json({ id: c.var.user.id, suspended: c.var.user.suspended_at !== null }));
app.get('/api/private', requireSession, (c) => c.json({ id: c.var.user.id }));
app.all('/api/write', requireSameOrigin, (c) => c.json({ ok: true }));
app.get('/v1/ping', requireApiKey, (c) => c.json({ user: c.var.user.id, key: c.var.apiKey?.id }));
app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(error, c.env.APP_URL);
  console.error(error);
  return errorResponse(new ApiError('internal_error', 'Unexpected error.'), c.env.APP_URL);
});

interface SentEmail {
  to: string;
  subject: string;
  text: string;
}

/** Stands in for Resend and records what would have been mailed. */
function mockResend(): SentEmail[] {
  const sent: SentEmail[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected outbound request: ${url}`);
    sent.push(JSON.parse(String(init?.body)) as SentEmail);
    return Response.json({ id: `email_${sent.length}` });
  });
  return sent;
}

function linkIn(email: SentEmail | undefined): URL {
  const match = /https?:\/\/\S+\/login\/verify\?\S+/.exec(email?.text ?? '');
  if (!match) throw new Error('no sign-in link in the email');
  return new URL(match[0]);
}

function tokenIn(email: SentEmail | undefined): string {
  const token = linkIn(email).searchParams.get('token');
  if (!token) throw new Error('no token in the sign-in link');
  return token;
}

interface PostOptions {
  env?: Env;
  headers?: Record<string, string>;
}

async function post(path: string, body: unknown, options: PostOptions = {}): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...options.headers },
      body: JSON.stringify(body),
    },
    options.env ?? env,
  );
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { headers }, env);
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code;
}

function envWith(overrides: Partial<Env>): Env {
  return { ...env, ...overrides };
}

let emailSeq = 0;
/** Storage is shared by every test in this file, so each test uses its own addresses. */
function uniqueEmail(tag: string): string {
  emailSeq += 1;
  return `${tag}-${emailSeq}@example.com`;
}

interface SignedIn {
  user: UserRow;
  sessionId: string;
  /** Ready-to-send Cookie header. */
  cookie: string;
  setCookie: string;
}

/** The whole flow through the router: request a link, read it from the mail, verify it. */
async function signIn(email: string, sent: SentEmail[]): Promise<SignedIn> {
  await post('/auth/magic-link', { email });
  const response = await post('/auth/verify', { token: tokenIn(sent.at(-1)) });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const sessionId = setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));
  const user = await getUserByEmail(db, email);
  if (!user) throw new Error('sign-in did not create the account');
  return { user, sessionId, cookie: `${AUTH.sessionCookie}=${sessionId}`, setCookie };
}

function requestWithCookie(cookie: string): Request {
  return new Request(`${ORIGIN}/api/me`, { headers: { cookie } });
}

async function makeUser(tag: string): Promise<UserRow> {
  return (await findOrCreateUserByEmail(db, uniqueEmail(tag), NOW)).user;
}

async function suspend(user: UserRow): Promise<void> {
  await run(db, 'UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?', NOW, 'abuse', user.id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('magic link sign-in', () => {
  it('signs in a new address end to end: link -> email -> verify -> cookie -> session user', async () => {
    const sent = mockResend();
    const email = uniqueEmail('happy');

    const requested = await post('/auth/magic-link', { email: `  ${email.toUpperCase()} `, next: '/dashboard/keys' });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ ok: true });
    expect(requested.headers.get('cache-control')).toBe('no-store');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    const link = linkIn(sent[0]);
    expect(`${link.origin}${link.pathname}`).toBe(`${ORIGIN}/login/verify`);
    expect(link.searchParams.get('next')).toBe('/dashboard/keys');
    const token = tokenIn(sent[0]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only the hash of the token is stored, and asking for a link creates no account.
    const tokens = await all<Record<string, unknown>>(db, 'SELECT * FROM login_tokens WHERE email = ?', email);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      token_hash: await sha256Hex(token),
      created_at: NOW,
      expires_at: NOW + AUTH.magicLinkTtlMs,
      used_at: null,
    });
    expect(JSON.stringify(tokens)).not.toContain(token);
    expect(await getUserByEmail(db, email)).toBeNull();

    const verified = await post('/auth/verify', { token, next: link.searchParams.get('next') });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ ok: true, redirect: '/dashboard/keys' });

    const setCookie = verified.headers.get('set-cookie') ?? '';
    const sessionId = readSessionId(requestWithCookie(setCookie.split(';')[0]!));
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = await getSessionUser(requestWithCookie(`${AUTH.sessionCookie}=${sessionId}`), env);
    expect(user).toMatchObject({ email, plan: 'free', created_at: NOW, suspended_at: null });

    // Only the hash of the session id is stored.
    const sessions = await all<Record<string, unknown>>(db, 'SELECT * FROM sessions WHERE user_id = ?', user!.id);
    expect(sessions).toEqual([
      { id_hash: await sha256Hex(sessionId!), user_id: user!.id, created_at: NOW, expires_at: NOW + AUTH.sessionTtlMs },
    ]);
    expect(JSON.stringify(sessions)).not.toContain(sessionId);
  });

  it('sets a HttpOnly, SameSite=Lax, Secure, 30-day cookie', async () => {
    const sent = mockResend();
    const { setCookie, sessionId } = await signIn(uniqueEmail('cookie'), sent);

    const [pair, ...attributes] = setCookie.split('; ');
    expect(pair).toBe(`${AUTH.sessionCookie}=${sessionId}`);
    expect(attributes.sort()).toEqual(['HttpOnly', `Max-Age=${AUTH.sessionTtlMs / 1000}`, 'Path=/', 'SameSite=Lax', 'Secure']);
  });

  it('drops Secure only when the app is served over plain http', () => {
    const local = { APP_URL: 'http://localhost:8787' };
    expect(sessionCookie(local, 'abc')).toBe(`${AUTH.sessionCookie}=abc; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    expect(clearedSessionCookie(local)).toBe(`${AUTH.sessionCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    expect(sessionCookie({ APP_URL: ORIGIN }, 'abc')).toMatch(/; Secure$/);
    expect(clearedSessionCookie({ APP_URL: ORIGIN })).toMatch(/; Secure$/);
  });

  it('accepts a token once: the second attempt is rejected and sets no cookie', async () => {
    const sent = mockResend();
    await post('/auth/magic-link', { email: uniqueEmail('once') });
    const token = tokenIn(sent[0]);

    expect((await post('/auth/verify', { token })).status).toBe(200);
    const second = await post('/auth/verify', { token });
    expect(second.status).toBe(400);
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(await errorCode(second)).toBe('invalid_request');
  });

  it('lets exactly one of two simultaneous attempts with the same token through', async () => {
    const sent = mockResend();
    const email = uniqueEmail('race');
    await post('/auth/magic-link', { email });
    const token = tokenIn(sent[0]);

    const responses = await Promise.all([post('/auth/verify', { token }), post('/auth/verify', { token })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it('rejects a token once it has expired, and accepts it one millisecond before', async () => {
    const sent = mockResend();
    await post('/auth/magic-link', { email: uniqueEmail('expired') });
    await post('/auth/magic-link', { email: uniqueEmail('in-time') });

    vi.setSystemTime(NOW + AUTH.magicLinkTtlMs - 1);
    expect((await post('/auth/verify', { token: tokenIn(sent[1]) })).status).toBe(200);

    vi.setSystemTime(NOW + AUTH.magicLinkTtlMs);
    const late = await post('/auth/verify', { token: tokenIn(sent[0]) });
    expect(late.status).toBe(400);
    expect(await errorCode(late)).toBe('invalid_request');
    expect(late.headers.get('set-cookie')).toBeNull();
  });

  it('rejects tampered, truncated and non-string tokens without burning the real one', async () => {
    const sent = mockResend();
    const email = uniqueEmail('tamper');
    await post('/auth/magic-link', { email });
    const token = tokenIn(sent[0]);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    for (const bad of [flipped, token.slice(0, 20), `${token}x`, '', 42, null, { token }, undefined]) {
      const response = await post('/auth/verify', { token: bad });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    }
    expect(await getUserByEmail(db, email)).toBeNull();
    expect((await post('/auth/verify', { token })).status).toBe(200);
  });

  it('never touches the database for a string that cannot be a token', async () => {
    const untouchable = {
      prepare: () => {
        throw new Error('database was queried');
      },
    } as unknown as D1Database;
    expect(await consumeMagicLink(untouchable, 'not a token', NOW)).toBeNull();
    expect(await consumeMagicLink(untouchable, 12345, NOW)).toBeNull();
  });

  it('answers the same for known and unknown addresses, and mails both', async () => {
    const sent = mockResend();
    const known = uniqueEmail('known');
    await signIn(known, sent);
    const unknown = uniqueEmail('unknown');
    sent.length = 0;

    const forKnown = await post('/auth/magic-link', { email: known });
    const forUnknown = await post('/auth/magic-link', { email: unknown });

    expect(forKnown.status).toBe(forUnknown.status);
    expect(await forKnown.text()).toBe(await forUnknown.text());
    expect(sent.map((email) => email.to)).toEqual([known, unknown]);
    expect(sent[0]!.subject).toBe(sent[1]!.subject);
  });

  it('still answers 200 when the mail provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));

    const response = await post('/auth/magic-link', { email: uniqueEmail('provider-down') });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers 400 invalid_request for anything that is not an email address or a JSON object', async () => {
    const sent = mockResend();
    for (const body of [{ email: 'not-an-email' }, { email: '' }, { email: 42 }, {}, [], 'text', null]) {
      const response = await post('/auth/magic-link', body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    }
    const broken = await app.request(
      '/auth/magic-link',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{"email":' },
      env,
    );
    expect(broken.status).toBe(400);
    const huge = await post('/auth/magic-link', { email: uniqueEmail('huge'), padding: 'x'.repeat(5000) });
    expect(huge.status).toBe(413);
    expect(sent).toHaveLength(0);
  });

  it('mails at most the hourly cap per address, silently, and resumes when the hour has passed', async () => {
    const sent = mockResend();
    const email = uniqueEmail('capped');
    const count = () => first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM login_tokens WHERE email = ?', email);

    for (let i = 0; i < AUTH.maxMagicLinksPerEmailPerHour; i++) {
      expect((await post('/auth/magic-link', { email })).status).toBe(200);
    }
    expect(sent).toHaveLength(AUTH.maxMagicLinksPerEmailPerHour);

    const over = await post('/auth/magic-link', { email });
    expect(over.status).toBe(200);
    expect(await over.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(AUTH.maxMagicLinksPerEmailPerHour);
    expect(await count()).toEqual({ n: AUTH.maxMagicLinksPerEmailPerHour });

    // Another address is not affected.
    await post('/auth/magic-link', { email: uniqueEmail('not-capped') });
    expect(sent).toHaveLength(AUTH.maxMagicLinksPerEmailPerHour + 1);

    vi.setSystemTime(NOW + HOUR_MS - 1);
    await post('/auth/magic-link', { email });
    expect(sent).toHaveLength(AUTH.maxMagicLinksPerEmailPerHour + 1);

    vi.setSystemTime(NOW + HOUR_MS);
    await post('/auth/magic-link', { email });
    expect(sent).toHaveLength(AUTH.maxMagicLinksPerEmailPerHour + 2);
    expect(sent.at(-1)!.to).toBe(email);
    // The stale rows of the last window were dropped on the way.
    expect(await count()).toEqual({ n: 1 });
  });

  it('issueMagicLink returns null at the cap and the link plus delivery result otherwise', async () => {
    const sent = mockResend();
    const email = uniqueEmail('issue');
    const request = { email, next: '/dashboard', ip: '203.0.113.7', now: NOW };

    const issued = await issueMagicLink(env, request);
    expect(issued?.delivery).toEqual({ ok: true, id: 'email_1' });
    expect(issued?.link).toBe(linkIn(sent[0]).href);
    expect(await first(db, 'SELECT ip FROM login_tokens WHERE email = ?', email)).toEqual({ ip: '203.0.113.7' });

    for (let i = 1; i < AUTH.maxMagicLinksPerEmailPerHour; i++) await issueMagicLink(env, request);
    expect(await issueMagicLink(env, request)).toBeNull();
  });

  it('keeps only same-site paths as the next destination', () => {
    for (const ok of ['/dashboard', '/', '/dashboard/keys?tab=1#new', '/docs/api']) {
      expect(safeNextPath(ok)).toBe(ok);
    }
    const rejected = [
      '//evil.example',
      'https://evil.example',
      'http://evil.example/dashboard',
      'javascript:alert(1)',
      '/\\evil.example',
      '\\\\evil.example',
      '/\t/evil.example',
      '/dash board',
      ' /dashboard',
      'dashboard',
      '',
      `/${'a'.repeat(600)}`,
      undefined,
      null,
      42,
      ['/dashboard'],
    ];
    for (const bad of rejected) expect(safeNextPath(bad)).toBeNull();
  });

  it('drops an off-site next from the emailed link and from the redirect', async () => {
    const sent = mockResend();
    for (const next of ['//evil.example', 'https://evil.example']) {
      await post('/auth/magic-link', { email: uniqueEmail('evil-next'), next });
      const link = linkIn(sent.at(-1));
      expect(link.searchParams.has('next')).toBe(false);
      expect(link.href).not.toContain('evil.example');

      const verified = await post('/auth/verify', { token: tokenIn(sent.at(-1)), next });
      expect(await verified.json()).toEqual({ ok: true, redirect: DEFAULT_REDIRECT });
    }

    await post('/auth/magic-link', { email: uniqueEmail('good-next'), next: '/dashboard' });
    expect(linkIn(sent.at(-1)).searchParams.get('next')).toBe('/dashboard');
    expect(DEFAULT_REDIRECT).toBe('/dashboard');
  });

  it('returns dev_link in development and test when no Resend key is set, and it works', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('no email may be sent without a key');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const local = envWith({ ENVIRONMENT: 'development', APP_URL: 'http://localhost:8787', RESEND_API_KEY: undefined });
    const headers = { origin: 'http://localhost:8787' };
    const requested = await post('/auth/magic-link', { email: uniqueEmail('dev'), next: '/dashboard' }, { env: local, headers });
    const body = (await requested.json()) as { ok: boolean; dev_link?: string };
    expect(body.ok).toBe(true);
    const link = new URL(body.dev_link ?? '');
    expect(`${link.origin}${link.pathname}`).toBe('http://localhost:8787/login/verify');
    expect(link.searchParams.get('next')).toBe('/dashboard');
    // The same link is printed for a developer who watches the terminal instead.
    expect(String(logged.mock.calls[0]?.[0])).toContain(link.href);

    const verified = await post('/auth/verify', { token: link.searchParams.get('token') }, { env: local, headers });
    expect(verified.status).toBe(200);
    expect(verified.headers.get('set-cookie')).not.toContain('Secure');

    const inTest = await post('/auth/magic-link', { email: uniqueEmail('dev') }, { env: envWith({ RESEND_API_KEY: '' }) });
    expect(((await inTest.json()) as { dev_link?: string }).dev_link).toContain(`${ORIGIN}/login/verify?token=`);
    expect(outbound).not.toHaveBeenCalled();
  });

  it('never returns dev_link in staging or production, with or without a Resend key', async () => {
    mockResend();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    for (const name of ['staging', 'production'] as const) {
      for (const key of [undefined, 're_test_not_a_real_key']) {
        const response = await post(
          '/auth/magic-link',
          { email: uniqueEmail('live') },
          { env: envWith({ ENVIRONMENT: name, RESEND_API_KEY: key }) },
        );
        expect(await response.json()).toEqual({ ok: true });
      }
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it('rate-limits link requests and verifications per client IP, on separate counters', async () => {
    const sent = mockResend();
    const keys: string[] = [];
    const limited = envWith({
      RATE_LIMITS_DISABLED: '0',
      RL_AUTH: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const headers = { 'cf-connecting-ip': '203.0.113.9' };

    const requested = await post('/auth/magic-link', { email: uniqueEmail('limited') }, { env: limited, headers });
    expect(requested.status).toBe(429);
    expect(requested.headers.get('retry-after')).toBeTruthy();
    expect(await errorCode(requested)).toBe('rate_limited');

    const verified = await post('/auth/verify', { token: 'A'.repeat(43) }, { env: limited, headers });
    expect(verified.status).toBe(429);

    expect(keys).toEqual(['203.0.113.9', 'verify:203.0.113.9']);
    expect(sent).toHaveLength(0);
  });

  it('refuses cross-site and non-JSON posts, so a hostile page cannot sign a visitor in', async () => {
    const sent = mockResend();
    await post('/auth/magic-link', { email: uniqueEmail('csrf') });
    const token = tokenIn(sent[0]);

    const crossSite = await post('/auth/verify', { token }, { headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    expect(await errorCode(crossSite)).toBe('forbidden');
    expect(crossSite.headers.get('set-cookie')).toBeNull();

    const form = await post('/auth/verify', { token }, { headers: { 'content-type': 'text/plain' } });
    expect(form.status).toBe(403);

    // The token survived both attempts.
    expect((await post('/auth/verify', { token })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('logout deletes the session and clears the cookie', async () => {
    const sent = mockResend();
    const { cookie, user } = await signIn(uniqueEmail('logout'), sent);
    expect((await get('/api/private', { cookie })).status).toBe(200);

    const response = await app.request('/auth/logout', { method: 'POST', headers: { cookie, origin: ORIGIN } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBe(`${AUTH.sessionCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);

    expect(await all(db, 'SELECT * FROM sessions WHERE user_id = ?', user.id)).toEqual([]);
    expect(await getSessionUser(requestWithCookie(cookie), env)).toBeNull();
    expect((await get('/api/private', { cookie })).status).toBe(401);
  });

  it('logout without a session still answers 200 and clears the cookie', async () => {
    const response = await app.request('/auth/logout', { method: 'POST', headers: { origin: ORIGIN } }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects and deletes a session once it has expired', async () => {
    const user = await makeUser('expiry');
    const session = await createSession(db, user.id, NOW);
    expect(session.expiresAt).toBe(NOW + AUTH.sessionTtlMs);
    const request = requestWithCookie(`${AUTH.sessionCookie}=${session.id}`);

    expect((await getSessionUser(request, env, session.expiresAt - 1))?.id).toBe(user.id);
    expect(await getSessionUser(request, env, session.expiresAt)).toBeNull();
    expect(await all(db, 'SELECT * FROM sessions WHERE user_id = ?', user.id)).toEqual([]);

    // The default clock is the request time.
    const later = await createSession(db, user.id, NOW);
    const laterRequest = requestWithCookie(`${AUTH.sessionCookie}=${later.id}`);
    expect((await getSessionUser(laterRequest, env))?.id).toBe(user.id);
    vi.setSystemTime(NOW + AUTH.sessionTtlMs);
    expect(await getSessionUser(laterRequest, env)).toBeNull();
  });

  it('a new sign-in sweeps the expired sessions of that user and keeps the live ones', async () => {
    const user = await makeUser('sweep');
    await createSession(db, user.id, NOW - AUTH.sessionTtlMs);
    const live = await createSession(db, user.id, NOW - 1000);
    const fresh = await createSession(db, user.id, NOW);

    const hashes = (await all<{ id_hash: string }>(db, 'SELECT id_hash FROM sessions WHERE user_id = ?', user.id)).map((row) => row.id_hash);
    expect(hashes.sort()).toEqual([await sha256Hex(live.id), await sha256Hex(fresh.id)].sort());
  });

  it('destroySession removes only the session it is given', async () => {
    const user = await makeUser('destroy');
    const firstSession = await createSession(db, user.id, NOW);
    const second = await createSession(db, user.id, NOW);

    await destroySession(db, firstSession.id);

    expect(await getSessionUser(requestWithCookie(`${AUTH.sessionCookie}=${firstSession.id}`), env)).toBeNull();
    expect((await getSessionUser(requestWithCookie(`${AUTH.sessionCookie}=${second.id}`), env))?.id).toBe(user.id);
  });

  it('reads the session id from among other cookies and ignores anything not shaped like one', async () => {
    const id = 'A'.repeat(43);
    expect(readSessionId(requestWithCookie(`theme=dark; ${AUTH.sessionCookie}=${id}; other=1`))).toBe(id);
    expect(readSessionId(requestWithCookie(`x${AUTH.sessionCookie}=${id}`))).toBeNull();
    expect(readSessionId(requestWithCookie(`${AUTH.sessionCookie}=short`))).toBeNull();
    expect(readSessionId(requestWithCookie(`${AUTH.sessionCookie}=${id}' OR 1=1`))).toBeNull();
    expect(readSessionId(new Request(`${ORIGIN}/api/me`))).toBeNull();
    // A well-formed id that matches no session is simply signed out.
    expect(await getSessionUser(requestWithCookie(`${AUTH.sessionCookie}=${id}`), env)).toBeNull();
  });
});

describe('API keys', () => {
  it('shows the secret once and stores only its hash and display prefix', async () => {
    const user = await makeUser('key-create');
    const { row, secret } = await createApiKey(db, user.id, '  Production   site ', NOW);

    expect(secret).toMatch(new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{40}$`));
    expect(row).toEqual({
      id: expect.stringMatching(/^k_[0-9a-z]{16}$/),
      user_id: user.id,
      name: 'Production site',
      prefix: secret.slice(0, 12),
      key_hash: await sha256Hex(secret),
      created_at: NOW,
      last_used_at: null,
      revoked_at: null,
    });

    const stored = await all<Record<string, unknown>>(db, 'SELECT * FROM api_keys WHERE user_id = ?', user.id);
    expect(stored).toEqual([row]);
    for (const value of Object.values(stored[0]!)) {
      expect(value).not.toBe(secret);
      // No column holds more of the key than the 12-character display prefix.
      expect(String(value)).not.toContain(secret.slice(12));
      expect(String(value)).not.toContain(secret.slice(0, 13));
    }
  });

  it('lists the active keys of one user, newest first, without the hash', async () => {
    const user = await makeUser('key-list');
    const other = await makeUser('key-list-other');
    const older = await createApiKey(db, user.id, 'Older', NOW);
    const newer = await createApiKey(db, user.id, 'Newer', NOW + 1000);
    await createApiKey(db, other.id, 'Someone else', NOW);

    expect(await listApiKeys(db, user.id)).toEqual([
      { id: newer.row.id, name: 'Newer', prefix: newer.row.prefix, created_at: NOW + 1000, last_used_at: null },
      { id: older.row.id, name: 'Older', prefix: older.row.prefix, created_at: NOW, last_used_at: null },
    ]);
  });

  it('authenticates a key to its owner and rejects unknown keys', async () => {
    const user = await makeUser('key-auth');
    const { row, secret } = await createApiKey(db, user.id, 'CI', NOW);

    const authenticated = await authenticateApiKey(db, secret, NOW + 5);
    expect(authenticated?.user.id).toBe(user.id);
    expect(authenticated?.key).toEqual({ ...row, last_used_at: NOW + 5 });

    const unknown = `${API_KEY_PREFIX}${'0'.repeat(40)}`;
    expect(await authenticateApiKey(db, unknown, NOW)).toBeNull();
  });

  it('rejects malformed input without touching the database', async () => {
    const user = await makeUser('key-malformed');
    const { secret } = await createApiKey(db, user.id, 'CI', NOW);
    const untouchable = {
      prepare: () => {
        throw new Error('database was queried');
      },
    } as unknown as D1Database;

    const malformed = ['', 'ltc_short', `Bearer ${secret}`, `${secret}x`, secret.slice(0, -1), ` ${secret}`, `xxx_${'a'.repeat(40)}`, `${API_KEY_PREFIX}${'-'.repeat(40)}`];
    for (const presented of malformed) {
      expect(await authenticateApiKey(untouchable, presented, NOW)).toBeNull();
    }
    await expect(authenticateApiKey(untouchable, secret, NOW)).rejects.toThrow('database was queried');
  });

  it('revokes a key: it stops authenticating and leaves the list; only the owner can revoke', async () => {
    const user = await makeUser('key-revoke');
    const stranger = await makeUser('key-revoke-stranger');
    const { row, secret } = await createApiKey(db, user.id, 'To revoke', NOW);
    const kept = await createApiKey(db, user.id, 'Kept', NOW);

    expect(await revokeApiKey(db, stranger.id, row.id, NOW)).toBe(false);
    expect((await authenticateApiKey(db, secret, NOW))?.key.id).toBe(row.id);

    expect(await revokeApiKey(db, user.id, row.id, NOW + 10)).toBe(true);
    expect(await authenticateApiKey(db, secret, NOW + 20)).toBeNull();
    expect((await listApiKeys(db, user.id)).map((key) => key.id)).toEqual([kept.row.id]);
    expect(await first(db, 'SELECT revoked_at FROM api_keys WHERE id = ?', row.id)).toEqual({ revoked_at: NOW + 10 });

    expect(await revokeApiKey(db, user.id, row.id, NOW + 30)).toBe(false);
    expect(await revokeApiKey(db, user.id, 'k_doesnotexist00000', NOW)).toBe(false);
    expect((await authenticateApiKey(db, kept.secret, NOW))?.key.id).toBe(kept.row.id);
  });

  it('writes last_used_at at most once per minute', async () => {
    const user = await makeUser('key-last-used');
    const { row, secret } = await createApiKey(db, user.id, 'Busy', NOW);
    const lastUsed = async () => (await first<{ last_used_at: number | null }>(db, 'SELECT last_used_at FROM api_keys WHERE id = ?', row.id))?.last_used_at;

    expect(await lastUsed()).toBeNull();
    await authenticateApiKey(db, secret, NOW);
    expect(await lastUsed()).toBe(NOW);

    const soon = await authenticateApiKey(db, secret, NOW + 59_999);
    expect(soon?.key.last_used_at).toBe(NOW);
    expect(await lastUsed()).toBe(NOW);

    await authenticateApiKey(db, secret, NOW + 60_000);
    expect(await lastUsed()).toBe(NOW + 60_000);
  });

  it('caps the number of active keys per user; revoking one frees a slot', async () => {
    const user = await makeUser('key-cap');
    const keys = [];
    for (let i = 0; i < LIMITS.maxApiKeysPerUser; i++) keys.push(await createApiKey(db, user.id, `Key ${i}`, NOW + i));

    await expect(createApiKey(db, user.id, 'One too many', NOW)).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(await listApiKeys(db, user.id)).toHaveLength(LIMITS.maxApiKeysPerUser);

    await revokeApiKey(db, user.id, keys[0]!.row.id, NOW);
    await expect(createApiKey(db, user.id, 'Replacement', NOW)).resolves.toMatchObject({ row: { name: 'Replacement' } });
  });

  it('requires a name of at most LIMITS.maxNameChars characters', async () => {
    const user = await makeUser('key-name');
    await expect(createApiKey(db, user.id, '   ', NOW)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createApiKey(db, user.id, 'n'.repeat(LIMITS.maxNameChars + 1), NOW)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createApiKey(db, user.id, 'n'.repeat(LIMITS.maxNameChars), NOW)).resolves.toBeDefined();
    expect(await listApiKeys(db, user.id)).toHaveLength(1);
  });
});

describe('requireApiKey', () => {
  it('answers 401 invalid_api_key with WWW-Authenticate when the header is missing or not Bearer', async () => {
    for (const headers of [{}, { authorization: 'Basic dXNlcjpwYXNz' }, { authorization: 'Bearer' }] as Record<string, string>[]) {
      const response = await get('/v1/ping', headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Link To Card API"');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await errorCode(response)).toBe('invalid_api_key');
    }
  });

  it('answers 401 for unknown, malformed and revoked keys', async () => {
    const user = await makeUser('mw-key-bad');
    const { row, secret } = await createApiKey(db, user.id, 'Revoked', NOW);
    await revokeApiKey(db, user.id, row.id, NOW);

    for (const key of [secret, `${API_KEY_PREFIX}${'0'.repeat(40)}`, 'garbage']) {
      const response = await get('/v1/ping', { authorization: `Bearer ${key}` });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="Link To Card API", error="invalid_token"');
      expect(await errorCode(response)).toBe('invalid_api_key');
    }
  });

  it('lets a valid key through and exposes the user and the key to the route', async () => {
    const user = await makeUser('mw-key-ok');
    const { row, secret } = await createApiKey(db, user.id, 'Live', NOW);

    for (const scheme of ['Bearer', 'bearer']) {
      const response = await get('/v1/ping', { authorization: `${scheme} ${secret}` });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ user: user.id, key: row.id });
    }
  });

  it('answers 403 account_suspended for a key of a suspended account', async () => {
    const user = await makeUser('mw-key-suspended');
    const { secret } = await createApiKey(db, user.id, 'Suspended', NOW);
    await suspend(user);

    const response = await get('/v1/ping', { authorization: `Bearer ${secret}` });
    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe('account_suspended');
    expect(body.error.message).toContain(env.SUPPORT_EMAIL);
    expect(body.error.message).not.toContain('abuse');
  });
});

describe('requireSession', () => {
  it('answers 401 unauthorized JSON without a valid session cookie', async () => {
    for (const headers of [{}, { cookie: `${AUTH.sessionCookie}=nonsense` }, { cookie: `${AUTH.sessionCookie}=${'B'.repeat(43)}` }] as Record<string, string>[]) {
      const response = await get('/api/private', headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Sign in to continue.', docs: `${ORIGIN}/docs/api#errors` },
      });
    }
  });

  it('lets a signed-in user through and exposes it to the route', async () => {
    const sent = mockResend();
    const { cookie, user } = await signIn(uniqueEmail('mw-session'), sent);

    const response = await get('/api/private', { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: user.id });
  });

  it('blocks a suspended account everywhere except the route that opts in', async () => {
    const sent = mockResend();
    const email = uniqueEmail('mw-suspended');
    const { cookie, user } = await signIn(email, sent);
    await suspend(user);

    const blocked = await get('/api/private', { cookie });
    expect(blocked.status).toBe(403);
    expect(await errorCode(blocked)).toBe('account_suspended');

    const me = await get('/api/me', { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ id: user.id, suspended: true });
    expect((await get('/api/me')).status).toBe(401);

    // A suspended account can still sign in, which is how it gets to read that notice.
    const again = await signIn(email, sent);
    expect((await get('/api/me', { cookie: again.cookie })).status).toBe(200);
    expect((await get('/api/private', { cookie: again.cookie })).status).toBe(403);
  });
});

describe('requireSameOrigin', () => {
  const write = (init: RequestInit) => app.request('/api/write', init, env);
  const json = { 'content-type': 'application/json' };

  it('lets safe methods through whatever the Origin', async () => {
    expect((await write({ method: 'GET', headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });

  it('accepts same-origin JSON writes, with or without an Origin header', async () => {
    expect((await write({ method: 'POST', headers: { ...json, origin: ORIGIN }, body: '{}' })).status).toBe(200);
    expect((await write({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })).status).toBe(200);
    expect((await write({ method: 'DELETE', headers: { origin: ORIGIN } })).status).toBe(200);
    expect((await write({ method: 'POST' })).status).toBe(200);
  });

  it('answers 403 forbidden for another Origin, including the opaque "null" origin', async () => {
    for (const origin of ['https://evil.example', 'https://linktocard.test.evil.example', 'http://linktocard.test', 'null']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await write({ method, headers: { ...json, origin }, body: '{}' });
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe('forbidden');
      }
    }
  });

  it('answers 403 forbidden for a body that is not application/json', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
      const response = await write({ method: 'POST', headers: { 'content-type': contentType, origin: ORIGIN }, body: 'a=1' });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('forbidden');
    }
  });
});
