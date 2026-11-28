// The legal pages as each deployment publishes them (audit F4 and the owner decisions of 2026-11-27).
//   - Production publishes the Terms of Service of 89270a7, the last production deploy before build
//     v3, which the owner approved, plus one line the owner published on 2026-11-27: the rule against
//     counterfeit or misleading documents, in every build. The rest of the terms text that came with
//     PDF documents (suspension on report, "and other files") waits in feature:pdf blocks, and
//     staging keeps it. On 2026-11-28 two lines of section 6 changed in every build, because the
//     owner opened the top-up to accounts without a subscription ("$8 top-up without a
//     subscription: yes, allow it"): the Free line and the Top-up line. The terms are dated
//     2026-11-28 (front matter `updated`) in every build.
//   - The privacy policy keeps its two changes that are no feature's text (Turnstile "if a free tool
//     on the website shows it", which the preview checkers can show, and "the daily clean-up") and
//     names Cloudflare Web Analytics (owner decision of 2026-11-27), so it has its own date: front
//     matter `updated`, which scripts/build-site.ts prints instead of legalUpdated of
//     site/site.config.json. The refund policy keeps legalUpdated.
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
import { FEATURES, applyFeatureBlocks, renderSite, siteFeatures, type RenderedSite } from '../../scripts/build-site';
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
/** The line the owner published in every build on 2026-11-27 (it was feature:pdf text before). */
const COUNTERFEIT_RULE =
  '- create counterfeit or misleading documents in any form the service produces, such as fake invoices or receipts, bank statements, utility bills, identity documents, or certificates that claim to come from an issuer that did not issue them;';
/**
 * The two lines of section 6 that changed on 2026-11-28, each with its text in 89270a7. The owner's
 * decision of that day lets an account without a subscription buy the top-up, which made both
 * untrue: a Free account with a top-up keeps rendering past its monthly allowance, and the top-up
 * is no longer "available on paid plans".
 */
const TOPUP_WITHOUT_SUBSCRIPTION: ReadonlyArray<{ now: string; before: string }> = [
  {
    now: '- **Free:** [[plan.free.images]] images per month. Free-plan images carry a small mark in one corner. When the monthly allowance and any top-up you bought are used up, new images are not rendered until the next month: it is a hard stop, and nothing is charged automatically.',
    before:
      '- **Free:** [[plan.free.images]] images per month. Free-plan images carry a small mark in one corner. When the monthly allowance is used up, new images are not rendered until the next month: it is a hard stop, and there are no charges.',
  },
  {
    now: '- **Top-up (optional):** [[topup.price]] for [[topup.images]] extra images, available on [[topup.plans]]. A top-up is only ever bought by you, by hand. It is never billed automatically. Top-up images are used after your monthly allowance runs out and stay valid for [[topup.validDays]] days from purchase. A top-up adds images only: it does not change your plan, and Free-plan images keep their mark.',
    before:
      '- **Top-up (optional):** [[topup.price]] for [[topup.images]] extra images, available on paid plans. A top-up is only ever bought by you, by hand. It is never billed automatically. Top-up images are used after your monthly allowance runs out and stay valid for [[topup.validDays]] days from purchase.',
  },
];

let production: RenderedSite;
let staging: RenderedSite;
beforeAll(() => {
  production = renderSite({ env: buildEnv('deploy:production'), now: NOW });
  staging = renderSite({ env: buildEnv('deploy:staging'), now: NOW });
});

