// The value axis: "nice" tick values, and number formatting. Pure functions, no layout.
import type { NumberFormat } from './spec'

export interface Scale {
  min: number
  max: number
  step: number
  /** Multiples of `step` inside [min, max], ascending. */
  ticks: number[]
}

const MIN_RELATIVE_RANGE = 1e-9
const MAX_TICKS = 50

/** Rounds away binary noise (0.1 + 0.2) without touching real digits. */
const tidy = (value: number): number => Number(value.toPrecision(12))

/**
 * The smallest step of the form 1, 2, 2.5, 5 x 10^n that covers `range` in at most
 * `maxIntervals` intervals. 2.5 is only used where it gives whole numbers (25, 250, ...),
 * and with `wholeNumbers` (data that are all counts) the step is never below 1.
 */
export function niceStep(range: number, maxIntervals: number, wholeNumbers = false): number {
  const raw = range / Math.max(1, maxIntervals)
  const exponent = Math.floor(Math.log10(raw))
  const magnitude = 10 ** exponent
  const fraction = raw / magnitude
  const multiples = exponent >= 1 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10]
  const step = tidy(multiples.find((m) => m >= fraction - 1e-9)! * magnitude)
  return wholeNumbers ? Math.max(1, step) : step
}

export interface ScaleOptions {
  /** Upper limit for the number of intervals between ticks (from the pixels available). */
  maxIntervals: number
  /** Axis ends set by the caller; they are used exactly, even when they are not round. */
  min?: number
  max?: number
  wholeNumbers?: boolean
}

/** A scale that covers [low, high] and ends on round numbers. A flat range is widened so the axis still has two ends. */
export function niceScale(low: number, high: number, options: ScaleOptions): Scale {
  let lo = options.min ?? low
  let hi = options.max ?? high
  // Ends that are equal, or closer together than a billionth of their size, give no usable step
  // (and tick numbers too large to count in): the range is widened as for a flat one.
  if (hi - lo <= Math.max(Math.abs(lo), Math.abs(hi)) * MIN_RELATIVE_RANGE) {
    // All values equal (often all zero, or one point), or a fixed end beyond the data.
    if (options.min !== undefined) hi = lo + (Math.abs(lo) || 1)
    else if (options.max !== undefined) lo = hi - (Math.abs(hi) || 1)
    else if (lo === 0) hi = 1
    else if (lo > 0) lo = 0
    else hi = 0
  }
  const build = (step: number): Scale => {
    const min = options.min ?? tidy(Math.floor(lo / step + 1e-9) * step)
    const max = options.max ?? tidy(Math.ceil(hi / step - 1e-9) * step)
    const first = Math.ceil(min / step - 1e-9)
    const count = Math.floor(max / step + 1e-9) - first
    const ticks: number[] = []
    // The step comes from the range, so there are only a few ticks; the bound keeps the loop finite whatever the input.
    for (let i = 0; i <= count && i < MAX_TICKS; i++) ticks.push(tidy((first + i) * step))
    return { min, max, step, ticks }
  }
  let scale = build(niceStep(hi - lo, options.maxIntervals, options.wholeNumbers))
  // Rounding the ends outwards can add an interval; ask for fewer until it fits.
  for (let intervals = options.maxIntervals - 1; scale.ticks.length - 1 > options.maxIntervals && intervals >= 1; intervals--) {
    scale = build(niceStep(hi - lo, intervals, options.wholeNumbers))
  }
  // One size coarser sometimes hugs the data more closely: -50k..50k in steps of 25k instead of
  // -60k..60k in steps of 20k. It is taken when it still leaves at least five ticks.
  const coarser = build(niceStep(scale.step * 1.01, 1, options.wholeNumbers))
  if (coarser.max - coarser.min < scale.max - scale.min && coarser.ticks.length >= 5) scale = coarser
  return scale
}

/** Decimals needed to write `value` exactly (0.25 -> 2), at most 6. */
export function decimalsOf(value: number): number {
  for (let decimals = 0; decimals < 6; decimals++) {
    if (Math.abs(value - Number(value.toFixed(decimals))) < Math.abs(value) * 1e-9) return decimals
  }
  return 6
}

const UNITS: ReadonlyArray<[number, string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
]
/** From this size on, an axis is written compactly (12k, 1.4M); below it numbers are written in full (4,200). */
export const COMPACT_FROM = 10_000
const MINUS = '−'

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function fixed(value: number, decimals: number, trim: boolean): string {
  const [whole, fraction = ''] = value.toFixed(decimals).split('.')
  const kept = trim ? fraction.replace(/0+$/, '') : fraction
  return kept ? `${group(whole!)}.${kept}` : group(whole!)
}

/** `abs` >= 1000, written with a unit letter and three significant digits unless the decimals are fixed: 1.42M, 12.3k, 812k. */
function compact(abs: number, decimals: number | undefined): string {
  const places = (scaled: number): number => decimals ?? (scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)
  let unit = UNITS.findIndex(([size]) => abs >= size)
  // 999,950 must not become "1,000k".
  if (unit > 0 && Number((abs / UNITS[unit]![0]).toFixed(places(abs / UNITS[unit]![0]))) >= 1000) unit--
  const [size, letter] = UNITS[unit]!
  return fixed(abs / size, places(abs / size), decimals === undefined) + letter
}

export interface Formatter {
  /** A tick on the value axis. */
  tick(value: number): string
  /** A value printed on a bar, point or slice (one more decimal than the ticks when the data need it). */
  value(value: number): string
}

/**
 * One number style per chart. `reach` is the largest absolute value on the axis and `step` the
 * distance between ticks: compact from 10,000 up, in full below, decimals from the step unless
 * `format.decimals` fixes them.
 */
export function formatter(format: NumberFormat, reach: number, step: number): Formatter {
  const isCompact = reach >= COMPACT_FROM
  const stepDecimals = decimalsOf(step)
  const write = (value: number, autoDecimals: number): string => {
    const abs = Math.abs(value)
    const digits = isCompact && abs >= 1000 ? compact(abs, format.decimals) : fixed(abs, format.decimals ?? autoDecimals, format.decimals === undefined)
    // "-0" and "-0.0" are zero.
    const negative = value < 0 && /[1-9]/.test(digits)
    return `${negative ? MINUS : ''}${format.prefix}${digits}${format.suffix}`
  }
  return {
    tick: (value) => write(value, Math.min(6, stepDecimals)),
    value: (value) => write(value, Math.min(4, stepDecimals + 1)),
  }
}
