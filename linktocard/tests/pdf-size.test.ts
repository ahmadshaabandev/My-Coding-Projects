// Large PDFs (src/pdf/render.ts, src/pdf/count.ts). A small document can make a very large PDF
// (Chrome stores every image at its full size), so the browser's answer is read with a running
// byte count and refused past PDF.maxPdfBytes without buffering more than that, Content-Length
// or not; one deadline covers the call and reading its body; and the page counter decodes only
// the parts of the file it reads, so its cost does not grow with the file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF } from '../src/config';
import { countPdfPages } from '../src/pdf/count';
import { CALL_TIMEOUT_MS, MAX_ERROR_BODY_BYTES, printPdf, type PrintRequest } from '../src/pdf/render';
import { FIXTURES, mockBrowser } from './pdf-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;
const LIMIT_MB = PDF.maxPdfBytes / MB;

const REQUEST: PrintRequest = {
  html: '<!doctype html><html><head><meta charset="utf-8"><style></style></head><body><p>x</p></body></html>',
  setup: { format: 'a4', landscape: false, margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } },
  headerFooter: { displayHeaderFooter: false },
};

const binary = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
const encode = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Fills `target` with binary that looks like image data (a 64 KB block, repeated). */
function fillNoise(target: Uint8Array): void {
  const block = new Uint8Array(64 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (Math.imul(i + 1, 2654435761) >>> 24) & 0xff;
  for (let at = 0; at < target.length; at += block.length) target.set(block.subarray(0, Math.min(block.length, target.length - at)), at);
}

/**
 * A real Chrome PDF with one more object: a stream of `padBytes` of binary, like an image. At
 * 'start' it goes before every other object, so they all move `padBytes` further into the file
 * and every offset in the table is rewritten; at 'end' it goes after them, before the table.
 * The table, /Size and startxref stay exact (pdfinfo and pdftotext read the result).
 */
function paddedPdf(source: Uint8Array, padBytes: number, at: 'start' | 'end'): Uint8Array {
  const text = binary(source);
  const xrefAt = text.lastIndexOf('\nxref\n') + 1;
  const headerEnd = text.indexOf('\n', text.indexOf('\n') + 1) + 1;
  const insertAt = at === 'start' ? headerEnd : xrefAt;
  const size = Number(/\/Size (\d+)/.exec(text.slice(xrefAt))![1]);
  const head = encode(`${size} 0 obj\n<</Length ${padBytes}>>\nstream\n`);
  const tail = encode('\nendstream\nendobj\n');
  const added = head.byteLength + padBytes + tail.byteLength;
  const shift = (offset: number): number => (offset >= insertAt ? offset + added : offset);
  const table = encode(
    text
      .slice(xrefAt)
      .replace(/(\d{10}) (\d{5}) n/g, (_, offset: string, gen: string) => `${String(shift(Number(offset))).padStart(10, '0')} ${gen} n`)
      .replace(/^xref\n0 (\d+)\n/, (_, count: string) => `xref\n0 ${Number(count) + 1}\n`)
      .replace(/\ntrailer\n/, `\n${String(insertAt).padStart(10, '0')} 00000 n \ntrailer\n`)
      .replace(`/Size ${size}`, `/Size ${size + 1}`)
      .replace(/startxref\n(\d+)/, (_, offset: string) => `startxref\n${shift(Number(offset))}`),
  );
  const out = new Uint8Array(xrefAt + added + table.byteLength);
  let offset = 0;
  const put = (part: Uint8Array): void => {
    out.set(part, offset);
    offset += part.byteLength;
  };
  put(source.subarray(0, insertAt));
  put(head);
  fillNoise(out.subarray(offset, offset + padBytes));
  offset += padBytes;
  put(tail);
  put(source.subarray(insertAt, xrefAt));
  put(table);
  return out;
}

/** A valid 3-page Chrome PDF of exactly `length` bytes. */
function pdfOfLength(length: number): Uint8Array {
  const source = FIXTURES['3-pages'].bytes;
  let pad = length - source.byteLength - 64;
  for (let attempt = 0; attempt < 4; attempt++) {
    const pdf = paddedPdf(source, pad, 'end');
    if (pdf.byteLength === length) return pdf;
    pad += length - pdf.byteLength;
  }
  throw new Error(`could not build a PDF of ${length} bytes`);
}

interface TrackedBody {
  stream: ReadableStream<Uint8Array>;
  /** Bytes the reader has pulled out of the stream so far. */
  pulled(): number;
  cancelled(): boolean;
}

/**
 * A response body that hands out what `next` returns (null ends it, a promise that never settles
 * stalls it), one chunk per read and nothing ahead of the reader (highWaterMark 0).
 */
function trackedBody(next: (pulled: number) => Uint8Array | null | Promise<never>): TrackedBody {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = next(pulled);
        if (chunk instanceof Promise) return chunk;
        if (chunk === null) controller.close();
        else {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        }
        return undefined;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

/** `bytes` in chunks of `chunk` bytes. */
const chunksOf = (bytes: Uint8Array, chunk = MB) => (pulled: number) => (pulled >= bytes.byteLength ? null : bytes.subarray(pulled, pulled + chunk));
/** Zeros, a megabyte at a time, for ever. */
const endless = (): (() => Uint8Array) => {
  const chunk = new Uint8Array(MB);
  return () => chunk;
};

function pdfAnswer(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf', 'x-browser-ms-used': '0', ...headers } });
}

function expectTooLarge(outcome: Awaited<ReturnType<typeof printPdf>>): void {
  expect(outcome).toMatchObject({ status: 200, browserMs: 0, bytes: null, pages: null, cause: 'document' });
  expect(outcome.error).toMatchObject({ code: 'template_error', status: 422, details: { max_bytes: PDF.maxPdfBytes } });
  expect(outcome.error?.message).toContain(`larger than ${LIMIT_MB} MB`);
  expect(outcome.error?.message).toContain('use smaller or fewer images');
  expect(Number.isInteger(outcome.wallMs) && outcome.wallMs >= 0).toBe(true);
}

describe(`printPdf with a PDF over PDF.maxPdfBytes (${LIMIT_MB} MB)`, () => {
  it('refuses a Content-Length over the limit without reading the body, and cancels it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = trackedBody(endless());
    const outcome = await printPdf(mockBrowser(() => pdfAnswer(body.stream, { 'content-length': String(PDF.maxPdfBytes + 1) })).binding, REQUEST);
    expectTooLarge(outcome);
    expect(body.pulled()).toBe(0);
    expect(body.cancelled()).toBe(true);
  });

  it('without Content-Length, stops reading as soon as the running count goes over, and cancels the stream', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = trackedBody(endless());
    const outcome = await printPdf(mockBrowser(() => pdfAnswer(body.stream)).binding, REQUEST);
    expectTooLarge(outcome);
    // The chunk that would have crossed the limit is pulled and dropped; nothing after it.
    expect(body.pulled()).toBe(PDF.maxPdfBytes + MB);
    expect(body.cancelled()).toBe(true);
  });

  it('is not fooled by a Content-Length that understates the body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = trackedBody(endless());
    const outcome = await printPdf(mockBrowser(() => pdfAnswer(body.stream, { 'content-length': '1000' })).binding, REQUEST);
    expectTooLarge(outcome);
    expect(body.pulled()).toBeLessThanOrEqual(PDF.maxPdfBytes + MB);
    expect(body.cancelled()).toBe(true);
  });

  it.each([
    ['without Content-Length', false],
    ['with Content-Length', true],
  ])('takes a PDF of exactly the limit and refuses one byte more, %s', async (_, withLength) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const atLimit = pdfOfLength(PDF.maxPdfBytes);
    const answer = (bytes: Uint8Array) => pdfAnswer(trackedBody(chunksOf(bytes)).stream, withLength ? { 'content-length': String(bytes.byteLength) } : {});
    const ok = await printPdf(mockBrowser(() => answer(atLimit)).binding, REQUEST);
    expect(ok).toMatchObject({ status: 200, pages: 3, error: null, cause: null });
    expect(ok.bytes?.byteLength).toBe(PDF.maxPdfBytes);
    expect(ok.bytes!.every((byte, i) => byte === atLimit[i])).toBe(true);
    expectTooLarge(await printPdf(mockBrowser(() => answer(pdfOfLength(PDF.maxPdfBytes + 1))).binding, REQUEST));
  });

  it('reads a body that arrives in many small chunks, with and without Content-Length, byte for byte', async () => {
    const bytes = FIXTURES['51-pages-header-footer'].bytes;
    const variants: Array<Record<string, string>> = [{}, { 'content-length': String(bytes.byteLength) }];
    for (const headers of variants) {
      const outcome = await printPdf(mockBrowser(() => pdfAnswer(trackedBody(chunksOf(bytes, 1000)).stream, headers)).binding, REQUEST);
      expect(outcome).toMatchObject({ status: 200, pages: 51 });
      expect(outcome.bytes).toEqual(bytes);
    }
  });
});

