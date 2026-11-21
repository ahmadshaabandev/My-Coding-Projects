// Render engine: Satori VDOM -> SVG (satori) -> RGBA / PNG (resvg-wasm) -> JPEG / WebP (jSquash).
// Everything here runs inside workerd. No headless browser, no network access.
//
// workerd forbids compiling WebAssembly from bytes at runtime, so every .wasm is imported as a
// precompiled WebAssembly.Module (wrangler.toml `rules` type CompiledWasm) and instantiated
// lazily, exactly once per isolate.
import satori, { init as initSatori } from 'satori/standalone'
import layoutWasm from 'satori/layout.wasm'
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import encodeJpeg, { init as initJpegEncoder } from '@jsquash/jpeg/encode.js'
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js'
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc.wasm'
import { FONTS } from './fonts'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

/** React-element-like object accepted by Satori ("Use without JSX" in its README). */
export interface VNode {
  type: string
  key?: string | number | null
  props: {
    style?: Record<string, string | number>
    children?: VChild | VChild[]
    [prop: string]: unknown
  }
}
export type VChild = VNode | string | number | null | undefined | false

export interface RenderOptions {
  width: number
  height: number
  format: ImageFormat
  /** JPEG / WebP quality 1-100. Default 85. */
  quality?: number
  /** Opaque colour painted behind the card. Default '#ffffff'. */
  background?: string
}

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

// ---------------------------------------------------------------------------
// One-time wasm initialisation.
//
// The registry lives on globalThis rather than in module scope: under vitest the
// module graph can be evaluated more than once inside the same isolate, while the
// wasm libraries keep their own "already initialised" state.
// ---------------------------------------------------------------------------
type InitName = 'satori' | 'resvg' | 'jpeg' | 'webp'
interface InitRegistry {
  promises: Partial<Record<InitName, Promise<void>>>
  /** How many times each initialiser actually ran (must stay at 1). */
  runs: Partial<Record<InitName, number>>
}
const REGISTRY_KEY = Symbol.for('linktocard.render.init')
const globalRegistry = globalThis as unknown as Record<symbol, InitRegistry | undefined>
const registry: InitRegistry = (globalRegistry[REGISTRY_KEY] ??= { promises: {}, runs: {} })

function once(name: InitName, run: () => Promise<unknown>): Promise<void> {
  let promise = registry.promises[name]
  if (!promise) {
    registry.runs[name] = (registry.runs[name] ?? 0) + 1
    promise = run().then(
      () => undefined,
      (error: unknown) => {
        // Let the next request retry instead of caching the failure forever.
        delete registry.promises[name]
        throw error
      },
    )
    registry.promises[name] = promise
  }
  return promise
}

/** Number of times each wasm initialiser ran in this isolate (for tests / diagnostics). */
export function initRuns(): Readonly<Partial<Record<InitName, number>>> {
  return { ...registry.runs }
}

const ensureSatori = () => once('satori', async () => initSatori(layoutWasm))

const ensureResvg = () =>
  once('resvg', async () => {
    try {
      await initResvg(resvgWasm)
    } catch (error) {
      // resvg-wasm throws if initWasm() is called twice; that state is fine for us.
      if (!(error instanceof Error && error.message.includes('Already initialized'))) throw error
    }
  })

const ensureJpeg = () => once('jpeg', () => initJpegEncoder(jpegEncWasm))
const ensureWebp = () => once('webp', () => initWebpEncoder(webpEncWasm))

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/** Satori VDOM -> SVG string (text is converted to paths, so resvg needs no fonts). */
export async function renderSvg(
  vdom: VNode,
  size: { width: number; height: number },
): Promise<string> {
  await ensureSatori()
  return satori(vdom as unknown as Parameters<typeof satori>[0], {
    width: size.width,
    height: size.height,
    fonts: FONTS,
  })
}

interface Raster {
  width: number
  height: number
  /** RGBA, 8 bit per channel, premultiplied alpha (see rasterize()). */
  pixels: Uint8Array
}

function withResvg<T>(svg: string, width: number, background: string, use: (image: ReturnType<InstanceType<typeof Resvg>['render']>) => T): T {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background,
    font: { loadSystemFonts: false },
  })
  try {
    const image = resvg.render()
    try {
      return use(image)
    } finally {
      image.free()
    }
  } finally {
    resvg.free()
  }
}

/**
 * SVG -> RGBA pixels. resvg (tiny-skia) returns PREMULTIPLIED alpha. Because an opaque
 * `background` is always painted first, every pixel has alpha 255 and premultiplied equals
 * straight alpha, so the buffer can be handed to the JPEG / WebP encoders unchanged.
 */
export async function rasterize(svg: string, width: number, background = '#ffffff'): Promise<Raster> {
  await ensureResvg()
  // Copy out of wasm memory before the image is freed.
  return withResvg(svg, width, background, (image) => ({
    width: image.width,
    height: image.height,
    pixels: image.pixels.slice(),
  }))
}

export async function svgToPng(svg: string, width: number, background = '#ffffff'): Promise<Uint8Array> {
  await ensureResvg()
  return withResvg(svg, width, background, (image) => image.asPng().slice())
}

function toImageData(raster: Raster): ImageData {
  // jSquash only reads .data/.width/.height, so a plain object is enough (workerd has no ImageData).
  return {
    data: new Uint8ClampedArray(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength),
    width: raster.width,
    height: raster.height,
  } as unknown as ImageData
}

export async function encodeRasterJpeg(raster: Raster, quality = 85): Promise<Uint8Array> {
  await ensureJpeg()
  return new Uint8Array(await encodeJpeg(toImageData(raster), { quality }))
}

export async function encodeRasterWebp(raster: Raster, quality = 85): Promise<Uint8Array> {
  await ensureWebp()
  return new Uint8Array(await encodeWebp(toImageData(raster), { quality }))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Satori VDOM + {width,height,format} -> encoded image bytes. */
export async function render(vdom: VNode, options: RenderOptions): Promise<Uint8Array> {
  const { width, height, format, quality = 85, background = '#ffffff' } = options
  const svg = await renderSvg(vdom, { width, height })
  if (format === 'png') return svgToPng(svg, width, background)
  const raster = await rasterize(svg, width, background)
  return format === 'jpeg' ? encodeRasterJpeg(raster, quality) : encodeRasterWebp(raster, quality)
}

export const renderPng = (vdom: VNode, size: { width: number; height: number }) =>
  render(vdom, { ...size, format: 'png' })
export const renderJpeg = (vdom: VNode, size: { width: number; height: number }, quality?: number) =>
  render(vdom, { ...size, format: 'jpeg', quality })
export const renderWebp = (vdom: VNode, size: { width: number; height: number }, quality?: number) =>
  render(vdom, { ...size, format: 'webp', quality })
