// The two email starter templates (src/render/templates/email-banner.ts, email-offer.ts), rendered
// inside workerd with the real renderer: their design sizes and the existing presets, sparse,
// overfull and hostile data, and the open-field path from a signed URL to the pixels.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { EMAIL_FIELDS, LIMITS, SIZES } from '../src/config';
import { buildOpenFieldsUrl, normaliseOpenValue, verifyWithOpenFields } from '../src/lib/open-fields';
import { SIZE_PARAM } from '../src/lib/signed-url';
import { renderCard, validateTemplate, warmUp } from '../src/render';
import { parseTemplate } from '../src/render/template';
import { STARTER_TEMPLATE_IDS, type StarterTemplate } from '../src/render/templates';
import { emailBanner } from '../src/render/templates/email-banner';
import { emailOffer } from '../src/render/templates/email-offer';
import type { RenderDeps, RenderOutput, TemplateData, WatermarkMode } from '../src/types';
import { decodePng, diffPixels, pngSize, redImages } from './helpers';

type EmailTemplate = Omit<StarterTemplate, 'id'> & { id: 'email-banner' | 'email-offer' };

/** Compile-time check: each file has exactly the shape of a starter template. */
const asStarterShape: readonly Omit<StarterTemplate, 'id'>[] = [emailBanner, emailOffer];
const TEMPLATES: readonly EmailTemplate[] = [emailBanner, emailOffer];

interface Size {
  name: string;
  width: number;
  height: number;
}

const PRESETS: readonly Size[] = Object.values(SIZES).map(({ id, width, height }) => ({ name: id, width, height }));
const preset = (id: keyof typeof SIZES): Size => PRESETS.find((size) => size.name === id)!;
/** The preset each template is laid out for (decision D7: email-banner the email preset, email-offer og). */
const DESIGN: Record<EmailTemplate['id'], Size> = {
  'email-banner': preset('email'),
  'email-offer': preset('og'),
};
/** Its design size first, then every other preset it must also survive. */
const sizesOf = (template: EmailTemplate): Size[] => [DESIGN[template.id], ...PRESETS.filter((size) => size !== DESIGN[template.id])];

const IMAGE_URL = 'https://cdn.example.com/logo.png';
/** font-size of .hello at the design size (the CSS above the size-* rules). */
const NAME_FONT_PX: Record<EmailTemplate['id'], number> = { 'email-banner': 42, 'email-offer': 40 };
const HOSTILE_NAMES: readonly [string, string][] = [
  ['the longest signed value', 'W'.repeat(LIMITS.maxDataValueChars)],
  ['the longest open value', 'W'.repeat(EMAIL_FIELDS.maxValueChars)],
  ['a long real name', 'Alexandra Konstantinopoulou-Whitfield'],
  ['one unbroken word', 'Supercalifragilisticexpialidocious'.repeat(8)],
  ['markup', '<img src="https://cdn.example.com/x.png"><script>alert(1)</script><b>Maya</b>'],
  ['a bidi override', '‮ayaM yraM'],
  ['combining marks', `Z${'́'.repeat(30)}oe`],
];

let imageDataUri: string;
let fetchSpy: MockInstance<typeof fetch>;
let fetchImage: Mock<RenderDeps['fetchImage']>;

function render(template: EmailTemplate, data: TemplateData, size: Size, options: { extraCss?: string; watermark?: WatermarkMode } = {}): Promise<RenderOutput> {
  const deps: RenderDeps = { fetchImage: (url) => fetchImage(url) };
  return renderCard(
    { html: template.html, css: template.css + (options.extraCss ?? ''), data, width: size.width, height: size.height, format: 'png', watermark: options.watermark ?? 'none' },
    deps,
  );
}

function expectCleanPng(output: RenderOutput, size: Size): void {
  expect(output.contentType).toBe('image/png');
  expect(pngSize(output.bytes)).toEqual({ width: size.width, height: size.height });
  expect(output.warnings).toEqual([]);
}

function sameBytes(a: RenderOutput, b: RenderOutput): boolean {
  return a.bytes.length === b.bytes.length && a.bytes.every((byte, index) => byte === b.bytes[index]);
}

