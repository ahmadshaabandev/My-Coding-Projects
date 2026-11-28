// The production site, audited (owner decision of 2026-11-27). Built with the exact environment that
// `npm run deploy:production` gives `npm run build:site`, it must publish the old production site (the
// build with every feature off, SITE_FEATURES= SITE_PDF=off) plus exactly the approved pages:
//   - the tool hub /tools and the five one-app preview checkers (previews);
//   - /tools/merge-pdf and /tools/image-to-pdf, which run in the browser (localpdf);
//   - the docs pages /docs/bulk, /docs/pdf-tools, /docs/link-cards and /docs/email-images
//     (apidocs), each opening with a notice that its API is not switched on yet.
// /docs/integrations is not published: the connectors stay unpublished (decision 6).
// Nothing else may change: every old page reads as before except the footer's tool links and the
// pricing page's two free-tool lines, no link is broken, and no page outside the four docs pages says
// that bulk documents, the PDF toolkit API, cards from links, email images or PDF documents are
// available. The production Worker switches (wrangler.toml) are checked to be off for every API
// whose site feature is off. Builds go to temp directories, so site/dist is left alone.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDF } from '../../src/config';
import { FEATURES, FOOTER_ASSET, LOCAL_PDF_BUNDLE, buildSite, type Feature, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-27T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'ltc-production-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** The pages the owner approved for production that are free tools (indexed, in sitemap.xml). */
const FREE_PAGES = [
  'tools.html',
  'tools/x-card-validator.html',
  'tools/linkedin-post-preview.html',
  'tools/slack-link-preview.html',
  'tools/discord-embed-preview.html',
  'tools/whatsapp-link-preview.html',
  'tools/merge-pdf.html',
  'tools/image-to-pdf.html',
] as const;

/** The approved docs pages, with the site feature of the API each documents (off in production). */
const API_DOCS: Readonly<Record<string, Feature>> = {
  'docs/bulk.html': 'batch',
  'docs/pdf-tools.html': 'toolkit',
  'docs/link-cards.html': 'linkcards',
  'docs/email-images.html': 'email',
};
const APPROVED = [...FREE_PAGES, ...Object.keys(API_DOCS)].sort();

/** Files the free pages need, and the only non-page files production adds. */
const FREE_PAGE_FILES = ['assets/css/og-platform.css', 'assets/js/og-platform.js', 'assets/js/local-files.js', 'assets/js/merge-pdf.js', 'assets/js/image-to-pdf.js', LOCAL_PDF_BUNDLE];

/** Each API's site feature and its Worker switch in wrangler.toml. */
const API_SWITCHES: Readonly<Record<string, string>> = {
  pdf: 'PDF_ENABLED',
  batch: 'BATCH_ENABLED',
  toolkit: 'PDF_TOOLKIT_ENABLED',
  linkcards: 'LINK_CARDS_ENABLED',
  email: 'EMAIL_FIELDS_ENABLED',
};

/** Words that say one of the switched-off tools is there. None may appear outside the four docs pages. */
const OFF_TOOL_PHRASES = [
  '/v1/pdf',
  '/v1/batches',
  '/v1/cards',
  '/v1/link',
  '/v1/certificates',
  'PDF toolkit',
  'Bulk documents',
  'bulk documents',
  'verification page',
  'Cards from links',
  'card from a link',
  'open field',
  'Open field',
  'email image',
  'Email image',
  'Browser Run',
  'HTML to PDF',
  'Invoice generator',
  'Certificate generator',
  'PDF documents',
  'PDF starter',
  PDF.freeMark,
  'being prepared for listing',
  'Zapier',
  'n8n',
  // The PDF toolkit's API is off: nothing outside its docs page may offer to automate a PDF tool.
  'Automate this with the API',
];

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/** The variables a deploy script sets in front of `npm run build:site`, e.g. { SITE_FEATURES: 'previews', SITE_PDF: 'off' }. */
function buildEnv(script: string): Record<string, string> {
  const step = (pkg.scripts[script] ?? '').split('&&').map((part) => part.trim()).find((part) => part.endsWith('npm run build:site'));
  if (!step) throw new Error(`${script} does not run npm run build:site`);
  const env: Record<string, string> = {};
  for (const assignment of step.slice(0, -'npm run build:site'.length).trim().split(/\s+/).filter(Boolean)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(assignment);
    if (!match) throw new Error(`${script}: "${assignment}" is not NAME=value`);
    env[match[1]!] = match[2]!;
  }
  return env;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name]));
}

