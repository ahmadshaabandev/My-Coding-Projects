// Signed card URLs (GET /v1/og/...) through the real app: routing, ownership,
// cache layers, quota, HEAD, rate limits and the quota emails.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS, HTTP_CACHE, RATE_LIMITS } from '../src/config';
import { first, run } from '../src/db/client';
import { app } from '../src/index';
import { renderR2Key } from '../src/lib/images';
import type { Env, RateLimitBinding, RenderRow } from '../src/types';
import {
  bytesOf,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  errorOf,
  isPng,
  pngDimensions,
  renderCount,
  requestUrl,
  reversedQuery,
  sessionCookieFor,
  setUsed,
  signedPath,
  usageOf,
} from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An account with a site and a small custom template that renders quickly. */
async function account(plan: 'free' | 'starter' | 'pro' = 'free', now: number = Date.now()) {
  const user = await createUser(plan, now);
  const cookie = await sessionCookieFor(user.id, now);
  const site = await createSite(user.id, now);
  const templateId = await createTemplate(cookie);
  return { user, cookie, site, templateId };
}

const cacheKeyOf = (response: Response): string => (response.headers.get('etag') ?? '').replaceAll('"', '');

function ledgerRow(cacheKey: string): Promise<RenderRow | null> {
  return first<RenderRow>(env.DB, 'SELECT * FROM renders WHERE cache_key = ?1', cacheKey);
}

interface Mail {
  to: string;
  subject: string;
  idempotencyKey: string | null;
}

