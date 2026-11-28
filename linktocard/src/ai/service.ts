/**
 * The AI tools behind the routes of src/routes/ai.ts (AI-SPEC.md sections 4, 6 and 9).
 *
 *   createCoverPreview   free cover preview: Turnstile, per-client limits, a background from the
 *                        model (checked), the cover at 600 x 315 with the preview mark; both kept
 *                        24 hours, so buying the preview reuses that exact background
 *   createCover          final cover (session or API key): 1 credit
 *   createQrPreview      free QR preview, 600 x 600, verified, preview mark
 *   createQr             paid QR code (session or API key): 2048 x 2048 PNG plus the QR layer as SVG, 1 credit
 *   createUpload         a logo or reference image (session)
 *   reportAbuse          the public "Report this QR code" form
 *
 * Credits: an image is charged only once it exists and is stored, through the ledger of every image
 * (src/lib/quota.ts chargeRender: a `renders` row whose cache key is the asset id). Starter and Pro
 * pay from their monthly allowance, then from top-ups; the Free plan only from top-ups
 * (AI.freePlanAllowance false: 402 ai_credits_required otherwise). Nothing is charged for a request
 * that was refused, flagged, unclean, failed or timed out. A Free account's images carry the Free
 * corner mark, like every Free render.
 *
 * No text of a request reaches the model: the prompt is buildPrompt of enums and colours
 * (src/ai/prompt.ts). Title, description and site name are drawn by Satori (src/ai/compose.ts).
 */
import { effectivePlanId, getPlan } from '../billing/plans';
import { quotaRemedy } from '../billing/offers';
import { AI, AI_COVER_SIZES, DAY_MS, type AiCoverSize, type AiLayout, type AiMotif, type AiStyle } from '../config';
import { first, normalizeEmail } from '../db/client';
import { checkForPreview } from '../cards/playground-from-check';
import { ApiError } from '../lib/errors';
import { sendEmail } from '../lib/email';
import { assertKnownFields, codePointLength, iso, usageJson, type Background, type JsonObject } from '../lib/http';
import { planWatermark, quotaExceededError, sendQuotaEmail } from '../lib/images';
import { chargeRender, getUsage } from '../lib/quota';
import { bumpCounter, limitsDisabled } from '../inspect/limits';
import { createEmojiLoader } from '../render/emoji';
import type { Env, UsageSummary, UserRow } from '../types';
import { generateCheckedBackground, assertUploadShape, checkUpload, type UploadPurpose } from './checks';
import { composeCover, type CoverMark, type PixelImage } from './compose';
import { parseLayout, parseMotif, parsePalette, parseStyle, resolveMotif } from './prompt';
import { reserveFreePreview, assertTurnstile } from './limits';
import { composeVerifiedQr, qrLayerSvg, qrMatrix } from './qr';
import { aiAssetUrl, assetBytes, deleteAsset, liveAsset, markCharged, storeAsset, type AiAssetRow } from './storage';
import { checkQrTarget, logAbuse } from './url-safety';

const COVER_PREVIEW_FIELDS = ['check_id', 'url', 'title', 'description', 'site_name', 'style', 'palette', 'motif', 'layout', 'turnstile_token'] as const;
const COVER_FIELDS = ['background_id', 'title', 'description', 'site_name', 'style', 'palette', 'motif', 'layout', 'preset_id', 'logo_id', 'size'] as const;
const QR_PREVIEW_FIELDS = ['url', 'style', 'palette', 'motif', 'turnstile_token'] as const;
const QR_FIELDS = ['url', 'style', 'palette', 'motif', 'background_id'] as const;
const REPORT_FIELDS = ['url_or_id', 'reason', 'email'] as const;

/** Errors that are not the visitor's doing: a free preview they cost is given back. */
const RELEASING: readonly string[] = ['ai_busy', 'ai_unavailable', 'ai_timeout', 'content_flagged', 'not_configured'];

