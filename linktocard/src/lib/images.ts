/**
 * The render service behind signed URLs (/v1/og) and POST /v1/images.
 *
 * Order of operations for one card, and why quota can be neither charged for
 * nothing nor bypassed:
 *
 *   1. cache key (account + template identity + data + size + format + watermark)
 *   2. R2 lookup            hit -> served, quota untouched
 *   3. quota pre-check      nothing left -> 402 before any CPU is spent
 *   4. render               any failure -> its error, nothing stored, nothing counted
 *   5. chargeRender         the authority: charged | duplicate | quota_exceeded
 *   6. store in R2          only for a charged image or one the ledger already covers
 *
 * Email images (CardRequest.chargeOnce, a signed URL with open fields) are charged once: step 5
 * writes the record that the image was paid for in the same D1 batch that takes it
 * (RenderCharge.chargeRecord), so the record exists if and only if the image was taken. When the
 * charge of an image is remembered (src/lib/open-fields.ts hasEmailCharge), step 3 is skipped and
 * step 5 records an uncharged ledger row instead (recordUnchargedRender), so a copy rendered again
 * after its stored period ended costs nothing.
 *
 * A starter template renders only at the size presets it is laid out for (assertTemplateSize).
 *
 * The dashboard preview and the playground render through the same renderer
 * but skip steps 2-6: they are watermarked, never stored here and never counted.
 */
import { quotaRemedy, topUpOnSale } from '../billing/offers';
import { getPlan, formatCount } from '../billing/plans';
import {
  CONTENT_TYPES,
  DAY_MS,
  DEFAULT_FORMAT,
  DEFAULT_SIZE,
  EMAIL_FIELDS,
  EXTENSION_TO_FORMAT,
  FORMATS,
  FORMAT_TO_EXTENSION,
  LIMITS,
  SIZES,
  type ImageFormat,
  type SizeId,
  type SizePreset,
} from '../config';
import { first } from '../db/client';
import { renderCard } from '../render';
import { createEmojiLoader } from '../render/emoji';
import { createImageFetcher } from '../render/proxy';
import { EMAIL_TEMPLATES, STARTER_TEMPLATES, getStarterTemplate, type StarterTemplate } from '../render/templates';
import type { Env, RenderDeps, TemplateData, TemplateRow, UsageSummary, UserRow, WatermarkMode } from '../types';
import { sha256Hex } from './crypto';
import { featureEnabled } from './features';
import { sendEmail, quotaWarningEmail } from './email';
import { ApiError } from './errors';
import { createFontLoader, fontsEnabled } from './fonts-store';
import {
  codePointLength,
  etagFor,
  imageHeaders,
  imageMaxAge,
  isJsonObject,
  iso,
  usageJson,
  type Background,
  type JsonObject,
} from './http';
import { emailChargeBucket, hasEmailCharge } from './open-fields';
import { chargeRender, getUsage, recordUnchargedRender, type RenderCharge } from './quota';
import { enforceRateLimit } from './rate-limit';

/** Bump only when the meaning of a cache key changes; it re-bills every cached card. */
const CACHE_KEY_VERSION = 'ltc-card-v1';
const RENDER_KEY_PREFIX = 'r/';
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CACHE_KEY_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Input validation shared by /v1/images, /api/preview and /api/sign   */
/* ------------------------------------------------------------------ */

/**
 * The one validator for a `data` map: an object of at most maxDataKeys string
 * values, keys matching dataKeyPattern, values at most maxDataValueChars code
 * points (the same unit the signed-URL verifier counts).
 */
