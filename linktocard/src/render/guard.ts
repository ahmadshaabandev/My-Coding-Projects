// Input guard that runs right before Satori.
//
// Satori fetches on its own (`fetch(url, { redirect: 'manual' })`) for every http(s) URL it finds:
// <img src>, SVG <image href>, and CSS url() in background-image, mask-image, list-style-image,
// `content` (::before/::after) - including rules inside <style> elements. It has no switch to
// turn that off. The product must never let the renderer talk to the network, so anything that
// is not a `data:` URI (or a local `#fragment` reference) is rejected here: remote resources
// have to be downloaded and inlined as data URIs BEFORE the VDOM reaches the engine.
//
// The guard also bounds tree size and depth (very deep trees overflow the stack inside Satori:
// "RangeError: Maximum call stack size exceeded").
import type { VNode } from './engine'

export class RenderInputError extends Error {
  override name = 'RenderInputError'
}

export interface GuardLimits {
  /** Maximum element + text nodes. Satori costs roughly 0.15-0.2 ms per node. */
  maxNodes: number
  /** Maximum nesting depth. Depth 200 works, depth 1000 overflows the stack. */
  maxDepth: number
}

export const DEFAULT_LIMITS: GuardLimits = { maxNodes: 3000, maxDepth: 100 }

/** Props whose value is a URL that Satori (or a later consumer of the SVG) may load. */
const URL_PROPS = new Set(['src', 'srcSet', 'srcset', 'poster', 'href', 'xlinkHref', 'xlink:href'])
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi

function isLocal(url: string): boolean {
  const value = url.trim().toLowerCase()
  return value === '' || value.startsWith('data:') || value.startsWith('#')
}

function checkCss(text: string, where: string): void {
  CSS_URL.lastIndex = 0
  for (let match = CSS_URL.exec(text); match; match = CSS_URL.exec(text)) {
    const target = match[1] ?? match[2] ?? match[3] ?? ''
    if (!isLocal(target)) {
      throw new RenderInputError(`Remote URL in ${where}: url(${target.slice(0, 80)}). Only data: URIs are allowed.`)
    }
  }
}

function checkValue(value: unknown, where: string): void {
  if (typeof value === 'string') checkCss(value, where)
  else if (Array.isArray(value)) for (const item of value) checkValue(item, where)
  else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    for (const [key, nested] of Object.entries(value)) checkValue(nested, `${where}.${key}`)
  }
}

/** Throws RenderInputError if the tree could make Satori fetch, or is too large / too deep. */
export function assertSafeVdom(root: unknown, limits: GuardLimits = DEFAULT_LIMITS): void {
  let nodes = 0
  const visit = (node: unknown, depth: number, insideStyle: boolean): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth, insideStyle)
      return
    }
    if (++nodes > limits.maxNodes) throw new RenderInputError(`Too many nodes (limit ${limits.maxNodes}).`)
    if (typeof node === 'string' || typeof node === 'number') {
      // Text of a <style> element is CSS that Satori applies; ordinary text may mention URLs freely.
      if (insideStyle) checkCss(String(node), '<style>')
      return
    }
    if (depth > limits.maxDepth) throw new RenderInputError(`Tree too deep (limit ${limits.maxDepth}).`)
    const { type, props } = node as VNode
    if (typeof type !== 'string') throw new RenderInputError('Only plain elements (string `type`) are supported.')
    for (const [name, value] of Object.entries(props ?? {})) {
      if (name === 'children') continue
      if (URL_PROPS.has(name)) {
        // <a href> is never loaded; everything else must be inline.
        if (typeof value === 'string' && !(type === 'a' && name === 'href') && !isLocal(value)) {
          throw new RenderInputError(`Remote URL in <${type} ${name}>: ${value.slice(0, 80)}. Only data: URIs are allowed.`)
        }
        continue
      }
      checkValue(value, `<${type}> ${name}`)
    }
    visit(props?.children, depth + 1, type === 'style')
  }
  visit(root, 0, false)
}
