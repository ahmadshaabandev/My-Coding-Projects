// Characterisation tests: behaviours of satori@0.63.2 + @resvg/resvg-wasm@2.6.2 that the product
// is designed around (see research/spike-render.md, section 7). They run inside workerd.
// If one of them fails after a dependency upgrade, a design assumption changed.
import { describe, expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-wasm'
import { RenderInputError, renderSvg, warmUp, type LayoutBox, type VNode } from '../src/render/engine'
import { FONTS, fontStack } from '../src/render/fonts'
import { captureError, colourAt, draw, el, ink, inkBox, redImages } from './helpers'
import interLatinWoff2 from '../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'

const SIZE = { width: 300, height: 200 }

async function boxes(vdom: VNode, extra: object = {}): Promise<string[]> {
  const out: string[] = []
  await renderSvg(vdom, {
    ...SIZE,
    ...extra,
    onNodeDetected: (n: LayoutBox) => out.push(`${n.type}@${Math.round(n.left)},${Math.round(n.top)} ${Math.round(n.width)}x${Math.round(n.height)}`),
  })
  return out
}

describe('7a <img> and data URIs', () => {
  it('PNG, JPEG, GIF and SVG data URIs render; WebP is silently dropped by resvg', async () => {
    const images = await redImages()
    const centre = async (src: string) => {
      const { raster } = await draw(el('div', { style: { display: 'flex' } }, el('img', { src, width: 100, height: 100 })), SIZE)
      return colourAt(raster, 50, 50)
    }
    expect(await centre(images.png)).toBe('red')
    expect(await centre(images.jpeg)).toBe('red')
    expect(await centre(images.gif)).toBe('red')
    expect(await centre(images.svg)).toBe('red')
    expect(await centre(images.svgUtf8)).toBe('red')
    // Satori emits the <image>, resvg-wasm 2.6.2 cannot decode WebP and draws nothing. No error.
    const webp = await renderSvg(el('div', { style: { display: 'flex' } }, el('img', { src: images.webp, width: 100, height: 100 })), SIZE)
    expect(webp).toContain('data:image/webp')
    expect(await centre(images.webp)).toBe('white')
  })

  it('width/height are not required, but without them the image takes the full container width', async () => {
    const { png } = await redImages(16)
    expect(await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: png })))).toEqual(['div@0,0 300x300', 'img@0,0 300x300'])
    expect(await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: png, width: 50 })))).toEqual(['div@0,0 300x50', 'img@0,0 50x50'])
    expect(await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: png, style: { width: 60, height: 40 } })))).toEqual(['div@0,0 300x40', 'img@0,0 60x40'])
  })
})

