// CPU cost of the largest toolkit jobs, measured inside workerd on real Chrome PDFs (the
// 51-page fixture of tests/fixtures/pdf, 50 pages taken from each copy). The work is synchronous
// and single-threaded, so the elapsed time printed here is the job's CPU time on this machine;
// it is what the Worker's [limits] cpu_ms (wrangler.toml) is compared with. The ceilings below
// only catch a pathological regression; the printed numbers are what to read
// (npx vitest run tests/pdftools-cpu.test.ts --silent=false).
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { countPdfPages } from '../src/pdf/count';
import { addFreeMark, fields, merge, protect, split, stamp } from '../src/pdftools';
import { estimateStructure, MAX_STRUCTURE_TOKENS } from '../src/pdftools/budget';
import { FIXTURES } from './pdf-helpers';

const CEILING_MS = 30_000;

async function timed<T>(label: string, work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await work();
  const ms = Math.round(performance.now() - start);
  console.log(`[pdftools cpu] ${label}: ${ms} ms`);
  return { result, ms };
}

const chrome = (): Uint8Array => FIXTURES['51-pages'].bytes.slice();

describe('PDF toolkit CPU time on large documents', () => {
  it('merges 200 pages (four Chrome PDFs)', async () => {
    const files = Array.from({ length: 4 }, () => ({ bytes: chrome(), pages: '1-50' }));
    const { result, ms } = await timed('merge 4 x 50 = 200 pages', () => merge(files));
    expect(result.pages).toBe(200);
    expect(countPdfPages(result.bytes)).toBe(200);
    expect(ms).toBeLessThan(CEILING_MS);
  });

  it('stamps, marks, splits and protects 500 pages', async () => {
    const files = Array.from({ length: 10 }, () => ({ bytes: chrome(), pages: '1-50' }));
    const big = (await timed('merge 10 x 50 = 500 pages', () => merge(files))).result;
    expect(big.pages).toBe(500);
    console.log(`[pdftools cpu] 500-page input: ${big.bytes.byteLength} bytes`);

    const stamped = await timed('stamp text on 500 pages', () => stamp(big.bytes, { text: { text: 'PAID', rotation: 45 } }));
    expect(stamped.result.pages).toBe(500);
    expect(stamped.ms).toBeLessThan(CEILING_MS);

    const free = await timed('stamp text + free mark on 500 pages', () => stamp(big.bytes, { text: { text: 'DRAFT' }, freeMark: true }));
    expect(free.ms).toBeLessThan(CEILING_MS);

    const marked = await timed('free mark alone on 500 pages', () => addFreeMark(big.bytes));
    expect(countPdfPages(marked.result.bytes)).toBe(500);

    const parts = await timed('split 500 pages into 20 files', () => split(big.bytes, { every: 25 }));
    expect(parts.result.outputs).toHaveLength(20);

    const locked = await timed('protect 500 pages (AES-256)', () => protect(big.bytes, { userPassword: 'open me' }));
    expect(locked.result.pages).toBe(500);

    const listed = await timed('fields of a 500-page PDF without a form', () => fields(big.bytes));
    expect(listed.result.fields).toEqual([]);
  });

  // The costliest file the structure budget still admits: 500 pages carrying 55 link
  // annotations each (27,500 small objects, about 907,000 tokens). Its parsed form held 44 MB
  // of heap in Node; this measures its CPU time in workerd.
  it('stamps and merges the most complex 500-page file the budget admits', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont('Helvetica');
    for (let p = 0; p < 500; p++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Page ${p + 1}`, { x: 72, y: 760, size: 18, font });
      const annots = [];
      for (let a = 0; a < 55; a++) {
        const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10 + a, 10, 20 + a, 20], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of(`https://example.com/${p}/${a}`) } });
        annots.push(doc.context.register(link));
      }
      page.node.set(PDFName.of('Annots'), doc.context.obj(annots));
    }
    const bytes = await doc.save({ useObjectStreams: false });
    const estimate = (await timed('structure estimate of the complex file', () => estimateStructure(bytes, 'files[0]'))).result;
    console.log(`[pdftools cpu] complex file: ${bytes.byteLength} bytes, ${estimate.tokens} tokens (budget ${MAX_STRUCTURE_TOKENS})`);
    expect(estimate.tokens).toBeLessThan(MAX_STRUCTURE_TOKENS);

    const stamped = await timed('stamp text on the complex 500-page file', () => stamp(bytes, { text: { text: 'PAID' }, freeMark: true }));
    expect(stamped.result.pages).toBe(500);
    expect(stamped.ms).toBeLessThan(CEILING_MS);
    const merged = await timed('merge the complex 500-page file', () => merge([{ bytes }]));
    expect(merged.result.pages).toBe(500);
    expect(merged.ms).toBeLessThan(CEILING_MS);
  });
});
