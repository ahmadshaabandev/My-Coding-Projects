/** Shapes shared by the PDF toolkit's operations (src/pdftools/*). */

/** A finished PDF and its page count (what the route charges: pdfToolkitUnits in src/config.ts). */
export interface PdfOutput {
  bytes: Uint8Array;
  pages: number;
}

/** Options every operation that writes a PDF accepts. */
export interface OutputOptions {
  /**
   * Stamp "Made with Link To Card" at the bottom of every page (Free plan outputs). It is drawn
   * before the file is written, so it is also inside a file that "protect" encrypts.
   */
  freeMark?: boolean;
}
