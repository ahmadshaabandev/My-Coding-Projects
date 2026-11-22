// Second look at the security review: attacks one step sideways from the first
// reviewer's fixes, driven through the real Worker app.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR } from '../src/auth/magic-link';
import { DAY_MS } from '../src/config';
import { first, run } from '../src/db/client';
import { CLEANUP_LIMITS, runCleanup } from '../src/lib/cleanup';
import type { Env } from '../src/types';
import { ORIGIN, call, requestUrl } from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let serial = 0;
const unique = (label: string): string => `${label}-${Date.now().toString(36)}-${++serial}`;

/** Stands in for Resend and records the recipients. */
function mockResend(): string[] {
  const sent: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected outbound request: ${url.href}`);
    sent.push((JSON.parse(String(init?.body)) as { to: string }).to);
    return Response.json({ id: `email_${sent.length}` });
  });
  return sent;
}

function authPost(path: string, body: unknown, headers: Record<string, string> = {}, bindings: Env = env): Promise<Response> {
  return call(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, bindings);
}

describe('sign-in: the per-client hourly cap', () => {
  it('holds when the requests arrive at the same time', async () => {
    // A Resend key so that a stored link is also a mailed one.
    const bindings: Env = { ...env, RESEND_API_KEY: 're_test' } as Env;
    const sent = mockResend();
    const ip = '198.51.100.201';
    const burst = MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR * 2;
    const responses = await Promise.all(
      Array.from({ length: burst }, () => authPost('/auth/magic-link', { email: `${unique('burst')}@example.com` }, { 'cf-connecting-ip': ip }, bindings)),
    );
    const statuses = responses.map((response) => response.status);
    const stored = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM login_tokens WHERE ip = ?', ip);
    expect(stored?.n).toBeLessThanOrEqual(MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR);
    expect(sent.length).toBeLessThanOrEqual(MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR);
    expect(statuses.filter((status) => status !== 200 && status !== 429)).toEqual([]);
  });
});

describe('cleanup: sign-in requests (an email address and an IP each)', () => {
  it('keeps pace with what two clients at the hourly cap can create in a day', async () => {
    const now = Date.UTC(2026, 10, 22, 3, 17);
    await runCleanup(env, now);
    // 20 an hour from each of two IPv4 addresses: 960 rows a day, more than one statement deletes.
    const perDay = MAX_MAGIC_LINKS_PER_CLIENT_PER_HOUR * 24 * 2;
    expect(perDay).toBeGreaterThan(CLEANUP_LIMITS.rowsPerStatement);
    await run(
      env.DB,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
       INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip)
       SELECT 'old_tok_' || i, 'stranger' || i || '@example.com', ?2, ?2 + 900000, '203.0.113.' || (i % 2) FROM n`,
      perDay,
      now - DAY_MS - 1,
    );
    await run(env.DB, "INSERT INTO login_tokens (token_hash, email, created_at, expires_at, ip) VALUES ('young_tok', 'y@example.com', ?1, ?1, 'x')", now - 1000);

    const report = await runCleanup(env, now);
    expect(report.loginTokens).toBe(perDay);
    expect((await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM login_tokens WHERE token_hash LIKE 'old_tok_%'"))?.n).toBe(0);
    expect(await first(env.DB, "SELECT 1 FROM login_tokens WHERE token_hash = 'young_tok'")).not.toBeNull();
  });
});
