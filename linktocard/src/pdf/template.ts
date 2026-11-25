/**
 * PDF template language and sanitiser: HTML + CSS + data -> one self-contained HTML document
 * that the browser prints. Pure: no I/O. Remote images are inlined by a separate async step
 * (src/pdf/assets.ts), which is why preparePdfDocument() hands back the URLs it found.
 *
 * The language, applied on the parsed tree (never on the HTML source, so a value can only
 * ever become text or an attribute value, never markup):
 *
 *   {{key}}                       the value of data.key; a missing key is empty
 *   {{#items}} ... {{/items}}     the nodes in between, once per element of data.items; inside,
 *                                 {{key}} is the item's field first, then data.key
 *   {{^items}} ... {{/items}}     the nodes in between when data.items is empty or missing
 *   {{#key}} ... {{/key}}         the nodes in between when key has a non-empty value
 *   {{^key}} ... {{/key}}         ... when it is empty or missing
 *
 * Markers may sit in text between elements (around the <tr> rows of a <tbody>), and a section
 * must open and close among the children of one element. Templates never compute: totals and
 * taxes are sent by the caller as display strings.
 *
 * Sanitising, after placeholders are filled in:
 *   - removed with their content: <script>, <noscript>, <template>, <iframe>, <frame>,
 *     <frameset>, <object>, <embed>, <applet>, <param>, <base>, <meta>, <link>, <portal>,
 *     <fencedframe>, <xmp>, <noembed>, <noframes>, <plaintext>, <source>, <track>, <video>,
 *     <audio>, wherever they are (inside <svg> too); inside <svg> also the animation elements
 *   - every on* attribute; every URL-bearing attribute except <img src> and link targets
 *     (srcset, poster, background, action, formaction, ping, ...); src anywhere but <img>
 *   - link targets (<a>/<area> href, xlink:href) other than http(s):, mailto:, tel: and #id,
 *     so javascript: and vbscript: never survive; on other SVG elements only #id
 *   - <img src> must be an http(s) URL (inlined later) or a data:image URI; an <img> whose
 *     src is empty after substitution is left out, like an optional logo
 *   - CSS: see src/pdf/css.ts (@import and external @font-face refused, url() inlined)
 *   - form controls render, but forms are inert: action and formaction are removed
 *
 * The result: <!doctype html><html><head><meta charset="utf-8"><style>fonts + css</style>
 * [<title>]</head><body>...</body></html>, serialised with domutils.
 */
import { Element, Text, isTag, isText, type ChildNode } from 'domhandler';
import { getOuterHTML } from 'domutils';
import { parseDocument } from 'htmlparser2';
import { LIMITS, PDF } from '../config';
import { ApiError } from '../lib/errors';
import { codePointLength, isJsonObject } from '../lib/http';
import { hasExternalCssUrl, noteFontAttribute, remoteUrl, sanitizeInlineStyle, sanitizeStylesheet, type AssetContext, type CssScope, type FontUse, type Warn } from './css';
import type { PdfData, PdfItem } from './templates/types';

export type { PdfData, PdfItem } from './templates/types';

/** Bundled @font-face rules for the families a document names (src/pdf/fonts.ts in the Worker). */
export type FontFaces = (families: ReadonlySet<string>, text: string) => string;

export interface PdfDocumentInput {
  html: string;
  css: string;
  data: PdfData;
}

export interface PdfBuildOptions {
  /** Without it no font is embedded (the browser's own fonts apply); the Worker passes bundledFontFaces. */
  fontFaces?: FontFaces;
}

/**
 * A sanitised document or header/footer whose remote images are not fetched yet. render()
 * writes each URL's replacement (a data: URI from the asset step) or, when `resolve` returns
 * undefined, the URL itself.
 */
export interface PreparedPdfHtml {
  /** Distinct absolute http(s) URLs of <img src> and CSS url(), in order of first use. */
  remoteUrls: string[];
  warnings: string[];
  render(resolve: (url: string) => string | undefined): string;
}

type Attributes = Record<string, string>;

