import { encodeRasterJpeg, encodeRasterWebp, rasterize, renderSvg, svgToPng, type SvgOptions, type VNode } from '../src/render/engine'

type Child = VNode | string | number | null | undefined | false

/** Tiny hyperscript: el('div', { style: {...} }, child, child) */
export function el(type: string, props: Record<string, unknown> = {}, ...children: Child[]): VNode {
  const kids = children.flat() as Child[]
  return { type, props: { ...props, ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) } } as VNode
}

export interface Raster {
  width: number
  height: number
  pixels: Uint8Array
}

export async function draw(vdom: VNode, options: SvgOptions, background = '#ffffff'): Promise<{ svg: string; raster: Raster }> {
  const svg = await renderSvg(vdom, options)
  return { svg, raster: await rasterize(svg, options.width, background) }
}

export function pixel(raster: Raster, x: number, y: number): [number, number, number, number] {
  const i = (Math.round(y) * raster.width + Math.round(x)) * 4
  return [raster.pixels[i]!, raster.pixels[i + 1]!, raster.pixels[i + 2]!, raster.pixels[i + 3]!]
}

/** Classifies a pixel as one of the pure test colours. */
export function colourName([r, g, b]: readonly number[]): string {
  const hi = (v: number) => v > 200
  const lo = (v: number) => v < 60
  if (hi(r!) && hi(g!) && hi(b!)) return 'white'
  if (lo(r!) && lo(g!) && lo(b!)) return 'black'
  if (hi(r!) && lo(g!) && lo(b!)) return 'red'
  if (lo(r!) && g! > 100 && lo(b!)) return 'green'
  if (lo(r!) && lo(g!) && hi(b!)) return 'blue'
  return `rgb(${r},${g},${b})`
}

export const colourAt = (raster: Raster, x: number, y: number) => colourName(pixel(raster, x, y))

/** Number of pixels in the box that differ from white. */
export function ink(raster: Raster, box: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: raster.width, h: raster.height }): number {
  let count = 0
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * raster.width + x) * 4
      if (raster.pixels[i]! < 240 || raster.pixels[i + 1]! < 240 || raster.pixels[i + 2]! < 240) count++
    }
  }
  return count
}

/** Bounding box of all non-white pixels, or null. */
export function inkBox(raster: Raster): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const i = (y * raster.width + x) * 4
      if (raster.pixels[i]! < 240 || raster.pixels[i + 1]! < 240 || raster.pixels[i + 2]! < 240) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Decodes a PNG to RGBA pixels with resvg (the project has no other PNG decoder). */
export async function decodePng(png: Uint8Array): Promise<Raster> {
  const { width, height } = pngSize(png)
  const href = `data:image/png;base64,${toBase64(png)}`
  return rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="${href}"/></svg>`, width)
}

/** Number of pixels inside the box whose colour differs between two rasters of the same size. */
export function diffPixels(a: Raster, b: Raster, box: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: a.width, h: a.height }): number {
  let count = 0
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * a.width + x) * 4
      if (Math.abs(a.pixels[i]! - b.pixels[i]!) + Math.abs(a.pixels[i + 1]! - b.pixels[i + 1]!) + Math.abs(a.pixels[i + 2]! - b.pixels[i + 2]!) > 24) count++
    }
  }
  return count
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const RED_SVG = (size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#ff0000"/></svg>`

/** Solid red test images produced with the project's own encoders, as data: URIs. */
export async function redImages(size = 16) {
  const svg = RED_SVG(size)
  const raster = await rasterize(svg, size)
  return {
    png: `data:image/png;base64,${toBase64(await svgToPng(svg, size))}`,
    jpeg: `data:image/jpeg;base64,${toBase64(await encodeRasterJpeg(raster))}`,
    webp: `data:image/webp;base64,${toBase64(await encodeRasterWebp(raster))}`,
    // 1x1 GIF89a, palette [ff0000, ffffff], single pixel = index 0.
    gif: 'data:image/gif;base64,R0lGODlhAQABAIABAP8AAP///ywAAAAAAQABAAACAkQBADs=',
    svg: `data:image/svg+xml;base64,${btoa(svg)}`,
    svgUtf8: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  }
}

export async function captureError(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}
