/**
 * A measuring inflater (RFC 1950 zlib wrapper, RFC 1951 deflate) for src/pdftools/budget.ts:
 * it decodes a FlateDecode stream only to learn how large it is and to hand its bytes to a
 * counter in small chunks, holding no more than the 32 KB window deflate needs.
 *
 * Why not the platform's or pdf-lib's decoder:
 *  - workerd's DecompressionStream rejects any byte after the end of the compressed data and
 *    then delivers nothing at all (measured), while pdf-lib's own decoder ignores such bytes and
 *    inflates everything: one junk byte would hide a deflate bomb from the check;
 *  - pdf-lib's decoder (a port of pdf.js's FlateStream) inflates one whole deflate block per
 *    step, and a crafted block can expand without bound before it returns.
 * This one stops at the byte cap wherever it is, and like pdf-lib it ignores the Adler-32
 * trailer and anything after the last block. A stream that turns out damaged ends the count
 * where the damage starts, which is as far as pdf-lib's decoder could have gone too.
 */

const WINDOW = 32_768;

export class InflateLimitExceeded extends Error {}
class EndOfData extends Error {}
class BadData extends Error {}

// Length codes 257-285 and distance codes 0-29: base values and extra bits (RFC 1951, 3.2.5).
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1]! + counts[len - 1]!;
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offsets[lengths[i]!]!++] = i;
  return { counts, symbols };
}

const FIXED_LIT = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DIST = huffman(new Array<number>(30).fill(5));

class Bits {
  private pos: number;
  private buffer = 0;
  private count = 0;
  constructor(
    private readonly data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }
  bits(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.data.length) throw new EndOfData();
      this.buffer |= this.data[this.pos++]! << this.count;
      this.count += 8;
    }
    const value = this.buffer & ((1 << n) - 1);
    this.buffer >>>= n;
    this.count -= n;
    return value;
  }
  alignToByte(): void {
    this.buffer = 0;
    this.count = 0;
  }
  byteAt(): number {
    if (this.pos >= this.data.length) throw new EndOfData();
    return this.data[this.pos++]!;
  }
  decode(code: Huffman): number {
    let first = 0;
    let index = 0;
    let value = 0;
    for (let len = 1; len < 16; len++) {
      value |= this.bits(1);
      const count = code.counts[len]!;
      if (value - first < count) return code.symbols[index + value - first]!;
      index += count;
      first = (first + count) << 1;
      value <<= 1;
    }
    throw new BadData();
  }
}

class Output {
  private readonly buf = new Uint8Array(WINDOW * 4);
  private pos = 0;
  private flushed = 0;
  total = 0;
  constructor(
    private readonly cap: number,
    private readonly onChunk?: (chunk: Uint8Array) => void,
  ) {}
  private room(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    this.flush();
    const keep = Math.min(this.pos, WINDOW);
    this.buf.copyWithin(0, this.pos - keep, this.pos);
    this.pos = keep;
    this.flushed = keep;
  }
  private grow(n: number): void {
    this.total += n;
    if (this.total > this.cap) throw new InflateLimitExceeded();
  }
  flush(): void {
    if (this.pos > this.flushed) this.onChunk?.(this.buf.subarray(this.flushed, this.pos));
    this.flushed = this.pos;
  }
  byte(value: number): void {
    this.grow(1);
    this.room(1);
    this.buf[this.pos++] = value;
  }
  copy(distance: number, length: number): void {
    if (distance > this.pos) throw new BadData();
    this.grow(length);
    this.room(length);
    for (let i = 0; i < length; i++, this.pos++) this.buf[this.pos] = this.buf[this.pos - distance]!;
  }
}

function dynamicCodes(bits: Bits): [Huffman, Huffman] {
  const hlit = bits.bits(5) + 257;
  const hdist = bits.bits(5) + 1;
  const hclen = bits.bits(4) + 4;
  const codeLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = bits.bits(3);
  const lengthCode = huffman(codeLengths);
  const lengths = new Uint8Array(hlit + hdist);
  for (let i = 0; i < hlit + hdist; ) {
    const symbol = bits.decode(lengthCode);
    if (symbol < 16) {
      lengths[i++] = symbol;
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      if (i === 0) throw new BadData();
      value = lengths[i - 1]!;
      repeat = 3 + bits.bits(2);
    } else if (symbol === 17) repeat = 3 + bits.bits(3);
    else repeat = 11 + bits.bits(7);
    if (i + repeat > lengths.length) throw new BadData();
    lengths.fill(value, i, i + repeat);
    i += repeat;
  }
  return [huffman(lengths.subarray(0, hlit)), huffman(lengths.subarray(hlit))];
}

/**
 * Inflates `data` (a zlib stream, as FlateDecode stores it) and returns how many bytes it
 * expands to. `onChunk` receives the output in pieces of at most 128 KB (each valid only during
 * the call). Throws InflateLimitExceeded as soon as the output passes `cap`.
 */
export function inflatedSize(data: Uint8Array, cap: number, onChunk?: (chunk: Uint8Array) => void): number {
  const out = new Output(cap, onChunk);
  // Two header bytes (method and flags), skipped as pdf-lib's decoder skips them; a preset
  // dictionary (FDICT) cannot appear in a PDF stream.
  const bits = new Bits(data, 2);
  try {
    let final = 0;
    while (!final) {
      final = bits.bits(1);
      const type = bits.bits(2);
      if (type === 0) {
        bits.alignToByte();
        const length = bits.byteAt() | (bits.byteAt() << 8);
        bits.byteAt();
        bits.byteAt(); // one's complement of the length, not checked (pdf-lib does not either)
        for (let i = 0; i < length; i++) out.byte(bits.byteAt());
      } else if (type === 1 || type === 2) {
        const [lit, dist] = type === 1 ? [FIXED_LIT, FIXED_DIST] : dynamicCodes(bits);
        for (;;) {
          const symbol = bits.decode(lit);
          if (symbol < 256) out.byte(symbol);
          else if (symbol === 256) break;
          else {
            const code = symbol - 257;
            if (code >= LENGTH_BASE.length) throw new BadData();
            const length = LENGTH_BASE[code]! + bits.bits(LENGTH_EXTRA[code]!);
            const distCode = bits.decode(dist);
            if (distCode >= DIST_BASE.length) throw new BadData();
            out.copy(DIST_BASE[distCode]! + bits.bits(DIST_EXTRA[distCode]!), length);
          }
        }
      } else {
        throw new BadData();
      }
    }
  } catch (error) {
    if (!(error instanceof EndOfData || error instanceof BadData)) throw error;
  }
  out.flush();
  return out.total;
}
