// Chart images on the site (site feature "charts", owner decision of 2026-11-28): the four free chart
// maker pages, /docs/charts, the homepage tile, the /tools block, the counting rule, the rate-limit
// rows, the privacy sentence and the OpenAPI paths. All of it is published only with the feature, so
// the production build (package.json "deploy:production", which leaves it out) has no trace of
// charts; tests/node/production-site.test.ts checks that page by page. This file checks what the
// pages say against the code: the documented signing example against src/charts/url.ts, the field
// tables against the validator (src/charts/spec.ts), the numbers against CHARTS (src/config.ts), and
// the chart maker's own helpers (site/public/assets/js/chart-maker.js) against the validator.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PLANS } from '../../src/billing/plans';
import { CHARTS, DAY_MS, RATE_LIMITS } from '../../src/config';
import { renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-28T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const temp = mkdtempSync(join(tmpdir(), 'ltc-charts-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** The site settings a deploy script in package.json passes to the build. */
function deployEnv(script: 'deploy:staging' | 'deploy:production'): Record<string, string> {
  const command = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts[script] ?? '';
  const features = /\bSITE_FEATURES=([a-z,]+)/.exec(command)?.[1];
  const pdf = /\bSITE_PDF=(on|off)\b/.exec(command)?.[1];
  if (features === undefined || pdf === undefined) throw new Error(`package.json "${script}" no longer sets SITE_FEATURES and SITE_PDF`);
  return { SITE_FEATURES: features, SITE_PDF: pdf };
}

const staging = renderSite({ env: deployEnv('deploy:staging'), now: NOW });
const production = renderSite({ env: deployEnv('deploy:production'), now: NOW });
const chartsOnly = renderSite({ env: { SITE_FEATURES: 'charts' }, now: NOW });
const plain = renderSite({ env: {}, now: NOW });

const page = (site: RenderedSite, outPath: string): string => {
  const found = site.pages.find((entry) => entry.outPath === outPath);
  if (!found) throw new Error(`${outPath} is not built`);
  return found.html;
};
const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', times: '×', nbsp: ' ' };
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|times|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const TOOL_PAGES = ['tools/chart-maker.html', 'tools/pie-chart-maker.html', 'tools/bar-graph-maker.html', 'tools/line-graph-maker.html'];
const START_TYPES: Record<string, string> = { 'tools/chart-maker.html': 'bar', 'tools/pie-chart-maker.html': 'pie', 'tools/bar-graph-maker.html': 'bar', 'tools/line-graph-maker.html': 'line' };
const CHART_PAGES = [...TOOL_PAGES, 'docs/charts.html'];

// Worker and browser sources are loaded through computed paths, as in signing-vectors.test.ts: a static
// import would pull them into the Node tsconfig.
interface ChartUrlModule {
  verifyChartUrl(url: URL, secret: string): Promise<{ ok: true; chartJson: string } | { ok: false; reason: string }>;
  buildChartUrl(input: { baseUrl: string; siteId: string; ext: 'png'; chartJson: string; secret: string }): Promise<string>;
}
interface ChartSpecModule {
  CHART_FIELDS: readonly string[];
  parseChart(input: unknown, extra?: readonly string[]): { type: string; series: unknown[]; legend: boolean; width: number; height: number; scale: number };
}
interface MakerForm {
  type: string;
  title: string;
  names: string[];
  rows: Array<{ label: string; values: string[] }>;
  stacked: boolean;
  horizontal: boolean;
  values: boolean;
  legend: boolean;
  prefix: string;
  suffix: string;
  theme: string;
  width: number;
  height: number;
}
interface MakerModule {
  API_PATH: string;
  MIN_GAP_MS: number;
  cellValue(text: string): number | string | null;
  parseBlock(text: string): string[][] | null;
  tableFromBlock(rows: string[][], maxSeries: number, maxRows: number): { names: string[]; rows: Array<{ label: string; values: string[] }>; droppedSeries: number; droppedRows: number };
  buildChart(form: MakerForm): { chart: Record<string, unknown> & { series: Array<{ name?: string; data: unknown[] }>; options?: Record<string, unknown> }; rowOf: number[] };
  fileName(title: string): string;
}
const load = async <T>(path: string): Promise<T> => (await import(join(ROOT, path))) as T;
const urls = await load<ChartUrlModule>('src/charts/url.ts');
const spec = await load<ChartSpecModule>('src/charts/spec.ts');
const maker = await load<MakerModule>('site/public/assets/js/chart-maker.js');

/** The fields the validator allows inside an object, read from its own "unknown field" message. */
function allowedFields(input: unknown): string[] {
  try {
    spec.parseChart(input);
  } catch (error) {
    const allowed = /Allowed: ([^.]+)\./.exec((error as Error).message)?.[1];
    if (allowed) return allowed.split(', ');
  }
  throw new Error('the validator accepted an unknown field');
}
const BASE_CHART = { type: 'bar', labels: ['a'], series: [{ data: [1] }] };

describe('the charts feature in each build', () => {
  it('publishes the four chart maker pages and /docs/charts with the feature, in staging, and nothing of it without', () => {
    for (const site of [staging, chartsOnly]) {
      const built = site.pages.map((entry) => entry.outPath);
      for (const outPath of CHART_PAGES) expect(built, outPath).toContain(outPath);
      expect(site.pages.filter((entry) => CHART_PAGES.includes(entry.outPath)).every((entry) => entry.indexed)).toBe(true);
    }
    for (const site of [production, plain]) {
      expect(site.features.charts).toBe(false);
      for (const outPath of CHART_PAGES) expect(site.pages.map((entry) => entry.outPath), outPath).not.toContain(outPath);
      for (const entry of site.pages) {
        expect(entry.html, entry.outPath).not.toMatch(/chart-maker|bar-graph-maker|line-graph-maker|\/docs\/charts|\/v1\/charts?\b|\/api\/tools\/chart|Chart images|chart image/i);
      }
      expect(site.openapi).not.toMatch(/chart/i);
    }
    expect(staging.features.charts).toBe(true);
    // The staging build gets the feature; production's list is unchanged.
    expect(deployEnv('deploy:staging').SITE_FEATURES.split(',')).toContain('charts');
    expect(deployEnv('deploy:production')).toEqual({ SITE_FEATURES: 'previews,localpdf,apidocs', SITE_PDF: 'off' });
  });

  it('copies the chart maker\'s script and stylesheet only with the feature', async () => {
    const { buildSite } = await import('../../scripts/build-site');
    const files = (env: Record<string, string>, name: string): string[] => {
      const dir = join(temp, name);
      buildSite({ outDir: dir, env, now: NOW });
      return ['assets/js/chart-maker.js', 'assets/css/chart-maker.css'].filter((file) => {
        try {
          readFileSync(join(dir, file));
          return true;
        } catch {
          return false;
        }
      });
    };
    expect(files({ SITE_FEATURES: 'charts' }, 'with')).toEqual(['assets/js/chart-maker.js', 'assets/css/chart-maker.css']);
    expect(files(deployEnv('deploy:production'), 'production')).toEqual([]);
  });

  it('lists the tile, the /tools block, the counting rule and the docs page only with the feature', () => {
    expect(page(staging, 'index.html')).toContain('<a class="tool-tile" href="/tools/chart-maker" data-tool="chart-images"');
    expect(page(production, 'index.html')).not.toContain('data-tool="chart-images"');
    const hub = page(staging, 'tools.html');
    for (const outPath of TOOL_PAGES) expect(hub, outPath).toContain(`<dt><a href="/${outPath.replace(/\.html$/, '')}">`);
    expect(page(production, 'tools.html')).not.toContain('<h2>Charts</h2>');
    for (const outPath of ['pricing.html', 'docs/limits.html', 'docs/api.html']) {
      expect(page(staging, outPath), outPath).toContain('A chart image counts once');
      expect(page(production, outPath), outPath).not.toContain('A chart image counts once');
    }
    expect(text(page(staging, 'pricing.html'))).toContain(`for ${CHARTS.chargeMemoryDays} days from its count. The free chart maker counts nothing.`);
    const nav = (html: string): string => html.slice(html.indexOf('<nav class="docs-nav"'), html.indexOf('</nav>', html.indexOf('<nav class="docs-nav"')));
    expect(nav(page(staging, 'docs.html'))).toContain('<a href="/docs/charts">Chart images</a>');
    expect(staging.sitemap).toContain('/docs/charts</loc>');
    expect(staging.sitemap).toContain('/tools/pie-chart-maker</loc>');
  });

  it('adds the chart routes to the rate-limit table with the feature', () => {
    const limits = text(page(staging, 'docs/limits.html'));
    expect(limits).toContain(`also ${CHARTS.rateLimitScopes.RL_KEY}`);
    expect(limits).toContain(`also ${CHARTS.rateLimitScopes.RL_PLAYGROUND}`);
    const off = text(page(production, 'docs/limits.html'));
    expect(off).not.toContain(CHARTS.rateLimitScopes.RL_KEY);
    expect(off).not.toContain(CHARTS.rateLimitScopes.RL_PLAYGROUND);
  });

  it('states the chart maker in the privacy policy with the feature, dated 28 November 2026, and leaves production\'s date alone', () => {
    const sentence = 'Free chart maker : the chart you enter (its type, labels, numbers and titles), which our server uses only to draw the image and send it straight back to your browser; neither the chart nor the image is stored';
    expect(text(page(staging, 'privacy.html'))).toContain(sentence);
    expect(text(page(staging, 'privacy.html'))).toContain('Last updated: 28 November 2026');
    expect(text(page(production, 'privacy.html'))).not.toContain('chart');
    expect(text(page(production, 'privacy.html'))).toContain('Last updated: 27 November 2026');
    expect(read('site/content/privacy.md')).toMatch(/^updated\.charts: 2026-11-28$/m);
  });
});

describe('the chart maker pages', () => {
  it('open on their own type, load only their own script and stylesheet, and have no inline script or style', () => {
    for (const outPath of TOOL_PAGES) {
      const html = page(staging, outPath);
      expect(html, outPath).toContain(`<div class="chart-tool" data-chart-start="${START_TYPES[outPath]}">`);
      expect(html, outPath).toContain('<script type="module" src="/assets/js/chart-maker.js"></script>');
      expect(html, outPath).toContain('<div id="content" tabindex="-1">\n<link rel="stylesheet" href="/assets/css/chart-maker.css">\n<main class="tool">');
      expect(html, outPath).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html, outPath).not.toMatch(/\sstyle="/);
      expect(html, outPath).not.toMatch(/<style\b/);
      // Says without JavaScript that it needs it, and ends with the automatic version.
      expect(html, outPath).toContain('<noscript><p class="alert alert-warn chart-noscript">This chart maker needs JavaScript');
      expect(html, outPath).toContain('<a class="btn btn-primary" href="/docs/charts">Read the chart docs</a>');
      // States what it does not do, precisely.
      expect(text(html), outPath).toContain('Your data is sent to our server to draw the image, and is not stored.');
      expect(text(html), outPath).toContain('It does not make interactive charts.');
      expect(text(html), outPath).toContain('It is not a spreadsheet.');
      expect(text(html), outPath).toContain(`previews are limited to ${RATE_LIMITS.RL_PLAYGROUND.limit} requests per minute from one network`);
      // No search volumes, no superlatives, no exclamation marks.
      expect(text(html), outPath).not.toMatch(/searches|best |fastest|!/i);
    }
    // No other page loads it.
    for (const entry of staging.pages.filter((built) => !TOOL_PAGES.includes(built.outPath))) expect(entry.html, entry.outPath).not.toContain('chart-maker.css');
  });

  it('carry the limits of CHARTS in their attributes', () => {
    const html = page(staging, 'tools/chart-maker.html');
    expect(html).toContain(`data-max-series="${CHARTS.maxSeries}" data-max-points="${CHARTS.maxPoints}" data-max-slices="${CHARTS.maxSlices}" data-max-label-chars="${CHARTS.maxLabelChars}" data-max-name-chars="${CHARTS.maxSeriesNameChars}"`);
    expect(html).toContain(`name="title" maxlength="${CHARTS.maxTitleChars}"`);
    expect(html).toContain(`name="prefix" maxlength="${CHARTS.maxAffixChars}"`);
  });

  it('offer only sizes the endpoint accepts, drawn at scale 2', () => {
    const options = [...page(staging, 'tools/chart-maker.html').matchAll(/<option value="(\d+)x(\d+)"/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(options).toContainEqual([CHARTS.defaultWidth, CHARTS.defaultHeight]);
    for (const [width, height] of options) {
      const chart = spec.parseChart({ ...BASE_CHART, width, height, scale: 2 });
      expect(chart.width * chart.height * 4, `${width}x${height}`).toBeLessThanOrEqual(CHARTS.maxPixels);
    }
  });

  it('show the image from a blob: URL, which the Content-Security-Policy allows', () => {
    const csp = /Content-Security-Policy: (.+)/.exec(read('site/public/_headers'))?.[1] ?? '';
    expect(/img-src ([^;]+)/.exec(csp)?.[1]?.split(' ')).toContain('blob:');
    const script = read('site/public/assets/js/chart-maker.js');
    expect(script).toContain('URL.createObjectURL(blob)');
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|eval\(|new Function/);
    expect(maker.API_PATH).toBe('/api/tools/chart');
    expect(read('src/routes/charts.ts')).toContain("chartToolRouter.post('/chart', requireSameOrigin");
  });

  it('never ask the endpoint more often than once per two seconds, under its rate limit', () => {
    expect(maker.MIN_GAP_MS).toBeGreaterThanOrEqual(2000);
    expect(RATE_LIMITS.RL_PLAYGROUND.periodSeconds * 1000 / maker.MIN_GAP_MS).toBeLessThanOrEqual(RATE_LIMITS.RL_PLAYGROUND.limit);
  });
});

describe('the chart maker script', () => {
  const form = (patch: Partial<MakerForm> = {}): MakerForm => ({
    type: 'bar',
    title: ' Orders ',
    names: ['2025', '2026'],
    rows: [
      { label: 'Q1', values: ['120', '1,350.5'] },
      { label: '', values: ['', ''] },
      { label: 'Q2', values: ['-3', '2e3'] },
    ],
    stacked: false,
    horizontal: false,
    values: false,
    legend: true,
    prefix: '',
    suffix: '',
    theme: 'light',
    width: CHARTS.defaultWidth,
    height: CHARTS.defaultHeight,
    ...patch,
  });

  it('reads numbers as a spreadsheet writes them, and keeps anything else for the server to refuse', () => {
    expect(maker.cellValue('1250')).toBe(1250);
    expect(maker.cellValue(' 1,250.5 ')).toBe(1250.5);
    expect(maker.cellValue('-0.25')).toBe(-0.25);
    expect(maker.cellValue('')).toBeNull();
    expect(maker.cellValue('1,5')).toBe('1,5');
    expect(maker.cellValue('12%')).toBe('12%');
  });

  it('turns a pasted block into a table, with the header row when it has names', () => {
    const tabs = maker.parseBlock('Region\tOnline\tStores\r\nNorth\t120\t80\nSouth\t95\t110\n');
    expect(tabs).toEqual([['Region', 'Online', 'Stores'], ['North', '120', '80'], ['South', '95', '110']]);
    expect(maker.tableFromBlock(tabs!, CHARTS.maxSeries, CHARTS.maxPoints)).toEqual({
      names: ['Online', 'Stores'],
      rows: [{ label: 'North', values: ['120', '80'] }, { label: 'South', values: ['95', '110'] }],
      droppedSeries: 0,
      droppedRows: 0,
    });
    const csv = maker.parseBlock('Month,"Sales, net"\nJan,"1,200"\nFeb,900');
    expect(csv).toEqual([['Month', 'Sales, net'], ['Jan', '1,200'], ['Feb', '900']]);
    // No header: the first row holds numbers.
    expect(maker.tableFromBlock([['Jan', '1'], ['Feb', '2']], CHARTS.maxSeries, CHARTS.maxPoints).names).toEqual(['']);
    // Too wide or too long: cut, and said so.
    const wide = maker.tableFromBlock([['x', '1', '2', '3'], ['y', '4', '5', '6']], 2, 1);
    expect(wide).toMatchObject({ droppedSeries: 1, droppedRows: 1 });
    expect(maker.parseBlock('just one value')).toBeNull();
  });

  it('builds chart JSON that the validator accepts, short and with every default left out', () => {
    const { chart, rowOf } = maker.buildChart(form());
    expect(chart).toEqual({
      type: 'bar',
      title: 'Orders',
      labels: ['Q1', 'Q2'],
      series: [{ name: '2025', data: [120, -3] }, { name: '2026', data: [1350.5, 2000] }],
      width: CHARTS.defaultWidth,
      height: CHARTS.defaultHeight,
      scale: 2,
    });
    expect(rowOf).toEqual([0, 2]);
    expect(spec.parseChart(chart).series).toHaveLength(2);
  });

  it('sends the first series only for pie and doughnut, and options only where they apply', () => {
    const pie = maker.buildChart(form({ type: 'pie', rows: [{ label: 'A', values: ['1', '9'] }], stacked: true, horizontal: true, legend: true, suffix: '%' })).chart;
    expect(pie.series).toEqual([{ name: '2025', data: [1] }]);
    expect(pie.options).toEqual({ suffix: '%' });
    expect(spec.parseChart(pie).type).toBe('pie');
    const line = maker.buildChart(form({ type: 'line', names: ['Visits'], rows: [{ label: 'Jan', values: ['5'] }], legend: false, horizontal: true, theme: 'dark' })).chart;
    expect(line.options).toEqual({ theme: 'dark' });
    const bar = maker.buildChart(form({ stacked: true, horizontal: true, values: true, legend: false, prefix: '$' })).chart;
    expect(bar.options).toEqual({ horizontal: true, stacked: true, values: true, legend: false, prefix: '$' });
    expect(spec.parseChart(bar).legend).toBe(false);
  });

  it('lets the server refuse what it would refuse, naming the field', () => {
    const { chart } = maker.buildChart(form({ rows: [{ label: 'Q1', values: ['12%', '1'] }] }));
    expect(() => spec.parseChart(chart)).toThrow(/^series\[0\]\.data\[0\]: must be a finite number\.$/);
  });

  it('names the downloaded file after the title', () => {
    expect(maker.fileName('Orders per quarter')).toBe('orders-per-quarter.png');
    expect(maker.fileName('  ')).toBe('chart.png');
  });
});

describe('/docs/charts', () => {
  const source = read('site/content/docs/charts.md');
  const docs = page(staging, 'docs/charts.html');

  it('documents every field the validator accepts, at every level', () => {
    const topLevel = [...spec.CHART_FIELDS, 'format'];
    const options = allowedFields({ ...BASE_CHART, options: { unknown_option: true } });
    const series = allowedFields({ ...BASE_CHART, series: [{ data: [1], unknown_field: 1 }] });
    expect(options.length).toBeGreaterThan(5);
    expect(series).toEqual(['name', 'data', 'color']);
    const tables = source.slice(source.indexOf('## The chart JSON'), source.indexOf('## Signed chart URLs'));
    const documented = new Set([...tables.matchAll(/^\| `([a-z_]+)`(?:, `([a-z_]+)`)? \|/gm)].flatMap((match) => [match[1], match[2]]).filter(Boolean));
    for (const field of [...spec.CHART_FIELDS, ...options, ...series]) expect(documented, field).toContain(field);
    expect(source).toContain('`format`: `"png"` (the default), `"jpeg"` (or `"jpg"`) or `"webp"`');
    // And nothing else: every documented field is one the validator knows.
    for (const field of documented) expect([...topLevel, ...options, ...series], field).toContain(field);
  });

  it('prints every limit from CHARTS through tokens, never as a typed number', () => {
    const prose = (body: string): string =>
      body
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '')
        .replace(/\[\[[^\]]+\]\]/g, '');
    const files = ['site/content/docs/charts.md', ...TOOL_PAGES.map((file) => `site/pages/${file}`), 'site/partials/chart-maker.html', 'site/partials/chart-maker-limits.html', 'site/partials/chart-maker-api.html'];
    for (const file of files) {
      const body = prose(read(file).replace(/^---[\s\S]*?---/, ''));
      expect(body, file).not.toMatch(/\b\d[\d,.]*\s+(?:series|rows|labels|slices|characters|KB|days|requests|points|decimals)\b/);
    }
    const shown = text(docs);
    expect(shown).toContain(`at most ${CHARTS.maxPoints}, or ${CHARTS.maxSlices} for pie and doughnut`);
    expect(shown).toContain(`At least 1, at most ${CHARTS.maxSeries}.`);
    expect(shown).toContain(`${CHARTS.minWidth} to ${CHARTS.maxWidth}.`);
    expect(shown).toContain(`at most ${CHARTS.maxPixels.toLocaleString('en-US')} pixels in all`);
    expect(shown).toContain(`Each is 0, or between 0.000001 and 1,000,000,000,000,000 in size`);
    expect(CHARTS.minAbsValue).toBe(0.000001);
    expect(CHARTS.maxAbsValue).toBe(1e15);
    expect(shown).toContain(`at most ${CHARTS.maxJsonBytes / 1024} KB`);
    expect(shown).toContain(`at most ${CHARTS.maxSignedUrlChars.toLocaleString('en-US')} characters (path and query)`);
    expect(shown).toContain(`of up to ${CHARTS.maxAgeSeconds * 1000 / DAY_MS} days`);
  });

  it('states the charging rule of PRODUCT-SPEC "Charging"', () => {
    const shown = text(docs);
    expect(shown).toContain('A chart is counted once: 1 image the first time it is drawn.');
    expect(shown).toContain('Repeat views are free.');
    expect(shown).toContain(`without counting it again, for ${CHARTS.chargeMemoryDays} days from the time it was counted`);
    expect(shown).toContain('A refused or failed request is never counted. HEAD never counts.');
    // The code it describes: the period is CHARTS.chargeMemoryDays, the charge key has no mark in it.
    const service = read('src/charts/service.ts');
    expect(service).toContain('chargeOnce: { key: keys.chargeKey, memoryMs: CHARTS.chargeMemoryDays * DAY_MS }');
    expect(service).toMatch(/sha256Hex\(JSON\.stringify\(\[CHARGE_KEY_VERSION, request\.user\.id, chart, request\.format\]\)\)/);
    // "Not in v1" is "not supported", never planned.
    expect(shown).not.toMatch(/coming soon|planned|later version|on the roadmap/i);
    expect(shown).toContain('Not supported');
  });

  it('gives a signing example in Node.js that makes URLs src/charts/url.ts verifies', async () => {
    const block = /```js\n(import \{ createHmac \}[\s\S]*?function signedChartUrl[\s\S]*?)```/.exec(source)?.[1];
    expect(block).toBeDefined();
    const file = join(temp, 'sign-chart.mjs');
    writeFileSync(file, (block ?? '').replaceAll('[[site.url]]', 'https://linktocard.com'));
    const secret = 'test-site-secret-0123456789';
    const run = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, LTC_SITE_SECRET: secret } });
    expect(run.stderr).toBe('');
    const printed = run.stdout.trim();
    const url = new URL(printed);
    expect(url.pathname).toBe('/v1/chart/s_4k2j9x0q1m7c8d5e.png');
    const verified = await urls.verifyChartUrl(url, secret);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    // The Worker's own signer makes the same URL, and the chart in it is valid.
    expect(await urls.buildChartUrl({ baseUrl: 'https://linktocard.com', siteId: 's_4k2j9x0q1m7c8d5e', ext: 'png', chartJson: verified.chartJson, secret })).toBe(printed);
    expect(spec.parseChart(JSON.parse(verified.chartJson)).type).toBe('bar');
    // A wrong secret does not verify.
    expect((await urls.verifyChartUrl(url, `${secret}x`)).ok).toBe(false);
    // The three lines shown above the example are the canonical form of that small chart.
    const lines = /```text\n(\/v1\/chart\/[^\n]+)\nc\n(c=[^\n]+)\n```/.exec(source);
    expect(lines).not.toBeNull();
    const shownJson = (lines?.[2] ?? '').slice('c='.length);
    expect(JSON.stringify(JSON.parse(shownJson))).toBe(shownJson);
    expect(spec.parseChart(JSON.parse(shownJson)).type).toBe('bar');
  });

  it('answers POST /v1/charts with the fields of src/routes/charts.ts and the Free plan\'s numbers', () => {
    const blocks = [...docs.matchAll(/<code class="language-json">([\s\S]*?)<\/code>/g)].map((match) => text(match[1] ?? ''));
    const answer = blocks.find((block) => block.includes('"credits_used"'));
    expect(answer).toBeDefined();
    const parsed = JSON.parse(answer ?? '{}') as Record<string, unknown> & { usage: Record<string, unknown>; created_at: string; expires_at: string };
    const route = read('src/routes/charts.ts');
    const fields = /return c\.json\(\{([\s\S]*?)\}\);/.exec(route)?.[1] ?? '';
    expect(Object.keys(parsed)).toEqual([...fields.matchAll(/^\s+([a-z_]+):/gm)].map((match) => match[1]));
    expect(parsed.usage.limit).toBe(PLANS.free.monthlyImages);
    expect(parsed.usage.remaining).toBe(PLANS.free.monthlyImages - 1);
    expect(parsed.usage.cache_days).toBe(PLANS.free.cacheDays);
    expect(Date.parse(parsed.expires_at) - Date.parse(parsed.created_at)).toBe(PLANS.free.cacheDays * DAY_MS);
    expect(String(parsed.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(parsed.url)).toContain(`/${String(parsed.id)}.png`);
    // The size of the example request's chart: 600 x 300 at scale 2.
    expect([parsed.width, parsed.height]).toEqual([1200, 600]);
  });
});

describe('openapi.yaml', () => {
  const published = staging.openapi;
  const block = published.slice(published.indexOf('    ChartRequest:'), published.indexOf('    ChartSeries:'));

  it('describes the two chart paths only with the feature', () => {
    expect(published).toContain('  /v1/charts:\n    post:');
    expect(published).toContain('  /v1/chart/{site_id}.{ext}:\n    get:');
    expect(published).not.toContain('/api/tools/chart');
    expect(production.openapi).not.toContain('/v1/chart');
  });

  it('matches the validator\'s fields and the limits of CHARTS', () => {
    const properties = (name: string, next: string): string[] => {
      const part = published.slice(published.indexOf(`    ${name}:`), published.indexOf(`    ${next}:`));
      return [...part.matchAll(/^ {8}([a-z_]+):$/gm)].map((match) => match[1]!);
    };
    expect(new Set(properties('ChartRequest', 'ChartSeries'))).toEqual(new Set([...spec.CHART_FIELDS, 'format']));
    expect(new Set(properties('ChartOptions', 'ChartImage'))).toEqual(new Set(allowedFields({ ...BASE_CHART, options: { x: 1 } })));
    expect(new Set(properties('ChartSeries', 'ChartOptions'))).toEqual(new Set(['name', 'data', 'color']));
    expect(block).toContain(`          enum: [${CHARTS.types.join(', ')}]`);
    expect(block).toContain(`          maxItems: ${CHARTS.maxPoints}\n          description: One per bar, point or slice, in order. At most ${CHARTS.maxSlices} for pie and doughnut.`);
    expect(block).toContain(`          maxItems: ${CHARTS.maxSeries}\n`);
    expect(block).toContain(`        width:\n          type: integer\n          minimum: ${CHARTS.minWidth}\n          maximum: ${CHARTS.maxWidth}\n          default: ${CHARTS.defaultWidth}`);
    expect(block).toContain(`        height:\n          type: integer\n          minimum: ${CHARTS.minHeight}\n          maximum: ${CHARTS.maxHeight}\n          default: ${CHARTS.defaultHeight}`);
    expect(block).toContain(`          enum: [${CHARTS.scales.join(', ')}]`);
    expect(published).toContain(`        decimals:\n          type: integer\n          minimum: 0\n          maximum: ${CHARTS.maxDecimals}`);
    expect(published).toContain(`up to ${CHARTS.maxAgeSeconds * 1000 / DAY_MS} days and never past the stored copy's expiry`);
    // The 503 says what the Worker says.
    expect(published).toContain('("Chart images are not enabled yet.")');
    expect(read('src/lib/features.ts')).toContain("charts: 'Chart images are'");
  });
});
