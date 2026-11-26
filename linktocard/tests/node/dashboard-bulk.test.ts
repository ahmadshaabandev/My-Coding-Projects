// The dashboard's feature tabs and the Bulk documents batch screen: the pure rules in
// site/public/assets/js/dashboard/helpers.js (dashboardTabs, routeFromHash) and
// bulk-helpers.js (ZIP parts, totals, certificates, the batch list), how dashboard.js loads
// the tab, and what a site built with and without the batch feature ships. The screens are
// exercised in a real browser against `wrangler dev` (scratch script, not part of `npm test`).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JS = join(ROOT, 'site/public/assets/js');
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(JS, name)).href)) as T;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
// Comments may name what is banned or expected; only code counts.
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

type Tab = { id: string; label: string };
type Download = { part: number; href: string; entries: number | null; bytes: number | null };
type Row = Record<string, unknown>;
type Batch = Record<string, unknown>;

interface Helpers {
  TABS: Tab[];
  FEATURE_TABS: Array<Tab & { after: string; flag: string }>;
  dashboardTabs(config: unknown): Tab[];
  routeFromHash(hash: string, tabs?: Tab[]): { tab: string; param: string };
}

interface Bulk {
  zipDownloads(batch: Batch | null, path: string): Download[];
  zipPartDetail(download: Download): string;
  zipPartLabel(download: Download, partCount: number, finished: boolean): string;
  batchTotalsText(batch: Batch | null): string;
  rowFilename(row: Row | null): string;
  certificateState(row: Row | null, revokedHere?: Set<string>): { id: string; url: string | null; revoked: boolean } | null;
  batchListEntry(batch: Batch, templateNames?: Record<string, string>): { id: string; title: string; status: { label: string; tone: string }; progress: string };
  batchSettled(batch: Batch | null): boolean;
  batchCancellable(batch: Batch | null): boolean;
  batchProgress(batch: Batch): { pending: number; finished: boolean };
  progressText(progress: unknown): string;
}

const helpers = await load<Helpers>('dashboard/helpers.js');
const bulk = await load<Bulk>('dashboard/bulk-helpers.js');

const ON = { batch: { enabled: true } };
const ids = (tabs: Tab[]): string[] => tabs.map((tab) => tab.id);

describe('feature tabs', () => {
  it('adds Bulk documents after Templates only while /api/config switches batches on', () => {
    expect(ids(helpers.dashboardTabs(ON))).toEqual(['overview', 'sites', 'templates', 'bulk', 'keys', 'fonts', 'renders']);
    expect(helpers.dashboardTabs(ON).find((tab) => tab.id === 'bulk')?.label).toBe('Bulk documents');
    for (const config of [{ batch: { enabled: false } }, { batch: {} }, { batch: { enabled: 'true' } }, {}, null, undefined]) {
      expect(ids(helpers.dashboardTabs(config)), JSON.stringify(config)).toEqual(ids(helpers.TABS));
    }
  });

  it('leaves the always-on tabs as they are, and copies them', () => {
    const before = JSON.stringify(helpers.TABS);
    const tabs = helpers.dashboardTabs(ON);
    tabs[0]!.label = 'changed';
    expect(JSON.stringify(helpers.TABS)).toBe(before);
    expect(helpers.TABS.some((tab) => tab.id === 'bulk')).toBe(false);
  });

  it('routes #bulk only to an account whose tabs include it', () => {
    const on = helpers.dashboardTabs(ON);
    expect(helpers.routeFromHash('#bulk', on)).toEqual({ tab: 'bulk', param: '' });
    expect(helpers.routeFromHash('#bulk/bat_abc123', on)).toEqual({ tab: 'bulk', param: 'bat_abc123' });
    expect(helpers.routeFromHash('#bulk/bat_abc123', helpers.dashboardTabs({}))).toEqual({ tab: 'overview', param: '' });
    // Without a list, the always-on tabs: what the dashboard did before feature tabs existed.
    expect(helpers.routeFromHash('#bulk')).toEqual({ tab: 'overview', param: '' });
    expect(helpers.routeFromHash('#billing', on)).toEqual({ tab: 'overview', param: 'billing' });
  });

  it('every feature tab has its module and comes after a tab that exists', () => {
    for (const tab of helpers.FEATURE_TABS) {
      expect(existsSync(join(JS, 'dashboard', `${tab.id}.js`)), tab.id).toBe(true);
      expect(ids(helpers.TABS)).toContain(tab.after);
    }
  });

  it('dashboard.js imports a feature tab only when it is opened, never at start', () => {
    const source = code('site/public/assets/js/dashboard.js');
    expect(source).not.toMatch(/from '\.\/dashboard\/bulk\.js'/);
    expect(source).not.toMatch(/import \* as bulk/);
    expect(source).toContain("import('./dashboard/bulk.js').then((module) => module.mount(...args))");
    expect(source).toContain('dashboardTabs(config)');
    expect(source).toContain('routeFromHash(location.hash, shownTabs)');
    // The nav and the window title follow the same list as the router.
    expect(source).toContain('shownTabs.map((tab) =>');
    expect(source).toContain('shownTabs.find((tab) => tab.id === route.tab).label');
    expect(source).not.toMatch(/\bTABS\b/);
  });

  it('bulk.js shows nothing of the feature when the server says it is off', () => {
    expect(code('site/public/assets/js/dashboard/bulk.js')).toContain('if (ctx.config.batch?.enabled !== true) return { node: notEnabled() };');
  });
});

