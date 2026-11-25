/**
 * Page count of a PDF the browser returned, read from the document's own page tree: the
 * trailer (or cross-reference stream) names the catalog (/Root), the catalog names the root
 * /Pages node, and that node's /Count is the number of pages.
 *
 * Chrome (Skia) writes the page tree as plain objects with a fan-out of 8: a 51-page document
 * has seven /Type /Pages nodes and the root's /Count is 51 (tests/fixtures/pdf). /Count also
 * appears in the outline (/Type /Outlines), so "the largest /Count anywhere" would be wrong;
 * when the catalog cannot be followed, the largest /Count of a /Type /Pages node is used, which
 * is the root's by construction.
 *
 * Anything that cannot be read returns null. The caller treats that as a failed render
 * (500 render_failed, not charged), never as zero pages.
 */

/** Upper bound for a believable count; Chrome is asked for at most PDF.maxPages + 1 pages. */
const MAX_BELIEVABLE_PAGES = 100_000;

/** Bytes as a binary string (one char per byte), in chunks to stay under argument limits. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return out;
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  let found: RegExpMatchArray | undefined;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

/** The body of the newest definition of object `id gen` (incremental updates append later ones). */
function objectBody(text: string, id: string, gen: string): string | undefined {
  const match = lastMatch(text, new RegExp(`(?:^|[^0-9])${id}\\s+${gen}\\s+obj\\b`, 'g'));
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length;
  const end = text.indexOf('endobj', start);
  return end < 0 ? undefined : text.slice(start, end);
}

function isPagesNode(body: string): boolean {
  return /\/Type\s*\/Pages(?![A-Za-z0-9])/.test(body);
}

function countOf(body: string): number | undefined {
  const match = /\/Count\s+(\d{1,9})(?![0-9.])/.exec(body);
  return match ? Number(match[1]) : undefined;
}

function believable(count: number | undefined): number | null {
  return count !== undefined && Number.isInteger(count) && count >= 1 && count <= MAX_BELIEVABLE_PAGES ? count : null;
}

/** Root -> catalog -> /Pages -> /Count. */
function countFromCatalog(text: string): number | undefined {
  const root = lastMatch(text, /\/Root\s+(\d+)\s+(\d+)\s+R/g);
  if (!root) return undefined;
  const catalog = objectBody(text, root[1]!, root[2]!);
  const pagesRef = catalog && /\/Pages\s+(\d+)\s+(\d+)\s+R/.exec(catalog);
  if (!pagesRef) return undefined;
  const pages = objectBody(text, pagesRef[1]!, pagesRef[2]!);
  return pages && isPagesNode(pages) ? countOf(pages) : undefined;
}

/** The largest /Count among /Type /Pages objects (the root of a page tree counts every page). */
function countFromPageNodes(text: string): number | undefined {
  let largest: number | undefined;
  for (const match of text.matchAll(/\bobj\b([\s\S]*?)\bendobj\b/g)) {
    const body = match[1]!;
    if (!isPagesNode(body)) continue;
    const count = countOf(body);
    if (count !== undefined && (largest === undefined || count > largest)) largest = count;
  }
  return largest;
}

/** Number of pages, or null when the bytes are not a PDF whose page count can be read. */
export function countPdfPages(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8) return null;
  const text = latin1(bytes);
  if (!text.startsWith('%PDF-')) return null;
  return believable(countFromCatalog(text)) ?? believable(countFromPageNodes(text));
}
