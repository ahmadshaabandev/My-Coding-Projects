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
  /** How long the call took, measured here: the browser time when Browser Run reports none (timeouts, 5xx). */
  wallMs: number;
  bytes: Uint8Array | null;
  /** Pages counted in the returned PDF; null when there is none or it cannot be read. */
  pages: number | null;
  error: ApiError | null;
  /**
   * Why there is no usable PDF: 'document' when the document itself fails (a browser 422 or
   * timeout, too many pages, a file too large or unreadable), 'provider' when Browser Run or our
   * call to it failed (5xx, 400, an unreachable binding, a wrong content type), 'busy' for its
   * 429. null on success. Only 'document' failures count against an account.
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
/** Navigation and printing each have PDF.renderTimeoutMs; past both (and some slack) we stop waiting. */
const CALL_TIMEOUT_MS = 2 * PDF.renderTimeoutMs + 15_000;
const BUSY_RETRY_SECONDS = 10;

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

/** The messages of a BrowserRunErrorResponse, shortened; '' when the body is not one. */
async function errorMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
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

function tooManyPages(pages: number): ApiError {
  return new ApiError(
    'template_error',
    `The document has more than ${PDF.maxPages} pages; a PDF may have at most ${PDF.maxPages}. Split it into several documents.`,
    { details: { max_pages: PDF.maxPages, pages_rendered: pages } },
  );
}

/** Awaits the call, but not forever: the browser has its own timeouts, this is the backstop. */
function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), CALL_TIMEOUT_MS);
  });
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
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
  let response: Response;
  const started = Date.now();
  try {
    response = await withDeadline(browser.quickAction('pdf', quickActionOptions(request)));
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError('render_failed', 'The PDF renderer could not be reached. Try again in a moment.');
    if (!(error instanceof ApiError)) console.error('Browser Run call failed:', error);
    return { status: 0, browserMs: null, wallMs: Math.max(0, Date.now() - started), bytes: null, pages: null, error: apiError };
  }
  const wallMs = Math.max(0, Date.now() - started);
  const browserMs = browserMsOf(response);
  const { status } = response;
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();

  if (status !== 200 || contentType !== 'application/pdf') {
    const message = await errorMessage(response);
    if (status === 200) console.error(`Browser Run answered 200 with content-type "${contentType}"`);
    return { status, browserMs, wallMs, bytes: null, pages: null, error: browserError(status === 200 ? 500 : status, message) };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
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
}
