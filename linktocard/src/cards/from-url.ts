/**
 * "Link in, card out": turns one OG check (src/inspect, CheckResult) into the data of a card.
 *
 *   linkFieldsFromCheck()  what the page says about itself, cleaned and shortened
 *   cardDataFromLink()     those fields under the names templates use, only the ones the
 *                          template has, with the caller's overrides on top
 *
 * Everything here is pure: no fetch, no storage. The inspector has already read the page
 * (https only, guarded, size and time capped); this module only decides which of its values
 * go on the card and makes sure each one is something the card engine accepts.
 *
 * Page text is hostile input. It can only ever become text or an image URL in the card,
 * because placeholders are substituted on the parsed template tree (src/render/template.ts),
 * so the work here is about looks and limits: control and bidi-override characters are
 * dropped, long text is cut at a word with an ellipsis, a theme colour must be a real
 * colour, and an image URL must be one the image proxy can load.
 */
import { LIMITS } from '../config';
import type { CheckResult } from '../inspect/types';
import { parseTemplate } from '../render/template';
import type { TemplateData } from '../types';

/** Longest text taken from the page, per field, in code points (the unit validateData counts). */
export interface LinkFieldLimits {
  title: number;
  description: number;
  /** og:site_name and the domain. */
  site: number;
}

/** What the page says about itself, after cleaning. Null means the page does not say. */
export interface LinkFields {
  /** og:title, else twitter:title, else <title>. */
  title: string | null;
  /** og:description, else twitter:description, else <meta name="description">. */
  description: string | null;
  /** og:site_name. */
  siteName: string | null;
  /** Host name of the final URL (after redirects) without a leading "www.". */
  domain: string;
  /** The final URL, when it fits in a data value. */
  url: string | null;
  /** The page icon, only when its file name says PNG, JPEG, GIF or WebP (see logoUrl). */
  logo: string | null;
  /** og:image (else twitter:image), only when the checker loaded it as an image the proxy accepts. */
  pageImage: string | null;
  /** theme-color as lower-case #rrggbb or #rrggbbaa; null for anything that is not a plain colour. */
  themeColor: string | null;
}

/**
 * The data keys a link card can fill, and where each value comes from. Exported so the
 * docs can print it; the order is the order of the docs table.
 */
export const LINK_DATA_SOURCES: Readonly<Record<string, string>> = {
  title: 'og:title, else twitter:title, else the page <title>; else the site name or the domain',
  description: 'og:description, else twitter:description, else the meta description',
  site: 'the domain of the final URL, without "www."',
  author: 'og:site_name, unless it only repeats the domain',
  image: 'the page icon, when it is a PNG, JPEG, GIF or WebP file',
  logo: 'the same icon as image',
  page_image: "the page's og:image (else twitter:image), when the checker could load it as a PNG, JPEG, GIF or WebP image",
  site_name: 'og:site_name',
  domain: 'the domain of the final URL, without "www."',
  url: 'the final URL of the page, after redirects',
  theme_color: 'theme-color as #rrggbb (or #rrggbbaa); left out unless it is a hex, rgb() or basic named colour',
  theme: 'dark when white text reads better than black on the theme colour, else light; left out without a theme colour',
};

/** Keys whose value is an image URL taken from the page. They are dropped when loading one fails. */
export const PAGE_IMAGE_KEYS: readonly string[] = ['image', 'logo', 'page_image'];

/** State class every template can style (.theme-dark), whether or not it prints {{theme}}. */
const THEME_KEY = 'theme';

