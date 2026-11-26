/// <reference path="./fixtures/og/raw.d.ts" />
// "Link in, card out", the mapping: a CheckResult (src/inspect) to card data. Pure functions,
// checked on real inspector results built from the OG fixtures and on hand-made hostile ones,
// then rendered through the real card engine so every starter accepts what the mapping makes.
import { describe, expect, it } from 'vitest';
import {
  LINK_DATA_SOURCES,
  PAGE_IMAGE_KEYS,
  cardDataFromLink,
  cleanText,
  clipText,
  hasPageImages,
  linkData,
  linkFieldsFromCheck,
  normaliseThemeColor,
  templateFieldNames,
  themeForColor,
  withoutPageImages,
  type LinkFieldLimits,
} from '../src/cards/from-url';
import { LIMITS } from '../src/config';
import type { CheckResult } from '../src/inspect/types';
import { validateData } from '../src/lib/images';
import { renderCard } from '../src/render';
import { STARTER_TEMPLATES, getStarterTemplate } from '../src/render/templates';
import type { TemplateData } from '../src/types';
import { isPng, pngDimensions } from './app-helpers';
import { SETTINGS, bareCheck, checkOf, probePng, solidPng } from './cards-helpers';
import goodHtml from './fixtures/og/good.html?raw';
import missingHtml from './fixtures/og/missing-tags.html?raw';
import relativeHtml from './fixtures/og/relative-image.html?raw';

const LIMITS_SMALL: LinkFieldLimits = { title: 20, description: 30, site: 12 };
const limits = SETTINGS.maxChars;
const codePoints = (text: string): number => [...text].length;
const blog = getStarterTemplate('blog')!;
const blogKeys = templateFieldNames(blog);

function check(fill: (result: CheckResult) => void, url?: string): CheckResult {
  const result = bareCheck(url);
  fill(result);
  return result;
}

/** The good fixture served from `site`, its images on the same site. */
function goodPage(site: string): string {
  return goodHtml.replaceAll('https://cdn.ogfixtures.com', `https://${site}`).replaceAll('https://shop.ogfixtures.com', `https://${site}`);
}

describe('linkFieldsFromCheck on the OG fixtures', () => {
  it('good.html: og values first, the icon as logo, the probed og:image, the theme colour', async () => {
    const site = 'www.good.cardfixtures.com';
    const result = await checkOf(`https://${site}/widgets`, goodPage(site), {
      [`https://${site}/card.png`]: probePng(),
    });
    const fields = linkFieldsFromCheck(result, limits);
    expect(fields).toEqual({
      title: 'Acme Widgets',
      description: 'Hand-made widgets, shipped worldwide.',
      siteName: 'Acme',
      domain: 'good.cardfixtures.com',
      url: `https://${site}/widgets`,
      logo: `https://${site}/static/icon-32.png`,
      pageImage: `https://${site}/card.png`,
      themeColor: '#0f766e',
    });

    // The blog card gets only the fields it has; teal-700 reads better with white text.
    expect(cardDataFromLink(fields, blogKeys)).toEqual({
      title: 'Acme Widgets',
      description: 'Hand-made widgets, shipped worldwide.',
      site: 'good.cardfixtures.com',
      author: 'Acme',
      image: `https://${site}/static/icon-32.png`,
      theme: 'dark',
    });
  });

  it('missing-tags.html: the <title> alone, no icon (the default /favicon.ico cannot be drawn), no image', async () => {
    const result = await checkOf('https://missing.cardfixtures.com/', missingHtml);
    const fields = linkFieldsFromCheck(result, limits);
    expect(fields).toMatchObject({ title: 'Only a title', description: null, siteName: null, logo: null, pageImage: null, themeColor: null });
    expect(result.page.favicon).toBe('https://missing.cardfixtures.com/favicon.ico');
    expect(cardDataFromLink(fields, blogKeys)).toEqual({ title: 'Only a title', site: 'missing.cardfixtures.com' });
  });

  it('relative-image.html: an .ico icon is left out, an og:image that does not load is left out', async () => {
    const result = await checkOf('https://relative.cardfixtures.com/blog/post', relativeHtml);
    expect(result.page.favicon).toBe('https://relative.cardfixtures.com/blog/favicon-16.ico');
    expect(result.image?.status).toBe(404);
    const fields = linkFieldsFromCheck(result, limits);
    expect(fields).toMatchObject({ title: 'Relative image', logo: null, pageImage: null });
  });

  it('a relative og:image that loads is used as page_image, resolved against the page', async () => {
    const result = await checkOf('https://relative2.cardfixtures.com/blog/post', relativeHtml, {
      'https://relative2.cardfixtures.com/blog/images/card.png': probePng(),
    });
    expect(linkFieldsFromCheck(result, limits).pageImage).toBe('https://relative2.cardfixtures.com/blog/images/card.png');
  });
});

