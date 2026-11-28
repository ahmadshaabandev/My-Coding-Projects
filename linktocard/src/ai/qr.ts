/**
 * Scan-safe QR codes on an AI background (AI-SPEC.md section 6).
 *
 * The code is a real QR code from uqr (the library of src/lib/qr.ts), error correction Q, drawn as
 * SVG on a solid light plate that holds the quiet zone of 4 modules, with dark modules of at least
 * 7:1 contrast against the plate, centred on the square background; its modules take at least 42%
 * of the image width. The model never draws any part of the code.
 *
 * Every image is verified before anyone sees it: resvg draws it to pixels and jsQR (Apache-2.0)
 * must decode exactly the encoded URL at full size and at one third of it. When an attempt fails,
 * the next step of the ladder is tried: the palette's colours, then a larger code, then pure black
 * on white at the largest size. An image no step verified is never shown or charged (422
 * url_refused, reason too_long_to_scan). The step that passed is recorded.
 */
import jsQR from 'jsqr';
import { encode } from 'uqr';
import { AI } from '../config';
import { ApiError } from '../lib/errors';
import { qrPathData } from '../lib/qr';
import { rasterize } from '../render/engine';
import { encodePng } from '../render/png-writer';
import { stampWatermark, watermarkMarkup } from '../render/watermark';
import { dataUri, type PixelImage } from './compose';

export type QrStepName = 'palette' | 'larger' | 'plain';

export interface QrStep {
  name: QrStepName;
  /** Share of the image width the code's modules take (at least AI.qr.minWidthFraction). */
  moduleFraction: number;
  /** Fixed colours; otherwise derived from the palette (qrColours). */
  colours?: { dark: string; light: string };
}

export const QR_LADDER: readonly QrStep[] = [
  { name: 'palette', moduleFraction: 0.46 },
  { name: 'larger', moduleFraction: 0.6 },
  { name: 'plain', moduleFraction: 0.72, colours: { dark: '#000000', light: '#ffffff' } },
];

/** The composition's own coordinate space; it is rasterised at any width. */
const CANVAS = 1024;
/** Plate padding beyond the quiet zone, in modules (the rounded corners stay inside it). */
const PAD_MODULES = 1;
/** The plate never takes more than this share of the width, so the corner mark stays off it. */
const MAX_PLATE_FRACTION = 0.9;

/* ------------------------------------------------------------------ */
/* Colours                                                             */
/* ------------------------------------------------------------------ */

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2 relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(hex: string, towards: [number, number, number], amount: number): string {
  const rgb = channels(hex);
  return toHex(rgb.map((value, index) => value + (towards[index]! - value) * amount));
}

/**
 * Plate and module colours from the palette: the lightest colour tinted almost to white for the
 * plate, the darkest darkened until it has AI.qr.minContrast against the plate (else black).
 */
export function qrColours(palette: readonly string[]): { dark: string; light: string } {
  if (palette.length === 0) return { dark: '#111111', light: '#ffffff' };
  const sorted = [...palette].sort((a, b) => luminance(a) - luminance(b));
  const light = mix(sorted[sorted.length - 1]!, [255, 255, 255], 0.88);
  let dark = sorted[0]!;
  for (let step = 0; step <= 10 && contrast(dark, light) < AI.qr.minContrast; step++) dark = mix(sorted[0]!, [0, 0, 0], step / 10);
  if (contrast(dark, light) < AI.qr.minContrast) dark = '#000000';
  return { dark, light };
}

/* ------------------------------------------------------------------ */
/* The code                                                            */
/* ------------------------------------------------------------------ */

export interface QrMatrix {
  rows: boolean[][];
  /** Modules per side, without the quiet zone. */
  size: number;
  version: number;
}

/** The smallest code that holds the text at error correction Q (uqr; Q is never boosted down). */
export function qrMatrix(text: string): QrMatrix {
  try {
    const qr = encode(text, { ecc: AI.qr.ecc, boostEcc: false, border: 0 });
    return { rows: qr.data, size: qr.size, version: qr.version };
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError('url_refused', 'This URL is too long for a QR code.', { details: { reason: 'too_long' } });
    throw error;
  }
}

