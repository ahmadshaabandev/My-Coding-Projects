// Unit tests for the template compiler (src/render/css.ts, template.ts, fonts.ts, svg-check.ts).
// They run inside workerd like everything else, but render nothing: tests/render.test.ts
// covers the pipeline end to end.
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../src/config'
import { ApiError } from '../src/lib/errors'
import { BASE_CSS, BUILTIN_FONT_FAMILIES, GENERIC_FONT_FAMILIES, validateTemplate } from '../src/render'
import {
  cssDeclarations,
  cssUrls,
  dropUnsupportedAtRules,
  fontVariableNames,
  isOpaqueFontShorthand,
  mapCssDeclarations,
  parseCss,
  parseFontFamilyList,
  parseInlineStyle,
  replaceCssUrls,
  rewriteDeclaration,
  serializeCss,
  splitFontShorthand,
  stripCssComments,
  type FontFamilyItem,
  type ValueRewriter,
} from '../src/render/css'
import { rasterize, type VNode } from '../src/render/engine'
import { stampWatermark, watermarkMarkup } from '../src/render/watermark'
import { bundledFamily, expandFontFamilies, FONTS, fontStack, fontsWith } from '../src/render/fonts'
import { assertSvgWithinLimits, dropOffCanvasContent, measureSvgEffects } from '../src/render/svg-check'
import {
  bindStaticTemplate,
  bindTemplate,
  buildDocument,
  canonicalDataUri,
  classifyImageUrl,
  parseTemplate,
  stateClasses,
  type BoundElement,
  type ResourceResolver,
} from '../src/render/template'
import type { LoadedFont } from '../src/types'

const OG = { width: 1200, height: 630 }

const codeOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return error instanceof ApiError ? error.code : `not an ApiError: ${String(error)}`
  }
  return 'no error'
}

const names = (items: FontFamilyItem[]): string => items.map((item) => (item.kind === 'name' ? item.name : item.text)).join('|')
const passThrough: ValueRewriter = { url: (target) => target, fontFamilies: names, fontVariables: new Set() }

/** Resolver that leaves data: URIs alone and marks remote URLs, so tests can see where they end up. */
const marking: ResourceResolver = {
  image: (reference) => (reference.kind === 'remote' ? `data:image/png;base64,REMOTE` : reference.kind === 'data' ? reference.uri : reference.id),
  fontFamilies: names,
}

const bodyOf = (document: VNode): VNode => (document.props.children as VNode[])[1]!
const sheetOf = (document: VNode): string => (document.props.children as VNode[])[0]!.props.children as string
const kids = (node: VNode): (VNode | string)[] => [node.props.children].flat() as (VNode | string)[]
const build = (html: string, css = '', data: Record<string, string> = {}) =>
  buildDocument(bindTemplate(parseTemplate(html, css), data, OG), marking, () => undefined)

