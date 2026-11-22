/**
 * Minimal PNG encoder for the one case the renderer needs it: turning a decoded
 * WebP into something resvg can draw (resvg-wasm silently draws nothing for WebP).
 *
 * 8-bit RGB or RGBA, Paeth filter on every row, a single IDAT chunk. Compression is
 * the platform's CompressionStream('deflate'), which produces the zlib format PNG
 * requires. Rows are streamed into the compressor in small batches so a 4-megapixel
 * image never needs a second full-size buffer inside the 128 MB isolate.
 */

export interface RgbaImage {
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** Thrown when the encoded file would exceed `maxBytes`; encoding stops at that point. */
export class PngTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`PNG output exceeds ${maxBytes} bytes`);
    this.name = 'PngTooLargeError';
    this.maxBytes = maxBytes;
  }
}

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** Signature + IHDR chunk + IDAT framing + IEND chunk. */
const FIXED_OVERHEAD_BYTES = 8 + 25 + 12 + 12;
const BATCH_BYTES = 64 * 1024;
const FILTER_PAETH = 4;
const COLOUR_TYPE = { rgb: 2, rgba: 6 } as const;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 (ISO 3309, as used by PNG and zlib) over the concatenation of `parts`. */
export function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const bytes of parts) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function chunk(type: string, data: Uint8Array[]): Uint8Array[] {
  const tag = new TextEncoder().encode(type);
  const length = data.reduce((sum, part) => sum + part.byteLength, 0);
  return [uint32(length), tag, ...data, uint32(crc32(tag, ...data))];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function isOpaque(data: RgbaImage['data']): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

/** Paeth-filtered scanlines for rows [firstRow, firstRow + rowCount), `channels` bytes per pixel. */
function filterRows(image: RgbaImage, channels: number, firstRow: number, rowCount: number): Uint8Array {
  const { data, width } = image;
  const sourceStride = width * 4;
  const out = new Uint8Array(rowCount * (width * channels + 1));
  let o = 0;
  for (let y = firstRow; y < firstRow + rowCount; y++) {
    out[o++] = FILTER_PAETH;
    const row = y * sourceStride;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const i = row + x * 4 + c;
        const left = x > 0 ? data[i - 4]! : 0;
        const up = y > 0 ? data[i - sourceStride]! : 0;
        const upLeft = x > 0 && y > 0 ? data[i - sourceStride - 4]! : 0;
        // Uint8Array assignment wraps modulo 256, which is exactly the PNG filter arithmetic.
        out[o++] = data[i]! - paeth(left, up, upLeft);
      }
    }
  }
  return out;
}

async function writeScanlines(
  writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>,
  image: RgbaImage,
  channels: number,
): Promise<void> {
  const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / (image.width * channels + 1)));
  for (let y = 0; y < image.height; y += rowsPerBatch) {
    await writer.write(filterRows(image, channels, y, Math.min(rowsPerBatch, image.height - y)));
  }
  await writer.close();
}

async function deflateScanlines(image: RgbaImage, channels: number, maxBytes: number): Promise<Uint8Array[]> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = writeScanlines(writer, image, channels);
  // A failed write also errors the readable side, so the read loop below reports it; this
  // handler only keeps the rejection from being flagged as unhandled in the meantime.
  writing.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PngTooLargeError(maxBytes + FIXED_OVERHEAD_BYTES);
      chunks.push(value);
    }
    await writing;
    return chunks;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await writer.abort().catch(() => undefined);
    throw error;
  }
}

/**
 * Encode straight RGBA pixels as a PNG file. Fully opaque images are written as RGB
 * (a quarter less data to compress). Rejects with PngTooLargeError as soon as the
 * file would exceed `maxBytes`.
 */
export async function encodePng(image: RgbaImage, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
  const { data, width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`PNG dimensions must be positive integers (got ${width}x${height})`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(`expected ${width * height * 4} bytes of RGBA for ${width}x${height}, got ${data.length}`);
  }
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const opaque = isOpaque(data);
  const channels = opaque ? 3 : 4;
  const idat = await deflateScanlines(image, channels, maxBytes - FIXED_OVERHEAD_BYTES);
  const header = Uint8Array.of(8, opaque ? COLOUR_TYPE.rgb : COLOUR_TYPE.rgba, 0, 0, 0);
  return concat([
    SIGNATURE,
    ...chunk('IHDR', [uint32(width), uint32(height), header]),
    ...chunk('IDAT', idat),
    ...chunk('IEND', []),
  ]);
}
