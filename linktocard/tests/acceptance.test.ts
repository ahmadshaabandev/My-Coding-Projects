// The owner's acceptance list, one test per criterion, each driven through the
// real Worker app (router, middleware, D1, R2, an execution context) - never
// through internal functions. Test names quote the criterion they prove.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP } from '../src/billing/plans';
import { LIMITS } from '../src/config';
import {
  TINY_CSS,
  TINY_HTML,
  apiKeyFor,
  bearer,
  bytesOf,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  dohAnswer,
  errorOf,
  isJpeg,
  isPng,
  isWebp,
  paddleSignature,
  pngDimensions,
  postImage,
  postWebhook,
  renderCount,
  requestUrl,
  reversedQuery,
  sessionCookieFor,
  signedPath,
  usageOf,
  userRow,
} from './app-helpers';
import subscriptionCanceled from './fixtures/paddle/subscription.canceled.json';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';
import subscriptionUpdated from './fixtures/paddle/subscription.updated.json';
import transactionCompleted from './fixtures/paddle/transaction.completed.json';

interface PaddleFixture {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

interface UsageBody {
  plan: string;
  limit: number;
  used: number;
  remaining: number;
  topup_remaining: number;
  total_remaining: number;
  watermark: boolean;
  period_start: string;
  period_end: string;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_acc${String(++sequence).padStart(4, '0')}`;

async function usageVia(secret: string): Promise<UsageBody> {
  const response = await call('/v1/usage', { headers: bearer(secret) });
  expect(response.status).toBe(200);
  return response.json();
}

/** Resend accepts every email; returns the subjects it was asked to send. */
function mockResend(): string[] {
  const subjects: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url.href}`);
    subjects.push((JSON.parse(String(init?.body)) as { subject: string }).subject);
    return Response.json({ id: 'email_test' });
  });
  return subjects;
}

