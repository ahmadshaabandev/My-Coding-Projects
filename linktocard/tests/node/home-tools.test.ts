// The home page's tool grid (site/tools.catalog.ts -> scripts/tools-site.ts -> site/pages/index.html).
// The grid is static HTML made at build time, so these tests read the rendered pages: which tools a
// build lists, where each tile goes, what it is labelled, and that the page under the grid is intact.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLANS, formatCount } from '../../src/billing/plans';
import { FEATURES, renderSite, type Feature, type RenderedSite } from '../../scripts/build-site';
import { publishedTools, toolPagePath } from '../../scripts/tools-site';
import { TOOL_ICONS } from '../../site/tool-icons';
import { TOOLS, TOOL_CATEGORIES, TOOL_CHIPS, TOOL_LABELS, type Tool } from '../../site/tools.catalog';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-28T12:00:00Z');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** The site settings of a deploy script in package.json, exactly as that script passes them to the build. */
function deployEnv(script: 'deploy:staging' | 'deploy:production'): Record<string, string> {
  const command = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts[script] ?? '';
  const features = /\bSITE_FEATURES=([a-z,]+)/.exec(command)?.[1];
  const pdf = /\bSITE_PDF=(on|off)\b/.exec(command)?.[1];
  if (features === undefined || pdf === undefined) throw new Error(`package.json "${script}" no longer sets SITE_FEATURES and SITE_PDF`);
  return { SITE_FEATURES: features, SITE_PDF: pdf };
}

const build = (env: Record<string, string>): RenderedSite => renderSite({ env, now: NOW });
const staging = build(deployEnv('deploy:staging'));
const production = build(deployEnv('deploy:production'));
const plain = build({});

const page = (site: RenderedSite, outPath: string): string => {
  const found = site.pages.find((entry) => entry.outPath === outPath);
  if (!found) throw new Error(`${outPath} is not built`);
  return found.html;
};
const home = (site: RenderedSite): string => page(site, 'index.html');
const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '');

interface Tile {
  id: string;
  href: string;
  chip: string;
  free: boolean;
  search: string;
  name: string;
  description: string;
  label: string;
  shortLabel: string;
  html: string;
}

function tiles(html: string): Tile[] {
  return [...html.matchAll(/<a class="tool-tile" href="([^"]+)" data-tool="([^"]+)" data-chip="([^"]+)"( data-free)? data-search="([^"]*)">([\s\S]*?)<\/a>/g)].map((match) => {
    const inner = match[6] ?? '';
    const part = (pattern: RegExp): string => stripTags(pattern.exec(inner)?.[1] ?? '');
    return {
      href: match[1] ?? '',
      id: match[2] ?? '',
      chip: match[3] ?? '',
      free: match[4] !== undefined,
      search: match[5] ?? '',
      name: part(/<span class="tool-name">(?:<span class="tn-full">)?([^<]*)/),
      description: part(/<span class="tool-desc">([^<]*)<\/span>/),
      label: part(/<span class="tl-full">(.*?)<\/span><span class="tl-short"/),
      shortLabel: part(/<span class="tl-short" aria-hidden="true">(.*?)<\/span><\/span>$/),
      html: match[0],
    };
  });
}

const ids = (site: RenderedSite): string[] => tiles(home(site)).map((tile) => tile.id);
/** The pages a tile stands for: the page it links to and the other pages of the same tool (Tool.pages). */
const tilePages = (tile: Tile): string[] => [toolPagePath(tile.href), ...(TOOLS.find((tool) => tool.id === tile.id)?.pages ?? [])];
const featuresOf = (site: RenderedSite): Feature[] => FEATURES.filter((feature) => site.features[feature]);
const LABEL_TEXTS = Object.values(TOOL_LABELS).map((label) => label.text);