export function validateData(input: unknown, reserved: readonly string[] = []): TemplateData {
  if (input === undefined) return {};
  if (!isJsonObject(input)) {
    throw new ApiError('invalid_request', '"data" must be an object of string values, for example {"title": "Hello"}.');
  }
  const entries = Object.entries(input);
  if (entries.length > LIMITS.maxDataKeys) {
    throw new ApiError('invalid_request', `"data" may contain at most ${LIMITS.maxDataKeys} keys; this one has ${entries.length}.`);
  }
  const data: TemplateData = {};
  for (const [key, value] of entries) {
    if (!LIMITS.dataKeyPattern.test(key)) {
      throw new ApiError(
        'invalid_request',
        `Data key "${key.slice(0, 40)}" is not valid. Keys start with a lower-case letter and contain only a-z, 0-9 and "_" (at most 32 characters).`,
      );
    }
    if (reserved.includes(key)) {
      throw new ApiError('invalid_request', `"${key}" is a reserved name and cannot be used as a data key here.`);
    }
    if (typeof value !== 'string') {
      throw new ApiError('invalid_request', `Data value "${key}" must be a string. Send numbers and booleans as text.`);
    }
    if (value.length > LIMITS.maxDataValueChars && codePointLength(value) > LIMITS.maxDataValueChars) {
      throw new ApiError('invalid_request', `Data value "${key}" is longer than ${LIMITS.maxDataValueChars} characters.`);
    }
    data[key] = value;
  }
  return data;
}

function unsupportedSize(): ApiError {
  const presets = Object.values(SIZES).map((size) => `${size.id} (${size.width}x${size.height})`);
  return new ApiError('unsupported_size', `Unsupported size. Supported sizes: ${presets.join(', ')}.`);
}

/** `size` as a preset id; undefined means the default (og). */
export function parseSize(value: unknown): SizePreset {
  if (value === undefined) return SIZES[DEFAULT_SIZE];
  const preset = Object.values(SIZES).find((size) => size.id === value);
  if (!preset) throw unsupportedSize();
  return preset;
}

/** `width` + `height` are accepted only when they equal one of the presets. */
export function parseDimensions(width: unknown, height: unknown): SizePreset {
  const preset = Object.values(SIZES).find((size) => size.width === width && size.height === height);
  if (!preset) throw unsupportedSize();
  return preset;
}

/** `format` as an ImageFormat ("jpg" is accepted for jpeg); undefined means png. */
export function parseFormat(value: unknown): ImageFormat {
  if (value === undefined) return DEFAULT_FORMAT;
  const format = typeof value === 'string' ? EXTENSION_TO_FORMAT[value] : undefined;
  if (!format) throw new ApiError('unsupported_format', `Unsupported format. Supported formats: ${FORMATS.join(', ')}.`);
  return format;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export interface ResolvedTemplate {
  /** What the ledger and API responses call it: a starter id, a custom id or "inline". */
  label: string;
  /** The part of the cache key that changes when the template's content does. */
  identity: string;
  html: string;
  css: string;
  /** The presets a starter is laid out for; undefined (custom and inline templates) means every preset. */
  sizes?: readonly SizeId[];
}

/** Which starters a request may name: the email starters only while the email images tool is on. */
export interface TemplateOptions {
  emailTemplates?: boolean;
}

export function templateOptions(env: Partial<Pick<Env, 'EMAIL_FIELDS_ENABLED'>>): TemplateOptions {
  return { emailTemplates: featureEnabled(env, 'emailfields') };
}

/**
 * A starter template, or a custom one the account owns. Someone else's
 * template is null exactly like a missing one, so ids cannot be probed.
 */
export async function resolveTemplate(db: D1Database, userId: string, id: unknown, options: TemplateOptions = {}): Promise<ResolvedTemplate | null> {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null;
  const starter = getStarterTemplate(id, { email: options.emailTemplates === true });
  // A starter's identity has no content hash on purpose: a redesign must not re-bill existing URLs.
  if (starter) return { label: starter.id, identity: `starter:${starter.id}`, html: starter.html, css: starter.css, sizes: starter.sizes };
  const row = await first<TemplateRow>(
    db,
    'SELECT * FROM templates WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL',
    id,
    userId,
  );
  return row ? { label: row.id, identity: `custom:${row.id}@${row.version}`, html: row.html, css: row.css } : null;
}

export async function inlineTemplate(html: string, css: string): Promise<ResolvedTemplate> {
  return { label: 'inline', identity: `inline:${await sha256Hex(html)}:${await sha256Hex(css)}`, html, css };
}

/** A starter template as listed by the API; the dashboard also gets its source and sample data. */
export function starterTemplateJson(template: StarterTemplate, withSource: boolean): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    ...(withSource ? { html: template.html, css: template.css } : {}),
    fields: template.fields.map((field) => ({
      name: field.name,
      description: field.description,
      example: field.example,
      required: field.required === true,
    })),
    ...(withSource ? { sample: template.sample } : {}),
  };
}

