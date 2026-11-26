/**
 * Bulk documents over HTTP (src/batch/* holds the logic; this file only wires it):
 *
 *   POST /v1/batches                  API key: check the whole request, store it, queue every row; 202
 *   GET  /v1/batches                  the account's batches, newest first (?limit=, ?before=<batch id>)
 *   GET  /v1/batches/{id}             one batch with every row and its ZIP parts
 *   GET  /v1/batches/{id}/zip         the finished PDFs as a ZIP, ?part=N (from 1; no part = part 1)
 *   POST /v1/batches/{id}/cancel      cancel the rows that have not started; answers the batch
 *
 * Dashboard twins under /api/batches (session cookie; writes need a same-origin JSON request),
 * plus GET /api/batches/templates, the PDF starter templates with their fields for the Bulk tab.
 * Revoking a certificate is POST /v1/certificates/{id}/revoke (src/routes/verify.ts).
 *
 * Unless BATCH_ENABLED is "true" AND PDFs are on (src/pdf/render.ts pdfEnabled), every request
 * answers 503 not_configured before anything else, the batch switch first: "Bulk documents are
 * not enabled yet.", then "PDF rendering is not enabled yet.". Creating a batch also needs the
 * BATCH_QUEUE binding. The /v1 routes count against RL_IP per client and RL_KEY per key, like
 * revoking a certificate.
 *
 * ZIP downloads (decision D9): the done rows whose PDF is still stored are packed greedily, in
 * row order, into parts of at most BATCH.zipPartMaxEntries files and BATCH.zipPartMaxBytes
 * archive bytes, computed from the sizes stored with the rows. The batch JSON lists them as
 * `zip_parts`. A part's exact length is computed up front (zipArchiveSize), so it is sent with a
 * Content-Length through a FixedLengthStream; a PDF that is then missing from R2 or has another
 * size errors the stream (the download stops short) instead of producing a broken archive.
 * While a batch runs, or as its PDFs expire, the parts can change: read zip_parts again first.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { requireApiKey, requireSameOrigin, requireSession } from '../auth/middleware';
import { getPlan } from '../billing/plans';
import { BATCH, DAY_MS } from '../config';
import { enqueueBatchRows } from '../batch/enqueue';
import { pinnedTemplateVersion } from '../batch/render';
import { assertBatchFits, dedupeFilenames, parseBatchRequest } from '../batch/rows';
import { batchCounts, cancelBatch, createBatch, doneRows, getBatch, listBatchRows, listBatches, type BatchListItem } from '../batch/store';
import type { BatchRecord, BatchRowRecord } from '../batch/types';
import { batchJson, type BatchJson } from '../batch/view';
import { batchZipFilename } from '../batch/zip';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled, featureNotConfigured } from '../lib/features';
import { readJsonObject } from '../lib/http';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { zipArchiveSize, zipStream, type ZipEntry } from '../lib/zip';
import { assertPdfEnabled } from '../pdf/render';
import { pdfTemplateNotFound, readStoredPdf, resolvePdfTemplate } from '../pdf/service';
import { PDF_TEMPLATES } from '../pdf/templates';
import type { AppEnv, Env } from '../types';

/** The shape of the ids createBatch makes (randomId('bat')); anything else is simply not found. */
const BATCH_ID_RE = /^bat_[0-9a-z]{1,64}$/;
const PART_RE = /^[1-9][0-9]{0,5}$/;
const LIMIT_RE = /^[1-9][0-9]{0,5}$/;

/** Which API answered: the URLs in the batch JSON point back at the same one. */
type Surface = 'api' | 'dashboard';
const SURFACE_PREFIX: Record<Surface, string> = { api: '/v1/batches', dashboard: '/api/batches' };

const notFound = (): ApiError => new ApiError('not_found', 'No batch with this id on your account.');

/* ------------------------------------------------------------------ */
/* ZIP parts (decision D9)                                             */
/* ------------------------------------------------------------------ */

/** One PDF of a ZIP part: its entry name (unique within the batch) and stored size. */
export interface ZipPartEntry {
  index: number;
  cacheKey: string;
  name: string;
  size: number;
}

export interface ZipPart {
  /** Counted from 1. */
  part: number;
  entries: ZipPartEntry[];
  /** Exact archive length (what zipArchiveSize gives and the download sends as Content-Length). */
  bytes: number;
}

