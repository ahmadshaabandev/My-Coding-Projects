// merge and split (src/pdftools/merge.ts, split.ts) on Chrome and pdf-lib PDFs.
import { describe, expect, it } from 'vitest';
import { PDF, PDF_TOOLKIT, pdfToolkitUnits } from '../src/config';
import { countPdfPages } from '../src/pdf/count';
import { merge, split } from '../src/pdftools';
import { FIXTURES } from './pdf-helpers';
import { expectApiError, fixture, hexText, makePdf, pageContent, reload } from './pdftools-helpers';

describe('merge', () => {
  it('joins files and chosen pages in the order given, keeping each page as it was', async () => {
    const out = await merge([{ bytes: FIXTURES['3-pages'].bytes.slice() }, { bytes: fixture('multi-page.pdf'), pages: '3,2' }, { bytes: fixture('rotated.pdf') }]);
    expect(out.pages).toBe(10);
    // The page counter of Chrome PDFs reads the output too: a classic cross-reference table.
    expect(countPdfPages(out.bytes)).toBe(10);
    const doc = await reload(out.bytes);
    expect(doc.getPageCount()).toBe(10);
    // Pages in the order written: "3,2" puts page 3 first.
    expect(pageContent(doc, 3)).toContain(hexText('Page 3 of 8'));
    expect(pageContent(doc, 4)).toContain(hexText('Page 2 of 8'));
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0, 0, 0, 0, 0, 90, 180, 270, 0]);
    const cropped = doc.getPages()[9]!.getCropBox();
    expect(cropped).toEqual({ x: 50, y: 100, width: 400, height: 500 });
    expect(pdfToolkitUnits('merge', out.pages)).toBe(1);
  });

  it('reorders and repeats pages of one file', async () => {
    const out = await merge([{ bytes: fixture('multi-page.pdf'), pages: '8,1-2,1' }]);
    const doc = await reload(out.bytes);
    expect(out.pages).toBe(4);
    expect([0, 1, 2, 3].map((i) => ['Page 8 of 8', 'Page 1 of 8', 'Page 2 of 8'].find((t) => pageContent(doc, i).includes(hexText(t))))).toEqual([
      'Page 8 of 8',
      'Page 1 of 8',
      'Page 2 of 8',
      'Page 1 of 8',
    ]);
  });

  it('merges a single file (a way to apply the free mark, or to normalise a PDF)', async () => {
    const out = await merge([{ bytes: fixture('multi-page.pdf') }], { freeMark: true });
    expect(out.pages).toBe(8);
    const doc = await reload(out.bytes);
    for (let i = 0; i < 8; i++) expect(pageContent(doc, i)).toContain(hexText(PDF.freeMark));
  });

  it('leaves the free mark off unless asked', async () => {
    const out = await merge([{ bytes: fixture('multi-page.pdf') }]);
    expect(pageContent(await reload(out.bytes), 0)).not.toContain(hexText(PDF.freeMark));
  });

  it(`stops at ${PDF_TOOLKIT.maxPages} output pages`, async () => {
    const three = await makePdf(300);
    const error = await expectApiError(merge([{ bytes: three }, { bytes: three.slice() }]), 'payload_too_large', /merged PDF would have 600 pages/);
    expect(error.details).toEqual({ pages: 600, max_pages: PDF_TOOLKIT.maxPages });
    // Choosing pages keeps it under the cap.
    expect((await merge([{ bytes: three }, { bytes: three.slice(), pages: '1-200' }])).pages).toBe(500);
  });

  it('names the file whose pages are wrong, and refuses a bad file anywhere in the list', async () => {
    await expectApiError(merge([{ bytes: fixture('multi-page.pdf') }, { bytes: fixture('multi-page.pdf'), pages: '9' }]), 'invalid_request', /^files\[1\]\.pages: "9" names page 9/);
    await expectApiError(merge([{ bytes: fixture('multi-page.pdf') }, { bytes: fixture('encrypted-owner.pdf') }]), 'invalid_request', /^files\[1\] is encrypted/);
    await expectApiError(merge([]), 'invalid_request', /at least 1/);
  });
});

describe('split', () => {
  it('makes one file per range', async () => {
    const result = await split(fixture('multi-page.pdf'), { ranges: '1-3,5,7-' });
    expect(result.outputs.map((o) => [o.range, o.pages])).toEqual([
      ['1-3', 3],
      ['5', 1],
      ['7-8', 2],
    ]);
    expect(result.pages).toBe(6);
    const second = await reload(result.outputs[1]!.bytes);
    expect(pageContent(second, 0)).toContain(hexText('Page 5 of 8'));
    for (const output of result.outputs) expect(countPdfPages(output.bytes)).toBe(output.pages);
    // Charged per output: three files of 1-3 pages are 3 units, not 1.
    expect(result.outputs.reduce((n, o) => n + pdfToolkitUnits('split', o.pages), 0)).toBe(3);
  });

  it('makes a new file every n pages', async () => {
    const result = await split(fixture('multi-page.pdf'), { every: 3 });
    expect(result.outputs.map((o) => o.range)).toEqual(['1-3', '4-6', '7-8']);
    expect(result.outputs.map((o) => o.pages)).toEqual([3, 3, 2]);
  });

  it('marks every output for Free', async () => {
    const result = await split(fixture('rotated.pdf'), { every: 2, freeMark: true });
    for (const output of result.outputs) {
      const doc = await reload(output.bytes);
      for (let i = 0; i < doc.getPageCount(); i++) expect(pageContent(doc, i)).toContain(hexText(PDF.freeMark));
    }
  });

  it('takes ranges or every, never both or neither', async () => {
    await expectApiError(split(fixture('multi-page.pdf'), {}), 'invalid_request', /either "ranges".*or "every"/);
    await expectApiError(split(fixture('multi-page.pdf'), { ranges: '1', every: 2 }), 'invalid_request', /not both/);
    for (const every of [0, -1, 1.5, Number.NaN]) await expectApiError(split(fixture('multi-page.pdf'), { every }), 'invalid_request', /"every" must be a whole number/);
    await expectApiError(split(fixture('multi-page.pdf'), { ranges: '2-1' }), 'invalid_request', /^ranges: "2-1" runs backwards/);
  });

  it(`makes at most ${PDF_TOOLKIT.maxFiles} files`, async () => {
    const pdf = await makePdf(21);
    const error = await expectApiError(split(pdf, { every: 1 }), 'invalid_request', /would make 21 files; at most 20/);
    expect(error.details).toEqual({ outputs: 21, max_outputs: PDF_TOOLKIT.maxFiles });
    await expectApiError(split(pdf, { ranges: Array.from({ length: 21 }, (_, i) => String(i + 1)).join(',') }), 'invalid_request', /21 files/);
    expect((await split(pdf, { every: 2 })).outputs).toHaveLength(11);
  });

  it(`caps the pages written, also when ranges overlap (at most ${PDF_TOOLKIT.maxPages})`, async () => {
    const pdf = await makePdf(300);
    const error = await expectApiError(split(pdf, { ranges: '1-300,1-300' }), 'payload_too_large', /split files would have 600 pages/);
    expect(error.details).toEqual({ pages: 600, max_pages: PDF_TOOLKIT.maxPages });
  });
});
