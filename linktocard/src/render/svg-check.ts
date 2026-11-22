/**
 * Checks and repairs applied to the SVG that Satori produced, right before
 * resvg rasterises it.
 *
 * Cost limits. Checking the output instead of the CSS means var(), calc(),
 * shorthands and inline styles cannot hide a value: whatever the template did,
 * a blur ends up here as a <filter> with an feGaussianBlur.
 *
 * Why these are hard limits: one 60px-blur shadow costs ~2 s of CPU in resvg
 * and 200px traps the wasm module (research/spike-render.md, 7i), and a
 * synchronous wasm call cannot be interrupted once it has started.
 */
import { LIMITS } from '../config';
import { ApiError } from '../lib/errors';

export interface SvgLimits {
  maxSvgBytes: number;
  maxBlurRadiusPx: number;
  maxFilterEffects: number;
}

export interface SvgEffects {
  /** Shadow / blur / filter effects: one per <filter>, plus one per extra blur primitive inside it. */
  effects: number;
  /** Largest Gaussian blur standard deviation found, in px. */
  maxStdDeviation: number;
}

/** Inline <svg> and SVG images are embedded as data: URIs, which can embed further SVGs. */
const MAX_NESTING = 3;

const FILTER_OPEN = /<filter[\s>/]/g;
const STD_DEVIATION = /stdDeviation\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// resvg also applies CSS filter functions written in a `filter` attribute or style of an embedded SVG.
const BLUR_FUNCTION = /\b(blur|drop-shadow)\(([^)]*)\)/gi;
const LENGTH = /([-+]?(?:\d+\.?\d*|\.\d+))([a-z%]*)/gi;
// A quoted data: URI runs to its closing quote (URL-encoded SVG may contain the other quote and
// parentheses); an unquoted one, as in url(data:...), ends at the parenthesis or white space.
const NESTED_SVG = /(["'])data:image\/svg\+xml([^,"']*),([\s\S]*?)\1|data:image\/svg\+xml([^,"'\s)]*),([^"'\s)]*)/gi;

const largestNumber = (text: string): number =>
  Math.max(0, ...[...text.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)].map((match) => Math.abs(Number(match[0]))));

function decodeNested(parameters: string, payload: string): string | undefined {
  try {
    if (!/;base64$/i.test(parameters)) return decodeURIComponent(payload);
    const binary = atob(payload);
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** Counts filter effects and finds the largest blur in an SVG, including SVGs embedded in it as data: URIs. */
export function measureSvgEffects(svg: string, nesting = 0): SvgEffects {
  let effects = 0;
  let maxStdDeviation = 0;

  const filterStarts = [...svg.matchAll(FILTER_OPEN)].map((match) => match.index);
  filterStarts.forEach((start, i) => {
    const end = svg.indexOf('</filter>', start);
    const next = filterStarts[i + 1] ?? svg.length;
    const body = svg.slice(start, end < 0 || end > next ? next : end);
    const blurs = [...body.matchAll(STD_DEVIATION)];
    effects += Math.max(1, blurs.length);
    for (const blur of blurs) maxStdDeviation = Math.max(maxStdDeviation, largestNumber(blur[1] ?? blur[2] ?? ''));
  });

  for (const match of svg.matchAll(BLUR_FUNCTION)) {
    effects += 1;
    // Colours (#123456, rgb(...) up to the first parenthesis) contain digits that are not lengths.
    const lengths = [...match[2]!.replace(/#[0-9a-f]+|[a-z-]+\([^)]*/gi, ' ').matchAll(LENGTH)];
    // blur(<radius>) has one length; drop-shadow(<x> <y> <blur>) carries the blur third.
    const blur = match[1]!.toLowerCase() === 'blur' ? lengths[0] : lengths[2];
    // Only px (or unitless) lengths are measured; em, cm ... are refused rather than converted.
    const radius = !blur ? 0 : /^(?:px)?$/i.test(blur[2]!) ? Math.abs(Number(blur[1])) : Infinity;
    maxStdDeviation = Math.max(maxStdDeviation, radius);
  }

  for (const match of svg.matchAll(NESTED_SVG)) {
    if (nesting >= MAX_NESTING) {
      throw new ApiError('template_error', `SVG images are nested more than ${MAX_NESTING} levels deep.`);
    }
    const nested = decodeNested(match[2] ?? match[4] ?? '', match[3] ?? match[5] ?? '');
    if (nested === undefined) continue;
    const inner = measureSvgEffects(nested, nesting + 1);
    effects += inner.effects;
    maxStdDeviation = Math.max(maxStdDeviation, inner.maxStdDeviation);
  }
  return { effects, maxStdDeviation };
}

/** Throws ApiError('template_error') when the SVG would be too expensive to rasterise. */
export function assertSvgWithinLimits(svg: string, limits: SvgLimits = LIMITS): void {
  // Satori's output is ASCII apart from the odd text node, so code units are a fair byte count.
  if (svg.length > limits.maxSvgBytes) {
    throw new ApiError(
      'template_error',
      `The card is too complex: its intermediate SVG is ${svg.length} bytes; the limit is ${limits.maxSvgBytes}. Use fewer elements or less text.`,
    );
  }
  const { effects, maxStdDeviation } = measureSvgEffects(svg);
  // An SVG Gaussian blur's standard deviation is half the CSS blur radius of a shadow.
  const maxStd = limits.maxBlurRadiusPx / 2;
  if (maxStdDeviation > maxStd) {
    throw new ApiError(
      'template_error',
      `A shadow or blur is too large. box-shadow and text-shadow blur may be at most ${limits.maxBlurRadiusPx}px; ` +
        `filter: blur(), drop-shadow() and backdrop-filter blur at most ${maxStd}px.`,
      { details: { limit: limits.maxBlurRadiusPx } },
    );
  }
  if (effects > limits.maxFilterEffects) {
    throw new ApiError(
      'template_error',
      `The card uses ${effects} shadow / filter effects; the limit is ${limits.maxFilterEffects}. ` +
        'Every box-shadow layer, text-shadow (once per text run), filter and backdrop-filter counts as one.',
      { details: { effects, limit: limits.maxFilterEffects } },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Off-canvas content                                                  */
/* ------------------------------------------------------------------ */

// The exact markup Satori writes for a run of text below a clipping ancestor (overflow: hidden,
// clip-path: both attributes; mask-image: the mask only).
const CLIPPED_TEXT_RUN = /<g mask="url\(#[\w-]+\)"(?: clip-path="url\(#[\w-]+\)")?><path fill="[^"]*" d="([^"]*)"\/><\/g>/g;
const IMAGE_TAG = /<image ([^>]*?)\/>/g;
const PATH_START = /^M(-?[\d.]+)[ ,](-?[\d.]+)/;
const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/g;

interface Canvas {
  width: number;
  height: number;
}

/** Whether a box lies entirely outside the canvas, with a pixel to spare for anti-aliasing. */
const isOffCanvas = (canvas: Canvas, left: number, top: number, right: number, bottom: number): boolean =>
  right < -1 || bottom < -1 || left > canvas.width + 1 || top > canvas.height + 1;

function pathIsOffCanvas(d: string, canvas: Canvas): boolean {
  const start = PATH_START.exec(d);
  // Fast path for nearly every run: it starts on the canvas, so it is (at least partly) visible.
  if (!start || !isOffCanvas(canvas, Number(start[1]), Number(start[2]), Number(start[1]), Number(start[2]))) return false;
  // Only absolute commands made of coordinate pairs (what glyph outlines use) can be measured by listing numbers.
  if (/[^MLQCZ\d\s.,e-]/.test(d)) return false;
  const numbers = d.match(NUMBER) ?? [];
  if (numbers.length % 2 !== 0) return false;
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < numbers.length; i += 2) {
    const x = Number(numbers[i]);
    const y = Number(numbers[i + 1]);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return isOffCanvas(canvas, left, top, right, bottom);
}

function imageIsOffCanvas(attributes: string, canvas: Canvas): boolean {
  // Only clipped or masked images are at risk, and a transform would move the box.
  if (!/ (?:clip-path|mask)="/.test(` ${attributes}`) || attributes.includes('transform="')) return false;
  const number = (name: string): number => Number(new RegExp(`(?:^| )${name}="(-?[\\d.]+)"`).exec(attributes)?.[1] ?? Number.NaN);
  const [x, y, width, height] = [number('x'), number('y'), number('width'), number('height')];
  return [x, y, width, height].every(Number.isFinite) && isOffCanvas(canvas, x, y, x + width, y + height);
}

/**
 * Removes clipped text runs and images that lie entirely outside the canvas.
 *
 * Why: resvg-wasm 2.6.2 traps ("RuntimeError: unreachable") on any clipped or
 * masked element whose bounding box starts more than twice the canvas size
 * away - a three-line SVG reproduces it. Satori leaves out boxes that are
 * outside the image, but not runs of text in inline content, nor text to the
 * left or right of the image; below an overflow: hidden ancestor (the base
 * stylesheet makes <body> one) each run is a clipped group. A long text or a
 * `left: -9999px` would otherwise fail the render. What is removed is
 * invisible by definition. Runs with a stroke, shadow or transform are left
 * alone: their markup is different and their extent is not known here.
 */
export function dropOffCanvasContent(svg: string, canvas: Canvas): string {
  return svg
    .replace(CLIPPED_TEXT_RUN, (group, d: string) => (pathIsOffCanvas(d, canvas) ? '' : group))
    .replace(IMAGE_TAG, (tag, attributes: string) => (imageIsOffCanvas(attributes, canvas) ? '' : tag));
}
