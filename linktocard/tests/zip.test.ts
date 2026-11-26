// The streaming ZIP writer (src/lib/zip.ts), checked inside workerd with a ZIP reader written
// here from the format, not from the writer: it walks the central directory, then each local
// header, data and data descriptor, and recomputes every CRC-32 bit by bit. Interoperability
// with real tools (unzip, Python, Java) is in tests/node/zip-unzip.test.ts.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import {
  ZIP_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  assertZipName,
  crc32,
  dedupeZipNames,
  dosDateTime,
  safeZipName,
  zipArchiveSize,
  zipNameDeduper,
  zipStream,
  type ZipEntry,
} from '../src/lib/zip';

/* ------------------------------------------------------------------ */
/* Independent reader                                                  */
/* ------------------------------------------------------------------ */

/** CRC-32 one bit at a time, straight from the polynomial: shares nothing with the writer. */
function bitwiseCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ReadEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  versionMadeBy: number;
  versionNeeded: number;
  externalAttributes: number;
  offset: number;
}

/**
 * Parses a whole archive and throws on anything a strict reader would reject: wrong signatures,
 * a local header that disagrees with the central directory, non-zero CRC or sizes in a local
 * header that uses a data descriptor, a descriptor that disagrees, a CRC that does not match the
 * data, gaps or overlaps between records, or a central directory that is not where the end
 * record says.
 */
function readZip(zip: Uint8Array): ReadEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const fail = (message: string): never => {
    throw new Error(`zip reader: ${message}`);
  };
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  if (zip.length < 22) fail('shorter than an end record');
  const end = zip.length - 22; // the writer adds no archive comment
  if (u32(end) !== 0x06054b50) fail('no end of central directory record at the end');
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0) fail('multi-disk fields are not zero');
  const count = u16(end + 8);
  if (u16(end + 10) !== count) fail('entry counts differ');
  const centralSize = u32(end + 12);
  const centralOffset = u32(end + 16);
  if (u16(end + 20) !== 0) fail('archive comment present');
  if (centralOffset + centralSize !== end) fail('central directory does not end where the end record starts');

  const entries: ReadEntry[] = [];
  let at = centralOffset;
  let expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) fail(`central header ${i}: bad signature`);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const entry = {
      versionMadeBy: u16(at + 4),
      versionNeeded: u16(at + 6),
      flags: u16(at + 8),
      method: u16(at + 10),
      time: u16(at + 12),
      date: u16(at + 14),
      crc: u32(at + 16),
      compressedSize: u32(at + 20),
      size: u32(at + 24),
      disk: u16(at + 34),
      internalAttributes: u16(at + 36),
      externalAttributes: u32(at + 38),
      offset: u32(at + 42),
      nameBytes: zip.slice(at + 46, at + 46 + nameLength),
    };
    if (extraLength !== 0 || commentLength !== 0 || entry.disk !== 0 || entry.internalAttributes !== 0) fail(`central header ${i}: unexpected extra fields`);
    if (entry.compressedSize !== entry.size) fail(`central header ${i}: stored entry with compressed size != size`);
    at += 46 + nameLength;

    // The local header, the data and the descriptor must follow one another without gaps.
    const local = entry.offset;
    if (local !== expectedLocal) fail(`entry ${i}: local header at ${local}, expected ${expectedLocal}`);
    if (u32(local) !== 0x04034b50) fail(`entry ${i}: bad local header signature`);
    if (u16(local + 4) !== entry.versionNeeded) fail(`entry ${i}: version needed differs`);
    if (u16(local + 6) !== entry.flags) fail(`entry ${i}: flags differ`);
    if (u16(local + 8) !== entry.method) fail(`entry ${i}: method differs`);
    if (u16(local + 10) !== entry.time || u16(local + 12) !== entry.date) fail(`entry ${i}: time differs`);
    if (entry.flags & 0x0008 && (u32(local + 14) !== 0 || u32(local + 18) !== 0 || u32(local + 22) !== 0)) {
      fail(`entry ${i}: bit 3 is set but the local header has a CRC or sizes`);
    }
    if (u16(local + 26) !== nameLength || u16(local + 28) !== 0) fail(`entry ${i}: local name or extra length differs`);
    const localName = zip.slice(local + 30, local + 30 + nameLength);
    if (localName.some((byte, index) => byte !== entry.nameBytes[index])) fail(`entry ${i}: local name differs`);
    const dataStart = local + 30 + nameLength;
    const data = zip.slice(dataStart, dataStart + entry.size);
    const descriptor = dataStart + entry.size;
    if (u32(descriptor) !== 0x08074b50) fail(`entry ${i}: no data descriptor signature after the data`);
    if (u32(descriptor + 4) !== entry.crc || u32(descriptor + 8) !== entry.size || u32(descriptor + 12) !== entry.size) fail(`entry ${i}: descriptor differs`);
    if (bitwiseCrc32(data) !== entry.crc) fail(`entry ${i}: CRC-32 does not match the data`);
    expectedLocal = descriptor + 16;

    entries.push({
      name: decoder.decode(entry.nameBytes),
      data,
      crc: entry.crc,
      flags: entry.flags,
      method: entry.method,
      time: entry.time,
      date: entry.date,
      versionMadeBy: entry.versionMadeBy,
      versionNeeded: entry.versionNeeded,
      externalAttributes: entry.externalAttributes,
      offset: entry.offset,
    });
  }
  if (at !== end) fail('central directory has bytes after its last record');
  if (expectedLocal !== centralOffset) fail('bytes between the last entry and the central directory');
  return entries;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const bytesOf = (text: string): Uint8Array => encoder.encode(text);
