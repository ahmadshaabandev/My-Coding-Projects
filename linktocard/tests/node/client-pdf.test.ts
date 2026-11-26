// The in-browser PDF tools, /tools/merge-pdf and /tools/image-to-pdf: the engine bundle they load
// (scripts/build-browser-bundles.mts -> assets/js/vendor/pdf-local.js) is built here and run in
// Node exactly as a browser gets it, on PDFs made with @cantoo/pdf-lib and the images in
// tests/fixtures/client-pdf (made once with Pillow). The results are read back with
// @cantoo/pdf-lib, a different build of the parser than the one under test.
//
// Also checked: what the pages promise. The bundle and the page scripts contain no way to send
// data (fetch, XMLHttpRequest, beacons, sockets), JPEG metadata stays out of the PDF while the
// picture data is copied unchanged, and the rules match the PDF toolkit API (src/pdftools).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from '@cantoo/pdf-lib';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF } from '../../src/config';
import { orientationMatrix as apiOrientationMatrix, readImageInfo as apiReadImageInfo } from '../../src/pdftools/images';
import { BROWSER_BUNDLES, bundleBrowserCode, dedupePackages, licenseBanner, type BundleResult } from '../../scripts/build-browser-bundles.mts';
import type * as EngineModule from '../../site/src-browser/pdf-local';

type Engine = typeof EngineModule;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = join(ROOT, 'tests/fixtures/client-pdf');
const JS = join(ROOT, 'site/public/assets/js');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const file = (name: string, bytes: Uint8Array = fixture(name)) => ({ name, bytes });

const BUNDLE = BROWSER_BUNDLES.find((bundle) => bundle.out.endsWith('/pdf-local.js'))!;
const scratch = mkdtempSync(join(tmpdir(), 'ltc-client-pdf-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let built: BundleResult;
let engine: Engine;
beforeAll(async () => {
  built = await bundleBrowserCode(BUNDLE);
  const out = join(scratch, 'pdf-local.js');
  writeFileSync(out, built.code);
  engine = (await import(pathToFileURL(out).href)) as Engine;
});

const LIMITS = { maxPages: 1000, maxImagePixels: 30_000_000 };

/** A PDF whose pages have the given sizes (each page is identified by its size). */
async function makePdf(sizes: Array<[number, number]>, extra?: (doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  await extra?.(doc);
  return doc.save();
}

const sizesOf = (doc: PDFDocument): Array<[number, number]> => doc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string; file?: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { name: string; code: string; message: string; file?: string };
    expect(e.name).toBe('LocalPdfError');
    return { code: e.code, message: e.message, file: e.file };
  }
  throw new Error('expected the promise to be rejected');
}

/** The decoded content stream of a page and its one image XObject. */
function pageParts(doc: PDFDocument, index: number): { content: string; image: PDFRawStream } {
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const content = streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode())).join('\n');
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  const [ref] = xobjects.values();
  return { content, image: doc.context.lookup(ref!) as PDFRawStream };
}

const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array): number => Buffer.from(haystack).indexOf(Buffer.from(needle));

/* ------------------------------------------------------------------ the bundle */

