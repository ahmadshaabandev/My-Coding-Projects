// Small files that cost pdf-lib (or the toolkit's own pre-scan) far more than their size, from
// the build-v3 security review (SEC-1 to SEC-4). Each must be refused, quickly, before the work
// happens; and pdf-lib's object pools must not keep what a request parsed (src/pdftools/pools.ts).
import { PDFDocument, PDFName, PDFRef } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDF_TOOLKIT } from '../src/config';
import { estimateStructure } from '../src/pdftools/budget';
import { loadPdf } from '../src/pdftools/document';
import { fields, fill } from '../src/pdftools/forms';
import { merge } from '../src/pdftools/merge';
import { ORIGINAL_FACTORIES, POOLS_COLLECTABLE, pdfObjectPoolSizes, sweepPdfObjectPools } from '../src/pdftools/pools';
import { split } from '../src/pdftools/split';
import { expectApiError } from './pdftools-helpers';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A PDF of the given objects (1-based: objs[1] is object 1) with a classic xref table. */
function rawPdf(objs: (string | Uint8Array)[]): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    const body = objs[id]!;
    const piece = concat([enc(`${id} 0 obj\n`), typeof body === 'string' ? enc(body) : body, enc('\nendobj\n')]);
    offsets[id] = offset;
    offset += piece.length;
    parts.push(piece);
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(enc(xref));
  return concat(parts);
}

const PAGE_OBJECTS = [
  '',
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
];

/** An empty cross-reference stream whose /Index claims `count` entries (the reviewer's xref-bomb-1000000.pdf, 455 bytes). */
const xrefBomb = (count: number, extra = ''): Uint8Array =>
  rawPdf([...PAGE_OBJECTS, `<< /Type /XRef /Size ${10 + count} /Index [10 ${count}] /W [0 0 0] /Length 0 ${extra}>>\nstream\n\nendstream`]);

/** A page tree whose every level lists one branch `fan` times: fan^(depth+1) pages when walked as a tree (tree-bomb-<depth>-<fan>.pdf). */
function treeBomb(depth: number, fan: number): Uint8Array {
  const objs: string[] = [''];
  const kidsOf = (id: number): string => Array.from({ length: fan }, () => `${id} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count 1 /Kids [${kidsOf(3)}] >>`;
  for (let k = 0; k < depth; k++) objs[3 + k] = `<< /Type /Pages /Parent 2 0 R /Count 1 /Kids [${kidsOf(4 + k)}] >>`;
  objs[3 + depth] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>';
  return rawPdf(objs);
}

/** A form whose field tree lists one child `fan` times per level: fan^depth fields when walked as a tree (field-bomb-<depth>-<fan>.pdf). */
function fieldBomb(depth: number, fan: number): Uint8Array {
  const first = 5;
  const leaf = first + depth;
  const objs: string[] = [''];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${first} 0 R] >> >>`;
  objs[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [${leaf} 0 R] >>`;
  objs[4] = '<< >>';
  for (let k = 0; k < depth; k++) objs[first + k] = `<< /T (n${k}) /Kids [${Array.from({ length: fan }, () => `${first + k + 1} 0 R`).join(' ')}] >>`;
  objs[leaf] = '<< /FT /Tx /T (x) /V (v) /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /P 3 0 R >>';
  return rawPdf(objs);
}

/** A form of `count` distinct text fields, each its own widget on the one page. */
function wideForm(count: number): Uint8Array {
  const objs: string[] = [''];
  const firstField = 4;
  const ids = Array.from({ length: count }, (_, i) => firstField + i);
  objs[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${ids.map((id) => `${id} 0 R`).join(' ')}] >> >>`;
  objs[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>';
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`;
  for (const [i, id] of ids.entries()) objs[id] = `<< /FT /Tx /T (f${i}) /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /P 3 0 R >>`;
  return rawPdf(objs);
}

async function timedMs(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work().catch(() => undefined);
  return performance.now() - start;
}

