/**
 * Template compiler: HTML + CSS + data -> the element tree handed to Satori.
 *
 *   parseTemplate()  static: size limits, HTML parse, structure, disallowed markup
 *   bindTemplate()   per render: {{placeholders}}, state classes, text limit
 *   buildDocument()  per render: html > [style] + body > nodes, with every image
 *                    URL and font-family list passed through a resolver
 *
 * Placeholders are substituted on the parsed tree, never on the HTML source,
 * so a data value can only ever become text or an attribute value.
 */
import { isTag, isText, type ChildNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { LIMITS, SIZES } from '../config';
import { base64Encode } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { TemplateData } from '../types';
import {
  cssDeclarations,
  cssUrls,
  dropUnsupportedAtRules,
  fontVariableNames,
  isOpaqueFontShorthand,
  mapCssDeclarations,
  parseCss,
  parseInlineStyle,
  rewriteDeclaration,
  serializeCss,
  type CssDeclaration,
  type CssNode,
  type FontFamilyItem,
  type ValueRewriter,
} from './css';
import type { VNode } from './engine';

type Attributes = Record<string, string>;
type Warn = (message: string) => void;

export interface TemplateElement {
  tag: string;
  /** True for an inline <svg> element and everything inside it. */
  svg: boolean;
  attrs: Attributes;
  children: TemplateChild[];
}
export type TemplateChild = TemplateElement | string;

export interface ParsedTemplate {
  /** Attributes kept from the template's own <html> / <body> wrappers. */
  htmlAttrs: Attributes;
  bodyAttrs: Attributes;
  children: TemplateChild[];
  /** <style> elements in document order, then the css argument. */
  css: CssNode[];
  /** Placeholder keys used in text and attribute values, in order of first use. */
  placeholders: string[];
  warnings: string[];
}

/** Base stylesheet applied before template CSS. The docs print this verbatim. */
export const BASE_CSS = `*, *::before, *::after { box-sizing: border-box }
html, body { width: 100%; height: 100%; margin: 0; padding: 0 }
body { font-family: Inter; overflow: hidden; background: #ffffff; color: #111827 }
code, kbd, samp, pre { font-family: "JetBrains Mono" }`;

const BASE_CSS_NODES = parseCss(BASE_CSS);

/** Same syntax as data keys (LIMITS.dataKeyPattern), with optional inner spaces. */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

const WRAPPERS = new Set(['html', 'head', 'body']);
/** Wrapper attributes that still mean something on the generated <html> / <body>. */
const WRAPPER_ATTRIBUTES = new Set(['class', 'id', 'style', 'dir', 'lang']);

const DROPPED_ELEMENTS = new Set([
  ...['script', 'link', 'meta', 'title', 'base', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'template', 'noscript'],
  ...['form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter'],
  // Never rendered by Satori; removed so their URL attributes cannot matter.
  ...['source', 'track', 'param', 'area', 'map', 'frame', 'frameset', 'applet', 'math'],
]);
const DROPPED_SVG_ELEMENTS = new Set(['script', 'foreignObject', 'image', 'feImage', 'animate', 'animateMotion', 'animateTransform', 'set']);
const SVG_TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath']);
/** Laid out as plain boxes by Satori (it throws on display: table / ruby). */
const UNSUPPORTED_LAYOUT = new Set(['table', 'ruby']);

/** Names that are React/Satori props rather than attributes. */
const RESERVED_ATTRIBUTES = new Set(['children', 'key', 'ref', 'tw', 'dangerouslysetinnerhtml', '__proto__']);
const ATTRIBUTE_NAME = /^[A-Za-z_][\w:.-]*$/;
const HREF_ATTRIBUTES = new Set(['href', 'xlink:href', 'xlinkhref']);

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

function assertSourceSize(what: 'HTML' | 'CSS', text: string, limit: number): void {
  // UTF-8 never takes fewer bytes than UTF-16 code units, so short sources skip the encoding.
  if (text.length * 3 <= limit) return;
  const bytes = utf8Length(text);
  if (bytes > limit) {
    throw new ApiError('payload_too_large', `Template ${what} is ${bytes} bytes; the limit is ${limit} bytes.`, {
      details: { bytes, limit },
    });
  }
}

interface ParseState {
  elements: number;
  styles: string[];
  htmlAttrs: Attributes;
  bodyAttrs: Attributes;
  warn: Warn;
}

function keepAttributes(element: Element, tag: string, svg: boolean, warn: Warn): Attributes {
  const attrs: Attributes = {};
  for (const [rawName, value] of Object.entries(element.attribs)) {
    const lower = rawName.toLowerCase();
    // HTML attribute names are case-insensitive; SVG ones (viewBox, gradientUnits) are not.
    const name = svg ? rawName : lower;
    if (lower.startsWith('on')) {
      warn('Event handler attributes (on*) were removed.');
    } else if (!ATTRIBUTE_NAME.test(name) || RESERVED_ATTRIBUTES.has(lower)) {
      warn(`Attribute "${rawName.slice(0, 40)}" is not supported and was removed.`);
    } else if (lower === 'srcset' || lower === 'poster' || (lower === 'src' && (svg || tag !== 'img'))) {
      warn(`${lower} on <${tag}> is not supported and was removed; only <img src> and CSS url() can load images.`);
    } else if (HREF_ATTRIBUTES.has(lower) && !svg && tag !== 'a') {
      warn(`href on <${tag}> is not supported and was removed.`);
    } else {
      attrs[name] = value;
    }
  }
  return attrs;
}

function convertElement(element: Element, parentIsSvg: boolean, depth: number, nesting: number, state: ParseState): TemplateChild[] {
  // htmlparser2 lower-cases HTML tag names and keeps the case of SVG ones (linearGradient).
  const tag = element.name;
  const svg = parentIsSvg || tag === 'svg';

  if (tag === 'style') {
    state.styles.push(element.children.map((child) => (isText(child) ? child.data : '')).join(''));
    return [];
  }
  if (!parentIsSvg && WRAPPERS.has(tag)) {
    if (tag !== 'head') {
      const kept = keepAttributes(element, tag, false, state.warn);
      const target = tag === 'html' ? state.htmlAttrs : state.bodyAttrs;
      for (const [name, value] of Object.entries(kept)) if (WRAPPER_ATTRIBUTES.has(name)) target[name] = value;
    }
    return convertChildren(element.children, false, depth, nesting + 1, state);
  }
  if (parentIsSvg ? DROPPED_SVG_ELEMENTS.has(tag) : DROPPED_ELEMENTS.has(tag)) {
    state.warn(`<${tag}>${parentIsSvg ? ' inside inline <svg>' : ''} is not supported and was removed.`);
    return [];
  }
  if (parentIsSvg && SVG_TEXT_ELEMENTS.has(tag)) {
    throw new ApiError(
      'template_error',
      `<${tag}> inside inline <svg> is not supported. Convert the text to paths, or position an HTML element over the SVG.`,
    );
  }
  if (!svg && UNSUPPORTED_LAYOUT.has(tag)) {
    state.warn(`<${tag}> layout is not supported; its elements are laid out as plain boxes. Use flex or grid instead.`);
  }

  if (++state.elements > LIMITS.maxNodes) {
    throw new ApiError('template_error', `Template has more than ${LIMITS.maxNodes} elements.`);
  }
  if (depth > LIMITS.maxDepth) {
    throw new ApiError('template_error', `Template elements are nested more than ${LIMITS.maxDepth} levels deep.`);
  }
  return [
    {
      tag,
      svg,
      attrs: keepAttributes(element, tag, svg, state.warn),
      children: convertChildren(element.children, svg, depth + 1, nesting + 1, state),
    },
  ];
}

function convertChildren(nodes: ChildNode[], svg: boolean, depth: number, nesting: number, state: ParseState): TemplateChild[] {
  // Flattened wrappers do not count towards maxDepth, so the recursion needs its own bound.
  if (nesting > LIMITS.maxDepth + 4) {
    throw new ApiError('template_error', `Template elements are nested more than ${LIMITS.maxDepth} levels deep.`);
  }
  const out: TemplateChild[] = [];
  for (const node of nodes) {
    if (isText(node)) out.push(node.data);
    else if (isTag(node)) out.push(...convertElement(node, svg, depth, nesting, state));
    // Comments, doctype and processing instructions are not rendered.
  }
  return out;
}

function collectPlaceholders(children: readonly TemplateChild[], attributeSets: readonly Attributes[], keys: Set<string>): void {
  const scan = (text: string): void => {
    for (const match of text.matchAll(PLACEHOLDER)) keys.add(match[1]!);
  };
  for (const attrs of attributeSets) Object.values(attrs).forEach(scan);
  for (const child of children) {
    if (typeof child === 'string') scan(child);
    else collectPlaceholders(child.children, [child.attrs], keys);
  }
}

/**
 * Static compilation: everything that can be checked without data. Throws
 * ApiError('payload_too_large') for oversized sources and
 * ApiError('template_error') for structure the renderer cannot handle.
 */
export function parseTemplate(html: string, css: string): ParsedTemplate {
  assertSourceSize('HTML', html, LIMITS.maxHtmlBytes);
  assertSourceSize('CSS', css, LIMITS.maxCssBytes);

  const warnings = new Set<string>();
  const state: ParseState = { elements: 0, styles: [], htmlAttrs: {}, bodyAttrs: {}, warn: (message) => warnings.add(message) };
  const document = parseDocument(html, { lowerCaseAttributeNames: false });
  const children = convertChildren(document.children, false, 1, 0, state);

  // Each sheet is parsed on its own so an unclosed block cannot swallow the next one.
  const sheets = [...state.styles, css].flatMap((sheet) => parseCss(sheet));
  const placeholders = new Set<string>();
  collectPlaceholders(children, [state.htmlAttrs, state.bodyAttrs], placeholders);

  return {
    htmlAttrs: state.htmlAttrs,
    bodyAttrs: state.bodyAttrs,
    children,
    css: dropUnsupportedAtRules(sheets, state.warn),
    placeholders: [...placeholders],
    warnings: [...warnings],
  };
}

/* ------------------------------------------------------------------ */
/* Binding data                                                        */
/* ------------------------------------------------------------------ */

export interface BoundElement {
  tag: string;
  svg: boolean;
  /** Attributes after substitution, without style. */
  attrs: Attributes;
  style: CssDeclaration[];
  children: BoundChild[];
}
export type BoundChild = BoundElement | string;

export interface BoundTemplate {
  /** The generated <html> element; its only child is <body>. */
  html: BoundElement;
  css: CssNode[];
  warnings: string[];
}

const THEME = /^[a-z0-9-]{1,32}$/;

const dataValue = (data: TemplateData, key: string): string => {
  // Keys such as "constructor" are valid placeholders; never read them off the prototype.
  const value = Object.hasOwn(data, key) ? data[key] : undefined;
  return typeof value === 'string' ? value : '';
};

const substitute = (text: string, data: TemplateData): string =>
  text.includes('{{') ? text.replace(PLACEHOLDER, (_match, key: string) => dataValue(data, key)) : text;

function lengthClass(value: string): 's' | 'm' | 'l' | 'xl' {
  const length = [...value].length;
  if (length <= 30) return 's';
  if (length <= 60) return 'm';
  return length <= 100 ? 'l' : 'xl';
}

/** Classes added to <body> so plain CSS can adapt a design to its data and size. */
export function stateClasses(placeholders: readonly string[], data: TemplateData, size: { width: number; height: number }): string[] {
  const classes: string[] = [];
  const preset = Object.values(SIZES).find((candidate) => candidate.width === size.width && candidate.height === size.height);
  if (preset) classes.push(`size-${preset.id}`);
  const theme = dataValue(data, 'theme');
  if (THEME.test(theme)) classes.push(`theme-${theme}`);
  for (const key of placeholders) {
    const value = dataValue(data, key).trim();
    classes.push(value === '' ? `no-${key}` : `has-${key}`, `len-${key}-${lengthClass(value)}`);
  }
  return classes;
}

interface BindState {
  data: TemplateData;
  /** Static validation: attribute values that depend on data are skipped instead of checked. */
  staticOnly: boolean;
  textChars: number;
  warn: Warn;
}

function bindAttributes(element: TemplateElement, state: BindState): { attrs: Attributes; style: CssDeclaration[] } {
  const attrs: Attributes = {};
  let style: CssDeclaration[] = [];
  for (const [name, raw] of Object.entries(element.attrs)) {
    if (state.staticOnly && raw.search(PLACEHOLDER) >= 0) continue;
    const value = substitute(raw, state.data);
    const lower = name.toLowerCase();
    if (lower === 'style') {
      style = parseInlineStyle(value);
    } else if (element.svg && HREF_ATTRIBUTES.has(lower) && !value.trim().startsWith('#')) {
      state.warn(`${name} on <${element.tag}> inside inline <svg> may only reference an element of the same SVG (#id); it was removed.`);
    } else if (!(element.tag === 'img' && name === 'src') && cssUrls(value).some((target) => !target.trim().startsWith('#'))) {
      // Only style and <img src> may load resources; a url() anywhere else is never needed for layout.
      state.warn(`Attribute "${name}" on <${element.tag}> contains url(...) and was removed.`);
    } else {
      attrs[name] = value;
    }
  }
  return { attrs, style };
}

function bindChildren(children: readonly TemplateChild[], state: BindState): BoundChild[] {
  const out: BoundChild[] = [];
  for (const child of children) {
    if (typeof child === 'string') {
      const text = substitute(child, state.data);
      // White space collapses when rendered, so indentation does not count against the limit.
      state.textChars += text.replace(/\s+/g, ' ').trim().length;
      out.push(text);
      continue;
    }
    const { attrs, style } = bindAttributes(child, state);
    // An image without a source cannot be laid out; the usual cause is an empty optional value.
    if (child.tag === 'img' && !child.svg && (attrs.src ?? '').trim() === '') continue;
    out.push({ tag: child.tag, svg: child.svg, attrs, style, children: bindChildren(child.children, state) });
  }
  return out;
}

function bindWrapper(tag: 'html' | 'body', attributes: Attributes, extraClasses: readonly string[], children: BoundChild[], state: BindState): BoundElement {
  const { attrs, style } = bindAttributes({ tag, svg: false, attrs: attributes, children: [] }, state);
  const classes = [attrs.class ?? '', ...extraClasses].join(' ').trim();
  if (classes) attrs.class = classes;
  return { tag, svg: false, attrs, style, children };
}

function bind(parsed: ParsedTemplate, data: TemplateData, size: { width: number; height: number }, staticOnly: boolean): BoundTemplate {
  const warnings = new Set(parsed.warnings);
  const state: BindState = { data, staticOnly, textChars: 0, warn: (message) => warnings.add(message) };
  const children = bindChildren(parsed.children, state);
  if (state.textChars > LIMITS.maxTextChars) {
    throw new ApiError('template_error', `The card contains ${state.textChars} characters of text; the limit is ${LIMITS.maxTextChars}.`, {
      details: { chars: state.textChars, limit: LIMITS.maxTextChars },
    });
  }
  const body = bindWrapper('body', parsed.bodyAttrs, stateClasses(parsed.placeholders, data, size), children, state);
  const html = bindWrapper('html', parsed.htmlAttrs, [], [body], state);
  return { html, css: parsed.css, warnings: [...warnings] };
}

/** Applies data to a parsed template. Throws ApiError('template_error') when the text limit is exceeded. */
export function bindTemplate(parsed: ParsedTemplate, data: TemplateData, size: { width: number; height: number }): BoundTemplate {
  return bind(parsed, data, size, false);
}

/**
 * The template without data, for validation on save: placeholders in text are
 * empty and attributes whose value depends on data are left out, so only what
 * every render of the template will contain gets checked.
 */
export function bindStaticTemplate(parsed: ParsedTemplate): BoundTemplate {
  return bind(parsed, {}, SIZES.og, true);
}

/* ------------------------------------------------------------------ */
/* URLs                                                                */
/* ------------------------------------------------------------------ */

export type ImageReference =
  /** Absolute http(s) URL (normalised); must be fetched and inlined before rendering. */
  | { kind: 'remote'; url: string }
  /** Canonical base64 data: URI of an allowed image type. */
  | { kind: 'data'; uri: string }
  /** Reference to an element of the document, e.g. filter: url(#blur). CSS only. */
  | { kind: 'fragment'; id: string };

const DATA_URI = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is;
const RASTER_TYPES: Record<string, string> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/gif': 'image/gif' };
const SVG_TYPE = 'image/svg+xml';
const ALLOWED_TYPES = 'image/png, image/jpeg, image/gif or image/svg+xml';

function decodeSvgPayload(payload: string, isBase64: boolean): string | undefined {
  try {
    if (!isBase64) return decodeURIComponent(payload);
    const binary = atob(payload.replace(/\s+/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/**
 * Normalises an image data: URI to `data:<type>;base64,<payload>`, the one form
 * that is safe to place inside url("...") and that Satori can measure.
 * Undefined when the type is not allowed or the payload is malformed.
 */
export function canonicalDataUri(uri: string): string | undefined {
  const match = DATA_URI.exec(uri.trim());
  if (!match) return undefined;
  const type = match[1]!.trim().toLowerCase();
  const isBase64 = /;\s*base64\s*$/i.test(match[2]!);
  const payload = match[3]!;
  if (type === SVG_TYPE) {
    const svg = decodeSvgPayload(payload, isBase64);
    return svg === undefined ? undefined : `data:${SVG_TYPE};base64,${base64Encode(new TextEncoder().encode(svg))}`;
  }
  const raster = RASTER_TYPES[type];
  const compact = payload.replace(/\s+/g, '');
  if (!raster || !isBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
  return `data:${raster};base64,${compact}`;
}

const preview = (url: string): string => (url.length > 80 ? `${url.slice(0, 77)}...` : url);

/**
 * Classifies the target of an <img src> or a CSS url(). Throws
 * ApiError('template_error') for anything the renderer will not load:
 * relative URLs, other schemes (file:, javascript:, blob: ...), other data: types.
 */
export function classifyImageUrl(target: string, context: 'img' | 'css'): ImageReference {
  const url = target.trim();
  if (context === 'css' && /^#[\w.-]+$/.test(url)) return { kind: 'fragment', id: url };
  if (/^data:/i.test(url)) {
    const uri = canonicalDataUri(url);
    if (uri) return { kind: 'data', uri };
    throw new ApiError('template_error', `Unsupported data: URI "${preview(url)}". Images must be base64 ${ALLOWED_TYPES} (SVG may also be URL-encoded).`);
  }
  if (/^https?:\/\//i.test(url) && !/[\\\s"'<>]/.test(url) && URL.canParse(url)) return { kind: 'remote', url: new URL(url).href };
  if (/^var\(/i.test(url)) {
    throw new ApiError('template_error', 'url(var(...)) is not supported. Put the whole url(...) in the custom property instead.');
  }
  throw new ApiError(
    'template_error',
    `Image URL "${preview(url)}" is not allowed. Use an absolute http(s) URL or a data: URI (${ALLOWED_TYPES}).`,
  );
}

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

export interface ResourceResolver {
  /** Maps a classified image reference to the URL written into the document. */
  image: (reference: ImageReference) => string;
  /** Maps a parsed font-family list to the list written into the document. */
  fontFamilies: (items: FontFamilyItem[]) => string;
}

function* inlineDeclarations(element: BoundElement): Generator<CssDeclaration> {
  yield* element.style;
  for (const child of element.children) if (typeof child !== 'string') yield* inlineDeclarations(child);
}

function inlineStyle(element: BoundElement, rewriter: ValueRewriter): Record<string, string> | undefined {
  if (element.style.length === 0) return undefined;
  const style: Record<string, string> = {};
  for (const declaration of element.style) {
    // style="background-image: url({{image}})" with an empty value: drop the declaration, like an <img> without src.
    if (cssUrls(declaration.value).some((target) => target.trim() === '')) continue;
    const { name, value } = rewriteDeclaration(declaration, rewriter);
    // Inline declarations already win the cascade; Satori rejects the !important suffix in style objects.
    style[name] = value.replace(/\s*!\s*important\s*$/i, '');
  }
  return style;
}

function toVNode(element: BoundElement, rewriter: ValueRewriter, image: (target: string) => string): VNode {
  const props: VNode['props'] = {};
  for (const [name, value] of Object.entries(element.attrs)) {
    props[name] = element.tag === 'img' && name === 'src' ? image(value) : value;
  }
  const style = inlineStyle(element, rewriter);
  if (style) props.style = style;
  const children = element.children.map((child) => (typeof child === 'string' ? child : toVNode(child, rewriter, image)));
  if (children.length > 0) props.children = children.length === 1 ? children[0] : children;
  return { type: element.tag, props };
}

/**
 * Builds the Satori document: html > [style] + body > the template's nodes.
 * Every <img src>, CSS url() and font-family list goes through `resolver`, so
 * the same walk serves to collect the resources a render needs (first pass)
 * and to write the resolved values (second pass).
 */
export function buildDocument(bound: BoundTemplate, resolver: ResourceResolver, warn: Warn): VNode {
  const sheet = [...BASE_CSS_NODES, ...bound.css];
  const declarations = [...cssDeclarations(sheet), ...inlineDeclarations(bound.html)];
  if (declarations.some(isOpaqueFontShorthand)) {
    warn('A "font" shorthand that uses var() cannot be mapped to the bundled fonts; set font-family separately.');
  }
  const rewriter: ValueRewriter = {
    url: (target) => resolver.image(classifyImageUrl(target, 'css')),
    fontFamilies: resolver.fontFamilies,
    fontVariables: fontVariableNames(declarations),
  };
  const css = serializeCss(mapCssDeclarations(sheet, (declaration) => rewriteDeclaration(declaration, rewriter)));
  const html = toVNode(bound.html, rewriter, (target) => resolver.image(classifyImageUrl(target, 'img')));
  const body = html.props.children as VNode;
  return { type: 'html', props: { ...html.props, children: [{ type: 'style', props: { children: css } }, body] } };
}
