/**
 * Page count of a PDF the browser returned, read from the file's structure, never by searching
 * its text: `startxref` names the cross-reference table, the table gives the byte offset of
 * every object, the trailer names the catalog (/Root), the catalog names the root of the page
 * tree (/Pages), and the tree is walked down to its leaves (/Type /Page). Every object is parsed
 * at the offset the table gives for it, so text inside the document (an image's alt text in a
 * tagged PDF, a /Title, a link) can never stand in for an object, and each /Pages node's /Count
 * must agree with the leaves under it.
 *
 * Chrome (Skia) writes a classic cross-reference table and a page tree with a fan-out of 8: a
 * 51-page document has seven /Type /Pages nodes under the root (tests/fixtures/pdf). Incremental
 * updates (/Prev) are followed. Anything else (a cross-reference stream, a broken table, an
 * object that is not where the table says, a /Count that disagrees with the tree) returns null.
 * The caller treats that as a failed render (500 render_failed, not charged), never as zero
 * pages.
 */

/** Upper bound for a believable count; Chrome is asked for at most PDF.maxPages + 1 pages. */
const MAX_BELIEVABLE_PAGES = 100_000;
/** Bounds on the structure we are willing to follow. */
const MAX_XREF_SECTIONS = 32;
const MAX_TREE_DEPTH = 32;
const MAX_NESTING = 64;
/** `startxref` sits in the last bytes of the file. */
const TAIL_BYTES = 2048;

type PdfValue =
  | { kind: 'dict'; entries: Map<string, PdfValue> }
  | { kind: 'array'; items: PdfValue[] }
  | { kind: 'ref'; id: number; gen: number }
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'other' };

class Unreadable extends Error {}

const fail = (): never => {
  throw new Unreadable();
};

/** Bytes as a binary string (one char per byte), in chunks to stay under argument limits. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return out;
}

const isWhite = (ch: string | undefined): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
const isDelimiter = (ch: string | undefined): boolean => ch !== undefined && '()<>[]{}/%'.includes(ch);

/** A reader of PDF values from a position in the file. */
class Reader {
  constructor(
    private readonly text: string,
    public pos: number,
  ) {}

  skipWhite(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (isWhite(ch)) this.pos++;
      else if (ch === '%') while (this.pos < this.text.length && this.text[this.pos] !== '\n' && this.text[this.pos] !== '\r') this.pos++;
      else return;
    }
  }

  /** A regular token (a number, a keyword) at the position, without moving past it. */
  peekToken(): string {
    this.skipWhite();
    let end = this.pos;
    while (end < this.text.length && !isWhite(this.text[end]) && !isDelimiter(this.text[end])) end++;
    return this.text.slice(this.pos, end);
  }

  keyword(word: string): void {
    if (this.peekToken() !== word) fail();
    this.pos += word.length;
  }

  integer(): number {
    const token = this.peekToken();
    if (!/^\d{1,10}$/.test(token)) fail();
    this.pos += token.length;
    return Number(token);
  }

  value(depth = 0): PdfValue {
    if (depth > MAX_NESTING) fail();
    this.skipWhite();
    const ch = this.text[this.pos];
    if (ch === undefined) fail();
    if (ch === '/') {
      let end = this.pos + 1;
      while (end < this.text.length && !isWhite(this.text[end]) && !isDelimiter(this.text[end])) end++;
      const value = this.text.slice(this.pos + 1, end);
      this.pos = end;
      return { kind: 'name', value };
    }
    if (ch === '<' && this.text[this.pos + 1] === '<') {
      this.pos += 2;
      const entries = new Map<string, PdfValue>();
      for (;;) {
        this.skipWhite();
        if (this.text.startsWith('>>', this.pos)) {
          this.pos += 2;
          return { kind: 'dict', entries };
        }
        const key = this.value(depth + 1);
        if (key.kind !== 'name') fail();
        const value = this.value(depth + 1);
        if (!entries.has((key as { value: string }).value)) entries.set((key as { value: string }).value, value);
      }
    }
    if (ch === '[') {
      this.pos++;
      const items: PdfValue[] = [];
      for (;;) {
        this.skipWhite();
        if (this.text[this.pos] === ']') {
          this.pos++;
          return { kind: 'array', items };
        }
        items.push(this.value(depth + 1));
      }
    }
    if (ch === '(') {
      // A literal string: balanced parentheses, backslash escapes.
      let level = 0;
      for (; this.pos < this.text.length; this.pos++) {
        const c = this.text[this.pos];
        if (c === '\\') this.pos++;
        else if (c === '(') level++;
        else if (c === ')' && --level === 0) {
          this.pos++;
          return { kind: 'other' };
        }
      }
      fail();
    }
    if (ch === '<') {
      const end = this.text.indexOf('>', this.pos);
      if (end < 0) fail();
      this.pos = end + 1;
      return { kind: 'other' };
    }
    const token = this.peekToken();
    if (token === '') fail();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      this.pos += token.length;
      if (/^\d+$/.test(token)) {
        // "id gen R" is a reference.
        const save = this.pos;
        const gen = this.peekToken();
        if (/^\d+$/.test(gen)) {
          this.pos += gen.length;
          if (this.peekToken() === 'R') {
            this.pos += 1;
            return { kind: 'ref', id: Number(token), gen: Number(gen) };
          }
        }
        this.pos = save;
      }
      return { kind: 'number', value: Number(token) };
    }
    if (token === 'true' || token === 'false' || token === 'null') {
      this.pos += token.length;
      return { kind: 'other' };
    }
    return fail();
  }
}

