/**
 * The OG checker's image probe: HEAD then GET through the guarded fetcher, reading only
 * as much of the file as it takes to learn its size and pixel dimensions (PNG, JPEG,
 * GIF and WebP headers; nothing is decoded).
 */
import { INSPECT } from '../config';
import { discard, type FetchDeps, FetchFailure, guardedFetch, mediaType, readBody, vetUrl, withBudget } from './fetch';
import type { ImageProbe } from './types';

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export interface ImageSize {
  format: ImageFormat;
  width: number;
  height: number;
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value);
}

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'webp';
  return null;
}

function png(b: Uint8Array): [number, number] | null {
  return b.length >= 24 && startsWith(b, ascii('IHDR'), 12) ? [u32be(b, 16), u32be(b, 20)] : null;
}

/** Start-of-frame markers carry the size; C4 (Huffman tables), C8 and CC are not frames. */
function jpeg(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
    } else if (marker === 0xd9 || marker === 0xda) {
      return null;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return i + 8 < b.length ? [u16be(b, i + 7), u16be(b, i + 5)] : null;
    } else {
      const length = u16be(b, i + 2);
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

/** The logical screen, which is what a viewer shows. */
function gif(b: Uint8Array): [number, number] | null {
  return b.length >= 10 ? [u16le(b, 6), u16le(b, 8)] : null;
}

function webp(b: Uint8Array): [number, number] | null {
  if (startsWith(b, ascii('VP8 '), 12)) {
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  }
  if (startsWith(b, ascii('VP8L'), 12)) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (startsWith(b, ascii('VP8X'), 12)) {
    return b.length >= 30 ? [u24le(b, 24) + 1, u24le(b, 27) + 1] : null;
  }
  return null;
}

/** Pixel size from the first bytes of a PNG, JPEG, GIF or WebP file; null for other or truncated files. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const format = sniffImageFormat(bytes);
  if (!format) return null;
  const size = { png, jpeg, gif, webp }[format](bytes);
  if (!size || size[0] < 1 || size[1] < 1) return null;
  return { format, width: size[0], height: size[1] };
}

/** What the checklist needs beyond the public ImageProbe JSON. */
export interface ImageOutcome {
  probe: ImageProbe;
  /** Why the image is not usable (unreachable, blocked, not an image, timeout), or null. */
  error: string | null;
  /** The file is larger than the 8 MB we read and its size was not declared. */
  overReadCap: boolean;
  /** Detected file format, null when not recognised. */
  format: ImageFormat | null;
}

export interface ProbeOptions extends FetchDeps {
  now: () => number;
  timeoutMs?: number;
  maxBytes?: number;
}

const IMAGE_ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.1';
/** JPEG keeps its size after EXIF/ICC segments, which can be large; 1 MB of head covers real files. */
const HEAD_BYTES = 1024 * 1024;

function declaredLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

export function isImageType(type: string | null): boolean {
  return type !== null && type.startsWith('image/');
}

/**
 * HEAD, then GET (one shared time budget). Never throws: what was learned before a
 * failure is kept and the failure is reported in `error`.
 */
export async function probeImage(url: string, options: ProbeOptions): Promise<ImageOutcome> {
  const timeoutMs = options.timeoutMs ?? INSPECT.imageTimeoutMs;
  const maxBytes = options.maxBytes ?? INSPECT.imageMaxBytes;
  const started = options.now();
  const probe: ImageProbe = { url, status: null, content_type: null, bytes: null, width: null, height: null, aspect_ratio: null, response_ms: null };
  const outcome: ImageOutcome = { probe, error: null, overReadCap: false, format: null };
  const request = { accept: IMAGE_ACCEPT, httpsOnly: false, maxRedirects: INSPECT.maxRedirects };

  try {
    vetUrl(url, false);
    await withBudget(
      timeoutMs,
      async (signal) => {
        let headLength: number | null = null;
        try {
          const { response } = await guardedFetch(url, { ...request, method: 'HEAD', signal }, options);
          await discard(response);
          probe.status = response.status;
          probe.content_type = mediaType(response.headers.get('content-type'));
          headLength = declaredLength(response);
          if (response.ok && probe.content_type !== null && !isImageType(probe.content_type)) {
            throw new FetchFailure('not_image', `It is served as ${probe.content_type}, not as an image.`);
          }
        } catch (error) {
          // Servers that mishandle HEAD still get a GET; address and redirect failures do not.
          if (!(error instanceof FetchFailure) || ['blocked', 'dns_failed', 'too_many_redirects', 'not_image'].includes(error.reason)) throw error;
        }

        const { response } = await guardedFetch(url, { ...request, method: 'GET', signal }, options);
        probe.status = response.status;
        probe.content_type = mediaType(response.headers.get('content-type'));
        if (!response.ok) {
          await discard(response);
          throw new FetchFailure('http_error', `The image URL answered HTTP ${response.status}.`, response.status);
        }
        if (!isImageType(probe.content_type)) {
          await discard(response);
          throw new FetchFailure('not_image', `It is served as ${probe.content_type ?? 'an unknown type'}, not as an image.`);
        }
        const declared = declaredLength(response) ?? headLength;
        const read = await readBody(response, {
          maxBytes,
          keepBytes: HEAD_BYTES,
          // With a declared length, the header bytes are all we need.
          enough: declared === null ? undefined : (kept) => readImageSize(kept) !== null,
        });
        probe.bytes = read.complete ? read.bytesRead : declared;
        outcome.overReadCap = read.overCap && declared === null;
        outcome.format = sniffImageFormat(read.kept);
        const size = readImageSize(read.kept);
        if (size) {
          probe.width = size.width;
          probe.height = size.height;
          probe.aspect_ratio = Math.round((size.width / size.height) * 1000) / 1000;
        }
      },
      () => new FetchFailure('timeout', `The image did not finish loading within ${timeoutMs / 1000} s.`),
    );
  } catch (error) {
    outcome.error = error instanceof FetchFailure ? error.message : 'The image could not be fetched.';
    if (error instanceof FetchFailure && error.reason === 'blocked') outcome.error = 'The image address is not on the public internet.';
  }
  probe.response_ms = Math.max(0, options.now() - started);
  return outcome;
}
