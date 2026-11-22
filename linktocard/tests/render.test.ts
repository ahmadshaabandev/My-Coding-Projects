// End-to-end tests of the render pipeline (src/render/index.ts), inside workerd:
// HTML + CSS + data in, encoded image bytes out. Pixels are checked by decoding the PNG.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { LIMITS, SIZES, type ImageFormat } from '../src/config'
import { ApiError } from '../src/lib/errors'
import { renderCard, warmUp } from '../src/render'
import { RenderInputError, renderSvg } from '../src/render/engine'
import { SAMPLE_CSS, SAMPLE_HTML, sampleData, sampleDeps } from '../src/render/sample-card'
import { bindTemplate, buildDocument, parseTemplate } from '../src/render/template'
import type { LoadedFont, RenderDeps, RenderInput, RenderOutput, TemplateData, WatermarkMode } from '../src/types'
import serifLatin400 from '../src/render/fonts/source-serif-4-latin-400-normal.woff'
import { colourAt, decodePng, diffPixels, ink, pngSize, redImages, type Raster } from './helpers'

const OG = { width: 1200, height: 630 }
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

/** Deps whose image fetcher fails the test if it is reached. */
const noDeps: RenderDeps = {
  fetchImage: async (url) => {
    throw new Error(`unexpected fetchImage(${url})`)
  },
}

interface CardOptions {
  css?: string
  data?: TemplateData
  size?: { width: number; height: number }
  format?: ImageFormat
  watermark?: WatermarkMode
  deps?: RenderDeps
}

const input = (html: string, { css = '', data = {}, size = OG, format = 'png', watermark = 'none' }: CardOptions = {}): RenderInput => ({
  html,
  css,
  data,
  ...size,
  format,
  watermark,
})
const card = (html: string, options: CardOptions = {}): Promise<RenderOutput> => renderCard(input(html, options), options.deps ?? noDeps)
const pixels = async (html: string, options: CardOptions = {}): Promise<Raster> => decodePng((await card(html, options)).bytes)

/** Runs a render that must fail and returns the ApiError; nothing else may come back. */
async function failure(html: string, options: CardOptions = {}): Promise<ApiError> {
  const result = await card(html, options).then(
    (output) => output,
    (error: unknown) => error,
  )
  if (!(result instanceof ApiError)) throw new Error(`expected an ApiError, got ${result instanceof Error ? result.message : 'image bytes'}`)
  return result
}

const BOX = '.box{width:100px;height:100px}'
let images: Awaited<ReturnType<typeof redImages>>
let fetchSpy: MockInstance<typeof fetch>

beforeAll(async () => {
  await warmUp()
  images = await redImages()
})

// The renderer must never touch the network: every test runs with fetch() booby-trapped.
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    throw new Error(`the renderer called fetch(${String(request)})`)
  })
})
afterEach(() => {
  expect(fetchSpy.mock.calls).toEqual([])
  vi.restoreAllMocks()
})

