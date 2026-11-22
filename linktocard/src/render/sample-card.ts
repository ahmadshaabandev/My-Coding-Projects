import type { VNode } from './engine'
import { fontStack } from './fonts'

const h = (type: string, style: Record<string, string | number>, ...children: VNode['props']['children'][]): VNode => ({
  type,
  props: { style, children: children.flat() as VNode['props']['children'] },
})

/** Small card used by the spike test and the /spike.* smoke endpoints. */
export function sampleCard(title = 'Link To Card', subtitle = 'Satori + resvg-wasm inside workerd'): VNode {
  return h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      // satori@0.63 follows CSS: box-sizing defaults to content-box, so without this the
      // padding is added to the 100% and the bottom row is pushed out of the image.
      boxSizing: 'border-box',
      width: '100%',
      height: '100%',
      padding: 64,
      backgroundImage: 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)',
      color: '#f8fafc',
      fontFamily: fontStack('Inter'),
    },
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h('div', { fontSize: 84, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }, title),
      h('div', { marginTop: 24, fontSize: 36, fontWeight: 400, color: '#cbd5e1' }, subtitle),
    ),
    h(
      'div',
      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 28 },
      h('div', { fontFamily: fontStack('Source Serif 4'), fontStyle: 'italic' }, 'Żółć, Привет, Γειά σου, Tiếng Việt'),
      h('div', { fontFamily: fontStack('JetBrains Mono'), fontWeight: 700, color: '#93c5fd' }, 'workerd'),
    ),
  )
}
