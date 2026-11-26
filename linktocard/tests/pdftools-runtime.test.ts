// @cantoo/pdf-lib inside workerd (the vitest Workers pool): the library the PDF toolkit is built
// on imports, draws, encrypts (AES-256 needs crypto.getRandomValues) and reads its own output back.
// If this file fails after an upgrade, the toolkit cannot run in the Worker at all.
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';

describe('@cantoo/pdf-lib in workerd', () => {
  it('creates, draws text and reloads a document', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Hello from workerd', { x: 50, y: 800, size: 12, font, color: rgb(0, 0, 0) });
    const bytes = await doc.save();
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const again = await PDFDocument.load(bytes);
    expect(again.getPageCount()).toBe(1);
  });

  it('encrypts with AES-256 and the result is refused without a password', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.encrypt({ userPassword: 'open-me', ownerPassword: 'owner-secret', permissions: { printing: 'highResolution', copying: false } });
    const bytes = await doc.save();
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Encrypt');
    expect(text).toMatch(/\/V 5/);
    await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
    const opened = await PDFDocument.load(bytes, { password: 'open-me' });
    expect(opened.getPageCount()).toBe(1);
  });
});