export interface ClientInfo {
  /** The limit key: IPv4 address or IPv6 /64 (src/lib/rate-limit.ts clientIp). */
  client: string;
  /** CF-Connecting-IP, for Turnstile. */
  remoteIp: string | null;
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

function invalid(message: string, field: string): ApiError {
  return new ApiError('invalid_request', message, { details: { field } });
}

/** Control characters and runs of white space become one space. */
function normalise(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f  ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A text field of the request: absent or empty is null; over `max` code points is 400. */
function textField(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`"${field}" must be a string.`, field);
  const text = normalise(value);
  if (text === '') return null;
  if (codePointLength(text) > max) throw invalid(`"${field}" may be at most ${max} characters.`, field);
  return text;
}

/** Page text from a stored check, cut to `max` code points. */
function cut(text: string | null, max: number): string | null {
  if (text === null) return null;
  const clean = normalise(text);
  if (clean === '') return null;
  const points = [...clean];
  return points.length <= max ? clean : `${points.slice(0, max - 3).join('').trimEnd()}...`;
}

function parseCoverSize(value: unknown): AiCoverSize {
  if (value === undefined) return 'cover';
  if (typeof value === 'string' && value in AI_COVER_SIZES) return value as AiCoverSize;
  throw invalid('"size" must be "cover" (1200 x 630) or "header" (1200 x 400).', 'size');
}

interface CoverText {
  title: string;
  description: string | null;
  siteName: string | null;
}

/** Title, description and site name of the stored OG check `checkId` (no new page fetch). */
async function textFromCheck(db: D1Database, checkId: unknown, now: number): Promise<{ text: Partial<CoverText>; page: string }> {
  if (typeof checkId !== 'string') throw invalid('"check_id" must be the id of a check from the preview checker.', 'check_id');
  const result = await checkForPreview(db, checkId, now);
  if (!result) throw new ApiError('not_found', 'This check has expired. Check the page again, then generate the cover.');
  const max = AI.maxChars;
  const text: Partial<CoverText> = {};
  const title = cut(result.preview.title ?? result.og.title ?? result.page.title, max.title);
  if (title) text.title = title;
  text.description = cut(result.preview.description ?? result.og.description ?? result.page.description, max.description);
  text.siteName = cut(result.preview.site_name ?? result.og.site_name ?? result.preview.domain, max.siteName);
  return { text, page: result.final_url || result.url };
}

/** The page a free cover preview is for (its per-page limit): an http(s) URL, normalised, or null. */
function pageKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    url.hash = '';
    return url.href;
  } catch {
    throw invalid('"url" must be the http(s) address of the page.', 'url');
  }
}

