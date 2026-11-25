/**
 * The PDF service behind POST /v1/pdf, signed PDF links and the free PDF tools.
 *
 * Order of operations for one PDF, and why quota can be neither charged for nothing nor
 * bypassed (the same shape as images, src/lib/images.ts):
 *
 *   1. cache key   account + template identity + data + page setup + header/footer + free
 *                  mark + file name
 *   2. R2 lookup   hit -> served, quota untouched
 *   3. pre-check   less than PDF.baseUnits images left in any one place -> 402, no render
 *   4. prepare     sanitise and fill in the template (template_error before any download)
 *   5. assets      remote images inlined as data: URIs (image_fetch_failed)
 *   6. browser     one quickAction call; a browser_usage row records it whatever happens
 *   7. pages       > PDF.maxPages -> 422, not charged; unreadable count -> 500, not charged
 *   8. chargePdf   pdfUnits(pages) as one block: charged | duplicate | quota_exceeded (402,
 *                  the PDF is not returned)
 *   9. store       in R2 with its file name, pages and units as metadata
 *
 * The free tools run steps 4-7 only: never stored, never counted against an account.
 */
import { PLAN_ORDER, formatCount, getPlan } from '../billing/plans';
import { DAY_MS, PDF, pdfUnits } from '../config';
import { first, run } from '../db/client';
import { randomId, sha256Hex } from '../lib/crypto';
import { quotaWarningEmail, sendEmail } from '../lib/email';
import { ApiError } from '../lib/errors';
import { etagFor, imageMaxAge, iso, usageJson, type Background } from '../lib/http';
import { chargePdf, pdfCapacity, PDF_PENDING_STALE_MS, readPdfLedger, type ChargeResult } from '../lib/quota';
import { enforceRateLimit } from '../lib/rate-limit';
import type { Env, TemplateRow, UsageSummary, UserRow } from '../types';
import { inlineRemoteAssets } from './assets';
import { bundledFontFaces } from './fonts';
import { assertFailedRenderAllowance, assertFreeBrowserCapacity, noteUnchargedRender } from './guard';
import { contentDisposition, headerFooter, parseFormat, parseLandscape, parseMargin, withMarkRoom } from './page';
import { printPdf, type PrintRequest } from './render';
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
      canonicalData(job.data),
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
  source: 'api' | 'signed' | 'tool';
}

/** Steps 4 of the module comment: pure, throws template_error / invalid_request before anything is downloaded. */
export function preparePdf(job: PdfJob): PreparedPdf {
  const document = preparePdfDocument({ html: job.template.html, css: job.template.css, data: job.data }, { fontFaces: bundledFontFaces });
  // Next to the free mark, header and footer stylesheets are dropped (src/pdf/page.ts headerFooter).
  const header = job.header === null ? null : preparePdfFragment(job.header, job.data, 'header', { styles: !job.mark });
  const footer = job.footer === null ? null : preparePdfFragment(job.footer, job.data, 'footer', { styles: !job.mark });
  const warnings = [...new Set([document, header, footer].flatMap((part) => part?.warnings ?? []))];
  return { job, document, header, footer, warnings };
}