describe('the bundle (assets/js/vendor/pdf-local.js)', () => {
  it('is pdf-lib 1.17.1 and its dependencies, each with its licence text in the banner', () => {
    expect(built.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      '@pdf-lib/standard-fonts@1.0.0',
      '@pdf-lib/upng@1.0.1',
      'pako@1.0.11',
      'pdf-lib@1.17.1',
      'tslib@1.14.1',
    ]);
    const banner = built.code.slice(0, built.code.indexOf('*/') + 2);
    expect(banner.startsWith('/*! assets/js/vendor/pdf-local.js: ')).toBe(true);
    for (const pkg of built.packages) {
      expect(banner).toContain(`${pkg.name} ${pkg.version}: ${pkg.license}`);
      // The first and last lines of each licence, as the file has them.
      const lines = pkg.licenseText.split(/\r?\n/).filter((line) => line.trim() !== '');
      expect(banner).toContain(lines[0]!.trim());
      expect(banner).toContain(lines.at(-1)!.trim());
    }
    expect(banner).toContain('Copyright (c) 2019 Andrew Dillon');
  });

  it('ends its banner only once, even when a licence text contains "*/"', () => {
    const banner = licenseBanner(BUNDLE, [{ name: 'x', version: '1.0.0', license: 'MIT', licenseText: 'a */ b' }]);
    expect(banner.match(/\*\//g)).toHaveLength(1);
    expect(banner).toContain('a * / b');
  });

  it('has no way to send data anywhere, and no eval', () => {
    const forbidden = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|RTCPeerConnection|\beval\s*\(|new Function\s*\(|\bimport\s*\(/;
    expect(built.code.match(forbidden)?.[0] ?? null).toBeNull();
    // A module that imports nothing: it cannot pull further code from anywhere.
    expect(built.code).not.toMatch(/(^|[;}\s])import\s*[{*"'\w]/m);
  });

  it('stays small enough to be worth loading in a browser (pdf-lib, not the larger fork)', () => {
    // pdf-lib 1.17.1 measured 432 KB minified for these operations, @cantoo/pdf-lib 597 KB.
    expect(Buffer.byteLength(built.code)).toBeLessThan(470 * 1024);
    expect(built.code).not.toContain('html-entities');
  });

  it('is the same bytes on every build', async () => {
    expect((await bundleBrowserCode(BUNDLE)).code).toBe(built.code);
  });

  it('bundles one copy of a package that npm installed several times at the same version', async () => {
    // npm nests pako 1.0.11 under pdf-lib and both its helpers (the root has pako 0.2.9).
    const dir = join(scratch, 'dedupe');
    const pkg = (at: string, name: string, version: string, code: string): void => {
      mkdirSync(join(dir, at), { recursive: true });
      writeFileSync(join(dir, at, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }));
      writeFileSync(join(dir, at, 'index.js'), code);
    };
    for (const user of ['a', 'b', 'c']) pkg(`node_modules/${user}`, user, '1.0.0', `import dup from 'dup'; export default [${JSON.stringify(user)}, dup];`);
    pkg('node_modules/a/node_modules/dup', 'dup', '2.0.0', "export default 'DUP-2-' + globalThis.marker;");
    pkg('node_modules/b/node_modules/dup', 'dup', '2.0.0', "export default 'DUP-2-' + globalThis.marker;");
    pkg('node_modules/c/node_modules/dup', 'dup', '3.0.0', "export default 'DUP-3-' + globalThis.marker;");
    writeFileSync(join(dir, 'entry.js'), "import a from 'a'; import b from 'b'; import c from 'c'; console.log(a, b, c);");
    const bundle = async (plugins: ReturnType<typeof dedupePackages>[]): Promise<string> =>
      (await build({ absWorkingDir: dir, entryPoints: ['entry.js'], bundle: true, format: 'esm', write: false, logLevel: 'silent', plugins })).outputFiles[0]!.text;
    const count = (text: string, needle: string): number => text.split(needle).length - 1;
    expect(count(await bundle([]), 'DUP-2-')).toBe(2);
    const deduped = await bundle([dedupePackages()]);
    expect(count(deduped, 'DUP-2-')).toBe(1);
    // Another version is other code: it stays.
    expect(count(deduped, 'DUP-3-')).toBe(1);
  });

  it('carries none of src/config.ts (only a type comes from there)', () => {
    expect(built.code).not.toContain(PDF.freeMark);
    expect(built.code).not.toContain('ltc_session');
  });
});

/* ------------------------------------------------------------------ merge */

describe('mergePdfs', () => {
  it('copies every page of every file, in the order given', async () => {
    const a = await makePdf([[200, 200]]);
    const b = await makePdf([[300, 300], [310, 310]]);
    const c = await makePdf([[400, 400], [410, 410], [420, 420]]);
    const merged = await engine.mergePdfs([file('a.pdf', a), file('b.pdf', b), file('c.pdf', c)], LIMITS);
    expect(merged.pages).toBe(6);
    const doc = await PDFDocument.load(merged.bytes);
    expect(sizesOf(doc)).toEqual([[200, 200], [300, 300], [310, 310], [400, 400], [410, 410], [420, 420]]);

    const reordered = await PDFDocument.load((await engine.mergePdfs([file('c.pdf', c), file('a.pdf', a)], LIMITS)).bytes);
    expect(sizesOf(reordered)).toEqual([[400, 400], [410, 410], [420, 420], [200, 200]]);
  });

  it('keeps what a page draws (its fonts and text)', async () => {
    const text = await makePdf([[300, 200]], async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.getPage(0).drawText('Hello merge', { x: 20, y: 100, size: 18, font });
    });
    const doc = await PDFDocument.load((await engine.mergePdfs([file('t.pdf', text), file('t2.pdf', text)], LIMITS)).bytes);
    for (const index of [0, 1]) {
      const font = doc.getPage(index).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
      expect(font.keys().length).toBe(1);
    }
  });

  it('writes a plain PDF: classic cross-reference table, Producer "Link To Card", no dates', async () => {
    const merged = await engine.mergePdfs([file('a.pdf', await makePdf([[100, 100]]))], LIMITS);
    const text = new TextDecoder('latin1').decode(merged.bytes);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toMatch(/\nxref\n/);
    const doc = await PDFDocument.load(merged.bytes, { updateMetadata: false });
    expect(doc.getProducer()).toBe('Link To Card');
    expect(doc.getCreationDate()).toBeUndefined();
    expect(text).not.toContain('pdf-lib');
  });

  it('leaves out what belongs to the whole document: bookmarks and the form field list', async () => {
    const withForm = await makePdf([[400, 300]], (doc) => {
      doc.getForm().createTextField('full_name').addToPage(doc.getPage(0), { x: 20, y: 20, width: 200, height: 24 });
      doc.catalog.set(PDFName.of('Outlines'), doc.context.obj({ Type: 'Outlines', Count: 0 }));
    });
    const doc = await PDFDocument.load((await engine.mergePdfs([file('form.pdf', withForm)], LIMITS)).bytes);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
    // The widget annotation travels with its page: what it shows stays on the page.
    expect(doc.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it('refuses encrypted PDFs, also when they open without a password', async () => {
    for (const security of [{ userPassword: 'open-me', ownerPassword: 'owner' }, { ownerPassword: 'owner-only' }]) {
      const locked = await makePdf([[200, 200]], (doc) => doc.encrypt(security));
      const refused = await rejection(engine.mergePdfs([file('ok.pdf', await makePdf([[100, 100]])), file('locked.pdf', locked)], LIMITS));
      expect(refused).toMatchObject({ code: 'encrypted', file: 'locked.pdf' });
      expect(refused.message).toContain('“locked.pdf” is password-protected');
    }
  });

  it('refuses XFA forms, like the API', async () => {
    const needsRendering = await makePdf([[200, 200]], (doc) => doc.catalog.set(PDFName.of('NeedsRendering'), doc.context.obj(true)));
    expect(await rejection(engine.readPdf(file('dyn.pdf', needsRendering), LIMITS))).toMatchObject({ code: 'xfa', file: 'dyn.pdf' });
    const xfa = await makePdf([[200, 200]], (doc) => {
      doc.getForm();
      doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).set(PDFName.of('XFA'), doc.context.obj([]));
    });
    expect((await rejection(engine.readPdf(file('static.pdf', xfa), LIMITS))).code).toBe('xfa');
  });

  it('refuses what is not a PDF, empty files and damaged files, naming the file', async () => {
    expect(await rejection(engine.readPdf(file('photo.jpg'), LIMITS))).toMatchObject({ code: 'not_pdf', file: 'photo.jpg' });
    expect(await rejection(engine.readPdf(file('empty.pdf', new Uint8Array()), LIMITS))).toMatchObject({ code: 'empty' });
    const broken = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');
    expect(await rejection(engine.readPdf(file('broken.pdf', broken), LIMITS))).toMatchObject({ code: 'damaged', file: 'broken.pdf' });
    expect((await rejection(engine.mergePdfs([], LIMITS))).code).toBe('empty');
  });

  it('accepts a few bytes before the header, as readers do, but not a header further in', async () => {
    const pdf = await makePdf([[100, 100]]);
    const junk = new TextEncoder().encode('junk\n');
    expect(await engine.readPdf(file('j.pdf', Buffer.concat([junk, pdf])), LIMITS)).toEqual({ pages: 1 });
    expect(engine.hasPdfHeader(Buffer.concat([new Uint8Array(2000), pdf]))).toBe(false);
  });

  it('stops at the page limit, for one file and for the result', async () => {
    const three = await makePdf([[100, 100], [100, 100], [100, 100]]);
    const one = await rejection(engine.readPdf(file('three.pdf', three), { maxPages: 2 }));
    expect(one).toMatchObject({ code: 'too_many_pages', file: 'three.pdf' });
    expect(one.message).toContain('has 3 pages');
    const total = await rejection(engine.mergePdfs([file('a.pdf', three), file('b.pdf', three)], { maxPages: 5 }));
    expect(total.code).toBe('too_many_pages');
    expect(total.message).toContain('would have 6 pages');
    expect((await engine.mergePdfs([file('a.pdf', three), file('b.pdf', three)], { maxPages: 6 })).pages).toBe(6);
  });
});

/* ------------------------------------------------------------------ image headers */

describe('readImageHeader', () => {
  it.each([
    ['photo.jpg', 'jpeg', 60, 40, 1],
    ['photo-progressive.jpg', 'jpeg', 60, 40, 1],
    ['gray.jpg', 'jpeg', 30, 20, 1],
    ['photo-exif-6.jpg', 'jpeg', 60, 40, 6],
    ['alpha.png', 'png', 50, 30, 1],
    ['palette.png', 'png', 40, 24, 1],
    ['gray16.png', 'png', 20, 12, 1],
    ['photo.webp', 'webp', 48, 32, 1],
    ['lossless.webp', 'webp', 20, 10, 1],
    ['alpha.webp', 'webp', 24, 12, 1],
    ['anim.gif', 'gif', 33, 21, 1],
  ])('%s: %s %i x %i, orientation %i', (name, kind, width, height, orientation) => {
    expect(engine.readImageHeader(fixture(name))).toEqual({ kind, width, height, orientation });
  });

  it('reads EXIF in either byte order', () => {
    const jpeg = fixture('photo.jpg');
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const little of [true, false]) {
        expect(engine.readImageHeader(withExif(jpeg, orientation, little))?.orientation).toBe(orientation);
      }
    }
    expect(engine.readImageHeader(withExif(jpeg, 9, true))?.orientation).toBe(1);
  });

  it('says null for anything else, and for cut-off headers', () => {
    expect(engine.readImageHeader(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(engine.readImageHeader(fixture('photo.jpg').subarray(0, 30))).toBeNull();
    expect(engine.readImageHeader(fixture('alpha.png').subarray(0, 20))).toBeNull();
    expect(engine.readImageHeader(new Uint8Array())).toBeNull();
  });

  it('agrees with the API (src/pdftools/images.ts) on size, orientation and the drawing matrix', () => {
    for (const name of ['photo.jpg', 'photo-progressive.jpg', 'gray.jpg', 'photo-exif-6.jpg', 'alpha.png', 'palette.png', 'gray16.png']) {
      const ours = engine.readImageHeader(fixture(name))!;
      const api = apiReadImageInfo(fixture(name))!;
      expect({ width: ours.width, height: ours.height, orientation: ours.orientation }, name).toEqual({ width: api.width, height: api.height, orientation: api.orientation });
    }
    for (let orientation = 0; orientation <= 9; orientation++) expect(engine.orientationMatrix(orientation)).toEqual(apiOrientationMatrix(orientation));
  });
});

/** The JPEG with an APP1 EXIF segment holding only an Orientation tag, right after SOI. */
function withExif(jpeg: Uint8Array, orientation: number, little: boolean): Uint8Array {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  if (little) {
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
  } else {
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
  }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** A segment: marker and payload, with the length field filled in. */
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/* ------------------------------------------------------------------ JPEG metadata */

describe('stripJpegMetadata', () => {
  const scanOf = (jpeg: Uint8Array): Uint8Array => {
    // From the first SOS to EOI: the compressed picture.
    const start = Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xda]));
    const end = Buffer.from(jpeg).lastIndexOf(Buffer.from([0xff, 0xd9]));
    return jpeg.subarray(start, end + 2);
  };

  it('drops EXIF, XMP, IPTC, comments and data after EOI, and keeps the picture byte for byte', () => {
    const base = fixture('photo-exif-6.jpg');
    const soi = base.subarray(0, 2);
    const rest = base.subarray(2);
    const dirty = Buffer.concat([
      soi,
      segment(0xfe, Buffer.from('a comment', 'latin1')),
      segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>', 'latin1')),
      segment(0xed, Buffer.from('Photoshop 3.0\0IPTC', 'latin1')),
      segment(0xe2, Buffer.from('MPF\0multi-picture', 'latin1')),
      segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile', 'latin1')),
      segment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1')),
      rest,
      Buffer.from('appended second picture Exif', 'latin1'),
    ]);
    const clean = engine.stripJpegMetadata(dirty)!;
    const text = Buffer.from(clean).toString('latin1');
    for (const gone of ['Exif', 'xmpmeta', 'IPTC', 'a comment', 'MPF', 'appended']) expect(text, gone).not.toContain(gone);
    for (const kept of ['JFIF', 'ICC_PROFILE', 'Adobe']) expect(text, kept).toContain(kept);
    expect(indexOfBytes(clean, scanOf(base))).toBeGreaterThan(0);
    expect(Buffer.from(clean.subarray(-2))).toEqual(Buffer.from([0xff, 0xd9]));
    // Still the same picture: same size (orientation is read before stripping).
    expect(engine.readImageHeader(clean)).toMatchObject({ kind: 'jpeg', width: 60, height: 40, orientation: 1 });
  });

  it('keeps every scan of a progressive JPEG', () => {
    const progressive = fixture('photo-progressive.jpg');
    const clean = engine.stripJpegMetadata(progressive)!;
    expect(Buffer.from(clean).toString('latin1').split('\xff\xda').length).toBe(Buffer.from(progressive).toString('latin1').split('\xff\xda').length);
    expect(clean.byteLength).toBeLessThanOrEqual(progressive.byteLength);
    expect(indexOfBytes(clean, scanOf(progressive))).toBeGreaterThan(0);
  });

  it('gives null for a file it cannot follow', () => {
    const jpeg = fixture('photo.jpg');
    expect(engine.stripJpegMetadata(new TextEncoder().encode('not a jpeg'))).toBeNull();
    // A segment whose length runs past the end of the file.
    expect(engine.stripJpegMetadata(Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe0, 0xff, 0xff, 1, 2])]))).toBeNull();
  });
});

