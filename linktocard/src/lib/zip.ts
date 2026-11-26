/**
 * A streaming ZIP writer for downloads of many finished files (the PDFs of a batch): the files
 * are already compressed, so entries are stored (method 0), never deflated, and the archive is
 * written while the files are read, without holding any of them in memory.
 *
 * Layout (PKWARE's APPNOTE.TXT), all numbers little-endian:
 *
 *   per entry   local file header (30 bytes + name)
 *               the file's bytes, as they arrive
 *               data descriptor (16 bytes: signature, CRC-32, compressed size, size)
 *   at the end  central directory (46 bytes + name per entry)
 *               end of central directory record (22 bytes)
 *
 * General purpose flags 0x0808 on every entry: bit 3, so the CRC-32 (computed while the bytes
 * stream past) can follow the data in a descriptor and the local header carries zeros there;
 * bit 11, so names are read as UTF-8. Readers that use the central directory need nothing else
 * (Info-ZIP unzip, Python's zipfile and Java's ZipFile are tested). Streaming readers that read
 * only local headers cannot find the end of a stored entry whose sizes are in a descriptor (Java's
 * ZipInputStream refuses such entries): the price of not buffering a file to learn its CRC first.
 *
 * No ZIP64: an archive must be smaller than 4 GiB, so every 32-bit size and offset stays below
 * 0xFFFFFFFF (the value that means "look in the ZIP64 record"), and hold at most 65,535 entries,
 * which Info-ZIP unzip, Python's zipfile and Java's ZipFile read without ZIP64
 * (tests/node/zip-unzip.test.ts). zipArchiveSize() checks a list up front, so a route can
 * refuse with a JSON error (and send an exact Content-Length) before the first byte.
 */
import { ApiError } from './errors';

export interface ZipEntry {
  /** Path inside the archive: "/" separates folders; see assertZipName for what is refused. */
  name: string;
  /** Exact byte length of `data`; the stream fails if the data turns out longer or shorter. */
  size: number;
  data: ReadableStream<Uint8Array> | Uint8Array;
}

export interface ZipOptions {
  /** Modification time written for every entry (DOS time, read as UTC). Default: now. */
  modified?: Date;
}

/* ------------------------------------------------------------------ */
/* Format constants (fixed by the ZIP format, not product settings)    */
/* ------------------------------------------------------------------ */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;

/** Bit 3 (sizes and CRC in a data descriptor) and bit 11 (UTF-8 names). */
const FLAGS = 0x0808;
const METHOD_STORED = 0;
/** "Version needed to extract" 2.0, the default Python's zipfile writes for entries like these. */
const VERSION_NEEDED = 20;
/** Made by Unix (3) with spec version 2.0, so external attributes carry a Unix file mode. */
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** Regular file, rw-r--r--: what unzip gives an extracted file. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

/** Largest archive (4 GiB - 1): every size and offset in it is then below 0xFFFFFFFF. */
export const ZIP_MAX_BYTES = 0xffff_ffff;
/** Largest value of the 16-bit entry counts; Python's zipfile also writes this many without ZIP64. */
export const ZIP_MAX_ENTRIES = 0xffff;
/** A name is stored with a 16-bit length. */
const MAX_NAME_FIELD_BYTES = 0xffff;
/** One path component: 255 bytes is the name limit of ext4 and APFS (NTFS: 255 UTF-16 units). */
const MAX_COMPONENT_BYTES = 255;

/* ------------------------------------------------------------------ */
/* CRC-32 (ISO-HDLC, the one ZIP and gzip use)                         */
/* ------------------------------------------------------------------ */

/**
 * Eight 256-entry tables for "slicing by 8": eight bytes per step instead of one, about 1.5
 * times the speed of the one-table loop in V8 (some 630 against 440 MB/s in Node 22). A batch
 * download hashes every byte of every PDF on the Worker's CPU clock.
 */
const CRC_TABLES = ((): Uint32Array[] => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  const [t0] = tables as [Uint32Array];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t0[n]!;
    for (let k = 1; k < 8; k++) {
      c = t0[c & 0xff]! ^ (c >>> 8);
      tables[k]![n] = c;
    }
  }
  return tables;
})();