describe('the Terms of Service', () => {
  it('are, in production, the text of 89270a7 plus the counterfeit rule and the two top-up lines of 2026-11-28, and nothing else', () => {
    // The production source differs from 89270a7 by its date (front matter, which a build does not
    // print), by the one line the owner published on 2026-11-27, right after the fraud rule, and by
    // the Free and Top-up lines of section 6, rewritten on 2026-11-28 for the top-up without a subscription.
    const source = productionSource('terms');
    expect(featureDates(source)).toEqual([]);
    expect(source).toMatch(/^---\n[\s\S]*?^updated: 2026-11-28$[\s\S]*?^---$/m);
    const lines = source.replace(/^updated: \d{4}-\d{2}-\d{2}\n/m, '').split('\n');
    for (const line of TOPUP_WITHOUT_SUBSCRIPTION) {
      const index = lines.indexOf(line.now);
      expect(index, `in the production terms: ${line.now.slice(0, 24)}`).toBeGreaterThan(0);
      expect(lines).not.toContain(line.before);
      lines[index] = line.before;
    }
    const at = lines.indexOf(COUNTERFEIT_RULE);
    expect(at, 'the counterfeit rule is in the production terms').toBeGreaterThan(0);
    expect(lines[at - 1]).toMatch(/^- commit fraud, phishing or impersonation/);
    const terms = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n');
    const previous = previousSource('terms');
    if (previous !== null) {
      expect(blobId(previous), 'the pinned blob id is the one of 89270a7').toBe(BLOBS_89270A7.terms);
      expect(terms).toBe(previous);
    }
    expect(blobId(terms)).toBe(BLOBS_89270A7.terms);
  });

  it('carry the counterfeit rule in every build, and the suspension on report and "other files" with PDFs only', () => {
    const counterfeit = 'create counterfeit or misleading documents in any form the service produces';
    const urgent = 'Counterfeit and misleading documents are always urgent. When we receive a report that the service was used to make one, we suspend the API keys and the account involved straight away, look into the report, and tell you afterwards.';
    const prod = text(mainOf(html(production, 'terms.html')));
    expect(prod).toContain(COUNTERFEIT_RULE.slice(2));
    expect(text(mainOf(html(renderSite({ env: {}, now: NOW }), 'terms.html')))).toContain(counterfeit);
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

describe('Cloudflare Web Analytics (owner decision of 2026-11-27)', () => {
  const csp = read('site/public/_headers').split('\n').find((line) => line.trim().startsWith('Content-Security-Policy:')) ?? '';
  const directive = (name: string): string[] => (csp.split(';').map((part) => part.trim().replace(/^Content-Security-Policy:\s*/, '')).find((part) => part.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);

  it("the site's CSP lets its beacon run and report, and allows no other new source", () => {
    // Cloudflare injects <script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/...">
    // into every HTML page for browsers; on this proxied zone it reports to /cdn-cgi/rum ('self').
    // The whole policy is pinned: the two Web Analytics hosts are the only change of 2026-11-27.
    const policy = Object.fromEntries(
      csp.replace(/^\s*Content-Security-Policy:\s*/, '').split(';').map((part) => part.trim().split(/\s+/)).filter((part) => part[0]).map(([name, ...sources]) => [name, sources]),
    );
    expect(policy).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.paddle.com', 'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://*.paddle.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.paddle.com'],
      'font-src': ["'self'"],
      'connect-src': ["'self'", 'https://*.paddle.com', 'https://cloudflareinsights.com'],
      'frame-src': ['https://*.paddle.com', 'https://challenges.cloudflare.com'],
      'form-action': ["'self'", 'mailto:'],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it('the privacy policy names it in both builds and no longer says that no analytics are used', () => {
    for (const site of [production, staging]) {
      const privacy = text(mainOf(html(site, 'privacy.html')));
      expect(privacy).toContain('our only website analytics are cookieless Cloudflare Web Analytics');
      expect(privacy).not.toContain('we do not use analytics');
      expect(privacy).toContain('counted by Cloudflare Web Analytics so we can see how the website is used and how fast it is. It is cookieless: it sets no cookie and stores nothing on your device, and Cloudflare says it does not fingerprint visitors. Cloudflare works out the country from the connection');
      expect(privacy).toContain('We see only totals, not individual visitors.');
      // IP addresses: security, and the country of the statistics.
      expect(privacy).toContain('This is what IP addresses are used for, apart from the country in the website statistics (section 2).');
      expect(privacy).toContain('Web Analytics, the cookieless statistics of this website');
      // Still true: the beacon sets no cookie (checked in Chromium on 2026-11-27: no Set-Cookie, no storage).
      expect(privacy).toContain('We use no analytics cookies, no advertising cookies and no tracking pixels.');
    }
  });

  it("verification pages keep a policy without script, as the privacy policy says they load none", () => {
    // Their own policy (VERIFY_PAGE_CSP) has no script-src, so default-src 'none' blocks the injected beacon
    // there; tests/verify-page.test.ts checks the policy the Worker actually sends.
    const policy = /export const VERIFY_PAGE_CSP =\s*"([^"]+)"/.exec(read('src/batch/verify-page.ts'))?.[1] ?? '';
    expect(policy).toMatch(/^default-src 'none';/);
    expect(policy).not.toMatch(/script-src|cloudflareinsights/);
    expect(text(mainOf(html(staging, 'privacy.html')))).toContain('Verification pages set no cookie and load no script.');
  });
});

describe('"Last updated"', () => {
  it('is 28 November 2026 on the terms, 27 November 2026 on the privacy policy and 25 November 2026 on the refund policy, in both builds', () => {
    for (const site of [production, staging]) {
      expect(lastUpdated(html(site, 'terms.html'))).toEqual(['28 November 2026']);
      // The chart maker's line (feature "charts", staging only) is dated 28 November 2026 with
      // `updated.charts`, so only a build with that feature shows the later date.
      expect(lastUpdated(html(site, 'privacy.html'))).toEqual([site.features.charts ? '28 November 2026' : '27 November 2026']);
      expect(lastUpdated(html(site, 'refund.html'))).toEqual(['25 November 2026']);
    }
    expect(staging.features.charts && !production.features.charts).toBe(true);
    // The site-wide date is unchanged; the terms and the privacy policy have a date of their own.
    // The top-up decision of 2026-11-28 changed the terms only: the privacy policy and the refund
    // policy say nothing that it made untrue.
    expect(siteConfig.legalUpdated).toBe('2026-11-25');
    expect(read('site/content/terms.md')).toMatch(/^---\n[\s\S]*?^updated: 2026-11-28$[\s\S]*?^---$/m);
    expect(read('site/content/privacy.md')).toMatch(/^---\n[\s\S]*?^updated: 2026-11-27$[\s\S]*?^---$/m);
    expect(read('site/content/refund.md').split(/^---$/m)[1]).not.toMatch(/^updated:/m);
    // The one feature date: the chart maker's line of the privacy policy (feature "charts", not in production).
    const featureDatesOf: Record<string, string[]> = { terms: [], privacy: ['updated.charts: 2026-11-28'], refund: [] };
    for (const page of ['terms', 'privacy', 'refund']) expect(featureDates(read(`site/content/${page}.md`)), page).toEqual(featureDatesOf[page]);
  });

  it('of the terms is 28 November 2026 in every build: the two top-up lines are in all of them', () => {
    const terms = (env: Record<string, string>): string[] => lastUpdated(html(renderSite({ env, now: NOW }), 'terms.html'));
    const envs: Record<string, string>[] = [{}, { SITE_PDF: 'on' }, { SITE_FEATURES: 'linkcards', SITE_PDF: 'off' }, { SITE_FEATURES: 'pdf,batch,toolkit,email' }];
    for (const env of envs) {
      expect(terms(env), JSON.stringify(env)).toEqual(['28 November 2026']);
    }
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

  it('of the privacy policy is its own because its production text changed since 89270a7', () => {
    // Without its `updated` line, the production source differs from 89270a7 in text that is no
    // feature's: Turnstile, the clean-up and Cloudflare Web Analytics. The same line also dates the
    // privacy text of the feature blocks written on 26 and 27 November (staging), so it must stay
    // even if those sentences were reverted, until a raised legalUpdated covers that text.
    // `updated.<feature>` lines date text that production does not print (chart maker: updated.charts).
    const privacy = productionSource('privacy').replace(/^updated: .*\n/m, '').replace(/^updated\.[a-z-]+: .*\n/gm, '');
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
      expect(removed).toHaveLength(4);
      expect(removed.join('\n')).toContain('we do not use analytics or advertising trackers');
      expect(removed.join('\n')).toContain('This is what IP addresses are used for.');
      expect(removed.join('\n')).toContain('if the Open Graph checker shows it');
      expect(removed.join('\n')).toContain('by a regular clean-up shortly afterwards');
      const added = privacy.split('\n').filter((line) => !previous.split('\n').includes(line));
      expect(added).toHaveLength(5);
      expect(added.filter((line) => /Web Analytics|website statistics/.test(line))).toHaveLength(4);
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