function dictOf(value: PdfValue): Map<string, PdfValue> {
  if (value.kind !== 'dict') fail();
  return (value as { entries: Map<string, PdfValue> }).entries;
}

/** The offsets of the objects in use, following /Prev; the newest section wins. And the newest trailer. */
function readXref(text: string): { offsets: Map<string, number>; trailer: Map<string, PdfValue> } {
  const tail = text.slice(Math.max(0, text.length - TAIL_BYTES));
  const at = tail.lastIndexOf('startxref');
  if (at < 0) fail();
  const start = new Reader(tail, at + 'startxref'.length).integer();
  const offsets = new Map<string, number>();
  /** Object numbers a newer section already defined (in use or freed): older entries do not count. */
  const defined = new Set<number>();
  let newest: Map<string, PdfValue> | null = null;
  const seen = new Set<number>();
  let next: number | null = start;
  while (next !== null) {
    if (seen.has(next) || seen.size >= MAX_XREF_SECTIONS || next >= text.length) fail();
    seen.add(next);
    const reader = new Reader(text, next);
    // A cross-reference stream ("12 0 obj << /Type /XRef ...") is not what Chrome writes.
    reader.keyword('xref');
    for (;;) {
      if (reader.peekToken() === 'trailer') break;
      const first = reader.integer();
      const count = reader.integer();
      reader.skipWhite();
      const entry = /(\d{10}) (\d{5}) ([nf])(?:\r\n| \r| \n|\r|\n)/y;
      for (let i = 0; i < count; i++) {
        entry.lastIndex = reader.pos;
        const match = entry.exec(text);
        if (!match) fail();
        reader.pos = entry.lastIndex;
        const id = first + i;
        if (defined.has(id)) continue;
        defined.add(id);
        if (match![3] === 'n') offsets.set(`${id} ${Number(match![2])}`, Number(match![1]));
      }
    }
    reader.keyword('trailer');
    const trailer = dictOf(reader.value());
    newest ??= trailer;
    const prev = trailer.get('Prev');
    next = prev === undefined ? null : prev.kind === 'number' && Number.isInteger(prev.value) ? prev.value : fail();
  }
  return { offsets, trailer: newest! };
}

/** The value of indirect object `ref`, read at the offset the cross-reference table gives for it. */
function objectAt(text: string, offsets: Map<string, number>, ref: PdfValue): PdfValue {
  if (ref.kind !== 'ref') fail();
  const { id, gen } = ref as { id: number; gen: number };
  const offset = offsets.get(`${id} ${gen}`);
  if (offset === undefined || offset >= text.length) fail();
  const reader = new Reader(text, offset!);
  if (reader.integer() !== id || reader.integer() !== gen) fail();
  reader.keyword('obj');
  return reader.value();
}

function nameOf(entries: Map<string, PdfValue>, key: string): string | undefined {
  const value = entries.get(key);
  return value?.kind === 'name' ? value.value : undefined;
}

/** Leaves under a page tree node; every /Pages node's /Count must match them. */
function leavesUnder(text: string, offsets: Map<string, number>, ref: PdfValue, depth: number, visited: Set<string>): number {
  if (ref.kind !== 'ref' || depth > MAX_TREE_DEPTH) fail();
  const key = `${(ref as { id: number }).id} ${(ref as { gen: number }).gen}`;
  if (visited.has(key)) fail();
  visited.add(key);
  const node = dictOf(objectAt(text, offsets, ref));
  const type = nameOf(node, 'Type');
  if (type === 'Page') return 1;
  if (type !== 'Pages') fail();
  const kids = node.get('Kids');
  const count = node.get('Count');
  if (kids?.kind !== 'array' || count?.kind !== 'number' || !Number.isInteger(count.value)) fail();
  let leaves = 0;
  for (const kid of (kids as { items: PdfValue[] }).items) {
    leaves += leavesUnder(text, offsets, kid, depth + 1, visited);
    if (leaves > MAX_BELIEVABLE_PAGES) fail();
  }
  if (leaves !== (count as { value: number }).value) fail();
  return leaves;
}

/** Number of pages, or null when the bytes are not a PDF whose page count can be read. */
export function countPdfPages(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8) return null;
  const text = latin1(bytes);
  if (!text.startsWith('%PDF-')) return null;
  try {
    const { offsets, trailer } = readXref(text);
    const root = trailer.get('Root');
    const catalog = dictOf(objectAt(text, offsets, root ?? fail()));
    if (nameOf(catalog, 'Type') !== 'Catalog') fail();
    const pages = catalog.get('Pages') ?? fail();
    const count = leavesUnder(text, offsets, pages, 0, new Set());
    return count >= 1 && count <= MAX_BELIEVABLE_PAGES ? count : null;
  } catch (error) {
    if (error instanceof Unreadable || error instanceof RangeError) return null;
    throw error;
  }
}
