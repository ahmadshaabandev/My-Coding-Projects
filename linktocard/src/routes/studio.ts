/**
 * The template studio part of the dashboard API (/api): custom templates, the
 * live preview and custom fonts. Same guards as ./dashboard.ts.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { requireSameOrigin, requireSession } from '../auth/middleware';
import { getPlan } from '../billing/plans';
import { LIMITS } from '../config';
import { all, first, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { deleteFont, fontsEnabled, listFonts, parseFontDescriptor, uploadFont } from '../lib/fonts-store';
import { assertKnownFields, cleanName, iso, readBodyBytes, readJsonObject } from '../lib/http';
import { CARD_FIELDS, parseCardInput, renderDeps, starterTemplateJson, warningsHeader } from '../lib/images';
import { enforceRateLimit } from '../lib/rate-limit';
import { renderCard, validateTemplate } from '../render';
import { STARTER_TEMPLATES } from '../render/templates';
import type { AppEnv, FontRow, TemplateRow } from '../types';

const FONT_CONTENT_TYPES: readonly string[] = ['font/ttf', 'font/otf', 'font/woff', 'application/octet-stream'];

export const studioRouter = new Hono<AppEnv>();

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const templateJson = (row: TemplateRow): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  html: row.html,
  css: row.css,
  version: row.version,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});

const templateNotFound = (): ApiError => new ApiError('not_found', 'Template not found.');

function sourceField(value: unknown, name: 'html' | 'css'): string {
  if (typeof value !== 'string') throw new ApiError('invalid_request', `"${name}" must be a string.`);
  return value;
}

function ownTemplate(db: D1Database, userId: string, id: string): Promise<TemplateRow | null> {
  return first<TemplateRow>(db, 'SELECT * FROM templates WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL', id, userId);
}

studioRouter.get('/templates', requireSession, async (c) => {
  const custom = await all<Pick<TemplateRow, 'id' | 'name' | 'version' | 'updated_at'>>(
    c.env.DB,
    'SELECT id, name, version, updated_at FROM templates WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY updated_at DESC, id',
    c.var.user.id,
  );
  return c.json({
    starter: STARTER_TEMPLATES.map((template) => starterTemplateJson(template, true)),
    custom: custom.map((template) => ({ ...template, updated_at: iso(template.updated_at) })),
  });
});

studioRouter.get('/templates/:id', requireSession, async (c) => {
  const row = await ownTemplate(c.env.DB, c.var.user.id, c.req.param('id'));
  if (!row) throw templateNotFound();
  return c.json({ template: templateJson(row) });
});

studioRouter.post('/templates', requireSameOrigin, requireSession, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const now = Date.now();
  const row: TemplateRow = {
    id: randomId('t'),
    user_id: c.var.user.id,
    name: cleanName(body.name, 'template'),
    html: sourceField(body.html, 'html'),
    css: body.css === undefined ? '' : sourceField(body.css, 'css'),
    version: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  const { warnings } = validateTemplate(row.html, row.css);
  // The cap is checked inside the INSERT so concurrent requests cannot overshoot it.
  const inserted = await run(
    c.env.DB,
    `INSERT INTO templates (id, user_id, name, html, css, version, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
     WHERE (SELECT COUNT(*) FROM templates WHERE user_id = ?2 AND deleted_at IS NULL) < ?8`,
    row.id,
    row.user_id,
    row.name,
    row.html,
    row.css,
    row.version,
    now,
    LIMITS.maxTemplatesPerUser,
  );
  if (inserted !== 1) {
    throw new ApiError('conflict', `You can have at most ${LIMITS.maxTemplatesPerUser} templates. Delete one to create another.`);
  }
  return c.json({ template: templateJson(row), warnings }, 201);
});

studioRouter.put('/templates/:id', requireSameOrigin, requireSession, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const current = await ownTemplate(c.env.DB, c.var.user.id, c.req.param('id'));
  if (!current) throw templateNotFound();

  const name = body.name === undefined ? current.name : cleanName(body.name, 'template');
  const html = body.html === undefined ? current.html : sourceField(body.html, 'html');
  const css = body.css === undefined ? current.css : sourceField(body.css, 'css');
  const { warnings } = validateTemplate(html, css);
  // The version is part of the render cache key: only a change that can alter pixels bumps it.
  const sourceChanged = html !== current.html || css !== current.css;
  const updated = await first<TemplateRow>(
    c.env.DB,
    `UPDATE templates SET name = ?1, html = ?2, css = ?3, version = version + ?4, updated_at = ?5
     WHERE id = ?6 AND user_id = ?7 AND deleted_at IS NULL RETURNING *`,
    name,
    html,
    css,
    sourceChanged ? 1 : 0,
    Date.now(),
    current.id,
    current.user_id,
  );
  if (!updated) throw templateNotFound();
  return c.json({ template: templateJson(updated), warnings });
});

studioRouter.delete('/templates/:id', requireSameOrigin, requireSession, async (c) => {
  const changed = await run(
    c.env.DB,
    'UPDATE templates SET deleted_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL',
    Date.now(),
    c.req.param('id'),
    c.var.user.id,
  );
  if (changed !== 1) throw templateNotFound();
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Live preview                                                        */
/* ------------------------------------------------------------------ */

