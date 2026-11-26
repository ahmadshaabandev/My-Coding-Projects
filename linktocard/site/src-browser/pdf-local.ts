/**
 * Merge PDFs and turn images into a PDF in the visitor's own browser: the engine of the free
 * pages /tools/merge-pdf and /tools/image-to-pdf (site/public/assets/js/merge-pdf.js and
 * image-to-pdf.js load it on first use).
 *
 * scripts/build-browser-bundles.mts bundles this file with pdf-lib into
 * site/public/assets/js/vendor/pdf-local.js. The module only turns bytes into bytes: no network,
 * DOM or storage access. That is what lets the pages say the files stay on the device, and what
 * lets tests/node/client-pdf.test.ts run the very same bundle in Node.
 *
 * pdf-lib 1.17.1 rather than the Worker's @cantoo/pdf-lib: bundling the same calls with esbuild
 * 0.28.2 (minified, browser, ES2020) gave 432,263 bytes for pdf-lib (179,654 gzipped) and
 * 597,247 for @cantoo/pdf-lib 2.11.1 (251,331 gzipped), because the fork's SVG drawing pulls in
 * html-entities, culori and an HTML parser that tree shaking cannot drop. The fork's addition,
 * encryption, is not needed here.
 *
 * The rules follow POST /v1/pdf-tools/merge and /from-images (src/pdftools), so "automate this
 * with the API" gives the same pages: encrypted PDFs and XFA forms are refused, images are drawn
 * upright from their EXIF orientation, and page size, fit, orientation and margin mean the same.
 * Two differences: there is no free-plan mark (Link To Card renders nothing here), and a JPEG's
 * metadata segments (EXIF with the camera's location, XMP, comments) are left out of the PDF,
 * because these pages promise privacy; the compressed picture itself is copied unchanged.
 */
import {
  EncryptedPDFError,
  PDFDict,
  PDFDocument,
  type PDFImage,
  PDFName,
  ParseSpeeds,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib';
// Type only: a value import would pull all of src/config.ts into the bundle (esbuild keeps
// top-level constants written as arithmetic, such as 15 * 60 * 1000, even when unused).
import type { PdfFormat } from '../../src/config';

export type LocalPdfErrorCode =
  | 'empty'
  | 'not_pdf'
  | 'encrypted'
  | 'xfa'
  | 'damaged'
  | 'no_pages'
  | 'too_many_pages'
  | 'not_image'
  | 'image_too_large'
  | 'invalid_option';

/** A refusal in plain words, naming the file; `file` is its name when one file is to blame. */
export class LocalPdfError extends Error {
  readonly code: LocalPdfErrorCode;
  readonly file: string | undefined;

  constructor(code: LocalPdfErrorCode, message: string, file?: string) {
    super(message);
    this.name = 'LocalPdfError';
    this.code = code;
    this.file = file;
  }
}

/** A file as the page holds it: what the visitor called it, and its bytes. */
export interface LocalFile {
  name: string;
  bytes: Uint8Array;
}

export interface LocalPdfResult {
  bytes: Uint8Array;
  pages: number;
}

/* ------------------------------------------------------------------ bytes */

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number): number => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, i: number): number => (u24le(b, i) | ((b[i + 3] ?? 0) << 24)) >>> 0;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

const quoted = (name: string): string => `“${name}”`;

/* ------------------------------------------------------------------ PDFs */

/**
 * Some PDFs carry a few bytes of junk before "%PDF-" and readers accept them, so the header is
 * looked for in the first 1024 bytes (as src/pdftools/document.ts does). pdf-lib itself would
 * scan the whole file, letting anything that merely contains "%PDF-" through to the parser.
 */
const HEADER_WINDOW = 1024;
const PDF_HEADER = ascii('%PDF-');

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, HEADER_WINDOW) - PDF_HEADER.length;
  for (let i = 0; i <= end; i++) {
    if (startsWith(bytes, PDF_HEADER, i)) return true;
  }
  return false;
}

