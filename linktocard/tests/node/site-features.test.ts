// Build-time feature switches (scripts/build-site.ts): SITE_PDF=on publishes the PDF pages,
// blocks and API paths; without it the site must look exactly as if PDFs did not exist.
// Both builds go to temp directories so site/dist is left alone.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER } from '../../src/billing/plans';
import { PDF, RATE_LIMITS, type RateLimitName } from '../../src/config';
import { FEATURES, applyFeatureBlocks, buildSite, isPdfRateLimit, rateLimitFeature, renderSite, siteFeatures, type Feature, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-25T12:00:00Z');
const temp = mkdtempSync(join(tmpdir(), 'ltc-features-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** The site features, with exactly `on` switched on. */
const only = (...on: Feature[]): Record<Feature, boolean> => Object.fromEntries(FEATURES.map((feature) => [feature, on.includes(feature)])) as Record<Feature, boolean>;
const ON = only('pdf');
const OFF = only();

/** Every page that exists only with the "previews" feature (the tool hub and the five one-app pages). */
const PREVIEWS_PAGES = [
  'tools.html',
  'tools/discord-embed-preview.html',
  'tools/linkedin-post-preview.html',
  'tools/slack-link-preview.html',
  'tools/whatsapp-link-preview.html',
  'tools/x-card-validator.html',
] as const;

/** Every page that exists only with SITE_PDF=on. The test below proves the list matches the front matter. */
const PDF_PAGES = [
  'docs/pdf.html',
  'guides/html-to-pdf-n8n.html',
  'guides/html-to-pdf-zapier-webhooks.html',
  'guides/invoice-pdf-from-stripe-webhook.html',
  'tools/certificate-generator.html',
  'tools/html-to-pdf.html',
  'tools/invoice-generator.html',
] as const;
const PDF_URLS = PDF_PAGES.map((page) => `/${page.replace(/\.html$/, '')}`);
const TOOL_LINKS = ['/tools/html-to-pdf', '/tools/invoice-generator', '/tools/certificate-generator'];

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, ' ');
const ENTITIES: Record<string, string> = { ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', ndash: '\u2013', mdash: '\u2014', middot: '\u00b7', times: '\u00d7', hellip: '\u2026', nbsp: ' ' };
const unescapeHtml = (html: string): string =>
  html
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|middot|times|hellip|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (html: string): string => unescapeHtml(stripTags(html)).replace(/\s+/g, ' ');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name],
  );
}

function page(site: RenderedSite, outPath: string): string {
  const found = site.pages.find((candidate) => candidate.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
}

const footerOf = (html: string): string => html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
const navOf = (html: string): string => html.slice(html.indexOf('<nav class="docs-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="docs-nav"')));

