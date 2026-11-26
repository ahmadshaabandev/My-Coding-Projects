/**
 * D1 queries of bulk documents (the batches migration, src/db/migrations/*_batches.sql). Every
 * state change is one conditional statement, or one db.batch() (a transaction), so concurrent
 * queue consumers, redelivered messages, a cancel and the daily sweep cannot leave a batch
 * half-changed:
 *
 *   create    the batch and its rows in one transaction, refused as a whole when the account
 *             already has `maxActive` queued or running batches
 *   claim     queued -> running, attempts + 1; a running row whose claim is older than the claim
 *             timeout (its consumer died) can be claimed again. Only the holder of the claim with
 *             that attempt number may finish the row, so a row is never worked on twice at once
 *             and never again once it is finished
 *   finish    done | failed | cancelled, or back to queued for a retry; each finish also
 *             finalizes the batch when nothing is queued or running any more. A verified row's
 *             certificate record is written when the row is done, never before
 *   cancel    the batch, and every row not yet claimed, in one transaction; rows being rendered
 *             finish normally (their PDF is made and charged, and shown)
 *
 * The batch's final status: done when every row is done, failed when none is, partial otherwise;
 * a cancelled batch stays cancelled.
 */
import { isMissingTableError, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { ApiError, type ErrorCode } from '../lib/errors';
import type { PdfData } from '../pdf/templates/types';
import { certificateInsertStatements } from './certificates';
import type { BatchCounts, BatchPdfOptions, BatchRecord, BatchRenderResult, BatchRowRecord, BatchStatus, ParsedBatchRequest, RowError, RowStatus } from './types';

export const BATCH_ID_PREFIX = 'bat';

/**
 * JSON sent per row insert statement, in UTF-8 bytes: well under D1's 2,000,000-byte limit on one
 * value, so a 4 MB request body is a handful of statements of one bound parameter each. Limits as
 * listed on https://developers.cloudflare.com/d1/platform/limits/ (read from the cloudflare-docs
 * source, src/content/docs/d1/platform/limits.mdx, by src/batch/certificates.ts on 2026-11-26).
 */
const INSERT_CHUNK_BYTES = 512 * 1024;
const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* Rows of the tables                                                  */
/* ------------------------------------------------------------------ */

interface BatchDbRow {
  id: string;
  user_id: string;
  status: BatchStatus;
  template: string;
  template_version: number | null;
  pdf_options: string;
  verify: number;
  total: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  cancelled_at: number | null;
  expires_at: number;
}

interface BatchRowDbRow {
  batch_id: string;
  idx: number;
  status: RowStatus;
  data?: string;
  filename: string;
  certificate_id: string | null;
  attempts: number;
  claimed_at: number | null;
  cache_key: string | null;
  pages: number | null;
  credits_used: number | null;
  bytes: number | null;
  pdf_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: number | null;
}

/** Every column but `data`: listings never need the rows' data. */
const ROW_COLUMNS =
  'batch_id, idx, status, filename, certificate_id, attempts, claimed_at, cache_key, pages, credits_used, bytes, pdf_expires_at, error_code, error_message, finished_at';

function parsePdfOptions(json: string): BatchPdfOptions {
  const value = JSON.parse(json) as Partial<BatchPdfOptions>;
  return { format: value.format ?? null, landscape: value.landscape ?? null };
}

export function toBatchRecord(row: BatchDbRow): BatchRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    template: row.template,
    templateVersion: row.template_version,
    pdf: parsePdfOptions(row.pdf_options),
    verify: row.verify === 1,
    total: row.total,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelledAt: row.cancelled_at,
    expiresAt: row.expires_at,
  };
}

export function toRowRecord(row: BatchRowDbRow): BatchRowRecord {
  return {
    batchId: row.batch_id,
    index: row.idx,
    status: row.status,
    filename: row.filename,
    certificateId: row.certificate_id,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    cacheKey: row.cache_key,
    pages: row.pages,
    creditsUsed: row.credits_used,
    bytes: row.bytes,
    pdfExpiresAt: row.pdf_expires_at,
    error: row.error_code === null ? null : { code: row.error_code as ErrorCode, message: row.error_message ?? '' },
    finishedAt: row.finished_at,
  };
}

/* ------------------------------------------------------------------ */
/* Finalizing                                                          */
/* ------------------------------------------------------------------ */