/* ------------------------------------------------------------------ image pages */

describe('imagePageLayout', () => {
  it('lists the PDF renderer formats plus auto, as the API does', () => {
    expect([...engine.IMAGE_PAGE_SIZES]).toEqual([...PDF.formats, 'auto']);
  });

  it('auto: the page is the image, 1 pixel = 1 point, held to 3..14,400 points', () => {
    expect(engine.imagePageLayout(1200, 800, { pageSize: 'auto' })).toEqual({ pageWidth: 1200, pageHeight: 800, x: 0, y: 0, width: 1200, height: 800, clip: false });
    const huge = engine.imagePageLayout(28_800, 7_200, { pageSize: 'auto' });
    expect([huge.pageWidth, huge.pageHeight]).toEqual([14_400, 3_600]);
    expect(engine.imagePageLayout(1, 1, { pageSize: 'auto' }).pageWidth).toBe(3);
  });

  it('paper: turned to suit the image unless told otherwise, the whole image centred within the margin', () => {
    const wide = engine.imagePageLayout(600, 400, { pageSize: 'a4' });
    expect([wide.pageWidth, wide.pageHeight]).toEqual([841.89, 595.28]);
    // Limited by the width: 841.89 / 600 is smaller than 595.28 / 400.
    expect(wide.width).toBeCloseTo(841.89);
    expect(wide.height).toBeCloseTo(561.26);
    expect(wide.x).toBeCloseTo(0);
    expect(wide.y).toBeCloseTo((595.28 - 561.26) / 2);
    const tall = engine.imagePageLayout(400, 600, { pageSize: 'letter' });
    expect([tall.pageWidth, tall.pageHeight]).toEqual([612, 792]);
    expect([engine.imagePageLayout(600, 400, { pageSize: 'a5', orientation: 'portrait' }).pageWidth]).toEqual([419.53]);
    const margin = engine.imagePageLayout(400, 600, { pageSize: 'letter', margin: 36 });
    expect(margin.height).toBeCloseTo(792 - 72);
    expect(margin.y).toBeCloseTo(36);
  });

  it('fill: covers the page and clips; margins are ignored', () => {
    const fill = engine.imagePageLayout(600, 400, { pageSize: 'a4', orientation: 'portrait', fit: 'fill', margin: 50 });
    expect(fill.clip).toBe(true);
    expect(fill.height).toBeCloseTo(841.89);
    expect(fill.width).toBeCloseTo(841.89 * 1.5);
    expect(fill.x).toBeLessThan(0);
  });

  it('refuses options it does not know', () => {
    expect(() => engine.imagePageLayout(10, 10, { pageSize: 'a3' as never })).toThrow(/page size must be one of: a4, letter, a5, auto/);
    expect(() => engine.imagePageLayout(10, 10, { fit: 'stretch' as never })).toThrow(/fit must be one of/);
    expect(() => engine.imagePageLayout(10, 10, { margin: -1 })).toThrow(/margin/);
  });
});

