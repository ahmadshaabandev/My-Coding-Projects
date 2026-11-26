/**
 * Page setup of a PDF: paper format, orientation, margins, the download name, and the free
 * mark ("Made with Link To Card") that Chrome draws in the footer of every page of a Free
 * plan or free-tool PDF.
 */
import { PDF, type PdfFormat } from '../config';
import { ApiError } from '../lib/errors';
import { isJsonObject } from '../lib/http';
import type { PdfMargin, PdfPageSetup } from './templates/types';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

const LENGTH = /^(\d{1,4}(?:\.\d{1,4})?|\.\d{1,4})(mm|cm|in|px)$/;
const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, in: 25.4, px: 25.4 / 96 };

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

const round = (mm: number): number => Math.round(mm * 100) / 100;

/** A CSS length in millimetres: number+mm|cm|in|px, or 0. Throws for anything else or more than PDF.maxMarginMm. */
export function marginToMm(value: unknown, side: string): number {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (text === '0' || text === 0) return 0;
  const match = typeof text === 'string' ? LENGTH.exec(text) : null;
  if (!match) throw invalid(`margin.${side} must be a length such as "12mm", "1.5cm", "0.5in" or "40px".`);
  const mm = round(Number(match[1]) * MM_PER_UNIT[match[2]!]!);
  if (mm > PDF.maxMarginMm) throw invalid(`margin.${side} may be at most ${PDF.maxMarginMm}mm.`);
  return mm;
}

/** Margins as Chrome receives them: millimetres, rounded to 0.01 mm. */
export function mm(value: number): string {
  return `${round(value)}mm`;
}

export function parseFormat(value: unknown, fallback: PdfFormat): PdfFormat {
  if (value === undefined) return fallback;
  const format = typeof value === 'string' ? PDF.formats.find((candidate) => candidate === value.trim().toLowerCase()) : undefined;
  if (!format) throw invalid(`"format" must be one of ${PDF.formats.map((candidate) => `"${candidate}"`).join(', ')}.`);
  return format;
}

/** A boolean, or in a signed link's query "true"/"false"/"1"/"0". */
export function parseLandscape(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw invalid('"landscape" must be true or false.');
}