/**
 * The batch's final status once none of its rows is queued or running; no change before that.
 * `status` inside the CASE is the value before the update, so a cancelled batch stays cancelled.
 * Idempotent (finished_at IS NULL), so every finish may run it. `which` picks the batches (?1);
 * ?2 is the time.
 */
function finalizeSql(which: string): string {
  return `UPDATE batches SET
    status = CASE
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN NOT EXISTS (SELECT 1 FROM batch_rows r WHERE r.batch_id = batches.id AND r.status <> 'done') THEN 'done'
      WHEN EXISTS (SELECT 1 FROM batch_rows r WHERE r.batch_id = batches.id AND r.status = 'done') THEN 'partial'
      ELSE 'failed' END,
    finished_at = ?2
  WHERE ${which} AND finished_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM batch_rows r WHERE r.batch_id = batches.id AND r.status IN ('queued', 'running'))`;
}

function finalizeStatement(db: D1Database, batchId: string, now: number): D1PreparedStatement {
  return db.prepare(finalizeSql('id = ?1')).bind(batchId, now);
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export interface NewBatch {
  userId: string;
  request: ParsedBatchRequest;
  /** The custom template's version now (null for a starter), so later rows render the same template. */
  templateVersion: number | null;
  /** created_at + the plan's cache days: how long the batch is listed if it never makes a PDF. */
  expiresAt: number;
}

/**
 * The batch insert, which inserts nothing when the account already has `maxActive` (?10) queued or
 * running batches; the row inserts after it insert only when the batch row exists. All run in
 * one db.batch() transaction, so the cap holds under concurrent creates (tests/batch-store.test.ts
 * sends six at once; local D1).
 * Queued and running batches always have finished_at NULL, which lets the count use
 * idx_batches_unfinished.
 */
const INSERT_BATCH_SQL = `INSERT INTO batches
    (id, user_id, status, template, template_version, pdf_options, verify, total, created_at, expires_at)
  SELECT ?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?7, ?8, ?9
  WHERE (SELECT COUNT(*) FROM batches WHERE user_id = ?2 AND finished_at IS NULL AND status IN ('queued', 'running')) < ?10`;

const INSERT_ROWS_SQL = `INSERT INTO batch_rows (batch_id, idx, status, data, filename, certificate_id)
  SELECT ?1, json_extract(value, '$.i'), 'queued', json_extract(value, '$.d'), json_extract(value, '$.f'), json_extract(value, '$.c')
  FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM batches WHERE id = ?1)`;

function rowInsertStatements(db: D1Database, batchId: string, request: ParsedBatchRequest): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (chunk.length === 0) return;
    statements.push(db.prepare(INSERT_ROWS_SQL).bind(batchId, `[${chunk.join(',')}]`));
    chunk = [];
    bytes = 0;
  };
  for (const row of request.rows) {
    // The data is stored as the exact JSON text the consumer will parse, not as a nested value.
    const json = JSON.stringify({ i: row.index, d: JSON.stringify(row.data), f: row.filename, c: row.certificateId });
    const size = encoder.encode(json).length + 1;
    if (bytes + size > INSERT_CHUNK_BYTES) flush();
    chunk.push(json);
    bytes += size;
  }
  flush();
  return statements;
}

/** 409 conflict (decision D2): the account's own state refuses the batch, not a request rate. */
export function activeCapError(maxActive: number): ApiError {
  return new ApiError(
    'conflict',
    `You already have ${maxActive} batch${maxActive === 1 ? '' : 'es'} queued or running, the most at once. Wait until one finishes, or cancel one, then send this one again.`,
    { details: { max_active_batches: maxActive } },
  );
}

/**
 * Stores a new batch, the batch and every row (queued), all or nothing. Throws activeCapError()
 * at the cap. Certificate records are not made here but when each row's PDF is (completeRow):
 * a record must never say "valid" for a document that was never produced. Queueing the rows is
 * the caller's next step (src/batch/enqueue.ts).
 */
