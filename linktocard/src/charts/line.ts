// Lines and areas (plain and stacked), with markers and value labels.
import { colorOf, type Plot } from './cartesian'
import { byImportance, labelAt, placeLabels, type Part } from './frame'
import { num as n, type Rect, type Shape, type Text } from './scene'
import type { Chart } from './spec'
import { textWidth } from './text'
import { lineHeight, type Sizes, type Theme } from './theme'

export interface Point {
  x: number
  y: number
}

const polyline = (points: readonly Point[]): string => points.map((point, i) => `${i === 0 ? 'M' : 'L'}${n(point.x)} ${n(point.y)}`).join('')

/** For every series: the points of its line, and of the edge its area is filled down to. */
export function linePoints(chart: Chart, plot: Pick<Plot, 'at' | 'center' | 'base'>): Array<{ top: Point[]; floor: Point[] }> {
  const running = chart.labels.map(() => 0)
  return chart.series.map((series) => {
    const floor = chart.labels.map((_, i) => ({ x: plot.center(i), y: plot.at(chart.stacked ? running[i]! : plot.base) }))
    const top = series.data.map((value, i) => {
      if (chart.stacked) running[i]! += value
      return { x: plot.center(i), y: plot.at(chart.stacked ? running[i]! : value) }
    })
    return { top, floor }
  })
}

/** True when the segment a-b passes through the rectangle (Liang-Barsky clipping). */
export function segmentCrosses(a: Point, b: Point, box: Rect): boolean {
  const [dx, dy] = [b.x - a.x, b.y - a.y]
  let [enter, leave] = [0, 1]
  const edges: Array<[number, number]> = [
    [-dx, a.x - box.x],
    [dx, box.x + box.w - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.h - a.y],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
    } else if (p < 0) enter = Math.max(enter, q / p)
    else leave = Math.min(leave, q / p)
  }
  return enter <= leave
}

export function lineMarks(chart: Chart, plot: Plot, theme: Theme, s: Sizes): Part {
  const area = chart.type === 'area'
  const count = chart.labels.length
  const lines = linePoints(chart, plot)
  const color = (index: number): string => colorOf(chart, theme, index)
  const fills: Shape[] = []
  const strokes: Shape[] = []
  const dots: Shape[] = []
  // Markers when the points are far enough apart to tell them from the line; a single point is only a marker.
  const markers = count === 1 || (!area && plot.band >= s.marker * 5)
  const radius = count === 1 ? s.marker * 1.4 : s.marker

  lines.forEach(({ top, floor }, index) => {
    if (area && count > 1) {
      // Stacked bands touch, so they are filled almost solid; overlapping areas stay a light wash.
      fills.push({ kind: 'path', d: `${polyline(top)}${polyline([...floor].reverse()).replace('M', 'L')}Z`, fill: color(index), opacity: chart.stacked ? 0.7 : 0.16 })
    }
    if (count > 1) strokes.push({ kind: 'path', d: polyline(top), stroke: color(index), strokeWidth: s.stroke })
    if (markers) for (const point of top) dots.push({ kind: 'circle', cx: point.x, cy: point.y, r: radius, fill: color(index), stroke: theme.surface, strokeWidth: 1.5 })
  })
  const shapes = [...fills, ...strokes, ...dots]
  if (!chart.values) return { shapes, texts: [] }

  // A value label goes above its point, or below, or to one side: the first of these that no line passes through.
  const row = lineHeight(s.font)
  const style = { size: s.font, color: theme.ink }
  const lift = s.marker + 3 + row / 2
  const candidates: Text[][] = []
  lines.forEach(({ top }, index) => {
    const data = chart.series[index]!.data
    // Points closer together than a label is wide cannot all be labelled: then only the highest,
    // the lowest and the last value of each series are.
    const dense = plot.band < Math.max(...data.map((value) => textWidth(plot.format.value(value), s.font))) * 0.8
    for (const i of byImportance(data).slice(0, dense ? 3 : undefined)) {
      const point = top[i]!
      const text = plot.format.value(data[i]!)
      const centred = labelAt(text, point.x, point.y - lift, style)
      const side = centred.w / 2 + s.marker + 2
      const valley = (top[i - 1]?.y ?? Infinity) < point.y && (top[i + 1]?.y ?? Infinity) < point.y
      const spots: Array<[number, number]> = [[0, -lift], [0, lift], [-side, -lift], [side, -lift], [side, lift], [-side, lift]]
      if (valley) [spots[0], spots[1]] = [spots[1]!, spots[0]!]
      // Only segments near the label can cross it.
      const reach = Math.ceil((centred.w + side) / Math.max(1, plot.band)) + 1
      const clear = (box: Rect): boolean =>
        lines.every((line) => {
          for (let k = Math.max(0, i - reach); k < Math.min(count - 1, i + reach); k++) {
            if (segmentCrosses(line.top[k]!, line.top[k + 1]!, { x: box.x, y: box.y + 2, w: box.w, h: box.h - 4 })) return false
          }
          return true
        })
      candidates.push(spots.map(([dx, dy]) => ({ ...centred, x: centred.x + dx, y: point.y + dy - row / 2 })).filter(clear))
    }
  })
  const taken: Rect[] = markers ? lines.flatMap(({ top }) => top.map((point) => ({ x: point.x - s.marker, y: point.y - s.marker, w: s.marker * 2, h: s.marker * 2 }))) : []
  return { shapes, texts: placeLabels(candidates, plot.labelBounds, taken) }
}
