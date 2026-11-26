/**
 * The PDF toolkit under /v1/pdf-tools: browser-free operations on existing PDFs
 * (src/pdftools/*, @cantoo/pdf-lib).
 *
 *   POST /v1/pdf-tools/{op}   API key; op is one of PDF_TOOLKIT.ops
 *
 * Mounted before the API-key routes, which share the /v1 prefix. Unless PDF_TOOLKIT_ENABLED is
 * "true", every method and path below /v1/pdf-tools answers 503 not_configured before anything
 * else (src/lib/features.ts).
 *
 * Body: JSON (src/pdftools/request.ts), at most PDF_TOOLKIT.maxRequestBodyBytes, or
 * multipart/form-data under the same cap, with the files as uploads:
 *   files    one file part per input file, in order
 *   image    stamp only: the image file
 *   options  one text part: a JSON object with the operation's other fields ({"ranges": "1-3"})
 *
 * Input files, read one after another, so a request never holds more than its input budget
 * (PDF_TOOLKIT.maxInputBytes for all files together; an image also PDF_TOOLKIT.maxImageBytes):
 *   base64 / uploads  as sent
 *   pdf_id            one of the caller's own stored PDFs: its renders-ledger row must be paid
 *                     and unexpired, then the file is read from R2 (r/<account>/<id>.pdf)
 *   url               downloaded under the rules of the image fetcher (src/render/proxy.ts):
 *                     http(s) only, default port, no credentials, no internal names, every
 *                     redirect hop checked again with the addresses its host resolves to over
 *                     DNS, LIMITS.imageMaxRedirects, LIMITS.imageFetchTimeoutMs; and, like the
 *                     images of PDF documents (src/pdf/assets.ts), never one of Link To Card's
 *                     own hosts, on any hop. The same residual DNS-rebinding gap applies.
 *
 * Order: kill switch, RL_IP, API key, RL_PDF_TOOLS (per key), body checks, a 402 pre-check
 * (nothing is downloaded without an image left), the inputs, the operation (Free plan: the free
 * mark on every page), units (pdfToolkitUnits per output file, summed), a second 402 check of
 * that block, the ledger claim of the first file (and 'pending' rows for the further files of a
 * split), the files written to R2, the charge as ONE block (chargeClaimedPdf), the further
 * files labelled paid. A result is written before it is charged, so a charged result is always
 * stored; one that ends up not charged is deleted again, and a request cut off in between leaves
 * only pending rows, which expire with their files (src/lib/cleanup.ts).
 *
 * Every result has a random id and every successful request counts: identical requests are not
 * served from a cache (an encrypted result would differ anyway). "fields" writes nothing and
 * counts nothing, but is rate limited like the rest.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { requireApiKey } from '../auth/middleware';
import { PLAN_ORDER, formatCount, getPlan } from '../billing/plans';
import { DAY_MS, LIMITS, PDF, PDF_TOOLKIT, pdfToolkitUnits, type PdfToolkitOp } from '../config';
import { toHex } from '../lib/crypto';
import { quotaWarningEmail, sendEmail } from '../lib/email';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled } from '../lib/features';
import { backgroundFor, isJsonObject, iso, parseJsonObject, readBodyBytes, usageJson, type Background, type JsonObject } from '../lib/http';
import {
  chargeClaimedPdf,
  claimPdf,
  claimPdfParts,
  labelPdfParts,
  pdfCapacity,
  readPdfLedger,
  releasePdfClaim,
  releasePdfParts,
  type PdfChargeResult,
  type PdfClaim,
} from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { isOwnHost } from '../pdf/assets';
import { sanitizeFilename } from '../pdf/page';
import { PDF_CONTENT_TYPE, pdfHeaders, pdfR2Key, pdfUrl, planMark, readStoredPdf } from '../pdf/service';
import { assertTotalBytes, isToolkitOp, parseToolkitRequest, runToolkitOp, type FileRef, type PdfOutput, type ToolkitRequest } from '../pdftools';
import { assertPublicHttpUrl, isBlockedIp, resolveHostViaDoh } from '../render/proxy';
import type { AppEnv, Env, UsageSummary, UserRow } from '../types';

export const pdfToolkitRouter = new Hono<AppEnv>();

pdfToolkitRouter.use('*', async (c, next) => {
  assertFeatureEnabled(c.env, 'toolkit');
  await next();
});

const limitIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  await next();
};

const limitKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c.env, 'RL_PDF_TOOLS', c.var.apiKey?.id ?? c.var.user.id);
  await next();
};

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

const megabytes = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

/* ------------------------------------------------------------------ */
/* The request body: JSON or multipart/form-data                       */
/* ------------------------------------------------------------------ */

