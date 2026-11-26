// The five starter templates (src/render/templates), rendered inside workerd with the real
// renderer: every size, sparse and overfull data, and the promises the docs make about them.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { LIMITS, SIZES, type SizeId } from '../src/config'
import { renderCard, validateTemplate, warmUp } from '../src/render'
import { parseTemplate } from '../src/render/template'
import { STARTER_TEMPLATES, STARTER_TEMPLATE_IDS, getStarterTemplate, type StarterTemplate } from '../src/render/templates'
import type { RenderDeps, RenderOutput, TemplateData } from '../src/types'
import samplesWorker from '../scripts/samples-worker.mjs'
import { decodePng, diffPixels, pngSize, redImages } from './helpers'

// The social starters are laid out for these presets. The email preset (1200x400, decision D7) is
// for the email starters (tests/email-templates.test.ts); these five are not laid out for it, and
// the test below fails when a new preset appears that is in neither list.
const SIZE_IDS: SizeId[] = ['og', 'square', 'portrait']
const EMAIL_ONLY_SIZE_IDS: SizeId[] = ['email']
const DATA_FIELDS = ['title', 'description', 'author', 'image', 'theme', 'site', 'tag']
const IMAGE_URL = 'https://cdn.example.com/avatar.png'

const WORDS =
  'How we moved forty thousand Open Graph images from a headless browser fleet to plain HTML and CSS templates without breaking one single link in production'

/** A title of exactly `length` characters that ends in `lastWord`. */
function titleOf(length: number, lastWord = 'today'): string {
  const head = WORDS.slice(0, length - lastWord.length - 1).trimEnd()
  return `${head.padEnd(length - lastWord.length - 1, 's')} ${lastWord}`
}

const LONG_DESCRIPTION =
  'A field report with every number we measured along the way: cold starts, cache hit rates, the cost per thousand images, and the three template mistakes that made our first week harder than it had to be.'
    .padEnd(200, '.')
    .slice(0, 200)

/** Every field filled with more text than a sensible card has. */
const crowded = (title: string): TemplateData => ({
  title,
  description: LONG_DESCRIPTION,
  author: 'Alexandra Konstantinopoulou-Whitfield',
  site: 'engineering.longcompanyname.example',
  tag: 'Infrastructure field notes',
  image: IMAGE_URL,
})

let imageDataUri: string
let fetchSpy: MockInstance<typeof fetch>
let fetchImage: Mock<RenderDeps['fetchImage']>

interface RenderOptions {
  size?: SizeId
  extraCss?: string
}

function render(template: StarterTemplate, data: TemplateData, { size = 'og', extraCss = '' }: RenderOptions = {}): Promise<RenderOutput> {
  const { width, height } = SIZES[size]
  const deps: RenderDeps = { fetchImage: (url) => fetchImage(url) }
  return renderCard({ html: template.html, css: template.css + extraCss, data, width, height, format: 'png', watermark: 'none' }, deps)
}

/** A clean render: a PNG of the requested size, and nothing for the customer to fix. */
function expectCleanPng(output: RenderOutput, size: SizeId): void {
  expect(output.contentType).toBe('image/png')
  expect(pngSize(output.bytes)).toEqual({ width: SIZES[size].width, height: SIZES[size].height })
  expect(output.warnings).toEqual([])
}

/** The PNG writer is deterministic, so equal pixels are equal bytes; decoding is the slow path. */
function sameBytes(a: RenderOutput, b: RenderOutput): boolean {
  return a.bytes.length === b.bytes.length && a.bytes.every((byte, index) => byte === b.bytes[index])
}

async function changedPixels(a: RenderOutput, b: RenderOutput): Promise<number> {
  return sameBytes(a, b) ? 0 : diffPixels(await decodePng(a.bytes), await decodePng(b.bytes))
}

beforeAll(async () => {
  await warmUp()
  imageDataUri = (await redImages(64)).png
})

// Starter templates must never reach the network by themselves.
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    throw new Error(`a starter template made the renderer call fetch(${String(request)})`)
  })
  fetchImage = vi.fn(async () => ({ dataUri: imageDataUri }))
})
afterEach(() => {
  expect(fetchSpy.mock.calls).toEqual([])
  vi.restoreAllMocks()
})