describe('css.ts', () => {
  it('strips comments but not comment-looking text inside strings', () => {
    expect(stripCssComments('a{/* x */color:red}/* unterminated')).toBe('a{ color:red} ')
    expect(stripCssComments('a::before{content:"/* keep */"}')).toBe('a::before{content:"/* keep */"}')
  })

  it('parses rules, nested blocks, at-rules and declarations; tolerates garbage', () => {
    const nodes = parseCss('@layer a, b; .x > p:hover { color: red; ; background: url("a;b{c}.png") } @media (min-width: 10px) { .y { --Custom: 1 } } }}} nonsense')
    expect(serializeCss(nodes)).toBe('@layer a, b;.x > p:hover{color:red;background:url("a;b{c}.png");}@media (min-width: 10px){.y{--Custom:1;}}')
    expect([...cssDeclarations(nodes)].map((d) => d.name)).toEqual(['color', 'background', '--Custom'])
  })

  it('refuses absurdly nested blocks instead of overflowing the stack', () => {
    expect(codeOf(() => parseCss('a{'.repeat(5000)))).toBe('template_error')
  })

  it('parses a style attribute: quotes and parentheses protect ; and :', () => {
    expect(parseInlineStyle('COLOR: red; background-image: url(data:image/png;base64,AA==); content: "a;b:c"; broken; --x:  1 2 ')).toEqual([
      { name: 'color', value: 'red' },
      { name: 'background-image', value: 'url(data:image/png;base64,AA==)' },
      { name: 'content', value: '"a;b:c"' },
      { name: '--x', value: '1 2' },
    ])
  })

  it('drops at-rules that load resources or that Satori ignores, once per kind', () => {
    const warnings: string[] = []
    const kept = dropUnsupportedAtRules(
      parseCss('@import url(https://x.test/a.css); @import "b.css"; @font-face { font-family: X; src: url(https://x.test/x.woff) } @media print { @keyframes k { from { top: 0 } } .a { top: 1px } } @supports (display: grid) { .b { top: 2px } }'),
      (message) => warnings.push(message),
    )
    expect(serializeCss(kept)).toBe('@media print{.a{top:1px;}}@supports (display: grid){.b{top:2px;}}')
    expect([...new Set(warnings)].sort()).toEqual(['@font-face is not supported and was ignored.', '@import is not supported and was ignored.', '@keyframes is not supported and was ignored.'])
  })

  it('finds and rewrites url() tokens, quoted or not, but not text inside strings', () => {
    const value = 'url(a.png), URL( "b c.png" ) no-repeat, url(\'d.png\'), "url(not-a-url)" myurl(x)'
    expect(cssUrls(value)).toEqual(['a.png', 'b c.png', 'd.png'])
    expect(replaceCssUrls(value, (target) => target.toUpperCase())).toBe('url("A.PNG"), url("B C.PNG") no-repeat, url("D.PNG"), "url(not-a-url)" myurl(x)')
  })

  it('splits a font shorthand into head and family list', () => {
    expect(splitFontShorthand('italic 700 24px/1.2 "Source Serif 4", serif')).toEqual({ head: 'italic 700 24px/1.2', families: '"Source Serif 4", serif' })
    expect(splitFontShorthand('bold 2em / 1.5 Inter')).toEqual({ head: 'bold 2em / 1.5', families: 'Inter' })
    expect(splitFontShorthand('calc(1px + 2em) monospace')).toEqual({ head: 'calc(1px + 2em)', families: 'monospace' })
    expect(splitFontShorthand('caption')).toBeUndefined()
    expect(splitFontShorthand('700 var(--size) Inter')).toBeUndefined()
  })

  it('parses font-family lists', () => {
    expect(parseFontFamilyList(' "Source Serif 4" , Times  New Roman, var(--f, serif), \'Inter\' ')).toEqual([
      { kind: 'name', name: 'Source Serif 4' },
      { kind: 'name', name: 'Times New Roman' },
      { kind: 'raw', text: 'var(--f, serif)' },
      { kind: 'name', name: 'Inter' },
    ])
    expect(parseFontFamilyList('inherit')).toBeUndefined()
  })

  it('follows var() from font-family to the custom properties that hold family lists', () => {
    const declarations = [...cssDeclarations(parseCss(':root{--head:var(--brand),serif;--brand:Georgia;--size:12px;--short:700 12px Inter} h1{font-family:var(--head)} p{font:var(--short)}'))]
    expect([...fontVariableNames(declarations)].sort()).toEqual(['--brand', '--head'])
    expect(declarations.filter(isOpaqueFontShorthand).map((d) => d.value)).toEqual(['var(--short)'])
  })

  it('rewrites url() and font families in font-family, font and font variables, keeping !important', () => {
    const rewriter: ValueRewriter = { url: (target) => `X-${target}`, fontFamilies: (items) => `[${names(items)}]`, fontVariables: new Set(['--head']) }
    const rewrite = (name: string, value: string) => rewriteDeclaration({ name, value }, rewriter).value
    expect(rewrite('background', 'url(a.png) red')).toBe('url("X-a.png") red')
    expect(rewrite('font-family', 'Georgia, serif !important')).toBe('[Georgia|serif] !important')
    expect(rewrite('font', 'italic 12px/2 Georgia, serif')).toBe('italic 12px/2 [Georgia|serif]')
    expect(rewrite('--head', '"A B", serif')).toBe('[A B|serif]')
    expect(rewrite('--other', 'serif')).toBe('serif')
    expect(rewrite('font-family', 'inherit')).toBe('inherit')
    expect(serializeCss(mapCssDeclarations(parseCss('@media print{a{font-family:serif}}'), (d) => rewriteDeclaration(d, passThrough)))).toBe('@media print{a{font-family:serif;}}')
  })
})

