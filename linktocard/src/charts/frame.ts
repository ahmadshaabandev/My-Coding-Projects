// What every chart has around its marks: title block, legend, and the rules for value labels.
import type { Chart } from './spec'
import { overlaps, type Rect, type Shape, type Text } from './scene'
import { fitText, textWidth, type Weight } from './text'
import { lineHeight, type Sizes, type Theme } from './theme'

/** A piece of a chart: shapes and texts, in drawing order. */
export interface Part {
  shapes: Shape[]
  texts: Text[]
}

export const merge = (...parts: Part[]): Part => ({ shapes: parts.flatMap((part) => part.shapes), texts: parts.flatMap((part) => part.texts) })

interface TextStyle {
  size: number
  color: string
  align?: Text['align']
  weight?: Weight
}

/** A one-line text box at (x, y) that is `width` wide; text that is too long is cut with an ellipsis. */
export function textBox(text: string, x: number, y: number, width: number, style: TextStyle): Text {
  const weight = style.weight ?? 400
  return { x, y, w: width, h: lineHeight(style.size), text: fitText(text, width, style.size, weight), size: style.size, weight, color: style.color, align: style.align ?? 'start' }
}

/** A text box exactly as wide as its text, centred on (cx, cy): the unit that value labels are placed and tested in. */
export function labelAt(text: string, cx: number, cy: number, style: TextStyle): Text {
  const width = Math.ceil(textWidth(text, style.size, style.weight ?? 400)) + 2
  const height = lineHeight(style.size)
  return { ...textBox(text, cx - width / 2, cy - height / 2, width, style), align: 'center' }
}

/** Title and subtitle, left-aligned. `bottom` is where the next part may start. */
export function header(chart: Chart, theme: Theme, s: Sizes): { texts: Text[]; bottom: number } {
  const width = chart.width - 2 * s.pad
  const texts: Text[] = []
  let y = s.pad
  if (chart.title) {
    texts.push(textBox(chart.title, s.pad, y, width, { size: s.title, color: theme.ink, weight: 600 }))
    y += lineHeight(s.title)
  }
  if (chart.subtitle) {
    texts.push(textBox(chart.subtitle, s.pad, y, width, { size: s.subtitle, color: theme.ink2 }))
    y += lineHeight(s.subtitle)
  }
  return { texts, bottom: y }
}

export interface LegendItem {
  label: string
  color: string
  /** Printed after the label in the stronger ink (pie values that do not fit in their slice). */
  value?: string
}

export type LegendKey = 'square' | 'line'

function legendKey(kind: LegendKey, x: number, centerY: number, color: string, s: Sizes): Shape[] {
  const size = keySize(s)
  if (kind === 'square') return [{ kind: 'rect', x, y: Math.round(centerY - size / 2), w: size, h: size, r: 2, fill: color }]
  return [
    { kind: 'rect', x, y: centerY - s.stroke / 2, w: size * 1.6, h: s.stroke, r: s.stroke / 2, fill: color },
    { kind: 'circle', cx: x + size * 0.8, cy: centerY, r: size * 0.36, fill: color },
  ]
}

const keySize = (s: Sizes): number => Math.round(s.font * 0.9)
const keyWidth = (kind: LegendKey, s: Sizes): number => (kind === 'square' ? keySize(s) : keySize(s) * 1.6) + Math.round(s.font * 0.5)
const rowHeight = (s: Sizes): number => Math.round(s.font * 1.7)

function legendEntry(item: LegendItem, kind: LegendKey, x: number, y: number, labelWidth: number, valueWidth: number, theme: Theme, s: Sizes): Part {
  const top = y + (rowHeight(s) - lineHeight(s.font)) / 2
  const textX = x + keyWidth(kind, s)
  const texts = [textBox(item.label, textX, top, labelWidth, { size: s.font, color: theme.ink2 })]
  if (item.value !== undefined) {
    // valueWidth already holds the gap between a label and its value.
    texts.push(textBox(item.value, textX + labelWidth, top, valueWidth, { size: s.font, color: theme.ink, align: 'end' }))
  }
  return { shapes: legendKey(kind, x, y + rowHeight(s) / 2, item.color, s), texts }
}

/**
 * Width of the value column (the widest value plus a gap; 0 without values), at most what `room`
 * leaves beside a short label: a value too long for that is cut like any other text.
 */
const valueColumn = (items: readonly LegendItem[], s: Sizes, room: number): number =>
  items.some((item) => item.value !== undefined)
    ? Math.max(0, Math.min(Math.ceil(Math.max(...items.map((item) => textWidth(item.value ?? '', s.font)))) + s.font * 0.5, room - s.font * 2))
    : 0

