/**
 * The image prompt (AI-SPEC.md section 2). It is built from our own words only: the style, motif
 * and layout enums of src/config.ts AI, colour words for at most AI.maxPaletteColours validated
 * #rrggbb colours, and the fixed negative suffix. No title, description, site name, URL or file
 * name is ever part of it: buildPrompt takes no string a visitor typed, and motif "auto" maps
 * words of the title to a motif id by a fixed keyword table (the title itself is not passed on).
 * This is the prompt filter: there is no free-text prompt to filter.
 */
import { AI, AI_LAYOUTS, AI_MOTIFS, AI_STYLES, type AiLayout, type AiMotif, type AiStyle } from '../config';
import { ApiError } from '../lib/errors';

export type PromptKind = 'cover' | 'qr';

/** Everything that decides a prompt. Each field is an enum value or a validated colour. */
export interface PromptSpec {
  kind: PromptKind;
  style: AiStyle;
  motif: AiMotif;
  layout: AiLayout;
  /** #rrggbb, lower case, at most AI.maxPaletteColours. */
  palette: readonly string[];
}

const HEX = /^#[0-9a-f]{6}$/;

function invalid(message: string, field: string): ApiError {
  return new ApiError('invalid_request', message, { details: { field } });
}

export function parseStyle(value: unknown, field = 'style'): AiStyle {
  if (typeof value === 'string' && (AI_STYLES as readonly string[]).includes(value)) return value as AiStyle;
  throw invalid(`"${field}" must be one of ${AI_STYLES.join(', ')}.`, field);
}

/** A motif id, or "auto" (resolved from the title by resolveMotif). Undefined means "auto". */
export function parseMotif(value: unknown, field = 'motif'): AiMotif | 'auto' {
  if (value === undefined || value === 'auto') return 'auto';
  if (typeof value === 'string' && (AI_MOTIFS as readonly string[]).includes(value)) return value as AiMotif;
  throw invalid(`"${field}" must be "auto" or one of ${AI_MOTIFS.join(', ')}.`, field);
}

export function parseLayout(value: unknown, field = 'layout'): AiLayout {
  if (value === undefined) return 'left';
  if (typeof value === 'string' && (AI_LAYOUTS as readonly string[]).includes(value)) return value as AiLayout;
  throw invalid(`"${field}" must be one of ${AI_LAYOUTS.join(', ')}.`, field);
}

/** Up to AI.maxPaletteColours colours, each exactly #rrggbb (any case; returned lower case). */
export function parsePalette(value: unknown, field = 'palette'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI.maxPaletteColours) {
    throw invalid(`"${field}" must be a list of at most ${AI.maxPaletteColours} colours like "#1d4ed8".`, field);
  }
  return value.map((colour, index) => {
    if (typeof colour !== 'string' || !HEX.test(colour.toLowerCase())) {
      throw invalid(`"${field}[${index}]" must be a colour written as # and six hexadecimal digits, like "#1d4ed8".`, field);
    }
    return colour.toLowerCase();
  });
}

/** Lower-case words of a text (letters and digits of any script). */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * motif "auto": the first motif of AI.motifKeywords (in its order) with a word of the title that
 * starts with one of its stems; a stem of three letters or fewer must be the whole word. Returns
 * only a motif id, never text of the title.
 */
export function resolveMotif(motif: AiMotif | 'auto', title: string): AiMotif {
  if (motif !== 'auto') return motif;
  const found = words(title);
  for (const [id, stems] of Object.entries(AI.motifKeywords) as [AiMotif, readonly string[]][]) {
    if (stems.some((stem) => found.some((word) => (stem.length <= 3 ? word === stem : word.startsWith(stem))))) return id;
  }
  return AI.defaultMotif;
}

/* ------------------------------------------------------------------ */
/* Colour words                                                        */
/* ------------------------------------------------------------------ */

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number];
}

const HUES: readonly [number, string][] = [
  [15, 'red'],
  [40, 'orange'],
  [65, 'yellow'],
  [80, 'lime'],
  [160, 'green'],
  [190, 'teal'],
  [250, 'blue'],
  [290, 'purple'],
  [330, 'pink'],
  [360, 'red'],
];

/** A plain colour name for a #rrggbb value: "dark blue", "light orange", "grey", ... */
export function colourName(hex: string): string {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const shade = lightness < 0.3 ? 'dark ' : lightness > 0.75 ? 'light ' : '';
  if (saturation < 0.15 || delta < 0.06) {
    if (lightness < 0.12) return 'black';
    if (lightness > 0.94) return 'white';
    return `${shade}grey`;
  }
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  const name = HUES.find(([limit]) => hue < limit)?.[1] ?? 'red';
  return `${shade}${name}`;
}

function paletteWords(palette: readonly string[]): string {
  if (palette.length === 0) return 'a harmonious, calm colour palette';
  return `a colour palette of ${palette.map((hex) => `${colourName(hex)} (${hex})`).join(', ')}`;
}

/**
 * The prompt for one background. Every word comes from AI (src/config.ts) or from colourName of a
 * validated colour; tests/ai-prompt.test.ts proves that no field of a request can reach it.
 */
export function buildPrompt(spec: PromptSpec): string {
  if (!(AI_STYLES as readonly string[]).includes(spec.style)) throw new Error(`unknown style ${spec.style}`);
  if (!(AI_MOTIFS as readonly string[]).includes(spec.motif)) throw new Error(`unknown motif ${spec.motif}`);
  if (!(AI_LAYOUTS as readonly string[]).includes(spec.layout)) throw new Error(`unknown layout ${spec.layout}`);
  if (spec.palette.length > AI.maxPaletteColours || !spec.palette.every((hex) => HEX.test(hex))) throw new Error('invalid palette');
  const composition = spec.kind === 'qr' ? AI.qrLayout : AI.layouts[spec.layout];
  return [
    `Background illustration of ${AI.motifs[spec.motif]}.`,
    `Style: ${AI.styles[spec.style]}.`,
    `Colours: ${paletteWords(spec.palette)}.`,
    `Composition: ${composition}.`,
    AI.negativeSuffix,
  ].join(' ');
}