function coverText(body: JsonObject, fromCheck: Partial<CoverText>): CoverText {
  const max = AI.maxChars;
  const title = textField(body.title, 'title', max.title) ?? fromCheck.title ?? null;
  if (!title) throw invalid('"title" is required: the text drawn on the cover.', 'title');
  return {
    title,
    description: body.description !== undefined ? textField(body.description, 'description', max.description) : (fromCheck.description ?? null),
    siteName: body.site_name !== undefined ? textField(body.site_name, 'site_name', max.siteName) : (fromCheck.siteName ?? null),
  };
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The tags a page puts in its <head> for this cover. */
export function coverMetaTags(url: string, width: number, height: number, alt: string): string {
  const image = escapeAttribute(url);
  return [
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="${width}">`,
    `<meta property="og:image:height" content="${height}">`,
    `<meta property="og:image:alt" content="${escapeAttribute(alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${image}">`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Credits                                                             */
/* ------------------------------------------------------------------ */

/** Whether the plan in force pays AI images from its monthly allowance (Starter and Pro; Free only if AI.freePlanAllowance). */
export function allowancePaysAi(user: Pick<UserRow, 'plan' | 'cancel_at'>, now: number): boolean {
  return effectivePlanId(user, now) !== 'free' || AI.freePlanAllowance;
}

export function aiCreditsRequiredError(env: Env, usage: UsageSummary): ApiError {
  const remedy = quotaRemedy(env, getPlan(usage.plan));
  return new ApiError(
    'ai_credits_required',
    `AI images are paid from the images of a Starter or Pro plan, or from top-up images. The Free plan's monthly images do not cover them${remedy ? `; to make AI images, ${remedy}` : ''}.`,
    { details: { usage: usageJson(usage) } },
  );
}

/** Before any model call: 402 unless the account can pay one AI image now. */
async function assertCanPay(env: Env, user: UserRow, now: number): Promise<void> {
  const usage = await getUsage(env.DB, user, now);
  const allowance = allowancePaysAi(user, now);
  const available = (allowance ? usage.remaining : 0) + usage.topup_remaining;
  if (available >= AI.creditsPerImage) return;
  throw allowance ? quotaExceededError(env, usage) : aiCreditsRequiredError(env, usage);
}

/**
 * Takes the credit of one stored image through the ledger. When nothing could be taken, the image
 * (and `extra`, the SVG of a QR code) is deleted again and 402 answers. Sends the 90% / 100%
 * allowance notices like every charge.
 */
async function chargeAiImage(env: Env, background: Background, user: UserRow, asset: AiAssetRow, template: string, now: number, extra: AiAssetRow[] = []): Promise<UsageSummary> {
  const fromAllowance = allowancePaysAi(user, now);
  const charge = await chargeRender(
    env.DB,
    user,
    {
      cacheKey: asset.id,
      siteId: null,
      source: 'api',
      template,
      width: asset.width,
      height: asset.height,
      format: 'png',
      bytes: asset.bytes + extra.reduce((sum, row) => sum + row.bytes, 0),
      r2Key: asset.r2_key,
      ttlMs: getPlan(user.plan).cacheDays * DAY_MS,
    },
    now,
    { fromAllowance },
  );
  if (charge.status !== 'charged') {
    for (const row of [...extra, asset]) await deleteAsset(env, row);
    if (charge.status === 'quota_exceeded') throw fromAllowance ? quotaExceededError(env, charge.usage) : aiCreditsRequiredError(env, charge.usage);
    throw new ApiError('internal_error', 'The image could not be charged. Nothing was charged; try again.');
  }
  await markCharged(env.DB, asset.id, AI.creditsPerImage, charge.chargedTo);
  const percent = charge.crossed100 ? 100 : charge.crossed90 ? 90 : null;
  if (percent !== null) background(sendQuotaEmail(env, user, percent, charge.usage));
  return charge.usage;
}

function planMark(user: UserRow): CoverMark {
  return planWatermark(user) === 'none' ? 'none' : 'free';
}

/* ------------------------------------------------------------------ */
/* Backgrounds                                                         */
/* ------------------------------------------------------------------ */

type Tool = 'cover' | 'qr';

interface BackgroundMeta {
  tool?: Tool;
  style?: AiStyle;
  motif?: AiMotif;
  layout?: AiLayout;
  palette?: string[];
}

function metaOf(row: Pick<AiAssetRow, 'meta'>): BackgroundMeta & Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.meta);
    return typeof value === 'object' && value !== null ? (value as BackgroundMeta) : {};
  } catch {
    return {};
  }
}

function pixelImage(row: Pick<AiAssetRow, 'mime' | 'width' | 'height'>, bytes: Uint8Array): PixelImage {
  if (row.mime === 'image/svg+xml') throw new Error('an SVG is not a pixel image');
  return { bytes, mime: row.mime, width: row.width, height: row.height };
}

/**
 * A background named by background_id: an unexpired background of this tool that belongs to this
 * account, or that is behind a free preview (owner NULL; its 64-hex id came with the preview).
 */
async function reusableBackground(env: Env, user: UserRow, id: unknown, tool: Tool, now: number): Promise<{ row: AiAssetRow; image: PixelImage }> {
  const row = await liveAsset(env.DB, id, now);
  if (!row || row.kind !== 'background' || (row.owner_id !== null && row.owner_id !== user.id) || metaOf(row).tool !== tool) {
    throw new ApiError('not_found', 'Background not found. Backgrounds are kept for 24 hours; generate a new one.', { details: { field: 'background_id' } });
  }
  return { row, image: pixelImage(row, await assetBytes(env.BUCKET, row)) };
}

interface NewBackground {
  tool: Tool;
  scope: 'free' | 'account';
  user: UserRow | null;
  style: AiStyle;
  motif: AiMotif;
  layout: AiLayout;
  palette: string[];
  width: number;
  height: number;
  ttlMs: number;
}

