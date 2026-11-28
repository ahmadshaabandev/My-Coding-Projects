// A laid-out chart: shapes and one-line text boxes in CSS pixels. Layout produces a Scene
// (pure, testable); this file turns its shapes into SVG markup and its texts into Satori nodes.
import type { VNode } from '../render/engine'
import { isMeasurable, type Weight } from './text'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Side = 'top' | 'right' | 'bottom' | 'left'

export type Shape =
  /** `round` rounds the two corners on one side (the data end of a bar) with radius `r`; without it all four. */
  | ({ kind: 'rect'; fill: string; r?: number; round?: Side; opacity?: number } & Rect)
  | { kind: 'path'; d: string; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string; stroke?: string; strokeWidth?: number }
  /** Children are drawn only inside `rect`. */
  | { kind: 'clip'; rect: Rect; shapes: Shape[] }

export interface Text extends Rect {
  text: string
  size: number
  weight: Weight
  color: string
  align: 'start' | 'center' | 'end'
  /** Rotated a quarter turn anticlockwise around the centre of the box (the title of a vertical axis). */
  rotate?: boolean
}

export interface Scene {
  width: number
  height: number
  /** '#rrggbb' or 'transparent'. */
  background: string
  shapes: Shape[]
  texts: Text[]
}

export const overlaps = (a: Rect, b: Rect, margin = 0): boolean =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin

/**
 * A coordinate as SVG text. Two decimals are a quarter of a device pixel at scale 2: enough, and
 * it keeps the SVG short. A value that is not a number is a bug in the layout: the render fails
 * rather than produce a broken image.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Chart layout produced a coordinate that is not a number.')
  return String(Math.round(value * 100) / 100)
}
const n = num

/** Path of a rectangle with the two corners on `side` rounded. */
function roundedEnd({ x, y, w, h }: Rect, side: Side, radius: number): string {
  const r = Math.max(0, Math.min(radius, side === 'top' || side === 'bottom' ? Math.min(w / 2, h) : Math.min(h / 2, w)))
  const [x2, y2] = [x + w, y + h]
  switch (side) {
    case 'top':
      return `M${n(x)} ${n(y2)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(x2 - r)}Q${n(x2)} ${n(y)} ${n(x2)} ${n(y + r)}V${n(y2)}Z`
    case 'bottom':
      return `M${n(x)} ${n(y)}V${n(y2 - r)}Q${n(x)} ${n(y2)} ${n(x + r)} ${n(y2)}H${n(x2 - r)}Q${n(x2)} ${n(y2)} ${n(x2)} ${n(y2 - r)}V${n(y)}Z`
    case 'right':
      return `M${n(x)} ${n(y)}H${n(x2 - r)}Q${n(x2)} ${n(y)} ${n(x2)} ${n(y + r)}V${n(y2 - r)}Q${n(x2)} ${n(y2)} ${n(x2 - r)} ${n(y2)}H${n(x)}Z`
    case 'left':
      return `M${n(x2)} ${n(y)}H${n(x + r)}Q${n(x)} ${n(y)} ${n(x)} ${n(y + r)}V${n(y2 - r)}Q${n(x)} ${n(y2)} ${n(x + r)} ${n(y2)}H${n(x2)}Z`
  }
}

const attr = (name: string, value: string | number | undefined): string => (value === undefined ? '' : ` ${name}="${typeof value === 'number' ? n(value) : value}"`)

/**
 * SVG markup for the shapes, in drawing order. Every string in it is a number or a colour that
 * validation or the theme produced; text supplied by the caller never reaches this markup.
 */
export function shapesToSvg(shapes: readonly Shape[], ids = { next: 0 }): string {
  let out = ''
  for (const shape of shapes) {
    switch (shape.kind) {
      case 'rect':
        if (shape.w <= 0 || shape.h <= 0) break
        out += shape.round
          ? `<path d="${roundedEnd(shape, shape.round, shape.r ?? 0)}" fill="${shape.fill}"${attr('opacity', shape.opacity)}/>`
          : `<rect x="${n(shape.x)}" y="${n(shape.y)}" width="${n(shape.w)}" height="${n(shape.h)}"${attr('rx', shape.r)} fill="${shape.fill}"${attr('opacity', shape.opacity)}/>`
        break
      case 'path':
        out += `<path d="${shape.d}" fill="${shape.fill ?? 'none'}"${attr('stroke', shape.stroke)}${attr('stroke-width', shape.strokeWidth)}${
          shape.stroke ? ' stroke-linejoin="round" stroke-linecap="round"' : ''
        }${attr('opacity', shape.opacity)}/>`
        break
      case 'circle':
        out += `<circle cx="${n(shape.cx)}" cy="${n(shape.cy)}" r="${n(shape.r)}" fill="${shape.fill}"${attr('stroke', shape.stroke)}${attr('stroke-width', shape.strokeWidth)}/>`
        break
      case 'clip': {
        const id = `chart-clip-${ids.next++}`
        const { x, y, w, h } = shape.rect
        out += `<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath><g clip-path="url(#${id})">${shapesToSvg(shape.shapes, ids)}</g>`
        break
      }
    }
  }
  return out
}

const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end' } as const

/**
 * One absolutely positioned box per text. Layout has already cut every text to its box with the
 * width table, so the box only aligns it. Text with characters outside the bundled fonts cannot
 * be measured; it gets an inner box that lets the text engine cut it with an ellipsis instead.
 */
export function textToNode(text: Text): VNode {
  const safe = isMeasurable(text.text)
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: text.x,
        top: text.y,
        width: text.w,
        height: text.h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: JUSTIFY[text.align],
        fontSize: text.size,
        fontWeight: text.weight,
        color: text.color,
        whiteSpace: 'nowrap',
        ...(text.rotate ? { transform: 'rotate(-90deg)' } : {}),
      },
      children: safe
        ? text.text
        : { type: 'div', props: { style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }, children: text.text } },
    },
  }
}
