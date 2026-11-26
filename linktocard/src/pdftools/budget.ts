/**
 * How much memory parsing a PDF with pdf-lib will take, estimated from the raw bytes before
 * pdf-lib sees them. A Worker isolate has 128 MB; the 20 MB input cap alone does not keep a
 * parse inside it, because pdf-lib turns every number, name, string, array and dictionary of
 * the file's structure into its own JavaScript object:
 *
 *   measured (Node, same V8): a 4.8 MB file holding one array of 2.5 million small numbers took
 *   113 MB of heap once parsed; a 19.6 MB file of 111,000 small objects took 170 MB.
 *
 * Two shapes are dangerous, and both are measured here:
 *  - structure tokens outside streams (page dictionaries, annotations, arrays): pdf-lib allocates
 *    roughly one object per token, so the scanner counts tokens the way its lexer splits them;
 *  - object streams (/Type /ObjStm) and cross-reference streams (/Type /XRef), which pdf-lib
 *    inflates and parses while loading: 97 KB of deflate can expand to 100 MB. They are inflated
 *    here by a measuring inflater (src/pdftools/inflate.ts) with a byte cap
 *    (PDF_TOOLKIT.maxInputBytes in total), and the tokens inside count too. A cross-reference
 *    stream counts three tokens per entry it declares, and one that declares more entries than
 *    its data holds is refused (xrefEntries).
 *
 * Every other stream (page content, fonts, images) stays compressed: the toolkit's operations
 * copy or wrap them without decoding, so they cost their size and nothing more.
 *
 * The scan is a single pass over the bytes (about as fast as reading them). It errs on the
 * side of counting more: text that only looks like structure still counts.
 */
import { PDF_TOOLKIT } from '../config';
import { ApiError } from '../lib/errors';
import { InflateLimitExceeded, inflatedSize } from './inflate';

/**
 * Structure tokens a parse may hold. Both measured shapes above cost about 48 bytes of heap per
 * token as counted here (3.5 million tokens for the 170 MB file), so this is about 50 MB, which
 * leaves the isolate room for the input, the output and the operation itself. Ordinary
 * documents are far below it: the 51-page Chrome PDF of tests/fixtures/pdf has 3,915 tokens,
 * about 77 a page.
 * NOTE for integration: this is a limit and belongs in src/config.ts (proposed name
 * PDF_TOOLKIT.maxStructureTokens); it is defined here only because this build step may not edit
 * that file.
 */
export const MAX_STRUCTURE_TOKENS = PDF_TOOLKIT.maxStructureTokens;

export interface StructureEstimate {
  /** Tokens outside streams plus tokens inside object streams (and cross-reference entries). */
  tokens: number;
  /** Bytes the object and cross-reference streams inflate to. */
  inflatedBytes: number;
  objectStreams: number;
}

const WHITE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITE[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const STREAM = ascii('stream');
const ENDSTREAM = ascii('endstream');
const OBJ = ascii('obj');

function matchesAt(b: Uint8Array, i: number, word: Uint8Array): boolean {
  if (i + word.length > b.length) return false;
  for (let k = 0; k < word.length; k++) if (b[i + k] !== word[k]) return false;
  return true;
}

function indexOf(b: Uint8Array, word: Uint8Array, from: number): number {
  const first = word[0]!;
  for (let i = b.indexOf(first, from); i !== -1 && i + word.length <= b.length; i = b.indexOf(first, i + 1)) {
    if (matchesAt(b, i, word)) return i;
  }
  return -1;
}

interface Lexer {
  tokens: number;
  /** Inside a token or string that continues into the next chunk (object streams arrive in chunks). */
  inWord: boolean;
}

/** Counts tokens of streamless PDF syntax (the inside of an object stream), chunk by chunk. */
function countTokens(chunk: Uint8Array, state: Lexer): void {
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]!;
    if (WHITE[c] || DELIM[c]) {
      if (state.inWord) state.inWord = false;
      // "[" "<" "(" "/" start an object of their own; closers do not allocate.
      if (c === 0x5b || c === 0x3c || c === 0x28 || c === 0x2f) state.tokens++;
    } else if (!state.inWord) {
      state.inWord = true;
      state.tokens++;
    }
  }
}