describe('precedence and missing fields', () => {
  it('title and description: og, then twitter, then the page', () => {
    const all = check((r) => {
      r.og.title = 'OG title';
      r.twitter.title = 'Twitter title';
      r.page.title = 'Page title';
      r.twitter.description = 'Twitter description';
      r.page.description = 'Page description';
    });
    expect(linkFieldsFromCheck(all, limits)).toMatchObject({ title: 'OG title', description: 'Twitter description' });
    const pageOnly = check((r) => {
      r.page.title = 'Page title';
      r.page.description = 'Page description';
    });
    expect(linkFieldsFromCheck(pageOnly, limits)).toMatchObject({ title: 'Page title', description: 'Page description' });
  });

  it('an empty or invisible og:title falls through to the next source', () => {
    const result = check((r) => {
      r.og.title = ' \u200e\u202e ';
      r.twitter.title = 'Twitter title';
    });
    expect(linkFieldsFromCheck(result, limits).title).toBe('Twitter title');
  });

  it('without any title the card is titled with the site name, else the domain', () => {
    const named = check((r) => {
      r.og.site_name = 'Example Journal';
    });
    expect(linkData(linkFieldsFromCheck(named, limits)).title).toBe('Example Journal');
    const bare = bareCheck('https://www.Example.com/');
    expect(linkData(linkFieldsFromCheck(bare, limits))).toEqual({ title: 'example.com', site: 'example.com', domain: 'example.com', url: 'https://www.example.com/' });
  });

  it('the domain is the final URL after redirects, without www.', () => {
    const result = check((r) => {
      r.final_url = 'https://WWW.Moved.example/new';
    }, 'https://old.example/');
    expect(linkFieldsFromCheck(result, limits)).toMatchObject({ domain: 'moved.example', url: 'https://www.moved.example/new' });
  });

  it('author is the site name, unless it only repeats the domain', () => {
    const repeat = check((r) => {
      r.og.site_name = 'Example.com';
    });
    expect(linkData(linkFieldsFromCheck(repeat, limits)).author).toBeUndefined();
    const www = check((r) => {
      r.og.site_name = 'www.example.com';
    });
    expect(linkData(linkFieldsFromCheck(www, limits)).author).toBeUndefined();
    const named = check((r) => {
      r.og.site_name = 'Example';
    });
    expect(linkData(linkFieldsFromCheck(named, limits))).toMatchObject({ author: 'Example', site_name: 'Example', site: 'example.com' });
  });

  it('a final URL longer than a data value is left out rather than cut', () => {
    const long = `https://example.com/${'a'.repeat(LIMITS.maxDataValueChars)}`;
    expect(linkFieldsFromCheck(bareCheck(long), limits).url).toBeNull();
  });
});