/** Captures emails sent through Resend; `respond` decides what Resend answers. */
function mockResend(respond: () => Response = () => Response.json({ id: 'email_test' })): Mail[] {
  const sent: Mail[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url.href}`);
    const body = JSON.parse(String(init?.body)) as { to: string; subject: string };
    sent.push({ to: body.to, subject: body.subject, idempotencyKey: new Headers(init?.headers).get('idempotency-key') });
    return respond();
  });
  return sent;
}

/** A rate-limit binding that records the keys it is asked about. */
function limiter(allow: boolean): { binding: RateLimitBinding; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: allow });
      },
    },
  };
}

describe('GET /v1/og: a signed card', () => {
  it('renders a starter template, labels the response and records the render against the site', async () => {
    const { user, site } = await account();
    const response = await call(await signedPath(site, 'blog', { title: 'Hello', author: 'Ahmad' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(`public, max-age=${HTTP_CACHE.imageMaxAgeSeconds}`);
    expect(response.headers.get('x-ltc-cache')).toBe('miss');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(isPng(await bytesOf(response))).toBe(true);

    const row = await ledgerRow(cacheKeyOf(response));
    expect(row).toMatchObject({
      user_id: user.id,
      site_id: site.id,
      source: 'og',
      template: 'blog',
      width: 1200,
      height: 630,
      format: 'png',
      charged_to: 'plan',
      r2_key: renderR2Key(user.id, cacheKeyOf(response), 'png'),
    });
    expect(row!.expires_at - row!.created_at).toBe(PLANS.free.cacheDays * DAY_MS);
    expect(await env.BUCKET.head(row!.r2_key)).not.toBeNull();
  });

  it('renders a custom template of the site owner and charges again only when the template changes', async () => {
    const { user, cookie, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Custom', n: '1' });
    const firstRender = await call(path);
    expect(firstRender.status).toBe(200);
    expect((await usageOf(user.id)).used).toBe(1);

    // Renaming does not touch the pixels: same card, still cached.
    expect((await dashboard(cookie, 'PUT', `/api/templates/${templateId}`, { name: 'Renamed' })).status).toBe(200);
    const afterRename = await call(reversedQuery(path));
    expect(afterRename.headers.get('x-ltc-cache')).toBe('hit');
    expect(afterRename.headers.get('etag')).toBe(firstRender.headers.get('etag'));

    // New source = new version = a different card, rendered and counted.
    const edited = await dashboard(cookie, 'PUT', `/api/templates/${templateId}`, { html: '<div class="card"><b>{{title}}</b></div>' });
    expect(edited.status).toBe(200);
    // (A third spelling of the URL: the edge may keep the earlier two for up to a day.)
    const afterEdit = await call(`${reversedQuery(path)}&`);
    expect(afterEdit.status).toBe(200);
    expect(afterEdit.headers.get('x-ltc-cache')).toBe('miss');
    expect(afterEdit.headers.get('etag')).not.toBe(firstRender.headers.get('etag'));
    expect((await usageOf(user.id)).used).toBe(2);
  });

  it('honours the size parameter and treats size=og as the default card', async () => {
    const { user, site, templateId } = await account();
    const square = await call(await signedPath(site, templateId, { title: 'Square', size: 'square' }));
    expect(square.status).toBe(200);
    expect(pngDimensions(await bytesOf(square))).toEqual({ width: 1080, height: 1080 });

    const portrait = await call(await signedPath(site, templateId, { title: 'Portrait', size: 'portrait' }, 'jpg'));
    expect(portrait.status).toBe(200);
    expect(portrait.headers.get('content-type')).toBe('image/jpeg');
    expect((await ledgerRow(cacheKeyOf(portrait)))).toMatchObject({ width: 1080, height: 1350, format: 'jpeg' });

    const implicit = await call(await signedPath(site, templateId, { title: 'Default size' }));
    const explicit = await call(await signedPath(site, templateId, { title: 'Default size', size: 'og' }));
    expect(explicit.headers.get('x-ltc-cache')).toBe('hit');
    expect(explicit.headers.get('etag')).toBe(implicit.headers.get('etag'));
    expect((await usageOf(user.id)).used).toBe(3);

    const unknown = await call(await signedPath(site, templateId, { title: 'Huge', size: '4000x4000' }));
    expect(unknown.status).toBe(400);
    const error = await errorOf(unknown);
    expect(error.code).toBe('unsupported_size');
    expect(error.message).toContain('square (1080x1080)');
    expect((await usageOf(user.id)).used).toBe(3);
  });

  it('answers 404 for paths, sites and templates that do not exist - and for another account\'s template', async () => {
    const { user, cookie, site, templateId } = await account();
    const other = await account();
    const deletedSite = await createSite(user.id);
    await dashboard(cookie, 'DELETE', `/api/sites/${deletedSite.id}`);
    const deletedTemplate = await createTemplate(cookie);
    await dashboard(cookie, 'DELETE', `/api/templates/${deletedTemplate}`);

    const params = { title: 'Nowhere' };
    const notFound: Array<[string, string]> = [
      ['not a card path', '/v1/og/only-one-segment'],
      ['unknown extension', `/v1/og/${site.id}/blog.gif?title=x&sig=${'0'.repeat(64)}`],
      ['unknown site', (await signedPath(site, 'blog', params)).replace(site.id, 's_doesnotexist0000')],
      ['deleted site', await signedPath(deletedSite, 'blog', params)],
      ['unknown template', await signedPath(site, 'no-such-template', params)],
      ['deleted template', await signedPath(site, deletedTemplate, params)],
      ["another account's template", await signedPath(site, other.templateId, params)],
    ];
    const messages = new Map<string, string>();
    for (const [label, path] of notFound) {
      const response = await call(path);
      expect(response.status, label).toBe(404);
      const error = await errorOf(response);
      expect(error.code, label).toBe('not_found');
      messages.set(label, error.message);
    }
    // Someone else's template is indistinguishable from one that does not exist.
    expect(messages.get("another account's template")).toBe(messages.get('unknown template'));
    expect(messages.get('deleted site')).toBe(messages.get('unknown site'));
    expect(await renderCount(user.id)).toBe(0);
    expect(await renderCount(other.user.id)).toBe(0);
    // The owner's own template id does work, so the 404 above is about ownership.
    expect((await call(await signedPath(site, templateId, params))).status).toBe(200);
  });

  it('stops verifying every existing URL of a site when its secret is rotated', async () => {
    const { cookie, site, templateId } = await account();
    const before = await signedPath(site, templateId, { title: 'Before rotation', n: '1' });
    expect((await call(before)).status).toBe(200);

    const rotated = await dashboard(cookie, 'POST', `/api/sites/${site.id}/rotate`, {});
    expect(rotated.status).toBe(200);
    const { site: rotatedSite, secret } = (await rotated.json()) as { site: { secret_version: number }; secret: string };
    expect(rotatedSite.secret_version).toBe(2);

    // The same card under a URL the edge has not cached: the old signature no longer verifies.
    const stale = await call(reversedQuery(before));
    expect(stale.status).toBe(403);
    expect((await errorOf(stale)).details?.reason).toBe('signature_mismatch');

    const fresh = await call(await signedPath(site, templateId, { title: 'Before rotation', n: '1' }, 'png', secret));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('x-ltc-cache')).toBe('hit');
  });

  it('refuses a suspended account with 403, after the signature check', async () => {
    const { user, site, templateId } = await account();
    await run(env.DB, 'UPDATE users SET suspended_at = ?1, suspended_reason = ?2 WHERE id = ?3', Date.now(), 'abuse', user.id);

    const suspended = await call(await signedPath(site, templateId, { title: 'Suspended' }));
    expect(suspended.status).toBe(403);
    const error = await errorOf(suspended);
    expect(error.code).toBe('account_suspended');
    expect(error.message).toContain(env.SUPPORT_EMAIL);

    // An unsigned probe learns nothing about the account's state.
    const unsigned = await call(`/v1/og/${site.id}/${templateId}.png?title=Suspended`);
    expect((await errorOf(unsigned)).code).toBe('invalid_signature');
    expect(await renderCount(user.id)).toBe(0);
  });
});

describe('GET /v1/og: cache layers and quota', () => {
  it('serves the edge copy for a repeated URL even when R2 no longer has the image', async () => {
    const { user, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Edge copy', n: '1' });
    const rendered = await call(path);
    const bytes = await bytesOf(rendered);
    await env.BUCKET.delete(renderR2Key(user.id, cacheKeyOf(rendered), 'png'));

    const again = await call(path);
    expect(again.status).toBe(200);
    expect(again.headers.get('x-ltc-cache')).toBe('hit');
    expect(again.headers.get('x-request-id')).not.toBe(rendered.headers.get('x-request-id'));
    expect(await bytesOf(again)).toEqual(bytes);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('re-renders without charging when the ledger covers a card whose R2 object is missing', async () => {
    const { user, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Lost object', n: '1' });
    const rendered = await call(path);
    const cacheKey = cacheKeyOf(rendered);
    const r2Key = renderR2Key(user.id, cacheKey, 'png');
    const ledger = await ledgerRow(cacheKey);
    await env.BUCKET.delete(r2Key);

    const recovered = await call(reversedQuery(path));
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get('x-ltc-cache')).toBe('miss');
    expect(isPng(await bytesOf(recovered))).toBe(true);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);

    // The object is back and expires together with the ledger row that paid for it.
    const stored = await env.BUCKET.head(r2Key);
    expect(stored?.customMetadata?.expiresAt).toBe(String(ledger!.expires_at));
    const third = await call(`${reversedQuery(path)}&`);
    expect(third.headers.get('x-ltc-cache')).toBe('hit');
  });

  it('counts a card again once its cache period is over, and never tells clients to cache beyond it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 2, 1, 12);
    vi.setSystemTime(start);
    const { user, site, templateId } = await account('free', start);
    const path = await signedPath(site, templateId, { title: 'Expiring', n: '1' });
    expect((await call(path)).headers.get('cache-control')).toBe('public, max-age=86400');

    // One hour before the 7 days are over: still cached, but only for that hour.
    vi.setSystemTime(start + PLANS.free.cacheDays * DAY_MS - 3_600_000);
    const lastHour = await call(reversedQuery(path));
    expect(lastHour.headers.get('x-ltc-cache')).toBe('hit');
    expect(lastHour.headers.get('cache-control')).toBe('public, max-age=3600');
    expect((await usageOf(user.id, Date.now())).used).toBe(1);

    vi.setSystemTime(start + PLANS.free.cacheDays * DAY_MS + 1);
    const expired = await call(`${reversedQuery(path)}&`);
    expect(expired.status).toBe(200);
    expect(expired.headers.get('x-ltc-cache')).toBe('miss');
    expect((await usageOf(user.id, Date.now())).used).toBe(2);
    expect(await renderCount(user.id)).toBe(1);
  });

  it('answers 402 before rendering when the allowance is used up, and renders again from a top-up', async () => {
    const { user, site, templateId } = await account('starter');
    await setUsed(user, PLANS.starter.monthlyImages);
    const path = await signedPath(site, templateId, { title: 'Over the limit', n: '1' });

    const refused = await call(path);
    expect(refused.status).toBe(402);
    const error = await errorOf(refused);
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toContain('2,000 images on the Starter plan');
    expect(error.message).toContain('upgrade or buy a top-up');
    expect(error.details?.usage).toMatchObject({ plan: 'starter', used: 2000, total_remaining: 0 });
    expect(typeof (error.details?.usage as { period_end: unknown }).period_end).toBe('string');
    expect(await renderCount(user.id)).toBe(0);

    const now = Date.now();
    await run(
      env.DB,
      'INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at) VALUES (?1, ?2, ?3, 1000, 1000, ?4, ?5)',
      `tu_${user.id}`,
      user.id,
      `txn_${user.id}`,
      now,
      now + 365 * DAY_MS,
    );
    const paid = await call(path);
    expect(paid.status).toBe(200);
    expect((await ledgerRow(cacheKeyOf(paid)))?.charged_to).toBe('topup');
    expect(await usageOf(user.id)).toMatchObject({ used: 2000, topup_remaining: 999 });
  });
});

describe('HEAD /v1/og', () => {
  it('never renders or charges: cached cards answer with their headers, uncached ones with the type only', async () => {
    const { user, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Head', n: '1' });

    const cold = await call(path, { method: 'HEAD' });
    expect(cold.status).toBe(200);
    expect(cold.headers.get('content-type')).toBe('image/png');
    expect(cold.headers.get('cache-control')).toBe('no-store');
    expect(cold.headers.get('x-ltc-cache')).toBe('miss');
    expect(cold.headers.get('content-length')).toBeNull();
    expect((await bytesOf(cold)).byteLength).toBe(0);
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);

    const rendered = await call(path);
    const size = (await bytesOf(rendered)).byteLength;

    // Reordered, so this HEAD is answered from R2 rather than the edge copy.
    const warm = await call(reversedQuery(path), { method: 'HEAD' });
    expect(warm.status).toBe(200);
    expect(warm.headers.get('x-ltc-cache')).toBe('hit');
    expect(warm.headers.get('etag')).toBe(rendered.headers.get('etag'));
    expect(warm.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect(warm.headers.get('content-length')).toBe(String(size));
    expect((await bytesOf(warm)).byteLength).toBe(0);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('reports a bad signature and an exhausted allowance like GET would', async () => {
    const { user, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Head errors', n: '1' });
    expect((await call(path.replace(/sig=[0-9a-f]{4}/, 'sig=0000'), { method: 'HEAD' })).status).toBe(403);
    await setUsed(user, PLANS.free.monthlyImages);
    expect((await call(path, { method: 'HEAD' })).status).toBe(402);
    expect(await renderCount(user.id)).toBe(0);
  });
});

describe('GET /v1/og: quota emails', () => {
  it('sends one notice at 90% and one at 100%, to the account owner, without delaying the image', async () => {
    const sent = mockResend();
    const { user, site, templateId } = await account();
    const limit = PLANS.free.monthlyImages;
    const card = (n: number): Promise<string> => signedPath(site, templateId, { title: 'Notice', n: String(n) });

    await setUsed(user, limit * 0.9 - 2);
    expect((await call(await card(1))).status).toBe(200);
    expect(sent).toHaveLength(0);

    expect((await call(await card(2))).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(user.email);
    expect(sent[0]!.subject).toContain('90%');
    expect(sent[0]!.idempotencyKey).toContain(`quota-90-${user.id}`);

    // Further images between the thresholds stay quiet.
    expect((await call(await card(3))).status).toBe(200);
    expect(sent).toHaveLength(1);

    await setUsed(user, limit - 1);
    expect((await call(await card(4))).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe(user.email);
    expect(sent[1]!.idempotencyKey).toContain(`quota-100-${user.id}`);
    expect((await call(await card(5))).status).toBe(402);
    expect(sent).toHaveLength(2);
  });

  it('still serves and counts the image when the email provider fails or is unreachable', async () => {
    const { user, site, templateId } = await account();
    const limit = PLANS.free.monthlyImages;
    await setUsed(user, limit * 0.9 - 1);
    const failing = mockResend(() => Response.json({ name: 'internal_server_error', message: 'boom' }, { status: 500 }));
    const first = await call(await signedPath(site, templateId, { title: 'Provider down', n: '1' }));
    expect(first.status).toBe(200);
    expect(isPng(await bytesOf(first))).toBe(true);
    expect(failing).toHaveLength(1);

    vi.restoreAllMocks();
    await setUsed(user, limit - 1);
    const unreachable = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const second = await call(await signedPath(site, templateId, { title: 'Provider down', n: '2' }));
    expect(second.status).toBe(200);
    expect(unreachable).toHaveBeenCalledTimes(1);
    expect((await usageOf(user.id)).used).toBe(limit);
  });
});

describe('GET /v1/og without an execution context', () => {
  it('still renders, counts and sends the notice when the router is called directly', async () => {
    const sent = mockResend();
    const { user, site, templateId } = await account();
    await setUsed(user, PLANS.free.monthlyImages * 0.9 - 1);
    const response = await app.request(await signedPath(site, templateId, { title: 'No context', n: '1' }), {}, env);
    expect(response.status).toBe(200);
    expect(isPng(await bytesOf(response))).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await usageOf(user.id)).used).toBe(PLANS.free.monthlyImages * 0.9);
  });
});

describe('GET /v1/og: rate limits', () => {
  const limited = (overrides: Partial<Env>): Env => ({ ...env, RATE_LIMITS_DISABLED: '0', ...overrides });

  it('limits by client IP, and by site only when a render is needed', async () => {
    const { user, site, templateId } = await account();
    const ip = limiter(true);
    const perSite = limiter(true);
    const bindings = limited({ RL_IP: ip.binding, RL_KEY: perSite.binding });
    const path = await signedPath(site, templateId, { title: 'Limited', n: '1' });
    const headers = { 'cf-connecting-ip': '203.0.113.7' };

    expect((await call(path, { headers }, bindings)).status).toBe(200);
    expect(ip.keys).toEqual(['203.0.113.7']);
    expect(perSite.keys).toEqual([site.id]);

    // The edge copy answers before any limiter; the R2 copy passes the IP limiter but not the per-site one.
    expect((await call(path, { headers }, bindings)).headers.get('x-ltc-cache')).toBe('hit');
    expect(ip.keys).toHaveLength(1);
    expect((await call(reversedQuery(path), { headers }, bindings)).headers.get('x-ltc-cache')).toBe('hit');
    expect(ip.keys).toHaveLength(2);
    expect(perSite.keys).toHaveLength(1);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('answers 429 with Retry-After when a limiter says no, and renders nothing', async () => {
    const { user, site, templateId } = await account();
    const path = await signedPath(site, templateId, { title: 'Too fast', n: '1' });

    const byIp = await call(path, {}, limited({ RL_IP: limiter(false).binding, RL_KEY: limiter(true).binding }));
    expect(byIp.status).toBe(429);
    expect(byIp.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_IP.periodSeconds));
    expect((await errorOf(byIp)).code).toBe('rate_limited');

    const bySite = await call(path, {}, limited({ RL_IP: limiter(true).binding, RL_KEY: limiter(false).binding }));
    expect(bySite.status).toBe(429);
    expect((await errorOf(bySite)).details).toMatchObject({ limit: RATE_LIMITS.RL_KEY.limit });
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);
  });
});