describe('the tool catalogue', () => {
  it('has well-formed entries: unique ids, known columns, labels and icons, short names and one-line descriptions', () => {
    expect(new Set(TOOLS.map((tool) => tool.id)).size).toBe(TOOLS.length);
    for (const tool of TOOLS) {
      expect(tool.id, tool.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(TOOL_CATEGORIES.map((category) => category.id), tool.id).toContain(tool.category);
      expect(Object.keys(TOOL_LABELS), tool.id).toContain(tool.label);
      expect(Object.keys(TOOL_ICONS), tool.id).toContain(tool.icon);
      expect(tool.name.length, tool.id).toBeLessThanOrEqual(22);
      // One line of a column at 1366 px, measured in a browser for the entries of today; 28 characters is the rule of the file's header.
      expect(tool.description.length, tool.id).toBeLessThanOrEqual(28);
      expect(tool.description, tool.id).not.toMatch(/[.!]$|\d/);
      if (tool.short !== undefined) expect(tool.short.length, tool.id).toBeLessThan(tool.name.length);
      expect((tool.short ?? tool.name).length, `${tool.id}: the name on phones`).toBeLessThanOrEqual(16);
      expect(tool.href, tool.id).toMatch(/^\/(#[a-z-]+|(tools|docs)\/[a-z0-9-]+)$/);
      for (const feature of tool.features) expect(FEATURES, tool.id).toContain(feature);
      expect(tool.keywords, tool.id).toBe(tool.keywords.toLowerCase().trim());
    }
    for (const category of TOOL_CATEGORIES) expect(TOOL_CHIPS.map((chip) => chip.id), category.id).toContain(category.chip);
  });

  it('draws every icon from plain shapes: no image, no text, nothing loaded, nothing that is a logo file', () => {
    for (const [id, svg] of Object.entries(TOOL_ICONS)) {
      expect(svg, id).toMatch(/^(<(rect|path|circle)\b[^>]*\/>)+$/);
      expect(svg, id).not.toMatch(/href|url\(|<image|<text|<use|style=/);
      for (const name of svg.matchAll(/class="([^"]+)"/g)) expect((name[1] ?? '').split(' ').every((part) => ['a', 'af', 'k'].includes(part)), id).toBe(true);
    }
    // One pictogram per tool: no two tools share one.
    expect(new Set(TOOLS.map((tool) => tool.icon)).size).toBe(TOOLS.length);
  });
});

describe('the home page with every feature of the staging build', () => {
  const html = home(staging);
  const all = tiles(html);

  it('lists every tool of the catalogue once, in the catalogue order of each column', () => {
    expect(featuresOf(staging)).toEqual([...FEATURES]);
    expect(all.map((tile) => tile.id).sort()).toEqual(TOOLS.map((tool) => tool.id).sort());
    for (const category of TOOL_CATEGORIES) {
      const column = new RegExp(`<section class="tool-col" data-col="${category.id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1] ?? '';
      expect(tiles(column).map((tile) => tile.id), category.id).toEqual(TOOLS.filter((tool) => tool.category === category.id).map((tool) => tool.id));
    }
  });

  it('has exactly one tile for every built page under /tools/', () => {
    const toolPages = staging.pages.filter((entry) => entry.url.startsWith('/tools/')).map((entry) => entry.url);
    expect(toolPages.length).toBeGreaterThanOrEqual(11);
    for (const url of toolPages) expect(all.filter((tile) => tilePages(tile).includes(url)), url).toHaveLength(1);
  });

  it('prints each tile as one link with an icon, a name, a one-line description and a label from the allowed set', () => {
    for (const tile of all) {
      const tool = TOOLS.find((entry) => entry.id === tile.id) as Tool;
      expect(tile.name, tile.id).toBe(tool.name);
      expect(tile.description, tile.id).toBe(tool.description);
      expect(LABEL_TEXTS, tile.id).toContain(tile.label);
      expect(tile.label, tile.id).toBe(TOOL_LABELS[tool.label].text);
      expect(tile.shortLabel, tile.id).toBe(TOOL_LABELS[tool.label].short);
      expect(tile.free, tile.id).toBe(TOOL_LABELS[tool.label].free);
      expect(tile.html.match(/<svg class="tool-ico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">/g), tile.id).toHaveLength(1);
      expect(tile.html, tile.id).not.toMatch(/<img|<a [\s\S]*<a /);
      if (tool.short !== undefined) expect(tile.html, tile.id).toContain(`<span class="tn-short" aria-hidden="true">${tool.short}</span>`);
    }
    // The three labels are all in use, so the legend explains nothing that is not on the page.
    expect(new Set(all.map((tile) => tile.label))).toEqual(new Set(LABEL_TEXTS));
  });

  it('counts the tiles on the column headings and the chips', () => {
    const headings = [...html.matchAll(/<h2 class="tool-col-head" id="tools-([a-z-]+)"><span class="tool-col-name">([^<]+)<\/span> <span class="tool-col-count">(\d+)</g)];
    expect(headings.map((match) => match[1])).toEqual(TOOL_CATEGORIES.map((category) => category.id));
    for (const [, id, , count] of headings) expect(Number(count), id).toBe(TOOLS.filter((tool) => tool.category === id).length);
    const chips = Object.fromEntries([...html.matchAll(/<button class="tool-chip" type="button" data-filter="([a-z]+)" aria-pressed="(true|false)" disabled>([^<]+) <span class="tool-chip-n">(\d+)</g)].map((match) => [match[1], { pressed: match[2], title: match[3], count: Number(match[4]) }]));
    expect(Object.keys(chips)).toEqual(['all', ...TOOL_CHIPS.map((chip) => chip.id), 'free']);
    expect(chips.all).toEqual({ pressed: 'true', title: 'All', count: all.length });
    for (const chip of TOOL_CHIPS) expect(chips[chip.id], chip.id).toEqual({ pressed: 'false', title: chip.title, count: all.filter((tile) => tile.chip === chip.id).length });
    expect(chips.free).toEqual({ pressed: 'false', title: 'Free only', count: all.filter((tile) => tile.free).length });
    expect(TOOL_CHIPS.reduce((sum, chip) => sum + (chips[chip.id]?.count ?? 0), 0)).toBe(all.length);
  });

  it('agrees with the /tools hub: everything listed there as free has a tile that says it has a free page', () => {
    const hub = page(staging, 'tools.html');
    const main = hub.slice(hub.indexOf('<main'), hub.indexOf('</main>'));
    const listed = [...main.matchAll(/<dt><a href="([^"]+)">/g)].map((match) => match[1] ?? '');
    expect(listed.length).toBeGreaterThanOrEqual(12);
    for (const href of listed) {
      const tile = all.find((entry) => entry.href === href || tilePages(entry).includes(href));
      expect(tile, href).toBeDefined();
      expect(tile?.free, href).toBe(true);
    }
  });
});

describe('every build', () => {
  const builds: Array<[string, RenderedSite]> = [
    ['staging', staging],
    ['production', production],
    ['no feature', plain],
    ...['pdf', 'pdf,batch', 'pdf,toolkit', 'linkcards', 'email', 'previews', 'integrations', 'apidocs', 'localpdf,apidocs', 'localpdf,toolkit,pdf', 'charts'].map(
      (features): [string, RenderedSite] => [features, build({ SITE_FEATURES: features })],
    ),
  ];

  it('links each tile to a page the build publishes as launched, or to an anchor the home page has', () => {
    for (const [name, site] of builds) {
      const html = home(site);
      for (const tile of tiles(html)) {
        const [path, anchor] = tile.href.split('#') as [string, string | undefined];
        const target = site.pages.find((entry) => entry.url === path);
        expect(target, `${name}: ${tile.href}`).toBeDefined();
        // Indexed means launched: a docs page published only with its "not switched on yet" notice is noindex.
        expect(target?.indexed, `${name}: ${tile.href}`).toBe(true);
        expect(target?.html, `${name}: ${tile.href}`).not.toContain('Not switched on yet');
        if (anchor !== undefined) expect(target?.html, `${name}: ${tile.href}`).toContain(` id="${anchor}"`);
      }
    }
  });

  it('has a tile for a tool exactly when its features are on, and one tile for every built /tools/ page', () => {
    for (const [name, site] of builds) {
      const expected = TOOLS.filter((tool) => tool.features.every((feature) => site.features[feature])).map((tool) => tool.id);
      expect(ids(site).sort(), name).toEqual(expected.sort());
      for (const entry of site.pages.filter((built) => built.url.startsWith('/tools/'))) {
        expect(tiles(home(site)).filter((tile) => tilePages(tile).includes(entry.url)), `${name}: ${entry.url}`).toHaveLength(1);
      }
    }
  });

  it('prints no empty column and no chip without tiles, and counts what it prints', () => {
    for (const [name, site] of builds) {
      const html = home(site);
      const all = tiles(html);
      const columns = [...html.matchAll(/<section class="tool-col" data-col="([a-z-]+)" data-chip="([a-z]+)"[^>]*>([\s\S]*?)<\/section>/g)];
      expect(html, name).toContain(`<div class="tool-grid tool-grid-${columns.length}" id="tool-grid">`);
      let seen = 0;
      for (const [, id, , inner] of columns) {
        const count = tiles(inner ?? '').length;
        expect(count, `${name}: ${id}`).toBeGreaterThan(0);
        expect(inner, `${name}: ${id}`).toContain(`<span class="tool-col-count">${count}<span class="visually-hidden"> ${count === 1 ? 'tool' : 'tools'}</span></span>`);
        seen += count;
      }
      expect(seen, name).toBe(all.length);
      expect(html, name).toContain(`data-filter="all" aria-pressed="true" disabled>All <span class="tool-chip-n">${all.length}<`);
      for (const [, , count] of html.matchAll(/data-filter="([a-z]+)"[^>]*>[^<]+<span class="tool-chip-n">(\d+)/g)) expect(Number(count), name).toBeGreaterThan(0);
    }
  });

  it('keeps one h1, an h2 for each column, and the sections of the old home page with their ids, in order', () => {
    for (const [name, site] of builds) {
      const html = home(site);
      const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => stripTags(match[1] ?? ''));
      expect(h1, name).toEqual(['Every tool, one click away.']);
      expect(html.match(/<h2 class="tool-col-head"/g)?.length, name).toBe(html.match(/<section class="tool-col"/g)?.length);
      // The old headline is still there, one level down, and so is every block other pages link to.
      expect(html, name).toContain('<h2>Turn every link into a <em>beautiful</em> share card.</h2>');
      const sectionIds = [...html.slice(html.indexOf('<main'), html.indexOf('</main>')).matchAll(/<(?:section|div)[^>]* id="([a-z-]+)"/g)].map((match) => match[1]);
      const kept = ['tools', 'playground', 'meta-tag', 'how-it-works', 'templates', 'pricing', 'counting', 'faq', 'contact'];
      expect(sectionIds.filter((id) => kept.includes(id ?? '')), name).toEqual(kept);
      expect(html.indexOf('id="tool-grid"'), name).toBeLessThan(html.indexOf('id="playground"'));
    }
  });
});

describe('the home page of the production build', () => {
  const html = home(production);

  it('is built with the features of package.json "deploy:production"', () => {
    expect(featuresOf(production)).toEqual(['previews', 'localpdf', 'apidocs']);
  });

  it('lists only what production publishes: the checkers, the card builder, the two in-browser PDF tools, the API and signed URLs', () => {
    expect(ids(production)).toEqual([
      'og-checker',
      'x-card-validator',
      'linkedin-post-preview',
      'slack-link-preview',
      'discord-embed-preview',
      'whatsapp-link-preview',
      'card-builder',
      'merge-pdf',
      'image-to-pdf',
      'api',
      'signed-urls',
    ]);
    expect([...html.matchAll(/<section class="tool-col" data-col="([a-z-]+)"/g)].map((match) => match[1])).toEqual(['previews', 'images', 'pdf-files', 'automation']);
  });

  it('has no tile for a tool whose feature is off, although "apidocs" publishes that tool\'s docs page with its notice', () => {
    const off = TOOLS.filter((tool) => !tool.features.every((feature) => production.features[feature]));
    expect(off.map((tool) => tool.id).sort()).toEqual(['bulk-documents', 'certificate-generator', 'chart-images', 'email-images', 'html-to-pdf', 'invoice-generator', 'link-cards', 'pdf-toolkit', 'workflows']);
    for (const tool of off) {
      expect(html, tool.id).not.toContain(`data-tool="${tool.id}"`);
      expect(html.slice(html.indexOf('id="tool-grid"'), html.indexOf('id="tool-status"')), tool.id).not.toContain(`href="${tool.href}"`);
    }
    // The four docs pages are built there, under their notice: a tile would present a switched-off API as available.
    for (const path of ['/docs/bulk', '/docs/pdf-tools', '/docs/link-cards', '/docs/email-images']) {
      const docs = production.pages.find((entry) => entry.url === path);
      expect(docs?.html, path).toContain('Not switched on yet');
      expect(docs?.indexed, path).toBe(false);
    }
    expect(production.pages.some((entry) => entry.url === '/docs/integrations')).toBe(false);
  });

  it('would drop a tile whose page is missing, even with its feature on', () => {
    const everything = Object.fromEntries(FEATURES.map((feature) => [feature, true]));
    const launched = new Set(staging.pages.filter((entry) => entry.indexed).map((entry) => entry.url));
    expect(publishedTools(everything, launched).length).toBe(TOOLS.length);
    launched.delete('/docs/bulk');
    expect(publishedTools(everything, launched).map((tool) => tool.id)).not.toContain('bulk-documents');
    expect(publishedTools(everything, new Set()).length).toBe(0);
  });
});

describe('the top of the home page', () => {
  const source = read('site/pages/index.html');
  const html = home(staging);

  it('explains the labels in a legend with the plan numbers as tokens, never typed', () => {
    const top = source.slice(source.indexOf('<section class="tools"'), source.indexOf('<section class="hero">'));
    // No typed number anywhere in the visible text above the grid.
    expect(stripTags(top)).not.toMatch(/\d/);
    const legends = [...top.matchAll(/<p class="tools-legend [a-z-]+">(.*)<\/p>/g)].map((match) => match[1] ?? '');
    expect(legends).toHaveLength(2);
    for (const legend of legends) {
      for (const id of Object.keys(TOOL_LABELS)) expect(legend).toContain(`[[> tool-label-${id}]]`);
      expect(legend).toContain('[[plan.free.images]]');
      expect(legend).toContain('[[plan.free.name]]');
    }
    const built = stripTags(/<p class="tools-legend tools-legend-wide">(.*?)<\/p>/.exec(html)?.[1] ?? '').replace(/\s+/g, ' ');
    expect(built).toBe(
      `FreeF No account, no cost. CreditsC Needs an account and uses the images of your plan: ${PLANS.free.name} includes ${formatCount(PLANS.free.monthlyImages)} a month. Free + creditsF+C A free page, plus an API that uses credits.`,
    );
  });

  it('prints the search box and the chips switched off, for the script to switch on, and hides them where scripts cannot run', () => {
    expect(html).toMatch(/<input class="input" id="tool-q" type="text"[^>]* aria-controls="tool-grid"[^>]* disabled>/);
    expect(html).toContain('<label class="visually-hidden" for="tool-q">Search the tools</label>');
    const chips = html.match(/<button class="tool-chip"[^>]*>/g) ?? [];
    expect(chips.length).toBeGreaterThan(2);
    for (const chip of chips) expect(chip).toMatch(/ aria-pressed="(true|false)" disabled>$/);
    expect(html).toContain('<p class="visually-hidden" id="tool-status" role="status"></p>');
    expect(html).toMatch(/<div class="tools-empty" id="tool-empty" hidden>/);
    const css = read('site/public/assets/css/site.css');
    expect(css).toMatch(/@media \(scripting: none\) \{\s*\.tools-search, \.tool-chips \{ display: none; \}/);
    expect(css).toContain('13 Home tools');
  });

  it('loads its script as a small file of its own and has no inline script, as the Content-Security-Policy requires', () => {
    expect(source).toMatch(/^scripts: playground, pricing, tool-finder$/m);
    expect(html).toContain('<script type="module" src="/assets/js/tool-finder.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(read('site/public/_headers')).toMatch(/script-src 'self' /);
    expect(statSync(join(ROOT, 'site/public/assets/js/tool-finder.js')).size).toBeLessThan(3584);
    expect(html.slice(html.indexOf('<section class="tools"'), html.indexOf('<section class="hero">'))).not.toMatch(/ style="|<img/);
  });

  it('says in its title and description what the page leads with, in every build', () => {
    for (const site of [staging, production, plain]) {
      const built = home(site);
      expect(built).toContain('<title>Link To Card - Every tool for share cards and link previews</title>');
      const description = /<meta name="description" content="([^"]*)">/.exec(built)?.[1] ?? '';
      expect(description).toMatch(/^Every Link To Card tool on one page\. /);
      // PDF files are named only where the in-browser PDF tools are published.
      expect(description.includes('PDF')).toBe(site.features.localpdf);
      expect(ids(site).some((id) => id === 'merge-pdf')).toBe(site.features.localpdf);
    }
  });
});

describe('tool-finder.js', () => {
  type Finder = {
    searchWords(text: string): string[];
    matches(tile: { chip: string; free: boolean; search: string }, state: { chip: string; free: boolean; words: string[] }): boolean;
    statusText(shown: number, total: number): string;
  };
  const load = async (): Promise<Finder> => (await import(pathToFileURL(join(ROOT, 'site/public/assets/js/tool-finder.js')).href)) as Finder;
  const all = tiles(home(staging));
  const found = (finder: Finder, query: string, chip = 'all', free = false): string[] =>
    all.filter((tile) => finder.matches(tile, { chip, free, words: finder.searchWords(query) })).map((tile) => tile.id);

  it('finds a tool by its name, its short name, its description and its keywords', async () => {
    const finder = await load();
    for (const tool of TOOLS) {
      expect(found(finder, tool.name), tool.name).toContain(tool.id);
      expect(found(finder, tool.description), tool.description).toContain(tool.id);
      if (tool.short !== undefined) expect(found(finder, tool.short), tool.short).toContain(tool.id);
      expect(found(finder, tool.keywords.split(' ')[0] ?? ''), tool.id).toContain(tool.id);
    }
    expect(found(finder, '  JOIN   pdfs ')).toEqual(['merge-pdf']);
    expect(found(finder, 'merge pdf')).toEqual(['merge-pdf', 'pdf-toolkit', 'bulk-documents']);
    expect(found(finder, 'twitter')).toEqual(['og-checker', 'x-card-validator', 'card-builder']);
    expect(found(finder, 'a link’s look')).toEqual(found(finder, "a link's look"));
    expect(found(finder, 'zapier, make')).toEqual(['workflows']);
    expect(found(finder, 'no such tool')).toEqual([]);
    expect(found(finder, '')).toHaveLength(all.length);
  });

  it('filters by chip and by "Free only", together with the words', async () => {
    const finder = await load();
    expect(found(finder, '', 'pdf')).toEqual(TOOLS.filter((tool) => tool.category.startsWith('pdf-')).map((tool) => tool.id));
    expect(found(finder, '', 'all', true)).toEqual(TOOLS.filter((tool) => TOOL_LABELS[tool.label].free).map((tool) => tool.id));
    expect(found(finder, '', 'automation', true)).toEqual([]);
    expect(found(finder, 'invoice', 'pdf', true)).toEqual(['invoice-generator']);
  });

  it('words the live region for all, some and none', async () => {
    const { statusText } = await load();
    expect(statusText(19, 19)).toBe('All 19 tools shown.');
    expect(statusText(7, 19)).toBe('7 of 19 tools shown.');
    expect(statusText(0, 19)).toBe('No tool matches.');
  });
});