/**
 * CRC-32 of `bytes`, continuing from `previous` (the CRC of the bytes before them), so
 * crc32(b, crc32(a)) === crc32(a followed by b). Same convention as zlib's crc32().
 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES as [Uint32Array, Uint32Array, Uint32Array, Uint32Array, Uint32Array, Uint32Array, Uint32Array, Uint32Array];
  let crc = ~previous >>> 0;
  let i = 0;
  const length = bytes.length;
  const blocks = length - (length % 8);
  while (i < blocks) {
    const low = crc ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24));
    const high = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24);
    crc =
      t7[low & 0xff]! ^
      t6[(low >>> 8) & 0xff]! ^
      t5[(low >>> 16) & 0xff]! ^
      t4[low >>> 24]! ^
      t3[high & 0xff]! ^
      t2[(high >>> 8) & 0xff]! ^
      t1[(high >>> 16) & 0xff]! ^
      t0[high >>> 24]!;
    i += 8;
  }
  while (i < length) crc = t0[(crc ^ bytes[i++]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const utf8Length = (text: string): number => encoder.encode(text).byteLength;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Refuses names that would extract outside the target folder or not at all: empty, absolute
 * ("/x", "C:x"), backslashes (a folder separator on Windows), "." and ".." components, empty
 * components ("a//b", a trailing "/": folders are not entries here), control characters, text
 * that is not valid Unicode, components over 255 UTF-8 bytes. These names come from our own
 * code (safeZipName), so a bad one is a bug: TypeError, not a client error.
 */
export function assertZipName(name: string): void {
  if (typeof name !== 'string' || name === '') throw new TypeError('zip: an entry name must be a non-empty string');
  const shown = JSON.stringify(name.slice(0, 80));
  if (CONTROL.test(name) || LONE_SURROGATE.test(name)) throw new TypeError(`zip: entry name ${shown} has a control character or invalid Unicode`);
  if (name.includes('\\')) throw new TypeError(`zip: entry name ${shown} has a backslash`);
  if (/^[A-Za-z]:/.test(name)) throw new TypeError(`zip: entry name ${shown} starts with a drive letter`);
  for (const part of name.split('/')) {
    if (part === '' || part === '.' || part === '..') throw new TypeError(`zip: entry name ${shown} has an empty, "." or ".." component`);
    if (utf8Length(part) > MAX_COMPONENT_BYTES) throw new TypeError(`zip: entry name ${shown} has a component over ${MAX_COMPONENT_BYTES} bytes`);
  }
  if (utf8Length(name) > MAX_NAME_FIELD_BYTES) throw new TypeError(`zip: entry name ${shown} is over ${MAX_NAME_FIELD_BYTES} bytes`);
}

/** Characters Windows refuses in a file name, plus "/" (safeZipName makes one flat file name). */
const UNSAFE_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Device names Windows reserves with any extension ("con.pdf" too). */
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

/** Cuts `stem` (at a code point) so that stem + suffix fit in `maxBytes` of UTF-8. */
function fitName(stem: string, suffix: string, maxBytes: number): string {
  let kept = stem;
  while (kept !== '' && utf8Length(kept + suffix) > maxBytes) kept = Array.from(kept).slice(0, -1).join('');
  return (kept.replace(/[\s.]+$/, '') || '_') + suffix;
}

/** "report.pdf" -> ["report", ".pdf"]; "README" and ".env" have no extension. */
function splitExtension(base: string): [string, string] {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
}

/**
 * One flat file name that extracts on Windows, macOS and Linux and keeps its letters in any
 * script (names are UTF-8): NFC, runs of white space (tabs and line breaks too) one space,
 * characters Windows refuses and other control characters "_", no leading or trailing dots or
 * spaces, reserved device names ("CON", "nul.pdf") get a leading "_", at most 255 UTF-8 bytes
 * with the extension kept. `fallback` when nothing usable is left. Never throws.
 */
