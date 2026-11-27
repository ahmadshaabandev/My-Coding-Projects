/**
 * GET /v1/link/{siteId}/{template}.{png|jpg|jpeg|webp}?url=<page>&<data>&size=&sig=
 *
 * A signed card made from a page's own metadata: the og:image a customer can put on a page
 * (or anywhere) without writing the card's text into the URL. Public, authenticated by the
 * HMAC signature alone (src/cards/link-url.ts, the same scheme as /v1/og), and mounted
 * before the API-key routes, which share the /v1 prefix. Answers 503 not_configured unless
 * LINK_CARDS_ENABLED is "true".
 *
 * Any public https page can be named (the OG checker's rules decide: https only, no private
 * or blocked hosts, 5 s, 2 MB, 3 redirects). What protects the owner's units and the pages:
 *
 *   - per IP: RL_IP, like every /v1 request;
 *   - per site: the plan's daily page checks (INSPECT.dailyInspectionsByPlan, counted per
 *     site; cached checks are free) and RL_KEY on renders, shared with the site's /v1/og URLs;
 *   - per link: an R2 pointer (src/cards/service.ts) answers without reading the page until
 *     the link is due for a refresh, and keeps serving the last card if the page cannot be
 *     read then; a failed refresh is retried after INSPECT.cacheTtlMs, not on every request.
 *
 * Every new card costs 1 image unit (source "og", the site's id in the ledger), exactly like
 * an uncached /v1/og render; a card that is already stored costs nothing. HEAD never reads
 * the page, never renders and never charges.
 */
import { Hono } from 'hono';
import { EXTENSION_TO_FORMAT, INSPECT, type ImageFormat, type SizePreset } from '../config';
import { describeLinkUrlFailure, linkCanonical, parseLinkPath, verifyLinkUrl } from '../cards/link-url';
import {
  enforceSiteInspectLimit,
  linkPointerKey,
  pointerIsFresh,
  readLinkPointer,
  renderLinkCard,
  writeLinkPointer,
  type LinkCardSettings,
  type LinkPointer,
} from '../cards/service';
import { first, getUserById } from '../db/client';
import { defaultInspectDeps, inspectUrl } from '../inspect/check';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled } from '../lib/features';
import { backgroundFor, etagFor, imageHeaders, imageMaxAge, matchesEtag, notModified, type Background } from '../lib/http';
import {
  assertTemplateSize,
  parseSize,
  quotaExceededError,
  readStoredImage,
  resolveTemplate,
  storedImageHeaders,
  templateNotFound,
  templateOptions,
  type ResolvedTemplate,
  type StoredImage,
} from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { deriveSiteSecret } from '../lib/signed-url';
import type { AppEnv, Env, SiteRow, TemplateData, UserRow } from '../types';

interface LinkRequest {
  site: SiteRow;
  owner: UserRow;
  target: URL;
  template: ResolvedTemplate;
  overrides: TemplateData;
  size: SizePreset;
  format: ImageFormat;
}

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

async function linkRequestFor(env: Env, url: URL, request: Request): Promise<LinkRequest> {
  const path = parseLinkPath(url.pathname);
  if (!path) throw new ApiError('not_found', 'Not found. Link card URLs look like /v1/link/{site id}/{template}.png?url=...&sig=...');
  await enforceRateLimit(env, 'RL_IP', clientIp(request));

  const site = await first<SiteRow>(env.DB, 'SELECT * FROM sites WHERE id = ?1 AND deleted_at IS NULL', path.siteId);
  const owner = site ? await getUserById(env.DB, site.user_id) : null;
  if (!site || !owner) throw new ApiError('not_found', 'Site not found. Check the site id in the URL.');

  const verified = await verifyLinkUrl(url, await deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version));
  if (!verified.ok) {
    throw new ApiError('invalid_signature', describeLinkUrlFailure(verified.reason), { details: { reason: verified.reason } });
  }
  if (owner.suspended_at !== null) {
    throw new ApiError('account_suspended', `This account is suspended. Contact ${env.SUPPORT_EMAIL}.`);
  }
  const size = parseSize(verified.size);
  const template = await resolveTemplate(env.DB, owner.id, path.template, templateOptions(env));
  if (!template) throw templateNotFound();
  // Before the pointer, the page or the card: a starter at a size it is not laid out for is refused (400).
  assertTemplateSize(template, size, templateOptions(env));
  return { site, owner, target: verified.target, template, overrides: verified.overrides, size, format: EXTENSION_TO_FORMAT[path.ext]! };
}

/** Browsers and edges keep a link card until the card expires or the link is due for a refresh, whichever is first. */
function cacheControlFor(image: StoredImage, refreshAt: number, now: number): string {
  return `public, max-age=${Math.max(0, Math.min(imageMaxAge(image.expiresAt, now), Math.floor((refreshAt - now) / 1000)))}`;
}

/**
 * Answers from a stored card (200, 304 or a HEAD), or null when the card is no longer in R2.
 * `cache` is what x-ltc-cache says: "stale" when the page could not be read and this is the last card.
 */