/** Image types the card renderer's proxy accepts (src/render/proxy.ts ALLOWED_CONTENT_TYPES). */
const RENDERABLE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Icons are not probed, so their file name is the only hint; .ico and .svg would fail the render. */
const RENDERABLE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
/** classifyImageUrl (src/render/template.ts) refuses these characters in a remote image URL. */
const UNSAFE_URL_CHARS = /[\\\s"'<>]/;

/**
 * C0 and C1 controls, bidi embeddings, overrides and isolates, and the byte order mark. They
 * are invisible on a card at best, and a right-to-left override can make a title read
 * backwards. Joiners (U+200C, U+200D) stay: emoji sequences and several scripts need them.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Zero-width marks: kept inside text (direction marks can matter there), but not text on their own. */
const ZERO_WIDTH = /[\u061c\u200b-\u200f\u2060]/g;
const ELLIPSIS = '\u2026';
/** Characters that look wrong right before an ellipsis. */
const TRAILING_PUNCTUATION = /[\s,;:.\-\u2013\u2014|/]+$/u;

/** Collapses white space and drops invisible characters; null when nothing visible is left. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
  return text.replace(ZERO_WIDTH, '').trim() === '' ? null : text;
}

const codePoints = (text: string): number => {
  let count = 0;
  for (const _ of text) count++;
  return count;
};

let segmenter: Intl.Segmenter | null | undefined;

/** Intl.Segmenter keeps emoji sequences, flags and combining marks whole; code points are the fallback. */
const graphemes = (text: string): string[] => {
  if (segmenter === undefined) segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : [...text];
};

/**
 * Text of at most `max` code points. Longer text is cut after a whole word when one ends in
 * the last fifth of the room, never inside a character sequence, and ends with an ellipsis
 * (which counts towards `max`).
 */
export function clipText(text: string, max: number): string {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`clipText: max must be a positive integer, got ${max}`);
  if (text.length <= max || codePoints(text) <= max) return text;
  const room = max - 1;
  const kept: string[] = [];
  let used = 0;
  let lastSpace = -1;
  for (const part of graphemes(text)) {
    const size = codePoints(part);
    if (used + size > room) break;
    if (/^\s+$/.test(part)) lastSpace = kept.length;
    kept.push(part);
    used += size;
  }
  const cut = lastSpace > 0 && lastSpace >= Math.floor(kept.length * 0.8) ? lastSpace : kept.length;
  const head = kept.slice(0, cut).join('').replace(TRAILING_PUNCTUATION, '');
  return `${head === '' ? kept.join('') : head}${ELLIPSIS}`;
}

function firstText(values: readonly (string | null)[], max: number): string | null {
  for (const value of values) {
    const text = cleanText(value);
    if (text !== null) return clipText(text, max);
  }
  return null;
}

/** An absolute http(s) URL the card renderer will try to load, or null. */
function imageUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
  const href = url.href;
  if (UNSAFE_URL_CHARS.test(href) || codePoints(href) > LIMITS.maxDataValueChars) return null;
  return href;
}

/** The page icon, when its file name promises a type the renderer can draw. */
function logoUrl(favicon: string | null): string | null {
  const href = imageUrlOrNull(favicon);
  return href !== null && RENDERABLE_EXTENSION.test(new URL(href).pathname) ? href : null;
}

/** og:image as probed by the checker: loaded, of a renderable type, and within the renderer's limits. */
function pageImageUrl(result: CheckResult): string | null {
  const probe = result.image;
  if (!probe || probe.status === null || probe.status < 200 || probe.status > 299) return null;
  const type = probe.content_type?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!RENDERABLE_TYPES.includes(type)) return null;
  if (probe.bytes !== null && probe.bytes > LIMITS.maxImageBytes) return null;
  if (probe.width !== null && probe.height !== null && probe.width * probe.height > LIMITS.maxImagePixels) return null;
  return imageUrlOrNull(probe.url);
}

/* ------------------------------------------------------------------ */
/* Theme colour                                                        */
/* ------------------------------------------------------------------ */

/** The CSS basic colour keywords, plus orange and grey. Other names are left out rather than listed in full. */
const NAMED_COLOURS: Readonly<Record<string, string>> = {
  black: '#000000',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  white: '#ffffff',
  maroon: '#800000',
  red: '#ff0000',
  purple: '#800080',
  fuchsia: '#ff00ff',
  green: '#008000',
  lime: '#00ff00',
  olive: '#808000',
  yellow: '#ffff00',
  navy: '#000080',
  blue: '#0000ff',
  teal: '#008080',
  aqua: '#00ffff',
  orange: '#ffa500',
};

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)(%?)$/;

const hex2 = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');

function rgbToHex(body: string): string | null {
  // The legacy rgb(1, 2, 3) / rgba(1, 2, 3, 0.5) and the modern rgb(1 2 3) / rgb(1 2 3 / 50%).
  let channels: string[];
  let alpha: string | undefined;
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    const parts = body.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) return null;
    channels = parts.slice(0, 3);
    alpha = parts[3];
  } else {
    const [main = '', slashAlpha, extra] = body.split('/').map((part) => part.trim());
    if (extra !== undefined) return null;
    channels = main.split(/\s+/);
    alpha = slashAlpha;
  }
  if (channels.length !== 3) return null;
  const rgb: number[] = [];
  for (const channel of channels) {
    const match = NUMBER.exec(channel);
    if (!match) return null;
    const value = Number.parseFloat(channel);
    rgb.push(match[1] === '%' ? (value / 100) * 255 : value);
  }
  let suffix = '';
  if (alpha !== undefined) {
    const match = NUMBER.exec(alpha);
    if (!match) return null;
    const value = Number.parseFloat(alpha);
    const fraction = match[1] === '%' ? value / 100 : value;
    if (fraction < 1) suffix = hex2(fraction * 255);
  }
  return `#${rgb.map(hex2).join('')}${suffix}`;
}

