// The pages of the in-browser PDF tools, /tools/merge-pdf and /tools/image-to-pdf (feature
// "toolkit"): built only with the feature, every limit printed from LOCAL_PDF, the attributes
// the scripts read, the promise that files stay on the device, and the API examples.
// tests/node/client-pdf.test.ts covers the engine and the scripts themselves.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PDF, PDF, PDF_TOOLKIT } from '../../src/config';
import { IMAGE_FITS, IMAGE_ORIENTATIONS, IMAGE_PAGE_SIZES } from '../../site/src-browser/pdf-local';
import { buildBrowserBundles } from '../../scripts/build-browser-bundles.mts';
import { LOCAL_PDF_BUNDLE, buildSite, renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-26T12:00:00Z');
const temp = mkdtempSync(join(tmpdir(), 'ltc-client-pdf-pages-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const PAGES = { merge: 'tools/merge-pdf.html', images: 'tools/image-to-pdf.html' } as const;
const FILES = ['assets/js/local-files.js', 'assets/js/merge-pdf.js', 'assets/js/image-to-pdf.js', LOCAL_PDF_BUNDLE];

const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', rsquo: '’', middot: '·', nbsp: ' ' };
const unescapeHtml = (html: string): string =>
  html
    .replace(/&(ldquo|rdquo|rsquo|middot|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const visibleText = (html: string): string => unescapeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`) : [entry.name],
  );
}

let on: RenderedSite;
let off: RenderedSite;
beforeAll(() => {
  on = renderSite({ env: { SITE_FEATURES: 'toolkit' }, now: NOW });
  off = renderSite({ env: {}, now: NOW });
});

const page = (site: RenderedSite, outPath: string): string | undefined => site.pages.find((candidate) => candidate.outPath === outPath)?.html;
const built = (outPath: string): string => {
  const html = page(on, outPath);
  if (!html) throw new Error(`no page ${outPath}`);
  return html;
};
const formOf = (html: string): string => html.slice(html.indexOf('<form'), html.indexOf('</form>'));
const attribute = (html: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(formOf(html))?.[1];

describe('publishing', () => {
  it('builds both pages only with the toolkit feature, and lists them in sitemap.xml only then', () => {
    for (const outPath of Object.values(PAGES)) {
      expect(page(off, outPath), outPath).toBeUndefined();
      expect(page(on, outPath), outPath).toBeDefined();
      const url = `/${outPath.replace(/\.html$/, '')}`;
      expect(off.sitemap).not.toContain(`${off.config.url}${url}<`);
      expect(on.sitemap).toContain(`<loc>${on.config.url}${url}</loc>`);
    }
  });

  it('copies the scripts and the engine only with the feature', async () => {
    await buildBrowserBundles();
    const offDir = join(temp, 'off');
    const onDir = join(temp, 'on');
    buildSite({ outDir: offDir, env: {}, now: NOW });
    buildSite({ outDir: onDir, env: { SITE_FEATURES: 'toolkit' }, now: NOW });
    const offFiles = walk(offDir);
    const onFiles = walk(onDir);
    for (const file of FILES) {
      expect(offFiles, file).not.toContain(file);
      expect(onFiles, file).toContain(file);
    }
    expect(readFileSync(join(onDir, LOCAL_PDF_BUNDLE), 'utf8')).toBe(readFileSync(join(ROOT, 'site/public', LOCAL_PDF_BUNDLE), 'utf8'));
  });

  it('refuses to publish the tools without their engine', () => {
    const siteDir = join(temp, 'site');
    cpSync(join(ROOT, 'site'), siteDir, { recursive: true, filter: (source) => !source.includes(`${join('site', 'dist')}`) && !source.endsWith('pdf-local.js') });
    expect(existsSync(join(siteDir, 'public', LOCAL_PDF_BUNDLE))).toBe(false);
    expect(() => buildSite({ siteDir, outDir: join(temp, 'no-engine'), env: { SITE_FEATURES: 'toolkit' }, now: NOW })).toThrow(/pdf-local\.js is missing: run "npm run build:browser" first/);
    // Without the feature the engine is not needed.
    expect(() => buildSite({ siteDir, outDir: join(temp, 'no-engine-off'), env: {}, now: NOW })).not.toThrow();
  });
});

describe.each(Object.entries(PAGES))('%s page', (tool, outPath) => {
  it('loads its own script, which loads local-files.js and the engine', () => {
    const html = built(outPath);
    expect(html).toContain(`<script type="module" src="/assets/js/${outPath.slice('tools/'.length, -'.html'.length)}.js"></script>`);
    expect(html).not.toContain('/assets/js/pdf-tools.js');
  });

  it('gives the scripts the LOCAL_PDF limits, unformatted', () => {
    const html = built(outPath);
    expect(attribute(html, 'data-max-files')).toBe(String(LOCAL_PDF.maxFiles));
    expect(attribute(html, 'data-max-bytes')).toBe(String(LOCAL_PDF.maxTotalBytes));
    if (tool === 'merge') expect(attribute(html, 'data-max-pages')).toBe(String(LOCAL_PDF.maxPages));
    else expect(attribute(html, 'data-max-pixels')).toBe(String(LOCAL_PDF.maxImagePixels));
  });

  it('has every element the script looks up', () => {
    const html = built(outPath);
    for (const id of ['local-form', 'file-input', 'drop-zone', 'file-list', 'file-summary', 'local-submit', 'local-error', 'local-result', 'local-result-text', 'local-download', 'local-status']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-sort');
    expect(html).toContain('data-clear');
  });

  it('says the files stay on the device, and prints the limits from LOCAL_PDF', () => {
    const text = visibleText(built(outPath));
    expect(text).toContain('Your files stay on your device: this page');
    expect(text).toContain('uploads nothing');
    expect(text).toContain(`Up to ${LOCAL_PDF.maxFiles} `);
    expect(text).toContain(`${LOCAL_PDF.maxTotalBytes / (1024 * 1024)} MB together`);
    if (tool === 'merge') expect(text).toContain(`${LOCAL_PDF.maxPages.toLocaleString('en-US')} pages in the merged PDF`);
    else expect(text).toContain(`up to ${LOCAL_PDF.maxImagePixels / 1_000_000} million pixels each`);
    expect(text).toContain('No account, no watermark.');
  });

  it('links to the API from the top of the page, with an example the toolkit accepts', () => {
    const html = built(outPath);
    expect(html).toContain('<a class="link-arrow" href="#api">Automate this with the API</a>');
    expect(html).toContain('<h3 id="api">Automate this with the API</h3>');
    expect(html).toContain('href="/docs/pdf-tools"');
    const code = unescapeHtml(/<code class="language-shell">([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '');
    const op = tool === 'merge' ? 'merge' : 'from-images';
    expect(code).toContain(`curl ${on.config.url}/v1/pdf-tools/${op} \\`);
    const body = JSON.parse(/-d '([\s\S]*?)'/.exec(code)?.[1] ?? 'null') as Record<string, unknown> & { files: Array<Record<string, unknown>> };
    // The fields src/pdftools/request.ts takes for the operation (it cannot run in Node: it imports the renderer).
    const allowed = tool === 'merge' ? ['files', 'response'] : ['files', 'response', 'page_size', 'fit', 'orientation', 'margin'];
    expect(Object.keys(body).filter((key) => !allowed.includes(key))).toEqual([]);
    for (const entry of body.files) expect(Object.keys(entry).filter((key) => !['url', ...(tool === 'merge' ? ['pages'] : [])].includes(key))).toEqual([]);
    expect(body.response).toBe('binary');
    if (tool === 'images') {
      expect(IMAGE_PAGE_SIZES).toContain(body.page_size);
      expect(IMAGE_FITS).toContain(body.fit);
      expect(typeof body.margin).toBe('number');
    }
    const text = visibleText(html);
    expect(text).toContain(`Each started block of ${PDF_TOOLKIT.pagesPerUnit} pages of the result counts as one image of your plan.`);
    expect(text).toContain(`carries a small “${PDF.freeMark}” line`);
  });
});

describe('image page setup', () => {
  it('offers exactly the engine options, A4 first and selected', () => {
    const form = formOf(built(PAGES.images));
    const options = (name: string): string[] => {
      const select = new RegExp(`<select class="select" name="${name}">([\\s\\S]*?)</select>`).exec(form)?.[1] ?? '';
      return [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]!);
    };
    expect(options('page_size')).toEqual([...IMAGE_PAGE_SIZES]);
    expect(options('fit')).toEqual([...IMAGE_FITS]);
    expect(options('orientation')).toEqual([...IMAGE_ORIENTATIONS]);
    expect(form).toContain(`<option value="${PDF.defaultFormat}" selected>`);
    expect(form).toMatch(new RegExp(`name="margin" type="number"[^>]* min="0" max="${PDF.maxMarginMm}"`));
  });

  it('accepts the four image types the script handles', () => {
    expect(attribute(built(PAGES.images), 'accept')).toBe('image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif');
    expect(attribute(built(PAGES.merge), 'accept')).toBe('application/pdf,.pdf');
  });
});
