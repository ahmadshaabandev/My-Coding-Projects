/**
 * The PDF service behind POST /v1/pdf, signed PDF links, bulk-document rows (source 'batch',
 * src/batch/consumer.ts) and the free PDF tools.
 *
 * Order of operations for one PDF, and why quota can be neither charged for nothing nor
 * bypassed (the same shape as images, src/lib/images.ts):
 *
 *   1. cache key   account + template identity + data + page setup + header/footer + free
 *                  mark + file name
 *   2. R2 lookup   hit -> served, quota untouched
 *   3. pre-checks  less than PDF.baseUnits images left in any one place -> 402; the day's failed
 *                  renders used up -> 429; Free while the free brake is on -> 429 (guard.ts)
 *   4. claim       signed links: the site's rate limit (RL_KEY). Then the ledger row of the
 *                  cache key, 'pending' (claimPdf). Held by an identical request -> wait for it
 *                  (looking read-only) and serve its PDF free; its failure remembered -> the
 *                  same answer, nothing rendered or counted
 *   5. reserve     a place under the failed-render caps (guard.ts), then the Free rate limit
 *                  (RL_PDF_FREE; not for batch rows, see reserveAndPrint)
 *   6. prepare     sanitise and fill in the template (template_error before any download)
 *   7. assets      remote images inlined as data: URIs (image_fetch_failed)
 *   8. browser     one quickAction call; a browser_usage row records it whatever happens
 *   9. pages       > PDF.maxPages -> 422, not charged; unreadable count -> 500, not charged
 *  10. charge      pdfUnits(pages) as one block (chargeClaimedPdf): charged | quota_exceeded
 *                  (402, the PDF is not returned)
 *  11. store       in R2 with its file name, pages and units as metadata
 *
 * Every way out after step 4 settles the claim (paid, or released) and after step 5 the place
 * (given back, or kept as a failure when the document itself failed or the PDF did not fit). A
 * request cut off by the runtime settles neither: its claim is taken over after
 * PDF_PENDING_STALE_MS and its place counts as a failure (src/pdf/guard.ts). The free tools run
 * steps 6-9 only: never stored, never counted against an account.
 */
import { PLAN_ORDER, formatCount, getPlan } from '../billing/plans';
import { DAY_MS, PDF, pdfUnits } from '../config';
import { first, isMissingColumnError, run } from '../db/client';
import { randomId, sha256Hex } from '../lib/crypto';
import { quotaWarningEmail, sendEmail } from '../lib/email';
import { ApiError } from '../lib/errors';
import { etagFor, imageMaxAge, iso, usageJson, type Background } from '../lib/http';
import {
  chargeClaimedPdf,
  claimPdf,
  pdfCapacity,
  peekPdfClaim,
  PDF_PENDING_STALE_MS,
  readPdfLedger,
  releasePdfClaim,
  type PdfChargeResult,
  type PdfClaim,
  type PdfClaimResult,
  type PdfFailureNote,
  type PdfLedgerState,
} from '../lib/quota';
import { enforceRateLimit } from '../lib/rate-limit';
import type { Env, TemplateRow, UsageSummary, UserRow } from '../types';
import { inlineRemoteAssets } from './assets';
import { bundledFontFaces } from './fonts';
import {
  assertFailedRenderAllowance,
  assertFreeBrowserCapacity,
  documentFailureNote,
  failureRange,
  forgetFailure,
  giveBackFailedRender,
  keepFailedRender,
  quotaFailureNote,
  readRememberedFailure,
  recallFailure,
  reserveFailedRender,
  type FailedRenderReservation,
  type FailureScope,
  type RememberedFailure,
} from './guard';
import { contentDisposition, headerFooter, parseFormat, parseLandscape, parseMargin, withMarkRoom } from './page';
import { CALL_TIMEOUT_MS, printPdf, type FailureCause, type PrintRequest } from './render';
import { preparePdfDocument, preparePdfFragment, type PdfData, type PreparedPdfHtml } from './template';
import { PDF_TEMPLATE_IDS, getPdfTemplate } from './templates';
import type { PdfPageSetup } from './templates/types';

/** Bump only when the meaning of a cache key changes; it re-bills every stored PDF. */
const PDF_CACHE_KEY_VERSION = 'ltc-pdf-v1';
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CACHE_KEY_RE = /^[0-9a-f]{64}$/;
export const PDF_CONTENT_TYPE = 'application/pdf';

/* ------------------------------------------------------------------ */
/* Templates and jobs                                                  */
/* ------------------------------------------------------------------ */

export interface PdfTemplateSource {
  /** What the ledger and responses call it: a starter id, a custom id or "inline". */
  label: string;
  /** The part of the cache key that changes when the template's content does. */
  identity: string;
  html: string;
  css: string;
  /** A starter template's page setup; null for custom and inline templates. */
  defaults: PdfPageSetup | null;
}