describe('output formats and sizes', () => {
  it('renders a PNG with the right signature and IHDR size for every preset', async () => {
    for (const size of Object.values(SIZES)) {
      const out = await card('<h1>{{title}}</h1>', { data: { title: 'Hello' }, size })
      expect([...out.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(ascii(out.bytes, 12, 16)).toBe('IHDR')
      expect(pngSize(out.bytes)).toEqual({ width: size.width, height: size.height })
      expect(out).toMatchObject({ contentType: 'image/png', width: size.width, height: size.height, warnings: [] })
    }
  })

  it('renders JPEG (baseline, not progressive) and WebP', async () => {
    const jpeg = await card('<h1>Hello</h1>', { format: 'jpeg' })
    expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect([...jpeg.bytes.subarray(-2)]).toEqual([0xff, 0xd9])
    expect(jpeg.contentType).toBe('image/jpeg')
    // SOF2 (ff c2) marks a progressive JPEG; a sequential one has SOF0 or SOF1.
    const markers = new Set<number>()
    for (let i = 0; i < jpeg.bytes.length - 1; i++) if (jpeg.bytes[i] === 0xff) markers.add(jpeg.bytes[i + 1]!)
    expect(markers.has(0xc2)).toBe(false)
    expect(markers.has(0xc0) || markers.has(0xc1)).toBe(true)

    const webp = await card('<h1>Hello</h1>', { format: 'webp' })
    expect(ascii(webp.bytes, 0, 4)).toBe('RIFF')
    expect(ascii(webp.bytes, 8, 12)).toBe('WEBP')
    expect(new DataView(webp.bytes.buffer, webp.bytes.byteOffset).getUint32(4, true) + 8).toBe(webp.bytes.byteLength)
    expect(webp.contentType).toBe('image/webp')
  })

  it('is always opaque: a transparent template renders on white', async () => {
    const raster = await pixels('<p>x</p>', { css: 'html,body{background:transparent}' })
    expect(colourAt(raster, 600, 400)).toBe('white')
    let minAlpha = 255
    for (let i = 3; i < raster.pixels.length; i += 4) minAlpha = Math.min(minAlpha, raster.pixels[i]!)
    expect(minAlpha).toBe(255)
  })

  it('refuses sizes and formats outside the product', async () => {
    expect((await failure('<p>x</p>', { size: { width: 4000, height: 4000 } })).code).toBe('unsupported_size')
    expect((await failure('<p>x</p>', { size: { width: 1200.5, height: 630 } })).code).toBe('unsupported_size')
    expect((await failure('<p>x</p>', { format: 'gif' as ImageFormat })).code).toBe('unsupported_format')
    expect((await failure('<p>x</p>', { watermark: 'off' as WatermarkMode })).code).toBe('invalid_request')
  })

  it('produces byte-identical output for identical input, in every format', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const render = () => renderCard({ html: SAMPLE_HTML, css: SAMPLE_CSS, data: sampleData(), ...OG, format, watermark: 'free' }, sampleDeps)
      const [first, second] = [await render(), await render()]
      expect(first.bytes.byteLength).toBeGreaterThan(5_000)
      expect(second.bytes).toEqual(first.bytes)
    }
  })

  it('renders a typical card in well under one second when warm', async () => {
    const render = (title: string) => renderCard({ html: SAMPLE_HTML, css: SAMPLE_CSS, data: sampleData(title), ...OG, format: 'png', watermark: 'free' }, sampleDeps)
    await render('Warm up')
    const out = await render('A different title, so nothing is served from a cache')
    console.log('warm sample card timings (ms)', JSON.stringify(out.timings))
    expect(out.timings.totalMs).toBeLessThan(600)
    expect(out.warnings).toEqual([])
    const { compileMs, imagesMs, layoutMs, rasterMs, encodeMs, totalMs } = out.timings
    expect(compileMs + imagesMs + layoutMs + rasterMs + encodeMs).toBeLessThanOrEqual(totalMs + 1)
  })
})

