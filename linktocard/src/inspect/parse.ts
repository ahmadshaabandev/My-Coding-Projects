/**
 * Reads the link-preview tags out of a page: og:*, twitter:*, <title>, meta description,
 * canonical, icons and theme-color. A SAX pass (htmlparser2, already used by the
 * renderer); nothing is executed and no DOM is built. The first non-empty value of each
 * tag wins. Values are returned as the page wrote them (entities decoded, whitespace
 * collapsed); URLs are not rewritten here.
 */
import { Parser } from 'htmlparser2';
import type { OgFields, TwitterFields } from './types';

export interface IconLink {
  rel: string;
  href: string;
}

export interface ParsedHead {
  title: string | null;
  description: string | null;
  canonical: string | null;
  themeColor: string | null;
  /** <link> icons in document order. */
  icons: IconLink[];
  og: OgFields;
  twitter: TwitterFields;
}

const ICON_RELS = ['icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed'];

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Character set from a Content-Type header or the first 1024 bytes (<meta charset>), else UTF-8. */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!charset) {
    const head = String.fromCharCode(...bytes.subarray(0, 1024));
    charset = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function parseHead(html: string): ParsedHead {
  const meta = new Map<string, string>();
  const icons: IconLink[] = [];
  let canonical: string | null = null;
  let title: string | null = null;
  let titleText: string | null = null;
  // <title> inside inline SVG names the drawing, not the page.
  let svgDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'svg') svgDepth++;
        if (svgDepth > 0) return;
        if (name === 'title' && title === null) {
          titleText = '';
        } else if (name === 'meta') {
          const content = clean(attrs.content);
          if (content === null) return;
          for (const key of [attrs.property, attrs.name]) {
            const normalised = key?.trim().toLowerCase();
            if (normalised && !meta.has(normalised)) meta.set(normalised, content);
          }
        } else if (name === 'link') {
          const rel = (attrs.rel ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
          const href = clean(attrs.href);
          if (!href) return;
          const tokens = rel.split(' ');
          if (tokens.includes('canonical') && canonical === null) canonical = href;
          if (ICON_RELS.includes(rel) || tokens.includes('icon') || tokens.includes('apple-touch-icon')) icons.push({ rel, href });
        }
      },
      ontext(text) {
        if (titleText !== null) titleText += text;
      },
      onclosetag(name) {
        if (name === 'svg' && svgDepth > 0) svgDepth--;
        if (name === 'title' && titleText !== null) {
          title = clean(titleText);
          titleText = null;
          // An empty <title> does not count; a later one may still fill it.
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const get = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = meta.get(key);
      if (value !== undefined) return value;
    }
    return null;
  };
  return {
    title,
    description: get('description'),
    canonical,
    themeColor: get('theme-color'),
    icons,
    og: {
      title: get('og:title'),
      description: get('og:description'),
      // ogp.me: og:image:url is identical to og:image.
      image: get('og:image', 'og:image:url'),
      image_alt: get('og:image:alt'),
      image_width: get('og:image:width'),
      image_height: get('og:image:height'),
      url: get('og:url'),
      type: get('og:type'),
      site_name: get('og:site_name'),
    },
    twitter: {
      card: get('twitter:card'),
      title: get('twitter:title'),
      description: get('twitter:description'),
      image: get('twitter:image', 'twitter:image:src'),
      site: get('twitter:site'),
    },
  };
}

/** How a URL was written: with a scheme, scheme-relative (//host/...), or relative to the page. */
export function urlForm(raw: string): 'absolute' | 'scheme_relative' | 'relative' {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return 'absolute';
  return raw.startsWith('//') ? 'scheme_relative' : 'relative';
}

/** Resolve against the page's final URL; null when it is not a URL at all. */
export function resolveUrl(raw: string, base: URL): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/** The page's icon: rel=icon first, then shortcut icon, then apple-touch-icon; default /favicon.ico. */
export function pickFavicon(icons: IconLink[], base: URL): URL {
  const ranked = [
    icons.find((icon) => icon.rel.split(' ').includes('icon') && !icon.rel.includes('shortcut')),
    icons.find((icon) => icon.rel === 'shortcut icon'),
    icons.find((icon) => icon.rel.startsWith('apple-touch-icon')),
  ];
  for (const icon of ranked) {
    if (!icon) continue;
    const url = resolveUrl(icon.href, base);
    if (url && (url.protocol === 'https:' || url.protocol === 'http:')) return url;
  }
  return new URL('/favicon.ico', base);
}
