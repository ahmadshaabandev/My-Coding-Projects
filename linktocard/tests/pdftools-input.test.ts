// Input checks every toolkit operation shares (src/pdftools/document.ts, budget.ts, images.ts):
// what is refused before pdf-lib parses anything, and with which message.
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { LIMITS, PDF_TOOLKIT } from '../src/config';
import { estimateStructure, MAX_STRUCTURE_TOKENS } from '../src/pdftools/budget';
import { assertFileCount, assertTotalBytes, loadPdf } from '../src/pdftools/document';
import { checkImage, orientationMatrix, readImageInfo } from '../src/pdftools/images';
import { merge } from '../src/pdftools/merge';
import { FIXTURES } from './pdf-helpers';
import { expectApiError, fixture, makePdf } from './pdftools-helpers';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A one-page PDF with a classic xref table and extra objects (raw bytes, as given). */
function rawPdf(extra: Uint8Array[] = []): Uint8Array {
  const objects = [
    enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'),
    enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    enc('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n'),
    ...extra,
  ];
  const head = enc('%PDF-1.7\n');
  const offsets: number[] = [];
  let offset = head.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return concat(head, ...objects, enc(xref));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('loadPdf', () => {
  it('opens a Chrome PDF and a pdf-lib PDF', async () => {
    expect((await loadPdf(FIXTURES['12-pages'].bytes.slice(), 'files[0]')).getPageCount()).toBe(12);
    expect((await loadPdf(fixture('multi-page.pdf'), 'files[0]')).getPageCount()).toBe(8);
  });

  it('refuses encrypted files, including ones that open without a password', async () => {
    for (const name of ['encrypted-user.pdf', 'encrypted-owner.pdf'] as const) {
      const error = await expectApiError(loadPdf(fixture(name), 'files[2]'), 'invalid_request', /^files\[2\] is encrypted \(password-protected\)/);
      expect(error.details).toEqual({ reason: 'encrypted' });
      expect(error.message).toMatch(/Remove the protection/);
    }
  });

  it('refuses XFA forms', async () => {
    const error = await expectApiError(loadPdf(fixture('xfa.pdf'), 'files[0]'), 'invalid_request', /is an XFA form/);
    expect(error.details).toEqual({ reason: 'xfa' });
  });

  it('refuses files that are not PDFs', async () => {
    await expectApiError(loadPdf(fixture('logo.png'), 'files[0]'), 'unsupported_media_type', /is not a PDF/);
    await expectApiError(loadPdf(new Uint8Array(0), 'files[0]'), 'invalid_request', /is empty/);
    // The header must be within the first 1024 bytes (pdf-lib alone would search the whole file).
    const late = concat(new Uint8Array(1100).fill(0x20), FIXTURES['1-page'].bytes);
    await expectApiError(loadPdf(late, 'files[0]'), 'unsupported_media_type');
  });

  it('accepts a little junk before the header', async () => {
    const early = concat(enc('junk\n'), fixture('multi-page.pdf'));
    expect((await loadPdf(early, 'files[0]')).getPageCount()).toBe(8);
  });

  it('refuses damaged files with a client error, not a crash', async () => {
    const truncated = FIXTURES['12-pages'].bytes.slice(0, 4000);
    const error = await expectApiError(loadPdf(truncated, 'files[0]'), 'invalid_request', /damaged or incomplete/);
    expect(error.details).toEqual({ reason: 'damaged' });
    await expectApiError(loadPdf(enc('%PDF-1.7\nhello world\n%%EOF\n'), 'files[0]'), 'invalid_request', /damaged/);
  });

  it(`refuses more than ${PDF_TOOLKIT.maxPages} pages, from the xref table or after parsing`, async () => {
    const classic = await makePdf(PDF_TOOLKIT.maxPages + 1);
    const error = await expectApiError(loadPdf(classic, 'files[0]'), 'payload_too_large', /has 501 pages/);
    expect(error.details).toEqual({ pages: 501, max_pages: PDF_TOOLKIT.maxPages });

    // Object streams: src/pdf/count.ts cannot read them, the check after parsing still holds.
    const doc = await PDFDocument.load(classic);
    const compact = await doc.save({ useObjectStreams: true });
    await expectApiError(loadPdf(compact, 'files[0]'), 'payload_too_large', /501 pages/);
  });
});

describe('file and byte limits', () => {
  it('counts files', () => {
    expect(() => assertFileCount(0, 1, 20, 'PDF')).toThrow(/at least 1 PDFs|takes at least/);
    expect(() => assertFileCount(21, 1, 20, 'PDF')).toThrow(/At most 20 PDFs per request; 21 were given/);
    expect(() => assertFileCount(2, 1, 1, 'PDF')).toThrow(/takes one PDF; 2 were given/);
    expect(() => assertFileCount(1, 1, 1, 'PDF')).not.toThrow();
  });

  it(`caps all inputs together at ${PDF_TOOLKIT.maxInputBytes} bytes`, () => {
    const half = new Uint8Array(PDF_TOOLKIT.maxInputBytes / 2);
    expect(() => assertTotalBytes([half, half])).not.toThrow();
    try {
      assertTotalBytes([half, half, new Uint8Array(1)]);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'payload_too_large', details: { bytes: PDF_TOOLKIT.maxInputBytes + 1, max_bytes: PDF_TOOLKIT.maxInputBytes } });
    }
  });

  it('merge refuses a 21st file before parsing any', async () => {
    const files = Array.from({ length: PDF_TOOLKIT.maxFiles + 1 }, () => ({ bytes: new Uint8Array(1) }));
    await expectApiError(merge(files), 'invalid_request', /At most 20 PDFs/);
  });
});

