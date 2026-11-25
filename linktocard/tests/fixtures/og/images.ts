// Minimal image files for the OG checker tests: valid headers of each format the probe
// reads, padded to any byte size. Nothing here is decodable art; only the headers matter.

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));
const u16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u24le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

export type FixtureFormat = 'png' | 'jpeg' | 'gif' | 'webp-vp8' | 'webp-vp8l' | 'webp-vp8x';

function header(format: FixtureFormat, width: number, height: number): number[] {
  switch (format) {
    case 'png':
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
    case 'jpeg':
      // SOI, an APP0 (JFIF) segment and an APP1 segment before the frame header, as real files have.
      return [
        0xff, 0xd8,
        0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
        0xff, 0xe1, ...u16be(8), ...ascii('Exif'), 0, 0,
        0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
      ];
    case 'gif':
      return [...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0, 0x3b];
    case 'webp-vp8':
      return [...ascii('RIFF'), ...u32le(30), ...ascii('WEBP'), ...ascii('VP8 '), ...u32le(18), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
    case 'webp-vp8l': {
      const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
      return [...ascii('RIFF'), ...u32le(20), ...ascii('WEBP'), ...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(bits >>> 0)];
    }
    case 'webp-vp8x':
      return [...ascii('RIFF'), ...u32le(30), ...ascii('WEBP'), ...ascii('VP8X'), ...u32le(10), 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  }
}

/** A file of the given format and pixel size, zero-padded to `bytes` (at least the header). */
export function imageFile(format: FixtureFormat, width: number, height: number, bytes = 0): Uint8Array {
  const head = header(format, width, height);
  const out = new Uint8Array(Math.max(bytes, head.length));
  out.set(head);
  return out;
}
