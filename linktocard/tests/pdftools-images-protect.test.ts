// from-images and protect (src/pdftools/from-images.ts, protect.ts).
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDF, PDF_TOOLKIT } from '../src/config';
import { fromImages, merge, protect } from '../src/pdftools';
import { expectApiError, fixture, hexText, latin1, pageContent, reload } from './pdftools-helpers';

const A4: [number, number] = [595.28, 841.89];

function sizes(doc: PDFDocument): number[][] {
  return doc.getPages().map((page) => [page.getWidth(), page.getHeight()]);
}

describe('fromImages', () => {
  it('puts one image per page, A4 turned to suit each image, EXIF applied', async () => {
    const images = (['photo.jpg', 'logo.png', 'photo-exif-6.jpg', 'cmyk.jpg', 'grey.png'] as const).map(fixture);
    const out = await fromImages(images);
    expect(out.pages).toBe(5);
    const doc = await reload(out.bytes);
    // photo 300x200 landscape, logo landscape, EXIF 6 shown 100x200 portrait, cmyk landscape, grey square portrait.
    expect(sizes(doc)).toEqual([[A4[1], A4[0]], [A4[1], A4[0]], A4, [A4[1], A4[0]], A4]);
    // "fit": the 300 x 200 photo fills the landscape page's height... or width, whichever binds.
    const scale = Math.min(A4[1] / 300, A4[0] / 200);
    expect(pageContent(doc, 0)).toContain(`${300 * scale} 0 0 ${200 * scale}`);
    expect(pageContent(doc, 2)).toContain('0 -1 1 0 0 1 cm');
  });

  it('sizes "auto" pages to the image (1 px = 1 pt) and keeps them within reader limits', async () => {
    const out = await fromImages([fixture('photo.jpg'), fixture('photo-exif-6.jpg')], { pageSize: 'auto' });
    expect(sizes(await reload(out.bytes))).toEqual([
      [300, 200],
      [100, 200],
    ]);
    // A JPEG whose header says 30000 x 20000: the page is scaled to 14,400 points wide.
    const huge = fixture('photo.jpg');
    const sof = huge.findIndex((b, i) => b === 0xff && huge[i + 1] === 0xc0);
    new DataView(huge.buffer).setUint16(sof + 5, 20000);
    new DataView(huge.buffer).setUint16(sof + 7, 30000);
    const big = await fromImages([huge], { pageSize: 'auto' });
    expect(sizes(await reload(big.bytes))).toEqual([[14400, 9600]]);
  });

  it('uses letter and A5, a forced orientation and a margin', async () => {
    const letter = await reload((await fromImages([fixture('photo.jpg')], { pageSize: 'letter', orientation: 'portrait', margin: 36 })).bytes);
    expect(sizes(letter)).toEqual([[612, 792]]);
    const width = 612 - 72;
    expect(pageContent(letter, 0)).toContain(`${width} 0 0 ${(width * 200) / 300}`);
    const a5 = await reload((await fromImages([fixture('grey.png')], { pageSize: 'a5', orientation: 'landscape' })).bytes);
    expect(sizes(a5)).toEqual([[595.28, 419.53]]);
  });

  it('"fill" covers the page and clips the overflow', async () => {
    const doc = await reload((await fromImages([fixture('photo.jpg')], { fit: 'fill', orientation: 'portrait' })).bytes);
    const content = pageContent(doc, 0);
    expect(content).toContain(`0 0 ${A4[0]} ${A4[1]} re\nW\nn`);
    const scale = Math.max(A4[0] / 300, A4[1] / 200);
    expect(content).toContain(`${300 * scale} 0 0 ${200 * scale}`);
  });

  it('adds the free mark when asked', async () => {
    const doc = await reload((await fromImages([fixture('photo.jpg')], { freeMark: true })).bytes);
    expect(pageContent(doc, 0)).toContain(hexText(PDF.freeMark));
  });

  it('refuses bad files and options by name', async () => {
    await expectApiError(fromImages([]), 'invalid_request', /at least 1 images/);
    await expectApiError(fromImages(Array.from({ length: PDF_TOOLKIT.maxFiles + 1 }, () => fixture('grey.png'))), 'invalid_request', /At most 20 images/);
    await expectApiError(fromImages([fixture('photo.jpg'), fixture('multi-page.pdf')]), 'unsupported_media_type', /^files\[1\] is not a PNG or JPEG/);
    const damaged = fixture('logo.png').slice(0, 40);
    await expectApiError(fromImages([damaged]), 'invalid_request', /files\[0\] could not be read as a PNG/);
    await expectApiError(fromImages([fixture('photo.jpg')], { pageSize: 'a3' as never }), 'invalid_request', /page_size must be one of: a4, letter, a5, auto/);
    await expectApiError(fromImages([fixture('photo.jpg')], { fit: 'stretch' as never }), 'invalid_request', /fit must be one of: fit, fill/);
    await expectApiError(fromImages([fixture('photo.jpg')], { orientation: 'sideways' as never }), 'invalid_request', /orientation must be one of/);
    await expectApiError(fromImages([fixture('photo.jpg')], { margin: -5 }), 'invalid_request', /margin must be/);
  });
});