export async function createBatch(db: D1Database, input: NewBatch, options: { maxActive: number; now: number }): Promise<BatchRecord> {
  const { request, userId } = input;
  const id = randomId(BATCH_ID_PREFIX);
  const pdfOptions = JSON.stringify({ format: request.pdf.format, landscape: request.pdf.landscape });
  const [inserted] = await db.batch([
    db
      .prepare(INSERT_BATCH_SQL)
      .bind(id, userId, request.template, input.templateVersion, pdfOptions, request.verify ? 1 : 0, request.rows.length, options.now, input.expiresAt, options.maxActive),
    ...rowInsertStatements(db, id, request),
  ]);
  if ((inserted?.meta.changes ?? 0) !== 1) throw activeCapError(options.maxActive);
  return {
    id,
    userId,
    status: 'queued',
    template: request.template,
    templateVersion: input.templateVersion,
    pdf: { ...request.pdf },
    verify: request.verify,
    total: request.rows.length,
    createdAt: options.now,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    expiresAt: input.expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** One of the account's batches; another account's is null like a missing one. */
export async function getBatch(db: D1Database, userId: string, batchId: string): Promise<BatchRecord | null> {
  const row = await db.prepare('SELECT * FROM batches WHERE id = ?1 AND user_id = ?2').bind(batchId, userId).first<BatchDbRow>();
  return row ? toBatchRecord(row) : null;
}

const EMPTY_COUNTS: BatchCounts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, pages: 0, creditsUsed: 0 };

function addCounts(counts: BatchCounts, row: { status: RowStatus; n: number; pages: number | null; credits: number | null }): void {
  counts[row.status] += row.n;
  counts.pages += row.pages ?? 0;
  counts.creditsUsed += row.credits ?? 0;
}

const COUNTS_SQL =
  'SELECT batch_id, status, COUNT(*) AS n, SUM(pages) AS pages, SUM(credits_used) AS credits FROM batch_rows WHERE batch_id = ?1 GROUP BY status';

export async function batchCounts(db: D1Database, batchId: string): Promise<BatchCounts> {
  const { results } = await db.prepare(COUNTS_SQL).bind(batchId).all<{ status: RowStatus; n: number; pages: number | null; credits: number | null }>();
  const counts = { ...EMPTY_COUNTS };
  for (const row of results ?? []) addCounts(counts, row);
  return counts;
}

/** A page of a batch's rows in row order, starting after row `after` (-1: from the first). */
export async function listBatchRows(db: D1Database, batchId: string, options: { after?: number; limit: number }): Promise<BatchRowRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM batch_rows WHERE batch_id = ?1 AND idx > ?2 ORDER BY idx LIMIT ?3`)
    .bind(batchId, options.after ?? -1, options.limit)
    .all<BatchRowDbRow>();
  return (results ?? []).map(toRowRecord);
}

/** The finished rows that have a PDF, in row order (the ZIP's entries). */
export async function doneRows(db: D1Database, batchId: string): Promise<BatchRowRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM batch_rows WHERE batch_id = ?1 AND status = 'done' AND cache_key IS NOT NULL ORDER BY idx`)
    .bind(batchId)
    .all<BatchRowDbRow>();
  return (results ?? []).map(toRowRecord);
}

export interface BatchListItem {
  batch: BatchRecord;
  counts: BatchCounts;
}

/** Where a listing continues: the last batch of the previous page. */
export interface BatchCursor {
  createdAt: number;
  id: string;
}

/** The account's batches, newest first, with their counts: two statements whatever the page size. */
export async function listBatches(db: D1Database, userId: string, options: { limit: number; before?: BatchCursor }): Promise<BatchListItem[]> {
  // Without a cursor every created_at is below MAX_SAFE_INTEGER, so the id is never compared.
  const before = options.before ?? { createdAt: Number.MAX_SAFE_INTEGER, id: '' };
  const page = `SELECT id FROM batches WHERE user_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC LIMIT ?4`;
  const [batches, counts] = await db.batch([
    db
      .prepare(`SELECT * FROM batches WHERE id IN (${page}) ORDER BY created_at DESC, id DESC`)
      .bind(userId, before.createdAt, before.id || '￿', options.limit),
    db
      .prepare(`SELECT batch_id, status, COUNT(*) AS n, SUM(pages) AS pages, SUM(credits_used) AS credits FROM batch_rows WHERE batch_id IN (${page}) GROUP BY batch_id, status`)
      .bind(userId, before.createdAt, before.id || '￿', options.limit),
  ]);
  const byBatch = new Map<string, BatchCounts>();
  for (const row of (counts?.results ?? []) as Array<{ batch_id: string; status: RowStatus; n: number; pages: number | null; credits: number | null }>) {
    const entry = byBatch.get(row.batch_id) ?? { ...EMPTY_COUNTS };
    addCounts(entry, row);
    byBatch.set(row.batch_id, entry);
  }
  return ((batches?.results ?? []) as BatchDbRow[]).map((row) => ({ batch: toBatchRecord(row), counts: byBatch.get(row.id) ?? { ...EMPTY_COUNTS } }));
}

