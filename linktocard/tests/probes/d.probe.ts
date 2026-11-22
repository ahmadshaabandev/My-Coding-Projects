import { expect, it } from 'vitest'
import { Resvg } from '@resvg/resvg-wasm'
import { renderSvg, warmUp, type VNode } from '../../src/render/engine'
import { el } from '../helpers'

const log = (label: string, value: unknown) => console.log(`PROBE ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
const SIZE = { width: 1200, height: 630 }

function raster(svg: string) {
  const t = performance.now()
  let outcome = 'ok'
  let resvg: InstanceType<typeof Resvg> | undefined
  let pixels: Uint8Array | undefined
  try {
    resvg = new Resvg(svg, { background: '#ffffff' })
    const img = resvg.render()
    pixels = img.pixels.slice()
    img.free()
  } catch (e) {
    outcome = `${(e as Error).name}: ${(e as Error).message}`
  }
  try { resvg?.free() } catch {}
  return { outcome, ms: Math.round(performance.now() - t), pixels }
}

const card = (w: number, h: number, style: Record<string, string | number>): VNode =>
  el('div', { style: { display: 'flex', width: '100%', height: '100%', background: '#fff', alignItems: 'center', justifyContent: 'center' } }, el('div', { style: { width: w, height: h, backgroundColor: '#2563eb', borderRadius: 16, ...style } }))

it('shadow cost grid', async () => {
  await warmUp()
  for (const [w, h] of [[200, 120], [1000, 500]] as const) {
    const row: Record<string, number | string> = {}
    for (const blur of [0, 4, 8, 16, 24, 32, 40, 48, 64]) {
      const svg = await renderSvg(card(w, h, { boxShadow: `0 8px ${blur}px rgba(0,0,0,.4)` }), SIZE)
      const r = raster(svg)
      row[`blur${blur}`] = r.outcome === 'ok' ? r.ms : r.outcome
    }
    log(`box-shadow ms, element ${w}x${h}`, row)
  }
  const trow: Record<string, number | string> = {}
  for (const blur of [0, 2, 4, 8, 16, 24, 32]) {
    const svg = await renderSvg(el('div', { style: { display: 'flex', width: '100%', height: '100%', background: '#fff', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter', fontSize: 96, fontWeight: 800, textShadow: `0 4px ${blur}px rgba(0,0,0,.5)` } }, 'Big headline'), SIZE)
    const r = raster(svg)
    trow[`blur${blur}`] = r.outcome === 'ok' ? r.ms : r.outcome
  }
  log('text-shadow ms, 96px headline', trow)
  const frow: Record<string, number | string> = {}
  for (const blur of [2, 8, 16, 40]) {
    const svg = await renderSvg(card(400, 300, { filter: `blur(${blur}px)` }), SIZE)
    frow[`filter blur${blur}`] = raster(svg).ms
    const svg2 = await renderSvg(card(400, 300, { filter: `drop-shadow(0 8px ${blur}px rgba(0,0,0,.5))` }), SIZE)
    frow[`drop-shadow blur${blur}`] = raster(svg2).ms
    const svg3 = await renderSvg(card(400, 300, { backdropFilter: `blur(${blur}px)`, backgroundColor: 'rgba(255,255,255,.3)' }), SIZE)
    frow[`backdrop blur${blur}`] = raster(svg3).ms
  }
  log('filter ms, element 400x300', frow)
  expect(true).toBe(true)
}, 300_000)

it('PoC: tighten box-shadow filter region', async () => {
  await warmUp()
  for (const blur of [60, 100]) {
    const svg = await renderSvg(card(600, 300, { boxShadow: `0 20px ${blur}px rgba(0,0,0,.5)` }), SIZE)
    const before = raster(svg)
    const m = 3 * (blur / 2) + 40
    const tightened = svg.replace(/<filter id="(satori_s-[^"]+)" x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+">/g, (_all, id) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-m}" y="${-m}" width="${SIZE.width + 2 * m}" height="${SIZE.height + 2 * m}">`)
    const after = raster(tightened)
    let maxDiff = 0, diffPixels = 0
    if (before.pixels && after.pixels) for (let i = 0; i < before.pixels.length; i++) { const d = Math.abs(before.pixels[i]! - after.pixels[i]!); if (d > maxDiff) maxDiff = d; if (d > 2) diffPixels++ }
    log(`PoC blur ${blur}`, { changed: tightened !== svg, beforeMs: before.ms, afterMs: after.ms, beforeOutcome: before.outcome, afterOutcome: after.outcome, maxChannelDiff: maxDiff, channelsDifferingBy3plus: diffPixels })
  }
  expect(true).toBe(true)
}, 300_000)
