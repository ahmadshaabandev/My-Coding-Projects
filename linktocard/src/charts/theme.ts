// The default look: neutral, not the Link To Card brand. Colours, and every size as a function
// of the chart's width and height.

export interface Theme {
  /** Chart background, also the colour of the gaps between touching marks. */
  surface: string
  /** Title and values. */
  ink: string
  /** Axis text, legend, subtitle. */
  ink2: string
  grid: string
  /** Zero line / baseline. */
  axis: string
  /** Eight series colours in a fixed order; neighbours stay apart for colour-blind readers. */
  palette: readonly string[]
  /** Ninth colour. */
  neutral: string
}

// Palette, order and inks: the validated reference palette (blue, orange, aqua, yellow, magenta,
// green, violet, red). Checked with a colour-vision-deficiency simulator: the worst neighbouring
// pair keeps a distance of 11.8 (light) and 10.1 (dark) in OKLab x100, target >= 8.
export const LIGHT: Theme = {
  surface: '#ffffff',
  ink: '#191919',
  ink2: '#666666',
  grid: '#e7e7e7',
  axis: '#c2c2c2',
  palette: ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6a4ce2', '#ec4647'],
  neutral: '#8f8f8f',
}

export const DARK: Theme = {
  surface: '#191919',
  ink: '#efefef',
  ink2: '#9c9c9c',
  grid: '#303030',
  axis: '#474747',
  palette: ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'],
  neutral: '#8a8a8a',
}

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]
const toHex = (rgb: number[]): string => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

/** `color` moved towards `towards` by `amount` (0..1). */
export function mix(color: string, towards: string, amount: number): string {
  const a = channels(color)
  const b = channels(towards)
  return toHex(a.map((c, i) => c + (b[i]! - c) * amount))
}

/**
 * Colour of series or slice `index`. The first eight are the palette, the ninth a neutral grey;
 * after that the palette repeats as tints, which are distinct for normal vision but were not
 * checked for colour-blind readers.
 */
export function seriesColor(theme: Theme, index: number): string {
  const { palette } = theme
  if (index < palette.length) return palette[index]!
  if (index === palette.length) return theme.neutral
  const round = Math.floor((index - palette.length - 1) / palette.length)
  return mix(palette[(index - palette.length - 1) % palette.length]!, theme.surface, round % 2 === 0 ? 0.45 : 0.7)
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Ink for a label printed inside a filled mark: white, or near-black on light fills such as yellow. */
export const inkOn = (fill: string): string => (luminance(fill) > 0.42 ? '#0b0b0b' : '#ffffff')

export interface Sizes {
  /** Axis text, legend, value labels. */
  font: number
  title: number
  subtitle: number
  /** Outer margin. */
  pad: number
  /** Space between unrelated parts (title block and plot, plot and axis title). */
  gap: number
  /** Line and marker weights. */
  stroke: number
  marker: number
}

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
/** Height of a one-line text box. */
export const lineHeight = (size: number): number => Math.ceil(size * 1.3)

/** Everything scales with the square root of the chart's area: 9px text at 300x200, 11px at 600x360, 15px at 1200x630. */
export function sizesFor(width: number, height: number): Sizes {
  const k = Math.sqrt((width * height) / (600 * 400))
  const font = clamp(Math.round(11 * Math.sqrt(k)), 9, 15)
  return {
    font,
    title: Math.round(font * 1.45),
    subtitle: font + 1,
    pad: Math.round(font * 1.45),
    gap: Math.round(font * 0.9),
    stroke: clamp(font / 5.5, 1.5, 3),
    marker: clamp(font / 3.2, 3, 5),
  }
}