describe('7b Satori fetches remote URLs on its own - unless the guard stops them', () => {
  const remote: Record<string, VNode> = {
    'img src': el('div', { style: { display: 'flex' } }, el('img', { src: 'https://example.com/a.png', width: 50, height: 50 })),
    'background-image': el('div', { style: { width: 50, height: 50, backgroundImage: 'url(https://example.com/c.png)' } }),
    'background shorthand': el('div', { style: { width: 50, height: 50, background: 'url("http://example.com/c2.png") no-repeat' } }),
    'mask-image': el('div', { style: { width: 50, height: 50, backgroundColor: 'red', maskImage: "url('https://example.com/d.png')" } }),
    'svg <image href>': el('svg', { width: 50, height: 50, viewBox: '0 0 50 50' }, el('image', { href: 'https://example.com/f.png', width: 50, height: 50 })),
    '<style> rule': el('div', {}, el('style', {}, 'div.x{background-image:url(https://example.com/g.png);width:50px;height:50px}'), el('div', { className: 'x' })),
  }

  async function withFetchSpy<T>(run: (calls: string[]) => Promise<T>): Promise<T> {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return new Response('nope', { status: 404 })
    }) as typeof fetch
    try {
      return await run(calls)
    } finally {
      globalThis.fetch = original
    }
  }

  it('with the guard bypassed, every sink reaches fetch()', async () => {
    await withFetchSpy(async (calls) => {
      for (const [name, vdom] of Object.entries(remote)) {
        calls.length = 0
        await captureError(() => renderSvg(vdom, { ...SIZE, unsafeAllowRemoteUrls: true }))
        expect(calls.length, name).toBe(1)
      }
      // These do not fetch: @import, <link>, @font-face.
      calls.length = 0
      await renderSvg(
        el('div', {}, el('style', {}, '@import url(https://example.com/h.css); @font-face{font-family:Z;src:url(https://example.com/k.woff)}'), el('link', { rel: 'stylesheet', href: 'https://example.com/i.css' }), el('div', {}, 'x')),
        { ...SIZE, unsafeAllowRemoteUrls: true },
      )
      expect(calls).toEqual([])
    })
  })

  it('the default guard rejects every remote sink before Satori runs, and data: URIs never fetch', async () => {
    await withFetchSpy(async (calls) => {
      for (const [name, vdom] of Object.entries(remote)) {
        const error = await captureError(() => renderSvg(vdom, SIZE))
        expect(error, name).toMatch(/^RenderInputError: Remote URL/)
      }
      const images = await redImages()
      await renderSvg(el('div', { style: { display: 'flex', backgroundImage: `url(${images.png})` } }, el('img', { src: images.jpeg, width: 10, height: 10 }), el('a', { href: 'https://example.com' }, 'see https://example.com')), SIZE)
      expect(calls).toEqual([])
    })
  })

  it('relative and private-network URLs make Satori throw', async () => {
    const img = (src: string) => el('div', { style: { display: 'flex' } }, el('img', { src, width: 50, height: 50 }))
    expect(await captureError(() => renderSvg(img('/local.png'), { ...SIZE, unsafeAllowRemoteUrls: true }))).toBe('Error: Image source must be an absolute URL: /local.png')
    expect(await captureError(() => renderSvg(img('http://127.0.0.1/x.png'), { ...SIZE, unsafeAllowRemoteUrls: true }))).toBe(
      'Error: Image source resolves to a blocked address (SSRF protection): http://127.0.0.1/x.png',
    )
  })

  it('the guard also bounds depth and node count', async () => {
    const deep = (d: number): VNode => (d === 0 ? el('div', {}, 'x') : el('div', {}, deep(d - 1)))
    expect(await captureError(() => renderSvg(deep(150), SIZE))).toMatch(/RenderInputError: Tree too deep/)
    expect(await captureError(() => renderSvg(el('div', {}, ...Array.from({ length: 50 }, () => el('span', {}, 'x'))), { ...SIZE, limits: { maxNodes: 20 } }))).toMatch(/RenderInputError: Too many nodes/)
    expect(new RenderInputError('x')).toBeInstanceOf(Error)
  })
})

