// The API-key endpoints (/v1/images, /v1/usage, /v1/templates), stored images
// (/i/...) and the app shell (health, 404s, error mapping, security headers),
// all through the real app.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS, LIMITS, RATE_LIMITS } from '../src/config';
import { run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import { validateData, warningsHeader } from '../src/lib/images';
import { STARTER_TEMPLATE_IDS } from '../src/render/templates';
import type { Env, RateLimitBinding } from '../src/types';
import {
  ORIGIN,
  TINY_CSS,
  TINY_HTML,
  apiKeyFor,
  bearer,
  bytesOf,
  call,
  createTemplate,
  createUser,
  errorOf,
  isJpeg,
  isPng,
  isWebp,
  paddleSignature,
  pngDimensions,
  postImage,
  postWebhook,
  renderCount,
  sessionCookieFor,
  setUsed,
  usageOf,
} from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface ImageJson {
  id: string;
  url: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  cached: boolean;
  template: string;
  created_at: string;
  expires_at: string;
  warnings: string[];
  usage: { plan: string; used: number; remaining: number; period_start: string; period_end: string };
}

async function account(plan: 'free' | 'starter' | 'pro' = 'free', now: number = Date.now()) {
  const user = await createUser(plan, now);
  const key = await apiKeyFor(user.id, now);
  return { user, key, secret: key.secret };
}

const tiny = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  html: TINY_HTML,
  css: TINY_CSS,
  data: { title },
  ...extra,
});

const pathOf = (url: string): string => url.slice(ORIGIN.length);

