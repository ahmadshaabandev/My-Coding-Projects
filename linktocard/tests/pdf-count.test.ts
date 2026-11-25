// Page counting on real Chrome PDFs (tests/fixtures/pdf) and on hand-made edge cases. A count
// that cannot be read is null (a failed render), never 0.
import { describe, expect, it } from 'vitest';
import { countPdfPages } from '../src/pdf/count';
import { FIXTURES, type FixtureName } from './pdf-helpers';

const encode = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('countPdfPages on Chrome output', () => {
  it.each(Object.keys(FIXTURES) as FixtureName[])('%s', (name) => {
    expect(countPdfPages(FIXTURES[name].bytes)).toBe(FIXTURES[name].pages);
  });

  it('follows the catalog to the root /Pages node of a tree with several /Pages nodes', () => {
    const pdf = Array.from(FIXTURES['51-pages'].bytes, (byte) => String.fromCharCode(byte)).join('');
    // Chrome's page tree has a fan-out of 8: seven leaf /Pages nodes and the root, which counts all 51.
    expect([...pdf.matchAll(/\/Type \/Pages\b/g)].length).toBe(8);
    expect(countPdfPages(FIXTURES['51-pages'].bytes)).toBe(51);
  });

  it('is not misled by the /Count of an outline', () => {
    const pdf = Array.from(FIXTURES['12-pages-tagged'].bytes, (byte) => String.fromCharCode(byte)).join('');
    expect(pdf).toMatch(/\/Type \/Outlines/);
    expect(countPdfPages(FIXTURES['12-pages-tagged'].bytes)).toBe(12);
  });
});

describe('countPdfPages on edge cases', () => {
  const doc = (body: string, trailer = 'trailer\n<< /Root 1 0 R >>\n%%EOF') => encode(`%PDF-1.7\n${body}\n${trailer}`);

  it('reads the root count through /Root and /Pages, whatever the white space', () => {
    const pdf = doc('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj\r\n<<  /Type   /Pages\n/Kids [3 0 R]\n/Count\t7 >>\nendobj');
    expect(countPdfPages(pdf)).toBe(7);
  });

  it('takes the newest definition of an object after an incremental update', () => {
    const pdf = doc('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 3>>endobj\n2 0 obj<</Type/Pages/Count 4>>endobj');
    expect(countPdfPages(pdf)).toBe(4);
  });

  it('falls back to the largest /Count of a /Type /Pages node when the catalog cannot be followed', () => {
    const pdf = doc('5 0 obj<</Type/Pages/Count 8/Parent 9 0 R>>endobj\n9 0 obj<</Type/Pages/Count 20>>endobj\n7 0 obj<</Type/Outlines/Count 99>>endobj', '%%EOF');
    expect(countPdfPages(pdf)).toBe(20);
  });

  it('ignores /Count of objects that are not /Pages (for example /PagesX or an outline)', () => {
    expect(countPdfPages(doc('4 0 obj<</Type/PagesX/Count 5>>endobj\n6 0 obj<</Type/Outlines/Count 3>>endobj', '%%EOF'))).toBeNull();
  });

  it('is null without a count, for zero pages, for a non-PDF and for empty bytes', () => {
    expect(countPdfPages(doc('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]>>endobj'))).toBeNull();
    expect(countPdfPages(doc('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0>>endobj'))).toBeNull();
    expect(countPdfPages(encode('<html>not a pdf</html>'))).toBeNull();
    expect(countPdfPages(new Uint8Array(0))).toBeNull();
  });

  it('is null for a truncated Chrome PDF that lost its page tree', () => {
    const bytes = FIXTURES['3-pages'].bytes;
    const pdf = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    const cut = pdf.indexOf('/Type /Pages');
    expect(cut).toBeGreaterThan(0);
    expect(countPdfPages(bytes.subarray(0, cut))).toBeNull();
  });
});
