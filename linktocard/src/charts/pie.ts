// Pie and doughnut: slices in the order given, clockwise from 12 o'clock, separated by a real gap
// (not a stroke in the background colour, so it also works on a transparent background).
import { header, labelAt, legendColumn, legendColumnHeight, legendRows, merge, type LegendItem, type Part } from './frame'
import { formatter } from './scale'
import { num as n, type Rect, type Shape, type Text } from './scene'
import type { Chart } from './spec'
import { inkOn, seriesColor, type Sizes, type Theme } from './theme'

const TAU = Math.PI * 2

export interface Slice {
  index: number
  value: number
  /** Radians, clockwise, 0 = 3 o'clock; the first slice starts at -90 degrees. */
  start: number
  end: number
}

export function slices(values: readonly number[]): Slice[] {
  const total = values.reduce((sum, value) => sum + value, 0)
  let angle = -Math.PI / 2
  return values.flatMap((value, index) => {
    if (total <= 0 || value <= 0) return []
    const start = angle
    angle += (value / total) * TAU
    return [{ index, value, start, end: angle }]
  })
}

/**
 * Outline of one slice. The two straight edges are moved inwards by half the gap, parallel to
 * themselves, so the gap between neighbours has the same width from the rim to the centre.
 * `inner` is the radius of the hole (0 for a pie).
 */
export function slicePath(cx: number, cy: number, outer: number, inner: number, slice: Slice, gap: number): string {
  const at = (angle: number, radius: number): string => `${n(cx + radius * Math.cos(angle))} ${n(cy + radius * Math.sin(angle))}`
  const sweep = slice.end - slice.start
  if (sweep >= TAU - 1e-6) {
    // One slice is the whole: two half-circles, and the hole drawn the other way round.
    const ring = (radius: number, direction: 0 | 1): string =>
      `M${at(0, radius)}A${n(radius)} ${n(radius)} 0 1 ${direction} ${at(Math.PI, radius)}A${n(radius)} ${n(radius)} 0 1 ${direction} ${at(0, radius)}Z`
    return inner > 0 ? ring(outer, 1) + ring(inner, 0) : ring(outer, 1)
  }
  // Angle that half the gap takes up at a radius; a sliver keeps at least half of its own sweep.
  const trim = (radius: number): number => Math.min(Math.asin(Math.min(1, gap / 2 / radius)), sweep / 4)
  const [outerStart, outerEnd] = [slice.start + trim(outer), slice.end - trim(outer)]
  const arc = (radius: number, from: number, to: number, direction: 0 | 1): string => `A${n(radius)} ${n(radius)} 0 ${Math.abs(to - from) > Math.PI ? 1 : 0} ${direction} ${at(to, radius)}`
  if (inner > 0) {
    const [innerStart, innerEnd] = [slice.start + trim(inner), slice.end - trim(inner)]
    return `M${at(innerStart, inner)}L${at(outerStart, outer)}${arc(outer, outerStart, outerEnd, 1)}L${at(innerEnd, inner)}${arc(inner, innerEnd, innerStart, 0)}Z`
  }
  // The point of the wedge moves out along its middle line to where the two shifted edges meet.
  const middle = (slice.start + slice.end) / 2
  const tip = sweep < Math.PI * 1.5 ? Math.min(gap / 2 / Math.sin(sweep / 2), outer * 0.6) : 0
  return `M${at(middle, tip)}L${at(outerStart, outer)}${arc(outer, outerStart, outerEnd, 1)}Z`
}

/** True when the box lies inside the slice with `margin` px to spare on every side. */
export function fitsInSlice(box: Rect, cx: number, cy: number, outer: number, inner: number, slice: Slice, margin: number): boolean {
  const sweep = slice.end - slice.start
  const middle = (slice.start + slice.end) / 2
  for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]] as const) {
    const radius = Math.hypot(x - cx, y - cy)
    if (radius > outer - margin || radius < inner + (inner > 0 ? margin : 0)) return false
    if (sweep >= TAU - 1e-6) continue
    // Distance of the corner from the nearer straight edge, measured across the slice.
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(y - cy, x - cx) - middle), Math.cos(Math.atan2(y - cy, x - cx) - middle)))
    const rest = sweep / 2 - off
    if (rest < 0 || (rest < Math.PI / 2 && radius * Math.sin(rest) < margin)) return false
  }
  return true
}

