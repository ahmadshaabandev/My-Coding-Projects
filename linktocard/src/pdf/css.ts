/**
 * CSS for PDF documents: every stylesheet (<style> elements, the request's "css", header and
 * footer templates) and every style="" attribute passes through here before the browser sees it.
 *
 * Chrome understands all of CSS, so unlike the image renderer nothing is mapped or simplified.
 * This module only makes sure the document cannot reach the network:
 *
 *   @import                          refused (template_error): CSS must come with the request
 *   @font-face with a non-data: url  refused (template_error): fonts are bundled or embedded
 *   url(https://...)                 handed to the asset collector, which inlines it as data:
 *   url(#id), url(data:...)          kept
 *   any other url(...)               the declaration is dropped
 *   escapes that could spell url(    the declaration is dropped
 *   image-set("...") with strings    the declaration is dropped (strings there are URLs)
 *   src("...")                       the declaration is dropped (its string is a URL)
 *
 * The browser call itself also allows only data: requests, so a gap here would show up as a
 * missing image, never as a request to the open web.
 */
import { ApiError } from '../lib/errors';
import { cssUrls, parseCss, parseInlineStyle, replaceCssUrls, serializeCss, type CssDeclaration, type CssNode } from '../render/css';

export type Warn = (message: string) => void;

/** Where a URL is written: an HTML attribute (style="") or the text of a <style> element. */
export type AssetContext = 'attribute' | 'sheet';

/** Receives every remote URL and returns the text to write in its place. */
export type AssetCollector = (url: string, context: AssetContext) => string;

/** Bundled families found in font-family / font declarations (lower-case names). */
export type FontUse = Set<string>;

export interface CssScope {
  collect: AssetCollector;
  warn: Warn;
  fonts: FontUse;
}

