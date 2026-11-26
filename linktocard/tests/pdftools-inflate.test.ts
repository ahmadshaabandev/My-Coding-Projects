// The measuring inflater of the structure budget (src/pdftools/inflate.ts): it must see every
// byte a FlateDecode stream expands to, in bounded pieces, also when bytes follow the end of the
// compressed data (workerd's DecompressionStream then delivers nothing; pdf-lib inflates anyway).
import { describe, expect, it } from 'vitest';
import { estimateStructure } from '../src/pdftools/budget';
import { InflateLimitExceeded, inflatedSize } from '../src/pdftools/inflate';

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function collect(data: Uint8Array, cap = Number.MAX_SAFE_INTEGER): { size: number; bytes: Uint8Array; largest: number } {
  const chunks: Uint8Array[] = [];
  let largest = 0;
  const size = inflatedSize(data, cap, (chunk) => {
    chunks.push(chunk.slice());
    largest = Math.max(largest, chunk.length);
  });
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { size, bytes, largest };
}

/** Deterministic pseudo-random bytes (incompressible: deflate writes stored blocks for them). */
function noise(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('inflatedSize', () => {
  it('reproduces what CompressionStream compressed: text, repeats, noise, tiny and empty inputs', async () => {
    const samples = [
      text('1 0 obj << /Type /Page >> endobj '.repeat(5000)),
      new Uint8Array(300_000),
      noise(200_000),
      text('a'),
      new Uint8Array(0),
      new Uint8Array([...noise(70_000, 3), ...new Uint8Array(70_000), ...text('x y z '.repeat(9000))]),
    ];
    for (const sample of samples) {
      const result = collect(await deflate(sample));
      expect(result.size).toBe(sample.length);
      expect(result.bytes).toEqual(sample);
      expect(result.largest).toBeLessThanOrEqual(4 * 32_768);
    }
  });

  it('ignores bytes after the compressed data, as pdf-lib does', async () => {
    const sample = text('0 '.repeat(50_000));
    const data = await deflate(sample);
    const junk = new Uint8Array([...data, 0x0a, 0x78, 0x79, 0x7a]);
    expect(collect(junk).size).toBe(sample.length);
  });

  it('counts what a truncated or damaged stream gave before the damage', async () => {
    const sample = noise(100_000);
    const data = await deflate(sample);
    const size = inflatedSize(data.subarray(0, data.length / 2), Number.MAX_SAFE_INTEGER);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(sample.length);
    expect(inflatedSize(new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff]), 1000)).toBe(0);
  });

  it('stops at the cap, wherever it falls', async () => {
    const data = await deflate(new Uint8Array(5_000_000));
    expect(() => inflatedSize(data, 1_000_000)).toThrow(InflateLimitExceeded);
    expect(inflatedSize(data, 5_000_000)).toBe(5_000_000);
  });
});

describe('the structure budget with a deflate bomb followed by junk', () => {
  it('still sees the bomb (the DecompressionStream version would have counted 0 bytes)', async () => {
    const zeros = await deflate(text(`4 0 ${'0 '.repeat(1_000_000)}`));
    const body = new Uint8Array([...zeros, 0x00, 0x01, 0x02]);
    const enc = (s: string): Uint8Array => text(s);
    const head = enc('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
    const object = new Uint8Array([...enc(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${body.length} >>\nstream\n`), ...body, ...enc('\nendstream\nendobj\n')]);
    const file = new Uint8Array([...head, ...object, ...enc('%%EOF\n')]);
    await expect(estimateStructure(file, 'files[0]', 10_000_000, 500_000)).rejects.toMatchObject({ code: 'payload_too_large' });
    await expect(estimateStructure(file, 'files[0]', 500_000, 50_000_000)).rejects.toMatchObject({ code: 'payload_too_large' });
  });
});
