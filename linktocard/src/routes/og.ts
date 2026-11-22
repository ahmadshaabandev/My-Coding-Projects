/**
 * GET /v1/og/{siteId}/{template}.{png|jpg|jpeg|webp}?<data>&size=&sig=
 *
 * The signed URL a customer pastes into <meta property="og:image">. Public,
 * authenticated by the HMAC signature alone. Mounted before the API-key
 * routes, which share the /v1 prefix.
 *
 * HEAD never renders and never charges: it answers from the caches when the
 * card exists, and otherwise says what a GET would most likely say (200 with
 * the image type, or 402 when the allowance is used up) without a length.
 */
import { Hono } from 'hono';
import { EXTENSION_TO_FORMAT } from '../config';
import { first, getUserById } from '../db/client';
import { ApiError } from '../lib/errors';
import { backgroundFor, etagFor, imageHeaders, matchesEtag, notModified } from '../lib/http';
import {
  cardCacheKey,
  findStoredCard,
  getCard,
  parseSize,
  quotaExceededError,
  resolveTemplate,
  storedImageHeaders,
  templateNotFound,
  type CardRequest,
} from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { SIZE_PARAM, deriveSiteSecret, describeSignedUrlFailure, parseOgPath, verifySignedUrl } from '../lib/signed-url';
import type { AppEnv, Env, SiteRow } from '../types';

export const ogRouter = new Hono<AppEnv>();

/** The edge cache is an optimisation: when it is unavailable the request simply continues. */
async function edgeCacheMatch(url: string): Promise<Response | undefined> {
  try {
    return await caches.default.match(url);
  } catch {
    return undefined;
  }
}

function fromEdgeCache(request: Request, cached: Response): Response {
  const etag = cached.headers.get('etag');
  return etag !== null && matchesEtag(request, etag) ? notModified(cached.headers) : cached;
}

async function cardRequestFor(env: Env, url: URL, request: Request): Promise<CardRequest> {
  const path = parseOgPath(url.pathname);
  if (!path) throw new ApiError('not_found', 'Not found. Signed card URLs look like /v1/og/{site id}/{template}.png?...&sig=...');
  await enforceRateLimit(env, 'RL_IP', clientIp(request));

  const site = await first<SiteRow>(env.DB, 'SELECT * FROM sites WHERE id = ?1 AND deleted_at IS NULL', path.siteId);
  const owner = site ? await getUserById(env.DB, site.user_id) : null;
  if (!site || !owner) throw new ApiError('not_found', 'Site not found. Check the site id in the URL.');

  const verified = await verifySignedUrl(url, await deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version));
  if (!verified.ok) {
    throw new ApiError('invalid_signature', describeSignedUrlFailure(verified.reason), { details: { reason: verified.reason } });
  }
  if (owner.suspended_at !== null) {
    throw new ApiError('account_suspended', `This account is suspended. Contact ${env.SUPPORT_EMAIL}.`);
  }

  const { [SIZE_PARAM]: sizeParam, ...data } = verified.params;
  const size = parseSize(sizeParam);
  const template = await resolveTemplate(env.DB, owner.id, path.template);
  if (!template) throw templateNotFound();
  return {
    user: owner,
    template,
    data,
    size,
    format: EXTENSION_TO_FORMAT[path.ext]!,
    source: 'og',
    siteId: site.id,
    renderRateLimitKey: site.id,
  };
}

ogRouter.get('/*', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const edge = await edgeCacheMatch(url.href);
  if (edge) return fromEdgeCache(request, edge);

  const card = await cardRequestFor(c.env, url, request);
  const now = Date.now();
  const cacheKey = await cardCacheKey(card);
  const etag = etagFor(cacheKey);
  const conditional = matchesEtag(request, etag);

  if (request.method === 'HEAD') {
    const stored = await findStoredCard(c.env, card, cacheKey, now, false);
    if (stored) {
      const headers = storedImageHeaders(stored.image, 'hit', now);
      headers.set('content-length', String(stored.image.bytes));
      return new Response(null, { headers });
    }
    const usage = await getUsage(c.env.DB, card.user, now);
    if (usage.total_remaining <= 0) throw quotaExceededError(c.env, usage);
    return new Response(null, { headers: imageHeaders({ format: card.format, etag, cacheControl: 'no-store', cache: 'miss' }) });
  }

  const background = backgroundFor(c);
  const result = await getCard(c.env, background, card, { now, cacheKey, withBody: !conditional });
  const headers = storedImageHeaders(result.image, result.cached ? 'hit' : 'miss', now);
  if (result.cached && conditional) return notModified(headers);

  const response = new Response(result.body, { headers });
  if (!headers.get('cache-control')!.endsWith('max-age=0')) {
    // The copy at the edge answers repeat requests for this exact URL without reaching R2 or D1.
    const copyHeaders = new Headers(headers);
    copyHeaders.set('x-ltc-cache', 'hit');
    const copy = new Response(response.clone().body, { headers: copyHeaders });
    background(Promise.resolve().then(() => caches.default.put(url.href, copy)));
  }
  return response;
});