export interface ZipPartLimits {
  maxEntries: number;
  maxBytes: number;
}

const DEFAULT_PART_LIMITS: ZipPartLimits = { maxEntries: BATCH.zipPartMaxEntries, maxBytes: BATCH.zipPartMaxBytes };

/**
 * The ZIP parts of a batch: its done rows whose PDF is still stored (`pdfExpiresAt` after `now`,
 * the same rule as a row's `url`), in row order, each part filled until one more file would pass
 * `maxEntries` or `maxBytes`. Entry names are deduplicated over the whole batch, so the parts
 * extract into one folder without overwriting each other. A single file larger than `maxBytes`
 * gets a part of its own. No rows: no parts.
 */
export function batchZipParts(rows: readonly BatchRowRecord[], now: number, limits: ZipPartLimits = DEFAULT_PART_LIMITS): ZipPart[] {
  const live = rows.filter(
    (row): row is BatchRowRecord & { cacheKey: string; bytes: number } =>
      row.status === 'done' && row.cacheKey !== null && row.bytes !== null && (row.pdfExpiresAt ?? 0) > now,
  );
  const names = dedupeFilenames(live.map((row) => row.filename));
  const empty = zipArchiveSize([]);
  const parts: ZipPart[] = [];
  let current: ZipPart | null = null;
  for (const [position, row] of live.entries()) {
    const entry: ZipPartEntry = { index: row.index, cacheKey: row.cacheKey, name: names[position]!, size: row.bytes };
    // What this one file adds to an archive: its local header, data, descriptor and central record.
    const added = zipArchiveSize([entry]) - empty;
    if (current === null || current.entries.length + 1 > limits.maxEntries || current.bytes + added > limits.maxBytes) {
      if (current !== null && current.entries.length === 0) throw new RangeError('batchZipParts: limits leave no room for a file');
      current = { part: parts.length + 1, entries: [], bytes: empty };
      parts.push(current);
    }
    current.entries.push(entry);
    current.bytes += added;
  }
  return parts;
}

export interface ZipPartJson {
  part: number;
  entries: number;
  bytes: number;
  url: string;
}

/** GET .../zip on the surface that answered (part 1): an API key cannot open a dashboard URL, nor a cookie an /v1 one. */
function zipUrl(env: Pick<Env, 'APP_URL'>, surface: Surface, batchId: string): string {
  return `${env.APP_URL.replace(/\/+$/, '')}${SURFACE_PREFIX[surface]}/${batchId}/zip`;
}

function zipPartUrl(env: Pick<Env, 'APP_URL'>, surface: Surface, batchId: string, part: number): string {
  return `${zipUrl(env, surface, batchId)}?part=${part}`;
}

export function zipPartsJson(env: Pick<Env, 'APP_URL'>, surface: Surface, batchId: string, parts: readonly ZipPart[]): ZipPartJson[] {
  return parts.map((part) => ({ part: part.part, entries: part.entries.length, bytes: part.bytes, url: zipPartUrl(env, surface, batchId, part.part) }));
}

/** ?part=N: absent is part 1; anything but a whole number from 1 is a 400. */
export function parsePart(value: string | undefined): number {
  if (value === undefined || value === '') return 1;
  if (!PART_RE.test(value)) throw new ApiError('invalid_request', '"part" must be a whole number from 1: the part of the ZIP, as zip_parts lists them.');
  return Number(value);
}

/**
 * The PDFs of one part, read from R2 one at a time as the archive is written. The length was
 * promised up front, so a PDF that is gone or has another size than the row says cannot be left
 * out: it stops the download (logged) rather than producing an archive that does not match.
 */
async function* zipPartData(bucket: R2Bucket, userId: string, batchId: string, entries: readonly ZipPartEntry[], now: number): AsyncGenerator<ZipEntry> {
  for (const entry of entries) {
    const stored = await readStoredPdf(bucket, userId, entry.cacheKey, now, true);
    if (!stored?.body || stored.pdf.bytes !== entry.size) {
      const found = stored ? `${stored.pdf.bytes} bytes` : 'nothing';
      throw new Error(`batch ${batchId} zip: row ${entry.index} (${entry.cacheKey}.pdf) should have ${entry.size} bytes, R2 has ${found}`);
    }
    yield { name: entry.name, size: entry.size, data: stored.body as ReadableStream<Uint8Array> };
  }
}

