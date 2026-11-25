/**
 * Free tools under /api/tools (public: no session, no cookie):
 *
 *   GET /api/tools/og-check?url=...[&turnstile=...]   check a page's link-preview tags
 *   GET /api/tools/og-check/{id}/image                 the image recorded in that result
 *   GET /api/tools/og-check/{id}/favicon               the favicon recorded in that result
 *
 * The two image routes never take a URL: they fetch only what the (unexpired) result
 * recorded, through the same guarded fetcher, so the page can show remote images while
 * the site CSP keeps img-src 'self'. They 404 once the result has expired.
 */
import { Hono } from 'hono';
import { INSPECT } from '../config';
import { ApiError } from '../lib/errors';
import { clientIp } from '../lib/rate-limit';
import { defaultInspectDeps, inspectUrl, liveCheck, normaliseInputUrl } from '../inspect/check';
import { defaultFetchDeps, discard, FetchFailure, type OwnSite, guardedFetch, mediaType, pageFetchError, readBody, withBudget } from '../inspect/fetch';
import { enforceProxyLimit, enforcePublicLimit } from '../inspect/limits';
import type { AppEnv } from '../types';

export const toolsRouter = new Hono<AppEnv>();

toolsRouter.get('/og-check', async (c) => {
  const input = normaliseInputUrl(c.req.query('url'));
  const request = c.req.raw;
  const remoteIp = request.headers.get('cf-connecting-ip');
  const result = await inspectUrl(
    c.env.DB,
    input,
    () => enforcePublicLimit(c.env, clientIp(request), remoteIp, c.req.query('turnstile') ?? null, Date.now()),
    defaultInspectDeps(c.env),
  );
  return c.json(result);
});

/** SVG could carry script when opened directly; only raster types are passed through. */
const PROXY_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp',
];

async function proxyRecorded(target: string, own: OwnSite): Promise<Response> {
  const deps = defaultFetchDeps(own);
  const maxBytes = INSPECT.proxyMaxBytes;
  const { bytes, type } = await withBudget(
    INSPECT.proxyTimeoutMs,
    async (signal) => {
      const { response } = await guardedFetch(
        target,
        { method: 'GET', accept: 'image/*', httpsOnly: false, maxRedirects: INSPECT.maxRedirects, signal },
        deps,
      );
      if (!response.ok) {
        await discard(response);
        throw new FetchFailure('http_error', `It answered HTTP ${response.status}.`, response.status);
      }
      const contentType = mediaType(response.headers.get('content-type'));
      if (!contentType || !PROXY_TYPES.includes(contentType)) {
        await discard(response);
        throw new FetchFailure('not_image', `It is served as ${contentType ?? 'an unknown type'}, not as a PNG, JPEG, GIF, WebP, AVIF or ICO image.`);
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (declared > maxBytes) {
        await discard(response);
        throw new FetchFailure('too_large', `It is larger than ${maxBytes / (1024 * 1024)} MB.`);
      }
      const read = await readBody(response, { maxBytes });
      if (read.overCap) throw new FetchFailure('too_large', `It is larger than ${maxBytes / (1024 * 1024)} MB.`);
      return { bytes: read.kept, type: contentType };
    },
    () => new FetchFailure('timeout', `It did not load within ${INSPECT.proxyTimeoutMs / 1000} s.`),
  ).catch((error: unknown) => {
    throw error instanceof FetchFailure ? pageFetchError(error, 'image') : error;
  });
  return new Response(bytes, {
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      'cache-control': 'public, max-age=600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

for (const kind of ['image', 'favicon'] as const) {
  toolsRouter.get(`/og-check/:id/${kind}`, async (c) => {
    const row = await liveCheck(c.env.DB, c.req.param('id'), Date.now());
    const target = kind === 'image' ? row?.image_url : row?.favicon_url;
    if (!row || !target) throw new ApiError('not_found', `No ${kind} for this check. Results expire after ${INSPECT.cacheTtlMs / 60_000} minutes; run the check again.`);
    await enforceProxyLimit(c.env, clientIp(c.req.raw), Date.now());
    return proxyRecorded(target, c.env);
  });
}