const FIXED = new Date(Date.UTC(2026, 10, 26, 13, 45, 30));

async function* asAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/** A stream that hands out `bytes` in the given chunk lengths (cycled), counting its pulls. */
function chunked(bytes: Uint8Array, lengths: number[], stats = { pulls: 0, cancelled: false as unknown }): ReadableStream<Uint8Array> {
  let at = 0;
  let step = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls++;
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        const length = lengths[step++ % lengths.length]!;
        controller.enqueue(bytes.slice(at, at + length));
        at += length;
      },
      cancel(reason) {
        stats.cancelled = reason ?? true;
      },
    },
    { highWaterMark: 0 },
  );
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads until the stream fails; returns the bytes before the failure and the error. */
async function failure(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; error: unknown }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) throw new Error('expected the stream to fail');
      parts.push(value);
    } catch (error) {
      if (error instanceof Error && error.message === 'expected the stream to fail') throw error;
      const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      return { bytes, error };
    }
  }
}

function random(length: number, seed: number): Uint8Array {
  // xorshift32: reproducible "file" contents without crypto.getRandomValues' 64 KiB limit.
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CRC-32                                                              */
/* ------------------------------------------------------------------ */

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(bytesOf('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('agrees with a bitwise CRC for every length around the 8-byte blocks and for offsets into a buffer', () => {
    const data = random(4099, 7);
    for (let length = 0; length <= 40; length++) expect(crc32(data.subarray(0, length)), `length ${length}`).toBe(bitwiseCrc32(data.subarray(0, length)));
    for (const start of [1, 3, 5, 7]) expect(crc32(data.subarray(start))).toBe(bitwiseCrc32(data.subarray(start)));
    expect(crc32(data)).toBe(bitwiseCrc32(data));
  });

  it('continues across chunks like zlib: crc32(b, crc32(a)) is the CRC of a then b', () => {
    const data = random(10_000, 99);
    for (const cut of [0, 1, 7, 8, 9, 4096, 9999, 10_000]) {
      expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(crc32(data));
    }
  });
});

/* ------------------------------------------------------------------ */
/* Archives                                                            */
/* ------------------------------------------------------------------ */