const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', middot: '·', times: '×', hellip: '…', nbsp: ' ', copy: '©' };
const unescapeHtml = (html: string): string =>
  html
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|middot|times|hellip|nbsp|copy);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (html: string): string => unescapeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const footerOf = (html: string): string => html.slice(html.indexOf('<footer'), html.indexOf('</footer>') + '</footer>'.length);
const withoutFooter = (html: string): string => html.replace(footerOf(html), '');
const docsNavOf = (html: string): string => {
  const start = html.indexOf('<nav class="docs-nav"');
  return start < 0 ? '' : html.slice(start, html.indexOf('</nav>', start));
};

interface Built {
  site: RenderedSite;
  dir: string;
  files: string[];
  /** Output path -> HTML of every page, read back from the output directory. */
  html: Map<string, string>;
}

function build(name: string, env: Record<string, string>): Built {
  const dir = join(temp, name);
  const site = buildSite({ outDir: dir, env, now: NOW });
  const files = walk(dir).sort();
  return { site, dir, files, html: new Map(site.pages.map((page) => [page.outPath, readFileSync(join(dir, page.outPath), 'utf8')])) };
}

let production: Built;
let old: Built;
let staging: Built;
beforeAll(() => {
  production = build('production', buildEnv('deploy:production'));
  old = build('old-production', { SITE_FEATURES: '', SITE_PDF: 'off' });
  staging = build('staging', buildEnv('deploy:staging'));
});

const pagesOf = (built: Built): string[] => built.site.pages.map((page) => page.outPath).sort();
const html = (built: Built, outPath: string): string => {
  const found = built.html.get(outPath);
  if (found === undefined) throw new Error(`no page ${outPath}`);
  return found;
};