const MULTIPART_FIELDS = ['files', 'image', 'options'] as const;
const MULTIPART_HELP =
  'A multipart request has one file part "files" per input file (and one "image" part for a stamp image), and one text part "options" ' +
  'holding the other fields as a JSON object, for example {"ranges": "1-3"}.';
/** Base64 of "%PDF-": stands in for each uploaded file while parseToolkitRequest checks the body's shape. */
const UPLOAD_PLACEHOLDER = 'JVBERi0=';

function uploads(form: FormData, name: 'files' | 'image'): File[] {
  return form.getAll(name).map((value) => {
    if (typeof value === 'string') throw invalid(`The form field "${name}" must be a file upload, not text. ${MULTIPART_HELP}`);
    return value;
  });
}

function multipartOptions(form: FormData): JsonObject {
  const parts = form.getAll('options');
  if (parts.length === 0) return {};
  if (parts.length > 1) throw invalid(`Send one "options" part, not ${parts.length}. ${MULTIPART_HELP}`);
  const text = parts[0]!;
  if (typeof text !== 'string') throw invalid(`The form field "options" must be text (a JSON object), not a file. ${MULTIPART_HELP}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(`The form field "options" is not valid JSON: ${error instanceof Error ? error.message : 'syntax error'}`);
  }
  if (!isJsonObject(parsed)) throw invalid(`The form field "options" must be a JSON object, for example {"ranges": "1-3"}.`);
  return parsed;
}

/*
 * The body is up to PDF_TOOLKIT.maxRequestBodyBytes (28 MB) for the files, but what surrounds
 * them is small. JSON.parse and formData() build every element first, and the counts were only
 * checked after: 9 million empty arrays in a 27 MB JSON body took 369 MB of heap, 400,000 empty
 * file parts 400 MB in workerd, both for the cheap 400 "At most 20 files" (security review SEC-5).
 * So the structure is counted in the raw bytes first, in one linear pass that stops at the cap.
 */

/** Counts "[", "{", "," and ":" outside JSON strings, stopping once over `max`. */
export function countJsonTokens(bytes: Uint8Array, max: number): number {
  let count = 0;
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0x22) {
      // A string: jump to its closing quote (one not escaped by an odd run of backslashes).
      let end = i;
      for (;;) {
        end = bytes.indexOf(0x22, end + 1);
        if (end === -1) return count; // unterminated: JSON.parse reports it
        let slashes = 0;
        while (bytes[end - 1 - slashes] === 0x5c) slashes++;
        if (slashes % 2 === 0) break;
      }
      i = end;
    } else if (c === 0x5b || c === 0x7b || c === 0x2c || c === 0x3a) {
      if (++count > max) return count;
    }
  }
  return count;
}

function assertJsonStructure(bytes: Uint8Array): void {
  const max = PDF_TOOLKIT.maxJsonTokens;
  if (countJsonTokens(bytes, max) > max) {
    throw new ApiError(
      'invalid_request',
      `The request body has more than ${formatCount(max)} JSON elements; a PDF toolkit request needs far fewer. Send the files and the operation's fields only.`,
      { details: { reason: 'too_many_elements', max_json_elements: max } },
    );
  }
}

