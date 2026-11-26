/**
 * split: one PDF into several. Either `ranges` ("1-3,5,8-": one output per item) or `every`
 * (a new file every n pages). At most PDF_TOOLKIT.maxFiles outputs: the same cap as inputs, so a
 * request can never fan out into more stored files than it could have sent.
 *
 * Each output is charged on its own pages (the route sums pdfToolkitUnits per output).
 */
import { PDF_TOOLKIT } from '../config';
import { ApiError } from '../lib/errors';
import { assertOutputBytes, assertTotalBytes, fileLabel, loadPdf, newPdf, tooManyPages } from './document';
import { finish } from './mark';
import { type PageRange, parsePageRanges, rangeIndexes } from './pages';
import type { OutputOptions, PdfOutput } from './types';

export interface SplitOptions extends OutputOptions {
  ranges?: string;
  every?: number;
}

export interface SplitOutput extends PdfOutput {
  /** The pages of the input this file holds, e.g. "1-3". */
  range: string;
}

export interface SplitResult {
  outputs: SplitOutput[];
  /** Pages of all outputs together. */
  pages: number;
}

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

function tooManyOutputs(count: number): ApiError {
  return new ApiError('invalid_request', `This split would make ${count} files; at most ${PDF_TOOLKIT.maxFiles} per request. Use fewer ranges or a larger "every".`, {
    details: { outputs: count, max_outputs: PDF_TOOLKIT.maxFiles },
  });
}

function everyRanges(every: number, pageCount: number): PageRange[] {
  const ranges: PageRange[] = [];
  for (let from = 1; from <= pageCount; from += every) {
    const to = Math.min(pageCount, from + every - 1);
    ranges.push({ from, to, label: from === to ? String(from) : `${from}-${to}` });
  }
  return ranges;
}

export async function split(pdf: Uint8Array, options: SplitOptions): Promise<SplitResult> {
  const hasRanges = options.ranges !== undefined;
  const hasEvery = options.every !== undefined;
  if (hasRanges === hasEvery) throw invalid('Give either "ranges" (like "1-3,5") or "every" (pages per file), not both.');
  if (hasEvery && (!Number.isInteger(options.every) || options.every! < 1)) throw invalid('"every" must be a whole number of pages, 1 or more.');
  if (hasRanges && typeof options.ranges !== 'string') throw invalid('"ranges" must be a string like "1-3,5".');

  assertTotalBytes([pdf]);
  const source = await loadPdf(pdf, fileLabel(0));
  const pageCount = source.getPageCount();
  if (hasEvery && Math.ceil(pageCount / options.every!) > PDF_TOOLKIT.maxFiles) throw tooManyOutputs(Math.ceil(pageCount / options.every!));
  const ranges = hasEvery ? everyRanges(options.every!, pageCount) : parsePageRanges(options.ranges!, pageCount, 'ranges');
  if (ranges.length > PDF_TOOLKIT.maxFiles) throw tooManyOutputs(ranges.length);
  // Ranges may overlap ("1-500,1-500"): the page cap is on what is written, not on the input.
  const written = ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0);
  if (written > PDF_TOOLKIT.maxPages) throw tooManyPages(written, 'The split files would have');

  const outputs: SplitOutput[] = [];
  // Every file gets its own copy of what its pages share, and all files are held until they are
  // stored: the running total stops the split before the next file is built (PDF_TOOLKIT.maxOutputBytes).
  let bytes = 0;
  for (const range of ranges) {
    const out = await newPdf();
    for (const page of await out.copyPages(source, rangeIndexes(range))) out.addPage(page);
    const output = await finish(out, options);
    bytes += output.bytes.byteLength;
    assertOutputBytes(bytes);
    outputs.push({ ...output, range: range.label });
  }
  return { outputs, pages: outputs.reduce((sum, output) => sum + output.pages, 0) };
}