describe('cross-reference streams that claim more entries than they hold (SEC-1)', () => {
  it('refuses the 455-byte xref bomb in the pre-scan, before pdf-lib makes a million references', async () => {
    const bomb = xrefBomb(1_000_000);
    expect(bomb.byteLength).toBeLessThan(500);
    const before = pdfObjectPoolSizes().refs;
    const error = await expectApiError(estimateStructure(bomb, 'files[0]'), 'invalid_request', /cross-reference stream claims more entries than it holds/);
    expect(error.details).toEqual({ reason: 'damaged' });
    await expectApiError(loadPdf(bomb, 'files[0]'), 'invalid_request', /files\[0\] could not be read as a PDF/);
    expect(pdfObjectPoolSizes().refs - before).toBeLessThan(100);
  });

  it('refuses an xref stream whose /W, /Index or /Size is an indirect object, which pdf-lib would look up', async () => {
    const indirectIndex = rawPdf([...PAGE_OBJECTS, '<< /Type /XRef /Size 5 /Index 5 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream', '[10 1000000]']);
    await expectApiError(estimateStructure(indirectIndex, 'files[0]'), 'invalid_request', /claims more entries/);
    const indirectW = rawPdf([...PAGE_OBJECTS, '<< /Type /XRef /Size 5 /Index [0 5] /W 5 0 R /Length 0 >>\nstream\n\nendstream', '[0 0 0]']);
    await expectApiError(estimateStructure(indirectW, 'files[0]'), 'invalid_request', /claims more entries/);
    const indirectSize = rawPdf([...PAGE_OBJECTS, '<< /Type /XRef /Size 5 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream', '1000000']);
    await expectApiError(estimateStructure(indirectSize, 'files[0]'), 'invalid_request', /claims more entries/);
  });

  it('counts three tokens per declared entry of an honest cross-reference stream', async () => {
    const data = new Uint8Array(4 * 4); // four entries of W [1 2 1]
    const honest = rawPdf([...PAGE_OBJECTS, concat([enc('<< /Type /XRef /Size 4 /W [1 2 1] /Length 16 >>\nstream\n'), data, enc('\nendstream')])]);
    const estimate = await estimateStructure(honest, 'files[0]');
    const without = await estimateStructure(rawPdf(PAGE_OBJECTS), 'files[0]');
    // the stream's own dictionary adds tokens too; the entries add 3 x 4
    expect(estimate.tokens - without.tokens).toBeGreaterThanOrEqual(12);
  });

  it('still opens files pdf-lib writes with object and cross-reference streams', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 30; i++) doc.addPage([200, 200]);
    const bytes = await doc.save({ useObjectStreams: true });
    expect(new TextDecoder('latin1').decode(bytes)).toMatch(/\/Type \/XRef/);
    await estimateStructure(bytes, 'files[0]');
    expect((await loadPdf(bytes, 'files[0]')).getPageCount()).toBe(30);
  });
});

describe("pdf-lib's object pools (SEC-1)", () => {
  it('are replaced by collectable pools that keep identity and the static names', () => {
    expect(POOLS_COLLECTABLE).toBe(true);
    expect(PDFRef.of).not.toBe(ORIGINAL_FACTORIES.refOf);
    expect(PDFName.of).not.toBe(ORIGINAL_FACTORIES.nameOf);
    expect(PDFRef.of(12, 0)).toBe(PDFRef.of(12, 0));
    expect(PDFRef.of(12)).toBe(PDFRef.of(12, 0));
    expect(PDFRef.of(12, 1)).not.toBe(PDFRef.of(12, 0));
    expect(PDFName.of('Type')).toBe(PDFName.Type);
    expect(PDFName.of('Length')).toBe(PDFName.Length);
    expect(PDFName.of('A#20B')).toBe(PDFName.of('A B'));
    expect(pdfObjectPoolSizes().pinnedNames).toBeGreaterThanOrEqual(25);
  });

  it('make the same instances as the original factories', () => {
    const names = ['Type', 'A B', 'A#20B', 'x#2fy', 'x#2Fy', '(paren)', 'Ünïcödé', '中文', 'a#b', '#', 'tab\there', '%pct', '~'];
    for (const name of names) {
      const ours = PDFName.of(name);
      const original = ORIGINAL_FACTORIES.nameOf(name);
      expect(ours).toBeInstanceOf(PDFName);
      expect(ours.asString(), name).toBe(original.asString());
      expect(ours.decodeText(), name).toBe(original.decodeText());
      expect(Object.keys(ours)).toEqual(Object.keys(original));
    }
    for (const [n, g] of [[1, 0], [7, 3], [123456, 65535]] as const) {
      const ours = PDFRef.of(n, g);
      const original = ORIGINAL_FACTORIES.refOf(n, g);
      expect(ours).toBeInstanceOf(PDFRef);
      expect(ours.toString()).toBe(original.toString());
      expect({ ...ours }).toEqual({ ...original });
      expect(ours.sizeInBytes()).toBe(original.sizeInBytes());
    }
  });

  it('let a sweep drop entries nothing holds any more', () => {
    // Without a way to force a collection here, check what a sweep keeps: every live instance.
    const held = Array.from({ length: 5000 }, (_, i) => PDFRef.of(900_000 + i, 0));
    sweepPdfObjectPools();
    for (const [i, ref] of held.entries()) expect(PDFRef.of(900_000 + i, 0)).toBe(ref);
    expect(PDFName.of('Type')).toBe(PDFName.Type);
  });
});

