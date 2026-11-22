// The documentation: every page builds and is reachable, and every statement
// that repeats something from the code (signature vector, signer code, base
// stylesheet, error codes, starter templates, limits) is checked against it.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLANS, TOPUP, formatCount, formatUsd } from '../../src/billing/plans';
import { FORMATS, HTTP_CACHE, LIMITS, RATE_LIMITS, SIZES } from '../../src/config';
import { ERROR_STATUS } from '../../src/lib/errors';
import type { SignedUrlFailure } from '../../src/lib/signed-url';
import { STARTER_TEMPLATES, STARTER_TEMPLATE_IDS } from '../../src/render/templates';
import { renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface DocPage {
  /** Markdown source, relative to site/content. */
  file: string;
  url: string;
  nav: string;
}

/** The docs, in navigation order. */
const DOCS: readonly DocPage[] = [
  { file: 'docs.md', url: '/docs', nav: 'Overview' },
  { file: 'docs/quickstart.md', url: '/docs/quickstart', nav: 'Quickstart' },
  { file: 'docs/signed-urls.md', url: '/docs/signed-urls', nav: 'Signed URLs' },
  { file: 'docs/html-css-templates.md', url: '/docs/html-css-templates', nav: 'HTML and CSS templates' },
  { file: 'docs/frameworks.md', url: '/docs/frameworks', nav: 'Frameworks' },
  { file: 'docs/api.md', url: '/docs/api', nav: 'API reference' },
  { file: 'docs/limits.md', url: '/docs/limits', nav: 'Limits' },
];

/** Every verification failure the signed-URL endpoint can report; tsc fails here when one is added. */
const SIGNATURE_FAILURES: Record<SignedUrlFailure, true> = {
  missing_sig: true,
  malformed_sig: true,
  bad_param_name: true,
  duplicate_param: true,
  bad_value: true,
  too_many_params: true,
  url_too_long: true,
  signature_mismatch: true,
};

const unescapeHtml = (html: string): string =>
  html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Visible text of a page, code blocks included, as a reader sees it. */
const visibleText = (html: string): string => unescapeHtml(html.replace(/<[^>]+>/g, ''));
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const source = (file: string): string => read(`site/content/${file}`);

/** Bodies of the fenced code blocks of one language, in document order. */
const codeBlocks = (markdown: string, lang: string): string[] =>
  [...markdown.matchAll(/^```([\w-]*)\n([\s\S]*?)^```$/gm)].filter((match) => match[1] === lang).map((match) => match[2] ?? '');

/**
 * BASE_CSS as the renderer declares it. It is read from the source text because
 * importing src/render/template.ts would pull the Worker-only wasm and font
 * imports into this Node project.
 */
function baseCss(): string {
  const literal = /export const BASE_CSS = `([^`]*)`;/.exec(read('src/render/template.ts'))?.[1];
  if (!literal) throw new Error('src/render/template.ts no longer declares BASE_CSS as a template literal');
  if (/\$\{|\\/.test(literal)) throw new Error('BASE_CSS contains an interpolation or an escape; evaluate it instead of reading it');
  return literal;
}

/** The ImageFetchFailure union, read from the source text for the same reason as BASE_CSS. */
function imageFailures(): string[] {
  const union = /export type ImageFetchFailure =([^;]+);/.exec(read('src/render/proxy.ts'))?.[1];
  if (!union) throw new Error('src/render/proxy.ts no longer declares the ImageFetchFailure union');
  return [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
}

let site: RenderedSite;
beforeAll(() => {
  site = renderSite({ env: {}, now: new Date('2026-11-22T12:00:00Z') });
});

function builtPage(url: string): string {
  const page = site.pages.find((candidate) => candidate.url === url);
  if (!page) throw new Error(`the site has no page ${url}`);
  return page.html;
}

/** The <article> of a docs page: what the author wrote, without header, sidebar and footer. */
function article(url: string): string {
  const html = builtPage(url);
  const start = html.indexOf('<article');
  const end = html.indexOf('</article>');
  if (start < 0 || end < 0) throw new Error(`${url} has no <article>`);
  return html.slice(start, end);
}

/** Text of the Markdown section under a heading, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const level = heading.indexOf(' ');
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line) && line.indexOf(' ') <= level);
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** A function copied out of a reference signer: from its first line to the last line of its body. */
function referenceFunction(file: string, firstLine: RegExp, isBodyLine: (line: string) => boolean): string {
  const lines = read(`examples/signing/${file}`).split('\n');
  const start = lines.findIndex((line) => firstLine.test(line));
  if (start < 0) throw new Error(`${file}: signer function not found`);
  let end = start + 1;
  while (end < lines.length && isBodyLine(lines[end] ?? '')) end++;
  return lines.slice(start, end).join('\n').trimEnd();
}

const untilClosingBrace = (line: string): boolean => line !== '}';
const indentedOrBlank = (line: string): boolean => line === '' || line.startsWith('    ');

const NODE_SIGNER = `${referenceFunction('sign.mjs', /^function signedCardUrl\(/, untilClosingBrace)}\n}`;
const PHP_SIGNER = `${referenceFunction('sign.php', /^function signed_card_url\(/, untilClosingBrace)}\n}`;
const PYTHON_SIGNER = referenceFunction('sign.py', /^def signed_card_url\(/, indentedOrBlank);

/** The lines of a signer that build the message and the signature, without comments. */
function coreLines(signer: string, signatureCall: string): string[] {
  const lines = signer.split('\n').slice(1).map((line) => line.trim());
  const last = lines.findIndex((line) => line.includes(signatureCall));
  if (last < 0) throw new Error(`signer has no ${signatureCall}`);
  return lines.slice(0, last + 1).filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('#'));
}

describe('docs pages', () => {
  it('builds all seven pages', () => {
    for (const doc of DOCS) {
      const html = builtPage(doc.url);
      expect(html.match(/<h1[\s>]/g), doc.url).toHaveLength(1);
      expect(site.sitemap, doc.url).toContain(`<loc>${site.config.url}${doc.url}</loc>`);
    }
  });

  it('links every page from the docs navigation, in order', () => {
    for (const doc of DOCS) {
      const html = builtPage(doc.url);
      const nav = html.slice(html.indexOf('<nav class="docs-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="docs-nav"')));
      const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => [match[1], match[2]]);
      expect(links, doc.url).toEqual(DOCS.map((page) => [page.url, page.nav]));
      expect(nav, doc.url).toContain(`<a href="${doc.url}" aria-current="page">`);
    }
  });

  it('links only to pages and anchors that exist', () => {
    // /openapi.yaml is a file the build copies next to the pages, not a rendered page.
    const urls = new Set([...site.pages.map((page) => page.url), '/openapi.yaml']);
    for (const doc of DOCS) {
      for (const [, href] of article(doc.url).matchAll(/<a [^>]*href="([^"]+)"/g)) {
        if (!href || /^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split('#');
        const target = path === '' ? doc.url : (path ?? '');
        expect(urls.has(target), `${doc.url} links to ${href}`).toBe(true);
        if (anchor) expect(builtPage(target), `${doc.url} links to ${href}`).toContain(` id="${anchor}"`);
      }
    }
  });

  it('leaves no unresolved token, placeholder or unfinished marker', () => {
    for (const doc of DOCS) {
      const html = article(doc.url);
      expect(html, doc.url).not.toMatch(/\[\[\s*>?\s*[a-zA-Z]/);
      expect(html, doc.url).not.toContain('class="placeholder"');
      for (const text of [source(doc.file), html]) {
        expect(text, doc.url).not.toMatch(/\bTODO\b/i);
        expect(text, doc.url).not.toMatch(/\bFIXME\b/i);
        // Snippets were run against a local instance; the published text must name the real site.
        expect(text, doc.url).not.toMatch(/localhost|127\.0\.0\.1/);
      }
    }
  });

  it('names no payment provider other than Paddle', () => {
    for (const doc of DOCS) {
      for (const text of [source(doc.file), article(doc.url)]) {
        expect(text, doc.url).not.toMatch(/stripe/i);
        expect(text, doc.url).not.toMatch(/lemon\s*squeezy/i);
      }
    }
  });

  it('prints prices only from the plan catalog', () => {
    const catalog = new Set([...Object.values(PLANS).map((plan) => formatUsd(plan.priceUsd)), formatUsd(TOPUP.priceUsd)]);
    for (const doc of DOCS) {
      // A price typed into Markdown would bypass the tokens that keep prices in sync.
      expect(source(doc.file), doc.file).not.toMatch(/\$\d/);
      for (const match of visibleText(article(doc.url)).matchAll(/\$\d[\d,.]*/g)) {
        const price = match[0].replace(/[.,]$/, '');
        expect(catalog.has(price), `${doc.url} prints ${price}`).toBe(true);
      }
    }
  });
});

describe('signed URLs page', () => {
  const markdown = source('docs/signed-urls.md');
  const vector = JSON.parse(read('examples/signing/vector.json')) as {
    secret: string;
    base_url: string;
    site_id: string;
    template: string;
    ext: string;
    params: Record<string, string>;
    canonical: string;
    signature: string;
    url: string;
  };

  it('prints the published test vector exactly', () => {
    expect(markdown).toContain(`\`\`\`text\n${vector.canonical}\n\`\`\``);
    expect(markdown).toContain(`\`\`\`text\n${vector.signature}\n\`\`\``);
    expect(markdown).toContain(`\`\`\`text\n${vector.url}\n\`\`\``);
    expect(markdown).toContain(vector.secret);
    expect(markdown).toContain(vector.site_id);
    const text = visibleText(article('/docs/signed-urls'));
    expect(text).toContain(vector.canonical);
    expect(text).toContain(vector.url);
  });

  it('prints the three reference signers unchanged', () => {
    expect(NODE_SIGNER).toContain("createHmac('sha256', secret)");
    expect(PHP_SIGNER).toContain("hash_hmac('sha256'");
    expect(PYTHON_SIGNER).toContain('hmac.new(');
    for (const signer of [NODE_SIGNER, PHP_SIGNER, PYTHON_SIGNER]) expect(markdown).toContain(signer);
  });

  it('prints a Node.js signer that produces the vector URL when it is run', () => {
    type Signer = (input: { secret: string; baseUrl: string; siteId: string; template: string; ext: string; params: Record<string, string> }) => string;
    const block = codeBlocks(markdown, 'js').find((code) => code.includes('function signedCardUrl('));
    if (!block) throw new Error('signed-urls.md has no Node.js signer');
    const importLine = "import { createHmac } from 'node:crypto';\n";
    expect(block.startsWith(importLine)).toBe(true);
    // The block as published, with its one import handed in as an argument.
    const signer = new Function('createHmac', `${block.slice(importLine.length)}\nreturn signedCardUrl;`)(createHmac) as Signer;
    const url = signer({ secret: vector.secret, baseUrl: vector.base_url, siteId: vector.site_id, template: vector.template, ext: vector.ext, params: vector.params });
    expect(url).toBe(vector.url);
    // A line break in a value must not become a second parameter line.
    const hostile = signer({ secret: vector.secret, baseUrl: vector.base_url, siteId: vector.site_id, template: 'blog', ext: 'png', params: { title: 'a\nsize=square' } });
    expect(new URL(hostile).searchParams.get('title')).toBe('a size=square');
  });

  it('explains every reason for a 403', () => {
    for (const reason of Object.keys(SIGNATURE_FAILURES)) expect(markdown, reason).toContain(`| \`${reason}\` |`);
  });

  it('states the cache lifetime the service sends', () => {
    expect(markdown).toContain(`max-age=${HTTP_CACHE.imageMaxAgeSeconds}`);
    expect(source('docs/api.md')).toContain(`max-age=${HTTP_CACHE.imageMaxAgeSeconds}`);
  });
});