studioRouter.post('/preview', requireSameOrigin, requireSession, async (c) => {
  const user = c.var.user;
  await enforceRateLimit(c.env, 'RL_PREVIEW', user.id);
  const body = await readJsonObject(c.req.raw);
  assertKnownFields(body, CARD_FIELDS);
  const { template, data, size, format } = await parseCardInput(c.env.DB, user.id, body);

  // Watermarked, not stored, not counted: a preview is never a usable card.
  const output = await renderCard(
    { html: template.html, css: template.css, data, width: size.width, height: size.height, format, watermark: 'preview' },
    renderDeps(c.env, user),
  );
  return new Response(output.bytes, {
    headers: {
      'content-type': output.contentType,
      'cache-control': 'no-store',
      'x-ltc-warnings': warningsHeader(output.warnings),
    },
  });
});

/* ------------------------------------------------------------------ */
/* Fonts (paid plans)                                                  */
/* ------------------------------------------------------------------ */

const fontJson = (font: FontRow): Record<string, unknown> => ({
  id: font.id,
  family: font.family,
  weight: font.weight,
  style: font.style,
  format: font.format,
  bytes: font.bytes,
  created_at: iso(font.created_at),
});

const requireFontPlan: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!fontsEnabled(c.var.user)) {
    throw new ApiError('plan_required', 'Custom fonts are available on the Starter and Pro plans.');
  }
  await next();
};

/**
 * The upload body is the raw font file, not JSON, so requireSameOrigin's
 * content-type rule cannot apply. Browsers always send Origin on a POST;
 * requiring it to be ours keeps other sites from uploading with the cookie.
 */
const requireOwnOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('origin') !== new URL(c.env.APP_URL).origin) {
    throw new ApiError('forbidden', 'Font uploads must come from the dashboard (same-origin request with an Origin header).');
  }
  await next();
};

studioRouter.get('/fonts', requireSession, requireFontPlan, async (c) => {
  const { maxFiles, maxBytesPerFile } = getPlan(c.var.user.plan).fonts;
  return c.json({
    fonts: (await listFonts(c.env.DB, c.var.user.id)).map(fontJson),
    limits: { max_files: maxFiles, max_bytes_per_file: maxBytesPerFile },
  });
});

studioRouter.post('/fonts', requireOwnOrigin, requireSession, requireFontPlan, async (c) => {
  const user = c.var.user;
  const descriptor = parseFontDescriptor({ family: c.req.query('family'), weight: c.req.query('weight'), style: c.req.query('style') });
  const contentType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!FONT_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError('unsupported_media_type', `Send the font file as the request body with Content-Type ${FONT_CONTENT_TYPES.join(', ')}.`);
  }
  const bytes = await readBodyBytes(c.req.raw, getPlan(user.plan).fonts.maxBytesPerFile);
  if (bytes.byteLength === 0) throw new ApiError('invalid_request', 'The request body is empty. Send the font file as the body.');
  const font = await uploadFont(c.env, user, descriptor, bytes, Date.now());
  return c.json({ font: fontJson(font) }, 201);
});

studioRouter.delete('/fonts/:id', requireSameOrigin, requireSession, requireFontPlan, async (c) => {
  if (!(await deleteFont(c.env, c.var.user.id, c.req.param('id'), Date.now()))) {
    throw new ApiError('not_found', 'Font not found.');
  }
  return c.json({ ok: true });
});
