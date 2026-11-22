// The homepage playground (GET /playground/card.png) through the real app.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, HTTP_CACHE, RATE_LIMITS } from '../src/config';
import { first } from '../src/db/client';
import { STARTER_TEMPLATE_IDS } from '../src/render/templates';
import type { Env, RateLimitBinding } from '../src/types';
import { bytesOf, call, errorOf, isPng, pngDimensions } from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const r2KeyOf = (response: Response): string => `p/${(response.headers.get('etag') ?? '').replaceAll('"', '')}.png`;

async function countRows(table: 'renders' | 'usage_periods'): Promise<number> {
  return (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
}

describe('GET /playground/card.png', () => {
  it('renders every starter template as a 1200x630 PNG without touching any account', async () => {
    for (const template of STARTER_TEMPLATE_IDS) {
      const response = await call(`/playground/card.png?template=${template}&title=Playground%20${template}&theme=dark`);
      expect(response.status, template).toBe(200);
      expect(response.headers.get('content-type'), template).toBe('image/png');
      const bytes = await bytesOf(response);
      expect(isPng(bytes), template).toBe(true);
      expect(pngDimensions(bytes), template).toEqual({ width: 1200, height: 630 });
    }
    expect(await countRows('renders')).toBe(0);
    expect(await countRows('usage_periods')).toBe(0);
  });

  it('caches identical requests in R2 for a day and tells browsers to cache for an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 3, 5, 12);
    vi.setSystemTime(start);
    const path = '/playground/card.png?title=Cached%20playground%20card&author=Ahmad';

    const fresh = await call(path);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('x-ltc-cache')).toBe('miss');
    expect(fresh.headers.get('cache-control')).toBe(`public, max-age=${HTTP_CACHE.playgroundMaxAgeSeconds}`);
    expect(fresh.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    const etag = fresh.headers.get('etag')!;
    const bytes = await bytesOf(fresh);
    expect((await env.BUCKET.head(r2KeyOf(fresh)))?.customMetadata?.createdAt).toBe(String(start));

    // Parameter order and unknown parameters do not make another card.
    vi.setSystemTime(start + DAY_MS - 1000);
    const again = await call('/playground/card.png?author=Ahmad&utm_source=x&title=Cached%20playground%20card');
    expect(again.headers.get('x-ltc-cache')).toBe('hit');
    expect(again.headers.get('etag')).toBe(etag);
    expect(await bytesOf(again)).toEqual(bytes);

    const conditional = await call(path, { headers: { 'if-none-match': etag } });
    expect(conditional.status).toBe(304);

    const head = await call(path, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect((await bytesOf(head)).byteLength).toBe(0);

    // A day later the stored copy is stale: rendered again and stamped anew.
    vi.setSystemTime(start + DAY_MS);
    const stale = await call(path);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('x-ltc-cache')).toBe('miss');
    expect((await env.BUCKET.head(r2KeyOf(stale)))?.customMetadata?.createdAt).toBe(String(start + DAY_MS));
  });

  it('reads only its four text fields and never fetches anything', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('the playground must not fetch'));
    const plain = await call('/playground/card.png?title=No%20fetching');
    const loaded = await call(
      '/playground/card.png?title=No%20fetching&image=http%3A%2F%2F127.0.0.1%2Fx.png&logo=https%3A%2F%2Fexample.org%2Fa.png&html=%3Cimg%20src%3Dx%3E',
    );
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get('x-ltc-cache')).toBe('hit');
    expect(loaded.headers.get('etag')).toBe(plain.headers.get('etag'));
    expect(outbound).not.toHaveBeenCalled();
  });

  it('rejects unknown templates, long values and unknown themes with the JSON error', async () => {
    const rejected: Array<[string, string]> = [
      ['template=nope', '"template" must be one of: blog, dark, quote, launch, docs'],
      ['template=t_custom0000000000', '"template" must be one of'],
      [`title=${'x'.repeat(121)}`, '"title" can be at most 120 characters'],
      [`description=${'x'.repeat(201)}`, '"description" can be at most 200 characters'],
      [`author=${'x'.repeat(61)}`, '"author" can be at most 60 characters'],
      ['theme=blue', '"theme" must be light or dark'],
    ];
    for (const [query, fragment] of rejected) {
      const response = await call(`/playground/card.png?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type'), query).toContain('application/json');
      const error = await errorOf(response);
      expect(error.code, query).toBe('invalid_request');
      expect(error.message, query).toContain(fragment);
    }
    // Limits count characters, not UTF-16 units.
    const astral = encodeURIComponent('\u{1D49C}'.repeat(60));
    expect((await call(`/playground/card.png?author=${astral}`)).status).toBe(200);
  });

  it('does not render for HEAD and is rate-limited per IP only when a render is needed', async () => {
    const path = '/playground/card.png?title=Rate%20limited%20playground';
    const cold = await call(path, { method: 'HEAD' });
    expect(cold.status).toBe(200);
    expect(cold.headers.get('content-type')).toBe('image/png');
    expect(cold.headers.get('cache-control')).toBe('no-store');
    expect(await env.BUCKET.head(r2KeyOf(cold))).toBeNull();

    const keys: string[] = [];
    const deny: RateLimitBinding = {
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    };
    const limited: Env = { ...env, RATE_LIMITS_DISABLED: '0', RL_PLAYGROUND: deny };
    const headers = { 'cf-connecting-ip': '203.0.113.77' };

    const refused = await call(path, { headers }, limited);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_PLAYGROUND.periodSeconds));
    expect(keys).toEqual(['203.0.113.77']);

    expect((await call(path)).status).toBe(200);
    const cached = await call(path, { headers }, limited);
    expect(cached.status).toBe(200);
    expect(cached.headers.get('x-ltc-cache')).toBe('hit');
    expect(keys).toHaveLength(1);
  });
});
