// What the docs pages of switched-off APIs say in production must be true there (audit F1, F2, F3).
// Production publishes /docs/bulk, /docs/pdf-tools, /docs/link-cards and /docs/email-images with a
// notice, but its openapi.yaml, its rate-limits table and its pages leave out what those APIs add.
// So a sentence that points the reader at one of them is a feature block of its page's feature, and
// production says what is true instead:
//   - "The OpenAPI description covers every endpoint on this page" (bulk, pdf-tools): staging only;
//     no page of either build links /openapi.yaml while documenting an endpoint it does not describe;
//   - the toolkit's rate limit: "listed with the others" on staging, the number itself in production;
//   - the per-key limit of bulk documents: "per API key" on staging, where the row names /v1/batches,
//     "the one of POST /v1/images" in production, the only route that row names there;
//   - the dashboard's preview of row 1: "made by the free PDF tool" only where that tool is published.
// The builds are rendered in memory, so site/dist is left alone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDF, RATE_LIMITS } from '../../src/config';
import { rateLimitScope, renderSite, type RenderedSite } from '../../scripts/build-site';
import { rateLimitText, v3SiteTokens } from '../../scripts/v3-site-tokens';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-27T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

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

const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', nbsp: ' ' };
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|hellip|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const html = (site: RenderedSite, outPath: string): string => {
  const found = site.pages.find((page) => page.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
};
const mainOf = (page: string): string => page.slice(page.indexOf('<main'), page.indexOf('</main>'));
/** The visible text of the page's article, without the space text() leaves where a tag was. */
const article = (site: RenderedSite, outPath: string): string => text(mainOf(html(site, outPath))).replace(/ ([.,:;)])/g, '$1').replace(/\( /g, '(');

/** "METHOD /path" of every operation of an openapi.yaml, paths with {parameters} as {}. */
function openapiOperations(yaml: string): Set<string> {
  const operations = new Set<string>();
  let path: string | null = null;
  for (const line of yaml.split('\n')) {
    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine) {
      path = pathLine[1]!.replace(/\{[^}]*\}/g, '{}');
      continue;
    }
    if (/^\S/.test(line)) path = null;
    const method = /^ {4}(get|put|post|delete|patch|head|options):\s*$/.exec(line);
    if (path && method) operations.add(`${method[1]!.toUpperCase()} ${path}`);
  }
  return operations;
}

/** "METHOD /path" of every endpoint a page documents under its own heading, e.g. "### POST /v1/batches". */
function documentedEndpoints(page: string): string[] {
  const found: string[] = [];
  for (const heading of mainOf(page).matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)) {
    for (const match of text(heading[1] ?? '').matchAll(/\b(GET|PUT|POST|DELETE|PATCH|HEAD) (\/[^\s]*)/g)) {
      found.push(`${match[1]} ${match[2]!.replace(/\{[^}]*\}/g, '{}')}`);
    }
  }
  return found;
}

/**
 * An endpoint is described when an operation has its method and its path, or a path under it
 * (GET /v1/og -> GET /v1/og/{}/{}.{}). In a heading, {name} stands for one segment and "..." for anything.
 */
function described(endpoint: string, operations: Set<string>): boolean {
  const [method, path] = endpoint.split(' ') as [string, string];
  const escape = (part: string): string => part.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\}/g, '[^/]+');
  const pattern = new RegExp(`^${method} ${path.split('...').map(escape).join('.*')}(?:/.*)?$`);
  return [...operations].some((operation) => pattern.test(operation));
}

let production: RenderedSite;
let staging: RenderedSite;
beforeAll(() => {
  production = renderSite({ env: buildEnv('deploy:production'), now: NOW });
  staging = renderSite({ env: buildEnv('deploy:staging'), now: NOW });
});

describe('the OpenAPI description (audit F1)', () => {
  it('is linked only from a page whose endpoints the published openapi.yaml describes, in both builds', () => {
    for (const [name, site] of [['production', production], ['staging', staging]] as const) {
      const operations = openapiOperations(site.openapi);
      expect(operations.size, name).toBeGreaterThan(5);
      let linking = 0;
      for (const page of site.pages) {
        if (!mainOf(page.html).includes('href="/openapi.yaml"')) continue;
        linking += 1;
        const missing = documentedEndpoints(page.html).filter((endpoint) => !described(endpoint, operations));
        expect(missing, `${name}: ${page.outPath} links /openapi.yaml`).toEqual([]);
      }
      expect(linking, name).toBeGreaterThan(0);
    }
    // The rule bites: the switched-off endpoints are absent from the production file.
    const operations = openapiOperations(production.openapi);
    for (const endpoint of ['POST /v1/batches', 'POST /v1/certificates/{}/revoke', 'GET /v/{}', 'POST /v1/pdf-tools/{}']) {
      expect(described(endpoint, operations), endpoint).toBe(false);
      expect(described(endpoint, openapiOperations(staging.openapi)), endpoint).toBe(true);
    }
  });

  it('is named by the bulk and toolkit pages on staging only', () => {
    const sentences: Array<[string, string]> = [
      ['docs/bulk.html', 'The OpenAPI description covers every endpoint on this page.'],
      ['docs/pdf-tools.html', 'The OpenAPI description has a schema for every operation.'],
    ];
    for (const [outPath, sentence] of sentences) {
      expect(article(staging, outPath), outPath).toContain(sentence);
      expect(html(staging, outPath), outPath).toContain('<a href="/openapi.yaml">OpenAPI description</a>');
      expect(article(production, outPath), outPath).not.toContain('OpenAPI');
      expect(html(production, outPath), outPath).not.toContain('/openapi.yaml');
    }
  });
});

