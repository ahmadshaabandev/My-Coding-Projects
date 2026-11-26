/**
 * The one place that talks to Cloudflare Browser Run: env.BROWSER.quickAction('pdf', options).
 *
 * What the browser receives is always our own sanitised document (src/pdf/template.ts), never
 * a URL, and the options below are fixed:
 *
 *   html                  the document, with every image already inlined as data:
 *   setJavaScriptEnabled  false: nothing in the page runs
 *   allowRequestPattern   ['^data:']: the page may not fetch anything from the network, even
 *                         something the sanitiser missed
 *   cacheTTL              0: Browser Run caches results for a few seconds by default; we keep
 *                         our own per-account R2 cache and want nothing shared between accounts
 *   pageRanges            "1-<maxPages + 1>": one page more than allowed tells us the document
 *                         is too long without printing all of it
 *   tagged, outline       false: a plain PDF (Browser Run's default is tagged), the same file
 *                         structure the page counter is tested on
 *
 * No addScriptTag, no url, no cookies, no extra headers. A response is application/pdf (200)
 * or a JSON error (400, 422, 429, 500, 503); X-Browser-Ms-Used reports the browser time.
 *
 * The PDF is read with a running byte count and refused (422 template_error, never buffered
 * past PDF.maxPdfBytes) as soon as it is larger than that: a small document can make a very
 * large PDF, since every image is stored at its full size. One deadline covers the whole call,
 * the browser's answer and reading its body.
 */
import { PDF } from '../config';
import { ApiError } from '../lib/errors';
import type { Env } from '../types';
import { countPdfPages } from './count';
import type { HeaderFooter } from './page';
import type { PdfPageSetup } from './templates/types';

export interface PrintRequest {
  html: string;
  setup: PdfPageSetup;
  headerFooter: HeaderFooter;
}

/** What one browser call produced. `error` is set when no usable PDF came back. */
export interface PrintOutcome {
  /** HTTP status of the browser's answer; 0 when the call itself failed. */
  status: number;
  /** X-Browser-Ms-Used, when reported. */
  browserMs: number | null;
  /**
   * How long the call took, measured here from the call to the end of reading its body (or to
   * the deadline): the browser time when Browser Run reports none (timeouts, 5xx).
   */
  wallMs: number;
  bytes: Uint8Array | null;
  /** Pages counted in the returned PDF; null when there is none or it cannot be read. */
  pages: number | null;
  error: ApiError | null;
  /**
   * Why there is no usable PDF: 'document' when the document itself fails (a browser 422 or
   * timeout, too many pages, a PDF over PDF.maxPdfBytes or with an unreadable page count),
   * 'provider' when Browser Run or our call to it failed (5xx, 400, an unreachable binding, a
   * wrong content type, a body that stopped or did not finish before the deadline), 'busy' for
   * its 429. null on success. Only 'document' failures count against an account.
   */
  cause: FailureCause | null;
}

export type FailureCause = 'document' | 'provider' | 'busy';

export function failureCause(outcome: Pick<PrintOutcome, 'error' | 'bytes' | 'pages'>): FailureCause | null {
  const { error } = outcome;
  if (error === null) return null;
  if (error.code === 'rate_limited') return 'busy';
  if (error.code === 'render_timeout' || error.code === 'template_error') return 'document';
  // A PDF came back but its page count cannot be read: treated as the document's failure.
  if (error.code === 'render_failed' && outcome.bytes !== null && outcome.pages === null) return 'document';
  return 'provider';
}

const MESSAGE_CHARS = 300;
/**
 * Navigation and printing each have PDF.renderTimeoutMs; past both (and some slack) we stop
 * waiting. The deadline covers the whole call: the browser's answer and reading its body.
 */
export const CALL_TIMEOUT_MS = 2 * PDF.renderTimeoutMs + 15_000;
const BUSY_RETRY_SECONDS = 10;
/** A browser error answer is a short JSON document; a longer body is not read. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Kill switch: PDFs need PDF_ENABLED = "true" and a Browser Run binding. */
export function pdfEnabled(env: Pick<Env, 'PDF_ENABLED' | 'BROWSER'>): boolean {
  return env.PDF_ENABLED === 'true' && typeof env.BROWSER?.quickAction === 'function';
}

