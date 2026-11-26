/**
 * Route handlers of "link in, card out" that live inside existing routers:
 *
 *   POST /v1/cards/from-url                          (src/routes/api.ts, API key)
 *   GET  /playground/from-check/{checkId}/{template}.png   (src/routes/playground.ts, public)
 *
 * They are factories that take LinkCardSettings (src/config.ts LINK_CARDS in the app, small
 * numbers in tests). Both answer 503 not_configured behind requireLinkCards while
 * LINK_CARDS_ENABLED is not "true". GET /v1/link/... has its own router (src/routes/link.ts).
 */
import type { Handler, MiddlewareHandler } from 'hono';
import { DAY_MS, HTTP_CACHE, INSPECT, SIZES } from '../config';
import { defaultInspectDeps, inspectUrl, normaliseInputUrl } from '../inspect/check';
import { enforceInspectLimit } from '../inspect/limits';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled } from '../lib/features';
import { assertKnownFields, backgroundFor, etagFor, imageHeaders, iso, matchesEtag, notModified, readJsonObject, usageJson } from '../lib/http';
import { imageUrl, parseCardInput, renderDeps, templateOptions, storedImageHeaders, warningsHeader } from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { renderCard } from '../render';
import { STARTER_TEMPLATE_IDS, getStarterTemplate } from '../render/templates';
import type { AppEnv } from '../types';
import { PREVIEW_THEMES, checkForPreview, parsePreviewFile, previewDataFromCheck } from './playground-from-check';
import { renderLinkCard, type LinkCardSettings } from './service';

/** 503 not_configured until LINK_CARDS_ENABLED is "true"; runs before authentication, like the PDF switch. */
export const requireLinkCards: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertFeatureEnabled(c.env, 'linkcards');
  await next();
};

/* ------------------------------------------------------------------ */
/* POST /v1/cards/from-url                                             */
/* ------------------------------------------------------------------ */

/** No inline html/css: a link card is a starter template or one of the account's own. */
export const FROM_URL_FIELDS: readonly string[] = ['url', 'template', 'data', 'size', 'width', 'height', 'format', 'response'];
const RESPONSE_MODES = ['json', 'binary'] as const;

/**
 * Body: { url, template?, data?, size? | width+height?, format?, response? }. Answers like
 * POST /v1/images, plus `link`: the checked page and the data the card was made from.
 * Mount after requireLinkCards and requireApiKey.
 */
export function fromUrlHandler(settings: LinkCardSettings): Handler<AppEnv> {
  return async (c) => {
    const user = c.var.user;
    const keyId = c.var.apiKey?.id ?? user.id;
    await enforceRateLimit(c.env, 'RL_KEY', keyId);

    const body = await readJsonObject(c.req.raw);
    assertKnownFields(body, FROM_URL_FIELDS);
    const mode = RESPONSE_MODES.find((candidate) => candidate === (body.response ?? 'json'));
    if (!mode) throw new ApiError('invalid_request', '"response" must be "json" (default) or "binary".');
    if (typeof body.url !== 'string') throw new ApiError('invalid_request', '"url" is required: the https:// address of the page to make the card from.');
    const target = normaliseInputUrl(body.url);
    // Everything about the card is checked before the page is read, so a typo never costs an inspection.
    const input = await parseCardInput(c.env.DB, user.id, {
      template: body.template === undefined ? settings.defaultTemplate : body.template,
      data: body.data,
      size: body.size,
      width: body.width,
      height: body.height,
      format: body.format,
    }, templateOptions(c.env));

    // The inspector's own cache and the key's daily inspections (GET /v1/inspect's limit) apply.
    const check = await inspectUrl(c.env.DB, target, () => enforceInspectLimit(c.env, user, keyId, Date.now()), defaultInspectDeps(c.env));
    const now = Date.now();
    const { card, data } = await renderLinkCard(
      c.env,
      backgroundFor(c),
      check,
      { user, template: input.template, size: input.size, format: input.format, overrides: input.data, source: 'api', siteId: null },
      settings.maxChars,
      { now, withBody: mode === 'binary' },
    );
    const { image } = card;
    const url = imageUrl(c.env, user.id, image.cacheKey, image.format);

    if (mode === 'binary') {
      const headers = storedImageHeaders(image, card.cached ? 'hit' : 'miss', now);
      headers.set('x-ltc-image-url', url);
      headers.set('x-ltc-warnings', warningsHeader(card.warnings));
      return new Response(card.body, { headers });
    }
    return c.json({
      id: image.cacheKey,
      url,
      width: image.width,
      height: image.height,
      format: image.format,
      bytes: image.bytes,
      cached: card.cached,
      template: image.template,
      created_at: iso(image.createdAt),
      expires_at: iso(image.expiresAt),
      warnings: card.warnings,
      usage: usageJson(card.usage ?? (await getUsage(c.env.DB, user, now))),
      link: { url: check.url, final_url: check.final_url, check_id: check.id, check_cached: check.cached, data },
    });
  };
}

