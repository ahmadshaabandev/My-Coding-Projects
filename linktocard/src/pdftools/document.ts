/**
 * Reading and writing PDFs for the PDF toolkit (POST /v1/pdf-tools/{op}), with the input checks
 * every operation shares. Everything runs on @cantoo/pdf-lib inside the Worker: no browser.
 *
 * What pdf-lib cannot do safely is refused up front, with a message that says what to do:
 *  - encrypted files: pdf-lib refuses them, and a file that opens without a password can still
 *    carry an owner password whose restrictions we must not strip;
 *  - XFA forms: pdf-lib cannot read or write XFA, and its getForm() and save() silently delete
 *    the XFA data, which would leave a dynamic form blank;
 *  - files that are not PDFs, or are damaged beyond what the parser recovers.
 *
 * The byte, file and page limits are PDF_TOOLKIT's (src/config.ts). Bytes are checked before
 * anything is parsed; pages are checked from the file's own cross-reference table when it has a
 * classic one (src/pdf/count.ts, cheap), and again after parsing. Before parsing, the file's
 * structure is also measured (src/pdftools/budget.ts): pdf-lib's memory grows with it, not with
 * the byte count, and an isolate that runs out of memory fails every request it is serving.
 */
// First: makes pdf-lib's PDFRef/PDFName pools collectable before anything here parses a PDF.
import { sweepPdfObjectPools } from './pools';
import { EncryptedPDFError, PDFArray, PDFDict, PDFDocument, PDFName, PDFPageLeaf, PDFPageTree, ParseSpeeds } from '@cantoo/pdf-lib';
import { PDF_TOOLKIT } from '../config';
import { formatCount } from '../billing/plans';
import { ApiError } from '../lib/errors';
import { countPdfPages } from '../pdf/count';
import { estimateStructure } from './budget';
import type { PdfOutput } from './types';

/**
 * Some PDFs carry a few bytes of junk before "%PDF-" and readers tolerate it, so the header is
 * looked for in the first 1024 bytes. pdf-lib itself would scan the whole file for it, which
 * lets any file that merely contains "%PDF-" somewhere through to the parser.
 */
const HEADER_WINDOW = 1024;
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

const megabytes = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

function invalid(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('invalid_request', message, details ? { details } : {});
}

/** How a file is named in messages: its place in the request's "files" list. */
export function fileLabel(index: number): string {
  return `files[${index}]`;
}

/** Number of input files an operation takes. */
export function assertFileCount(count: number, min: number, max: number, what: string): void {
  if (count < min) throw invalid(min === 1 && max === 1 ? `This operation takes one ${what}.` : `This operation takes at least ${min} ${what}s.`);
  if (count > max) {
    throw invalid(max === 1 ? `This operation takes one ${what}; ${count} were given.` : `At most ${max} ${what}s per request; ${count} were given.`, {
      max_files: max,
    });
  }
}

/** Every input together (PDFs, images, a stamp image) within PDF_TOOLKIT.maxInputBytes. */
export function assertTotalBytes(inputs: readonly Uint8Array[]): void {
  const total = inputs.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (total > PDF_TOOLKIT.maxInputBytes) {
    throw new ApiError('payload_too_large', `The files are ${megabytes(total)} together; the limit is ${megabytes(PDF_TOOLKIT.maxInputBytes)}.`, {
      details: { bytes: total, max_bytes: PDF_TOOLKIT.maxInputBytes },
    });
  }
}

export function tooManyPages(pages: number, what: string): ApiError {
  return new ApiError(
    'payload_too_large',
    `${what} ${pages} pages; the PDF toolkit handles at most ${PDF_TOOLKIT.maxPages} pages per request. Split the work into several requests.`,
    { details: { pages, max_pages: PDF_TOOLKIT.maxPages } },
  );
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, HEADER_WINDOW) - PDF_HEADER.length;
  for (let i = 0; i <= end; i++) {
    if (PDF_HEADER.every((value, k) => bytes[i + k] === value)) return true;
  }
  return false;
}

/** True when the document carries XFA, or asks readers to build its pages from XFA. */
function usesXfa(doc: PDFDocument): boolean {
  const catalog = doc.catalog;
  if (catalog.has(PDFName.of('NeedsRendering')) && String(catalog.get(PDFName.of('NeedsRendering'))) === 'true') return true;
  const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return acroForm !== undefined && acroForm.has(PDFName.of('XFA'));
}

function damaged(label: string): ApiError {
  return invalid(`${label} could not be read as a PDF: the file is damaged or incomplete.`, { reason: 'damaged' });
}

/**
 * Walks the page tree the way pdf-lib's getPages() does (PDFPageTree.traverse), but with a
 * visited set and a running page count. pdf-lib has neither: a tree that lists the same branch
 * many times (a DAG) is walked once per path, so 1.4 KB whose root lists one branch ten times,
 * seven levels deep, made 100,000,000 pages in 6 s and 1.5 GB before the page limit was looked at
 * (security review SEC-2). Here a node reached twice is a damaged file (each page and branch has
 * one parent) and the walk stops as soon as the pages pass PDF_TOOLKIT.maxPages.
 */
function assertPageTree(doc: PDFDocument, label: string): void {
  const root = doc.catalog.Pages();
  const seen = new Set<PDFDict>([root]);
  const stack: PDFPageTree[] = [root];
  let pages = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    const kids = node.Kids();
    for (let i = 0; i < kids.size(); i++) {
      const kid = doc.context.lookup(kids.get(i));
      if (!(kid instanceof PDFPageTree) && !(kid instanceof PDFPageLeaf)) continue; // pdf-lib skips these too
      if (seen.has(kid)) throw damaged(label);
      seen.add(kid);
      if (kid instanceof PDFPageTree) stack.push(kid);
      else if (++pages > PDF_TOOLKIT.maxPages) throw tooManyPages(pages, `${label} has at least`);
    }
  }
}