export function assertPdfEnabled(env: Pick<Env, 'PDF_ENABLED' | 'BROWSER'>): void {
  if (!pdfEnabled(env)) throw new ApiError('not_configured', 'PDF rendering is not enabled yet.');
}

/** The exact options of every quickAction('pdf') call. */
export function quickActionOptions(request: PrintRequest): BrowserRunPDFOptions {
  const { setup, headerFooter } = request;
  return {
    html: request.html,
    setJavaScriptEnabled: false,
    allowRequestPattern: ['^data:'],
    cacheTTL: 0,
    gotoOptions: { waitUntil: 'load', timeout: PDF.renderTimeoutMs },
    pdfOptions: {
      format: setup.format,
      landscape: setup.landscape,
      margin: { ...setup.margin },
      printBackground: true,
      displayHeaderFooter: headerFooter.displayHeaderFooter,
      ...(headerFooter.displayHeaderFooter ? { headerTemplate: headerFooter.headerTemplate, footerTemplate: headerFooter.footerTemplate } : {}),
      pageRanges: `1-${PDF.maxPages + 1}`,
      timeout: PDF.renderTimeoutMs,
      preferCSSPageSize: false,
      // Explicit, so the file the page counter reads does not depend on Browser Run's defaults
      // (tagged is true there): a tagged PDF carries the document's alt texts as strings.
      tagged: false,
      outline: false,
    },
  };
}

function browserMsOf(response: Response): number | null {
  const raw = response.headers.get('x-browser-ms-used');
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
  return Math.round(Number(raw));
}