describe('imagesToPdf', () => {
  it('makes one page per image, in order, with the sizes the options give', async () => {
    const names = ['photo.jpg', 'alpha.png', 'gray.jpg', 'palette.png', 'gray16.png', 'photo-progressive.jpg'];
    const made = await engine.imagesToPdf(names.map((name) => file(name)), { pageSize: 'auto', ...LIMITS });
    expect(made.pages).toBe(6);
    const doc = await PDFDocument.load(made.bytes);
    expect(sizesOf(doc)).toEqual([[60, 40], [50, 30], [30, 20], [40, 24], [20, 12], [60, 40]]);

    const a4 = await PDFDocument.load((await engine.imagesToPdf([file('photo.jpg'), file('photo-exif-6.jpg')], { pageSize: 'a4', ...LIMITS })).bytes);
    expect(sizesOf(a4)).toEqual([[842, 595], [595, 842]]);
  });

  it('copies a JPEG picture unchanged, without its EXIF metadata', async () => {
    const jpeg = fixture('photo-exif-6.jpg');
    const doc = await PDFDocument.load((await engine.imagesToPdf([file('p.jpg', jpeg)], { pageSize: 'auto', ...LIMITS })).bytes);
    const { image } = pageParts(doc, 0);
    expect(image.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    const stored = image.getContents();
    const scan = jpeg.subarray(Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xda])));
    expect(indexOfBytes(stored, scan)).toBeGreaterThan(0);
    expect(Buffer.from(stored).toString('latin1')).not.toContain('Exif');
    expect(Buffer.from(jpeg).toString('latin1')).toContain('Exif');
  });

  it('draws a sideways phone photo upright (EXIF orientation 6)', async () => {
    const doc = await PDFDocument.load((await engine.imagesToPdf([file('photo-exif-6.jpg')], { pageSize: 'auto', ...LIMITS })).bytes);
    // Stored 60 x 40, shown 40 x 60: the page is the shown size, and the image goes through the turn.
    expect(sizesOf(doc)).toEqual([[40, 60]]);
    const { content, image } = pageParts(doc, 0);
    expect(image.dict.get(PDFName.of('Width'))?.toString()).toBe('60');
    expect(content).toMatch(/40 0 0 60 0 0 cm\s+0 -1 1 0 0 1 cm\s+\/\S+ Do/);
  });

  it('keeps PNG transparency as a soft mask and stores 16-bit PNGs with 8 bits a colour', async () => {
    const doc = await PDFDocument.load((await engine.imagesToPdf([file('alpha.png'), file('gray16.png')], { pageSize: 'auto', ...LIMITS })).bytes);
    expect(pageParts(doc, 0).image.dict.has(PDFName.of('SMask'))).toBe(true);
    expect(pageParts(doc, 1).image.dict.get(PDFName.of('BitsPerComponent'))?.toString()).toBe('8');
  });

  it('clips a "fill" page to the page', async () => {
    const doc = await PDFDocument.load((await engine.imagesToPdf([file('photo.jpg')], { pageSize: 'a4', orientation: 'portrait', fit: 'fill', ...LIMITS })).bytes);
    expect(pageParts(doc, 0).content).toMatch(/0 0 595\.28 841\.89 re\s+W\s+n/);
  });

  it('takes PNG and JPEG only: WebP and GIF must be converted by the page first', async () => {
    for (const name of ['photo.webp', 'anim.gif']) {
      expect(engine.checkImage(file(name), LIMITS).kind).toBe(name.endsWith('gif') ? 'gif' : 'webp');
      expect(await rejection(engine.imagesToPdf([file(name)], LIMITS))).toMatchObject({ code: 'not_image', file: name });
    }
    expect(await rejection(engine.imagesToPdf([file('notes.txt', new TextEncoder().encode('hello'))], LIMITS))).toMatchObject({ code: 'not_image' });
    expect((await rejection(engine.imagesToPdf([], LIMITS))).code).toBe('empty');
  });

  it('refuses a PNG with too many pixels from its header, before decoding it; JPEGs have no pixel cap', () => {
    const png = Buffer.from(fixture('alpha.png'));
    png.writeUInt32BE(10_000, 16);
    png.writeUInt32BE(10_000, 20);
    const refused = (() => {
      try {
        engine.checkImage(file('big.png', png), { maxImagePixels: 30_000_000 });
      } catch (error) {
        return error as { code: string; message: string };
      }
      return null;
    })();
    expect(refused?.code).toBe('image_too_large');
    expect(refused?.message).toContain('10000 x 10000 pixels');
    expect(refused?.message).toContain('30 million pixels');
    const jpeg = Buffer.from(fixture('photo.jpg'));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    jpeg.writeUInt16BE(10_000, sof + 5);
    jpeg.writeUInt16BE(10_000, sof + 7);
    expect(engine.checkImage(file('big.jpg', jpeg), { maxImagePixels: 30_000_000 }).width).toBe(10_000);
  });

  it('says which file is damaged, and does not hang on a PNG that breaks off', async () => {
    // pdf-lib's PNG decoder never returns on this file; the chunk check refuses it first.
    const png = fixture('alpha.png');
    for (const cut of [png.subarray(0, png.length - 30), png.subarray(0, png.length - 12), png.subarray(0, 40)]) {
      expect(engine.pngIsComplete(cut)).toBe(false);
      expect(await rejection(engine.imagesToPdf([file('photo.jpg'), file('cut.png', cut)], LIMITS))).toMatchObject({ code: 'damaged', file: 'cut.png' });
    }
    for (const name of ['alpha.png', 'palette.png', 'gray16.png']) expect(engine.pngIsComplete(fixture(name)), name).toBe(true);
    // A JPEG whose header is fine but which breaks off inside the next segment.
    const jpeg = Buffer.from(fixture('photo.jpg'));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const broken = jpeg.subarray(0, sof + 2 + jpeg.readUInt16BE(sof + 2) + 6);
    expect(engine.readImageHeader(broken)).toMatchObject({ kind: 'jpeg', width: 60, height: 40 });
    expect(await rejection(engine.imagesToPdf([file('broken.jpg', broken)], LIMITS))).toMatchObject({ code: 'damaged', file: 'broken.jpg' });
  });
});