describe('the starter template catalogue', () => {
  it('lists the five templates in gallery order and finds them by id', () => {
    expect(STARTER_TEMPLATE_IDS).toEqual(['blog', 'dark', 'quote', 'launch', 'docs'])
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual(STARTER_TEMPLATE_IDS)
    for (const template of STARTER_TEMPLATES) expect(getStarterTemplate(template.id)).toBe(template)
    expect(getStarterTemplate('nope')).toBeUndefined()
    expect(getStarterTemplate('toString')).toBeUndefined()
  })

  it('is tested at every size preset except the email-only ones', () => {
    expect(Object.keys(SIZES)).toEqual([...SIZE_IDS, ...EMAIL_ONLY_SIZE_IDS])
  })

  it.each(STARTER_TEMPLATES)('$id: the documented fields are exactly the placeholders of its HTML', (template) => {
    const { placeholders } = parseTemplate(template.html, template.css)
    const fields = template.fields.map((field) => field.name)
    // theme is the one field that is not a placeholder: it only switches the theme-<value> class.
    expect(fields.filter((name) => name !== 'theme').sort()).toEqual([...placeholders].sort())
    expect(fields.includes('theme')).toBe(template.css.includes('.theme-dark'))
    expect(new Set(fields).size).toBe(fields.length)
    for (const name of fields) expect(DATA_FIELDS).toContain(name)
    expect(template.fields.filter((field) => field.required).map((field) => field.name)).toEqual(['title'])
    for (const field of template.fields) {
      expect(field.description.length).toBeGreaterThan(10)
      expect(field.example).not.toBe('')
    }
  })

  it.each(STARTER_TEMPLATES)('$id: the sample uses documented fields and the source stays small and self-contained', (template) => {
    const fields = template.fields.map((field) => field.name)
    for (const key of Object.keys(template.sample)) expect(fields).toContain(key)
    expect(template.sample.title).toBeTruthy()
    expect(template.sample.image).toBeUndefined()
    expect(template.name).not.toBe('')
    expect(template.description).not.toBe('')
    expect(new TextEncoder().encode(template.html).length).toBeLessThan(LIMITS.maxHtmlBytes / 4)
    expect(new TextEncoder().encode(template.css).length).toBeLessThan(LIMITS.maxCssBytes / 2)
    // No remote resource except {{image}}, and nothing that costs a filter pass.
    expect(template.html + template.css).not.toMatch(/https?:|url\(|@import|@font-face/)
    expect(template.html.match(/<img\b[^>]*>/g)).toEqual([expect.stringContaining('src="{{image}}"')])
    // The fit tests below clip and unclip this element.
    expect(template.html.match(/class="main"/g)).toHaveLength(1)
    expect(template.css).not.toMatch(/box-shadow|text-shadow|filter\s*:|backdrop-filter/)
  })

  it.each(STARTER_TEMPLATES)('$id: validates without warnings', (template) => {
    expect(validateTemplate(template.html, template.css)).toEqual({ warnings: [] })
  })
})

describe.each(STARTER_TEMPLATES)('rendering $id', (template) => {
  it.each(SIZE_IDS)('%s: sample data and a title on its own render cleanly', async (size) => {
    const sample = await render(template, template.sample, { size })
    expectCleanPng(sample, size)
    const titleOnly = await render(template, { title: template.sample.title! }, { size })
    expectCleanPng(titleOnly, size)
    expect(sameBytes(sample, titleOnly)).toBe(false)
    expect(fetchImage).not.toHaveBeenCalled()
  })

  // The upper bound of every len-title-* step is its worst case. With every other field
  // overfull, the text area must look the same clipped as it does laid bare: nothing spills
  // out of it, and no description had to step aside (blog and launch wrap theirs into a
  // second flex column and park it off the canvas with a column gap when the title needs
  // the room; without the gap that column would show).
  it.each(SIZE_IDS)('%s: titles of 30, 60, 100 and 140 characters fit their text area', async (size) => {
    let longest: RenderOutput | undefined
    for (const length of [30, 60, 100, 140]) {
      const data = crowded(titleOf(length, 'zebra'))
      const clipped = await render(template, data, { size, extraCss: '\n.main { overflow: hidden; }' })
      expectCleanPng(clipped, size)
      const unclipped = await render(template, data, { size, extraCss: '\n.main { overflow: visible; column-gap: 0; }' })
      expect(await changedPixels(clipped, unclipped), `${length} characters`).toBe(0)
      longest = clipped
    }
    // ...and the template as shipped does not cut the longest title short: its last word is drawn.
    const otherEnding = await render(template, crowded(titleOf(140, 'quilt')), { size })
    expectCleanPng(otherEnding, size)
    expect(sameBytes(longest!, otherEnding)).toBe(false)
  })

  it('fetches {{image}} exactly once, and nothing when there is no image', async () => {
    const without = await render(template, template.sample)
    expect(fetchImage).not.toHaveBeenCalled()

    const withImage = await render(template, { ...template.sample, image: IMAGE_URL })
    expectCleanPng(withImage, 'og')
    expect(fetchImage.mock.calls).toEqual([[IMAGE_URL]])
    expect(sameBytes(without, withImage)).toBe(false)
  })

  it('draws markup in a title as text', async () => {
    const markup = `<img src="${IMAGE_URL}"><script>alert(1)</script><b>Hi</b>`
    const output = await render(template, { title: markup })
    // A real <img> would be fetched and a real <script> would be dropped with a warning.
    expectCleanPng(output, 'og')
    expect(fetchImage).not.toHaveBeenCalled()
    const plain = await render(template, { title: 'Hi' })
    expect(sameBytes(output, plain)).toBe(false)
  })

  it('changes with theme=dark exactly when it documents a theme field', async () => {
    const sample = await render(template, template.sample)
    const other = await render(template, { ...template.sample, theme: template.sample.theme === 'dark' ? 'light' : 'dark' })
    const themed = template.fields.some((field) => field.name === 'theme')
    expect(sameBytes(sample, other)).toBe(!themed)
  })
})

describe('the samples worker (scripts/samples-worker.mts)', () => {
  const get = (path: string): Promise<Response> => samplesWorker.fetch(new Request(`http://samples.test${path}`))

  it('lists the templates with their sample data', async () => {
    const list = await (await get('/templates')).json()
    expect(list).toEqual(STARTER_TEMPLATES.map(({ id, name, sample }) => ({ id, name, sample })))
  })

  it('renders a template from query parameters, with the size and watermark asked for', async () => {
    const response = await get('/render/quote.png?size=square&wm=free&title=Hello&author=Ada')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-render-warnings')).toBe(encodeURIComponent('[]'))
    expect(Number(response.headers.get('x-render-ms'))).toBeGreaterThan(0)
    const watermarked = new Uint8Array(await response.arrayBuffer())
    expect(pngSize(watermarked)).toEqual({ width: 1080, height: 1080 })

    const clean = new Uint8Array(await (await get('/render/quote.png?size=square&title=Hello&author=Ada')).arrayBuffer())
    expect(diffPixels(await decodePng(watermarked), await decodePng(clean))).toBeGreaterThan(0)
  })

  it('serves its one demo image and refuses every other URL', async () => {
    const demo = await get(`/render/blog.png?title=Hello&author=Ada&image=${encodeURIComponent('https://samples.linktocard.test/avatar.svg')}`)
    expect(demo.status).toBe(200)
    await demo.arrayBuffer()
    const other = await get(`/render/blog.png?title=Hello&author=Ada&image=${encodeURIComponent(IMAGE_URL)}`)
    expect(other.status).toBe(422)
    expect(await other.json()).toMatchObject({ error: { code: 'image_fetch_failed' } })
  })

  it.each([
    ['/render/nope.png', 404, 'not_found'],
    ['/elsewhere', 404, 'not_found'],
    ['/render/blog.png?title=Hi&size=banner', 400, 'unsupported_size'],
    ['/render/blog.png?title=Hi&wm=huge', 400, 'invalid_request'],
  ])('%s answers %i %s', async (path, status, code) => {
    const response = await get(path)
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
  })
})