describe('hostile page text', () => {
  it('drops control and bidi-override characters, keeps joiners', () => {
    const result = check((r) => {
      r.og.title = 'Hello\u0000\u0007 \u202eworld\u202c\u2066!\u2069\ufeff';
      r.og.description = 'Family: \u{1F468}\u200d\u{1F469}\u200d\u{1F467} and \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645';
    });
    const fields = linkFieldsFromCheck(result, limits);
    expect(fields.title).toBe('Hello world!');
    expect(fields.description).toBe('Family: \u{1F468}\u200d\u{1F469}\u200d\u{1F467} and \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645');
  });

  it('keeps placeholders and markup as plain text (the engine substitutes on the parsed tree)', async () => {
    const result = check((r) => {
      r.og.title = '{{author}} <img src=x onerror=alert(1)> </h1><script>alert(1)</script>';
      r.og.site_name = '{{title}}';
    });
    const data = cardDataFromLink(linkFieldsFromCheck(result, limits), blogKeys);
    expect(data.title).toBe('{{author}} <img src=x onerror=alert(1)> </h1><script>alert(1)</script>');
    expect(data.author).toBe('{{title}}');
    const output = await renderCard({ html: blog.html, css: blog.css, data, width: 1200, height: 630, format: 'png', watermark: 'none' }, { fetchImage: () => Promise.reject(new Error('no fetch expected')) });
    expect(isPng(output.bytes)).toBe(true);
  });

  it('cuts long text at a word, with an ellipsis, within the limit (the inspector already bounds tags to 2048)', () => {
    const words = `${'Lorem ipsum dolor sit amet '.repeat(80)}\u2026`;
    const result = check((r) => {
      r.og.title = words;
      r.og.description = words;
      r.og.site_name = words;
    });
    const fields = linkFieldsFromCheck(result, limits);
    for (const [value, max] of [
      [fields.title, limits.title],
      [fields.description, limits.description],
      [fields.siteName, limits.site],
    ] as const) {
      expect(codePoints(value!)).toBeLessThanOrEqual(max);
      expect(value!.endsWith('\u2026')).toBe(true);
      expect(value).not.toMatch(/\s\u2026$/);
      // Whole words only.
      expect(value!.slice(0, -1).split(' ').every((word) => ['Lorem', 'ipsum', 'dolor', 'sit', 'amet'].includes(word))).toBe(true);
    }
  });

  it('never splits an emoji sequence or a surrogate pair at the cut', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
    const title = family.repeat(10);
    const clipped = clipText(title, 12);
    expect(codePoints(clipped)).toBeLessThanOrEqual(12);
    expect(clipped).toBe(`${family}\u2026`);
    const flags = '\u{1F1F1}\u{1F1E7}'.repeat(10);
    expect(clipText(flags, 6)).toBe('\u{1F1F1}\u{1F1E7}\u{1F1F1}\u{1F1E7}\u2026');
    expect(clipText('\u{1F600}'.repeat(10), 4)).toBe('\u{1F600}\u{1F600}\u{1F600}\u2026');
  });

  it('every value it makes passes the data validator, whatever the page wrote', () => {
    const huge = 'x'.repeat(2048) + '\u2026';
    const result = check((r) => {
      r.og.title = huge;
      r.og.description = huge;
      r.og.site_name = huge;
      r.page.favicon = `https://example.com/${'i'.repeat(2000)}.png`;
      r.page.theme_color = huge;
    });
    const data = linkData(linkFieldsFromCheck(result, limits));
    expect(() => validateData(data)).not.toThrow();
    expect(data.image).toBeUndefined();
    expect(data.theme_color).toBeUndefined();
  });
});

describe('clipText and cleanText', () => {
  it('leaves text that fits alone and counts code points, not UTF-16 units', () => {
    expect(clipText('exactly 10', 10)).toBe('exactly 10');
    expect(clipText('\u{1F600}'.repeat(5), 5)).toBe('\u{1F600}'.repeat(5));
  });

  it('cuts inside a word only when no word ends near the limit', () => {
    expect(clipText('Supercalifragilistic', 10)).toBe('Supercali\u2026');
    expect(clipText('Short words here, and more', 20)).toBe('Short words here\u2026');
    expect(clipText('ab', 1)).toBe('\u2026');
  });

  it('drops punctuation right before the ellipsis', () => {
    expect(clipText('One, two, three, four', 11)).toBe('One, two\u2026');
  });

  it('cleanText collapses white space and returns null for nothing visible', () => {
    expect(cleanText('  a \n\t b  ')).toBe('a b');
    expect(cleanText('\u0001\u202e')).toBeNull();
    expect(cleanText(null)).toBeNull();
  });

  it('refuses a limit below one', () => {
    expect(() => clipText('abc', 0)).toThrow(RangeError);
  });
});

