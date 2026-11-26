// The five PDF starter templates (src/pdf/templates): the data keys the engine, the site and the
// free tools all rely on (copied from the feature contract), what the markup and CSS may contain,
// the page setup, the samples, and what buildPdfDocument makes of them. How they look in print
// is checked by rendering them in Chrome, which this pool cannot do.
import { isTag, isText, type AnyNode, type Element } from 'domhandler'
import { findAll, textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'
import { describe, expect, it } from 'vitest'
import { LIMITS, PDF } from '../src/config'
import { qrSvgDataUri } from '../src/lib/qr'
import { buildPdfDocument, validatePdfData } from '../src/pdf/template'
import { PDF_TEMPLATES, PDF_TEMPLATE_IDS, getPdfTemplate, type PdfData, type PdfItem, type PdfStarterTemplate } from '../src/pdf/templates'
import { cssDeclarations, parseCss, parseFontFamilyList, stripCssComments, type CssNode } from '../src/render/css'
import { BUILTIN_FONT_FAMILIES } from '../src/render/fonts'

/** Verbatim from the contract ("Data keys of the five starter templates"); * marks a required key. */
const CONTRACT_KEYS: Record<PdfStarterTemplate['id'], string> = {
  invoice:
    'seller_name*, seller_address, seller_email, seller_tax_id, logo_url, buyer_name*, buyer_address, buyer_email, invoice_number*, issue_date*, due_date, currency, items* [description, quantity, unit_price, amount], subtotal, tax_label, tax, total*, payment_terms, notes',
  receipt:
    'seller_name*, seller_address, seller_email, logo_url, receipt_number*, date*, buyer_name, payment_method, currency, items* [description, quantity, amount], subtotal, tax_label, tax, total*, notes',
  quote:
    'seller_name*, seller_address, seller_email, logo_url, buyer_name*, buyer_address, quote_number*, issue_date*, valid_until, currency, items* [description, quantity, unit_price, amount], subtotal, tax_label, tax, total*, terms, notes',
  certificate: 'title*, recipient_name*, achievement*, issuer_name*, date*, signer_name, signer_title, certificate_id, logo_url, verify_url, verify_qr',
  report: 'title*, subtitle, author, date, summary, items [heading, body], footer_note',
}

/**
 * Keys Link To Card fills in itself for bulk documents with "verify": true (src/batch/certificates.ts).
 * A customer never types them, so the samples leave them out.
 */
const VERIFICATION_KEYS: readonly string[] = ['verify_url', 'verify_qr']
/** The only placeholders allowed in an attribute: an image's src. */
const IMAGE_SOURCES = [
  { tag: 'img', name: 'src', value: '{{logo_url}}' },
  { tag: 'img', name: 'src', value: '{{verify_qr}}' },
]

interface ContractField {
  key: string
  required: boolean
  kind: 'text' | 'items'
  itemFields?: string[]
}

function contractFields(spec: string): ContractField[] {
  return [...spec.matchAll(/([a-z_]+)(\*)?(?: \[([^\]]+)\])?/g)].map(([, key, star, items]) => ({
    key: key!,
    required: star === '*',
    kind: items ? 'items' : 'text',
    ...(items ? { itemFields: items.split(', ') } : {}),
  }))
}

/** Words for documents we never ship a template or wording for (bank statements, IDs, ...). */
const FORBIDDEN_WORDS = [
  'bank statement', 'utility bill', 'passport', 'driver', 'diploma', 'government', 'id card', 'identity card', 'identity document',
  'national id', 'social security', 'birth certificate', 'residence permit', 'visa', 'transcript', 'university', 'notary', 'notarised', 'notarized',
]
/** The certificate is a modern completion certificate: nothing that imitates an official mark. */
const OFFICIAL_MARKS = ['seal', 'crest', 'emblem', 'coat of arms', 'ribbon', 'rosette', 'stamp', 'guilloche', 'watermark']