describe('template language', () => {
  it('substitutes {{placeholders}} in text and in attribute values', async () => {
    const html = '<div class="box {{kind}}" style="background: {{colour}}"></div><p class="t">{{ title }}</p>'
    const css = `${BOX} .wide{width:300px} .t{margin:0;font-size:80px}`
    const filled = await pixels(html, { css, data: { kind: 'wide', colour: '#ff0000', title: 'Hello' } })
    expect(colourAt(filled, 250, 50)).toBe('red')
    expect(ink(filled, { x: 0, y: 100, w: 600, h: 120 })).toBeGreaterThan(1000)

    const empty = await pixels(html, { css })
    expect(colourAt(empty, 50, 50)).toBe('white')
    expect(ink(empty)).toBe(0)
  })

  it('renders markup in a data value as text: no element is created and nothing is fetched', async () => {
    const fetchImage = vi.fn(noDeps.fetchImage)
    const html = '<p class="t">{{title}}</p>'
    const css = '.t{margin:0;font-size:40px} script,img{display:block;width:400px;height:400px;background:#ff0000}'
    const title = '<script>alert(1)</script><img src=http://127.0.0.1/x.png>'
    const raster = await pixels(html, { css, data: { title }, deps: { fetchImage } })
    // Had the value become elements, the CSS above would paint a red block.
    expect(colourAt(raster, 200, 300)).toBe('white')
    // The whole string is drawn as glyphs, so it is much wider than its visible part "alert(1)".
    const width = (value: Raster) => {
      let right = 0
      for (let x = 0; x < value.width; x++) if (ink(value, { x, y: 0, w: 1, h: 60 }) > 0) right = x
      return right
    }
    expect(width(raster)).toBeGreaterThan(900)
    expect(width(await pixels(html, { css, data: { title: 'alert(1)' } }))).toBeLessThan(200)
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('adds size-, theme-, has-/no- and len- classes to <body> so CSS can adapt', async () => {
    const html = '<div class="row"><div class="box s"></div><div class="box t"></div><div class="box h"></div><div class="box l"></div></div><p>{{title}}</p>'
    const css = `${BOX} .row{display:flex}
      .size-og .s{background:#ff0000} .size-square .s{background:#00ff00} .size-portrait .s{background:#0000ff}
      .t{background:#000000} .theme-dark .t{background:#ff0000} .theme-light .t{background:#00ff00}
      .has-title .h{background:#00ff00} .no-title .h{background:#ff0000}
      .len-title-s .l{background:#ff0000} .len-title-m .l{background:#00ff00} .len-title-l .l{background:#0000ff} .len-title-xl .l{background:#000000}`
    const colours = async (data: TemplateData, size = OG) => {
      const raster = await pixels(html, { css, data, size })
      return [50, 150, 250, 350].map((x) => colourAt(raster, x, 50))
    }
    expect(await colours({})).toEqual(['red', 'black', 'red', 'red'])
    expect(await colours({ title: 'Short', theme: 'dark' }, SIZES.square)).toEqual(['green', 'red', 'green', 'red'])
    expect(await colours({ title: 'x'.repeat(45), theme: 'light' }, SIZES.portrait)).toEqual(['blue', 'green', 'green', 'green'])
    expect(await colours({ title: 'x'.repeat(80), theme: 'Dark!' })).toEqual(['red', 'black', 'green', 'blue'])
    expect(await colours({ title: 'x '.repeat(60) })).toEqual(['red', 'black', 'green', 'black'])
  })

  it('applies <style> elements from the HTML and the css argument, in that order', async () => {
    const html = '<style>.a{background:#ff0000} .c{background:#ff0000}</style><div class="box a"></div><div class="box b"></div><div class="box c"></div><style>.d{background:#00ff00}</style><div class="box d"></div>'
    const raster = await pixels(html, { css: `${BOX} .b{background:#0000ff} .c{background:#0000ff}` })
    expect([50, 150, 250, 350].map((y) => colourAt(raster, 50, y))).toEqual(['red', 'blue', 'blue', 'green'])
  })

  it('renders a full HTML document like a fragment and keeps the classes of <body>', async () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>.dark .box{background:#0000ff}</style></head><body class="dark"><div class="box"></div></body></html>'
    const out = await card(html, { css: BOX })
    expect(colourAt(await decodePng(out.bytes), 50, 50)).toBe('blue')
    expect(out.warnings).toEqual(['<meta> is not supported and was removed.', '<title> is not supported and was removed.'])
  })

  it('applies the base stylesheet: border-box sizing, no body margin, dark text on white', async () => {
    const raster = await pixels('<div class="full"></div>', { css: '.full{width:100%;height:100%;padding:40px;border:10px solid #ff0000}' })
    for (const [x, y] of [[4, 4], [1195, 625], [600, 4], [4, 300]] as const) expect(colourAt(raster, x, y)).toBe('red')
    expect(colourAt(raster, 600, 315)).toBe('white')
    const text = await pixels('<p style="font-size:200px;margin:0">I</p>')
    const dark = [...Array(200).keys()].some((x) => colourAt(text, x, 120) === 'black')
    expect(dark).toBe(true)
  })

  it('turns style attributes into styles and survives an invalid declaration with a warning', async () => {
    const out = await card('<div style="width:200px; height:100px; BACKGROUND: #0000ff !important; display:table">x</div><div style="width:200px;height:100px;background:#ff0000"></div>')
    const raster = await decodePng(out.bytes)
    // The first box lost its invalid display (and with it its block size); everything else still applies.
    expect(colourAt(raster, 4, 2)).toBe('blue')
    expect(colourAt(raster, 150, 80)).toBe('red')
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toMatch(/^Ignored style: Invalid value for CSS property "display"/)
  })

  it('draws inline <svg> with case-sensitive attributes and currentColor', async () => {
    const html = '<div style="color:#ff0000"><svg viewBox="0 0 10 10" width="200" height="200"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0"><stop offset="0" stop-color="#0000ff"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><rect width="10" height="5" fill="currentColor"/><rect y="5" width="10" height="5" fill="url(#g)"/></svg></div>'
    const raster = await pixels(html)
    expect(colourAt(raster, 100, 50)).toBe('red')
    expect(colourAt(raster, 100, 150)).toBe('blue')
    expect((await failure('<svg viewBox="0 0 10 10"><text x="0" y="5">hi</text></svg>')).code).toBe('template_error')
  })

  it('removes scripts, event handlers and an <img> without a source, and says so', async () => {
    const out = await card('<script>while(1){}</script><div class="box" onclick="x()" style="background:#00ff00"></div><img src="{{avatar}}" width="100" height="100">', { css: BOX })
    expect(colourAt(await decodePng(out.bytes), 50, 50)).toBe('green')
    expect(out.warnings).toEqual(['<script> is not supported and was removed.', 'Event handler attributes (on*) were removed.'])
  })
})

describe('images', () => {
  const remote = (dataUri: () => string) => vi.fn(async (_url: string) => ({ dataUri: dataUri() }))

  it('loads a remote <img src> through deps.fetchImage and draws the data: URI it returns', async () => {
    const fetchImage = remote(() => images.png)
    const html = '<img src="https://img.test/red.png" width="100" height="100"><img src="{{again}}" width="100" height="100">'
    const raster = await pixels(html, { css: 'img{display:block}', data: { again: 'https://img.test/red.png' }, deps: { fetchImage } })
    expect(colourAt(raster, 50, 50)).toBe('red')
    expect(colourAt(raster, 50, 150)).toBe('red')
    // The same URL twice is one download.
    expect(fetchImage.mock.calls).toEqual([['https://img.test/red.png']])
  })

  it('loads remote CSS url() images - stylesheet, style attribute and ::before content - the same way', async () => {
    const fetchImage = vi.fn(async (url: string) => ({ dataUri: url.endsWith('.jpg') ? images.jpeg : url.endsWith('.png') ? images.png : images.svgUtf8 }))
    const html = '<div class="box a"></div><div class="box" style="background-image:url(\'https://img.test/b.jpg\');background-size:cover"></div><div class="c"></div>'
    const css = `${BOX} .a{background:url(https://img.test/a.svg) 0 0 / 100px 100px no-repeat} .c::before{content:url("https://img.test/c.png")}`
    const out = await card(html, { css, deps: { fetchImage } })
    const raster = await decodePng(out.bytes)
    expect(colourAt(raster, 50, 50)).toBe('red')
    expect(colourAt(raster, 50, 150)).toBe('red')
    // Generated content is drawn at the image's natural size (16x16).
    expect(colourAt(raster, 8, 208)).toBe('red')
    expect(fetchImage.mock.calls.map(([url]) => url).sort()).toEqual(['https://img.test/a.svg', 'https://img.test/b.jpg', 'https://img.test/c.png'])
  })

  it('hands Satori only data: URIs, and the engine guard still refuses anything else', async () => {
    const bound = bindTemplate(parseTemplate('<img src="https://img.test/a.png" width="10" height="10">', 'p{background:url(https://img.test/b.png)}'), {}, OG)
    const fonts = { fontFamilies: () => 'Inter' }
    const inlined = buildDocument(bound, { ...fonts, image: () => images.png }, () => undefined)
    expect(JSON.stringify(inlined)).not.toMatch(/https?:/)
    await expect(renderSvg(inlined, OG)).resolves.toContain('<svg')
    // A resolver bug that lets a remote URL through must not reach Satori's own fetch().
    const leaked = buildDocument(bound, { ...fonts, image: (reference) => (reference.kind === 'remote' ? reference.url : '') }, () => undefined)
    await expect(renderSvg(leaked, OG)).rejects.toBeInstanceOf(RenderInputError)
  })

  it('accepts data: URIs directly, without calling deps.fetchImage', async () => {
    const html = `<img src="${images.png}" width="100" height="100"><div class="box" style="background-image:url(${images.svgUtf8})"></div>`
    const raster = await pixels(html, { css: `${BOX} img{display:block}` })
    expect(colourAt(raster, 50, 50)).toBe('red')
    expect(colourAt(raster, 50, 150)).toBe('red')
  })

  it('refuses relative, file:, javascript: and other non-image URLs before anything is fetched', async () => {
    const fetchImage = remote(() => images.png)
    const refused = [
      '<img src="/local.png">',
      '<img src="local.png">',
      '<img src="//cdn.test/a.png">',
      '<img src="file:///etc/passwd">',
      '<img src="javascript:alert(1)">',
      '<img src="data:text/html;base64,PHNjcmlwdD4=">',
      '<div style="background:url(../a.png)">x</div>',
      '<div style="background:url(file:///etc/passwd)">x</div>',
      '<style>div{background:url(javascript:alert(1))}</style><div>x</div>',
      '<style>div::before{content:url(a.png)}</style><div>x</div>',
    ]
    for (const html of refused) {
      const error = await failure(html, { deps: { fetchImage } })
      expect(error.code, html).toBe('template_error')
      expect(error.status).toBe(422)
    }
    const fromData = await failure('<img src="{{avatar}}">', { data: { avatar: 'javascript:alert(1)' }, deps: { fetchImage } })
    expect(fromData.code).toBe('template_error')
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('drops resource-loading constructs that are not images, with a warning', async () => {
    const fetchImage = remote(() => images.png)
    const html = '<link rel="stylesheet" href="https://x.test/a.css"><div class="box" style="background:#00ff00"></div><svg width="10" height="10"><image href="https://x.test/a.png"/></svg>'
    const css = `@import url("https://x.test/b.css"); @font-face{font-family:X;src:url(https://x.test/x.woff2)} ${BOX}`
    const out = await card(html, { css, deps: { fetchImage } })
    expect(colourAt(await decodePng(out.bytes), 50, 50)).toBe('green')
    expect(out.warnings).toEqual([
      '<link> is not supported and was removed.',
      '<image> inside inline <svg> is not supported and was removed.',
      '@import is not supported and was ignored.',
      '@font-face is not supported and was ignored.',
    ])
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('allows at most LIMITS.maxImagesPerRender distinct remote images', async () => {
    const fetchImage = remote(() => images.png)
    const tags = (count: number) => Array.from({ length: count }, (_, i) => `<img src="https://img.test/${i}.png" width="10" height="10">`).join('')
    await card(tags(LIMITS.maxImagesPerRender), { deps: { fetchImage } })
    expect(fetchImage).toHaveBeenCalledTimes(LIMITS.maxImagesPerRender)
    fetchImage.mockClear()
    expect((await failure(tags(LIMITS.maxImagesPerRender + 1), { deps: { fetchImage } })).code).toBe('template_error')
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('reports image problems as image_fetch_failed', async () => {
    const html = '<img src="https://img.test/a.png" width="10" height="10">'
    const failed = await failure(html, { deps: { fetchImage: async () => Promise.reject(new Error('socket hang up at 10.0.0.7')) } })
    expect(failed.code).toBe('image_fetch_failed')
    expect(failed.message).toBe('Could not load image https://img.test/a.png.')

    const upstream = new ApiError('image_fetch_failed', 'Image is larger than 2 MB.')
    expect(await failure(html, { deps: { fetchImage: async () => Promise.reject(upstream) } })).toBe(upstream)

    // resvg cannot decode WebP, so it must not get that far.
    expect((await failure(html, { deps: { fetchImage: async () => ({ dataUri: images.webp }) } })).code).toBe('image_fetch_failed')
    expect((await failure(html, { deps: { fetchImage: async () => ({ dataUri: 'https://img.test/redirected.png' }) } })).code).toBe('image_fetch_failed')
    const noSize = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>')}`
    expect((await failure(html, { deps: { fetchImage: async () => ({ dataUri: noSize }) } })).code).toBe('image_fetch_failed')
  })
})

describe('limits', () => {
  it('rejects oversized HTML and CSS with payload_too_large', async () => {
    const html = await failure(`<p>${'x'.repeat(LIMITS.maxHtmlBytes)}</p>`)
    expect([html.code, html.status]).toEqual(['payload_too_large', 413])
    const css = await failure('<p>x</p>', { css: `p{color:red}/*${'x'.repeat(LIMITS.maxCssBytes)}*/` })
    expect([css.code, css.status]).toEqual(['payload_too_large', 413])
  })

  it('rejects too many elements, too deep nesting and too much text with template_error', async () => {
    expect((await failure('<i>x</i>'.repeat(LIMITS.maxNodes + 1))).code).toBe('template_error')
    expect((await failure('<div>'.repeat(LIMITS.maxDepth + 1) + 'x' + '</div>'.repeat(LIMITS.maxDepth + 1))).code).toBe('template_error')
    const text = await failure('<p>{{body}}</p>', { data: { body: 'x'.repeat(LIMITS.maxTextChars + 1) } })
    expect(text.code).toBe('template_error')
    expect(text.message).toBe(`The card contains ${LIMITS.maxTextChars + 1} characters of text; the limit is ${LIMITS.maxTextChars}.`)
    // At the limits everything still renders.
    await card('<i>x</i>'.repeat(LIMITS.maxNodes))
    await card('<div>'.repeat(LIMITS.maxDepth) + 'x' + '</div>'.repeat(LIMITS.maxDepth))
    await card('<p>{{body}}</p>', { data: { body: 'word '.repeat(LIMITS.maxTextChars / 5) } })
  })

  it('rejects a blur beyond maxBlurRadiusPx however it is written', async () => {
    const tooBig = LIMITS.maxBlurRadiusPx + 1
    const hidden = [
      `.box{box-shadow:0 0 ${tooBig}px #000}`,
      `:root{--blur:${tooBig}px} .box{box-shadow:0 0 var(--blur) #000}`,
      `.box{text-shadow:0 0 ${tooBig}px #000}`,
      `.box{filter:blur(${tooBig / 2}px)}`,
      `.box{filter:drop-shadow(0 0 ${tooBig / 2}px #000)}`,
      `.box{backdrop-filter:blur(${tooBig / 2}px)}`,
    ]
    for (const css of hidden) {
      const error = await failure('<div class="box">x</div>', { css: BOX + css })
      expect(error.code, css).toBe('template_error')
      expect(error.message).toMatch(/^A shadow or blur is too large/)
    }
    const inline = await failure(`<div class="box" style="box-shadow: 0 0 {{blur}} #000">x</div>`, { css: BOX, data: { blur: '200px' } })
    expect(inline.code).toBe('template_error')
    const insideSvg = await failure('<svg width="100" height="100" viewBox="0 0 100 100"><filter id="f"><feGaussianBlur stdDeviation="80"/></filter><rect width="50" height="50" filter="url(#f)"/></svg>')
    expect(insideSvg.code).toBe('template_error')
    // The largest allowed shadow renders.
    const ok = await pixels('<div class="box">x</div>', { css: `${BOX} .box{margin:60px;box-shadow:0 0 ${LIMITS.maxBlurRadiusPx}px #000}` })
    expect(ink(ok, { x: 40, y: 40, w: 20, h: 140 })).toBeGreaterThan(100)
  })

  it('rejects more than maxFilterEffects shadow / filter effects', async () => {
    const boxes = (count: number) => '<div class="box"></div>'.repeat(count)
    const css = '.box{width:40px;height:40px;margin:20px;box-shadow:0 2px 4px #000}'
    await card(boxes(LIMITS.maxFilterEffects), { css })
    const error = await failure(boxes(LIMITS.maxFilterEffects + 1), { css })
    expect(error.code).toBe('template_error')
    expect(error.message).toMatch(new RegExp(`^The card uses ${LIMITS.maxFilterEffects + 1} shadow / filter effects; the limit is ${LIMITS.maxFilterEffects}\\.`))
    // Layers of one shadow count separately.
    const layers = Array.from({ length: LIMITS.maxFilterEffects + 1 }, (_, i) => `0 ${i}px 2px #000`).join(',')
    expect((await failure(boxes(1), { css: `.box{width:40px;height:40px;box-shadow:${layers}}` })).code).toBe('template_error')
  })

  it('stops with render_timeout when resources take longer than the budget', async () => {
    vi.useFakeTimers()
    try {
      const pending = failure('<img src="https://img.test/slow.png" width="10" height="10">', { deps: { fetchImage: () => new Promise(() => undefined) } })
      await vi.advanceTimersByTimeAsync(LIMITS.renderTimeoutMs + 1)
      const error = await pending
      expect([error.code, error.status]).toEqual(['render_timeout', 504])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unexpected engine failures as render_failed without internals', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const corrupt: LoadedFont[] = [{ family: 'Broken', weight: 400, style: 'normal', data: new ArrayBuffer(64) }]
    const error = await failure('<p style="font-family:Broken">x</p>', { deps: { ...noDeps, loadFonts: async () => corrupt } })
    expect([error.code, error.status, error.message]).toEqual(['render_failed', 500, 'The card could not be rendered.'])
    expect(error.details).toBeUndefined()
    expect(logged).toHaveBeenCalledTimes(1)
    // The isolate is still usable afterwards.
    await card('<p>x</p>')
  })
})

describe('watermark', () => {
  // The badge sits bottom-right with a 16px margin and is 28px tall at 1200x630.
  const CORNER = { x: 960, y: 580, w: 240, h: 50 }
  const REST = { x: 0, y: 0, w: 1200, h: 560 }
  const modes = async (html: string, css: string) => {
    const [none, free, preview] = await Promise.all((['none', 'free', 'preview'] as const).map((watermark) => pixels(html, { css, watermark })))
    return { none: none!, free: free!, preview: preview! }
  }

  it("'free' and 'preview' draw a badge in the bottom-right corner; 'none' draws nothing", async () => {
    const { none, free, preview } = await modes('<p>Card</p>', '')
    expect(ink(none, CORNER)).toBe(0)
    expect(ink(free, CORNER)).toBeGreaterThan(2000)
    // "Preview - linktocard.com" is the longer badge.
    expect(ink(preview, CORNER)).toBeGreaterThan(ink(free, CORNER) + 1000)
    expect(diffPixels(none, free, REST)).toBe(0)
    expect(diffPixels(none, preview, REST)).toBe(0)
    // Inside the 16px margin nothing is drawn.
    expect(ink(free, { x: 1186, y: 560, w: 14, h: 70 })).toBe(0)
    expect(ink(free, { x: 900, y: 616, w: 300, h: 14 })).toBe(0)
  })

  it('scales with the card and stays in the corner at every size', async () => {
    for (const size of [SIZES.square, SIZES.portrait]) {
      const corner = { x: size.width - 230, y: size.height - 46, w: 230, h: 46 }
      const none = await pixels('<p>Card</p>', { size })
      const free = await pixels('<p>Card</p>', { size, watermark: 'free' })
      expect(diffPixels(none, free, corner)).toBeGreaterThan(1500)
      expect(diffPixels(none, free, { x: 0, y: 0, w: size.width, h: size.height - 46 })).toBe(0)
    }
  })

  it('cannot be removed, covered or cropped by template CSS', async () => {
    const clean = await modes('<p>Card</p>', '')
    const badge = diffPixels(clean.none, clean.free, CORNER)
    const hostile = [
      '* { display: none !important }',
      'html, body { display: none } image, svg, svg * { display: none; opacity: 0; visibility: hidden }',
      'body { transform: scale(3); transform-origin: 100% 100% }',
      'html { transform: translate(-500px, -500px) scale(0.1); overflow: hidden; width: 10px; height: 10px; clip-path: inset(50%) }',
      'body::after { content: ""; position: fixed; inset: 0; z-index: 9999; background: #ff0000 }',
      'body { opacity: 0; filter: opacity(0); mask-image: linear-gradient(transparent, transparent) }',
    ]
    for (const css of hostile) {
      const html = '<div style="position:absolute;inset:0;z-index:9999;background:#ff0000"></div><p>Card</p>'
      const { none, free } = await modes(html, css)
      // The badge changes the same number of pixels as on a clean card (its rim blends with the backdrop).
      expect(Math.abs(diffPixels(none, free, CORNER) - badge), css).toBeLessThan(badge * 0.15)
      expect(diffPixels(none, free, REST), css).toBe(0)
    }
  })
})

describe('fonts', () => {
  const text = (fontFamily: string, extra = '') =>
    card('<p class="t">Hamburgefonstiv 0123</p>', { css: `.t{margin:0;font-size:80px;${fontFamily ? `font-family:${fontFamily};` : ''}${extra}}`, deps: noDeps })

  it('maps generic families to the bundled fonts', async () => {
    const [base, sans, serif, mono] = await Promise.all([text(''), text('sans-serif'), text('serif'), text('monospace')])
    expect(sans.bytes).toEqual(base.bytes)
    expect(serif.bytes).not.toEqual(sans.bytes)
    expect(mono.bytes).not.toEqual(sans.bytes)
    expect(mono.bytes).not.toEqual(serif.bytes)
    expect((await text('"Source Serif 4"')).bytes).toEqual(serif.bytes)
    expect((await text('ui-serif, sans-serif')).bytes).toEqual(serif.bytes)
    expect((await text('JETBRAINS MONO')).bytes).toEqual(mono.bytes)
    expect((await text('system-ui')).bytes).toEqual(base.bytes)
    expect([base, sans, serif, mono].flatMap((out) => out.warnings)).toEqual([])
  })

  it('expands font shorthands and font families held in custom properties', async () => {
    const serif = await text('serif')
    expect((await card('<p class="t">Hamburgefonstiv 0123</p>', { css: '.t{margin:0;font:400 80px serif}' })).bytes).toEqual(serif.bytes)
    expect((await card('<p class="t">Hamburgefonstiv 0123</p>', { css: ':root{--heading:"Source Serif 4"} .t{margin:0;font-size:80px;font-family:var(--heading)}' })).bytes).toEqual(serif.bytes)
    expect((await card('<p class="t" style="font-family: Georgia, serif">Hamburgefonstiv 0123</p>', { css: '.t{margin:0;font-size:80px}' })).bytes).toEqual(serif.bytes)
  })

  it('uses the monospace font for code and the subset stack of the chosen family', async () => {
    const plain = await card('<p style="font-size:60px;margin:0">const x = 1</p>')
    const code = await card('<p style="font-size:60px;margin:0"><code>const x = 1</code></p>')
    const mono = await card('<p style="font-size:60px;margin:0;font-family:monospace">const x = 1</p>')
    expect(code.bytes).not.toEqual(plain.bytes)
    expect(code.bytes).toEqual(mono.bytes)
    // "ł" is in the Latin Extended subset: with a serif family it must come from the serif, not from Inter.
    const serifExt = await pixels('<p style="font-size:200px;margin:0;font-family:serif">ł</p>')
    const sansExt = await pixels('<p style="font-size:200px;margin:0">ł</p>')
    expect(diffPixels(serifExt, sansExt)).toBeGreaterThan(500)
  })

  it('asks deps.loadFonts once for families that are not bundled and uses what it returns', async () => {
    const acme: LoadedFont[] = [{ family: 'Acme Serif', weight: 400, style: 'normal', data: serifLatin400 }]
    const loadFonts = vi.fn(async (_families: string[]) => acme)
    const css = '.t{margin:0;font-size:80px;font-family:"Acme Serif", Helvetica, sans-serif} .u{font-family:acme serif}'
    const out = await card('<p class="t">Hamburgefonstiv 0123</p><p class="u"></p>', { css, deps: { ...noDeps, loadFonts } })
    expect(loadFonts.mock.calls).toEqual([[['Acme Serif', 'Helvetica']]])
    expect(out.warnings).toEqual(['Font families not available: Helvetica. Text uses the next family in the list, or Inter.'])
    // The customer font is the bundled serif under another name, so the glyphs must match the serif render.
    const serif = await pixels('<p class="t">Hamburgefonstiv 0123</p>', { css: '.t{margin:0;font-size:80px;font-family:serif}' })
    expect(diffPixels(await decodePng(out.bytes), serif)).toBe(0)
    // Same fonts again: same bytes (and no re-parse, see fontsWith()).
    expect((await card('<p class="t">Hamburgefonstiv 0123</p><p class="u"></p>', { css, deps: { ...noDeps, loadFonts } })).bytes).toEqual(out.bytes)
  })

  it('falls back to Inter with a warning when a family is unknown or there is no font loader', async () => {
    const base = await text('')
    const loadFonts = vi.fn(async (_families: string[]): Promise<LoadedFont[]> => [])
    const unknown = await card('<p class="t">Hamburgefonstiv 0123</p>', { css: '.t{margin:0;font-size:80px;font-family:"Comic Sans MS"}', deps: { ...noDeps, loadFonts } })
    expect(loadFonts.mock.calls).toEqual([[['Comic Sans MS']]])
    expect(unknown.bytes).toEqual(base.bytes)
    expect(unknown.warnings).toEqual(['Font families not available: Comic Sans MS. Text uses the next family in the list, or Inter.'])
    const noLoader = await text('Papyrus')
    expect(noLoader.bytes).toEqual(base.bytes)
    expect(noLoader.warnings).toEqual(['Font families not available: Papyrus. Text uses the next family in the list, or Inter.'])
    expect((await failure('<p style="font-family:Acme">x</p>', { deps: { ...noDeps, loadFonts: async () => Promise.reject(new Error('R2 down')) } })).code).toBe('render_failed')
  })
})

describe('emoji and missing glyphs', () => {
  const EMOJI = '<p style="font-size:100px;margin:0;line-height:1">😀</p>'
  const redEmoji = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>')}`

  it('asks deps.loadEmoji for each emoji and draws the image it returns', async () => {
    const loadEmoji = vi.fn(async (_emoji: string): Promise<string | undefined> => redEmoji)
    const out = await card('<p style="font-size:100px;margin:0;line-height:1">😀👨‍👩‍👧 ok 😀</p>', { deps: { ...noDeps, loadEmoji } })
    expect(loadEmoji.mock.calls.map(([emoji]) => emoji).sort()).toEqual(['😀', '👨‍👩‍👧'].sort())
    expect(colourAt(await decodePng(out.bytes), 50, 50)).toBe('red')
    expect(out.warnings).toEqual([])
  })

  it('leaves an emoji blank - never a tofu box - without a loader or without an image', async () => {
    const withoutLoader = await card(EMOJI)
    expect(ink(await decodePng(withoutLoader.bytes))).toBe(0)
    expect(withoutLoader.warnings).toEqual(['Emoji 😀 is not available and was left blank.'])

    for (const loadEmoji of [async () => undefined, async () => 'https://cdn.test/1f600.svg', async () => Promise.reject(new Error('boom'))]) {
      const out = await card(EMOJI, { deps: { ...noDeps, loadEmoji } })
      expect(ink(await decodePng(out.bytes))).toBe(0)
      expect(out.warnings).toEqual(['Emoji 😀 is not available and was left blank.'])
    }
  })

  it('warns, naming the script, about text no bundled font covers', async () => {
    const out = await card('<p>你好 مرحبا</p>')
    expect(out.warnings.sort()).toEqual([
      'No bundled font covers Arabic characters ("مرحبا"); they render as empty boxes.',
      'No bundled font covers Japanese / Chinese characters ("你好"); they render as empty boxes.',
    ])
    const covered = await card('<p>Żółć, Привет, Γειά σου, Tiếng Việt</p>')
    expect(covered.warnings).toEqual([])
  })
})