/* ------------------------------------------------------------------ */
/* Claim and finish (the queue consumer)                               */
/* ------------------------------------------------------------------ */

/** A claimed row: its claim number is `attempts`. */
export interface ClaimedRow extends BatchRowRecord {
  data: PdfData;
}

export type ClaimResult =
  | { kind: 'claimed'; batch: BatchRecord; row: ClaimedRow }
  /** Done, failed or cancelled: nothing more to do. */
  | { kind: 'finished'; status: RowStatus }
  /** Running under a claim that is not older than the claim timeout. */
  | { kind: 'held'; claimedAt: number }
  /** No such row (the batch was deleted with its account, or the message is not ours). */
  | { kind: 'missing' };

/** Identifies one claim of one row: only its holder may finish the row. */
export interface RowClaim {
  batchId: string;
  index: number;
  attempt: number;
}

/**
 * Claims a row for rendering. `claimTimeoutMs`: a running row claimed at least this long ago is
 * taken over (the consumer that held it is gone: an invocation lasts at most 15 minutes).
 */
export async function claimRow(db: D1Database, batchId: string, index: number, now: number, claimTimeoutMs: number): Promise<ClaimResult> {
  const [claimed, , rowResult, batchResult] = await db.batch([
    db
      .prepare(
        `UPDATE batch_rows SET status = 'running', claimed_at = ?3, attempts = attempts + 1
         WHERE batch_id = ?1 AND idx = ?2 AND (status = 'queued' OR (status = 'running' AND claimed_at <= ?4))`,
      )
      .bind(batchId, index, now, now - claimTimeoutMs),
    db
      .prepare(
        `UPDATE batches SET status = 'running', started_at = COALESCE(started_at, ?2)
         WHERE id = ?1 AND status = 'queued' AND EXISTS (SELECT 1 FROM batch_rows WHERE batch_id = ?1 AND status = 'running')`,
      )
      .bind(batchId, now),
    db.prepare('SELECT * FROM batch_rows WHERE batch_id = ?1 AND idx = ?2').bind(batchId, index),
    db.prepare('SELECT * FROM batches WHERE id = ?1').bind(batchId),
  ]);
  const row = (rowResult?.results as BatchRowDbRow[] | undefined)?.[0];
  const batch = (batchResult?.results as BatchDbRow[] | undefined)?.[0];
  if (!row || !batch) return { kind: 'missing' };
  if ((claimed?.meta.changes ?? 0) === 1) {
    return { kind: 'claimed', batch: toBatchRecord(batch), row: { ...toRowRecord(row), data: JSON.parse(row.data ?? '{}') as PdfData } };
  }
  if (row.status === 'running') return { kind: 'held', claimedAt: row.claimed_at ?? now };
  // queued but not claimed cannot happen (the update would have taken it); treat it as held now.
  if (row.status === 'queued') return { kind: 'held', claimedAt: now };
  return { kind: 'finished', status: row.status };
}

/** Runs a finish of one claimed row and finalizes the batch; false when the claim was no longer held. */
async function finishClaimed(db: D1Database, claim: RowClaim, sql: string, params: unknown[], now: number, extra: D1PreparedStatement[] = []): Promise<boolean> {
  const [changed] = await db.batch([
    db.prepare(`${sql} WHERE batch_id = ?1 AND idx = ?2 AND status = 'running' AND attempts = ?3`).bind(claim.batchId, claim.index, claim.attempt, ...params),
    ...extra,
    finalizeStatement(db, claim.batchId, now),
  ]);
  return (changed?.meta.changes ?? 0) === 1;
}

/** The certificate record a verified row gets once its PDF exists. */
export interface RowCertificate {
  id: string;
  userId: string;
  /** The row's data (the record keeps a few of its fields, src/batch/certificates.ts). */
  data: PdfData;
}

