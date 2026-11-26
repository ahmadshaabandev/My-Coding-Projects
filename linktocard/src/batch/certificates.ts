/**
 * Certificate verification records (bulk documents with "verify": true). Each document of such a
 * batch gets an id "crt_" + 20 base32 characters; its data gains certificate_id, verify_url
 * (APP_URL/v/{id}) and verify_qr, and the record behind GET /v/{id} keeps the few facts the
 * public page shows. Nothing here renders or charges anything.
 *
 * Why this shape:
 *   - The id is the only secret-ish part of a record: 100 random bits (crypto.getRandomValues),
 *     so ids cannot be guessed or enumerated. The alphabet is Crockford's base32 in lower case
 *     (no i, l, o or u), because people type ids from paper: parseCertificateId() reads upper
 *     case and the look-alikes i, l (as 1) and o (as 0) too.
 *   - The record keeps five fields of the row (recipient_name, title, achievement, issuer_name,
 *     date: the certificate starter template's names), never the whole row. A template that
 *     uses other names simply shows fewer facts. The issuer's account is not copied: the page
 *     states the domain of the account's sign-in email (src/batch/issuer.ts), read at lookup.
 *   - Records outlive the batch that made them: kept until revoked + BATCH.revokedRetentionDays
 *     or until the account is deleted (users ON DELETE CASCADE). A lookup ignores a record past
 *     that point even before the daily cleanup has deleted it, and hides every record of a
 *     suspended account or one whose deletion was requested.
 *   - Inserts send the rows as one JSON parameter per statement (json_each), so a batch of
 *     thousands of rows is a handful of statements, inside D1's 100-parameter limit, and a retried
 *     queue message inserts nothing twice (ON CONFLICT DO NOTHING).
 *
 * Expected table (src/db/migrations, the batches migration):
 *
 *   CREATE TABLE certificates (
 *     id             TEXT PRIMARY KEY,                                   -- 'crt_' + 20 base32
 *     user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
 *     batch_id       TEXT,                                               -- no cascade: records outlive batches
 *     row_index      INTEGER,
 *     recipient_name TEXT,
 *     title          TEXT,
 *     achievement    TEXT,
 *     issuer_name    TEXT,
 *     document_date  TEXT,                                               -- the row's "date", as written
 *     created_at     INTEGER NOT NULL,
 *     revoked_at     INTEGER
 *   );
 *   CREATE INDEX idx_certificates_user ON certificates (user_id, created_at);
 *   CREATE INDEX idx_certificates_batch ON certificates (batch_id);
 *   CREATE INDEX idx_certificates_revoked ON certificates (revoked_at) WHERE revoked_at IS NOT NULL;
 */
import { BATCH, DAY_MS } from '../config';
import { isMissingTableError, run } from '../db/client';
import { ApiError } from '../lib/errors';
import { qrSvgDataUri } from '../lib/qr';
import type { PdfData } from '../pdf/templates/types';
import { issuerFromEmail, type Issuer } from './issuer';

export const CERTIFICATE_ID_PREFIX = 'crt_';
/** Characters after the prefix: 20 base32 characters are 100 random bits. */
export const CERTIFICATE_ID_LENGTH = 20;
/** Crockford's base32, lower case: digits and letters without i, l, o and u. */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_RE = /^crt_[0-9a-hjkmnp-tv-z]{20}$/;

/** Data keys Link To Card fills in for a verified document. A row may not bring its own. */
export const VERIFICATION_KEYS = ['certificate_id', 'verify_url', 'verify_qr'] as const;
export type VerificationKey = (typeof VERIFICATION_KEYS)[number];
export type VerificationFields = Record<VerificationKey, string>;

/** Row data key -> certificates column, for the facts the verification page shows. */
const RECORD_COLUMNS = {
  recipient_name: 'recipient_name',
  title: 'title',
  achievement: 'achievement',
  issuer_name: 'issuer_name',
  date: 'document_date',
} as const;
type RecordKey = keyof typeof RECORD_COLUMNS;
const RECORD_KEYS = Object.keys(RECORD_COLUMNS) as RecordKey[];

/**
 * JSON per insert statement, in UTF-8 bytes: well under D1's 2,000,000-byte limit on one string
 * value (the 100 KB statement limit is about the SQL text, which stays short). Limits as listed on
 * https://developers.cloudflare.com/d1/platform/limits/ (read from the cloudflare-docs source,
 * src/content/docs/d1/platform/limits.mdx, on 2026-11-26).
 */
const INSERT_CHUNK_BYTES = 512 * 1024;
const encoder = new TextEncoder();

