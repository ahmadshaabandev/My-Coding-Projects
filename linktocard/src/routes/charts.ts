/**
 * Chart images: a chart described as JSON, drawn as an image (src/charts). Three ways in, one
 * renderer. All of them answer 503 not_configured unless CHARTS_ENABLED is "true".
 *
 *   GET, HEAD /v1/chart/{siteId}.{png|jpg|jpeg|webp}?c=<chart JSON>&sig=<hex>     (chartUrlRouter)
 *     The signed URL for an <img>. Public, authenticated by the HMAC signature alone, signed with
 *     the site's secret by the recipe of card URLs (src/charts/url.ts). Nothing but c and sig is
 *     accepted. The signature is verified before the chart JSON is parsed or anything is drawn.
 *     HEAD never renders and never charges, by the rules of /v1/og. Responses carry x-ltc-cache,
 *     x-ltc-credits-used (1 for the request that was charged, else 0), an ETag and a
 *     Cache-Control that email clients' image proxies can keep (CHARTS.maxAgeSeconds at most,
 *     never past the stored copy's expiry).
 *
 *   POST /v1/charts                                                               (chartsApiRouter)
 *     API key. Body: the chart JSON plus optional "format" (png, jpeg or webp; png by default).
 *     Answers like POST /v1/images: { id, url, width, height, format, bytes, cached,
 *     credits_used, created_at, expires_at, warnings, usage }. Same rate limits (RL_IP, RL_KEY).
 *
 *   POST /api/tools/chart                                                         (chartToolRouter)
 *     The free chart maker pages. Body: the chart JSON. Answers the PNG bytes. No account, not
 *     counted, nothing stored (no R2 object, no D1 row), always with the Free corner mark.
 *     Same-origin like the other free tools that take a body; RL_PLAYGROUND per client, counted
 *     apart from the homepage playground.
 *
 * Charging (signed URL and API): a chart is charged 1 image the first time it is drawn and then
 * never again while its charge is remembered; see src/charts/service.ts.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { requireApiKey, requireSameOrigin } from '../auth/middleware';
import { CHARTS, EXTENSION_TO_FORMAT } from '../config';
import { first, getUserById } from '../db/client';
import { assertChartFormat, renderChart } from '../charts/render';
import { chartIsPaid, chartKeys, chartRenderDeps, getChart, type ChartRequest } from '../charts/service';
import { parseChart, parseChartJson } from '../charts/spec';
import { describeChartUrlFailure, parseChartPath, verifyChartUrl } from '../charts/url';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled } from '../lib/features';
import { backgroundFor, etagFor, imageHeaders, iso, matchesEtag, notModified, readJsonObject, usageJson } from '../lib/http';
import { findStoredCard, imageUrl, parseFormat, quotaExceededError, storedImageHeaders, warningsHeader, type StoredImage } from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { deriveSiteSecret } from '../lib/signed-url';
import type { AppEnv, SiteRow } from '../types';
import { edgeCacheMatch, fromEdgeCache } from './og';

export const chartUrlRouter = new Hono<AppEnv>();
export const chartsApiRouter = new Hono<AppEnv>();
export const chartToolRouter = new Hono<AppEnv>();

/** The kill switch comes first on every chart path and method: before the caches, the limits and the body. */
const chartsEnabledOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertFeatureEnabled(c.env, 'charts');
  await next();
};

chartUrlRouter.use('*', chartsEnabledOnly);
chartsApiRouter.use('*', chartsEnabledOnly);
// This router shares /api/tools with the other free tools: only its own path is switched.
chartToolRouter.use('/chart', chartsEnabledOnly);
chartToolRouter.use('/chart/*', chartsEnabledOnly);

/* ------------------------------------------------------------------ */
/* Signed URL                                                          */
/* ------------------------------------------------------------------ */

/** Headers of a chart served from its signed URL. */
function chartHeaders(image: StoredImage, cache: 'hit' | 'miss', now: number, creditsUsed: number): Headers {
  const headers = storedImageHeaders(image, cache, now);
  // The same chart JSON always gives the same picture, so a mail proxy may keep it as long as the stored copy lives.
  headers.set('cache-control', `public, max-age=${Math.max(0, Math.min(CHARTS.maxAgeSeconds, Math.floor((image.expiresAt - now) / 1000)))}`);
  headers.set('x-ltc-credits-used', String(creditsUsed));
  return headers;
}

