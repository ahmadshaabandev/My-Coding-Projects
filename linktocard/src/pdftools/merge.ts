/**
 * merge: several PDFs (or chosen pages of each) into one, in the order given.
 *
 * Pages are copied with everything they draw (fonts, images). Document-level parts of the
 * inputs do not carry over: bookmarks, the form's field list (a filled form's values stay
 * visible, but the fields are no longer editable), attachments, metadata. That is pdf-lib's
 * copyPages behaviour and what most merge tools do.
 */
import { PDF_TOOLKIT } from '../config';
import { assertFileCount, assertTotalBytes, fileLabel, loadPdf, newPdf, tooManyPages } from './document';
import { finish } from './mark';
import { isAll, parsePageRanges, rangeIndexes } from './pages';
import type { OutputOptions, PdfOutput } from './types';

export interface MergeInput {
  bytes: Uint8Array;
  /**
   * Pages of this file to take, in the order written ("3,1-2" puts page 3 first; a page may be
   * named twice); every page when absent. Merging one file with pages set reorders it.
   */
  pages?: string;
}

export async function merge(files: readonly MergeInput[], options: OutputOptions = {}): Promise<PdfOutput> {
  assertFileCount(files.length, 1, PDF_TOOLKIT.maxFiles, 'PDF');
  assertTotalBytes(files.map((file) => file.bytes));
  const out = await newPdf();
  let total = 0;
  for (const [index, file] of files.entries()) {
    const label = fileLabel(index);
    const source = await loadPdf(file.bytes, label);
    const count = source.getPageCount();
    const indexes =
      file.pages === undefined || isAll(file.pages)
        ? Array.from({ length: count }, (_, i) => i)
        : parsePageRanges(file.pages, count, `${label}.pages`).flatMap(rangeIndexes);
    total += indexes.length;
    // Checked before copying: the limit is on the output, so stop as soon as it is passed.
    if (total > PDF_TOOLKIT.maxPages) throw tooManyPages(total, 'The merged PDF would have');
    for (const page of await out.copyPages(source, indexes)) out.addPage(page);
  }
  return finish(out, options);
}
