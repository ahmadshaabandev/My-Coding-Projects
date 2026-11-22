// The 30 WOFF files below were copied from @fontsource/* (see research/spike-render.md).
//
// IMPORTANT (verified against satori@0.63.2, src/font.ts):
//  - Satori keeps ONE font per (family name, weight, style). Several entries with the same
//    name+weight+style do NOT fall back per glyph: only the first one registered is used.
//    Therefore every unicode-range subset file is registered under its OWN family name.
//  - Per-glyph fallback walks: the families listed in `fontFamily` (in order), then every
//    other registered family in registration order. To keep a serif heading from falling
//    back to "Inter Latin Ext" for e.g. "ł", every font-family list is expanded to the full
//    subset stack of each logical family (expandFontFamilies()).
//  - Keep `FONTS` a module-level constant: Satori caches the parsed fonts in a WeakMap
//    keyed by this array's identity (and by each ArrayBuffer's identity).
import type { LoadedFont } from '../types'
import type { FontFamilyItem } from './css'
import interLatin400Normal from './fonts/inter-latin-400-normal.woff'
import interLatin600Normal from './fonts/inter-latin-600-normal.woff'
import interLatin700Normal from './fonts/inter-latin-700-normal.woff'
import interLatin800Normal from './fonts/inter-latin-800-normal.woff'
import interLatinExt400Normal from './fonts/inter-latin-ext-400-normal.woff'
import interLatinExt600Normal from './fonts/inter-latin-ext-600-normal.woff'
import interLatinExt700Normal from './fonts/inter-latin-ext-700-normal.woff'
import interLatinExt800Normal from './fonts/inter-latin-ext-800-normal.woff'
import interCyrillic400Normal from './fonts/inter-cyrillic-400-normal.woff'
import interCyrillic600Normal from './fonts/inter-cyrillic-600-normal.woff'
import interCyrillic700Normal from './fonts/inter-cyrillic-700-normal.woff'
import interCyrillic800Normal from './fonts/inter-cyrillic-800-normal.woff'
import interGreek400Normal from './fonts/inter-greek-400-normal.woff'
import interGreek600Normal from './fonts/inter-greek-600-normal.woff'
import interGreek700Normal from './fonts/inter-greek-700-normal.woff'
import interGreek800Normal from './fonts/inter-greek-800-normal.woff'
import interVietnamese400Normal from './fonts/inter-vietnamese-400-normal.woff'
import interVietnamese600Normal from './fonts/inter-vietnamese-600-normal.woff'
import interVietnamese700Normal from './fonts/inter-vietnamese-700-normal.woff'
import interVietnamese800Normal from './fonts/inter-vietnamese-800-normal.woff'
import sourceSerif4Latin400Normal from './fonts/source-serif-4-latin-400-normal.woff'
import sourceSerif4Latin600Normal from './fonts/source-serif-4-latin-600-normal.woff'
import sourceSerif4Latin400Italic from './fonts/source-serif-4-latin-400-italic.woff'
import sourceSerif4LatinExt400Normal from './fonts/source-serif-4-latin-ext-400-normal.woff'
import sourceSerif4LatinExt600Normal from './fonts/source-serif-4-latin-ext-600-normal.woff'
import sourceSerif4LatinExt400Italic from './fonts/source-serif-4-latin-ext-400-italic.woff'
import jetbrainsMonoLatin400Normal from './fonts/jetbrains-mono-latin-400-normal.woff'
import jetbrainsMonoLatin700Normal from './fonts/jetbrains-mono-latin-700-normal.woff'
import jetbrainsMonoLatinExt400Normal from './fonts/jetbrains-mono-latin-ext-400-normal.woff'
import jetbrainsMonoLatinExt700Normal from './fonts/jetbrains-mono-latin-ext-700-normal.woff'

export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
export interface RenderFont {
  name: string
  data: ArrayBuffer
  weight: FontWeight
  style: 'normal' | 'italic'
}