const withoutValues = (items: readonly LegendItem[]): LegendItem[] => items.map(({ value: _value, ...item }) => item)

/**
 * Legend entries in rows, starting at (x, y), at most `width` wide. A few entries flow left to
 * right at their natural width. When that would be taller than `maxHeight`, they are set in equal
 * columns instead: as few columns as the height allows, so labels are cut as little as possible.
 */
export function legendRows(items: readonly LegendItem[], kind: LegendKey, x: number, y: number, width: number, maxHeight: number, theme: Theme, s: Sizes): Part & { height: number } {
  const key = keyWidth(kind, s)
  const between = Math.round(s.font * 1.4)
  let values = valueColumn(items, s, width - key)
  const natural = items.map((item) => Math.ceil(textWidth(item.label, s.font)) + 1)
  const maxRows = Math.max(1, Math.floor(maxHeight / rowHeight(s)))

  let labelWidths = natural.map((w) => Math.max(0, Math.min(w, width - key - values)))
  const spots: Array<{ x: number; row: number }> = []
  let [cursor, row] = [0, 0]
  labelWidths.forEach((labelWidth, i) => {
    const entry = key + labelWidth + values
    if (i > 0 && cursor + entry > width) [cursor, row] = [0, row + 1]
    spots.push({ x: cursor, row })
    cursor += entry + between
  })
  if (row >= maxRows) {
    const widest = key + Math.max(...natural) + values
    let columns = Math.max(1, Math.floor((width + between) / (widest + between)))
    while (Math.ceil(items.length / columns) > maxRows && columns < items.length) columns++
    const column = Math.floor((width + between) / columns)
    // Columns too narrow for a label beside its value keep the labels and leave the values out.
    if (column - between - key - values < s.font * 2) values = 0
    labelWidths = natural.map((w) => Math.min(w, Math.max(0, column - between - key - values)))
    items.forEach((_, i) => (spots[i] = { x: (i % columns) * column, row: Math.floor(i / columns) }))
  }
  const shown = values > 0 ? items : withoutValues(items)
  const parts = shown.map((item, i) => legendEntry(item, kind, x + spots[i]!.x, y + spots[i]!.row * rowHeight(s), labelWidths[i]!, values, theme, s))
  return { ...merge(...parts), height: (spots[spots.length - 1]!.row + 1) * rowHeight(s) }
}

/** Legend entries in one column, values right-aligned. `width` is the widest the column may be; the result says how wide it is. */
export function legendColumn(items: readonly LegendItem[], kind: LegendKey, x: number, y: number, width: number, theme: Theme, s: Sizes): Part & { width: number; height: number } {
  const key = keyWidth(kind, s)
  const values = valueColumn(items, s, width - key)
  const labelWidth = Math.max(0, Math.min(Math.ceil(Math.max(...items.map((item) => textWidth(item.label, s.font)))) + 1, width - key - values))
  const parts = items.map((item, i) => legendEntry(item, kind, x, y + i * rowHeight(s), labelWidth, values, theme, s))
  return { ...merge(...parts), width: key + labelWidth + values, height: items.length * rowHeight(s) }
}

export const legendColumnHeight = (count: number, s: Sizes): number => count * rowHeight(s)

/**
 * Value labels compete for space. Each label comes with its possible positions, best first; labels
 * are taken in the order given (most important first) and a label is dropped when none of its
 * positions is free. So labels never overlap each other or leave `bounds`, whatever the data.
 */
export function placeLabels(candidates: readonly Text[][], bounds: Rect, taken: readonly Rect[] = []): Text[] {
  const placed: Text[] = []
  const inside = (box: Rect): boolean => box.x >= bounds.x && box.y >= bounds.y && box.x + box.w <= bounds.x + bounds.w && box.y + box.h <= bounds.y + bounds.h
  for (const options of candidates) {
    const free = options.find((box) => inside(box) && !placed.some((other) => overlaps(box, other, 1)) && !taken.some((other) => overlaps(box, other, 1)))
    if (free) placed.push(free)
  }
  return placed
}

/** Indices in the order value labels should be considered: the largest and smallest value first, then left to right. */
export function byImportance(values: readonly number[]): number[] {
  const order = values.map((_, i) => i)
  if (values.length === 0) return order
  const max = values.indexOf(Math.max(...values))
  const min = values.indexOf(Math.min(...values))
  return [...new Set([max, min, values.length - 1, ...order])]
}