/** Occurrences of `pattern` in `bytes` (Knuth-Morris-Pratt: linear whatever the pattern), stopping once over `max`. */
export function countOccurrences(bytes: Uint8Array, pattern: Uint8Array, max: number): number {
  const m = pattern.length;
  if (m === 0) return 0;
  const fail = new Int32Array(m);
  for (let i = 1, k = 0; i < m; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = fail[k - 1]!;
    if (pattern[i] === pattern[k]) k++;
    fail[i] = k;
  }
  let count = 0;
  for (let i = 0, k = 0; i < bytes.length; i++) {
    while (k > 0 && bytes[i] !== pattern[k]) k = fail[k - 1]!;
    if (bytes[i] === pattern[k]) k++;
    if (k === m) {
      if (++count > max) return count;
      k = fail[k - 1]!;
    }
  }
  return count;
}

/** At most one part per input file, one "image" and one "options" (plus the closing delimiter), counted before formData(). */
function assertMultipartParts(body: Uint8Array, contentType: string): void {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return; // formData() refuses a body without one
  const maxParts = PDF_TOOLKIT.maxFiles + 2;
  const delimiters = countOccurrences(body, new TextEncoder().encode(`--${boundary}`), maxParts + 1);
  if (delimiters > maxParts + 1) {
    throw invalid(
      `A multipart request may have at most ${maxParts} parts: up to ${PDF_TOOLKIT.maxFiles} "files", one "image" and one "options". This one has more. ${MULTIPART_HELP}`,
    );
  }
}

async function readMultipart(request: Request, op: PdfToolkitOp): Promise<ToolkitRequest> {
  const body = await readBodyBytes(request, PDF_TOOLKIT.maxRequestBodyBytes);
  assertMultipartParts(body, request.headers.get('content-type') ?? '');
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
  } catch {
    throw invalid(`The request body could not be read as multipart/form-data. ${MULTIPART_HELP} Or send a JSON body.`);
  }
  const unknown = [...new Set(form.keys())].filter((name) => !(MULTIPART_FIELDS as readonly string[]).includes(name));
  if (unknown.length > 0) throw invalid(`Unknown form field "${unknown[0]}". ${MULTIPART_HELP}`);
  const files = uploads(form, 'files');
  const images = uploads(form, 'image');
  if (images.length > 1) throw invalid(`Send one "image" part, not ${images.length}.`);
  const options = multipartOptions(form);
  if (files.length > 0 && options.files !== undefined) throw invalid('Send the files either as "files" parts or as "files" in "options", not both.');
  if (images.length > 0 && options.image !== undefined) throw invalid('Send the stamp image either as an "image" part or as "image" in "options", not both.');

  // The shape (counts, the operation's fields) is checked by the same parser as a JSON body; the
  // uploads then take the places of their placeholders.
  const shape: JsonObject = { ...options };
  if (files.length > 0) shape.files = files.map(() => ({ base64: UPLOAD_PLACEHOLDER }));
  if (images.length > 0) shape.image = { base64: UPLOAD_PLACEHOLDER };
  const parsed = parseToolkitRequest(op, shape);
  const asRef = async (file: File): Promise<FileRef> => ({ kind: 'base64', bytes: new Uint8Array(await file.arrayBuffer()) });
  return {
    ...parsed,
    files: files.length > 0 ? await Promise.all(files.map(asRef)) : parsed.files,
    ...(images.length > 0 ? { image: await asRef(images[0]!) } : {}),
  };
}

/** JSON unless the request says multipart/form-data (POST /v1/pdf does not insist on a JSON content type either). */
async function readToolkitRequest(request: Request, op: PdfToolkitOp): Promise<ToolkitRequest> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'multipart/form-data') return readMultipart(request, op);
  const bytes = await readBodyBytes(request, PDF_TOOLKIT.maxRequestBodyBytes);
  assertJsonStructure(bytes);
  return parseToolkitRequest(op, parseJsonObject(bytes));
}

/* ------------------------------------------------------------------ */
/* Input files                                                         */
/* ------------------------------------------------------------------ */

type InputKind = 'pdf' | 'image';

