// A validated chart -> PNG / JPEG / WebP, on the pipeline the cards use and behind the same
// safety net:
//
//   layout     Chart -> Scene: shapes and one-line text boxes (layout.ts; pure, no engine)
//   text       Satori turns the text boxes into outlines (bundled Inter, per-glyph fallback),
//              behind the VDOM guard of src/render/engine.ts
//   shapes     added to that SVG as plain markup: numbers and validated colours only
//   limits     the SVG size cap and src/render/svg-check.ts, as for a card
//   mark       the Free corner badge of src/render/watermark.ts, in a strip the layout leaves empty
//   raster     resvg -> pixels -> the PNG / JPEG / WebP encoders of src/render/engine.ts
//
// The whole render runs under the cards' time budget (LIMITS.renderTimeoutMs). It never fetches:
// the chart JSON has no URL field, and emoji come from the Worker's own static assets through
// deps.loadEmoji. Every failure is an ApiError; a failed render returns no bytes.
import { CHARTS, CONTENT_TYPES, FORMATS, LIMITS, type ImageFormat } from '../config'
import { ApiError } from '../lib/errors'
import { assetLoader, startBudget } from '../render'
import { encodeSvg, RenderInputError, renderSvg, type VNode } from '../render/engine'
import { fontStack } from '../render/fonts'
import { assertSvgWithinLimits } from '../render/svg-check'
import { stampWatermark, watermarkMarkup, watermarkStrip } from '../render/watermark'
import type { RenderDeps, RenderOutput } from '../types'
import { layoutChart } from './layout'
import { shapesToSvg, textToNode, type Scene } from './scene'
import type { Chart } from './spec'

/** 'free': the corner mark of every Free render. 'none': a paid plan's chart. */
export type ChartMark = 'none' | 'free'

export interface ChartRenderOptions {
  format: ImageFormat
  mark: ChartMark
}

/** Emoji in a chart's text are images from the Worker's static assets; without a loader they are left blank. */
export type ChartRenderDeps = Pick<RenderDeps, 'loadEmoji'>

const MARKS: readonly ChartMark[] = ['none', 'free']
const MAX_WARNINGS = 20
const MAX_WARNING_CHARS = 240

/**
 * The canvas width the corner mark is drawn for. The badge of src/render/watermark.ts scales with
 * the canvas (it was made for 1200px cards); a chart narrower than CHARTS.markMinWidth gets the
 * badge of that width, so it stays readable. Widths go in steps, so an isolate holds a handful
 * of badges however many chart sizes it draws.
 */
export function markWidth(chartWidth: number): number {
  const { markMinWidth: min, markWidthStep: step, markMaxWidth: max } = CHARTS
  return Math.min(max, min + Math.floor(Math.max(0, chartWidth - min) / step) * step)
}

/** Height in px that a marked chart keeps empty at its bottom edge, for the badge and its margin. */
export const markStrip = (chartWidth: number): number => watermarkStrip(markWidth(chartWidth))

/**
 * What the chart JSON alone cannot decide: "transparent" needs a format with transparency, and
 * here that is PNG. Routes call it before anything is looked up; renderChart calls it again.
 */
export function assertChartFormat(chart: Pick<Chart, 'background'>, format: ImageFormat): void {
  if (!FORMATS.includes(format)) {
    throw new ApiError('unsupported_format', `Unsupported format "${String(format)}". Supported formats: ${FORMATS.join(', ')}.`)
  }
  if (chart.background === 'transparent' && format !== 'png') {
    throw new ApiError('invalid_request', 'options.background: "transparent" is only available for PNG images. Use a colour, or the png format.', {
      details: { field: 'options.background' },
    })
  }
}

