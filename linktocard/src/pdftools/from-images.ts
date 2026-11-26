/**
 * from-images: PNG and JPEG files to a PDF, one image per page, in the order given.
 *
 *   page_size    a4 | letter | a5 (PDF.formats, the sizes of the PDF renderer) or auto: the page is
 *                the image (1 pixel = 1 point, i.e. 72 dpi)
 *   fit          "fit": the whole image, as large as the margins allow, centred (default)
 *                "fill": the page covered edge to edge, the image cropped to it (margins ignored)
 *   orientation  auto (portrait or landscape, whichever suits the image; default), portrait, landscape
 *   margin       points around a "fit" image (default 0)
 *
 * Images are drawn upright (EXIF orientation, src/pdftools/images.ts). An "auto" page is held
 * within 3 to 14,400 points (200 inches) a side, the implementation limits the PDF 1.7 reference
 * gives in its Annex C (not checked against the document itself for this build; larger pages
 * need /UserUnit, which many readers ignore); a larger image is scaled down onto it.
 */
import { PageSizes } from '@cantoo/pdf-lib';
import { PDF, PDF_TOOLKIT, type PdfFormat } from '../config';
import { ApiError } from '../lib/errors';
import { assertFileCount, assertTotalBytes, fileLabel, newPdf } from './document';
import { clipRect, drawInFrame } from './frame';
import { drawImage, embedImage } from './images';
import { finish } from './mark';
import type { OutputOptions, PdfOutput } from './types';

export const IMAGE_PAGE_SIZES = [...PDF.formats, 'auto'] as const;
export type ImagePageSize = (typeof IMAGE_PAGE_SIZES)[number];
export const IMAGE_FITS = ['fit', 'fill'] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];
export const IMAGE_ORIENTATIONS = ['auto', 'portrait', 'landscape'] as const;
export type ImageOrientation = (typeof IMAGE_ORIENTATIONS)[number];

export interface FromImagesOptions extends OutputOptions {
  pageSize?: ImagePageSize;
  fit?: ImageFit;
  orientation?: ImageOrientation;
  margin?: number;
}

/** Smallest and largest page side, in points (see the header). */
const MIN_SIDE = 3;
const MAX_SIDE = 14_400;

const SIZES: Record<PdfFormat, [number, number]> = { a4: PageSizes.A4, letter: PageSizes.Letter, a5: PageSizes.A5 };

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

function oneOf<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, what: string): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw invalid(`${what} must be one of: ${allowed.join(', ')}.`);
  return value;
}

const clamp = (n: number): number => Math.min(MAX_SIDE, Math.max(MIN_SIDE, n));

/** Page size for an image shown `w` x `h` pixels. */
function pageFor(size: ImagePageSize, orientation: ImageOrientation, w: number, h: number): [number, number] {
  if (size === 'auto') {
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    return [clamp(w * scale), clamp(h * scale)];
  }
  const [short, long] = SIZES[size];
  const landscape = orientation === 'landscape' || (orientation === 'auto' && w > h);
  return landscape ? [long, short] : [short, long];
}

export async function fromImages(images: readonly Uint8Array[], options: FromImagesOptions = {}): Promise<PdfOutput> {
  assertFileCount(images.length, 1, PDF_TOOLKIT.maxFiles, 'image');
  assertTotalBytes(images);
  const pageSize = oneOf(options.pageSize, IMAGE_PAGE_SIZES, 'a4', 'page_size');
  const fit = oneOf(options.fit, IMAGE_FITS, 'fit', 'fit');
  const orientation = oneOf(options.orientation, IMAGE_ORIENTATIONS, 'auto', 'orientation');
  const margin = options.margin ?? 0;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) throw invalid('margin must be a number of points, 0 or more.');

  const doc = await newPdf();
  for (const [index, bytes] of images.entries()) {
    const prepared = await embedImage(doc, bytes, fileLabel(index));
    const [pageWidth, pageHeight] = pageFor(pageSize, orientation, prepared.width, prepared.height);
    const page = doc.addPage([pageWidth, pageHeight]);
    const room = fit === 'fill' || pageSize === 'auto' ? 0 : Math.min(margin, pageWidth / 2 - 1, pageHeight / 2 - 1);
    const scale =
      fit === 'fill'
        ? Math.max(pageWidth / prepared.width, pageHeight / prepared.height)
        : Math.min((pageWidth - 2 * room) / prepared.width, (pageHeight - 2 * room) / prepared.height);
    drawInFrame(page, (frame) => {
      if (fit === 'fill') page.pushOperators(...clipRect(0, 0, frame.width, frame.height));
      drawImage(page, prepared, { centerX: frame.width / 2, centerY: frame.height / 2, width: prepared.width * scale, height: prepared.height * scale });
    });
  }
  return finish(doc, options);
}
