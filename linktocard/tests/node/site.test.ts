// The static site: flat-file output, tokens fed from plans.ts / config.ts, the
// Markdown pipeline, the go-live placeholder check and the pure parts of the
// browser scripts. Builds go to temp directories so site/dist is left alone.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLANS, PLAN_ORDER, TOPUP, formatCount, formatUsd } from '../../src/billing/plans';
import { INSPECT, LIMITS, RATE_LIMITS } from '../../src/config';
import { buildSite, findPlaceholders, listTokens, renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-22T12:00:00Z');
const temp = mkdtempSync(join(tmpdir(), 'ltc-site-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const HAND_BUILT = ['index.html', 'pricing.html', 'contact.html', 'login.html', 'login/verify.html', 'dashboard.html', '404.html'];
const HEADER_LINKS = ['/', '/docs', '/pricing', '/login'];
// The comparison pages are linked from the footer only: the header carries nothing but the way in.
const FOOTER_LINKS = ['/terms', '/privacy', '/refund', '/pricing', '/docs', '/contact', '/compare/bannerbear', '/compare/vercel-og', '/tools/og-checker'];
/** The Open Graph checker's guides (site/content/guides/<slug>.md). */
const GUIDES = [
  'og-image-not-showing-whatsapp',
  'og-image-not-showing-linkedin',
  'twitter-card-not-showing',
  'facebook-og-image-cache-refresh',
  'og-image-size',
] as const;
/** Pages other engineers write as Markdown; a link to one that is not written yet is reported, not failed. */
const CONTENT_ROUTES = /^\/(terms|privacy|refund|docs(\/[\w-]+)?|compare\/[\w-]+)$/;
/** Paths answered by the Worker, not by a file. */
const WORKER_ROUTES = /^\/(v1|api|auth|playground|webhooks|i)\//;

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '');
const unescapeHtml = (html: string): string =>
  html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const loadScript = async <T>(name: string): Promise<T> =>
  (await import(pathToFileURL(join(ROOT, 'site/public/assets/js', name)).href)) as T;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name],
  );
}

function pageHtml(site: RenderedSite, outPath: string): string {
  const page = site.pages.find((candidate) => candidate.outPath === outPath);
  if (!page) throw new Error(`no page ${outPath}`);
  return page.html;
}