describe('7c missing glyphs, loadAdditionalAsset, RTL', () => {
  it('text without a matching font renders tofu boxes, it does not throw', async () => {
    for (const text of ['😀', '你好', 'مرحبا', 'שלום']) {
      const { raster } = await draw(el('div', { style: { fontSize: 48, fontFamily: 'Inter' } }, text), SIZE)
      expect(ink(raster), text).toBeGreaterThan(300)
    }
  })

  it('loadAdditionalAsset receives (languageCode, segment)', async () => {
    const calls: [string, string][] = []
    await renderSvg(el('div', { style: { fontSize: 32, fontFamily: 'Inter' } }, 'Hi 😀 你好 こんにちは 안녕 مرحبا שלום → 👍'), {
      ...SIZE,
      loadAdditionalAsset: async (code, segment) => {
        calls.push([code, segment])
        return []
      },
    })
    expect(calls).toEqual([
      ['emoji', '😀'],
      ['emoji', '👍'],
      ['ja-JP|zh-CN|zh-TW|zh-HK', '你好'],
      ['ja-JP', 'こんにちは'],
      ['ko-KR', '안녕'],
      ['ar-AR', 'مرحبا'],
      ['he-IL', 'שלום'],
      ['symbol', '→'],
    ])
  })

  it('an emoji can be supplied as a data:image/svg+xml URI', async () => {
    const emoji = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>')
    const text = el('div', { style: { fontSize: 100, fontFamily: 'Inter', lineHeight: 1 } }, '😀')
    const viaLoader = await draw(text, { ...SIZE, loadAdditionalAsset: async (code) => (code === 'emoji' ? emoji : []) })
    expect(colourAt(viaLoader.raster, 50, 50)).toBe('red')
    expect(inkBox(viaLoader.raster)).toEqual({ x0: 0, y0: 0, x1: 99, y1: 99 }) // font-size square
    const viaMap = await draw(text, { ...SIZE, graphemeImages: { '😀': emoji } })
    expect(colourAt(viaMap.raster, 50, 50)).toBe('red')
  })

  it('direction: rtl / dir="rtl" start lines at the right edge', async () => {
    const text = (props: object) => el('div', { ...props, style: { fontSize: 40, fontFamily: 'Inter', ...(props as { style?: object }).style } }, 'Hello')
    const ltr = inkBox((await draw(text({}), SIZE)).raster)!
    const rtl = inkBox((await draw(text({ style: { direction: 'rtl' } }), SIZE)).raster)!
    const attr = inkBox((await draw(text({ dir: 'rtl' }), SIZE)).raster)!
    expect(ltr.x0).toBeLessThan(10)
    expect(rtl.x1).toBeGreaterThan(290)
    expect(attr.x1).toBeGreaterThan(290)
  })
})

describe('7d paint order and the watermark', () => {
  const abs = (colour: string, extra: object = {}) => ({ position: 'absolute', left: 0, top: 0, width: 100, height: 100, backgroundColor: colour, ...extra })
  const root = (...kids: VNode[]) => el('div', { style: { position: 'relative', width: 300, height: 200, display: 'flex' } }, ...kids)
  const top = async (vdom: VNode) => colourAt((await draw(vdom, SIZE)).raster, 50, 50)

  it('later siblings paint on top; z-index is honoured', async () => {
    expect(await top(root(el('div', { style: abs('#ff0000') }), el('div', { style: abs('#0000ff') })))).toBe('blue')
    expect(await top(root(el('div', { style: abs('#ff0000', { zIndex: 10 }) }), el('div', { style: abs('#0000ff') })))).toBe('red')
    expect(await top(root(el('div', { style: abs('#ff0000') }), el('div', { style: abs('#0000ff', { zIndex: -1 }) })))).toBe('red')
  })

  it('a last-sibling absolute element covers earlier siblings and their absolute descendants', async () => {
    expect(await top(root(el('div', { style: { width: 100, height: 100, backgroundColor: '#ff0000' } }), el('div', { style: abs('#0000ff') })))).toBe('blue')
    expect(await top(root(el('div', { style: { display: 'flex' } }, el('div', { style: abs('#ff0000') })), el('div', { style: abs('#0000ff') })))).toBe('blue')
  })

  it('...but template CSS can beat it with z-index, unless the template lives in its own stacking context', async () => {
    const attacker = el('div', { style: abs('#ff0000', { zIndex: 9999 }) })
    const watermark = el('div', { style: abs('#0000ff', { zIndex: 1 }) })
    // No isolation: the template wins.
    expect(await top(root(el('div', { style: { display: 'flex' } }, attacker), watermark))).toBe('red')
    // Template wrapped in `isolation: isolate` (or position:relative + z-index:0): the watermark wins.
    expect(await top(root(el('div', { style: { display: 'flex', isolation: 'isolate' } }, attacker), watermark))).toBe('blue')
    expect(await top(root(el('div', { style: { display: 'flex', position: 'relative', zIndex: 0 } }, attacker), watermark))).toBe('blue')
    const fixed = el('div', { style: { ...abs('#ff0000', { zIndex: 9999 }), position: 'fixed' } })
    expect(await top(root(el('div', { style: { display: 'flex', isolation: 'isolate' } }, fixed), watermark))).toBe('blue')
  })

  it('markup appended to the SVG after Satori always paints last (the safest watermark)', async () => {
    const svg = await renderSvg(root(el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), SIZE)
    expect(svg.endsWith('</svg>')).toBe(true)
    const stamped = svg.slice(0, -'</svg>'.length) + '<rect x="0" y="0" width="100" height="100" fill="#0000ff"/></svg>'
    await warmUp()
    const resvg = new Resvg(stamped, { background: '#ffffff' })
    const image = resvg.render()
    const at = (50 * 300 + 50) * 4
    expect([...image.pixels.subarray(at, at + 4)]).toEqual([0, 0, 255, 255])
    image.free()
    resvg.free()
  })
})

