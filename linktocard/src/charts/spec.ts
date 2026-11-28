// Chart JSON v1: validation. Turns untrusted JSON into a Chart with every default filled in, or
// throws 400 invalid_request with a message that names the field (details.field holds its path).
//
// The JSON is data only. Nothing in it is executed, and no field is ever read as a URL: text is
// drawn as text and a colour is "#rgb" or "#rrggbb", so a chart cannot make the service fetch
// anything. Unknown fields are refused, so a typo is not silently ignored. Every limit is in
// CHARTS (src/config.ts).
import { CHARTS } from '../config'
import { ApiError } from '../lib/errors'

export type ChartType = (typeof CHARTS.types)[number]

export interface Series {
  name: string
  data: number[]
  /** '#rrggbb', lower case. */
  color?: string
}

export interface NumberFormat {
  prefix: string
  suffix: string
  /** Fixed number of decimals; undefined = chosen from the data. */
  decimals?: number
}

/** A validated chart with defaults applied. */
export interface Chart {
  type: ChartType
  title: string
  subtitle: string
  labels: string[]
  series: Series[]
  horizontal: boolean
  stacked: boolean
  legend: boolean
  values: boolean
  xTitle: string
  yTitle: string
  format: NumberFormat
  min?: number
  max?: number
  theme: 'light' | 'dark'
  /** '#rrggbb', 'transparent', or undefined for the theme's surface. */
  background?: string
  width: number
  height: number
  scale: 1 | 2
}

/** The fields of the chart JSON. POST /v1/charts accepts "format" beside them. */
export const CHART_FIELDS = ['type', 'title', 'subtitle', 'labels', 'series', 'options', 'width', 'height', 'scale'] as const
const OPTION_FIELDS = ['horizontal', 'stacked', 'legend', 'values', 'x_title', 'y_title', 'prefix', 'suffix', 'decimals', 'min', 'max', 'theme', 'background'] as const
const SERIES_FIELDS = ['name', 'data', 'color'] as const
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
/** Control characters and line or paragraph separators: a text is one line. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g')
/** Two ends of an axis closer together than this share of their size cannot be told apart. */
const MIN_RELATIVE_RANGE = 1e-9

type Json = Record<string, unknown>

/** 400 invalid_request that names the field. */
function fail(path: string, problem: string): never {
  throw new ApiError('invalid_request', `${path}: ${problem}`, { details: { field: path } })
}

function object(value: unknown, path: string, allowed: readonly string[], extra: readonly string[] = []): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object.')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) && !extra.includes(key)) {
      // The name is the caller's own text: shortened and kept on one line.
      const name = key.slice(0, 40).replace(CONTROL, ' ')
      fail(path === 'chart' ? name : `${path}.${name}`, `unknown field. Allowed: ${allowed.join(', ')}.`)
    }
  }
  return value as Json
}

/** One line of plain text. Control characters and line breaks become spaces; affixes keep their spaces (" kg"). */
function text(value: unknown, path: string, max: number, trim = true): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') fail(path, 'must be a string.')
  const oneLine = value.replace(CONTROL, ' ')
  const clean = trim ? oneLine.trim() : oneLine
  if (clean.length > max && [...clean].length > max) fail(path, `is longer than ${max} characters.`)
  return clean
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, 'must be true or false.')
  return value
}

/** A number the chart can draw: finite, and 0 or between the two size limits. */
function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number.')
  const size = Math.abs(value)
  if (size > CHARTS.maxAbsValue) fail(path, `is out of range: a number may be at most ${CHARTS.maxAbsValue} in size.`)
  if (size !== 0 && size < CHARTS.minAbsValue) fail(path, `is too small to draw: a number is 0 or at least ${CHARTS.minAbsValue} in size. Use a smaller unit.`)
  // -0 would print as "0" and hash as "0"; make it so.
  return value === 0 ? 0 : value
}

