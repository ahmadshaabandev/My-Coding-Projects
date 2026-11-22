/**
 * CSS text utilities for the template compiler.
 *
 * Satori has its own stylesheet engine (selectors, cascade, variables, @media),
 * so user CSS is handed to it as text. This module only does what Satori cannot
 * or must not do for us:
 *   - find every url(...) so remote images can be inlined before Satori runs
 *     (Satori would otherwise fetch them itself),
 *   - find font-family lists so they can be expanded to the bundled subset stacks,
 *   - drop at-rules that could load resources (@import, @font-face).
 *
 * It is a tolerant tokenizer, not a validating parser: selectors and values are
 * kept as written and Satori drops what it does not understand, like a browser.
 */
import { ApiError } from '../lib/errors';

export interface CssDeclaration {
  /** Lower-cased property name; custom properties (--x) keep their case. */
  name: string;
  value: string;
}

export type CssNode =
  | ({ kind: 'declaration' } & CssDeclaration)
  /** A style rule or a block at-rule: `prelude { children }`. */
  | { kind: 'rule'; prelude: string; children: CssNode[] }
  /** A block-less at-rule such as `@layer base, theme;`. */
  | { kind: 'statement'; text: string };

/** Deepest `{` nesting accepted (@media inside @supports inside nested rules ...). */
const MAX_BLOCK_DEPTH = 12;

/** At-rules passed on to Satori. Everything else is dropped with a warning. */
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'property']);

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';

/** Index just past the string literal that starts at `start` (handles backslash escapes). */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') i += 2;
    else if (ch === quote) return i + 1;
    else i++;
  }
  return text.length;
}

/**
 * Index of the first character at parenthesis depth 0, outside string literals,
 * for which `stop` is true; text.length if there is none.
 */
function indexOfTopLevel(text: string, from: number, stop: (ch: string) => boolean): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (depth === 0 && stop(ch)) return i;
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    i++;
  }
  return text.length;
}

/** Splits on a separator character at the top level (outside quotes and parentheses). */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start <= text.length) {
    const end = indexOfTopLevel(text, start, (ch) => ch === separator);
    parts.push(text.slice(start, end));
    start = end + 1;
  }
  return parts;
}

/** Removes comments (string literals are left alone). Each comment becomes one space. */
export function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  let last = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
    } else if (ch === '\\') {
      i += 2;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      out += `${css.slice(last, i)} `;
      i = last = end < 0 ? css.length : end + 2;
    } else {
      i++;
    }
  }
  return out + css.slice(last);
}

function parseDeclaration(chunk: string): CssDeclaration | undefined {
  const colon = indexOfTopLevel(chunk, 0, (ch) => ch === ':');
  if (colon >= chunk.length) return undefined;
  const rawName = chunk.slice(0, colon).trim();
  const value = chunk.slice(colon + 1).trim();
  if (!/^-{0,2}[a-zA-Z_][\w-]*$/.test(rawName) || value === '') return undefined;
  return { name: rawName.startsWith('--') ? rawName : rawName.toLowerCase(), value };
}

function parseBlock(text: string, start: number, nodes: CssNode[], depth: number): number {
  if (depth > MAX_BLOCK_DEPTH) {
    throw new ApiError('template_error', `CSS blocks are nested more than ${MAX_BLOCK_DEPTH} levels deep.`);
  }
  let pos = start;
  while (pos < text.length) {
    const ch = text[pos]!;
    if (isSpace(ch) || ch === ';') {
      pos++;
      continue;
    }
    if (ch === '}') return pos + 1;
    const end = indexOfTopLevel(text, pos, (c) => c === '{' || c === ';' || c === '}');
    const chunk = text.slice(pos, end).trim();
    if (text[end] === '{') {
      const children: CssNode[] = [];
      pos = parseBlock(text, end + 1, children, depth + 1);
      nodes.push({ kind: 'rule', prelude: chunk, children });
      continue;
    }
    if (chunk.startsWith('@')) {
      nodes.push({ kind: 'statement', text: chunk });
    } else {
      // Anything that is not `name: value` is dropped, as a browser would.
      const declaration = parseDeclaration(chunk);
      if (declaration) nodes.push({ kind: 'declaration', ...declaration });
    }
    pos = end;
  }
  return pos;
}

