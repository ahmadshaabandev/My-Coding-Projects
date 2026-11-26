/**
 * CSS for PDF documents: every stylesheet (<style> elements, the request's "css", header and
 * footer templates) and every style="" attribute passes through here before the browser sees it.
 *
 * Chrome understands all of CSS, so unlike the image renderer nothing is mapped or simplified.
 * This module only makes sure the document cannot reach the network:
 *
 *   @import                          refused (template_error): CSS must come with the request
 *   @font-face with a non-data: url  refused (template_error): fonts are bundled or embedded
 *   @page (anywhere, also nested)    dropped with a warning: paper size, orientation and margins
 *                                    come from the request's "pdf" (Chrome would let @page
 *                                    margins override them, and take room from the free mark)
 *   <!-- and --> before a rule       removed at the top level, where Chrome skips them, so
 *                                    "<!-- @page" is an @page rule here too; a nested rule that
 *                                    starts with them is dropped (Chrome ignores it)
 *   url(https://...)                 handed to the asset collector, which inlines it as data:
 *   url(#id), url(data:...)          kept
 *   any other url(...)               the declaration is dropped
 *   escapes that could spell url(    the declaration is dropped
 *   image-set("...") with strings    the declaration is dropped (strings there are URLs)
 *   image-set() with var()           the declaration is dropped (var() can bring in such a string)
 *   a string with a raw line break   refused (template_error): Chrome would end the string there
 *                                    and read the rest as CSS the sanitiser never saw
 *   src("...")                       the declaration is dropped (its string is a URL)
 *   url( with "(" or a quote in an   the declaration, rule or statement is dropped: Chrome ends
 *   address not in quotes            that url( at its first ")", while the tokenizer here would
 *                                    read on (see urlTokens)
 *   url( in a selector or at-rule    the rule or statement is dropped: url() is never valid there
 *   prelude                          (@import and @namespace are handled first)
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
/** The page box is set by the request's "pdf" alone. */
const PAGE_AT_RULE_WARNING = 'Page size, orientation and margins come from "pdf" (format, landscape, margin); the CSS @page rule was ignored.';
const PRELUDE_URL_WARNING = 'A CSS rule with url(...) in its selector or at-rule prelude was ignored: url() belongs in declarations only.';
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

const isLineBreak = (ch: string | undefined): boolean => ch === '\n' || ch === '\r' || ch === '\f';

/**
 * The text with every string literal removed (escapes inside strings handled). Like CSS, a
 * string ends at an unescaped line break (sanitizeStylesheet refuses such text beforehand).
 */
export function withoutStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && !isLineBreak(text[j])) j += text[j] === '\\' ? 2 : 1;
      i = isLineBreak(text[j]) ? j : j + 1;
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Refuses CSS with a "bad string": a quoted string with an unescaped line break before its
 * closing quote. A browser ends the string at the line break and reads what follows as new
 * declarations or rules, which the tokenizer here (shared with the card renderer) would read as
 * part of one string - so the sanitiser and Chrome would disagree about what the CSS says.
 */
