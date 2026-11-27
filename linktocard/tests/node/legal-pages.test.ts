// The legal pages as each deployment publishes them (audit F4; owner decision of 2026-11-27).
//   - Production publishes the Terms of Service of 89270a7, the last production deploy before build
//     v3, which the owner approved: the terms text that came with PDF documents (counterfeit
//     documents, suspension on report, "and other files") waits in feature:pdf blocks, and staging
//     keeps it.
//   - The privacy policy keeps its two changes that are no feature's text (Turnstile "if a free tool
//     on the website shows it", which the preview checkers can show, and "the daily clean-up"), so it
//     has its own date: front matter `updated`, which scripts/build-site.ts prints instead of
//     legalUpdated of site/site.config.json. Terms and refund keep legalUpdated in production.
//   - The terms text of bulk documents, the PDF toolkit, cards from links and email images was
//     written on 2026-11-26 (cce33b0), after legalUpdated: the terms date it with
//     `updated.<feature>`, so a build that prints that text (staging) says 26 November 2026.
//   - Each page shows the latest date that applies, so raising legalUpdated at a launch (GO-LIVE.md
//     sections 10 and 11c) dates every legal page without touching their front matter.
// The 89270a7 texts are pinned by their git blob ids, so the test needs no git history; where
// history is there, it also compares the text itself, for a readable diff.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEATURES, applyFeatureBlocks, renderSite, siteFeatures, type Feature, type RenderedSite } from '../../scripts/build-site';
import siteConfig from '../../site/site.config.json';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-27T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'ltc-legal-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** The previous production deploy, and the git blob ids of its legal pages (git rev-parse 89270a7:linktocard/site/content/<page>.md). */
const PREVIOUS_PRODUCTION = '89270a7';
const BLOBS_89270A7 = {
  terms: '23934625414bb3c75541435f119ec9b5c2484540',
  privacy: '376bbfd54793de3502bb0daab9eaf5f49fe6afb5',
  refund: 'e0f8e2d908248dd6e532359482b0d1dd64b57541',
} as const;
type LegalPage = keyof typeof BLOBS_89270A7;

