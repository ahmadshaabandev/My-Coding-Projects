/**
 * Customer fonts (paid plans): rows in D1, bytes in R2 under f/<userId>/<fontId>.
 *
 * A font is accepted only after it survives a real render, so a file that the
 * layout engine cannot parse is refused at upload instead of breaking every
 * card that names its family.
 */
import { getPlan } from '../billing/plans';
import { all, first, run } from '../db/client';
import { renderCard } from '../render';
import { FONTS, bundledFamily } from '../render/fonts';
import type { Env, FontRow, LoadedFont, RenderDeps, UserRow } from '../types';
import { randomId, sha256Hex } from './crypto';
import { ApiError } from './errors';

export type FontFormat = FontRow['format'];
export type FontStyle = FontRow['style'];

export interface FontDescriptor {
  family: string;
  weight: number;
  style: FontStyle;
}

const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const FONT_STYLES: readonly FontStyle[] = ['normal', 'italic'];
const FONT_KEY_PREFIX = 'f/';

/* The same ArrayBuffer must be handed to the renderer on every call (it memoises
 * parsed fonts by buffer identity), so bytes are kept per isolate, bounded by size. */
const BUFFER_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const buffers = new Map<string, ArrayBuffer>();
let bufferBytes = 0;

function forget(fontId: string): void {
  const data = buffers.get(fontId);
  if (!data) return;
  bufferBytes -= data.byteLength;
  buffers.delete(fontId);
}

function remember(fontId: string, data: ArrayBuffer): void {
  forget(fontId);
  buffers.set(fontId, data);
  bufferBytes += data.byteLength;
  while (bufferBytes > BUFFER_CACHE_MAX_BYTES) {
    const oldest = buffers.keys().next().value as string;
    bufferBytes -= buffers.get(oldest)!.byteLength;
    buffers.delete(oldest);
  }
}

async function fontBuffer(bucket: R2Bucket, row: FontRow): Promise<ArrayBuffer | null> {
  const cached = buffers.get(row.id);
  if (cached) {
    // Re-insert so that Map order is recency order.
    buffers.delete(row.id);
    buffers.set(row.id, cached);
    return cached;
  }
  const object = await bucket.get(row.r2_key);
  if (!object) return null;
  const data = await object.arrayBuffer();
  remember(row.id, data);
  return data;
}

/** Custom fonts are a paid feature: Free accounts can neither upload nor render with them. */
export function fontsEnabled(user: Pick<UserRow, 'plan'>): boolean {
  return getPlan(user.plan).fonts.maxFiles > 0;
}

/** The account's fonts in a stable order (the renderer's font cache depends on it). */
export function listFonts(db: D1Database, userId: string): Promise<FontRow[]> {
  return all<FontRow>(db, 'SELECT * FROM fonts WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id', userId);
}

/** RenderDeps.loadFonts for one account: the fonts whose family a template names, matched case-insensitively. */
export function createFontLoader(env: Pick<Env, 'DB' | 'BUCKET'>, userId: string): NonNullable<RenderDeps['loadFonts']> {
  return async (families) => {
    const wanted = new Set(families.map((family) => family.toLowerCase()));
    const rows = (await listFonts(env.DB, userId)).filter((row) => wanted.has(row.family.toLowerCase()));
    const loaded: LoadedFont[] = [];
    for (const row of rows) {
      const data = await fontBuffer(env.BUCKET, row);
      // A row without its object is skipped; the render then warns that the family is not available.
      if (data) loaded.push({ family: row.family, weight: row.weight, style: row.style, data });
    }
    return loaded;
  };
}

/** Decides the font type from the first four bytes; the Content-Type header is not trusted. */
export function sniffFontFormat(bytes: Uint8Array): FontFormat | 'woff2' | 'collection' | null {
  if (bytes.byteLength < 4) return null;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (tag === '\u0000\u0001\u0000\u0000' || tag === 'true') return 'ttf';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'ttcf') return 'collection';
  return null;
}

/** Validates the ?family=&weight=&style= of an upload. */
export function parseFontDescriptor(input: { family?: string; weight?: string; style?: string }): FontDescriptor {
  const family = (input.family ?? '').replace(/\s+/g, ' ').trim();
  if (!FAMILY_RE.test(family)) {
    throw new ApiError(
      'invalid_request',
      'Pass ?family= with the name you will use in CSS font-family: 1 to 64 letters, digits, spaces, "-" or "_", starting with a letter or digit.',
    );
  }
  // Generic keywords and bundled names (including the per-script subsets the renderer registers) stay ours.
  const reserved = bundledFamily(family) !== undefined || FONTS.some((font) => font.name.toLowerCase() === family.toLowerCase());
  if (reserved) {
    throw new ApiError('invalid_request', `"${family}" is a built-in font family. Choose another family name for your upload.`);
  }
  const weight = Number(input.weight ?? '400');
  if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) {
    throw new ApiError('invalid_request', '?weight= must be one of 100, 200, 300, 400, 500, 600, 700, 800, 900.');
  }
  const style = FONT_STYLES.find((candidate) => candidate === (input.style ?? 'normal'));
  if (!style) throw new ApiError('invalid_request', '?style= must be normal or italic.');
  return { family, weight, style };
}