describe('POST /v1/images', () => {
  it('renders a starter template, returns the documented JSON and a URL that serves the image', async () => {
    const { user, secret } = await account();
    const response = await postImage(secret, { template: 'blog', data: { title: 'From the API', author: 'Ahmad' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const image: ImageJson = await response.json();
    expect(image).toMatchObject({ width: 1200, height: 630, format: 'png', cached: false, template: 'blog' });
    expect(image.id).toMatch(/^[0-9a-f]{64}$/);
    expect(image.url).toBe(`${ORIGIN}/i/${user.id}/${image.id}.png`);
    expect(image.bytes).toBeGreaterThan(1000);
    expect(Array.isArray(image.warnings)).toBe(true);
    expect(Date.parse(image.expires_at) - Date.parse(image.created_at)).toBe(PLANS.free.cacheDays * DAY_MS);
    expect(image.usage).toMatchObject({ plan: 'free', used: 1, remaining: PLANS.free.monthlyImages - 1 });
    expect(image.usage.period_start).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);

    const served = await call(pathOf(image.url));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    const bytes = await bytesOf(served);
    expect(bytes.byteLength).toBe(image.bytes);
    expect(isPng(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it('returns the cached image for an identical request without counting it again', async () => {
    const { user, secret } = await account();
    const first: ImageJson = await (await postImage(secret, tiny('Once'))).json();
    // Key order and omitted defaults do not make a different card.
    const second: ImageJson = await (
      await postImage(secret, { format: 'png', size: 'og', data: { title: 'Once' }, css: TINY_CSS, html: TINY_HTML })
    ).json();
    expect(second.cached).toBe(true);
    expect(second).toMatchObject({ id: first.id, url: first.url, bytes: first.bytes, created_at: first.created_at, expires_at: first.expires_at });
    expect(second.usage.used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);

    // Any difference in data, CSS, size or format is a different card.
    const different = [
      tiny('Twice'),
      tiny('Once', { css: `${TINY_CSS} .n { color: red; }` }),
      tiny('Once', { size: 'square' }),
      tiny('Once', { format: 'webp' }),
    ];
    const ids = new Set([first.id]);
    for (const body of different) ids.add(((await (await postImage(secret, body)).json()) as ImageJson).id);
    expect(ids.size).toBe(5);
    expect((await usageOf(user.id)).used).toBe(5);
  });

  it('keeps accounts apart: the same request from two accounts is two images, each counted once', async () => {
    const a = await account();
    const b = await account();
    const forA: ImageJson = await (await postImage(a.secret, tiny('Shared words'))).json();
    const forB: ImageJson = await (await postImage(b.secret, tiny('Shared words'))).json();
    expect(forB.cached).toBe(false);
    expect(forB.id).not.toBe(forA.id);
    expect((await usageOf(a.user.id)).used).toBe(1);
    expect((await usageOf(b.user.id)).used).toBe(1);
  });

  it('renders every format and size, by name or by width and height', async () => {
    const { secret } = await account();
    const jpeg: ImageJson = await (await postImage(secret, tiny('Formats', { format: 'jpeg', size: 'square' }))).json();
    expect(jpeg).toMatchObject({ format: 'jpeg', width: 1080, height: 1080 });
    expect(jpeg.url.endsWith('.jpg')).toBe(true);
    expect(isJpeg(await bytesOf(await call(pathOf(jpeg.url))))).toBe(true);

    const alias: ImageJson = await (await postImage(secret, tiny('Formats', { format: 'jpg', size: 'square' }))).json();
    expect(alias).toMatchObject({ id: jpeg.id, cached: true });

    const webp: ImageJson = await (await postImage(secret, tiny('Formats', { format: 'webp', width: 1080, height: 1350 }))).json();
    expect(webp).toMatchObject({ format: 'webp', width: 1080, height: 1350 });
    const served = await call(pathOf(webp.url));
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(isWebp(await bytesOf(served))).toBe(true);
  });

  it('returns the bytes with the image headers when response is "binary"', async () => {
    const { user, secret } = await account();
    const fresh = await postImage(secret, tiny('Binary', { response: 'binary' }));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('content-type')).toBe('image/png');
    expect(fresh.headers.get('x-ltc-cache')).toBe('miss');
    expect(fresh.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(fresh.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const url = fresh.headers.get('x-ltc-image-url')!;
    expect(url.startsWith(`${ORIGIN}/i/${user.id}/`)).toBe(true);
    expect(JSON.parse(decodeURIComponent(fresh.headers.get('x-ltc-warnings')!))).toEqual([]);
    const bytes = await bytesOf(fresh);
    expect(isPng(bytes)).toBe(true);

    const cached = await postImage(secret, tiny('Binary', { response: 'binary' }));
    expect(cached.headers.get('x-ltc-cache')).toBe('hit');
    expect(cached.headers.get('x-ltc-image-url')).toBe(url);
    expect(await bytesOf(cached)).toEqual(bytes);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('reports render warnings in JSON and in the binary header', async () => {
    const { secret } = await account();
    const html = '<div class="card">{{title}}<button>Buy</button></div>';
    const json: ImageJson = await (await postImage(secret, { html, css: TINY_CSS, data: { title: 'Warned' } })).json();
    expect(json.warnings.length).toBeGreaterThan(0);
    const binary = await postImage(secret, { html, css: TINY_CSS, data: { title: 'Warned again' }, response: 'binary' });
    expect(JSON.parse(decodeURIComponent(binary.headers.get('x-ltc-warnings')!))).toEqual(json.warnings);
  });

  it('renders the account\'s own custom template and hides everyone else\'s', async () => {
    const owner = await account();
    const stranger = await account();
    const templateId = await createTemplate(await sessionCookieFor(owner.user.id));

    const own: ImageJson = await (await postImage(owner.secret, { template: templateId, data: { title: 'Mine' } })).json();
    expect(own).toMatchObject({ template: templateId, cached: false });

    const theirs = await postImage(stranger.secret, { template: templateId, data: { title: 'Not mine' } });
    const missing = await postImage(stranger.secret, { template: 't_doesnotexist0000', data: { title: 'Not mine' } });
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await errorOf(theirs)).toEqual(await errorOf(missing));
    expect(await renderCount(stranger.user.id)).toBe(0);
  });

  it('rejects malformed bodies with a message that says what to fix', async () => {
    const { user, secret } = await account();
    const cases: Array<[string, unknown, string]> = [
      ['empty body', '', 'empty'],
      ['broken JSON', '{"template": "blog", ', 'not valid JSON'],
      ['an array', '[1, 2]', 'must be a JSON object'],
      ['a typo in a field name', { tempalte: 'blog' }, 'Unknown field "tempalte"'],
      ['neither template nor html', { data: { title: 'x' } }, 'exactly one of "template"'],
      ['both template and html', { template: 'blog', html: '<b>x</b>' }, 'exactly one of "template"'],
      ['css without html', { template: 'blog', css: 'b{}' }, '"css" can only be sent together with "html"'],
      ['template of the wrong type', { template: 42 }, '"template" must be a template id'],
      ['empty html', { html: '   ' }, '"html" must be a non-empty string'],
      ['css of the wrong type', { html: '<b>x</b>', css: 7 }, '"css" must be a string'],
      ['unknown response mode', { template: 'blog', response: 'base64' }, '"response" must be'],
      ['size and width together', { template: 'blog', size: 'og', width: 1200, height: 630 }, 'either "size" or "width"'],
      ['data as a list', { template: 'blog', data: ['title'] }, '"data" must be an object'],
      ['a bad data key', { template: 'blog', data: { 'Title-1': 'x' } }, 'Data key "Title-1" is not valid'],
      ['a non-string data value', { template: 'blog', data: { count: 3 } }, 'Data value "count" must be a string'],
      [
        'too many data keys',
        { template: 'blog', data: Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys + 1 }, (_, i) => [`k${i}`, 'v'])) },
        `at most ${LIMITS.maxDataKeys} keys`,
      ],
      ['a data value that is too long', { template: 'blog', data: { title: 'x'.repeat(LIMITS.maxDataValueChars + 1) } }, 'longer than 1000 characters'],
    ];
    for (const [label, body, fragment] of cases) {
      const response = await postImage(secret, body);
      expect(response.status, label).toBe(400);
      const error = await errorOf(response);
      expect(error.code, label).toBe('invalid_request');
      expect(error.message, label).toContain(fragment);
      expect(error.docs, label).toBe(`${ORIGIN}/docs/api#errors`);
    }
    const typo = await errorOf(await postImage(secret, { tempalte: 'blog', dta: {} }));
    expect(typo.details).toEqual({ unknown_fields: ['tempalte', 'dta'] });

    const unsupported: Array<[unknown, string]> = [
      [{ template: 'blog', format: 'gif' }, 'unsupported_format'],
      [{ template: 'blog', size: 'banner' }, 'unsupported_size'],
      [{ template: 'blog', width: 1200, height: 631 }, 'unsupported_size'],
      [{ template: 'blog', width: 1200 }, 'unsupported_size'],
    ];
    for (const [body, code] of unsupported) {
      const response = await postImage(secret, body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe(code);
    }
    expect(await renderCount(user.id)).toBe(0);
  });

  it('counts data values in code points, like the signed-URL verifier', () => {
    const astral = '\u{1D49C}';
    expect(validateData({ title: astral.repeat(LIMITS.maxDataValueChars) }).title).toHaveLength(LIMITS.maxDataValueChars * 2);
    expect(() => validateData({ title: astral.repeat(LIMITS.maxDataValueChars + 1) })).toThrow(ApiError);
    expect(validateData(undefined)).toEqual({});
    expect(() => validateData({ size: 'og' }, ['size'])).toThrow('reserved');
  });

  it('keeps the warnings header within a safe size by dropping whole warnings from the end', () => {
    const warnings = Array.from({ length: 50 }, (_, index) => `Warning ${index}: ${'\u00e9'.repeat(100)}`);
    const header = warningsHeader(warnings);
    expect(header.length).toBeLessThanOrEqual(6000);
    const kept = JSON.parse(decodeURIComponent(header)) as string[];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(warnings.slice(0, kept.length));
    expect(kept.length).toBeLessThan(warnings.length);
    expect(warningsHeader([])).toBe('%5B%5D');
  });

  it('refuses a body over the size cap, whether or not Content-Length admits it', async () => {
    const { user, secret } = await account();
    const oversized = JSON.stringify({ html: `<div>${'x'.repeat(LIMITS.maxRequestBodyBytes)}</div>` });

    const declared = await postImage(secret, oversized);
    expect(declared.status).toBe(413);
    const error = await errorOf(declared);
    expect(error.code).toBe('payload_too_large');
    expect(error.details).toEqual({ max_bytes: LIMITS.maxRequestBodyBytes });

    // No Content-Length at all, and a body that never ends on its own: reading stops just past the cap.
    const chunk = new TextEncoder().encode('x'.repeat(16_384));
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const streamed = await call('/v1/images', { method: 'POST', headers: bearer(secret), body: endless });
    expect(streamed.status).toBe(413);
    expect((await errorOf(streamed)).code).toBe('payload_too_large');
    expect(pulled * chunk.byteLength).toBeLessThan(LIMITS.maxRequestBodyBytes + 4 * chunk.byteLength);
    expect(await renderCount(user.id)).toBe(0);
  });

  it('answers 402 at the limit with the usage in the error, while cached images keep working', async () => {
    const { user, secret } = await account();
    const cachedBefore: ImageJson = await (await postImage(secret, tiny('Before the limit'))).json();
    await setUsed(user, PLANS.free.monthlyImages);

    const refused = await postImage(secret, tiny('After the limit'));
    expect(refused.status).toBe(402);
    const error = await errorOf(refused);
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toContain('100 images on the Free plan');
    // Since 2026-11-28 a Free account can buy the top-up, so the message offers it (checkout is open in the test bindings).
    expect(error.message).toContain(`to render new ones now, upgrade or buy a top-up at ${ORIGIN}/pricing.`);
    expect(error.details?.usage).toMatchObject({ plan: 'free', used: 100, remaining: 0, total_remaining: 0 });

    // While checkout is closed, as in production today, the message is the one from before: it names no top-up.
    const closed = await call(
      '/v1/images',
      { method: 'POST', headers: { ...bearer(secret), 'content-type': 'application/json' }, body: JSON.stringify(tiny('After the limit')) },
      { ...env, CHECKOUT_ENABLED: 'false' },
    );
    expect(closed.status).toBe(402);
    const closedError = await errorOf(closed);
    expect(closedError.message.endsWith(`Images that are already cached keep working; to render new ones now, upgrade at ${ORIGIN}/pricing.`)).toBe(true);
    expect(closedError.message).not.toContain('top-up');

    const stillThere: ImageJson = await (await postImage(secret, tiny('Before the limit'))).json();
    expect(stillThere).toMatchObject({ id: cachedBefore.id, cached: true });
    expect(await renderCount(user.id)).toBe(1);
  });

  it('refuses a suspended account with 403 and takes its stored images offline', async () => {
    const { user, secret } = await account();
    const before: ImageJson = await (await postImage(secret, tiny('Before suspension'))).json();
    expect((await call(pathOf(before.url))).status).toBe(200);

    await run(env.DB, 'UPDATE users SET suspended_at = ?1 WHERE id = ?2', Date.now(), user.id);
    const responses = [
      await postImage(secret, tiny('Suspended')),
      await postImage(secret, tiny('Before suspension')),
      await call('/v1/usage', { headers: bearer(secret) }),
      await call('/v1/templates', { headers: bearer(secret) }),
      await call(pathOf(before.url)),
      await call(pathOf(before.url), { headers: { 'if-none-match': `"${before.id}"` } }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('account_suspended');
    }
    expect(await renderCount(user.id)).toBe(1);
  });

  it('rate-limits by IP before looking at the key, and by key for renders', async () => {
    const { key, secret } = await account();
    const keysSeen = { ip: [] as string[], key: [] as string[] };
    const binding = (seen: string[], allow: boolean): RateLimitBinding => ({
      limit: ({ key: limited }) => {
        seen.push(limited);
        return Promise.resolve({ success: allow });
      },
    });
    const limited = (ipAllowed: boolean, keyAllowed: boolean): Env => ({
      ...env,
      RATE_LIMITS_DISABLED: '0',
      RL_IP: binding(keysSeen.ip, ipAllowed),
      RL_KEY: binding(keysSeen.key, keyAllowed),
    });
    const post = (headers: Record<string, string>, bindings: Env): Promise<Response> =>
      call(
        '/v1/images',
        { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.9', ...headers }, body: JSON.stringify(tiny('Rate limited')) },
        bindings,
      );

    const anonymous = await post({}, limited(false, true));
    expect(anonymous.status).toBe(429);
    expect(anonymous.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_IP.periodSeconds));
    expect(keysSeen).toEqual({ ip: ['198.51.100.9'], key: [] });

    const perKey = await post(bearer(secret), limited(true, false));
    expect(perKey.status).toBe(429);
    expect((await errorOf(perKey)).code).toBe('rate_limited');
    expect(keysSeen.key).toEqual([key.id]);

    expect((await post(bearer(secret), limited(true, true))).status).toBe(200);
    // Reading usage is limited per IP only.
    expect((await call('/v1/usage', { headers: bearer(secret) }, limited(true, false))).status).toBe(200);
  });
});

describe('GET /v1/usage and /v1/templates', () => {
  it('reports the usage of the current period with ISO dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2027, 4, 17, 8));
    const { user, secret } = await account('starter', Date.now());
    await setUsed(user, 12, Date.now());
    const response = await call('/v1/usage', { headers: bearer(secret) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      plan: 'starter',
      period_start: '2027-05-01T00:00:00.000Z',
      period_end: '2027-06-01T00:00:00.000Z',
      limit: PLANS.starter.monthlyImages,
      used: 12,
      remaining: PLANS.starter.monthlyImages - 12,
      topup_remaining: 0,
      total_remaining: PLANS.starter.monthlyImages - 12,
      cache_days: PLANS.starter.cacheDays,
      watermark: false,
    });
  });

  it('lists the starter templates with their fields, and only the caller\'s own custom templates', async () => {
    const owner = await account();
    const stranger = await account();
    const templateId = await createTemplate(await sessionCookieFor(owner.user.id));

    const response = await call('/v1/templates', { headers: bearer(owner.secret) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      starter: Array<{ id: string; name: string; description: string; fields: Array<Record<string, unknown>> } & Record<string, unknown>>;
      custom: Array<{ id: string; name: string; version: number; updated_at: string }>;
    };
    expect(body.starter.map((template) => template.id)).toEqual([...STARTER_TEMPLATE_IDS]);
    for (const template of body.starter) {
      expect(Object.keys(template).sort()).toEqual(['description', 'fields', 'id', 'name']);
      expect(template.fields.length).toBeGreaterThan(0);
      for (const field of template.fields) {
        expect(Object.keys(field).sort()).toEqual(['description', 'example', 'name', 'required']);
        expect(typeof field.required).toBe('boolean');
      }
    }
    expect(body.custom).toEqual([{ id: templateId, name: 'Test template', version: 1, updated_at: expect.stringMatching(/^\d{4}-.*Z$/) }]);

    const theirs = (await (await call('/v1/templates', { headers: bearer(stranger.secret) })).json()) as { custom: unknown[] };
    expect(theirs.custom).toEqual([]);
  });
});

describe('GET /i/{userId}/{cacheKey}.{ext}', () => {
  it('serves a stored image with cache headers, answers conditional and HEAD requests, and never counts', async () => {
    const { user, secret } = await account();
    const image: ImageJson = await (await postImage(secret, tiny('Stored'))).json();
    const path = pathOf(image.url);

    const served = await call(path);
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(served.headers.get('etag')).toBe(`"${image.id}"`);
    expect(served.headers.get('x-ltc-cache')).toBe('hit');
    expect(served.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    await served.arrayBuffer();

    for (const validator of [`"${image.id}"`, `W/"${image.id}"`, `"other", "${image.id}"`, '*']) {
      const conditional = await call(path, { headers: { 'if-none-match': validator } });
      expect(conditional.status, validator).toBe(304);
      expect(conditional.headers.get('etag')).toBe(`"${image.id}"`);
      expect(conditional.headers.get('content-type')).toBeNull();
    }
    expect((await call(path, { headers: { 'if-none-match': '"something-else"' } })).status).toBe(200);

    const head = await call(path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(image.bytes));
    expect((await bytesOf(head)).byteLength).toBe(0);
    expect((await usageOf(user.id)).used).toBe(1);
  });

  it('answers 404 for anything that is not a stored, unexpired image', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 5, 2, 10);
    vi.setSystemTime(start);
    const { user, secret } = await account('free', start);
    const image: ImageJson = await (await postImage(secret, tiny('Short lived'))).json();

    const missing = [
      `/i/${user.id}/${'0'.repeat(64)}.png`,
      `/i/${user.id}/${image.id}.jpg`,
      `/i/${user.id}/${image.id}`,
      `/i/${user.id}/not-a-key.png`,
      `/i/u_someone_else/${image.id}.png`,
      `/i/${user.id}`,
    ];
    for (const path of missing) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      expect((await errorOf(response)).code, path).toBe('not_found');
    }

    vi.setSystemTime(start + PLANS.free.cacheDays * DAY_MS - 1000);
    const lastSecond = await call(pathOf(image.url));
    expect(lastSecond.status).toBe(200);
    expect(lastSecond.headers.get('cache-control')).toBe('public, max-age=1');
    await lastSecond.arrayBuffer();

    vi.setSystemTime(start + PLANS.free.cacheDays * DAY_MS);
    const expired = await call(pathOf(image.url));
    expect(expired.status).toBe(404);
    expect((await errorOf(expired)).message).toContain('expired');
  });
});

describe('the app shell', () => {
  it('answers /healthz', async () => {
    const response = await call('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('answers unknown Worker paths and wrong methods with the JSON 404', async () => {
    const { secret } = await account();
    const requests: Array<[string, RequestInit]> = [
      ['/v1/nope', {}],
      ['/v1/images', { headers: bearer(secret) }],
      ['/v1/usage', { method: 'DELETE', headers: bearer(secret) }],
      ['/api/nope', {}],
      ['/auth/nope', {}],
      ['/webhooks/stripe', { method: 'POST' }],
      ['/playground/card.gif', {}],
      ['/healthz', { method: 'POST' }],
    ];
    for (const [path, init] of requests) {
      const response = await call(path, init);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toContain('application/json');
      expect(response.headers.get('cache-control'), path).toBe('no-store');
      expect(response.headers.get('x-request-id'), path).toBeTruthy();
      expect((await errorOf(response)).code, path).toBe('not_found');
    }
  });

  it('hands a page path that reaches the Worker to static assets', async () => {
    const response = await call('/a-page-that-does-not-exist');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('application/json');
  });

  it('maps an unexpected failure to a 500 that says nothing about its cause', async () => {
    const { secret } = await account();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error('D1 exploded: secret detail');
        },
      } as unknown as D1Database,
    };
    const response = await call('/v1/usage', { headers: bearer(secret) }, broken);
    expect(response.status).toBe(500);
    const error = await errorOf(response);
    expect(error.code).toBe('internal_error');
    expect(JSON.stringify(error)).not.toContain('secret detail');
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain(response.headers.get('x-request-id'));
  });

  it('lets Paddle webhooks through untouched: no session, no Origin rule, no content-type rule, raw body intact', async () => {
    const raw = `{ "event_id": "evt_shell_${Date.now()}",\n  "event_type": "transaction.paid", "occurred_at": "${new Date().toISOString()}", "data": {} }`;
    const response = await call('/webhooks/paddle', {
      method: 'POST',
      headers: { origin: 'https://paddle.com', 'content-type': 'text/plain', 'paddle-signature': await paddleSignature(raw) },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: 'ignored:unhandled' });
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect((await postWebhook(raw, null)).status).toBe(401);
  });
});
