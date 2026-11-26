/**
 * stamp: a text or image watermark ("PAID", "DRAFT", a logo) on chosen pages.
 *
 * Placement is in the page as shown (src/pdftools/frame.ts): `position` is one of nine anchors,
 * `margin` (points) keeps the stamp off the edges, and `rotation` turns it counter-clockwise
 * around its own centre. The turned stamp's bounding box is what is kept inside the margins, so
 * a 45-degree "DRAFT" in a corner stays on the page. A stamp larger than the page is centred
 * on its anchor and may run off the page; it is not shrunk behind the caller's back.
 *
 * Text uses a standard PDF font (src/pdftools/text.ts: Latin characters only) and is at most
 * PDF.maxDataValueChars long, the cap on any one value printed into a PDF: the line is written
 * into every chosen page, so its length is multiplied by up to PDF_TOOLKIT.maxPages.
 */
import { degrees, type PDFDocument, type PDFFont } from '@cantoo/pdf-lib';
import { PDF } from '../config';
import { ApiError } from '../lib/errors';
import { codePointLength } from '../lib/http';
import { assertTotalBytes, fileLabel, loadPdf } from './document';
import { drawInFrame, type Frame } from './frame';
import { drawImage, embedImage, type PreparedImage } from './images';
import { finish } from './mark';
import { selectPages } from './pages';
import { assertDrawable, parseColor, STAMP_FONTS, type StampFont, standardFont } from './text';
import type { OutputOptions, PdfOutput } from './types';

export const STAMP_POSITIONS = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type StampPosition = (typeof STAMP_POSITIONS)[number];

/** Defaults: a large, faint, grey line in the middle of every page. */
const DEFAULTS = { fontSize: 48, font: 'helvetica-bold' as StampFont, color: '#6b7280', opacity: 0.35, rotation: 0, position: 'center' as StampPosition, margin: 36 };

export interface StampLayout {
  /** 0 (invisible) to 1 (solid). */
  opacity?: number;
  /** Degrees, counter-clockwise. */
  rotation?: number;
  position?: StampPosition;
  /** Distance from the page edges, in points (1/72 inch). */
  margin?: number;
  /** "1-3,5"; every page when absent. */
  pages?: string;
}

export interface TextStamp extends StampLayout {
  text: string;
  /** Points. */
  fontSize?: number;
  font?: StampFont;
  /** "#rrggbb" or "#rgb". */
  color?: string;
}

export interface ImageStamp extends StampLayout {
  image: Uint8Array;
  /** Width in points; the height follows the image's proportions. Default: the image at 72 dpi, shrunk to fit inside the margins. */
  width?: number;
}

export type StampOptions = OutputOptions & ({ text: TextStamp; image?: undefined } | { image: ImageStamp; text?: undefined });

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

function finiteNumber(value: unknown, what: string, check: (n: number) => boolean, rule: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !check(value)) throw invalid(`${what} must be ${rule}.`);
  return value;
}

interface Layout {
  opacity: number;
  rotation: number;
  position: StampPosition;
  margin: number;
}

function layoutOf(input: StampLayout, what: string): Layout {
  const position = input.position ?? DEFAULTS.position;
  if (!STAMP_POSITIONS.includes(position)) throw invalid(`${what}.position must be one of: ${STAMP_POSITIONS.join(', ')}.`);
  return {
    opacity: finiteNumber(input.opacity ?? DEFAULTS.opacity, `${what}.opacity`, (n) => n >= 0 && n <= 1, 'a number from 0 to 1'),
    rotation: finiteNumber(input.rotation ?? DEFAULTS.rotation, `${what}.rotation`, (n) => Math.abs(n) <= 360, 'a number of degrees from -360 to 360'),
    position,
    margin: finiteNumber(input.margin ?? DEFAULTS.margin, `${what}.margin`, (n) => n >= 0, 'a number of points, 0 or more'),
  };
}

/** Centre of a w x h box (already turned) at `position`, inside `margin`. */
function anchor(frame: Frame, layout: Layout, boxWidth: number, boxHeight: number): { x: number; y: number } {
  const { position, margin } = layout;
  const left = margin + boxWidth / 2;
  const right = frame.width - margin - boxWidth / 2;
  const bottom = margin + boxHeight / 2;
  const top = frame.height - margin - boxHeight / 2;
  const x = position.endsWith('left') ? left : position.endsWith('right') ? right : frame.width / 2;
  const y = position.startsWith('top') ? top : position.startsWith('bottom') ? bottom : frame.height / 2;
  return { x, y };
}

/** Bounding box of a w x h rectangle turned by `rotation` degrees. */
function turnedBox(width: number, height: number, rotation: number): { width: number; height: number } {
  const theta = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(theta));
  const sin = Math.abs(Math.sin(theta));
  return { width: width * cos + height * sin, height: width * sin + height * cos };
}

