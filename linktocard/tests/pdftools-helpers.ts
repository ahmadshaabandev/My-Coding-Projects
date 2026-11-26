/// <reference path="./fixtures/pdf/inline.d.ts" />
/// <reference path="./fixtures/pdftools/inline.d.ts" />
// Helpers for the PDF toolkit tests (tests/pdftools-*.test.ts). The fixtures in
// tests/fixtures/pdftools were made once with @cantoo/pdf-lib and Pillow by throw-away scripts
// (only the files are committed):
//   multi-page.pdf       8 A4 pages, "Page N of 8"
//   rotated.pdf          pages turned 0, 90, 180, 270, and a 600x800 page cropped to 400x500 at (50,100)
//   form.pdf             AcroForm: full_name, email (filled), zip (max 5), notes (multi-line), subscribe,
//                        terms (checked), plan (radio free/starter/pro, "free"), country (dropdown),
//                        topics (multi-select list), reset (push button)
//   xfa.pdf              an AcroForm that also carries XFA and /NeedsRendering
//   encrypted-user.pdf   AES-256, needs the password "open-me" to open
//   encrypted-owner.pdf  AES-256, opens without a password, owner password restricts it
//   logo.png 120x40 RGBA, grey.png 64x64 greyscale, photo.jpg 300x200, cmyk.jpg 80x60 CMYK,
//   photo-exif-6.jpg     stored 200x100 with EXIF Orientation 6 (shown 100x200)
// Chrome-made PDFs come from tests/fixtures/pdf through tests/pdf-helpers.ts.
import { PDFArray, PDFDocument, PDFRawStream, PDFStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { expect } from 'vitest';
import { ApiError, type ErrorCode } from '../src/lib/errors';
import cmyk from './fixtures/pdftools/cmyk.jpg?inline';
import encryptedOwner from './fixtures/pdftools/encrypted-owner.pdf?inline';
import encryptedUser from './fixtures/pdftools/encrypted-user.pdf?inline';
import form from './fixtures/pdftools/form.pdf?inline';
import grey from './fixtures/pdftools/grey.png?inline';
import logo from './fixtures/pdftools/logo.png?inline';
import multiPage from './fixtures/pdftools/multi-page.pdf?inline';
import photoExif6 from './fixtures/pdftools/photo-exif-6.jpg?inline';
import photo from './fixtures/pdftools/photo.jpg?inline';
import rotated from './fixtures/pdftools/rotated.pdf?inline';
import xfa from './fixtures/pdftools/xfa.pdf?inline';

function bytesOfDataUrl(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const FILES = {
  'multi-page.pdf': multiPage,
  'rotated.pdf': rotated,
  'form.pdf': form,
  'xfa.pdf': xfa,
  'encrypted-user.pdf': encryptedUser,
  'encrypted-owner.pdf': encryptedOwner,
  'logo.png': logo,
  'grey.png': grey,
  'photo.jpg': photo,
  'cmyk.jpg': cmyk,
  'photo-exif-6.jpg': photoExif6,
} as const;

export type ToolkitFixture = keyof typeof FILES;

/** A fresh copy of a fixture (operations must never depend on, or change, a shared buffer). */
export function fixture(name: ToolkitFixture): Uint8Array {
  return bytesOfDataUrl(FILES[name]);
}

export const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** Every content stream of a page, decoded and joined (what a reader executes for that page). */
export function pageContent(doc: PDFDocument, index: number): string {
  const contents = doc.getPages()[index]!.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref);
      if (stream instanceof PDFRawStream) return latin1(decodePDFRawStream(stream).decode());
      if (stream instanceof PDFStream) return latin1(stream.getContents());
      return '';
    })
    .join('\n');
}

/** Text as pdf-lib writes it for a standard font: an uppercase hex string. */
export function hexText(text: string): string {
  return `<${[...text].map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('')}>`;
}

export async function reload(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** A document of `pages` blank-ish A4 pages, each with a line of text (built for size tests). */
export async function makePdf(pages: number, options: { size?: [number, number] } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont('Helvetica');
  for (let i = 1; i <= pages; i++) doc.addPage(options.size ?? [595.28, 841.89]).drawText(`Page ${i}`, { x: 72, y: 760, size: 18, font });
  return doc.save({ useObjectStreams: false });
}

/** Awaits `work` and checks that it failed with ApiError `code` and a message matching `message`. */
export async function expectApiError(work: Promise<unknown>, code: ErrorCode, message?: RegExp): Promise<ApiError> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected an ApiError').toBeInstanceOf(ApiError);
  const error = caught as ApiError;
  expect(error.code).toBe(code);
  if (message) expect(error.message).toMatch(message);
  return error;
}
