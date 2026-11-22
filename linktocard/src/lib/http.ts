/**
 * Request and response plumbing shared by the routers: capped body reading,
 * JSON parsing with useful messages, image response headers, conditional
 * requests and background work.
 */
import type { Context } from 'hono';
import { CONTENT_TYPES, HTTP_CACHE, LIMITS, type ImageFormat } from '../config';
import type { AppEnv, UsageSummary } from '../types';
import { ApiError } from './errors';

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Epoch milliseconds -> ISO 8601 (UTC), the only timestamp format in JSON responses. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

/** UsageSummary as it appears in JSON: the period bounds become ISO strings. */
export type UsageJson = Omit<UsageSummary, 'period_start' | 'period_end'> & { period_start: string; period_end: string };

export function usageJson(usage: UsageSummary): UsageJson {
  return { ...usage, period_start: iso(usage.period_start), period_end: iso(usage.period_end) };
}

/** Number of Unicode code points, the unit every documented text limit uses. */
export function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/**
 * Reads a request body and stops as soon as it exceeds the cap. Content-Length
 * is only a shortcut: a chunked or lying request is still cut off by the
 * bytes actually received.
 */
export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = (): ApiError =>
    new ApiError('payload_too_large', `The request body may be at most ${maxBytes} bytes.`, { details: { max_bytes: maxBytes } });
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) throw tooLarge();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads a JSON object body under the shared size cap. Every failure says what to fix. */
export async function readJsonObject(request: Request, maxBytes: number = LIMITS.maxRequestBodyBytes): Promise<JsonObject> {
  const bytes = await readBodyBytes(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError('invalid_request', 'The request body must be JSON encoded as UTF-8.');
  }
  if (text.trim() === '') throw new ApiError('invalid_request', 'The request body is empty. Send a JSON object.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'syntax error';
    throw new ApiError('invalid_request', `The request body is not valid JSON: ${reason}`);
  }
  if (!isJsonObject(parsed)) {
    throw new ApiError('invalid_request', 'The request body must be a JSON object, for example {"template": "blog"}.');
  }
  return parsed;
}

/** Rejects fields the endpoint does not know, which is how a typo such as "tempalte" gets noticed. */
export function assertKnownFields(body: JsonObject, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const names = unknown.map((key) => `"${key}"`).join(', ');
  throw new ApiError('invalid_request', `Unknown field${unknown.length > 1 ? 's' : ''} ${names}. Allowed fields: ${allowed.join(', ')}.`, {
    details: { unknown_fields: unknown },
  });
}

/** A name for a key, site or template: collapsed whitespace, 1..maxNameChars characters. */
export function cleanName(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ApiError('invalid_request', `"name" is required: give the ${what} a name.`);
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) throw new ApiError('invalid_request', `Give the ${what} a name.`);
  if (codePointLength(cleaned) > LIMITS.maxNameChars) {
    throw new ApiError('invalid_request', `A ${what} name can be at most ${LIMITS.maxNameChars} characters.`);
  }
  return cleaned;
}

/* ------------------------------------------------------------------ */
/* Image responses                                                     */
/* ------------------------------------------------------------------ */

export function etagFor(id: string): string {
  return `"${id}"`;
}

/** True when If-None-Match names this ETag (weak comparison, as RFC 9110 asks for GET and HEAD). */
export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim().replace(/^W\//, '');
    return value === '*' || value === etag;
  });
}

/** Browser and edge lifetime of a stored image: a day at most, never beyond the image's own expiry. */
export function imageMaxAge(expiresAt: number, now: number): number {
  return Math.max(0, Math.min(HTTP_CACHE.imageMaxAgeSeconds, Math.floor((expiresAt - now) / 1000)));
}

export interface ImageHeaderInput {
  format: ImageFormat;
  etag: string;
  cacheControl: string;
  cache: 'hit' | 'miss';
  /** Known byte length; omitted when the body is not known (HEAD before the first render). */
  bytes?: number;
}

export function imageHeaders(input: ImageHeaderInput): Headers {
  const headers = new Headers({
    'content-type': CONTENT_TYPES[input.format],
    'cache-control': input.cacheControl,
    etag: input.etag,
    'x-ltc-cache': input.cache,
    // Cards are embedded by other origins (meta tags, <img>); say so explicitly.
    'cross-origin-resource-policy': 'cross-origin',
  });
  if (input.bytes !== undefined) headers.set('content-length', String(input.bytes));
  return headers;
}

/** 304 for a client that already holds this exact image. */
export function notModified(headers: Headers): Response {
  const kept = new Headers(headers);
  kept.delete('content-length');
  kept.delete('content-type');
  return new Response(null, { status: 304, headers: kept });
}

/* ------------------------------------------------------------------ */
/* Background work                                                     */
/* ------------------------------------------------------------------ */

export type Background = (work: Promise<unknown>) => void;

/**
 * Work that must neither delay nor fail the response (emails, edge-cache
 * writes). Failures are logged and swallowed.
 */
export function backgroundFor(c: Context<AppEnv>): Background {
  return (work) => {
    const guarded = work.catch((error: unknown) => console.error('background task failed:', error));
    try {
      c.executionCtx.waitUntil(guarded);
    } catch {
      // No ExecutionContext (a router called directly in a unit test): the promise still runs.
    }
  };
}