function zipFilename(batchId: string, part: number, parts: number): string {
  return parts === 1 ? batchZipFilename(batchId) : `${batchId}-part-${part}-of-${parts}.zip`;
}

/* ------------------------------------------------------------------ */
/* Handlers, shared by both surfaces                                   */
/* ------------------------------------------------------------------ */

async function findBatch(c: Context<AppEnv>): Promise<BatchRecord> {
  const id = c.req.param('id') ?? '';
  const batch = BATCH_ID_RE.test(id) ? await getBatch(c.env.DB, c.var.user.id, id) : null;
  if (!batch) throw notFound();
  return batch;
}

/** One batch as both surfaces answer it: batchJson, its ZIP parts, and its rows when asked for. */
async function singleBatchJson(c: Context<AppEnv>, surface: Surface, batch: BatchRecord, withRows: boolean): Promise<BatchJson & { zip_parts: ZipPartJson[] }> {
  const now = Date.now();
  const [counts, rows, done] = await Promise.all([
    batchCounts(c.env.DB, batch.id),
    withRows ? listBatchRows(c.env.DB, batch.id, { limit: batch.total }) : Promise.resolve(undefined),
    doneRows(c.env.DB, batch.id),
  ]);
  const json = batchJson(c.env, batch, counts, now, rows);
  const parts = batchZipParts(done, now);
  return { ...json, zip_url: zipUrl(c.env, surface, batch.id), zip_parts: zipPartsJson(c.env, surface, batch.id, parts) };
}

function createHandler(surface: Surface) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const queue = c.env.BATCH_QUEUE;
    if (!queue) throw featureNotConfigured('batch');
    const user = c.var.user;
    const body = await readJsonObject(c.req.raw, BATCH.maxRequestBodyBytes);
    const now = Date.now();
    const usage = await getUsage(c.env.DB, user, now);
    const request = parseBatchRequest(body, { plan: usage.plan, appUrl: c.env.APP_URL });
    // An unknown template is 404 like POST /v1/pdf (decision D3).
    const template = await resolvePdfTemplate(c.env.DB, user.id, request.template);
    if (!template) throw pdfTemplateNotFound();
    assertBatchFits(usage, request.rows.length, c.env.APP_URL);
    const created = await createBatch(
      c.env.DB,
      { userId: user.id, request, templateVersion: pinnedTemplateVersion(template), expiresAt: now + getPlan(usage.plan).cacheDays * DAY_MS },
      { maxActive: BATCH.maxActivePerAccount, now },
    );
    // A send that fails fails its rows at once (uncharged) and the answer shows them failed.
    await enqueueBatchRows(c.env.DB, queue, created.id, request.rows.map((row) => row.index), BATCH, now);
    const batch = (await getBatch(c.env.DB, user.id, created.id)) ?? created;
    return c.json(await singleBatchJson(c, surface, batch, false), 202);
  };
}

function listHandler(surface: Surface) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const user = c.var.user;
    const limitParam = c.req.query('limit');
    if (limitParam !== undefined && (!LIMIT_RE.test(limitParam) || Number(limitParam) > BATCH.listMaxLimit)) {
      throw new ApiError('invalid_request', `"limit" must be a whole number from 1 to ${BATCH.listMaxLimit}.`);
    }
    const limit = limitParam === undefined ? BATCH.listDefaultLimit : Number(limitParam);
    const beforeId = c.req.query('before');
    let before: { createdAt: number; id: string } | undefined;
    if (beforeId !== undefined) {
      const anchor = BATCH_ID_RE.test(beforeId) ? await getBatch(c.env.DB, user.id, beforeId) : null;
      if (!anchor) throw new ApiError('invalid_request', '"before" must be the id of one of your batches: the next_before of the previous page.');
      before = { createdAt: anchor.createdAt, id: anchor.id };
    }
    // One more than asked shows whether another page follows.
    const items: BatchListItem[] = await listBatches(c.env.DB, user.id, { limit: limit + 1, before });
    const page = items.slice(0, limit);
    const now = Date.now();
    return c.json({
      batches: page.map(({ batch, counts }) => ({ ...batchJson(c.env, batch, counts, now), zip_url: zipUrl(c.env, surface, batch.id) })),
      next_before: items.length > limit ? page[page.length - 1]!.batch.id : null,
    });
  };
}

