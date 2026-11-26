/**
 * Static QR codes as small SVG data: URIs, for printing inside PDF templates (the certificate's
 * verification link). The matrix comes from uqr (MIT, no dependencies); this module only draws it.
 *
 * Why this shape:
 *   - a data:image/svg+xml URI, because the PDF sanitiser keeps <img src> only for http(s) URLs
 *     (downloaded and inlined) and data:image URIs (src/pdf/template.ts imageSource), and the
 *     browser that prints may load nothing but data: (src/pdf/render.ts allowRequestPattern);
 *   - one stroked <path> for all dark modules: each run of dark modules in a row is a 1-unit
 *     wide horizontal line, and the viewBox starts at y = -0.5 so a line at row y covers exactly
 *     that row. One path is painted as one shape (separate squares can show hairline seams in
 *     an anti-aliasing viewer), and it is short: the URI for a linktocard.com verification link
 *     fits in PDF.maxDataValueChars (tests/batch-qr.test.ts);
 *   - shape-rendering="crispEdges", so rasterisers do not blur module edges;
 *   - percent-encoding of only the characters that need it (white space, ", #, %, <, >) and
 *     single quotes in the markup, so the URI is short and survives a double-quoted HTML
 *     attribute (or a {{placeholder}} in one) unchanged; it contains no ", <, >, & or white space.
 *
 * The SVG has no width or height: it takes the size the template's CSS gives the <img> and keeps
 * its square aspect ratio from the viewBox.
 */
import { encode } from 'uqr';
import { ApiError } from './errors';

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrSvgOptions {
  /** Light modules around the code, in modules. Default 4, the quiet zone the QR standard asks for. */
  margin?: number;
  /** Colour of dark modules: #rgb or #rrggbb. Default #000. */
  dark?: string;
  /** Colour of the background square, #rgb or #rrggbb, or "none" for no background. Default #fff. */
  light?: string;
  /**
   * Least error correction (L 7%, M 15%, Q 25%, H 30% of the code may be damaged). The code
   * is the smallest size that holds the text at this level, then uses the highest level that
   * still fits that size (uqr boostEcc). Default L: for a small printed code, a smaller size
   * (larger modules at the same print size) helps scanning more than a higher level, and it
   * keeps a verification link's URI within PDF.maxDataValueChars.
   */
  ecc?: QrEcc;
}

const QUIET_ZONE_MODULES = 4;
const ECC_LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];
const HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

/** Relative luminance (WCAG 2) of a #rgb or #rrggbb colour. */
function luminance(hex: string): number {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((digit) => digit + digit).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = Number.parseInt(digits.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function colour(value: string | undefined, fallback: string, what: 'dark' | 'light'): string {
  if (value === undefined) return fallback;
  if (what === 'light' && value === 'none') return value;
  if (typeof value !== 'string' || !HEX_COLOUR.test(value)) {
    throw invalid(`QR "${what}" must be a colour like #000 or #1a2b3c${what === 'light' ? ', or "none"' : ''}.`);
  }
  return value.toLowerCase();
}

/** The shorter of an absolute and a relative move from (fromX, fromY) to (x, y). */
function move(x: number, y: number, fromX: number | undefined, fromY: number): string {
  const absolute = `M${x},${y}`;
  if (fromX === undefined) return absolute;
  const dy = y - fromY;
  const relative = `m${x - fromX}${dy < 0 ? '' : ','}${dy}`;
  return relative.length < absolute.length ? relative : absolute;
}

/** Path data for the dark modules of `rows`, shifted by `margin`: "M4,4h7m2,0h1...". */
export function qrPathData(rows: readonly (readonly boolean[])[], margin: number): string {
  const parts: string[] = [];
  let x: number | undefined;
  let y = 0;
  rows.forEach((row, rowIndex) => {
    for (let start = 0; start < row.length; ) {
      if (!row[start]) {
        start++;
        continue;
      }
      let end = start;
      while (end < row.length && row[end]) end++;
      parts.push(move(start + margin, rowIndex + margin, x, y), `h${end - start}`);
      x = end + margin;
      y = rowIndex + margin;
      start = end;
    }
  });
  return parts.join('');
}

const encodeForDataUri = (svg: string): string => svg.replace(/[\s"#%<>]/g, (character) => encodeURIComponent(character));

/**
 * A QR code for `text` (UTF-8; numeric and upper-case alphanumeric text get the denser modes)
 * as a data:image/svg+xml URI; QrSvgOptions.ecc says how the size is chosen. Throws
 * ApiError('invalid_request') for empty text, text too long for any QR code, or invalid
 * options. Dark must be darker than light: scanners look for dark modules on a light ground,
 * and some cannot read an inverted code.
 */
export function qrSvgDataUri(text: string, opts: QrSvgOptions = {}): string {
  if (typeof text !== 'string' || text === '') throw invalid('A QR code needs some text to encode.');
  const margin = opts.margin ?? QUIET_ZONE_MODULES;
  if (!Number.isSafeInteger(margin) || margin < 0) throw invalid('QR "margin" must be a whole number of modules, 0 or more.');
  const ecc = opts.ecc ?? 'L';
  if (!ECC_LEVELS.includes(ecc)) throw invalid('QR "ecc" must be one of L, M, Q or H.');
  const dark = colour(opts.dark, '#000', 'dark');
  const light = colour(opts.light, '#fff', 'light');
  if (light !== 'none' && luminance(dark) >= luminance(light)) throw invalid('QR "dark" must be darker than "light".');

  let rows: boolean[][];
  try {
    // uqr turns text into UTF-8 with encodeURI, which throws on a lone surrogate.
    rows = encode(text.replace(LONE_SURROGATE, '\uFFFD'), { ecc, boostEcc: true, border: 0 }).data;
  } catch (error) {
    if (error instanceof RangeError) throw invalid('The text is too long for a QR code.');
    throw error;
  }

  const side = rows.length + 2 * margin;
  const background = light === 'none' ? '' : `<path fill='${light}' d='M0-.5h${side}v${side}H0z'/>`;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 -.5 ${side} ${side}' shape-rendering='crispEdges'>` +
    `${background}<path stroke='${dark}' d='${qrPathData(rows, margin)}'/></svg>`;
  return `data:image/svg+xml,${encodeForDataUri(svg)}`;
}