describe('rate limits (audit F2)', () => {
  it('the toolkit page states its own limit in production, where /docs/limits has no toolkit row', () => {
    const limit = rateLimitText('RL_PDF_TOOLS');
    // From src/config.ts, as the rate-limits table prints it.
    const { limit: count, periodSeconds } = RATE_LIMITS.RL_PDF_TOOLS;
    expect(limit).toBe(`${count.toLocaleString('en-US')} requests per ${periodSeconds === 60 ? 'minute' : `${periodSeconds} seconds`}`);
    expect(v3SiteTokens()['toolkit.rateLimit']).toBe(limit);

    expect(article(production, 'docs/pdf-tools.html')).toContain(`The toolkit has its own rate limit per API key, ${limit}, on top of the rate limit per IP address of all /v1 requests.`);
    expect(article(production, 'docs/pdf-tools.html')).not.toContain('listed with the others');
    expect(html(production, 'docs/limits.html')).not.toContain(RATE_LIMITS.RL_PDF_TOOLS.scope.replace(/^p/, 'P'));
    // The per-IP row it refers to is there, for every /v1 request; the toolkit route counts against both.
    expect(text(html(production, 'docs/limits.html'))).toContain(`${rateLimitScope('RL_IP', production.features).replace(/^p/, 'P')} ${rateLimitText('RL_IP')}`);
    expect(read('src/routes/pdf-toolkit.ts')).toContain("pdfToolkitRouter.post('/:op', limitIp, requireApiKey, limitKey,");
    expect(read('src/routes/pdf-toolkit.ts')).toContain("enforceRateLimit(c.env, 'RL_PDF_TOOLS',");

    // Staging lists it with the others, in the same words.
    expect(article(staging, 'docs/pdf-tools.html')).toContain('The toolkit has its own rate limit per API key, listed with the others under Rate limits.');
    expect(html(staging, 'docs/limits.html')).toContain(`<th scope="row">${RATE_LIMITS.RL_PDF_TOOLS.scope.replace(/^p/, 'P')}</th><td>${limit}</td>`);
  });

  it('the bulk page names in production the per-key limit it shares with POST /v1/images, the only route that row names there', () => {
    const productionRow = rateLimitScope('RL_KEY', production.features);
    expect(productionRow).toContain('(POST /v1/images)');
    expect(productionRow).not.toContain('/v1/batches');
    expect(html(production, 'docs/limits.html')).toContain(`<th scope="row">${productionRow.replace(/^p/, 'P')}</th><td>${rateLimitText('RL_KEY')}</td>`);
    expect(article(production, 'docs/bulk.html')).toContain("The requests count against the API's rate limits: the one per IP address, and per API key the one of POST /v1/images, which they share.");
    // Both count against RL_KEY by the API key's id.
    expect(read('src/routes/batches.ts')).toContain("await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? c.var.user.id);");
    expect(read('src/routes/api.ts')).toContain("await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? user.id);");

    expect(rateLimitScope('RL_KEY', staging.features)).toContain('every /v1/batches request');
    expect(article(staging, 'docs/bulk.html')).toContain("The requests count against the API's rate limits per IP address and per API key.");
  });
});

describe('tools production does not publish (audit F3)', () => {
  it('the bulk page names the free PDF tool only where it is published, and says what the preview carries everywhere', () => {
    expect(production.pages.map((page) => page.url)).not.toContain('/tools/html-to-pdf');
    expect(article(production, 'docs/bulk.html')).not.toContain('free PDF tool');
    expect(article(production, 'docs/bulk.html')).toContain(`row 1 for a preview (with the "${PDF.freeMark}" line, not stored and not counted) and every row when you start the batch.`);
    // The preview is made by POST /api/tools/pdf, the free PDF tools' endpoint, which marks every
    // page of every PDF with that line (tests/pdf-tools.test.ts).
    expect(read('site/public/assets/js/dashboard/bulk.js')).toContain("const PREVIEW_PATH = '/api/tools/pdf';");

    expect(staging.pages.map((page) => page.url)).toContain('/tools/html-to-pdf');
    expect(article(staging, 'docs/bulk.html')).toContain("row 1 for a preview made by the free PDF tool (with that tool's mark, not stored and not counted) and every row when you start the batch.");
  });
});
