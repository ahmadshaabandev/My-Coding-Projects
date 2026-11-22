import { describe, expect, it, vi } from 'vitest'
import { initRuns, rasterize, render, renderSvg } from '../src/render/engine'
import { sampleCard } from '../src/render/sample-card'

const SIZE = { width: 1200, height: 630 }

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

describe('render engine inside workerd', () => {
  it('runs in workerd, not node', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers')
  })

  it('renders a PNG with the right signature and IHDR size', async () => {
    const png = await render(sampleCard(), { ...SIZE, format: 'png' })
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(ascii(png, 12, 16)).toBe('IHDR')
    expect(view.getUint32(16)).toBe(1200)
    expect(view.getUint32(20)).toBe(630)
    expect(png.byteLength).toBeGreaterThan(10_000)
  })

  it('renders a JPEG (SOI marker)', async () => {
    const jpeg = await render(sampleCard(), { ...SIZE, format: 'jpeg' })
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]) // EOI
    expect(jpeg.byteLength).toBeGreaterThan(5_000)
  })

  it('renders a WebP (RIFF/WEBP header)', async () => {
    const webp = await render(sampleCard(), { ...SIZE, format: 'webp' })
    expect(ascii(webp, 0, 4)).toBe('RIFF')
    expect(ascii(webp, 8, 12)).toBe('WEBP')
    const riffSize = new DataView(webp.buffer, webp.byteOffset, webp.byteLength).getUint32(4, true)
    expect(riffSize + 8).toBe(webp.byteLength)
  })

  it('renders the other product sizes', async () => {
    for (const [width, height] of [
      [1080, 1080],
      [1080, 1350],
    ] as const) {
      const png = await render(sampleCard(), { width, height, format: 'png' })
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([width, height])
    }
  })

  it('a second render reuses the initialised wasm (every initialiser ran exactly once)', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const bytes = await render(sampleCard('Second render'), { ...SIZE, format })
      expect(bytes.byteLength).toBeGreaterThan(5_000)
    }
    // Concurrent renders must not race the initialisers either.
    await Promise.all([
      render(sampleCard('a'), { ...SIZE, format: 'png' }),
      render(sampleCard('b'), { ...SIZE, format: 'jpeg' }),
      render(sampleCard('c'), { ...SIZE, format: 'webp' }),
    ])
    expect(initRuns()).toEqual({ satori: 1, resvg: 1, jpeg: 1, webp: 1, harfbuzz: 1 })
  })

  it('survives the module graph being evaluated a second time in the same isolate', async () => {
    // What vitest does on vi.resetModules() / between files: our module-level state is gone,
    // and each library is either the old instance (still initialised) or a brand-new one
    // (needs init again). Both must work: no "Already initialized", no hang.
    const before = initRuns()
    vi.resetModules()
    const again = await import('../src/render/engine')
    expect(again.render).not.toBe(render)
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const bytes = await again.render(sampleCard('Re-evaluated'), { ...SIZE, format })
      expect(bytes.byteLength).toBeGreaterThan(5_000)
    }
    // The old module instance still works as well.
    expect((await render(sampleCard('Old instance'), { ...SIZE, format: 'png' })).byteLength).toBeGreaterThan(5_000)
    console.log('init runs before/after module re-evaluation', JSON.stringify(before), JSON.stringify(again.initRuns()))
  })

  it('text is emitted as glyph paths (fonts are embedded, resvg needs none)', async () => {
    const svg = await renderSvg(sampleCard(), SIZE)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<path')
    expect(svg).not.toContain('<text')
  })

  it('pixels are fully opaque, so premultiplied == straight alpha', async () => {
    const raster = await rasterize(await renderSvg(sampleCard(), SIZE), SIZE.width)
    expect(raster.pixels.byteLength).toBe(1200 * 630 * 4)
    let minAlpha = 255
    for (let i = 3; i < raster.pixels.length; i += 4) minAlpha = Math.min(minAlpha, raster.pixels[i]!)
    expect(minAlpha).toBe(255)
  })
})
