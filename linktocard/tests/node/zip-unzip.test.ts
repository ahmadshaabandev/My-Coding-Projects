// Interoperability of the streaming ZIP writer (src/lib/zip.ts) with real readers: Info-ZIP
// unzip (test and extract), Python's zipfile and, when a JDK is installed, Java's ZipFile.
// A reader that is not installed is skipped; tests/zip.test.ts checks the format itself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, zipArchiveSize, zipStream, type ZipEntry } from '../../src/lib/zip';

const scratch = mkdtempSync(join(tmpdir(), 'ltc-zip-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function installed(command: string, args: string[]): boolean {
  const probe = spawnSync(command, args, { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}
const HAS_UNZIP = installed('unzip', ['-v']);
const HAS_PYTHON = installed('python3', ['--version']);
const HAS_JAVA = installed('java', ['-version']);

/** UTF-8 locale for unzip, so it writes the UTF-8 names as they are. */
const UTF8_ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' };

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: scratch, env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? ''}${result.stdout}${result.stderr}`);
  return result.stdout;
}

function random(length: number, seed: number): Uint8Array {
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

function streamOf(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function* asAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function writeZip(file: string, entries: AsyncIterable<ZipEntry>): Promise<Uint8Array> {
  const bytes = new Uint8Array(await new Response(zipStream(entries, { modified: new Date(Date.UTC(2026, 10, 26, 9, 30, 0)) })).arrayBuffer());
  writeFileSync(join(scratch, file), bytes);
  return bytes;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The files of the main archive: several scripts, a folder, an empty file, a 3 MB streamed file. */
const FILES: { name: string; content: Uint8Array; chunk: number | null }[] = [
  { name: 'certificate-001.pdf', content: random(52_000, 11), chunk: null },
  { name: 'شهادة أحمد.pdf', content: random(9000, 12), chunk: 1000 },
  { name: '日本語/レポート (2).pdf', content: random(3 * 1024 * 1024 + 17, 13), chunk: 65_536 },
  { name: 'empty.txt', content: new Uint8Array(0), chunk: 100 },
  { name: 'emoji 🎓 Zoë.pdf', content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x50, 0x4b, 0x07, 0x08, 0x50, 0x4b, 0x03, 0x04, 0x0a]), chunk: 3 },
];

let archive: Uint8Array;

beforeAll(async () => {
  archive = await writeZip(
    'main.zip',
    asAsync(FILES.map(({ name, content, chunk }) => ({ name, size: content.length, data: chunk === null ? content : streamOf(content, chunk) }))),
  );
});

describe('the archive matches its precomputed size', () => {
  it('zipArchiveSize is the exact byte length', () => {
    expect(archive.length).toBe(zipArchiveSize(FILES.map(({ name, content }) => ({ name, size: content.length }))));
  });
});

describe.skipIf(!HAS_UNZIP)('Info-ZIP unzip', () => {
  it('unzip -t finds no errors', () => {
    expect(run('unzip', ['-t', 'main.zip'], UTF8_ENV)).toMatch(/No errors detected in compressed data of main\.zip\./);
  });

  it('zipinfo reads stored entries from a Unix host with -rw-r--r--', () => {
    const listing = run('zipinfo', ['-v', 'main.zip'], UTF8_ENV);
    expect(listing.match(/compression method:\s+none \(stored\)/g)).toHaveLength(FILES.length);
    expect(listing.match(/extended local header:\s+yes/g)).toHaveLength(FILES.length);
    expect(listing.match(/Unix file attributes \(100644 octal\):\s+-rw-r--r--/g)).toHaveLength(FILES.length);
    expect(listing).toMatch(/2026 Nov 26 09:30:00/);
  });

  it('extracts every file under its UTF-8 name with the same bytes', () => {
    const out = join(scratch, 'unzipped');
    run('unzip', ['-q', '-o', '-d', out, 'main.zip'], UTF8_ENV);
    for (const { name, content } of FILES) expect(sha256(readFileSync(join(out, name))), name).toBe(sha256(content));
  });
});

describe.skipIf(!HAS_PYTHON)("Python's zipfile", () => {
  it('testzip() passes and every entry reads back with its name, flags, CRC and bytes', () => {
    const script = [
      'import json, sys, zipfile, hashlib, zlib',
      'z = zipfile.ZipFile(sys.argv[1])',
      'out = {"testzip": z.testzip(), "entries": []}',
      'for i in z.infolist():',
      '    data = z.read(i)',
      '    out["entries"].append({"name": i.filename, "flags": i.flag_bits, "method": i.compress_type, "crc": i.CRC,',
      '        "crc_of_data": zlib.crc32(data), "size": i.file_size, "sha256": hashlib.sha256(data).hexdigest(),',
      '        "system": i.create_system, "mode": i.external_attr >> 16, "date": list(i.date_time)})',
      'print(json.dumps(out))',
    ].join('\n');
    writeFileSync(join(scratch, 'read_zip.py'), script);
    const result = JSON.parse(run('python3', ['-I', join(scratch, 'read_zip.py'), join(scratch, 'main.zip')])) as {
      testzip: string | null;
      entries: { name: string; flags: number; method: number; crc: number; crc_of_data: number; size: number; sha256: string; system: number; mode: number; date: number[] }[];
    };
    expect(result.testzip).toBeNull();
    expect(result.entries.map((entry) => entry.name)).toEqual(FILES.map((file) => file.name));
    result.entries.forEach((entry, index) => {
      const file = FILES[index]!;
      expect(entry.flags & 0x0808).toBe(0x0808);
      expect(entry.method).toBe(0);
      expect(entry.crc).toBe(entry.crc_of_data);
      expect(entry.crc).toBe(crc32(file.content));
      expect(entry.size).toBe(file.content.length);
      expect(entry.sha256).toBe(sha256(file.content));
      expect(entry.system).toBe(3);
      expect(entry.mode).toBe(0o100644);
      expect(entry.date).toEqual([2026, 11, 26, 9, 30, 0]);
    });
  });
});

describe.skipIf(!HAS_JAVA)("Java's ZipFile", () => {
  it('reads every entry through the central directory; ZipInputStream refuses stored entries with a descriptor', () => {
    const program = `
import java.io.*; import java.util.*; import java.util.zip.*;
public class ReadZip {
  public static void main(String[] args) throws Exception {
    StringBuilder out = new StringBuilder();
    try (ZipFile zip = new ZipFile(args[0], java.nio.charset.StandardCharsets.UTF_8)) {
      for (Enumeration<? extends ZipEntry> e = zip.entries(); e.hasMoreElements();) {
        ZipEntry entry = e.nextElement();
        try (InputStream in = zip.getInputStream(entry)) {
          CRC32 crc = new CRC32(); crc.update(in.readAllBytes());
          out.append(entry.getName()).append('\\t').append(entry.getSize()).append('\\t').append(crc.getValue()).append('\\n');
        }
      }
    }
    try (ZipInputStream stream = new ZipInputStream(new FileInputStream(args[0]))) {
      stream.getNextEntry(); stream.readAllBytes(); out.append("stream: read\\n");
    } catch (ZipException refused) { out.append("stream: ").append(refused.getMessage()).append('\\n'); }
    System.out.write(out.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); System.out.flush();
  }
}`;
    writeFileSync(join(scratch, 'ReadZip.java'), program);
    const lines = run('java', [join(scratch, 'ReadZip.java'), join(scratch, 'main.zip')]).trim().split('\n');
    expect(lines.slice(0, FILES.length)).toEqual(FILES.map(({ name, content }) => `${name}\t${content.length}\t${crc32(content)}`));
    // The documented trade-off of stored entries with data descriptors (src/lib/zip.ts header).
    expect(lines[FILES.length]).toBe('stream: only DEFLATED entries can have EXT descriptor');
  });
});

describe('the 65,535-entry limit is readable without ZIP64', () => {
  const COUNT = 65_535;
  let names: string[];

  beforeAll(async () => {
    names = Array.from({ length: COUNT }, (_, index) => `rows/row-${index + 1}.txt`);
    await writeZip('many.zip', asAsync(names.map((name, index) => ({ name, size: 1, data: new Uint8Array([0x61 + (index % 26)]) }))));
  });

  it.skipIf(!HAS_UNZIP)('unzip -t reads all of them', () => {
    expect(run('unzip', ['-tq', 'many.zip'])).toMatch(/No errors detected/);
    expect(run('zipinfo', ['-h', 'many.zip'])).toMatch(new RegExp(`number of entries: ${COUNT}\\b`));
  });

  it.skipIf(!HAS_PYTHON)("Python's zipfile reads all of them", () => {
    const script = 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(len(z.infolist()), z.testzip())';
    writeFileSync(join(scratch, 'count_zip.py'), script);
    expect(run('python3', ['-I', join(scratch, 'count_zip.py'), join(scratch, 'many.zip')]).trim()).toBe(`${COUNT} None`);
  });
});

describe('crc32 agrees with zlib', () => {
  it('for buffers of many lengths and for chunked input', () => {
    for (const length of [0, 1, 7, 8, 9, 15, 16, 17, 255, 4096, 100_003]) {
      const data = random(length, length + 1);
      expect(crc32(data), `length ${length}`).toBe(zlibCrc32(data));
      const cut = Math.floor(length / 3);
      expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(zlibCrc32(data));
    }
  });
});