describe('theme colour', () => {
  it.each([
    ['#0F766E', '#0f766e'],
    ['#abc', '#aabbcc'],
    ['#abcf', '#aabbcc'],
    ['#abcd', '#aabbccdd'],
    ['#11223344', '#11223344'],
    ['#112233FF', '#112233'],
    ['rgb(15, 118, 110)', '#0f766e'],
    ['rgba(15, 118, 110, 0.5)', '#0f766e80'],
    ['rgb(15 118 110 / 50%)', '#0f766e80'],
    ['rgb(100%, 0%, 0%)', '#ff0000'],
    ['RGB(0,0,0)', '#000000'],
    [' White ', '#ffffff'],
    ['navy', '#000080'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseThemeColor(input)).toBe(expected);
  });

  it.each([
    'hsl(120, 50%, 50%)',
    'var(--brand)',
    'red; background: url(https://evil.example/x.png)',
    '#12345',
    '#ggg',
    'rgb(1, 2)',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1, 2, 3 / 0.5)',
    'rgb(a, b, c)',
    'rebeccapurple',
    'transparent',
    '',
  ])('%s is left out', (input) => {
    expect(normaliseThemeColor(input)).toBeNull();
  });

  it('dark when white text has more contrast than black text', () => {
    expect(themeForColor('#000000')).toBe('dark');
    expect(themeForColor('#ffffff')).toBe('light');
    expect(themeForColor('#0f766e')).toBe('dark');
    // Google blue: black text is (just) more legible.
    expect(themeForColor('#1a73e8')).toBe('light');
    expect(themeForColor('#ffd400')).toBe('light');
    expect(themeForColor('#00000040')).toBeNull();
    expect(themeForColor(null)).toBeNull();
  });

  it('no theme without a theme colour', () => {
    expect(linkData(linkFieldsFromCheck(bareCheck(), limits)).theme).toBeUndefined();
  });
});

describe('image URLs', () => {
  const logoOf = (favicon: string | null): string | null =>
    linkFieldsFromCheck(
      check((r) => {
        r.page.favicon = favicon;
      }),
      limits,
    ).logo;

  it('uses an icon whose file name is PNG, JPEG, GIF or WebP', () => {
    expect(logoOf('https://example.com/icon.PNG')).toBe('https://example.com/icon.PNG');
    expect(logoOf('https://example.com/a/icon-192.webp?v=3')).toBe('https://example.com/a/icon-192.webp?v=3');
    expect(logoOf('http://example.com/logo.jpeg')).toBe('http://example.com/logo.jpeg');
  });

  it.each([
    'https://example.com/favicon.ico',
    'https://example.com/favicon.svg',
    'https://example.com/icon',
    'https://example.com/icon.png.php',
    'https://user:pass@example.com/icon.png',
    'javascript:alert(1)//.png',
    'data:image/png;base64,AAAA',
    'ftp://example.com/icon.png',
  ])('leaves out the icon %s', (favicon) => {
    expect(logoOf(favicon)).toBeNull();
  });

  const pageImageOf = (probe: Partial<NonNullable<CheckResult['image']>>): string | null =>
    linkFieldsFromCheck(
      check((r) => {
        r.image = { url: 'https://cdn.example.com/card.png', status: 200, content_type: 'image/png', bytes: 1000, width: 1200, height: 630, aspect_ratio: 1.905, response_ms: 5, ...probe };
      }),
      limits,
    ).pageImage;

  it('uses og:image only when the checker loaded it as an image the renderer accepts', () => {
    expect(pageImageOf({})).toBe('https://cdn.example.com/card.png');
    expect(pageImageOf({ content_type: 'image/webp', bytes: null, width: null, height: null })).toBe('https://cdn.example.com/card.png');
    expect(pageImageOf({ status: 404 })).toBeNull();
    expect(pageImageOf({ status: null })).toBeNull();
    expect(pageImageOf({ content_type: 'image/avif' })).toBeNull();
    expect(pageImageOf({ content_type: 'image/svg+xml' })).toBeNull();
    expect(pageImageOf({ bytes: LIMITS.maxImageBytes + 1 })).toBeNull();
    expect(pageImageOf({ width: 4000, height: 4000 })).toBeNull();
    expect(pageImageOf({ url: 'https://cdn.example.com/a b".png' })).toBe('https://cdn.example.com/a%20b%22.png');
  });

  it('withoutPageImages drops the page images but keeps the caller own', () => {
    const data: TemplateData = { title: 'T', image: 'https://a.example/i.png', logo: 'https://a.example/i.png', page_image: 'https://a.example/p.png' };
    expect(PAGE_IMAGE_KEYS).toEqual(['image', 'logo', 'page_image']);
    expect(hasPageImages(data)).toBe(true);
    expect(withoutPageImages(data)).toEqual({ title: 'T' });
    const overrides = { image: 'https://mine.example/me.png' };
    expect(withoutPageImages({ ...data, ...overrides }, overrides)).toEqual({ title: 'T', image: 'https://mine.example/me.png' });
    expect(hasPageImages({ title: 'T', image: 'https://mine.example/me.png' }, overrides)).toBe(false);
  });
});