/** A row of the certificates table. Times are epoch ms. */
export interface CertificateRow {
  id: string;
  user_id: string;
  batch_id: string | null;
  row_index: number | null;
  recipient_name: string | null;
  title: string | null;
  achievement: string | null;
  issuer_name: string | null;
  document_date: string | null;
  created_at: number;
  revoked_at: number | null;
}

export type CertificateStatus = 'valid' | 'revoked';

/** What the verification page and its JSON twin show. */
export interface CertificateRecord {
  id: string;
  status: CertificateStatus;
  recipientName: string | null;
  title: string | null;
  achievement: string | null;
  /** The issuer's name exactly as the row gave it; not checked by anyone. */
  issuerName: string | null;
  /** The row's "date" as written on the document (free text). */
  date: string | null;
  createdAt: number;
  revokedAt: number | null;
  /** The issuing account, as its sign-in email's domain (src/batch/issuer.ts). */
  issuer: Issuer;
}

/* ------------------------------------------------------------------ */
/* Ids and the fields a verified document gains                        */
/* ------------------------------------------------------------------ */

/** A new certificate id: "crt_" + 20 characters, 5 random bits each (a byte's low 5 bits: no bias, 256 is a multiple of 32). */
export function newCertificateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CERTIFICATE_ID_LENGTH));
  let id = CERTIFICATE_ID_PREFIX;
  for (const byte of bytes) id += ID_ALPHABET[byte & 31];
  return id;
}

/**
 * The canonical id for what someone typed or a link carried, or null when it cannot be one:
 * surrounding space and case are ignored, and i, l read as 1 and o as 0 (Crockford's rule).
 */
export function parseCertificateId(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const lower = input.trim().toLowerCase();
  if (!lower.startsWith(CERTIFICATE_ID_PREFIX)) return null;
  const id = CERTIFICATE_ID_PREFIX + lower.slice(CERTIFICATE_ID_PREFIX.length).replace(/[ilo]/g, (c) => (c === 'o' ? '0' : '1'));
  return ID_RE.test(id) ? id : null;
}

export function verifyUrl(appUrl: string, id: string): string {
  return `${appUrl.replace(/\/+$/, '')}/v/${id}`;
}

/**
 * certificate_id, verify_url and verify_qr (a static QR code of verify_url as an SVG data: URI)
 * for one document. They are trusted values (decision D13): the consumer hands them to the PDF
 * engine apart from the row's data (BatchRenderRequest.verification, PdfJob.trusted), after the
 * data was validated, so PDF.maxDataValueChars does not apply. A linktocard.com link's code
 * takes about 1,650 characters, the staging workers.dev origin's about 2,550 (one QR version
 * larger), see tests/batch-certificates.test.ts; the document as a whole stays under
 * PDF.maxHtmlBytes.
 */
export function verificationFields(appUrl: string, id: string): VerificationFields {
  const url = verifyUrl(appUrl, id);
  return { certificate_id: id, verify_url: url, verify_qr: qrSvgDataUri(url) };
}

/**
 * The row's data with the verification fields added. A row that fills one of them itself is
 * refused rather than overwritten: the printed id must be the one the page verifies, and
 * silently replacing a customer's own numbering would hide that. An empty value is replaced.
 * `where` names the row in the error, e.g. "rows[3]".
 */
export function withVerificationFields(data: PdfData, fields: VerificationFields, where: string): PdfData {
  for (const key of VERIFICATION_KEYS) {
    const value = data[key];
    if (value !== undefined && value !== '') {
      throw new ApiError(
        'invalid_request',
        `${where}: "${key}" is filled in by Link To Card when "verify" is on. Leave it out of the row (rename the column), or send "verify": false.`,
      );
    }
  }
  return { ...data, ...fields };
}

