/**
 * The render pipeline: HTML + CSS + data -> PNG / JPEG / WebP.
 *
 *   compile   parseTemplate + bindTemplate          (template.ts, css.ts)
 *   resources deps.fetchImage / deps.loadFonts      (the renderer never calls fetch itself)
 *   layout    Satori -> SVG, then the cost limits   (engine.ts, guard.ts, svg-check.ts)
 *   watermark stamped into the SVG                  (watermark.ts)
 *   raster    resvg -> pixels -> encoder            (engine.ts)
 *
 * Every failure is an ApiError; a failed render returns no bytes.
 */
import { CONTENT_TYPES, FORMATS, LIMITS, SIZES } from '../config';
import { ApiError } from '../lib/errors';
import type { LoadedFont, RenderDeps, RenderInput, RenderOutput, WatermarkMode } from '../types';
import { encodeSvg, RenderInputError, renderSvg, warmUp as warmUpEngine, type SvgOptions, type VNode } from './engine';
import { bundledFamily, expandFontFamilies, fontsWith } from './fonts';
import { assertSvgWithinLimits, dropOffCanvasContent } from './svg-check';
import { bindStaticTemplate, bindTemplate, buildDocument, canonicalDataUri, parseTemplate, type BoundTemplate } from './template';
import { stampWatermark, watermarkMarkup } from './watermark';

export { BASE_CSS } from './template';
export { BUILTIN_FONT_FAMILIES, GENERIC_FONT_FAMILIES } from './fonts';

type Warn = (message: string) => void;

const WATERMARK_MODES: readonly WatermarkMode[] = ['none', 'free', 'preview'];
const MAX_WARNINGS = 20;
const MAX_WARNING_CHARS = 240;

/** Drawn in place of an emoji that has no image: blank, never a tofu box. */
const BLANK_GLYPH = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')}`;

/** Satori's language codes for text no loaded font covers (its src/language.ts). */
const SCRIPT_NAMES: Record<string, string> = {
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Chinese',
  'zh-TW': 'Chinese',
  'zh-HK': 'Chinese',
  'th-TH': 'Thai',
  'bn-IN': 'Bengali',
  'ar-AR': 'Arabic',
  'ta-IN': 'Tamil',
  'ml-IN': 'Malayalam',
  'he-IL': 'Hebrew',
  'te-IN': 'Telugu',
  devanagari: 'Devanagari',
  kannada: 'Kannada',
  symbol: 'symbol',
  math: 'math symbol',
};

const scriptName = (code: string): string =>
  [...new Set(code.split('|').map((part) => SCRIPT_NAMES[part] ?? 'unsupported-script'))].join(' / ');

const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/* ------------------------------------------------------------------ */
/* Time budget                                                         */
/* ------------------------------------------------------------------ */

interface Budget {
  /** Rejects with render_timeout if `work` is still pending when the budget runs out. */
  race<T>(work: Promise<T>): Promise<T>;
  /** Throws render_timeout if the budget ran out during synchronous work. */
  check(): void;
  stop(): void;
}

/**
 * Wasm calls (layout, rasterising, encoding) are synchronous and cannot be
 * interrupted, so the budget is enforced around the async stages and checked
 * between the synchronous ones; the input limits bound the rest.
 */