const ENCRYPT = ascii('/Encrypt');
/** Where a trailer can be: near the end, or near the start in a linearized file. */
const TRAILER_WINDOW = 1024 * 1024;

/** True when "/Encrypt" (the trailer key of an encrypted file) appears near the start or the end. */
function mentionsEncrypt(bytes: Uint8Array): boolean {
  const scan = (from: number, to: number): boolean => {
    for (let i = from; i <= to - ENCRYPT.length; i++) {
      if (bytes[i] === 0x2f && startsWith(bytes, ENCRYPT, i)) return true;
    }
    return false;
  };
  if (bytes.length <= 2 * TRAILER_WINDOW) return scan(0, bytes.length);
  return scan(0, TRAILER_WINDOW) || scan(bytes.length - TRAILER_WINDOW, bytes.length);
}

/** True when the document carries XFA, or asks readers to build its pages from XFA. */
function usesXfa(doc: PDFDocument): boolean {
  const catalog = doc.catalog;
  if (String(catalog.get(PDFName.of('NeedsRendering')) ?? '') === 'true') return true;
  const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return acroForm !== undefined && acroForm.has(PDFName.of('XFA'));
}

function tooManyPages(pages: number, maxPages: number, file?: string): LocalPdfError {
  const what = file === undefined ? `The merged PDF would have ${pages} pages` : `${quoted(file)} has ${pages} pages`;
  return new LocalPdfError('too_many_pages', `${what}; this page combines at most ${maxPages} pages at a time. Merge in smaller groups.`, file);
}

export interface PdfLimits {
  /** Pages one file, and the merged result, may have. */
  maxPages: number;
}

/**
 * Parses one PDF and checks it. Fastest parse speed: pdf-lib's slower speeds pause between
 * batches of objects, and in a browser each pause lasts at least a few milliseconds, which makes
 * a large file take seconds longer without making the page any more responsive.
 */
async function loadPdf(file: LocalFile, limits: PdfLimits): Promise<PDFDocument> {
  const { name, bytes } = file;
  if (bytes.byteLength === 0) throw new LocalPdfError('empty', `${quoted(name)} is empty.`, name);
  if (!hasPdfHeader(bytes)) throw new LocalPdfError('not_pdf', `${quoted(name)} is not a PDF.`, name);
  let doc: PDFDocument;
  let pages: number;
  try {
    doc = await PDFDocument.load(bytes, { parseSpeed: ParseSpeeds.Fastest, updateMetadata: false });
    // Walks the page tree: a broken tree throws here, inside the try, not halfway through a merge.
    pages = doc.getPages().length;
  } catch (error) {
    // pdf-lib checks for encryption only after parsing, and the objects of an encrypted file that
    // uses object streams cannot be parsed: the parse fails first, so look for the marker itself.
    if (error instanceof EncryptedPDFError || mentionsEncrypt(bytes)) throw encrypted(name);
    throw new LocalPdfError('damaged', `${quoted(name)} could not be read: the file is damaged or incomplete.`, name);
  }
  if (doc.isEncrypted) throw encrypted(name);
  if (usesXfa(doc)) {
    throw new LocalPdfError(
      'xfa',
      `${quoted(name)} is an XFA form, which this tool cannot copy. Print or export it to a new PDF first, then add that file.`,
      name,
    );
  }
  if (pages === 0) throw new LocalPdfError('no_pages', `${quoted(name)} has no pages.`, name);
  if (pages > limits.maxPages) throw tooManyPages(pages, limits.maxPages, name);
  return doc;
}

function encrypted(name: string): LocalPdfError {
  // A file that opens without a password can still carry an owner password whose restrictions must not be stripped.
  return new LocalPdfError(
    'encrypted',
    `${quoted(name)} is password-protected (encrypted), so it cannot be merged here. Remove the protection in the app that made it, then add it again.`,
    name,
  );
}

/** Reads one PDF for the file list: its page count, or the reason it cannot be used. */
export async function readPdf(file: LocalFile, limits: PdfLimits): Promise<{ pages: number }> {
  const doc = await loadPdf(file, limits);
  return { pages: doc.getPageCount() };
}

