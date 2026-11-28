// Text measurement without the text engine: advance widths of the bundled Inter subsets
// (inter-widths.ts, generated from the font files by scripts/gen-chart-widths.mjs; run it again
// when the fonts under src/render/fonts change). Satori's own measurement agrees with these
// sums to within a pixel; kerning only ever makes the real text a little narrower.
import { INTER_WIDTHS } from './inter-widths'

export type Weight = 400 | 600

const ELLIPSIS = '…'
/** Width guesses, in 1/1000 em, for characters the bundled fonts do not have (drawn as empty boxes). */
const UNKNOWN_WIDE = 1000
const UNKNOWN_NARROW = 620

function buildTable(weight: Weight): Map<number, number> {
  const table = new Map<number, number>()
  for (const run of INTER_WIDTHS[weight]) {
    for (let i = 1; i < run.length; i++) table.set(run[0]! + i - 1, run[i]!)
  }
  return table
}

// Built once per isolate, on first use.
const tables: Partial<Record<Weight, Map<number, number>>> = {}
const tableFor = (weight: Weight): Map<number, number> => (tables[weight] ??= buildTable(weight))

function advance(char: string, table: Map<number, number>): number {
  const code = char.codePointAt(0)!
  return table.get(code) ?? (code >= 0x2e80 ? UNKNOWN_WIDE : UNKNOWN_NARROW)
}

/** Width of one line of text in px. */
export function textWidth(text: string, size: number, weight: Weight = 400): number {
  const table = tableFor(weight)
  let units = 0
  for (const char of text) units += advance(char, table)
  return (units * size) / 1000
}

/** False when the text has characters outside the bundled fonts, so its measured width is a guess. */
export function isMeasurable(text: string): boolean {
  const table = tableFor(400)
  for (const char of text) if (!table.has(char.codePointAt(0)!)) return false
  return true
}

/** The text itself if it fits in `maxWidth`, otherwise its longest beginning that fits with an ellipsis ('' if not even that fits). */
export function fitText(text: string, maxWidth: number, size: number, weight: Weight = 400): string {
  if (textWidth(text, size, weight) <= maxWidth) return text
  const table = tableFor(weight)
  const budget = (maxWidth * 1000) / size - advance(ELLIPSIS, table)
  let units = 0
  let kept = ''
  for (const char of text) {
    units += advance(char, table)
    if (units > budget) break
    kept += char
  }
  kept = kept.trimEnd()
  return kept ? kept + ELLIPSIS : ''
}