/** Parses a stylesheet, or the text of a style="" attribute, into a tree of rules and declarations. */
export function parseCss(css: string): CssNode[] {
  const text = stripCssComments(css);
  const nodes: CssNode[] = [];
  let pos = 0;
  // A stray `}` at the top level ends parseBlock early; skip it and carry on.
  while (pos < text.length) pos = parseBlock(text, pos, nodes, 0);
  return nodes;
}

/** Declarations of an inline style attribute (rules inside it are ignored). */
export function parseInlineStyle(style: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  for (const node of parseCss(style)) {
    if (node.kind === 'declaration') declarations.push({ name: node.name, value: node.value });
  }
  return declarations;
}

export function serializeCss(nodes: readonly CssNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'declaration') out += `${node.name}:${node.value};`;
    else if (node.kind === 'statement') out += `${node.text};`;
    else out += `${node.prelude}{${serializeCss(node.children)}}`;
  }
  return out;
}

const atRuleName = (prelude: string): string | undefined => /^@([a-z-]+)/i.exec(prelude)?.[1]?.toLowerCase();

/**
 * Drops at-rules Satori must not see (@import, @font-face: resource loading) or
 * ignores anyway (@keyframes, @charset ...), reporting each kind once.
 */
export function dropUnsupportedAtRules(nodes: readonly CssNode[], warn: (message: string) => void): CssNode[] {
  const kept: CssNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'declaration') {
      kept.push(node);
      continue;
    }
    const name = atRuleName(node.kind === 'rule' ? node.prelude : node.text);
    if (name !== undefined && !ALLOWED_AT_RULES.has(name)) {
      warn(`@${name} is not supported and was ignored.`);
      continue;
    }
    kept.push(node.kind === 'rule' ? { ...node, children: dropUnsupportedAtRules(node.children, warn) } : node);
  }
  return kept;
}

/** Every declaration in the tree, depth first. */
export function* cssDeclarations(nodes: readonly CssNode[]): Generator<CssDeclaration> {
  for (const node of nodes) {
    if (node.kind === 'declaration') yield node;
    else if (node.kind === 'rule') yield* cssDeclarations(node.children);
  }
}

/** A copy of the tree with every declaration replaced by `map(declaration)`. */
export function mapCssDeclarations(nodes: readonly CssNode[], map: (declaration: CssDeclaration) => CssDeclaration): CssNode[] {
  return nodes.map((node): CssNode => {
    if (node.kind === 'declaration') return { kind: 'declaration', ...map(node) };
    if (node.kind === 'rule') return { ...node, children: mapCssDeclarations(node.children, map) };
    return node;
  });
}

/* ------------------------------------------------------------------ */
/* url(...)                                                            */
/* ------------------------------------------------------------------ */

const URL_TOKEN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*))\s*\)/iy;
const IDENT_CHAR = /[\w-]/;

/**
 * Replaces the target of every url(...) token in a CSS value. The replacement is
 * always written double-quoted, so `replace` must return a string without `"`,
 * backslashes or line breaks (data: URIs produced by this renderer are base64).
 */
export function replaceCssUrls(value: string, replace: (target: string) => string): string {
  let out = '';
  let i = 0;
  let last = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '"' || ch === "'") {
      i = skipString(value, i);
      continue;
    }
    if ((ch === 'u' || ch === 'U') && (i === 0 || !IDENT_CHAR.test(value[i - 1]!))) {
      URL_TOKEN.lastIndex = i;
      const match = URL_TOKEN.exec(value);
      if (match) {
        out += `${value.slice(last, i)}url("${replace(match[1] ?? match[2] ?? match[3] ?? '')}")`;
        i = last = URL_TOKEN.lastIndex;
        continue;
      }
    }
    i++;
  }
  return out + value.slice(last);
}

/** The targets of every url(...) token in a CSS value, in order. */
export function cssUrls(value: string): string[] {
  const targets: string[] = [];
  replaceCssUrls(value, (target) => {
    targets.push(target);
    return '';
  });
  return targets;
}

/* ------------------------------------------------------------------ */
/* font-family                                                         */
/* ------------------------------------------------------------------ */

const IMPORTANT = /\s*!\s*important\s*$/i;
const CSS_WIDE_KEYWORD = /^(?:inherit|initial|unset|revert|revert-layer)$/i;
const FONT_SIZE =
  /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+|%)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(?:calc|min|max|clamp)\()/i;

/**
 * Splits a `font` shorthand into everything up to the size (and line height) and
 * the family list. Undefined when there is no family list to find: system font
 * keywords (`font: caption`) and values using var().
 */