describe('page and field trees that reuse their nodes (SEC-2)', () => {
  it('refuses a 1.4 KB page tree of 10^8 paths as damaged, quickly', async () => {
    const bomb = treeBomb(7, 10);
    expect(bomb.byteLength).toBeLessThan(1500);
    const ms = await timedMs(async () => {
      const error = await expectApiError(loadPdf(bomb, 'files[0]'), 'invalid_request', /files\[0\] could not be read as a PDF/);
      expect(error.details).toEqual({ reason: 'damaged' });
    });
    expect(ms).toBeLessThan(1000);
  });

  it('stops counting distinct pages as soon as they pass the page limit', async () => {
    const pages = PDF_TOOLKIT.maxPages + 1;
    const objs: string[] = ['', '<< /Type /Catalog /Pages 2 0 R >>'];
    const ids = Array.from({ length: pages }, (_, i) => 3 + i);
    objs[2] = `<< /Type /Pages /Count ${pages} /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`;
    for (const id of ids) objs[id] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>';
    // An xref stream instead of a table, so the quick count of src/pdf/count.ts does not answer first.
    const doc = await PDFDocument.load(rawPdf(objs));
    const bytes = await doc.save({ useObjectStreams: true });
    const error = await expectApiError(loadPdf(bytes, 'files[0]'), 'payload_too_large', new RegExp(`files\\[0\\] has (at least )?${pages} pages`));
    expect(error.details).toMatchObject({ max_pages: PDF_TOOLKIT.maxPages });
  });

  it('refuses a 1.3 KB field tree of 10^6 paths as damaged, for "fields" and "fill"', async () => {
    const bomb = fieldBomb(6, 10);
    expect(bomb.byteLength).toBeLessThan(1300);
    const ms = await timedMs(async () => {
      await expectApiError(fields(bomb), 'invalid_request', /could not be read as a PDF/);
      await expectApiError(fill(bomb, { values: { x: 'y' } }), 'invalid_request', /could not be read as a PDF/);
    });
    expect(ms).toBeLessThan(1000);
  });

  it('caps the nodes of a form at PDF_TOOLKIT.maxFormFields', async () => {
    const atCap = await fields(wideForm(PDF_TOOLKIT.maxFormFields));
    expect(atCap.fields).toHaveLength(PDF_TOOLKIT.maxFormFields);
    const error = await expectApiError(fields(wideForm(PDF_TOOLKIT.maxFormFields + 1)), 'payload_too_large', /fields and widgets/);
    expect(error.details).toEqual({ reason: 'too_many_fields', max_form_fields: PDF_TOOLKIT.maxFormFields });
  });
});

describe('the structure pre-scan stays linear (SEC-3)', () => {
  it('scans 40,000 empty streams after one "obj" in well under a second', async () => {
    const body = '%PDF-1.7\n1 0 obj\n<< >>\n' + 'stream\nendstream\n'.repeat(40_000) + 'endobj\n%%EOF\n';
    const bytes = enc(body);
    expect(bytes.byteLength).toBeGreaterThan(600_000);
    const start = performance.now();
    const estimate = await estimateStructure(bytes, 'files[0]');
    const ms = performance.now() - start;
    expect(estimate.tokens).toBeGreaterThanOrEqual(40_000);
    expect(ms).toBeLessThan(1000);
  });

  it('still finds /Type /ObjStm in a dictionary that follows another stream', async () => {
    // Tokens inside an object stream count; the second stream's dictionary starts after the first one's end.
    const objStm = '<< /Type /ObjStm /N 1 /First 4 /Length 40 >>\nstream\n' + '5 0 ' + '[1 2 3 4 5 6 7 8 9 10 11 12 13 14 15]  ' + '\nendstream';
    const bytes = enc(`%PDF-1.7\n1 0 obj\n<< /Length 0 >>\nstream\n\nendstream\n${objStm}\nendobj\n%%EOF\n`);
    const estimate = await estimateStructure(bytes, 'files[0]');
    expect(estimate.objectStreams).toBe(1);
  });
});