export function layoutPie(chart: Chart, theme: Theme, s: Sizes): Part {
  const { width, height } = chart
  const head = header(chart, theme, s)
  const body: Rect = { x: s.pad, y: head.bottom + (head.bottom > s.pad ? s.gap : 0), w: width - 2 * s.pad, h: height - s.pad - head.bottom - (head.bottom > s.pad ? s.gap : 0) }
  const values = chart.series[0]!.data
  const parts = slices(values)
  const colors = values.map((_, index) => seriesColor(theme, index))
  const format = formatter(chart.format, Math.max(...values), 1)
  const hole = chart.type === 'doughnut' ? 0.6 : 0
  const gap = s.font >= 13 ? 2 : 1.5

  /** The circle and the legend for one choice of legend content; values move into the legend when a slice is too small for its label. */
  const arrange = (valuesInLegend: boolean): { cx: number; cy: number; radius: number; legend: Part } => {
    const items: LegendItem[] = chart.labels.map((label, index) => ({ label, color: colors[index]!, value: valuesInLegend ? format.value(values[index]!) : undefined }))
    const between = s.font * 2
    if (!chart.legend) return { cx: body.x + body.w / 2, cy: body.y + body.h / 2, radius: Math.min(body.w, body.h) / 2, legend: { shapes: [], texts: [] } }
    if (body.w >= body.h * 1.25 && legendColumnHeight(items.length, s) <= body.h) {
      // Wide chart: legend in a column on the right; circle and legend are centred together.
      const measured = legendColumn(items, 'square', 0, 0, body.w * 0.5, theme, s)
      const diameter = Math.min(body.h, body.w - measured.width - between)
      const left = body.x + (body.w - diameter - between - measured.width) / 2
      const legend = legendColumn(items, 'square', Math.round(left + diameter + between), Math.round(body.y + (body.h - measured.height) / 2), body.w * 0.5, theme, s)
      return { cx: left + diameter / 2, cy: body.y + body.h / 2, radius: diameter / 2, legend }
    }
    // Otherwise the legend goes underneath, in rows.
    const measured = legendRows(items, 'square', body.x, 0, body.w, body.h * 0.45, theme, s)
    const available = body.h - measured.height - s.gap
    const legend = legendRows(items, 'square', body.x, Math.round(body.y + body.h - measured.height), body.w, body.h * 0.45, theme, s)
    return { cx: body.x + body.w / 2, cy: body.y + available / 2, radius: Math.max(10, Math.min(body.w, available) / 2), legend }
  }

  /** The value of each slice, printed inside it where it fits. */
  const labelsFor = ({ cx, cy, radius }: { cx: number; cy: number; radius: number }): Text[] =>
    parts.flatMap((slice) => {
      const middle = (slice.start + slice.end) / 2
      const whole = slice.end - slice.start >= TAU - 1e-6
      const distances = hole > 0 ? [radius * (1 + hole) / 2] : whole ? [0] : [radius * 0.62, radius * 0.74, radius * 0.5]
      for (const distance of distances) {
        const label = labelAt(format.value(slice.value), cx + distance * Math.cos(middle), cy + distance * Math.sin(middle), { size: s.font, weight: 600, color: inkOn(colors[slice.index]!) })
        if (fitsInSlice(label, cx, cy, radius, radius * hole, slice, gap / 2 + 2)) return [label]
      }
      return []
    })

  let layout = arrange(false)
  let labels = chart.values ? labelsFor(layout) : []
  if (chart.values && chart.legend && labels.length < parts.length) {
    layout = arrange(true)
    labels = labelsFor(layout)
  }

  const { cx, cy, radius } = layout
  const shapes: Shape[] =
    parts.length === 0
      ? // Nothing to divide (all values are zero): an empty circle in the grid colour.
        [{ kind: 'path', d: slicePath(cx, cy, radius, radius * hole, { index: 0, value: 0, start: 0, end: TAU }, 0), fill: theme.grid }]
      : parts.map((slice) => ({ kind: 'path', d: slicePath(cx, cy, radius, radius * hole, slice, parts.length > 1 ? gap : 0), fill: colors[slice.index]! }))
  return merge({ shapes: [], texts: head.texts }, { shapes, texts: labels }, layout.legend)
}
