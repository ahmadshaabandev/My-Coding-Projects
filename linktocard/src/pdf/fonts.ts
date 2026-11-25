/**
 * The bundled fonts, embedded in a PDF document as base64 @font-face rules under the family
 * names 'Inter', 'Source Serif 4' and 'JetBrains Mono' (the same WOFF files the image renderer
 * uses; see src/render/fonts.ts and its LICENSES folder).
 *
 * Embedded weights and styles (every file there is):
 *   Inter           400, 600, 700, 800 normal
 *   Source Serif 4  400, 600 normal; 400 italic
 *   JetBrains Mono  400, 700 normal
 *
 * To keep the request to the browser small, a family is embedded only when the document's CSS
 * names it, and each family's subsets beyond Latin (Latin Extended, Cyrillic, Greek,
 * Vietnamese) only when the document's text has a character in that subset's unicode-range.
 * Characters the bundled fonts do not cover fall back to the browser's own fonts.
 *
 * This module imports font files, so it runs only inside the Worker (and its test pool);
 * src/pdf/template.ts takes it as an optional dependency and stays importable from Node.
 */
import { base64Encode } from '../lib/crypto';
import { FONTS, FONT_STACKS, type FontFamily } from '../render/fonts';

type Subset = 'latin' | 'latin-ext' | 'cyrillic' | 'greek' | 'vietnamese';
type Range = readonly [from: number, to: number];

/** Unicode ranges of the @fontsource subsets the files were taken from. */
const SUBSET_RANGES: Record<Subset, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  vietnamese: 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
};

const SUBSET_SUFFIXES: ReadonlyArray<[suffix: string, subset: Subset]> = [
  [' Latin Ext', 'latin-ext'],
  [' Cyrillic', 'cyrillic'],
  [' Greek', 'greek'],
  [' Vietnamese', 'vietnamese'],
];

function parseRanges(list: string): Range[] {
  return list.split(',').map((part) => {
    const [from, to] = part.replace(/^U\+/i, '').split('-');
    return [Number.parseInt(from!, 16), Number.parseInt(to ?? from!, 16)] as const;
  });
}

const PARSED_RANGES = Object.fromEntries(Object.entries(SUBSET_RANGES).map(([subset, list]) => [subset, parseRanges(list)])) as Record<Subset, Range[]>;
const EXTRA_SUBSETS = (Object.keys(SUBSET_RANGES) as Subset[]).filter((subset) => subset !== 'latin');

interface FontFile {
  family: FontFamily;
  subset: Subset;
  weight: number;
  style: 'normal' | 'italic';
  data: ArrayBuffer;
}

/** Every bundled file with its logical family and subset (Satori registers each subset under its own name). */
const FILES: FontFile[] = (Object.keys(FONT_STACKS) as FontFamily[]).flatMap((family) =>
  FONTS.filter((font) => (FONT_STACKS[family] as readonly string[]).includes(font.name)).map((font) => {
    const subset = font.name === family ? 'latin' : (SUBSET_SUFFIXES.find(([suffix]) => font.name === `${family}${suffix}`)?.[1] ?? 'latin');
    return { family, subset, weight: font.weight, style: font.style, data: font.data };
  }),
);

const FAMILY_BY_LOWER = new Map((Object.keys(FONT_STACKS) as FontFamily[]).map((family) => [family.toLowerCase(), family]));

/** base64 of each file, computed once per isolate. */
const encoded = new WeakMap<ArrayBuffer, string>();

function base64Of(data: ArrayBuffer): string {
  let value = encoded.get(data);
  if (value === undefined) {
    value = base64Encode(data);
    encoded.set(data, value);
  }
  return value;
}

/** The subsets beyond Latin that some character of `text` needs. */
export function subsetsFor(text: string): Set<Subset> {
  const needed = new Set<Subset>();
  const seen = new Set<number>();
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // Plain Latin-1 is always embedded; each other code point is looked up once.
    if (code < 0x100 || seen.has(code)) continue;
    seen.add(code);
    for (const subset of EXTRA_SUBSETS) {
      if (!needed.has(subset) && PARSED_RANGES[subset].some(([from, to]) => code >= from && code <= to)) needed.add(subset);
    }
    if (needed.size === EXTRA_SUBSETS.length) break;
  }
  return needed;
}

function fontFace(file: FontFile): string {
  return (
    `@font-face{font-family:'${file.family}';font-style:${file.style};font-weight:${file.weight};font-display:block;` +
    `src:url("data:font/woff;base64,${base64Of(file.data)}") format("woff");unicode-range:${SUBSET_RANGES[file.subset]}}`
  );
}

/**
 * @font-face rules for the bundled families in `families` (lower-case names, as
 * src/pdf/css.ts reports them), with the subsets `text` needs. '' when none is used.
 */
export function bundledFontFaces(families: ReadonlySet<string>, text: string): string {
  const wanted = new Set([...families].map((name) => FAMILY_BY_LOWER.get(name)).filter((family) => family !== undefined));
  if (wanted.size === 0) return '';
  const subsets = subsetsFor(text);
  return FILES.filter((file) => wanted.has(file.family) && (file.subset === 'latin' || subsets.has(file.subset)))
    .map(fontFace)
    .join('');
}