describe('the size of what a request makes (SEC-4)', () => {
  /** `pages` pages that all draw one uncompressed image of `imageBytes` bytes. */
  function sharedImagePdf(pages: number, imageBytes: number): Uint8Array {
    const side = Math.floor(Math.sqrt(imageBytes / 3));
    const pixels = new Uint8Array(side * side * 3);
    for (let at = 0; at < pixels.length; at += 65536) crypto.getRandomValues(pixels.subarray(at, Math.min(pixels.length, at + 65536)));
    const objs: (string | Uint8Array)[] = ['', '<< /Type /Catalog /Pages 2 0 R >>'];
    const pageIds = Array.from({ length: pages }, (_, i) => 5 + i);
    objs[2] = `<< /Type /Pages /Count ${pages} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
    objs[3] = concat([enc(`<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, enc('\nendstream')]);
    objs[4] = '<< /Length 30 >>\nstream\nq 200 0 0 200 0 0 cm /Im0 Do Q\nendstream';
    for (const id of pageIds) objs[id] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 3 0 R >> >> /Contents 4 0 R >>';
    return rawPdf(objs);
  }

  it('stops a split whose files together pass PDF_TOOLKIT.maxOutputBytes', async () => {
    const imageBytes = 2 * 1024 * 1024;
    const pages = Math.ceil(PDF_TOOLKIT.maxOutputBytes / imageBytes) + 2;
    expect(pages).toBeLessThanOrEqual(PDF_TOOLKIT.maxFiles);
    const input = sharedImagePdf(pages, imageBytes);
    expect(input.byteLength).toBeLessThan(imageBytes + 100_000);
    const error = await expectApiError(split(input, { every: 1 }), 'payload_too_large', /the PDF toolkit makes at most 25 MB per request/);
    expect(error.details).toMatchObject({ reason: 'result_too_large', max_bytes: PDF_TOOLKIT.maxOutputBytes });
    expect(error.details!.bytes as number).toBeGreaterThan(PDF_TOOLKIT.maxOutputBytes);
    expect(error.details!.bytes as number).toBeLessThan(PDF_TOOLKIT.maxOutputBytes + 2 * imageBytes);
    // The same pages in fewer files share the image, and fit.
    const fewer = await split(input, { every: pages });
    expect(fewer.outputs).toHaveLength(1);
    expect((await merge([{ bytes: input }])).pages).toBe(pages);
  });
});

describe('counting a request body before parsing it (SEC-5)', () => {
  it('countJsonTokens skips strings, honours escapes and stops at the cap', async () => {
    const { countJsonTokens } = await import('../src/routes/pdf-toolkit');
    expect(countJsonTokens(enc('{"a":[1,2,{"b":3}]}'), 100)).toBe(7);
    expect(countJsonTokens(enc('{"a\\"[,{:":"x\\\\"}'), 100)).toBe(2);
    expect(countJsonTokens(enc('[],'.repeat(1000)), 10)).toBe(11);
    // A 20 MB base64 string is one jump: no per-byte work inside strings.
    const big = new Uint8Array(20 * 1024 * 1024).fill(0x41);
    big[0] = 0x22;
    big[big.length - 1] = 0x22;
    const start = performance.now();
    expect(countJsonTokens(big, 10)).toBe(0);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('countOccurrences is linear even for a pattern that almost matches everywhere', async () => {
    const { countOccurrences } = await import('../src/routes/pdf-toolkit');
    expect(countOccurrences(enc('--b x --b y --b--'), enc('--b'), 10)).toBe(3);
    expect(countOccurrences(enc('aaaa'), enc('aa'), 10)).toBe(3);
    const pattern = enc(`--${'x'.repeat(68)}y`);
    const data = new Uint8Array(20 * 1024 * 1024).fill(0x78);
    const start = performance.now();
    expect(countOccurrences(data, pattern, 30)).toBe(0);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