/** Everything that decides the bytes of one PDF. */
export interface PdfJob {
  template: PdfTemplateSource;
  data: PdfData;
  /** Final setup: the free mark's bottom margin is already applied. */
  setup: PdfPageSetup;
  /** The customer's header/footer template source, if any. */
  header: string | null;
  footer: string | null;
  /** "Made with Link To Card" on every page (Free plan, free tools). */
  mark: boolean;
  /** Sanitised download name. */
  filename: string;
  /**
   * Values Link To Card sets itself (a verified bulk document's certificate_id, verify_url and
   * verify_qr): added to the document after `data` is validated, outside the data limits
   * (PdfDocumentInput.trusted). Not used by headers and footers.
   */
  trusted?: Readonly<Record<string, string>>;
}

export function pdfTemplateNotFound(): ApiError {
  return new ApiError(
    'not_found',
    `PDF template not found. Use a PDF starter template (${PDF_TEMPLATE_IDS.join(', ')}) or the id of one of your own templates.`,
  );
}

function starterSource(id: string): PdfTemplateSource | null {
  const starter = getPdfTemplate(id);
  // A starter's identity has no content hash on purpose: a redesign must not re-bill stored PDFs.
  return starter ? { label: starter.id, identity: `pdf-starter:${starter.id}`, html: starter.html, css: starter.css, defaults: starter.defaultPdf } : null;
}

/** A PDF starter template, or a custom template the account owns; someone else's is null like a missing one. */
export async function resolvePdfTemplate(db: D1Database, userId: string, id: unknown): Promise<PdfTemplateSource | null> {
  if (typeof id !== 'string' || !TEMPLATE_ID_RE.test(id)) return null;
  const starter = starterSource(id);
  if (starter) return starter;
  const row = await first<TemplateRow>(db, 'SELECT * FROM templates WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL', id, userId);
  return row ? { label: row.id, identity: `custom:${row.id}@${row.version}`, html: row.html, css: row.css, defaults: null } : null;
}

export function starterPdfTemplate(id: string): PdfTemplateSource {
  const starter = starterSource(id);
  if (!starter) throw pdfTemplateNotFound();
  return starter;
}

export async function inlinePdfTemplate(html: string, css: string): Promise<PdfTemplateSource> {
  return { label: 'inline', identity: `inline:${await sha256Hex(html)}:${await sha256Hex(css)}`, html, css, defaults: null };
}

/** Format, orientation and margins from the request over the template's defaults; room for the mark when it is drawn. */
export function pageSetupFor(input: { format?: unknown; landscape?: unknown; margin?: unknown }, defaults: PdfPageSetup | null, mark: boolean): PdfPageSetup {
  const setup: PdfPageSetup = {
    format: parseFormat(input.format, defaults?.format ?? PDF.defaultFormat),
    landscape: parseLandscape(input.landscape, defaults?.landscape ?? false),
    margin: parseMargin(input.margin, defaults?.margin ?? null),
  };
  return mark ? withMarkRoom(setup) : setup;
}

/** Free accounts get the mark; Starter and Pro do not. */
export function planMark(user: Pick<UserRow, 'plan'>): boolean {
  return getPlan(user.plan).watermark;
}

/** Data with sorted keys and every value as text: "5" and 5 render alike, so they share a cache key. */
function canonicalData(data: PdfData): unknown {
  const sorted = <T>(entries: Array<[string, T]>): Array<[string, T]> => entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted(Object.entries(data)).map(([key, value]) =>
    Array.isArray(value) ? [key, value.map((item) => sorted(Object.entries(item)).map(([field, text]) => [field, String(text)]))] : [key, String(value)],
  );
}

