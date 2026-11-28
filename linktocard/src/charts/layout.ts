// Chart -> Scene. Pure: the same chart always gives the same shapes and text boxes.
import { layoutCartesian } from './cartesian'
import { layoutPie } from './pie'
import type { Scene, Shape, Text } from './scene'
import type { Chart } from './spec'
import { DARK, LIGHT, sizesFor, type Theme } from './theme'

export interface LayoutOptions {
  /** Height in px left empty at the bottom of the image (the strip the corner mark of a Free chart sits in). */
  footer?: number
}

/** The colour painted behind a chart: its own, or the theme's surface; 'transparent' for none. */
function chartBackground(chart: Pick<Chart, 'background' | 'theme'>): string {
  return chart.background ?? (chart.theme === 'dark' ? DARK : LIGHT).surface
}

export function layoutChart(chart: Chart, options: LayoutOptions = {}): Scene {
  const base = chart.theme === 'dark' ? DARK : LIGHT
  // A background colour of the caller's becomes the surface that gaps and marker rings are painted in.
  const theme: Theme = chart.background && chart.background !== 'transparent' ? { ...base, surface: chart.background } : base
  // Sizes follow the whole image; the parts are laid out in the height above the footer.
  const sizes = sizesFor(chart.width, chart.height)
  const body: Chart = { ...chart, height: chart.height - Math.max(0, Math.round(options.footer ?? 0)) }
  const part = chart.type === 'pie' || chart.type === 'doughnut' ? layoutPie(body, theme, sizes) : layoutCartesian(body, theme, sizes)
  // Last line of defence for charts with more on them than their size can hold (every option on
  // at the smallest size): nothing is drawn outside the body. A text box that does not lie inside
  // it is left out, and with a footer the shapes are cut at its edge, so the strip stays empty.
  const inside = (text: Text): boolean =>
    text.rotate === true ? text.w <= body.height : text.x >= -0.5 && text.y >= -0.5 && text.x + text.w <= body.width + 0.5 && text.y + text.h <= body.height + 0.5
  const shapes: Shape[] = body.height < chart.height ? [{ kind: 'clip', rect: { x: 0, y: 0, w: body.width, h: body.height }, shapes: part.shapes }] : part.shapes
  return { width: chart.width, height: chart.height, background: chartBackground(chart), shapes, texts: part.texts.filter(inside) }
}