describe('the production build', () => {
  it('is built with previews, localpdf and apidocs, and no API feature', () => {
    expect(buildEnv('deploy:production')).toEqual({ SITE_FEATURES: 'previews,localpdf,apidocs', SITE_PDF: 'off' });
    const on = FEATURES.filter((feature) => production.site.features[feature]);
    expect(on).toEqual(['previews', 'localpdf', 'apidocs']);
    // Staging keeps every feature.
    expect(FEATURES.filter((feature) => !staging.site.features[feature])).toEqual([]);
  });

  it('switches off in production every API whose site feature it leaves out', () => {
    const toml = read('wrangler.toml');
    const vars = toml.slice(toml.search(/^\[env\.production\.vars\]/m));
    const section = vars.slice(0, vars.slice(1).search(/^\[/m) + 1 || undefined);
    for (const [feature, name] of Object.entries(API_SWITCHES)) {
      const value = new RegExp(`^${name} = "([^"]*)"$`, 'm').exec(section)?.[1];
      expect(value, name).toBeDefined();
      if (!production.site.features[feature as Feature]) expect(value, `${name} is on in production but the site leaves "${feature}" out`).toBe('false');
    }
  });

  it('publishes the old production pages plus exactly the approved pages', () => {
    const added = pagesOf(production).filter((page) => !pagesOf(old).includes(page));
    expect(added).toEqual(APPROVED);
    expect(pagesOf(old).filter((page) => !pagesOf(production).includes(page))).toEqual([]);
    expect(pagesOf(production)).toHaveLength(pagesOf(old).length + 12);
    // The connectors page stays out of production until the connectors are published (decision 6).
    expect(pagesOf(production)).not.toContain('docs/integrations.html');
    expect(pagesOf(staging)).toContain('docs/integrations.html');
    // The same holds for every published file: the approved pages and the scripts the free tools load.
    const addedFiles = production.files.filter((file) => !old.files.includes(file));
    expect(addedFiles.sort()).toEqual([...APPROVED, ...FREE_PAGE_FILES].sort());
    expect(old.files.filter((file) => !production.files.includes(file))).toEqual([]);
  });

  it('changes no old page, except the footer\'s tool links, the pricing page\'s free-tool lines and the home page\'s tool grid', () => {
    const freeToolLines = [
      '<p class="section-foot">The same goes for the one-app link preview checkers among the <a href="/tools">free tools</a>.</p>\n',
      '<p class="section-foot">The free <a href="/tools/merge-pdf">Merge PDF</a> and <a href="/tools/image-to-pdf">Image to PDF</a> tools run in your browser: no account, the files are not uploaded, and nothing is counted.</p>\n',
    ];
    const footerLinks = ['<li><a href="/tools/merge-pdf">Merge PDF</a></li>\n', '<li><a href="/tools/image-to-pdf">Image to PDF</a></li>\n', '<li><a href="/tools">All free tools</a></li>\n'];
    const changed: string[] = [];
    for (const outPath of pagesOf(old)) {
      let page = withoutFooter(html(production, outPath));
      if (outPath === 'pricing.html') {
        for (const line of freeToolLines) {
          expect(page, line).toContain(line);
          page = page.replace(line, '');
        }
      }
      let before = withoutFooter(html(old, outPath));
      if (outPath === 'index.html') {
        // The home page lists the tools of its build: its description, the chips' counts and the tiles follow the
        // features (tests/node/home-tools.test.ts says which tiles). Everything else on it is the same, byte for byte.
        const toolIds = (text: string): string[] => [...text.matchAll(/ data-tool="([a-z-]+)"/g)].map((match) => match[1]!);
        expect(toolIds(before)).toEqual(['og-checker', 'card-builder', 'api', 'signed-urls']);
        expect(toolIds(page).filter((id) => !toolIds(before).includes(id))).toEqual([
          'x-card-validator',
          'linkedin-post-preview',
          'slack-link-preview',
          'discord-embed-preview',
          'whatsapp-link-preview',
          'merge-pdf',
          'image-to-pdf',
        ]);
        const withoutTools = (text: string): string =>
          text
            .replace(/<meta (?:name="description"|property="og:description") content="[^"]*">/g, '')
            .replace(/<div class="tool-chips"[\s\S]*?<\/div>/, '')
            .replace(/<div class="tool-grid[\s\S]*?<\/div>\n(?=<p class="visually-hidden" id="tool-status")/, '');
        expect(withoutTools(page)).not.toContain('tool-tile');
        page = withoutTools(page);
        before = withoutTools(before);
      }
      if (page !== before) changed.push(outPath);
      let footer = footerOf(html(production, outPath));
      for (const line of footerLinks) {
        expect(footer, `${outPath}: ${line}`).toContain(line);
        footer = footer.replace(line, '');
      }
      expect(footer, outPath).toBe(footerOf(html(old, outPath)));
    }
    expect(changed).toEqual([]);
    for (const file of ['openapi.yaml', 'robots.txt', '_headers', '_redirects']) {
      expect(readFileSync(join(production.dir, file), 'utf8'), file).toBe(readFileSync(join(old.dir, file), 'utf8'));
    }
  });

  it('lists the free pages in sitemap.xml, and not the docs pages of APIs that are off', () => {
    const urls = (built: Built): string[] => [...built.site.sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
    const added = urls(production).filter((url) => !urls(old).includes(url));
    expect(added.sort()).toEqual(FREE_PAGES.map((page) => `${production.site.config.url}/${page.replace(/\.html$/, '')}`).sort());
    expect(urls(old).filter((url) => !urls(production).includes(url))).toEqual([]);
  });

  it('has no broken internal link or anchor', () => {
    const files = new Set(production.files);
    const exists = (path: string): boolean => path === '/' || files.has(path.slice(1)) || files.has(`${path.slice(1)}.html`);
    const broken: string[] = [];
    let links = 0;
    for (const [outPath, page] of production.html) {
      for (const match of page.matchAll(/\s(?:href|src|action)="(\/[^"#?]*)(?:\?[^"#]*)?(?:#([^"]*))?"/g)) {
        links += 1;
        const path = match[1] ?? '';
        // Worker routes: the API, sign-in, the playground, stored files and verification pages.
        if (/^\/(v1|api|auth|playground|webhooks|i|v)\//.test(path)) continue;
        if (!exists(path)) {
          broken.push(`${outPath} -> ${path}`);
          continue;
        }
        const anchor = match[2];
        const target = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
        if (anchor && production.html.has(target) && !html(production, target).includes(` id="${anchor}"`)) broken.push(`${outPath} -> ${path}#${anchor}`);
      }
      // Same-page anchors.
      for (const match of page.matchAll(/\shref="#([^"]+)"/g)) {
        if (!page.includes(` id="${match[1]}"`)) broken.push(`${outPath} -> #${match[1]}`);
      }
    }
    expect(links).toBeGreaterThan(1000);
    expect(broken).toEqual([]);
  });

  it('says nowhere outside the four docs pages that a switched-off tool is available', () => {
    const outside = [...production.html].filter(([outPath]) => !(outPath in API_DOCS));
    expect(outside).toHaveLength(pagesOf(old).length + FREE_PAGES.length);
    const found: string[] = [];
    for (const [outPath, page] of outside) {
      const visible = text(page);
      // An old page may keep what the old production page said (compare/bannerbear.html names Zapier as
      // Bannerbear's, and says we offer nothing of the kind); the test above proves it says nothing new.
      const before = old.html.has(outPath) ? text(html(old, outPath)) : '';
      for (const phrase of OFF_TOOL_PHRASES) if (visible.includes(phrase) && !before.includes(phrase)) found.push(`${outPath}: ${phrase}`);
      // No page outside the approved docs pages links to one: they document tools that are off
      // (review EXP-1: the in-browser tools sent "Automate this with the API" to /docs/pdf-tools).
      for (const match of page.matchAll(/href="(\/docs\/(?:bulk|pdf-tools|link-cards|email-images|integrations))[#"]/g)) found.push(`${outPath} links to ${match[1]}`);
      expect(page, outPath).not.toContain('id="not-switched-on"');
    }
    expect(found).toEqual([]);
    // The in-browser tools say what they are, and the hub lists only what this build publishes.
    const hub = html(production, 'tools.html');
    const main = hub.slice(hub.indexOf('<main'), hub.indexOf('</main>'));
    const listed = [...main.matchAll(/<dt><a href="([^"]+)"/g)].map((match) => match[1]!);
    expect(listed).toEqual(['/tools/og-checker', ...FREE_PAGES.filter((page) => page.startsWith('tools/') && !page.includes('-pdf')).map((page) => `/${page.replace(/\.html$/, '')}`), '/#playground', '/tools/merge-pdf', '/tools/image-to-pdf']);
  });

  it('opens each approved docs page with its notice, keeps it noindex and out of the docs navigation', () => {
    for (const [outPath, feature] of Object.entries(API_DOCS)) {
      const page = html(production, outPath);
      const article = page.slice(page.indexOf('<article class="prose">'), page.indexOf('</article>'));
      // Right under the heading, before anything else the page says.
      expect(article, outPath).toMatch(/^<article class="prose">\n<h1>[^<]+<\/h1>\n<p class="alert alert-warn" id="not-switched-on" role="note"><strong>/);
      const notice = text(/<p class="alert alert-warn" id="not-switched-on" role="note">([\s\S]*?)<\/p>/.exec(page)?.[1] ?? '').trim();
      expect(notice, outPath).toMatch(/^Not switched on yet on linktocard\.com\. /);
      expect(notice, outPath).toContain(feature === 'email' ? '403 invalid_signature' : '503 not_configured');
      expect(page, outPath).toContain('<meta name="robots" content="noindex">');
      expect(production.site.pages.find((built) => built.outPath === outPath)?.indexed, outPath).toBe(false);
      // In the full build (staging) the same page has no notice, is indexed and is in the navigation.
      expect(html(staging, outPath), outPath).not.toContain('id="not-switched-on"');
      expect(docsNavOf(html(staging, 'docs.html')), outPath).toContain(`href="/${outPath.replace(/\.html$/, '')}"`);
    }
    for (const [outPath, page] of production.html) {
      for (const docs of Object.keys(API_DOCS)) expect(docsNavOf(page), `${outPath} lists ${docs}`).not.toContain(`href="/${docs.replace(/\.html$/, '')}"`);
    }
    // A docs page has no previous/next pager when it is not in the navigation.
    for (const outPath of Object.keys(API_DOCS)) expect(html(production, outPath), outPath).not.toContain('class="pager"');
  });

  it('prints links to pages it does not publish as their text', () => {
    // /docs/bulk links POST /v1/pdf to /docs/pdf (a PDF page) in the full build; production keeps the words.
    expect(html(staging, 'docs/bulk.html')).toContain('<a href="/docs/pdf#post-v1-pdf"><code>POST /v1/pdf</code></a>');
    expect(html(production, 'docs/bulk.html')).not.toContain('href="/docs/pdf');
    expect(html(production, 'docs/bulk.html')).toContain('exactly like a <code>POST /v1/pdf</code> request');
    // The email page's guide is an email-feature page: named, not linked (its notice says so, see the next test).
    expect(html(staging, 'docs/email-images.html')).toContain('href="/guides/personalized-email-images"');
    expect(html(production, 'docs/email-images.html')).not.toContain('href="/guides/');
    // Links among the approved pages stay links.
    expect(html(production, 'docs/pdf-tools.html')).toContain('<a href="/tools/merge-pdf">Merge PDF</a>');
  });

  it('sends no reader to a page it does not publish without saying so (review EXP-5)', () => {
    // A link to an unpublished page becomes its text, so a sentence that says where to read more
    // would point at nothing on linktocard.com. In bulk and pdf-tools those sentences are feature
    // blocks of their target. The two email pages may carry no feature blocks
    // (tests/node/email-content-draft.test.ts), so the email page's notice says that the guide it
    // refers to is not published yet, as the bulk and toolkit notices say of PDF documents.
    const references = ['PDF documents lists', 'described in PDF documents', 'the one in PDF documents', 'the mark of PDF documents'];
    for (const outPath of Object.keys(API_DOCS)) {
      const visible = text(html(production, outPath));
      for (const phrase of references) expect(visible, `${outPath}: ${phrase}`).not.toContain(phrase);
      if (outPath !== 'docs/email-images.html') for (const phrase of ['see the guide', 'The guide lists']) expect(visible, `${outPath}: ${phrase}`).not.toContain(phrase);
    }
    const emailNotice = text(/<p class="alert alert-warn" id="not-switched-on" role="note">([\s\S]*?)<\/p>/.exec(html(production, 'docs/email-images.html'))?.[1] ?? '');
    expect(emailNotice).toContain('The guide this page refers to, Personalized email images, is not published here yet either.');
    // The guide is the only page the email page's own text links to that production does not publish.
    const published = new Set(production.site.pages.map((page) => page.url));
    const emailTargets = [...read('site/content/docs/email-images.md').matchAll(/\]\((\/[^)#?\s]*)/g)].map((match) => match[1]!).filter((path) => !path.startsWith('/v1/') && !published.has(path));
    expect([...new Set(emailTargets)]).toEqual(['/guides/personalized-email-images']);
    // What production says instead, where the sentence needs an ending.
    expect(text(html(production, 'docs/bulk.html'))).toContain('Every other limit of a PDF, such as its HTML size and its images, is the one of a POST /v1/pdf request.');
    expect(text(html(production, 'docs/bulk.html'))).toContain('line. The per-minute limit');
    expect(text(html(production, 'docs/pdf-tools.html'))).toContain('on a white background of its own. It is part of the page');
    // The full build keeps every reference, linked, and has no notice.
    expect(html(staging, 'docs/email-images.html')).toContain('see the guide <a href="/guides/personalized-email-images">Personalized email images</a>.');
    expect(html(staging, 'docs/email-images.html')).toContain('The <a href="/guides/personalized-email-images#merge-tags-by-platform">guide</a> lists the platforms');
    expect(html(staging, 'docs/bulk.html')).toContain('<a href="/docs/pdf#starter-templates">PDF documents</a> lists the keys of every starter template.');
    expect(html(staging, 'docs/bulk.html')).toContain('line, as described in <a href="/docs/pdf#the-free-footer-mark">PDF documents</a>.');
    expect(html(staging, 'docs/bulk.html')).toContain('is the one in <a href="/docs/pdf#limits">PDF documents</a>.');
    expect(html(staging, 'docs/pdf-tools.html')).toContain('like the mark of <a href="/docs/pdf#the-free-footer-mark">PDF documents</a>.');
  });

  it('publishes the footer of its pages for the pages the Worker renders', () => {
    for (const built of [production, old, staging]) {
      const asset = readFileSync(join(built.dir, FOOTER_ASSET), 'utf8');
      expect(asset).toBe(built.site.footer);
      for (const [outPath, page] of built.html) expect(footerOf(page), outPath).toBe(asset);
    }
    const asset = readFileSync(join(production.dir, FOOTER_ASSET), 'utf8');
    for (const href of ['/tools', '/tools/merge-pdf', '/tools/image-to-pdf']) expect(asset).toContain(`<a href="${href}">`);
    // Kept out of search results (site/public/_headers).
    expect(read('site/public/_headers')).toMatch(/^\/assets\/partials\/\*\n {2}X-Robots-Tag: noindex$/m);
  });
});