/** A new document. No dates and pdf-lib's own name are written; Producer says what made it. */
async function newDocument(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Link To Card');
  return doc;
}

/**
 * Classic cross-reference tables, like the API's output (src/pdftools/document.ts), so the file
 * reads in every viewer and can be sent to the API afterwards. Field appearances are left alone:
 * nothing here changes a field, and regenerating them would redraw every field in Helvetica.
 */
async function save(doc: PDFDocument): Promise<LocalPdfResult> {
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false, objectsPerTick: Number.POSITIVE_INFINITY });
  return { bytes, pages: doc.getPageCount() };
}

/**
 * Every page of every file, in the order given. Pages are copied with what they draw (fonts,
 * images, annotations); document-level parts do not carry over: bookmarks, the form's field list
 * (filled values stay visible, the fields are no longer fillable), attachments and metadata.
 */
export async function mergePdfs(files: readonly LocalFile[], limits: PdfLimits): Promise<LocalPdfResult> {
  if (files.length === 0) throw new LocalPdfError('empty', 'Add at least one PDF.');
  const out = await newDocument();
  let total = 0;
  for (const file of files) {
    const source = await loadPdf(file, limits);
    total += source.getPageCount();
    // Checked before copying: the limit is on the result, so stop as soon as it is passed.
    if (total > limits.maxPages) throw tooManyPages(total, limits.maxPages);
    for (const page of await out.copyPages(source, source.getPageIndices())) out.addPage(page);
  }
  return save(out);
}

/* ------------------------------------------------------------------ images */

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'gif';

export interface ImageHeader {
  kind: ImageKind;
  /** As stored in the file, in pixels. */
  width: number;
  height: number;
  /** EXIF orientation of a JPEG, 1 (as stored) to 8; always 1 for the other kinds. */
  orientation: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_ID = [...ascii('Exif'), 0, 0];
const ICC_ID = [...ascii('ICC_PROFILE'), 0];

interface JpegSegment {
  /** Offset of the 0xFF of the marker. */
  start: number;
  /** Offset after the segment (and, for a scan, after its entropy-coded data). */
  end: number;
  /** -1: the file breaks off here (a segment length runs past the end). */
  marker: number;
}

/**
 * The marker segments of a JPEG that starts with SOI, in file order, up to and including EOI.
 * The entropy-coded data after each SOS (several scans in a progressive file) belongs to that
 * SOS segment. Fill bytes and stray bytes between segments are skipped, as decoders do. A
 * generator, so reading the header stops at the frame instead of walking the whole picture.
 */
function* jpegSegments(b: Uint8Array): Generator<JpegSegment> {
  yield { start: 0, end: 2, marker: 0xd8 };
  let i = 2;
  while (i + 1 < b.length) {
    const marker = b[i + 1]!;
    if (b[i] !== 0xff || marker === 0xff) {
      i += 1; // stray or fill byte
      continue;
    }
    if (marker === 0xd9) {
      yield { start: i, end: i + 2, marker };
      return;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // no payload
      continue;
    }
    const length = u16be(b, i + 2);
    if (length < 2 || i + 2 + length > b.length) {
      yield { start: i, end: b.length, marker: -1 };
      return;
    }
    let end = i + 2 + length;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker.
      const isDataByte = (at: number): boolean => !(b[at] === 0xff && b[at + 1] !== 0x00 && !(b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7));
      while (end + 1 < b.length && isDataByte(end)) end += 1;
      if (end + 1 >= b.length) end = b.length;
    }
    yield { start: i, end, marker };
    i = end;
  }
}