function assertNoBadStrings(css: string): void {
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    // An unquoted url(...) is one token up to its ")": a quote inside it does not start a string.
    if ((ch === 'u' || ch === 'U') && /^url\(\s*[^\s"')]/i.test(css.slice(i, i + 6)) && !/[\w-]/.test(css[i - 1] ?? '')) {
      const end = css.indexOf(')', i);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) {
        if (isLineBreak(css[j])) {
          throw new ApiError(
            'template_error',
            `A CSS string has a line break before its closing quote ("${preview(css.slice(i, j))}"). Close the quote on the same line; write \\A for a line break inside content.`,
          );
        }
        // An escaped line break (also CR LF) continues the string.
        j += css[j] === '\\' ? (css[j + 1] === '\r' && css[j + 2] === '\n' ? 3 : 2) : 1;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
}

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || isLineBreak(ch);
const isHexDigit = (ch: string | undefined): boolean => ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
/** A character that continues a CSS name: ASCII letters, digits, "_", "-" and everything non-ASCII. */
const isNameChar = (ch: string | undefined): boolean => ch !== undefined && (/^[\w-]$/.test(ch) || ch.charCodeAt(0) >= 0x80);

/** The character a CSS escape at `at` (a backslash not followed by a line break) stands for, and the index after it. */
function readEscape(text: string, at: number): { char: string; end: number } {
  let i = at + 1;
  if (!isHexDigit(text[i])) return { char: text[i] ?? '�', end: Math.min(text.length, i + 1) };
  let hex = '';
  while (hex.length < 6 && isHexDigit(text[i])) hex += text[i++];
  if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
  else if (isSpace(text[i])) i += 1;
  const code = parseInt(hex, 16);
  return { char: code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '�' : String.fromCodePoint(code), end: i };
}

/**
 * The url( tokens of one piece of CSS (a declaration value, a rule prelude, a statement), outside
 * strings, as Chrome's tokenizer finds them. `found`: some name that ends in "url" (any case, also
 * spelled with escapes such as "\\75rl") is directly followed by "(". `mismatch`: one of them is
 * not followed by a quote and, before its first unescaped ")", holds a "(" or a quote.
 *
 * Chrome reads such a url( as one token up to that ")" (a "bad url"), whatever is inside. The
 * tokenizer here (src/render/css.ts, shared with the card renderer) counts the "(" as a nested
 * parenthesis and the quote as the start of a string, so it would read on past Chrome's ")"
 * across "}", "{" and ";": text it puts inside a value or a prelude would reach Chrome as new
 * rules (@page, @import, @font-face) that were never inspected. Any name ending in "url" counts,
 * not only "url" itself, so that what comes before it never matters ("<!--url(", "U+0url(").
 */
export function urlTokens(text: string): { found: boolean; mismatch: boolean } {
  let found = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && !isLineBreak(text[j])) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    const escape = ch === '\\' && !isLineBreak(text[i + 1]) && i + 1 < text.length;
    if (!isNameChar(ch) && !escape) {
      i++;
      continue;
    }
    let name = '';
    let j = i;
    while (j < text.length) {
      if (text[j] === '\\') {
        if (j + 1 >= text.length || isLineBreak(text[j + 1])) break;
        const decoded = readEscape(text, j);
        name += decoded.char;
        j = decoded.end;
      } else if (isNameChar(text[j])) {
        name += text[j++];
      } else {
        break;
      }
    }
    i = j;
    if (text[j] !== '(' || !name.toLowerCase().endsWith('url')) continue;
    found = true;
    let k = j + 1;
    while (isSpace(text[k])) k++;
    // url("...") is a function and a string, read alike by both tokenizers.
    if (text[k] === '"' || text[k] === "'") {
      i = k;
      continue;
    }
    for (; k < text.length && text[k] !== ')'; k++) {
      if (text[k] === '\\') k++;
      else if (text[k] === '(' || text[k] === '"' || text[k] === "'") return { found, mismatch: true };
    }
    i = k + 1;
  }
  return { found, mismatch: false };
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
  if (urlTokens(value).mismatch) {
    scope.warn(`url(...) in "${property}" has "(" or a quote in an address that is not in quotes, and was removed; write it as url("...").`);
    return undefined;
  }
  const bare = withoutStrings(value);
  if (bare.includes('\\') && bare.includes('(')) {
    scope.warn(`A CSS value of "${property}" uses escape sequences together with a function and was removed.`);
    return undefined;
  }
  if (SRC_FUNCTION.test(bare)) {
    scope.warn(`src(...) in "${property}" is not supported and was removed; use url().`);
    return undefined;
  }
  // image-set() takes plain strings as URLs, and var() could bring one in from a custom property.
  if (/image-set\(/i.test(bare) && /var\(/i.test(bare)) {
    scope.warn(`image-set() with var() in "${property}" is not supported and was removed; write the url() inside image-set().`);
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

/** <!-- and --> (CDO and CDC) with the white space around them, at the start of a rule. */
const LEADING_CDO_CDC = /^(?:\s*(?:<!--|-->))+\s*/;

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

function sanitizeNodes(nodes: readonly CssNode[], scope: CssScope, context: AssetContext, fontFace: boolean, topLevel: boolean): CssNode[] {
  const out: CssNode[] = [];
  for (const raw of nodes) {
    if (raw.kind === 'declaration') {
      const kept = sanitizeDeclaration(raw, scope, context, fontFace);
      if (kept) out.push({ kind: 'declaration', ...kept });
      continue;
    }
    // Chrome skips <!-- and --> at the top level of a stylesheet: "<!-- @page {...}" is an
    // @page rule. Anywhere else they make the rule invalid, and Chrome ignores it.
    const text = raw.kind === 'rule' ? raw.prelude : raw.text;
    const leading = LEADING_CDO_CDC.exec(text)?.[0] ?? '';
    if (leading !== '' && !topLevel) continue;
    const rest = text.slice(leading.length);
    if (leading !== '' && rest === '') continue;
    const node: CssNode = raw.kind === 'rule' ? { ...raw, prelude: rest } : { kind: 'statement', text: rest };
    const name = atRuleName(rest);
    if (name === 'import') refuseImport();
    if (name !== undefined && SILENT_AT_RULES.has(name)) continue;
    if (name !== undefined && DROPPED_AT_RULES.has(name)) {
      scope.warn(`@${name} is not supported and was ignored.`);
      continue;
    }
    if (name === 'page') {
      scope.warn(PAGE_AT_RULE_WARNING);
      continue;
    }
    // url() is never valid in a selector or an at-rule prelude, and one with "(" or a quote in
    // it would end, for Chrome, inside this prelude (urlTokens): the whole rule goes.
    if (urlTokens(rest).found) {
      scope.warn(PRELUDE_URL_WARNING);
      continue;
    }
    if (node.kind === 'statement') {
      out.push(node);
      continue;
    }
    out.push({ ...node, children: sanitizeNodes(node.children, scope, context, fontFace || name === 'font-face', false) });
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

/** A whole stylesheet, sanitised and serialised. Throws ApiError('template_error') for @import, external @font-face and bad strings. */
export function sanitizeStylesheet(css: string, scope: CssScope): string {
  assertNoBadStrings(css);
  return styleElementText(serializeCss(sanitizeNodes(parseCss(css), scope, 'sheet', false, true)));
}

/** The value of a style="" attribute, sanitised; '' when nothing is left. */
export function sanitizeInlineStyle(style: string, scope: CssScope): string {
  assertNoBadStrings(style);
  const kept: string[] = [];
  for (const declaration of parseInlineStyle(style)) {
    const clean = sanitizeDeclaration(declaration, scope, 'attribute', false);
    if (clean) kept.push(`${clean.name}:${clean.value}`);
  }
  return kept.join(';');
}

/**
 * SVG presentation attributes: Chrome reads them as CSS values (lower case). Of these, fill,
 * stroke, clip-path, mask, filter, marker-* and cursor take url().
 */
export const SVG_PRESENTATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  ...['alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation', 'color-interpolation-filters'],
  ...['color-rendering', 'cursor', 'cx', 'cy', 'd', 'direction', 'display', 'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule', 'filter'],
  ...['flood-color', 'flood-opacity', 'font', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant'],
  ...['font-weight', 'height', 'image-rendering', 'letter-spacing', 'lighting-color', 'marker', 'marker-end', 'marker-mid', 'marker-start'],
  ...['mask', 'mask-type', 'opacity', 'overflow', 'paint-order', 'pointer-events', 'r', 'rx', 'ry', 'shape-rendering', 'stop-color'],
  ...['stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit'],
  ...['stroke-opacity', 'stroke-width', 'text-anchor', 'text-decoration', 'text-overflow', 'text-rendering', 'transform', 'transform-origin'],
  ...['unicode-bidi', 'vector-effect', 'visibility', 'white-space', 'width', 'word-spacing', 'writing-mode', 'x', 'y'],
]);

/**
 * True when an attribute value (not style) contains a url(...) that is not a #fragment.
 * `css` marks a value Chrome reads as CSS (an SVG presentation attribute on an SVG element):
 * there an escape can spell url( ("\\75rl("), so a backslash together with a "(" counts as one
 * too. Other attributes (title, alt, data-*) are never CSS, and a Windows path or a regex in
 * them is kept.
 */
export function hasExternalCssUrl(value: string, css: boolean): boolean {
  if (css && value.includes('\\') && value.includes('(')) return true;
  if (!/url\(/i.test(value)) return false;
  const targets = cssUrls(value);
  if ((withoutStrings(value).match(URL_FUNCTION) ?? []).length !== targets.length) return true;
  return targets.some((target) => !/^#[\w.-]+$/.test(target.trim()));
}

/** Notes bundled families named in an SVG font-family attribute. */
export function noteFontAttribute(value: string, fonts: FontUse): void {
  noteFonts({ name: 'font-family', value }, fonts);
}