export const FONTS: RenderFont[] = [
  { name: "Inter", data: interLatin400Normal, weight: 400, style: 'normal' },
  { name: "Inter", data: interLatin600Normal, weight: 600, style: 'normal' },
  { name: "Inter", data: interLatin700Normal, weight: 700, style: 'normal' },
  { name: "Inter", data: interLatin800Normal, weight: 800, style: 'normal' },
  { name: "Inter Latin Ext", data: interLatinExt400Normal, weight: 400, style: 'normal' },
  { name: "Inter Latin Ext", data: interLatinExt600Normal, weight: 600, style: 'normal' },
  { name: "Inter Latin Ext", data: interLatinExt700Normal, weight: 700, style: 'normal' },
  { name: "Inter Latin Ext", data: interLatinExt800Normal, weight: 800, style: 'normal' },
  { name: "Inter Cyrillic", data: interCyrillic400Normal, weight: 400, style: 'normal' },
  { name: "Inter Cyrillic", data: interCyrillic600Normal, weight: 600, style: 'normal' },
  { name: "Inter Cyrillic", data: interCyrillic700Normal, weight: 700, style: 'normal' },
  { name: "Inter Cyrillic", data: interCyrillic800Normal, weight: 800, style: 'normal' },
  { name: "Inter Greek", data: interGreek400Normal, weight: 400, style: 'normal' },
  { name: "Inter Greek", data: interGreek600Normal, weight: 600, style: 'normal' },
  { name: "Inter Greek", data: interGreek700Normal, weight: 700, style: 'normal' },
  { name: "Inter Greek", data: interGreek800Normal, weight: 800, style: 'normal' },
  { name: "Inter Vietnamese", data: interVietnamese400Normal, weight: 400, style: 'normal' },
  { name: "Inter Vietnamese", data: interVietnamese600Normal, weight: 600, style: 'normal' },
  { name: "Inter Vietnamese", data: interVietnamese700Normal, weight: 700, style: 'normal' },
  { name: "Inter Vietnamese", data: interVietnamese800Normal, weight: 800, style: 'normal' },
  { name: "Source Serif 4", data: sourceSerif4Latin400Normal, weight: 400, style: 'normal' },
  { name: "Source Serif 4", data: sourceSerif4Latin600Normal, weight: 600, style: 'normal' },
  { name: "Source Serif 4", data: sourceSerif4Latin400Italic, weight: 400, style: 'italic' },
  { name: "Source Serif 4 Latin Ext", data: sourceSerif4LatinExt400Normal, weight: 400, style: 'normal' },
  { name: "Source Serif 4 Latin Ext", data: sourceSerif4LatinExt600Normal, weight: 600, style: 'normal' },
  { name: "Source Serif 4 Latin Ext", data: sourceSerif4LatinExt400Italic, weight: 400, style: 'italic' },
  { name: "JetBrains Mono", data: jetbrainsMonoLatin400Normal, weight: 400, style: 'normal' },
  { name: "JetBrains Mono", data: jetbrainsMonoLatin700Normal, weight: 700, style: 'normal' },
  { name: "JetBrains Mono Latin Ext", data: jetbrainsMonoLatinExt400Normal, weight: 400, style: 'normal' },
  { name: "JetBrains Mono Latin Ext", data: jetbrainsMonoLatinExt700Normal, weight: 700, style: 'normal' },
]

/** Logical family -> ordered list of Satori family names (one per subset file). */
export const FONT_STACKS = {
  "Inter": ["Inter","Inter Latin Ext","Inter Cyrillic","Inter Greek","Inter Vietnamese"],
  "Source Serif 4": ["Source Serif 4","Source Serif 4 Latin Ext"],
  "JetBrains Mono": ["JetBrains Mono","JetBrains Mono Latin Ext"],
} as const

export type FontFamily = keyof typeof FONT_STACKS

const quoteFamily = (name: string): string => JSON.stringify(name)

/** CSS `font-family` value for Satori: the logical family expanded to all of its subsets. */
export function fontStack(family: FontFamily): string {
  return FONT_STACKS[family].map(quoteFamily).join(', ')
}

export interface FontVariant {
  weight: number
  style: 'normal' | 'italic'
}

