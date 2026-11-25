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

  it('is not misled by alt text that spells page-tree objects in a tagged PDF', () => {
    const pdf = Array.from(FIXTURES['51-pages-tagged-hostile-alt'].bytes, (byte) => String.fromCharCode(byte)).join('');
    expect(pdf).toContain('150 0 obj /Pages 150 0 R /Type /Pages /Count 1 endobj');
    expect(countPdfPages(FIXTURES['51-pages-tagged-hostile-alt'].bytes)).toBe(51);
  });

  it('is not misled by the /Count of an outline', () => {
    const pdf = Array.from(FIXTURES['12-pages-tagged'].bytes, (byte) => String.fromCharCode(byte)).join('');
    expect(pdf).toMatch(/\/Type \/Outlines/);
    expect(countPdfPages(FIXTURES['12-pages-tagged'].bytes)).toBe(12);
  });
});

describe('countPdfPages on edge cases', () => {
  /**
   * A PDF with a real cross-reference table: `objects[i]` is object i + 1. `update` appends an
   * incremental update (its own table, trailer and /Prev) that redefines or adds objects.
   */
  function pdfFile(objects: string[], options: { root?: number; update?: Record<number, string>; xref?: boolean } = {}): Uint8Array {
    let text = '%PDF-1.7\n';
    const section = (entries: Array<[number, number]>, size: number, prev?: number): string => {
      const start = text.length;
      text += 'xref\n';
      for (const [id, offset] of entries) text += `${id} 1\n${String(offset).padStart(10, '0')} 00000 n \n`;
      text += `trailer\n<< /Size ${size} /Root ${options.root ?? 1} 0 R${prev === undefined ? '' : ` /Prev ${prev}`} >>\nstartxref\n${start}\n%%EOF\n`;
      return String(start);
    };
    const entries: Array<[number, number]> = objects.map((body, i) => {
      const offset = text.length;
      text += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return [i + 1, offset];
    });
    if (options.xref === false) return encode(`${text}trailer\n<< /Root 1 0 R >>\n%%EOF`);
    const first = Number(section(entries, objects.length + 1));
    if (options.update) {
      const updated: Array<[number, number]> = Object.entries(options.update).map(([id, body]) => {
        const offset = text.length;
        text += `${id} 0 obj\n${body}\nendobj\n`;
        return [Number(id), offset];
      });
      section(updated, Math.max(objects.length, ...updated.map(([id]) => id)) + 1, first);
    }
    return encode(text);
  }
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.92 842.88] >>';

  it('reads the count through /Root, /Pages and the leaves, whatever the white space', () => {
    const pdf = pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<<  /Type   /Pages\n/Kids [3 0 R\r\n4 0 R]\n/Count\t2 >>', page, page]);
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('takes the newest definition of an object after an incremental update', () => {
    const pdf = pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', page], {
      update: { 2: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>', 4: page },
    });
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('walks a tree with several /Pages nodes and checks every /Count against its leaves', () => {
    const tree = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 3>>', '<</Type/Pages/Kids[5 0 R 6 0 R]/Count 2>>', page, page, page];
    expect(countPdfPages(pdfFile(tree))).toBe(3);
    // A /Count that disagrees with the leaves under it is not believed, at the root or below.
    expect(countPdfPages(pdfFile(tree.map((body, i) => (i === 1 ? body.replace('/Count 3', '/Count 1') : body))))).toBeNull();
    expect(countPdfPages(pdfFile(tree.map((body, i) => (i === 2 ? body.replace('/Count 2', '/Count 9') : body))))).toBeNull();
    // A tree that points back at itself is not followed.
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[2 0 R]/Count 1>>']))).toBeNull();
  });

  it('is not misled by objects spelled out inside strings: only the cross-reference table says where objects are', () => {
    const fake = Array.from({ length: 20 }, (_, i) => `${i + 1} 0 obj << /Type /Pages /Kids [] /Count 1 >> endobj`).join(' ');
    const pdf = pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>', page, page, page, `<< /Alt (${fake}) /Title (2 0 obj) >>`]);
    expect(countPdfPages(pdf)).toBe(3);
  });

  it('does not fall back to searching the file when the structure cannot be followed', () => {
    // Before: the largest /Count of any "/Type /Pages" text in the file was used, which a
    // document's own text could supply. Without a cross-reference table there is no count.
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', page], { xref: false }))).toBeNull();
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 9 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', page]))).toBeNull();
    expect(countPdfPages(pdfFile(['<</Type/Pages/Kids[2 0 R]/Count 1>>', page]))).toBeNull();
  });

  it('ignores /Count of objects that are not /Pages (for example /PagesX or an outline)', () => {
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/PagesX/Kids[3 0 R]/Count 1>>', page]))).toBeNull();
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Outlines/Count 3>>']))).toBeNull();
  });

  it('is null without a count, for zero pages, for a non-PDF and for empty bytes', () => {
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[]>>']))).toBeNull();
    expect(countPdfPages(pdfFile(['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[]/Count 0>>']))).toBeNull();
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