function startBudget(ms: number): Budget {
  const deadline = Date.now() + ms;
  const expired = (): ApiError => new ApiError('render_timeout', `Rendering took longer than ${ms} ms and was stopped.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(expired()), ms);
  });
  timeout.catch(() => undefined);
  return {
    race: (work) => {
      // The loser of the race keeps running; its eventual rejection must not go unhandled.
      work.catch(() => undefined);
      return Promise.race([work, timeout]);
    },
    check: () => {
      if (Date.now() > deadline) throw expired();
    },
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

interface ResourceRequests {
  /** Distinct remote image URLs, normalised. */
  imageUrls: string[];
  /** Font families that are not bundled, as written in the template. */
  fontFamilies: string[];
}

/** First pass over the document: which remote images and which non-bundled fonts does it use? */
function collectRequests(bound: BoundTemplate, warn: Warn): ResourceRequests {
  const urls = new Set<string>();
  const families = new Map<string, string>();
  buildDocument(
    bound,
    {
      image: (reference) => {
        if (reference.kind === 'remote') urls.add(reference.url);
        return '';
      },
      fontFamilies: (items) => {
        for (const item of items) {
          if (item.kind !== 'name' || bundledFamily(item.name)) continue;
          const key = item.name.toLowerCase();
          // Family names are case-insensitive; the first spelling is the one asked for.
          if (!families.has(key)) families.set(key, item.name);
        }
        return '';
      },
    },
    warn,
  );
  if (urls.size > LIMITS.maxImagesPerRender) {
    throw new ApiError('template_error', `The card references ${urls.size} remote images; the limit is ${LIMITS.maxImagesPerRender}.`, {
      details: { images: urls.size, limit: LIMITS.maxImagesPerRender },
    });
  }
  return { imageUrls: [...urls], fontFamilies: [...families.values()] };
}

async function loadImage(url: string, deps: RenderDeps): Promise<string> {
  let dataUri: unknown;
  try {
    ({ dataUri } = await deps.fetchImage(url));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('image_fetch_failed', `Could not load image ${shorten(url, 120)}.`);
  }
  const uri = typeof dataUri === 'string' ? canonicalDataUri(dataUri) : undefined;
  if (!uri) throw new ApiError('image_fetch_failed', `Image ${shorten(url, 120)} is not a PNG, JPEG, GIF or SVG image.`);
  return uri;
}

async function loadImages(urls: readonly string[], deps: RenderDeps): Promise<Map<string, string>> {
  const loaded = await Promise.all(urls.map(async (url) => [url, await loadImage(url, deps)] as const));
  return new Map(loaded);
}

/** Satori splits font-family lists on commas and strips one pair of quotes, so such names cannot be addressed. */
const USABLE_FAMILY_NAME = /^[^",\\]+$/;

async function loadCustomFonts(families: readonly string[], deps: RenderDeps): Promise<LoadedFont[]> {
  if (families.length === 0 || !deps.loadFonts) return [];
  let fonts: LoadedFont[];
  try {
    fonts = await deps.loadFonts([...families]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Falling back to Inter here would cache a card in the wrong typeface.
    throw new ApiError('render_failed', 'The fonts for this card could not be loaded.');
  }
  const requested = new Set(families.map((family) => family.toLowerCase()));
  return fonts.filter(
    (font) =>
      requested.has(font.family.toLowerCase()) &&
      USABLE_FAMILY_NAME.test(font.family) &&
      font.data instanceof ArrayBuffer &&
      (font.style === 'normal' || font.style === 'italic'),
  );
}

/** Answers Satori's requests for glyphs no loaded font has. Never does network I/O itself. */
function assetLoader(deps: RenderDeps, warn: Warn): NonNullable<SvgOptions['loadAdditionalAsset']> {
  return async (languageCode, segment) => {
    if (languageCode !== 'emoji') {
      warn(`No bundled font covers ${scriptName(languageCode)} characters ("${shorten(segment, 24)}"); they render as empty boxes.`);
      return [];
    }
    let image: string | undefined;
    try {
      image = await deps.loadEmoji?.(segment);
    } catch {
      image = undefined;
    }
    const uri = image === undefined ? undefined : canonicalDataUri(image);
    if (uri) return uri;
    warn(`Emoji ${segment} is not available and was left blank.`);
    return BLANK_GLYPH;
  };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Messages Satori throws for images it cannot measure (its src/handler/image.ts and compute.ts). */
const IMAGE_ERROR = /^(?:Image size cannot be determined|Failed to parse SVG|Image source|Unsupported image type)/;

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // The guard's messages name the offending element or URL and contain nothing internal.
  if (error instanceof RenderInputError) return new ApiError('template_error', error.message);
  if (error instanceof Error && IMAGE_ERROR.test(error.message)) {
    return new ApiError(
      'image_fetch_failed',
      'An image could not be decoded. Raster images must be valid PNG, JPEG or GIF files; SVG images need a viewBox or a width and height.',
    );
  }
  // Logged for the operator; the caller only learns that the render failed.
  console.error('[render] unexpected failure:', error);
  return new ApiError('render_failed', 'The card could not be rendered.');
}

function assertOutput(input: RenderInput): void {
  const { width, height, format } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > LIMITS.maxRenderPixels) {
    const sizes = Object.values(SIZES).map((size) => `${size.width}x${size.height}`);
    throw new ApiError('unsupported_size', `Unsupported size ${width}x${height}. Supported sizes: ${sizes.join(', ')}.`);
  }
  if (!FORMATS.includes(format)) {
    throw new ApiError('unsupported_format', `Unsupported format "${String(format)}". Supported formats: ${FORMATS.join(', ')}.`);
  }
  // An unknown mode must not silently become "no watermark".
  if (!WATERMARK_MODES.includes(input.watermark)) {
    throw new ApiError('invalid_request', `Unknown watermark mode "${String(input.watermark)}".`);
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Renders one card. Remote images, emoji and customer fonts come from `deps`;
 * the same input and the same resources always produce the same bytes.
 */
export async function renderCard(input: RenderInput, deps: RenderDeps): Promise<RenderOutput> {
  const { width, height, format } = input;
  const started = performance.now();
  const warnings = new Set<string>();
  const warn: Warn = (message) => warnings.add(shorten(message, MAX_WARNING_CHARS));
  const budget = startBudget(LIMITS.renderTimeoutMs);
  try {
    assertOutput(input);

    const bound = bindTemplate(parseTemplate(input.html, input.css), input.data, { width, height });
    bound.warnings.forEach(warn);
    const requests = collectRequests(bound, warn);
    const compiled = performance.now();

    const [images, customFonts] = await budget.race(
      Promise.all([loadImages(requests.imageUrls, deps), loadCustomFonts(requests.fontFamilies, deps)]),
    );
    const loaded = performance.now();

    const customFamilies = new Set(customFonts.map((font) => font.family.toLowerCase()));
    const missingFamilies = new Set<string>();
    const document: VNode = buildDocument(
      bound,
      {
        image: (reference) => {
          if (reference.kind === 'fragment') return reference.id;
          return reference.kind === 'data' ? reference.uri : images.get(reference.url)!;
        },
        fontFamilies: (items) => expandFontFamilies(items, customFamilies, (name) => missingFamilies.add(name)),
      },
      warn,
    );
    if (missingFamilies.size > 0) {
      warn(`Font families not available: ${[...missingFamilies].join(', ')}. Text uses the next family in the list, or Inter.`);
    }

    const drawn = await budget.race(
      renderSvg(document, {
        width,
        height,
        fonts: fontsWith(customFonts),
        loadAdditionalAsset: assetLoader(deps, warn),
        // Without a handler one invalid inline declaration fails the whole render.
        onStyleError: (error) => warn(`Ignored style: ${error.message}`),
      }),
    );
    let svg = dropOffCanvasContent(drawn, { width, height });
    assertSvgWithinLimits(svg);
    if (input.watermark !== 'none') {
      svg = stampWatermark(svg, await budget.race(watermarkMarkup(width, height, input.watermark)));
    }
    budget.check();
    const laidOut = performance.now();

    const image = await encodeSvg(svg, width, format);
    budget.check();

    return {
      bytes: image.bytes,
      contentType: CONTENT_TYPES[format],
      width,
      height,
      warnings: [...warnings].slice(0, MAX_WARNINGS),
      timings: {
        compileMs: compiled - started,
        imagesMs: loaded - compiled,
        layoutMs: laidOut - loaded,
        rasterMs: image.rasterMs,
        encodeMs: image.encodeMs,
        totalMs: performance.now() - started,
      },
    };
  } catch (error) {
    throw toApiError(error);
  } finally {
    budget.stop();
  }
}

/**
 * Static checks for a template that is being saved: source sizes, structure,
 * disallowed markup, URL schemes and the image count of everything that does
 * not depend on data. Throws the same ApiErrors as renderCard; renders nothing.
 */
export function validateTemplate(html: string, css: string): { warnings: string[] } {
  const warnings = new Set<string>();
  const warn: Warn = (message) => warnings.add(shorten(message, MAX_WARNING_CHARS));
  try {
    const bound = bindStaticTemplate(parseTemplate(html, css));
    bound.warnings.forEach(warn);
    collectRequests(bound, warn);
  } catch (error) {
    throw toApiError(error);
  }
  return { warnings: [...warnings].slice(0, MAX_WARNINGS) };
}

/** Instantiates the wasm modules and parses the bundled fonts, so the first card does not pay for it. */
export async function warmUp(): Promise<void> {
  await warmUpEngine();
  await renderSvg({ type: 'div', props: { children: 'Aa' } }, { width: 16, height: 16 });
}
