/**
 * The page as a reader shows it. pdf-lib draws in the page's own coordinates, but a page can be
 * turned (/Rotate 90, 180 or 270: scans and landscape exports often are) and show only part of
 * its media box (/CropBox). Drawing "at the bottom, centred" in raw coordinates would then land
 * on the side of the page, or outside the visible area.
 *
 * visualFrame() gives the visible size as shown (width and height swap at 90 and 270 degrees)
 * and the matrix from that upright frame (origin at the bottom-left corner as shown, x to the
 * right, y up) to page space. drawInFrame() wraps drawing in q / cm ... Q so everything drawn
 * inside uses upright coordinates, and marks it as an artifact (/Artifact BMC ... EMC) so screen
 * readers and text extraction of tagged PDFs skip stamps and the free mark.
 */
import {
  type PDFOperator,
  type PDFPage,
  beginMarkedContent,
  clip,
  concatTransformationMatrix,
  endMarkedContent,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from '@cantoo/pdf-lib';

/** [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f (the PDF "cm" operands). */
export type Matrix = [number, number, number, number, number, number];

export interface Frame {
  width: number;
  height: number;
  /** Upright frame -> page space. */
  matrix: Matrix;
  /** Clockwise turn of the page as shown: 0, 90, 180 or 270. */
  rotation: 0 | 90 | 180 | 270;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The crop box clipped to the media box (readers show their intersection). */
function visibleBox(page: PDFPage): Box {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  // A crop box outside the media box is broken; readers fall back to the media box.
  if (x1 <= x0 || y1 <= y0) return media;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** /Rotate must be a multiple of 90 (negative and > 360 allowed); anything else is treated as 0. */
function normalisedRotation(page: PDFPage): Frame['rotation'] {
  const angle = page.getRotation().angle;
  if (!Number.isFinite(angle) || angle % 90 !== 0) return 0;
  return (((angle % 360) + 360) % 360) as Frame['rotation'];
}

export function visualFrame(page: PDFPage): Frame {
  const { x, y, width: w, height: h } = visibleBox(page);
  const rotation = normalisedRotation(page);
  switch (rotation) {
    case 90:
      // Shown turned clockwise: upright x runs along page +y, upright y along page -x.
      return { width: h, height: w, rotation, matrix: [0, 1, -1, 0, x + w, y] };
    case 180:
      return { width: w, height: h, rotation, matrix: [-1, 0, 0, -1, x + w, y + h] };
    case 270:
      return { width: h, height: w, rotation, matrix: [0, -1, 1, 0, x, y + h] };
    default:
      return { width: w, height: h, rotation, matrix: [1, 0, 0, 1, x, y] };
  }
}

/** Maps a point of the upright frame to page space (used by tests and by callers that need it). */
export function toPageSpace(frame: Frame, px: number, py: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = frame.matrix;
  return { x: a * px + c * py + e, y: b * px + d * py + f };
}

/** Runs `draw` with upright coordinates on `page`, as one artifact, in its own graphics state. */
export function drawInFrame(page: PDFPage, draw: (frame: Frame) => void): void {
  const frame = visualFrame(page);
  page.pushOperators(beginMarkedContent('Artifact'), pushGraphicsState(), concatTransformationMatrix(...frame.matrix));
  draw(frame);
  page.pushOperators(popGraphicsState(), endMarkedContent());
}

/** "x y w h re W n": clips what follows to a rectangle (from-images "fill" crops to the page). */
export function clipRect(x: number, y: number, width: number, height: number): PDFOperator[] {
  return [rectangle(x, y, width, height), clip(), endPath()];
}