/** SQL for credits_used given as `?n`: unchanged when null, else the larger of the two (a row charged once keeps its charge). */
const keepCharge = (n: number): string => `credits_used = CASE WHEN ?${n} IS NULL THEN credits_used ELSE MAX(COALESCE(credits_used, 0), ?${n}) END`;

/**
 * done, with the stored PDF; the batch is kept listed at least until that PDF expires. A verified
 * row's certificate record is written in the same transaction, because the PDF that prints its id
 * now exists (rendered and paid for), even if this claim turns out to be lost; a second write of
 * the same record changes nothing (ON CONFLICT DO NOTHING).
 */
export function completeRow(db: D1Database, claim: RowClaim, result: BatchRenderResult, now: number, certificate: RowCertificate | null = null): Promise<boolean> {
  const records = certificate
    ? certificateInsertStatements(db, { userId: certificate.userId, batchId: claim.batchId, rows: [{ id: certificate.id, rowIndex: claim.index, data: certificate.data }] }, now)
    : [];
  return finishClaimed(
    db,
    claim,
    // credits_used: a row put back after a charged render whose bookkeeping failed (releaseRow with
    // credits) is found stored on its next claim, which charges 0; it keeps what it was charged.
    `UPDATE batch_rows SET status = 'done', claimed_at = NULL, cache_key = ?4, pages = ?5, ${keepCharge(6)}, bytes = ?7, pdf_expires_at = ?8,
       error_code = NULL, error_message = NULL, finished_at = ?9`,
    [result.cacheKey, result.pages, result.creditsUsed, result.bytes, result.expiresAt, now],
    now,
    [db.prepare('UPDATE batches SET expires_at = MAX(expires_at, ?2) WHERE id = ?1').bind(claim.batchId, result.expiresAt), ...records],
  );
}

/** failed for good, with the reason; `creditsUsed` when its PDF was made and charged all the same. */
export function failRow(db: D1Database, claim: RowClaim, error: RowError, now: number, creditsUsed: number | null = null): Promise<boolean> {
  return finishClaimed(
    db,
    claim,
    `UPDATE batch_rows SET status = 'failed', claimed_at = NULL, error_code = ?4, error_message = ?5, finished_at = ?6, ${keepCharge(7)}`,
    [error.code, error.message, now, creditsUsed],
    now,
  );
}

/** cancelled: claimed after the batch was cancelled, and not rendered. */
export function cancelClaimedRow(db: D1Database, claim: RowClaim, now: number): Promise<boolean> {
  return finishClaimed(db, claim, "UPDATE batch_rows SET status = 'cancelled', claimed_at = NULL, finished_at = ?4", [now], now);
}

/**
 * Back to queued for a retry (the queue message is retried with a delay); the reason stays as
 * the row's last error, so GET /v1/batches/{id} can say why it is waiting.
 */
export async function releaseRow(db: D1Database, claim: RowClaim, error: RowError, creditsUsed: number | null = null): Promise<boolean> {
  const changes = await run(
    db,
    `UPDATE batch_rows SET status = 'queued', claimed_at = NULL, error_code = ?4, error_message = ?5, ${keepCharge(6)} WHERE batch_id = ?1 AND idx = ?2 AND status = 'running' AND attempts = ?3`,
    claim.batchId,
    claim.index,
    claim.attempt,
    error.code,
    error.message,
    creditsUsed,
  );
  return changes === 1;
}

/**
 * Fails rows nobody has claimed: every queued row of the batch (`indexes` omitted: the quota ran
 * out, so nothing after it can be charged), or the listed ones (the feature was switched off,
 * the message could not be queued). Rows being rendered are left to their consumer. Returns how
 * many rows failed.
 */
export async function failQueuedRows(db: D1Database, batchId: string, error: RowError, now: number, indexes?: readonly number[]): Promise<number> {
  const only = indexes === undefined ? '' : ' AND idx IN (SELECT value FROM json_each(?5))';
  const params: unknown[] = [batchId, error.code, error.message, now];
  if (indexes !== undefined) params.push(JSON.stringify(indexes));
  const [failed] = await db.batch([
    db
      .prepare(`UPDATE batch_rows SET status = 'failed', error_code = ?2, error_message = ?3, finished_at = ?4 WHERE batch_id = ?1 AND status = 'queued'${only}`)
      .bind(...params),
    finalizeStatement(db, batchId, now),
  ]);
  return failed?.meta.changes ?? 0;
}