const BUNDLED_FAMILIES = Object.keys(BUILTIN_FONT_FAMILIES)
const GENERIC_FAMILIES = ['serif', 'sans-serif', 'monospace']
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g
const MARKER = /\{\{\s*[#^/]\s*[a-z][a-z0-9_]{0,31}\s*\}\}/g
const TABLE_TEMPLATES = ['invoice', 'receipt', 'quote'] as const
const EMPTY_ROW: Record<(typeof TABLE_TEMPLATES)[number], string> = { invoice: 'No line items.', receipt: 'No items.', quote: 'No line items.' }

const textFields = (template: PdfStarterTemplate) => template.fields.filter((field) => field.kind === 'text')
const hasList = (template: PdfStarterTemplate): boolean => template.fields.some((field) => field.kind === 'items')
const itemFieldsOf = (template: PdfStarterTemplate): readonly string[] => template.fields.find((field) => field.kind === 'items')?.itemFields ?? []
const sampleItems = (template: PdfStarterTemplate): PdfItem[] => (template.sample.items ?? []) as PdfItem[]
const flatSampleValues = (template: PdfStarterTemplate): Array<[string, string]> =>
  Object.entries(template.sample).filter((entry): entry is [string, string] => typeof entry[1] === 'string')

function elements(nodes: AnyNode[]): Element[] {
  return findAll(() => true, nodes)
}

/** The template's own html, parsed as the engine parses it (markers stay in the text). */
function parseHtml(html: string): AnyNode[] {
  return parseDocument(html, { lowerCaseAttributeNames: false }).children
}

/** Style rules with their selector and own declarations, at any nesting depth. */
function* styleRules(nodes: readonly CssNode[]): Generator<{ selector: string; declarations: Map<string, string> }> {
  for (const node of nodes) {
    if (node.kind !== 'rule') continue
    const declarations = new Map<string, string>()
    for (const child of node.children) if (child.kind === 'declaration') declarations.set(child.name, child.value)
    yield { selector: node.prelude.trim(), declarations }
    yield* styleRules(node.children)
  }
}

/** Text as the HTML serialiser writes it. */
const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function requiredOnly(template: PdfStarterTemplate): PdfData {
  const data: PdfData = {}
  for (const field of template.fields) if (field.required) data[field.key] = template.sample[field.key]!
  return data
}

function build(template: PdfStarterTemplate, data: PdfData): string {
  return buildPdfDocument({ html: template.html, css: template.css, data })
}

describe('PDF starter templates: the catalogue', () => {
  it('has exactly the five templates, in the contract order', () => {
    expect(PDF_TEMPLATE_IDS).toEqual(['invoice', 'receipt', 'quote', 'certificate', 'report'])
    expect(PDF_TEMPLATES.map((template) => template.id)).toEqual(PDF_TEMPLATE_IDS)
  })

  it('finds each template by its id and nothing else', () => {
    for (const template of PDF_TEMPLATES) expect(getPdfTemplate(template.id)).toBe(template)
    for (const id of ['', 'Invoice', 'invoice ', 'blog', 'constructor', '__proto__', 'toString', 'bank-statement']) {
      expect(getPdfTemplate(id)).toBeUndefined()
    }
  })

  it('names and describes each template in one plain sentence', () => {
    expect(new Set(PDF_TEMPLATES.map((template) => template.name)).size).toBe(PDF_TEMPLATES.length)
    for (const template of PDF_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(2)
      expect(template.description).toMatch(/^[A-Z][^.]*[^.\s]\.$/)
      expect(template.description.length).toBeLessThanOrEqual(140)
    }
  })
})

describe.each(PDF_TEMPLATES.map((template) => [template.id, template] as const))('PDF starter template %s', (id, template) => {
  const nodes = parseHtml(template.html)
  const sheet = parseCss(template.css)

  describe('data keys', () => {
    it('are exactly the contract keys, in order, with the required flags', () => {
      const fields = template.fields.map(({ key, required, kind, itemFields }) => ({ key, required, kind, ...(itemFields ? { itemFields: [...itemFields] } : {}) }))
      expect(fields).toEqual(contractFields(CONTRACT_KEYS[id]))
      for (const field of template.fields) expect(field.label.trim()).not.toBe('')
    })

    it('all appear in the html: flat keys as {{key}}, the list as an {{#items}} section with every item field inside', () => {
      for (const field of textFields(template)) expect(template.html).toContain(`{{${field.key}}}`)
      const list = template.fields.find((field) => field.kind === 'items')
      if (!list) {
        expect(template.html).not.toMatch(/\{\{\s*[#^/]/)
        return
      }
      const open = template.html.indexOf(`{{#${list.key}}}`)
      const close = template.html.indexOf(`{{/${list.key}}}`, open)
      expect(open).toBeGreaterThanOrEqual(0)
      expect(close).toBeGreaterThan(open)
      const section = template.html.slice(open, close)
      for (const field of itemFieldsOf(template)) expect(section).toContain(`{{${field}}}`)
    })

    it('are the only placeholders the html uses', () => {
      const known = new Set([...template.fields.map((field) => field.key), ...itemFieldsOf(template)])
      const used = [...template.html.replace(MARKER, '').matchAll(PLACEHOLDER)].map((match) => match[1]!)
      expect(used.filter((key) => !known.has(key))).toEqual([])
      expect(template.html.replace(MARKER, '').replace(PLACEHOLDER, '')).not.toMatch(/\{\{|\}\}/)
    })

    it('each fill a whole element, so a missing value leaves an :empty element that the CSS hides', () => {
      // The CSS drops optional rows and labels with :empty / :has(... :empty), which only works when
      // the placeholder is the element's only content. The only attribute placeholders are image
      // sources: the logo, and the certificate's verification QR code.
      for (const element of elements(nodes)) {
        for (const [name, value] of Object.entries(element.attribs)) {
          if (!value.includes('{{')) continue
          expect(IMAGE_SOURCES).toContainEqual({ tag: element.name, name, value })
        }
        for (const child of element.children) {
          // Section markers ({{#items}} ...) may share text with white space; placeholders may not.
          if (!isText(child) || !/\{\{\s*[a-z]/.test(child.data)) continue
          expect(child.data, `<${element.name} class="${element.attribs.class}">`).toMatch(/^\{\{[a-z_]+\}\}$/)
          expect(element.children).toHaveLength(1)
        }
      }
    })
  })

  describe('markup', () => {
    it('has no script, no event handlers and no embedded content', () => {
      const names = elements(nodes).map((element) => element.name.toLowerCase())
      for (const banned of ['script', 'noscript', 'iframe', 'frame', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'style', 'form', 'svg', 'template']) {
        expect(names).not.toContain(banned)
      }
      for (const element of elements(nodes)) {
        for (const name of Object.keys(element.attribs)) expect(name.toLowerCase()).not.toMatch(/^on/)
        expect(element.attribs.style).toBeUndefined()
      }
      expect(template.html).not.toMatch(/javascript:|vbscript:|<!--/i)
    })

    it('loads nothing by itself: the only URLs are the {{logo_url}} and {{verify_qr}} of an <img>', () => {
      for (const element of elements(nodes)) {
        for (const name of ['src', 'href', 'xlink:href', 'srcset', 'poster', 'background', 'action', 'data']) {
          if (name in element.attribs) expect(IMAGE_SOURCES).toContainEqual({ tag: element.name, name, value: element.attribs[name] })
        }
      }
      const images = template.fields.filter((field) => field.key === 'logo_url' || field.key === 'verify_qr').length
      expect(findAll((element) => element.name === 'img', nodes)).toHaveLength(images)
      for (const source of [template.html, template.css]) {
        expect(source).not.toMatch(/https?:|\/\/[a-z0-9]/i)
      }
      expect(template.css).not.toMatch(/url\(|@import|@font-face|image-set\(|expression\(/i)
    })

    it('has no wording for documents we do not ship', () => {
      const text = [template.id, template.name, template.description, template.html, template.css, JSON.stringify(template.sample)].join('\n').toLowerCase()
      for (const word of FORBIDDEN_WORDS) expect(text, word).not.toMatch(new RegExp(`\\b${word}`))
    })
  })

  describe('CSS', () => {
    it('opens with the --accent custom property on :root', () => {
      const first = sheet[0]
      expect(first?.kind === 'rule' && first.prelude.trim()).toBe(':root')
      const declarations = first?.kind === 'rule' ? first.children.filter((child) => child.kind === 'declaration') : []
      expect(declarations[0]).toMatchObject({ name: '--accent' })
      expect(stripCssComments(template.css).trimStart().startsWith(':root {\n  --accent:')).toBe(true)
    })

    it('names only the bundled fonts, and every font stack ends in a generic family', () => {
      const families = [...cssDeclarations(sheet)].filter((declaration) => declaration.name === 'font-family')
      expect(families.length).toBeGreaterThan(0)
      expect(template.css).not.toMatch(/(^|[\s;{])font\s*:/)
      for (const { value } of families) {
        const list = parseFontFamilyList(value)!.map((item) => (item.kind === 'name' ? item.name : item.text))
        expect(GENERIC_FAMILIES, value).toContain(list.at(-1))
        for (const name of list.slice(0, -1)) expect(BUNDLED_FAMILIES, value).toContain(name)
        // Quoted names exactly as the engine embeds them.
        expect(value, value).toMatch(/^'(Inter|Source Serif 4|JetBrains Mono)', (sans-serif|serif|monospace)$/)
      }
    })

    it('uses only weights and styles the bundled fonts ship, so Chrome never fakes bold or italic', () => {
      const shipped = new Set(Object.values(BUILTIN_FONT_FAMILIES).flatMap((variants) => variants.map((variant) => variant.weight)))
      for (const { name, value } of cssDeclarations(sheet)) if (name === 'font-weight') expect(shipped, value).toContain(Number(value))
      // Where a rule names a family, its weight and style must exist in that family.
      for (const { selector, declarations } of styleRules(sheet)) {
        const family = declarations.get('font-family')
        if (!family) continue
        const name = parseFontFamilyList(family)![0]!
        const variants = BUILTIN_FONT_FAMILIES[(name.kind === 'name' ? name.name : '') as keyof typeof BUILTIN_FONT_FAMILIES]
        const weight = Number(declarations.get('font-weight') ?? 400)
        const style = declarations.get('font-style') ?? 'normal'
        if (declarations.has('font-weight') || declarations.has('font-style')) {
          expect(variants, selector).toContainEqual({ weight, style })
        }
      }
    })

    it('leaves the page size to the page setup', () => {
      expect(template.css).not.toMatch(/@page/i)
    })
  })

  describe('page setup', () => {
    it(id === 'certificate' ? 'is A4 landscape' : 'is A4 portrait', () => {
      expect(template.defaultPdf.format).toBe('a4')
      expect(PDF.formats).toContain(template.defaultPdf.format)
      expect(template.defaultPdf.landscape).toBe(id === 'certificate')
    })

    it('has margins in millimetres within the margin limit', () => {
      const { margin } = template.defaultPdf
      expect(Object.keys(margin).sort()).toEqual(['bottom', 'left', 'right', 'top'])
      for (const value of Object.values(margin)) {
        expect(value).toMatch(/^\d+(\.\d+)?mm$/)
        expect(Number.parseFloat(value)).toBeLessThanOrEqual(PDF.maxMarginMm)
      }
    })
  })

  describe('sample', () => {
    it('fills every key a customer fills in, and only the template keys', () => {
      const customerKeys = template.fields.map((field) => field.key).filter((key) => !VERIFICATION_KEYS.includes(key))
      expect(Object.keys(template.sample).sort()).toEqual(customerKeys.sort())
      for (const field of textFields(template)) {
        if (VERIFICATION_KEYS.includes(field.key)) continue
        expect(typeof template.sample[field.key], field.key).toBe('string')
        expect(String(template.sample[field.key]).trim(), field.key).not.toBe('')
      }
    })

    it(hasList(template) ? 'has 3 to 5 items, each with every item field filled' : 'has no list, as the contract gives this template none', () => {
      const items = sampleItems(template)
      if (!hasList(template)) {
        expect(template.sample.items).toBeUndefined()
        return
      }
      expect(items.length).toBeGreaterThanOrEqual(3)
      expect(items.length).toBeLessThanOrEqual(5)
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual([...itemFieldsOf(template)].sort())
        for (const value of Object.values(item)) expect(String(value).trim()).not.toBe('')
      }
    })

    it('stays within the PDF data limits', () => {
      expect(validatePdfData(template.sample)).toEqual(template.sample)
      const entries = Object.entries(template.sample)
      expect(entries.length).toBeLessThanOrEqual(PDF.maxDataKeys)
      for (const [key, value] of entries) {
        expect(key).toMatch(LIMITS.dataKeyPattern)
        if (typeof value === 'string') expect(value.length, key).toBeLessThanOrEqual(PDF.maxDataValueChars)
      }
      const items = sampleItems(template)
      expect(items.length).toBeLessThanOrEqual(PDF.maxItems)
      for (const item of items) {
        expect(Object.keys(item).length).toBeLessThanOrEqual(PDF.maxItemFields)
        for (const value of Object.values(item)) expect(String(value).length).toBeLessThanOrEqual(PDF.maxItemValueChars)
      }
    })

    it('uses fictional contacts and a logo that needs no network', () => {
      for (const [key, value] of flatSampleValues(template)) {
        for (const email of value.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) expect(email, key).toMatch(/\.example$/)
        if (key !== 'logo_url') expect(value, key).not.toMatch(/https?:|www\./i)
      }
      if (!('logo_url' in template.sample)) return
      const logo = String(template.sample.logo_url)
      expect(logo).toMatch(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/)
      const svg = atob(logo.slice(logo.indexOf(',') + 1))
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. ]+">.*<\/svg>$/)
      // Only the SVG namespace may look like a URL; no scripts, handlers, links or text.
      expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|href|<script|<text|<image|\son[a-z]+=/i)
    })
  })

  if (id === 'certificate') {
    it('is issued by the customer, with no official-looking marks', () => {
      expect(template.html).toMatch(/Issued by<\/span>\s*<span class="issuer-name">\{\{issuer_name\}\}<\/span>/)
      const text = `${template.html}\n${template.css}`.toLowerCase()
      for (const word of OFFICIAL_MARKS) expect(text, word).not.toContain(word)
    })

    it('prints the verification link and QR code in a corner when given, and nothing of them when not', () => {
      const qr = qrSvgDataUri('https://linktocard.com/v/crt_8w3k5q0m2r7t9v4x6z1b')
      const verified = parseDocument(build(template, { ...template.sample, verify_url: 'https://linktocard.com/v/crt_8w3k5q0m2r7t9v4x6z1b', verify_qr: qr }))
      const images = findAll((element) => element.name === 'img', verified.children)
      expect(images.map((element) => element.attribs.class)).toEqual(['logo', 'verify-qr'])
      expect(images[1]!.attribs.src).toBe(qr)
      const url = findAll((element) => element.attribs.class === 'verify-url mono', verified.children)
      expect(url.map((element) => textContent(element))).toEqual(['https://linktocard.com/v/crt_8w3k5q0m2r7t9v4x6z1b'])

      const plain = build(template, template.sample)
      expect(plain).not.toContain('verify-qr"')
      expect(findAll((element) => element.attribs.class === 'verify-url mono', parseDocument(plain).children).map((element) => textContent(element))).toEqual([''])
      // Out of the flow: with or without it, nothing else on the page moves.
      expect(template.css).toMatch(/\.verify \{ position: absolute;/)
      expect(template.css).toMatch(/\.body \{ position: relative;/)
      expect(template.css).toMatch(/\.verify-text:has\(> \.verify-url:empty\) \{ display: none; \}/)
    })

    it('scales down on A5, where the 32pt title broke inside its words ("Certifica / te of")', () => {
      // When Chrome prints, the media width is the page area: A5 landscape is 210 mm, A4 and Letter
      // landscape are wider than 230 mm and keep the full-size design.
      const small = /@media \(max-width: 230mm\) \{([\s\S]*?)\n\}/.exec(template.css)?.[1] ?? ''
      expect(small).toMatch(/\.title \{ font-size: 22pt; \}/)
      expect(small).toMatch(/\.recipient \{ font-size: 30pt;/)
      expect(template.css).toMatch(/\.title \{[^}]*font-size: 32pt;/)
    })
  }

  if ((TABLE_TEMPLATES as readonly string[]).includes(id)) {
    it('prints tables cleanly: the header repeats, rows never split, money is in tabular figures and right-aligned', () => {
      const css = template.css
      expect(css).toMatch(/\.items thead \{ display: table-header-group; \}/)
      expect(css).toMatch(/\.items tr \{ break-inside: avoid; \}/)
      expect(css).toMatch(/\.items \.num \{[^}]*text-align: right;[^}]*font-variant-numeric: tabular-nums;/)
      expect(css).toMatch(/\.totals \.value \{[^}]*font-variant-numeric: tabular-nums;/)
      // Not on the whole table: Inter's tabular forms also widen the hyphens of descriptions
      // ("print - ready" in a real print).
      expect(css).not.toMatch(/\.items \{[^}]*tabular-nums/)
      // Totals are shown once (not repeated per page as a footer group) and are never split.
      expect(css).toMatch(/\.items tfoot \{ display: table-row-group; \}/)
      expect(css).toMatch(/\.totals \{ display: inline-block;/)
      for (const cell of findAll((element) => element.name === 'th' || element.name === 'td', nodes)) {
        if (/\{\{(quantity|unit_price|amount)\}\}/.test(textContent(cell)) || /^(Qty|Unit price|Amount)/.test(textContent(cell))) {
          expect(cell.attribs.class, textContent(cell)).toBe('num')
        }
      }
    })
  }
})

/**
 * The document with the "}}" that closes a nested CSS block (an @media rule ends with its last
 * rule's "}" and its own) taken out of the stylesheet, so that only placeholders match /}}/.
 */
function withoutNestedCss(document: string): string {
  return document.replace(/<style>[\s\S]*?<\/style>/, (style) => style.replace(/;\}\}/g, ';}'))
}

describe('PDF starter templates built by the engine', () => {
  describe.each(PDF_TEMPLATES.map((template) => [template.id, template] as const))('%s', (id, template) => {
    it('fills in every sample value and leaves no placeholder or marker', () => {
      const document = build(template, template.sample)
      expect(document.startsWith('<!doctype html><html><head><meta charset="utf-8"><style>')).toBe(true)
      expect(withoutNestedCss(document)).not.toMatch(/\{\{|\}\}/)
      const parsed = parseDocument(document)
      const text = textContent(parsed.children)
      for (const [key, value] of flatSampleValues(template)) {
        if (key === 'logo_url') {
          const image = findAll((element) => element.name === 'img', parsed.children)
          expect(image.map((element) => element.attribs.src)).toEqual([value])
          expect(document).toContain(`src="${value}"`)
          continue
        }
        expect(text, key).toContain(value)
        expect(document, key).toContain(escapeText(value))
      }
      for (const item of sampleItems(template)) for (const value of Object.values(item)) expect(document).toContain(escapeText(String(value)))
    })

    it.skipIf(!hasList(template))('repeats the list section once per item, in order', () => {
      const document = parseDocument(build(template, template.sample))
      // The element that holds the {{#items}} section: the table body, or the report's sections.
      const container = findAll((element) => element.name === 'tbody' || element.attribs.class === 'sections', document.children)
      expect(container).toHaveLength(1)
      // One row (or section) per item; its cells (or heading and body) hold the item fields in order.
      const entries = container[0]!.children.filter(isTag).map((entry) => entry.children.filter(isTag).map((cell) => textContent(cell)))
      const fields = itemFieldsOf(template)
      expect(entries).toEqual(sampleItems(template).map((item) => fields.map((field) => String(item[field]))))
    })

    it('builds with only the required keys, leaving the optional ones out without a trace', () => {
      const document = build(template, requiredOnly(template))
      expect(withoutNestedCss(document)).not.toMatch(/\{\{|\}\}|undefined|null|NaN/)
      for (const field of textFields(template)) {
        if (field.required) continue
        expect(document, field.key).not.toContain(escapeText(String(template.sample[field.key])))
      }
      if (template.fields.some((field) => field.key === 'logo_url')) expect(document).not.toContain('<img')
    })

    it('turns markup in values into text', () => {
      const hostile = '<b onclick="x()">bold</b><script>alert(1)</script>'
      const data: PdfData = {}
      for (const field of textFields(template)) if (field.key !== 'logo_url' && field.key !== 'verify_qr') data[field.key] = hostile
      data.items = [Object.fromEntries(itemFieldsOf(template).map((field) => [field, hostile]))]
      const document = build(template, data)
      const parsed = parseDocument(document)
      expect(findAll((element) => ['b', 'script'].includes(element.name), parsed.children)).toEqual([])
      expect(document).toContain(escapeText(hostile))
    })

    if ((TABLE_TEMPLATES as readonly string[]).includes(id)) {
      const tableId = id as (typeof TABLE_TEMPLATES)[number]

      it('repeats one table row per item (60 items) and shows the empty row only without items', () => {
        const base = sampleItems(template)
        const items = Array.from({ length: 60 }, (_, index) => ({ ...base[index % base.length]!, description: `Line ${index + 1}` }))
        const document = build(template, { ...template.sample, items })
        const body = findAll((element) => element.name === 'tbody', parseDocument(document).children)
        expect(body).toHaveLength(1)
        const rows = body[0]!.children.filter(isTag)
        expect(rows.map((row) => textContent(row.children[0]!))).toEqual(items.map((item) => item.description))
        expect(document).not.toContain(EMPTY_ROW[tableId])

        const empty = build(template, { ...template.sample, items: [] })
        expect(empty).toContain(EMPTY_ROW[tableId])
        expect(empty).not.toContain(escapeText(String(base[0]!.description)))
        expect(build(template, requiredOnly({ ...template, sample: { ...template.sample, items: [] } }))).toContain(EMPTY_ROW[tableId])
      })
    }

    if (id === 'report') {
      it('numbers one section per item (12 sections) and builds without any section', () => {
        const items = Array.from({ length: 12 }, (_, index) => ({ heading: `Part ${index + 1}`, body: `Body ${index + 1}\n\nSecond paragraph.` }))
        const document = build(template, { ...template.sample, items })
        const sections = findAll((element) => element.attribs.class === 'section', parseDocument(document).children)
        expect(sections.map((section) => textContent(section).trim().split('\n')[0])).toEqual(items.map((item) => item.heading))
        expect(template.css).toMatch(/counter-increment: section/)
        expect(build(template, { title: 'Only a title' })).not.toContain('class="section"')
      })

      it('lets an item without a heading continue the section above (item fields have a length limit)', () => {
        const long = 'x'.repeat(PDF.maxItemValueChars)
        const document = build(template, { title: 'Long section', items: [{ heading: 'One', body: long }, { heading: '', body: long }] })
        const sections = findAll((element) => element.attribs.class === 'section', parseDocument(document).children)
        // The second section's heading is an empty element, which the CSS below turns into a continuation.
        expect(sections.map((section) => section.children.filter(isTag).map((child) => [child.attribs.class, textContent(child).length]))).toEqual([
          [['heading', 3], ['body', long.length]],
          [['heading', 0], ['body', long.length]],
        ])
        expect(template.css).toContain('.section:has(> .heading:empty) { padding-top: 0; border-top: 0; counter-increment: none; }')
        expect(template.css).toContain('.section:has(> .heading:empty)::before { content: none; }')
      })
    }
  })
})