/** Start-of-frame markers carry the size; C4 (Huffman tables), C8 and CC are not frames. */
const isFrameMarker = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** Orientation tag (0x0112) of an EXIF APP1 payload starting at `start` ("Exif\0\0" + TIFF). */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  const tiff = start + EXIF_ID.length;
  if (end - tiff < 8) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const u16 = (i: number): number => (little ? u16le(b, i) : u16be(b, i));
  const u32 = (i: number): number => (little ? u32le(b, i) : u32be(b, i));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegHeader(b: Uint8Array): ImageHeader | null {
  let orientation = 1;
  for (const { start, end, marker } of jpegSegments(b)) {
    // APP1 "Exif\0\0" comes before the frame header in camera files.
    if (marker === 0xe1 && startsWith(b, EXIF_ID, start + 4)) orientation = exifOrientation(b, start + 4, end);
    if (isFrameMarker(marker)) return { kind: 'jpeg', height: u16be(b, start + 5), width: u16be(b, start + 7), orientation };
    if (marker === 0xda || marker === -1) return null; // image data before a frame header, or a broken file
  }
  return null;
}

/** WebP: "RIFF" size "WEBP", then a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk. */
function webpHeader(b: Uint8Array): ImageHeader | null {
  if (!startsWith(b, ascii('RIFF')) || !startsWith(b, ascii('WEBP'), 8) || b.length < 30) return null;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  const size = (width: number, height: number): ImageHeader => ({ kind: 'webp', width, height, orientation: 1 });
  if (chunk === 'VP8 ' && startsWith(b, [0x9d, 0x01, 0x2a], 23)) return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = u32le(b, 21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/**
 * True when a PNG's chunks can be followed from IHDR to IEND without running past the end of
 * the file. The PNG decoder inside pdf-lib (UPNG) reads chunks until it meets IEND, so a file
 * that breaks off (an interrupted download) would keep the page busy forever.
 */
export function pngIsComplete(b: Uint8Array): boolean {
  let at = PNG_SIGNATURE.length;
  while (at + 12 <= b.length) {
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (at === PNG_SIGNATURE.length && type !== 'IHDR') return false;
    const end = at + 12 + u32be(b, at);
    if (end > b.length) return false;
    if (type === 'IEND') return true;
    at = end;
  }
  return false;
}

/** Type, stored size and (for JPEG) orientation, from the first bytes; null for anything else. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    if (bytes.length < 24 || !startsWith(bytes, ascii('IHDR'), 12)) return null;
    return { kind: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20), orientation: 1 };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpegHeader(bytes);
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return bytes.length < 10 ? null : { kind: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8), orientation: 1 };
  }
  return webpHeader(bytes);
}

/**
 * The JPEG without its metadata segments: APP1 (EXIF, which holds the camera, the time and often
 * the GPS position, and XMP), APP2 other than the ICC colour profile (multi-picture data), APP3
 * to APP13 and APP15 (maker and IPTC data), comments, and anything after EOI (some phones append
 * a second picture there). Kept, byte for byte: everything a decoder reads (tables, frame, scans),
 * APP0 (JFIF), the ICC profile and APP14 (Adobe colour transform). null when the file is not a
 * JPEG whose segments can be followed to the end.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!startsWith(bytes, [0xff, 0xd8])) return null;
  const segments = [...jpegSegments(bytes)];
  if (segments.some(({ marker }) => marker === -1)) return null;
  const drop = ({ start, marker }: JpegSegment): boolean =>
    marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xee && !(marker === 0xe2 && startsWith(bytes, ICC_ID, start + 4)));
  const kept = segments.filter((segment) => !drop(segment));
  const out = new Uint8Array(kept.reduce((sum, { start, end }) => sum + end - start, 0));
  let at = 0;
  for (const { start, end } of kept) {
    out.set(bytes.subarray(start, end), at);
    at += end - start;
  }
  return out;
}

/** [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f (the PDF "cm" operands). */
export type Matrix = [number, number, number, number, number, number];

/**
 * The unit-square matrix that shows a stored image in its EXIF orientation (the same table as
 * src/pdftools/images.ts). PDF draws an image into the unit square with its first row at the
 * top; the result must be the picture as a photo viewer shows it, again filling the unit square.
 */
export function orientationMatrix(orientation: number): Matrix {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, 1, 0]; // mirrored left-right
    case 3:
      return [-1, 0, 0, -1, 1, 1]; // turned 180
    case 4:
      return [1, 0, 0, -1, 0, 1]; // mirrored top-bottom
    case 5:
      return [0, -1, -1, 0, 1, 1]; // mirrored along the main diagonal
    case 6:
      return [0, -1, 1, 0, 0, 1]; // turned 90 clockwise
    case 7:
      return [0, 1, 1, 0, 0, 0]; // mirrored along the other diagonal
    case 8:
      return [0, 1, -1, 0, 1, 0]; // turned 90 counter-clockwise
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/* ------------------------------------------------------------------ image pages */

/**
 * Paper sizes in points (ISO 216 A4 and A5, US Letter; the values pdf-lib's PageSizes lists).
 * Keyed by PdfFormat, so TypeScript insists on exactly the formats of PDF.formats, the sizes the
 * PDF renderer prints; tests/node/client-pdf.test.ts checks the order too.
 */
const PAPER: Record<PdfFormat, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792], a5: [419.53, 595.28] };