describe('7e layout rules', () => {
  it('a <div> with several children needs no display:flex any more (block layout)', async () => {
    expect(await boxes(el('div', { style: { fontSize: 16, fontFamily: 'Inter' } }, el('div', {}, 'a'), el('div', {}, 'b')))).toEqual(['div@0,0 300x38', 'div@0,0 300x19', 'div@0,19 300x19'])
  })

  it('text and inline children share a line; whitespace collapses like CSS white-space: normal', async () => {
    const style = { fontSize: 20, fontFamily: 'Inter' }
    const withSpace = await boxes(el('div', { style }, 'Hello ', el('b', {}, 'world')))
    const noSpace = await boxes(el('div', { style }, 'Hello', el('b', {}, 'world')))
    expect(withSpace[0]).toBe('div@0,0 300x24') // one line
    const x = (row: string) => Number(row.split('@')[1]!.split(',')[0])
    expect(x(withSpace[1]!)).toBeGreaterThan(x(noSpace[1]!)) // the trailing space is kept
    // Runs of spaces/newlines collapse; text stays on one line.
    expect(await boxes(el('div', { style }, '  Hello   \n   world  '))).toEqual(['div@0,0 300x24'])
    // Whitespace-only text between block children creates no line.
    expect((await boxes(el('div', { style }, '\n  ', el('div', {}, 'a'), '\n  ', el('div', {}, 'b'), '\n')))[0]).toBe('div@0,0 300x48')
    // <pre> keeps newlines (and has 1em margins).
    expect(await boxes(el('pre', { style: { fontSize: 20 } }, 'a\n  b'))).toEqual(['pre@0,20 300x48'])
  })

  it('preset element styles: h1 / p margins and sizes, body margin', async () => {
    expect(await boxes(el('div', { style: { fontSize: 20 } }, el('h1', {}, 'H'), el('p', {}, 'P')))).toEqual(['div@0,27 300x99', 'h1@0,27 300x48', 'p@0,102 300x24'])
    const body = await draw(el('html', {}, el('body', {}, el('div', { style: { width: 50, height: 50, background: '#ff0000' } }))), SIZE)
    expect(inkBox(body.raster)).toEqual({ x0: 8, y0: 8, x1: 57, y1: 57 })
  })

  it('an invalid inline style value fails the whole render, unless onStyleError is given', async () => {
    const vdom = el('div', { style: { display: 'table' } }, 'x')
    expect(await captureError(() => renderSvg(vdom, SIZE))).toBe(
      'Error: Invalid value for CSS property "display". Allowed values: "block" | "flow-root" | "list-item" | "flex" | "-webkit-flex" | "-webkit-box" | "grid" | "inline" | "inline-block" | "inline-flex" | "-webkit-inline-flex" | "inline-grid" | "contents" | "none". Received: "table".',
    )
    const errors: string[] = []
    await renderSvg(vdom, { ...SIZE, onStyleError: (e) => errors.push(e.message) })
    expect(errors).toHaveLength(1)
    // Unknown properties and unknown elements are ignored silently.
    expect(await captureError(() => renderSvg(el('foo', { style: { columns: 2, cursor: 'pointer' } }, 'x'), SIZE))).toBeNull()
  })

  it('style must be an object (strings are ignored); kebab-case keys work; <style> + class works', async () => {
    const asString = await draw(el('div', { style: 'background-color:#ff0000;width:100px;height:100px' }), SIZE)
    expect(colourAt(asString.raster, 50, 50)).toBe('white')
    const kebab = await draw(el('div', { style: { 'background-color': '#ff0000', width: 100, height: 100 } }), SIZE)
    expect(colourAt(kebab.raster, 50, 50)).toBe('red')
    const sheet = await draw(el('div', {}, el('style', {}, '.box{width:100px;height:100px;background:#ff0000} #b{background:#0000ff}'), el('div', { className: 'box' }), el('div', { class: 'box', id: 'b' })), SIZE)
    expect([colourAt(sheet.raster, 50, 50), colourAt(sheet.raster, 50, 150)]).toEqual(['red', 'blue'])
  })

  it('box-sizing defaults to content-box, like browsers', async () => {
    const content = await boxes(el('div', { style: { width: '100%', height: '100%', padding: 20 } }))
    const border = await boxes(el('div', { style: { width: '100%', height: '100%', padding: 20, boxSizing: 'border-box' } }))
    expect(content).toEqual(['div@0,0 340x240'])
    expect(border).toEqual(['div@0,0 300x200'])
  })
})

