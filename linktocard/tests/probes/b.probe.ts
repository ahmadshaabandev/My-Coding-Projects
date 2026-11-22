import { describe, expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-wasm'
import { renderSvg, warmUp, type LayoutBox } from '../../src/render/engine'
import { FONTS } from '../../src/render/fonts'
import { captureError, colourAt, draw, el, ink, inkBox, pixel, redImages } from '../helpers'
import interLatinWoff2 from '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'

const SIZE = { width: 300, height: 200 }
const log = (label: string, value: unknown) => console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const boxes = async (vdom: ReturnType<typeof el>, extra: object = {}) => {
  const out: string[] = []
  await renderSvg(vdom, { ...SIZE, ...extra, onNodeDetected: (n: LayoutBox) => out.push(`${n.type}${n.textContent ? `"${n.textContent}"` : ''}@${n.left},${n.top} ${n.width}x${n.height}`) })
  return out
}

describe('7a more', () => {
  it('img sizing + webp', async () => {
    const images = await redImages()
    log('7a img no size in flex', await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: images.png }))))
    log('7a img no size in block', await boxes(el('div', {}, el('img', { src: images.png }))))
    log('7a img no size flex-start', await boxes(el('div', { style: { display: 'flex', alignItems: 'flex-start' } }, el('img', { src: images.png }))))
    log('7a img width attr only', await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: images.png, width: 50 }))))
    log('7a img css width only', await boxes(el('div', { style: { display: 'flex' } }, el('img', { src: images.png, style: { width: 50 } }))))
    log('7a gif no size block', await boxes(el('div', {}, el('img', { src: images.gif }))))
    const svg = await renderSvg(el('div', { style: { display: 'flex' } }, el('img', { src: images.webp, width: 100, height: 100 })), SIZE)
    log('7a webp svg contains image', { hasImage: svg.includes('<image'), hasWebp: svg.includes('data:image/webp'), len: svg.length })
    // resvg directly
    await warmUp()
    for (const kind of ['png', 'jpeg', 'gif', 'webp'] as const) {
      const direct = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><image href="${images[kind]}" width="20" height="20"/></svg>`
      const r = new Resvg(direct, { background: '#ffffff' })
      const img = r.render()
      const px = [...img.pixels.subarray(10 * 20 * 4 + 40, 10 * 20 * 4 + 44)]
      img.free(); r.free()
      log(`7a resvg direct ${kind}`, px)
    }
    expect(true).toBe(true)
  })
})

describe('4 premultiplied', () => {
  it('resvg pixels', async () => {
    await warmUp()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000" fill-opacity="0.5"/></svg>'
    const a = new Resvg(svg); const ia = a.render(); log('4 no background, 50% red pixel', [...ia.pixels.subarray(0, 4)]); ia.free(); a.free()
    const b = new Resvg(svg, { background: '#ffffff' }); const ib = b.render(); log('4 white background, 50% red pixel', [...ib.pixels.subarray(0, 4)]); ib.free(); b.free()
    const c = new Resvg(svg, { background: 'rgba(255,255,255,0.5)' }); const ic = c.render(); log('4 50% white background', [...ic.pixels.subarray(0, 4)]); ic.free(); c.free()
    expect(true).toBe(true)
  })
})

describe('7d paint order', () => {
  const abs = (colour: string, extra: object = {}) => ({ position: 'absolute', left: 0, top: 0, width: 100, height: 100, backgroundColor: colour, ...extra })
  it('z-index and watermark', async () => {
    const root = (...kids: ReturnType<typeof el>[]) => el('div', { style: { position: 'relative', width: 300, height: 200, display: 'flex' } }, ...kids)
    const t = async (name: string, vdom: ReturnType<typeof el>) => {
      const { raster } = await draw(vdom, SIZE)
      log(`7d ${name}`, colourAt(raster, 50, 50))
    }
    await t('later sibling wins (no z-index): red then blue', root(el('div', { style: abs('#ff0000') }), el('div', { style: abs('#0000ff') })))
    await t('z-index 10 on first: red(z10) then blue', root(el('div', { style: abs('#ff0000', { zIndex: 10 }) }), el('div', { style: abs('#0000ff') })))
    await t('negative z-index on last: red then blue(z-1)', root(el('div', { style: abs('#ff0000') }), el('div', { style: abs('#0000ff', { zIndex: -1 }) })))
    await t('last abs sibling vs earlier static sibling', root(el('div', { style: { width: 100, height: 100, backgroundColor: '#ff0000' } }), el('div', { style: abs('#0000ff') })))
    await t('last abs sibling vs abs descendant of earlier sibling', root(el('div', { style: { display: 'flex' } }, el('div', { style: abs('#ff0000') })), el('div', { style: abs('#0000ff') })))
    await t('ATTACK: earlier descendant z-index 9999 vs last abs sibling (auto)', root(el('div', { style: { display: 'flex' } }, el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), el('div', { style: abs('#0000ff') })))
    await t('ATTACK: descendant z 9999 vs watermark z-index 1', root(el('div', { style: { display: 'flex' } }, el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), el('div', { style: abs('#0000ff', { zIndex: 1 }) })))
    await t('DEFENCE isolation:isolate wrapper + watermark z1', root(el('div', { style: { display: 'flex', isolation: 'isolate' } }, el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), el('div', { style: abs('#0000ff', { zIndex: 1 }) })))
    await t('DEFENCE wrapper position:relative z-index 0 + watermark z1', root(el('div', { style: { display: 'flex', position: 'relative', zIndex: 0, width: 300, height: 200 } }, el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), el('div', { style: abs('#0000ff', { zIndex: 1 }) })))
    await t('DEFENCE wrapper isolate, watermark auto z', root(el('div', { style: { display: 'flex', isolation: 'isolate' } }, el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), el('div', { style: abs('#0000ff') })))
    await t('ATTACK position fixed z 9999 inside isolate wrapper vs watermark z1', root(el('div', { style: { display: 'flex', isolation: 'isolate' } }, el('div', { style: { ...abs('#ff0000', { zIndex: 9999 }), position: 'fixed' } })), el('div', { style: abs('#0000ff', { zIndex: 1 }) })))
    // SVG-level watermark: appended after satori
    const svg = await renderSvg(root(el('div', { style: abs('#ff0000', { zIndex: 9999 }) })), SIZE)
    const stamped = svg.replace(/<\/svg>\s*$/, '<rect x="0" y="0" width="100" height="100" fill="#0000ff"/></svg>')
    await warmUp()
    const r = new Resvg(stamped, { background: '#ffffff' }); const img = r.render(); const px = [...img.pixels.subarray((50 * 300 + 50) * 4, (50 * 300 + 50) * 4 + 4)]; img.free(); r.free()
    log('7d SVG-level stamp after satori', { px, changed: stamped !== svg, tail: svg.slice(-60) })
    expect(true).toBe(true)
  })
})

describe('7e layout rules', () => {
  it('div children, inline text, whitespace', async () => {
    log('7e div 2 block children no flex', { error: await captureError(() => draw(el('div', {}, el('div', {}, 'a'), el('div', {}, 'b')), SIZE)), boxes: await boxes(el('div', {}, el('div', {}, 'a'), el('div', {}, 'b'))) })
    log('7e div text + div child', await boxes(el('div', { style: { fontSize: 20 } }, 'text ', el('div', {}, 'b'))))
    log('7e Hello <b>world</b>', await boxes(el('div', { style: { fontSize: 20, fontFamily: 'Inter' } }, 'Hello ', el('b', {}, 'world'))))
    log('7e Hello<b>world</b> no space', await boxes(el('div', { style: { fontSize: 20, fontFamily: 'Inter' } }, 'Hello', el('b', {}, 'world'))))
    log('7e whitespace collapse', await boxes(el('div', { style: { fontSize: 20, fontFamily: 'Inter' } }, '  Hello   \n   world  ')))
    log('7e whitespace-only child between inline', await boxes(el('div', { style: { fontSize: 20, fontFamily: 'Inter' } }, el('span', {}, 'a'), ' ', el('span', {}, 'b'))))
    log('7e newline between blocks', await boxes(el('div', { style: { fontSize: 20 } }, '\n  ', el('div', {}, 'a'), '\n  ', el('div', {}, 'b'), '\n')))
    log('7e pre', await boxes(el('pre', { style: { fontSize: 20 } }, 'a\n  b')))
    log('7e span default', await boxes(el('div', { style: { fontSize: 20 } }, el('span', {}, 'a'), el('span', {}, 'b'))))
    log('7e p h1 margins', await boxes(el('div', { style: { fontSize: 20 } }, el('h1', {}, 'H'), el('p', {}, 'P'))))
    log('7e flex row text children', await boxes(el('div', { style: { fontSize: 20, display: 'flex' } }, 'Hello ', el('b', {}, 'world'))))
    log('7e unknown element <foo>', { error: await captureError(() => draw(el('foo', {}, 'x'), SIZE)) })
    log('7e display table', { error: await captureError(() => draw(el('div', { style: { display: 'table' } }, 'x'), SIZE)) })
    log('7e <table>', { error: await captureError(() => draw(el('table', {}, el('tr', {}, el('td', {}, 'x'))), SIZE)) })
    log('7e invalid colour', { error: await captureError(() => draw(el('div', { style: { color: 'notacolour' } }, 'x'), SIZE)) })
    log('7e unsupported prop (columns)', { error: await captureError(() => draw(el('div', { style: { columns: 2, cursor: 'pointer' } }, 'x'), SIZE)) })
    const errs: string[] = []
    await renderSvg(el('div', { style: { display: 'table', color: 'notacolour' } }, 'x'), { ...SIZE, onStyleError: (e) => errs.push(e.message) })
    log('7e onStyleError', errs)
    log('7e class + style element', await (async () => { const { raster } = await draw(el('div', {}, el('style', {}, '.box{width:100px;height:100px;background:#ff0000} #b{background:#0000ff}'), el('div', { className: 'box' }), el('div', { class: 'box', id: 'b' })), SIZE); return [colourAt(raster, 50, 50), colourAt(raster, 50, 150)] })())
    log('7e string style prop', { error: await captureError(() => draw(el('div', { style: 'color: red' }, 'x'), SIZE)) })
    log('7e kebab-case style keys', await (async () => { const { raster } = await draw(el('div', { style: { 'background-color': '#ff0000', width: 100, height: 100 } }), SIZE); return colourAt(raster, 50, 50) })())
    expect(true).toBe(true)
  })
})

describe('7f fonts', () => {
  it('same-name subsets, woff2', async () => {
    const latin = FONTS.find((f) => f.name === 'Inter' && f.weight === 400)!
    const cyr = FONTS.find((f) => f.name === 'Inter Cyrillic' && f.weight === 400)!
    const sameName = [{ ...latin, name: 'X' }, { ...cyr, name: 'X' }]
    const distinct = [{ ...latin, name: 'X' }, { ...cyr, name: 'Y' }]
    const onlyLatin = [{ ...latin, name: 'X' }]
    const text = el('div', { style: { fontSize: 40, fontFamily: 'X' } }, 'Привет')
    const r0 = await draw(text, { ...SIZE, fonts: onlyLatin })
    const r1 = await draw(text, { ...SIZE, fonts: sameName })
    const r2 = await draw(text, { ...SIZE, fonts: distinct })
    log('7f cyrillic text: only latin / same family name / distinct names', { onlyLatin: [ink(r0.raster), inkBox(r0.raster)], sameName: [ink(r1.raster), inkBox(r1.raster)], distinct: [ink(r2.raster), inkBox(r2.raster)], sameEqOnly: r0.svg === r1.svg })
    const w2 = [{ name: 'W2', data: interLatinWoff2, weight: 400 as const, style: 'normal' as const }]
    const a = await draw(el('div', { style: { fontSize: 40, fontFamily: 'W2' } }, 'Hello'), { ...SIZE, fonts: w2 })
    const b = await draw(el('div', { style: { fontSize: 40, fontFamily: 'X' } }, 'Hello'), { ...SIZE, fonts: onlyLatin })
    log('7f woff2', { bytes: interLatinWoff2.byteLength, ink: ink(a.raster), sameSvgAsWoff: a.svg === b.svg })
    log('7f no fonts', { error: await captureError(() => draw(el('div', {}, 'x'), { ...SIZE, fonts: [] })) })
    log('7f bold synth: weight 900 with only 400', await (async () => { const n = await draw(el('div', { style: { fontSize: 40, fontFamily: 'X', fontWeight: 400 } }, 'Hello'), { ...SIZE, fonts: onlyLatin }); const bld = await draw(el('div', { style: { fontSize: 40, fontFamily: 'X', fontWeight: 900 } }, 'Hello'), { ...SIZE, fonts: onlyLatin }); return { normalInk: ink(n.raster), boldInk: ink(bld.raster) } })())
    log('7f generic family monospace -> ?', await boxes(el('div', { style: { fontSize: 40 } }, el('code', {}, 'iiii'), el('span', { style: { fontFamily: 'JetBrains Mono' } }, 'iiii'), el('span', { style: { fontFamily: 'Inter' } }, 'iiii'))))
    expect(true).toBe(true)
  })
})

describe('7j inline svg', () => {
  it('svg children', async () => {
    const t = async (name: string, vdom: ReturnType<typeof el>, at: [number, number] = [50, 50]) => {
      const error = await captureError(async () => { const { raster } = await draw(vdom, SIZE); log(`7j ${name}`, { at: colourAt(raster, ...at), box: inkBox(raster) }) })
      if (error) log(`7j ${name} ERROR`, error)
    }
    await t('circle', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('circle', { cx: 50, cy: 50, r: 40, fill: '#ff0000' })))
    await t('kebab attrs stroke-width', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('path', { d: 'M10 50 H90', stroke: '#ff0000', 'stroke-width': 40, 'stroke-linecap': 'round' })))
    await t('camel attrs strokeWidth', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('path', { d: 'M10 50 H90', stroke: '#ff0000', strokeWidth: 40, strokeLinecap: 'round' })))
    await t('lowercase viewbox (html parser)', el('svg', { width: 100, height: 100, viewbox: '0 0 10 10' }, el('rect', { width: 10, height: 10, fill: '#ff0000' })))
    await t('no width/height, only viewBox', el('svg', { viewBox: '0 0 100 100' }, el('rect', { width: 100, height: 100, fill: '#ff0000' })))
    await t('css size on svg', el('svg', { viewBox: '0 0 100 100', style: { width: 100, height: 100 } }, el('rect', { width: 100, height: 100, fill: '#ff0000' })))
    await t('currentColor', el('div', { style: { color: '#ff0000', display: 'flex' } }, el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('rect', { width: 100, height: 100, fill: 'currentColor' }))))
    await t('defs + linearGradient + use', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('defs', {}, el('linearGradient', { id: 'g' }, el('stop', { offset: '0', stopColor: '#ff0000' }), el('stop', { offset: '1', stopColor: '#ff0000' })), el('rect', { id: 'r', width: 100, height: 100 })), el('use', { href: '#r', fill: 'url(#g)' })))
    await t('<text> inside svg', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('text', { x: 10, y: 50 }, 'hi')))
    await t('style attr object on child', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('rect', { width: 100, height: 100, style: { fill: '#ff0000' } })))
    await t('class on svg child + style element', el('div', {}, el('style', {}, '.r{fill:#ff0000}'), el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('rect', { width: 100, height: 100, className: 'r' }))))
    await t('foreignObject', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('foreignObject', { width: 100, height: 100 }, el('div', { style: { width: 100, height: 100, background: '#ff0000' } }))))
    await t('svg image data uri', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('image', { href: (await redImages()).png, width: 100, height: 100 })))
    await t('script inside svg', el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('script', {}, 'alert(1)'), el('rect', { width: 100, height: 100, fill: '#ff0000', onclick: 'alert(1)' })))
    const svg = await renderSvg(el('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, el('script', {}, 'alert(1)'), el('rect', { width: 100, height: 100, fill: '#ff0000', onclick: 'alert(1)' })), SIZE)
    log('7j output svg (script/onclick passthrough?)', svg)
    expect(true).toBe(true)
  })
})