/** The messages of a BrowserRunErrorResponse, shortened; '' when the body is not one, is too long or does not arrive in time. */
async function errorMessage(response: Response, deadline: Deadline): Promise<string> {
  let body: unknown = null;
  try {
    const bytes = await readBody(response, MAX_ERROR_BODY_BYTES, deadline);
    if (bytes !== null) body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = null;
  }
  const errors = typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors) ? (body as { errors: unknown[] }).errors : [];
  const text = errors
    .map((entry) => (typeof entry === 'object' && entry !== null && typeof (entry as { message?: unknown }).message === 'string' ? (entry as { message: string }).message : ''))
    .filter((message) => message !== '')
    .join('; ');
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 3)}...` : text;
}

function timedOut(): ApiError {
  return new ApiError('render_timeout', `The document did not finish rendering within ${PDF.renderTimeoutMs / 1000} s. Make it smaller or simpler.`);
}

/** A browser error answer as one of our errors. */
export function browserError(status: number, message: string): ApiError {
  const said = message ? ` The browser said: ${message}` : '';
  if (status === 429) {
    return new ApiError('rate_limited', 'The PDF renderer is busy. Retry in a few seconds.', {
      headers: { 'retry-after': String(BUSY_RETRY_SECONDS) },
      details: { retry_after_seconds: BUSY_RETRY_SECONDS },
    });
  }
  if (/timed?\s*out|timeout/i.test(message)) return timedOut();
  if (status === 422) return new ApiError('template_error', `The browser could not render this document.${said}`);
  if (status === 400) return new ApiError('render_failed', `The browser refused the render request.${said}`);
  return new ApiError('render_failed', `The PDF renderer failed (HTTP ${status}). Try again; if it keeps happening, contact support.${said}`);
}

function tooLarge(): ApiError {
  return new ApiError(
    'template_error',
    `The PDF is larger than ${PDF.maxPdfBytes / (1024 * 1024)} MB, the most one PDF may be. Every image is stored in the PDF at its full size: use smaller or fewer images.`,
    { details: { max_bytes: PDF.maxPdfBytes } },
  );
}

/** The browser answered 200 but its body stopped, or did not finish before the deadline. */
function bodyFailed(): ApiError {
  return new ApiError('render_failed', 'The PDF renderer did not finish sending the PDF. Try again in a moment.');
}

function tooManyPages(pages: number): ApiError {
  return new ApiError(
    'template_error',
    `The document has more than ${PDF.maxPages} pages; a PDF may have at most ${PDF.maxPages}. Split it into several documents.`,
    { details: { max_pages: PDF.maxPages, pages_rendered: pages } },
  );
}

/** One deadline for a whole call: every await of it is raced against the same timer. */
interface Deadline {
  race<T>(work: Promise<T>): Promise<T>;
  clear(): void;
}

/** The browser has its own timeouts; this is the backstop, so a call never waits forever. */
function startDeadline(ms: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), ms);
  });
  expired.catch(() => undefined);
  return {
    race<T>(work: Promise<T>): Promise<T> {
      work.catch(() => undefined);
      return Promise.race([work, expired]);
    },
    clear: () => clearTimeout(timer),
  };
}

/**
 * The body of `response`, or null when it is larger than `limit` bytes: a Content-Length over
 * the limit is refused without reading anything; otherwise the stream is read with a running
 * count and cancelled as soon as the next chunk would take it over, so no more than `limit`
 * bytes are ever kept. A known Content-Length is read straight into one buffer of that size.
 * Rejects when the stream fails or the deadline passes first (the stream is cancelled).
 */
async function readBody(response: Response, limit: number, deadline: Deadline): Promise<Uint8Array | null> {
  const declaredHeader = response.headers.get('content-length')?.trim() ?? '';
  const declared = /^\d{1,16}$/.test(declaredHeader) ? Number(declaredHeader) : null;
  const body = response.body;
  if (declared !== null && declared > limit) {
    body?.cancel().catch(() => undefined);
    return null;
  }
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  let buffer: Uint8Array | null = declared === null ? null : new Uint8Array(declared);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await deadline.race(reader.read());
      if (done) break;
      if (total + value.byteLength > limit) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      if (buffer !== null && total + value.byteLength <= buffer.byteLength) {
        buffer.set(value, total);
      } else {
        // More than the Content-Length said: keep what came so far and collect the rest.
        if (buffer !== null) chunks.push(buffer.subarray(0, total));
        buffer = null;
        chunks.push(value);
      }
      total += value.byteLength;
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  if (buffer !== null) return total === buffer.byteLength ? buffer : buffer.slice(0, total);
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Prints one document. Never throws: the outcome says what happened, so the caller can record
 * the browser time of every attempt before it answers.
 */
export async function printPdf(browser: BrowserRun, request: PrintRequest): Promise<PrintOutcome> {
  const outcome = await printOnce(browser, request);
  return { ...outcome, cause: failureCause(outcome) };
}

async function printOnce(browser: BrowserRun, request: PrintRequest): Promise<Omit<PrintOutcome, 'cause'>> {
  const started = Date.now();
  const elapsed = (): number => Math.max(0, Date.now() - started);
  const deadline = startDeadline(CALL_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await deadline.race(browser.quickAction('pdf', quickActionOptions(request)));
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError('render_failed', 'The PDF renderer could not be reached. Try again in a moment.');
      if (!(error instanceof ApiError)) console.error('Browser Run call failed:', error);
      return { status: 0, browserMs: null, wallMs: elapsed(), bytes: null, pages: null, error: apiError };
    }
    const browserMs = browserMsOf(response);
    const { status } = response;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

    if (status !== 200 || contentType !== 'application/pdf') {
      const message = await errorMessage(response, deadline);
      if (status === 200) console.error(`Browser Run answered 200 with content-type "${contentType}"`);
      return { status, browserMs, wallMs: elapsed(), bytes: null, pages: null, error: browserError(status === 200 ? 500 : status, message) };
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await readBody(response, PDF.maxPdfBytes, deadline);
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Reading the PDF from Browser Run failed:', error);
      else console.error(`Browser Run did not finish sending the PDF within ${CALL_TIMEOUT_MS} ms`);
      return { status, browserMs, wallMs: elapsed(), bytes: null, pages: null, error: bodyFailed() };
    }
    const wallMs = elapsed();
    if (bytes === null) {
      console.error(`Browser Run returned a PDF larger than ${PDF.maxPdfBytes} bytes; refused`);
      return { status, browserMs, wallMs, bytes: null, pages: null, error: tooLarge() };
    }
    const pages = countPdfPages(bytes);
    if (pages === null) {
      console.error(`Browser Run returned a PDF whose page count cannot be read (${bytes.byteLength} bytes)`);
      return {
        status,
        browserMs,
        wallMs,
        bytes,
        pages: null,
        error: new ApiError('render_failed', 'The PDF renderer returned a file that could not be read. Try again; if it keeps happening, contact support.'),
      };
    }
    if (pages > PDF.maxPages) return { status, browserMs, wallMs, bytes, pages, error: tooManyPages(pages) };
    return { status, browserMs, wallMs, bytes, pages, error: null };
  } finally {
    deadline.clear();
  }
}