describe('ZIP parts (decision D9)', () => {
  const path = '/api/batches/bat_abc123';
  const parts = [
    { part: 2, entries: 3, bytes: 61_000, url: 'https://linktocard.example/api/batches/bat_abc123/zip?part=2' },
    { part: 1, entries: 500, bytes: 2_000_000_000, url: 'https://linktocard.example/api/batches/bat_abc123/zip?part=1' },
  ];

  it('offers one download per part, in order, on this origin', () => {
    expect(bulk.zipDownloads({ zip_parts: parts }, path)).toEqual([
      { part: 1, href: '/api/batches/bat_abc123/zip?part=1', entries: 500, bytes: 2_000_000_000 },
      { part: 2, href: '/api/batches/bat_abc123/zip?part=2', entries: 3, bytes: 61_000 },
    ]);
  });

  it('offers nothing while no part exists, and skips a part the server could not have sent', () => {
    expect(bulk.zipDownloads({ zip_parts: [], counts: { done: 4 } }, path)).toEqual([]);
    expect(bulk.zipDownloads({ zip_parts: [{ part: 0 }, { part: 'x' }, null] }, path)).toEqual([]);
    expect(bulk.zipDownloads({ zip_parts: [{ part: 1, entries: -1, bytes: 1.5 }] }, path)).toEqual([{ part: 1, href: `${path}/zip?part=1`, entries: null, bytes: null }]);
  });

  it('without zip_parts (an older answer) offers the whole ZIP once something is done', () => {
    expect(bulk.zipDownloads({ counts: { done: 2 } }, path)).toEqual([{ part: 1, href: `${path}/zip`, entries: 2, bytes: null }]);
    expect(bulk.zipDownloads({ rows: [{ status: 'done' }, { status: 'failed' }] }, path)).toEqual([{ part: 1, href: `${path}/zip`, entries: 1, bytes: null }]);
    expect(bulk.zipDownloads({ counts: { done: 0 } }, path)).toEqual([]);
    expect(bulk.zipDownloads(null, path)).toEqual([]);
  });

  it('labels one part as the PDFs and several by number', () => {
    const one = { part: 1, href: '', entries: 3, bytes: 61_440 };
    expect(bulk.zipPartLabel(one, 1, true)).toBe('Download the PDFs (.zip)');
    expect(bulk.zipPartLabel(one, 1, false)).toBe('Download the PDFs made so far (.zip)');
    expect(bulk.zipPartLabel({ ...one, part: 2 }, 3, true)).toBe('Download part 2 of 3 (.zip)');
    expect(bulk.zipPartDetail(one)).toBe('3 PDFs, 60 KB');
    expect(bulk.zipPartDetail({ ...one, entries: 500, bytes: 1_900_000_000 })).toBe('500 PDFs, 1.8 GB');
    expect(bulk.zipPartDetail({ ...one, entries: 500, bytes: 2 * 1024 ** 3 })).toBe('500 PDFs, 2 GB');
    expect(bulk.zipPartDetail({ ...one, entries: 1, bytes: null })).toBe('1 PDF');
    expect(bulk.zipPartDetail({ ...one, entries: null, bytes: null })).toBe('');
  });

  it('reads the part fields batches.ts sends, from the URL it serves', () => {
    const route = read('src/routes/batches.ts');
    expect(route).toMatch(/export interface ZipPartJson \{\s*part: number;\s*entries: number;\s*bytes: number;\s*url: string;\s*\}/);
    expect(route).toContain('zip_parts: zipPartsJson(');
    expect(route).toContain('`${zipUrl(env, surface, batchId)}?part=${part}`');
    expect(route).toContain("batchesDashboardRouter.get('/:id/zip', zipHandler);");
  });
});