async function newBackground(env: Env, background: Background, spec: NewBackground, now: number): Promise<{ row: AiAssetRow; image: PixelImage }> {
  const generated = await generateCheckedBackground(
    env,
    background,
    {
      scope: spec.scope,
      userId: spec.user?.id ?? null,
      spec: { kind: spec.tool, style: spec.style, motif: spec.motif, layout: spec.layout, palette: spec.palette },
      width: spec.width,
      height: spec.height,
    },
    now,
  );
  const { image } = generated;
  const row = await storeAsset(
    env,
    {
      ownerId: spec.user?.id ?? null,
      kind: 'background',
      mime: image.mime,
      width: image.width,
      height: image.height,
      meta: {
        tool: spec.tool,
        style: spec.style,
        motif: spec.motif,
        layout: spec.layout,
        palette: spec.palette,
        model: image.model,
        attempts: generated.attempts,
        estimated_neurons: generated.neurons,
      },
      expiresAt: now + spec.ttlMs,
    },
    image.bytes,
    now,
  );
  return { row, image: { bytes: image.bytes, mime: image.mime, width: image.width, height: image.height } };
}

/** Runs a free preview's work under its reservation: given back when the failure was not the visitor's. */
async function underReservation<T>(release: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError && RELEASING.includes(error.code)) await release().catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Tool 1: covers                                                      */
/* ------------------------------------------------------------------ */

export async function createCoverPreview(env: Env, background: Background, body: JsonObject, client: ClientInfo, now: number): Promise<Record<string, unknown>> {
  assertKnownFields(body, COVER_PREVIEW_FIELDS);
  await assertTurnstile(env, body.turnstile_token, client.remoteIp);
  const fromCheck = body.check_id !== undefined ? await textFromCheck(env.DB, body.check_id, now) : null;
  const text = coverText(body, fromCheck?.text ?? {});
  const page = fromCheck?.page ?? pageKey(body.url);
  const style = parseStyle(body.style);
  const palette = parsePalette(body.palette);
  const motif = resolveMotif(parseMotif(body.motif), text.title);
  const layout = parseLayout(body.layout);

  const reservation = await reserveFreePreview(env, client.client, page, now);
  const ttlMs = AI.freePreviewTtlMs;
  const bg = await underReservation(reservation.release, () =>
    newBackground(env, background, { tool: 'cover', scope: 'free', user: null, style, motif, layout, palette, ...AI.coverSizes.cover.generate, ttlMs }, now),
  );
  const composed = await composeCover({ size: 'cover', layout, text, background: bg.image, mark: 'preview', outputWidth: AI.previewCover.width }, { loadEmoji: createEmojiLoader(env.ASSETS) });
  const preview = await storeAsset(
    env,
    { ownerId: null, kind: 'preview', mime: 'image/png', width: composed.width, height: composed.height, parentId: bg.row.id, meta: { tool: 'cover', layout }, expiresAt: now + ttlMs },
    composed.bytes,
    now,
  );
  return {
    preview_id: preview.id,
    image_url: aiAssetUrl(env, preview.id, 'image/png'),
    width: preview.width,
    height: preview.height,
    expires_at: iso(now + ttlMs),
    background_id: bg.row.id,
    style,
    motif,
    layout,
  };
}

interface PresetRow {
  id: string;
  style: string;
  palette: string;
  motif: string;
  layout: string;
  size: string;
  logo_id: string | null;
}

async function loadPreset(db: D1Database, userId: string, id: unknown): Promise<PresetRow> {
  const row = typeof id === 'string' && /^aip_[A-Za-z0-9_-]{1,64}$/.test(id) ? await first<PresetRow>(db, 'SELECT * FROM ai_presets WHERE id = ?1 AND user_id = ?2', id, userId) : null;
  if (!row) throw new ApiError('not_found', 'Preset not found.', { details: { field: 'preset_id' } });
  return row;
}

function presetPalette(row: PresetRow | null): unknown {
  if (!row) return undefined;
  try {
    return JSON.parse(row.palette) as unknown;
  } catch {
    return undefined;
  }
}