/** The default margin of a template (or PDF.defaultMarginMm), overridden side by side. */
export function parseMargin(value: unknown, fallback: PdfMargin | null): PdfMargin {
  const base: Record<Side, string> = fallback
    ? { top: mm(marginToMm(fallback.top, 'top')), right: mm(marginToMm(fallback.right, 'right')), bottom: mm(marginToMm(fallback.bottom, 'bottom')), left: mm(marginToMm(fallback.left, 'left')) }
    : { top: mm(PDF.defaultMarginMm), right: mm(PDF.defaultMarginMm), bottom: mm(PDF.defaultMarginMm), left: mm(PDF.defaultMarginMm) };
  if (value === undefined) return base;
  if (!isJsonObject(value)) throw invalid('"margin" must be an object such as {"top": "20mm", "bottom": "20mm"}.');
  const unknown = Object.keys(value).filter((key) => !(SIDES as readonly string[]).includes(key));
  if (unknown.length > 0) throw invalid(`Unknown margin field${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"${key}"`).join(', ')}. Allowed: ${SIDES.join(', ')}.`);
  const margin = { ...base };
  for (const side of SIDES) if (value[side] !== undefined) margin[side] = mm(marginToMm(value[side], side));
  return margin;
}

/** The setup with the free mark's room: the bottom margin raised to PDF.freeMarkMinBottomMm. */
export function withMarkRoom(setup: PdfPageSetup): PdfPageSetup {
  const bottom = marginToMm(setup.margin.bottom, 'bottom');
  if (bottom >= PDF.freeMarkMinBottomMm) return setup;
  return { ...setup, margin: { ...setup.margin, bottom: mm(PDF.freeMarkMinBottomMm) } };
}

/* ------------------------------------------------------------------ */
/* Header and footer templates                                         */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Chrome prints a default date/title header and URL/page footer unless templates are given. */
export const EMPTY_TEMPLATE = '<span></span>';

/**
 * The free mark as Chrome's footer draws it: one centred line in the bottom margin. Header and
 * footer templates do not see the document's fonts, so it uses the browser's sans-serif.
 * print-color-adjust: exact keeps its grey: without it Chrome darkens light text when it prints
 * (measured: #6b7280 came out as #24272c), and the mark should stay quieter than the document.
 *
 * The text sits on its own white background. Chrome paints the footer above the page, so
 * whatever the document puts under the mark (a background, a band in the mark's own grey, text
 * printed into the bottom margin) cannot make it unreadable.
 */
export const FREE_MARK_HTML =
  '<div style="width:100%;box-sizing:border-box;padding:0 10mm;font-family:sans-serif;font-size:7.5pt;line-height:1.3;' +
  'color:#6b7280;-webkit-print-color-adjust:exact;print-color-adjust:exact;text-align:center;position:relative;z-index:2147483647">' +
  `<div style="display:inline-block;padding:0.4mm 2mm;background:#fff;color:#6b7280">${escapeHtml(PDF.freeMark)}</div></div>`;

/** Chrome's own padding between the page edge and a header's top or a footer's bottom (0.4 cm). */
const CHROME_EDGE_PADDING_MM = 4;
/** Height the free mark's line takes at the bottom of the footer. */
const MARK_LINE_MM = 5;

export interface HeaderFooter {
  displayHeaderFooter: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
}

/**
 * The classes Chrome fills in on every page of a header or footer, in the order its template
 * applies them, so on an element with several the last one wins. (Chrome also knows "url",
 * which is not offered: it would print the browser's address of the document.)
 */
export const PAGE_VALUE_CLASSES = ['date', 'title', 'pageNumber', 'totalPages'] as const;
export type PageValueClass = (typeof PAGE_VALUE_CLASSES)[number];

/** The only markup of a plain-text header or footer: an element Chrome fills in, and a line break. */
export const pageValueSpan = (name: PageValueClass): string => `<span class="${name}"></span>`;
export const PLAIN_LINE_BREAK = '<br>';
const PLAIN_MARKUP = new RegExp(`${PLAIN_LINE_BREAK}|<span class="(?:${PAGE_VALUE_CLASSES.join('|')})"></span>`, 'g');

/**
 * Text that keeps only the markup of a plain-text header or footer (src/pdf/template.ts builds
 * it): every other "<" and ">" is escaped, so no element we did not write can reach Chrome.
 */
export function plainTextOnly(html: string): string {
  const escape = (text: string): string => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let last = 0;
  for (const match of html.matchAll(PLAIN_MARKUP)) {
    out += escape(html.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + escape(html.slice(last));
}

/**
 * How a header or footer prints next to the free mark: our own box, laid out like Chrome's
 * own #header and #footer (full width, centred), in our font, size and colour, slightly
 * stronger than the mark. It holds only plain text and Chrome's page values, and is cut off at
 * the height the margin leaves it.
 */
export const PLAIN_TEXT_STYLE =
  'width:100%;box-sizing:border-box;padding:0 10mm;font-family:sans-serif;font-size:8pt;line-height:1.3;color:#374151;' +
  '-webkit-print-color-adjust:exact;print-color-adjust:exact;text-align:center;overflow-wrap:anywhere;overflow:hidden';

function plainTextBox(text: string, maxHeightMm: number): string {
  return `<div style="${PLAIN_TEXT_STYLE};max-height:${mm(Math.max(0, maxHeightMm))}">${plainTextOnly(text)}</div>`;
}

/**
 * Chrome's header/footer options. Without the mark: the customer's sanitised templates as
 * they are. With it (Free plan, free tools): Chrome renders the header, the footer and the mark
 * in one document, so no customer markup goes there at all. The header and footer arrive as
 * plain text (preparePdfFragment with `mark`), anything else in them is escaped here as well,
 * and each sits in its own box sized to its margin (`margin`: the page's top and bottom
 * margin). The mark comes last, below the footer, on its own white box at the highest z-index.
 */
export function headerFooter(
  header: string | null,
  footer: string | null,
  mark: boolean,
  margin: Pick<PdfMargin, 'top' | 'bottom'> = { top: mm(PDF.defaultMarginMm), bottom: mm(PDF.freeMarkMinBottomMm) },
): HeaderFooter {
  if (!mark) {
    if (header === null && footer === null) return { displayHeaderFooter: false };
    return { displayHeaderFooter: true, headerTemplate: header ?? EMPTY_TEMPLATE, footerTemplate: footer ?? EMPTY_TEMPLATE };
  }
  const top = marginToMm(margin.top, 'top');
  const bottom = marginToMm(margin.bottom, 'bottom');
  const headerTemplate = header === null || header === '' ? EMPTY_TEMPLATE : plainTextBox(header, top - CHROME_EDGE_PADDING_MM);
  const footerTemplate =
    footer === null || footer === ''
      ? FREE_MARK_HTML
      : `<div style="width:100%">${plainTextBox(footer, bottom - CHROME_EDGE_PADDING_MM - MARK_LINE_MM)}${FREE_MARK_HTML}</div>`;
  return { displayHeaderFooter: true, headerTemplate, footerTemplate };
}

/* ------------------------------------------------------------------ */
/* Download name                                                       */
/* ------------------------------------------------------------------ */

/**
 * A safe download name for Content-Disposition: ASCII letters, digits, space, ".", "_", "-",
 * "(" and ")" only (accents are dropped, anything else becomes "-"), no leading dot, at most
 * PDF.maxFilenameChars characters, always ending in ".pdf". `fallback` when nothing is left.
 */
export function sanitizeFilename(value: string, fallback: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.pdf\s*$/i, '')
    .replace(/[^A-Za-z0-9 ._()-]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[\s.-]+|[\s.-]+$/g, '');
  const kept = base.slice(0, PDF.maxFilenameChars - '.pdf'.length).replace(/[\s.-]+$/g, '');
  if (kept === '') return fallback === value ? 'document.pdf' : sanitizeFilename(fallback, 'document.pdf');
  return `${kept}.pdf`;
}

/** The "filename" field of a request, sanitised; the fallback when it is absent. */
export function parseFilename(value: unknown, fallback: string): string {
  if (value === undefined) return sanitizeFilename(fallback, 'document.pdf');
  if (typeof value !== 'string') throw invalid('"filename" must be text, for example "invoice-2026-001.pdf".');
  return sanitizeFilename(value, fallback);
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  // sanitizeFilename leaves no quote, backslash or non-ASCII character, so the plain form is exact.
  return `${kind}; filename="${filename}"`;
}