describe('the batch screen', () => {
  it('keeps watching a batch until nothing in it can change, also after a cancel', () => {
    expect(bulk.batchSettled({ status: 'running', counts: { running: 0 } })).toBe(false);
    expect(bulk.batchSettled({ status: 'done', counts: { running: 0 } })).toBe(true);
    // Cancelling stops the rows that have not started; the ones being made still finish.
    expect(bulk.batchSettled({ status: 'cancelled', counts: { running: 2 } })).toBe(false);
    expect(bulk.batchSettled({ status: 'cancelled', counts: { running: 0 } })).toBe(true);
    expect(bulk.batchSettled({ status: 'cancelled', rows: [{ status: 'running' }] })).toBe(false);
    expect(bulk.batchSettled({ status: 'partial' })).toBe(true);
    expect(bulk.batchSettled(null)).toBe(false);
    const source = code('site/public/assets/js/dashboard/bulk.js');
    expect([...source.matchAll(/if \(stopped \|\| batchSettled\(batch\)\) return;/g)]).toHaveLength(2);
  });

  it('does not call a row that is still being made after a cancel "not made"', () => {
    const cancelling = { status: 'cancelled', total: 8, counts: { queued: 0, running: 1, done: 0, failed: 0, cancelled: 7 } };
    expect(bulk.progressText(bulk.batchProgress(cancelling))).toBe('0 of 8 documents made, 7 cancelled, 1 waiting.');
    expect(bulk.progressText(bulk.batchProgress({ ...cancelling, counts: { ...cancelling.counts, running: 0, done: 1 } }))).toBe('1 of 8 documents made, 7 cancelled.');
  });

  it('offers "Cancel the rest" only while the batch is queued or running', () => {
    expect(bulk.batchCancellable({ status: 'queued' })).toBe(true);
    expect(bulk.batchCancellable({ status: 'running' })).toBe(true);
    for (const status of ['done', 'partial', 'failed', 'cancelled']) expect(bulk.batchCancellable({ status, counts: { running: 1 } }), status).toBe(false);
    expect(code('site/public/assets/js/dashboard/bulk.js')).toContain('cancel.hidden = !batchCancellable(batch);');
  });

  it('reads the totals of a batch (decision D6 fields)', () => {
    expect(bulk.batchTotalsText({ pages: 12, credits_used: 24 })).toBe('12 pages, 24 images counted.');
    expect(bulk.batchTotalsText({ pages: 1, credits_used: 1 })).toBe('1 page, 1 image counted.');
    expect(bulk.batchTotalsText({ pages: 0, credits_used: 0 })).toBe('');
    expect(bulk.batchTotalsText(null)).toBe('');
  });

  it('shows a row\'s file name when the API sends one', () => {
    expect(bulk.rowFilename({ filename: 'certificate-1.pdf' })).toBe('certificate-1.pdf');
    expect(bulk.rowFilename({})).toBe('');
    expect(bulk.rowFilename(null)).toBe('');
  });

  it('knows where a certificate stands: none, valid, or revoked by the server or on this page', () => {
    expect(bulk.certificateState({ certificate_id: null })).toBeNull();
    expect(bulk.certificateState({ status: 'failed' })).toBeNull();
    const row = { certificate_id: 'crt_abc', verify_url: 'https://linktocard.example/v/crt_abc' };
    expect(bulk.certificateState(row)).toEqual({ id: 'crt_abc', url: 'https://linktocard.example/v/crt_abc', revoked: false });
    expect(bulk.certificateState({ ...row, verify_url: null })?.url).toBeNull();
    expect(bulk.certificateState(row, new Set(['crt_abc']))?.revoked).toBe(true);
    expect(bulk.certificateState({ ...row, certificate_status: 'revoked' })?.revoked).toBe(true);
    expect(bulk.certificateState({ ...row, revoked_at: '2026-11-26T12:00:00.000Z' })?.revoked).toBe(true);
  });

  it('lists a batch with its template name, status and progress', () => {
    const entry = bulk.batchListEntry(
      { id: 'bat_1', template: 'certificate', status: 'partial', total: 3, counts: { queued: 0, running: 0, done: 2, failed: 1, cancelled: 0 } },
      { certificate: 'Certificate' },
    );
    expect(entry).toEqual({ id: 'bat_1', title: 'Certificate: 3 documents', status: { label: 'Finished, some failed', tone: 'warn' }, progress: '2 of 3 documents made, 1 failed.' });
    expect(bulk.batchListEntry({ id: 'bat_2', template: 't_own', status: 'queued', total: 1 }).title).toBe('t_own: 1 document');
  });

  it('calls the routes batches.ts and verify.ts serve on the dashboard surface', () => {
    const route = read('src/routes/batches.ts');
    for (const line of [
      "batchesDashboardRouter.get('/templates',",
      "batchesDashboardRouter.post('/', createHandler('dashboard'));",
      "batchesDashboardRouter.get('/', listHandler('dashboard'));",
      "batchesDashboardRouter.get('/:id', getHandler('dashboard'));",
      "batchesDashboardRouter.post('/:id/cancel', cancelHandler('dashboard'));",
    ]) {
      expect(route).toContain(line);
    }
    expect(read('src/routes/verify.ts')).toContain("certificatesDashboardRouter.post('/:id/revoke', requireSameOrigin, requireSession, revoke);");
    const source = code('site/public/assets/js/dashboard/bulk.js');
    expect(source).toContain("api.get('/api/batches')");
    expect(source).toContain('`/api/certificates/${encodeURIComponent(row.certificate_id)}/revoke`');
    expect(source).toContain('zipDownloads(batch, path)');
    // The list of batches comes from the server now, not from this browser's storage.
    expect(source).not.toMatch(/\bmemory\b|localStorage/);
  });

  it('styles every class the batch screen adds', () => {
    const css = read('site/public/assets/css/dashboard-bulk.css');
    for (const name of ['bulk-zips', 'bulk-zip-list', 'bulk-zip', 'bulk-zip-detail', 'bulk-doc', 'bulk-filename', 'bulk-history', 'bulk-history-main', 'bulk-history-status']) {
      expect(css, name).toMatch(new RegExp(`\\.${name}\\b`));
    }
  });
});