describe('7f fonts', () => {
  const latin = FONTS.find((f) => f.name === 'Inter' && f.weight === 400)!
  const cyrillic = FONTS.find((f) => f.name === 'Inter Cyrillic' && f.weight === 400)!
  const onlyLatin = [{ ...latin, name: 'X' }]
  const sameName = [{ ...latin, name: 'X' }, { ...cyrillic, name: 'X' }]
  const distinct = [{ ...latin, name: 'X' }, { ...cyrillic, name: 'Y' }]
  const text = el('div', { style: { fontSize: 40, fontFamily: 'X' } }, 'Привет')

  it('two files under the SAME family name+weight+style: only the first is used', async () => {
    const a = await renderSvg(text, { ...SIZE, fonts: onlyLatin })
    const b = await renderSvg(text, { ...SIZE, fonts: sameName })
    const c = await renderSvg(text, { ...SIZE, fonts: distinct })
    expect(b).toBe(a) // still tofu
    expect(c).not.toBe(a) // a separately named subset is found by per-glyph fallback
  })

  it('fallback walks the listed families first, then every other family in registration order', async () => {
    const glyph = async (fontFamily: string) => ((await renderSvg(el('div', { style: { fontSize: 100, fontFamily } }, 'ł'), SIZE)).match(/ d="([^"]+)"/) ?? [])[1]
    expect(await glyph('"Source Serif 4"')).toBe(await glyph('"Inter Latin Ext"')) // wrong face!
    expect(await glyph(fontStack('Source Serif 4'))).toBe(await glyph('"Source Serif 4 Latin Ext"'))
  })

  it('generic families select nothing; missing bold is synthesised; WOFF2 is accepted', async () => {
    const widths = await boxes(el('div', { style: { fontSize: 40 } }, el('code', {}, 'iiii'), el('span', { style: { fontFamily: 'JetBrains Mono' } }, 'iiii')))
    const width = (row: string) => Number(row.split(' ')[1]!.split('x')[0])
    expect(width(widths[1]!)).toBeLessThan(width(widths[2]!) / 2) // <code> is still Inter
    const normal = await draw(el('div', { style: { fontSize: 40, fontFamily: 'X', fontWeight: 400 } }, 'Hello'), { ...SIZE, fonts: onlyLatin })
    const bold = await draw(el('div', { style: { fontSize: 40, fontFamily: 'X', fontWeight: 800 } }, 'Hello'), { ...SIZE, fonts: onlyLatin })
    expect(ink(bold.raster)).toBeGreaterThan(ink(normal.raster) * 1.1)
    const woff2 = await draw(el('div', { style: { fontSize: 40, fontFamily: 'W2' } }, 'Hello'), { ...SIZE, fonts: [{ name: 'W2', data: interLatinWoff2, weight: 400, style: 'normal' }] })
    expect(ink(woff2.raster)).toBe(ink(normal.raster))
    expect(await captureError(() => renderSvg(el('div', {}, 'x'), { ...SIZE, fonts: [] }))).toBe('Error: No fonts are loaded. At least one font is required to calculate the layout.')
  })
})