/* ------------------------------------------------------------------ */
/* GET /playground/from-check/{checkId}/{template}.png                 */
/* ------------------------------------------------------------------ */

const PREVIEW_KEY_VERSION = 'ltc-playground-from-check-v1';
/** Same as the playground: identical previews share one R2 object under p/ for a day (cleanup removes them). */
const PREVIEW_KEEP_MS = DAY_MS;

/**
 * The OG checker's "Make this card": a watermarked 1200x630 PNG of a starter template filled
 * from a stored check. No page fetch and no image fetch (src/cards/playground-from-check.ts);
 * renders count against RL_PLAYGROUND like the homepage playground, and nothing is charged.
 * Optional ?theme=light|dark. Mount as GET /from-check/:checkId/:file after requireLinkCards.
 */
export function fromCheckHandler(settings: LinkCardSettings): Handler<AppEnv> {
  return async (c) => {
    const request = c.req.raw;
    const templateId = parsePreviewFile(c.req.param('file') ?? '');
    const template = templateId === null ? undefined : getStarterTemplate(templateId);
    if (!template) {
      throw new ApiError('not_found', `Previews are PNG images of a starter template: /playground/from-check/{check id}/{${STARTER_TEMPLATE_IDS.join('|')}}.png`);
    }
    const theme = c.req.query('theme');
    if (theme !== undefined && theme !== '' && !PREVIEW_THEMES.includes(theme)) throw new ApiError('invalid_request', '"theme" must be light or dark.');

    const now = Date.now();
    const result = await checkForPreview(c.env.DB, c.req.param('checkId') ?? '', now);
    if (!result) {
      throw new ApiError('not_found', `No stored check has this id. Results are kept ${INSPECT.cacheTtlMs / 60_000} minutes: run the check again to preview the card.`);
    }
    const data = previewDataFromCheck(result, template, settings.maxChars, theme || undefined);

    // The template source is part of the key, as in the playground: a redesign shows at once.
    const key = await sha256Hex(
      JSON.stringify([PREVIEW_KEY_VERSION, template.id, await sha256Hex(template.html), await sha256Hex(template.css), Object.entries(data)]),
    );
    const r2Key = `p/${key}.png`;
    const etag = etagFor(key);
    const head = request.method === 'HEAD';
    const conditional = matchesEtag(request, etag);
    const headers = (cache: 'hit' | 'miss', cacheControl = `public, max-age=${HTTP_CACHE.playgroundMaxAgeSeconds}`): Headers =>
      imageHeaders({ format: 'png', etag, cacheControl, cache });

    const object = head || conditional ? await c.env.BUCKET.head(r2Key) : await c.env.BUCKET.get(r2Key);
    if (object && Number(object.customMetadata?.createdAt) > now - PREVIEW_KEEP_MS) {
      if (conditional) return notModified(headers('hit'));
      const hit = headers('hit');
      if (head) hit.set('content-length', String(object.size));
      return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers: hit });
    }
    // HEAD never renders: it reports the type a GET would return and is not cacheable.
    if (head) return new Response(null, { headers: headers('miss', 'no-store') });

    await enforceRateLimit(c.env, 'RL_PLAYGROUND', clientIp(request));
    const { width, height } = SIZES.og;
    const output = await renderCard(
      { html: template.html, css: template.css, data, width, height, format: 'png', watermark: 'free' },
      renderDeps(c.env, null),
    );
    await c.env.BUCKET.put(r2Key, output.bytes, {
      httpMetadata: { contentType: output.contentType },
      customMetadata: { createdAt: String(now) },
    }).catch((error: unknown) => console.error('storing a card preview failed:', error));
    return new Response(output.bytes, { headers: headers('miss') });
  };
}
