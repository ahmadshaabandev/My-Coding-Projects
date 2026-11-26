/**
 * GET /playground/card.png?template=&title=&description=&author=&theme=
 *
 * The homepage playground: starter templates only, four short text fields, a
 * watermarked 1200x630 PNG. It takes no URL parameter of any kind, so it cannot
 * be used to make the service fetch something. Not tied to an account and
 * never counted; identical requests share one R2 object for a day.
 */
import { Hono } from 'hono';
import { fromCheckHandler, requireLinkCards } from '../cards/handlers';
import { DAY_MS, HTTP_CACHE, LINK_CARDS, SIZES } from '../config';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { codePointLength, etagFor, imageHeaders, matchesEtag, notModified } from '../lib/http';
import { renderDeps } from '../lib/images';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { renderCard } from '../render';
import { STARTER_TEMPLATE_IDS, getStarterTemplate } from '../render/templates';
import type { AppEnv, TemplateData } from '../types';

const TEXT_LIMITS: Readonly<Record<string, number>> = { title: 120, description: 200, author: 60 };
const THEMES: readonly string[] = ['light', 'dark'];
const DEFAULT_TEMPLATE = 'blog';
const KEY_VERSION = 'ltc-playground-v1';
const KEEP_MS = DAY_MS;

export const playgroundRouter = new Hono<AppEnv>();

function playgroundData(query: Record<string, string>): TemplateData {
  const data: TemplateData = {};
  for (const [name, max] of Object.entries(TEXT_LIMITS)) {
    const value = query[name];
    if (value === undefined || value === '') continue;
    if (codePointLength(value) > max) {
      throw new ApiError('invalid_request', `"${name}" can be at most ${max} characters in the playground.`);
    }
    data[name] = value;
  }
  const theme = query.theme;
  if (theme !== undefined && theme !== '') {
    if (!THEMES.includes(theme)) throw new ApiError('invalid_request', '"theme" must be light or dark.');
    data.theme = theme;
  }
  return data;
}

playgroundRouter.get('/card.png', async (c) => {
  const request = c.req.raw;
  const query = c.req.query();
  const template = getStarterTemplate(query.template || DEFAULT_TEMPLATE);
  if (!template) {
    throw new ApiError('invalid_request', `"template" must be one of: ${STARTER_TEMPLATE_IDS.join(', ')}.`);
  }
  const data = playgroundData(query);
  const now = Date.now();

  // The template source is part of the key: the playground is free, so a redesign shows up at once.
  const key = await sha256Hex(
    JSON.stringify([KEY_VERSION, template.id, await sha256Hex(template.html), await sha256Hex(template.css), Object.entries(data)]),
  );
  const r2Key = `p/${key}.png`;
  const etag = etagFor(key);
  const head = request.method === 'HEAD';
  const conditional = matchesEtag(request, etag);
  const headers = (cache: 'hit' | 'miss', cacheControl = `public, max-age=${HTTP_CACHE.playgroundMaxAgeSeconds}`): Headers =>
    imageHeaders({ format: 'png', etag, cacheControl, cache });

  const object = head || conditional ? await c.env.BUCKET.head(r2Key) : await c.env.BUCKET.get(r2Key);
  if (object && Number(object.customMetadata?.createdAt) > now - KEEP_MS) {
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
  }).catch((error: unknown) => console.error('storing a playground image failed:', error));
  return new Response(output.bytes, { headers: headers('miss') });
});

// The OG checker's "Make this card" (src/cards/handlers.ts): a watermarked preview from a stored check, no fetch.
playgroundRouter.get('/from-check/:checkId/:file', requireLinkCards, fromCheckHandler(LINK_CARDS));
