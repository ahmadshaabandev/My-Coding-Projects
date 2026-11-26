// Certificate verification records (src/batch/certificates.ts): ids, the fields a verified row
// gains, inserts from batch rows, lookup, revocation and the retention of revoked records.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CERTIFICATE_ID_LENGTH,
  certificateInsertStatements,
  createCertificates,
  getCertificate,
  newCertificateId,
  parseCertificateId,
  purgeRevokedCertificates,
  recordFieldsFromData,
  revokeCertificate,
  revokedCutoff,
  verificationFields,
  verifyUrl,
  withVerificationFields,
} from '../src/batch/certificates';
import { BATCH, DAY_MS, PDF } from '../src/config';
import { first, run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import { validatePdfData } from '../src/pdf/template';
import { createAccount, ensureCertificatesTable, SAMPLE_ROW } from './batch-certificate-helpers';

const APP = 'https://linktocard.test';
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

beforeAll(ensureCertificatesTable);

async function issue(account: { id: string }, data: Record<string, string | number> = SAMPLE_ROW, now = NOW): Promise<string> {
  const id = newCertificateId();
  await createCertificates(env.DB, { userId: account.id, batchId: null, rows: [{ id, rowIndex: 0, data }] }, now);
  return id;
}

describe('certificate ids', () => {
  it('are "crt_" + 20 lower-case base32 characters without i, l, o or u', () => {
    const ids = new Set<string>();
    for (let n = 0; n < 2000; n++) {
      const id = newCertificateId();
      expect(id).toMatch(/^crt_[0-9a-hjkmnp-tv-z]{20}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
    expect(CERTIFICATE_ID_LENGTH).toBe(20);
  });

  it('use every character of the alphabet about equally (no modulo bias)', () => {
    const counts = new Map<string, number>();
    const total = 4000 * CERTIFICATE_ID_LENGTH;
    for (let n = 0; n < 4000; n++) for (const c of newCertificateId().slice(4)) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(32);
    // Expected 2500 each; a 15% band is many standard deviations wide.
    for (const [c, count] of counts) expect(Math.abs(count - total / 32), c).toBeLessThan((total / 32) * 0.15);
  });

  it('parse case-insensitively and read the look-alikes i, l, o', () => {
    const id = 'crt_0123456789abcdefghjk';
    expect(parseCertificateId(id)).toBe(id);
    expect(parseCertificateId(` ${id.toUpperCase()} `)).toBe(id);
    expect(parseCertificateId('CRT_O123456789ABCDEFGHJK')).toBe(id);
    expect(parseCertificateId('crt_0i23456789abcdefghjk')).toBe('crt_0123456789abcdefghjk');
    expect(parseCertificateId('crt_0L23456789abcdefghjk')).toBe('crt_0123456789abcdefghjk');
  });

  it('refuse anything else', () => {
    for (const input of ['', 'crt_', 'crt_0123456789abcdefghj', 'crt_0123456789abcdefghjkm', 'crt_0123456789abcdefghju', 'bat_0123456789abcdefghjk', 'crt-0123456789abcdefghjk', 'crt_0123456789abcdefgh.k', `crt_${'0'.repeat(80)}`]) {
      expect(parseCertificateId(input), input).toBeNull();
    }
  });
});

describe('the fields a verified row gains', () => {
  it('are the id, the verification URL and a QR code of that URL', () => {
    const id = newCertificateId();
    const fields = verificationFields(`${APP}/`, id);
    expect(fields.certificate_id).toBe(id);
    expect(fields.verify_url).toBe(`${APP}/v/${id}`);
    expect(verifyUrl(APP, id)).toBe(fields.verify_url);
    expect(fields.verify_qr.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('fit in PDF data for linktocard.com, so the row still validates', () => {
    for (let n = 0; n < 200; n++) {
      const fields = verificationFields('https://linktocard.com', newCertificateId());
      expect(fields.verify_qr).not.toBe('');
      expect(fields.verify_qr.length).toBeLessThanOrEqual(PDF.maxDataValueChars);
      const data = withVerificationFields(validatePdfData(SAMPLE_ROW), fields, 'rows[0]');
      expect(validatePdfData(data)).toEqual(data);
    }
  });

  it('keep the QR code for an origin too long for one data value: they are trusted values (decision D13)', () => {
    // The staging origin needs a QR code one version larger, whose URI is over PDF.maxDataValueChars.
    // Before D13 it was dropped; now it goes to the engine outside the data limits (PdfJob.trusted).
    const fields = verificationFields('https://linktocard-staging.names-on-base.workers.dev', newCertificateId());
    expect(fields.verify_qr.startsWith('data:image/svg+xml,')).toBe(true);
    expect(fields.verify_qr.length).toBeGreaterThan(PDF.maxDataValueChars);
    expect(fields.verify_url).toMatch(/^https:\/\/linktocard-staging\.names-on-base\.workers\.dev\/v\/crt_/);
    // As customer data it would be refused; that is why it never travels as data.
    expect(() => validatePdfData(withVerificationFields(validatePdfData(SAMPLE_ROW), fields, 'rows[0]'))).toThrow(ApiError);
  });

  it('are added to the row without touching its other values', () => {
    const fields = verificationFields(APP, newCertificateId());
    const data = { ...SAMPLE_ROW, items: [{ description: 'x' }] };
    expect(withVerificationFields(data, fields, 'rows[0]')).toEqual({ ...data, ...fields });
    expect(withVerificationFields({ ...SAMPLE_ROW, certificate_id: '' }, fields, 'rows[0]').certificate_id).toBe(fields.certificate_id);
  });

  it('refuse a row that brings its own certificate_id, verify_url or verify_qr', () => {
    const fields = verificationFields(APP, newCertificateId());
    for (const key of ['certificate_id', 'verify_url', 'verify_qr']) {
      const attempt = () => withVerificationFields({ ...SAMPLE_ROW, [key]: 'LW-2026-0381' }, fields, 'rows[7]');
      expect(attempt).toThrow(ApiError);
      expect(attempt).toThrow(`rows[7]: "${key}" is filled in by Link To Card`);
    }
    expect(() => withVerificationFields({ ...SAMPLE_ROW, certificate_id: 0 }, fields, 'rows[0]')).toThrow(ApiError);
  });

  it('keep five facts of a row for the record, as text', () => {
    expect(recordFieldsFromData({ ...SAMPLE_ROW, title: '  Spaced  ', date: 2026, items: [] })).toEqual({
      recipient_name: 'Amara Nwosu',
      title: 'Spaced',
      achievement: SAMPLE_ROW.achievement,
      issuer_name: 'Lanternworks Training',
      date: '2026',
    });
    expect(recordFieldsFromData({ invoice_number: '1' })).toEqual({ recipient_name: null, title: null, achievement: null, issuer_name: null, date: null });
  });
});

describe('records', () => {
  it('are created from batch rows and looked up with the issuing account', async () => {
    const account = await createAccount('registrar@lanternworks.org');
    const ids = [newCertificateId(), newCertificateId(), newCertificateId()];
    const inserted = await createCertificates(
      env.DB,
      { userId: account.id, batchId: null, rows: ids.map((id, index) => ({ id, rowIndex: index, data: { ...SAMPLE_ROW, recipient_name: `Person ${index}` } })) },
      NOW,
    );
    expect(inserted).toBe(3);
    const record = await getCertificate(env.DB, ids[2]!, NOW);
    expect(record).toEqual({
      id: ids[2],
      status: 'valid',
      recipientName: 'Person 2',
      title: SAMPLE_ROW.title,
      achievement: SAMPLE_ROW.achievement,
      issuerName: SAMPLE_ROW.issuer_name,
      date: SAMPLE_ROW.date,
      createdAt: NOW,
      revokedAt: null,
      issuer: { kind: 'domain', domain: 'lanternworks.org', statement: 'Issued by a Link To Card account verified at @lanternworks.org' },
    });
    const row = await first<{ row_index: number; batch_id: string | null; user_id: string }>(env.DB, 'SELECT row_index, batch_id, user_id FROM certificates WHERE id = ?1', ids[1]);
    expect(row).toEqual({ row_index: 1, batch_id: null, user_id: account.id });
  });

  it('are inserted once, however often a queue message is retried', async () => {
    const account = await createAccount();
    const id = newCertificateId();
    const input = { userId: account.id, batchId: null, rows: [{ id, rowIndex: 4, data: SAMPLE_ROW }] };
    expect(await createCertificates(env.DB, input, NOW)).toBe(1);
    expect(await createCertificates(env.DB, input, NOW + 1000)).toBe(0);
    expect((await getCertificate(env.DB, id, NOW))?.createdAt).toBe(NOW);
  });

  it('keep unusual text exactly, quotes and all', async () => {
    const account = await createAccount();
    const hostile = `Robert'); DROP TABLE certificates;-- "<b>" ‮evil \u{1F600}`;
    const id = await issue(account, { ...SAMPLE_ROW, recipient_name: hostile });
    expect((await getCertificate(env.DB, id, NOW))?.recipientName).toBe(hostile);
  });

  it('go into a few statements for a large batch, each with one JSON parameter', async () => {
    const account = await createAccount();
    const long = 'x'.repeat(PDF.maxDataValueChars);
    const rows = Array.from({ length: 400 }, (_, index) => ({ id: newCertificateId(), rowIndex: index, data: { ...SAMPLE_ROW, achievement: long } }));
    const statements = certificateInsertStatements(env.DB, { userId: account.id, batchId: null, rows }, NOW);
    expect(statements.length).toBeGreaterThan(1);
    expect(statements.length).toBeLessThan(10);
    const results = await env.DB.batch(statements);
    expect(results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)).toBe(400);
    const count = await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?1', account.id);
    expect(count?.n).toBe(400);
    expect(certificateInsertStatements(env.DB, { userId: account.id, batchId: null, rows: [] }, NOW)).toEqual([]);
  });

  it('refuse an id that is not a certificate id (a programming error, not a client one)', () => {
    expect(() => certificateInsertStatements(env.DB, { userId: 'u_x', batchId: null, rows: [{ id: 'crt_NOPE', rowIndex: 0, data: {} }] }, NOW)).toThrow(/not a certificate id/);
  });

  it('show a personal address as such, not as its provider', async () => {
    const account = await createAccount(`${crypto.randomUUID()}@gmail.com`);
    const id = await issue(account);
    expect((await getCertificate(env.DB, id, NOW))?.issuer).toEqual({ kind: 'personal', domain: null, statement: 'Issued by a Link To Card account with a personal email address' });
  });

  it('of a suspended account, or one being deleted, are not shown', async () => {
    const suspended = await createAccount();
    const deleting = await createAccount();
    const ofSuspended = await issue(suspended);
    const ofDeleting = await issue(deleting);
    await run(env.DB, "UPDATE users SET suspended_at = ?1, suspended_reason = 'fraud' WHERE id = ?2", NOW, suspended.id);
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?1 WHERE id = ?2', NOW, deleting.id);
    expect(await getCertificate(env.DB, ofSuspended, NOW)).toBeNull();
    expect(await getCertificate(env.DB, ofDeleting, NOW)).toBeNull();
  });

  it('go when the account is deleted', async () => {
    const account = await createAccount();
    const id = await issue(account);
    await run(env.DB, 'DELETE FROM users WHERE id = ?1', account.id);
    expect(await first(env.DB, 'SELECT id FROM certificates WHERE id = ?1', id)).toBeNull();
  });

  it('of an unknown id are null', async () => {
    expect(await getCertificate(env.DB, newCertificateId(), NOW)).toBeNull();
  });
});

describe('revocation', () => {
  it('marks the record revoked, once', async () => {
    const account = await createAccount();
    const id = await issue(account);
    const revoked = await revokeCertificate(env.DB, account, id, NOW + 5000);
    expect(revoked).toMatchObject({ id, status: 'revoked', revokedAt: NOW + 5000 });
    const again = await revokeCertificate(env.DB, account, id, NOW + 9000);
    expect(again).toMatchObject({ status: 'revoked', revokedAt: NOW + 5000 });
    expect(await getCertificate(env.DB, id, NOW + 10_000)).toMatchObject({ status: 'revoked', revokedAt: NOW + 5000 });
  });

  it("is refused for another account's certificate, which reads as not found", async () => {
    const owner = await createAccount();
    const stranger = await createAccount();
    const id = await issue(owner);
    expect(await revokeCertificate(env.DB, stranger, id, NOW)).toBeNull();
    expect(await getCertificate(env.DB, id, NOW)).toMatchObject({ status: 'valid', revokedAt: null });
    expect(await revokeCertificate(env.DB, owner, newCertificateId(), NOW)).toBeNull();
  });
});

describe('retention of revoked records', () => {
  it(`shows a revoked record for ${BATCH.revokedRetentionDays} days, then neither shows nor keeps it`, async () => {
    const account = await createAccount();
    const id = await issue(account);
    const kept = await issue(account);
    await revokeCertificate(env.DB, account, id, NOW);
    const retention = BATCH.revokedRetentionDays * DAY_MS;
    expect(revokedCutoff(NOW + retention)).toBe(NOW);

    expect(await getCertificate(env.DB, id, NOW + retention - 1)).toMatchObject({ status: 'revoked' });
    expect(await purgeRevokedCertificates(env.DB, NOW + retention - 1, 500, 20_000)).toBe(0);

    // Past the period the record is hidden at once, before any cleanup has run ...
    expect(await getCertificate(env.DB, id, NOW + retention)).toBeNull();
    // ... and the daily cleanup deletes it; a valid record is never touched.
    expect(await purgeRevokedCertificates(env.DB, NOW + retention, 500, 20_000)).toBe(1);
    expect(await first(env.DB, 'SELECT id FROM certificates WHERE id = ?1', id)).toBeNull();
    expect(await getCertificate(env.DB, kept, NOW + 10 * retention)).toMatchObject({ status: 'valid' });
  });

  it('deletes in bounded statements up to the per-run cap', async () => {
    const account = await createAccount();
    const ids: string[] = [];
    for (let n = 0; n < 7; n++) ids.push(await issue(account));
    for (const id of ids) await revokeCertificate(env.DB, account, id, NOW - 400 * DAY_MS);
    expect(await purgeRevokedCertificates(env.DB, NOW, 2, 5)).toBe(5);
    expect(await purgeRevokedCertificates(env.DB, NOW, 2, 5)).toBe(2);
    expect(await purgeRevokedCertificates(env.DB, NOW, 2, 5)).toBe(0);
  });
});