function getHandler(surface: Surface) {
  return async (c: Context<AppEnv>): Promise<Response> => c.json(await singleBatchJson(c, surface, await findBatch(c), true));
}

function cancelHandler(surface: Surface) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const id = c.req.param('id') ?? '';
    const result = BATCH_ID_RE.test(id) ? await cancelBatch(c.env.DB, c.var.user.id, id, Date.now()) : null;
    if (!result) throw notFound();
    return c.json(await singleBatchJson(c, surface, result.batch, true));
  };
}

async function zipHandler(c: Context<AppEnv>): Promise<Response> {
  const part = parsePart(c.req.query('part'));
  const batch = await findBatch(c);
  const now = Date.now();
  const parts = batchZipParts(await doneRows(c.env.DB, batch.id), now);
  const chosen = parts[part - 1];
  if (!chosen) {
    throw new ApiError(
      'not_found',
      parts.length === 0
        ? 'This batch has no finished documents to download (yet, or any more: their storage time has ended).'
        : `This batch's ZIP has ${parts.length} part${parts.length === 1 ? '' : 's'}; ask for part=1 to part=${parts.length} (zip_parts in GET of the batch lists them).`,
      { details: { parts: parts.length } },
    );
  }
  // Checked again on the exact entries: names, duplicates and the format's limits, before the first byte.
  const length = zipArchiveSize(chosen.entries);
  const fixed = new FixedLengthStream(length);
  const archive = zipStream(zipPartData(c.env.BUCKET, batch.userId, batch.id, chosen.entries, now), { modified: new Date(now) });
  archive.pipeTo(fixed.writable).catch((error: unknown) => console.error(`batch ${batch.id} zip part ${part} stopped:`, error));
  return new Response(fixed.readable, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      // The same number the FixedLengthStream enforces; set here too so the header is there before the body is sent.
      'content-length': String(length),
      'content-disposition': `attachment; filename="${zipFilename(batch.id, part, parts.length)}"`,
      'cache-control': 'private, no-store',
      'x-ltc-zip-part': String(part),
      'x-ltc-zip-parts': String(parts.length),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Routers                                                             */
/* ------------------------------------------------------------------ */

/** The kill switches, before anything else: BATCH_ENABLED first, then PDF rendering. */
const requireBatches: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertFeatureEnabled(c.env, 'batch');
  assertPdfEnabled(c.env);
  await next();
};

const limitIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  await next();
};

const limitKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? c.var.user.id);
  await next();
};

/** Mounted at /v1/batches, before the /v1 API router. */
export const batchesApiRouter = new Hono<AppEnv>();

batchesApiRouter.use('*', requireBatches, limitIp, requireApiKey, limitKey);
batchesApiRouter.post('/', createHandler('api'));
batchesApiRouter.get('/', listHandler('api'));
batchesApiRouter.get('/:id', getHandler('api'));
batchesApiRouter.get('/:id/zip', zipHandler);
batchesApiRouter.post('/:id/cancel', cancelHandler('api'));

/** The PDF starter templates as the Bulk tab needs them: fields to map columns to, and the source for its preview. */
function starterTemplatesJson(): Record<string, unknown>[] {
  return PDF_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    html: template.html,
    css: template.css,
    default_pdf: { format: template.defaultPdf.format, landscape: template.defaultPdf.landscape },
    fields: template.fields.map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      required: field.required,
      ...(field.itemFields ? { item_fields: [...field.itemFields] } : {}),
    })),
    // parseBatchRequest verifies the certificate template unless the request says otherwise.
    verify_default: template.id === 'certificate',
  }));
}

/** Mounted at /api/batches, before the dashboard router. */
export const batchesDashboardRouter = new Hono<AppEnv>();

batchesDashboardRouter.use('*', requireBatches, requireSameOrigin, requireSession);
batchesDashboardRouter.get('/templates', (c) => c.json({ starter: starterTemplatesJson() }));
batchesDashboardRouter.post('/', createHandler('dashboard'));
batchesDashboardRouter.get('/', listHandler('dashboard'));
batchesDashboardRouter.get('/:id', getHandler('dashboard'));
batchesDashboardRouter.get('/:id/zip', zipHandler);
batchesDashboardRouter.post('/:id/cancel', cancelHandler('dashboard'));