/* ------------------------------------------------------------------ */
/* Cancel                                                              */
/* ------------------------------------------------------------------ */

/**
 * Cancels one of the account's batches: the batch and every queued row at once. Rows already
 * being rendered finish (their consumer marks them), so a cancel never wastes a paid render.
 * Null for another account's or a missing batch; `changed` false when it had already finished
 * or was cancelled before (the route answers with the batch as it is).
 */
export async function cancelBatch(db: D1Database, userId: string, batchId: string, now: number): Promise<{ batch: BatchRecord; changed: boolean } | null> {
  const [cancelled, , , selected] = await db.batch([
    db
      .prepare("UPDATE batches SET status = 'cancelled', cancelled_at = ?3 WHERE id = ?1 AND user_id = ?2 AND status IN ('queued', 'running')")
      .bind(batchId, userId, now),
    db
      .prepare(
        `UPDATE batch_rows SET status = 'cancelled', finished_at = ?3
         WHERE batch_id = ?1 AND status = 'queued' AND EXISTS (SELECT 1 FROM batches WHERE id = ?1 AND user_id = ?2 AND status = 'cancelled')`,
      )
      .bind(batchId, userId, now),
    finalizeStatement(db, batchId, now),
    db.prepare('SELECT * FROM batches WHERE id = ?1 AND user_id = ?2').bind(batchId, userId),
  ]);
  const row = (selected?.results as BatchDbRow[] | undefined)?.[0];
  return row ? { batch: toBatchRecord(row), changed: (cancelled?.meta.changes ?? 0) === 1 } : null;
}

/* ------------------------------------------------------------------ */
/* Daily cleanup                                                       */
/* ------------------------------------------------------------------ */

export const STALE_ROW_ERROR: RowError = {
  code: 'internal_error',
  message: 'This row was never rendered: its place in the queue was lost. Nothing was charged for it; send it again in a new batch.',
};

/**
 * Rows of unfinished batches created at or before `createdBefore` that are still queued or
 * running: their queue message can no longer arrive (the queue keeps messages a few days, and a
 * message whose retries ran out is deleted), so they are failed and their batches finalized.
 * `createdBefore` must be older than the queue's retention plus the claim timeout. At most
 * `limit` batches per run. Returns the rows failed. A database without the tables has none.
 */
export async function failStaleRows(db: D1Database, createdBefore: number, now: number, limit: number): Promise<number> {
  const stale = `SELECT id FROM batches WHERE finished_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?4`;
  try {
    const [failed] = await db.batch([
      db
        .prepare(
          `UPDATE batch_rows SET status = 'failed', claimed_at = NULL, error_code = ?2, error_message = ?3, finished_at = ?5
           WHERE status IN ('queued', 'running') AND batch_id IN (${stale})`,
        )
        .bind(createdBefore, STALE_ROW_ERROR.code, STALE_ROW_ERROR.message, limit, now),
      db
        .prepare(finalizeSql('id IN (SELECT id FROM batches WHERE finished_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?3)'))
        .bind(createdBefore, now, limit),
    ]);
    return failed?.meta.changes ?? 0;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    console.error('batch_rows is missing: apply the batches migration');
    return 0;
  }
}

/**
 * Deletes finished batches whose newest PDF has expired (their rows go with them; the PDFs
 * themselves are deleted with their ledger rows, src/lib/cleanup.ts), `limit` batches per
 * statement and at most `maxPerRun`. Certificate records are not touched: they outlive batches.
 */
export async function purgeExpiredBatches(db: D1Database, now: number, limit: number, maxPerRun: number): Promise<number> {
  let deleted = 0;
  while (deleted < maxPerRun) {
    let changes: number;
    try {
      changes = await run(
        db,
        'DELETE FROM batches WHERE id IN (SELECT id FROM batches WHERE finished_at IS NOT NULL AND expires_at <= ?1 LIMIT ?2)',
        now,
        Math.min(limit, maxPerRun - deleted),
      );
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      console.error('batches is missing: apply the batches migration');
      return deleted;
    }
    deleted += changes;
    if (changes < limit) break;
  }
  return deleted;
}