describe('structure budget (memory pdf-lib would need)', () => {
  it('measures ordinary documents far below the budget', async () => {
    const chrome = await estimateStructure(FIXTURES['51-pages'].bytes, 'files[0]');
    expect(chrome.tokens).toBeGreaterThan(1000);
    expect(chrome.tokens * 10).toBeLessThan(MAX_STRUCTURE_TOKENS);
    expect(chrome.objectStreams).toBe(0);
  });

  it('counts inside object streams about what the same file costs without them', async () => {
    const classic = await makePdf(40);
    const compact = await (await PDFDocument.load(classic)).save({ useObjectStreams: true });
    const plain = await estimateStructure(classic, 'files[0]');
    const packed = await estimateStructure(compact, 'files[0]');
    expect(packed.objectStreams).toBeGreaterThan(0);
    expect(packed.inflatedBytes).toBeGreaterThan(0);
    expect(packed.tokens).toBeGreaterThan(plain.tokens * 0.5);
    expect(packed.tokens).toBeLessThan(plain.tokens * 2);
  });

  it('refuses a file whose structure is too large, before pdf-lib parses it', async () => {
    // One array of small numbers: 4.8 MB of these took 113 MB of heap in pdf-lib (budget.ts).
    const dense = rawPdf([enc(`4 0 obj\n[${'0 '.repeat(MAX_STRUCTURE_TOKENS + 10)}]\nendobj\n`)]);
    const error = await expectApiError(loadPdf(dense, 'files[0]'), 'payload_too_large', /too complex for the PDF toolkit/);
    expect(error.details).toMatchObject({ reason: 'too_complex' });
  });

  it('stops inflating an object stream past the byte cap (a deflate bomb)', async () => {
    const zeros = await deflate(enc(`4 0 ${'0 '.repeat(1_000_000)}`));
    expect(zeros.length).toBeLessThan(20_000);
    const bomb = rawPdf([
      concat(enc(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${zeros.length} /Filter /FlateDecode >>\nstream\n`), zeros, enc('\nendstream\nendobj\n')),
    ]);
    await expectApiError(estimateStructure(bomb, 'files[0]', MAX_STRUCTURE_TOKENS, 500_000), 'payload_too_large', /too complex/);
    // Under a cap it fits, the tokens inside count.
    const fits = await estimateStructure(bomb, 'files[0]', 10_000_000, 5_000_000);
    expect(fits.inflatedBytes).toBe(2_000_004);
    expect(fits.tokens).toBeGreaterThan(1_000_000);
  });

  it('refuses object streams packed with a filter it does not unpack', async () => {
    const odd = rawPdf([enc('4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length 4 /Filter /LZWDecode >>\nstream\nxxxx\nendstream\nendobj\n')]);
    await expectApiError(estimateStructure(odd, 'files[0]'), 'invalid_request', /LZWDecode/);
  });

  it('skips page content streams and strings that only look like structure', async () => {
    const content = enc(`4 0 obj\n<< /Length 9000 >>\nstream\n${'0 '.repeat(4500)}\nendstream\nendobj\n5 0 obj\n(${'1 2 3 '.repeat(1000)} \\) stream)\nendobj\n`);
    const estimate = await estimateStructure(rawPdf([content]), 'files[0]');
    expect(estimate.tokens).toBeLessThan(200);
  });
});

describe('images', () => {
  it('reads type, size and EXIF orientation from the header', () => {
    expect(readImageInfo(fixture('logo.png'))).toEqual({ type: 'image/png', width: 120, height: 40, orientation: 1 });
    expect(readImageInfo(fixture('photo.jpg'))).toEqual({ type: 'image/jpeg', width: 300, height: 200, orientation: 1 });
    expect(readImageInfo(fixture('photo-exif-6.jpg'))).toEqual({ type: 'image/jpeg', width: 200, height: 100, orientation: 6 });
    expect(readImageInfo(fixture('cmyk.jpg'))).toMatchObject({ type: 'image/jpeg', width: 80, height: 60 });
    expect(readImageInfo(fixture('multi-page.pdf'))).toBeUndefined();
  });

  it('refuses non-images, oversized files and PNGs over the pixel cap', () => {
    expect(() => checkImage(fixture('multi-page.pdf'), 'files[1]')).toThrow(/files\[1\] is not a PNG or JPEG/);
    const big = new Uint8Array(PDF_TOOLKIT.maxImageBytes + 1);
    big.set(fixture('logo.png').subarray(0, 24));
    expect(() => checkImage(big, 'image')).toThrow(/an image may be at most/);
    // A header that claims 3000 x 3000 pixels: refused before anything is decoded.
    const huge = fixture('logo.png');
    new DataView(huge.buffer).setUint32(16, 3000);
    new DataView(huge.buffer).setUint32(20, 3000);
    try {
      checkImage(huge, 'files[0]');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'payload_too_large', details: { width: 3000, height: 3000, max_pixels: LIMITS.maxImagePixels } });
    }
  });

  it('maps each EXIF orientation onto the picture as shown', () => {
    // Stored pixel (u, v), u right and v down, both 0..1. PDF draws it at (u, 1 - v); the matrix must
    // put it where EXIF says that pixel is shown (TIFF 6.0 Orientation: where row 0 and column 0 go).
    const shown = (orientation: number, u: number, v: number): [number, number] => {
      const [a, b, c, d, e, f] = orientationMatrix(orientation);
      const x = u;
      const y = 1 - v;
      return [a * x + c * y + e, 1 - (b * x + d * y + f)];
    };
    const expected: Record<number, (u: number, v: number) => [number, number]> = {
      1: (u, v) => [u, v],
      2: (u, v) => [1 - u, v],
      3: (u, v) => [1 - u, 1 - v],
      4: (u, v) => [u, 1 - v],
      5: (u, v) => [v, u],
      6: (u, v) => [1 - v, u],
      7: (u, v) => [1 - v, 1 - u],
      8: (u, v) => [v, 1 - u],
    };
    for (let orientation = 1; orientation <= 8; orientation++) {
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [0.25, 0.75]] as const) {
        const [x, y] = shown(orientation, u, v);
        const [ex, ey] = expected[orientation]!(u, v);
        expect([x, y], `orientation ${orientation} at ${u},${v}`).toEqual([expect.closeTo(ex, 9), expect.closeTo(ey, 9)]);
      }
    }
  });
});
