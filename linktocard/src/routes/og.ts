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
 *
 * Open fields (src/lib/open-fields.ts, EMAIL_FIELDS_ENABLED): a URL with "open"
 * is verified without the listed fields' values, which an email platform fills
 * in per recipient. A render with open fields that is not in the cache takes
 * the image's slot among the site's unique renders of the UTC day, or shares it
 * with the other requests for the same image (the cap counts images, not
 * requests); once the day's slots are held by other images, the card is served
 * with every open field at its default instead (one cached card), so an email
 * that was already sent never shows a broken image.
 *
 * Charge once: such a card is charged 1 image the first time it is rendered and
 * never again while its charge is remembered (EMAIL_FIELDS.chargeMemoryDays): a
 * copy whose stored period ended is rendered and stored again for free (and
 * still takes one of the day's unique renders). Responses for these URLs carry
 * x-ltc-credits-used (1 for the request that was charged, else 0) next to
 * x-ltc-cache.
 *
 * A starter template answers 400 for a size it is not laid out for (the social
 * starters at the email size), however the URL was signed.
 */
import { Hono } from 'hono';
import { EXTENSION_TO_FORMAT } from '../config';
import { first, getUserById } from '../db/client';
import { ApiError } from '../lib/errors';
import { featureEnabled } from '../lib/features';
import { backgroundFor, etagFor, imageHeaders, matchesEtag, notModified } from '../lib/http';
import {
  assertTemplateSize,
  cardCacheKey,
  findStoredCard,
  getCard,
  parseSize,
  quotaExceededError,
  resolveTemplate,
  storedImageHeaders,
  templateNotFound,
  templateOptions,
  type CardRequest,
} from '../lib/images';
import {
  asOpenFieldsResult,
  describeOpenFieldsFailure,
  hasEmailCharge,
  keepTemplateOpenFields,
  openFieldsCacheControl,
  reserveOpenFieldRender,
  templateFields,
  verifyWithOpenFields,
  type OpenRenderReservation,
} from '../lib/open-fields';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { SIZE_PARAM, deriveSiteSecret, parseOgPath, verifySignedUrl } from '../lib/signed-url';
import type { AppEnv, Env, SiteRow, TemplateData } from '../types';

export const ogRouter = new Hono<AppEnv>();

/** The edge cache is an optimisation: when it is unavailable the request simply continues. Signed chart URLs use it too (src/routes/charts.ts). */
export async function edgeCacheMatch(url: string): Promise<Response | undefined> {
  try {
    return await caches.default.match(url);
  } catch {
    return undefined;
  }
}

export function fromEdgeCache(request: Request, cached: Response): Response {
  const etag = cached.headers.get('etag');
  return etag !== null && matchesEtag(request, etag) ? notModified(cached.headers) : cached;
}

interface OgCard {
  card: CardRequest;
  /** Open fields of the URL that are fields of its template; empty without "open". */
  openFields: string[];
  /** The card's data with every open field at its default. */
  fallbackData: TemplateData;
}

async function cardRequestFor(env: Env, url: URL, request: Request): Promise<OgCard> {
  const path = parseOgPath(url.pathname);
  if (!path) throw new ApiError('not_found', 'Not found. Signed card URLs look like /v1/og/{site id}/{template}.png?...&sig=...');
  await enforceRateLimit(env, 'RL_IP', clientIp(request));

  const site = await first<SiteRow>(env.DB, 'SELECT * FROM sites WHERE id = ?1 AND deleted_at IS NULL', path.siteId);
  const owner = site ? await getUserById(env.DB, site.user_id) : null;
  if (!site || !owner) throw new ApiError('not_found', 'Site not found. Check the site id in the URL.');

  const secret = await deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version);
  // Kill switch: while open fields are off, "open" is ordinary signed data, exactly as before.
  const verified = featureEnabled(env, 'emailfields') ? await verifyWithOpenFields(url, secret) : asOpenFieldsResult(await verifySignedUrl(url, secret));
  if (!verified.ok) {
    throw new ApiError('invalid_signature', describeOpenFieldsFailure(verified.reason), { details: { reason: verified.reason } });
  }
  if (owner.suspended_at !== null) {
    throw new ApiError('account_suspended', `This account is suspended. Contact ${env.SUPPORT_EMAIL}.`);
  }

  const size = parseSize(verified.params[SIZE_PARAM]);
  const template = await resolveTemplate(env.DB, owner.id, path.template, templateOptions(env));
  if (!template) throw templateNotFound();
  assertTemplateSize(template, size, templateOptions(env));
  // Open fields the template does not have are dropped, so their values cannot vary the cache key.
  const open = verified.openFields.length > 0 ? keepTemplateOpenFields(verified, templateFields(template)) : verified;
  const { [SIZE_PARAM]: _size, ...data } = open.params;
  const { [SIZE_PARAM]: _fallbackSize, ...fallbackData } = open.fallbackParams;
  return {
    card: {
      user: owner,
      template,
      data,
      size,
      format: EXTENSION_TO_FORMAT[path.ext]!,
      source: 'og',
      siteId: site.id,
      renderRateLimitKey: site.id,
      // Charged once (the default card served past the daily cap included): see the module comment.
      ...(open.openFields.length > 0 ? { chargeOnce: true } : {}),
    },
    openFields: open.openFields,
    fallbackData,
  };
}