/* ------------------------------------------------------------------ page scripts */

interface LocalFiles {
  ENGINE_URL: string;
  formatSize(bytes: number): string;
  plural(count: number, word: string): string;
  readLimits(dataset: Record<string, string | undefined>): { maxFiles: number; maxTotalBytes: number; maxPages: number; maxImagePixels: number };
  planAdd(
    current: Array<{ size: number }>,
    incoming: Array<{ name: string; size: number }>,
    limits: { maxFiles: number; maxTotalBytes: number },
    noun?: string,
  ): { accept: Array<{ name: string }>; refuse: Array<{ name: string; message: string }> };
  moveItem<T>(items: T[], from: number, to: number): T[];
  sortByName<T extends { name: string }>(items: T[]): T[];
  totalSize(items: Array<{ size: number }>): number;
  refusal(message: string): Error;
  errorMessage(error: unknown, fallback: string): string;
}

interface PageTool {
  noun: string;
  minFiles: number;
  outputName: string;
  prepare(file: Blob & { name: string }, bytes: Uint8Array, engine: Engine, limits: Record<string, number>): Promise<{ bytes: Uint8Array; detail: string; pages?: number; thumb?: string }>;
  run(items: Array<{ name: string; bytes: Uint8Array }>, engine: Engine, limits: Record<string, number>, form?: unknown): Promise<{ bytes: Uint8Array; pages: number }>;
}

