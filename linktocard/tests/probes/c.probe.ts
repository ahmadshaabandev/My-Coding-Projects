import { describe, expect, it } from 'vitest'
import { parseDocument } from 'htmlparser2'
import { selectAll, selectOne, is } from 'css-select'
import { parse as parseSelector } from 'css-what'
import { textContent, getAttributeValue } from 'domutils'
import type { Element } from 'domhandler'
import { encodeRasterJpeg, encodeRasterWebp, rasterize, renderSvg, svgToPng, warmUp, type VNode } from '../../src/render/engine'
import { sampleCard } from '../../src/render/sample-card'
import { captureError, colourAt, draw, el, ink, inkBox } from '../helpers'

const SIZE = { width: 1200, height: 630 }
const log = (label: string, value: unknown) => console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const ms = (n: number) => Math.round(n * 10) / 10

async function timed(vdom: VNode, size = SIZE) {
  const t0 = performance.now()
  const svg = await renderSvg(vdom, { ...size, limits: { maxNodes: 1e9, maxDepth: 1e9 } })
  const t1 = performance.now()
  const png = await svgToPng(svg, size.width)
  const t2 = performance.now()
  return { satoriMs: ms(t1 - t0), resvgPngMs: ms(t2 - t1), svgKB: Math.round(svg.length / 1024), pngKB: Math.round(png.length / 1024) }
}

describe('7h html parsing in workerd', () => {
  it('htmlparser2 + css-select', () => {
    const html = `<div class="card" id="c"><style>.card h1{color:red}</style><h1 data-x="1">Hello <b>world</b></h1><p class="lead a">Lead</p><svg viewBox="0 0 10 10" width="10"><linearGradient id="g"><stop stop-color="red"/></linearGradient><path d="M0 0" stroke-width="2"/><foreignObject></foreignObject></svg><img src="data:image/png;base64,AAAA" alt=x></div>`
    const doc = parseDocument(html)
    const card = selectOne('div.card', doc) as unknown as Element
    const svg = selectOne('svg', doc) as unknown as Element
    log('7h parse', {
      cardAttrs: card.attribs,
      h1: textContent(selectOne('.card > h1', doc)!),
      b: selectAll('h1 b, p.lead', doc).map((n) => (n as unknown as Element).name),
      nth: selectAll('div > :nth-child(2)', doc).map((n) => (n as unknown as Element).name),
      attrSel: selectAll('[data-x="1"]', doc).length,
      is: is(card, '#c.card'),
      svgAttribs: svg.attribs,
      svgChildren: svg.children.map((c) => [(c as unknown as Element).name, (c as unknown as Element).attribs]),
      selectorAst: parseSelector('.card > h1:not(.x)')[0]!.map((t) => t.type),
      imgSrc: getAttributeValue(selectOne('img', doc) as unknown as Element, 'src'),
    })
    const xml = parseDocument('<svg viewBox="0 0 10 10"><linearGradient gradientUnits="userSpaceOnUse"/></svg>', { lowerCaseAttributeNames: false, lowerCaseTags: false })
    const s2 = selectOne('svg', xml) as unknown as Element
    log('7h case-preserving options', { attribs: s2.attribs, child: (s2.children[0] as unknown as Element).name, childAttribs: (s2.children[0] as unknown as Element).attribs })
    expect(card.attribs.id).toBe('c')
  })
})

describe('7e extra', () => {
  it('string style, rtl, body', async () => {
    const a = await draw(el('div', { style: 'background-color:#ff0000;width:100px;height:100px' }), { width: 300, height: 200 })
    log('7e string style applied?', colourAt(a.raster, 50, 50))
    const ltr = await draw(el('div', { style: { fontSize: 40, fontFamily: 'Inter' } }, 'Hello'), { width: 300, height: 200 })
    const rtl = await draw(el('div', { style: { fontSize: 40, fontFamily: 'Inter', direction: 'rtl' } }, 'Hello'), { width: 300, height: 200 })
    const dir = await draw(el('div', { dir: 'rtl', style: { fontSize: 40, fontFamily: 'Inter' } }, 'Hello'), { width: 300, height: 200 })
    log('7c rtl alignment (ink box x0..x1)', { ltr: inkBox(ltr.raster), cssDirectionRtl: inkBox(rtl.raster), dirAttr: inkBox(dir.raster) })
    const body = await draw(el('html', {}, el('body', {}, el('div', { style: { width: 50, height: 50, background: '#ff0000' } }))), { width: 300, height: 200 })
    log('7e html/body wrapper (body margin 8)', inkBox(body.raster))
    const rootOverflow = await draw(el('div', { style: { width: 600, height: 400, background: '#ff0000' } }), { width: 300, height: 200 })
    log('7e root overflow clipped', inkBox(rootOverflow.raster))
    const noHeight = await captureError(async () => { const svg = await renderSvg(el('div', { style: { width: 100, height: 345, background: '#ff0000' } }), { width: 300 } as never); log('7e height omitted -> svg header', svg.slice(0, 80)) })
    if (noHeight) log('7e height omitted ERROR', noHeight)
    expect(true).toBe(true)
  })
  it('tofu sample png', async () => {
    const svg = await renderSvg(el('div', { style: { fontSize: 44, fontFamily: 'Inter', padding: 20, boxSizing: 'border-box', width: '100%', height: '100%', background: '#fff', color: '#000' } }, 'Latin ok. Emoji 😀 CJK 你好 Arabic مرحبا Hebrew שלום'), { width: 900, height: 200 })
    const png = await svgToPng(svg, 900)
    let binary = ''
    for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000))
    console.log('TOFUPNG ' + btoa(binary))
    expect(png.length).toBeGreaterThan(100)
  })
})