/** At-rules dropped without a word: they are meaningless or obsolete inside a <style> element. */
const SILENT_AT_RULES = new Set(['charset']);
/** At-rules that name a resource, and are dropped (with a warning) because nothing may be fetched. */
const DROPPED_AT_RULES = new Set(['namespace']);
/** The at-keyword: it ends at the first character that cannot be part of a name, so "@import'a.css'" is @import. */
const AT_NAME = /^@([\w-]+)/;
const URL_FUNCTION = /(^|[^\w-])url\(/gi;
/** src("...") (CSS Values 4) takes its URL as a string, which url() handling never sees. */
const SRC_FUNCTION = /(^|[^\w-])src\(/i;
const FONT_PROPERTIES = new Set(['font-family', 'font']);
/** The bundled families (src/pdf/fonts.ts), matched as whole names in lower case. */
const BUNDLED_FAMILY_NAMES = ['inter', 'source serif 4', 'jetbrains mono'].map(
  (family) => [family, new RegExp(`(^|[^a-z0-9_-])${family}($|[^a-z0-9_-])`)] as const,
);

function preview(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The text with every string literal removed (escapes inside strings handled). */
export function withoutStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * An absolute http(s) URL the asset collector may fetch, normalised by the URL parser (which
 * percent-encodes spaces, quotes and angle brackets); undefined otherwise. A backslash is
 * refused: in CSS it starts an escape, so we could not know which URL the browser would read.
 */
export function remoteUrl(target: string): string | undefined {
  const url = target.trim();
  if (!/^https?:\/\//i.test(url) || /[\\\u0000-\u001f\u007f]/.test(url) || !URL.canParse(url)) return undefined;
  return new URL(url).href;
}

/**
 * Rewrites the url() targets of one declaration value, or returns undefined when the
 * declaration must be dropped. `fontFace` refuses everything but data: (an @font-face src).
 */
function rewriteUrls(property: string, value: string, scope: CssScope, context: AssetContext, fontFace: boolean): string | undefined {
  const bare = withoutStrings(value);
  if (bare.includes('\\') && bare.includes('(')) {
    scope.warn(`A CSS value of "${property}" uses escape sequences together with a function and was removed.`);
    return undefined;
  }
  if (SRC_FUNCTION.test(bare)) {
    scope.warn(`src(...) in "${property}" is not supported and was removed; use url().`);
    return undefined;
  }
  // Inside image-set() a plain string is a URL too. Without its url() tokens, a quote that is
  // left can only be such a string (or another string in the same value: dropped as well).
  if (/image-set\(/i.test(bare) && /["']/.test(replaceCssUrls(value, () => '').replace(/url\(""\)/g, ''))) {
    scope.warn(`image-set() with plain strings in "${property}" is not supported and was removed; use url() inside image-set().`);
    return undefined;
  }
  const targets = cssUrls(value);
  // Every url( outside strings must have been parsed, or the declaration hides one.
  if ((bare.match(URL_FUNCTION) ?? []).length !== targets.length) {
    scope.warn(`A malformed url(...) in "${property}" was removed.`);
    return undefined;
  }
  let dropped = false;
  const rewritten = replaceCssUrls(value, (raw) => {
    const target = raw.trim();
    if (/^data:/i.test(target) && !target.includes('\\')) return target.replace(/"/g, '%22').replace(/[\r\n\f]/g, '');
    if (fontFace) {
      throw new ApiError(
        'template_error',
        `@font-face may only use fonts embedded as data: URIs; "${preview(target)}" would be downloaded. Inter, Source Serif 4 and JetBrains Mono are built in and need no @font-face.`,
      );
    }
    if (/^#[\w.-]+$/.test(target)) return target;
    const remote = remoteUrl(target);
    if (remote) return scope.collect(remote, context);
    dropped = true;
    return '';
  });
  if (dropped) {
    scope.warn(`url(...) in "${property}" must be an absolute http(s) URL, a data: URI or #id; the declaration was removed.`);
    return undefined;
  }
  return rewritten;
}

function noteFonts(declaration: CssDeclaration, fonts: FontUse): void {
  if (!FONT_PROPERTIES.has(declaration.name) && !declaration.name.startsWith('--')) return;
  const value = declaration.value.toLowerCase();
  for (const [family, pattern] of BUNDLED_FAMILY_NAMES) if (pattern.test(value)) fonts.add(family);
}

function sanitizeDeclaration(declaration: CssDeclaration, scope: CssScope, context: AssetContext, fontFace: boolean): CssDeclaration | undefined {
  const value = rewriteUrls(declaration.name, declaration.value, scope, context, fontFace);
  if (value === undefined) return undefined;
  const kept = { name: declaration.name, value };
  noteFonts(kept, scope.fonts);
  return kept;
}

function atRuleName(text: string): string | undefined {
  if (!text.startsWith('@')) return undefined;
  if (/^@[^\s({;]*\\/.test(text)) {
    throw new ApiError('template_error', `CSS escapes in an at-rule name are not supported ("${preview(text)}").`);
  }
  return AT_NAME.exec(text)?.[1]?.toLowerCase() ?? '';
}

function refuseImport(): never {
  throw new ApiError(
    'template_error',
    '@import is not supported: nothing is downloaded while a PDF renders. Put the CSS in "css" or in a <style> element.',
  );
}

function sanitizeNodes(nodes: readonly CssNode[], scope: CssScope, context: AssetContext, fontFace: boolean): CssNode[] {
  const out: CssNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'declaration') {
      const kept = sanitizeDeclaration(node, scope, context, fontFace);
      if (kept) out.push({ kind: 'declaration', ...kept });
      continue;
    }
    const name = atRuleName(node.kind === 'rule' ? node.prelude : node.text);
    if (name === 'import') refuseImport();
    if (name !== undefined && SILENT_AT_RULES.has(name)) continue;
    if (name !== undefined && DROPPED_AT_RULES.has(name)) {
      scope.warn(`@${name} is not supported and was ignored.`);
      continue;
    }
    if (node.kind === 'statement') {
      out.push(node);
      continue;
    }
    out.push({ ...node, children: sanitizeNodes(node.children, scope, context, fontFace || name === 'font-face') });
  }
  return out;
}

/**
 * Text that is safe between <style> and </style>: only "</style" can end the element early,
 * and outside a string it is not valid CSS anyway.
 */
export function styleElementText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/** A whole stylesheet, sanitised and serialised. Throws ApiError('template_error') for @import and external @font-face. */
export function sanitizeStylesheet(css: string, scope: CssScope): string {
  return styleElementText(serializeCss(sanitizeNodes(parseCss(css), scope, 'sheet', false)));
}

/** The value of a style="" attribute, sanitised; '' when nothing is left. */
export function sanitizeInlineStyle(style: string, scope: CssScope): string {
  const kept: string[] = [];
  for (const declaration of parseInlineStyle(style)) {
    const clean = sanitizeDeclaration(declaration, scope, 'attribute', false);
    if (clean) kept.push(`${clean.name}:${clean.value}`);
  }
  return kept.join(';');
}

/** True when an attribute value (not style) contains a url(...) that is not a #fragment. */
export function hasExternalCssUrl(value: string): boolean {
  if (!/url\(/i.test(value)) return false;
  const targets = cssUrls(value);
  if ((withoutStrings(value).match(URL_FUNCTION) ?? []).length !== targets.length) return true;
  return targets.some((target) => !/^#[\w.-]+$/.test(target.trim()));
}

/** Notes bundled families named in an SVG font-family attribute. */
export function noteFontAttribute(value: string, fonts: FontUse): void {
  noteFonts({ name: 'font-family', value }, fonts);
}