describe('fonts.ts', () => {
  it('describes the bundled families from the registered fonts', () => {
    expect(BUILTIN_FONT_FAMILIES).toEqual({
      'Inter': [400, 600, 700, 800].map((weight) => ({ weight, style: 'normal' })),
      'Source Serif 4': [{ weight: 400, style: 'normal' }, { weight: 600, style: 'normal' }, { weight: 400, style: 'italic' }],
      'JetBrains Mono': [{ weight: 400, style: 'normal' }, { weight: 700, style: 'normal' }],
    })
    expect(GENERIC_FONT_FAMILIES).toEqual({
      'sans-serif': 'Inter', 'system-ui': 'Inter', 'ui-sans-serif': 'Inter',
      'serif': 'Source Serif 4', 'ui-serif': 'Source Serif 4',
      'monospace': 'JetBrains Mono', 'ui-monospace': 'JetBrains Mono',
    })
    expect(bundledFamily('SOURCE serif 4')).toBe('Source Serif 4')
    expect(bundledFamily('UI-Monospace')).toBe('JetBrains Mono')
    expect(bundledFamily('Inter Cyrillic')).toBeUndefined()
  })

  it('expands lists to subset stacks, keeps customer families, reports the rest', () => {
    const missing: string[] = []
    const expand = (list: string) => expandFontFamilies(parseFontFamilyList(list)!, new Set(['acme sans']), (name) => missing.push(name))
    expect(expand('serif')).toBe(fontStack('Source Serif 4'))
    expect(expand('"Acme Sans", Helvetica, monospace, ui-monospace')).toBe(`"Acme Sans", ${fontStack('JetBrains Mono')}`)
    expect(expand('var(--f), Arial')).toBe('var(--f)')
    expect(expand('Papyrus, fantasy')).toBe(fontStack('Inter'))
    expect(missing).toEqual(['Helvetica', 'Arial', 'Papyrus', 'fantasy'])
  })

  it('keeps FONTS identity without customer fonts and memoises combinations by buffer identity', () => {
    const data = new ArrayBuffer(8)
    const custom: LoadedFont[] = [{ family: 'Acme Sans', weight: 450, style: 'normal', data }]
    expect(fontsWith([])).toBe(FONTS)
    const first = fontsWith(custom)
    expect(first).not.toBe(FONTS)
    expect(first.slice(0, FONTS.length)).toEqual(FONTS)
    expect(first.at(-1)).toEqual({ name: 'Acme Sans', weight: 500, style: 'normal', data })
    expect(fontsWith([{ ...custom[0]! }])).toBe(first)
    expect(fontsWith([{ ...custom[0]!, data: new ArrayBuffer(8) }])).not.toBe(first)
  })
})