async function accountLogo(env: Env, user: UserRow, id: unknown, now: number): Promise<PixelImage | null> {
  if (id === undefined || id === null) return null;
  const row = await liveAsset(env.DB, id, now);
  if (!row || row.kind !== 'logo' || row.owner_id !== user.id) {
    throw new ApiError('not_found', 'Logo not found. Uploads are kept for 24 hours unless a preset keeps them; upload it again.', { details: { field: 'logo_id' } });
  }
  return pixelImage(row, await assetBytes(env.BUCKET, row));
}

export async function createCover(env: Env, background: Background, user: UserRow, body: JsonObject, now: number): Promise<Record<string, unknown>> {
  assertKnownFields(body, COVER_FIELDS);
  const preset = body.preset_id !== undefined ? await loadPreset(env.DB, user.id, body.preset_id) : null;
  const text = coverText(body, {});
  const size = parseCoverSize(body.size ?? preset?.size);
  const layout = parseLayout(body.layout ?? preset?.layout);
  const logo = await accountLogo(env, user, body.logo_id ?? preset?.logo_id ?? undefined, now);
  const reuse = body.background_id !== undefined;
  // Validated before anything is spent, also when a reused background makes them unused.
  const style = reuse && body.style === undefined && !preset ? null : parseStyle(body.style ?? preset?.style);
  const palette = parsePalette(body.palette ?? presetPalette(preset));
  const motif = parseMotif(body.motif ?? preset?.motif);

  await assertCanPay(env, user, now);
  const bg = reuse
    ? await reusableBackground(env, user, body.background_id, 'cover', now)
    : await newBackground(
        env,
        background,
        { tool: 'cover', scope: 'account', user, style: style!, motif: resolveMotif(motif, text.title), layout, palette, ...AI.coverSizes[size].generate, ttlMs: AI.backgroundTtlMs },
        now,
      );

  const composed = await composeCover({ size, layout, text, background: bg.image, logo, mark: planMark(user) }, { loadEmoji: createEmojiLoader(env.ASSETS) });
  const cover = await storeAsset(
    env,
    { ownerId: user.id, kind: 'cover', mime: 'image/png', width: composed.width, height: composed.height, parentId: bg.row.id, meta: { tool: 'cover', size, layout, reused_background: reuse }, expiresAt: null },
    composed.bytes,
    now,
  );
  const usage = await chargeAiImage(env, background, user, cover, 'ai-cover', now);
  const url = aiAssetUrl(env, cover.id, 'image/png');
  return {
    id: cover.id,
    url,
    width: cover.width,
    height: cover.height,
    size,
    background_id: bg.row.id,
    credits_used: AI.creditsPerImage,
    meta_tags: coverMetaTags(url, cover.width, cover.height, text.title.slice(0, AI.maxChars.alt)),
    created_at: iso(now),
    usage: usageJson(usage),
  };
}

/* ------------------------------------------------------------------ */
/* Tool 3: QR codes                                                    */
/* ------------------------------------------------------------------ */

export async function createQrPreview(env: Env, background: Background, body: JsonObject, client: ClientInfo, now: number): Promise<Record<string, unknown>> {
  assertKnownFields(body, QR_PREVIEW_FIELDS);
  await assertTurnstile(env, body.turnstile_token, client.remoteIp);
  const style = parseStyle(body.style);
  const palette = parsePalette(body.palette);
  const motif = resolveMotif(parseMotif(body.motif), '');
  const text = await checkQrTarget(env, body.url, null, now);
  // The size check needs no model: a URL whose code cannot be drawn is refused before anything is spent.
  qrMatrix(text);

  const reservation = await reserveFreePreview(env, client.client, text, now);
  const ttlMs = AI.freePreviewTtlMs;
  const bg = await underReservation(reservation.release, () =>
    newBackground(env, background, { tool: 'qr', scope: 'free', user: null, style, motif, layout: 'center', palette, ...AI.qrBackground, ttlMs }, now),
  );
  const verified = await composeVerifiedQr(text, bg.image, { side: AI.qrPreviewSide, palette, mark: 'preview' });
  const preview = await storeAsset(
    env,
    { ownerId: null, kind: 'preview', mime: 'image/png', width: verified.side, height: verified.side, parentId: bg.row.id, meta: { tool: 'qr', attempt: verified.attempt, step: verified.composition.step.name }, expiresAt: now + ttlMs },
    verified.png,
    now,
  );
  return {
    preview_id: preview.id,
    image_url: aiAssetUrl(env, preview.id, 'image/png'),
    width: verified.side,
    height: verified.side,
    verified: true,
    attempt: verified.attempt,
    encoded_url: text,
    expires_at: iso(now + ttlMs),
    background_id: bg.row.id,
    style,
    motif,
  };
}

