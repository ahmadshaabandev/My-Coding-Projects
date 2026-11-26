/**
 * The free mark of toolkit outputs: PDF.freeMark ("Made with Link To Card") as one small grey
 * line, centred at the bottom of every page as the page is shown (rotation and crop box are
 * honoured, src/pdftools/frame.ts). It looks like the mark Chrome prints on Free-plan PDFs
 * (src/pdf/page.ts): 7.5 pt sans-serif, #6b7280, on its own white background so a dark page
 * cannot hide it. Chrome leaves the mark room in the bottom margin; here the pages already exist,
 * so the line sits 4 mm above the bottom edge, below the content of most documents.
 */
import { type PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { PDF } from '../config';
import { loadPdf, savePdf } from './document';
import { drawInFrame } from './frame';
import type { PdfOutput } from './types';

const MM = 72 / 25.4;
const FONT_SIZE = 7.5;
const BOTTOM = 4 * MM;
const PAD_X = 2 * MM;
const PAD_Y = 0.4 * MM;
const GREY = rgb(0x6b / 255, 0x72 / 255, 0x80 / 255);
const WHITE = rgb(1, 1, 1);

/** Draws the free mark on every page of `doc` (in place). */
export async function stampFreeMark(doc: PDFDocument): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const text = PDF.freeMark;
  const widthAt1 = font.widthOfTextAtSize(text, 1);
  for (const page of doc.getPages()) {
    drawInFrame(page, (frame) => {
      // A page narrower than the line (a label, a ticket) gets a smaller line, never a clipped one.
      const size = Math.min(FONT_SIZE, (frame.width - 2 * PAD_X) / widthAt1);
      if (!(size > 0)) return;
      const width = widthAt1 * size;
      const ascent = font.heightAtSize(size, { descender: false });
      const descent = ascent - font.heightAtSize(size);
      const boxWidth = width + 2 * PAD_X;
      const boxHeight = ascent - descent + 2 * PAD_Y;
      const bottom = Math.min(BOTTOM, frame.height / 10);
      const x = (frame.width - boxWidth) / 2;
      page.drawRectangle({ x, y: bottom, width: boxWidth, height: boxHeight, color: WHITE });
      page.drawText(text, { x: x + PAD_X, y: bottom + PAD_Y - descent, size, font, color: GREY });
    });
  }
}

/** The free mark on an existing PDF (for outputs made elsewhere, e.g. a merge done in pieces). */
export async function addFreeMark(pdf: Uint8Array): Promise<PdfOutput> {
  const doc = await loadPdf(pdf, 'files[0]');
  await stampFreeMark(doc);
  return savePdf(doc);
}

/** Applies OutputOptions.freeMark, then saves. */
export async function finish(doc: PDFDocument, options: { freeMark?: boolean }, save: { forms?: boolean } = {}): Promise<PdfOutput> {
  if (options.freeMark === true) await stampFreeMark(doc);
  return savePdf(doc, save);
}