describe('acceptance', () => {
  it('1. "Playground render returns a valid PNG, about 1200x630"', async () => {
    const response = await call('/playground/card.png?template=blog&title=Hello%20from%20the%20playground&author=Ahmad');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = await bytesOf(response);
    expect(isPng(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

  it('2. "Signed URL without a valid sig is rejected (4xx)" - missing, malformed, wrong secret, tampered param, tampered path', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const params = { title: 'Signed card', author: 'Ahmad' };
    const valid = await signedPath(site, 'blog', params);
    const [pathname, query = ''] = valid.split('?');
    const withoutSig = query.replace(/&?sig=[0-9a-f]+/, '');
    const wrongSecret = await signedPath(site, 'blog', params, 'png', 'ltcs_not_the_secret_of_this_site');

    const rejected: Array<[string, string, string]> = [
      ['missing', `${pathname}?${withoutSig}`, 'missing_sig'],
      ['malformed', `${pathname}?${withoutSig}&sig=not-hex`, 'malformed_sig'],
      ['wrong secret', wrongSecret, 'signature_mismatch'],
      ['tampered param', valid.replace('Signed+card', 'Hacked+card'), 'signature_mismatch'],
      ['tampered path (template)', valid.replace('/blog.png', '/dark.png'), 'signature_mismatch'],
      ['tampered path (format)', valid.replace('/blog.png', '/blog.webp'), 'signature_mismatch'],
    ];
    for (const [label, path, reason] of rejected) {
      const response = await call(path);
      expect(response.status, label).toBe(403);
      expect(response.headers.get('cache-control'), label).toBe('no-store');
      const error = await errorOf(response);
      expect(error.code, label).toBe('invalid_signature');
      expect(error.details?.reason, label).toBe(reason);
    }
    // Nothing was rendered, stored or counted for any of them.
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('3. "Valid sig returns image/png (or the requested type) and is cacheable" - png, jpg, webp; Cache-Control public + max-age, ETag, 304', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const params = { title: 'Cacheable card', author: 'Ahmad' };

    const pngPath = await signedPath(site, 'blog', params, 'png');
    const png = await call(pngPath);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toMatch(/^public, max-age=[1-9]\d*$/);
    expect(png.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const etag = png.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const pngBytes = await bytesOf(png);
    expect(isPng(pngBytes)).toBe(true);
    expect(pngDimensions(pngBytes)).toEqual({ width: 1200, height: 630 });

    const jpg = await call(await signedPath(site, 'blog', params, 'jpg'));
    expect(jpg.status).toBe(200);
    expect(jpg.headers.get('content-type')).toBe('image/jpeg');
    expect(jpg.headers.get('cache-control')).toMatch(/^public, max-age=[1-9]\d*$/);
    expect(jpg.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(isJpeg(await bytesOf(jpg))).toBe(true);

    const webp = await call(await signedPath(site, 'blog', params, 'webp'));
    expect(webp.status).toBe(200);
    expect(webp.headers.get('content-type')).toBe('image/webp');
    expect(webp.headers.get('cache-control')).toMatch(/^public, max-age=[1-9]\d*$/);
    expect(isWebp(await bytesOf(webp))).toBe(true);

    // 304 from the edge copy (same URL) and from R2 (same card, different URL).
    for (const path of [pngPath, reversedQuery(pngPath)]) {
      const conditional = await call(path, { headers: { 'if-none-match': etag! } });
      expect(conditional.status).toBe(304);
      expect(conditional.headers.get('etag')).toBe(etag);
      expect((await bytesOf(conditional)).byteLength).toBe(0);
    }
    expect((await usageOf(user.id)).used).toBe(3);
  });

  it('4. "A second identical request is served from cache without decrementing quota" - same URL (edge) and same card under another URL (R2)', async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const path = await signedPath(site, 'blog', { title: 'Rendered once', author: 'Ahmad' });

    const first = await call(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ltc-cache')).toBe('miss');
    const firstBytes = await bytesOf(first);
    const afterFirst = await usageOf(user.id);
    expect(afterFirst.used).toBe(1);

    const sameUrl = await call(path);
    expect(sameUrl.status).toBe(200);
    expect(sameUrl.headers.get('x-ltc-cache')).toBe('hit');
    expect(await bytesOf(sameUrl)).toEqual(firstBytes);

    // Same parameters in another order: a URL the edge cache has never seen, so this is the R2 copy.
    const reordered = reversedQuery(path);
    expect(reordered).not.toBe(path);
    const fromR2 = await call(reordered);
    expect(fromR2.status).toBe(200);
    expect(fromR2.headers.get('x-ltc-cache')).toBe('hit');
    expect(fromR2.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(await bytesOf(fromR2)).toEqual(firstBytes);

    expect(await usageOf(user.id)).toEqual(afterFirst);
    expect(await renderCount(user.id)).toBe(1);
  });

  it('5. "A failed render does not decrement quota" - a template over a limit, and an image URL the proxy refuses', async () => {
    const user = await createUser();
    const key = await apiKeyFor(user.id);
    const cookie = await sessionCookieFor(user.id);
    const site = await createSite(user.id);

    const tooManyNodes = `<div>${'<span>x</span>'.repeat(LIMITS.maxNodes + 50)}</div>`;
    const overLimit = await postImage(key.secret, { html: tooManyNodes });
    expect(overLimit.status).toBe(422);
    expect((await errorOf(overLimit)).code).toBe('template_error');

    const refusedByApi = await postImage(key.secret, {
      html: '<img src="{{image}}" width="200" height="200">',
      data: { image: 'http://127.0.0.1/secret.png' },
    });
    expect(refusedByApi.status).toBe(422);
    expect((await errorOf(refusedByApi)).code).toBe('image_fetch_failed');

    const templateId = await createTemplate(cookie, '<img src="{{image}}" width="200" height="200">', '');
    const refusedBySignedUrl = await call(await signedPath(site, templateId, { image: 'http://169.254.169.254/latest/meta-data/' }));
    expect(refusedBySignedUrl.status).toBe(422);
    expect(refusedBySignedUrl.headers.get('cache-control')).toBe('no-store');
    expect((await errorOf(refusedBySignedUrl)).code).toBe('image_fetch_failed');

    const usage = await usageVia(key.secret);
    expect(usage.used).toBe(0);
    expect(usage.remaining).toBe(PLANS.free.monthlyImages);
    expect(await renderCount(user.id)).toBe(0);
  });

  it(
    '6. "After 100 successful uncached Free renders in a simulated month, the next unique render returns 402 with a clear JSON error; cached ones still serve; after the month rolls over rendering works again"',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.UTC(2027, 0, 28, 9));
      const emails = mockResend();
      const limit = PLANS.free.monthlyImages;
      expect(limit).toBe(100);

      const user = await createUser('free', Date.now());
      const site = await createSite(user.id, Date.now());
      const templateId = await createTemplate(await sessionCookieFor(user.id, Date.now()), TINY_HTML, TINY_CSS);
      const card = (n: number): Promise<string> => signedPath(site, templateId, { title: 'Monthly post', n: String(n) });

      for (let n = 1; n <= limit; n++) {
        const response = await call(await card(n));
        expect(response.status, `render ${n}`).toBe(200);
        expect(response.headers.get('x-ltc-cache'), `render ${n}`).toBe('miss');
        await response.arrayBuffer();
      }
      const full = await usageOf(user.id, Date.now());
      expect(full).toMatchObject({ used: limit, remaining: 0, total_remaining: 0 });
      expect(await renderCount(user.id)).toBe(limit);

      const next = await call(await card(limit + 1));
      expect(next.status).toBe(402);
      expect(next.headers.get('content-type')).toContain('application/json');
      expect(next.headers.get('cache-control')).toBe('no-store');
      const error = await errorOf(next);
      expect(error.code).toBe('quota_exceeded');
      expect(error.message).toContain('100 images');
      expect(error.message).toContain('used up');
      expect(error.message).toContain('2027-02-01');
      expect(error.message).toContain('/pricing');
      expect(error.details?.usage).toMatchObject({ plan: 'free', limit, used: limit, remaining: 0 });

      // Cached cards keep working at the limit: from the edge and, under a reordered URL, from R2.
      for (const path of [await card(1), reversedQuery(await card(50))]) {
        const cached = await call(path);
        expect(cached.status).toBe(200);
        expect(cached.headers.get('x-ltc-cache')).toBe('hit');
        expect(isPng(await bytesOf(cached))).toBe(true);
      }
      expect((await usageOf(user.id, Date.now())).used).toBe(limit);
      expect(await renderCount(user.id)).toBe(limit);

      // The two quota notices went out exactly once each, at 90% and at 100%.
      expect(emails).toHaveLength(2);
      expect(emails[0]).toContain('90%');

      vi.setSystemTime(Date.UTC(2027, 1, 1, 0, 0, 5));
      const afterRollover = await call(await card(limit + 1));
      expect(afterRollover.status).toBe(200);
      expect(afterRollover.headers.get('x-ltc-cache')).toBe('miss');
      expect(isPng(await bytesOf(afterRollover))).toBe(true);
      expect(await usageOf(user.id, Date.now())).toMatchObject({ used: 1, remaining: limit - 1 });
    },
    300_000,
  );

  it('7. "API key auth works; a revoked key is rejected; no key / malformed key is 401"', async () => {
    const user = await createUser();
    const cookie = await sessionCookieFor(user.id);
    const created = await dashboard(cookie, 'POST', '/api/keys', { name: 'Acceptance key' });
    expect(created.status).toBe(201);
    const { key, secret } = (await created.json()) as { key: { id: string }; secret: string };
    expect(secret.startsWith('ltc_')).toBe(true);

    const rendered = await postImage(secret, { template: 'blog', data: { title: 'Authenticated' } });
    expect(rendered.status).toBe(200);
    expect(((await rendered.json()) as { cached: boolean }).cached).toBe(false);
    expect((await usageVia(secret)).used).toBe(1);

    const body = JSON.stringify({ template: 'blog', data: { title: 'Never rendered' } });
    const unauthenticated: Array<[string, Record<string, string>]> = [
      ['no key', {}],
      ['not a bearer header', { authorization: secret }],
      ['malformed key', { authorization: 'Bearer not-a-key' }],
      ['well-formed but unknown key', { authorization: `Bearer ltc_${'0'.repeat(40)}` }],
    ];
    for (const [label, headers] of unauthenticated) {
      for (const [method, path] of [['POST', '/v1/images'], ['GET', '/v1/usage'], ['GET', '/v1/templates']] as const) {
        const response = await call(path, {
          method,
          headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
          body: method === 'POST' ? body : undefined,
        });
        expect(response.status, `${label} ${path}`).toBe(401);
        expect(response.headers.get('www-authenticate'), `${label} ${path}`).toContain('Bearer');
        expect((await errorOf(response)).code, `${label} ${path}`).toBe('invalid_api_key');
      }
    }

    const revoked = await dashboard(cookie, 'DELETE', `/api/keys/${key.id}`);
    expect(revoked.status).toBe(200);
    for (const response of [await postImage(secret, JSON.parse(body)), await call('/v1/usage', { headers: bearer(secret) })]) {
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe('invalid_api_key');
    }
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('8. "Paddle: a correctly signed subscription event for Starter flips the plan and the new limit applies to /v1/usage; a cancellation returns the account to Free at period end; a bad signature is refused" - implemented: a scheduled cancellation keeps Starter (cancel_at is shown) and the subscription.canceled event Paddle sends when the period ends sets the plan to Free', async () => {
    const user = await createUser();
    const key = await apiKeyFor(user.id);
    const cookie = await sessionCookieFor(user.id);
    const subscriptionId = nextId('sub');
    const customerId = nextId('ctm');
    const now = Date.now();
    const periodEnd = now + 20 * 24 * 60 * 60 * 1000;

    /** Paddle's example payload with our ids, price, status and dates, as sent after a sandbox checkout. */
    const subscriptionEvent = (fixture: PaddleFixture, at: number, changes: { status?: string; cancelAt?: number } = {}): string => {
      const event = structuredClone(fixture);
      event.event_id = nextId('evt');
      event.occurred_at = new Date(at).toISOString();
      Object.assign(event.data, {
        id: subscriptionId,
        customer_id: customerId,
        custom_data: { user_id: user.id },
        current_billing_period: { starts_at: new Date(now - 60_000).toISOString(), ends_at: new Date(periodEnd).toISOString() },
        scheduled_change: changes.cancelAt
          ? { action: 'cancel', effective_at: new Date(changes.cancelAt).toISOString(), resume_at: null }
          : null,
        ...(changes.status ? { status: changes.status } : {}),
      });
      (event.data.items as Array<{ price: { id: string } }>)[0]!.price.id = env.PADDLE_PRICE_STARTER ?? '';
      return JSON.stringify(event);
    };

    expect(await usageVia(key.secret)).toMatchObject({ plan: 'free', limit: PLANS.free.monthlyImages, watermark: true });

    // A bad signature is refused and changes nothing.
    const forged = subscriptionEvent(subscriptionCreated, now, { status: 'active' });
    for (const signature of [null, 'ts=1;h1=00', await paddleSignature(forged, 'pdl_ntfset_someone_elses_secret')]) {
      const refused = await postWebhook(forged, signature);
      expect(refused.status).toBe(401);
      expect((await errorOf(refused)).code).toBe('unauthorized');
    }
    expect((await userRow(user.id)).plan).toBe('free');

    const created = subscriptionEvent(subscriptionCreated, now + 1, { status: 'active' });
    const applied = await postWebhook(created, await paddleSignature(created));
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ ok: true, result: 'ok' });
    expect(await usageVia(key.secret)).toMatchObject({
      plan: 'starter',
      limit: PLANS.starter.monthlyImages,
      remaining: PLANS.starter.monthlyImages,
      watermark: false,
      period_end: new Date(periodEnd).toISOString(),
    });

    // The customer cancels: Paddle schedules it for the end of the paid period. Still Starter.
    const scheduled = subscriptionEvent(subscriptionUpdated, now + 2, { status: 'active', cancelAt: periodEnd });
    expect((await postWebhook(scheduled, await paddleSignature(scheduled))).status).toBe(200);
    expect((await usageVia(key.secret)).plan).toBe('starter');
    const me = (await (await dashboard(cookie, 'GET', '/api/me')).json()) as {
      user: { plan: string; subscription: { status: string; cancel_at: string | null } | null };
    };
    expect(me.user.plan).toBe('starter');
    expect(me.user.subscription).toMatchObject({ status: 'active', cancel_at: new Date(periodEnd).toISOString() });

    // Period end: Paddle sends subscription.canceled and the account is Free again.
    const canceled = subscriptionEvent(subscriptionCanceled, now + 3, { status: 'canceled' });
    expect((await postWebhook(canceled, await paddleSignature(canceled))).status).toBe(200);
    expect(await usageVia(key.secret)).toMatchObject({ plan: 'free', limit: PLANS.free.monthlyImages, watermark: true });
  });

  it('9. "Webhook handler is idempotent: replaying the same event id does not double-credit a top-up"', async () => {
    const user = await createUser();
    const key = await apiKeyFor(user.id);
    const event = structuredClone(transactionCompleted) as PaddleFixture;
    event.event_id = nextId('evt');
    event.occurred_at = new Date().toISOString();
    Object.assign(event.data, { id: nextId('txn'), customer_id: nextId('ctm'), subscription_id: null, custom_data: { user_id: user.id } });
    // The official example has three items; the third is a one-time price, which becomes the top-up.
    const item = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[2]!;
    item.price.id = env.PADDLE_PRICE_TOPUP ?? '';
    item.quantity = 1;
    const raw = JSON.stringify(event);

    const first = await postWebhook(raw, await paddleSignature(raw));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, result: 'ok' });
    expect((await usageVia(key.secret)).topup_remaining).toBe(TOPUP.images);

    for (let replay = 0; replay < 2; replay++) {
      const again = await postWebhook(raw, await paddleSignature(raw));
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, duplicate: true });
    }
    // Even a redelivery under a new event id cannot credit the same transaction twice.
    const renamed = JSON.stringify({ ...event, event_id: nextId('evt') });
    const redelivered = await postWebhook(renamed, await paddleSignature(renamed));
    expect(await redelivered.json()).toEqual({ ok: true, result: 'ignored:already_credited' });

    const usage = await usageVia(key.secret);
    expect(usage.topup_remaining).toBe(TOPUP.images);
    expect(usage.total_remaining).toBe(PLANS.free.monthlyImages + TOPUP.images);
  });

  it('10. "Image proxy refuses 127.0.0.1, 10.0.0.0/8, 169.254.169.254, an oversize body and a non-image" - through POST /v1/images with data.image: 422 image_fetch_failed, nothing counted', async () => {
    const user = await createUser();
    const key = await apiKeyFor(user.id);
    const oversize = 'https://cdn.acceptance-oversize.example.org/huge.png';
    const notAnImage = 'https://www.acceptance-page.example.org/index.html';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.origin + url.pathname === 'https://cloudflare-dns.com/dns-query') return dohAnswer(url);
      if (url.href === oversize) {
        return new Response(new Uint8Array(LIMITS.maxImageBytes + 1), { headers: { 'content-type': 'image/png' } });
      }
      if (url.href === notAnImage) {
        return new Response('<!doctype html><title>Not an image</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      throw new Error(`unexpected fetch ${url.href}`);
    });
    const fetched = (): string[] => fetchMock.mock.calls.map(([input]) => requestUrl(input).href);

    const refused: Array<[string, string]> = [
      ['http://127.0.0.1/admin.png', 'blocked_host'],
      ['http://10.20.30.40/internal.png', 'blocked_host'],
      ['http://169.254.169.254/latest/meta-data/iam/', 'blocked_host'],
      [oversize, 'too_large'],
      [notAnImage, 'bad_content_type'],
    ];
    for (const [image, reason] of refused) {
      const response = await postImage(key.secret, {
        html: '<div style="display:flex"><img src="{{image}}" width="300" height="300"></div>',
        data: { image },
      });
      expect(response.status, image).toBe(422);
      expect(response.headers.get('cache-control'), image).toBe('no-store');
      const error = await errorOf(response);
      expect(error.code, image).toBe('image_fetch_failed');
      expect(error.details?.reason, image).toBe(reason);
    }
    // The private addresses were refused before any request left the Worker.
    expect(fetched().filter((url) => /127\.0\.0\.1|10\.20\.30\.40|169\.254\.169\.254/.test(url))).toEqual([]);
    expect(fetched()).toContain(oversize);
    expect(fetched()).toContain(notAnImage);

    const usage = await usageVia(key.secret);
    expect(usage.used).toBe(0);
    expect(usage.remaining).toBe(PLANS.free.monthlyImages);
    expect(await renderCount(user.id)).toBe(0);
  });
});
