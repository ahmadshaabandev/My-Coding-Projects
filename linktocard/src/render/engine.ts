// Render engine: Satori VDOM -> SVG (satori) -> RGBA / PNG (resvg-wasm) -> JPEG / WebP (jSquash).
// Everything here runs inside workerd. No headless browser, no network access.
// The template pipeline on top of these stages is src/render/index.ts.
//
// workerd forbids compiling WebAssembly from bytes at runtime, so every .wasm is imported as a
// precompiled WebAssembly.Module (wrangler.toml `rules` type CompiledWasm) and instantiated
// lazily, exactly once per isolate.

// Must stay the FIRST import: it has to run before the satori module is evaluated.
import { harfbuzzShimHits } from './satori-workerd-shim'
import satori, { init as initSatori } from 'satori/standalone'
import layoutWasm from 'satori/layout.wasm'
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import encodeJpeg, { init as initJpegEncoder } from '@jsquash/jpeg/encode.js'
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js'
// @jsquash/webp picks its SIMD build when wasm-feature-detect's simd() is true, which it is in
// workerd, so the SIMD binary is the one that has to be supplied (same as jSquash's own
// Cloudflare Workers example). tests/spike.test.ts fails loudly if that ever stops matching.
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm'
import type { ImageFormat } from '../config'
import { FONTS, type RenderFont } from './fonts'
import { assertSafeVdom, DEFAULT_LIMITS, RenderInputError, type GuardLimits } from './guard'

export { RenderInputError, DEFAULT_LIMITS, type GuardLimits } from './guard'

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

/** Opaque colour painted behind every card, so the output never has transparency. */
const BACKGROUND = '#ffffff'

/**
 * Encoder settings, chosen from the timings in research/spike-render.md section 5:
 *  - JPEG q85 non-progressive: 50 ms / 32.7 kB against 99 ms / 28.4 kB progressive.
 *  - WebP q85 method 2: 39 ms / 18.7 kB against 64 ms / 18.4 kB for the default method 4
 *    (method 0 is faster still but 17% larger).
 */
const JPEG_OPTIONS = { quality: 85, progressive: false } as const
const WEBP_OPTIONS = { quality: 85, method: 2 } as const

// ---------------------------------------------------------------------------
// One-time wasm initialisation.
//
// Each library keeps its "initialised" state inside its own module instance. In production
// every module is evaluated once per isolate, but under vitest (vi.resetModules(), or the next
// test file) THIS module can be evaluated again while a library is not - or a library can be
// evaluated again and need a fresh init. So the init promise is remembered per library
// instance: a WeakMap on globalThis keyed by that library's own init function.
//   - same library instance, our module re-evaluated  -> promise reused, no second init
//     (resvg-wasm would throw "Already initialized", Satori would create a second engine)
//   - library re-evaluated (new function identity)     -> initialised again, as it must be
//     (skipping it makes satori() wait forever for a layout engine that never arrives)
// ---------------------------------------------------------------------------
type InitName = 'satori' | 'resvg' | 'jpeg' | 'webp'
interface InitRegistry {
  promises: WeakMap<object, Promise<void>>
  /** How many times each initialiser actually ran in this isolate (1 in production). */
  runs: Partial<Record<InitName, number>>
}
const REGISTRY_KEY = Symbol.for('linktocard.render.init')
const globalRegistry = globalThis as unknown as Record<symbol, InitRegistry | undefined>
const registry: InitRegistry = (globalRegistry[REGISTRY_KEY] ??= { promises: new WeakMap(), runs: {} })

function once(name: InitName, libraryInit: object, run: () => Promise<unknown>): Promise<void> {
  let promise = registry.promises.get(libraryInit)
  if (!promise) {
    registry.runs[name] = (registry.runs[name] ?? 0) + 1
    promise = run().then(
      () => undefined,
      (error: unknown) => {
        // Let the next request retry instead of caching the failure forever.
        registry.promises.delete(libraryInit)
        throw error
      },
    )
    registry.promises.set(libraryInit, promise)
  }
  return promise
}

/** Number of times each wasm initialiser ran in this isolate (for tests / diagnostics). */
export function initRuns(): Readonly<Partial<Record<InitName | 'harfbuzz', number>>> {
  return { ...registry.runs, harfbuzz: harfbuzzShimHits() }
}

const ensureSatori = () => once('satori', initSatori, async () => initSatori(layoutWasm))

const ensureResvg = () =>
  once('resvg', initResvg, async () => {
    try {
      await initResvg(resvgWasm)
    } catch (error) {
      // resvg-wasm throws if initWasm() is called twice; that state is fine for us.
      if (!(error instanceof Error && error.message.includes('Already initialized'))) throw error
    }
  })

const ensureJpeg = () => once('jpeg', initJpegEncoder, () => initJpegEncoder(jpegEncWasm))
const ensureWebp = () => once('webp', initWebpEncoder, () => initWebpEncoder(webpEncWasm))

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/** Options passed straight through to Satori (see node_modules/satori/dist/standalone.d.ts). */
export interface SvgOptions {
  width: number
  height: number
  /** Defaults to the bundled FONTS. Pass a stable (module-level) array: Satori caches by identity. */
  fonts?: RenderFont[]
  /** grapheme -> image data URI (e.g. emoji). */
  graphemeImages?: Record<string, string>
  /**
   * Called for text no loaded font covers. `languageCode` is 'emoji', 'symbol', 'math', 'unknown'
   * or one or more locales joined with '|' (e.g. 'ja-JP|zh-CN|zh-TW|zh-HK', 'ar-AR', 'he-IL').
   * Return an image data URI (string) or extra fonts. MUST NOT do network I/O in this product.
   */
  loadAdditionalAsset?: (languageCode: string, segment: string) => Promise<string | RenderFont[]>
  /** Receives invalid / unsupported declarations instead of failing the whole render. */
  onStyleError?: (error: Error) => void
  /** Receives the layout box of every node. */
  onNodeDetected?: (node: LayoutBox) => void
  debug?: boolean
  /** Node-count / depth limits enforced before Satori runs. */
  limits?: Partial<GuardLimits>
  /**
   * Skips the "data: URIs only" guard. Satori will then fetch() http(s) images by itself.
   * Exists for the characterisation tests only - never set it in product code.
   */
  unsafeAllowRemoteUrls?: boolean
}