describe('zipStream', () => {
  it('writes an empty archive as a bare end record', async () => {
    const zip = await collect(zipStream(asAsync([]), { modified: FIXED }));
    expect([...zip]).toEqual([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    expect(zipArchiveSize([])).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('matches a hand-assembled archive byte for byte', async () => {
    const zip = await collect(
      zipStream(
        asAsync([
          { name: 'a.txt', size: 3, data: bytesOf('abc') },
          { name: 'é', size: 0, data: new Uint8Array(0) },
        ]),
        { modified: FIXED },
      ),
    );
    // Assembled from the format with explicit field values, not with the writer's helpers.
    const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
    const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    const time = le16((13 << 11) | (45 << 5) | 15);
    const date = le16(((2026 - 1980) << 9) | (11 << 5) | 26);
    const crcAbc = le32(0x352441c2);
    const name1 = [...bytesOf('a.txt')];
    const name2 = [0xc3, 0xa9];
    const local1 = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0x08, 0x08, 0, 0, ...time, ...date, ...le32(0), ...le32(0), ...le32(0), 5, 0, 0, 0, ...name1];
    const data1 = [0x61, 0x62, 0x63];
    const desc1 = [0x50, 0x4b, 0x07, 0x08, ...crcAbc, ...le32(3), ...le32(3)];
    const local2 = [0x50, 0x4b, 0x03, 0x04, 20, 0, 0x08, 0x08, 0, 0, ...time, ...date, ...le32(0), ...le32(0), ...le32(0), 2, 0, 0, 0, ...name2];
    const desc2 = [0x50, 0x4b, 0x07, 0x08, ...le32(0), ...le32(0), ...le32(0)];
    const offset2 = local1.length + data1.length + desc1.length;
    const unixFile = le32((0o100644 << 16) >>> 0);
    const central1 = [0x50, 0x4b, 0x01, 0x02, 20, 3, 20, 0, 0x08, 0x08, 0, 0, ...time, ...date, ...crcAbc, ...le32(3), ...le32(3), 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...unixFile, ...le32(0), ...name1];
    const central2 = [0x50, 0x4b, 0x01, 0x02, 20, 3, 20, 0, 0x08, 0x08, 0, 0, ...time, ...date, ...le32(0), ...le32(0), ...le32(0), 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...unixFile, ...le32(offset2), ...name2];
    const centralOffset = offset2 + local2.length + desc2.length;
    const centralSize = central1.length + central2.length;
    const endRecord = [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 2, 0, 2, 0, ...le32(centralSize), ...le32(centralOffset), 0, 0];
    const expected = [...local1, ...data1, ...desc1, ...local2, ...desc2, ...central1, ...central2, ...endRecord];
    expect(bitwiseCrc32(bytesOf('abc'))).toBe(0x352441c2);
    expect([...zip]).toEqual(expected);
    expect(zipArchiveSize([{ name: 'a.txt', size: 3 }, { name: 'é', size: 0 }])).toBe(expected.length);
  });

  it('stores streamed and in-memory entries with UTF-8 names, CRCs and sizes a strict reader accepts', async () => {
    const big = random(300_000, 42);
    // A PDF-like body that contains the data descriptor signature: readers must not stop there.
    const tricky = new Uint8Array([...bytesOf('%PDF-1.7\n'), 0x50, 0x4b, 0x07, 0x08, 1, 2, 3, 4, ...bytesOf('\n%%EOF\n')]);
    const files: { name: string; content: Uint8Array; streamed: number[] | null }[] = [
      { name: 'invoice-001.pdf', content: random(1234, 1), streamed: null },
      { name: 'شهادة أحمد.pdf', content: random(4096, 2), streamed: [1000, 1, 0, 3000] },
      { name: '日本語/レポート (2).pdf', content: big, streamed: [65_536, 7, 12_345] },
      { name: 'empty.pdf', content: new Uint8Array(0), streamed: [10] },
      { name: 'emoji 🎓.pdf', content: tricky, streamed: [5] },
    ];
    const entries: ZipEntry[] = files.map(({ name, content, streamed }) => ({
      name,
      size: content.length,
      data: streamed ? chunked(content, streamed) : content,
    }));
    const zip = await collect(zipStream(asAsync(entries), { modified: FIXED }));
    expect(zip.length).toBe(zipArchiveSize(files.map(({ name, content }) => ({ name, size: content.length }))));

    const read = readZip(zip);
    expect(read.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    read.forEach((entry, index) => {
      const file = files[index]!;
      expect(entry.data, file.name).toEqual(file.content);
      expect(entry.crc).toBe(bitwiseCrc32(file.content));
      expect(entry.flags).toBe(0x0808); // data descriptor + UTF-8
      expect(entry.method).toBe(0); // stored
      expect(entry.versionNeeded).toBe(20);
      expect(entry.versionMadeBy >>> 8).toBe(3); // Unix, so the mode below is honoured
      expect(entry.externalAttributes >>> 16).toBe(0o100644);
      expect(entry.time).toBe((13 << 11) | (45 << 5) | 15);
      expect(entry.date).toBe((46 << 9) | (11 << 5) | 26);
    });
  });

  it('pipes through a FixedLengthStream of zipArchiveSize(), so a download can send Content-Length', async () => {
    const files = [
      { name: 'a.pdf', content: random(70_000, 5) },
      { name: 'b.pdf', content: random(10, 6) },
    ];
    const total = zipArchiveSize(files.map(({ name, content }) => ({ name, size: content.length })));
    const { readable, writable } = new FixedLengthStream(total);
    const piped = zipStream(asAsync(files.map(({ name, content }) => ({ name, size: content.length, data: chunked(content, [8192]) }))), { modified: FIXED }).pipeTo(writable);
    const response = new Response(readable, { headers: { 'content-type': 'application/zip' } });
    const zip = new Uint8Array(await response.arrayBuffer());
    await piped;
    expect(zip.length).toBe(total);
    expect(readZip(zip).map((entry) => entry.data)).toEqual(files.map((file) => file.content));
  });

  it('defaults the modification time to now', async () => {
    const before = dosDateTime(new Date());
    const zip = await collect(zipStream(asAsync([{ name: 'x', size: 1, data: bytesOf('x') }])));
    const [entry] = readZip(zip);
    const after = dosDateTime(new Date());
    expect(entry!.date).toBeGreaterThanOrEqual(before.date);
    expect(entry!.date).toBeLessThanOrEqual(after.date);
    if (entry!.date === before.date && before.date === after.date) {
      expect(entry!.time).toBeGreaterThanOrEqual(before.time);
      expect(entry!.time).toBeLessThanOrEqual(after.time);
    }
  });

  it('pulls entries and their data only as the archive is read', async () => {
    const requested: string[] = [];
    const stats = [{ pulls: 0, cancelled: false as unknown }, { pulls: 0, cancelled: false as unknown }];
    async function* lazy(): AsyncGenerator<ZipEntry> {
      for (const [index, name] of ['one.pdf', 'two.pdf'].entries()) {
        requested.push(name);
        yield { name, size: 20_000, data: chunked(random(20_000, index + 5), [4096], stats[index]) };
      }
    }
    const reader = zipStream(lazy(), { modified: FIXED }).getReader();
    const first = await reader.read(); // local header of one.pdf
    expect(first.value!.length).toBe(30 + 'one.pdf'.length);
    // The stream keeps at most one chunk ahead of the reader.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requested).toEqual(['one.pdf']);
    expect(stats[0]!.pulls).toBeLessThanOrEqual(2);
    expect(stats[1]!.pulls).toBe(0);
    const rest: Uint8Array[] = [first.value!];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    expect(requested).toEqual(['one.pdf', 'two.pdf']);
    expect(readZip(new Uint8Array(await new Blob(rest).arrayBuffer())).map((entry) => entry.name)).toEqual(['one.pdf', 'two.pdf']);
  });

  it('cancelling the download cancels the entry being read and closes the entry source', async () => {
    const stats = { pulls: 0, cancelled: false as unknown };
    let closed = false;
    async function* source(): AsyncGenerator<ZipEntry> {
      try {
        yield { name: 'big.pdf', size: 1_000_000, data: chunked(random(1_000_000, 3), [1000], stats) };
        yield { name: 'never.pdf', size: 1, data: bytesOf('x') };
      } finally {
        closed = true;
      }
    }
    const reader = zipStream(source(), { modified: FIXED }).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel('client went away');
    expect(stats.cancelled).toBe('client went away');
    expect(closed).toBe(true);
    expect(stats.pulls).toBeLessThan(10);
  });

  it('fails when the data is shorter or longer than its size, and stops reading the source', async () => {
    const short = { pulls: 0, cancelled: false as unknown };
    const long = { pulls: 0, cancelled: false as unknown };
    const shortFail = await failure(zipStream(asAsync([{ name: 'a.pdf', size: 10, data: chunked(random(9, 1), [4], short) }])));
    expect(String(shortFail.error)).toMatch(/ended after 9 of 10 bytes/);
    const longFail = await failure(zipStream(asAsync([{ name: 'a.pdf', size: 10, data: chunked(random(100, 1), [4], long) }])));
    expect(String(longFail.error)).toMatch(/more than 10 bytes/);
    expect(long.cancelled).not.toBe(false);
    const memoryFail = await failure(zipStream(asAsync([{ name: 'a.pdf', size: 10, data: new Uint8Array(11) }])));
    expect(String(memoryFail.error)).toMatch(/has 11 bytes, not 10/);
  });

  it('passes on an error of an entry stream or of the entry source', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.error(new Error('R2 read failed'));
      },
    });
    expect(String((await failure(zipStream(asAsync([{ name: 'a.pdf', size: 10, data: broken }])))).error)).toMatch(/R2 read failed/);
    async function* failing(): AsyncGenerator<ZipEntry> {
      yield { name: 'a.pdf', size: 1, data: bytesOf('a') };
      throw new Error('D1 query failed');
    }
    const { bytes, error } = await failure(zipStream(failing()));
    expect(String(error)).toMatch(/D1 query failed/);
    expect(bytes.length).toBe(30 + 5 + 1 + 16); // a.pdf was written completely, then nothing
  });

  it('refuses unsafe and duplicate names before writing the entry', async () => {
    const ok = { name: 'ok.pdf', size: 1, data: bytesOf('o') };
    for (const name of ['../evil.pdf', 'a/../../evil.pdf', '/etc/passwd', 'C:evil.pdf', 'a\\b.pdf', 'a//b.pdf', 'folder/', '.', 'a\u0000b', 'tab\there', '\uD800x', 'x'.repeat(256), '']) {
      expect(() => assertZipName(name), JSON.stringify(name)).toThrow(TypeError);
      expect(() => zipArchiveSize([{ name, size: 1 }])).toThrow(TypeError);
      const { bytes, error } = await failure(zipStream(asAsync([ok, { name, size: 1, data: bytesOf('x') }])));
      expect(error, JSON.stringify(name)).toBeInstanceOf(TypeError);
      expect(bytes.length).toBe(30 + 6 + 1 + 16);
    }
    for (const [first, second] of [
      ['a.pdf', 'a.pdf'],
      ['Report.PDF', 'report.pdf'],
      ['caf\u00e9.pdf', 'cafe\u0301.pdf'],
    ] as const) {
      expect(() => zipArchiveSize([{ name: first, size: 0 }, { name: second, size: 0 }])).toThrow(/duplicate/);
      const { error } = await failure(zipStream(asAsync([{ name: first, size: 0, data: new Uint8Array(0) }, { name: second, size: 0, data: new Uint8Array(0) }])));
      expect(String(error)).toMatch(/duplicate/);
    }
    expect(() => assertZipName('folder/sub/x.pdf')).not.toThrow();
    expect(() => assertZipName('x'.repeat(255))).not.toThrow();
  });

  it('refuses invalid sizes', () => {
    for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => zipArchiveSize([{ name: 'a', size }])).toThrow(TypeError);
  });
});