export function safeZipName(raw: string, fallback = 'file'): string {
  const cleaned = String(raw)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(UNSAFE_CHARACTERS, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (cleaned === '' || /^_+$/.test(cleaned)) return fallback === raw ? 'file' : safeZipName(fallback, 'file');
  const named = RESERVED_WINDOWS_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  if (utf8Length(named) <= MAX_COMPONENT_BYTES) return named;
  const [stem, extension] = splitExtension(named);
  // An "extension" longer than a few dozen bytes is just text after a dot: cut the whole name.
  return utf8Length(extension) <= 32 ? fitName(stem, extension, MAX_COMPONENT_BYTES) : fitName(named, '', MAX_COMPONENT_BYTES);
}

/** How names collide on extraction: macOS and Windows file systems ignore case and normalisation. */
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase();

/** "folder/a.pdf", 2 -> "folder/a (2).pdf", keeping the component within 255 bytes. */
function numberedName(name: string, n: number): string {
  const slash = name.lastIndexOf('/');
  const folder = name.slice(0, slash + 1);
  const [stem, extension] = splitExtension(name.slice(slash + 1));
  return folder + fitName(stem, ` (${n})${extension}`, MAX_COMPONENT_BYTES);
}

/**
 * A function that hands out names unique within one archive: the first "a.pdf" stays "a.pdf",
 * the next become "a (2).pdf", "a (3).pdf"; a numbered name that is itself taken is skipped.
 * Names differing only in case or Unicode normalisation count as the same, because they would
 * overwrite each other when extracted on macOS or Windows. For streams of entries, one call per
 * name in archive order.
 */
export function zipNameDeduper(): (name: string) => string {
  const taken = new Set<string>();
  return (name) => {
    let candidate = name;
    for (let n = 2; taken.has(nameKey(candidate)); n++) candidate = numberedName(name, n);
    taken.add(nameKey(candidate));
    return candidate;
  };
}

/** dedupeZipNames(["a.pdf", "a.pdf", "b.pdf"]) -> ["a.pdf", "a (2).pdf", "b.pdf"]. */
export function dedupeZipNames(names: Iterable<string>): string[] {
  return Array.from(names, zipNameDeduper());
}

/* ------------------------------------------------------------------ */
/* Sizes and limits                                                    */
/* ------------------------------------------------------------------ */

function assertSize(name: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError(`zip: entry ${JSON.stringify(name.slice(0, 80))} has an invalid size ${size}`);
}

function tooLarge(entries: number, bytes: number): ApiError {
  return new ApiError('payload_too_large', `A ZIP download holds at most ${ZIP_MAX_ENTRIES} files and 4 GiB; this one would need more.`, {
    details: { files: entries, bytes, max_files: ZIP_MAX_ENTRIES, max_bytes: ZIP_MAX_BYTES },
  });
}

/** Archive bytes taken by one entry: its local header, data and descriptor, and its central record. */
const entryBytes = (nameBytes: number, size: number): number =>
  LOCAL_HEADER_BYTES + nameBytes + size + DATA_DESCRIPTOR_BYTES + CENTRAL_HEADER_BYTES + nameBytes;

/**
 * Exact length of the archive zipStream() writes for these entries, after the same checks:
 * names (TypeError, see assertZipName), sizes, duplicates (TypeError), and the format's limits
 * (ApiError payload_too_large). Call it before starting a download, to refuse with a proper
 * error and to send Content-Length.
 */
export function zipArchiveSize(entries: Iterable<{ name: string; size: number }>): number {
  const seen = new Set<string>();
  let count = 0;
  let total = END_OF_CENTRAL_DIRECTORY_BYTES;
  for (const { name, size } of entries) {
    assertZipName(name);
    assertSize(name, size);
    const key = nameKey(name);
    if (seen.has(key)) throw new TypeError(`zip: duplicate entry name ${JSON.stringify(name.slice(0, 80))} (use zipNameDeduper)`);
    seen.add(key);
    count++;
    total += entryBytes(utf8Length(name), size);
  }
  if (count > ZIP_MAX_ENTRIES || total > ZIP_MAX_BYTES) throw tooLarge(count, total);
  return total;
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

interface DosTime {
  time: number;
  date: number;
}

/** DOS date and time (2-second steps, 1980-2107), from the UTC fields: the format has no time zone. */
export function dosDateTime(when: Date): DosTime {
  const ms = when.getTime();
  if (!Number.isFinite(ms)) throw new TypeError('zip: invalid modification time');
  const year = when.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  };
}

interface Written {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

function localHeader(name: Uint8Array, when: DosTime): Uint8Array {
  const out = new Uint8Array(LOCAL_HEADER_BYTES + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, FLAGS, true);
  view.setUint16(8, METHOD_STORED, true);
  view.setUint16(10, when.time, true);
  view.setUint16(12, when.date, true);
  // 14..25: CRC-32, compressed and uncompressed size are zero; the data descriptor has them (bit 3).
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true); // no extra field
  out.set(name, LOCAL_HEADER_BYTES);
  return out;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const out = new Uint8Array(DATA_DESCRIPTOR_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true); // stored: compressed size = size
  view.setUint32(12, size, true);
  return out;
}

function centralDirectory(written: readonly Written[], when: DosTime, offset: number): Uint8Array {
  const recordBytes = written.reduce((sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.name.length, 0);
  const out = new Uint8Array(recordBytes + END_OF_CENTRAL_DIRECTORY_BYTES);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const entry of written) {
    view.setUint32(at, CENTRAL_HEADER_SIGNATURE, true);
    view.setUint16(at + 4, VERSION_MADE_BY, true);
    view.setUint16(at + 6, VERSION_NEEDED, true);
    view.setUint16(at + 8, FLAGS, true);
    view.setUint16(at + 10, METHOD_STORED, true);
    view.setUint16(at + 12, when.time, true);
    view.setUint16(at + 14, when.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.size, true);
    view.setUint32(at + 24, entry.size, true);
    view.setUint16(at + 28, entry.name.length, true);
    // 30: extra field length, 32: comment length, 34: disk number, 36: internal attributes: all zero.
    view.setUint32(at + 38, EXTERNAL_ATTRIBUTES, true);
    view.setUint32(at + 42, entry.offset, true);
    out.set(entry.name, at + CENTRAL_HEADER_BYTES);
    at += CENTRAL_HEADER_BYTES + entry.name.length;
  }
  view.setUint32(at, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  // at+4: this disk, at+6: disk with the central directory: both 0 (one-file archive).
  view.setUint16(at + 8, written.length, true);
  view.setUint16(at + 10, written.length, true);
  view.setUint32(at + 12, recordBytes, true);
  view.setUint32(at + 16, offset, true);
  // at+20: comment length 0.
  return out;
}

/* ------------------------------------------------------------------ */
/* Stream                                                              */
/* ------------------------------------------------------------------ */

type ReaderSlot = { current: ReadableStreamDefaultReader<Uint8Array> | undefined };

async function* archiveChunks(entries: AsyncIterable<ZipEntry>, when: DosTime, slot: ReaderSlot): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let centralBytes = 0;

  for await (const entry of entries) {
    const { name, size, data } = entry;
    assertZipName(name);
    assertSize(name, size);
    const key = nameKey(name);
    if (seen.has(key)) throw new TypeError(`zip: duplicate entry name ${JSON.stringify(name.slice(0, 80))} (use zipNameDeduper)`);
    seen.add(key);
    const nameBytes = encoder.encode(name);
    const end = offset + LOCAL_HEADER_BYTES + nameBytes.length + size + DATA_DESCRIPTOR_BYTES;
    centralBytes += CENTRAL_HEADER_BYTES + nameBytes.length;
    // Checked before the entry's first byte, so a refused archive never holds half an entry.
    if (written.length + 1 > ZIP_MAX_ENTRIES || end + centralBytes + END_OF_CENTRAL_DIRECTORY_BYTES > ZIP_MAX_BYTES) {
      throw tooLarge(written.length + 1, end + centralBytes + END_OF_CENTRAL_DIRECTORY_BYTES);
    }

    yield localHeader(nameBytes, when);
    let crc = 0;
    let length = 0;
    if (data instanceof Uint8Array) {
      if (data.byteLength !== size) throw new Error(`zip: entry ${JSON.stringify(name.slice(0, 80))} has ${data.byteLength} bytes, not ${size}`);
      crc = crc32(data);
      length = data.byteLength;
      if (length > 0) yield data;
    } else {
      const reader = data.getReader();
      slot.current = reader;
      let finished = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const bytes: unknown = chunk.value;
          if (!(bytes instanceof Uint8Array)) throw new TypeError(`zip: entry ${JSON.stringify(name.slice(0, 80))} produced a chunk that is not a Uint8Array`);
          length += bytes.byteLength;
          if (length > size) throw new Error(`zip: entry ${JSON.stringify(name.slice(0, 80))} has more than ${size} bytes`);
          crc = crc32(bytes, crc);
          if (bytes.byteLength > 0) yield bytes;
        }
        finished = true;
      } finally {
        slot.current = undefined;
        // On any way out but the end of the data (an error, a cancelled download), stop the source.
        if (finished) reader.releaseLock();
        else await reader.cancel().catch(() => undefined);
      }
      if (length !== size) throw new Error(`zip: entry ${JSON.stringify(name.slice(0, 80))} ended after ${length} of ${size} bytes`);
    }
    yield dataDescriptor(crc, size);
    written.push({ name: nameBytes, crc, size, offset });
    offset = end;
  }

  yield centralDirectory(written, when, offset);
}

/**
 * The archive of `entries`, in their order, as a byte stream. Entries are pulled one at a time
 * and each one's data only when the reader of the archive asks for more, so a batch of hundreds
 * of stored PDFs streams with one file open at a time. The stream errors (and stops reading the
 * current entry) on a bad name, a duplicate, a size that does not match the data, or an archive
 * past the format's limits; zipArchiveSize() finds all of those but the size mismatch up front.
 * Cancelling the stream cancels the entry being read and closes `entries`.
 */
export function zipStream(entries: AsyncIterable<ZipEntry>, options: ZipOptions = {}): ReadableStream<Uint8Array> {
  const when = dosDateTime(options.modified ?? new Date());
  const slot: ReaderSlot = { current: undefined };
  const chunks = archiveChunks(entries, when, slot);
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      // A pull may be waiting on the current entry: cancelling its reader ends that wait, then
      // the generator unwinds (its finally blocks run and `entries` is closed).
      await slot.current?.cancel(reason).catch(() => undefined);
      await chunks.return(undefined).catch(() => undefined);
    },
  });
}