export function templateNotFound(): ApiError {
  return new ApiError('not_found', 'Template not found. Use a starter template id or the id of one of your own templates.');
}

const presetName = (id: SizeId): string => `${id} (${SIZES[id].width}x${SIZES[id].height})`;

/**
 * Refuses a size preset a starter template is not laid out for (StarterTemplate.sizes; the
 * social starters are not laid out for the email preset), with 400 invalid_request. Every route
 * that renders or signs a card calls it once the template and the size are known, and getCard
 * calls it again. Custom and inline templates take every preset. The message names the sizes the
 * template supports and the starters made for the size asked for, or says that they are not
 * switched on (the email starters while EMAIL_FIELDS_ENABLED is off).
 */
export function assertTemplateSize(template: Pick<ResolvedTemplate, 'label' | 'sizes'>, size: SizePreset, options: TemplateOptions = {}): void {
  if (template.sizes === undefined || template.sizes.includes(size.id)) return;
  const madeFor = (list: readonly StarterTemplate[]): string[] => list.filter((starter) => starter.sizes.includes(size.id)).map((starter) => starter.id);
  const available = [...madeFor(STARTER_TEMPLATES), ...(options.emailTemplates === true ? madeFor(EMAIL_TEMPLATES) : [])];
  const switchedOff = options.emailTemplates === true ? [] : madeFor(EMAIL_TEMPLATES);
  const others =
    available.length > 0
      ? `For the ${size.id} size, use ${available.length === 1 ? 'the starter template' : 'one of the starter templates'} ${available.join(', ')}, or one of your own templates (they take every size).`
      : switchedOff.length > 0
        ? `The starter templates made for the ${size.id} size (${switchedOff.join(', ')}) are not switched on yet; your own templates take every size.`
        : 'Your own templates take every size.';
  throw new ApiError(
    'invalid_request',
    `The starter template "${template.label}" is not laid out for the ${presetName(size.id)} size. It supports ${template.sizes.map(presetName).join(', ')}. ${others}`,
    { details: { reason: 'size_not_supported', template: template.label, size: size.id, supported_sizes: [...template.sizes] } },
  );
}

/** Body fields that describe a card; POST /v1/images adds "response" on top. */
export const CARD_FIELDS = ['template', 'html', 'css', 'data', 'size', 'width', 'height', 'format'] as const;

export interface CardInput {
  template: ResolvedTemplate;
  data: TemplateData;
  size: SizePreset;
  format: ImageFormat;
}

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

