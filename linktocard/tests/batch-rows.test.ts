// Validation of a bulk-documents request (src/batch/rows.ts): template, rows by plan, each row
// through validatePdfData, page options, verification, file name patterns and the capacity check.
import { describe, expect, it } from 'vitest';
import { parseCertificateId } from '../src/batch/certificates';
import {
  assertBatchFits,
  batchUnitsNeeded,
  compileFilenamePattern,
  dedupeFilenames,
  defaultFilenamePattern,
  maxRowsFor,
  parseBatchRequest,
  rowFilename,
  type BatchRequestContext,
} from '../src/batch/rows';
import { BATCH, PDF } from '../src/config';
import { ApiError } from '../src/lib/errors';
import type { JsonObject } from '../src/lib/http';
import type { UsageSummary } from '../src/types';
import { certificateRows } from './batch-helpers';

const APP = 'https://linktocard.test';
const pro: BatchRequestContext = { plan: 'pro', appUrl: APP };

function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

const parse = (body: JsonObject, ctx = pro) => parseBatchRequest(body, ctx);

describe('the request', () => {
  it('accepts a certificate batch, verified by default, with one name per row', () => {
    const parsed = parse({ template: 'certificate', rows: certificateRows(3) });
    expect(parsed.template).toBe('certificate');
    expect(parsed.verify).toBe(true);
    expect(parsed.pdf).toEqual({ format: null, landscape: null });
    expect(parsed.filenamePattern).toBe('certificate-{{n}}.pdf');
    expect(parsed.rows.map((row) => [row.index, row.filename])).toEqual([
      [0, 'certificate-1.pdf'],
      [1, 'certificate-2.pdf'],
      [2, 'certificate-3.pdf'],
    ]);
    expect(parsed.rows[1]!.data.recipient_name).toBe('Recipient 2');
    // The verification fields are added when the row renders, not stored with it.
    expect(parsed.rows[0]!.data.certificate_id).toBeUndefined();
    const ids = parsed.rows.map((row) => row.certificateId);
    for (const id of ids) expect(parseCertificateId(id!)).toBe(id);
    expect(new Set(ids).size).toBe(3);
  });

  it('verifies other templates only when asked, and the certificate template unless told not to', () => {
    expect(parse({ template: 'invoice', rows: [{ invoice_number: '1' }] }).verify).toBe(false);
    expect(parse({ template: 'invoice', rows: [{ invoice_number: '1' }] }).rows[0]!.certificateId).toBeNull();
    expect(parse({ template: 'invoice', rows: [{ invoice_number: '1' }], verify: true }).rows[0]!.certificateId).toMatch(/^crt_/);
    expect(parse({ template: 'certificate', rows: certificateRows(1), verify: false }).rows[0]!.certificateId).toBeNull();
    // A custom template id is accepted by shape; the route resolves it.
    expect(parse({ template: 't_abc123', rows: [{ name: 'x' }] }).verify).toBe(false);
    expect(refusal(() => parse({ template: 'invoice', rows: [{}], verify: 'yes' })).message).toContain('"verify" must be true or false');
  });

  it('takes pdf.format and pdf.landscape, and refuses anything else there', () => {
    expect(parse({ template: 'report', rows: [{}], pdf: { format: 'Letter', landscape: true } }).pdf).toEqual({ format: 'letter', landscape: true });
    expect(parse({ template: 'report', rows: [{}], pdf: { landscape: false } }).pdf).toEqual({ format: null, landscape: false });
    expect(parse({ template: 'report', rows: [{}], pdf: null }).pdf).toEqual({ format: null, landscape: null });
    expect(refusal(() => parse({ template: 'report', rows: [{}], pdf: { format: 'a3' } })).message).toContain('"format" must be one of');
    expect(refusal(() => parse({ template: 'report', rows: [{}], pdf: { landscape: 'sideways' } })).message).toContain('"landscape" must be true or false');
    expect(refusal(() => parse({ template: 'report', rows: [{}], pdf: { margin: '1cm' } })).message).toContain('"pdf.margin"');
    expect(refusal(() => parse({ template: 'report', rows: [{}], pdf: 'a4' })).message).toContain('"pdf" must be an object');
  });

  it('refuses unknown fields, a missing or malformed template and bad rows', () => {
    expect(refusal(() => parse({ template: 'invoice', rows: [{}], tempalte: 'x' })).details).toEqual({ unknown_fields: ['tempalte'] });
    for (const template of [undefined, '', 'has space', 'x'.repeat(65), 42]) {
      const error = refusal(() => parse({ template, rows: [{}] } as JsonObject));
      expect(error.code).toBe('invalid_request');
      expect(error.message).toContain('"template" is required');
    }
    for (const rows of [undefined, [], 'a,b', { 0: {} }]) {
      expect(refusal(() => parse({ template: 'invoice', rows } as JsonObject)).message).toContain('"rows" must be a list of at least one row');
    }
  });

  it('validates every row with validatePdfData and names the row in the error', () => {
    const notObject = refusal(() => parse({ template: 'invoice', rows: [{}, 'text'] }));
    expect(notObject.message).toMatch(/^rows\[1\] must be an object/);
    expect(notObject.details).toEqual({ row: 1 });

    const badKey = refusal(() => parse({ template: 'invoice', rows: [{ ok: 1 }, { ok: 2 }, { 'Bad Key': 'x' }] }));
    expect(badKey.code).toBe('invalid_request');
    expect(badKey.message).toMatch(/^rows\[2\] key "Bad Key" is not valid/);
    expect(badKey.details).toEqual({ row: 2 });

    const manyKeys = Object.fromEntries(Array.from({ length: PDF.maxDataKeys + 1 }, (_, i) => [`k${i}`, 'v']));
    expect(refusal(() => parse({ template: 'invoice', rows: [manyKeys] })).message).toBe(
      `rows[0] may contain at most ${PDF.maxDataKeys} keys; this one has ${PDF.maxDataKeys + 1}.`,
    );
    expect(refusal(() => parse({ template: 'invoice', rows: [{ note: 'x'.repeat(PDF.maxDataValueChars + 1) }] })).message).toMatch(
      /^rows\[0\]: Data value "note" is longer than/,
    );
    expect(refusal(() => parse({ template: 'invoice', rows: [{ paid: true }] })).message).toMatch(/^rows\[0\]: Data value "paid" must be text or a number/);
    // Lists and nulls are handled exactly as POST /v1/pdf handles them.
    const ok = parse({ template: 'invoice', rows: [{ amount: 12.5, items: [{ description: 'Design', amount: '1,200.00' }], gone: null }] });
    expect(ok.rows[0]!.data).toEqual({ amount: 12.5, items: [{ description: 'Design', amount: '1,200.00' }] });
  });
});