async function recordBrowserUsage(
  db: D1Database,
  attempt: RenderAttempt,
  outcome: { status: number; browserMs: number | null; wallMs: number; pages: number | null },
  now: number,
): Promise<void> {
  try {
    await run(
      db,
      'INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      randomId('bu'),
      attempt.userId,
      attempt.source,
      outcome.status,
      outcome.browserMs,
      outcome.wallMs,
      outcome.pages,
      now,
    );
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

/** Steps 5-7: inline the images, print once, record the browser time. Throws the render's error after recording it. */
export async function printPrepared(env: Env, prepared: PreparedPdf, attempt: RenderAttempt, now: number): Promise<RenderedPdf> {
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
  if (outcome.error) {
    // A busy renderer (429) did no work for us; anything else used browser time for nothing.
    if (attempt.userId !== null && outcome.status !== 429) await noteUnchargedRender(env, attempt.userId, now);
    throw outcome.error;
  }
  return { bytes: outcome.bytes!, pages: outcome.pages!, browserMs: outcome.browserMs, warnings: prepared.warnings };
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
/* Account PDFs: cache, quota, render, charge, store                   */
/* ------------------------------------------------------------------ */

export interface PdfRequest {
  user: UserRow;
  job: PdfJob;
  source: 'api' | 'signed';
  siteId: string | null;
  /** RL_KEY bucket applied only when a render is really needed (signed links: the site id). */
  renderRateLimitKey?: string;
}

export interface PdfResult {
  pdf: StoredPdf;
  cached: boolean;
  /** A stream for a stored PDF, bytes for a fresh one, null when only metadata was asked for. */
  body: ReadableStream | Uint8Array | null;
  /** Images charged by this request: 0 for a cache hit or a duplicate. */
  creditsUsed: number;
  warnings: string[];
  /** Usage right after the charge; null when nothing was charged. */
  usage: UsageSummary | null;
}

/** Waits (ms) between reads of a ledger row that an identical request holds unpaid. */
const PENDING_WAITS_MS = [0, 50, 100, 150, 200, 300, 400, 500];
const PENDING_RETRY_SECONDS = 2;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function renderAndCharge(env: Env, background: Background, request: PdfRequest, cacheKey: string, now: number): Promise<PdfResult> {
  const { user, job } = request;
  const capacity = await pdfCapacity(env.DB, user, now);
  if (capacity.largestBlock < PDF.baseUnits) throw pdfQuotaError(env, capacity.usage, PDF.baseUnits, true);
  await assertFailedRenderAllowance(env, user.id, capacity.usage.plan, now);
  if (capacity.usage.plan === 'free') await assertFreeBrowserCapacity(env, now);
  if (request.renderRateLimitKey) await enforceRateLimit(env, 'RL_KEY', request.renderRateLimitKey);
  if (capacity.usage.plan === 'free') await enforceRateLimit(env, 'RL_PDF_FREE', user.id);

  // Throws on any failure: from here to chargePdf nothing has been stored or counted.
  const rendered = await printPrepared(env, preparePdf(job), { userId: user.id, source: request.source }, now);
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
  const charge = (): Promise<ChargeResult> =>
    chargePdf(
      env.DB,
      user,
      { cacheKey, siteId: request.siteId, source: request.source, template: job.template.label, bytes: pdf.bytes, r2Key: pdfR2Key(user.id, cacheKey), ttlMs, units },
      now,
    );

  // A failed write must not fail a PDF that was paid for: the next request finds no object,
  // renders again and is told "duplicate" by the ledger.
  const store = (): Promise<void> => storePdf(env.BUCKET, pdf, rendered.bytes).catch((error: unknown) => console.error(`storing ${cacheKey}.pdf failed:`, error));
  const fresh = { pdf, cached: false, body: rendered.bytes, warnings: rendered.warnings };
  const settle = async (result: Exclude<ChargeResult, { status: 'duplicate' }>): Promise<PdfResult> => {
    if (result.status === 'quota_exceeded') {
      // The browser time is already recorded; the PDF is not handed out.
      await noteUnchargedRender(env, user.id, now);
      throw pdfQuotaError(env, result.usage, units, false);
    }
    await store();
    const percent = result.crossed100 ? 100 : result.crossed90 ? 90 : null;
    if (percent !== null) background(sendQuotaEmail(env, user, percent, result.usage));
    return { ...fresh, creditsUsed: units, usage: result.usage };
  };

  const initial = await charge();
  if (initial.status !== 'duplicate') return settle(initial);

  // duplicate: a ledger row already exists for this PDF. Only a PAID row may be served: a
  // pending one belongs to an identical request that is charging right now and may find that
  // the block does not fit (then it releases the row, and this request charges for itself).
  for (const wait of PENDING_WAITS_MS) {
    if (wait > 0) await sleep(wait);
    const ledger = await readPdfLedger(env.DB, user.id, cacheKey);
    const live = ledger !== null && ledger.expires_at > now;
    if (live && ledger.charged_to !== 'pending') {
      // Paid by a concurrent request, or by an earlier one whose object never reached R2.
      pdf.createdAt = ledger.created_at;
      pdf.expiresAt = ledger.expires_at;
      if (!(await readStoredPdf(env.BUCKET, user.id, cacheKey, now, false))) await store();
      return { ...fresh, creditsUsed: 0, usage: null };
    }
    if (!live || ledger.created_at < now - PDF_PENDING_STALE_MS) {
      // Released, expired or abandoned: this request charges the PDF itself.
      const again = await charge();
      if (again.status !== 'duplicate') return settle(again);
    }
  }
  throw new ApiError('rate_limited', 'An identical PDF is being made by another request right now. Retry in a few seconds.', {
    headers: { 'retry-after': String(PENDING_RETRY_SECONDS) },
    details: { retry_after_seconds: PENDING_RETRY_SECONDS },
  });
}

/** The PDF for a request: from R2 when it is stored, otherwise rendered, charged and stored. */
export async function getPdf(
  env: Env,
  background: Background,
  request: PdfRequest,
  options: { now: number; withBody: boolean; cacheKey?: string },
): Promise<PdfResult> {
  const cacheKey = options.cacheKey ?? (await pdfCacheKey(request.user.id, request.job));
  const stored = await readStoredPdf(env.BUCKET, request.user.id, cacheKey, options.now, options.withBody);
  if (stored) return { pdf: stored.pdf, cached: true, body: stored.body, creditsUsed: 0, warnings: [], usage: null };
  return renderAndCharge(env, background, request, cacheKey, options.now);
}
