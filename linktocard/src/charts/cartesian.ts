// Bar, line and area charts share one frame: a value axis with nice ticks, a category axis whose
// labels are thinned or shortened to fit, axis titles, the legend and the title block.
import { CHARTS } from '../config'
import { barMarks } from './bar'
import { header, legendRows, merge, textBox, type Part } from './frame'
import { lineMarks } from './line'
import { formatter, niceScale, type Formatter, type Scale } from './scale'
import type { Rect, Shape, Text } from './scene'
import type { Chart } from './spec'
import { fitText, textWidth } from './text'
import { clamp, lineHeight, seriesColor, type Sizes, type Theme } from './theme'

/** The plot area and how data maps into it. Value labels may use `labelBounds`, which is a little larger. */
export interface Plot {
  rect: Rect
  labelBounds: Rect
  horizontal: boolean
  scale: Scale
  format: Formatter
  /** Pixel position of a value on the value axis (y in a vertical chart, x in a horizontal one). */
  at(value: number): number
  /** Pixel position of category `i` on the category axis. */
  center(i: number): number
  /** Distance between neighbouring categories in px. */
  band: number
  /** Where bars and areas start: zero, or the end of the axis nearest to zero. */
  base: number
}

export const colorOf = (chart: Chart, theme: Theme, index: number): string => chart.series[index]?.color ?? seriesColor(theme, index)

/** Smallest and largest value the value axis has to show, stacking included. */
export function extent(chart: Chart): { low: number; high: number } {
  const all = chart.series.flatMap((series) => series.data)
  let low = Math.min(...all)
  let high = Math.max(...all)
  if (chart.stacked) {
    for (let i = 0; i < chart.labels.length; i++) {
      const column = chart.series.map((series) => series.data[i]!)
      if (chart.type === 'bar') {
        // Positive values stack upwards from zero, negative values downwards.
        high = Math.max(high, column.reduce((sum, value) => sum + Math.max(0, value), 0))
        low = Math.min(low, column.reduce((sum, value) => sum + Math.min(0, value), 0))
      } else {
        let running = 0
        for (const value of column) {
          running += value
          high = Math.max(high, running)
          low = Math.min(low, running)
        }
      }
    }
  }
  // Bars and areas are read by their length, so their axis includes zero. So does a line, unless
  // its values vary by less than a fifth of their size (980 to 1,020): then the axis follows the
  // data, with a little air so that the lowest point does not sit on the axis.
  const spread = high - low
  const narrow = chart.type === 'line' && (low > 0 || high < 0) && spread < Math.max(Math.abs(low), Math.abs(high)) * 0.2
  if (narrow) return { low: low - spread * 0.1, high: high + spread * 0.1 }
  low = Math.min(low, 0)
  high = Math.max(high, 0)
  return { low, high }
}

/** Space in px that value labels need beyond the largest and the smallest value. */
function labelRoom(chart: Chart, format: Formatter, low: number, high: number, s: Sizes): { beyondHigh: number; beyondLow: number } {
  if (!chart.values) return { beyondHigh: 0, beyondLow: 0 }
  if (chart.type !== 'bar') return { beyondHigh: s.marker + 3 + lineHeight(s.font), beyondLow: 0 }
  // Plain bars carry their value at the data end; stacks carry their total there.
  if (chart.stacked && chart.series.length === 1) return { beyondHigh: 0, beyondLow: 0 }
  const values = chart.stacked ? [low, high] : chart.series.flatMap((series) => series.data)
  const room = (side: number[]): number => {
    if (side.length === 0) return 0
    return chart.horizontal ? Math.max(...side.map((value) => textWidth(format.value(value), s.font))) + s.font * 0.7 : lineHeight(s.font) + 3
  }
  return { beyondHigh: high > 0 ? room(values.filter((value) => value >= 0)) : 0, beyondLow: low < 0 ? room(values.filter((value) => value < 0)) : 0 }
}

/**
 * Category labels that never overlap. If every label fits in its slot, all are shown. Wide slots
 * (few categories) keep every label and shorten the long ones; narrow slots show every n-th label.
 */
export function thinLabels(labels: readonly string[], slot: number, s: Sizes): Array<{ index: number; text: string; width: number }> {
  const spacing = s.font * 0.8
  const widths = labels.map((label) => textWidth(label, s.font))
  const widest = Math.max(...widths)
  const all = (limit: number, stride: number) =>
    labels.flatMap((label, index) => {
      if (index % stride !== 0) return []
      const text = fitText(label, limit, s.font)
      return text ? [{ index, text, width: Math.min(widths[index]!, limit) }] : []
    })
  if (widest + spacing <= slot) return all(widest, 1)
  if (slot >= s.font * 5) return all(slot - spacing, 1)
  const limit = Math.min(widest, s.font * 8)
  return all(limit, Math.ceil((limit + spacing) / slot))
}