const USER_AGENT = 'LinkToCard-FileFetcher/1.0 (+https://linktocard.com/docs)';
const FETCH_HEADERS: Record<InputKind, Record<string, string>> = {
  pdf: { accept: 'application/pdf,*/*;q=0.5', 'user-agent': USER_AGENT },
  image: { accept: 'image/png,image/jpeg;q=0.9,*/*;q=0.5', 'user-agent': USER_AGENT },
};
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/** The URL as given, the address being fetched (different after a redirect) and the file's place in the request. */
interface Hop {
  requested: string;
  current: string;
  label: string;
}

function shorten(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** 422 image_fetch_failed, the code the image fetcher uses, with details { reason, url } like it. */
function fetchFailed(hop: Hop, reason: string, message: string): ApiError {
  const via = hop.current === hop.requested ? '' : ` (reached by a redirect from ${shorten(hop.requested)})`;
  return new ApiError('image_fetch_failed', `${hop.label}.url: ${message}${via}`, { details: { reason, url: hop.requested } });
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** The URL parser writes every IP address as dotted IPv4 or bracketed IPv6; those have no name to resolve. */
function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** The checks of one hop: the image fetcher's URL rules, none of our own hosts, public addresses only. */
async function vetHop(hop: Hop, appUrl: string, fetchImpl: typeof fetch): Promise<URL> {
  let url: URL;
  try {
    url = assertPublicHttpUrl(hop.current);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'bad_url';
    const rules: Record<string, string> = {
      bad_scheme: 'files must be on an https:// or http:// address.',
      bad_port: 'files must be on the default port (443 for https, 80 for http).',
      blocked_host: 'that host is not on the public internet (loopback, private-network and internal names are refused). Use a file at a public address.',
    };
    throw fetchFailed(hop, reason, rules[reason] ?? 'that is not a full http:// or https:// address without a username or password.');
  }
  const host = bareHost(url.hostname);
  if (isOwnHost(host, appUrl)) {
    throw fetchFailed(hop, 'blocked_host', `files cannot be downloaded from Link To Card's own addresses (${host}). Send a PDF stored on your account as "pdf_id".`);
  }
  if (!isIpLiteral(host)) {
    let addresses: string[] = [];
    try {
      addresses = await resolveHostViaDoh(host, fetchImpl);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) throw fetchFailed(hop, 'dns_failed', `could not resolve the host "${shorten(host)}". Check the address.`);
    if (addresses.some(isBlockedIp)) {
      throw fetchFailed(hop, 'blocked_host', `the host "${shorten(host)}" resolves to a loopback, private-network or reserved address. Use a file at a public address.`);
    }
  }
  return url;
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The body, or null (download cancelled) as soon as it is over `maxBytes`. Content-Length is only a shortcut. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get('content-length') ?? '') > maxBytes) {
    await discard(response);
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks, size);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}

interface DownloadCap {
  maxBytes: number;
  tooLarge: () => ApiError;
}

/** Follows redirects by hand, so that every hop passes vetHop. */
async function downloadHops(start: Hop, kind: InputKind, cap: DownloadCap, appUrl: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Uint8Array> {
  let hop = start;
  for (let redirects = 0; ; redirects++) {
    const url = await vetHop(hop, appUrl, fetchImpl);
    let response: Response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', headers: FETCH_HEADERS[kind], signal });
    } catch {
      throw fetchFailed(hop, 'http_error', `could not connect to "${shorten(url.hostname)}".`);
    }
    if (REDIRECT_STATUSES.includes(response.status)) {
      await discard(response);
      if (redirects >= LIMITS.imageMaxRedirects) {
        throw fetchFailed(start, 'too_many_redirects', `the address redirected more than ${LIMITS.imageMaxRedirects} times. Link to the file's final address directly.`);
      }
      const location = response.headers.get('location');
      if (!location) throw fetchFailed(hop, 'http_error', `the host answered HTTP ${response.status} without a Location header.`);
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        next = location;
      }
      hop = { ...hop, current: next };
      continue;
    }
    if (!response.ok) {
      await discard(response);
      throw fetchFailed(hop, 'http_error', `the host answered HTTP ${response.status} for ${shorten(hop.current)}.`);
    }
    const bytes = await readCapped(response, cap.maxBytes);
    if (!bytes) throw cap.tooLarge();
    return bytes;
  }
}

