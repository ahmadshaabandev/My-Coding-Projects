// Test helpers for certificate verification records (src/batch/certificates.ts).
//
// ensureCertificatesTable() creates the table the module expects ONLY when no migration has
// created it yet (CREATE TABLE IF NOT EXISTS): while the batches migration is being written
// these tests still run, and once it exists they run against the real schema unchanged, so a
// column the module needs but the migration lacks fails here.
import { env } from 'cloudflare:workers';
import { run } from '../src/db/client';
import { randomId } from '../src/lib/crypto';

const EXPECTED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS certificates (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    batch_id       TEXT,
    row_index      INTEGER,
    recipient_name TEXT,
    title          TEXT,
    achievement    TEXT,
    issuer_name    TEXT,
    document_date  TEXT,
    created_at     INTEGER NOT NULL,
    revoked_at     INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_certificates_batch ON certificates (batch_id)',
  'CREATE INDEX IF NOT EXISTS idx_certificates_revoked ON certificates (revoked_at) WHERE revoked_at IS NOT NULL',
];

export async function ensureCertificatesTable(): Promise<void> {
  for (const sql of EXPECTED_SCHEMA) await env.DB.prepare(sql).run();
}

/** A user with this sign-in email (unique per call unless `email` is given). */
export async function createAccount(email?: string, now: number = Date.now()): Promise<{ id: string; email: string }> {
  const id = randomId('u');
  const address = email ?? `${id}@lanternworks.org`;
  await run(env.DB, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, ?3, 'starter')", id, address, now);
  return { id, email: address };
}

/** The certificate starter template's sample row. */
export const SAMPLE_ROW = {
  title: 'Certificate of Completion',
  recipient_name: 'Amara Nwosu',
  achievement: 'for completing the 12-hour Advanced TypeScript workshop.',
  issuer_name: 'Lanternworks Training',
  date: 'November 25, 2026',
  signer_name: 'Daniel Reyes',
} as const;