/**
 * theme-color as lower-case #rrggbb (#rrggbbaa when it is translucent), or null. Accepts hex,
 * rgb()/rgba() and the basic colour names; anything else (hsl(), var(), other names, CSS
 * that tries to escape the value) is left out rather than guessed.
 */
export function normaliseThemeColor(raw: string | null | undefined): string | null {
  const value = cleanText(raw)?.toLowerCase();
  if (!value) return null;
  const named = NAMED_COLOURS[value];
  if (named) return named;
  const hex = HEX.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return `#${full.endsWith('ff') && full.length === 8 ? full.slice(0, 6) : full}`;
  }
  const rgb = RGB.exec(value)?.[1];
  return rgb === undefined ? null : rgbToHex(rgb);
}

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * "dark" when white text has more contrast than black text on the colour (WCAG 2 contrast
 * ratios), else "light"; null for a colour that is mostly transparent.
 */
export function themeForColor(color: string | null): 'light' | 'dark' | null {
  if (color === null || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(color)) return null;
  const [r, g, b, a = 255] = (color.slice(1).match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)) as [number, number, number, number?];
  if (a < 128) return null;
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05 ? 'dark' : 'light';
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '');

/** The fields of one check, cleaned and cut to `limits`. */
export function linkFieldsFromCheck(result: CheckResult, limits: LinkFieldLimits): LinkFields {
  const finalUrl = new URL(result.final_url);
  return {
    title: firstText([result.og.title, result.twitter.title, result.page.title], limits.title),
    description: firstText([result.og.description, result.twitter.description, result.page.description], limits.description),
    siteName: firstText([result.og.site_name], limits.site),
    domain: clipText(bareHost(finalUrl.hostname), limits.site),
    url: codePoints(finalUrl.href) <= LIMITS.maxDataValueChars ? finalUrl.href : null,
    logo: logoUrl(result.page.favicon),
    pageImage: pageImageUrl(result),
    themeColor: normaliseThemeColor(result.page.theme_color),
  };
}

/**
 * Every value a link card can carry, under the template data names (LINK_DATA_SOURCES).
 * Empty values are left out, so the template's no-<field> classes apply.
 */
export function linkData(fields: LinkFields): TemplateData {
  const sameAsDomain = fields.siteName !== null && bareHost(fields.siteName) === fields.domain;
  const theme = themeForColor(fields.themeColor);
  const candidates: Record<string, string | null> = {
    title: fields.title ?? fields.siteName ?? fields.domain,
    description: fields.description,
    site: fields.domain,
    author: sameAsDomain ? null : fields.siteName,
    image: fields.logo,
    logo: fields.logo,
    page_image: fields.pageImage,
    site_name: fields.siteName,
    domain: fields.domain,
    url: fields.url,
    theme_color: fields.themeColor,
    theme,
  };
  const data: TemplateData = {};
  for (const [key, value] of Object.entries(candidates)) if (value !== null && value !== '') data[key] = value;
  return data;
}

/** The data keys a template can show: its {{placeholders}}, plus theme (a state class). */
export function templateFieldNames(template: { html: string; css: string }): string[] {
  return [...new Set([...parseTemplate(template.html, template.css).placeholders, THEME_KEY])];
}

function pick(data: TemplateData, keys: ReadonlySet<string>): TemplateData {
  const kept: TemplateData = {};
  for (const [key, value] of Object.entries(data)) if (keys.has(key)) kept[key] = value;
  return kept;
}

/**
 * The card's data: the page's values for the keys the template has, then `overrides` (already
 * checked with validateData) for those keys, which win even when empty. Keys the template does
 * not have are ignored on both sides, so they cannot split one card into several cache entries.
 */
export function cardDataFromLink(fields: LinkFields, templateKeys: readonly string[], overrides: TemplateData = {}): TemplateData {
  const keys = new Set(templateKeys);
  return { ...pick(linkData(fields), keys), ...pick(overrides, keys) };
}

/** True when `data` has an image URL that came from the page rather than from the caller. */
export function hasPageImages(data: TemplateData, overrides: TemplateData = {}): boolean {
  return PAGE_IMAGE_KEYS.some((key) => Object.hasOwn(data, key) && !Object.hasOwn(overrides, key));
}

/**
 * The same data without the page's image URLs. A broken or unreachable icon must not cost
 * the whole card: callers render again with this when loading an image failed.
 */
export function withoutPageImages(data: TemplateData, overrides: TemplateData = {}): TemplateData {
  const kept: TemplateData = {};
  for (const [key, value] of Object.entries(data)) {
    if (PAGE_IMAGE_KEYS.includes(key) && !Object.hasOwn(overrides, key)) continue;
    kept[key] = value;
  }
  return kept;
}