describe('7i scale', () => {
  const grid = (n: number) =>
    el('div', { style: { display: 'flex', flexWrap: 'wrap', width: '100%', height: '100%', fontFamily: 'Inter', fontSize: 10, background: '#fff' } },
      ...Array.from({ length: n }, (_, i) => el('div', { style: { display: 'flex', width: 24, height: 14, margin: 1, backgroundColor: i % 2 ? '#dbeafe' : '#fee2e2', borderRadius: 3 } }, String(i))))
  it('node counts', async () => {
    await warmUp()
    await timed(sampleCard()) // warm caches
    for (const n of [100, 500, 2000, 5000]) {
      log(`7i ${n} flex boxes with text (first)`, await timed(grid(n)))
      log(`7i ${n} flex boxes with text (repeat)`, await timed(grid(n)))
    }
    const deep = (d: number): VNode => (d === 0 ? el('div', {}, 'x') : el('div', { style: { display: 'flex', padding: 1 } }, deep(d - 1)))
    for (const d of [50, 200, 1000]) {
      const error = await captureError(async () => log(`7i nesting depth ${d}`, await timed(deep(d))))
      if (error) log(`7i nesting depth ${d} ERROR`, error.slice(0, 200))
    }
    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(400)
    log('7i 22k chars of text', await timed(el('div', { style: { fontSize: 12, fontFamily: 'Inter', width: '100%' } }, long)))
    log('7i 22k chars of text (repeat)', await timed(el('div', { style: { fontSize: 12, fontFamily: 'Inter', width: '100%' } }, long)))
    expect(true).toBe(true)
  }, 180_000)

  it('pathological css', async () => {
    await warmUp()
    const box = (style: Record<string, string | number>, n = 1) =>
      el('div', { style: { display: 'flex', flexWrap: 'wrap', width: '100%', height: '100%', background: '#fff', padding: 40, boxSizing: 'border-box' } },
        ...Array.from({ length: n }, () => el('div', { style: { width: 200, height: 120, margin: 20, backgroundColor: '#2563eb', ...style } })))
    const cases: Record<string, VNode> = {
      baseline: box({}),
      'box-shadow blur 20px': box({ boxShadow: '0 10px 20px rgba(0,0,0,.4)' }),
      'box-shadow blur 200px': box({ boxShadow: '0 0 200px rgba(0,0,0,.6)' }),
      'box-shadow blur 1000px': box({ boxShadow: '0 0 1000px rgba(0,0,0,.6)' }),
      'box-shadow blur 5000px': box({ boxShadow: '0 0 5000px rgba(0,0,0,.6)' }),
      'box-shadow blur 20px x12 elements': box({ boxShadow: '0 10px 20px rgba(0,0,0,.4)' }, 12),
      'box-shadow blur 200px x12 elements': box({ boxShadow: '0 0 200px rgba(0,0,0,.6)' }, 12),
      'box-shadow 10 layers blur 50px': box({ boxShadow: Array.from({ length: 10 }, (_, i) => `0 ${i * 4}px 50px rgba(0,0,0,.2)`).join(', ') }),
      'inset shadow blur 100px': box({ boxShadow: 'inset 0 0 100px rgba(0,0,0,.6)' }),
      'filter blur(10px)': box({ filter: 'blur(10px)' }),
      'filter blur(100px)': box({ filter: 'blur(100px)' }),
      'filter blur(1000px)': box({ filter: 'blur(1000px)' }),
      'filter blur(10px) x12': box({ filter: 'blur(10px)' }, 12),
      'filter drop-shadow blur 100px': box({ filter: 'drop-shadow(0 0 100px rgba(0,0,0,.8))' }),
      'backdrop-filter blur(40px)': box({ backdropFilter: 'blur(40px)', backgroundColor: 'rgba(37,99,235,.3)' }),
      'backdrop-filter blur(40px) x12': box({ backdropFilter: 'blur(40px)', backgroundColor: 'rgba(37,99,235,.3)' }, 12),
      'border-radius 1e9px': box({ borderRadius: 1e9 }),
      'border-radius 50% + border 40px dashed': box({ borderRadius: '50%', border: '40px dashed #111' }),
      'text-shadow blur 100px': el('div', { style: { fontSize: 120, fontFamily: 'Inter', fontWeight: 800, padding: 60, textShadow: '0 0 100px #f00', background: '#fff', width: '100%', height: '100%' } }, 'Shadow'),
      'opacity + mix-blend x12': box({ opacity: 0.5, mixBlendMode: 'multiply' }, 12),
      'conic-gradient full': el('div', { style: { width: '100%', height: '100%', backgroundImage: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)' } }),
      'repeating-linear-gradient 1px stripes': el('div', { style: { width: '100%', height: '100%', backgroundImage: 'repeating-linear-gradient(90deg, #000 0 1px, #fff 1px 2px)' } }),
      'tiny background-size tile 2px': el('div', { style: { width: '100%', height: '100%', backgroundImage: 'linear-gradient(#000, #f00)', backgroundSize: '2px 2px' } }),
      'transform scale(50) blur': box({ transform: 'scale(50)', filter: 'blur(20px)' }),
      'huge element 100000px': el('div', { style: { width: 100000, height: 100000, background: '#f00', boxShadow: '0 0 50px #000' } }),
      'font-size 5000px': el('div', { style: { fontSize: 5000, fontFamily: 'Inter' } }, 'Ag'),
      'letter-spacing + 2000 chars at 6px': el('div', { style: { fontSize: 6, fontFamily: 'Inter', width: '100%' } }, 'word '.repeat(2000)),
    }
    for (const [name, vdom] of Object.entries(cases)) {
      const error = await captureError(async () => log(`7i css ${name}`, await timed(vdom)))
      if (error) log(`7i css ${name} ERROR`, error.slice(0, 300))
    }
    expect(true).toBe(true)
  }, 300_000)
})

describe('encoder options', () => {
  it('jpeg/webp speed', async () => {
    await warmUp()
    const raster = await rasterize(await renderSvg(sampleCard(), SIZE), 1200)
    const time = async (fn: () => Promise<Uint8Array>) => { const runs: number[] = []; let len = 0; for (let i = 0; i < 4; i++) { const t = performance.now(); len = (await fn()).length; runs.push(performance.now() - t) } return { ms: ms(runs.sort((x, y) => x - y)[1]!), kB: ms(len / 1024) } }
    log('enc jpeg q85 (engine default opts)', await time(() => encodeRasterJpeg(raster, 85)))
    log('enc webp q85 (engine default opts)', await time(() => encodeRasterWebp(raster, 85)))
    const { default: encodeJpeg } = await import('@jsquash/jpeg/encode.js')
    const { default: encodeWebp } = await import('@jsquash/webp/encode.js')
    const data = { data: new Uint8ClampedArray(raster.pixels.buffer, raster.pixels.byteOffset, raster.pixels.byteLength), width: raster.width, height: raster.height } as never
    const j = async (o: object) => new Uint8Array(await encodeJpeg(data, o))
    const w = async (o: object) => new Uint8Array(await encodeWebp(data, o))
    log('enc jpeg q85 baseline no-optimize', await time(() => j({ quality: 85, baseline: true, progressive: false, optimize_coding: false })))
    log('enc jpeg q85 progressive=false', await time(() => j({ quality: 85, progressive: false })))
    log('enc jpeg q85 trellis off quant_table 3', await time(() => j({ quality: 85, progressive: false, optimize_coding: true, trellis_multipass: false })))
    log('enc webp q85 method 0', await time(() => w({ quality: 85, method: 0 })))
    log('enc webp q85 method 2', await time(() => w({ quality: 85, method: 2 })))
    log('enc webp q85 method 6', await time(() => w({ quality: 85, method: 6 })))
    log('enc webp lossless', await time(() => w({ lossless: 1 })))
    expect(true).toBe(true)
  }, 120_000)
})