async function download(url: string, label: string, kind: InputKind, cap: DownloadCap, appUrl: string): Promise<Uint8Array> {
  // Read the global at call time and call it unbound (workerd's fetch throws "Illegal invocation"
  // as a method of another object); tests replace it with vi.spyOn.
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  const start: Hop = { requested: url, current: url, label };
  const timeoutMs = LIMITS.imageFetchTimeoutMs;
  const timedOut = (): ApiError => fetchFailed(start, 'timeout', `the file did not finish downloading within ${timeoutMs / 1000} s. Use a faster host, a smaller file, or send it as base64.`);
  const controller = new AbortController();
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(timedOut()));
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The race covers steps that ignore the signal (the DNS lookup); the signal stops the download itself.
    return await Promise.race([downloadHops(start, kind, cap, appUrl, fetchImpl, controller.signal), expired]);
  } catch (error) {
    if (controller.signal.aborted) throw timedOut();
    if (error instanceof ApiError) throw error;
    throw fetchFailed(start, 'http_error', 'the download was interrupted before it completed.');
  } finally {
    clearTimeout(timer);
  }
}

/** 413 for a file that does not fit in what is left of the request's input budget. */
function overBudget(label: string, left: number, details: Record<string, unknown>): ApiError {
  return new ApiError(
    'payload_too_large',
    `${label} does not fit: the files of one request may be ${megabytes(PDF_TOOLKIT.maxInputBytes)} together, and ${megabytes(Math.max(0, left))} were left for it.`,
    { details: { ...details, max_bytes: PDF_TOOLKIT.maxInputBytes } },
  );
}

function downloadCap(url: string, label: string, kind: InputKind, left: number): DownloadCap {
  if (kind === 'image' && PDF_TOOLKIT.maxImageBytes <= left) {
    return {
      maxBytes: PDF_TOOLKIT.maxImageBytes,
      tooLarge: () =>
        new ApiError('payload_too_large', `${label} is larger than ${megabytes(PDF_TOOLKIT.maxImageBytes)}, the limit for one image.`, {
          details: { url, max_bytes: PDF_TOOLKIT.maxImageBytes },
        }),
    };
  }
  return { maxBytes: Math.max(0, left), tooLarge: () => overBudget(label, left, { url }) };
}

/** One of the caller's stored PDFs: a paid, unexpired ledger row of this account, and its object in R2. */
async function storedPdfInput(env: Env, user: UserRow, id: string, label: string, left: number, now: number): Promise<Uint8Array> {
  const notFound = (): ApiError =>
    new ApiError('not_found', `${label}.pdf_id is not one of your stored PDFs, or its storage time has ended. Make the PDF again, or send the file itself.`, {
      details: { pdf_id: id },
    });
  const ledger = await readPdfLedger(env.DB, user.id, id);
  if (!ledger || ledger.charged_to === 'pending' || ledger.expires_at <= now) throw notFound();
  const head = await readStoredPdf(env.BUCKET, user.id, id, now, false);
  if (!head) throw notFound();
  if (head.pdf.bytes > left) throw overBudget(label, left, { pdf_id: id });
  const stored = await readStoredPdf(env.BUCKET, user.id, id, now, true);
  if (!stored?.body) throw notFound();
  const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
  if (bytes.byteLength > left) throw overBudget(label, left, { pdf_id: id });
  return bytes;
}