export async function createQr(env: Env, background: Background, user: UserRow, body: JsonObject, now: number): Promise<Record<string, unknown>> {
  assertKnownFields(body, QR_FIELDS);
  const reuse = body.background_id !== undefined;
  const style = reuse && body.style === undefined ? null : parseStyle(body.style);
  const motif = resolveMotif(parseMotif(body.motif), '');
  const text = await checkQrTarget(env, body.url, user.id, now);
  const matrix = qrMatrix(text);

  await assertCanPay(env, user, now);
  const bg = reuse
    ? await reusableBackground(env, user, body.background_id, 'qr', now)
    : await newBackground(env, background, { tool: 'qr', scope: 'account', user, style: style!, motif, layout: 'center', palette: parsePalette(body.palette), ...AI.qrBackground, ttlMs: AI.backgroundTtlMs }, now);
  // A reused background keeps the palette it was made with unless the request names one.
  const palette = body.palette !== undefined ? parsePalette(body.palette) : reuse ? parsePalette(metaOf(bg.row).palette ?? []) : parsePalette(undefined);

  const verified = await composeVerifiedQr(text, bg.image, { side: AI.qrPaidSide, palette, mark: planMark(user) });
  const png = await storeAsset(
    env,
    {
      ownerId: user.id,
      kind: 'qr',
      mime: 'image/png',
      width: verified.side,
      height: verified.side,
      parentId: bg.row.id,
      meta: { tool: 'qr', attempt: verified.attempt, step: verified.composition.step.name, module_fraction: Math.round(verified.composition.moduleFraction * 1000) / 1000 },
      expiresAt: null,
    },
    verified.png,
    now,
  );
  const svgText = qrLayerSvg(matrix, verified.composition.colours);
  const svg = await storeAsset(
    env,
    { ownerId: user.id, kind: 'qr_svg', mime: 'image/svg+xml', width: matrix.size + 2 * AI.qr.quietZoneModules + 2, height: matrix.size + 2 * AI.qr.quietZoneModules + 2, parentId: png.id, meta: { tool: 'qr' }, expiresAt: null },
    new TextEncoder().encode(svgText),
    now,
  );
  const usage = await chargeAiImage(env, background, user, png, 'ai-qr', now, [svg]);
  return {
    id: png.id,
    png_url: aiAssetUrl(env, png.id, 'image/png'),
    svg_url: aiAssetUrl(env, svg.id, 'image/svg+xml'),
    width: verified.side,
    height: verified.side,
    verified: true,
    attempt: verified.attempt,
    encoded_url: text,
    background_id: bg.row.id,
    credits_used: AI.creditsPerImage,
    created_at: iso(now),
    usage: usageJson(usage),
  };
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

export async function createUpload(env: Env, background: Background, user: UserRow, form: FormData, now: number): Promise<Record<string, unknown>> {
  const purpose = form.get('purpose');
  if (purpose !== 'logo' && purpose !== 'reference') throw invalid('"purpose" must be "logo" or "reference".', 'purpose');
  if (purpose === 'reference' && !AI.referencesEnabled) {
    throw new ApiError('invalid_request', 'Reference images are not switched on yet.', { details: { field: 'purpose', reason: 'references_disabled' } });
  }
  if (form.get('rights_confirmed') !== 'true') {
    throw invalid('Confirm that you own this image or may use it: send "rights_confirmed" with the value "true".', 'rights_confirmed');
  }
  const file = form.get('file');
  if (typeof file === 'string' || file === null) throw invalid('"file" must be the image file (PNG or JPEG).', 'file');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = assertUploadShape(bytes, purpose as UploadPurpose);
  await checkUpload(env, background, { bytes, mime: header.mime }, purpose as UploadPurpose, now);
  // The file name is never stored: it is user text and has no use here.
  const row = await storeAsset(
    env,
    { ownerId: user.id, kind: purpose, mime: header.mime, width: header.width, height: header.height, meta: { purpose }, expiresAt: now + AI.uploadTtlMs },
    bytes,
    now,
  );
  return { id: row.id, purpose, width: row.width, height: row.height, bytes: row.bytes, expires_at: iso(now + AI.uploadTtlMs) };
}

/* ------------------------------------------------------------------ */
/* Abuse reports                                                       */
/* ------------------------------------------------------------------ */

export async function reportAbuse(env: Env, background: Background, body: JsonObject, client: ClientInfo, now: number): Promise<void> {
  assertKnownFields(body, REPORT_FIELDS);
  const target = textField(body.url_or_id, 'url_or_id', AI.abuse.maxTargetChars);
  if (!target) throw invalid('"url_or_id" is required: the address in the QR code, or the image link.', 'url_or_id');
  const reason = textField(body.reason, 'reason', AI.abuse.maxReasonChars);
  if (!reason) throw invalid('"reason" is required: what is wrong with it.', 'reason');
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    email = normalizeEmail(body.email);
    if (!email) throw invalid('"email" is not a valid email address.', 'email');
  }
  if (!limitsDisabled(env)) {
    const day = Math.floor(now / DAY_MS);
    if ((await bumpCounter(env.DB, `ai-report:${client.client}:${day}`, (day + 2) * DAY_MS)) > AI.abuse.reportsPerIpPerDay) {
      throw new ApiError('rate_limited', `At most ${AI.abuse.reportsPerIpPerDay} reports a day can be sent from one address. Write to ${env.SUPPORT_EMAIL} instead.`);
    }
  }
  await logAbuse(env.DB, { kind: 'report', target, reason, email }, now);
  const lines = [`Target: ${target}`, `Reason: ${reason}`, `Reply to: ${email ?? '(none given)'}`, `Received: ${new Date(now).toISOString()}`];
  background(
    sendEmail(env, {
      to: env.SUPPORT_EMAIL,
      subject: 'Link To Card: AI image abuse report',
      text: `${lines.join('\n')}\n`,
      html: `<!doctype html><html lang="en"><body><pre>${lines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`,
      ...(email ? { replyTo: email } : {}),
    }).then((result) => {
      if (!result.ok) console.error(`abuse report email was not sent: ${result.error}`);
    }),
  );
}