async function changedPixels(a: RenderOutput, b: RenderOutput): Promise<number> {
  return sameBytes(a, b) ? 0 : diffPixels(await decodePng(a.bytes), await decodePng(b.bytes));
}

/** Every field filled with more text than a sensible email image has. */
function crowded(template: EmailTemplate, title: string, name: string): TemplateData {
  const long = 'Infrastructure field notes and other very long labels';
  const data: TemplateData = { title, name, greeting: 'Good morning', site: 'engineering.longcompanyname.example', tag: long, image: IMAGE_URL };
  if (template.id === 'email-banner') return { ...data, cta: 'Read the whole story on our website today' };
  return {
    ...data,
    description: 'A field report with every number we measured along the way, and the three mistakes that made our first week harder.',
    code: 'SPRING-2026-MEMBERS-ONLY-EXTRA',
    expires: 'Valid until the end of the month, in every shop',
  };
}

beforeAll(async () => {
  await warmUp();
  imageDataUri = (await redImages(64)).png;
});

// Like the other starters, these must never reach the network by themselves.
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
    throw new Error(`an email template made the renderer call fetch(${String(request)})`);
  });
  fetchImage = vi.fn(async () => ({ dataUri: imageDataUri }));
});
afterEach(() => {
  expect(fetchSpy.mock.calls).toEqual([]);
  vi.restoreAllMocks();
});