/** The plate and modules in module units (side = size + 2 quiet + 2 pad), as SVG markup. */
function qrMarkup(matrix: QrMatrix, colours: { dark: string; light: string }): { markup: string; side: number } {
  const quiet = AI.qr.quietZoneModules;
  const side = matrix.size + 2 * (quiet + PAD_MODULES);
  // Rows of qrPathData are 1-unit strokes centred on y: shifting by half a module puts row y at [y, y + 1].
  const markup =
    `<rect x="0" y="0" width="${side}" height="${side}" rx="${PAD_MODULES}" fill="${colours.light}"/>` +
    `<path transform="translate(0 0.5)" stroke="${colours.dark}" stroke-width="1" shape-rendering="crispEdges" fill="none" d="${qrPathData(matrix.rows, quiet + PAD_MODULES)}"/>`;
  return { markup, side };
}

/** The QR layer alone as an SVG file (the paid download): plate, quiet zone and modules. */
export function qrLayerSvg(matrix: QrMatrix, colours: { dark: string; light: string }, pixelsPerModule = 16): string {
  const { markup, side } = qrMarkup(matrix, colours);
  const px = side * pixelsPerModule;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${side} ${side}">${markup}</svg>`;
}

export interface QrComposition {
  svg: string;
  step: QrStep;
  colours: { dark: string; light: string };
  /** The modules' share of the width, as drawn. */
  moduleFraction: number;
}

/** The background, the plate and the code in one square SVG (CANVAS units). */
export async function composeQrSvg(matrix: QrMatrix, background: PixelImage, step: QrStep, palette: readonly string[], mark: 'none' | 'free' | 'preview'): Promise<QrComposition> {
  const colours = step.colours ?? qrColours(palette);
  const { markup, side } = qrMarkup(matrix, colours);
  const wanted = Math.max(step.moduleFraction, AI.qr.minWidthFraction) * CANVAS / matrix.size;
  const scale = Math.min(wanted, (MAX_PLATE_FRACTION * CANVAS) / side);
  const offset = (CANVAS - side * scale) / 2;
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">` +
    `<image x="0" y="0" width="${CANVAS}" height="${CANVAS}" preserveAspectRatio="xMidYMid slice" href="${dataUri(background)}"/>` +
    `<g transform="translate(${offset.toFixed(3)} ${offset.toFixed(3)}) scale(${scale.toFixed(5)})">${markup}</g></svg>`;
  if (mark !== 'none') svg = stampWatermark(svg, await watermarkMarkup(CANVAS, CANVAS, mark));
  return { svg, step, colours, moduleFraction: (matrix.size * scale) / CANVAS };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export interface Raster {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** jsQR's reading of the pixels, or null. */
export function decodeQr(raster: Raster): string | null {
  const data = new Uint8ClampedArray(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength);
  return jsQR(data, raster.width, raster.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

export interface VerifiedQr {
  /** The PNG at `side` pixels. */
  png: Uint8Array;
  side: number;
  composition: QrComposition;
  /** 1-based position on the ladder of the step that verified. */
  attempt: number;
}

/**
 * Draws the ladder's steps until one decodes to exactly `text` at `side` pixels and at one third
 * of that; returns its PNG. Throws 422 url_refused (too_long_to_scan) when none does.
 */
export async function composeVerifiedQr(
  text: string,
  background: PixelImage,
  options: { side: number; palette: readonly string[]; mark: 'none' | 'free' | 'preview'; ladder?: readonly QrStep[] },
): Promise<VerifiedQr> {
  const matrix = qrMatrix(text);
  const ladder = options.ladder ?? QR_LADDER;
  for (const [index, step] of ladder.entries()) {
    const composition = await composeQrSvg(matrix, background, step, options.palette, options.mark);
    const full = await rasterize(composition.svg, options.side);
    if (decodeQr(full) !== text) continue;
    const small = await rasterize(composition.svg, Math.round(options.side * AI.qr.verifyScale));
    if (decodeQr(small) !== text) continue;
    return { png: await encodePng({ data: full.pixels, width: full.width, height: full.height }), side: options.side, composition, attempt: index + 1 };
  }
  throw new ApiError('url_refused', 'A QR code for this URL could not be verified to scan at small sizes. Use a shorter URL.', { details: { reason: 'too_long_to_scan' } });
}