describe('rows per plan', () => {
  it('follow BATCH.maxRows', () => {
    expect(maxRowsFor('free')).toBe(BATCH.maxRows.free);
    expect(maxRowsFor('starter')).toBe(BATCH.maxRows.starter);
    expect(maxRowsFor('pro')).toBe(BATCH.maxRows.pro);
    expect(parse({ template: 'invoice', rows: Array.from({ length: BATCH.maxRows.free }, () => ({})) }, { plan: 'free', appUrl: APP }).rows).toHaveLength(
      BATCH.maxRows.free,
    );
  });

  it('above the plan: plan_required when a higher plan takes that many, invalid_request above every plan', () => {
    const freeOver = refusal(() => parse({ template: 'invoice', rows: Array.from({ length: BATCH.maxRows.free + 1 }, () => ({})) }, { plan: 'free', appUrl: APP }));
    expect(freeOver.code).toBe('plan_required');
    expect(freeOver.message).toContain('Starter plan takes');
    expect(freeOver.details).toEqual({ rows: BATCH.maxRows.free + 1, max_rows: BATCH.maxRows.free, plan: 'free' });

    const freeFarOver = refusal(() => parse({ template: 'invoice', rows: Array.from({ length: BATCH.maxRows.starter + 1 }, () => ({})) }, { plan: 'free', appUrl: APP }));
    expect(freeFarOver.message).toContain('Pro plan takes');

    const proOver = refusal(() => parse({ template: 'invoice', rows: Array.from({ length: BATCH.maxRows.pro + 1 }, () => ({})) }));
    expect(proOver.code).toBe('invalid_request');
    expect(proOver.message).toContain('Split the rows into several batches');
  });
});

describe('verified rows', () => {
  it('may not fill the verification fields themselves', () => {
    for (const key of ['certificate_id', 'verify_url', 'verify_qr']) {
      const error = refusal(() => parse({ template: 'certificate', rows: [...certificateRows(2), { ...certificateRows(1)[0], [key]: 'mine' }] }));
      expect(error.message).toContain(`rows[2]: "${key}" is filled in by Link To Card`);
    }
    // Without verification the names are ordinary data.
    expect(parse({ template: 'certificate', rows: [{ certificate_id: 'mine' }], verify: false }).rows[0]!.data.certificate_id).toBe('mine');
  });

  it('must leave room for the three fields Link To Card adds', () => {
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    expect(parse({ template: 'invoice', verify: true, rows: [keys(PDF.maxDataKeys - 3)] }).rows).toHaveLength(1);
    const error = refusal(() => parse({ template: 'invoice', verify: true, rows: [keys(1), keys(PDF.maxDataKeys - 2)] }));
    expect(error.message).toContain(`rows[1] has ${PDF.maxDataKeys - 2} fields`);
    expect(error.details).toEqual({ row: 1 });
  });
});