/** a4, letter, a5, or auto: the page is the image. */
export const IMAGE_PAGE_SIZES = [...(Object.keys(PAPER) as PdfFormat[]), 'auto'] as const;
export type ImagePageSize = PdfFormat | 'auto';
/** fit: the whole image, as large as the margins allow, centred; fill: the page covered, the image cropped. */
export const IMAGE_FITS = ['fit', 'fill'] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];
export const IMAGE_ORIENTATIONS = ['auto', 'portrait', 'landscape'] as const;
export type ImageOrientation = (typeof IMAGE_ORIENTATIONS)[number];

export interface ImagePageOptions {
  pageSize?: ImagePageSize;
  fit?: ImageFit;
  orientation?: ImageOrientation;
  /** Points around a "fit" image on a paper size (ignored for auto pages and "fill"). Default 0. */
  margin?: number;
}

export interface ImageLayout {
  pageWidth: number;
  pageHeight: number;
  /** Where the image as shown goes, in page points (it may reach past the page with "fill"). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** "fill": what reaches past the page is cut off. */
  clip: boolean;
}

/**
 * Smallest and largest page side for an auto page, in points: the figures src/pdftools/from-images.ts
 * uses, which it gives as the implementation limits of the PDF 1.7 reference, Annex C (not checked
 * against the reference itself for this build either). A larger image is scaled down onto the
 * largest page; otherwise 1 pixel is 1 point (72 per inch).
 */
const MIN_SIDE = 3;
const MAX_SIDE = 14_400;

function oneOf<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, what: string): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new LocalPdfError('invalid_option', `${what} must be one of: ${allowed.join(', ')}.`);
  return value;
}