export function layoutCartesian(chart: Chart, theme: Theme, s: Sizes): Part {
  const { width, height, horizontal } = chart
  const count = chart.labels.length
  const tickGap = Math.round(s.font * 0.6)
  const row = lineHeight(s.font)
  const axisText = { size: s.font, color: theme.ink2 }

  // Title block and legend, top down.
  const head = header(chart, theme, s)
  const above: Part[] = [{ shapes: [], texts: head.texts }]
  let top = head.bottom
  if (chart.legend) {
    const items = chart.series.map((series, i) => ({ label: series.name, color: colorOf(chart, theme, i) }))
    const legend = legendRows(items, chart.type === 'line' ? 'line' : 'square', s.pad, top + (top > s.pad ? Math.round(s.font * 0.3) : 0), width - 2 * s.pad, height * 0.25, theme, s)
    above.push(legend)
    top += legend.height + (top > s.pad ? Math.round(s.font * 0.3) : 0)
  }
  // The top tick label is centred on the top grid line, so the plot starts half a line lower.
  top += Math.ceil(row / 2) + (top > s.pad ? Math.round(s.font * 0.6) : 0)

  const titleBand = (title: string): number => (title ? row + Math.round(s.font * 0.4) : 0)
  let bottom = height - s.pad - titleBand(chart.xTitle) - row - tickGap
  let left = s.pad + titleBand(chart.yTitle)
  let right = width - s.pad

  const { low, high } = extent(chart)
  const wholeNumbers = chart.series.every((series) => series.data.every(Number.isInteger))
  const scaleFor = (maxIntervals: number): Scale => niceScale(low, high, { maxIntervals, min: chart.min, max: chart.max, wholeNumbers })
  const formatFor = (scale: Scale): Formatter => formatter(chart.format, Math.max(Math.abs(scale.min), Math.abs(scale.max)), scale.step)

  let scale: Scale
  let categoryGutter = 0
  if (horizontal) {
    // Category names sit left of the plot; they may take up to 36% of the width.
    categoryGutter = Math.min(Math.ceil(Math.max(...chart.labels.map((label) => textWidth(label, s.font)))) + 1, Math.round(width * 0.36))
    left += categoryGutter + tickGap
    // As many ticks as fit side by side.
    let intervals = clamp(Math.floor((right - left) / (s.font * 6)), 2, 10)
    for (;;) {
      scale = scaleFor(intervals)
      const widest = Math.max(...scale.ticks.map((tick) => textWidth(formatFor(scale).tick(tick), s.font)))
      if ((widest + s.font) * (scale.ticks.length - 1) <= right - left || intervals <= 2) break
      intervals--
    }
  } else {
    // About one tick per 3.6 lines of text, but at least four intervals where the labels still have room.
    const roomy = Math.floor((bottom - top) / (s.font * 3.6))
    const tight = Math.floor((bottom - top) / (row * 1.6))
    scale = scaleFor(clamp(Math.max(roomy, Math.min(4, tight)), 1, 8))
    const widest = Math.max(...scale.ticks.map((tick) => textWidth(formatFor(scale).tick(tick), s.font)))
    left += Math.min(Math.ceil(widest) + 1, Math.round(width * 0.3)) + tickGap
  }
  const format = formatFor(scale)

  // Value labels beyond the ends of the axis get their room from the plot, not from an extra tick.
  const room = labelRoom(chart, format, low, high, s)
  const span = scale.max - scale.min
  const shrink = (length: number): { atHigh: number; atLow: number } => {
    const beyond = (value: number, need: number): number => {
      if (need === 0) return 0
      const free = (Math.abs(value) / span) * length
      return clamp(need - free, 0, length * 0.3)
    }
    return { atHigh: beyond(scale.max - clamp(high, scale.min, scale.max), room.beyondHigh), atLow: beyond(clamp(low, scale.min, scale.max) - scale.min, room.beyondLow) }
  }
  const pads = shrink(horizontal ? right - left : bottom - top)
  const outer = { top, right, bottom, left }
  if (horizontal) [right, left] = [right - Math.ceil(pads.atHigh), left + Math.ceil(pads.atLow)]
  else [top, bottom] = [top + Math.ceil(pads.atHigh), bottom - Math.ceil(pads.atLow)]

  const rect: Rect = { x: left, y: top, w: Math.max(20, right - left), h: Math.max(20, bottom - top) }
  const length = horizontal ? rect.w : rect.h
  const at = (value: number): number => {
    const share = (value - scale.min) / span
    return Math.round(horizontal ? rect.x + share * length : rect.y + length - share * length)
  }
  // Bars and areas use the full band; a line runs almost from edge to edge.
  const inset = chart.type === 'bar' ? undefined : chart.type === 'area' ? 0 : Math.min(s.font * 1.5, (horizontal ? rect.h : rect.w) / count / 2)
  const along = horizontal ? rect.h : rect.w
  const origin = horizontal ? rect.y : rect.x
  const band = inset === undefined ? along / count : count > 1 ? (along - 2 * inset) / (count - 1) : along
  const center = (i: number): number => (inset === undefined ? origin + band * (i + 0.5) : count > 1 ? origin + inset + band * i : origin + along / 2)
  const plot: Plot = {
    rect,
    labelBounds: { x: outer.left, y: outer.top - (horizontal ? 0 : Math.ceil(row / 2)), w: outer.right - outer.left, h: outer.bottom - outer.top + (horizontal ? 0 : Math.ceil(row / 2)) },
    horizontal,
    scale,
    format,
    at,
    center,
    band,
    base: clamp(0, scale.min, scale.max),
  }

  // Grid lines and tick labels of the value axis.
  const grid: Shape[] = []
  const texts: Text[] = []
  for (const tick of scale.ticks) {
    const position = at(tick)
    const label = format.tick(tick)
    if (horizontal) {
      grid.push({ kind: 'rect', x: position, y: rect.y, w: 1, h: rect.h, fill: theme.grid })
      // A tick label wider than the image (a long prefix or suffix on a small chart) is cut to it.
      const labelWidth = Math.min(Math.ceil(textWidth(label, s.font)) + 2, width - 4)
      texts.push({ ...textBox(label, clamp(position - labelWidth / 2, 2, width - 2 - labelWidth), rect.y + rect.h + tickGap, labelWidth, axisText), align: 'center' })
    } else {
      grid.push({ kind: 'rect', x: rect.x, y: position, w: rect.w, h: 1, fill: theme.grid })
      const gutter = rect.x - tickGap - s.pad - titleBand(chart.yTitle)
      texts.push(textBox(label, rect.x - tickGap - gutter, position - row / 2, gutter, { ...axisText, align: 'end' }))
    }
  }
  const basePosition = at(plot.base)
  const baseline: Shape = horizontal
    ? { kind: 'rect', x: basePosition, y: rect.y, w: 1, h: rect.h, fill: theme.axis }
    : { kind: 'rect', x: rect.x, y: basePosition, w: rect.w, h: 1, fill: theme.axis }

  // Category labels.
  if (horizontal) {
    const stride = Math.ceil(row / band)
    chart.labels.forEach((label, i) => {
      if (i % stride === 0) texts.push(textBox(label, s.pad + titleBand(chart.yTitle), center(i) - row / 2, categoryGutter, { ...axisText, align: 'end' }))
    })
  } else {
    const shown = thinLabels(chart.labels, band, s)
    let free = -Infinity
    for (const { index, text, width: labelWidth } of shown) {
      const boxWidth = Math.ceil(labelWidth) + 2
      // A label at the edge is moved inwards rather than cut off or pushed under the tick labels.
      // If that pushes it into its neighbour, it is left out.
      const x = clamp(center(index) - boxWidth / 2, rect.x - tickGap + 2, width - Math.round(s.pad / 2) - boxWidth)
      if (x < free) continue
      free = x + boxWidth + s.font * 0.5
      // When labels are left out, a small tick shows which category each remaining label belongs to.
      if (shown.length < count) grid.push({ kind: 'rect', x: Math.round(center(index)), y: rect.y + rect.h + 1, w: 1, h: Math.round(tickGap * 0.6), fill: theme.axis })
      texts.push({ ...textBox(text, x, outer.bottom + tickGap, boxWidth, axisText), align: 'center' })
    }
  }

  // Axis titles: x under the plot, y turned a quarter and centred on the plot's height.
  if (chart.xTitle) texts.push(textBox(chart.xTitle, rect.x, height - s.pad - row, rect.w, { ...axisText, align: 'center' }))
  if (chart.yTitle) {
    const box = textBox(chart.yTitle, 0, 0, rect.h, { ...axisText, align: 'center' })
    texts.push({ ...box, x: s.pad + row / 2 - rect.h / 2, y: rect.y + rect.h / 2 - row / 2, rotate: true })
  }

  const marks = chart.type === 'bar' ? barMarks(chart, plot, theme, s) : lineMarks(chart, plot, theme, s)
  // Data outside a fixed axis range is cut at the edge of the plot.
  const outside = (chart.min !== undefined || chart.max !== undefined) && chart.series.some((series) => series.data.some((value) => value < scale.min || value > scale.max))
  const drawn: Shape[] = outside ? [{ kind: 'clip', rect: { x: rect.x, y: rect.y, w: rect.w + 1, h: rect.h + 1 }, shapes: marks.shapes }] : marks.shapes
  // Bars stand on the baseline, so it is drawn over their feet; lines and areas are drawn over it.
  const layers = chart.type === 'bar' ? [...grid, ...drawn, baseline] : [...grid, baseline, ...drawn]
  // Value labels come most important first; beyond the cap the rest are left out (CHARTS.maxValueLabels).
  return merge(...above, { shapes: layers, texts: [...texts, ...marks.texts.slice(0, CHARTS.maxValueLabels)] })
}
