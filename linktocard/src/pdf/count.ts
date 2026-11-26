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
 *
 * The file is never turned into one string: a PDF can be tens of MB of image data the count
 * does not need. Only the parts the parse reads are decoded (one character per byte): the last
 * TAIL_BYTES for `startxref`, each cross-reference section from its offset, and each object
 * from its offset. Such a window starts small and is doubled only while the parse runs into its
 * end, so the result is the same as parsing the whole file, up to MAX_XREF_WINDOW for a section
 * and MAX_OBJECT_WINDOW for an object; a structure longer than that is not believed (null).
 * Memory is O(table + objects read), time O(table + objects read), whatever the file's size.
 */

/** Upper bound for a believable count; Chrome is asked for at most PDF.maxPages + 1 pages. */
const MAX_BELIEVABLE_PAGES = 100_000;
/** Bounds on the structure we are willing to follow. */
const MAX_XREF_SECTIONS = 32;
const MAX_TREE_DEPTH = 32;
const MAX_NESTING = 64;
/** `startxref` sits in the last bytes of the file. */
const TAIL_BYTES = 2048;
/**
 * Decoded window for a cross-reference section (table + trailer): 20 bytes per object, so the
 * first window holds about 3,000 objects and the largest about 400,000.
 */
const XREF_WINDOW = 64 * 1024;
export const MAX_XREF_WINDOW = 8 * 1024 * 1024;
/**
 * Decoded window for one object: Chrome's catalog, /Pages nodes and /Page dictionaries are a few
 * hundred bytes; a page with many links carries one reference per link in /Annots. Measured on
 * 349 local Chromium PDFs: largest object 4,988 bytes, largest table 62 KB; 40,000 links on one
 * page (more HTML than PDF.maxHtmlBytes allows) make /Annots 388 KB and the table 800 KB.
 */
const OBJECT_WINDOW = 1024;
export const MAX_OBJECT_WINDOW = 4 * 1024 * 1024;
/** Characters decoded per String.fromCharCode call (argument-count limit). */
const DECODE_CHUNK = 0x8000;
/** Generation numbers have five digits: an entry is stored as offset * GEN_LIMIT + generation. */
const GEN_LIMIT = 100_000;

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

/** Bytes as a binary string (one char per byte). Only ever called on a bounded window of the file. */
function latin1(bytes: Uint8Array): string {
  if (bytes.length <= DECODE_CHUNK) return String.fromCharCode.apply(null, bytes as unknown as number[]);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += DECODE_CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + DECODE_CHUNK) as unknown as number[]));
  }
  return parts.join('');
}

const isWhite = (ch: string | undefined): boolean => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
const isDelimiter = (ch: string | undefined): boolean => ch !== undefined && '()<>[]{}/%'.includes(ch);

/** One cross-reference entry: `nnnnnnnnnn ggggg n` and its end of line (at most 20 characters). */
const XREF_ENTRY = /(\d{10}) (\d{5}) ([nf])(?:\r\n| \r| \n|\r|\n)/y;
const XREF_ENTRY_CHARS = 20;

/**
 * A reader of PDF values from a position in a decoded window of the file. Every character is
 * read through `at`, which notes when a read reached the end of the window (`hitEnd`): what
 * follows in the file could then change the result, and the caller decodes a larger window.
 */
class Reader {
  hitEnd = false;

  constructor(
    private readonly text: string,
    public pos: number,
  ) {}

  private at(index: number): string | undefined {
    if (index >= this.text.length) {
      this.hitEnd = true;
      return undefined;
    }
    return this.text[index];
  }

  skipWhite(): void {
    for (;;) {
      const ch = this.at(this.pos);
      if (isWhite(ch)) this.pos++;
      else if (ch === '%') for (let c: string | undefined = ch; c !== undefined && c !== '\n' && c !== '\r'; c = this.at(++this.pos));
      else return;
    }
  }