describe('parseTemplate', () => {
  it('flattens document wrappers, keeps body/html attributes, hoists <style> in order', () => {
    const parsed = parseTemplate(
      '<!doctype html><html lang="en" data-x="1"><head><title>t</title><style>.a{top:1px}</style></head><body class="dark" onload="x()"><div ID="Main">Hi<style>.b{top:2px}</style></div></body></html>',
      '.c{top:3px}',
    )
    expect(parsed.htmlAttrs).toEqual({ lang: 'en' })
    expect(parsed.bodyAttrs).toEqual({ class: 'dark' })
    expect(parsed.children).toEqual([{ tag: 'div', svg: false, attrs: { id: 'Main' }, children: ['Hi'] }])
    expect(serializeCss(parsed.css)).toBe('.a{top:1px;}.b{top:2px;}.c{top:3px;}')
    expect(parsed.warnings).toEqual(['<title> is not supported and was removed.', 'Event handler attributes (on*) were removed.'])
  })

  it('drops scripts, embeds and form controls with a warning, and attributes that are not attributes', () => {
    const parsed = parseTemplate(
      '<script>alert(1)</script><iframe src="https://x.test"></iframe><form><input value="x"></form><button>b</button><link rel="stylesheet" href="https://x.test/a.css">' +
        '<p onclick="x()" children="c" tw="flex" srcset="a.png 2x" src="b.png" href="c">ok</p><a href="https://x.test/">link</a><video poster="p.png"></video>',
      '',
    )
    expect(parsed.children).toEqual([
      { tag: 'p', svg: false, attrs: {}, children: ['ok'] },
      { tag: 'a', svg: false, attrs: { href: 'https://x.test/' }, children: ['link'] },
    ])
    for (const tag of ['script', 'iframe', 'form', 'button', 'link', 'video']) expect(parsed.warnings).toContain(`<${tag}> is not supported and was removed.`)
    expect(parsed.warnings.join('\n')).toMatch(/srcset on <p>.*\n?.*/)
  })

  it('keeps attribute case inside inline <svg>, lower-cases HTML attributes, rejects <text>', () => {
    const parsed = parseTemplate('<DIV Class="A"><svg viewBox="0 0 10 10"><linearGradient gradientUnits="userSpaceOnUse" id="g"/><image href="https://x.test/a.png"/><foreignObject><p>x</p></foreignObject><rect fill="url(#g)"/></svg></DIV>', '')
    const svg = (parsed.children[0] as { children: unknown[] }).children[0]
    expect(parsed.children[0]).toMatchObject({ tag: 'div', attrs: { class: 'A' } })
    expect(svg).toEqual({
      tag: 'svg',
      svg: true,
      attrs: { viewBox: '0 0 10 10' },
      children: [
        { tag: 'linearGradient', svg: true, attrs: { gradientUnits: 'userSpaceOnUse', id: 'g' }, children: [] },
        { tag: 'rect', svg: true, attrs: { fill: 'url(#g)' }, children: [] },
      ],
    })
    expect(parsed.warnings).toEqual(['<image> inside inline <svg> is not supported and was removed.', '<foreignObject> inside inline <svg> is not supported and was removed.'])
    expect(codeOf(() => parseTemplate('<svg><text>hi</text></svg>', ''))).toBe('template_error')
  })

  it('lists placeholder keys from text and attributes, ignoring things that are not keys', () => {
    const parsed = parseTemplate('<p class="{{ kind }}">{{title}} {{title}} {{Not A Key}} {{ author_name }}</p><img src="{{avatar}}">', '.x::before{content:"{{css}}"}')
    expect(parsed.placeholders).toEqual(['kind', 'title', 'author_name', 'avatar'])
  })

  it('enforces source size, element count and depth', () => {
    const big = 'x'.repeat(LIMITS.maxHtmlBytes + 1)
    expect(codeOf(() => parseTemplate(big, ''))).toBe('payload_too_large')
    expect(codeOf(() => parseTemplate('', 'x'.repeat(LIMITS.maxCssBytes + 1)))).toBe('payload_too_large')
    // Bytes, not characters: 3 bytes per character.
    expect(codeOf(() => parseTemplate('€'.repeat(Math.floor(LIMITS.maxHtmlBytes / 3) + 1), ''))).toBe('payload_too_large')
    expect(codeOf(() => parseTemplate('x'.repeat(LIMITS.maxHtmlBytes), 'x'.repeat(LIMITS.maxCssBytes)))).toBe('no error')

    expect(codeOf(() => parseTemplate('<i></i>'.repeat(LIMITS.maxNodes), ''))).toBe('no error')
    expect(codeOf(() => parseTemplate('<i></i>'.repeat(LIMITS.maxNodes + 1), ''))).toBe('template_error')

    const nested = (depth: number) => `<html><body>${'<div>'.repeat(depth)}x${'</div>'.repeat(depth)}</body></html>`
    expect(codeOf(() => parseTemplate(nested(LIMITS.maxDepth), ''))).toBe('no error')
    expect(codeOf(() => parseTemplate(nested(LIMITS.maxDepth + 1), ''))).toBe('template_error')
    expect(codeOf(() => parseTemplate('<body>'.repeat(4000), ''))).toBe('template_error')
  })
})