export function splitFontShorthand(value: string): { head: string; families: string } | undefined {
  if (/var\(/i.test(value)) return undefined;
  let pos = 0;
  while (pos < value.length) {
    while (isSpace(value[pos])) pos++;
    const end = indexOfTopLevel(value, pos, (ch) => isSpace(ch) || ch === '/');
    if (end === pos) return undefined;
    if (FONT_SIZE.test(value.slice(pos, end))) {
      let next = end;
      while (isSpace(value[next])) next++;
      if (value[next] === '/') {
        next++;
        while (isSpace(value[next])) next++;
        next = indexOfTopLevel(value, next, isSpace);
      }
      const families = value.slice(next).trim();
      return families === '' ? undefined : { head: value.slice(0, next).trimEnd(), families };
    }
    pos = end;
  }
  return undefined;
}

export type FontFamilyItem =
  /** A family name without quotes, as written (matching is case-insensitive). */
  | { kind: 'name'; name: string }
  /** A var() reference (or anything else that is not a plain name); passed through untouched. */
  | { kind: 'raw'; text: string };

/** Parses a font-family list. Undefined for CSS-wide keywords (`inherit` ...), which have no list. */
export function parseFontFamilyList(list: string): FontFamilyItem[] | undefined {
  const trimmed = list.trim();
  if (CSS_WIDE_KEYWORD.test(trimmed)) return undefined;
  const items: FontFamilyItem[] = [];
  for (const part of splitTopLevel(trimmed, ',')) {
    const text = part.trim();
    if (text === '') continue;
    if (text.includes('(')) {
      items.push({ kind: 'raw', text });
      continue;
    }
    const quoted = /^(["'])(.*)\1$/s.exec(text);
    // Unquoted names are sequences of identifiers; runs of white space collapse to one space.
    items.push({ kind: 'name', name: quoted ? quoted[2]! : text.replace(/\s+/g, ' ') });
  }
  return items;
}

/** Custom property names referenced through var() in a value. */
function referencedVariables(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!);
}

/** The font-family list inside a declaration value, if the property has one. */
function fontFamilyPart(name: string, value: string, fontVariables: ReadonlySet<string>): { head: string; families: string } | undefined {
  if (name === 'font-family' || fontVariables.has(name)) return { head: '', families: value };
  if (name === 'font') return splitFontShorthand(value);
  return undefined;
}

/**
 * Custom properties that hold font-family lists: the ones referenced through
 * var() by a font-family declaration, and transitively by each other. Their
 * values must be expanded like font-family values, because Satori resolves
 * var() long after this module has run. (`font: var(--x)` is not followed: the
 * variable may hold a whole shorthand.)
 */
export function fontVariableNames(declarations: readonly CssDeclaration[]): Set<string> {
  const names = new Set<string>();
  // Each pass follows one more level of indirection; real stylesheets need one or two.
  for (let pass = 0; pass < 4; pass++) {
    const before = names.size;
    for (const declaration of declarations) {
      if (declaration.name === 'font-family' || names.has(declaration.name)) {
        for (const name of referencedVariables(declaration.value)) names.add(name);
      }
    }
    if (names.size === before) break;
  }
  return names;
}

export interface ValueRewriter {
  /** Returns the replacement target for a url(...) token. */
  url: (target: string) => string;
  /** Returns the replacement for a parsed font-family list. */
  fontFamilies: (items: FontFamilyItem[]) => string;
  /** Custom properties whose values are font-family lists (see fontVariableNames). */
  fontVariables: ReadonlySet<string>;
}

/** Rewrites url(...) tokens and font-family lists of one declaration. */
export function rewriteDeclaration(declaration: CssDeclaration, rewriter: ValueRewriter): CssDeclaration {
  const { name } = declaration;
  const value = replaceCssUrls(declaration.value, rewriter.url);
  const important = IMPORTANT.exec(value)?.[0] ?? '';
  const font = fontFamilyPart(name, important ? value.slice(0, -important.length) : value, rewriter.fontVariables);
  const items = font && parseFontFamilyList(font.families);
  if (!font || !items) return { name, value };
  return { name, value: `${font.head}${font.head ? ' ' : ''}${rewriter.fontFamilies(items)}${important}` };
}

/** True for a `font` shorthand whose family list cannot be located because it uses var(). */
export function isOpaqueFontShorthand(declaration: CssDeclaration): boolean {
  return declaration.name === 'font' && /var\(/i.test(declaration.value);
}
