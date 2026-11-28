// Regression tests of the build-v3 review fixes that live in files, not behaviour: the runbook's
// warnings (GO-LIVE.md), dead route modules, and wording of the free tool pages.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { FEATURES, rateLimitScope, renderSite, siteFeatures, type RenderedSite } from '../../scripts/build-site';
import { RATE_LIMITS, type RateLimitName } from '../../src/config';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(`${ROOT}${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : [],
  );
}

describe('src/routes holds no module nothing mounts (OPS-6)', () => {
  it('every route module is imported by another module of src', () => {
    const sources = sourceFiles('src').map((path) => ({ path, text: read(path) }));
    const routes = readdirSync(`${ROOT}src/routes`).filter((name) => name.endsWith('.ts')).map((name) => name.replace(/\.ts$/, ''));
    expect(routes.length).toBeGreaterThan(5);
    for (const route of routes) {
      const importers = sources.filter(({ path, text }) => path !== `src/routes/${route}.ts` && new RegExp(`from '(?:\\./routes|\\.\\./routes|\\.)/${route}'`).test(text));
      expect(importers.length, `src/routes/${route}.ts is imported by nothing`).toBeGreaterThan(0);
    }
  });
});

describe('GO-LIVE.md says what each emergency brake breaks for customers (OPS-2)', () => {
  const golive = read('GO-LIVE.md');
  const stopping = golive.slice(golive.indexOf('- **Stopping a tool:**'));
  it('lists the effect on outputs customers already have, per switch', () => {
    expect(stopping).toMatch(/ZIP downloads answer 503, finished and paid batches\s+included/);
    expect(stopping).toMatch(/every `\/v1\/link\/\.\.\.` URL answers 503, stored cards\s+included/);
    expect(stopping).toMatch(/open-field image in emails already sent\s+answers 403 `invalid_signature`/);
    expect(stopping).toMatch(/only for the queue's message retention \(4 days by default/);
    expect(stopping).toMatch(/BATCH\.staleAfterDays/);
  });

  it('asks for the custom templates that use {{open}} before email images go on (SEC-6)', () => {
    expect(golive).toContain('**Before turning email images on in production:**');
    expect(golive).toContain("html LIKE '%{{open}}%'");
  });
});

describe('site wording (CC-1, CC-2, CC-4, CC-5)', () => {
  const NOW = new Date('2026-11-26T12:00:00Z');
  let pdfOnly: RenderedSite;
  let all: RenderedSite;
  let off: RenderedSite;
  beforeAll(() => {
    pdfOnly = renderSite({ env: { SITE_PDF: 'on' }, now: NOW });
    all = renderSite({ env: { SITE_FEATURES: FEATURES.join(','), SITE_PDF: 'on' }, now: NOW });
    off = renderSite({ env: {}, now: NOW });
  });
  const page = (site: RenderedSite, outPath: string): string => {
    const found = site.pages.find((candidate) => candidate.outPath === outPath);
    if (!found) throw new Error(`no page ${outPath}`);
    return found.html;
  };

  it('/docs/pdf never says Link To Card sets the verification fields, except for verified bulk documents', () => {
    for (const site of [pdfOnly, all]) expect(page(site, 'docs/pdf.html')).not.toContain('set by Link To Card');
    expect(page(pdfOnly, 'docs/pdf.html')).not.toContain('/docs/bulk#certificates-and-verification');
    const withBatch = page(all, 'docs/pdf.html');
    expect(withBatch).toContain('<a href="/docs/bulk#certificates-and-verification">bulk documents</a>');
    expect(withBatch).toMatch(/fills in <code>certificate_id<\/code>, <code>verify_url<\/code> and <code>verify_qr<\/code>/);
  });

  it('the rate-limit table names every route that shares a limiter, and the production text is unchanged', () => {
    const none = siteFeatures({});
    for (const name of Object.keys(RATE_LIMITS) as RateLimitName[]) expect(rateLimitScope(name, none)).toBe(RATE_LIMITS[name].scope);
    const every = siteFeatures({ SITE_FEATURES: FEATURES.join(',') });
    expect(rateLimitScope('RL_KEY', every)).toBe(
      'per API key (POST /v1/images, POST /v1/cards/from-url, every /v1/batches request, POST /v1/certificates/{id}/revoke) and per site (uncached signed-URL renders); also POST /v1/charts (per API key) and uncached signed chart URLs (per site)',
    );
    expect(rateLimitScope('RL_IP', every)).toMatch(/; also GET \/v\/\{id\} and \/v\/\{id\}\.json$/);
    const limits = page(all, 'docs/limits.html');
    expect(limits).toContain('every /v1/batches request');
    expect(limits).toContain('also GET /v/{id} and /v/{id}.json');
    const offLimits = page(off, 'docs/limits.html');
    expect(offLimits).not.toContain('/v1/batches');
    expect(offLimits).toContain('Per API key (POST /v1/images) and per site (uncached signed-URL renders)');
  });

  it('Image to PDF says what 16-bit PNGs lose and which images the API takes', () => {
    const html = page(all, 'tools/image-to-pdf.html');
    expect(html).not.toContain('does the same from a script');
    expect(html).toContain('makes PDFs from PNG and JPEG images from a script');
    expect(html).toContain('The API takes PNG and JPEG images; convert WebP and GIF files first.');
    expect(html).toContain('a 16-bit PNG is reduced to 8 bits per colour');
    expect(html).not.toContain('lossless compression');
  });
});