  /** A regular token (a number, a keyword) at the position, without moving past it. */
  peekToken(): string {
    this.skipWhite();
    let end = this.pos;
    for (let ch = this.at(end); ch !== undefined && !isWhite(ch) && !isDelimiter(ch); ch = this.at(++end));
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

  /** The cross-reference entry at the position (no white space skipped), or null. */
  xrefEntry(): RegExpExecArray | null {
    if (this.pos + XREF_ENTRY_CHARS > this.text.length) this.hitEnd = true;
    XREF_ENTRY.lastIndex = this.pos;
    const match = XREF_ENTRY.exec(this.text);
    if (match) this.pos = XREF_ENTRY.lastIndex;
    return match;
  }

  value(depth = 0): PdfValue {
    if (depth > MAX_NESTING) fail();
    this.skipWhite();
    const ch = this.at(this.pos);
    if (ch === undefined) fail();
    if (ch === '/') {
      let end = this.pos + 1;
      for (let c = this.at(end); c !== undefined && !isWhite(c) && !isDelimiter(c); c = this.at(++end));
      const value = this.text.slice(this.pos + 1, end);
      this.pos = end;
      return { kind: 'name', value };
    }
    if (ch === '<' && this.at(this.pos + 1) === '<') {
      this.pos += 2;
      const entries = new Map<string, PdfValue>();
      for (;;) {
        this.skipWhite();
        if (this.at(this.pos) === '>' && this.at(this.pos + 1) === '>') {
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
        if (this.at(this.pos) === ']') {
          this.pos++;
          return { kind: 'array', items };
        }
        items.push(this.value(depth + 1));
      }
    }
    if (ch === '(') {
      // A literal string: balanced parentheses, backslash escapes.
      let level = 0;
      for (let c = this.at(this.pos); c !== undefined; c = this.at(++this.pos)) {
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
      if (end < 0) {
        this.hitEnd = true;
        fail();
      }
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

/**
 * Runs `parse` on the file from byte `start`, decoded `size` bytes at a time: when the parse
 * read up to the end of the window and the file goes on, the window is doubled and the parse
 * run again, up to `max` bytes. The parse must not change anything outside its own result.
 */
function inWindow<T>(bytes: Uint8Array, start: number, size: number, max: number, parse: (reader: Reader) => T): T {
  for (;;) {
    const end = Math.min(bytes.length, start + size);
    const reader = new Reader(latin1(bytes.subarray(start, end)), 0);
    let result: { value: T } | null = null;
    let failure: Unreadable | null = null;
    try {
      result = { value: parse(reader) };
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      failure = error;
    }
    if (!reader.hitEnd || end >= bytes.length) {
      if (result) return result.value;
      throw failure;
    }
    if (size >= max) fail();
    size = Math.min(max, size * 2);
  }
}

function dictOf(value: PdfValue): Map<string, PdfValue> {
  if (value.kind !== 'dict') fail();
  return (value as { entries: Map<string, PdfValue> }).entries;
}

/** Object number -> offset * GEN_LIMIT + generation, for the objects in use. */
type Offsets = Map<number, number>;

/**
 * One cross-reference section at the start of the reader: its entries in order, as pairs of
 * object number and offset * GEN_LIMIT + generation (-1 for a free entry), and its trailer.
 */
interface Section {
  entries: number[];
  trailer: Map<string, PdfValue>;
}

function readSection(reader: Reader): Section {
  // A cross-reference stream ("12 0 obj << /Type /XRef ...") is not what Chrome writes.
  reader.keyword('xref');
  const entries: number[] = [];
  for (;;) {
    if (reader.peekToken() === 'trailer') break;
    const first = reader.integer();
    const count = reader.integer();
    reader.skipWhite();
    for (let i = 0; i < count; i++) {
      const match = reader.xrefEntry();
      if (!match) fail();
      entries.push(first + i, match![3] === 'n' ? Number(match![1]) * GEN_LIMIT + Number(match![2]) : -1);
    }
  }
  reader.keyword('trailer');
  return { entries, trailer: dictOf(reader.value()) };
}

/** The offsets of the objects in use, following /Prev; the newest section wins. And the newest trailer. */
function readXref(bytes: Uint8Array): { offsets: Offsets; trailer: Map<string, PdfValue> } {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)));
  const at = tail.lastIndexOf('startxref');
  if (at < 0) fail();
  const start = new Reader(tail, at + 'startxref'.length).integer();
  const offsets: Offsets = new Map();
  /** Object numbers a newer section already defined (in use or freed): older entries do not count. */
  const defined = new Set<number>();
  let newest: Map<string, PdfValue> | null = null;
  const seen = new Set<number>();
  let next: number | null = start;
  while (next !== null) {
    if (next < 0 || seen.has(next) || seen.size >= MAX_XREF_SECTIONS || next >= bytes.length) fail();
    seen.add(next);
    const { entries, trailer }: Section = inWindow(bytes, next, XREF_WINDOW, MAX_XREF_WINDOW, readSection);
    for (let i = 0; i < entries.length; i += 2) {
      const id = entries[i]!;
      const entry = entries[i + 1]!;
      if (defined.has(id)) continue;
      defined.add(id);
      if (entry >= 0) offsets.set(id, entry);
    }
    newest ??= trailer;
    const prev: PdfValue | undefined = trailer.get('Prev');
    next = prev === undefined ? null : prev.kind === 'number' && Number.isInteger(prev.value) ? prev.value : fail();
  }
  return { offsets, trailer: newest! };
}

/** The value of indirect object `ref`, read at the offset the cross-reference table gives for it. */
function objectAt(bytes: Uint8Array, offsets: Offsets, ref: PdfValue): PdfValue {
  if (ref.kind !== 'ref') fail();
  const { id, gen } = ref as { id: number; gen: number };
  const entry = offsets.get(id);
  if (entry === undefined || entry % GEN_LIMIT !== gen) fail();
  const offset = (entry! - gen) / GEN_LIMIT;
  if (offset >= bytes.length) fail();
  return inWindow(bytes, offset, OBJECT_WINDOW, MAX_OBJECT_WINDOW, (reader) => {
    if (reader.integer() !== id || reader.integer() !== gen) fail();
    reader.keyword('obj');
    return reader.value();
  });
}

function nameOf(entries: Map<string, PdfValue>, key: string): string | undefined {
  const value = entries.get(key);
  return value?.kind === 'name' ? value.value : undefined;
}

/** Leaves under a page tree node; every /Pages node's /Count must match them. */
function leavesUnder(bytes: Uint8Array, offsets: Offsets, ref: PdfValue, depth: number, visited: Set<string>): number {
  if (ref.kind !== 'ref' || depth > MAX_TREE_DEPTH) fail();
  const key = `${(ref as { id: number }).id} ${(ref as { gen: number }).gen}`;
  if (visited.has(key)) fail();
  visited.add(key);
  const node = dictOf(objectAt(bytes, offsets, ref));
  const type = nameOf(node, 'Type');
  if (type === 'Page') return 1;
  if (type !== 'Pages') fail();
  const kids = node.get('Kids');
  const count = node.get('Count');
  if (kids?.kind !== 'array' || count?.kind !== 'number' || !Number.isInteger(count.value)) fail();
  let leaves = 0;
  for (const kid of (kids as { items: PdfValue[] }).items) {
    leaves += leavesUnder(bytes, offsets, kid, depth + 1, visited);
    if (leaves > MAX_BELIEVABLE_PAGES) fail();
  }
  if (leaves !== (count as { value: number }).value) fail();
  return leaves;
}

/** Number of pages, or null when the bytes are not a PDF whose page count can be read. */
export function countPdfPages(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 8) return null;
  if (latin1(bytes.subarray(0, 5)) !== '%PDF-') return null;
  try {
    const { offsets, trailer } = readXref(bytes);
    const root = trailer.get('Root');
    const catalog = dictOf(objectAt(bytes, offsets, root ?? fail()));
    if (nameOf(catalog, 'Type') !== 'Catalog') fail();
    const pages = catalog.get('Pages') ?? fail();
    const count = leavesUnder(bytes, offsets, pages, 0, new Set());
    return count >= 1 && count <= MAX_BELIEVABLE_PAGES ? count : null;
  } catch (error) {
    if (error instanceof Unreadable || error instanceof RangeError) return null;
    throw error;
  }
}
