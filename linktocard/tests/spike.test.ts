import { describe, expect, it } from 'vitest'
import { initRuns, render } from '../src/render/engine'
import { sampleCard } from '../src/render/sample-card'

const SIZE = { width: 1200, height: 630 }

describe('render engine inside workerd', () => {
  it('runs in workerd, not node', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers')
  })

  it('renders a PNG with the right signature and IHDR size', async () => {
    const png = await render(sampleCard(), { ...SIZE, format: 'png' })
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR')
    expect(view.getUint32(16)).toBe(1200)
    expect(view.getUint32(20)).toBe(630)
  })
})