describe('what each build ships', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ltc-dash-bulk-'));
  const NOW = new Date('2026-11-26T12:00:00Z');
  const off = buildSite({ outDir: join(temp, 'off'), env: { SITE_FEATURES: '', SITE_PDF: 'off' }, now: NOW });
  const on = buildSite({ outDir: join(temp, 'on'), env: { SITE_FEATURES: 'pdf,batch' }, now: NOW });
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  const dashboard = (site: { outDir: string }): string => readFileSync(join(site.outDir, 'dashboard.html'), 'utf8');
  const BULK_FILES = ['assets/js/dashboard/bulk.js', 'assets/js/dashboard/bulk-helpers.js', 'assets/js/dashboard/csv.js', 'assets/css/dashboard-bulk.css'];

  it('a build without the batch feature (production) has no Bulk tab files and no link to them', () => {
    for (const file of BULK_FILES) expect(existsSync(join(off.outDir, file)), file).toBe(false);
    expect(dashboard(off)).not.toContain('dashboard-bulk.css');
    expect(dashboard(off)).not.toContain('feature:');
    // The always-on dashboard still ships, with its own stylesheet.
    expect(existsSync(join(off.outDir, 'assets/js/dashboard.js'))).toBe(true);
    expect(dashboard(off)).toContain('href="/assets/css/dashboard.css"');
  });

  it('a build with it ships the tab and links its stylesheet with the page', () => {
    for (const file of BULK_FILES) expect(existsSync(join(on.outDir, file)), file).toBe(true);
    expect(dashboard(on)).toContain('<link rel="stylesheet" href="/assets/css/dashboard-bulk.css">');
    expect(dashboard(on)).not.toContain('feature:');
  });
});