/** The bytes of every file of the request, in order; the stamp image last. */
async function loadInputs(env: Env, user: UserRow, request: ToolkitRequest, now: number): Promise<{ files: Uint8Array[]; image?: Uint8Array }> {
  const fileKind: InputKind = request.op === 'from-images' ? 'image' : 'pdf';
  const inputs = [
    ...request.files.map((ref, index) => ({ ref, label: `files[${index}]`, kind: fileKind })),
    ...(request.image ? [{ ref: request.image, label: 'image', kind: 'image' as InputKind }] : []),
  ];
  // What came with the request counts first; stored PDFs and downloads get what is left.
  const sent = inputs.flatMap(({ ref }) => (ref.kind === 'base64' ? [ref.bytes] : []));
  assertTotalBytes(sent);
  let left = PDF_TOOLKIT.maxInputBytes - sent.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const loaded: Uint8Array[] = [];
  for (const { ref, label, kind } of inputs) {
    if (ref.kind === 'base64') {
      loaded.push(ref.bytes);
      continue;
    }
    const bytes =
      ref.kind === 'pdf_id' ? await storedPdfInput(env, user, ref.id, label, left, now) : await download(ref.url, label, kind, downloadCap(ref.url, label, kind, left), env.APP_URL);
    left -= bytes.byteLength;
    loaded.push(bytes);
  }
  assertTotalBytes(loaded);
  const files = loaded.slice(0, request.files.length);
  return request.image ? { files, image: loaded[request.files.length]! } : { files };
}

/* ------------------------------------------------------------------ */
/* Quota, storage and charging                                         */
/* ------------------------------------------------------------------ */

const images = (n: number): string => `${formatCount(n)} image${n === 1 ? '' : 's'}`;

/** 402 for a toolkit result: what it counts as, why it does not fit, when the allowance comes back. Same details as PDFs. */
function toolkitQuotaError(env: Pick<Env, 'APP_URL'>, usage: UsageSummary, units: number, atLeast: boolean): ApiError {
  const plan = getPlan(usage.plan);
  const canUpgrade = PLAN_ORDER.indexOf(plan.id) < PLAN_ORDER.length - 1;
  const remedy = [canUpgrade ? 'upgrade' : null, plan.topUps ? 'buy a top-up' : null].filter((part) => part !== null).join(' or ');
  const pricing = `${env.APP_URL.replace(/\/+$/, '')}/pricing`;
  const from = plan.topUps ? 'the monthly allowance or from a single top-up' : 'the monthly allowance';
  return new ApiError(
    'quota_exceeded',
    `${atLeast ? `A PDF toolkit result counts as at least ${images(units)}` : `This result counts as ${images(units)}`} and is charged as one block, from ${from}; not enough is left ` +
      `(${formatCount(usage.remaining)} of the ${formatCount(usage.limit)} images on the ${plan.name} plan this period). ` +
      `The allowance resets on ${iso(usage.period_end)}. Stored PDFs and images keep working; to make new ones now, ${remedy} at ${pricing}.`,
    { details: { usage: usageJson(usage), units_needed: units } },
  );
}

function sendQuotaEmail(env: Env, user: UserRow, percent: 90 | 100, usage: UsageSummary): Promise<void> {
  return sendEmail(env, {
    to: user.email,
    ...quotaWarningEmail({ percent, usage, appUrl: env.APP_URL }),
    // The key images and PDFs use (src/lib/images.ts, src/pdf/service.ts): one notice per account, threshold and period.
    idempotencyKey: `quota-${percent}-${user.id}-${usage.period_start}-${usage.limit}`,
  }).then((result) => {
    if (!result.ok) console.error(`quota ${percent}% email to ${user.id} was not sent: ${result.error}`);
  });
}

/** A result id: 64 hex characters like a PDF cache key (GET /i/<account>/<id>.pdf, pdf_id), but random. */
function newResultId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** "contracts.pdf" and "1-4" -> "contracts-1-4.pdf", the range kept whole within PDF.maxFilenameChars. */
function partFilename(filename: string, range: string): string {
  const suffix = `-${range}`;
  const stem = filename.replace(/\.pdf$/i, '').slice(0, Math.max(1, PDF.maxFilenameChars - '.pdf'.length - suffix.length));
  return sanitizeFilename(`${stem}${suffix}`, filename);
}

interface ResultFile {
  id: string;
  output: PdfOutput & { range?: string };
  units: number;
  filename: string;
}

interface SavedResult {
  files: ResultFile[];
  units: number;
  createdAt: number;
  expiresAt: number;
  usage: UsageSummary;
}