describe('bindTemplate', () => {
  it('substitutes placeholders in text and attribute values without ever creating markup', () => {
    const parsed = parseTemplate('<h1 class="t {{kind}}" title="{{ title }}">{{title}} by {{author}}{{missing}}</h1>', '')
    const bound = bindTemplate(parsed, { title: '<script>alert(1)</script><img src=http://evil.test/x.png>', kind: 'big" onclick="x', author: 'A & B' }, OG)
    const h1 = (bound.html.children[0] as BoundElement).children[0] as BoundElement
    expect(h1.tag).toBe('h1')
    expect(h1.attrs).toEqual({ class: 't big" onclick="x', title: '<script>alert(1)</script><img src=http://evil.test/x.png>' })
    expect(h1.children).toEqual(['<script>alert(1)</script><img src=http://evil.test/x.png> by A & B'])
  })

  it('never reads placeholder values off the prototype chain', () => {
    const bound = bindTemplate(parseTemplate('<p>[{{constructor}}][{{to_string}}]</p>', ''), {}, OG)
    expect(((bound.html.children[0] as BoundElement).children[0] as BoundElement).children).toEqual(['[][]'])
  })

  it('adds state classes for size, theme and every placeholder key', () => {
    expect(stateClasses(['title', 'sub'], { title: 'x'.repeat(31), theme: 'dark-2' }, { width: 1080, height: 1350 })).toEqual([
      'size-portrait', 'theme-dark-2', 'has-title', 'len-title-m', 'no-sub', 'len-sub-s',
    ])
    expect(stateClasses(['t'], { t: 'x'.repeat(30), theme: 'Not Valid' }, OG)).toEqual(['size-og', 'has-t', 'len-t-s'])
    expect(stateClasses(['t'], { t: 'x'.repeat(60) }, { width: 1080, height: 1080 })).toEqual(['size-square', 'has-t', 'len-t-m'])
    expect(stateClasses(['t'], { t: 'x'.repeat(100) }, { width: 300, height: 200 })).toEqual(['has-t', 'len-t-l'])
    expect(stateClasses(['t'], { t: '😀'.repeat(101) }, OG).at(-1)).toBe('len-t-xl')
    expect(stateClasses(['t'], { t: '   ' }, OG)).toEqual(['size-og', 'no-t', 'len-t-s'])

    const bound = bindTemplate(parseTemplate('<body class="mine">{{title}}</body>', ''), { title: 'Hi' }, OG)
    expect((bound.html.children[0] as BoundElement).attrs.class).toBe('mine size-og has-title len-title-s')
  })

  it('removes an <img> whose src is empty after substitution', () => {
    const bound = bindTemplate(parseTemplate('<img src="{{avatar}}"><img src="{{logo}}"><img alt="no src">', ''), { logo: 'https://x.test/l.png' }, OG)
    expect((bound.html.children[0] as BoundElement).children).toEqual([{ tag: 'img', svg: false, attrs: { src: 'https://x.test/l.png' }, style: [], children: [] }])
  })

  it('counts rendered text against maxTextChars, ignoring indentation', () => {
    const text = (chars: number) => parseTemplate(`<p>\n      ${'word '.repeat(chars / 5)}\n   </p>\n\n<p>{{more}}</p>`, '')
    expect(codeOf(() => bindTemplate(text(LIMITS.maxTextChars), {}, OG))).toBe('no error')
    expect(codeOf(() => bindTemplate(text(LIMITS.maxTextChars), { more: 'xx' }, OG))).toBe('template_error')
  })

  it('removes non-style attributes that carry url(...) and SVG hrefs that leave the document', () => {
    const parsed = parseTemplate('<p alt="{{note}}" data-ok="1">x</p><svg><use href="{{icon}}"/><use href="#local"/><rect fill="url(https://x.test/p.png)"/></svg>', '')
    const bound = bindTemplate(parsed, { note: 'see url(https://x.test/a.png)', icon: 'https://x.test/sprite.svg#i' }, OG)
    const [p, svg] = (bound.html.children[0] as BoundElement).children as BoundElement[]
    expect(p!.attrs).toEqual({ 'data-ok': '1' })
    expect(svg!.children.map((child) => (child as BoundElement).attrs)).toEqual([{}, { href: '#local' }, {}])
    expect(bound.warnings).toHaveLength(3)
  })
})