/** The scene as one SVG: shapes first, text outlines on top. */
async function sceneToSvg(scene: Scene, deps: ChartRenderDeps, warn: (message: string) => void): Promise<string> {
  const root: VNode = {
    type: 'div',
    props: {
      style: { display: 'flex', position: 'relative', width: scene.width, height: scene.height, fontFamily: fontStack('Inter') },
      children: scene.texts.filter((text) => text.text !== '').map(textToNode),
    },
  }
  const svg = await renderSvg(root, {
    width: scene.width,
    height: scene.height,
    // Text no bundled font covers is drawn as empty boxes, an emoji as its image or left blank; nothing is fetched.
    loadAdditionalAsset: assetLoader(deps, warn),
  })
  // Same technique as the card watermark: markup is added to Satori's root element. Shapes go in
  // first, so the text paints over them.
  const shapes = shapesToSvg(scene.shapes)
  const open = svg.indexOf('>')
  if (!svg.startsWith('<svg') || open < 0) throw new Error('Unexpected SVG from the text engine.')
  return svg[open - 1] === '/' ? `${svg.slice(0, open - 1)}>${shapes}</svg>` : `${svg.slice(0, open + 1)}${shapes}${svg.slice(open + 1)}`
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  // The VDOM guard's node limit: more text boxes than one image may hold.
  if (error instanceof RenderInputError && error.message.startsWith('Too many nodes')) {
    return new ApiError('template_error', 'The chart has more text than one image can hold. Use fewer points, or switch off "values".')
  }
  // Logged for the operator; the caller only learns that the render failed.
  console.error('[chart] unexpected failure:', error)
  return new ApiError('render_failed', 'The chart could not be drawn.')
}

/**
 * Draws one chart. The same chart, format and mark always give the same bytes. Throws ApiError:
 * 400 for a format the chart cannot have, 422 template_error for a chart too complex to draw,
 * 504 render_timeout, 500 render_failed.
 */
export async function renderChart(chart: Chart, options: ChartRenderOptions, deps: ChartRenderDeps = {}): Promise<RenderOutput> {
  const started = performance.now()
  const warnings = new Set<string>()
  const warn = (message: string): void => {
    warnings.add(message.length > MAX_WARNING_CHARS ? `${message.slice(0, MAX_WARNING_CHARS - 3)}...` : message)
  }
  const width = chart.width * chart.scale
  const height = chart.height * chart.scale
  const budget = startBudget(LIMITS.renderTimeoutMs)
  try {
    assertChartFormat(chart, options.format)
    // An unknown mode must not silently become "no mark".
    if (!MARKS.includes(options.mark)) throw new ApiError('invalid_request', `Unknown mark "${String(options.mark)}".`)
    // Validation keeps charts within CHARTS.maxPixels; this is the renderer's own cap, as for cards.
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > LIMITS.maxRenderPixels) {
      throw new ApiError('unsupported_size', `Unsupported size ${width}x${height}: a chart may have at most ${LIMITS.maxRenderPixels} pixels.`)
    }

    const marked = options.mark === 'free'
    const scene = layoutChart(chart, { footer: marked ? markStrip(chart.width) : 0 })
    const laidOut = performance.now()

    let svg = await budget.race(sceneToSvg(scene, deps, warn))
    if (svg.length > LIMITS.maxSvgBytes) {
      throw new ApiError('template_error', `The chart is too complex: its intermediate SVG is ${svg.length} bytes; the limit is ${LIMITS.maxSvgBytes}. Use fewer points or shorter labels.`)
    }
    assertSvgWithinLimits(svg)
    if (marked) {
      // The badge is drawn for a square canvas of the mark's width and moved so that its corner is the chart's.
      const canvas = markWidth(chart.width)
      const badge = await budget.race(watermarkMarkup(canvas, canvas, 'free'))
      svg = stampWatermark(svg, `<g transform="translate(${chart.width - canvas} ${chart.height - canvas})">${badge}</g>`)
    }
    budget.check()
    const drawn = performance.now()

    const image = await encodeSvg(svg, width, options.format, scene.background)
    budget.check()

    return {
      bytes: image.bytes,
      contentType: CONTENT_TYPES[options.format],
      width,
      height,
      warnings: [...warnings].slice(0, MAX_WARNINGS),
      timings: {
        compileMs: laidOut - started,
        imagesMs: 0,
        layoutMs: drawn - laidOut,
        rasterMs: image.rasterMs,
        encodeMs: image.encodeMs,
        totalMs: performance.now() - started,
      },
    }
  } catch (error) {
    throw toApiError(error)
  } finally {
    budget.stop()
  }
}