describe('format limits', () => {
  it('zipArchiveSize refuses more than 65,535 entries or 4 GiB with payload_too_large', () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `${index}`, size: 0 }));
    expect(ZIP_MAX_ENTRIES).toBe(65_535);
    expect(() => zipArchiveSize(names(ZIP_MAX_ENTRIES))).not.toThrow();
    let error: unknown;
    try {
      zipArchiveSize(names(ZIP_MAX_ENTRIES + 1));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('payload_too_large');
    expect((error as ApiError).status).toBe(413);

    // The largest single entry that fits: the archive is then exactly ZIP_MAX_BYTES long.
    const overhead = 30 + 1 + 16 + 46 + 1 + 22;
    expect(zipArchiveSize([{ name: 'a', size: ZIP_MAX_BYTES - overhead }])).toBe(ZIP_MAX_BYTES);
    expect(() => zipArchiveSize([{ name: 'a', size: ZIP_MAX_BYTES - overhead + 1 }])).toThrow(ApiError);
    expect(() => zipArchiveSize([{ name: 'a', size: 2 ** 31 }, { name: 'b', size: 2 ** 31 }])).toThrow(ApiError);
  });

  it('the stream refuses an entry that would pass 4 GiB before reading any of it', async () => {
    const stats = { pulls: 0, cancelled: false as unknown };
    const { bytes, error } = await failure(
      zipStream(
        asAsync([
          { name: 'small.pdf', size: 2, data: bytesOf('ok') },
          { name: 'huge.pdf', size: ZIP_MAX_BYTES, data: chunked(new Uint8Array(1), [1], stats) },
        ]),
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('payload_too_large');
    expect(bytes.length).toBe(30 + 9 + 2 + 16); // only the first entry
    expect(stats.pulls).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Times and names                                                     */
/* ------------------------------------------------------------------ */

describe('dosDateTime', () => {
  it('packs the UTC fields in 2-second steps and clamps to 1980-2107', () => {
    expect(dosDateTime(new Date(Date.UTC(2026, 10, 26, 13, 45, 31)))).toEqual({ time: (13 << 11) | (45 << 5) | 15, date: (46 << 9) | (11 << 5) | 26 });
    expect(dosDateTime(new Date(Date.UTC(1975, 0, 1)))).toEqual({ time: 0, date: (0 << 9) | (1 << 5) | 1 });
    expect(dosDateTime(new Date(Date.UTC(2200, 0, 1)))).toEqual({ time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 });
    expect(() => dosDateTime(new Date(Number.NaN))).toThrow(TypeError);
  });
});

describe('dedupeZipNames and zipNameDeduper', () => {
  it('numbers repeats before the extension and skips numbers already taken', () => {
    expect(dedupeZipNames(['a.pdf', 'a.pdf', 'A.PDF', 'a (2).pdf', 'b', 'b', '.env', '.env', 'dir/x.pdf', 'dir/x.pdf', 'other/x.pdf', 'x.tar.gz', 'x.tar.gz'])).toEqual([
      'a.pdf',
      'a (2).pdf',
      'A (3).PDF',
      'a (2) (2).pdf',
      'b',
      'b (2)',
      '.env',
      '.env (2)',
      'dir/x.pdf',
      'dir/x (2).pdf',
      'other/x.pdf',
      'x.tar.gz',
      'x.tar (2).gz',
    ]);
  });

  it('treats names that differ only in case or Unicode normalisation as the same', () => {
    expect(dedupeZipNames(['caf\u00e9.pdf', 'cafe\u0301.pdf', 'CAFÉ.pdf'])).toEqual(['caf\u00e9.pdf', 'cafe\u0301 (2).pdf', 'CAFÉ (3).pdf']);
  });

  it('keeps numbered names within 255 bytes and every result is a valid, distinct entry name', () => {
    const long = `${'ش'.repeat(126)}.pdf`; // 252 + 4 = 256 bytes before safeZipName
    const safe = safeZipName(long);
    expect(new TextEncoder().encode(safe).length).toBeLessThanOrEqual(255);
    const take = zipNameDeduper();
    const names = Array.from({ length: 12 }, () => take(safe));
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(12);
    for (const name of names) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
      expect(name.endsWith('.pdf')).toBe(true);
      expect(() => assertZipName(name)).not.toThrow();
    }
    expect(() => zipArchiveSize(names.map((name) => ({ name, size: 0 })))).not.toThrow();
  });
});

describe('safeZipName', () => {
  it.each([
    ['Report: Q1/Q2 <draft>?.pdf', 'Report_ Q1_Q2 _draft__.pdf'],
    ['  spaced \t\n out .pdf  ', 'spaced out .pdf'],
    ['trailing dots...', 'trailing dots'],
    ['..', 'file'],
    ['', 'file'],
    ['???', 'file'],
    ['CON', '_CON'],
    ['nul.pdf', '_nul.pdf'],
    ['com1.txt', '_com1.txt'],
    ['console.pdf', 'console.pdf'],
    ['line\u0000break\u001f.pdf', 'line_break_.pdf'],
    ['شهادة أحمد.pdf', 'شهادة أحمد.pdf'],
    ['cafe\u0301.pdf', 'caf\u00e9.pdf'],
    ['bad \uD800 surrogate.pdf', 'bad _ surrogate.pdf'],
  ])('%j -> %j', (raw, expected) => {
    expect(safeZipName(raw)).toBe(expected);
  });

  it('uses the fallback, itself made safe, when nothing is left', () => {
    expect(safeZipName('///', 'row 7.pdf')).toBe('row 7.pdf');
    expect(safeZipName('', 'a/b.pdf')).toBe('a_b.pdf');
    expect(safeZipName('', '')).toBe('file');
  });

  it('cuts long names to 255 UTF-8 bytes at a character boundary, keeping the extension', () => {
    const name = safeZipName(`${'é'.repeat(300)}.pdf`);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith('é.pdf')).toBe(true);
    expect(safeZipName(`${'🎓'.repeat(100)}.pdf`)).toBe(`${'🎓'.repeat(62)}.pdf`);
  });

  it('always returns a name zipStream accepts', () => {
    const alphabet = ['a', 'Z', '0', ' ', '.', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\u0000', '\t', '\u00e9', 'e\u0301', 'ش', '🎓', '\uD83C', '\uDF93', '-', '_'];
    let x = 12345;
    for (let round = 0; round < 500; round++) {
      let raw = '';
      const length = round % 40;
      for (let i = 0; i < length; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        raw += alphabet[x % alphabet.length];
      }
      const name = safeZipName(raw);
      expect(() => assertZipName(name), JSON.stringify(raw)).not.toThrow();
      expect(name).not.toContain('/');
    }
  });
});