/** The id git gives a file with this content. */
const blobId = (text: string): string => {
  const bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

/** The page's source at a commit (89270a7 by default), or null where the checkout has no such history (a shallow clone). */
function previousSource(page: LegalPage, commit: string = PREVIOUS_PRODUCTION): string | null {
  const shown = spawnSync('git', ['show', `${commit}:./site/content/${page}.md`], { cwd: ROOT, encoding: 'utf8' });
  return shown.status === 0 ? shown.stdout : null;
}

const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/** The variables a deploy script sets in front of `npm run build:site` (as tests/node/production-site.test.ts reads them). */
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

/** The page's Markdown source as the production build reads it: its feature blocks applied. */
const productionSource = (page: LegalPage): string =>
  applyFeatureBlocks(read(`site/content/${page}.md`), siteFeatures(buildEnv('deploy:production')), `site/content/${page}.md`);

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const html = (site: RenderedSite, outPath: string): string => {
  const found = site.pages.find((page) => page.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
};
const mainOf = (page: string): string => page.slice(page.indexOf('<main'), page.indexOf('</main>'));
const lastUpdated = (page: string): string[] => [...text(mainOf(page)).matchAll(/Last updated:? (\d{1,2} [A-Z][a-z]+ \d{4})/g)].map((match) => match[1]!);

/** The `updated.<feature>` lines of a page's front matter: the dates of text that only a build with that feature prints. */
const featureDates = (source: string): string[] => (source.split(/^---$/m)[1] ?? '').split('\n').filter((line) => line.startsWith('updated.'));
/** The four features whose terms text was written on 2026-11-26 (cce33b0). */
const TERMS_OF_2026_11_26: readonly Feature[] = ['batch', 'toolkit', 'linkcards', 'email'];

let production: RenderedSite;
let staging: RenderedSite;
beforeAll(() => {
  production = renderSite({ env: buildEnv('deploy:production'), now: NOW });
  staging = renderSite({ env: buildEnv('deploy:staging'), now: NOW });
});

describe('the Terms of Service', () => {
  it('are, in production, the text of 89270a7 byte for byte: the new terms wait for PDFs', () => {
    // The production source differs only by the front-matter dates of text that production does not
    // print (a build prints no front matter): one line per feature, each off in production.
    const source = productionSource('terms');
    expect(featureDates(source)).toEqual(TERMS_OF_2026_11_26.map((feature) => `updated.${feature}: 2026-11-26`));
    const features = siteFeatures(buildEnv('deploy:production'));
    for (const feature of TERMS_OF_2026_11_26) expect(features[feature], feature).toBe(false);
    const terms = source.replace(/^updated\.[a-z-]+: \d{4}-\d{2}-\d{2}\n/gm, '');
    const previous = previousSource('terms');
    if (previous !== null) {
      expect(blobId(previous), 'the pinned blob id is the one of 89270a7').toBe(BLOBS_89270A7.terms);
      expect(terms).toBe(previous);
    }
    expect(blobId(terms)).toBe(BLOBS_89270A7.terms);
  });

  it('carry the counterfeit clause, the suspension on report and "other files" with PDFs only', () => {
    const counterfeit = 'create counterfeit or misleading documents in any form the service produces';
    const urgent = 'Counterfeit and misleading documents are always urgent. When we receive a report that the service was used to make one, we suspend the API keys and the account involved straight away, look into the report, and tell you afterwards.';
    const prod = text(mainOf(html(production, 'terms.html')));
    expect(prod).not.toContain(counterfeit);
    expect(prod).not.toContain('always urgent');
    expect(prod).toContain('the data you send to be rendered, and the images the service produces for you.');
    const stage = text(mainOf(html(staging, 'terms.html')));
    expect(stage).toContain(counterfeit);
    expect(stage).toContain(urgent);
    expect(stage).toContain('the data you send to be rendered, and the images and other files the service produces for you.');
    // Section 4a (bulk documents, staging) refers to the counterfeit rule of section 4, which the PDF build has.
    expect(stage).toContain('handled like a counterfeit document (section 4)');
  });

  it('give section 4a and the toolkit the PDF text they build on, in every build that has them', () => {
    // A build with bulk documents or the toolkit and without PDFs would hand a reported record to a
    // counterfeit rule section 4 does not have; scripts/build-site.ts refuses it (GO-LIVE.md 11c, "Needs first").
    for (const features of ['batch', 'toolkit', 'batch,previews,localpdf,apidocs']) {
      expect(() => renderSite({ env: { SITE_FEATURES: features, SITE_PDF: 'off' }, now: NOW }), features).toThrow(/SITE_FEATURES: "(batch|toolkit)" needs "pdf" too/);
    }
    const bulk = text(mainOf(html(renderSite({ env: { SITE_FEATURES: 'batch', SITE_PDF: 'on' }, now: NOW }), 'terms.html')));
    expect(bulk).toContain('handled like a counterfeit document (section 4)');
    expect(bulk).toContain('create counterfeit or misleading documents in any form the service produces');
    expect(bulk).toContain('Counterfeit and misleading documents are always urgent.');
    const toolkit = text(mainOf(html(renderSite({ env: { SITE_FEATURES: 'pdf,toolkit' }, now: NOW }), 'terms.html')));
    expect(toolkit).toContain('The result is stored like your other documents.');
    expect(toolkit).toContain('and the images and other files the service produces for you.');
    expect(toolkit).toContain('create counterfeit or misleading documents in any form the service produces');
  });
});

describe('"Last updated"', () => {
  it('is 27 November 2026 on the privacy policy and 25 November 2026 on the refund policy in both builds, and on the terms 25 November in production and 26 November on staging', () => {
    for (const site of [production, staging]) {
      expect(lastUpdated(html(site, 'privacy.html'))).toEqual(['27 November 2026']);
      expect(lastUpdated(html(site, 'refund.html'))).toEqual(['25 November 2026']);
    }
    expect(lastUpdated(html(production, 'terms.html'))).toEqual(['25 November 2026']);
    // Staging prints the terms text of bulk documents, the toolkit, cards from links and email images of 2026-11-26.
    expect(lastUpdated(html(staging, 'terms.html'))).toEqual(['26 November 2026']);
    // The site-wide date is unchanged; the privacy policy has a date of its own, the terms one per feature text.
    expect(siteConfig.legalUpdated).toBe('2026-11-25');
    expect(read('site/content/privacy.md')).toMatch(/^---\n[\s\S]*?^updated: 2026-11-27$[\s\S]*?^---$/m);
    for (const page of ['terms', 'refund']) expect(read(`site/content/${page}.md`).split(/^---$/m)[1], page).not.toMatch(/^updated:/m);
    expect(featureDates(read('site/content/privacy.md'))).toEqual([]);
    expect(featureDates(read('site/content/refund.md'))).toEqual([]);
  });

  it('of the terms is 26 November 2026 in every build that prints the text of that day, and 25 November in the others', () => {
    const terms = (env: Record<string, string>): string[] => lastUpdated(html(renderSite({ env, now: NOW }), 'terms.html'));
    expect(terms({ SITE_PDF: 'on' })).toEqual(['25 November 2026']);
    expect(terms({ SITE_FEATURES: 'previews,localpdf,apidocs,integrations', SITE_PDF: 'on' })).toEqual(['25 November 2026']);
    for (const feature of TERMS_OF_2026_11_26) {
      expect(terms({ SITE_FEATURES: feature, SITE_PDF: 'on' }), feature).toEqual(['26 November 2026']);
    }
    expect(terms({ SITE_FEATURES: 'linkcards', SITE_PDF: 'off' })).toEqual(['26 November 2026']);
    expect(terms({ SITE_FEATURES: 'email', SITE_PDF: 'off' })).toEqual(['26 November 2026']);
    // Those are exactly the features whose blocks the terms gained in cce33b0 (2026-11-26); the
    // PDF blocks are of 5093600 (2026-11-25), and the terms have not changed for any feature since.
    const blocksOf = (source: string): string[] => [...new Set([...source.matchAll(/<!-- feature:([a-z-]+) -->/g)].map((match) => match[1]!))].sort();
    const blocks = blocksOf(read('site/content/terms.md'));
    expect(blocks).toEqual([...TERMS_OF_2026_11_26, 'no-pdf', 'pdf'].sort());
    const before = previousSource('terms', '5093600');
    if (before !== null) expect(blocks.filter((feature) => !blocksOf(before).includes(feature))).toEqual([...TERMS_OF_2026_11_26].sort());
  });

  it('follows legalUpdated when a launch raises it past the pages\' own dates, in production and on staging', () => {
    // GO-LIVE.md sections 10 and 11c: set legalUpdated to the launch day. That alone must build.
    const siteDir = join(temp, 'raised');
    mkdirSync(siteDir, { recursive: true });
    for (const part of ['layouts', 'partials', 'pages']) cpSync(join(ROOT, 'site', part), join(siteDir, part), { recursive: true });
    symlinkSync(join(ROOT, 'site/public'), join(siteDir, 'public'));
    writeFileSync(join(siteDir, 'site.config.json'), JSON.stringify({ ...siteConfig, legalUpdated: '2026-12-01' }, null, 2));
    for (const script of ['deploy:production', 'deploy:staging']) {
      const site = renderSite({ siteDir, contentDir: join(ROOT, 'site/content'), env: buildEnv(script), now: NOW });
      for (const page of ['terms.html', 'privacy.html', 'refund.html']) expect(lastUpdated(html(site, page)), `${script} ${page}`).toEqual(['1 December 2026']);
    }
  });

  it('of the privacy policy is its own because its production text changed since 89270a7, and only there', () => {
    // Without its `updated` line, the production source differs from 89270a7 in the two sentences
    // that are no feature's text. Were they ever reverted, the page would need no date of its own.
    const privacy = productionSource('privacy').replace(/^updated: .*\n/m, '');
    expect(blobId(privacy)).not.toBe(BLOBS_89270A7.privacy);
    const visible = text(mainOf(html(production, 'privacy.html')));
    expect(visible).toContain('Turnstile, the check that tells people from bots, if a free tool on the website shows it');
    expect(visible).toContain('Expired entries are deleted by the daily clean-up, normally within a day.');
    // That wording is true in production: the one-app preview checkers can show Turnstile.
    expect(read('site/public/assets/js/og-platform.js')).toContain("problem.code === 'verification_required' && problem.siteKey");
    const previous = previousSource('privacy');
    if (previous !== null) {
      expect(blobId(previous)).toBe(BLOBS_89270A7.privacy);
      const removed = previous.split('\n').filter((line) => !privacy.split('\n').includes(line));
      expect(removed).toHaveLength(2);
      expect(removed.join('\n')).toContain('if the Open Graph checker shows it');
      expect(removed.join('\n')).toContain('by a regular clean-up shortly afterwards');
    }
    // The refund policy has not changed at all.
    expect(blobId(productionSource('refund'))).toBe(BLOBS_89270A7.refund);
  });
});

describe('the "updated" front matter of a legal page', () => {
  const contentDir = join(temp, 'content');
  const write = (file: string, body: string): void => {
    mkdirSync(dirname(join(contentDir, file)), { recursive: true });
    writeFileSync(join(contentDir, file), body);
  };
  const render = (): RenderedSite => renderSite({ contentDir, env: {}, now: NOW });
  const legal = (updated: string | null, layout = 'legal', body = 'Last updated: [[legal.updated]] ([[legal.updatedIso]])\n\nText.\n'): string =>
    `---\ntitle: Notice\ndescription: A notice.\nlayout: ${layout}\n${updated === null ? '' : `updated: ${updated}\n`}---\n\n${body}`;
  const siteDate = new Date(`${siteConfig.legalUpdated}T00:00:00Z`);
  const later = new Date(siteDate.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const earlier = new Date(siteDate.getTime() - 86_400_000).toISOString().slice(0, 10);
  const longDate = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  it('sets the date of that page only, in its tokens and in the layout\'s own "Last updated" line', () => {
    write('a.md', legal(later));
    write('b.md', legal(null));
    write('c.md', legal(later, 'legal', 'Text without a date line.\n'));
    try {
      const site = render();
      expect(text(mainOf(html(site, 'a.html')))).toContain(`Last updated: ${longDate(later)} (${later})`);
      expect(text(mainOf(html(site, 'b.html')))).toContain(`Last updated: ${longDate(siteConfig.legalUpdated)} (${siteConfig.legalUpdated})`);
      expect(html(site, 'c.html')).toContain(`<p class="eyebrow">Last updated <time datetime="${later}">${longDate(later)}</time></p>`);
    } finally {
      for (const file of ['a.md', 'b.md', 'c.md']) rmSync(join(contentDir, file));
    }
  });

  it('may equal legalUpdated', () => {
    write('a.md', legal(siteConfig.legalUpdated));
    try {
      expect(text(mainOf(html(render(), 'a.html')))).toContain(`Last updated: ${longDate(siteConfig.legalUpdated)}`);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
  });

  it('gives way to a later legalUpdated: the page shows legalUpdated and the build goes on', () => {
    write('a.md', legal(earlier));
    try {
      const page = html(render(), 'a.html');
      expect(text(mainOf(page))).toContain(`Last updated: ${longDate(siteConfig.legalUpdated)} (${siteConfig.legalUpdated})`);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
  });

  it('per feature (updated.<feature>) counts only in a build with that switch, and the latest date that counts wins', () => {
    const latest = new Date(siteDate.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const page = (lines: string, env: Record<string, string>): string => {
      write('a.md', `---\ntitle: Notice\ndescription: A notice.\nlayout: legal\n${lines}---\n\nLast updated: [[legal.updated]] ([[legal.updatedIso]])\n\nText.\n`);
      try {
        return text(mainOf(html(renderSite({ contentDir, env, now: NOW }), 'a.html')));
      } finally {
        rmSync(join(contentDir, 'a.md'));
      }
    };
    const shows = (iso: string): string => `Last updated: ${longDate(iso)} (${iso})`;
    expect(page(`updated.linkcards: ${later}\n`, {})).toContain(shows(siteConfig.legalUpdated));
    expect(page(`updated.linkcards: ${later}\n`, { SITE_FEATURES: 'linkcards' })).toContain(shows(later));
    expect(page(`updated.no-pdf: ${later}\n`, {})).toContain(shows(later));
    expect(page(`updated.no-pdf: ${later}\n`, { SITE_PDF: 'on' })).toContain(shows(siteConfig.legalUpdated));
    const both = `updated: ${later}\nupdated.email: ${latest}\n`;
    expect(page(both, {})).toContain(shows(later));
    expect(page(both, { SITE_FEATURES: 'email' })).toContain(shows(latest));
    expect(page(`updated: ${latest}\nupdated.email: ${later}\n`, { SITE_FEATURES: 'email' })).toContain(shows(latest));
    expect(page(`updated.email: ${earlier}\n`, { SITE_FEATURES: 'email' })).toContain(shows(siteConfig.legalUpdated));
  });

  it.each([
    ['a date that does not exist', '2026-11-31', /a\.md: "updated" must be a YYYY-MM-DD date, not "2026-11-31"/],
    ['a 29 February of a common year', '2027-02-29', /a\.md: "updated" must be a YYYY-MM-DD date/],
    ['a written-out date', '27 November 2026', /a\.md: "updated" must be a YYYY-MM-DD date, not "27 November 2026"/],
    ['a date without leading zeros', '2026-1-5', /a\.md: "updated" must be a YYYY-MM-DD date/],
    ['a date and time', '2026-11-27T10:00', /a\.md: "updated" must be a YYYY-MM-DD date/],
    ['an empty value', '', /a\.md: "updated" must be a YYYY-MM-DD date, not ""/],
  ])('stops the build, naming the file, on %s', (_case, value, message) => {
    write('a.md', legal(value));
    try {
      expect(render).toThrow(message);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
  });

  it.each([
    ['a date that does not exist', 'updated.batch: 2026-11-31', /a\.md: "updated\.batch" must be a YYYY-MM-DD date, not "2026-11-31"/],
    ['a written-out date', 'updated.no-pdf: 26 November 2026', /a\.md: "updated\.no-pdf" must be a YYYY-MM-DD date, not "26 November 2026"/],
    ['an unknown feature', 'updated.bulk: 2026-11-26', /a\.md: "updated\.bulk": unknown feature "bulk"/],
    ['no feature', 'updated.: 2026-11-26', /a\.md: "updated\.": unknown feature ""/],
  ])('stops the build, naming the file and key, on a per-feature date with %s, whatever the build', (_case, line, message) => {
    write('a.md', `---\ntitle: Notice\ndescription: A notice.\nlayout: legal\n${line}\n---\n\nText.\n`);
    try {
      expect(render).toThrow(message);
      expect(() => renderSite({ contentDir, env: { SITE_FEATURES: FEATURES.join(','), SITE_PDF: 'on' }, now: NOW })).toThrow(message);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
  });

  it.each(['page', 'doc'])('stops the build on a page with layout %s, which prints no "Last updated" date', (layout) => {
    write('a.md', legal(later, layout, 'Text.\n'));
    try {
      expect(render).toThrow(/a\.md: "updated" is only for legal pages \(layout: legal\)/);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
    write('a.md', `---\ntitle: Notice\ndescription: A notice.\nlayout: ${layout}\nupdated.email: ${later}\n---\n\nText.\n`);
    try {
      expect(render).toThrow(/a\.md: "updated\.email" is only for legal pages \(layout: legal\)/);
    } finally {
      rmSync(join(contentDir, 'a.md'));
    }
  });
});