describe('image URLs', () => {
  it('normalises data: URIs to base64 and refuses other types', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill=\'#f00\' width="1" height="1"/>é</svg>'
    const base64 = canonicalDataUri(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)!
    expect(base64.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(new TextDecoder().decode(Uint8Array.from(atob(base64.split(',')[1]!), (ch) => ch.charCodeAt(0)))).toBe(svg)
    expect(canonicalDataUri(base64)).toBe(base64)
    expect(canonicalDataUri('DATA:image/JPG;base64,/9j/\n4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ')
    expect(canonicalDataUri('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=')
    for (const bad of ['data:image/webp;base64,AAAA', 'data:text/html;base64,AAAA', 'data:image/png,rawbytes', 'data:image/png;base64,"); x', 'data:image/svg+xml;base64,@@@', 'data:,x', 'nope']) {
      expect(canonicalDataUri(bad), bad).toBeUndefined()
    }
  })

  it('accepts absolute http(s) URLs and data: images; #fragments only in CSS', () => {
    expect(classifyImageUrl(' HTTPS://Example.com/a b.png'.replace(' b', '%20b'), 'img')).toEqual({ kind: 'remote', url: 'https://example.com/a%20b.png' })
    expect(classifyImageUrl('http://example.com', 'css')).toEqual({ kind: 'remote', url: 'http://example.com/' })
    expect(classifyImageUrl('#blur', 'css')).toEqual({ kind: 'fragment', id: '#blur' })
    expect(classifyImageUrl('data:image/gif;base64,R0lGODlh', 'img')).toEqual({ kind: 'data', uri: 'data:image/gif;base64,R0lGODlh' })
  })

  it('refuses relative URLs, other schemes and malformed URLs', () => {
    const refused = ['/local.png', 'local.png', '../a.png', '//cdn.test/a.png', 'file:///etc/passwd', 'javascript:alert(1)', 'blob:https://x.test/1', 'ftp://x.test/a.png',
      'data:text/html,<script>1</script>', 'data:image/webp;base64,AAAA', 'https://', 'https://exa mple.com/a.png', 'https://x.test/a"b.png', '\\68ttps://x.test/a.png', 'var(--u)', '']
    for (const url of refused) expect(codeOf(() => classifyImageUrl(url, 'css')), url).toBe('template_error')
    expect(codeOf(() => classifyImageUrl('#blur', 'img'))).toBe('template_error')
  })
})

describe('buildDocument', () => {
  it('builds html > [style] + body > nodes, with the base stylesheet first', () => {
    const document = build('<html class="h"><body id="b"><p class="x">Hi</p></body></html>', '.x{color:red}')
    expect(document.type).toBe('html')
    expect(document.props.class).toBe('h')
    expect(kids(document).map((child) => (child as VNode).type)).toEqual(['style', 'body'])
    expect(bodyOf(document).props).toMatchObject({ id: 'b', class: 'size-og' })
    expect(kids(bodyOf(document))).toEqual([{ type: 'p', props: { class: 'x', children: 'Hi' } }])
    const base = serializeCss(mapCssDeclarations(parseCss(BASE_CSS), (d) => rewriteDeclaration(d, { ...passThrough, fontFamilies: marking.fontFamilies })))
    expect(sheetOf(document)).toBe(`${base}.x{color:red;}`)
    expect(BASE_CSS).toContain('*, *::before, *::after { box-sizing: border-box }')
  })

  it('turns style attributes into objects and resolves url() and font families inside them', () => {
    const document = build('<div style="color: {{c}}; background: url(https://x.test/a.png) center / cover; font-family: Georgia, serif !important; background-image: url({{none}}); --v: 1">x</div>', '', { c: 'red' })
    expect((kids(bodyOf(document))[0] as VNode).props.style).toEqual({
      color: 'red',
      background: 'url("data:image/png;base64,REMOTE") center / cover',
      'font-family': 'Georgia|serif',
      '--v': '1',
    })
  })

  it('resolves <img src>, stylesheet url() and font variables; local #references stay', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const document = build(
      `<img src="https://x.test/a.png"><img src="${png}">`,
      `:root{--f:Georgia,serif;--bg:url(https://x.test/b.png)} .a{font-family:var(--f);background:var(--bg);filter:url(#soft);mask:url('${png}')}`,
    )
    expect(kids(bodyOf(document)).map((img) => (img as VNode).props.src)).toEqual(['data:image/png;base64,REMOTE', png])
    expect(sheetOf(document)).toContain(`:root{--f:Georgia|serif;--bg:url("data:image/png;base64,REMOTE");}.a{font-family:var(--f);background:var(--bg);filter:url("#soft");mask:url("${png}");}`)
  })

  it('throws template_error for URLs it will not load, wherever they are', () => {
    for (const [html, css] of [
      ['<img src="/a.png">', ''],
      ['<img src="{{u}}">', ''],
      ['<p style="background:url(file:///etc/passwd)">x</p>', ''],
      ['<p>x</p>', 'p{background:url(javascript:alert(1))}'],
      ['<style>p{list-style-image:url(a.png)}</style>', ''],
      ['<p>x</p>', 'p::before{content:url()}'],
    ] as const) {
      expect(codeOf(() => build(html, css, { u: 'javascript:alert(1)' })), html + css).toBe('template_error')
    }
  })

  it('warns about a font shorthand it cannot expand', () => {
    const warnings: string[] = []
    buildDocument(bindTemplate(parseTemplate('<p>x</p>', 'p{font:var(--short)}'), {}, OG), marking, (message) => warnings.push(message))
    expect(warnings).toEqual(['A "font" shorthand that uses var() cannot be mapped to the bundled fonts; set font-family separately.'])
  })
})

describe('validateTemplate', () => {
  it('returns warnings for a valid template and renders nothing', () => {
    expect(validateTemplate('<h1>{{title}}</h1>', 'h1{color:red}')).toEqual({ warnings: [] })
    expect(validateTemplate('<script>x</script><h1 onclick="x()">t</h1>', '@import "a.css"; h1{font:var(--f)}').warnings).toEqual([
      '<script> is not supported and was removed.',
      'Event handler attributes (on*) were removed.',
      '@import is not supported and was ignored.',
      'A "font" shorthand that uses var() cannot be mapped to the bundled fonts; set font-family separately.',
    ])
  })

  it('checks literal URLs but not ones that depend on data', () => {
    expect(validateTemplate('<img src="{{avatar}}"><img src="{{cdn}}/a.png"><div style="background-image:url({{bg}})">x</div><svg><use href="{{icon}}"/></svg>', '')).toEqual({ warnings: [] })
    expect(codeOf(() => validateTemplate('<img src="/a.png">', ''))).toBe('template_error')
    expect(codeOf(() => validateTemplate('<p style="background:url(a.png)">x</p>', ''))).toBe('template_error')
    expect(codeOf(() => validateTemplate('<p>x</p>', 'p{background:url(//cdn.test/a.png)}'))).toBe('template_error')
    expect(codeOf(() => validateTemplate('<p>x</p>', 'p{background:url(https://cdn.test/a.png)}'))).toBe('no error')
  })

  it('throws the same errors as a render for sizes, structure and image count', () => {
    expect(codeOf(() => validateTemplate('x'.repeat(LIMITS.maxHtmlBytes + 1), ''))).toBe('payload_too_large')
    expect(codeOf(() => validateTemplate('', 'x'.repeat(LIMITS.maxCssBytes + 1)))).toBe('payload_too_large')
    expect(codeOf(() => validateTemplate('<i></i>'.repeat(LIMITS.maxNodes + 1), ''))).toBe('template_error')
    expect(codeOf(() => validateTemplate('<svg><text>x</text></svg>', ''))).toBe('template_error')
    expect(codeOf(() => validateTemplate(`<p>${'x'.repeat(LIMITS.maxTextChars + 1)}</p>`, ''))).toBe('template_error')
    const images = (count: number) => Array.from({ length: count }, (_, i) => `<img src="https://x.test/${i}.png">`).join('')
    expect(codeOf(() => validateTemplate(images(LIMITS.maxImagesPerRender) + images(LIMITS.maxImagesPerRender), ''))).toBe('no error')
    expect(codeOf(() => validateTemplate(images(LIMITS.maxImagesPerRender + 1), ''))).toBe('template_error')
    expect(codeOf(() => bindStaticTemplate(parseTemplate('<p>{{t}}</p>', '')))).toBe('no error')
  })
})

describe('svg-check.ts', () => {
  const blur = (std: number | string) => `<filter id="f${std}"><feGaussianBlur stdDeviation="${std}"/></filter>`
  const wrap = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`

  it('counts one effect per filter and per extra blur primitive, and finds the largest blur', () => {
    expect(measureSvgEffects(wrap('<rect/>'))).toEqual({ effects: 0, maxStdDeviation: 0 })
    expect(measureSvgEffects(wrap(blur(3) + blur('4 9.5')))).toEqual({ effects: 2, maxStdDeviation: 9.5 })
    expect(measureSvgEffects(wrap('<filter id="a"><feGaussianBlur stdDeviation="1"/><feGaussianBlur stdDeviation="2"/><feColorMatrix/></filter><filter id="b"><feColorMatrix/></filter>'))).toEqual({ effects: 3, maxStdDeviation: 2 })
  })

  it('looks inside SVG images embedded as data: URIs, base64 or URL-encoded', () => {
    const inner = wrap(`${blur(40)}<g style="filter: drop-shadow(0 0 30px red)"/>`)
    expect(measureSvgEffects(wrap(`<image href="data:image/svg+xml;base64,${btoa(inner)}"/>`))).toEqual({ effects: 2, maxStdDeviation: 40 })
    expect(measureSvgEffects(wrap(`<image href="data:image/svg+xml;utf8,${encodeURIComponent(inner)}"/>`))).toEqual({ effects: 2, maxStdDeviation: 40 })
    expect(measureSvgEffects(wrap(`<g filter="blur(7px)"/>`))).toEqual({ effects: 1, maxStdDeviation: 7 })
    expect(measureSvgEffects(wrap(`<g filter="drop-shadow(1px 2px 3 red)"/><g style="filter:blur(2em)"/>`))).toEqual({ effects: 2, maxStdDeviation: Infinity })
    expect(measureSvgEffects(wrap(`<g filter="drop-shadow(#123456 1px 2px 3)"/><g filter="drop-shadow(0 0 5px rgb(255, 0, 0))"/>`))).toEqual({ effects: 2, maxStdDeviation: 5 })
    let nested = wrap(blur(1))
    for (let i = 0; i < 4; i++) nested = wrap(`<image href="data:image/svg+xml;base64,${btoa(nested)}"/>`)
    expect(codeOf(() => measureSvgEffects(nested))).toBe('template_error')
  })

  it('enforces blur radius, effect count and SVG size', () => {
    const limits = { maxSvgBytes: 2000, maxBlurRadiusPx: 24, maxFilterEffects: 4 }
    expect(codeOf(() => assertSvgWithinLimits(wrap(blur(12).repeat(4)), limits))).toBe('no error')
    expect(codeOf(() => assertSvgWithinLimits(wrap(blur(12.5)), limits))).toBe('template_error')
    expect(codeOf(() => assertSvgWithinLimits(wrap(blur(1).repeat(5)), limits))).toBe('template_error')
    expect(codeOf(() => assertSvgWithinLimits(wrap('<rect/>'.repeat(300)), limits))).toBe('template_error')
    // Defaults come from LIMITS.
    expect(codeOf(() => assertSvgWithinLimits(wrap(blur(LIMITS.maxBlurRadiusPx / 2))))).toBe('no error')
    expect(codeOf(() => assertSvgWithinLimits(wrap(blur(LIMITS.maxBlurRadiusPx / 2 + 1))))).toBe('template_error')
  })

  it('removes clipped text runs and images that are entirely off the canvas, and nothing else', () => {
    const canvas = { width: 1200, height: 630 }
    const run = (d: string) => `<g mask="url(#satori_om-id-1)" clip-path="url(#satori_cp-id-1)"><path fill="#111827" d="${d}"/></g>`
    const image = (x: number, extra = ' clip-path="url(#c)"') => `<image x="${x}" y="10" width="20" height="20" href="data:image/png;base64,AAAA"${extra}/>`
    const visible = run('M10 10L20 20Q30 30 40 40Z ') + run('M-50 10L5 20Z ') + run('M1300 10L1100 20Z ')
    const kept =
      visible +
      // Not the plain shape of a text run: relative commands, a transform, an unclipped or transformed image.
      run('M3000 10l5 5z') +
      '<g mask="url(#m)" clip-path="url(#c)"><path fill="#000" transform="matrix(1,0,0,1,-2900,0)" d="M3000 10L3010 20Z"/></g>' +
      image(100) + image(3000, '') + image(3000, ' transform="matrix(1,0,0,1,-2900,0)" clip-path="url(#c)"')
    const dropped = run('M3000 10L3010 20Q3020 5 3030 1e1Z ') + run('M10 700L20 710Z ') + run('M-90 5L-80 9Z ') + image(3000) + image(-500, ' mask="url(#m)"') + '<g mask="url(#satori_mi-id-1)"><path fill="red" d="M5000 5L5010 9Z"/></g>'
    expect(dropOffCanvasContent(wrap(kept + dropped), canvas)).toBe(wrap(kept))
  })
})

describe('watermark.ts', () => {
  it('stamps the badge as the last child of the root, also when the card drew nothing', () => {
    expect(stampWatermark('<svg width="1"><rect/></svg>', '<image/>')).toBe('<svg width="1"><rect/><image/></svg>')
    expect(stampWatermark('<svg width="1" height="1"/>', '<image/>')).toBe('<svg width="1" height="1"><image/></svg>')
    expect(() => stampWatermark('<svg><rect/>', '<image/>')).toThrow()
  })

  it('renders the badge once per size and mode: a small image in the bottom-right corner', async () => {
    const free = await watermarkMarkup(1200, 630, 'free')
    expect(watermarkMarkup(1200, 630, 'free')).toBe(watermarkMarkup(1200, 630, 'free'))
    const attribute = (markup: string, name: string) => Number(new RegExp(` ${name}="([\\d.]+)"`).exec(markup)![1])
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => attribute(free, name)) as [number, number, number, number]
    expect(height).toBe(28)
    expect(width).toBeGreaterThan(110)
    expect(width).toBeLessThan(160)
    expect([x + width, y + height]).toEqual([1200 - 16, 630 - 16])
    expect(free).toMatch(/^<image [^>]*href="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\/>$/)

    const preview = await watermarkMarkup(1200, 630, 'preview')
    expect(attribute(preview, 'width')).toBeGreaterThan(width + 40)
    // Scales with the width of the card.
    expect(attribute(await watermarkMarkup(1080, 1350, 'free'), 'height')).toBe(25)

    // The badge is a dark pill with light text, drawn as paths (no fonts needed by resvg).
    const badge = atob(free.split('base64,')[1]!.replace('"/>', ''))
    expect(badge).toContain('<path')
    expect(badge).not.toContain('<text')
    const raster = await rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${free}</svg>`, 1200)
    const at = (px: number, py: number) => [...raster.pixels.subarray((py * 1200 + px) * 4, (py * 1200 + px) * 4 + 3)]
    expect(Math.max(...at(x + 6, y + 14))).toBeLessThan(90)
    expect(at(x - 4, y + 14)).toEqual([255, 255, 255])
  })
})