/**
 * Writes one result file with the metadata readStoredPdf (src/pdf/service.ts) reads back, the
 * same as a rendered PDF: GET /i/... serves it until expiresAt and pdf_id can name it.
 */
function putResult(bucket: R2Bucket, userId: string, file: ResultFile, meta: { createdAt: number; expiresAt: number; template: string }): Promise<R2Object> {
  return bucket.put(pdfR2Key(userId, file.id), file.output.bytes, {
    httpMetadata: { contentType: PDF_CONTENT_TYPE },
    customMetadata: {
      expiresAt: String(meta.expiresAt),
      createdAt: String(meta.createdAt),
      pages: String(file.output.pages),
      units: String(file.units),
      filename: file.filename,
      template: meta.template,
    },
  });
}

function logged(what: string): (error: unknown) => void {
  return (error) => console.error(`${what} failed:`, error);
}

/** See the module comment: claim, store, charge as one block, label the further files. */
async function storeAndCharge(env: Env, background: Background, user: UserRow, request: ToolkitRequest, outputs: (PdfOutput & { range?: string })[]): Promise<SavedResult> {
  const files: ResultFile[] = outputs.map((output) => ({
    id: newResultId(),
    output,
    units: pdfToolkitUnits(request.op, output.pages),
    filename: output.range === undefined ? request.filename : partFilename(request.filename, output.range),
  }));
  const units = files.reduce((sum, file) => sum + file.units, 0);
  const at = Date.now();
  // A second look now that the block is known: nothing is written for a result that cannot be paid.
  const capacity = await pdfCapacity(env.DB, user, at);
  if (capacity.largestBlock < units) throw toolkitQuotaError(env, capacity.usage, units, false);
  const ttlMs = capacity.usage.cache_days * DAY_MS;
  const template = `toolkit:${request.op}`;
  const [first, ...further] = files as [ResultFile, ...ResultFile[]];
  const claimed = await claimPdf(
    env.DB,
    user,
    { cacheKey: first.id, siteId: null, source: 'toolkit', template, r2Key: pdfR2Key(user.id, first.id), ttlMs, bytes: first.output.bytes.byteLength },
    at,
  );
  if (claimed.status !== 'claimed') throw new Error(`PDF toolkit: the random result id ${first.id} is already in the ledger`);
  const claim: PdfClaim = claimed.claim;
  const furtherKeys = further.map((file) => file.id);
  const meta = { createdAt: at, expiresAt: at + ttlMs, template };
  // Objects first, then the rows that point at them, so no object is left without its row.
  const removeFiles = async (): Promise<void> => {
    await env.BUCKET.delete(files.map((file) => pdfR2Key(user.id, file.id)));
    await releasePdfParts(env.DB, claim, furtherKeys);
  };

  try {
    await claimPdfParts(
      env.DB,
      claim,
      further.map((file) => ({ cacheKey: file.id, source: 'toolkit', template, bytes: file.output.bytes.byteLength, r2Key: pdfR2Key(user.id, file.id), ttlMs })),
    );
    await Promise.all(files.map((file) => putResult(env.BUCKET, user.id, file, meta)));
  } catch (error) {
    await removeFiles().catch(logged('removing an unstored toolkit result'));
    await releasePdfClaim(env.DB, claim).catch(logged('releasing a toolkit claim'));
    throw error;
  }

  let charge: PdfChargeResult;
  try {
    charge = await chargeClaimedPdf(env.DB, claim, { units, bytes: first.output.bytes.byteLength });
  } catch (error) {
    // Unknown whether the charge committed: a claim that is still pending was not paid and goes
    // with its files; a paid one keeps them.
    const released = await releasePdfClaim(env.DB, claim).catch(() => false);
    if (released) await removeFiles().catch(logged('removing an uncharged toolkit result'));
    throw error;
  }
  if (charge.status !== 'charged') {
    // quota_exceeded: the claim is released (another request spent the images since the check above).
    await removeFiles().catch(logged('removing an uncharged toolkit result'));
    if (charge.status === 'quota_exceeded') throw toolkitQuotaError(env, charge.usage, units, false);
    throw new Error(`PDF toolkit: the claim of ${first.id} was taken over before it was charged`);
  }
  if (furtherKeys.length > 0) {
    // Their files are stored and paid either way; unlabelled rows stay pending until they expire with them.
    const labelled = await labelPdfParts(env.DB, claim, furtherKeys).catch((error: unknown) => {
      console.error(`labelling the files of toolkit result ${first.id} failed:`, error);
      return -1;
    });
    if (labelled >= 0 && labelled !== furtherKeys.length) console.error(`toolkit result ${first.id}: ${labelled} of ${furtherKeys.length} further files labelled`);
  }
  const percent = charge.crossed100 ? 100 : charge.crossed90 ? 90 : null;
  if (percent !== null) background(sendQuotaEmail(env, user, percent, charge.usage));
  return { files, units, ...meta, usage: charge.usage };
}