describe('applyFeatureBlocks', () => {
  const source = 'a\n<!-- feature:pdf -->\nb\n<!-- /feature:pdf -->\n<!-- feature:no-pdf -->\nc\n<!-- /feature:no-pdf -->\nd\n';

  it('keeps feature:pdf blocks only when on and feature:no-pdf blocks only when off, without their markers', () => {
    expect(applyFeatureBlocks(source, ON, 'x.md')).toBe('a\nb\nd\n');
    expect(applyFeatureBlocks(source, OFF, 'x.md')).toBe('a\nc\nd\n');
  });

  it('takes the whole line with a marker that stands alone, so a Markdown table or list stays in one piece', () => {
    const table = '| A | B |\n| - | - |\n| 1 | 2 |\n<!-- feature:pdf -->\n| 3 | 4 |\n<!-- /feature:pdf -->\n| 5 | 6 |\n';
    expect(applyFeatureBlocks(table, OFF, 't.md')).toBe('| A | B |\n| - | - |\n| 1 | 2 |\n| 5 | 6 |\n');
    expect(applyFeatureBlocks(table, ON, 't.md')).toBe('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n');
    // A block on one line goes with its line when off, and leaves just its content when on.
    const line = 'x\n  <!-- feature:pdf --><li>PDF</li><!-- /feature:pdf -->\ny\n';
    expect(applyFeatureBlocks(line, OFF, 'l.html')).toBe('x\ny\n');
    expect(applyFeatureBlocks(line, ON, 'l.html')).toBe('x\n  <li>PDF</li>\ny\n');
  });

  it('works inside a sentence', () => {
    const inline = 'Cards<!-- feature:pdf --> and PDFs<!-- /feature:pdf --> from HTML.';
    expect(applyFeatureBlocks(inline, ON, 'i.md')).toBe('Cards and PDFs from HTML.');
    expect(applyFeatureBlocks(inline, OFF, 'i.md')).toBe('Cards from HTML.');
  });

  it('reads YAML comment lines in openapi.yaml', () => {
    const yaml = 'paths:\n  /a:\n    get: {}\n  # feature:pdf\n  /pdf:\n    get: {}\n  # /feature:pdf\n  /b:\n    get: {}\n';
    expect(applyFeatureBlocks(yaml, OFF, 'o.yaml', 'yaml')).toBe('paths:\n  /a:\n    get: {}\n  /b:\n    get: {}\n');
    expect(applyFeatureBlocks(yaml, ON, 'o.yaml', 'yaml')).toBe('paths:\n  /a:\n    get: {}\n  /pdf:\n    get: {}\n  /b:\n    get: {}\n');
  });

  it.each([
    ['an unknown feature', 'a <!-- feature:video -->b<!-- /feature:video -->', /f\.md:1: unknown feature "video"/],
    ['a nested block', '<!-- feature:pdf -->\n<!-- feature:no-pdf -->\nx\n<!-- /feature:no-pdf -->\n<!-- /feature:pdf -->', /f\.md:2: feature:no-pdf opens inside feature:pdf/],
    ['an unclosed block', 'a\n<!-- feature:pdf -->\nb', /f\.md:2: feature:pdf is never closed/],
    ['a close without an open', 'a\n<!-- /feature:pdf -->', /f\.md:2: \/feature:pdf closes a block that was never opened/],
    ['a mismatched close', '<!-- feature:pdf -->x<!-- /feature:no-pdf -->', /\/feature:no-pdf closes feature:pdf/],
    ['a misspelled marker', 'a\n\n<!-- feature: pdf -->x', /f\.md:3: malformed feature marker/],
  ])('refuses %s, naming the file and line', (_case, input, message) => {
    expect(() => applyFeatureBlocks(input, ON, 'f.md')).toThrow(message);
    expect(() => applyFeatureBlocks(input, OFF, 'f.md')).toThrow(message);
  });

  it('switches only on SITE_PDF=on, and refuses any value but on and off', () => {
    expect(siteFeatures({ SITE_PDF: 'on' })).toEqual(ON);
    expect(siteFeatures({ SITE_PDF: ' on ' })).toEqual(ON);
    expect(siteFeatures({ SITE_PDF: 'off' })).toEqual(OFF);
    expect(siteFeatures({ SITE_PDF: '' })).toEqual(OFF);
    expect(siteFeatures({})).toEqual(OFF);
    for (const value of ['true', '1', 'yes', 'ON']) expect(() => siteFeatures({ SITE_PDF: value })).toThrow(/SITE_PDF must be "on" or "off"/);
  });

  it('takes a comma list of known features in SITE_FEATURES, with SITE_PDF=on as another way to say "pdf"', () => {
    // localpdf and apidocs: owner decision of 2026-11-27 (the in-browser PDF pages and the API docs pages go to
    // production while the APIs stay off), so the in-browser pages no longer come with "toolkit".
    expect(FEATURES).toEqual(['pdf', 'batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations', 'localpdf', 'apidocs']);
    expect(siteFeatures({ SITE_FEATURES: 'linkcards' })).toEqual(only('linkcards'));
    expect(siteFeatures({ SITE_FEATURES: ' pdf , toolkit ' })).toEqual(only('pdf', 'toolkit'));
    expect(siteFeatures({ SITE_FEATURES: 'toolkit', SITE_PDF: 'on' })).toEqual(only('pdf', 'toolkit'));
    expect(siteFeatures({ SITE_FEATURES: FEATURES.join(',') })).toEqual(only(...FEATURES));
    expect(siteFeatures({ SITE_FEATURES: '', SITE_PDF: 'off' })).toEqual(OFF);
    expect(() => siteFeatures({ SITE_FEATURES: 'pdf,tooklit' })).toThrow(/SITE_FEATURES names an unknown feature "tooklit"/);
  });

  it('refuses "localpdf" without a feature that publishes /docs/pdf-tools, where its API link goes', () => {
    expect(() => siteFeatures({ SITE_FEATURES: 'localpdf' })).toThrow(/"localpdf" needs "toolkit" or "apidocs" too/);
    expect(() => siteFeatures({ SITE_FEATURES: 'previews,localpdf', SITE_PDF: 'on' })).toThrow(/"localpdf" needs "toolkit" or "apidocs" too/);
    expect(siteFeatures({ SITE_FEATURES: 'localpdf,apidocs' })).toEqual(only('localpdf', 'apidocs'));
    expect(siteFeatures({ SITE_FEATURES: 'localpdf,toolkit', SITE_PDF: 'on' })).toEqual(only('pdf', 'localpdf', 'toolkit'));
  });

  it('refuses "batch" and "toolkit" without "pdf": their documents are PDFs, and their text builds on that of PDFs', () => {
    // GO-LIVE.md section 11c ("Needs first"); the terms' section 4a refers to the counterfeit rule of the PDF text.
    for (const feature of ['batch', 'toolkit'] as const) {
      const message = new RegExp(`SITE_FEATURES: "${feature}" needs "pdf" too \\(SITE_PDF=on, or "pdf" in SITE_FEATURES\\)`);
      expect(() => siteFeatures({ SITE_FEATURES: feature }), feature).toThrow(message);
      expect(() => siteFeatures({ SITE_FEATURES: `previews,localpdf,apidocs,${feature}`, SITE_PDF: 'off' }), feature).toThrow(message);
      expect(siteFeatures({ SITE_FEATURES: feature, SITE_PDF: 'on' }), feature).toEqual(only('pdf', feature));
      expect(siteFeatures({ SITE_FEATURES: `${feature},pdf` }), feature).toEqual(only('pdf', feature));
    }
    // The other features need nothing.
    for (const feature of ['linkcards', 'email', 'previews', 'integrations', 'apidocs'] as const) expect(siteFeatures({ SITE_FEATURES: feature }), feature).toEqual(only(feature));
  });
});