describe('file names', () => {
  it('fill {{field}} and {{n}}, as safe ASCII names ending in .pdf', () => {
    const parsed = parse({
      template: 'certificate',
      filename: '{{recipient_name}} - {{ n }}',
      rows: [{ recipient_name: 'Zoë Ångström' }, { recipient_name: 'José/Ana: "100%"' }, { recipient_name: 'Ünïcödé 中文' }],
    });
    // sanitizeFilename (src/pdf/page.ts): accents dropped, anything else outside ASCII becomes "-".
    expect(parsed.rows.map((row) => row.filename)).toEqual(['Zoe Angstrom - 1.pdf', 'Jose-Ana- -100- - 2.pdf', 'Unicode - - 3.pdf']);
    for (const row of parsed.rows) expect(row.filename).toMatch(/^[A-Za-z0-9 ._()-]+\.pdf$/);
  });

  it('use numbers as written, ignore lists, and fall back to "<template>-<n>.pdf" when nothing is left', () => {
    const parts = compileFilenamePattern('{{invoice_number}}{{items}}.pdf');
    expect(rowFilename(parts, { invoice_number: 2026001, items: [{ a: 'b' }] }, 0, 'invoice')).toBe('2026001.pdf');
    expect(rowFilename(parts, {}, 4, 'invoice')).toBe('invoice-5.pdf');
    expect(rowFilename(compileFilenamePattern('{{name}}'), { name: '中文' }, 9, 'document')).toBe('document-10.pdf');
  });

  it('are unique ignoring case: later duplicates get " (2)", " (3)"', () => {
    const parsed = parse({ template: 'invoice', filename: '{{client}}.pdf', rows: [{ client: 'Acme' }, { client: 'ACME' }, { client: 'acme' }, { client: 'Beta' }] });
    expect(parsed.rows.map((row) => row.filename)).toEqual(['Acme.pdf', 'ACME (2).pdf', 'acme (3).pdf', 'Beta.pdf']);
    // A numbered name that is itself taken is skipped.
    expect(dedupeFilenames(['a.pdf', 'a (2).pdf', 'a.pdf'])).toEqual(['a.pdf', 'a (2).pdf', 'a (3).pdf']);
    // A name at the length limit stays within it once numbered.
    const long = `${'x'.repeat(PDF.maxFilenameChars - 4)}.pdf`;
    const [first, second] = dedupeFilenames([long, long]);
    expect(first).toBe(long);
    expect(second!.length).toBeLessThanOrEqual(PDF.maxFilenameChars);
    expect(second).toMatch(/^x+ \(2\)\.pdf$/);
  });

  it('default to "<starter>-{{n}}.pdf", or "document-{{n}}.pdf" for an own template', () => {
    expect(defaultFilenamePattern('receipt')).toBe('receipt-{{n}}.pdf');
    expect(defaultFilenamePattern('t_abc')).toBe('document-{{n}}.pdf');
    expect(parse({ template: 't_abc', rows: [{}, {}] }).rows.map((row) => row.filename)).toEqual(['document-1.pdf', 'document-2.pdf']);
  });

  it('refuse patterns that are not text, too long, or with braces that are not placeholders', () => {
    expect(refusal(() => compileFilenamePattern(7)).message).toContain('"filename" must be a pattern');
    expect(refusal(() => compileFilenamePattern('   ')).message).toContain('"filename" must be a pattern');
    expect(refusal(() => compileFilenamePattern('x'.repeat(PDF.maxFilenameChars + 1))).message).toContain(`at most ${PDF.maxFilenameChars} characters`);
    expect(refusal(() => compileFilenamePattern('{{Recipient Name}}.pdf')).message).toContain('"{{Recipient Name}}" is not a placeholder');
    expect(refusal(() => compileFilenamePattern('{{a.b}}')).message).toContain('is not a placeholder');
    expect(refusal(() => compileFilenamePattern('{{name}.pdf')).message).toContain('a "{" or "}" that is not part of a placeholder');
    expect(refusal(() => compileFilenamePattern('{{{n}}}')).message).toContain('a "{" or "}" that is not part of a placeholder');
    expect(refusal(() => parse({ template: 'invoice', rows: [{}], filename: '{{oops' })).code).toBe('invalid_request');
  });
});

describe('capacity before a batch is accepted', () => {
  const usage = (total_remaining: number): UsageSummary => ({
    plan: 'starter',
    period_start: Date.UTC(2026, 10, 1),
    period_end: Date.UTC(2026, 11, 1),
    limit: 1000,
    used: 1000 - total_remaining,
    remaining: total_remaining,
    topup_remaining: 0,
    total_remaining,
    cache_days: 30,
    watermark: false,
  } as UsageSummary);

  it('needs PDF.baseUnits images per row, allowance and top-ups together', () => {
    expect(batchUnitsNeeded(10)).toBe(10 * PDF.baseUnits);
    expect(() => assertBatchFits(usage(10 * PDF.baseUnits), 10, APP)).not.toThrow();
    const error = refusal(() => assertBatchFits(usage(10 * PDF.baseUnits - 1), 10, APP));
    expect(error.code).toBe('quota_exceeded');
    expect(error.status).toBe(402);
    expect(error.message).toContain(`needs at least ${10 * PDF.baseUnits} images`);
    expect(error.message).toContain(`${APP}/pricing`);
    expect(error.details?.units_needed).toBe(10 * PDF.baseUnits);
  });
});