describe('the email templates as starter templates', () => {
  it('have new ids that a signed URL path accepts and that no other starter uses', () => {
    expect(asStarterShape).toHaveLength(2);
    expect(TEMPLATES.map((template) => template.id)).toEqual(['email-banner', 'email-offer']);
    for (const template of TEMPLATES) {
      expect(template.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(STARTER_TEMPLATE_IDS as readonly string[]).not.toContain(template.id);
    }
  });

  it.each(TEMPLATES)('$id: the documented fields are exactly the placeholders of its HTML', (template) => {
    const { placeholders } = parseTemplate(template.html, template.css);
    const fields = template.fields.map((field) => field.name);
    // theme only switches the theme-<value> class, like the other starters.
    expect(fields.filter((name) => name !== 'theme').sort()).toEqual([...placeholders].sort());
    expect(fields.includes('theme')).toBe(template.css.includes('.theme-dark'));
    expect(new Set(fields).size).toBe(fields.length);
    expect(template.fields.filter((field) => field.required).map((field) => field.name)).toEqual(['title']);
    for (const field of template.fields) {
      expect(field.name).toMatch(LIMITS.dataKeyPattern);
      expect(field.description.length).toBeGreaterThan(10);
      expect(field.example).not.toBe('');
    }
    // The personalised part every email template has.
    expect(fields).toEqual(expect.arrayContaining(['name', 'greeting']));
  });

  it.each(TEMPLATES)('$id: the sample uses documented fields and the source stays small and self-contained', (template) => {
    const fields = template.fields.map((field) => field.name);
    for (const key of Object.keys(template.sample)) expect(fields).toContain(key);
    expect(template.sample.title).toBeTruthy();
    expect(template.sample.image).toBeUndefined();
    expect(new TextEncoder().encode(template.html).length).toBeLessThan(LIMITS.maxHtmlBytes / 4);
    expect(new TextEncoder().encode(template.css).length).toBeLessThan(LIMITS.maxCssBytes / 2);
    expect(template.html + template.css).not.toMatch(/https?:|url\(|@import|@font-face/);
    expect(template.html.match(/<img\b[^>]*>/g)).toEqual([expect.stringContaining('src="{{image}}"')]);
    expect(template.html.match(/class="main"/g)).toHaveLength(1);
    expect(template.css).not.toMatch(/box-shadow|text-shadow|filter\s*:|backdrop-filter/);
    // No fixed words: every visible text comes from the data, so the template works in any language.
    const text = template.html.replace(/<[^>]*>/g, ' ').replace(/\{\{\s*\w+\s*\}\}/g, ' ');
    expect(text.replace(/[\s,]/g, '')).toBe('');
  });

  it.each(TEMPLATES)('$id: validates without warnings', (template) => {
    expect(validateTemplate(template.html, template.css)).toEqual({ warnings: [] });
  });
});

describe.each(TEMPLATES)('rendering $id', (template) => {
  it.each(sizesOf(template))('$name ($width x $height): sample data and a title on its own render cleanly', async (size) => {
    const sample = await render(template, template.sample, size);
    expectCleanPng(sample, size);
    const titleOnly = await render(template, { title: template.sample.title! }, size);
    expectCleanPng(titleOnly, size);
    expect(sameBytes(sample, titleOnly)).toBe(false);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  // With every field overfull, the text column looks the same clipped as laid bare: nothing
  // spills out of it (an offer's description that steps aside goes off the canvas either way).
  it.each(sizesOf(template))('$name: titles of 30, 60, 100 and 140 characters with crowded fields stay in their area', async (size) => {
    for (const length of [30, 60, 100, 140]) {
      const title = `${'Spring collection news for members '.repeat(5).slice(0, length - 6).trimEnd()} zebra`;
      const data = crowded(template, title, 'Alexandra Konstantinopoulou-Whitfield');
      const clipped = await render(template, data, size, { extraCss: '\n.main { overflow: hidden; }' });
      expectCleanPng(clipped, size);
      const unclipped = await render(template, data, size, { extraCss: '\n.main { overflow: visible; }' });
      expect(await changedPixels(clipped, unclipped), `${length} characters`).toBe(0);
    }
  });

  it.each(HOSTILE_NAMES)('a hostile name (%s) renders, stays on one line and leaves the title drawn', async (_label, name) => {
    const size = DESIGN[template.id];
    const data = { ...template.sample, name };
    const output = await render(template, data, size);
    expect(pngSize(output.bytes)).toEqual({ width: size.width, height: size.height });
    // Markup in a value is text: nothing is fetched.
    expect(fetchImage).not.toHaveBeenCalled();
    // The name cannot push the message off the card: another title still changes the pixels...
    const otherTitle = await render(template, { ...data, title: 'Another message entirely' }, size);
    expect(sameBytes(output, otherTitle)).toBe(false);
    // ...and the name stays on its one line: against a short name, only one band of rows changes,
    // no taller than two lines of the name (a stacked accent may reach above it). A name that
    // wrapped would move the centred title and change rows far below.
    const shortName = await render(template, { ...data, name: 'Maya' }, size);
    const [hostile, short] = await Promise.all([decodePng(output.bytes), decodePng(shortName.bytes)]);
    const rows: number[] = [];
    for (let row = 0; row < size.height; row++) if (diffPixels(hostile!, short!, { x: 0, y: row, w: size.width, h: 1 }) > 0) rows.push(row);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]! - rows[0]!).toBeLessThan(2 * NAME_FONT_PX[template.id]);
  });

  it('renders the longest open value for every field it may be used for', async () => {
    const size = DESIGN[template.id];
    const longest = 'W'.repeat(EMAIL_FIELDS.maxValueChars);
    for (const field of template.fields.map((entry) => entry.name).filter((name) => name !== 'image' && name !== 'theme')) {
      expectCleanPng(await render(template, { ...template.sample, [field]: longest }, size), size);
    }
  });

  it('shows the greeting and name only when they are given', async () => {
    const size = DESIGN[template.id];
    const full = await render(template, template.sample, size);
    const noName = await render(template, { ...template.sample, name: '' }, size);
    const noGreeting = await render(template, { ...template.sample, greeting: '' }, size);
    const neither = await render(template, { ...template.sample, name: '', greeting: '' }, size);
    for (const card of [noName, noGreeting, neither]) expectCleanPng(card, size);
    const cards = [full, noName, noGreeting, neither];
    for (const [index, card] of cards.entries()) for (const other of cards.slice(index + 1)) expect(sameBytes(card, other)).toBe(false);
  });

  it('fetches {{image}} exactly once, and nothing when there is no image', async () => {
    const size = DESIGN[template.id];
    const without = await render(template, template.sample, size);
    expect(fetchImage).not.toHaveBeenCalled();
    const withImage = await render(template, { ...template.sample, image: IMAGE_URL }, size);
    expectCleanPng(withImage, size);
    expect(fetchImage.mock.calls).toEqual([[IMAGE_URL]]);
    expect(sameBytes(without, withImage)).toBe(false);
  });

  it('changes with theme=dark and carries the Free watermark', async () => {
    const size = DESIGN[template.id];
    const light = await render(template, template.sample, size);
    const dark = await render(template, { ...template.sample, theme: 'dark' }, size);
    expectCleanPng(dark, size);
    expect(sameBytes(light, dark)).toBe(false);
    const marked = await render(template, template.sample, size, { watermark: 'free' });
    expectCleanPng(marked, size);
    expect(await changedPixels(light, marked)).toBeGreaterThan(0);
  });
});

describe('from a signed URL with open fields to the pixels', () => {
  const SECRET = 'ltcs_test_site_secret_for_email_template_tests';

  it.each(TEMPLATES)('$id: each recipient gets their own card, and unusable values get the default card', async (template) => {
    const size = DESIGN[template.id];
    const { name: _name, ...fixed } = template.sample;
    const { url } = await buildOpenFieldsUrl({
      baseUrl: 'https://linktocard.test',
      siteId: 's_email1',
      template: template.id,
      ext: 'png',
      params: { ...fixed, name_default: 'there' },
      secret: SECRET,
      open: ['name'],
    });
    const cardFor = async (raw: string): Promise<RenderOutput> => {
      const verified = await verifyWithOpenFields(new URL(url + encodeURIComponent(raw)), SECRET);
      if (!verified.ok) throw new Error(verified.reason);
      const { [SIZE_PARAM]: _size, ...data } = verified.params;
      return render(template, data, size);
    };
    const maya = await cardFor('Maya');
    expectCleanPng(maya, size);
    expect(sameBytes(maya, await render(template, template.sample, size))).toBe(true);
    const fallback = await render(template, { ...template.sample, name: 'there' }, size);
    for (const raw of ['', '*|FNAME|*', '<b>x</b>', 'محمد', 'W'.repeat(EMAIL_FIELDS.maxValueChars + 1)]) {
      expect(sameBytes(await cardFor(raw), fallback), raw).toBe(true);
    }
  });
});

describe('the bundled-font rule for open values', () => {
  // A one-field card: the value as plain text in a wrapping box, so every character is laid out.
  const html = '<div style="display: flex; flex-wrap: wrap; width: 100%; height: 100%; font-size: 12px; line-height: 1">{{v}}</div>';
  const draw = (value: string) =>
    renderCard({ html, css: '', data: { v: value }, width: 1200, height: 630, format: 'png', watermark: 'none' }, { fetchImage: async () => ({ dataUri: imageDataUri }) });
  const missingGlyphs = (output: RenderOutput): string[] => output.warnings.filter((warning) => warning.startsWith('No bundled font covers'));

  it('admits only letters a bundled font draws: none of them is reported missing', async () => {
    const admitted: string[] = [];
    for (let code = 0x21; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      // Characters admitted on their own and unchanged (a mark needs a base letter to stand on).
      if (/\p{M}/u.test(char) ? normaliseOpenValue(`a${char}`) === `a${char}`.normalize('NFKC') && `a${char}`.normalize('NFKC').length === 2 : normaliseOpenValue(char) === char) {
        admitted.push(/\p{M}/u.test(char) ? `a${char}` : char);
      }
    }
    expect(admitted.length).toBeGreaterThan(950);
    // Chunks within the per-value limit; spaces let the box wrap.
    for (let start = 0; start < admitted.length; start += 400) {
      const output = await draw(admitted.slice(start, start + 400).join(' '));
      expect(missingGlyphs(output), `characters ${start} to ${start + 400}`).toEqual([]);
    }
  });

  it('is needed: the renderer reports the scripts it leaves out', async () => {
    for (const value of ['محمد', '李小龙', 'नमस्ते', 'Қанат']) {
      expect(normaliseOpenValue(value)).toBeNull();
      expect(missingGlyphs(await draw(value)), value).not.toEqual([]);
    }
  });
});