interface PreparedText {
  text: string;
  font: PDFFont;
  size: number;
  color: ReturnType<typeof parseColor>;
  layout: Layout;
}

async function prepareText(doc: PDFDocument, input: TextStamp): Promise<PreparedText> {
  if (typeof input.text !== 'string' || input.text.trim() === '') throw invalid('text.text must be a non-empty string.');
  if (codePointLength(input.text) > PDF.maxDataValueChars) throw invalid(`text.text may be at most ${PDF.maxDataValueChars} characters.`);
  const fontName = input.font ?? DEFAULTS.font;
  if (!Object.hasOwn(STAMP_FONTS, fontName)) throw invalid(`text.font must be one of: ${Object.keys(STAMP_FONTS).join(', ')}.`);
  const font = await standardFont(doc, STAMP_FONTS[fontName], new Map());
  assertDrawable(font, input.text, 'text.text');
  return {
    text: input.text,
    font,
    size: finiteNumber(input.fontSize ?? DEFAULTS.fontSize, 'text.font_size', (n) => n > 0, 'a number of points above 0'),
    color: parseColor(input.color ?? DEFAULTS.color, 'text.color'),
    layout: layoutOf(input, 'text'),
  };
}

function drawTextStamp(doc: PDFDocument, indexes: number[], stamp: PreparedText): void {
  const { text, font, size, color, layout } = stamp;
  const width = font.widthOfTextAtSize(text, size);
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = ascent - font.heightAtSize(size);
  const box = turnedBox(width, ascent - descent, layout.rotation);
  const theta = (layout.rotation * Math.PI) / 180;
  // drawText turns around the baseline origin; move the origin so the turned box is centred on the anchor.
  const localX = width / 2;
  const localY = (ascent + descent) / 2;
  const offsetX = localX * Math.cos(theta) - localY * Math.sin(theta);
  const offsetY = localX * Math.sin(theta) + localY * Math.cos(theta);
  const pages = doc.getPages();
  for (const index of indexes) {
    const page = pages[index]!;
    drawInFrame(page, (frame) => {
      const center = anchor(frame, layout, box.width, box.height);
      page.drawText(text, {
        x: center.x - offsetX,
        y: center.y - offsetY,
        size,
        font,
        color,
        opacity: layout.opacity,
        rotate: degrees(layout.rotation),
      });
    });
  }
}

function drawImageStamp(doc: PDFDocument, indexes: number[], prepared: PreparedImage, input: ImageStamp, layout: Layout): void {
  if (input.width !== undefined) finiteNumber(input.width, 'image.width', (n) => n > 0, 'a number of points above 0');
  const pages = doc.getPages();
  for (const index of indexes) {
    const page = pages[index]!;
    drawInFrame(page, (frame) => {
      let width = input.width ?? prepared.width;
      let height = (width * prepared.height) / prepared.width;
      if (input.width === undefined) {
        // Natural size (1 px = 1 pt), shrunk so the turned image fits inside the margins.
        const box = turnedBox(width, height, layout.rotation);
        const scale = Math.min(1, (frame.width - 2 * layout.margin) / box.width, (frame.height - 2 * layout.margin) / box.height);
        if (scale > 0) {
          width *= scale;
          height *= scale;
        }
      }
      const box = turnedBox(width, height, layout.rotation);
      const center = anchor(frame, layout, box.width, box.height);
      drawImage(page, prepared, { centerX: center.x, centerY: center.y, width, height, rotate: layout.rotation, opacity: layout.opacity });
    });
  }
}

export async function stamp(pdf: Uint8Array, options: StampOptions): Promise<PdfOutput> {
  if ((options.text === undefined) === (options.image === undefined)) throw invalid('Give either "text" or "image" to stamp, not both.');
  const imageBytes = options.image?.image;
  if (options.image !== undefined && !(imageBytes instanceof Uint8Array)) throw invalid('image must be a PNG or JPEG file.');
  assertTotalBytes(imageBytes ? [pdf, imageBytes] : [pdf]);
  const doc = await loadPdf(pdf, fileLabel(0));
  const layoutInput = options.text ?? options.image!;
  const indexes = selectPages(layoutInput.pages, doc.getPageCount(), `${options.text ? 'text' : 'image'}.pages`);

  if (options.text) {
    drawTextStamp(doc, indexes, await prepareText(doc, options.text));
  } else {
    const layout = layoutOf(options.image!, 'image');
    const prepared = await embedImage(doc, imageBytes!, 'image');
    drawImageStamp(doc, indexes, prepared, options.image!, layout);
  }
  return finish(doc, options);
}

/** What an unset option means (for the route's docs and the tests). */
export const STAMP_DEFAULTS = DEFAULTS;