async function storedResponse(
  env: Env,
  request: Request,
  link: LinkRequest,
  cacheKey: string,
  refreshAt: number,
  cache: 'hit' | 'stale',
  now: number,
): Promise<Response | null> {
  const head = request.method === 'HEAD';
  const conditional = matchesEtag(request, etagFor(cacheKey));
  const stored = await readStoredImage(env.BUCKET, link.owner.id, cacheKey, link.format, now, !head && !conditional);
  if (!stored) return null;
  const headers = storedImageHeaders(stored.image, 'hit', now);
  headers.set('cache-control', cacheControlFor(stored.image, refreshAt, now));
  headers.set('x-ltc-cache', cache);
  if (conditional) return notModified(headers);
  if (head) {
    headers.set('content-length', String(stored.image.bytes));
    return new Response(null, { headers });
  }
  return new Response(stored.body, { headers });
}

/** The copy at the edge answers repeat requests for this exact URL without reaching R2 or D1. */
function keepAtEdge(background: Background, request: Request, url: URL, response: Response): Response {
  if (request.method !== 'GET' || response.status !== 200 || /max-age=0$/.test(response.headers.get('cache-control') ?? '')) return response;
  const copyHeaders = new Headers(response.headers);
  copyHeaders.set('x-ltc-cache', 'hit');
  const copy = new Response(response.clone().body, { headers: copyHeaders });
  background(Promise.resolve().then(() => caches.default.put(url.href, copy)));
  return response;
}

/** What a GET would most likely say, without reading the page: 402 when the allowance is used up, else 200 of the image type. */
async function headWithoutCard(env: Env, link: LinkRequest, now: number): Promise<Response> {
  const usage = await getUsage(env.DB, link.owner, now);
  if (usage.total_remaining <= 0) throw quotaExceededError(env, usage);
  const headers = imageHeaders({ format: link.format, etag: '""', cacheControl: 'no-store', cache: 'miss' });
  // No card yet, so no ETag a later GET could match.
  headers.delete('etag');
  return new Response(null, { headers });
}

/**
 * The /v1/link router. The numbers (field lengths, refresh interval) are passed in: the app
 * mounts it with src/config.ts LINK_CARDS, tests with their own.
 */
export function createLinkRouter(settings: LinkCardSettings): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.use('*', async (c, next) => {
    assertFeatureEnabled(c.env, 'linkcards');
    await next();
  });

  router.get('/*', async (c) => {
    const { env } = c;
    const request = c.req.raw;
    const url = new URL(request.url);
    const edge = await edgeCacheMatch(url.href);
    if (edge) return fromEdgeCache(request, edge);

    const link = await linkRequestFor(env, url, request);
    const background = backgroundFor(c);
    const now = Date.now();
    const pointerKey = await linkPointerKey(link.owner, link.template, linkCanonical(url));
    const pointer = await readLinkPointer(env.BUCKET, pointerKey, now);
    const refreshAt = (p: LinkPointer): number => p.checkedAt + settings.refreshAfterMs;

    if (pointer && pointerIsFresh(pointer, settings, now)) {
      const response = await storedResponse(env, request, link, pointer.cacheKey, refreshAt(pointer), 'hit', now);
      if (response) return keepAtEdge(background, request, url, response);
    }
    if (request.method === 'HEAD') {
      const response = pointer ? await storedResponse(env, request, link, pointer.cacheKey, refreshAt(pointer), 'hit', now) : null;
      return response ?? headWithoutCard(env, link, now);
    }

    try {
      // A cached check costs nothing; an uncached one counts against the site's daily page checks.
      const check = await inspectUrl(env.DB, link.target, () => enforceSiteInspectLimit(env, link.owner, link.site.id, Date.now()), defaultInspectDeps(env));
      const { card } = await renderLinkCard(
        env,
        background,
        check,
        {
          user: link.owner,
          template: link.template,
          size: link.size,
          format: link.format,
          overrides: link.overrides,
          source: 'og',
          siteId: link.site.id,
          renderRateLimitKey: link.site.id,
        },
        settings.maxChars,
        { now, withBody: true },
      );
      const fresh: LinkPointer = { cacheKey: card.image.cacheKey, checkedAt: now, expiresAt: card.image.expiresAt };
      background(writeLinkPointer(env.BUCKET, pointerKey, fresh));

      const headers = storedImageHeaders(card.image, card.cached ? 'hit' : 'miss', now);
      headers.set('cache-control', cacheControlFor(card.image, refreshAt(fresh), now));
      if (card.cached && matchesEtag(request, etagFor(card.image.cacheKey))) return notModified(headers);
      return keepAtEdge(background, request, url, new Response(card.body, { headers }));
    } catch (error) {
      // The page could not be read or the card not made: keep showing the last card while it exists.
      if (!(error instanceof ApiError) || !pointer) throw error;
      const retryAt = now + INSPECT.cacheTtlMs;
      const stale = await storedResponse(env, request, link, pointer.cacheKey, retryAt, 'stale', now);
      if (!stale) throw error;
      console.warn(`link card ${link.site.id}: serving the last card, refresh failed with ${error.code}`);
      // Not fresh again until retryAt, so a page that is down is not asked again on every request.
      background(writeLinkPointer(env.BUCKET, pointerKey, { ...pointer, checkedAt: retryAt - settings.refreshAfterMs }));
      return stale;
    }
  });

  return router;
}