/** Validates the card part of a JSON body and resolves its template for this account. */
export async function parseCardInput(db: D1Database, userId: string, body: JsonObject, options: TemplateOptions = {}): Promise<CardInput> {
  const { template: templateId, html, css } = body;
  if ((templateId === undefined) === (html === undefined)) {
    throw invalid('Send exactly one of "template" (a template id) or "html" (an inline template).');
  }
  if (templateId !== undefined && css !== undefined) throw invalid('"css" can only be sent together with "html".');
  if (templateId !== undefined && typeof templateId !== 'string') throw invalid('"template" must be a template id, for example "blog".');
  if (html !== undefined && (typeof html !== 'string' || html.trim() === '')) throw invalid('"html" must be a non-empty string.');
  if (css !== undefined && typeof css !== 'string') throw invalid('"css" must be a string.');

  const data = validateData(body.data);
  const hasDimensions = body.width !== undefined || body.height !== undefined;
  if (hasDimensions && body.size !== undefined) throw invalid('Send either "size" or "width" and "height", not both.');
  const size = hasDimensions ? parseDimensions(body.width, body.height) : parseSize(body.size);
  const format = parseFormat(body.format);

  if (typeof html === 'string') return { template: await inlineTemplate(html, typeof css === 'string' ? css : ''), data, size, format };
  const template = await resolveTemplate(db, userId, templateId, options);
  if (!template) throw templateNotFound();
  assertTemplateSize(template, size, options);
  return { template, data, size, format };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const fetchImage = createImageFetcher();

/** Remote images through the SSRF-guarded proxy, emoji from static assets, fonts of a paid account. */
export function renderDeps(env: Env, user: Pick<UserRow, 'id' | 'plan'> | null): RenderDeps {
  return {
    fetchImage,
    loadEmoji: createEmojiLoader(env.ASSETS),
    ...(user && fontsEnabled(user) ? { loadFonts: createFontLoader(env, user.id) } : {}),
  };
}

export function planWatermark(user: Pick<UserRow, 'plan'>): WatermarkMode {
  return getPlan(user.plan).watermark ? 'free' : 'none';
}

/* ------------------------------------------------------------------ */
/* Stored images                                                       */
/* ------------------------------------------------------------------ */

export interface StoredImage {
  cacheKey: string;
  userId: string;
  format: ImageFormat;
  bytes: number;
  width: number;
  height: number;
  template: string;
  createdAt: number;
  expiresAt: number;
}

export interface StoredImageRead {
  image: StoredImage;
  /** Null when only the metadata was asked for. */
  body: ReadableStream | null;
}

export function renderR2Key(userId: string, cacheKey: string, format: ImageFormat): string {
  return `${RENDER_KEY_PREFIX}${userId}/${cacheKey}.${FORMAT_TO_EXTENSION[format]}`;
}

/** Public URL of a stored image (GET /i/...). */
export function imageUrl(env: Pick<Env, 'APP_URL'>, userId: string, cacheKey: string, format: ImageFormat): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/i/${userId}/${cacheKey}.${FORMAT_TO_EXTENSION[format]}`;
}

/** Splits "<cacheKey>.<ext>" from an /i/ URL; null when it is not shaped like one of ours. */
export function parseImageFile(file: string): { cacheKey: string; format: ImageFormat } | null {
  const dot = file.lastIndexOf('.');
  if (dot === -1) return null;
  const cacheKey = file.slice(0, dot);
  const format = EXTENSION_TO_FORMAT[file.slice(dot + 1)];
  return format && CACHE_KEY_RE.test(cacheKey) ? { cacheKey, format } : null;
}

/**
 * Reads a stored image. An object past its expiry is treated as absent: the
 * cache period is over and the next render of that card is counted again.
 */
export async function readStoredImage(
  bucket: R2Bucket,
  userId: string,
  cacheKey: string,
  format: ImageFormat,
  now: number,
  withBody: boolean,
): Promise<StoredImageRead | null> {
  const key = renderR2Key(userId, cacheKey, format);
  const object = withBody ? await bucket.get(key) : await bucket.head(key);
  if (!object) return null;
  const meta = object.customMetadata ?? {};
  const expiresAt = Number(meta.expiresAt);
  const body = 'body' in object ? (object as R2ObjectBody).body : null;
  // An expired object's body is simply left unread (cancelling an R2 stream logs a runtime error).
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return {
    image: {
      cacheKey,
      userId,
      format,
      bytes: object.size,
      width: Number(meta.width),
      height: Number(meta.height),
      template: meta.template ?? '',
      createdAt: Number(meta.createdAt),
      expiresAt,
    },
    body,
  };
}

/** Response headers of a stored image: cacheable until it expires, a day at most. */
export function storedImageHeaders(image: StoredImage, cache: 'hit' | 'miss', now: number): Headers {
  return imageHeaders({
    format: image.format,
    etag: etagFor(image.cacheKey),
    cacheControl: `public, max-age=${imageMaxAge(image.expiresAt, now)}`,
    cache,
  });
}

const WARNINGS_HEADER_MAX_CHARS = 6000;

/** Render warnings for a header: URI-encoded JSON array, cut to whole warnings that fit. */
export function warningsHeader(warnings: readonly string[]): string {
  const kept: string[] = [];
  for (const warning of warnings) {
    if (encodeURIComponent(JSON.stringify([...kept, warning])).length > WARNINGS_HEADER_MAX_CHARS) break;
    kept.push(warning);
  }
  return encodeURIComponent(JSON.stringify(kept));
}

async function storeImage(bucket: R2Bucket, image: StoredImage, bytes: Uint8Array): Promise<void> {
  await bucket.put(renderR2Key(image.userId, image.cacheKey, image.format), bytes, {
    httpMetadata: { contentType: CONTENT_TYPES[image.format] },
    customMetadata: {
      expiresAt: String(image.expiresAt),
      createdAt: String(image.createdAt),
      width: String(image.width),
      height: String(image.height),
      template: image.template,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Cards: cache, quota, render, charge                                 */
/* ------------------------------------------------------------------ */

export interface CardRequest {
  user: UserRow;
  template: ResolvedTemplate;
  data: TemplateData;
  size: SizePreset;
  format: ImageFormat;
  source: 'og' | 'api';
  siteId: string | null;
  /** RL_KEY bucket applied only when a render is really needed (signed URLs: the site id). */
  renderRateLimitKey?: string;
  /**
   * An email image (a signed URL with open fields): charged once. While its charge is remembered
   * (EMAIL_FIELDS.chargeMemoryDays), a copy whose stored period ended is rendered again for free.
   */
  chargeOnce?: boolean;
}

export interface Card {
  image: StoredImage;
  /** Served from R2 without rendering. */
  cached: boolean;
  /** Stream for a cached image, bytes for a fresh one, null when only metadata was asked for. */
  body: ReadableStream | Uint8Array | null;
  warnings: string[];
  /** Usage right after the charge; null when nothing was charged. */
  usage: UsageSummary | null;
  /** Images this request was charged: 1 for 'charged', else 0. */
  creditsUsed: number;
  /**
   * cached: served from R2, nothing rendered. charged: rendered and charged. rerendered: an email
   * image charged before, rendered again after its copy expired, not charged. duplicate: rendered,
   * but the ledger already covered the image (a concurrent request, or an object that never
   * reached R2), not charged.
   */
  outcome: 'cached' | 'charged' | 'rerendered' | 'duplicate';
}

/** sha256 over everything that decides the pixels and who paid for them. */
export async function cardCacheKey(request: Pick<CardRequest, 'user' | 'template' | 'data' | 'size' | 'format'>): Promise<string> {
  const entries = Object.entries(request.data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(
    JSON.stringify([
      CACHE_KEY_VERSION,
      request.user.id,
      request.template.identity,
      entries,
      request.size.width,
      request.size.height,
      request.format,
      planWatermark(request.user),
    ]),
  );
}

/**
 * 402 that says what ran out, when it comes back and where to get more. A top-up is named only
 * while one can be bought here (src/billing/offers.ts).
 */
export function quotaExceededError(env: Env, usage: UsageSummary): ApiError {
  const plan = getPlan(usage.plan);
  const remedy = quotaRemedy(env, plan);
  return new ApiError(
    'quota_exceeded',
    `The monthly allowance of ${formatCount(usage.limit)} images on the ${plan.name} plan is used up. ` +
      `It resets on ${iso(usage.period_end)}. Images that are already cached keep working${remedy ? `; to render new ones now, ${remedy}` : ''}.`,
    { details: { usage: usageJson(usage) } },
  );
}

function sendQuotaEmail(env: Env, user: UserRow, percent: 90 | 100, usage: UsageSummary): Promise<void> {
  return sendEmail(env, {
    to: user.email,
    ...quotaWarningEmail({ percent, usage, appUrl: env.APP_URL, topUpOnSale: topUpOnSale(env, getPlan(usage.plan)) }),
    // One notice per account, threshold and period even if two isolates race.
    idempotencyKey: `quota-${percent}-${user.id}-${usage.period_start}-${usage.limit}`,
  }).then((result) => {
    if (!result.ok) console.error(`quota ${percent}% email to ${user.id} was not sent: ${result.error}`);
  });
}

/** Looks a card up in R2 without ever rendering (also what HEAD uses). */
export async function findStoredCard(
  env: Pick<Env, 'BUCKET'>,
  request: CardRequest,
  cacheKey: string,
  now: number,
  withBody: boolean,
): Promise<StoredImageRead | null> {
  return readStoredImage(env.BUCKET, request.user.id, cacheKey, request.format, now, withBody);
}

async function renderAndCharge(env: Env, background: Background, request: CardRequest, cacheKey: string, now: number): Promise<Card> {
  const { user, template, size, format } = request;
  // An email image that was charged before renders again for free, also with no images left.
  const prepaid = request.chargeOnce === true && (await hasEmailCharge(env.DB, user.id, cacheKey, now));
  const before = await getUsage(env.DB, user, now);
  if (before.total_remaining <= 0 && !prepaid) throw quotaExceededError(env, before);
  if (request.renderRateLimitKey) await enforceRateLimit(env, 'RL_KEY', request.renderRateLimitKey);

  // Throws on any failure: from here to chargeRender nothing has been stored or counted.
  const output = await renderCard(
    { html: template.html, css: template.css, data: request.data, width: size.width, height: size.height, format, watermark: planWatermark(user) },
    renderDeps(env, user),
  );

  const ttlMs = getPlan(user.plan).cacheDays * DAY_MS;
  const image: StoredImage = {
    cacheKey,
    userId: user.id,
    format,
    bytes: output.bytes.byteLength,
    width: output.width,
    height: output.height,
    template: template.label,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  const ledgerEntry: RenderCharge = {
    cacheKey,
    siteId: request.siteId,
    source: request.source,
    template: template.label,
    width: image.width,
    height: image.height,
    format,
    bytes: image.bytes,
    r2Key: renderR2Key(user.id, cacheKey, format),
    ttlMs,
    // Written in the batch that takes the image, and only then (src/lib/quota.ts CHARGE_RECORD_*).
    ...(request.chargeOnce === true ? { chargeRecord: { bucket: emailChargeBucket(user.id, cacheKey), ttlMs: EMAIL_FIELDS.chargeMemoryDays * DAY_MS } } : {}),
  };

  const fresh: Card = { image, cached: false, body: output.bytes, warnings: output.warnings, usage: null, creditsUsed: 0, outcome: 'duplicate' };
  // A failed write must not fail a render that was paid for: the next request
  // finds no object, renders again and is told "duplicate" by the ledger.
  const store = (): Promise<void> =>
    storeImage(env.BUCKET, image, output.bytes).catch((error: unknown) => console.error(`storing ${cacheKey} failed:`, error));

  if (prepaid) {
    // Paid for once already: a ledger row without a charge, so the copy expires and is cleaned up like any other.
    if ((await recordUnchargedRender(env.DB, user, ledgerEntry, now)) === 'recorded') {
      await store();
      return { ...fresh, outcome: 'rerendered' };
    }
  } else {
    const charge = await chargeRender(env.DB, user, ledgerEntry, now);
    if (charge.status === 'quota_exceeded') throw quotaExceededError(env, charge.usage);
    if (charge.status === 'charged') {
      await store();
      const percent = charge.crossed100 ? 100 : charge.crossed90 ? 90 : null;
      if (percent !== null) background(sendQuotaEmail(env, user, percent, charge.usage));
      return { ...fresh, usage: charge.usage, creditsUsed: 1, outcome: 'charged' };
    }
  }

  // duplicate: the ledger already covers this card (a concurrent request, or an
  // earlier charge whose object never reached R2). Serve it without charging and
  // make sure the object exists, expiring together with the ledger row. It never
  // writes an email image's charge record: an image row says 'plan' from its
  // claim, before anything is taken, so the row is no proof that it was paid.
  const ledger = await first<{ created_at: number; expires_at: number }>(
    env.DB,
    'SELECT created_at, expires_at FROM renders WHERE cache_key = ?1 AND user_id = ?2',
    cacheKey,
    user.id,
  );
  if (ledger && ledger.expires_at > now) {
    image.createdAt = ledger.created_at;
    image.expiresAt = ledger.expires_at;
    if (!(await findStoredCard(env, request, cacheKey, now, false))) await store();
  }
  return fresh;
}

/**
 * The card for a request: from R2 when it is cached, otherwise rendered,
 * charged and stored. Throws ApiError (402 quota_exceeded, render errors).
 */
export async function getCard(
  env: Env,
  background: Background,
  request: CardRequest,
  options: { now: number; withBody: boolean; cacheKey?: string },
): Promise<Card> {
  // The routes refuse a size a starter is not laid out for while parsing; this keeps every caller to it.
  assertTemplateSize(request.template, request.size, templateOptions(env));
  const cacheKey = options.cacheKey ?? (await cardCacheKey(request));
  const stored = await findStoredCard(env, request, cacheKey, options.now, options.withBody);
  if (stored) return { image: stored.image, cached: true, body: stored.body, warnings: [], usage: null, creditsUsed: 0, outcome: 'cached' };
  return renderAndCharge(env, background, request, cacheKey, options.now);
}