/**
 * The same for the form's field tree (/AcroForm /Fields and every /Kids below it), which
 * pdf-lib's getForm().getFields() walks without a visited set either (PDFAcroForm.getAllFields):
 * a 1.3 KB file listed 1,000,000 fields. Fields and widgets together are capped at
 * PDF_TOOLKIT.maxFormFields.
 */
function assertFieldTree(doc: PDFDocument, label: string): void {
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray)) return;
  const seen = new Set<PDFDict>();
  const stack: PDFArray[] = [fields];
  while (stack.length > 0) {
    const list = stack.pop()!;
    for (let i = 0; i < list.size(); i++) {
      const node = doc.context.lookup(list.get(i));
      if (!(node instanceof PDFDict)) continue;
      if (seen.has(node)) throw damaged(label);
      seen.add(node);
      if (seen.size > PDF_TOOLKIT.maxFormFields) {
        throw new ApiError(
          'payload_too_large',
          `${label} has a form of more than ${formatCount(PDF_TOOLKIT.maxFormFields)} fields and widgets; the PDF toolkit handles at most ${formatCount(PDF_TOOLKIT.maxFormFields)} per file.`,
          { details: { reason: 'too_many_fields', max_form_fields: PDF_TOOLKIT.maxFormFields } },
        );
      }
      const kids = node.lookup(PDFName.of('Kids'));
      if (kids instanceof PDFArray) stack.push(kids);
    }
  }
}

export function encryptedError(label: string): ApiError {
  return invalid(
    `${label} is encrypted (password-protected). The PDF toolkit cannot open encrypted PDFs, including ones that open ` +
      'without a password but restrict printing or changes. Remove the protection with the password, then send the file again.',
    { reason: 'encrypted' },
  );
}

/**
 * Parses one PDF and checks it. `label` names the file in error messages ("files[0]").
 * The parse never yields to the event loop (ParseSpeeds.Fastest): only CPU time matters here.
 */
export async function loadPdf(bytes: Uint8Array, label: string): Promise<PDFDocument> {
  sweepPdfObjectPools();
  if (bytes.byteLength === 0) throw invalid(`${label} is empty.`);
  if (!hasPdfHeader(bytes)) {
    throw new ApiError('unsupported_media_type', `${label} is not a PDF: it does not start with "%PDF-".`, { details: { reason: 'not_pdf' } });
  }
  // A classic cross-reference table gives the page count without parsing the file.
  const quick = countPdfPages(bytes);
  if (quick !== null && quick > PDF_TOOLKIT.maxPages) throw tooManyPages(quick, `${label} has`);
  // pdf-lib holds every structure token as an object: refuse what would not fit the isolate (src/pdftools/budget.ts).
  await estimateStructure(bytes, label);

  let doc: PDFDocument;
  let pages: number;
  try {
    doc = await PDFDocument.load(bytes, { parseSpeed: ParseSpeeds.Fastest, updateMetadata: false });
    // Our own bounded walks first: pdf-lib's own walks are exponential on a tree that reuses its nodes.
    assertPageTree(doc, label);
    assertFieldTree(doc, label);
    // Walks the page tree: a broken tree throws here, inside the try, not later in an operation.
    pages = doc.getPages().length;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof EncryptedPDFError) throw encryptedError(label);
    throw damaged(label);
  }
  if (doc.isEncrypted) throw encryptedError(label);
  if (usesXfa(doc)) {
    throw invalid(
      `${label} is an XFA form. The PDF toolkit supports standard (AcroForm) PDF forms only. Print or export the form to a ` +
        'new PDF first, then send that file.',
      { reason: 'xfa' },
    );
  }
  if (pages === 0) throw invalid(`${label} has no pages.`, { reason: 'no_pages' });
  if (pages > PDF_TOOLKIT.maxPages) throw tooManyPages(pages, `${label} has`);
  return doc;
}

/**
 * Serialises a document. Classic cross-reference tables (no object streams): the output reads
 * like Chrome's PDFs, so src/pdf/count.ts can count it, at the price of slightly larger files
 * when the input used object streams. Form appearances are regenerated only when an operation
 * changed fields (`forms`); otherwise pdf-lib would rebuild every field without one, in Helvetica.
 */
export async function savePdf(doc: PDFDocument, options: { forms?: boolean } = {}): Promise<PdfOutput> {
  const bytes = await doc.save({
    useObjectStreams: false,
    updateFieldAppearances: options.forms === true,
    addDefaultPage: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
  assertOutputBytes(bytes.byteLength);
  return { bytes, pages: doc.getPageCount() };
}

/**
 * 413 when the results of one request would be over PDF_TOOLKIT.maxOutputBytes together: every
 * output is checked when it is written (savePdf), and split also checks its running total.
 */
export function assertOutputBytes(total: number): void {
  if (total > PDF_TOOLKIT.maxOutputBytes) {
    throw new ApiError(
      'payload_too_large',
      `The result would be ${megabytes(total)} or more; the PDF toolkit makes at most ${megabytes(PDF_TOOLKIT.maxOutputBytes)} per request. ` +
        'Use fewer or smaller files, or fewer pages per request (a split copies the images and fonts its pages share into every file).',
      { details: { reason: 'result_too_large', bytes: total, max_bytes: PDF_TOOLKIT.maxOutputBytes } },
    );
  }
}

/** A new, empty document for operations that assemble pages (merge, split, from-images). */
export async function newPdf(): Promise<PDFDocument> {
  sweepPdfObjectPools();
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer('Link To Card');
  return doc;
}
