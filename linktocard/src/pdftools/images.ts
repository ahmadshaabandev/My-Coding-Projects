/**
 * PNG and JPEG images for the PDF toolkit (from-images pages, image stamps).
 *
 * pdf-lib embeds a JPEG as it is (the compressed data goes into the PDF untouched), but decodes
 * a PNG completely and compresses it again, holding the raw pixels several times over. The PNG
 * pixel cap is therefore LIMITS.maxImagePixels, the same 128 MB-isolate guard the card renderer
 * uses for template images, checked from the file header before anything is decoded.
 *
 * Phone cameras store photos sideways and record the turn in EXIF (Orientation 1-8); PDF has
 * no such tag, so a JPEG is drawn through the matching matrix and appears the way a photo viewer
 * shows it.
 */
import {
  type PDFDocument,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  setGraphicsState,
} from '@cantoo/pdf-lib';
import { LIMITS, PDF_TOOLKIT } from '../config';
import { ApiError } from '../lib/errors';
import type { Matrix } from './frame';

export type ImageType = 'image/png' | 'image/jpeg';

export interface ImageInfo {
  type: ImageType;
  /** Size as stored in the file, in pixels. */
  width: number;
  height: number;
  /** EXIF orientation, 1 (as stored) to 8; always 1 for PNG. */
  orientation: number;
}

export interface PreparedImage {
  image: PDFImage;
  info: ImageInfo;
  /** Size as shown (width and height swap for orientations 5-8), in pixels. */
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value);
}

/** Start-of-frame markers carry the size; C4 (Huffman tables), C8 and CC are not frames. */
function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Orientation tag (0x0112) of an EXIF APP1 payload starting at `start` ("Exif\0\0" + TIFF). */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  const tiff = start + 6;
  if (end - tiff < 8) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const u16 = (i: number): number => (little ? b[i]! | (b[i + 1]! << 8) : u16be(b, i));
  const u32 = (i: number): number => (little ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0 : u32be(b, i));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpegInfo(b: Uint8Array): ImageInfo | undefined {
  let orientation = 1;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // markers without a payload
    } else if (marker === 0xd9 || marker === 0xda) {
      return undefined; // image data began without a frame header
    } else if (isJpegFrameMarker(marker)) {
      if (i + 8 >= b.length) return undefined;
      return { type: 'image/jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7), orientation };
    } else {
      const length = u16be(b, i + 2);
      if (length < 2) return undefined;
      // APP1 "Exif\0\0": comes before the frame header in camera files.
      if (marker === 0xe1 && startsWith(b, [0x45, 0x78, 0x69, 0x66, 0, 0], i + 4)) orientation = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + length));
      i += 2 + length;
    }
  }
  return undefined;
}

/** Type, stored size and orientation from the header; undefined for anything but PNG or JPEG. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    if (bytes.length < 24 || !startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return undefined;
    return { type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20), orientation: 1 };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpegInfo(bytes);
  return undefined;
}

/** Checks one image file (bytes, type, size) and returns what its header says. */
export function checkImage(bytes: Uint8Array, label: string): ImageInfo {
  if (bytes.byteLength > PDF_TOOLKIT.maxImageBytes) {
    throw new ApiError('payload_too_large', `${label} is ${bytes.byteLength} bytes; an image may be at most ${PDF_TOOLKIT.maxImageBytes} bytes.`, {
      details: { bytes: bytes.byteLength, max_bytes: PDF_TOOLKIT.maxImageBytes },
    });
  }
  const info = readImageInfo(bytes);
  if (!info) throw new ApiError('unsupported_media_type', `${label} is not a PNG or JPEG image (or its header is damaged).`, { details: { reason: 'not_image' } });
  if (info.width < 1 || info.height < 1) throw new ApiError('invalid_request', `${label} has no pixels (${info.width} x ${info.height}).`);
  if (info.type === 'image/png' && info.width * info.height > LIMITS.maxImagePixels) {
    throw new ApiError(
      'payload_too_large',
      `${label} is a ${info.width} x ${info.height} PNG; a PNG may have at most ${LIMITS.maxImagePixels} pixels. Scale it down, or send it as a JPEG.`,
      { details: { width: info.width, height: info.height, max_pixels: LIMITS.maxImagePixels } },
    );
  }
  return info;
}

/** Embeds a checked image into `doc`. A file whose body is damaged fails here, as a client error. */
export async function embedImage(doc: PDFDocument, bytes: Uint8Array, label: string): Promise<PreparedImage> {
  const info = checkImage(bytes, label);
  let image: PDFImage;
  try {
    image = info.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    throw new ApiError('invalid_request', `${label} could not be read as a ${info.type === 'image/png' ? 'PNG' : 'JPEG'}: the file is damaged.`, {
      details: { reason: 'damaged' },
    });
  }
  const sideways = info.orientation >= 5;
  return { image, info, width: sideways ? info.height : info.width, height: sideways ? info.width : info.height };
}

/**
 * The unit-square matrix that shows a stored image in its EXIF orientation. PDF draws an image
 * into the unit square with its first row at the top (y = 1); the result must be the picture
 * as shown, again filling the unit square.
 */
export function orientationMatrix(orientation: number): Matrix {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, 1, 0]; // mirrored left-right
    case 3:
      return [-1, 0, 0, -1, 1, 1]; // turned 180
    case 4:
      return [1, 0, 0, -1, 0, 1]; // mirrored top-bottom
    case 5:
      return [0, -1, -1, 0, 1, 1]; // mirrored along the main diagonal
    case 6:
      return [0, -1, 1, 0, 0, 1]; // turned 90 clockwise
    case 7:
      return [0, 1, 1, 0, 0, 0]; // mirrored along the other diagonal
    case 8:
      return [0, 1, -1, 0, 1, 0]; // turned 90 counter-clockwise
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

export interface ImagePlacement {
  /** Centre of the drawn image, in the coordinates current on the page (usually an upright frame). */
  centerX: number;
  centerY: number;
  /** Size as shown, before `rotate`. */
  width: number;
  height: number;
  /** Degrees counter-clockwise around the centre. */
  rotate?: number;
  /** 0-1; undefined leaves the graphics state alone. */
  opacity?: number;
}

/** Draws a prepared image upright (EXIF applied), scaled, turned and faded as `placement` says. */
export function drawImage(page: PDFPage, prepared: PreparedImage, placement: ImagePlacement): void {
  const name = page.node.newXObject('Image', prepared.image.ref);
  const theta = ((placement.rotate ?? 0) * Math.PI) / 180;
  // Quarter turns give exact 0 and 1 (Math.cos(pi / 2) is 6e-17, which pdf-lib writes out in full).
  const snap = (n: number): number => (Math.abs(n) < 1e-12 ? 0 : n);
  const cos = snap(Math.cos(theta));
  const sin = snap(Math.sin(theta));
  const { width: w, height: h } = placement;
  const ops: PDFOperator[] = [pushGraphicsState()];
  if (placement.opacity !== undefined) {
    const state = page.doc.context.obj({ Type: 'ExtGState', ca: placement.opacity, CA: placement.opacity });
    ops.push(setGraphicsState(page.node.newExtGState('GS', state)));
  }
  ops.push(
    concatTransformationMatrix(1, 0, 0, 1, placement.centerX, placement.centerY),
    concatTransformationMatrix(cos, sin, -sin, cos, 0, 0),
    concatTransformationMatrix(w, 0, 0, h, -w / 2, -h / 2),
    concatTransformationMatrix(...orientationMatrix(prepared.info.orientation)),
    drawObject(name),
    popGraphicsState(),
  );
  page.pushOperators(...ops);
}
