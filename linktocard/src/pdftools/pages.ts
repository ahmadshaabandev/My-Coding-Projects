/**
 * Page ranges as people write them in print dialogs: "1-3,5,8-" (pages are numbered from 1).
 *
 *   n      one page
 *   a-b    pages a to b, a <= b
 *   a-     page a to the last page
 *
 * Commas separate items; spaces are ignored. A range that names a page the document does not
 * have is an error, never silently cut short: "1-12" on a 10-page file is more likely a mistake
 * than a request for ten pages.
 *
 * Every item names at least one page and no operation writes more than PDF_TOOLKIT.maxPages,
 * so a spec with more items than that is refused before it is split (its length is checked
 * first: the request body may be megabytes).
 */
import { PDF_TOOLKIT } from '../config';
import { ApiError } from '../lib/errors';

export interface PageRange {
  /** First and last page, 1-based and inclusive. */
  from: number;
  to: number;
  /** The item as written, normalised ("3-5", "8-10" for "8-" on a 10-page file). */
  label: string;
}

const ITEM = /^(\d{1,6})(?:(-)(\d{1,6})?)?$/;
/** Longest item ("123456-123456") plus its comma and a space. */
const MAX_ITEM_CHARS = 15;

function invalid(what: string, message: string): ApiError {
  return new ApiError('invalid_request', `${what}: ${message}`);
}

/** Parses `spec` against a document of `pageCount` pages. `what` names the field in messages. */
export function parsePageRanges(spec: string, pageCount: number, what = 'pages'): PageRange[] {
  if (typeof spec !== 'string') throw invalid(what, 'must be a string like "1-3,5".');
  const maxItems = PDF_TOOLKIT.maxPages;
  if (spec.length > maxItems * MAX_ITEM_CHARS) throw invalid(what, `too long: at most ${maxItems} pages or ranges.`);
  const items = spec.replace(/\s+/g, '').split(',');
  if (items.length > maxItems) throw invalid(what, `${items.length} items; at most ${maxItems} pages or ranges.`);
  if (items.length === 1 && items[0] === '') throw invalid(what, 'no pages given. Write pages like "1-3,5".');
  const ranges: PageRange[] = [];
  for (const item of items) {
    const match = ITEM.exec(item);
    if (!match) throw invalid(what, `"${item}" is not a page or a range. Write pages like "1-3,5" or "8-" (page 8 to the end).`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : match[3] === undefined ? pageCount : Number(match[3]);
    if (from < 1) throw invalid(what, `"${item}": pages are numbered from 1.`);
    if (from > pageCount || to > pageCount) {
      throw invalid(what, `"${item}" names page ${Math.max(from, to)}, but the document has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    }
    if (to < from) throw invalid(what, `"${item}" runs backwards; write the lower page first.`);
    ranges.push({ from, to, label: from === to ? String(from) : `${from}-${to}` });
  }
  return ranges;
}

/** Undefined or "all" (any case, spaces around): every page. */
export function isAll(spec: string | undefined): boolean {
  return spec === undefined || (typeof spec === 'string' && spec.trim().toLowerCase() === 'all');
}

/**
 * The pages an operation applies to, as 0-based indexes in document order without repeats.
 * Undefined or "all" means every page.
 */
export function selectPages(spec: string | undefined, pageCount: number, what = 'pages'): number[] {
  if (spec === undefined || isAll(spec)) return Array.from({ length: pageCount }, (_, i) => i);
  const chosen = new Set<number>();
  for (const range of parsePageRanges(spec, pageCount, what)) {
    for (let page = range.from; page <= range.to; page++) chosen.add(page - 1);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Indexes (0-based) of one range, in order. */
export function rangeIndexes(range: PageRange): number[] {
  return Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from - 1 + i);
}