export interface LayoutBox {
  left: number
  top: number
  width: number
  height: number
  type: string
  key?: string | number
  props: Record<string, unknown>
  textContent?: string
}

/** Satori VDOM -> SVG string (text is converted to paths, so resvg needs no fonts). */
export async function renderSvg(vdom: VNode, options: SvgOptions): Promise<string> {
  const { fonts = FONTS, limits, unsafeAllowRemoteUrls, ...rest } = options
  if (!unsafeAllowRemoteUrls) {
    assertSafeVdom(vdom, { ...DEFAULT_LIMITS, ...limits })
    // Images handed to Satori through the side doors must be inline too.
    for (const [grapheme, src] of Object.entries(rest.graphemeImages ?? {})) {
      if (!src.startsWith('data:')) throw new RenderInputError(`graphemeImages[${grapheme}] must be a data: URI.`)
    }
    const load = rest.loadAdditionalAsset
    if (load) {
      rest.loadAdditionalAsset = async (languageCode, segment) => {
        const asset = await load(languageCode, segment)
        if (typeof asset === 'string' && !asset.startsWith('data:')) {
          throw new RenderInputError('loadAdditionalAsset must return a data: URI or fonts.')
        }
        return asset
      }
    }
  }
  await ensureSatori()
  return satori(vdom as unknown as Parameters<typeof satori>[0], { ...rest, fonts })
}

/** Instantiates every wasm module now (otherwise each is initialised on first use). */
export async function warmUp(): Promise<void> {
  await Promise.all([ensureSatori(), ensureResvg(), ensureJpeg(), ensureWebp()])
}

interface Raster {
  width: number
  height: number
  /** RGBA, 8 bit per channel, premultiplied alpha (see rasterize()). */
  pixels: Uint8Array
}

type RenderedImage = ReturnType<InstanceType<typeof Resvg>['render']>

function withResvg<T>(svg: string, width: number, background: string, use: (image: RenderedImage) => T): T {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background,
    font: { loadSystemFonts: false },
  })
  let image: RenderedImage | undefined
  try {
    image = resvg.render()
    return use(image)
  } finally {
    // If render() trapped inside wasm ("RuntimeError: unreachable", e.g. out of memory on a
    // huge filter region), free() throws "recursive use of an object detected which would
    // lead to unsafe aliasing in rust". Swallow that so the original error is the one reported.
    try {
      image?.free()
    } catch {}
    try {
      resvg.free()
    } catch {}
  }
}

/**
 * SVG -> RGBA pixels. resvg (tiny-skia) returns PREMULTIPLIED alpha. Because an opaque
 * `background` is always painted first, every pixel has alpha 255 and premultiplied equals
 * straight alpha, so the buffer can be handed to the JPEG / WebP encoders unchanged.
 */
export async function rasterize(svg: string, width: number, background = BACKGROUND): Promise<Raster> {
  await ensureResvg()
  // Copy out of wasm memory before the image is freed.
  return withResvg(svg, width, background, (image) => ({
    width: image.width,
    height: image.height,
    pixels: image.pixels.slice(),
  }))
}

export async function svgToPng(svg: string, width: number, background = BACKGROUND): Promise<Uint8Array> {
  await ensureResvg()
  return withResvg(svg, width, background, (image) => image.asPng().slice())
}

/**
 * jSquash types its input as DOM `ImageData`, which workerd does not have. It only reads
 * .data/.width/.height, so a plain object is enough.
 */
function toImageData<T>(raster: Raster): T {
  return {
    data: new Uint8ClampedArray(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength),
    width: raster.width,
    height: raster.height,
  } as T
}

export async function encodeRasterJpeg(raster: Raster): Promise<Uint8Array> {
  await ensureJpeg()
  return new Uint8Array(await encodeJpeg(toImageData<Parameters<typeof encodeJpeg>[0]>(raster), JPEG_OPTIONS))
}

export async function encodeRasterWebp(raster: Raster): Promise<Uint8Array> {
  await ensureWebp()
  return new Uint8Array(await encodeWebp(toImageData<Parameters<typeof encodeWebp>[0]>(raster), WEBP_OPTIONS))
}

export interface EncodedImage {
  bytes: Uint8Array
  /** SVG -> pixels (resvg), ms; for PNG this includes the PNG encoding. */
  rasterMs: number
  /** Pixels -> JPEG / WebP, ms (0 for PNG). */
  encodeMs: number
}

/** SVG -> encoded image on an opaque white background. */
export async function encodeSvg(svg: string, width: number, format: ImageFormat): Promise<EncodedImage> {
  const started = performance.now()
  if (format === 'png') {
    const bytes = await svgToPng(svg, width)
    return { bytes, rasterMs: performance.now() - started, encodeMs: 0 }
  }
  const raster = await rasterize(svg, width)
  const rastered = performance.now()
  const bytes = format === 'jpeg' ? await encodeRasterJpeg(raster) : await encodeRasterWebp(raster)
  return { bytes, rasterMs: rastered - started, encodeMs: performance.now() - rastered }
}