const refuseImages: RenderDeps['fetchImage'] = () => Promise.reject(new Error('the font check loads no images'));

/**
 * Renders a line of text in the font, under the normal render limits. Throws
 * invalid_request when the engine cannot use the file.
 */
export async function assertFontRenders(font: LoadedFont): Promise<void> {
  const css = `.probe { font-family: "${font.family}"; font-weight: ${font.weight}; font-style: ${font.style}; font-size: 48px; }`;
  let warnings: string[];
  try {
    const output = await renderCard(
      { html: '<div class="probe">Aa Bb 0123</div>', css, data: {}, width: 400, height: 200, format: 'png', watermark: 'none' },
      { fetchImage: refuseImages, loadFonts: () => Promise.resolve([font]) },
    );
    warnings = output.warnings;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError('invalid_request', 'This file could not be used as a font: a test render with it failed. Upload a valid TTF, OTF or WOFF file.', {
      details: { reason },
    });
  }
  if (warnings.some((warning) => warning.startsWith('Font families not available'))) {
    throw new ApiError('invalid_request', 'This file could not be used as a font: the renderer did not accept it.');
  }
}

function conflictAtCap(maxFiles: number): ApiError {
  return new ApiError('conflict', `Your plan allows ${maxFiles} font files. Delete one to upload another.`, {
    details: { max_files: maxFiles },
  });
}

/**
 * Stores an uploaded font for a paid account. The caller has already capped
 * the body at the plan's per-file size.
 */
export async function uploadFont(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  user: UserRow,
  descriptor: FontDescriptor,
  bytes: Uint8Array,
  now: number,
): Promise<FontRow> {
  const { maxFiles } = getPlan(user.plan).fonts;
  const format = sniffFontFormat(bytes);
  if (format === 'woff2') {
    throw new ApiError('invalid_request', 'WOFF2 fonts are not supported by the renderer. Convert the file to WOFF, TTF or OTF and upload that.');
  }
  if (format === 'collection') {
    throw new ApiError('invalid_request', 'Font collections (.ttc) are not supported. Upload a single TTF, OTF or WOFF font.');
  }
  if (format === null) {
    throw new ApiError('invalid_request', 'This file is not a font. Upload a TTF, OTF or WOFF file.');
  }

  const existing = await listFonts(env.DB, user.id);
  if (existing.length >= maxFiles) throw conflictAtCap(maxFiles);
  const { family, weight, style } = descriptor;
  if (existing.some((row) => row.family.toLowerCase() === family.toLowerCase() && row.weight === weight && row.style === style)) {
    throw new ApiError('conflict', `You already have "${family}" ${weight} ${style}. Delete it first to replace it.`);
  }

  // Copy into a buffer of its own: the renderer keeps a reference to it.
  const data = bytes.slice().buffer;
  await assertFontRenders({ family, weight, style, data });

  const id = randomId('f');
  const row: FontRow = {
    id,
    user_id: user.id,
    family,
    weight,
    style,
    format,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    r2_key: `${FONT_KEY_PREFIX}${user.id}/${id}`,
    created_at: now,
    deleted_at: null,
  };
  await env.BUCKET.put(row.r2_key, data, { httpMetadata: { contentType: `font/${format}` } });
  // The cap is re-checked inside the INSERT so concurrent uploads cannot overshoot it.
  const inserted = await run(
    env.DB,
    `INSERT INTO fonts (id, user_id, family, weight, style, format, bytes, sha256, r2_key, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE (SELECT COUNT(*) FROM fonts WHERE user_id = ?2 AND deleted_at IS NULL) < ?11`,
    row.id,
    row.user_id,
    row.family,
    row.weight,
    row.style,
    row.format,
    row.bytes,
    row.sha256,
    row.r2_key,
    row.created_at,
    maxFiles,
  );
  if (inserted !== 1) {
    await env.BUCKET.delete(row.r2_key);
    throw conflictAtCap(maxFiles);
  }
  remember(row.id, data);
  return row;
}

/** Removes a font and its bytes. False when it does not exist or belongs to another account. */
export async function deleteFont(env: Pick<Env, 'DB' | 'BUCKET'>, userId: string, fontId: string, now: number): Promise<boolean> {
  const row = await first<FontRow>(
    env.DB,
    'UPDATE fonts SET deleted_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL RETURNING *',
    now,
    fontId,
    userId,
  );
  if (!row) return false;
  forget(row.id);
  await env.BUCKET.delete(row.r2_key);
  return true;
}