const variantsOf = (family: FontFamily): FontVariant[] =>
  FONTS.filter((font) => font.name === family).map(({ weight, style }) => ({ weight, style }))

/** Bundled families with the weights and styles each one ships (derived from FONTS, so it cannot drift). */
export const BUILTIN_FONT_FAMILIES: Record<FontFamily, FontVariant[]> = {
  "Inter": variantsOf("Inter"),
  "Source Serif 4": variantsOf("Source Serif 4"),
  "JetBrains Mono": variantsOf("JetBrains Mono"),
}

/** Satori gives generic families no meaning ("generic families select nothing"), so they are mapped here. */
export const GENERIC_FONT_FAMILIES: Record<string, FontFamily> = {
  'sans-serif': "Inter",
  'system-ui': "Inter",
  'ui-sans-serif': "Inter",
  'serif': "Source Serif 4",
  'ui-serif': "Source Serif 4",
  'monospace': "JetBrains Mono",
  'ui-monospace': "JetBrains Mono",
}

const BUNDLED_BY_NAME = new Map<string, FontFamily>([
  ...Object.entries(GENERIC_FONT_FAMILIES),
  ...(Object.keys(FONT_STACKS) as FontFamily[]).map((family): [string, FontFamily] => [family.toLowerCase(), family]),
])

/** The bundled family a CSS family name (or generic keyword) stands for; names are case-insensitive. */
export function bundledFamily(name: string): FontFamily | undefined {
  return BUNDLED_BY_NAME.get(name.toLowerCase())
}

/**
 * A parsed font-family list rewritten for Satori: bundled and generic names become their
 * subset stacks, names in `customFamilies` (lower-cased) are kept, every other name is
 * reported through `onMissing` and left out. A list with nothing usable becomes Inter.
 */
export function expandFontFamilies(
  items: readonly FontFamilyItem[],
  customFamilies: ReadonlySet<string>,
  onMissing: (name: string) => void,
): string {
  const out = new Set<string>()
  for (const item of items) {
    if (item.kind === 'raw') {
      out.add(item.text)
      continue
    }
    const bundled = bundledFamily(item.name)
    if (bundled) for (const subset of FONT_STACKS[bundled]) out.add(quoteFamily(subset))
    else if (customFamilies.has(item.name.toLowerCase())) out.add(quoteFamily(item.name))
    else onMissing(item.name)
  }
  return out.size > 0 ? [...out].join(', ') : fontStack("Inter")
}

const toWeight = (weight: number): FontWeight => (Math.min(900, Math.max(100, Math.round(weight / 100) * 100)) || 400) as FontWeight

interface CombinedFonts {
  custom: readonly LoadedFont[]
  fonts: RenderFont[]
}
// Satori keeps at most 8 font loaders alive; remembering more combinations would not avoid a re-parse.
const MAX_COMBINED = 8
const combined: CombinedFonts[] = []

const sameFont = (a: LoadedFont, b: LoadedFont): boolean =>
  a.data === b.data && a.family === b.family && a.weight === b.weight && a.style === b.style

/**
 * FONTS plus customer fonts. The result is memoised by the identity of each font's data
 * buffer, so renders that use the same customer fonts hand Satori the same array and hit
 * its parsed-font cache instead of re-parsing ~30 fonts.
 */
export function fontsWith(custom: readonly LoadedFont[]): RenderFont[] {
  if (custom.length === 0) return FONTS
  const index = combined.findIndex((entry) => entry.custom.length === custom.length && entry.custom.every((font, i) => sameFont(font, custom[i]!)))
  if (index >= 0) {
    const [hit] = combined.splice(index, 1)
    combined.push(hit!)
    return hit!.fonts
  }
  const fonts: RenderFont[] = [
    ...FONTS,
    ...custom.map((font): RenderFont => ({ name: font.family, data: font.data, weight: toWeight(font.weight), style: font.style })),
  ]
  combined.push({ custom: custom.map((font) => ({ ...font })), fonts })
  if (combined.length > MAX_COMBINED) combined.shift()
  return fonts
}
