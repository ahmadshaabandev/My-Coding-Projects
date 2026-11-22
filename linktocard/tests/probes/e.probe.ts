import { expect, it } from 'vitest'
import { renderSvg, warmUp } from '../../src/render/engine'
import { FONTS, fontStack } from '../../src/render/fonts'
import { sampleCard } from '../../src/render/sample-card'
import { el } from '../helpers'
import interLatin400w2 from '../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2'
import interLatinExt400w2 from '../../node_modules/@fontsource/inter/files/inter-latin-ext-400-normal.woff2'

const log = (label: string, value: unknown) => console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const SIZE = { width: 1200, height: 630 }
const ms = (n: number) => Math.round(n * 10) / 10
const fresh = (fonts: typeof FONTS) => fonts.map((f) => ({ ...f, data: f.data.slice(0) }))

it('font parse cost', async () => {
  await warmUp()
  // prime satori itself (layout engine etc.) with a tiny font set
  await renderSvg(el('div', {}, 'x'), { ...SIZE, fonts: fresh(FONTS.slice(0, 1)) })
  for (const n of [1, 4, 8, 20, 30]) {
    const fonts = fresh(FONTS.slice(0, n))
    const t0 = performance.now()
    await renderSvg(el('div', { style: { fontFamily: 'Inter' } }, 'x'), { ...SIZE, fonts })
    const t1 = performance.now()
    await renderSvg(el('div', { style: { fontFamily: 'Inter' } }, 'y'), { ...SIZE, fonts })
    const t2 = performance.now()
    log(`fonts=${n} (fresh buffers)`, { firstMs: ms(t1 - t0), secondMs: ms(t2 - t1), bytes: fonts.reduce((s, f) => s + f.data.byteLength, 0) })
  }
  // same data buffers, new array each call (inline array anti-pattern)
  const t0 = performance.now()
  for (let i = 0; i < 5; i++) await renderSvg(el('div', { style: { fontFamily: 'Inter' } }, 'z' + i), { ...SIZE, fonts: [...FONTS] })
  log('5 renders with a NEW array of the SAME buffers each time', { totalMs: ms(performance.now() - t0) })
  const t1 = performance.now()
  for (let i = 0; i < 5; i++) await renderSvg(el('div', { style: { fontFamily: 'Inter' } }, 'w' + i), { ...SIZE, fonts: fresh(FONTS) })
  log('5 renders with NEW buffers each time (cache defeated)', { totalMs: ms(performance.now() - t1) })
  // woff2 parse cost
  const w2 = [{ name: 'A', data: interLatin400w2.slice(0), weight: 400 as const, style: 'normal' as const }, { name: 'B', data: interLatinExt400w2.slice(0), weight: 400 as const, style: 'normal' as const }]
  const w1 = fresh([FONTS[0]!, FONTS[4]!])
  let t = performance.now(); await renderSvg(el('div', { style: { fontFamily: 'A' } }, 'x'), { ...SIZE, fonts: w2 }); const w2ms = performance.now() - t
  t = performance.now(); await renderSvg(el('div', { style: { fontFamily: 'Inter' } }, 'x'), { ...SIZE, fonts: w1 }); const w1ms = performance.now() - t
  log('parse 2 fonts: woff2 vs woff', { woff2Ms: ms(w2ms), woffMs: ms(w1ms), woff2Bytes: w2[0]!.data.byteLength + w2[1]!.data.byteLength, woffBytes: w1[0]!.data.byteLength + w1[1]!.data.byteLength })
  expect(true).toBe(true)
})

it('fallback order', async () => {
  const path = (svg: string) => (svg.match(/<path[^>]* d="([^"]+)"/) ?? [])[1]?.slice(0, 60)
  const serifOnly = await renderSvg(el('div', { style: { fontSize: 100, fontFamily: '"Source Serif 4"' } }, 'ł'), SIZE)
  const serifStack = await renderSvg(el('div', { style: { fontSize: 100, fontFamily: fontStack('Source Serif 4') } }, 'ł'), SIZE)
  const interExt = await renderSvg(el('div', { style: { fontSize: 100, fontFamily: '"Inter Latin Ext"' } }, 'ł'), SIZE)
  const serifExt = await renderSvg(el('div', { style: { fontSize: 100, fontFamily: '"Source Serif 4 Latin Ext"' } }, 'ł'), SIZE)
  log('ł with family "Source Serif 4" only', { sameAsInterLatinExt: path(serifOnly) === path(interExt), sameAsSerifLatinExt: path(serifOnly) === path(serifExt) })
  log('ł with fontStack("Source Serif 4")', { sameAsInterLatinExt: path(serifStack) === path(interExt), sameAsSerifLatinExt: path(serifStack) === path(serifExt) })
  // varied-content warm timing
  const times: number[] = []
  for (let i = 0; i < 8; i++) { const t = performance.now(); await renderSvg(sampleCard(`Unique title number ${i} ${'abcdefgh'[i]}`, `Subtitle ${i * 7919}`), SIZE); times.push(ms(performance.now() - t)) }
  log('satori ms, sample card with different text each time', times)
  const same: number[] = []
  for (let i = 0; i < 4; i++) { const t = performance.now(); await renderSvg(sampleCard(), SIZE); same.push(ms(performance.now() - t)) }
  log('satori ms, identical sample card', same)
  expect(true).toBe(true)
})