function integer(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be a whole number from ${min} to ${max}.`)
  }
  return value
}

/** "#rgb" or "#rrggbb" -> '#rrggbb' in lower case. Nothing else is a colour: no names, no rgb(), no url(). */
function color(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !HEX.test(value)) fail(path, 'must be a colour written as "#rgb" or "#rrggbb".')
  const hex = value.toLowerCase()
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
}

function parseSeries(value: unknown, labels: number, pie: boolean): Series[] {
  if (!Array.isArray(value) || value.length === 0) fail('series', 'must be a list with at least one series.')
  if (pie && value.length !== 1) fail('series', 'a pie or doughnut chart takes exactly one series.')
  if (value.length > CHARTS.maxSeries) fail('series', `has ${value.length} series; the limit is ${CHARTS.maxSeries}.`)
  return value.map((entry, i) => {
    const path = `series[${i}]`
    const raw = object(entry, path, SERIES_FIELDS)
    if (!Array.isArray(raw.data)) fail(`${path}.data`, 'must be a list of numbers.')
    if (raw.data.length !== labels) fail(`${path}.data`, `has ${raw.data.length} values but there are ${labels} labels.`)
    const data = raw.data.map((item, j) => number(item, `${path}.data[${j}]`))
    if (pie) {
      const negative = data.findIndex((item) => item < 0)
      if (negative >= 0) fail(`${path}.data[${negative}]`, 'a pie or doughnut chart cannot show a negative value.')
    }
    const seriesColor = color(raw.color, `${path}.color`)
    return { name: text(raw.name, `${path}.name`, CHARTS.maxSeriesNameChars) || `Series ${i + 1}`, data, ...(seriesColor ? { color: seriesColor } : {}) }
  })
}

/**
 * Validates a chart. Throws ApiError (400 invalid_request, details.field); never returns a partly
 * valid chart. `extra` names top-level fields the caller reads itself ("format" in POST /v1/charts).
 */
export function parseChart(input: unknown, extra: readonly string[] = []): Chart {
  const raw = object(input, 'chart', CHART_FIELDS, extra)
  const options = raw.options === undefined ? {} : object(raw.options, 'options', OPTION_FIELDS)

  const type = CHARTS.types.find((candidate) => candidate === raw.type)
  if (!type) fail('type', `must be one of ${CHARTS.types.join(', ')}.`)
  const pie = type === 'pie' || type === 'doughnut'

  if (!Array.isArray(raw.labels) || raw.labels.length === 0) fail('labels', 'must be a list with at least one label.')
  const maxLabels = pie ? CHARTS.maxSlices : CHARTS.maxPoints
  if (raw.labels.length > maxLabels) fail('labels', `has ${raw.labels.length} entries; the limit for a ${type} chart is ${maxLabels}.`)
  const labels = raw.labels.map((label, i) => {
    // Years and other numbers are common labels; they are accepted and shown as written.
    if (typeof label === 'number' && Number.isFinite(label)) return String(label)
    if (typeof label !== 'string') fail(`labels[${i}]`, 'must be a string or a number.')
    return text(label, `labels[${i}]`, CHARTS.maxLabelChars)
  })
  const series = parseSeries(raw.series, labels.length, pie)

  const width = integer(raw.width, 'width', CHARTS.minWidth, CHARTS.maxWidth, CHARTS.defaultWidth)
  const height = integer(raw.height, 'height', CHARTS.minHeight, CHARTS.maxHeight, CHARTS.defaultHeight)
  const scale = raw.scale === undefined ? 1 : raw.scale
  if (scale !== 1 && scale !== 2) fail('scale', `must be ${CHARTS.scales.join(' or ')}.`)
  if (width * scale * height * scale > CHARTS.maxPixels) {
    fail(scale === 2 ? 'scale' : 'width', `${width * scale} x ${height * scale} is more than ${CHARTS.maxPixels} pixels. Use ${scale === 2 ? 'scale 1 or ' : ''}a smaller chart.`)
  }

  const min = options.min === undefined ? undefined : number(options.min, 'options.min')
  const max = options.max === undefined ? undefined : number(options.max, 'options.max')
  if (min !== undefined && max !== undefined) {
    if (min >= max) fail('options.max', 'must be greater than options.min.')
    if (max - min <= Math.max(Math.abs(min), Math.abs(max)) * MIN_RELATIVE_RANGE) fail('options.max', 'is too close to options.min to draw an axis between them.')
  }

  if (options.theme !== undefined && options.theme !== 'light' && options.theme !== 'dark') fail('options.theme', 'must be "light" or "dark".')
  const background = options.background === 'transparent' ? 'transparent' : color(options.background, 'options.background')
  const decimals = options.decimals === undefined ? undefined : integer(options.decimals, 'options.decimals', 0, CHARTS.maxDecimals, 0)

  return {
    type,
    title: text(raw.title, 'title', CHARTS.maxTitleChars),
    subtitle: text(raw.subtitle, 'subtitle', CHARTS.maxSubtitleChars),
    labels,
    series,
    // "horizontal" belongs to bars and "stacked" to bars and areas. On other types they are checked
    // and then ignored, so a chart maker can switch type without clearing them.
    horizontal: bool(options.horizontal, 'options.horizontal', false) && type === 'bar',
    stacked: bool(options.stacked, 'options.stacked', false) && (type === 'bar' || type === 'area'),
    legend: bool(options.legend, 'options.legend', pie || series.length > 1),
    values: bool(options.values, 'options.values', false),
    xTitle: text(options.x_title, 'options.x_title', CHARTS.maxAxisTitleChars),
    yTitle: text(options.y_title, 'options.y_title', CHARTS.maxAxisTitleChars),
    format: {
      prefix: text(options.prefix, 'options.prefix', CHARTS.maxAffixChars, false),
      suffix: text(options.suffix, 'options.suffix', CHARTS.maxAffixChars, false),
      ...(decimals === undefined ? {} : { decimals }),
    },
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    theme: options.theme === 'dark' ? 'dark' : 'light',
    ...(background === undefined ? {} : { background }),
    width,
    height,
    scale,
  }
}

/** A chart from JSON text (the "c" parameter of a signed URL, a request body). */
export function parseChartJson(json: string, extra: readonly string[] = []): Chart {
  if (new TextEncoder().encode(json).byteLength > CHARTS.maxJsonBytes) {
    throw new ApiError('payload_too_large', `The chart JSON may be at most ${CHARTS.maxJsonBytes} bytes.`, { details: { max_bytes: CHARTS.maxJsonBytes } })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    fail('chart', 'is not valid JSON.')
  }
  return parseChart(parsed, extra)
}

/**
 * The canonical form of a chart: what "the same chart" means for the cache and the charge. It is
 * built from the validated chart in a fixed order, so the order of the JSON's keys, its white
 * space, "#ABC" against "#aabbcc", 1.0 against 1 and a default written out or left out all give
 * the same text. Changing what this returns for an existing chart charges that chart again: do
 * not, without bumping the key versions in src/charts/service.ts on purpose.
 */
export function canonicalChart(chart: Chart): string {
  return JSON.stringify([
    chart.type,
    chart.title,
    chart.subtitle,
    chart.labels,
    chart.series.map((series) => [series.name, series.data, series.color ?? null]),
    chart.horizontal,
    chart.stacked,
    chart.legend,
    chart.values,
    chart.xTitle,
    chart.yTitle,
    chart.format.prefix,
    chart.format.suffix,
    chart.format.decimals ?? null,
    chart.min ?? null,
    chart.max ?? null,
    chart.theme,
    chart.background ?? null,
    chart.width,
    chart.height,
    chart.scale,
  ])
}