interface TplElement {
  kind: 'element';
  name: string;
  svg: boolean;
  attrs: Attributes;
  children: TplNode[];
}
interface TplText {
  kind: 'text';
  text: string;
}
interface TplSection {
  kind: 'section';
  name: string;
  inverted: boolean;
  children: TplNode[];
}
type TplNode = TplElement | TplText | TplSection;
interface Marker {
  kind: 'marker';
  type: '#' | '^' | '/';
  name: string;
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
const MARKER = /\{\{\s*([#^/])\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;
const ANY_MARKER = /\{\{\s*[#^/]/;
const LIST_KEY = 'items';

const WRAPPERS = new Set(['html', 'head', 'body']);
const WRAPPER_ATTRIBUTES = new Set(['class', 'id', 'style', 'dir', 'lang']);
/**
 * Removed with everything inside them, inside <svg> too: a browser's HTML parser lets some of
 * them (<meta>, <embed>) break out of SVG, and a <foreignObject> holds HTML. None is an SVG element.
 */
const DROPPED_ELEMENTS = new Set([
  ...['script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param'],
  ...['base', 'meta', 'link', 'portal', 'fencedframe'],
  // Raw-text elements: their text would be written unescaped, so a value placed there could become markup.
  ...['xmp', 'noembed', 'noframes', 'plaintext'],
  // URL-bearing media that a PDF cannot play.
  ...['source', 'track', 'video', 'audio'],
]);
/** Also removed inside <svg> (compared in lower case). Animations can rewrite attributes such as href. */
const DROPPED_SVG_ELEMENTS = new Set(['animate', 'animatemotion', 'animatetransform', 'set', 'discard', 'handler', 'listener']);
/** Attributes that make a browser load or send something, and that a PDF never needs. */
const URL_ATTRIBUTES = new Set([
  ...['srcset', 'imagesrcset', 'imagesizes', 'poster', 'background', 'lowsrc', 'dynsrc', 'longdesc', 'ping'],
  ...['action', 'formaction', 'manifest', 'codebase', 'archive', 'classid', 'profile', 'icon', 'srcdoc', 'data', 'xml:base'],
]);
/** Removed without a warning: a lazy image might not be loaded before the page is printed. */
const SILENT_ATTRIBUTES = new Set(['loading']);
const HREF_ATTRIBUTES = new Set(['href', 'xlink:href']);
const LINK_SCHEMES = /^(?:https?:|mailto:|tel:)/;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;
const ELEMENT_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const ATTRIBUTE_NAME = /^[A-Za-z_][\w:.-]*$/;

function templateError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('template_error', message, details ? { details } : {});
}

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

function megabytesOrKilobytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

function assertSourceSize(what: string, text: string, limit: number): void {
  // UTF-8 never takes fewer bytes than UTF-16 code units, so short sources skip the encoding.
  if (text.length * 3 <= limit) return;
  const bytes = utf8Length(text);
  if (bytes > limit) {
    throw templateError(`${what} is ${bytes} bytes; the limit is ${megabytesOrKilobytes(limit)}.`, { bytes, limit });
  }
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function assertKey(key: string, where: string): void {
  if (!LIMITS.dataKeyPattern.test(key)) {
    throw invalid(
      `${where} key "${key.slice(0, 40)}" is not valid. Keys start with a lower-case letter and contain only a-z, 0-9 and "_" (at most 32 characters).`,
    );
  }
}

function flatValue(value: unknown, what: string, maxChars: number): string | number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (value.length > maxChars && codePointLength(value) > maxChars) throw invalid(`${what} is longer than ${maxChars} characters.`);
    return value;
  }
  if (typeof value === 'boolean') throw invalid(`${what} must be text or a number. Send true/false as text, for example "yes".`);
  throw invalid(`${what} must be text or a number. Only "${LIST_KEY}" may be a list (of objects with text or number fields).`);
}

function validateItems(value: unknown): PdfItem[] {
  if (!Array.isArray(value)) throw invalid(`"${LIST_KEY}" must be a list of objects, for example [{"description": "Design", "amount": "1,200.00"}].`);
  if (value.length > PDF.maxItems) throw invalid(`"${LIST_KEY}" may have at most ${PDF.maxItems} entries; this one has ${value.length}.`);
  return value.map((entry, index) => {
    const where = `${LIST_KEY}[${index}]`;
    if (!isJsonObject(entry)) throw invalid(`${where} must be an object of text or number fields.`);
    const fields = Object.entries(entry);
    if (fields.length > PDF.maxItemFields) throw invalid(`${where} may have at most ${PDF.maxItemFields} fields; it has ${fields.length}.`);
    const item: PdfItem = {};
    for (const [key, field] of fields) {
      assertKey(key, where);
      if (field === null) continue;
      item[key] = flatValue(field, `${where}.${key}`, PDF.maxItemValueChars);
    }
    return item;
  });
}

/**
 * The one validator for PDF `data`: at most PDF.maxDataKeys keys of text or numbers (null
 * counts as missing), plus at most one list, `items`, of flat objects. Throws
 * ApiError('invalid_request') with a message that says what to fix.
 */
export function validatePdfData(input: unknown): PdfData {
  if (input === undefined || input === null) return {};
  if (!isJsonObject(input)) throw invalid('"data" must be an object, for example {"invoice_number": "2026-001", "items": [...]}.');
  const entries = Object.entries(input);
  if (entries.length > PDF.maxDataKeys) throw invalid(`"data" may contain at most ${PDF.maxDataKeys} keys; this one has ${entries.length}.`);
  const data: PdfData = {};
  for (const [key, value] of entries) {
    assertKey(key, '"data"');
    if (value === null) continue;
    data[key] = key === LIST_KEY ? validateItems(value) : flatValue(value, `Data value "${key}"`, PDF.maxDataValueChars);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Parsing (static: everything that does not depend on data)           */
/* ------------------------------------------------------------------ */

interface ParseState {
  /** A header/footer template: there are no wrappers or <title>. */
  fragment: boolean;
  elements: number;
  styles: string[];
  title: TplNode[] | null;
  htmlAttrs: Attributes;
  bodyAttrs: Attributes;
  warn: Warn;
}

function textOf(element: Element): string {
  return element.children.map((child) => (isText(child) ? child.data : '')).join('');
}

function staticAttributes(element: Element, name: string, svg: boolean, warn: Warn): Attributes {
  const attrs: Attributes = {};
  for (const [rawName, value] of Object.entries(element.attribs)) {
    const lower = rawName.toLowerCase();
    // HTML attribute names are case-insensitive; SVG ones (viewBox, gradientUnits) are not.
    const attribute = svg ? rawName : lower;
    if (!ATTRIBUTE_NAME.test(attribute)) {
      warn(`Attribute "${rawName.slice(0, 40)}" is not supported and was removed.`);
    } else if (lower.startsWith('on')) {
      warn('Event handler attributes (on*) were removed.');
    } else if (SILENT_ATTRIBUTES.has(lower)) {
      // dropped on purpose, see SILENT_ATTRIBUTES
    } else if (URL_ATTRIBUTES.has(lower)) {
      warn(`"${lower}" on <${name}> was removed: nothing is downloaded while a PDF renders. Use <img src> or CSS url() for images.`);
    } else if (lower === 'src' && (svg || name !== 'img')) {
      warn(`src on <${name}> was removed; only <img src> can load an image.`);
    } else if (HREF_ATTRIBUTES.has(lower) && !svg && name !== 'a' && name !== 'area') {
      warn(`${lower} on <${name}> was removed.`);
    } else if (ANY_MARKER.test(value)) {
      throw templateError(`Sections ({{#...}}, {{^...}}, {{/...}}) can only be used in text, not in the "${lower}" attribute of <${name}>.`);
    } else {
      attrs[attribute] = value;
    }
  }
  return attrs;
}

function splitMarkers(text: string): Array<TplText | Marker> {
  if (!ANY_MARKER.test(text)) return [{ kind: 'text', text }];
  const parts: Array<TplText | Marker> = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) });
    parts.push({ kind: 'marker', type: match[1] as Marker['type'], name: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

const markerText = (section: Pick<TplSection, 'name' | 'inverted'>): string => `{{${section.inverted ? '^' : '#'}${section.name}}}`;

/** Turns the markers among one element's children into nested sections. */
function buildSections(parts: ReadonlyArray<TplNode | Marker>): TplNode[] {
  const root: TplNode[] = [];
  const stack: Array<{ section: TplSection | null; children: TplNode[] }> = [{ section: null, children: root }];
  for (const part of parts) {
    const top = stack[stack.length - 1]!;
    if (part.kind !== 'marker') {
      top.children.push(part);
      continue;
    }
    if (part.type === '/') {
      if (!top.section) throw templateError(`{{/${part.name}}} has no matching {{#${part.name}}} or {{^${part.name}}} inside the same element.`);
      if (top.section.name !== part.name) {
        throw templateError(`{{/${part.name}}} closes ${markerText(top.section)}; close the inner section first, inside the same element.`);
      }
      stack.pop();
      continue;
    }
    const section: TplSection = { kind: 'section', name: part.name, inverted: part.type === '^', children: [] };
    top.children.push(section);
    stack.push({ section, children: section.children });
  }
  const open = stack[stack.length - 1]!.section;
  if (open) throw templateError(`${markerText(open)} is not closed by {{/${open.name}}} inside the same element.`);
  return root;
}

function convertChildren(nodes: readonly ChildNode[], svg: boolean, depth: number, state: ParseState): TplNode[] {
  if (depth > PDF.maxDepth) throw templateError(`Elements are nested more than ${PDF.maxDepth} levels deep.`);
  const parts: Array<TplNode | Marker> = [];
  for (const node of nodes) {
    if (isText(node)) parts.push(...splitMarkers(node.data));
    else if (isTag(node)) parts.push(...convertElement(node, svg, depth, state));
    // Comments, doctype, CDATA and processing instructions are not rendered.
  }
  return buildSections(parts);
}

function convertElement(element: Element, parentIsSvg: boolean, depth: number, state: ParseState): TplNode[] {
  // htmlparser2 lower-cases HTML tag names and keeps the case of SVG ones (linearGradient).
  const name = element.name;
  const lower = name.toLowerCase();
  const svg = parentIsSvg || lower === 'svg';

  if (lower === 'style') {
    // Every <style> is moved out of the tree: to <head>, or to the top of a header/footer. Left
    // inside <svg>, a browser would parse its text as markup instead of as CSS.
    state.styles.push(textOf(element));
    return [];
  }
  if (!parentIsSvg && WRAPPERS.has(lower)) {
    if (!state.fragment && lower !== 'head') {
      const target = lower === 'html' ? state.htmlAttrs : state.bodyAttrs;
      for (const [attribute, value] of Object.entries(staticAttributes(element, lower, false, state.warn))) {
        if (WRAPPER_ATTRIBUTES.has(attribute) && !(attribute in target)) target[attribute] = value;
      }
    }
    return convertChildren(element.children, false, depth + 1, state);
  }
  if (!parentIsSvg && lower === 'title') {
    if (!state.fragment && state.title === null) state.title = convertChildren(element.children, false, depth + 1, state);
    return [];
  }
  if (DROPPED_ELEMENTS.has(lower) || (parentIsSvg && DROPPED_SVG_ELEMENTS.has(lower))) {
    state.warn(`<${lower}>${parentIsSvg ? ' inside <svg>' : ''} is not allowed in PDF documents and was removed.`);
    return [];
  }
  if (!ELEMENT_NAME.test(name)) {
    state.warn(`<${name.slice(0, 40)}> is not a valid element name and was removed.`);
    return [];
  }
  if (++state.elements > PDF.maxElements) throw templateError(`The template has more than ${PDF.maxElements} elements.`);
  return [
    {
      kind: 'element',
      name,
      svg,
      attrs: staticAttributes(element, lower, svg, state.warn),
      children: convertChildren(element.children, svg, depth + 1, state),
    },
  ];
}

/** {{#items}} inside {{#items}} would repeat the whole list for every item. */
function assertNoNestedList(nodes: readonly TplNode[], insideList: boolean): void {
  for (const node of nodes) {
    if (node.kind === 'text') continue;
    const opensList = node.kind === 'section' && node.name === LIST_KEY && !node.inverted;
    if (opensList && insideList) throw templateError(`{{#${LIST_KEY}}} cannot be used inside another {{#${LIST_KEY}}} section.`);
    assertNoNestedList(node.children, insideList || opensList);
  }
}

interface ParsedPdfTemplate {
  children: TplNode[];
  styles: string[];
  title: TplNode[] | null;
  htmlAttrs: Attributes;
  bodyAttrs: Attributes;
}

function parseTemplate(html: string, fragment: boolean, warn: Warn): ParsedPdfTemplate {
  const state: ParseState = { fragment, elements: 0, styles: [], title: null, htmlAttrs: {}, bodyAttrs: {}, warn };
  const document = parseDocument(html, { lowerCaseAttributeNames: false });
  const children = convertChildren(document.children, false, 0, state);
  assertNoNestedList(children, false);
  if (state.title) assertNoNestedList(state.title, false);
  return { children, styles: state.styles, title: state.title, htmlAttrs: state.htmlAttrs, bodyAttrs: state.bodyAttrs };
}

/* ------------------------------------------------------------------ */
/* Binding (per render: data, sanitising, assets)                      */
/* ------------------------------------------------------------------ */

interface Scope {
  data: PdfData;
  item: PdfItem | null;
}

interface AssetRef {
  url: string;
  context: AssetContext;
}

interface BindState {
  css: CssScope;
  /** Output elements and characters so far: sections can multiply a small template. */
  elements: number;
  chars: number;
  /** Text of the document, for choosing font subsets. */
  text: string[];
}

function lookup(scope: Scope, key: string): string {
  // Keys such as "constructor" are valid placeholders; never read them off the prototype.
  if (scope.item && Object.hasOwn(scope.item, key)) return String(scope.item[key]);
  const value = Object.hasOwn(scope.data, key) ? scope.data[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function substitute(text: string, scope: Scope, state: BindState): string {
  const out = text.includes('{{') ? text.replace(PLACEHOLDER, (_match, key: string) => lookup(scope, key)) : text;
  state.chars += out.length;
  if (state.chars > PDF.maxHtmlBytes) {
    throw templateError(`The document is larger than ${megabytesOrKilobytes(PDF.maxHtmlBytes)} once placeholders and sections are filled in.`, {
      limit: PDF.maxHtmlBytes,
    });
  }
  return out;
}

/** URL text as a browser reads it: without ASCII white space and control characters, lower case. */
const compactUrl = (value: string): string => value.replace(/[\u0000- \u007f]+/g, '').toLowerCase();

function imageSource(value: string, state: BindState): string | null | undefined {
  const target = value.trim();
  if (target === '') return null;
  if (DATA_IMAGE.test(compactUrl(target))) return target;
  const remote = remoteUrl(target);
  if (remote) return state.css.collect(remote, 'attribute');
  state.css.warn(`<img src="${target.slice(0, 80)}"> was removed: use an absolute http(s) URL or a data:image URI.`);
  return undefined;
}

function linkTarget(element: TplElement, value: string, warn: Warn): string | undefined {
  const compact = compactUrl(value);
  const lower = element.name.toLowerCase();
  if (compact.startsWith('#')) return value;
  const isLink = element.svg ? lower === 'a' : lower === 'a' || lower === 'area';
  if (isLink && LINK_SCHEMES.test(compact)) return value;
  if (element.svg && (lower === 'image' || lower === 'feimage') && DATA_IMAGE.test(compact)) return value;
  if (/^(?:javascript|vbscript):/.test(compact)) warn('javascript: and vbscript: links were removed.');
  else if (isLink) warn(`A link to "${value.slice(0, 80)}" was removed: links may use https:, http:, mailto:, tel: or #id.`);
  else warn(`A reference to "${value.slice(0, 80)}" on <${element.name}> inside <svg> was removed: only #id references are allowed there.`);
  return undefined;
}

/** Attributes after substitution and sanitising; null when the element must be left out. */
function bindAttributes(element: TplElement, scope: Scope, state: BindState): Attributes | null {
  const out: Attributes = {};
  for (const [name, raw] of Object.entries(element.attrs)) {
    const value = substitute(raw, scope, state);
    const lower = name.toLowerCase();
    if (lower === 'style') {
      const style = sanitizeInlineStyle(value, state.css);
      if (style !== '') out[name] = style;
    } else if (lower === 'src') {
      // Static rules keep src only on <img>. An empty one is an optional image without a value.
      const src = imageSource(value, state);
      if (src === null) return null;
      if (src !== undefined) out[name] = src;
    } else if (HREF_ATTRIBUTES.has(lower)) {
      const href = linkTarget(element, value, state.css.warn);
      if (href !== undefined) out[name] = href;
    } else if (hasExternalCssUrl(value)) {
      state.css.warn(`Attribute "${name}" on <${element.name}> referenced a url(...) and was removed.`);
    } else {
      if (element.svg && lower === 'font-family') noteFontAttribute(value, state.css.fonts);
      out[name] = value;
    }
  }
  return out;
}

function adopt(parent: Element, children: ChildNode[]): Element {
  parent.children = children;
  // dom-serializer reads `parent` to keep <style> text raw and to leave SVG's foreign mode.
  for (const child of children) child.parent = parent;
  return parent;
}

function bindNodes(nodes: readonly TplNode[], scope: Scope, state: BindState, out: ChildNode[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      const text = substitute(node.text, scope, state);
      if (text === '') continue;
      state.text.push(text);
      out.push(new Text(text));
    } else if (node.kind === 'section') {
      bindSection(node, scope, state, out);
    } else {
      const attrs = bindAttributes(node, scope, state);
      if (attrs === null) continue;
      if (++state.elements > PDF.maxElements) {
        throw templateError(`The document has more than ${PDF.maxElements} elements once {{#${LIST_KEY}}} sections are filled in.`);
      }
      const children: ChildNode[] = [];
      bindNodes(node.children, scope, state, children);
      out.push(adopt(new Element(node.name, attrs), children));
    }
  }
}

function bindSection(section: TplSection, scope: Scope, state: BindState, out: ChildNode[]): void {
  if (section.name === LIST_KEY) {
    const list = Array.isArray(scope.data[LIST_KEY]) ? (scope.data[LIST_KEY] as PdfItem[]) : [];
    if (section.inverted) {
      if (list.length === 0) bindNodes(section.children, scope, state, out);
      return;
    }
    for (const item of list) bindNodes(section.children, { data: scope.data, item }, state, out);
    return;
  }
  const present = lookup(scope, section.name).trim() !== '';
  if (present !== section.inverted) bindNodes(section.children, scope, state, out);
}

/* ------------------------------------------------------------------ */
/* Assets and serialisation                                            */
/* ------------------------------------------------------------------ */

const SERIALIZE = { encodeEntities: 'utf8' } as const;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function escapeAttributeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Collects remote URLs and writes an unguessable token in their place; render() swaps each
 * token for the resolved value. Tokens are letters and digits only, so the serialiser leaves
 * them alone in attributes and in CSS.
 */
class AssetTokens {
  private readonly nonce = randomToken();
  private readonly refs: AssetRef[] = [];
  private readonly byKey = new Map<string, number>();
  readonly urls: string[] = [];

  readonly collect = (url: string, context: AssetContext): string => {
    const key = `${context}\n${url}`;
    let index = this.byKey.get(key);
    if (index === undefined) {
      if (!this.urls.includes(url)) {
        if (this.urls.length >= PDF.maxRemoteAssets) {
          throw templateError(`The document references more than ${PDF.maxRemoteAssets} different remote images. Embed some as data: URIs.`, {
            limit: PDF.maxRemoteAssets,
          });
        }
        this.urls.push(url);
      }
      index = this.refs.length;
      this.refs.push({ url, context });
      this.byKey.set(key, index);
    }
    return `ltcasset${this.nonce}x${index}x`;
  };

  replace(html: string, resolve: (url: string) => string | undefined): string {
    if (this.refs.length === 0) return html;
    return html.replace(new RegExp(`ltcasset${this.nonce}x(\\d+)x`, 'g'), (_match, index: string) => {
      const ref = this.refs[Number(index)]!;
      const value = resolve(ref.url) ?? ref.url;
      return ref.context === 'attribute' ? escapeAttributeText(value) : value;
    });
  }
}

function openTag(name: string, attrs: Attributes): string {
  const html = getOuterHTML(new Element(name, attrs), SERIALIZE);
  return html.slice(0, html.length - `</${name}>`.length);
}

function newScope(fonts: FontUse, warnings: Set<string>, tokens: AssetTokens): CssScope {
  return { collect: tokens.collect, warn: (message) => warnings.add(message), fonts };
}

function wrapperAttributes(attrs: Attributes, scope: Scope, state: BindState): Attributes {
  return bindAttributes({ kind: 'element', name: 'body', svg: false, attrs, children: [] }, scope, state) ?? {};
}

/**
 * Sanitises a document and fills in its data without fetching anything. Throws
 * ApiError('template_error') for markup or CSS that cannot be used and for oversize input,
 * ApiError('invalid_request') for data that breaks the data limits.
 */
export function preparePdfDocument(input: PdfDocumentInput, options: PdfBuildOptions = {}): PreparedPdfHtml {
  assertSourceSize('The template HTML', input.html, PDF.maxHtmlBytes);
  assertSourceSize('The template CSS', input.css, PDF.maxCssBytes);
  const data = validatePdfData(input.data);
  const warnings = new Set<string>();
  const tokens = new AssetTokens();
  const fonts: FontUse = new Set();
  const css = newScope(fonts, warnings, tokens);

  const parsed = parseTemplate(input.html, false, css.warn);
  const sheets = [...parsed.styles, input.css].map((sheet) => sanitizeStylesheet(sheet, css)).filter((sheet) => sheet !== '');

  const state: BindState = { css, elements: 0, chars: 0, text: [] };
  const scope: Scope = { data, item: null };
  const body: ChildNode[] = [];
  bindNodes(parsed.children, scope, state, body);
  const bodyHtml = getOuterHTML(body, SERIALIZE);
  const bodyBytes = utf8Length(bodyHtml);
  if (bodyBytes > PDF.maxHtmlBytes) {
    throw templateError(`The document is ${bodyBytes} bytes once placeholders are filled in; the limit is ${megabytesOrKilobytes(PDF.maxHtmlBytes)}.`, {
      bytes: bodyBytes,
      limit: PDF.maxHtmlBytes,
    });
  }

  let title = '';
  if (parsed.title) {
    const parts: ChildNode[] = [];
    bindNodes(parsed.title, scope, state, parts);
    const text = parts.map((node) => (isText(node) ? node.data : '')).join('').replace(/\s+/g, ' ').trim();
    if (text !== '') title = getOuterHTML(new Element('title', {}, [new Text(text)]), SERIALIZE);
  }
  const htmlTag = openTag('html', wrapperAttributes(parsed.htmlAttrs, scope, state));
  const bodyTag = openTag('body', wrapperAttributes(parsed.bodyAttrs, scope, state));
  const sheetText = sheets.join('\n');
  const fontCss = options.fontFaces ? options.fontFaces(fonts, `${state.text.join('')}${sheetText}`) : '';
  const document =
    `<!doctype html>${htmlTag}<head><meta charset="utf-8"><style>${fontCss}${sheetText}</style>${title}</head>` + `${bodyTag}${bodyHtml}</body></html>`;

  return {
    remoteUrls: [...tokens.urls],
    warnings: [...warnings],
    render: (resolve) => tokens.replace(document, resolve),
  };
}

/**
 * A customer header or footer template (Chrome's headerTemplate / footerTemplate) with the
 * same sanitising and placeholders as the document. The browser renders it as a separate small
 * document, so its <style> elements are kept, moved to the top of the fragment. Chrome fills in
 * elements with the classes pageNumber, totalPages, date and title.
 */
export function preparePdfFragment(source: string, data: PdfData, what: 'header' | 'footer'): PreparedPdfHtml {
  assertSourceSize(`The ${what} template`, source, PDF.maxHeaderFooterBytes);
  const warnings = new Set<string>();
  const tokens = new AssetTokens();
  const css = newScope(new Set(), warnings, tokens);
  const parsed = parseTemplate(source, true, css.warn);
  const state: BindState = { css, elements: 0, chars: 0, text: [] };
  const styles = parsed.styles.map((sheet) => sanitizeStylesheet(sheet, css)).filter((sheet) => sheet !== '');
  const nodes: ChildNode[] = [];
  bindNodes(parsed.children, { data: validatePdfData(data), item: null }, state, nodes);
  const html = `${styles.length > 0 ? `<style>${styles.join('\n')}</style>` : ''}${getOuterHTML(nodes, SERIALIZE)}`;
  return { remoteUrls: [...tokens.urls], warnings: [...warnings], render: (resolve) => tokens.replace(html, resolve) };
}

/**
 * The sanitised document with sections expanded and placeholders filled in, remote image
 * URLs left as they are (the engine inlines them afterwards). Pure.
 */
export function buildPdfDocument(input: PdfDocumentInput, options: PdfBuildOptions = {}): string {
  return preparePdfDocument(input, options).render(() => undefined);
}