/** sha256 over everything that decides the bytes and who paid for them. The mark is part of it: an upgrade must not serve marked PDFs. */
export async function pdfCacheKey(userId: string, job: PdfJob): Promise<string> {
  const { margin } = job.setup;
  return sha256Hex(
    JSON.stringify([
      PDF_CACHE_KEY_VERSION,
      userId,
      job.template.identity,
      // Trusted values decide the bytes like data; a job without them keeps its key unchanged.
      canonicalData(job.trusted ? { ...job.data, ...job.trusted } : job.data),
      job.setup.format,
      job.setup.landscape,
      [margin.top, margin.right, margin.bottom, margin.left],
      job.header,
      job.footer,
      job.mark,
      job.filename,
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export interface PreparedPdf {
  job: PdfJob;
  document: PreparedPdfHtml;
  header: PreparedPdfHtml | null;
  footer: PreparedPdfHtml | null;
  warnings: string[];
}

export interface RenderedPdf {
  bytes: Uint8Array;
  pages: number;
  browserMs: number | null;
  warnings: string[];
}

/** Who a browser call is recorded for in browser_usage. */
export interface RenderAttempt {
  userId: string | null;
  source: 'api' | 'signed' | 'tool' | 'batch';
  /** The account's plan in force for this render (browser_usage.plan); none for the free tools. */
  plan?: UsageSummary['plan'] | null;
}

/** Steps 4 of the module comment: pure, throws template_error / invalid_request before anything is downloaded. */
export function preparePdf(job: PdfJob): PreparedPdf {
  const document = preparePdfDocument({ html: job.template.html, css: job.template.css, data: job.data, trusted: job.trusted }, { fontFaces: bundledFontFaces });
  // Next to the free mark, the header and footer are printed as plain text (src/pdf/template.ts, src/pdf/page.ts headerFooter).
  const header = job.header === null ? null : preparePdfFragment(job.header, job.data, 'header', { mark: job.mark });
  const footer = job.footer === null ? null : preparePdfFragment(job.footer, job.data, 'footer', { mark: job.mark });
  const warnings = [...new Set([document, header, footer].flatMap((part) => part?.warnings ?? []))];
  return { job, document, header, footer, warnings };
}

async function recordBrowserUsage(
  db: D1Database,
  attempt: RenderAttempt,
  outcome: { status: number; browserMs: number | null; wallMs: number; pages: number | null },
  now: number,
): Promise<void> {
  const values = [randomId('bu'), attempt.userId, attempt.source, outcome.status, outcome.browserMs, outcome.wallMs, outcome.pages, now] as const;
  try {
    await run(
      db,
      'INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at, plan) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
      ...values,
      attempt.plan ?? null,
    ).catch(async (error: unknown) => {
      // Deployed before migration 0007: the row is still recorded, without the plan.
      if (!isMissingColumnError(error)) throw error;
      console.error('browser_usage.plan is missing: apply migration 0007_browser_usage_plan.sql');
      return run(db, 'INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)', ...values);
    });
  } catch (error) {
    // Cost tracking must not fail a render that already happened.
    console.error('recording browser usage failed:', error);
  }
}

/**
 * Characters the inlined images may add to the document, counted at every use: PDF.maxAssetBytes
 * as base64 (4/3), plus room for the "data:image/...;base64," prefix of each of them.
 */
const MAX_INLINED_CHARS = Math.ceil((PDF.maxAssetBytes * 4) / 3) + 64 * 1024;

/** One print: the PDF, or the browser's error and whose fault it was (src/pdf/render.ts failureCause). */
export type PrintAttempt = { rendered: RenderedPdf; error: null; cause: null } | { rendered: null; error: ApiError; cause: FailureCause };

/** Steps 5-7: inline the images, print once, record the browser time. Throws only before the browser runs. */
async function printAttempt(env: Env, prepared: PreparedPdf, attempt: RenderAttempt, now: number): Promise<PrintAttempt> {
  if (!env.BROWSER) throw new ApiError('not_configured', 'PDF rendering is not enabled yet.');
  const parts = [prepared.document, prepared.header, prepared.footer];
  const urls = [...new Set(parts.flatMap((part) => part?.remoteUrls ?? []))];
  if (urls.length > PDF.maxRemoteAssets) {
    throw new ApiError('template_error', `The document references more than ${PDF.maxRemoteAssets} different remote images. Embed some as data: URIs.`, {
      details: { limit: PDF.maxRemoteAssets },
    });
  }
  const inlined = await inlineRemoteAssets(urls, { appUrl: env.APP_URL });
  const resolve = (url: string): string | undefined => inlined.get(url);
  // The images are within PDF.maxAssetBytes once each; every further use repeats the whole
  // data: URI in the document, so the copies are counted against the same budget before the
  // document is built (one image in a 200-row loop would otherwise make it hundreds of MB).
  const inlinedChars = parts.reduce((sum, part) => sum + (part?.inlinedChars(resolve) ?? 0), 0);
  if (inlinedChars > MAX_INLINED_CHARS) {
    throw new ApiError(
      'template_error',
      `The images in this document, counted every time they are used, add up to more than ${PDF.maxAssetBytes / (1024 * 1024)} MB. Use a repeated image fewer times, or a smaller one.`,
      { details: { limit: PDF.maxAssetBytes } },
    );
  }
  const request: PrintRequest = {
    html: prepared.document.render(resolve),
    setup: prepared.job.setup,
    headerFooter: headerFooter(prepared.header?.render(resolve) ?? null, prepared.footer?.render(resolve) ?? null, prepared.job.mark, prepared.job.setup.margin),
  };
  const outcome = await printPdf(env.BROWSER, request);
  await recordBrowserUsage(env.DB, attempt, outcome, now);
  if (outcome.error) return { rendered: null, error: outcome.error, cause: outcome.cause ?? 'provider' };
  return { rendered: { bytes: outcome.bytes!, pages: outcome.pages!, browserMs: outcome.browserMs, warnings: prepared.warnings }, error: null, cause: null };
}

/** Steps 5-7 for a caller that only needs the PDF (the free tools): the browser's error is thrown after it is recorded. */
export async function printPrepared(env: Env, prepared: PreparedPdf, attempt: RenderAttempt, now: number): Promise<RenderedPdf> {
  const result = await printAttempt(env, prepared, attempt, now);
  if (result.error) throw result.error;
  return result.rendered;
}

/* ------------------------------------------------------------------ */
/* Stored PDFs                                                         */
/* ------------------------------------------------------------------ */

export interface StoredPdf {
  cacheKey: string;
  userId: string;
  bytes: number;
  pages: number;
  /** Images it was charged as. */
  units: number;
  filename: string;
  template: string;
  createdAt: number;
  expiresAt: number;
}

export function pdfR2Key(userId: string, cacheKey: string): string {
  return `r/${userId}/${cacheKey}.pdf`;
}

/** Public URL of a stored PDF (GET /i/...). */
export function pdfUrl(env: Pick<Env, 'APP_URL'>, userId: string, cacheKey: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}/i/${userId}/${cacheKey}.pdf`;
}

/** "<cacheKey>.pdf" from an /i/ URL; null when it is not shaped like one of ours. */
export function parsePdfFile(file: string): string | null {
  const match = /^([0-9a-f]{64})\.pdf$/.exec(file);
  return match && CACHE_KEY_RE.test(match[1]!) ? match[1]! : null;
}

/** A stored PDF; past its expiry it counts as absent, and the next request renders (and counts) again. */
export async function readStoredPdf(
  bucket: R2Bucket,
  userId: string,
  cacheKey: string,
  now: number,
  withBody: boolean,
): Promise<{ pdf: StoredPdf; body: ReadableStream | null } | null> {
  const key = pdfR2Key(userId, cacheKey);
  const object = withBody ? await bucket.get(key) : await bucket.head(key);
  if (!object) return null;
  const meta = object.customMetadata ?? {};
  const expiresAt = Number(meta.expiresAt);
  const body = 'body' in object ? (object as R2ObjectBody).body : null;
  // An expired object's body is simply left unread (cancelling an R2 stream logs a runtime error).
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return {
    pdf: {
      cacheKey,
      userId,
      bytes: object.size,
      pages: Number(meta.pages),
      units: Number(meta.units),
      filename: meta.filename ?? 'document.pdf',
      template: meta.template ?? '',
      createdAt: Number(meta.createdAt),
      expiresAt,
    },
    body,
  };
}

async function storePdf(bucket: R2Bucket, pdf: StoredPdf, bytes: Uint8Array): Promise<void> {
  await bucket.put(pdfR2Key(pdf.userId, pdf.cacheKey), bytes, {
    httpMetadata: { contentType: PDF_CONTENT_TYPE },
    customMetadata: {
      expiresAt: String(pdf.expiresAt),
      createdAt: String(pdf.createdAt),
      pages: String(pdf.pages),
      units: String(pdf.units),
      filename: pdf.filename,
      template: pdf.template,
    },
  });
}

export interface PdfHeaderInput {
  filename: string;
  disposition: 'inline' | 'attachment';
  /** X-LTC-Pages; left out when not known yet (HEAD before the first render). */
  pages?: number;
  cacheControl: string;
  /** Stored PDFs: ETag and X-LTC-Cache. */
  cacheKey?: string;
  cache?: 'hit' | 'miss';
  bytes?: number;
}

export function pdfHeaders(input: PdfHeaderInput): Headers {
  const headers = new Headers({
    'content-type': PDF_CONTENT_TYPE,
    'content-disposition': contentDisposition(input.disposition, input.filename),
    'cache-control': input.cacheControl,
  });
  if (input.pages !== undefined) headers.set('x-ltc-pages', String(input.pages));
  if (input.cacheKey) {
    headers.set('etag', etagFor(input.cacheKey));
    // Stored PDFs are linked from and embedded in other sites, like images.
    headers.set('cross-origin-resource-policy', 'cross-origin');
  }
  if (input.cache) headers.set('x-ltc-cache', input.cache);
  if (input.bytes !== undefined) headers.set('content-length', String(input.bytes));
  return headers;
}

/** Headers of a stored PDF: cacheable until it expires, a day at most. */
export function storedPdfHeaders(pdf: StoredPdf, cache: 'hit' | 'miss', now: number): Headers {
  return pdfHeaders({
    filename: pdf.filename,
    disposition: 'inline',
    pages: pdf.pages,
    cacheControl: `public, max-age=${imageMaxAge(pdf.expiresAt, now)}`,
    cacheKey: pdf.cacheKey,
    cache,
  });
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

/** 402 for a PDF: what it counts as, why it does not fit, when the allowance comes back. Same JSON as images. */
export function pdfQuotaError(env: Pick<Env, 'APP_URL'>, usage: UsageSummary, units: number, atLeast: boolean): ApiError {
  const plan = getPlan(usage.plan);
  const canUpgrade = PLAN_ORDER.indexOf(plan.id) < PLAN_ORDER.length - 1;
  const remedy = [canUpgrade ? 'upgrade' : null, plan.topUps ? 'buy a top-up' : null].filter((part) => part !== null).join(' or ');
  const pricing = `${env.APP_URL.replace(/\/+$/, '')}/pricing`;
  const from = plan.topUps ? 'the monthly allowance or from a single top-up' : 'the monthly allowance';
  return new ApiError(
    'quota_exceeded',
    `${atLeast ? 'A PDF counts as at least' : 'This PDF counts as'} ${units} images and is charged as one block, from ${from}; not enough is left ` +
      `(${formatCount(usage.remaining)} of the ${formatCount(usage.limit)} images on the ${plan.name} plan this period). ` +
      `The allowance resets on ${iso(usage.period_end)}. Stored PDFs and images keep working; to render new ones now, ${remedy} at ${pricing}.`,
    { details: { usage: usageJson(usage), units_needed: units } },
  );
}

function sendQuotaEmail(env: Env, user: UserRow, percent: 90 | 100, usage: UsageSummary): Promise<void> {
  return sendEmail(env, {
    to: user.email,
    ...quotaWarningEmail({ percent, usage, appUrl: env.APP_URL }),
    // The same key as images (src/lib/images.ts): one notice per account, threshold and period.
    idempotencyKey: `quota-${percent}-${user.id}-${usage.period_start}-${usage.limit}`,
  }).then((result) => {
    if (!result.ok) console.error(`quota ${percent}% email to ${user.id} was not sent: ${result.error}`);
  });
}

/* ------------------------------------------------------------------ */
/* Account PDFs: cache, quota, claim, render, charge, store            */
/* ------------------------------------------------------------------ */

export interface PdfRequest {
  user: UserRow;
  job: PdfJob;
  source: 'api' | 'signed' | 'batch';
  siteId: string | null;
  /** RL_KEY bucket applied when the PDF is not stored and the pre-checks pass (signed links: the site id). */
  renderRateLimitKey?: string;
}

export interface PdfResult {
  pdf: StoredPdf;
  cached: boolean;
  /** A stream for a stored PDF, bytes for a fresh one, null when only metadata was asked for. */
  body: ReadableStream | Uint8Array | null;
  /** Images charged by this request: 0 for a cache hit or a PDF another request paid for. */
  creditsUsed: number;
  warnings: string[];
  /** Usage right after the charge; null when nothing was charged. */
  usage: UsageSummary | null;
}

/** How long a request waits for an identical request that is making the same PDF: one browser call (CALL_TIMEOUT_MS) and 15 s. */
export const PDF_DUPLICATE_WAIT_MS = CALL_TIMEOUT_MS + 15_000;
/** Pauses between looks at that request's ledger row: from about 250 ms, growing to 2 s. */
const WAIT_FIRST_MS = 250;
const WAIT_LONGEST_MS = 2_000;
/** A paid row whose PDF is still not in R2 after this much waiting lost its object: it is rendered again, free. */
const PAID_OBJECT_GRACE_MS = 2_000;
const LOST_CLAIM_RETRY_SECONDS = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A render that holds a claim or a failed-render place keeps running when the client goes away
 * (waitUntil; Cloudflare allows about 30 s more), so it can still settle both instead of leaving
 * a pending row that identical requests wait for until PDF_PENDING_STALE_MS. Its result and
 * error still go to the caller.
 */
function untilSettled<T>(background: Background, work: Promise<T>): Promise<T> {
  background(work.then(
    () => undefined,
    () => undefined,
  ));
  return work;
}

/** The account for POST /v1/pdf and batch rows; for signed links the site, and all sites of its owner together (src/pdf/guard.ts). */
function failureScope(request: PdfRequest): FailureScope {
  return request.source === 'signed' && request.siteId !== null
    ? { kind: 'site', id: request.siteId, ownerId: request.user.id }
    : { kind: 'account', id: request.user.id };
}

function storedResult(stored: { pdf: StoredPdf; body: ReadableStream | null }): PdfResult {
  return { pdf: stored.pdf, cached: true, body: stored.body, creditsUsed: 0, warnings: [], usage: null };
}

/**
 * The answer to a remembered failure: the document's error, or for a 402 the quota error with
 * what is left now. Returns (and, when `forget`, forgets the failure) when a remembered 402 fits
 * now, i.e. a top-up or an upgrade arrived: the PDF is then rendered normally.
 */
async function answerRemembered(env: Env, request: PdfRequest, failure: RememberedFailure | null, cacheKey: string, now: number, forget: boolean): Promise<void> {
  if (failure?.kind === 'document') throw failure.error;
  if (failure?.kind === 'quota') {
    const capacity = await pdfCapacity(env.DB, request.user, now);
    if (capacity.largestBlock < failure.units) throw pdfQuotaError(env, capacity.usage, failure.units, false);
  }
  // A 402 that fits now, or a row this code cannot read.
  if (forget) await forgetFailure(env.DB, cacheKey);
}

/** The checks every render passes before it claims anything: 402, the failed-render cap, the free brake. */
async function preRenderChecks(env: Env, request: PdfRequest, now: number): Promise<UsageSummary['plan']> {
  const capacity = await pdfCapacity(env.DB, request.user, now);
  if (capacity.largestBlock < PDF.baseUnits) throw pdfQuotaError(env, capacity.usage, PDF.baseUnits, true);
  const plan = capacity.usage.plan;
  await assertFailedRenderAllowance(env, failureScope(request), plan, now);
  if (plan === 'free') await assertFreeBrowserCapacity(env, now);
  return plan;
}

/**
 * HEAD of a signed link: what a GET would be refused with before it reaches the browser (402,
 * the site's failed-render cap, the free brake, a remembered failure). Never renders, counts
 * or reserves anything.
 */
export async function assertPdfWouldRender(env: Env, request: PdfRequest, cacheKey: string, now: number): Promise<void> {
  await preRenderChecks(env, request, now);
  await answerRemembered(env, request, await readRememberedFailure(env.DB, cacheKey, now), cacheKey, now, false);
}

/**
 * Takes a place under the failed-render cap, applies the Free render rate limit and prints. On
 * a browser error the place becomes a kept failure for a document failure and is given back
 * otherwise, and `release` is called with the failure to remember (if any); any other exception
 * gives the place back and calls `release` without one. Either way the error is rethrown.
 */
async function reserveAndPrint(
  env: Env,
  request: PdfRequest,
  cacheKey: string,
  plan: UsageSummary['plan'],
  now: number,
  release: (note?: PdfFailureNote) => Promise<void>,
): Promise<{ rendered: RenderedPdf; reservation: FailedRenderReservation }> {
  const { user, job } = request;
  let reservation: FailedRenderReservation = null;
  let settled = false;
  try {
    reservation = await reserveFailedRender(env, failureScope(request), plan, now);
    // Batch rows skip RL_PDF_FREE (decision D12): a Free batch is bounded by BATCH.maxRows.free,
    // BATCH.maxActivePerAccount, the allowance checked before it is accepted, the failed-render
    // cap and the free brake, and the queue consumer paces rows itself and honours Retry-After
    // when the browser is busy.
    if (plan === 'free' && request.source !== 'batch') await enforceRateLimit(env, 'RL_PDF_FREE', user.id);
    const print = await printAttempt(env, preparePdf(job), { userId: user.id, source: request.source, plan }, now);
    if (print.error === null) return { rendered: print.rendered, reservation };
    settled = true;
    // Only the document's own failures count and are remembered; Browser Run failing or busy is not the customer's doing.
    if (print.cause === 'document') {
      await keepFailedRender(env, reservation);
      await release(documentFailureNote(cacheKey, print.error, now));
    } else {
      await giveBackFailedRender(env, reservation);
      await release();
    }
    throw print.error;
  } catch (error) {
    if (!settled) {
      await giveBackFailedRender(env, reservation);
      await release();
    }
    throw error;
  }
}

/** Steps 5-11 for a claim this request holds; its time is the claim's (createdAt). */
async function renderClaimed(env: Env, background: Background, request: PdfRequest, claim: PdfClaim, plan: UsageSummary['plan']): Promise<PdfResult> {
  const { user, job } = request;
  const { cacheKey, createdAt: now } = claim;
  let held = true;
  const release = async (note?: PdfFailureNote): Promise<void> => {
    if (!held) return;
    held = false;
    await releasePdfClaim(env.DB, claim, note).catch((error: unknown) => console.error(`releasing the PDF claim of ${cacheKey} failed:`, error));
  };

  const { rendered, reservation } = await reserveAndPrint(env, request, cacheKey, plan, now, release);
  const units = pdfUnits(rendered.pages);
  const ttlMs = getPlan(user.plan).cacheDays * DAY_MS;
  const pdf: StoredPdf = {
    cacheKey,
    userId: user.id,
    bytes: rendered.bytes.byteLength,
    pages: rendered.pages,
    units,
    filename: job.filename,
    template: job.template.label,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  let result: PdfChargeResult;
  try {
    result = await chargeClaimedPdf(env.DB, claim, { units, bytes: pdf.bytes }, quotaFailureNote(cacheKey, units, now));
    held = false;
  } catch (error) {
    // Our failure, not the document's: the place goes back, and the claim unless it was paid.
    await giveBackFailedRender(env, reservation);
    await release();
    throw error;
  }

  if (result.status === 'quota_exceeded') {
    // Released and remembered by chargeClaimedPdf; the browser time is recorded and the render counts.
    await keepFailedRender(env, reservation);
    throw pdfQuotaError(env, result.usage, units, false);
  }
  await giveBackFailedRender(env, reservation);
  // A failed write must not fail a PDF that was paid for: the next request finds the paid row
  // without an object and renders it again, free.
  const store = (target: StoredPdf): Promise<void> =>
    storePdf(env.BUCKET, target, rendered.bytes).catch((error: unknown) => console.error(`storing ${cacheKey}.pdf failed:`, error));

  if (result.status === 'lost') {
    // Another request took the claim over (this one ran past PDF_PENDING_STALE_MS).
    const ledger = await readPdfLedger(env.DB, user.id, cacheKey);
    if (ledger !== null && ledger.expires_at > now && ledger.charged_to !== 'pending') {
      const paid = { ...pdf, createdAt: ledger.created_at, expiresAt: ledger.expires_at };
      if (!(await readStoredPdf(env.BUCKET, user.id, cacheKey, now, false))) await store(paid);
      return { pdf: paid, cached: false, body: rendered.bytes, creditsUsed: 0, warnings: rendered.warnings, usage: null };
    }
    throw new ApiError('rate_limited', 'An identical request took this PDF over while it was being made, because this one took unusually long. Nothing was charged. Retry in a few seconds.', {
      headers: { 'retry-after': String(LOST_CLAIM_RETRY_SECONDS) },
      details: { retry_after_seconds: LOST_CLAIM_RETRY_SECONDS },
    });
  }

  await store(pdf);
  const percent = result.crossed100 ? 100 : result.crossed90 ? 90 : null;
  if (percent !== null) background(sendQuotaEmail(env, user, percent, result.usage));
  return { pdf, cached: false, body: rendered.bytes, creditsUsed: units, warnings: rendered.warnings, usage: result.usage };
}

/**
 * Of several requests that find a paid PDF without its R2 object, one renders it again: the one
 * that takes this lock (tool_usage "pdfr:<cache key>"). The others keep waiting for the object.
 * The lock ends when that render does, or after PDF_PENDING_STALE_MS if its request was cut off.
 */
const LOCK_PAID_AGAIN_SQL = `INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 1, ?2)
  ON CONFLICT (bucket) DO UPDATE SET count = 1, expires_at = excluded.expires_at WHERE tool_usage.expires_at <= ?3
  RETURNING bucket`;
const paidAgainLock = (cacheKey: string): string => `pdfr:${cacheKey}`;

async function lockPaidAgain(db: D1Database, cacheKey: string, now: number): Promise<boolean> {
  return (await first<{ bucket: string }>(db, LOCK_PAID_AGAIN_SQL, paidAgainLock(cacheKey), now + PDF_PENDING_STALE_MS, now)) !== null;
}

/** A paid PDF whose R2 object is gone (a failed write): rendered again under its lock, stored, never charged again. */
async function renderPaidAgain(env: Env, request: PdfRequest, ledger: PdfLedgerState, cacheKey: string, plan: UsageSummary['plan'], now: number): Promise<PdfResult> {
  try {
    return await renderPaidAgainLocked(env, request, ledger, cacheKey, plan, now);
  } finally {
    await run(env.DB, 'DELETE FROM tool_usage WHERE bucket = ?1', paidAgainLock(cacheKey)).catch((error: unknown) =>
      console.error(`releasing the lock of ${cacheKey}.pdf failed:`, error),
    );
  }
}

async function renderPaidAgainLocked(env: Env, request: PdfRequest, ledger: PdfLedgerState, cacheKey: string, plan: UsageSummary['plan'], now: number): Promise<PdfResult> {
  const { user, job } = request;
  const { rendered, reservation } = await reserveAndPrint(env, request, cacheKey, plan, now, async () => undefined);
  await giveBackFailedRender(env, reservation);
  const pdf: StoredPdf = {
    cacheKey,
    userId: user.id,
    bytes: rendered.bytes.byteLength,
    pages: rendered.pages,
    units: pdfUnits(rendered.pages),
    filename: job.filename,
    template: job.template.label,
    createdAt: ledger.created_at,
    expiresAt: ledger.expires_at,
  };
  await storePdf(env.BUCKET, pdf, rendered.bytes).catch((error: unknown) => console.error(`storing ${cacheKey}.pdf failed:`, error));
  return { pdf, cached: false, body: rendered.bytes, creditsUsed: 0, warnings: rendered.warnings, usage: null };
}

/** The wait for an identical request ran out: 402 if no PDF can fit, otherwise 429 saying what is going on. */
async function waitedTooLong(env: Env, request: PdfRequest, ledger: PdfLedgerState, now: number, waitedMs: number): Promise<never> {
  const capacity = await pdfCapacity(env.DB, request.user, now);
  if (capacity.largestBlock < PDF.baseUnits) throw pdfQuotaError(env, capacity.usage, PDF.baseUnits, true);
  // Seconds until that request's claim can be taken over, if it is still not done by then.
  const age = Math.max(0, now + waitedMs - ledger.created_at);
  const retryAfter = Math.min(PDF_PENDING_STALE_MS / 1000, Math.max(LOST_CLAIM_RETRY_SECONDS, Math.ceil((PDF_PENDING_STALE_MS - age) / 1000)));
  throw new ApiError(
    'rate_limited',
    `An identical request started making this PDF ${Math.round(age / 1000)} s ago and has not finished; this request waited ${Math.round(waitedMs / 1000)} s for it and charged nothing. ` +
      `Retry in ${retryAfter} s: the PDF is then served if it was made, and otherwise the retry makes it.`,
    { headers: { 'retry-after': String(retryAfter) }, details: { retry_after_seconds: retryAfter } },
  );
}

/**
 * Steps 3-9 for a PDF that is not in R2. The ledger row is claimed before anything is rendered:
 * of several identical requests exactly one renders and the others wait for its result (the
 * stored PDF, the remembered failure, or the row released so that one of them renders). A
 * remembered failure is answered without rendering.
 */
async function renderAndCharge(
  env: Env,
  background: Background,
  request: PdfRequest,
  cacheKey: string,
  now: number,
  options: { withBody: boolean; maxWaitMs: number },
): Promise<PdfResult> {
  const { user, job } = request;
  const plan = await preRenderChecks(env, request, now);
  // Signed links: the site's render rate limit, for every request that renders or waits for an
  // identical one (a waiter looks at the ledger for up to PDF_DUPLICATE_WAIT_MS).
  if (request.renderRateLimitKey) await enforceRateLimit(env, 'RL_KEY', request.renderRateLimitKey);
  const range = failureRange(cacheKey);
  const ttlMs = getPlan(user.plan).cacheDays * DAY_MS;
  const started = performance.now();
  let slept = 0;
  const waitedMs = (): number => Math.max(slept, performance.now() - started);
  // A claim made after waiting is dated when it is made, so PDF_PENDING_STALE_MS counts from there.
  const at = (): number => now + Math.round(waitedMs());
  const claim = (time: number): Promise<PdfClaimResult> =>
    claimPdf(env.DB, user, { cacheKey, siteId: request.siteId, source: request.source, template: job.template.label, r2Key: pdfR2Key(user.id, cacheKey), ttlMs }, time, range);
  // While waiting: read only, and claim (a write) only when the claim can succeed.
  const look = async (time: number): Promise<PdfClaimResult> => {
    const seen = await peekPdfClaim(env.DB, cacheKey, time, range);
    return seen.status === 'free' ? claim(time) : seen;
  };

  let pause = WAIT_FIRST_MS;
  let paidMissingSince: number | null = null;
  let attempt = await claim(now);
  for (;;) {
    if (attempt.status === 'claimed') return untilSettled(background, renderClaimed(env, background, request, attempt.claim, plan));
    if (attempt.status === 'remembered') {
      // Throws the remembered answer; returns only when a remembered 402 fits now (and is forgotten).
      await answerRemembered(env, request, recallFailure(cacheKey, attempt.row), cacheKey, now, true);
      attempt = await claim(at());
      // Remembered again straight away (an identical request has just failed): look again after a pause.
      if (attempt.status !== 'remembered') continue;
    } else if (attempt.ledger.charged_to !== 'pending') {
      // Paid: by the request we waited for (its object follows right after), or long ago.
      const stored = await readStoredPdf(env.BUCKET, user.id, cacheKey, now, options.withBody);
      if (stored) return storedResult(stored);
      paidMissingSince ??= slept;
      if (slept - paidMissingSince >= PAID_OBJECT_GRACE_MS && (await lockPaidAgain(env.DB, cacheKey, at()))) {
        return untilSettled(background, renderPaidAgain(env, request, attempt.ledger, cacheKey, plan, at()));
      }
    }
    const waited = waitedMs();
    if (waited >= options.maxWaitMs) {
      const ledger = attempt.status === 'held' ? attempt.ledger : { charged_to: 'pending' as const, created_at: now, expires_at: now };
      return waitedTooLong(env, request, ledger, now, waited);
    }
    const step = Math.min(pause, options.maxWaitMs - slept);
    await sleep(step);
    slept += step;
    pause = Math.min(pause * 2, WAIT_LONGEST_MS);
    attempt = await look(at());
  }
}

/** The PDF for a request: from R2 when it is stored, otherwise rendered, charged and stored. */
export async function getPdf(
  env: Env,
  background: Background,
  request: PdfRequest,
  options: { now: number; withBody: boolean; cacheKey?: string; maxWaitMs?: number },
): Promise<PdfResult> {
  const cacheKey = options.cacheKey ?? (await pdfCacheKey(request.user.id, request.job));
  const stored = await readStoredPdf(env.BUCKET, request.user.id, cacheKey, options.now, options.withBody);
  if (stored) return storedResult(stored);
  return renderAndCharge(env, background, request, cacheKey, options.now, { withBody: options.withBody, maxWaitMs: options.maxWaitMs ?? PDF_DUPLICATE_WAIT_MS });
}