describe('the call deadline', () => {
  const stalls = (): Promise<never> => new Promise<never>(() => undefined);

  it(`still ends a call whose answer never comes, after ${CALL_TIMEOUT_MS / 1000} s`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let settled = false;
    const pending = printPdf(mockBrowser(stalls).binding, REQUEST).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 0, bytes: null, error: { code: 'render_timeout' }, cause: 'document', wallMs: CALL_TIMEOUT_MS });
  });

  it('covers reading the body too: an answer after 60 s whose body stalls ends at the same deadline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = new Uint8Array(1000);
    const body = trackedBody((pulled) => (pulled === 0 ? first : stalls()));
    const browser = mockBrowser(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return pdfAnswer(body.stream);
    });
    let settled = false;
    const pending = printPdf(browser.binding, REQUEST).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(body.pulled()).toBe(1000);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 60_000 - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    // The browser answered 200: a body that does not arrive is the renderer's failure, not the document's.
    expect(outcome).toMatchObject({ status: 200, browserMs: 0, bytes: null, pages: null, error: { code: 'render_failed', status: 500 }, cause: 'provider' });
    expect(outcome.wallMs).toBe(CALL_TIMEOUT_MS);
    expect(body.cancelled()).toBe(true);
  });

  it('covers reading an error answer too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const body = trackedBody(stalls);
    const pending = printPdf(mockBrowser(() => new Response(body.stream, { status: 422, headers: { 'content-type': 'application/json' } })).binding, REQUEST);
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 422, error: { code: 'template_error' }, cause: 'document', wallMs: CALL_TIMEOUT_MS });
    expect(body.cancelled()).toBe(true);
  });
});