describe('7j inline <svg>', () => {
  const at = async (vdom: VNode) => colourAt((await draw(vdom, SIZE)).raster, 50, 50)
  const svg = (...kids: VNode[]) => el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, ...kids)

  it('shapes, kebab- or camelCase attributes, currentColor, defs/gradients/use', async () => {
    expect(await at(svg(el('circle', { cx: 50, cy: 50, r: 40, fill: '#ff0000' })))).toBe('red')
    expect(await at(svg(el('path', { d: 'M10 50 H90', stroke: '#ff0000', 'stroke-width': 40 })))).toBe('red')
    expect(await at(svg(el('path', { d: 'M10 50 H90', stroke: '#ff0000', strokeWidth: 40 })))).toBe('red')
    expect(await at(el('div', { style: { color: '#ff0000', display: 'flex' } }, svg(el('rect', { width: 100, height: 100, fill: 'currentColor' }))))).toBe('red')
    expect(
      await at(svg(el('defs', {}, el('linearGradient', { id: 'g' }, el('stop', { offset: '0', stopColor: '#ff0000' }), el('stop', { offset: '1', stopColor: '#ff0000' })), el('rect', { id: 'r', width: 100, height: 100 })), el('use', { href: '#r', fill: 'url(#g)' }))),
    ).toBe('red')
  })

  it('limits: <text> throws, <foreignObject> and nested raster <image> draw nothing', async () => {
    expect(await captureError(() => renderSvg(svg(el('text', { x: 10, y: 50 }, 'hi')), SIZE))).toBe('Error: <text> nodes are not currently supported, please convert them to <path>')
    expect(await at(svg(el('foreignObject', { width: 100, height: 100 }, el('div', { style: { width: 100, height: 100, background: '#ff0000' } }))))).toBe('white')
    expect(await at(svg(el('image', { href: (await redImages()).png, width: 100, height: 100 })))).toBe('white')
  })

  it('inline SVG is embedded verbatim as a nested data: image (scripts included) - never serve the SVG itself', async () => {
    const out = await renderSvg(svg(el('script', {}, 'alert(1)'), el('rect', { width: 100, height: 100, fill: '#ff0000', onclick: 'alert(1)' })), SIZE)
    expect(out).toContain('href="data:image/svg+xml;utf8,')
    expect(out).toContain('%3Cscript%3Ealert(1)%3C/script%3E')
  })
})

describe('4 resvg pixel format', () => {
  it('pixels are premultiplied RGBA; an opaque background makes that irrelevant', async () => {
    await warmUp()
    const half = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000" fill-opacity="0.5"/></svg>'
    const first = (options?: { background: string }) => {
      const resvg = new Resvg(half, options)
      const image = resvg.render()
      const px = [...image.pixels.subarray(0, 4)]
      image.free()
      resvg.free()
      return px
    }
    expect(first()).toEqual([128, 0, 0, 128]) // straight alpha would be [255, 0, 0, 128]
    expect(first({ background: '#ffffff' })).toEqual([255, 127, 127, 255])
  })
})

describe('engine guard: side doors', () => {
  it('graphemeImages and loadAdditionalAsset may only supply data: URIs', async () => {
    const text = el('div', { style: { fontSize: 40, fontFamily: 'Inter' } }, '😀')
    expect(await captureError(() => renderSvg(text, { ...SIZE, graphemeImages: { '😀': 'https://example.com/e.svg' } }))).toMatch(/RenderInputError: graphemeImages/)
    expect(await captureError(() => renderSvg(text, { ...SIZE, loadAdditionalAsset: async () => 'https://example.com/e.svg' }))).toMatch(/RenderInputError: loadAdditionalAsset/)
  })
})