/* ------------------------------------------------------------------ */
/* POST /v1/pdf-tools/{op}                                             */
/* ------------------------------------------------------------------ */

function fileJson(env: Env, userId: string, file: ResultFile): Record<string, unknown> {
  return {
    id: file.id,
    url: pdfUrl(env, userId, file.id),
    pages: file.output.pages,
    bytes: file.output.bytes.byteLength,
    credits_used: file.units,
    filename: file.filename,
  };
}

pdfToolkitRouter.post('/:op', limitIp, requireApiKey, limitKey, async (c) => {
  const op = c.req.param('op');
  if (!isToolkitOp(op)) {
    throw new ApiError('not_found', `Unknown PDF toolkit operation "${shorten(op)}". Use one of: ${PDF_TOOLKIT.ops.join(', ')}.`);
  }
  const user = c.var.user;
  const request = await readToolkitRequest(c.req.raw, op);
  const now = Date.now();

  if (op === 'fields') {
    const result = await runToolkitOp(request, await loadInputs(c.env, user, request, now), false);
    if (result.kind !== 'fields') throw new Error('PDF toolkit: "fields" answered files');
    return c.json({ op, pages: result.pages, credits_used: 0, fields: result.fields });
  }

  // Nothing is downloaded or parsed for an account that cannot pay for the smallest result.
  const capacity = await pdfCapacity(c.env.DB, user, now);
  if (capacity.largestBlock < 1) throw toolkitQuotaError(c.env, capacity.usage, 1, true);
  const freeMark = capacity.usage.watermark || planMark(user);
  const result = await runToolkitOp(request, await loadInputs(c.env, user, request, now), freeMark);
  if (result.kind !== 'pdf') throw new Error(`PDF toolkit: "${op}" answered no file`);

  const saved = await storeAndCharge(c.env, backgroundFor(c), user, request, result.outputs);
  const timing = { created_at: iso(saved.createdAt), expires_at: iso(saved.expiresAt) };
  if (op === 'split') {
    return c.json({
      op,
      files: saved.files.map((file) => ({ range: file.output.range, ...fileJson(c.env, user.id, file) })),
      pages: saved.files.reduce((sum, file) => sum + file.output.pages, 0),
      credits_used: saved.units,
      ...timing,
      usage: usageJson(saved.usage),
    });
  }
  const file = saved.files[0]!;
  const url = pdfUrl(c.env, user.id, file.id);
  if (request.response === 'binary') {
    const headers = pdfHeaders({ filename: file.filename, disposition: 'inline', pages: file.output.pages, cacheControl: 'no-store', bytes: file.output.bytes.byteLength });
    headers.set('x-ltc-credits-used', String(saved.units));
    headers.set('x-ltc-pdf-url', url);
    return new Response(file.output.bytes, { headers });
  }
  return c.json({ op, ...fileJson(c.env, user.id, file), ...timing, usage: usageJson(saved.usage) });
});

pdfToolkitRouter.all('*', () => {
  throw new ApiError('not_found', `Not found. The PDF toolkit is POST /v1/pdf-tools/{operation}, with operation one of: ${PDF_TOOLKIT.ops.join(', ')}.`);
});