describe('reading the browser answer', () => {
  it(`reads no more than ${MAX_ERROR_BODY_BYTES / 1024} KB of an error answer`, async () => {
    const body = trackedBody(endless());
    const outcome = await printPdf(mockBrowser(() => new Response(body.stream, { status: 500, headers: { 'content-type': 'application/json' } })).binding, REQUEST);
    expect(outcome).toMatchObject({ status: 500, bytes: null, error: { code: 'render_failed', status: 500 }, cause: 'provider' });
    expect(outcome.error?.message).not.toContain('The browser said');
    expect(body.pulled()).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES + MB);
    expect(body.cancelled()).toBe(true);
  });

  it('turns a body that fails half way into render_failed (the renderer\'s fault), without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(FIXTURES['3-pages'].bytes.subarray(0, 4000));
        controller.error(new Error('connection reset'));
      },
    });
    const outcome = await printPdf(mockBrowser(() => pdfAnswer(stream)).binding, REQUEST);
    expect(outcome).toMatchObject({ status: 200, bytes: null, pages: null, error: { code: 'render_failed', status: 500 }, cause: 'provider' });
    expect(error).toHaveBeenCalledWith('Reading the PDF from Browser Run failed:', expect.any(Error));
  });
});

describe('countPdfPages on a 50 MB PDF', () => {
  const source = FIXTURES['51-pages-header-footer'].bytes;

  it.each(['start', 'end'] as const)('with 50 MB of image data at the %s: counted in milliseconds, decoding only what it reads', (at) => {
    const pdf = paddedPdf(source, 50 * MB, at);
    expect(pdf.byteLength).toBeGreaterThan(50 * MB);
    // Implementation: the whole file is never decoded into a string. The counter's only decoder
    // is String.fromCharCode on windows of at most 32 KB; TextDecoder is not used. (A counting
    // wrapper rather than vi.spyOn, which would keep every argument list.)
    const original = String.fromCharCode;
    let decoded = 0;
    let largest = 0;
    String.fromCharCode = (...codes: number[]): string => {
      decoded += codes.length;
      largest = Math.max(largest, codes.length);
      return original(...codes);
    };
    const textDecoder = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(countPdfPages(pdf)).toBe(51);
    } finally {
      String.fromCharCode = original;
    }
    expect(decoded).toBeGreaterThan(0);
    expect(largest).toBeLessThanOrEqual(32 * 1024);
    // Measured: 66,997 characters (the tail, the table and the 60 objects of the page tree, each
    // from its offset). Before, the whole file was decoded: 50 MB of string, about twice that in
    // heap; in the workers pool that version runs out of V8 heap on this test.
    expect(decoded).toBeLessThan(256 * 1024);
    expect(textDecoder).not.toHaveBeenCalled();
    textDecoder.mockRestore();
    // Time (without the wrapper): measured 1 ms (the clock's resolution) in the workers pool,
    // 1-4 ms in Node; the whole-file decode took about 1,200 ms on 54 MB in the pool and 2,250 ms
    // in Node. The bound leaves room for a slow machine.
    const started = performance.now();
    expect(countPdfPages(pdf)).toBe(51);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
