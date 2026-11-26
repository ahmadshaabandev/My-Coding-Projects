/**
 * Shared shapes of bulk documents (POST /v1/batches): what the request becomes, what D1 keeps
 * (the batches migration, src/db/migrations/*_batches.sql), and the contract between the queue
 * consumer and the function that renders one row. Types only; no behaviour lives here.
 */
import type { PdfFormat } from '../config';
import type { ErrorCode } from '../lib/errors';
import type { Background } from '../lib/http';
import type { PdfData } from '../pdf/templates/types';
import type { VerificationFields } from './certificates';
import type { Env, UserRow } from '../types';

export const BATCH_STATUSES = ['queued', 'running', 'done', 'partial', 'failed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** A batch in one of these states still has rows to render; the active-batch cap counts them. */
export const ACTIVE_BATCH_STATUSES = ['queued', 'running'] as const satisfies readonly BatchStatus[];

export const ROW_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
/** A row in one of these states is finished: nothing will ever render it again. */
export const FINAL_ROW_STATUSES = ['done', 'failed', 'cancelled'] as const satisfies readonly RowStatus[];

/** "pdf" of the request: null means the template's own default. */
export interface BatchPdfOptions {
  format: PdfFormat | null;
  landscape: boolean | null;
}

/** One validated row of the request. */
export interface ParsedBatchRow {
  index: number;
  /** The row as validatePdfData returned it; the verification fields are added at render time. */
  data: PdfData;
  /** ASCII download name ending in ".pdf", unique (ignoring case) within the batch. */
  filename: string;
  /** "crt_..." when the batch verifies, else null. */
  certificateId: string | null;
}

/** A validated POST /v1/batches body. The template id is checked for shape only; the caller resolves it. */
export interface ParsedBatchRequest {
  template: string;
  rows: ParsedBatchRow[];
  pdf: BatchPdfOptions;
  verify: boolean;
  /** The pattern the names came from (the default when the request had none). */
  filenamePattern: string;
}

/** A row of `batches`, as the code uses it. Times are epoch ms. */
export interface BatchRecord {
  id: string;
  userId: string;
  status: BatchStatus;
  template: string;
  /** A custom template's version when the batch was accepted; null for starter templates. */
  templateVersion: number | null;
  pdf: BatchPdfOptions;
  verify: boolean;
  total: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelledAt: number | null;
  expiresAt: number;
}

/** A row of `batch_rows` without its data (listings, the ZIP, GET /v1/batches/{id}). */
export interface BatchRowRecord {
  batchId: string;
  index: number;
  status: RowStatus;
  filename: string;
  certificateId: string | null;
  attempts: number;
  claimedAt: number | null;
  cacheKey: string | null;
  pages: number | null;
  creditsUsed: number | null;
  bytes: number | null;
  pdfExpiresAt: number | null;
  error: RowError | null;
  finishedAt: number | null;
}

/** Why a row failed, or why its last attempt did (while it waits for a retry). */
export interface RowError {
  code: ErrorCode;
  message: string;
}

/** Rows per status, and what the finished ones produced. */
export interface BatchCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  pages: number;
  creditsUsed: number;
}

/* ------------------------------------------------------------------ */
/* Consumer <-> renderer                                               */
/* ------------------------------------------------------------------ */

/** Everything the render function needs for one row; the consumer has claimed the row. */
export interface BatchRenderRequest {
  /** The account as it is now: its plan decides the free mark and what is charged. */
  user: UserRow;
  batch: BatchRecord;
  row: { index: number; filename: string; certificateId: string | null };
  /** The row's data as validated when the batch was accepted. */
  data: PdfData;
  /**
   * certificate_id, verify_url and verify_qr when the batch verifies, else null. Trusted values
   * (decision D13): added after the data is validated (PdfJob.trusted), so PDF.maxDataValueChars
   * does not apply to the QR code.
   */
  verification: VerificationFields | null;
  now: number;
  /** For work that may finish after the row (quota emails); its failures are logged, never retried. */
  background: Background;
}

/** What a rendered (or already stored) row PDF is. */
export interface BatchRenderResult {
  cacheKey: string;
  pages: number;
  /** Images charged by this render: 0 when an identical PDF was stored already. */
  creditsUsed: number;
  bytes: number;
  /** When the stored PDF expires (the plan's cache days). */
  expiresAt: number;
  /** Served from storage without a browser call: the consumer does not pace after it. */
  cached: boolean;
}

/**
 * Renders and charges one row exactly like POST /v1/pdf (source "batch"), or throws: an ApiError
 * (classified by its code, src/batch/consumer.ts) or a BatchRowError that names its cause.
 */
export type BatchRender = (env: Env, request: BatchRenderRequest) => Promise<BatchRenderResult>;

/**
 * Why a row's render failed, which decides what happens next:
 *   document  the document, template or data (or the account) is at fault: the row fails, no retry
 *   provider  Browser Run or our own infrastructure failed: retried up to BATCH.maxRowAttempts
 *   busy      Browser Run or a rate limit said "later": retried like provider
 *   quota     not enough images left: the row and every row still queued fail with quota_exceeded
 *   stop      the feature is switched off: the row fails with not_configured, no retry
 */
export type RowFailureCause = 'document' | 'provider' | 'busy' | 'quota' | 'stop';

/**
 * Numbers the queue code needs. They belong in BATCH (src/config.ts); until the integrator adds
 * them there, the caller passes them in (src/index.ts passes BATCH itself once it has them all).
 */
export interface BatchQueueSettings {
  /** Claims of one row that may end in a provider or busy failure before the row fails. */
  maxRowAttempts: number;
  /** The queue's max_retries (wrangler.toml): on delivery max_retries + 1 a retry() would delete the message. */
  queueMaxRetries: number;
  /** Base delay of a retried row; attempt n waits n times this (linear backoff). */
  retryDelaySeconds: number;
  /** Least wall time per rendered row, so Browser Run's per-second limit holds at full concurrency. */
  minRowMs: number;
  /** A claim older than this is dead (a consumer invocation lasts at most 15 minutes). */
  claimTimeoutMinutes: number;
  /** Messages per sendBatch call (Queues allows 100). */
  sendBatchChunk: number;
  /** Rows per queue message. */
  rowsPerMessage: number;
}