/** Page size and image box for an image shown `width` x `height` pixels (orientation applied). */
export function imagePageLayout(width: number, height: number, options: ImagePageOptions = {}): ImageLayout {
  const pageSize = oneOf(options.pageSize, IMAGE_PAGE_SIZES, 'a4', 'The page size');
  const fit = oneOf(options.fit, IMAGE_FITS, 'fit', 'The fit');
  const orientation = oneOf(options.orientation, IMAGE_ORIENTATIONS, 'auto', 'The orientation');
  const margin = options.margin ?? 0;
  if (!Number.isFinite(margin) || margin < 0) throw new LocalPdfError('invalid_option', 'The margin must be 0 or more.');
  if (!(width >= 1 && height >= 1)) throw new LocalPdfError('invalid_option', 'An image needs at least one pixel each way.');

  let pageWidth: number;
  let pageHeight: number;
  if (pageSize === 'auto') {
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const side = (n: number): number => Math.min(MAX_SIDE, Math.max(MIN_SIDE, n * scale));
    pageWidth = side(width);
    pageHeight = side(height);
  } else {
    const [short, long] = PAPER[pageSize];
    const landscape = orientation === 'landscape' || (orientation === 'auto' && width > height);
    [pageWidth, pageHeight] = landscape ? [long, short] : [short, long];
  }
  const room = fit === 'fill' || pageSize === 'auto' ? 0 : Math.min(margin, pageWidth / 2 - 1, pageHeight / 2 - 1);
  const scale =
    fit === 'fill' ? Math.max(pageWidth / width, pageHeight / height) : Math.min((pageWidth - 2 * room) / width, (pageHeight - 2 * room) / height);
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  return {
    pageWidth,
    pageHeight,
    x: (pageWidth - drawnWidth) / 2,
    y: (pageHeight - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
    clip: fit === 'fill',
  };
}

export interface ImageLimits {
  /**
   * Pixels a PNG may have. pdf-lib embeds a JPEG as it is but decodes a PNG completely (4 bytes a
   * pixel, held several times over while it is compressed again), so only PNGs are capped.
   * The page converts WebP and GIF to PNG first and checks them against the same number.
   */
  maxImagePixels: number;
}

/** Checks an image header against what this module embeds (PNG and JPEG) and the pixel cap. */
export function checkImage(file: LocalFile, limits: ImageLimits): ImageHeader {
  const header = readImageHeader(file.bytes);
  if (!header) throw new LocalPdfError('not_image', `${quoted(file.name)} is not a PNG, JPEG, WebP or GIF image.`, file.name);
  if (header.width < 1 || header.height < 1) throw new LocalPdfError('damaged', `${quoted(file.name)} has no pixels.`, file.name);
  if (header.kind !== 'jpeg' && header.width * header.height > limits.maxImagePixels) {
    throw new LocalPdfError(
      'image_too_large',
      `${quoted(file.name)} is ${header.width} x ${header.height} pixels; images other than JPEG may have at most ${Math.floor(limits.maxImagePixels / 1_000_000)} million pixels here. Scale it down, or save it as a JPEG.`,
      file.name,
    );
  }
  return header;
}

/**
 * One page per image, in the order given. Takes PNG and JPEG; the page turns WebP and GIF into
 * PNG in the browser before calling this.
 */
export async function imagesToPdf(files: readonly LocalFile[], options: ImagePageOptions & ImageLimits): Promise<LocalPdfResult> {
  if (files.length === 0) throw new LocalPdfError('empty', 'Add at least one image.');
  imagePageLayout(1, 1, options); // refuses unknown options before any work
  const doc = await newDocument();
  for (const file of files) {
    const header = checkImage(file, options);
    if (header.kind !== 'png' && header.kind !== 'jpeg') {
      throw new LocalPdfError('not_image', `${quoted(file.name)} must be converted to PNG before it is added.`, file.name);
    }
    let image: PDFImage;
    try {
      if (header.kind === 'png') {
        if (!pngIsComplete(file.bytes)) throw new Error('PNG breaks off');
        image = await doc.embedPng(file.bytes);
      } else {
        const stripped = stripJpegMetadata(file.bytes);
        if (!stripped) throw new Error('unreadable JPEG structure');
        image = await doc.embedJpg(stripped);
      }
    } catch {
      throw new LocalPdfError('damaged', `${quoted(file.name)} could not be read as a ${header.kind.toUpperCase()}: the file is damaged.`, file.name);
    }
    const sideways = header.orientation >= 5;
    const layout = imagePageLayout(sideways ? header.height : header.width, sideways ? header.width : header.height, options);
    const page = doc.addPage([layout.pageWidth, layout.pageHeight]);
    const name = page.node.newXObject('Image', image.ref);
    page.pushOperators(
      pushGraphicsState(),
      ...(layout.clip ? [rectangle(0, 0, layout.pageWidth, layout.pageHeight), clip(), endPath()] : []),
      concatTransformationMatrix(layout.width, 0, 0, layout.height, layout.x, layout.y),
      concatTransformationMatrix(...orientationMatrix(header.orientation)),
      drawObject(name),
      popGraphicsState(),
    );
  }
  return save(doc);
}