describe('the two builds', () => {
  let off: RenderedSite;
  let on: RenderedSite;
  let offFiles: string[];
  let onFiles: string[];
  beforeAll(() => {
    off = buildSite({ outDir: join(temp, 'off'), env: {}, now: NOW });
    on = buildSite({ outDir: join(temp, 'on'), env: { SITE_PDF: 'on' }, now: NOW });
    offFiles = walk(join(temp, 'off'));
    onFiles = walk(join(temp, 'on'));
  });

  it('lists every page whose front matter says "feature: pdf"', () => {
    const gated = [
      ...walk(join(ROOT, 'site/pages')).filter((file) => file.endsWith('.html')).map((file) => ['site/pages', file]),
      ...walk(join(ROOT, 'site/content')).filter((file) => file.endsWith('.md')).map((file) => ['site/content', file]),
    ]
      .filter(([dir, file]) => /^feature:\s*pdf\s*$/m.test(readFileSync(join(ROOT, dir ?? '', file ?? ''), 'utf8').split(/^---\s*$/m)[1] ?? ''))
      .map(([, file]) => (file ?? '').replace(/\.md$/, '.html'))
      .sort();
    expect(gated).toEqual([...PDF_PAGES]);
  });

  it('builds the PDF pages only with SITE_PDF=on, and lists them in sitemap.xml only then', () => {
    expect(off.features).toEqual(OFF);
    expect(on.features).toEqual(ON);
    for (const file of PDF_PAGES) {
      expect(offFiles, file).not.toContain(file);
      expect(onFiles, file).toContain(file);
    }
    for (const url of PDF_URLS) {
      expect(off.sitemap).not.toContain(`${off.config.url}${url}<`);
      expect(on.sitemap).toContain(`<loc>${on.config.url}${url}</loc>`);
    }
    // Everything else is the same set of pages.
    expect(on.pages.map((p) => p.outPath).filter((p) => !(PDF_PAGES as readonly string[]).includes(p)).sort()).toEqual(off.pages.map((p) => p.outPath).sort());
  });

  it('copies the tool script only with SITE_PDF=on', () => {
    expect(offFiles).not.toContain('assets/js/pdf-tools.js');
    expect(onFiles).toContain('assets/js/pdf-tools.js');
  });

  it('leaves no feature marker in any page or in openapi.yaml, in either build', () => {
    for (const site of [off, on]) {
      for (const built of site.pages) expect(built.html, built.outPath).not.toMatch(/feature\s*:/);
      expect(site.openapi).not.toMatch(/#\s*\/?feature\s*:/);
    }
    for (const dir of ['off', 'on']) expect(readFileSync(join(temp, dir, 'openapi.yaml'), 'utf8')).not.toMatch(/feature\s*:/);
  });

  it('never links to a PDF page from the build without them', () => {
    const links: string[] = [];
    for (const built of off.pages) {
      for (const match of built.html.matchAll(/\s(?:href|src|action)="(\/[^"#?]*)/g)) {
        if (PDF_URLS.includes(match[1] ?? '') || /pdf/i.test(match[1] ?? '')) links.push(`${built.outPath} -> ${match[1]}`);
      }
    }
    expect(links).toEqual([]);
  });

  it('resolves every internal link of the PDF build to a page or a file', () => {
    const exists = (path: string): boolean => path === '/' || onFiles.includes(path.slice(1)) || onFiles.includes(`${path.slice(1)}.html`);
    const broken: string[] = [];
    for (const built of on.pages) {
      for (const match of built.html.matchAll(/\s(?:href|src)="(\/[^"#?]*)(?:#([^"]*))?[^"]*"/g)) {
        const path = match[1] ?? '';
        if (/^\/(v1|api|auth|playground|webhooks|i)\//.test(path)) continue;
        if (!exists(path)) broken.push(`${built.outPath} -> ${path}`);
        const anchor = match[2];
        if (anchor && exists(path) && path !== '/' && on.pages.some((p) => p.url === path)) {
          if (!page(on, `${path.slice(1)}.html`).includes(` id="${anchor}"`)) broken.push(`${built.outPath} -> ${path}#${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps the PDF build within the CSP: no inline script, handler or style, nothing from another origin', () => {
    for (const built of on.pages) {
      expect(built.html.match(/<script\b(?![^>]*\ssrc=)[^>]*>/g), built.outPath).toBeNull();
      expect(built.html.match(/<[a-z][^>]*\son[a-z]+\s*=/g), built.outPath).toBeNull();
      expect(built.html.match(/<[a-z][^>]*\sstyle\s*=/g), built.outPath).toBeNull();
      expect(built.html, built.outPath).not.toMatch(/<style\b|<iframe\b/);
      const loaded = [...built.html.matchAll(/<(?:script|img|link|iframe|source)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(loaded.filter((url) => !url.startsWith('/') && !url.startsWith(`${on.config.url}/`)), built.outPath).toEqual([]);
    }
    // Downloads use a blob: link, not a frame: the CSP needs no new source.
    const csp = readFileSync(join(ROOT, 'site/public/_headers'), 'utf8');
    expect(csp).toContain('frame-src https://*.paddle.com https://challenges.cloudflare.com;');
  });

  it('gives every page of the PDF build its own title and description', () => {
    const seen = new Map<string, string>();
    for (const built of on.pages) {
      const title = /<title>([^<]+)<\/title>/.exec(built.html)?.[1] ?? '';
      const description = /<meta name="description" content="([^"]+)">/.exec(built.html)?.[1] ?? '';
      for (const value of [`title:${title}`, `description:${description}`]) {
        expect(seen.get(value), `${built.outPath} repeats ${value} of ${seen.get(value)}`).toBeUndefined();
        seen.set(value, built.outPath);
      }
    }
  });

  it('adds /docs/pdf to the docs navigation between Frameworks and the API reference, only when on', () => {
    const links = (site: RenderedSite): string[] => [...navOf(page(site, 'docs.html')).matchAll(/<a href="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(links(off)).not.toContain('/docs/pdf');
    const withPdf = links(on);
    expect(withPdf.indexOf('/docs/pdf')).toBe(withPdf.indexOf('/docs/frameworks') + 1);
    expect(withPdf.indexOf('/docs/api')).toBe(withPdf.indexOf('/docs/pdf') + 1);
    expect(page(on, 'docs/pdf.html')).toContain('<a href="/docs/pdf" aria-current="page">PDF documents</a>');
  });

  it('links the three PDF tools from every footer only when on', () => {
    for (const built of off.pages) {
      const footer = footerOf(built.html);
      expect(footer, built.outPath).toContain('<li><a href="/tools/og-checker">Tools</a></li>');
      for (const href of TOOL_LINKS) expect(footer, built.outPath).not.toContain(href);
    }
    for (const built of on.pages) {
      const footer = footerOf(built.html);
      expect(footer, built.outPath).toContain('<li><a href="/tools/og-checker">Open Graph checker</a></li>');
      for (const href of TOOL_LINKS) expect(footer, built.outPath).toContain(`href="${href}"`);
    }
  });

  it('says nothing about PDFs being available in the build without them', () => {
    // The only PDF words left are about what we do not do, and about Bannerbear's own output.
    const mentions = off.pages.filter((built) => /\bPDFs?\b/.test(text(built.html))).map((built) => built.outPath);
    expect(mentions.sort()).toEqual(['compare/bannerbear.html', 'docs.html']);
    const docs = text(page(off, 'docs.html')).match(/[^.]*\bPDF\b[^.]*\./g) ?? [];
    expect(docs.map((sentence) => sentence.replace(/^[\s)]+/, '').trim())).toEqual(['No video, GIF or PDF output.']);
    const all = off.pages.map((built) => text(built.html)).join('\n');
    for (const phrase of ['Browser Run', '/v1/pdf', PDF.freeMark, 'headless Chrome', 'Invoice generator', 'Certificate generator', 'HTML to PDF']) {
      expect(all, phrase).not.toContain(phrase);
    }
    // The home page keeps its old answer.
    expect(text(page(off, 'index.html'))).toContain(
      'It is not a visual editor: templates are code. It does not take screenshots of web pages, it does not make video or GIFs, and it does not generate images with AI.',
    );
  });

  it('keeps the PDF rate limits out of the tables without PDFs, and lists them with', () => {
    const pdfScopes = (Object.keys(RATE_LIMITS) as RateLimitName[]).filter(isPdfRateLimit).map((name) => RATE_LIMITS[name].scope);
    expect(pdfScopes.length).toBeGreaterThan(0);
    // Every limiter about PDFs belongs to a feature: the PDF toolkit's to "toolkit", the others to "pdf".
    for (const name of Object.keys(RATE_LIMITS) as RateLimitName[]) expect(rateLimitFeature(name) !== null, name).toBe(/pdf/i.test(RATE_LIMITS[name].scope));
    expect(rateLimitFeature('RL_PDF_TOOLS')).toBe('toolkit');
    const cellOf = (scope: string): string => `<th scope="row">${scope.charAt(0).toUpperCase()}${scope.slice(1)}</th>`.replace(/&/g, '&amp;');
    const toolkit = renderSite({ env: { SITE_FEATURES: 'pdf,toolkit' }, now: NOW });
    for (const outPath of ['docs/limits.html', 'docs/api.html']) {
      for (const scope of pdfScopes) {
        expect(page(off, outPath), outPath).not.toContain(cellOf(scope));
        expect(page(on, outPath), outPath).toContain(cellOf(scope));
      }
      const toolkitCell = cellOf(RATE_LIMITS.RL_PDF_TOOLS.scope);
      expect(page(off, outPath), outPath).not.toContain(toolkitCell);
      expect(page(on, outPath), outPath).not.toContain(toolkitCell);
      expect(page(toolkit, outPath), outPath).toContain(toolkitCell);
    }
    expect(page(on, 'docs/limits.html')).toContain(`<td>${RATE_LIMITS.RL_PDF_KEY.limit} requests per ${RATE_LIMITS.RL_PDF_KEY.periodSeconds} seconds</td>`);
  });

  it('builds the tool hub and the one-app preview pages only with "previews", and links the hub from the footer then', () => {
    const previews = renderSite({ env: { SITE_FEATURES: 'previews' }, now: NOW });
    const outPaths = (site: RenderedSite): string[] => site.pages.map((built) => built.outPath);
    for (const file of PREVIEWS_PAGES) {
      expect(outPaths(off), file).not.toContain(file);
      expect(outPaths(on), file).not.toContain(file);
      expect(outPaths(previews), file).toContain(file);
      expect(previews.sitemap).toContain(`<loc>${previews.config.url}/${file.replace(/\.html$/, '')}</loc>`);
    }
    expect(outPaths(previews).filter((p) => !(PREVIEWS_PAGES as readonly string[]).includes(p)).sort()).toEqual(outPaths(off).sort());
    for (const built of off.pages) expect(footerOf(built.html), built.outPath).not.toContain('href="/tools"');
    for (const built of previews.pages) expect(footerOf(built.html), built.outPath).toContain('<li><a href="/tools">All free tools</a></li>');
  });

  it('states on the pricing page how a PDF counts, and what each plan\'s PDFs look like, only when on', () => {
    for (const outPath of ['pricing.html', 'index.html', 'docs/limits.html']) {
      expect(page(off, outPath), outPath).not.toContain('id="pdf-counting"');
      const rule = text(page(on, outPath));
      expect(rule, outPath).toContain(`A PDF of 1 to ${PDF.basePages} pages counts as ${PDF.baseUnits} images, and each further ${PDF.extraPagesPerUnit} pages started add one more`);
    }
    const pricing = page(on, 'pricing.html');
    for (const id of PLAN_ORDER) {
      const card = pricing.slice(pricing.indexOf(`data-plan="${id}"`), pricing.indexOf('</article>', pricing.indexOf(`data-plan="${id}"`)));
      expect(card, id).toContain(PLANS[id].watermark ? `PDFs carry a \u201c${PDF.freeMark}\u201d footer line` : 'PDFs without a footer mark');
      expect(page(off, 'pricing.html')).not.toContain('PDFs carry');
    }
    expect(text(pricing)).toContain(`up to ${PDF.toolPdfsPerHour} PDFs per hour from one network, each with a \u201c${PDF.freeMark}\u201d footer line`);
  });

  it('says on the home page that PDFs are made by Cloudflare Browser Run and cards still without a browser, only when on', () => {
    const home = text(page(on, 'index.html'));
    expect(home).toContain('It still does not take screenshots of web pages');
    expect(home).toContain('Card images are still drawn without a browser. PDFs are rendered by Cloudflare Browser Run');
    expect(home).toContain('with JavaScript turned off');
    expect(page(on, 'index.html').match(/<details class="faq-item">/g)).toHaveLength(8);
  });

  it('forbids counterfeit and misleading documents, and promises suspension on report, in the PDF build only', () => {
    // Owner decision of 2026-11-27 (audit F4): the production terms stay those of 89270a7, which the
    // owner approved, so this text from the PDF feature waits for PDFs (tests/node/legal-pages.test.ts).
    const production = renderSite({ env: { SITE_FEATURES: 'previews,localpdf,apidocs', SITE_PDF: 'off' }, now: NOW });
    const counterfeit =
      'create counterfeit or misleading documents in any form the service produces, such as fake invoices or receipts, bank statements, utility bills, identity documents, or certificates that claim to come from an issuer that did not issue them;';
    const suspension = 'When we receive a report that the service was used to make one, we suspend the API keys and the account involved straight away';
    const onTerms = text(page(on, 'terms.html'));
    expect(onTerms).toContain(counterfeit);
    expect(onTerms).toContain(suspension);
    expect(onTerms).toContain('and the images and other files the service produces for you.');
    for (const site of [off, production]) {
      const terms = text(page(site, 'terms.html'));
      expect(terms).not.toContain('counterfeit');
      expect(terms).not.toContain(suspension);
      expect(terms).not.toContain('other files');
      expect(terms).toContain('and the images the service produces for you.');
    }
    expect(text(page(off, 'terms.html'))).not.toMatch(/\bPDF/);
    const terms = text(page(on, 'terms.html'));
    expect(terms).toContain(`PDF documents have at most ${PDF.maxPages} pages.`);
    expect(terms).toContain('PDF documents are rendered by Cloudflare Browser Run');
    expect(terms).toContain(`a PDF of 1 to ${PDF.basePages} pages counts as ${PDF.baseUnits} images`);
    expect(terms).toContain('or the footer line on Free-plan and free-tool PDFs');
  });

  it('names Cloudflare Browser Run, what is kept and for how long in the privacy policy, only when on', () => {
    expect(text(page(off, 'privacy.html'))).not.toMatch(/\bPDF|Browser Run/);
    const privacy = text(page(on, 'privacy.html'));
    expect(privacy).toContain('to Cloudflare Browser Run, Cloudflare\'s browser service, which prints it and returns the PDF. Cloudflare is already our host, so no further company receives your document.');
    expect(privacy).toContain('PDFs from the free PDF tools: not stored.');
    expect(privacy).toContain(`the pages and the browser time; no document content): ${PDF.browserUsageRetentionDays} days.`);
    expect(privacy).toContain('a count of PDFs per IP address (IPv6: per /64 network) for the current hour');
    // Still three outside companies: Browser Run is Cloudflare.
    expect(privacy).toContain('We use three outside companies.');
  });

  it('builds the comparison page for both, with no claim that we lack PDFs once we have them', () => {
    const offPage = text(page(off, 'compare/bannerbear.html'));
    expect(offPage).toContain('need video, PDF, batch jobs');
    const onPage = text(page(on, 'compare/bannerbear.html'));
    expect(onPage).not.toMatch(/need video, PDF|PDF and AVIF output|Static social cards only|We render still images only/);
    expect(onPage).toContain(`Yes, from HTML templates, up to ${PDF.maxPages} pages`);
  });
});

describe('docs pages with an "unlaunched" notice', () => {
  const contentDir = join(temp, 'unlaunched-content');
  const write = (file: string, text: string): void => {
    mkdirSync(join(contentDir, file, '..'), { recursive: true });
    writeFileSync(join(contentDir, file), text);
  };
  beforeAll(() => {
    write(
      'docs/tool.md',
      [
        '---',
        'title: A tool',
        'description: A docs page of an API behind the batch feature.',
        'layout: doc',
        'order: 1',
        'feature: batch',
        'unlaunched: **Not switched on yet on [[site.host]].** Requests answer 503 `not_configured`.',
        '---',
        '## Usage',
        '',
        'See [the PDF page](/docs/pdfpage#post), [usage](/docs/tool#usage), [a missing part](/docs/tool#gone), [the guide](/docs/guide#intro), [the stylesheet](/assets/css/site.css), [the API](/v1/batches) and [elsewhere](https://example.com/).',
        '',
      ].join('\n'),
    );
    write('docs/pdfpage.md', '---\ntitle: PDF page\ndescription: A docs page behind the pdf feature.\nlayout: doc\norder: 2\nfeature: pdf\n---\n## Post\n');
    write('docs/guide.md', '---\ntitle: Guide\ndescription: A docs page every build has.\nlayout: doc\norder: 3\n---\n## Intro\n');
  });
  const render = (features: string): RenderedSite => renderSite({ contentDir, env: { SITE_FEATURES: features }, now: NOW });
  const article = (site: RenderedSite, outPath: string): string => {
    const html = page(site, outPath);
    return html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  };

  it('are left out without their feature or apidocs, and built as usual with their feature', () => {
    expect(render('').pages.some((built) => built.outPath === 'docs/tool.html')).toBe(false);
    const own = render('pdf,batch');
    expect(article(own, 'docs/tool.html')).not.toContain('not-switched-on');
    expect(own.sitemap).toContain('/docs/tool</loc>');
    expect(navOf(page(own, 'docs/guide.html'))).toContain('href="/docs/tool"');
    expect(article(own, 'docs/tool.html')).toContain('<a href="/docs/tool#gone">a missing part</a>');
  });

  it('with apidocs: open with the notice, are noindex and out of the sitemap and navigation, and link only to what is built', () => {
    const site = render('apidocs');
    const body = article(site, 'docs/tool.html');
    expect(body).toMatch(/^<article class="prose">\n<h1>A tool<\/h1>\n<p class="alert alert-warn" id="not-switched-on" role="note"><strong>Not switched on yet on linktocard\.com\.<\/strong> Requests answer 503 <code>not_configured<\/code>\.<\/p>/);
    expect(page(site, 'docs/tool.html')).toContain('<meta name="robots" content="noindex">');
    expect(site.pages.find((built) => built.outPath === 'docs/tool.html')?.indexed).toBe(false);
    expect(site.sitemap).not.toContain('/docs/tool<');
    expect(navOf(page(site, 'docs/guide.html'))).not.toContain('/docs/tool');
    expect(page(site, 'docs/tool.html')).not.toContain('class="pager"');
    // A page this build does not make, and an anchor the target lacks, become text; everything else stays a link.
    expect(body).toContain('See the PDF page, <a href="/docs/tool#usage">usage</a>, a missing part, <a href="/docs/guide#intro">the guide</a>, <a href="/assets/css/site.css">the stylesheet</a>, <a href="/v1/batches">the API</a> and <a href="https://example.com/">elsewhere</a>.');
    // Other pages are not touched.
    expect(article(render('apidocs,pdf'), 'docs/tool.html')).toContain('<a href="/docs/pdfpage#post">the PDF page</a>');
  });

  it('refuse an "unlaunched" notice without a feature it stands for', () => {
    for (const feature of ['', 'feature: no-batch\n', 'feature: apidocs\n']) {
      const dir = join(temp, `unlaunched-bad-${feature.length}`);
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs/bad.md'), `---\ntitle: Bad\ndescription: A page whose notice stands for nothing.\nlayout: doc\n${feature}unlaunched: Off.\n---\nText.\n`);
      expect(() => renderSite({ contentDir: dir, env: { SITE_FEATURES: 'apidocs' }, now: NOW }), feature).toThrow(/docs\/bad\.md: "unlaunched" needs a "feature"/);
    }
  });
});

describe('deploy scripts and the command line', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const cli = (args: string[], env: Record<string, string>): { status: number | null; output: string } => {
    const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-site.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SITE_PDF: '', SITE_FEATURES: '', ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it('builds staging with every feature and production with the approved free pages only', () => {
    expect(pkg.scripts['deploy:staging']).toBe(`SITE_FEATURES=${FEATURES.join(',')} SITE_PDF=on npm run build:site && wrangler deploy --env staging`);
    // In so many words: a SITE_PDF=on or SITE_FEATURES=... left exported in the shell must not publish
    // more on production, where PDF_ENABLED and the v3 switches are "false". Owner decision of
    // 2026-11-27: the tool hub and the preview checkers (previews), Merge PDF and Image to PDF
    // (localpdf) and the API docs pages with their "not switched on yet" notice (apidocs); no API
    // feature (tests/node/production-site.test.ts audits that build).
    expect(pkg.scripts['deploy:production']).toBe('npm run check:golive && SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off npm run build:site && wrangler deploy --env production');
    expect(pkg.scripts['build:site']).not.toContain('SITE_PDF');
    expect(pkg.scripts['build:site']).not.toContain('SITE_FEATURES');
  });

  it('stops the build on a SITE_PDF value it does not know', () => {
    const { status, output } = cli(['--check-golive'], { SITE_PDF: 'yes' });
    expect(status).toBe(1);
    expect(output).toContain('SITE_PDF must be "on" or "off" (or unset), not "yes"');
    expect(cli(['--check-golive'], { SITE_PDF: 'on' }).status).toBe(0);
  });

  it('renders the same site from renderSite and from the environment the deploy script sets', () => {
    const fromEnv = renderSite({ env: { SITE_PDF: 'on' }, now: NOW });
    expect(fromEnv.pages.some((built) => built.url === '/docs/pdf')).toBe(true);
  });
});
