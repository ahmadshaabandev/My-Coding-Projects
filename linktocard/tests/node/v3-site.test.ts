// The build v3 statements outside the v3 docs pages themselves: the legal pages, the counting
// rules, the limits table, the API reference and signed-URL rules, the docs navigation and the
// pricing page. Every statement is behind the site feature of the tool it describes, so a build
// with every feature off (production: SITE_FEATURES= SITE_PDF=off) prints none of them and its
// terms and privacy policy read exactly as before, while a build with the feature prints it with
// the numbers of src/config.ts. Sites are rendered in memory, so site/dist is left alone.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER, formatCount } from '../../src/billing/plans';
import { BATCH, EMAIL_FIELDS, FEATURE_FLAGS, INSPECT, PDF, PDF_TOOLKIT } from '../../src/config';
import { FEATURES, buildSite, renderSite, type Feature, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-26T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, ' ');
const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', middot: '·', times: '×', hellip: '…', nbsp: ' ' };
const unescapeHtml = (html: string): string =>
  html
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|middot|times|hellip|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (html: string): string => unescapeHtml(stripTags(html)).replace(/\s+/g, ' ');

function page(site: RenderedSite, outPath: string): string {
  const found = site.pages.find((candidate) => candidate.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
}

/** The features of build v3 (pdf is older and has its own tests in site-features and pdf-site). */
const V3: readonly Feature[] = ['batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations'];

/** The pages each v3 feature publishes; the test below checks this against the front matter. */
const PAGES_BY_FEATURE: Record<string, string[]> = {
  batch: ['docs/bulk.html'],
  toolkit: ['docs/pdf-tools.html', 'tools/image-to-pdf.html', 'tools/merge-pdf.html'],
  linkcards: ['docs/link-cards.html'],
  email: ['docs/email-images.html', 'guides/personalized-email-images.html'],
  previews: ['tools.html', 'tools/discord-embed-preview.html', 'tools/linkedin-post-preview.html', 'tools/slack-link-preview.html', 'tools/whatsapp-link-preview.html', 'tools/x-card-validator.html'],
  integrations: ['docs/integrations.html'],
};

/** What the legal pages say about each feature; none of it may appear in a build without the feature. */
const LEGAL: Record<string, { terms: string[]; privacy: string[] }> = {
  batch: {
    terms: [
      '4a. Verification pages',
      'By issuing a verified document you confirm that you are allowed to publish those facts, including the recipient\'s name, and that the recipient knows the page exists.',
      'The page confirms only that your account created the record. We do not check who you are, whether you may issue the document, or whether its facts are true',
      `A revoked record is shown as revoked for ${BATCH.revokedRetentionDays} days and is then deleted`,
      'issue documents with a verification record that names an issuer, an accreditation, an achievement or a recipient that is not real',
      'Bulk documents: each document of a batch counts like a PDF of its pages when it is made.',
      `A batch is accepted only when at least ${PDF.baseUnits} images per row are left`,
    ],
    privacy: [
      'Verification pages are public.',
      'the domain of the email address the issuing account signs in with',
      'their titles and link previews do not contain the recipient\'s name, and the JSON version can be read from any website.',
      'Bulk documents and certificate records : the rows you send, one per document',
      `A revoked record is kept for ${BATCH.revokedRetentionDays} days after the revocation`,
      'If you are named on a verification page, the issuer decides about that record',
      'Verification pages set no cookie and load no script.',
    ],
  },
  toolkit: {
    terms: [
      'It also offers a PDF toolkit that merges, splits, stamps, fills and password-protects PDF files',
      'the files you choose there are not sent to us.',
      'Files you send to the PDF toolkit stay yours too. We use them only to make the result you asked for, while the request runs, and do not keep them.',
      'send files to the PDF toolkit that you have no right to copy or change',
      `PDF toolkit: a result counts one image for each started block of ${PDF_TOOLKIT.pagesPerUnit} pages, at least one`,
    ],
    privacy: [
      'PDF toolkit files : the PDFs and images you send, upload or link to',
      'Files sent to the PDF toolkit, and files it downloads for you: not stored; they are read while the request runs.',
      'identifying itself as LinkToCard-FileFetcher/1.0',
    ],
  },
  linkcards: {
    terms: ['It can also make a card from what a web page that you name says about itself', 'Cards from links: a card made from a page counts as one image, like any card.'],
    privacy: ['Cards from links : the page address you name', `what was read from the page, for ${INSPECT.cacheTtlMs / 60_000} minutes`, 'When you make a card from a link, our server reads that page in the same way as the Open Graph checker'],
  },
  email: {
    terms: [
      'Signed image URLs can also have open fields',
      'use open fields in emails sent to people who did not agree to receive them, for anything other than short display text (never email addresses or other personal details)',
      'Personalized email images: each distinct set of open-field values is one image',
    ],
    privacy: ['Open-field values : the short values, such as a first name', 'Open-field values travel in image addresses.', 'The count of new personalized images per site and day: until the end of the next day (UTC)'],
  },
};

const only = (...on: Feature[]): RenderedSite => renderSite({ env: { SITE_FEATURES: on.join(',') }, now: NOW });

let off: RenderedSite;
let all: RenderedSite;
const one: Record<string, RenderedSite> = {};
beforeAll(() => {
  off = renderSite({ env: {}, now: NOW });
  all = renderSite({ env: { SITE_FEATURES: FEATURES.join(','), SITE_PDF: 'on' }, now: NOW });
  for (const feature of V3) one[feature] = only(feature);
});

describe('the v3 pages', () => {
  it('are exactly the pages whose front matter names a v3 feature', () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`).map((file) => `${entry.name}/${file}`) : [entry.name]));
    const gated: Record<string, string[]> = {};
    for (const [dir, ext] of [['site/pages', '.html'], ['site/content', '.md']] as const) {
      for (const file of walk(dir).filter((name) => name.endsWith(ext))) {
        const feature = /^feature:\s*([a-z-]+)\s*$/m.exec(read(`${dir}/${file}`).split(/^---\s*$/m)[1] ?? '')?.[1];
        if (feature && V3.includes(feature as Feature)) (gated[feature] ??= []).push(file.replace(/\.md$/, '.html'));
      }
    }
    for (const feature of V3) expect((gated[feature] ?? []).sort(), feature).toEqual([...(PAGES_BY_FEATURE[feature] ?? [])].sort());
    // No draft is left behind: every v3 page is published under its feature.
    expect(walk('site/content').filter((file) => file.endsWith('.draft'))).toEqual([]);
    expect(walk('site/pages').filter((file) => file.endsWith('.draft'))).toEqual([]);
  });

  it('are built only with their feature, and listed in the docs navigation only then', () => {
    const outPaths = (site: RenderedSite): string[] => site.pages.map((built) => built.outPath);
    const nav = (site: RenderedSite): string => {
      const html = page(site, 'docs.html');
      return html.slice(html.indexOf('<nav class="docs-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="docs-nav"')));
    };
    for (const feature of V3) {
      for (const file of PAGES_BY_FEATURE[feature] ?? []) {
        expect(outPaths(off), file).not.toContain(file);
        expect(outPaths(one[feature]!), file).toContain(file);
        expect(outPaths(all), file).toContain(file);
        if (file.startsWith('docs/')) {
          const href = `href="/${file.replace(/\.html$/, '')}"`;
          expect(nav(off), file).not.toContain(href);
          expect(nav(one[feature]!), file).toContain(href);
        }
      }
    }
  });
});

describe('the build with every feature (staging)', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ltc-v3-'));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('resolves every internal link and anchor to a page or a file', () => {
    const built = buildSite({ outDir: temp, env: { SITE_FEATURES: FEATURES.join(','), SITE_PDF: 'on' }, now: NOW });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name]));
    const files = new Set(walk(temp));
    const exists = (path: string): boolean => path === '/' || files.has(path.slice(1)) || files.has(`${path.slice(1)}.html`);
    const broken: string[] = [];
    for (const builtPage of built.pages) {
      for (const match of builtPage.html.matchAll(/\s(?:href|src)="(\/[^"#?]*)(?:#([^"]*))?[^"]*"/g)) {
        const path = match[1] ?? '';
        if (/^\/(v1|api|auth|playground|webhooks|i|v)\//.test(path)) continue;
        if (!exists(path)) broken.push(`${builtPage.outPath} -> ${path}`);
        const anchor = match[2];
        if (anchor && path !== '/' && built.pages.some((other) => other.url === path) && !page(built, `${path.slice(1)}.html`).includes(` id="${anchor}"`)) {
          broken.push(`${builtPage.outPath} -> ${path}#${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
    // And stays within the site's Content-Security-Policy: no inline script, handler or style, nothing from another origin.
    for (const builtPage of built.pages) {
      expect(builtPage.html.match(/<script\b(?![^>]*\ssrc=)[^>]*>/g), builtPage.outPath).toBeNull();
      expect(builtPage.html.match(/<[a-z][^>]*\son[a-z]+\s*=/g), builtPage.outPath).toBeNull();
      expect(builtPage.html.match(/<[a-z][^>]*\sstyle\s*=/g), builtPage.outPath).toBeNull();
      expect(builtPage.html, builtPage.outPath).not.toMatch(/<style\b|<iframe\b/);
      const loaded = [...builtPage.html.matchAll(/<(?:script|img|link|iframe|source)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(loaded.filter((url) => !url.startsWith('/') && !url.startsWith(`${built.config.url}/`)), builtPage.outPath).toEqual([]);
      expect(builtPage.html, builtPage.outPath).not.toMatch(/feature\s*:/);
    }
  });
});

describe('the legal pages', () => {
  it('print none of the v3 statements with every feature off, as production builds them', () => {
    const terms = text(page(off, 'terms.html'));
    const privacy = text(page(off, 'privacy.html'));
    for (const [feature, statements] of Object.entries(LEGAL)) {
      for (const statement of statements.terms) expect(terms, `${feature}: ${statement}`).not.toContain(statement);
      for (const statement of statements.privacy) expect(privacy, `${feature}: ${statement}`).not.toContain(statement);
    }
    for (const word of ['verification page', 'PDF toolkit', 'open field', 'Open-field', 'card from a link', 'Cards from links', 'batch', 'certificate record']) {
      expect(terms, word).not.toContain(word);
      expect(privacy, word).not.toContain(word);
    }
  });

  it('print each feature\'s statements with that feature, and only those', () => {
    for (const [feature, statements] of Object.entries(LEGAL)) {
      const site = one[feature]!;
      const terms = text(page(site, 'terms.html'));
      const privacy = text(page(site, 'privacy.html'));
      for (const statement of statements.terms) expect(terms, `${feature}: ${statement}`).toContain(statement);
      for (const statement of statements.privacy) expect(privacy, `${feature}: ${statement}`).toContain(statement);
      for (const [other, otherStatements] of Object.entries(LEGAL)) {
        if (other === feature) continue;
        for (const statement of otherStatements.terms) expect(terms, `${feature} build has ${other}: ${statement}`).not.toContain(statement);
        for (const statement of otherStatements.privacy) expect(privacy, `${feature} build has ${other}: ${statement}`).not.toContain(statement);
      }
    }
  });

  it('keep the same three outside companies and the seller details in every build', () => {
    for (const site of [off, all, ...Object.values(one)]) {
      const privacy = text(page(site, 'privacy.html'));
      expect(privacy).toContain('We use three outside companies.');
      expect(privacy).toContain('We do not use your data for advertising');
    }
  });

  it('use the toolkit\'s real User-Agent, and say what the code keeps', () => {
    expect(read('src/routes/pdf-toolkit.ts')).toContain("const USER_AGENT = 'LinkToCard-FileFetcher/1.0");
    // Rows are stored with their batch; the batch is deleted after its last PDF expired (src/batch/store.ts).
    expect(read('src/db/migrations/0008_batches.sql')).toMatch(/^ {2}data {11}TEXT NOT NULL,/m);
    expect(read('src/batch/store.ts')).toContain("'DELETE FROM batches WHERE id IN (SELECT id FROM batches WHERE finished_at IS NOT NULL AND expires_at <= ?1 LIMIT ?2)'");
    // The verification page loads no script and sets no cookie.
    const verifyPage = read('src/batch/verify-page.ts');
    expect(verifyPage).toContain("default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self';");
    expect(verifyPage).not.toMatch(/set-cookie/i);
    // A suspended account's records are hidden (terms section 4a: "the records of the account involved are not shown").
    expect(read('src/batch/certificates.ts')).toContain('hides every record of a\n *     suspended account or one whose deletion was requested');
  });
});

describe('the counting rules, limits and reference pages', () => {
  const RULES: Record<string, string> = {
    batch: 'id="batch-counting"',
    toolkit: 'id="toolkit-counting"',
    linkcards: 'A card from a link is a card',
    email: 'Email images count once per distinct value',
  };

  it('state each v3 counting rule only with its feature, on every page that has the rules', () => {
    for (const outPath of ['pricing.html', 'index.html', 'docs/limits.html', 'docs/api.html']) {
      for (const [feature, marker] of Object.entries(RULES)) {
        expect(page(off, outPath), `${outPath} ${feature}`).not.toContain(marker);
        expect(page(one[feature]!, outPath), `${outPath} ${feature}`).toContain(marker);
      }
    }
    const toolkit = text(page(one.toolkit!, 'pricing.html'));
    expect(toolkit).toContain(`counts one image for each started block of ${PDF_TOOLKIT.pagesPerUnit} pages of its result, at least one`);
    const batch = text(page(one.batch!, 'pricing.html'));
    expect(batch).toContain(`A batch starts only when at least ${PDF.baseUnits} images per row are left.`);
  });

  it('add the per-plan v3 limits to the limits table only with their features', () => {
    const row = (site: RenderedSite, label: string): string | null => {
      const html = page(site, 'pricing.html');
      const start = html.indexOf(`<th scope="row">${label}</th>`);
      return start < 0 ? null : html.slice(start, html.indexOf('</tr>', start));
    };
    expect(row(off, 'Rows per bulk-documents batch')).toBeNull();
    expect(row(off, 'New personalized email images per site per day')).toBeNull();
    const rows = row(one.batch!, 'Rows per bulk-documents batch') ?? '';
    expect([...rows.matchAll(/<td>([^<]+)<\/td>/g)].map((match) => match[1])).toEqual(PLAN_ORDER.map((id) => formatCount(BATCH.maxRows[id])));
    const email = row(one.email!, 'New personalized email images per site per day') ?? '';
    expect([...email.matchAll(/<td>([^<]+)<\/td>/g)].map((match) => match[1])).toEqual(PLAN_ORDER.map((id) => formatCount(EMAIL_FIELDS.maxUniqueRendersPerDay[id])));
    expect(PLAN_ORDER.map((id) => PLANS[id].name).length).toBe(3);
  });

  it('name the v3 endpoints in the API reference\'s error table and links only with their features', () => {
    const api = (site: RenderedSite): string => text(page(site, 'docs/api.html'));
    expect(api(off)).not.toMatch(/\/v1\/batches|\/v1\/pdf-tools|\/v1\/cards|PDF toolkit/);
    expect(api(one.batch!)).toContain('and POST /v1/batches for more rows than your plan takes in one batch');
    expect(api(one.batch!)).toContain(`for POST /v1/batches ${BATCH.maxActivePerAccount} batches already waiting or running`);
    expect(api(one.toolkit!)).toContain('or a file sent to the PDF toolkit is not a PDF, or not a PNG or JPEG image');
    expect(api(one.linkcards!)).toContain('or GET /v1/inspect or a card from a link was given an address that is not on the public internet');
    expect(page(one.batch!, 'docs/api.html')).toContain('href="/docs/bulk#api-reference"');
    expect(page(one.toolkit!, 'docs/api.html')).toContain('href="/docs/pdf-tools#api-reference"');
    expect(page(one.linkcards!, 'docs/api.html')).toContain('href="/docs/link-cards"');
  });

  it('reserve "open" in the signed-URL rules only with email images', () => {
    expect(text(page(off, 'docs/signed-urls.html'))).not.toContain('open lists the open fields');
    expect(text(page(one.email!, 'docs/signed-urls.html'))).toContain('open lists the open fields of a personalized email image');
    expect(read('src/lib/open-fields.ts')).toContain('export const OPEN_RESERVED_PARAMS: readonly string[] = [SIG_PARAM, SIZE_PARAM, OPEN_PARAM];');
  });

  it('say on the pricing page that the in-browser tools and the preview checkers count nothing, only with their features', () => {
    expect(text(page(off, 'pricing.html'))).not.toMatch(/Merge PDF|one-app link preview/);
    expect(text(page(one.toolkit!, 'pricing.html'))).toContain('tools run in your browser: no account, the files are not uploaded, and nothing is counted.');
    expect(text(page(one.previews!, 'pricing.html'))).toContain('The same goes for the one-app link preview checkers among the free tools');
  });
});

describe('the PDF guides and the comparison page', () => {
  it('say that connectors are being prepared only with the integrations feature, and never that one is listed', () => {
    const pdfOnly = only('pdf');
    for (const outPath of ['guides/html-to-pdf-zapier-webhooks.html', 'guides/html-to-pdf-n8n.html']) {
      expect(text(page(pdfOnly, outPath)), outPath).not.toContain('being prepared for listing');
      const withConnectors = text(page(all, outPath));
      expect(withConnectors, outPath).toContain('being prepared for listing');
      expect(withConnectors, outPath).not.toMatch(/\b(?:is|are) (?:now )?(?:published|listed|available)\b/);
    }
    expect(text(page(pdfOnly, 'guides/html-to-pdf-zapier-webhooks.html'))).toContain('No. Link To Card offers an HTTP API and nothing else');
  });

  it('stops listing batch jobs among what we lack once bulk documents are on', () => {
    const pdfOnly = text(page(only('pdf'), 'compare/bannerbear.html'));
    expect(pdfOnly).toContain('or need video, batch jobs, AI features or no-code automation');
    const withBatch = text(page(all, 'compare/bannerbear.html'));
    expect(withBatch).toContain('or need video, AI features or no-code automation');
    expect(withBatch).toContain('(our bulk documents make PDFs, one per row, not images)');
    expect(text(page(off, 'compare/bannerbear.html'))).toContain('or need video, PDF, batch jobs, AI features or no-code automation');
  });
});

describe('the email image guide', () => {
  it('does not send readers to a dashboard option that the dashboard does not show', () => {
    // The Sites tab shows open fields only when GET /api/config sends email_fields (helpers.js openFieldsSettings).
    expect(read('site/public/assets/js/dashboard/helpers.js')).toContain('email_fields');
    const config = read('src/routes/dashboard.ts');
    const guide = read('site/content/guides/personalized-email-images.md');
    if (!/email_fields/.test(config)) {
      expect(guide).toContain("The dashboard's URL builder does not make URLs with open fields.");
      expect(guide).not.toMatch(/Make `name` an open field/);
    }
  });
});

describe('README.md and GO-LIVE.md', () => {
  const goLive = read('GO-LIVE.md');
  const readme = read('README.md');
  const toml = read('wrangler.toml');

  it('give the queue creation commands for the queues wrangler.toml binds on Cloudflare', () => {
    const staging = toml.slice(toml.search(/^\[env\.staging\]/m), toml.search(/^\[env\.production\]/m));
    const production = toml.slice(toml.search(/^\[env\.production\]/m));
    for (const section of [staging, production]) {
      const queue = /\[\[env\.\w+\.queues\.producers\]\][\s\S]*?queue = "([^"]+)"/.exec(section)?.[1];
      expect(queue).toBeDefined();
      expect(goLive).toContain(`npx wrangler queues create ${queue}`);
      expect(goLive).toContain(`npx wrangler queues pause-delivery ${queue}`);
    }
  });

  it('name the batches migration that exists, and every v3 switch with its production value', () => {
    const migrations = readdirSync(join(ROOT, 'src/db/migrations'));
    expect(migrations).toContain('0008_batches.sql');
    expect(goLive).toContain('0008_batches.sql');
    expect(readme).toContain('0008_batches.sql');
    const production = toml.slice(toml.search(/^\[env\.production\.vars\]/m));
    for (const name of Object.values(FEATURE_FLAGS)) {
      expect(production, name).toMatch(new RegExp(`^${name} = "false"$`, 'm'));
      expect(goLive, name).toContain(`\`${name}\``);
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
    // GO-LIVE section 11c names the site feature of every switch, with the deploy script it changes.
    for (const feature of ['batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations']) expect(goLive, feature).toContain(`| \`${feature}\` |`);
    expect(goLive).toContain('set `legalUpdated` to the launch day');
    expect(goLive).toContain('integrations/README.md');
    expect(JSON.parse(read('package.json')).scripts['deploy:production']).toContain('SITE_FEATURES= SITE_PDF=off');
  });

  it('keep a changelog entry for build v3 that says where AI was used', () => {
    const entry = readme.slice(readme.indexOf('- **2026-11-26: Build v3 tools**'), readme.indexOf('- **2026-11-26: PDF fixes after checking the round-3 fixes**'));
    expect(entry.length).toBeGreaterThan(200);
    expect(entry).toContain('Where AI was used:');
    expect(entry).toContain('not deployed');
  });
});
