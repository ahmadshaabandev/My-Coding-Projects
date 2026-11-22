import { describe, expect, it, vi } from 'vitest'
import { captureError, colourAt, draw, el, ink, inkBox, redImages } from '../helpers'

const SIZE = { width: 300, height: 200 }
const log = (label: string, value: unknown) => console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

describe('7a images', () => {
  it('data URIs', async () => {
    const images = await redImages()
    for (const [kind, src] of Object.entries(images)) {
      const withSize = await captureError(async () => {
        const { raster } = await draw(el('div', { style: { display: 'flex' } }, el('img', { src, width: 100, height: 100 })), SIZE)
        log(`7a ${kind} width+height attrs`, { centre: colourAt(raster, 50, 50), outside: colourAt(raster, 150, 150), box: inkBox(raster) })
      })
      if (withSize) log(`7a ${kind} width+height attrs ERROR`, withSize)
      const noSize = await captureError(async () => {
        const { raster } = await draw(el('div', { style: { display: 'flex' } }, el('img', { src })), SIZE)
        log(`7a ${kind} NO size`, { box: inkBox(raster) })
      })
      if (noSize) log(`7a ${kind} NO size ERROR`, noSize)
      const cssSize = await captureError(async () => {
        const { raster } = await draw(el('div', { style: { display: 'flex' } }, el('img', { src, style: { width: 60, height: 40 } })), SIZE)
        log(`7a ${kind} css size 60x40`, { box: inkBox(raster) })
      })
      if (cssSize) log(`7a ${kind} css size ERROR`, cssSize)
      const bg = await captureError(async () => {
        const { raster } = await draw(el('div', { style: { width: 100, height: 100, backgroundImage: `url(${src})`, backgroundSize: '100% 100%' } }), SIZE)
        log(`7a ${kind} background-image`, { centre: colourAt(raster, 50, 50), box: inkBox(raster) })
      })
      if (bg) log(`7a ${kind} background-image ERROR`, bg)
    }
    expect(true).toBe(true)
  })
})

describe('7b fetch', () => {
  it('remote URLs', async () => {
    const original = globalThis.fetch
    const calls: unknown[] = []
    const spy = vi.fn(async (input: unknown, init?: unknown) => {
      calls.push([String(input), init])
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
    })
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const cases: Record<string, ReturnType<typeof el>> = {
        'img https': el('div', { style: { display: 'flex' } }, el('img', { src: 'https://example.com/a.png', width: 50, height: 50 })),
        'img http': el('div', { style: { display: 'flex' } }, el('img', { src: 'http://example.com/b.png', width: 50, height: 50 })),
        'bg url()': el('div', { style: { width: 50, height: 50, backgroundImage: 'url(https://example.com/c.png)' } }),
        'mask url()': el('div', { style: { width: 50, height: 50, backgroundColor: 'red', maskImage: 'url(https://example.com/d.png)' } }),
        'list-style-image': el('ul', { style: { listStyleImage: 'url(https://example.com/e.png)' } }, el('li', {}, 'x')),
        'svg image href': el('svg', { width: 50, height: 50, viewBox: '0 0 50 50' }, el('image', { href: 'https://example.com/f.png', width: 50, height: 50 })),
        'style element': el('div', {}, el('style', {}, 'div.x{background-image:url(https://example.com/g.png);width:50px;height:50px}'), el('div', { className: 'x' })),
        'style @import': el('div', {}, el('style', {}, '@import url(https://example.com/h.css);'), el('div', {}, 'x')),
        'link stylesheet': el('div', {}, el('link', { rel: 'stylesheet', href: 'https://example.com/i.css' }), el('div', {}, 'x')),
        'img relative': el('div', { style: { display: 'flex' } }, el('img', { src: '/local.png', width: 50, height: 50 })),
        'img private ip': el('div', { style: { display: 'flex' } }, el('img', { src: 'http://127.0.0.1/x.png', width: 50, height: 50 })),
        '::before content url': el('div', {}, el('style', {}, '.y::before{content:url(https://example.com/j.png)}'), el('div', { className: 'y' }, 'x')),
        'font-face': el('div', {}, el('style', {}, '@font-face{font-family:Z;src:url(https://example.com/k.woff)} .z{font-family:Z}'), el('div', { className: 'z' }, 'x')),
      }
      for (const [name, vdom] of Object.entries(cases)) {
        calls.length = 0
        const error = await captureError(() => draw(vdom, { ...SIZE, unsafeAllowRemoteUrls: true }))
        log(`7b ${name}`, { fetchCalls: calls, error })
      }
      // data URIs only
      calls.length = 0
      const images = await redImages()
      await draw(el('div', { style: { display: 'flex', backgroundImage: `url(${images.png})` } }, el('img', { src: images.jpeg, width: 10, height: 10 })), SIZE)
      log('7b data URIs only', { fetchCalls: calls.length })
    } finally {
      globalThis.fetch = original
    }
    expect(true).toBe(true)
  })
})

describe('7c missing glyphs', () => {
  it('scripts without fonts', async () => {
    const samples: Record<string, string> = { latin: 'Hello', emoji: '😀', emojiZwj: '👨‍👩‍👧', cjk: '你好', kana: 'こんにちは', hangul: '안녕', arabic: 'مرحبا', hebrew: 'שלום', thai: 'สวัสดี', devanagari: 'नमस्ते', symbol: '→ ★ ✓', math: '∑ ≠ √' }
    for (const [name, text] of Object.entries(samples)) {
      const error = await captureError(async () => {
        const { raster, svg } = await draw(el('div', { style: { fontSize: 48, fontFamily: 'Inter' } }, text), SIZE)
        log(`7c ${name} no loader`, { ink: ink(raster), box: inkBox(raster), svgLen: svg.length })
      })
      if (error) log(`7c ${name} no loader ERROR`, error)
    }
    const calls: [string, string][] = []
    const error = await captureError(async () => {
      const { raster } = await draw(el('div', { style: { fontSize: 32, fontFamily: 'Inter' } }, 'Hi 😀 你好 こんにちは 안녕 مرحبا שלום สวัสดี → ∑ 👨‍👩‍👧 ℃'), {
        ...SIZE,
        loadAdditionalAsset: async (code, segment) => {
          calls.push([code, segment])
          return []
        },
      })
      log('7c loader calls', calls)
      log('7c loader render ink', ink(raster))
    })
    if (error) log('7c loader ERROR', error)

    // emoji as svg data uri
    const emojiSvg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#ff0000"/></svg>')
    const { raster } = await draw(el('div', { style: { fontSize: 100, fontFamily: 'Inter', lineHeight: 1 } }, '😀'), {
      ...SIZE,
      loadAdditionalAsset: async (code) => (code === 'emoji' ? emojiSvg : []),
    })
    log('7c emoji via loadAdditionalAsset', { box: inkBox(raster), centre: colourAt(raster, 50, 50) })
    const g = await draw(el('div', { style: { fontSize: 100, fontFamily: 'Inter', lineHeight: 1 } }, 'A😀B'), { ...SIZE, graphemeImages: { '😀': emojiSvg } })
    log('7c emoji via graphemeImages', { box: inkBox(g.raster), redAt150: colourAt(g.raster, 120, 50) })
    expect(true).toBe(true)
  })
})