describe('cardDataFromLink: template fields and overrides', () => {
  const fields = linkFieldsFromCheck(
    check((r) => {
      r.og.title = 'Page title';
      r.og.description = 'Page description';
      r.og.site_name = 'Example';
      r.page.favicon = 'https://www.example.com/icon.png';
      r.page.theme_color = '#ffffff';
      r.image = { url: 'https://www.example.com/og.png', status: 200, content_type: 'image/png', bytes: 10, width: 1200, height: 630, aspect_ratio: 1.905, response_ms: 1 };
    }),
    limits,
  );

  it('overrides win, even when empty; keys the template lacks are ignored on both sides', () => {
    const data = cardDataFromLink(fields, blogKeys, { title: 'Mine', image: '', tag: 'News', unknown_key: 'x', page_image: 'https://x.example/y.png' });
    expect(data).toEqual({ title: 'Mine', description: 'Page description', site: 'example.com', author: 'Example', image: '', tag: 'News', theme: 'light' });
  });

  it('a custom template gets every link field it names', () => {
    const custom = {
      html: '<div style="background: {{theme_color}}"><img src="{{page_image}}"><img src="{{logo}}"><p>{{site_name}} {{domain}} {{url}} {{title}}</p></div>',
      css: '',
    };
    const keys = templateFieldNames(custom);
    expect(keys.sort()).toEqual(['domain', 'logo', 'page_image', 'site_name', 'theme', 'theme_color', 'title', 'url']);
    expect(cardDataFromLink(fields, keys)).toEqual({
      title: 'Page title',
      logo: 'https://www.example.com/icon.png',
      page_image: 'https://www.example.com/og.png',
      site_name: 'Example',
      domain: 'example.com',
      url: 'https://www.example.com/post',
      theme_color: '#ffffff',
      theme: 'light',
    });
  });

  it('documents every key it can fill', () => {
    expect(Object.keys(linkData(fields)).every((key) => key in LINK_DATA_SOURCES)).toBe(true);
    expect(Object.keys(LINK_DATA_SOURCES).every((key) => LIMITS.dataKeyPattern.test(key))).toBe(true);
  });
});

describe('every starter template renders what the mapping makes', () => {
  it('good.html data, with a real logo, on every starter and size', async () => {
    const site = 'render.cardfixtures.com';
    const result = await checkOf(`https://${site}/widgets`, goodPage(site), { [`https://${site}/card.png`]: probePng() });
    const fields = linkFieldsFromCheck(result, LIMITS_SMALL);
    const logo = await solidPng(8, 8);
    const fetched: string[] = [];
    const deps = {
      fetchImage: async (url: string) => {
        fetched.push(url);
        return { dataUri: `data:image/png;base64,${btoa(String.fromCharCode(...logo))}` };
      },
    };
    for (const template of STARTER_TEMPLATES) {
      const data = cardDataFromLink(fields, templateFieldNames(template));
      expect(() => validateData(data), template.id).not.toThrow();
      const output = await renderCard({ html: template.html, css: template.css, data, width: 1200, height: 630, format: 'png', watermark: 'free' }, deps);
      expect(isPng(output.bytes), template.id).toBe(true);
      expect(pngDimensions(output.bytes), template.id).toEqual({ width: 1200, height: 630 });
    }
    // Only the icon is drawn by the starters; the og:image is for templates that ask for {{page_image}}.
    expect(new Set(fetched)).toEqual(new Set([`https://${site}/static/icon-32.png`]));
  });

  it('long hostile text fits the card text limit with the production limits', async () => {
    const words = 'Wordy '.repeat(400);
    const result = check((r) => {
      r.og.title = words;
      r.og.description = words;
      r.og.site_name = words;
    });
    for (const template of STARTER_TEMPLATES) {
      const data = cardDataFromLink(linkFieldsFromCheck(result, limits), templateFieldNames(template));
      const output = await renderCard({ html: template.html, css: template.css, data, width: 1080, height: 1080, format: 'png', watermark: 'none' }, { fetchImage: () => Promise.reject(new Error('no fetch expected')) });
      expect(isPng(output.bytes), template.id).toBe(true);
    }
  });
});