describe('the page scripts', () => {
  let local: LocalFiles;
  let merge: { MERGE_TOOL: PageTool; mergeSummary(items: Array<{ pages: number; size: number }>): string };
  let images: {
    IMAGE_TOOL: PageTool;
    imageSummary(items: Array<{ size: number }>): string;
    imageDetail(header: { kind: string; width: number; height: number; orientation: number }, converted: boolean): string;
    imageOptions(values: Record<string, string | undefined>, limits: { maxImagePixels: number }): Record<string, unknown>;
  };
  /** The code without its comments (which name the APIs the code promises not to use). */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const sources = ['local-files.js', 'merge-pdf.js', 'image-to-pdf.js'].map((name) => [name, code(readFileSync(join(JS, name), 'utf8'))] as const);

  beforeAll(async () => {
    const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(JS, name)).href)) as T;
    local = await load('local-files.js');
    merge = await load('merge-pdf.js');
    images = await load('image-to-pdf.js');
  });

  it.each(sources)('%s sends nothing anywhere and never turns text into HTML', (_name, source) => {
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\.submit\s*\(|requestSubmit|navigator\.|postMessage/);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|eval\(|new Function/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('load code only from this site: local-files.js, and the engine on first use', () => {
    const imports = sources.flatMap(([, source]) => [...source.matchAll(/^import\s[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)].map((match) => match[1]));
    expect([...new Set(imports)]).toEqual(['./local-files.js']);
    const dynamic = sources.flatMap(([, source]) => [...source.matchAll(/\bimport\s*\(([^)]*)\)/g)].map((match) => match[1]));
    expect(dynamic).toEqual(['ENGINE_URL']);
    expect(local.ENGINE_URL).toBe('./vendor/pdf-local.js');
  });

  it('reads the limits from the form, and a missing one refuses everything', () => {
    expect(local.readLimits({ maxFiles: '50', maxBytes: '104857600', maxPages: '1000', maxPixels: '30000000' })).toEqual({
      maxFiles: 50,
      maxTotalBytes: 104_857_600,
      maxPages: 1000,
      maxImagePixels: 30_000_000,
    });
    expect(local.readLimits({ maxFiles: 'lots' })).toEqual({ maxFiles: 0, maxTotalBytes: 0, maxPages: 0, maxImagePixels: 0 });
  });

  it('adds files within the count and total size, and says why the others were left out', () => {
    const limits = { maxFiles: 3, maxTotalBytes: 100 };
    const plan = local.planAdd(
      [{ size: 40 }],
      [
        { name: 'a.pdf', size: 50 },
        { name: 'big.pdf', size: 20 },
        { name: 'empty.pdf', size: 0 },
        { name: 'small.pdf', size: 10 },
        { name: 'more.pdf', size: 1 },
      ],
      limits,
      'PDF',
    );
    expect(plan.accept.map((entry) => entry.name)).toEqual(['a.pdf', 'small.pdf']);
    expect(plan.refuse.map((entry) => entry.name)).toEqual(['big.pdf', 'empty.pdf', 'more.pdf']);
    expect(plan.refuse[0]!.message).toBe('“big.pdf” (20 bytes) was not added: the files may be 100 bytes together, and the list already has 90 bytes.');
    expect(plan.refuse[1]!.message).toBe('“empty.pdf” is empty.');
    expect(plan.refuse[2]!.message).toBe('“more.pdf” was not added: this page takes up to 3 PDFs at a time.');
  });

  it('moves, sorts and counts the list', () => {
    expect(local.moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(local.moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(local.moveItem(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b']);
    expect(local.moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    const sorted = local.sortByName([{ name: 'page 10.jpg' }, { name: 'Page 2.jpg' }, { name: 'page 1.jpg' }]);
    expect(sorted.map((item) => item.name)).toEqual(['page 1.jpg', 'Page 2.jpg', 'page 10.jpg']);
    expect(local.totalSize([{ size: 3 }, { size: 4 }])).toBe(7);
    expect(local.formatSize(2 * 1024 * 1024 + 200_000)).toBe('2.2 MB');
    expect(local.plural(1, 'page')).toBe('1 page');
  });

  it('shows the engine refusals and its own, and hides anything unexpected', () => {
    expect(local.errorMessage(local.refusal('Nope.'), 'fallback')).toBe('Nope.');
    expect(local.errorMessage(new engine.LocalPdfError('encrypted', 'Locked.'), 'fallback')).toBe('Locked.');
    expect(local.errorMessage(new TypeError('x is undefined'), 'fallback')).toBe('fallback');
    expect(local.errorMessage('text', 'fallback')).toBe('fallback');
  });

  it('merge: reads each PDF as it is added and merges the list with the bundled engine', async () => {
    const one = await makePdf([[200, 200]]);
    const two = await makePdf([[300, 300], [310, 310]]);
    const limits = { maxFiles: 50, maxTotalBytes: 1e8, maxPages: 1000, maxImagePixels: 1 };
    const prepared = await merge.MERGE_TOOL.prepare(new File([new Uint8Array(two)], 'two.pdf'), two, engine, limits);
    expect(prepared).toMatchObject({ pages: 2, detail: '2 pages' });
    await expect(merge.MERGE_TOOL.prepare(new File([new Uint8Array(one)], 'x.jpg'), fixture('photo.jpg'), engine, limits)).rejects.toMatchObject({ code: 'not_pdf' });
    const made = await merge.MERGE_TOOL.run([{ name: 'two.pdf', bytes: two }, { name: 'one.pdf', bytes: one }], engine, limits);
    expect(sizesOf(await PDFDocument.load(made.bytes))).toEqual([[300, 300], [310, 310], [200, 200]]);
    expect(merge.MERGE_TOOL).toMatchObject({ minFiles: 2, outputName: 'merged.pdf' });
    expect(merge.mergeSummary([{ pages: 2, size: 1024 }, { pages: 1, size: 2048 }])).toBe('2 PDFs, 3 pages, 3 KB together.');
  });

  it('images: describes each image as shown and turns the form into the engine options', async () => {
    expect(images.imageDetail({ kind: 'jpeg', width: 60, height: 40, orientation: 6 }, false)).toBe('40 x 60 px, JPEG');
    expect(images.imageDetail({ kind: 'webp', width: 48, height: 32, orientation: 1 }, true)).toBe('48 x 32 px, WebP made PNG');
    const options = images.imageOptions({ page_size: 'letter', orientation: 'auto', fit: 'fit', margin: '10' }, { maxImagePixels: 5 });
    expect(options).toMatchObject({ pageSize: 'letter', orientation: 'auto', fit: 'fit', maxImagePixels: 5 });
    expect(options.margin).toBeCloseTo(28.346, 2);
    expect(images.imageOptions({ margin: '' }, { maxImagePixels: 5 }).margin).toBe(0);
    expect(images.imageOptions({ margin: '2,5' }, { maxImagePixels: 5 }).margin).toBeCloseTo(7.087, 2);
    expect(images.imageOptions({ margin: '-3' }, { maxImagePixels: 5 }).margin).toBe(0);
    expect(images.imageSummary([{ size: 1024 }])).toBe('1 image, 1 KB together.');

    const limits = { maxFiles: 50, maxTotalBytes: 1e8, maxPages: 1000, maxImagePixels: 30_000_000 };
    const jpeg = fixture('photo-exif-6.jpg');
    const prepared = await images.IMAGE_TOOL.prepare(new File([new Uint8Array(jpeg)], 'p.jpg', { type: 'image/jpeg' }), jpeg, engine, limits);
    expect(prepared.detail).toBe('40 x 60 px, JPEG');
    expect(prepared.thumb).toMatch(/^blob:/);
    URL.revokeObjectURL(prepared.thumb!);
    const form = { elements: { page_size: { value: 'a5' }, orientation: { value: 'auto' }, fit: { value: 'fit' }, margin: { value: '0' } } };
    const made = await images.IMAGE_TOOL.run([{ name: 'p.jpg', bytes: jpeg }], engine, limits, form);
    expect(sizesOf(await PDFDocument.load(made.bytes))).toEqual([[420, 595]]);
  });
});
