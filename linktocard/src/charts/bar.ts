// Bars: single, grouped and stacked, vertical and horizontal, positive and negative.
import { colorOf, type Plot } from './cartesian'
import { byImportance, labelAt, placeLabels, type Part } from './frame'
import { overlaps, type Rect, type Shape, type Side, type Text } from './scene'
import type { Chart } from './spec'
import { textWidth } from './text'
import { inkOn, lineHeight, type Sizes, type Theme } from './theme'

export interface Bar extends Rect {
  series: number
  category: number
  value: number
  /** The side the value ends on; undefined for a segment inside a stack. */
  end?: Side
}

/** Thickness of one bar and the gap between bars of a group, in whole px. */
export function barThickness(band: number, axisLength: number, perCategory: number): { thickness: number; gap: number } {
  if (perCategory === 1) return { thickness: Math.max(1, Math.round(Math.min(band * 0.64, axisLength * 0.16))), gap: 0 }
  const share = (band * 0.78) / perCategory
  const gap = share >= 8 ? 2 : share >= 4 ? 1 : 0
  return { thickness: Math.max(1, Math.floor(Math.min(share - gap, axisLength * 0.1))), gap }
}

/** Every bar or stack segment as a rectangle on whole pixels. */
export function barRects(chart: Chart, plot: Plot, s: Sizes): Bar[] {
  const { horizontal, at } = plot
  const perCategory = chart.stacked ? 1 : chart.series.length
  const { thickness, gap } = barThickness(plot.band, horizontal ? plot.rect.h : plot.rect.w, perCategory)
  const total = perCategory * thickness + (perCategory - 1) * gap
  const rect = (start: number, from: number, to: number): Rect =>
    horizontal ? { x: Math.min(from, to), y: start, w: Math.abs(to - from), h: thickness } : { x: start, y: Math.min(from, to), w: thickness, h: Math.abs(to - from) }
  const endOf = (value: number): Side => (horizontal ? (value >= 0 ? 'right' : 'left') : value >= 0 ? 'top' : 'bottom')
  // Screen direction in which positive values grow: right, or up.
  const grow = horizontal ? 1 : -1
  const seam = s.font >= 13 ? 2 : 1
  const bars: Bar[] = []

  chart.labels.forEach((_, category) => {
    const start = Math.round(plot.center(category) - total / 2)
    if (!chart.stacked) {
      chart.series.forEach((series, index) => {
        const value = series.data[category]!
        const from = at(plot.base)
        let to = at(value)
        // A value that is not zero always shows, even when it rounds to nothing.
        if (to === from && value !== plot.base) to = from + Math.sign(value - plot.base) * grow
        bars.push({ ...rect(start + index * (thickness + gap), from, to), series: index, category, value, end: endOf(value - plot.base) })
      })
      return
    }
    // Positive values stack away from zero in one direction, negative values in the other.
    const column = chart.series.map((series) => series.data[category]!)
    for (const sign of [1, -1]) {
      const members = column.map((value, index) => ({ value, index })).filter(({ value }) => Math.sign(value) === sign)
      let running = 0
      members.forEach(({ value, index }, position) => {
        const from = at(running)
        const outermost = position === members.length - 1
        running += value
        let to = at(running)
        // A gap in the surface colour separates the segments of a stack.
        if (!outermost && Math.abs(to - from) > seam + 1) to -= sign * grow * seam
        bars.push({ ...rect(start, from, to), series: index, category, value, end: outermost ? endOf(value) : undefined })
      })
    }
  })
  return bars
}

export function barMarks(chart: Chart, plot: Plot, theme: Theme, s: Sizes): Part {
  const bars = barRects(chart, plot, s)
  const radius = Math.max(1, Math.round(s.font / 4))
  const shapes: Shape[] = bars.map((bar) => ({ kind: 'rect', x: bar.x, y: bar.y, w: bar.w, h: bar.h, fill: colorOf(chart, theme, bar.series), round: bar.end, r: bar.end ? radius : 0 }))
  if (!chart.values) return { shapes, texts: [] }

  const row = lineHeight(s.font)
  const style = { size: s.font, color: theme.ink }
  /** A label inside a bar, in white or near-black depending on the fill; undefined when it does not fit. */
  const inside = (bar: Bar, text: string): Text | undefined => {
    const width = textWidth(text, s.font, 600)
    const fits = plot.horizontal ? bar.w >= width + s.font * 0.6 && bar.h >= row - 2 : bar.h >= row + 2 && bar.w >= width + 4
    return fits ? labelAt(text, bar.x + bar.w / 2, bar.y + bar.h / 2, { ...style, weight: 600, color: inkOn(colorOf(chart, theme, bar.series)) }) : undefined
  }
  /** A label just beyond the data end of a bar. */
  const beyond = (bar: Bar, text: string): Text => {
    const reach = Math.round(s.font * 0.4) + (Math.ceil(textWidth(text, s.font)) + 2) / 2
    if (bar.end === 'top') return labelAt(text, bar.x + bar.w / 2, bar.y - 2 - row / 2, style)
    if (bar.end === 'bottom') return labelAt(text, bar.x + bar.w / 2, bar.y + bar.h + 2 + row / 2, style)
    return labelAt(text, bar.end === 'right' ? bar.x + bar.w + reach : bar.x - reach, bar.y + bar.h / 2, style)
  }

  /** False when the label would sit on a bar other than its own. Only bars near the label can be in its way. */
  const byCategory = chart.labels.map((_, category) => bars.filter((bar) => bar.category === category))
  const clear = (label: Text, own: Bar): boolean => {
    const reach = Math.ceil((plot.horizontal ? label.h : label.w) / Math.max(1, plot.band)) + 1
    for (let category = Math.max(0, own.category - reach); category <= Math.min(byCategory.length - 1, own.category + reach); category++) {
      if (byCategory[category]!.some((bar) => bar !== own && overlaps(label, bar, 1))) return false
    }
    return true
  }
  const free = (label: Text, own: Bar): Text[] => (clear(label, own) ? [label] : [])

  if (chart.stacked) {
    // A segment has no free end: its value is printed inside when it fits and left out when it does
    // not. The free end of the stack carries the total, unless the chart mixes positive and negative
    // values (then one stack has two ends and neither is the total).
    const segments = bars.flatMap((bar) => inside(bar, plot.format.value(bar.value)) ?? [])
    const values = chart.series.flatMap((series) => series.data)
    const oneSigned = values.every((value) => value >= 0) || values.every((value) => value <= 0)
    if (chart.series.length === 1 || !oneSigned) return { shapes, texts: segments }
    const ends = bars.filter((bar) => bar.end)
    const totals = ends.map((end) => byCategory[end.category]!.reduce((sum, bar) => sum + bar.value, 0))
    const candidates = byImportance(totals).map((index) => free(beyond(ends[index]!, plot.format.value(totals[index]!)), ends[index]!))
    // Totals first: they are the labels kept when a chart has more than it may show.
    return { shapes, texts: [...placeLabels(candidates, plot.labelBounds), ...segments] }
  }

  // The value sits just beyond the data end of the bar; if there is no room there, inside the bar.
  const candidates = byImportance(bars.map((bar) => bar.value)).map((index) => {
    const bar = bars[index]!
    const text = plot.format.value(bar.value)
    const within = inside(bar, text)
    return [...free(beyond(bar, text), bar), ...(within ? [within] : [])]
  })
  return { shapes, texts: placeLabels(candidates, plot.labelBounds) }
}