/** A dictionary value that is a whole number written in place ("/Size 12"), or undefined. */
function literalInteger(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)(?![\\d.])(\\s+\\d+\\s+R\\b)?`).exec(dict);
  if (!match) return undefined;
  return match[2] === undefined ? Number(match[1]) : Number.NaN;
}

/** A dictionary value that is an array of whole numbers written in place ("/W [1 2 1]"), or undefined; NaN entries when it is not. */
function literalIntegers(dict: string, key: string): number[] | undefined {
  const at = new RegExp(`/${key}(?![A-Za-z0-9])\\s*`).exec(dict);
  if (!at) return undefined;
  const rest = dict.slice(at.index + at[0].length);
  if (rest[0] !== '[') return [Number.NaN]; // an indirect array ("/Index 7 0 R"), which pdf-lib would look up
  const end = rest.indexOf(']');
  if (end === -1) return [Number.NaN];
  const items = rest.slice(1, end).trim();
  if (items === '') return [];
  return items.split(/\s+/).map((item) => (/^\d+$/.test(item) ? Number(item) : Number.NaN));
}

/**
 * The entries pdf-lib reads from a cross-reference stream: PDFXRefStreamParser loops over the
 * /Index lengths (or /Size) without looking at the data, and makes an entry object and a PDFRef
 * for each, so an empty stream claiming /Index [10 1000000] made a million of them from 455 bytes
 * (security review SEC-1). Refused unless the entries fit the data: each takes W1+W2+W3 bytes.
 * Every number involved must be written in place: an indirect one is looked up by pdf-lib and
 * could say anything. Returns the entry count.
 */
function xrefEntries(dict: string, dataBytes: number, label: string): number {
  const refuse = (): ApiError =>
    new ApiError('invalid_request', `${label} could not be read as a PDF: a cross-reference stream claims more entries than it holds.`, {
      details: { reason: 'damaged' },
    });
  const widths = literalIntegers(dict, 'W');
  if (widths === undefined) return 0; // pdf-lib refuses a cross-reference stream without /W before reading entries
  const index = literalIntegers(dict, 'Index');
  const size = literalInteger(dict, 'Size');
  if (widths.some(Number.isNaN) || index?.some(Number.isNaN) || (index === undefined && size !== undefined && Number.isNaN(size))) throw refuse();
  let entries = 0;
  if (index !== undefined) {
    if (index.length % 2 !== 0) throw refuse();
    for (let k = 1; k < index.length; k += 2) entries += index[k]!;
  } else {
    entries = size ?? 0;
  }
  const width = widths.slice(0, 3).reduce((sum, w) => sum + w, 0);
  if (entries > 0 && (width === 0 || entries * width > dataBytes)) throw refuse();
  return entries;
}

/** Heap objects per cross-reference entry: the entry, its PDFRef and the ref's tag string. */
const TOKENS_PER_XREF_ENTRY = 3;

/** Skips a literal string "( ... )" with nesting and escapes; returns the index after it. */
function skipLiteral(b: Uint8Array, i: number): number {
  let depth = 0;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x5c) i++; // backslash escapes the next byte
    else if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return b.length;
}

/**
 * The structure estimate of a whole file. Throws ApiError payload_too_large as soon as the
 * file is over `maxTokens` or its object streams inflate past `maxInflatedBytes`.
 */
export async function estimateStructure(
  b: Uint8Array,
  label: string,
  maxTokens: number = MAX_STRUCTURE_TOKENS,
  maxInflatedBytes: number = PDF_TOOLKIT.maxInputBytes,
): Promise<StructureEstimate> {
  const estimate: StructureEstimate = { tokens: 0, inflatedBytes: 0, objectStreams: 0 };
  const tooComplex = (): ApiError =>
    new ApiError(
      'payload_too_large',
      `${label} is too complex for the PDF toolkit: its structure would need more memory than one request may use. ` +
        'Split it into smaller files, or save it again with a PDF tool, which often simplifies it.',
      { details: { reason: 'too_complex', max_structure_tokens: maxTokens } },
    );
  let lastObj = 0;
  // The end of the previous stream's data. A stream's dictionary always follows it, so the text
  // searched for /Length and /Type starts at the later of the two: the windows never overlap, and
  // the scan stays linear (from the last "obj" alone, N empty streams after one "obj" took O(N^2):
  // 664 KB took 15 s, security review SEC-3).
  let lastStreamEnd = 0;
  let i = 0;
  const n = b.length;
  while (i < n) {
    const c = b[i]!;
    if (WHITE[c]) {
      i++;
    } else if (c === 0x25) {
      // % comment to the end of the line
      while (i < n && b[i] !== 0x0a && b[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      estimate.tokens++;
      i = skipLiteral(b, i);
    } else if (c === 0x3c) {
      estimate.tokens++;
      if (b[i + 1] === 0x3c) i += 2;
      else {
        const end = b.indexOf(0x3e, i + 1);
        i = end === -1 ? n : end + 1;
      }
    } else if (c === 0x3e || c === 0x5d || c === 0x29 || c === 0x7d) {
      i++;
    } else if (c === 0x5b || c === 0x7b) {
      estimate.tokens++;
      i++;
    } else if (c === 0x2f) {
      estimate.tokens++;
      i++;
      while (i < n && !WHITE[b[i]!] && !DELIM[b[i]!]) i++;
    } else {
      const start = i;
      while (i < n && !WHITE[b[i]!] && !DELIM[b[i]!]) i++;
      const length = i - start;
      if (length === OBJ.length && matchesAt(b, start, OBJ)) {
        lastObj = i;
        estimate.tokens++;
      } else if (length === STREAM.length && matchesAt(b, start, STREAM)) {
        let dataStart = i;
        if (b[dataStart] === 0x0d) dataStart++;
        if (b[dataStart] === 0x0a) dataStart++;
        const dict = new TextDecoder('latin1').decode(b.subarray(Math.max(lastObj, lastStreamEnd), start));
        // Like pdf-lib: a direct /Length that lands on "endstream" ends the data; otherwise search for it.
        const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
        let end = -1;
        if (declared) {
          let k = dataStart + Number(declared[1]);
          while (k < n && WHITE[b[k]!]) k++;
          if (matchesAt(b, k, ENDSTREAM)) end = k;
        }
        if (end === -1) end = indexOf(b, ENDSTREAM, dataStart);
        const dataEnd = end === -1 ? n : end;
        const type = /\/Type\s*\/(ObjStm|XRef)\b/.exec(dict)?.[1];
        if (type) {
          const filter = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dict)?.[1];
          const data = b.subarray(dataStart, dataEnd);
          if (filter === undefined) {
            const state: Lexer = { tokens: 0, inWord: false };
            if (type === 'ObjStm') countTokens(data, state);
            estimate.inflatedBytes += data.length;
            estimate.tokens += type === 'ObjStm' ? state.tokens : TOKENS_PER_XREF_ENTRY * xrefEntries(dict, data.length, label);
          } else if (filter.replace(/[[\]\s]/g, '') === '/FlateDecode') {
            const state: Lexer = { tokens: 0, inWord: false };
            const room = maxInflatedBytes - estimate.inflatedBytes;
            let size: number;
            try {
              size = inflatedSize(data, room, type === 'ObjStm' ? (chunk) => countTokens(chunk, state) : undefined);
            } catch (error) {
              if (error instanceof InflateLimitExceeded) throw tooComplex();
              throw error;
            }
            estimate.inflatedBytes += size;
            estimate.tokens += type === 'ObjStm' ? state.tokens : TOKENS_PER_XREF_ENTRY * xrefEntries(dict, size, label);
          } else {
            throw new ApiError(
              'invalid_request',
              `${label} stores its structure with ${filter.trim()}, which the PDF toolkit does not unpack. Save it again with a PDF tool, then send it.`,
              { details: { reason: 'unsupported_filter' } },
            );
          }
          if (type === 'ObjStm') estimate.objectStreams++;
        }
        estimate.tokens++;
        i = end === -1 ? n : end + ENDSTREAM.length;
        lastStreamEnd = i;
      } else if (length > 0) {
        estimate.tokens++;
      } else {
        i++;
      }
    }
    if (estimate.tokens > maxTokens) throw tooComplex();
  }
  return estimate;
}
