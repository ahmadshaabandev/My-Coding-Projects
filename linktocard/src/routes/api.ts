/**
 * The API-key endpoints under /v1 ("Authorization: Bearer ltc_..."):
 *
 *   POST /v1/images     render (or fetch from cache) one card
 *   GET  /v1/usage      the account's usage for the current period
 *   GET  /v1/templates  starter templates and the account's own
 *   GET  /v1/inspect    check a page's link-preview tags (the OG checker's JSON; not an image)
 *
 * Auth is attached per route, so an unknown /v1 path is a plain 404.
 */
import { Hono } from 'hono';
import { requireApiKey } from '../auth/middleware';
import { all } from '../db/client';
import { ApiError } from '../lib/errors';
import { defaultInspectDeps, inspectUrl, normaliseInputUrl } from '../inspect/check';
import { enforceInspectLimit } from '../inspect/limits';
import { assertKnownFields, backgroundFor, iso, readJsonObject, usageJson } from '../lib/http';
import { CARD_FIELDS, getCard, imageUrl, parseCardInput, starterTemplateJson, storedImageHeaders, warningsHeader } from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { STARTER_TEMPLATES } from '../render/templates';
import type { AppEnv, TemplateRow } from '../types';

const IMAGE_FIELDS: readonly string[] = [...CARD_FIELDS, 'response'];
const RESPONSE_MODES = ['json', 'binary'] as const;

type CustomTemplateSummary = Pick<TemplateRow, 'id' | 'name' | 'version' | 'updated_at'>;

export const apiRouter = new Hono<AppEnv>();

apiRouter.use('*', async (c, next) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  await next();
});

apiRouter.post('/images', requireApiKey, async (c) => {
  const user = c.var.user;
  await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? user.id);

  const body = await readJsonObject(c.req.raw);
  assertKnownFields(body, IMAGE_FIELDS);
  const mode = RESPONSE_MODES.find((candidate) => candidate === (body.response ?? 'json'));
  if (!mode) throw new ApiError('invalid_request', '"response" must be "json" (default) or "binary".');
  const input = await parseCardInput(c.env.DB, user.id, body);

  const now = Date.now();
  const card = await getCard(
    c.env,
    backgroundFor(c),
    { user, ...input, source: 'api', siteId: null },
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
  });
});

apiRouter.get('/usage', requireApiKey, async (c) => c.json(usageJson(await getUsage(c.env.DB, c.var.user, Date.now()))));

apiRouter.get('/templates', requireApiKey, async (c) => {
  const custom = await all<CustomTemplateSummary>(
    c.env.DB,
    'SELECT id, name, version, updated_at FROM templates WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC, id',
    c.var.user.id,
  );
  return c.json({
    starter: STARTER_TEMPLATES.map((template) => starterTemplateJson(template, false)),
    custom: custom.map((template) => ({ ...template, updated_at: iso(template.updated_at) })),
  });
});

apiRouter.get('/inspect', requireApiKey, async (c) => {
  const { user } = c.var;
  const input = normaliseInputUrl(c.req.query('url'));
  // Cached results are free; an uncached check counts against the key's daily allowance.
  const result = await inspectUrl(c.env.DB, input, () => enforceInspectLimit(c.env, user, c.var.apiKey?.id ?? user.id, Date.now()), defaultInspectDeps(c.env));
  return c.json(result);
});