chartUrlRouter.get('/*', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const edge = await edgeCacheMatch(url.href);
  if (edge) return fromEdgeCache(request, edge);

  const path = parseChartPath(url.pathname);
  if (!path) throw new ApiError('not_found', 'Not found. Signed chart URLs look like /v1/chart/{site id}.png?c=...&sig=...');
  await enforceRateLimit(c.env, 'RL_IP', clientIp(request));

  const site = await first<SiteRow>(c.env.DB, 'SELECT * FROM sites WHERE id = ?1 AND deleted_at IS NULL', path.siteId);
  const owner = site ? await getUserById(c.env.DB, site.user_id) : null;
  if (!site || !owner) throw new ApiError('not_found', 'Site not found. Check the site id in the URL.');

  // The signature first: an unsigned or altered URL is refused before its chart JSON is even parsed.
  const secret = await deriveSiteSecret(c.env.SIGNING_MASTER_SECRET, site.id, site.secret_version);
  const verified = await verifyChartUrl(url, secret);
  if (!verified.ok) {
    throw new ApiError('invalid_signature', describeChartUrlFailure(verified.reason), { details: { reason: verified.reason } });
  }
  if (owner.suspended_at !== null) {
    throw new ApiError('account_suspended', `This account is suspended. Contact ${c.env.SUPPORT_EMAIL}.`);
  }

  const chart = parseChartJson(verified.chartJson);
  const format = EXTENSION_TO_FORMAT[path.ext]!;
  assertChartFormat(chart, format);
  const chartRequest: ChartRequest = { user: owner, chart, format, source: 'og', siteId: site.id, renderRateLimitKey: site.id };
  const now = Date.now();
  const keys = await chartKeys(chartRequest);
  const etag = etagFor(keys.cacheKey);
  const conditional = matchesEtag(request, etag);

  if (request.method === 'HEAD') {
    // HEAD never renders and never charges: it answers from the stored copy, or says what a GET would most likely say.
    const stored = await findStoredCard(c.env, chartRequest, keys.cacheKey, now, false);
    if (stored) {
      const headers = chartHeaders(stored.image, 'hit', now, 0);
      headers.set('content-length', String(stored.image.bytes));
      return new Response(null, { headers });
    }
    // A chart that was charged before is drawn again for free: a GET would answer 200 even with no images left.
    if (!(await chartIsPaid(c.env.DB, owner.id, keys, now))) {
      const usage = await getUsage(c.env.DB, owner, now);
      if (usage.total_remaining <= 0) throw quotaExceededError(c.env, usage);
    }
    const headers = imageHeaders({ format, etag, cacheControl: 'no-store', cache: 'miss' });
    headers.set('x-ltc-credits-used', '0');
    return new Response(null, { headers });
  }

  const background = backgroundFor(c);
  const result = await getChart(c.env, background, chartRequest, { now, keys, withBody: !conditional });
  const headers = chartHeaders(result.image, result.cached ? 'hit' : 'miss', now, result.creditsUsed);
  if (result.cached && conditional) return notModified(headers);

  const response = new Response(result.body, { headers });
  if (!headers.get('cache-control')!.endsWith('max-age=0')) {
    // The copy at the edge answers repeat requests for this exact URL without reaching R2 or D1.
    const copyHeaders = new Headers(headers);
    copyHeaders.set('x-ltc-cache', 'hit');
    copyHeaders.set('x-ltc-credits-used', '0');
    const copy = new Response(response.clone().body, { headers: copyHeaders });
    background(Promise.resolve().then(() => caches.default.put(url.href, copy)));
  }
  return response;
});

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

chartsApiRouter.use('*', async (c, next) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  await next();
});

chartsApiRouter.post('/', requireApiKey, async (c) => {
  const user = c.var.user;
  await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? user.id);

  const body = await readJsonObject(c.req.raw, CHARTS.maxJsonBytes);
  const chart = parseChart(body, ['format']);
  const format = parseFormat(body.format);
  assertChartFormat(chart, format);

  const now = Date.now();
  const card = await getChart(c.env, backgroundFor(c), { user, chart, format, source: 'api', siteId: null }, { now, withBody: false });
  const { image } = card;
  return c.json({
    id: image.cacheKey,
    url: imageUrl(c.env, user.id, image.cacheKey, image.format),
    width: image.width,
    height: image.height,
    format: image.format,
    bytes: image.bytes,
    cached: card.cached,
    credits_used: card.creditsUsed,
    created_at: iso(image.createdAt),
    expires_at: iso(image.expiresAt),
    warnings: card.warnings,
    usage: usageJson(card.usage ?? (await getUsage(c.env.DB, user, now))),
  });
});

/* ------------------------------------------------------------------ */
/* The free chart maker                                                */
/* ------------------------------------------------------------------ */

chartToolRouter.post('/chart', requireSameOrigin, async (c) => {
  const request = c.req.raw;
  // Its own counter in the playground's limiter: previews here do not use up the homepage playground's.
  await enforceRateLimit(c.env, 'RL_PLAYGROUND', `chart:${clientIp(request)}`);

  const chart = parseChart(await readJsonObject(request, CHARTS.maxJsonBytes));
  // Drawn and returned: no account, no ledger row, no stored copy. Always the Free corner mark.
  const output = await renderChart(chart, { format: 'png', mark: 'free' }, chartRenderDeps(c.env));
  return new Response(output.bytes, {
    headers: {
      'content-type': output.contentType,
      'content-length': String(output.bytes.byteLength),
      'cache-control': 'no-store',
      'x-ltc-warnings': warningsHeader(output.warnings),
    },
  });
});