describe('signer code on the other pages', () => {
  it('quickstart exports the reference Node.js signer', () => {
    expect(source('docs/quickstart.md')).toContain(`export ${NODE_SIGNER}`);
  });

  it('the WordPress plugin signs like the reference PHP signer', () => {
    const markdown = source('docs/frameworks.md');
    for (const line of coreLines(PHP_SIGNER, 'hash_hmac(')) expect(markdown, line).toContain(line);
  });
});

describe('templates page', () => {
  const markdown = source('docs/html-css-templates.md');

  it('prints the base stylesheet verbatim', () => {
    const css = baseCss();
    expect(css.split('\n')).toHaveLength(4);
    expect(markdown).toContain(`\`\`\`css\n${css}\n\`\`\``);
    expect(visibleText(article('/docs/html-css-templates'))).toContain(css);
  });

  it('lists every starter template with exactly its fields', () => {
    for (const template of STARTER_TEMPLATES) {
      const text = section(markdown, `### ${template.id}`);
      expect(text, template.id).toContain(`${template.name}.`);
      const fields = [...text.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1]);
      expect(fields, template.id).toEqual(template.fields.map((field) => field.name));
    }
    const documented = [...section(markdown, '## Starter templates').matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    expect(documented).toEqual([...STARTER_TEMPLATE_IDS]);
  });

  it('lists every reason an image download can fail with', () => {
    const line = markdown.split('\n').find((candidate) => candidate.startsWith('`details.reason` is one of'));
    const listed = [...(line ?? '').matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    expect(imageFailures().length).toBeGreaterThan(0);
    expect(listed).toEqual(imageFailures());
  });

  it('states the enforced shadow, filter and image limits', () => {
    expect(markdown).toContain(`at most ${LIMITS.maxBlurRadiusPx / 2}px`);
    expect(markdown).toContain(`the limit is ${LIMITS.maxFilterEffects}.`);
    expect(markdown).toContain(`${LIMITS.imageFetchTimeoutMs / 1000} seconds, at most ${LIMITS.imageMaxRedirects} redirects`);
    const text = visibleText(article('/docs/html-css-templates'));
    expect(text).toContain(`a blur radius of at most ${LIMITS.maxBlurRadiusPx}px`);
    expect(text).toContain(`at most ${LIMITS.maxFilterEffects} effects`);
  });
});

describe('API reference', () => {
  const markdown = source('docs/api.md');

  it('documents every error code with its HTTP status under #errors', () => {
    const html = article('/docs/api');
    const start = html.indexOf('<h2 id="errors">');
    expect(start).toBeGreaterThan(-1);
    const errors = html.slice(start, html.indexOf('<h2 ', start + 1));
    const rows = [...errors.matchAll(/<td>(\d{3})<\/td>\s*<td><code>([a-z_]+)<\/code><\/td>/g)].map((match) => [match[2], Number(match[1])]);
    expect(rows).toEqual(Object.entries(ERROR_STATUS));
  });

  it('documents the five public endpoints', () => {
    for (const heading of ['## POST /v1/images', '## GET /v1/usage', '## GET /v1/templates', '## GET /v1/og', '## GET /i']) {
      expect(markdown.split('\n'), heading).toContain(heading);
    }
  });

  it('shows the blog template as GET /v1/templates returns it', () => {
    const blog = STARTER_TEMPLATES.find((template) => template.id === 'blog');
    if (!blog) throw new Error('no blog starter template');
    expect(markdown).toContain(`"name": ${JSON.stringify(blog.name)}`);
    expect(markdown).toContain(`"description": ${JSON.stringify(blog.description)}`);
    for (const field of blog.fields) {
      const { name, description, example } = field;
      const json = `{ "name": ${JSON.stringify(name)}, "description": ${JSON.stringify(description)}, "example": ${JSON.stringify(example)}, "required": ${field.required === true} }`;
      expect(markdown, name).toContain(json);
    }
  });

  it('shows sample responses that agree with the Free plan and the rate limits', () => {
    const { limit, periodSeconds } = RATE_LIMITS.RL_KEY;
    expect(markdown).toContain(`Limit: ${limit} per ${periodSeconds} seconds`);
    expect(markdown).toContain(`"limit": ${PLANS.free.monthlyImages},`);
    expect(markdown).toContain(`"cache_days": ${PLANS.free.cacheDays},`);
    const limits = source('docs/limits.md');
    expect(limits).toContain(`The monthly allowance of ${formatCount(PLANS.free.monthlyImages)} images on the ${PLANS.free.name} plan is used up.`);
    expect(limits).toContain(`"limit": ${PLANS.free.monthlyImages},`);
  });
});

describe('openapi.yaml', () => {
  const openapi = read('openapi.yaml');

  it('is an OpenAPI 3.1 description with bearer authentication', () => {
    expect(openapi.startsWith('openapi: 3.1.')).toBe(true);
    expect(openapi).toContain('scheme: bearer');
  });

  it('describes the five public paths', () => {
    const paths = [...openapi.matchAll(/^ {2}(\/\S+):$/gm)].map((match) => match[1]);
    expect(paths).toEqual(['/v1/images', '/v1/usage', '/v1/templates', '/v1/og/{site_id}/{template}.{ext}', '/i/{account_id}/{id}.{ext}']);
  });

  it('names the real site and refers only to components it defines', () => {
    expect(openapi).not.toMatch(/localhost|127\.0\.0\.1/);
    const refs = [...openapi.matchAll(/\$ref: "#\/components\/([a-zA-Z]+)\/([\w-]+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [ref, kind, name] of refs) {
      const start = openapi.indexOf(`\n  ${kind}:\n`);
      expect(start, ref).toBeGreaterThan(-1);
      const next = /\n {2}\S/.exec(openapi.slice(start + 1));
      const sectionText = openapi.slice(start, next ? start + 1 + next.index : undefined);
      expect(sectionText, ref).toContain(`\n    ${name}:\n`);
    }
  });

  it('lists every error code with its status', () => {
    const codes = openapi.slice(openapi.indexOf('\n    ErrorCode:\n'), openapi.indexOf('\n    Error:\n'));
    expect(codes).not.toBe('');
    const listed = [...codes.matchAll(/^ {8}- ([a-z_]+)$/gm)].map((match) => match[1]);
    expect(listed).toEqual(Object.keys(ERROR_STATUS));
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(codes, code).toMatch(new RegExp(`\\b${escapeRegExp(code)} ${status}[,.]`));
    }
  });

  it('states the sizes, formats, starter templates and limits the service enforces', () => {
    for (const size of Object.values(SIZES)) expect(openapi).toContain(`${size.id} is ${size.width}x${size.height}`);
    expect(openapi).toContain(`enum: [${Object.keys(SIZES).join(', ')}]`);
    expect(openapi).toContain(`enum: [${FORMATS.join(', ')}]`);
    expect(openapi).toContain(`enum: [${STARTER_TEMPLATE_IDS.join(', ')}]`);
    expect(openapi).toContain(`maxProperties: ${LIMITS.maxDataKeys}`);
    expect(openapi).toContain(`maxLength: ${LIMITS.maxDataValueChars}`);
    expect(openapi).toContain(`at most ${LIMITS.maxSignedUrlChars} characters`);
    expect(openapi).toContain(`The body is over ${LIMITS.maxRequestBodyBytes / 1024} KB, or the template HTML or CSS is over ${LIMITS.maxHtmlBytes / 1024} KB.`);
    expect(openapi).toContain(`longer than ${LIMITS.renderTimeoutMs / 1000} seconds`);
    expect(LIMITS.maxCssBytes).toBe(LIMITS.maxHtmlBytes);
  });
});