/* ------------------------------------------------------------------ */
/* /api/config                                                         */
/* ------------------------------------------------------------------ */

/** The "ai" block of GET /api/config: what the tool pages need. Only `enabled: false` while AI_ENABLED is off. */
export function aiConfig(env: Env, enabled: boolean): Record<string, unknown> {
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
    styles: Object.keys(AI.styles),
    motifs: ['auto', ...Object.keys(AI.motifs)],
    layouts: ['left', 'center'],
    sizes: Object.entries(AI.coverSizes).map(([id, size]) => ({ id, width: size.width, height: size.height })),
    max_palette_colours: AI.maxPaletteColours,
    max_chars: { title: AI.maxChars.title, description: AI.maxChars.description, site_name: AI.maxChars.siteName },
    free_previews_per_day: AI.freePreviewsPerIpPerDay,
    free_previews_per_page_per_day: AI.freePreviewsPerPagePerIpPerDay,
    preview_hours: AI.freePreviewTtlMs / 3_600_000,
    credits_per_image: AI.creditsPerImage,
    free_plan_allowance: AI.freePlanAllowance,
    qr: { max_url_chars: AI.qr.maxUrlChars, preview_side: AI.qrPreviewSide, paid_side: AI.qrPaidSide },
    uploads: {
      types: [...AI.uploads.types],
      logo: { max_bytes: AI.uploads.maxLogoBytes, max_side: AI.uploads.maxLogoSide },
      reference: AI.referencesEnabled ? { max_bytes: AI.uploads.maxReferenceBytes, max_side: AI.uploads.maxReferenceSide, max_count: AI.uploads.maxReferences } : null,
    },
  };
}