describe('protect', () => {
  it('encrypts with AES-256: the file opens only with the password', async () => {
    const out = await protect(fixture('multi-page.pdf'), { userPassword: 'open me' });
    expect(out.pages).toBe(8);
    const raw = latin1(out.bytes);
    expect(raw).toMatch(/\/Encrypt \d+ 0 R/);
    expect(raw).toMatch(/\/V 5/);
    expect(raw).toMatch(/\/R 6/);
    await expect(PDFDocument.load(out.bytes)).rejects.toThrow(/encrypted/i);
    expect((await PDFDocument.load(out.bytes, { password: 'open me' })).getPageCount()).toBe(8);
    // Every permission allowed by default: the permission bits 3-6 and 9-12 of /P.
    const p = Number(/\/P (-?\d+)/.exec(raw)![1]);
    for (const bit of [3, 4, 5, 6, 9, 10, 11, 12]) expect(p & (1 << (bit - 1)), `bit ${bit}`).not.toBe(0);
  });

  it('restricts permissions with an owner password', async () => {
    const out = await protect(fixture('multi-page.pdf'), { ownerPassword: 'owner!', permissions: { printing: 'low', copying: false, modifying: false } });
    const raw = latin1(out.bytes);
    const p = Number(/\/P (-?\d+)/.exec(raw)![1]);
    const bit = (n: number): boolean => (p & (1 << (n - 1))) !== 0;
    expect(bit(3)).toBe(true); // print
    expect(bit(12)).toBe(false); // high-quality print
    expect(bit(4)).toBe(false); // modify
    expect(bit(5)).toBe(false); // copy
    expect(bit(6)).toBe(true); // annotate
    // No user password: it opens with an empty one.
    expect((await PDFDocument.load(out.bytes, { password: '' })).getPageCount()).toBe(8);
  });

  it('puts the free mark inside the encrypted file', async () => {
    const out = await protect(fixture('multi-page.pdf'), { userPassword: 'pw', freeMark: true });
    expect(latin1(out.bytes)).not.toContain(hexText(PDF.freeMark));
    const doc = await PDFDocument.load(out.bytes, { password: 'pw' });
    expect(pageContent(doc, 0)).toContain(hexText(PDF.freeMark));
  });

  it('refuses settings that would not protect anything', async () => {
    const pdf = fixture('multi-page.pdf');
    await expectApiError(protect(pdf, {}), 'invalid_request', /Give a user_password/);
    await expectApiError(protect(pdf, { userPassword: 'a', permissions: { copying: false } }), 'invalid_request', /need an owner_password/);
    await expectApiError(protect(pdf, { userPassword: 'same', ownerPassword: 'same', permissions: { copying: false } }), 'invalid_request', /must differ/);
    await expectApiError(protect(pdf, { ownerPassword: 'owner' }), 'invalid_request', /would open and work as before/);
  });

  it('accepts printable ASCII passwords of 1 to 127 characters only', async () => {
    const pdf = fixture('multi-page.pdf');
    for (const bad of ['', 'x'.repeat(128), 'pässword', 'tab\there', 7 as never]) {
      await expectApiError(protect(pdf, { userPassword: bad }), 'invalid_request', /user_password must be 1 to 127 printable ASCII characters/);
    }
    await expectApiError(protect(pdf, { userPassword: 'ok', ownerPassword: 'ö' }), 'invalid_request', /owner_password/);
    expect((await protect(pdf, { userPassword: 'x'.repeat(127) })).pages).toBe(8);
  });

  it('refuses bad permission values', async () => {
    const pdf = fixture('multi-page.pdf');
    await expectApiError(protect(pdf, { userPassword: 'a', ownerPassword: 'b', permissions: { printing: 'medium' as never } }), 'invalid_request', /permissions\.printing/);
    await expectApiError(protect(pdf, { userPassword: 'a', ownerPassword: 'b', permissions: { fillingForms: 'no' as never } }), 'invalid_request', /permissions\.filling_forms must be true or false/);
  });

  it('cannot be chained: a protected output is an encrypted input', async () => {
    const out = await protect(fixture('multi-page.pdf'), { userPassword: 'pw' });
    await expectApiError(merge([{ bytes: out.bytes }]), 'invalid_request', /encrypted/);
  });
});
