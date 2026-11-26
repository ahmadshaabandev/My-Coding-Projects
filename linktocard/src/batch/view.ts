/**
 * The JSON of a batch, the same for POST /v1/batches (202), GET /v1/batches/{id}, the cancel
 * answer, the listing and their dashboard twins. Field names follow the rest of the API
 * (snake_case, ISO 8601 times, a PDF's public /i/ URL as `url`).
 *
 * A row's `url` is null until it is done and again once its PDF has expired (the plan's cache
 * days): the link would answer 404 then. `certificate_id` and `verify_url` are null until the
 * row is done, because its certificate record is written only then (a failed row never has one).
 * `error` is the reason a row failed, or, while it is queued again, why its last attempt did.
 */
import { isoOrNull, iso } from '../lib/http';
import { pdfUrl } from '../pdf/service';
import type { Env } from '../types';
import { verifyUrl } from './certificates';
import type { BatchCounts, BatchRecord, BatchRowRecord, RowError } from './types';

export interface BatchRowJson {
  index: number;
  status: BatchRowRecord['status'];
  filename: string;
  pages: number | null;
  credits_used: number | null;
  url: string | null;
  error: RowError | null;
  certificate_id: string | null;
  verify_url: string | null;
}

export interface BatchJson {
  id: string;
  status: BatchRecord['status'];
  template: string;
  verify: boolean;
  total: number;
  counts: { queued: number; running: number; done: number; failed: number; cancelled: number };
  pages: number;
  credits_used: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  /** Every finished PDF in one ZIP (GET /v1/batches/{id}/zip), whatever the batch's status. */
  zip_url: string;
  /** Present when the caller asked for rows (GET /v1/batches/{id}). */
  rows?: BatchRowJson[];
}

function base(env: Pick<Env, 'APP_URL'>): string {
  return env.APP_URL.replace(/\/+$/, '');
}

export function batchRowJson(env: Pick<Env, 'APP_URL'>, userId: string, row: BatchRowRecord, now: number): BatchRowJson {
  const live = row.status === 'done' && row.cacheKey !== null && (row.pdfExpiresAt ?? 0) > now;
  const issued = row.status === 'done' && row.certificateId !== null;
  return {
    index: row.index,
    status: row.status,
    filename: row.filename,
    pages: row.pages,
    credits_used: row.creditsUsed,
    url: live ? pdfUrl(env, userId, row.cacheKey!) : null,
    error: row.status === 'done' || row.error === null ? null : { ...row.error },
    certificate_id: issued ? row.certificateId : null,
    verify_url: issued ? verifyUrl(env.APP_URL, row.certificateId!) : null,
  };
}

export function batchJson(env: Pick<Env, 'APP_URL'>, batch: BatchRecord, counts: BatchCounts, now: number, rows?: readonly BatchRowRecord[]): BatchJson {
  return {
    id: batch.id,
    status: batch.status,
    template: batch.template,
    verify: batch.verify,
    total: batch.total,
    counts: { queued: counts.queued, running: counts.running, done: counts.done, failed: counts.failed, cancelled: counts.cancelled },
    pages: counts.pages,
    credits_used: counts.creditsUsed,
    created_at: iso(batch.createdAt),
    started_at: isoOrNull(batch.startedAt),
    finished_at: isoOrNull(batch.finishedAt),
    cancelled_at: isoOrNull(batch.cancelledAt),
    zip_url: `${base(env)}/v1/batches/${batch.id}/zip`,
    ...(rows ? { rows: rows.map((row) => batchRowJson(env, batch.userId, row, now)) } : {}),
  };
}
