/**
 * The render side of "link in, card out", shared by POST /v1/cards/from-url and the signed
 * GET /v1/link/... URLs: one OG check in, one card out through the ordinary card service
 * (src/lib/images.ts getCard), so caching, quota, the free watermark and the ledger work
 * exactly as for any other card: 1 image unit per new card, nothing for a cached one.
 *
 * Signed link URLs also keep a small pointer per link in R2 (r/{userId}/link/{hash}, no
 * body, no page text: the card's cache key and two times in its metadata). It lets a link
 * be answered without reading the page again until the card is due for a refresh, and keeps
 * serving the last card when the page cannot be read at that moment. Pointers sit under the
 * account's r/ prefix, so deleting the account deletes them.
 */
import type { ImageFormat, SizePreset } from '../config';
import { enforceInspectLimit } from '../inspect/limits';
import type { CheckResult } from '../inspect/types';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { Background } from '../lib/http';
import { getCard, planWatermark, type Card, type CardRequest, type ResolvedTemplate } from '../lib/images';
import type { Env, TemplateData, UserRow } from '../types';
import { cardDataFromLink, hasPageImages, linkFieldsFromCheck, templateFieldNames, withoutPageImages, type LinkFieldLimits } from './from-url';

/**
 * The numbers of link cards. They live in src/config.ts (LINK_CARDS) and are passed in, so
 * this module and its tests do not depend on the production values.
 */
export interface LinkCardSettings {
  /** Template of POST /v1/cards/from-url when the body names none. */
  defaultTemplate: string;
  /** Longest page text put on a card, per field. */
  maxChars: LinkFieldLimits;
  /** A signed link card is built from the page again once its last check is this old. */
  refreshAfterMs: number;
}

export interface LinkCardRequest {
  user: UserRow;
  template: ResolvedTemplate;
  size: SizePreset;
  format: ImageFormat;
  /** Template data from the caller; wins over the page's values. Already validated. */
  overrides: TemplateData;
  source: CardRequest['source'];
  siteId: string | null;
  renderRateLimitKey?: string;
}

export interface LinkCard {
  card: Card;
  /** The data the card was rendered from (without the page's images if loading one failed). */
  data: TemplateData;
}

/**
 * The card for one check. When an image the page named cannot be loaded (a broken icon, a
 * private address, a type the renderer cannot draw) the card is rendered once more without
 * the page's images: the page's own problem should not cost the customer the card. A failed
 * render is never charged, so at most the card that is delivered counts.
 */
export async function renderLinkCard(
  env: Env,
  background: Background,
  check: CheckResult,
  request: LinkCardRequest,
  limits: LinkFieldLimits,
  options: { now: number; withBody: boolean },
): Promise<LinkCard> {
  const { overrides } = request;
  const data = cardDataFromLink(linkFieldsFromCheck(check, limits), templateFieldNames(request.template), overrides);
  const card = (cardData: TemplateData): CardRequest => ({
    user: request.user,
    template: request.template,
    data: cardData,
    size: request.size,
    format: request.format,
    source: request.source,
    siteId: request.siteId,
    ...(request.renderRateLimitKey ? { renderRateLimitKey: request.renderRateLimitKey } : {}),
  });
  try {
    return { card: await getCard(env, background, card(data), options), data };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'image_fetch_failed' || !hasPageImages(data, overrides)) throw error;
    const fallback = withoutPageImages(data, overrides);
    return { card: await getCard(env, background, card(fallback), options), data: fallback };
  }
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Page checks behind one site's signed link URLs: the plan's daily inspection allowance
 * (INSPECT.dailyInspectionsByPlan), counted per site instead of per API key. Cached checks
 * are never counted; the message names the site, not a key.
 */
export async function enforceSiteInspectLimit(env: Env, owner: UserRow, siteId: string, now: number): Promise<void> {
  try {
    await enforceInspectLimit(env, owner, `site:${siteId}`, now);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'rate_limited') throw error;
    const limit = typeof error.details?.limit === 'number' ? error.details.limit : null;
    throw new ApiError(
      'rate_limited',
      `This site's link cards have read ${limit ?? 'the allowed number of'} pages today (UTC), the daily limit of its plan. Cards already made keep being served; more pages can be read after midnight UTC.`,
      { ...(error.headers ? { headers: error.headers } : {}), ...(error.details ? { details: error.details } : {}) },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Link pointers                                                       */
/* ------------------------------------------------------------------ */

/** Bump only when the meaning of a pointer changes; every link is then read again once. */
const POINTER_VERSION = 'ltc-link-v1';

export interface LinkPointer {
  /** Cache key of the card (src/lib/images.ts cardCacheKey). */
  cacheKey: string;
  /** When the page was last read for this link (or a failed refresh was last tried). */
  checkedAt: number;
  /** When the card itself expires (its ledger row and R2 object). */
  expiresAt: number;
}

/**
 * R2 key of one link's pointer. Everything that changes the card without changing the
 * URL is part of it: the template's identity (a custom template's version) and the
 * watermark (a plan change), so neither can serve a stale card.
 */
export async function linkPointerKey(user: Pick<UserRow, 'id' | 'plan'>, template: Pick<ResolvedTemplate, 'identity'>, canonical: string): Promise<string> {
  const hash = await sha256Hex(JSON.stringify([POINTER_VERSION, user.id, template.identity, planWatermark(user), canonical]));
  return `r/${user.id}/link/${hash}`;
}

const CACHE_KEY_RE = /^[0-9a-f]{64}$/;

/** The pointer, or null when there is none, it is malformed or its card has expired. */
export async function readLinkPointer(bucket: R2Bucket, key: string, now: number): Promise<LinkPointer | null> {
  const object = await bucket.head(key);
  const meta = object?.customMetadata ?? {};
  const pointer = { cacheKey: meta.cacheKey ?? '', checkedAt: Number(meta.checkedAt), expiresAt: Number(meta.expiresAt) };
  if (!CACHE_KEY_RE.test(pointer.cacheKey) || !Number.isFinite(pointer.checkedAt) || !Number.isFinite(pointer.expiresAt)) return null;
  return pointer.expiresAt > now ? pointer : null;
}

export async function writeLinkPointer(bucket: R2Bucket, key: string, pointer: LinkPointer): Promise<void> {
  await bucket.put(key, new Uint8Array(0), {
    customMetadata: { cacheKey: pointer.cacheKey, checkedAt: String(pointer.checkedAt), expiresAt: String(pointer.expiresAt) },
  });
}

/** True while a pointer's card may be served without reading the page again. */
export function pointerIsFresh(pointer: LinkPointer, settings: Pick<LinkCardSettings, 'refreshAfterMs'>, now: number): boolean {
  return now - pointer.checkedAt < settings.refreshAfterMs;
}