ogRouter.get('/*', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const edge = await edgeCacheMatch(url.href);
  if (edge) return fromEdgeCache(request, edge);

  const og = await cardRequestFor(c.env, url, request);
  let card = og.card;
  const now = Date.now();
  let cacheKey = await cardCacheKey(card);
  const personalised = og.openFields.length > 0;
  // A personalised render that is not cached takes (or shares) the image's slot among the site's unique renders of the day.
  let reservation: OpenRenderReservation | null = null;
  let capped = false;
  if (personalised && request.method !== 'HEAD' && !(await findStoredCard(c.env, card, cacheKey, now, false))) {
    reservation = await reserveOpenFieldRender(c.env, card.siteId!, cacheKey, card.user, now);
    if (!reservation.allowed) {
      card = { ...card, data: og.fallbackData };
      cacheKey = await cardCacheKey(card);
      capped = true;
    }
  }
  const etag = etagFor(cacheKey);
  const conditional = matchesEtag(request, etag);

  if (request.method === 'HEAD') {
    const stored = await findStoredCard(c.env, card, cacheKey, now, false);
    if (stored) {
      const headers = storedImageHeaders(stored.image, 'hit', now);
      if (personalised) {
        headers.set('cache-control', openFieldsCacheControl(stored.image.expiresAt, now));
        headers.set('x-ltc-credits-used', '0');
      }
      headers.set('content-length', String(stored.image.bytes));
      return new Response(null, { headers });
    }
    // An email image that was charged before renders again for free: a GET would answer 200 even with no images left.
    if (!(personalised && (await hasEmailCharge(c.env.DB, card.user.id, cacheKey, now)))) {
      const usage = await getUsage(c.env.DB, card.user, now);
      if (usage.total_remaining <= 0) throw quotaExceededError(c.env, usage);
    }
    const headers = imageHeaders({ format: card.format, etag, cacheControl: 'no-store', cache: 'miss' });
    // HEAD never renders and never charges.
    if (personalised) headers.set('x-ltc-credits-used', '0');
    return new Response(null, { headers });
  }

  const background = backgroundFor(c);
  let result: Awaited<ReturnType<typeof getCard>>;
  try {
    result = await getCard(c.env, background, card, { now, cacheKey, withBody: !conditional });
  } catch (error) {
    await reservation?.release();
    throw error;
  }
  // This request rendered nothing (another request stored the image first): its hold on the image's
  // slot is given back, and the slot stays taken while a request that rendered the image holds it.
  // Every request that rendered keeps its hold: charged, rendered again for free after expiry, or a
  // duplicate of an image the ledger already covered (one image, one slot, however often rendered).
  if (reservation?.allowed && result.outcome === 'cached') await reservation.release();
  const headers = storedImageHeaders(result.image, result.cached ? 'hit' : 'miss', now);
  if (personalised) {
    // The default card served past the cap must not stay in a mail proxy as this recipient's image.
    headers.set('cache-control', capped ? 'no-store, max-age=0' : openFieldsCacheControl(result.image.expiresAt, now));
    headers.set('x-ltc-credits-used', String(result.creditsUsed));
    if (capped) headers.set('x-ltc-open-fields', 'daily-limit');
  }
  if (result.cached && conditional) return notModified(headers);

  const response = new Response(result.body, { headers });
  if (!headers.get('cache-control')!.endsWith('max-age=0')) {
    // The copy at the edge answers repeat requests for this exact URL without reaching R2 or D1.
    const copyHeaders = new Headers(headers);
    copyHeaders.set('x-ltc-cache', 'hit');
    if (personalised) copyHeaders.set('x-ltc-credits-used', '0');
    const copy = new Response(response.clone().body, { headers: copyHeaders });
    background(Promise.resolve().then(() => caches.default.put(url.href, copy)));
  }
  return response;
});
