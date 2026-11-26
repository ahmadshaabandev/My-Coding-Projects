// Child process of tests/node/pdftools-pool-heap.test.ts (run with --expose-gc and tsx): loads
// PDFs of many distinct indirect references or names through the toolkit's loadPdf, drops each
// document, collects garbage and prints the heap after each round as JSON. pdf-lib 2.11.1 interns
// every PDFRef and PDFName in a module-level pool that it never empties (security review SEC-1);
// src/pdftools/pools.ts makes those pools collectable.
import { loadPdf } from '../../../src/pdftools/document.ts';

const kind = process.argv[2] === 'names' ? 'names' : 'refs';
const count = Number(process.argv[3] ?? 250_000);
const rounds = Number(process.argv[4] ?? 4);

function pdfWithArray(first: number): Uint8Array {
  const items: string[] = [];
  for (let i = 0; i < count; i++) items.push(kind === 'refs' ? `${first + i} 0 R` : `/n${first + i}`);
  const objs = [
    '',
    '<< /Type /Catalog /Pages 2 0 R /Junk 4 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `[${items.join(' ')}]`,
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');
async function settle(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc!();
  }
  return process.memoryUsage().heapUsed;
}

const heaps: number[] = [await settle()];
for (let round = 0; round < rounds; round++) {
  let bytes: Uint8Array | null = pdfWithArray(10 + round * count);
  let doc: unknown = await loadPdf(bytes, 'files[0]');
  bytes = null;
  doc = null;
  void doc;
  void bytes;
  heaps.push(await settle());
}
console.log(JSON.stringify({ kind, count, heaps }));