describe('built site', () => {
  const outDir = join(temp, 'dist');
  let site: RenderedSite;
  let files: string[];
  beforeAll(() => {
    site = buildSite({ outDir, env: {}, now: NOW });
    files = walk(outDir);
  });

  it('writes flat .html files and never <dir>/index.html', () => {
    const content = walk(join(ROOT, 'site/content')).filter((file) => file.endsWith('.md'));
    for (const file of [...HAND_BUILT, ...content.map((name) => name.replace(/\.md$/, '.html'))]) {
      expect(files, file).toContain(file);
    }
    expect(files.filter((file) => file.endsWith('/index.html'))).toEqual([]);
    expect(site.pages.map((page) => page.url)).toEqual(expect.arrayContaining(['/', '/pricing', '/login/verify']));
  });

  it('copies assets, self-hosted fonts and the Twemoji set with its licence', () => {
    for (const file of [
      'sitemap.xml',
      'robots.txt',
      '_headers',
      'assets/css/site.css',
      'assets/js/site.js',
      'assets/js/dashboard.js',
      'assets/img/og.png',
      'assets/fonts/inter-latin-400-normal.woff2',
      'assets/fonts/inter-latin-700-normal.woff2',
      'assets/fonts/jetbrains-mono-latin-400-normal.woff2',
      'assets/fonts/source-serif-4-latin-900-normal.woff2',
      'assets/fonts/source-serif-4-latin-900-italic.woff2',
      'assets/fonts/source-serif-4-LICENSE.txt',
      'assets/img/favicon.svg',
      '_emoji/LICENSE.txt',
      '_emoji/1f600.svg',
    ]) {
      expect(files, file).toContain(file);
    }
    expect(files.filter((file) => file.startsWith('_emoji/') && file.endsWith('.svg')).length).toBeGreaterThan(3000);
  });

  it('removes stale files from an earlier build', () => {
    const stale = join(outDir, 'old-page.html');
    writeFileSync(stale, 'stale');
    buildSite({ outDir, env: {}, now: NOW });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(outDir, 'index.html'))).toBe(true);
  });

  it('refuses to build into a source directory, where pruning would delete sources', () => {
    expect(() => buildSite({ outDir: join(ROOT, 'site'), env: {} })).toThrow(/refusing to build into a source directory/);
    expect(existsSync(join(ROOT, 'site/site.config.json'))).toBe(true);
  });

  it('gives every page a title, a description, the header and the full footer', () => {
    for (const page of site.pages) {
      const where = page.outPath;
      expect(page.html, where).toMatch(/<title>[^<]+<\/title>/);
      expect(page.html, where).toMatch(/<meta name="description" content="[^"]+">/);
      const header = page.html.slice(page.html.indexOf('<header class="site-header"'), page.html.indexOf('</header>'));
      // Logo, Docs, Pricing, Sign in and the one primary action: nothing else competes with "Start free".
      expect([...header.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]), `${where} header`).toEqual([...HEADER_LINKS, '/login']);
      expect(header, where).toContain('<a class="btn btn-primary btn-sm" href="/login">Start free</a>');
      expect(header.match(/class="btn/g), `${where} header buttons`).toHaveLength(1);
      const footer = page.html.slice(page.html.indexOf('<footer'), page.html.indexOf('</footer>'));
      for (const href of FOOTER_LINKS) expect(footer, `${where} footer ${href}`).toContain(`href="${href}"`);
      expect(footer, where).toContain('Payments secured by Paddle');
      expect(footer, where).toContain(
        '&copy; 2026 Link To Card &middot; Ahmad Shaaban &middot; Shehim, Chouf, Lebanon &middot; <a href="mailto:support@linktocard.com">support@linktocard.com</a>',
      );
      const legalLinks = footer.slice(footer.indexOf('footer-legal-links'), footer.indexOf('</p>', footer.indexOf('footer-legal-links')));
      expect([...legalLinks.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]), where).toEqual([
        ['/terms', 'Terms'],
        ['/privacy', 'Privacy'],
        ['/refund', 'Refunds'],
        ['/pricing', 'Pricing'],
      ]);
      expect(footer, where).toMatch(/AI tools were used to help build this product\. A human reviews every release\./);
      expect(stripTags(footer), where).toContain('Emoji graphics by Twemoji (CC-BY 4.0).');
    }
  });

  it('keeps every page free of inline scripts, inline handlers and inline styles (CSP: script-src self)', () => {
    for (const page of site.pages) {
      expect(page.html.match(/<script\b(?![^>]*\ssrc=)[^>]*>/g), page.outPath).toBeNull();
      expect(page.html.match(/<[a-z][^>]*\son[a-z]+\s*=/g), page.outPath).toBeNull();
      expect(page.html.match(/<[a-z][^>]*\sstyle\s*=/g), page.outPath).toBeNull();
    }
  });

  it('leaves no unresolved tokens and loads nothing from another origin', () => {
    for (const page of site.pages) {
      expect(page.html.match(/\[\[>?\s*[a-zA-Z][\w.-]*\s*\]\]/g), page.outPath).toBeNull();
      const loaded = [...page.html.matchAll(/<(?:script|img|link|iframe|source)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
      const external = loaded.filter((url) => !url.startsWith('/') && !url.startsWith(`${site.config.url}/`));
      expect(external, page.outPath).toEqual([]);
    }
    const css = readFileSync(join(outDir, 'assets/css/site.css'), 'utf8');
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
    expect(css).not.toContain('@import');
  });

  it('points every internal link and asset at a file that exists', () => {
    const exists = (path: string): boolean =>
      path === '/' || files.includes(path.slice(1)) || files.includes(`${path.slice(1)}.html`);
    const pending = new Set<string>();
    const broken: string[] = [];
    for (const page of site.pages) {
      for (const match of page.html.matchAll(/\s(?:href|src)="(\/[^"#?]*)[^"]*"/g)) {
        const path = match[1] ?? '';
        if (WORKER_ROUTES.test(path) || exists(path)) continue;
        if (CONTENT_ROUTES.test(path)) pending.add(path);
        else broken.push(`${page.outPath} -> ${path}`);
      }
    }
    if (pending.size > 0) console.warn(`Links to content that is not written yet: ${[...pending].sort().join(', ')}`);
    expect(broken).toEqual([]);
  });

  it('prints plans, prices and Paddle catalog names from plans.ts on the pricing page', () => {
    const html = pageHtml(site, 'pricing.html');
    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      const card = html.slice(html.indexOf(`data-plan="${id}"`), html.indexOf('</article>', html.indexOf(`data-plan="${id}"`)));
      expect(card).toContain(`<h3 class="plan-name">${plan.name}</h3>`);
      expect(card).toContain(`<span class="plan-amount">${formatUsd(plan.priceUsd)}</span>`);
      expect(card).toContain(`<strong>${formatCount(plan.monthlyImages)}</strong> images per month`);
      expect(card).toContain(`cached for ${plan.cacheDays} days`);
      if (plan.paddleProductName) {
        expect(card).toContain(`Billed by Paddle as &ldquo;${plan.paddleProductName}&rdquo;`);
        expect(card).toContain(`href="/pricing?checkout=${id}" data-checkout="${id}"`);
      } else {
        expect(card).toContain('href="/login"');
        expect(card).not.toContain('Billed by Paddle');
      }
    }
    expect(html).toContain(`${formatUsd(TOPUP.priceUsd)} top-up: ${formatCount(TOPUP.images)} extra images`);
    expect(html).toContain(`Billed by Paddle as &ldquo;${TOPUP.paddleProductName}&rdquo;`);
    expect(html).toContain(`valid for ${TOPUP.validDays} days`);
    expect(html).toContain('data-checkout="topup"');
    expect(html).toContain(
      'Prices are in USD and exclude tax; Paddle, our reseller and Merchant of Record, adds any applicable sales tax or VAT at checkout.',
    );
    expect(html).toContain('href="/refund"');
    expect(html).toContain('HTTP 402');
    expect(html).toContain(`<th scope="row">Elements per template</th><td>${formatCount(LIMITS.maxNodes)}</td>`);
    expect(html).toContain('<script type="module" src="/assets/js/pricing.js"></script>');
  });

  it('builds the landing page around the promise, the playground and honest copy', () => {
    const html = pageHtml(site, 'index.html');
    const h1 = /<h1>(.*?)<\/h1>/.exec(html)?.[1] ?? '';
    expect(stripTags(h1)).toBe('Turn every link into a beautiful share card.');
    expect(html).toContain('The signed og:image URL for sites that are not on Vercel.');
    expect(html).toContain('<a class="btn btn-primary" href="/login">Start free</a>');
    expect(html).toContain('href="/docs">Read the docs</a>');
    // "Start free" is the only primary action: every primary button on the page is that link.
    const primary = [...html.matchAll(/<a class="btn btn-primary[^"]*" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) => `${match[1]} ${match[2]}`);
    expect(primary.length).toBeGreaterThanOrEqual(3);
    expect(new Set(primary)).toEqual(new Set(['/login Start free']));
    for (const id of ['blog', 'dark', 'quote', 'launch', 'docs']) {
      expect(html).toContain(`<input type="radio" name="template" value="${id}"`);
      // The sample PNG is optional: a missing one renders as a neutral box, never a broken image.
      const hasSample = existsSync(join(ROOT, 'site/public/assets/img/samples', `${id}.png`));
      expect(html.includes(`src="/assets/img/samples/${id}.png"`)).toBe(hasSample);
      expect(html.includes(`aria-label="Sample for the ${id} template is not available yet"`)).toBe(!hasSample);
    }
    expect(html).toContain(`data-origin="${site.config.url}"`);
    expect(html).toContain(`${site.config.url}/v1/og/YOUR_SITE_ID/blog.png?`);
    expect(html).toContain('sig=YOUR_SIGNATURE');
    expect(html.match(/<details class="faq-item">/g)).toHaveLength(8);
    expect(html).toContain('{{placeholders}}');
    expect(html).toContain('<script type="module" src="/assets/js/playground.js"></script>');
    expect(html).not.toMatch(/trusted by|testimonial|uptime|\d+\s?ms\b/i);
  });

  it('opens the playground on a pre-rendered sample: one visible input, five thumbnails, the rest behind "More options"', async () => {
    const html = pageHtml(site, 'index.html');
    const { STARTER_TEMPLATES } = await import('../../src/render/templates');
    const first = STARTER_TEMPLATES[0];
    if (!first) throw new Error('no starter template');
    const form = html.slice(html.indexOf('<form class="composer" id="pg-form">'), html.indexOf('</form>'));
    const more = form.slice(form.indexOf('<details class="more">'));
    expect(more).toContain('<summary>More options</summary>');
    // Before "More options" there is the title and the template picker, nothing else.
    const upFront = form.slice(0, form.indexOf('<details class="more">'));
    expect([...upFront.matchAll(/<input [^>]*name="(\w+)"/g)].map((match) => match[1])).toEqual(['title', ...STARTER_TEMPLATES.map(() => 'template')]);
    expect([...more.matchAll(/<input [^>]*name="(\w+)"/g)].map((match) => match[1])).toEqual(['description', 'author', 'theme', 'theme']);
    expect(upFront).toContain(`name="title" maxlength="120" value="${first.sample.title}"`);
    // Each thumbnail carries its template's sample text, so browsing templates needs no API call.
    for (const template of STARTER_TEMPLATES) {
      const radio = new RegExp(`<input type="radio" name="template" value="${template.id}"[^>]*>`).exec(upFront)?.[0] ?? '';
      expect(unescapeHtml(radio), template.id).toContain(`data-title="${template.sample.title}"`);
      expect(radio, template.id).toContain(`data-theme="${template.sample.theme === 'dark' ? 'dark' : 'light'}"`);
      expect(radio.includes(' checked'), template.id).toBe(template === first);
    }
    // First paint is a file, not an API call (when the sample has been rendered).
    const hasSample = existsSync(join(ROOT, 'site/public/assets/img/samples', `${first.id}.png`));
    expect(html.includes(`<img id="pg-image" src="/assets/img/samples/${first.id}.png"`)).toBe(hasSample);
    expect(html.includes('<img id="pg-image" hidden')).toBe(!hasSample);
    expect(html).not.toContain('src="/playground/');

    // The static snippet and link are what playground.js would print for the same form values.
    type Playground = { metaTagSnippet(origin: string, values: Record<string, string>): string; linkSlug(title: string): string };
    const { metaTagSnippet, linkSlug } = await loadScript<Playground>('playground.js');
    const values = {
      template: first.id,
      title: first.sample.title ?? '',
      description: first.sample.description ?? '',
      author: first.sample.author ?? '',
      theme: first.sample.theme === 'dark' ? 'dark' : 'light',
    };
    const snippet = /<code id="pg-snippet"[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '';
    expect(unescapeHtml(snippet)).toBe(metaTagSnippet(site.config.url, values));
    expect(html).toContain(`your-site.com/<span data-slug>${linkSlug(values.title)}</span>`);
    expect(html).toContain('<code>YOUR_SITE_ID</code> and <code>YOUR_SIGNATURE</code> are placeholders');
  });

  it('ships the dashboard shell, sign-in pages and contact form the scripts expect', () => {
    const dashboard = pageHtml(site, 'dashboard.html');
    expect(dashboard).toMatch(/<main id="app"[^>]*><\/main>/);
    expect(dashboard).toContain('<script type="module" src="/assets/js/dashboard.js"></script>');
    expect(pageHtml(site, 'login.html')).toContain('id="login-form"');
    expect(pageHtml(site, 'login/verify.html')).toContain('id="verify-button"');
    const contact = pageHtml(site, 'contact.html');
    expect(contact).toContain(`action="mailto:${site.config.supportEmail}"`);
    expect(contact).toContain('name="website"');
    for (const name of ['dashboard.html', 'login.html', 'login/verify.html', '404.html']) {
      expect(pageHtml(site, name), name).toContain('<meta name="robots" content="noindex">');
    }
  });

  // Compliance review: each sentence below was proved untrue or incomplete against the code.
  it('describes plans as monthly allowances, never as metered per-image billing', () => {
    for (const name of ['index.html', 'pricing.html']) {
      const text = stripTags(pageHtml(site, name));
      expect(text, name).not.toMatch(/pay per rendered image|priced per rendered image/i);
      expect(text, name).toContain('There is no metered billing and no overage.');
    }
  });

  it('asks for agreement to the terms where an account is created', () => {
    const login = pageHtml(site, 'login.html');
    const form = /<form class="stack" id="login-form">[\s\S]*?<\/form>/.exec(login)?.[0] ?? '';
    expect(form).toContain('you agree to the <a href="/terms">Terms of service</a>');
    expect(form).toContain('<a href="/privacy">Privacy policy</a>');
  });

  it('names in the privacy policy every place the contact form and usage emails go', () => {
    const privacy = unescapeHtml(stripTags(pageHtml(site, 'privacy.html')));
    // src/routes/dashboard.ts POST /api/contact sends the visitor's address and message through Resend.
    expect(privacy).toContain('the email address and message you enter in the contact form');
    expect(privacy).toMatch(/Messages sent with the contact form also pass through Resend/);
    // src/lib/quota.ts mails warnings at 90% and 100%; src/lib/cleanup.ts drops playground previews after a day.
    expect(privacy).toContain('warnings when your monthly allowance is nearly or fully used');
    expect(privacy).toContain('Previews from the playground on the home page: about one day.');
  });

  it('keeps the comparison pages within what our code and research notes support', () => {
    const vercel = unescapeHtml(stripTags(pageHtml(site, 'compare/vercel-og.html')));
    // src/lib/fonts-store.ts refuses WOFF2 uploads.
    expect(vercel).not.toMatch(/adds WOFF2 to the font formats it can read/);
    expect(vercel).toContain('does not accept WOFF2 uploads');
    const bannerbear = unescapeHtml(stripTags(pageHtml(site, 'compare/bannerbear.html')));
    // research/competitors.md tags every bannerbear.com statement [S]: search excerpts, page never opened.
    expect(bannerbear).toContain('are based on search-engine excerpts of bannerbear.com');
    expect(bannerbear).not.toMatch(/"according to their site" come from bannerbear\.com/);
  });

  it('publishes the API description next to the pages, byte for byte', () => {
    expect(readFileSync(join(outDir, 'openapi.yaml'), 'utf8')).toBe(readFileSync(join(ROOT, 'openapi.yaml'), 'utf8'));
  });

  it('lists only public pages in sitemap.xml and points robots.txt at it', () => {
    const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
    for (const path of ['/', '/pricing', '/contact', '/tools/og-checker', '/bot', ...GUIDES.map((slug) => `/guides/${slug}`)]) {
      expect(sitemap).toContain(`<loc>${site.config.url}${path}</loc>`);
    }
    for (const path of ['/dashboard', '/login', '/404']) expect(sitemap).not.toContain(`${site.config.url}${path}`);
    expect(readFileSync(join(outDir, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${site.config.url}/sitemap.xml`);
  });

  it('sets security headers and short asset caching in _headers', () => {
    const headers = readFileSync(join(outDir, '_headers'), 'utf8');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('X-Frame-Options: DENY');
    const csp = headers.split('\n').find((line) => line.trim().startsWith('Content-Security-Policy:')) ?? '';
    expect(csp).toContain("default-src 'self'");
    // Turnstile (the OG checker's optional human check) is the only other origin allowed to run script or frames.
    expect(csp).toContain("script-src 'self' https://cdn.paddle.com https://challenges.cloudflare.com;");
    expect(csp).toContain('frame-src https://*.paddle.com https://challenges.cloudflare.com;');
    expect(csp).toContain("img-src 'self' data: blob: https://*.paddle.com;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=3600\n/);
    expect(headers).not.toContain('immutable\n');
    expect(headers.split('\n').every((line) => line.length < 2000)).toBe(true);
  });

  it('links the Open Graph checker from the home page, the pricing page, the docs and the footer', () => {
    for (const outPath of ['index.html', 'pricing.html', 'docs.html']) {
      const main = pageHtml(site, outPath).slice(0, pageHtml(site, outPath).indexOf('<footer'));
      expect(main, outPath).toMatch(/<a href="\/tools\/og-checker">Open Graph checker<\/a>/);
    }
    const footer = pageHtml(site, 'index.html').slice(pageHtml(site, 'index.html').indexOf('<footer'));
    expect(footer).toContain('<li><a href="/tools/og-checker">Tools</a></li>');
  });

  it('gives each guide its own title and description, a no-JS form to the checker, an FAQ and a way to fix it', () => {
    const titles = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const page of site.pages) {
      const title = /<title>([^<]+)<\/title>/.exec(page.html)?.[1] ?? '';
      const description = /<meta name="description" content="([^"]+)">/.exec(page.html)?.[1] ?? '';
      expect(titles.get(title), `${page.outPath} repeats the title of ${titles.get(title)}`).toBeUndefined();
      expect(descriptions.get(description), `${page.outPath} repeats the description of ${descriptions.get(description)}`).toBeUndefined();
      titles.set(title, page.outPath);
      descriptions.set(description, page.outPath);
    }
    for (const slug of GUIDES) {
      const html = pageHtml(site, `guides/${slug}.html`);
      const where = `guides/${slug}`;
      expect(html, where).toContain('<main class="container page">');
      // Works without JavaScript: a plain GET to the checker, whose script runs ?url= on load.
      const form = /<form [^>]*action="\/tools\/og-checker" method="get">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? '';
      expect(form, where).toContain(`name="url" type="url"`);
      expect(form, where).toContain(`maxlength="${INSPECT.maxUrlChars}" required`);
      expect(form, where).toContain('<button class="btn btn-primary" type="submit">Check</button>');
      const faq = html.slice(html.indexOf('<h2 id="faq">'), html.indexOf('<h2 ', html.indexOf('<h2 id="faq">') + 1));
      expect(html.indexOf('<h2 id="faq">'), where).toBeGreaterThan(-1);
      expect(faq.match(/<h3 /g)?.length ?? 0, where).toBeGreaterThanOrEqual(4);
      expect(html, where).toMatch(/<a href="\/login">Fix it automatically with Link To Card<\/a>/);
    }
  });

  it('writes each guide for its own problem, not one template with the words swapped', () => {
    const seen = new Map<string, string>();
    for (const slug of GUIDES) {
      const html = pageHtml(site, `guides/${slug}.html`);
      const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
      const paragraphs = [...article.matchAll(/<(?:p|li)>([\s\S]*?)<\/(?:p|li)>/g)].map((match) => stripTags(match[1] ?? '').trim());
      for (const text of paragraphs.filter((paragraph) => paragraph.length >= 80)) {
        expect(seen.get(text), `guides/${slug} repeats a paragraph of ${seen.get(text)}: ${text}`).toBeUndefined();
        seen.set(text, slug);
      }
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it('scores the sizes in the image size guide exactly as the checker does', () => {
    const html = pageHtml(site, 'guides/og-image-size.html');
    const rows = [...html.matchAll(/<td>(\d+) x (\d+)<\/td>\s*<td>([\d.]+):1<\/td>\s*<td>(Pass|Warn|Fail)<\/td>/g)];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const [, w, h, shape, verdict] of rows) {
      const width = Number(w);
      const height = Number(h);
      const off = Math.abs(width / height / INSPECT.targetAspectRatio - 1);
      const expected = Math.min(width, height) < INSPECT.minImageSidePx ? 'Fail' : off <= INSPECT.aspectRatioTolerance ? 'Pass' : 'Warn';
      expect(`${w}x${h} ${verdict}`).toBe(`${w}x${h} ${expected}`);
      expect(shape, `${w}x${h}`).toBe((width / height).toFixed(2));
    }
    const text = unescapeHtml(stripTags(html));
    expect(text).toContain(`fails an image smaller than ${INSPECT.minImageSidePx} px on either side, and warns when the shape is more than ${INSPECT.aspectRatioTolerance * 100} % away from ${INSPECT.targetAspectRatio}:1`);
    expect(text).toContain(`warns when the image is over ${INSPECT.imageWarnBytes / (1024 * 1024)} MB, and stops reading at ${INSPECT.imageMaxBytes / (1024 * 1024)} MB`);
  });

  it('states in the privacy policy and the terms what the checker fetches and keeps', () => {
    const privacy = unescapeHtml(stripTags(pageHtml(site, 'privacy.html')));
    // src/inspect/check.ts stores results for INSPECT.cacheTtlMs; src/inspect/limits.ts counts per client per hour.
    expect(privacy).toContain(`Open Graph checker results (the address checked and the tags and measurements read from it): ${INSPECT.cacheTtlMs / 60_000} minutes.`);
    expect(privacy).toContain('a count of checks per IP address (IPv6: per /64 network) for the current hour');
    expect(privacy).toContain(`identifying itself as ${INSPECT.userAgent.split(' ')[0]}`);
    expect(privacy).toMatch(/We never store the page(?:'|&#39;)s HTML\./);
    expect(privacy).toMatch(/Turnstile/);
    const terms = unescapeHtml(stripTags(pageHtml(site, 'terms.html')));
    expect(terms).toContain('It fetches only the one page you ask it to check');
    expect(terms).toContain('use the Open Graph checker to probe, scan or map systems you have no right to probe');
  });

  it('prints the staging origin when SITE_URL overrides the configured one', () => {
    const staging = renderSite({ env: { SITE_URL: 'https://staging.example.workers.dev/' }, now: NOW });
    const html = pageHtml(staging, 'index.html');
    expect(html).toContain('<link rel="canonical" href="https://staging.example.workers.dev/">');
    expect(html).toContain('data-origin="https://staging.example.workers.dev"');
    expect(staging.sitemap).toContain('<loc>https://staging.example.workers.dev/pricing</loc>');
    expect(html).not.toContain('https://linktocard.com');
  });
});

describe('content pipeline', () => {
  const contentDir = join(temp, 'content');
  const write = (file: string, text: string): void => {
    mkdirSync(dirname(join(contentDir, file)), { recursive: true });
    writeFileSync(join(contentDir, file), text);
  };
  const render = (): RenderedSite => renderSite({ contentDir, env: {}, now: NOW });

  beforeAll(() => {
    write('docs.md', '---\ntitle: Documentation\ndescription: Start here.\nlayout: doc\norder: 1\nnav: Overview\n---\n\n# Docs\n\nHello.\n');
    write(
      'docs/quickstart.md',
      [
        '---',
        'title: "Quickstart: [[site.name]]"',
        'description: Render a first card.',
        'layout: doc',
        'order: 2',
        '---',
        '',
        '## Sign & send',
        '',
        '## Sign & send',
        '',
        'Up to [[limit.maxNodes]] nodes on [[site.host]]. A template uses `{{title}}`. Literal: \\[[not.a.token]].',
        '',
        '```js',
        'const url = "[[site.url]]/v1/og/<site>";',
        '```',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '<div class="alert">Raw <b>HTML</b></div>',
        '',
        '[[> rate-limits-table]]',
        '',
      ].join('\n'),
    );
    write('docs/api.md', '---\ntitle: API reference\ndescription: Endpoints.\nlayout: doc\norder: 3\nnav: API\n---\n\nBody.\n');
    write('notice.md', '---\ntitle: Legal notice\ndescription: Who sells this.\nlayout: legal\n---\n\nSold by [[legal.name]], [[legal.address]].\n');
    write('about.md', '---\ntitle: About\ndescription: About this site.\n---\n\nPlain page.\n');
  });

  it('turns every content file into <path>.html with an extensionless URL', () => {
    const site = render();
    for (const [outPath, url] of [
      ['docs.html', '/docs'],
      ['docs/quickstart.html', '/docs/quickstart'],
      ['notice.html', '/notice'],
      ['about.html', '/about'],
    ]) {
      expect(site.pages.find((page) => page.outPath === outPath)?.url).toBe(url);
    }
    expect(site.sitemap).toContain('<loc>https://linktocard.com/docs/quickstart</loc>');
  });

  it('renders Markdown with tokens, heading anchors, copyable code, tables and raw HTML', () => {
    const html = pageHtml(render(), 'docs/quickstart.html');
    expect(html).toContain('<title>Quickstart: Link To Card</title>');
    expect(html).toContain('<h1>Quickstart: Link To Card</h1>');
    expect(html).toContain('<h2 id="sign-send">Sign &amp; send <a class="anchor" href="#sign-send"');
    expect(html).toContain('<h2 id="sign-send-1">');
    expect(html).toContain(`Up to ${formatCount(LIMITS.maxNodes)} nodes on linktocard.com.`);
    expect(html).toContain('<code>{{title}}</code>');
    expect(html).toContain('Literal: [[not.a.token]].');
    expect(html).toContain(
      '<div class="code-block" data-lang="js"><button class="copy-btn" type="button" data-copy>Copy</button><pre><code class="language-js">const url = &quot;https://linktocard.com/v1/og/&lt;site&gt;&quot;;</code></pre></div>',
    );
    expect(html).toMatch(/<div class="table-wrap"><table>\s*<thead>/);
    expect(html).toContain('<div class="alert">Raw <b>HTML</b></div>');
    for (const rule of Object.values(RATE_LIMITS)) {
      expect(html).toContain(`<td>${formatCount(rule.limit)} requests per minute</td>`);
    }
  });

  it('builds the docs sidebar and pager from doc pages sorted by order', () => {
    const html = pageHtml(render(), 'docs/quickstart.html');
    const nav = html.slice(html.indexOf('<nav class="docs-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="docs-nav"')));
    expect([...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((match) => match.slice(1, 4))).toEqual([
      ['/docs', undefined, 'Overview'],
      ['/docs/quickstart', ' aria-current="page"', 'Quickstart: Link To Card'],
      ['/docs/api', undefined, 'API'],
    ]);
    expect(html).toContain('<a class="pager-prev" rel="prev" href="/docs"><span>Previous</span>Overview</a>');
    expect(html).toContain('<a class="pager-next" rel="next" href="/docs/api"><span>Next</span>API</a>');
    expect(pageHtml(render(), 'docs.html').match(/<h1/g)).toHaveLength(1);
  });

  it('renders legal pages in a narrow column with "Last updated" and highlighted placeholders', () => {
    const html = pageHtml(render(), 'notice.html');
    expect(html).toContain('<main class="container page page-legal">');
    expect(html).toContain('<p class="eyebrow">Last updated <time datetime="2026-11-25">25 November 2026</time></p>');
    expect(html).toContain('Sold by Ahmad Shaaban, Nahr Street, Shehim, Chouf, Lebanon.');
    const unfilled = pageHtml(renderSite({ contentDir, env: { SITE_LEGAL_NAME: 'LEGAL_NAME', SITE_LEGAL_ADDRESS: 'LEGAL_ADDRESS' }, now: NOW }), 'notice.html');
    expect(unfilled).toContain('Sold by <mark class="placeholder">LEGAL_NAME</mark>, <mark class="placeholder">LEGAL_ADDRESS</mark>.');
    expect(pageHtml(render(), 'about.html')).toContain('<main class="container page">');
  });

  it.each([
    ['an unknown token', 'bad.md', '---\ntitle: Bad\ndescription: Bad.\n---\n\n[[nope.token]]\n', /bad\.md: unknown token \[\[nope\.token\]\]/],
    ['an unknown partial', 'bad.md', '---\ntitle: Bad\ndescription: Bad.\n---\n\n[[> nope]]\n', /bad\.md: unknown partial \[\[> nope\]\]/],
    ['a missing description', 'bad.md', '---\ntitle: Bad\n---\n\nText.\n', /bad\.md: front matter needs both "title" and "description"/],
    ['missing front matter', 'bad.md', 'Text.\n', /bad\.md: missing front matter/],
    ['an unknown layout', 'bad.md', '---\ntitle: Bad\ndescription: Bad.\nlayout: fancy\n---\n', /bad\.md: unknown layout "fancy"/],
    ['a directory index', 'guides/index.md', '---\ntitle: Bad\ndescription: Bad.\n---\n', /guides\/index\.md: would emit guides\/index\.html/],
  ])('fails the build, naming the file, on %s', (_case, file, text, message) => {
    write(file, text);
    try {
      expect(render).toThrow(message);
    } finally {
      rmSync(join(contentDir, file));
    }
  });
});

describe('tokens', () => {
  const { tokens, partials } = listTokens({ env: {}, now: NOW });

  it('reads plan, top-up and limit values from plans.ts and config.ts', () => {
    expect(tokens).toMatchObject({
      'site.name': 'Link To Card',
      'site.url': 'https://linktocard.com',
      'site.host': 'linktocard.com',
      'site.supportEmail': 'support@linktocard.com',
      'site.year': '2026',
      'legal.name': 'Ahmad Shaaban',
      'legal.address': 'Nahr Street, Shehim, Chouf, Lebanon',
      'legal.locality': 'Shehim, Chouf, Lebanon',
      'legal.updated': '25 November 2026',
      'legal.governingLaw': 'Lebanon',
      'plan.free.paddleName': '(no Paddle product)',
      'plan.starter.price': formatUsd(PLANS.starter.priceUsd),
      'plan.starter.images': formatCount(PLANS.starter.monthlyImages),
      'plan.starter.paddleName': PLANS.starter.paddleProductName,
      'plan.pro.fontFiles': String(PLANS.pro.fonts.maxFiles),
      'plan.pro.fontMb': String(PLANS.pro.fonts.maxBytesPerFile / (1024 * 1024)),
      'plan.pro.support': PLANS.pro.support,
      'plan.free.cacheDays': String(PLANS.free.cacheDays),
      'topup.price': formatUsd(TOPUP.priceUsd),
      'topup.images': formatCount(TOPUP.images),
      'topup.validDays': String(TOPUP.validDays),
      'topup.paddleName': TOPUP.paddleProductName,
      'limit.maxHtmlKb': String(LIMITS.maxHtmlBytes / 1024),
      'limit.maxTextChars': formatCount(LIMITS.maxTextChars),
      'limit.maxImageMb': String(LIMITS.maxImageBytes / (1024 * 1024)),
      'limit.maxImageMegapixels': String(LIMITS.maxImagePixels / 1_000_000),
      'limit.renderTimeoutSeconds': String(LIMITS.renderTimeoutMs / 1000),
    });
  });

  it('defines every token the content authors were promised', () => {
    const planFields = ['name', 'price', 'images', 'cacheDays', 'fontFiles', 'fontMb', 'support', 'paddleName'];
    const limits = [
      'maxHtmlKb', 'maxCssKb', 'maxNodes', 'maxDepth', 'maxTextChars', 'maxDataKeys', 'maxDataValueChars', 'maxImages',
      'maxImageMb', 'maxImageMegapixels', 'maxBlurPx', 'maxFilters', 'renderTimeoutSeconds', 'maxTemplates', 'maxSites', 'maxApiKeys',
    ];
    const required = [
      ...['name', 'url', 'host', 'supportEmail'].map((name) => `site.${name}`),
      ...['name', 'address', 'locality', 'updated', 'governingLaw'].map((name) => `legal.${name}`),
      ...PLAN_ORDER.flatMap((id) => planFields.map((field) => `plan.${id}.${field}`)),
      ...['price', 'images', 'validDays', 'paddleName'].map((name) => `topup.${name}`),
      ...limits.map((name) => `limit.${name}`),
    ];
    expect(required.filter((name) => tokens[name] === undefined)).toEqual([]);
    expect(partials).toEqual(expect.arrayContaining(['pricing-table', 'limits-table', 'rate-limits-table', 'header', 'footer']));
  });

  it('applies the SITE_URL, SITE_LEGAL_NAME and SITE_LEGAL_ADDRESS overrides', () => {
    const overridden = listTokens({
      env: { SITE_URL: 'https://staging.example.workers.dev/', SITE_LEGAL_NAME: 'Example Trading', SITE_LEGAL_ADDRESS: '1 Example Street, Beirut' },
    }).tokens;
    expect(overridden['site.url']).toBe('https://staging.example.workers.dev');
    expect(overridden['site.host']).toBe('staging.example.workers.dev');
    expect(overridden['legal.name']).toBe('Example Trading');
    expect(overridden['legal.address']).toBe('1 Example Street, Beirut');
  });
});

describe('seller identity and Merchant of Record (Paddle website review)', () => {
  const MOR = 'Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders.';
  const SELLER = 'Ahmad Shaaban, trading as Link To Card';
  const site = renderSite({ env: {}, now: NOW });
  const text = (file: string): string => stripTags(pageHtml(site, file)).replace(/\s+/g, ' ');

  it.each(['terms.html', 'privacy.html', 'refund.html'])('%s names the seller with address and contact email', (file) => {
    const page = text(file);
    expect(page).toContain(SELLER);
    expect(page).toContain('Nahr Street, Shehim, Chouf, Lebanon');
    expect(page).toContain('support@linktocard.com');
  });

  it.each(['pricing.html', 'terms.html', 'refund.html'])('%s says Paddle is the Merchant of Record and handles payments and taxes', (file) => {
    const page = text(file);
    expect(page).toContain(MOR);
    expect(page).toContain('Paddle handles payments and taxes');
  });
});

describe('go-live placeholder check', () => {
  const cli = (args: string[], env: Record<string, string>): { status: number | null; output: string } => {
    const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-site.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SITE_LEGAL_NAME: '', SITE_LEGAL_ADDRESS: '', SITE_LEGAL_LOCALITY: '', SITE_URL: '', ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  const UNFILLED = { SITE_LEGAL_NAME: 'LEGAL_NAME', SITE_LEGAL_ADDRESS: 'LEGAL_ADDRESS' };

  it('finds an unfilled legal name and address and the pages that show them', () => {
    const found = findPlaceholders(renderSite({ env: UNFILLED, now: NOW }));
    expect(found.map(({ value }) => value)).toEqual(expect.arrayContaining(['LEGAL_NAME', 'LEGAL_ADDRESS']));
    expect(found.find(({ value }) => value === 'LEGAL_NAME')?.pages).toEqual(expect.arrayContaining(HAND_BUILT));
  });

  it('finds nothing in the shipped configuration: the seller is named on every page', () => {
    const site = renderSite({ env: {}, now: NOW });
    expect(findPlaceholders(site)).toEqual([]);
    expect(pageHtml(site, 'index.html')).toContain('&copy; 2026 Link To Card &middot; Ahmad Shaaban &middot; Shehim, Chouf, Lebanon');
  });

  it('applies the SITE_LEGAL_* overrides to the footer', () => {
    const env = { SITE_LEGAL_NAME: 'Example Trading', SITE_LEGAL_ADDRESS: '1 Example Street, Beirut', SITE_LEGAL_LOCALITY: 'Beirut, Lebanon' };
    expect(pageHtml(renderSite({ env, now: NOW }), 'index.html')).toContain('&copy; 2026 Link To Card &middot; Example Trading &middot; Beirut, Lebanon');
  });

  it('exits non-zero from the command line while placeholders remain, and zero once they are filled', () => {
    const failing = cli(['--check-golive'], UNFILLED);
    expect(failing.status).toBe(1);
    expect(failing.output).toContain('LEGAL_NAME');
    expect(failing.output).toContain('LEGAL_ADDRESS');
    const passing = cli(['--check-golive'], {});
    expect(passing.output).toContain('Go-live check passed');
    expect(passing.status).toBe(0);
  });

  it('prints every token with its value for --tokens', () => {
    const { status, output } = cli(['--tokens'], {});
    expect(status).toBe(0);
    expect(output).toMatch(new RegExp(`\\[\\[plan\\.pro\\.price\\]\\]\\s+\\${formatUsd(PLANS.pro.priceUsd)}\\n`));
    expect(output).toContain('[[> pricing-table]]');
  });
});

describe('browser scripts (pure parts)', () => {
  const load = loadScript;
  afterEach(() => vi.restoreAllMocks());

  type Action = { type: string; url?: string; message?: string; token?: string; environment?: string; options?: unknown };
  type Pricing = { checkoutAction(input: { item: string; user: unknown; config: unknown; origin: string }): Action };
  const config = { paddle: { environment: 'sandbox', client_token: 'test_token', prices: { starter: 'pri_s', pro: 'pri_p', topup: 'pri_t' } } };
  const origin = 'https://linktocard.com';

  it('sends signed-out visitors to sign in and back to the checkout', async () => {
    const { checkoutAction } = await load<Pricing>('pricing.js');
    expect(checkoutAction({ item: 'starter', user: null, config, origin })).toEqual({
      type: 'redirect',
      url: '/login?next=/pricing%3Fcheckout%3Dstarter',
    });
  });

  it('opens an overlay checkout for a free account with the user id as custom data', async () => {
    const { checkoutAction } = await load<Pricing>('pricing.js');
    const user = { id: 'u_1', email: 'a@example.com', plan: 'free' };
    expect(checkoutAction({ item: 'pro', user, config, origin })).toEqual({
      type: 'checkout',
      environment: 'sandbox',
      token: 'test_token',
      options: {
        items: [{ priceId: 'pri_p', quantity: 1 }],
        customer: { email: 'a@example.com' },
        customData: { user_id: 'u_1' },
        settings: { displayMode: 'overlay', successUrl: 'https://linktocard.com/dashboard?checkout=success' },
      },
    });
  });

  it('never opens a second subscription, limits top-ups to paid plans and survives missing Paddle config', async () => {
    const { checkoutAction } = await load<Pricing>('pricing.js');
    const free = { id: 'u_1', email: 'a@example.com', plan: 'free' };
    const paid = { ...free, plan: 'starter' };
    expect(checkoutAction({ item: 'pro', user: paid, config, origin })).toEqual({ type: 'redirect', url: '/dashboard#billing' });
    expect(checkoutAction({ item: 'topup', user: paid, config, origin }).type).toBe('checkout');
    expect(checkoutAction({ item: 'topup', user: free, config, origin }).message).toMatch(/Starter and Pro/);
    expect(checkoutAction({ item: 'starter', user: free, config: { paddle: null }, origin })).toEqual({
      type: 'message',
      message: 'Checkout is not configured yet.',
    });
    const unpriced = { paddle: { ...config.paddle, prices: { starter: '', pro: '', topup: '' } } };
    expect(checkoutAction({ item: 'starter', user: free, config: unpriced, origin }).message).toBe('Checkout is not configured yet.');
  });

  it('builds the playground URL and a meta-tag snippet that only ever contains placeholders', async () => {
    type Playground = {
      playgroundUrl(values: Record<string, string>): string;
      metaTagSnippet(siteOrigin: string, values: Record<string, string>): string;
    };
    const { playgroundUrl, metaTagSnippet } = await load<Playground>('playground.js');
    const values = { template: 'quote', title: 'Hello & welcome', description: '', author: 'Zoë', theme: 'dark' };
    expect(playgroundUrl(values)).toBe('/playground/card.png?template=quote&title=Hello+%26+welcome&author=Zo%C3%AB&theme=dark');
    const snippet = metaTagSnippet(origin, values).split('\n');
    const url = 'https://linktocard.com/v1/og/YOUR_SITE_ID/quote.png?title=Hello+%26+welcome&amp;author=Zo%C3%AB&amp;theme=dark&amp;sig=YOUR_SIGNATURE';
    expect(snippet).toEqual([
      `<meta property="og:image" content="${url}">`,
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${url}">`,
    ]);
    expect(metaTagSnippet(origin, { template: 'blog' })).toContain('/v1/og/YOUR_SITE_ID/blog.png?sig=YOUR_SIGNATURE"');
  });

  it('turns a title into the page address shown in the mock chat', async () => {
    const { linkSlug } = await load<{ linkSlug(title: string): string }>('playground.js');
    expect(linkSlug('Design for the first glance')).toBe('design-for-the-first-glance');
    expect(linkSlug('  Hello, World & more!  ')).toBe('hello-world-more');
    expect(linkSlug('Zoë: 100% naïve')).toBe('zo-100-na-ve');
    expect(linkSlug('')).toBe('your-page');
    expect(linkSlug('!!!')).toBe('your-page');
    const long = linkSlug('a'.repeat(47) + ' bcdef');
    expect(long).toBe('a'.repeat(47));
    expect(long.length).toBeLessThanOrEqual(48);
  });

  it('posts JSON and surfaces the API error message', async () => {
    type Api = { postJson(url: string, payload: unknown): Promise<unknown>; errorMessage(response: Response): Promise<string> };
    const { postJson, errorMessage } = await load<Api>('api.js');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (input === '/auth/magic-link') {
        expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ email: 'a@example.com' }) });
        return Response.json({ ok: true });
      }
      if (input === '/api/contact') {
        return Response.json({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } }, { status: 429 });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    await expect(postJson('/auth/magic-link', { email: 'a@example.com' })).resolves.toEqual({ ok: true });
    await expect(postJson('/api/contact', {})).rejects.toThrow('Too many requests. Try again in a minute.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(errorMessage(new Response('<h1>Bad gateway</h1>', { status: 502 }))).resolves.toBe(
      'The server had a problem (HTTP 502). Wait a minute, then try again.',
    );
  });
});