/** The facts the record keeps from a row: text and numbers as text, trimmed; empty or missing is null. */
export function recordFieldsFromData(data: PdfData): Record<RecordKey, string | null> {
  const fields = {} as Record<RecordKey, string | null>;
  for (const key of RECORD_KEYS) {
    const value = data[key];
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
    fields[key] = text === '' ? null : text;
  }
  return fields;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export interface NewCertificates {
  userId: string;
  /** The batch the documents belong to; null for a record made outside a batch. */
  batchId: string | null;
  rows: ReadonlyArray<{ id: string; rowIndex: number | null; data: PdfData }>;
}

const INSERT_SQL = `INSERT INTO certificates
  (id, user_id, batch_id, row_index, recipient_name, title, achievement, issuer_name, document_date, created_at)
SELECT json_extract(value, '$.id'), ?2, ?3, json_extract(value, '$.row_index'),
       json_extract(value, '$.recipient_name'), json_extract(value, '$.title'), json_extract(value, '$.achievement'),
       json_extract(value, '$.issuer_name'), json_extract(value, '$.date'), ?4
FROM json_each(?1) WHERE true
ON CONFLICT (id) DO NOTHING`;

/**
 * The insert statements for these records, for the caller's own db.batch() (so the records and
 * the batch rows that print their ids are written together, or not at all).
 */
export function certificateInsertStatements(db: D1Database, input: NewCertificates, now: number): D1PreparedStatement[] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const row of input.rows) {
    if (parseCertificateId(row.id) !== row.id) throw new Error(`certificateInsertStatements: "${row.id}" is not a certificate id`);
    const json = JSON.stringify({ id: row.id, row_index: row.rowIndex, ...recordFieldsFromData(row.data) });
    const size = encoder.encode(json).length + 1;
    if (chunk.length > 0 && bytes + size > INSERT_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(json);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.map((rows) => db.prepare(INSERT_SQL).bind(`[${rows.join(',')}]`, input.userId, input.batchId, now));
}

/** Inserts the records in one transaction; returns how many were new (a retried call inserts none). */
export async function createCertificates(db: D1Database, input: NewCertificates, now: number): Promise<number> {
  const statements = certificateInsertStatements(db, input, now);
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
}

/** Revoked records older than this (epoch ms) are no longer shown, and the daily cleanup deletes them. */
export function revokedCutoff(now: number): number {
  return now - BATCH.revokedRetentionDays * DAY_MS;
}

export function certificateStatus(row: Pick<CertificateRow, 'revoked_at'>): CertificateStatus {
  return row.revoked_at === null ? 'valid' : 'revoked';
}

export function toCertificateRecord(row: CertificateRow, accountEmail: string | null): CertificateRecord {
  return {
    id: row.id,
    status: certificateStatus(row),
    recipientName: row.recipient_name,
    title: row.title,
    achievement: row.achievement,
    issuerName: row.issuer_name,
    date: row.document_date,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    issuer: issuerFromEmail(accountEmail),
  };
}

/**
 * The public record behind GET /v/{id}, or null: unknown id, revoked longer ago than the
 * retention period, or an account that is suspended or being deleted. `id` must be canonical
 * (parseCertificateId).
 */
export async function getCertificate(db: D1Database, id: string, now: number): Promise<CertificateRecord | null> {
  const row = await db
    .prepare(
      `SELECT c.*, u.email AS account_email
       FROM certificates c JOIN users u ON u.id = c.user_id
       WHERE c.id = ?1 AND (c.revoked_at IS NULL OR c.revoked_at > ?2)
         AND u.suspended_at IS NULL AND u.deletion_requested_at IS NULL`,
    )
    .bind(id, revokedCutoff(now))
    .first<CertificateRow & { account_email: string }>();
  return row ? toCertificateRecord(row, row.account_email) : null;
}

/**
 * Revokes one of the account's certificates (idempotent: revoking it again keeps the first
 * time). Returns the record as it now is, or null when the account has no certificate with
 * this id; another account's id is "not found" too, never "forbidden".
 */
export async function revokeCertificate(
  db: D1Database,
  account: { id: string; email: string },
  id: string,
  now: number,
): Promise<CertificateRecord | null> {
  const [, selected] = await db.batch([
    db.prepare('UPDATE certificates SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(id, account.id, now),
    db.prepare('SELECT * FROM certificates WHERE id = ?1 AND user_id = ?2').bind(id, account.id),
  ]);
  const row = (selected?.results as CertificateRow[] | undefined)?.[0];
  return row ? toCertificateRecord(row, account.email) : null;
}

/**
 * Daily cleanup: deletes records revoked more than BATCH.revokedRetentionDays ago, in
 * statements of `limit` rows, at most `maxPerRun`. A database without the table yet (code
 * deployed before the migration) has nothing to delete.
 */
export async function purgeRevokedCertificates(db: D1Database, now: number, limit: number, maxPerRun: number): Promise<number> {
  let deleted = 0;
  while (deleted < maxPerRun) {
    let changes: number;
    try {
      changes = await run(
        db,
        'DELETE FROM certificates WHERE id IN (SELECT id FROM certificates WHERE revoked_at IS NOT NULL AND revoked_at <= ?1 LIMIT ?2)',
        revokedCutoff(now),
        Math.min(limit, maxPerRun - deleted),
      );
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      console.error('certificates is missing: apply the batches migration');
      return deleted;
    }
    deleted += changes;
    if (changes < limit) break;
  }
  return deleted;
}
