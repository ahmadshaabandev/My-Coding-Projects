// The build v3 docs pages (bulk, pdf-tools, link-cards, integrations) and the OpenAPI description of
// their endpoints. The pages are published behind their site features (they were drafts until the
// merge; a .md.draft is still read if one comes back), so this test reads the files itself instead
// of building the site, and checks what the build would not:
//   - front matter, feature names and feature blocks;
//   - every [[token]] exists (scripts/v3-site-tokens.ts or build-site.ts) and every number comes
//     from one: no number of src/config.ts or src/billing/plans.ts is typed into the prose;
//   - every request, field, default and enum the pages list is the one the code implements;
//   - the signed link example verifies with the server's own verifier, and its signer prints it;
//   - every link and anchor exists, every JSON example parses;
//   - the integrations page never says that a connector is published;
//   - the OpenAPI fragment describes every new path, refers only to components that exist, gives
//     each error code its own status and states the configured limits.
// Module sources that cannot be imported here (they pull Worker-only types) are read as text, as
// tests/node/docs.test.ts does for BASE_CSS.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER, TOPUP } from '../../src/billing/plans';
import { BATCH, EMAIL_FIELDS, HTTP_CACHE, INSPECT, LIMITS, LINK_CARDS, PDF, PDF_TOOLKIT, RATE_LIMITS, pdfToolkitUnits } from '../../src/config';
import { ERROR_STATUS } from '../../src/lib/errors';
import { canonicalString, verifySignedUrl } from '../../src/lib/signed-url';
import { PDF_TEMPLATES, PDF_TEMPLATE_IDS } from '../../src/pdf/templates';
import { IMAGE_FITS, IMAGE_ORIENTATIONS, IMAGE_PAGE_SIZES } from '../../src/pdftools/from-images';
import { PERMISSION_FLAGS } from '../../src/pdftools/protect';
import { STAMP_FONTS } from '../../src/pdftools/text';
import { STARTER_TEMPLATE_IDS } from '../../src/render/templates';
import { FEATURES, listTokens, renderSite, type RenderedSite } from '../../scripts/build-site';
import { PENDING_CONFIG_TOKENS, v3SiteTokens } from '../../scripts/v3-site-tokens';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-26T12:00:00Z');
const MB = 1024 * 1024;
const GB = 1024 * MB;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/* ------------------------------------------------------------------ */
/* The drafts                                                          */
/* ------------------------------------------------------------------ */

interface Draft {
  name: 'bulk' | 'pdf-tools' | 'link-cards' | 'integrations';
  /** The site feature that publishes the page (scripts/build-site.ts FEATURES). */
  feature: string;
  nav: string;
}

const DRAFTS: readonly Draft[] = [
  { name: 'bulk', feature: 'batch', nav: 'Bulk documents' },
  { name: 'pdf-tools', feature: 'toolkit', nav: 'PDF toolkit' },
  { name: 'link-cards', feature: 'linkcards', nav: 'Cards from links' },
  { name: 'integrations', feature: 'integrations', nav: 'Zapier, Make and n8n' },
];

/** The site features of build v3 (contract: pdf, batch, toolkit, linkcards, email, previews), plus integrations for the connectors page. */
const KNOWN_FEATURES = ['pdf', 'batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations'];

/** The page as published (.md) once renamed, the draft (.md.draft) before. */
function draftFile(name: Draft['name']): string {
  const published = `site/content/docs/${name}.md`;
  return existsSync(join(ROOT, published)) ? published : `${published}.draft`;
}

const source = (name: Draft['name']): string => read(draftFile(name));

function frontMatter(text: string, file: string): { data: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${file}: no front matter`);
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const value = line.slice(colon + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    data[line.slice(0, colon).trim()] = quoted ? (quoted[2] ?? '') : value;
  }
  return { data, body: text.slice(match[0].length) };
}

const body = (name: Draft['name']): string => frontMatter(source(name), name).body;

/** Fenced code blocks with their language, in document order. */
const codeBlocks = (markdown: string, lang?: string): string[] =>
  [...markdown.matchAll(/^```([\w-]*)\n([\s\S]*?)^```$/gm)].filter((match) => lang === undefined || match[1] === lang).map((match) => match[2] ?? '');

const withoutCode = (markdown: string): string => markdown.replace(/^```[\w-]*\n[\s\S]*?^```$/gm, '');

/** Markdown section under a heading, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const level = heading.indexOf(' ');
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line) && line.indexOf(' ') <= level);
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** Rows of the first Markdown table in `markdown`, as cells without the surrounding pipes. */
function tableRows(markdown: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^\|.*\|$/.test(line));
  if (start < 0) throw new Error('no table');
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (/^<!--.*-->$/.test(line.trim())) continue;
    if (!/^\|.*\|$/.test(line)) break;
    rows.push(line.slice(1, -1).split(' | ').map((cell) => cell.trim()));
  }
  return rows;
}

/** `code` spans of a table cell or a line. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');

/** The heading ids marked would give the headings of a Markdown file (scripts/build-site.ts slugify). */
function headingIds(markdown: string): Set<string> {
  const used = new Map<string, number>();
  const ids = new Set<string>();
  for (const match of withoutCode(markdown).matchAll(/^#{1,6} (.+)$/gm)) {
    const text = (match[1] ?? '').replace(/`/g, '');
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    ids.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const TOKEN_RE = /(\\?)\[\[(?:>\s*([a-z][a-z0-9-]*)\s*|([a-zA-Z][\w.]*))\]\]/g;
const PENDING_VALUE = '\u0000pending\u0000';

let tokens: Record<string, string>;
let partials: string[];
beforeAll(() => {
  const listing = listTokens({ env: {}, now: NOW });
  tokens = { ...listing.tokens, ...v3SiteTokens() };
  partials = listing.partials;
});

/** The text with every token replaced by its value and every partial removed, as a reader would see the numbers. */
function expandTokens(text: string): string {
  return text.replace(TOKEN_RE, (match: string, escaped: string, partial?: string, name?: string) => {
    if (escaped) return match.slice(1);
    if (partial !== undefined) return '';
    return tokens[name ?? ''] ?? (Object.hasOwn(PENDING_CONFIG_TOKENS, name ?? '') ? PENDING_VALUE : match);
  });
}

/* ------------------------------------------------------------------ */
/* Module sources read as text                                         */
/* ------------------------------------------------------------------ */

/** A `const NAME ... = [ 'a', 'b' ]` string list from a source file. */
function stringList(file: string, name: string): string[] {
  const literal = new RegExp(`(?:const|let) ${name}\\b[^=]*= \\[([^\\]]*)\\]`).exec(read(file))?.[1];
  if (literal === undefined) throw new Error(`${file} no longer declares ${name} as a list literal`);
  return [...literal.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

/** OP_FIELDS of src/pdftools/request.ts, with ...LAYOUT expanded. */
function toolkitOpFields(): Record<string, string[]> {
  const file = 'src/pdftools/request.ts';
  const text = read(file);
  const layout = stringList(file, 'LAYOUT');
  const block = /const OP_FIELDS[^{]*\{([\s\S]*?)\n\};/.exec(text)?.[1];
  if (!block) throw new Error(`${file} no longer declares OP_FIELDS`);
  const fields: Record<string, string[]> = {};
  for (const match of block.matchAll(/^\s+'?([a-z-]+)'?: \[([^\]]*)\],?$/gm)) {
    const list = match[2] ?? '';
    fields[match[1] ?? ''] = [...[...list.matchAll(/'([^']*)'/g)].map((item) => item[1] ?? ''), ...(list.includes('...LAYOUT') ? layout : [])];
  }
  return fields;
}

/** STAMP_POSITIONS and the stamp DEFAULTS of src/pdftools/stamp.ts (it imports src/lib/http.ts, which needs Worker types). */
function stampSource(): { positions: string[]; defaults: Record<string, string> } {
  const file = 'src/pdftools/stamp.ts';
  const text = read(file);
  const positions = /export const STAMP_POSITIONS = \[([^\]]*)\]/.exec(text)?.[1];
  const defaults = /const DEFAULTS = \{([^}]*)\}/.exec(text)?.[1];
  if (!positions || !defaults) throw new Error(`${file} no longer declares STAMP_POSITIONS and DEFAULTS as literals`);
  const values: Record<string, string> = {};
  for (const match of defaults.matchAll(/(\w+): '?([^,']+)'?(?: as \w+)?/g)) values[match[1] ?? ''] = (match[2] ?? '').trim();
  return { positions: [...positions.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? ''), defaults: values };
}

/** LINK_DATA_SOURCES of src/cards/from-url.ts (it imports the card renderer). */
function linkDataSources(): Record<string, string> {
  const file = 'src/cards/from-url.ts';
  const block = /export const LINK_DATA_SOURCES[^{]*\{([\s\S]*?)\n\};/.exec(read(file))?.[1];
  if (!block) throw new Error(`${file} no longer declares LINK_DATA_SOURCES`);
  const sources: Record<string, string> = {};
  for (const match of block.matchAll(/^\s+(\w+): (['"])(.*)\2,$/gm)) sources[match[1] ?? ''] = match[3] ?? '';
  return sources;
}

/** Field names of an `export interface Name { ... }` (one property per line). */
function interfaceFields(file: string, name: string): string[] {
  const block = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(read(file))?.[1];
  if (!block) throw new Error(`${file} no longer declares interface ${name}`);
  return [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1] ?? '');
}

/* ------------------------------------------------------------------ */
/* Config numbers                                                      */
/* ------------------------------------------------------------------ */

/** Every number of the configuration, in each unit a page could print it in (KB, MB, seconds, minutes, hours, days). */
function configNumbers(): Set<number> {
  const numbers = new Set<number>();
  const add = (value: number): void => {
    numbers.add(value);
    for (const unit of [1024, MB]) if (value % (unit / 2) === 0 && value >= unit) numbers.add(value / unit);
    for (const unit of [1000, 60_000, 3_600_000, 86_400_000]) if (value % unit === 0 && value >= unit) numbers.add(value / unit);
    if (value % 86_400 === 0 && value >= 86_400) numbers.add(value / 86_400);
    if (value % 1_000_000 === 0 && value >= 1_000_000) numbers.add(value / 1_000_000);
  };
  const walk = (value: unknown): void => {
    if (typeof value === 'number') add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk([BATCH, PDF_TOOLKIT, LINK_CARDS, EMAIL_FIELDS, INSPECT, PDF, LIMITS, HTTP_CACHE, RATE_LIMITS, TOPUP, PLANS]);
  // 0 and 1 are words of every sentence ("1 image", "at least one"), not limits.
  for (const trivial of [0, 1]) numbers.delete(trivial);
  return numbers;
}

/** HTTP statuses, printed as statuses ("answers 409 `conflict`", "| 413 |"), are not config numbers. */
const STATUS_AS_STATUS = /\b([1-5]\d\d)(?=\s*(?:`|\|))|\bHTTP ([1-5]\d\d)\b/g;

/**
 * Numbers the prose may type that happen to equal a config number but are not one, each with why.
 * Keep this short: a limit belongs in a token.
 */
const NOT_CONFIG: ReadonlyArray<{ file: Draft['name']; text: string; why: string }> = [];

/**
 * The prose of a page as the numbers check sees it: the description and the body, without code,
 * tokens, HTML tags, link targets and the numbers of ordered lists.
 */
function prose(page: string): string {
  const { data, body: markdown } = frontMatter(page, 'page');
  return `${data.description ?? ''}\n${withoutCode(markdown)}`
    .replace(/^\s*\d+\. /gm, ' ')
    .replace(STATUS_AS_STATUS, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(TOKEN_RE, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ');
}

/* ------------------------------------------------------------------ */
/* Pages and front matter                                              */
/* ------------------------------------------------------------------ */

describe('the v3 docs pages', () => {
  it('have the front matter of a docs page, each behind its own feature, in a free place of the docs order', () => {
    const existing = readdirSync(join(ROOT, 'site/content/docs'))
      .filter((file) => file.endsWith('.md'))
      .map((file) => `site/content/docs/${file}`)
      .concat('site/content/docs.md')
      .filter((file) => !DRAFTS.some((draft) => draftFile(draft.name) === file))
      .map((file) => Number(frontMatter(read(file), file).data.order));
    const orders = new Set(existing);
    for (const draft of DRAFTS) {
      const { data } = frontMatter(source(draft.name), draft.name);
      expect(Object.keys(data).sort(), draft.name).toEqual(['description', 'feature', 'layout', 'nav', 'order', 'title']);
      expect(data.layout, draft.name).toBe('doc');
      expect(data.feature, draft.name).toBe(draft.feature);
      expect(data.nav, draft.name).toBe(draft.nav);
      expect(data.title, draft.name).not.toBe('');
      expect(data.description?.length, draft.name).toBeGreaterThan(80);
      expect(data.description, draft.name).not.toMatch(TOKEN_RE);
      const order = Number(data.order);
      expect(Number.isFinite(order), draft.name).toBe(true);
      expect(orders.has(order), `${draft.name}: order ${order} is taken`).toBe(false);
      orders.add(order);
    }
  });

  it('use only tokens and partials that exist, or that wait for a named config value', () => {
    const used = new Set<string>();
    for (const draft of DRAFTS) {
      for (const match of source(draft.name).matchAll(TOKEN_RE)) {
        if (match[1]) continue;
        if (match[2] !== undefined) {
          expect(partials, `${draft.name}: [[> ${match[2]}]]`).toContain(match[2]);
          continue;
        }
        const name = match[3] ?? '';
        used.add(name);
        expect(Object.hasOwn(tokens, name) || Object.hasOwn(PENDING_CONFIG_TOKENS, name), `${draft.name}: unknown token [[${name}]]`).toBe(true);
      }
    }
    // A pending token is listed only while its config value is missing, and only if a page uses it.
    for (const name of Object.keys(PENDING_CONFIG_TOKENS)) expect(used.has(name), `${name} is pending but unused`).toBe(true);
  });

  it('have balanced feature blocks of known features', () => {
    for (const draft of DRAFTS) {
      let open: string | null = null;
      for (const match of source(draft.name).matchAll(/<!--[ \t]*(\/?)feature:([a-z][a-z0-9-]*)[ \t]*-->/g)) {
        const name = match[2] ?? '';
        expect(KNOWN_FEATURES, `${draft.name}: feature:${name}`).toContain(name.replace(/^no-/, ''));
        if (match[1] === '/') {
          expect(open, `${draft.name}: /feature:${name}`).toBe(name);
          open = null;
        } else {
          expect(open, `${draft.name}: feature:${name} inside feature:${open}`).toBeNull();
          open = name;
        }
      }
      expect(open, draft.name).toBeNull();
      // Anything else that looks like a marker would stop the build.
      expect(source(draft.name).replace(/<!--[ \t]*\/?feature:[a-z][a-z0-9-]*[ \t]*-->/g, ''), draft.name).not.toMatch(/<!--[^>]*?\bfeature\s*:/);
    }
  });

  it('type no number of the configuration: every limit, price and duration is a token', () => {
    const numbers = configNumbers();
    for (const draft of DRAFTS) {
      let text = prose(source(draft.name));
      for (const allowed of NOT_CONFIG.filter((entry) => entry.file === draft.name)) text = text.replace(allowed.text, ' ');
      const typed = [...text.matchAll(/(?<![\w#.\-/:@])(\d+(?:[.,]\d+)*)(?![\w])/g)]
        .map((match) => ({ raw: match[1] ?? '', value: Number((match[1] ?? '').replace(/,/g, '')) }))
        .filter(({ value }) => numbers.has(value));
      expect(typed.map(({ raw }) => raw), `${draft.name} types config numbers; use a token`).toEqual([]);
    }
  });

  it('print no price, no other payment provider, no placeholder and no local address', () => {
    for (const draft of DRAFTS) {
      const text = source(draft.name);
      expect(text, draft.name).not.toMatch(/\$\d/);
      expect(text, draft.name).not.toMatch(/stripe|lemon\s*squeezy/i);
      expect(text, draft.name).not.toMatch(/\bTODO\b|\bFIXME\b|\bTBD\b/i);
      expect(text, draft.name).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });

  it('have JSON examples and curl bodies that parse once the tokens are filled in', () => {
    for (const draft of DRAFTS) {
      const markdown = expandTokens(body(draft.name));
      for (const block of codeBlocks(markdown, 'json')) expect(() => JSON.parse(block), `${draft.name}: ${block.slice(0, 60)}`).not.toThrow();
      for (const block of codeBlocks(markdown, 'bash')) {
        const data = /-d '([\s\S]*?)'/.exec(block)?.[1];
        if (data !== undefined) expect(() => JSON.parse(data), `${draft.name}: ${data.slice(0, 60)}`).not.toThrow();
      }
    }
  });
});

describe('links of the v3 docs pages', () => {
  let site: RenderedSite;
  beforeAll(() => {
    // Every feature build-site.ts knows, so a page that was a draft (for example /tools/merge-pdf,
    // published under "toolkit" by the client-pdf integration patch) is still found once it is
    // renamed. SITE_FEATURES is ignored by a build-site.ts that only reads SITE_PDF.
    site = renderSite({ env: { SITE_PDF: 'on', SITE_FEATURES: FEATURES.join(',') }, now: NOW });
  });

  /** Pages other build v3 steps add as drafts (site/pages/**.html.draft, site/content/**.md.draft). */
  function draftPages(): Set<string> {
    const found = new Set<string>();
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
        else if (/\.(?:html|md)\.draft$/.test(entry.name)) found.add(`/${prefix}${entry.name.replace(/\.(?:html|md)\.draft$/, '')}`);
      }
    };
    walk('site/pages', '');
    walk('site/content', '');
    return found;
  }

  it('point only to pages and anchors that exist', () => {
    const ownIds = new Map(DRAFTS.map((draft) => [`/docs/${draft.name}`, headingIds(body(draft.name))]));
    const builtUrls = new Map(site.pages.map((page) => [page.url, page.html]));
    const otherDrafts = draftPages();
    for (const draft of DRAFTS) {
      const markdown = withoutCode(body(draft.name));
      const hrefs = [...markdown.matchAll(/\]\(([^)\s]+)\)/g), ...markdown.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? '');
      expect(hrefs.length, draft.name).toBeGreaterThan(0);
      for (const href of hrefs) {
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split('#');
        const target = path === '' ? `/docs/${draft.name}` : (path ?? '');
        if (target === '/openapi.yaml') continue;
        const known = ownIds.has(target) || builtUrls.has(target) || otherDrafts.has(target);
        expect(known, `${draft.name} links to ${href}`).toBe(true);
        if (!anchor) continue;
        if (ownIds.has(target)) expect([...(ownIds.get(target) ?? [])], `${draft.name} links to ${href}`).toContain(anchor);
        else if (builtUrls.has(target)) expect(builtUrls.get(target), `${draft.name} links to ${href}`).toContain(` id="${anchor}"`);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* What the pages say against what the code does                       */
/* ------------------------------------------------------------------ */

describe('/docs/bulk', () => {
  const markdown = body('bulk');

  it('sends rows that the certificate starter template takes, with every required key', () => {
    const certificate = PDF_TEMPLATES.find((template) => template.id === 'certificate');
    if (!certificate) throw new Error('no certificate template');
    const keys = certificate.fields.map((field) => field.key);
    const required = certificate.fields.filter((field) => field.required).map((field) => field.key);
    const request = JSON.parse(/-d '([\s\S]*?)'/.exec(codeBlocks(markdown, 'bash')[0] ?? '')?.[1] ?? '{}') as { template: string; rows: Array<Record<string, string>>; filename: string };
    expect(request.template).toBe('certificate');
    for (const row of request.rows) {
      for (const key of Object.keys(row)) expect(keys, key).toContain(key);
      for (const key of required) expect(Object.keys(row), key).toContain(key);
    }
    expect(request.rows.length).toBeLessThanOrEqual(BATCH.maxRows.free);
    expect(markdown).toContain(`\`${request.filename}\``);
  });

  it('prints certificate ids the issuer can make, and the record exactly as GET /v/{id}.json writes it', () => {
    const pattern = /const ID_RE = (\/\^crt_[^/]+\$\/);/.exec(read('src/batch/certificates.ts'))?.[1];
    if (!pattern) throw new Error('src/batch/certificates.ts no longer declares ID_RE');
    const idRe = new RegExp(pattern.slice(1, -1));
    const ids = [...markdown.matchAll(/crt_[0-9a-z]+/g)].map((match) => match[0]);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(id, id).toMatch(idRe);

    const record = codeBlocks(expandTokens(markdown), 'json').map((block) => JSON.parse(block) as Record<string, unknown>).find((json) => 'disclaimer' in json);
    if (!record) throw new Error('no verification record example');
    expect(Object.keys(record)).toEqual(interfaceFields('src/batch/verify-page.ts', 'VerifyJson'));
    const disclaimer = /export const VERIFY_DISCLAIMER =\s*"([^"]+)";/.exec(read('src/batch/verify-page.ts'))?.[1];
    expect(record.disclaimer).toBe(disclaimer);
    // The page paraphrases the fixed notice; its promise must be the same.
    expect(markdown.replace(/\s+/g, ' ')).toContain("it does not verify the issuer's identity, accreditation or the facts stated");
    const issuer = record.issued_by as { statement: string; email_domain: string };
    expect(issuer.statement).toBe(`Issued by a Link To Card account verified at @${issuer.email_domain}`);
  });

  it('names the statuses the dashboard shows, and no others', () => {
    const finished = stringList('site/public/assets/js/dashboard/bulk-helpers.js', 'FINISHED_STATUSES');
    const batchStatuses = tableRows(section(markdown, '## Progress and results')).map((row) => codeSpans(row[0] ?? '')[0]);
    expect(batchStatuses).toEqual(['queued', 'running', ...finished]);
    const rowLine = section(markdown, '## Progress and results').split('\n').find((line) => line.startsWith("Each row's `status`")) ?? '';
    expect(codeSpans(rowLine.split('. ')[0] ?? '').slice(1)).toEqual(['queued', 'running', 'done', 'failed', 'cancelled']);
    const batches = codeBlocks(expandTokens(markdown), 'json')
      .map((block) => JSON.parse(block) as { id?: string; status?: string; rows?: Array<{ status: string }> })
      .filter((json) => json.id?.startsWith('bat_'));
    expect(batches.length).toBeGreaterThan(1);
    for (const json of batches) {
      expect(['queued', 'running', ...finished]).toContain(json.status);
      for (const row of json.rows ?? []) expect(['queued', 'running', 'done', 'failed', 'cancelled']).toContain(row.status);
    }
  });

  it('uses the not_configured message of the switch, and error codes with their statuses', () => {
    expect(markdown).toContain('"Bulk documents are not enabled yet."');
    expect(read('src/lib/features.ts')).toContain("batch: 'Bulk documents are'");
    for (const row of tableRows(section(markdown, '### Errors'))) {
      const code = codeSpans(row[1] ?? '')[0] as keyof typeof ERROR_STATUS;
      expect(ERROR_STATUS[code], code).toBe(Number(row[0]));
    }
  });

  /** The JSON examples of batches, with the tokens filled in. */
  const batchExamples = (): Array<Record<string, unknown>> =>
    codeBlocks(expandTokens(markdown), 'json')
      .map((block) => JSON.parse(block) as Record<string, unknown>)
      .filter((json) => typeof json.id === 'string' && json.id.startsWith('bat_'));

  it('prints every field batchJson, batchRowJson and the ZIP parts answer, in their order (decision D6)', () => {
    const batchFields = interfaceFields('src/batch/view.ts', 'BatchJson');
    const rowFields = interfaceFields('src/batch/view.ts', 'BatchRowJson');
    const partFields = interfaceFields('src/routes/batches.ts', 'ZipPartJson');
    // singleBatchJson spreads batchJson, replaces zip_url in place and appends zip_parts.
    expect(read('src/routes/batches.ts')).toContain('return { ...json, zip_url: zipUrl(c.env, surface, batch.id), zip_parts: zipPartsJson(c.env, surface, batch.id, parts) };');
    const [created, progress] = batchExamples();
    expect(Object.keys(created ?? {})).toEqual([...batchFields.filter((field) => field !== 'rows'), 'zip_parts']);
    expect(Object.keys(progress ?? {})).toEqual([...batchFields, 'zip_parts']);
    const rows = (progress?.rows ?? []) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(Object.keys(row)).toEqual(rowFields);
    const parts = (progress?.zip_parts ?? []) as Array<Record<string, unknown>>;
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) expect(Object.keys(part)).toEqual(partFields);
    // Every field the reference lists is named on the page.
    const fieldsTable = tableRows(section(markdown, '## Progress and results').slice(section(markdown, '## Progress and results').indexOf('The other fields:')));
    const listed = fieldsTable.flatMap((row) => codeSpans(row[0] ?? ''));
    for (const field of batchFields.filter((name) => !['id', 'status', 'template', 'verify'].includes(name))) expect(listed, field).toContain(field);
    for (const field of rowFields) expect(markdown, field).toContain(`\`${field}\``);
  });

  it('shows a failed row as the code makes it: no certificate, and credits_used null when never charged (decision D5)', () => {
    const view = read('src/batch/view.ts');
    expect(view).toContain("const issued = row.status === 'done' && row.certificateId !== null;");
    const failed = batchExamples().flatMap((json) => (json.rows ?? []) as Array<Record<string, unknown>>).filter((row) => row.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row.certificate_id).toBeNull();
      expect(row.verify_url).toBeNull();
      expect(row.credits_used).toBeNull();
      expect(row.url).toBeNull();
    }
    // The partial example adds up: credits_used and pages are the sums of its done rows.
    const progress = batchExamples().find((json) => json.status === 'partial') ?? {};
    const done = ((progress.rows ?? []) as Array<{ status: string; pages: number; credits_used: number }>).filter((row) => row.status === 'done');
    expect(progress.credits_used).toBe(done.reduce((sum, row) => sum + row.credits_used, 0));
    expect(progress.pages).toBe(done.reduce((sum, row) => sum + row.pages, 0));
  });

  it('names the default file names defaultFilenamePattern makes (decision D4)', () => {
    const rows = read('src/batch/rows.ts');
    expect(rows).toContain("const ROW_NUMBER = 'n';");
    expect(rows).toContain("return `${getPdfTemplate(template) ? template : 'document'}-{{${ROW_NUMBER}}}.pdf`;");
    const names = section(markdown, '## File names');
    for (const name of ['certificate-1.pdf', 'certificate-2.pdf', 'document-1.pdf']) expect(names, name).toContain(`\`${name}\``);
    // The ZIP writer's and the batch's own rule for a repeated name.
    expect(rows).toContain('const suffix = ` (${n}).pdf`;');
    expect(names).toContain('`certificate-Amara Nwosu (2).pdf`');
    expect(markdown).not.toMatch(/named after the template, like `certificate\.pdf`/);
  });

  it('answers too many rows, an unknown template and the active-batch cap as the route does (decisions D1, D2, D3)', () => {
    const errors = new Map(tableRows(section(markdown, '### Errors')).map((row) => [codeSpans(row[1] ?? '')[0] ?? '', row[2] ?? '']));
    expect(errors.get('plan_required')).toMatch(/More rows than your plan takes/);
    expect(errors.get('invalid_request')).toMatch(/more rows than any plan takes/);
    expect(errors.get('not_found')).toMatch(/The template/);
    expect(errors.get('invalid_request')).not.toMatch(/template that does not exist/);
    expect(errors.get('conflict')).toContain('[[batch.maxActive]] batches are already waiting or running');
    expect(read('src/batch/rows.ts')).toContain("if (higher) return new ApiError('plan_required'");
    expect(read('src/routes/batches.ts')).toContain('if (!template) throw pdfTemplateNotFound();');
    expect(read('src/batch/store.ts')).toMatch(/export function activeCapError[^{]*\{\s*return new ApiError\(\s*'conflict'/);
  });

  it('describes ZIP downloads in parts as the route makes them (decision D9)', () => {
    const zip = section(markdown, '## Download as ZIP files');
    expect(zip).toContain('each part at most [[batch.zipPartMaxEntries]] files and [[batch.zipPartMaxGb]] GB');
    expect(tokens['batch.zipPartMaxEntries']).toBe(String(BATCH.zipPartMaxEntries));
    expect(tokens['batch.zipPartMaxGb']).toBe(String(BATCH.zipPartMaxBytes / GB));
    const route = read('src/routes/batches.ts');
    for (const header of ['X-LTC-Zip-Part', 'X-LTC-Zip-Parts', 'Content-Length']) {
      expect(zip, header).toContain(`\`${header}\``);
      expect(route, header).toContain(`'${header.toLowerCase()}'`);
    }
    expect(zip).toContain('`details.parts`');
    expect(route).toContain('{ details: { parts: parts.length } }');
    expect(route).toContain('`${batchId}-part-${part}-of-${parts}.zip`');
    expect(zip).toContain('`bat_...-part-2-of-3.zip`');
    // Every part URL of the examples is the zip URL with ?part=N, from 1.
    for (const json of batchExamples()) {
      for (const [i, part] of ((json.zip_parts ?? []) as Array<{ part: number; url: string }>).entries()) {
        expect(part.part).toBe(i + 1);
        expect(part.url).toBe(`${json.zip_url}?part=${part.part}`);
      }
    }
  });

  it('documents the listing with the limits of the route', () => {
    const list = section(markdown, '## List your batches');
    expect(list).toContain('from 1 to [[batch.listMaxLimit]] ([[batch.listDefaultLimit]] when you leave it out)');
    expect(tokens['batch.listMaxLimit']).toBe(String(BATCH.listMaxLimit));
    expect(tokens['batch.listDefaultLimit']).toBe(String(BATCH.listDefaultLimit));
    expect(list).toContain('`next_before`');
    expect(read('src/routes/batches.ts')).toContain('next_before: items.length > limit ?');
  });

  it('says the verification fields are added after the row is checked, outside the data limits (decision D13)', () => {
    const certificates = section(markdown, '## Certificates and verification');
    expect(certificates).toContain('after your row has been checked, so the [[pdf.maxDataValueChars]]-character limit of row values does not apply to them');
    expect(certificates).toContain('A row may not bring its own `certificate_id`, `verify_url` or `verify_qr`');
    expect(read('src/batch/certificates.ts')).toContain("export const VERIFICATION_KEYS = ['certificate_id', 'verify_url', 'verify_qr'] as const;");
  });
});

describe('/docs/pdf-tools', () => {
  const markdown = body('pdf-tools');
  const opFields = toolkitOpFields();
  const common = stringList('src/pdftools/request.ts', 'COMMON');

  it('documents every operation of PDF_TOOLKIT.ops, in its order', () => {
    expect(Object.keys(opFields)).toEqual([...PDF_TOOLKIT.ops]);
    const listed = tableRows(markdown).map((row) => codeSpans(row[0] ?? '')[0]);
    expect(listed).toEqual([...PDF_TOOLKIT.ops]);
    const headings = [...section(markdown, '## Operations').matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([...PDF_TOOLKIT.ops]);
  });

  it('sends only fields the request parser accepts, and every example request of an operation is complete', () => {
    for (const op of PDF_TOOLKIT.ops) {
      const examples = codeBlocks(expandTokens(section(markdown, `### ${op}`)), 'json')
        .map((block) => JSON.parse(block) as Record<string, unknown>)
        .filter((json) => 'files' in json && Array.isArray(json.files) && !('op' in json));
      expect(examples.length, op).toBeGreaterThan(0);
      for (const example of examples) {
        for (const key of Object.keys(example)) expect([...common, ...(opFields[op] ?? [])], `${op}: ${key}`).toContain(key);
        for (const file of example.files as Array<Record<string, unknown>>) {
          const sources = Object.keys(file).filter((key) => ['url', 'base64', 'pdf_id'].includes(key));
          expect(sources, `${op}: ${JSON.stringify(file)}`).toHaveLength(1);
          if (op !== 'merge') expect(Object.keys(file), op).toEqual(sources);
        }
      }
    }
  });

  it('lists the stamp options, fonts, positions and defaults of src/pdftools/stamp.ts', () => {
    const { positions, defaults } = stampSource();
    const rows = tableRows(section(markdown, '### stamp'));
    const byField = new Map(rows.map((row) => [codeSpans(row[0] ?? '')[0] ?? '', row]));
    expect([...byField.keys()].sort()).toEqual([...(opFields.stamp ?? [])].sort());
    expect(codeSpans(byField.get('font')?.[2] ?? '')).toEqual(Object.keys(STAMP_FONTS));
    expect(codeSpans(byField.get('position')?.[2] ?? '')).toEqual(positions);
    const shown = (field: string): string => (codeSpans(byField.get(field)?.[3] ?? '')[0] ?? '').replace(/^"|"$/g, '');
    expect(shown('font')).toBe(defaults.font);
    expect(shown('font_size')).toBe(defaults.fontSize);
    expect(shown('color')).toBe(defaults.color);
    expect(shown('opacity')).toBe(defaults.opacity);
    expect(shown('rotation')).toBe(defaults.rotation);
    expect(shown('position')).toBe(defaults.position);
    expect(shown('margin')).toBe(defaults.margin);
  });

  it('lists the from-images and protect choices the operations accept', () => {
    const images = new Map(tableRows(section(markdown, '### from-images')).map((row) => [codeSpans(row[0] ?? '')[0] ?? '', row]));
    expect([...images.keys()].sort()).toEqual([...(opFields['from-images'] ?? [])].sort());
    const pageSizes = expandTokens(images.get('page_size')?.[1] ?? '');
    for (const size of IMAGE_PAGE_SIZES) expect(pageSizes, size).toContain(size);
    expect(codeSpans(images.get('fit')?.[1] ?? '')).toEqual([...IMAGE_FITS]);
    expect(codeSpans(images.get('orientation')?.[1] ?? '')).toEqual([...IMAGE_ORIENTATIONS]);
    const protect = new Map(tableRows(section(markdown, '### protect')).map((row) => [codeSpans(row[0] ?? '')[0] ?? '', row]));
    expect([...protect.keys()].sort()).toEqual([...(opFields.protect ?? [])].sort());
    const permissions = codeSpans(protect.get('permissions')?.[1] ?? '');
    expect(permissions).toEqual(['printing', 'high', 'low', 'none', ...Object.values(PERMISSION_FLAGS), 'true', 'false']);
  });

  it('counts the split example as pdfToolkitUnits does, file by file', () => {
    const split = codeBlocks(section(markdown, '### split'), 'json')
      .map((block) => JSON.parse(expandTokens(block)) as { op?: string; files: Array<{ pages: number; credits_used: number }>; pages: number; credits_used: number })
      .find((json) => json.op === 'split');
    if (!split) throw new Error('no split answer');
    for (const file of split.files) expect(file.credits_used).toBe(pdfToolkitUnits('split', file.pages));
    expect(split.credits_used).toBe(split.files.reduce((sum, file) => sum + file.credits_used, 0));
    expect(split.pages).toBe(split.files.reduce((sum, file) => sum + file.pages, 0));
    expect(split.files.length).toBeLessThanOrEqual(PDF_TOOLKIT.maxFiles);
  });

  it('shows the fields answer with the keys of FieldInfo only', () => {
    const answer = codeBlocks(section(markdown, '### fields'), 'json')
      .map((block) => JSON.parse(block) as { op?: string; fields?: Array<Record<string, unknown>> })
      .find((json) => json.op === 'fields');
    const keys = interfaceFields('src/pdftools/forms.ts', 'FieldInfo');
    for (const field of answer?.fields ?? []) for (const key of Object.keys(field)) expect(keys, key).toContain(key);
    expect(answer?.fields?.length).toBeGreaterThan(0);
  });

  it('names the refusal reasons the document loader gives', () => {
    const loader = read('src/pdftools/document.ts');
    for (const reason of ['encrypted', 'xfa', 'not_pdf', 'damaged']) {
      expect(loader, reason).toContain(`reason: '${reason}'`);
      expect(markdown, reason).toContain(`\`${reason}\``);
    }
    expect(read('src/pdftools/budget.ts')).toContain("reason: 'too_complex'");
    expect(markdown).toContain('"The PDF toolkit is not enabled yet."');
    expect(read('src/lib/features.ts')).toContain("toolkit: 'The PDF toolkit is'");
  });

  it('shows the split answer with every key the route sends (decision D10)', () => {
    const split = codeBlocks(section(markdown, '### split'), 'json')
      .map((block) => JSON.parse(expandTokens(block)) as Record<string, unknown>)
      .find((json) => json.op === 'split');
    expect(Object.keys(split ?? {})).toEqual(['op', 'files', 'pages', 'credits_used', 'created_at', 'expires_at', 'usage']);
    const route = read('src/routes/pdf-toolkit.ts');
    expect(route).toContain('const timing = { created_at: iso(saved.createdAt), expires_at: iso(saved.expiresAt) };');
    expect(route).toMatch(/op,\s*files: saved\.files\.map[\s\S]*?pages:[\s\S]*?credits_used: saved\.units,\s*\.\.\.timing,\s*usage:/);
    for (const header of ['X-LTC-Pages', 'X-LTC-Credits-Used', 'X-LTC-Pdf-Url']) expect(section(markdown, '## API reference'), header).toContain(`\`${header}\``);
  });

  it('documents the multipart parts the route reads, and the 404 for an unknown operation', () => {
    const parts = stringList('src/routes/pdf-toolkit.ts', 'MULTIPART_FIELDS');
    expect(parts).toEqual(['files', 'image', 'options']);
    const upload = section(markdown, '### Upload the files');
    for (const part of parts) expect(upload, part).toMatch(new RegExp(`^- \`${part}\`:`, 'm'));
    expect(upload).toContain('`multipart/form-data`');
    expect(read('src/routes/pdf-toolkit.ts')).toContain("throw new ApiError('not_found', `Unknown PDF toolkit operation");
    expect(section(markdown, '## API reference')).toContain('any other answers 404 `not_found`');
  });

  it('says that every request counts and that downloads use the image fetcher\'s limits', () => {
    expect(section(markdown, '## What counts')).toContain('**Every request counts.** Results are not served from storage again');
    expect(read('src/routes/pdf-toolkit.ts')).toContain('identical requests are not\n * served from a cache');
    expect(tokens['toolkit.fetchTimeoutSeconds']).toBe(String(LIMITS.imageFetchTimeoutMs / 1000));
    expect(tokens['toolkit.fetchMaxRedirects']).toBe(String(LIMITS.imageMaxRedirects));
    expect(read('src/routes/pdf-toolkit.ts')).toContain("const USER_AGENT = 'LinkToCard-FileFetcher/1.0");
    expect(section(markdown, '## Files')).toContain('`User-Agent: LinkToCard-FileFetcher/1.0`');
  });

  it('matches the merge quickstart to the tokens of the example', () => {
    expect(pdfToolkitUnits('merge', Number(tokens['toolkit.examplePages']))).toBe(Number(tokens['toolkit.exampleUnits']));
    expect(Number(tokens['toolkit.exampleUnits'])).toBeGreaterThan(1);
  });
});

describe('/docs/link-cards', () => {
  const markdown = body('link-cards');
  const secret = 'ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab';

  it('lists the data keys of LINK_DATA_SOURCES with their sources, in order', () => {
    const sources = linkDataSources();
    const rows = tableRows(section(markdown, '## What goes on the card'));
    expect(rows.map((row) => codeSpans(row[0] ?? '')[0])).toEqual(Object.keys(sources));
    for (const row of rows) {
      const key = codeSpans(row[0] ?? '')[0] ?? '';
      expect((row[1] ?? '').replace(/`/g, ''), key).toBe(sources[key]);
    }
  });

  it('lists exactly the request fields of POST /v1/cards/from-url', () => {
    const fields = stringList('src/cards/handlers.ts', 'FROM_URL_FIELDS');
    const listed = tableRows(section(markdown, '### Request')).flatMap((row) => codeSpans(row[0] ?? ''));
    expect(listed).toEqual(fields);
    expect(markdown).toContain('Default: `[[linkCards.defaultTemplate]]`');
    expect(STARTER_TEMPLATE_IDS).toContain(LINK_CARDS.defaultTemplate);
  });

  it('prints a worked example that the server verifies', async () => {
    const blocks = codeBlocks(markdown, 'text');
    const canonical = blocks.find((block) => block.startsWith('/v1/link/'))?.trimEnd() ?? '';
    const signature = blocks.find((block) => /^[0-9a-f]{64}\n$/.test(block))?.trim() ?? '';
    const published = blocks.find((block) => block.startsWith('https://linktocard.com/v1/link/'))?.trim() ?? '';
    expect(markdown).toContain(secret);
    expect(createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')).toBe(signature);

    const url = new URL(published);
    expect(url.searchParams.get('sig')).toBe(signature);
    const params = [...url.searchParams].filter(([name]) => name !== 'sig');
    expect(canonicalString(url.pathname, params)).toBe(canonical);
    const verified = await verifySignedUrl(url, secret);
    expect(verified.ok).toBe(true);
    // The link-card verifier (src/cards/link-url.ts) needs the page in "url".
    expect(url.searchParams.get('url')).toMatch(/^https:\/\//);
  });

  it('prints a Node.js signer that makes the published URL when it is run', () => {
    type Signer = (input: { secret: string; baseUrl: string; siteId: string; template: string; ext?: string; page: string; params?: Record<string, string> }) => string;
    const block = codeBlocks(markdown, 'js').find((code) => code.includes('function signedLinkUrl('));
    if (!block) throw new Error('link-cards has no Node.js signer');
    const importLine = "import { createHmac } from 'node:crypto';\n";
    expect(block.startsWith(importLine)).toBe(true);
    const signer = new Function('createHmac', `${block.slice(importLine.length)}\nreturn signedLinkUrl;`)(createHmac) as Signer;
    const published = codeBlocks(markdown, 'text').find((code) => code.startsWith('https://linktocard.com/v1/link/'))?.trim();
    const made = signer({ secret, baseUrl: 'https://linktocard.com', siteId: 's_4k2j9x0q1m7c8d5e', template: 'blog', page: 'https://example.com/blog/launch-week', params: { tag: 'Launch week', theme: 'dark' } });
    expect(made).toBe(published);
    // A line break in a value must not become a second parameter line, and "url" is always the page.
    const hostile = new URL(signer({ secret, baseUrl: 'https://linktocard.com', siteId: 's_1', template: 'blog', page: 'https://example.com/', params: { tag: 'a\nsize=square', url: 'https://evil.example/' } }));
    expect(hostile.searchParams.get('tag')).toBe('a size=square');
    expect(hostile.searchParams.get('url')).toBe('https://example.com/');
  });

  it('lists the failure reasons that only link URLs have', () => {
    const union = /export type LinkUrlFailure = SignedUrlFailure((?: \| '[a-z_]+')+);/.exec(read('src/cards/link-url.ts'))?.[1];
    if (!union) throw new Error('src/cards/link-url.ts no longer declares LinkUrlFailure');
    const own = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    const rows = tableRows(section(markdown, '### Errors')).map((row) => codeSpans(row[0] ?? '')[0]);
    expect(rows).toEqual(own);
    expect(markdown).toContain('"Cards from links are not enabled yet."');
    expect(read('src/lib/features.ts')).toContain("linkcards: 'Cards from links are'");
  });

  it('promises no card on the free checker, which has no such button', () => {
    expect(markdown).not.toContain('## Try it without an account');
    expect(read('site/pages/tools/og-checker.html')).not.toMatch(/Make this card/i);
  });

  it('prints the refresh interval only once LINK_CARDS has it', () => {
    const configured = (LINK_CARDS as { refreshAfterMs?: number }).refreshAfterMs;
    if (configured === undefined) expect(Object.keys(PENDING_CONFIG_TOKENS)).toContain('linkCards.refreshHours');
    else expect(tokens['linkCards.refreshHours']).toBe(String(configured / 3_600_000));
  });
});

describe('/docs/integrations', () => {
  const markdown = body('integrations');

  it('says the connectors are being prepared, and never that one is published or listed', () => {
    expect(markdown).toContain('being prepared for listing');
    const text = markdown.replace(/\s+/g, ' ');
    for (const match of text.matchAll(/\b(published|listed|available on|now available|install it from|is live)\b/gi)) {
      const before = text.slice(Math.max(0, (match.index ?? 0) - 4), match.index);
      expect(`${before}${match[0]}`, 'a connector claim').toMatch(/^not (published|listed)$/i);
    }
  });

  it('names an API request for every operation, each one a path the API has', () => {
    const openapi = `${read('openapi.yaml')}\n${existsSync(join(ROOT, '../openapi-v3.yaml')) ? read('../openapi-v3.yaml') : ''}`;
    const paths = new Set([...openapi.matchAll(/^ {2}(\/\S+):$/gm)].map((match) => (match[1] ?? '').replace(/\{[a-z_]+\}/g, '{}')));
    const rows = tableRows(section(markdown, '## What the connectors offer'));
    // Six steps of contract T2, and the download of one part of a batch's ZIP (decision D9).
    expect(rows.length).toBe(7);
    expect(rows.map((row) => codeSpans(row[2] ?? '')[0])).toContain('GET /v1/batches/{id}/zip');
    for (const row of rows) {
      const request = codeSpans(row[2] ?? '')[0] ?? '';
      const [, path] = request.split(' ');
      expect(paths.has((path ?? '').replace(/\{[a-z_]+\}/g, '{}')), request).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The OpenAPI fragment                                                */
/* ------------------------------------------------------------------ */

describe('the OpenAPI description of the v3 endpoints', () => {
  const FRAGMENT = '../openapi-v3.yaml';
  const fragment = existsSync(join(ROOT, FRAGMENT)) ? read(FRAGMENT) : null;
  const openapi = read('openapi.yaml');
  /** The v3 part: the fragment while it exists, otherwise openapi.yaml after the merge. */
  const v3 = fragment ?? openapi;
  const both = fragment === null ? openapi : `${openapi}\n${fragment}`;
  const V3_PATHS = [
    '/v1/batches',
    '/v1/batches/{batch_id}',
    '/v1/batches/{batch_id}/zip',
    '/v1/batches/{batch_id}/cancel',
    '/v1/certificates/{certificate_id}/revoke',
    '/v/{certificate_id}',
    '/v/{certificate_id}.json',
    ...PDF_TOOLKIT.ops.map((op) => `/v1/pdf-tools/${op}`),
    '/v1/cards/from-url',
    '/v1/link/{site_id}/{template}.{ext}',
  ];

  /** Text of one component, from "    Name:" to the next component of the same section. */
  function component(text: string, kind: 'schemas' | 'responses', name: string): string {
    const sectionStart = text.indexOf(`\n  ${kind}:\n`);
    const start = text.indexOf(`\n    ${name}:\n`, sectionStart);
    if (sectionStart < 0 || start < 0) return '';
    const next = /\n {4}[A-Za-z]|\n {2}[a-z]/.exec(text.slice(start + 1));
    return text.slice(start, next ? start + 1 + next.index : undefined);
  }

  const properties = (schema: string): string[] => [...schema.matchAll(/^ {8}([a-z_]+):$/gm)].map((match) => match[1] ?? '');

  it('describes every new path, behind its feature', () => {
    const paths = [...v3.matchAll(/^ {2}(\/\S+):$/gm)].map((match) => match[1]);
    for (const path of V3_PATHS) expect(paths, path).toContain(path);
    const lines = v3.split('\n');
    const featureOf = (path: string): string | null => {
      let open: string | null = null;
      for (const line of lines) {
        const marker = /^\s*#\s*(\/?)feature:([a-z]+)\s*$/.exec(line);
        if (marker) open = marker[1] === '/' ? null : (marker[2] ?? null);
        if (line === `  ${path}:`) return open;
      }
      return null;
    };
    for (const path of V3_PATHS) {
      const expected = path.startsWith('/v1/pdf-tools/') ? 'toolkit' : path.startsWith('/v1/cards/') || path.startsWith('/v1/link/') ? 'linkcards' : 'batch';
      expect(featureOf(path), path).toBe(expected);
    }
  });

  it('has balanced feature blocks of known features', () => {
    let open: string | null = null;
    for (const match of v3.matchAll(/^[ \t]*#[ \t]*(\/?)feature:([a-z][a-z0-9-]*)[ \t]*$/gm)) {
      expect(KNOWN_FEATURES).toContain(match[2]);
      if (match[1] === '/') {
        expect(open).toBe(match[2]);
        open = null;
      } else {
        expect(open).toBeNull();
        open = match[2] ?? null;
      }
    }
    expect(open).toBeNull();
  });

  it('refers only to components that the fragment or openapi.yaml defines', () => {
    const refs = [...v3.matchAll(/\$ref: "#\/components\/([a-zA-Z]+)\/([\w-]+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    for (const [ref, kind, name] of refs) {
      const defined = [openapi, ...(fragment ? [fragment] : [])].some((text) => component(text, kind as 'schemas' | 'responses', name ?? '') !== '');
      expect(defined, ref).toBe(true);
    }
  });

  it('answers POST /v1/batches with 403 plan_required, 404 for an unknown template and 409 at the cap', () => {
    const post = v3.slice(v3.indexOf('\n  /v1/batches:\n'), v3.indexOf('\n    get:\n', v3.indexOf('\n  /v1/batches:\n')));
    expect(post).toContain('"403":\n          $ref: "#/components/responses/BatchForbidden"');
    expect(post).toContain('"404":\n          $ref: "#/components/responses/BatchTemplateNotFound"');
    expect(post).toContain('"409":\n          $ref: "#/components/responses/BatchConflict"');
    expect(component(v3, 'responses', 'BatchForbidden')).toContain('plan_required');
    expect(component(v3, 'responses', 'BatchConflict')).toContain('conflict.');
    expect(v3).toContain('(certificate-1.pdf, certificate-2.pdf, ...) and "document-{{n}}.pdf"');
  });

  it('gives every error response the status of its code', () => {
    for (const match of v3.matchAll(/"(\d{3})":\n\s+\$ref: "#\/components\/responses\/(\w+)"/g)) {
      const description = /description: '?([a-z_]+)[.,( ]/.exec(component(both, 'responses', match[2] ?? ''))?.[1] ?? '';
      if (!Object.hasOwn(ERROR_STATUS, description)) continue;
      expect(ERROR_STATUS[description as keyof typeof ERROR_STATUS], `${match[2]} under ${match[1]}`).toBe(Number(match[1]));
    }
  });

  it('lists the request fields the code accepts', () => {
    const opFields = toolkitOpFields();
    const common = stringList('src/pdftools/request.ts', 'COMMON');
    const schemaFor: Record<string, string[]> = {
      merge: ['MergeRequest'],
      split: ['SplitRequest'],
      stamp: ['StampTextRequest', 'StampImageRequest', 'StampLayout'],
      fill: ['FillRequest'],
      fields: ['FieldsRequest'],
      'from-images': ['FromImagesRequest'],
      protect: ['ProtectRequest'],
    };
    for (const op of PDF_TOOLKIT.ops) {
      const listed = new Set((schemaFor[op] ?? []).flatMap((name) => properties(component(v3, 'schemas', name))));
      for (const field of opFields[op] ?? []) expect([...listed], `${op}: ${field}`).toContain(field);
      for (const field of listed) expect([...common, ...(opFields[op] ?? [])], `${op}: ${field}`).toContain(field);
    }
    expect(properties(component(v3, 'schemas', 'CardFromUrlRequest'))).toEqual(stringList('src/cards/handlers.ts', 'FROM_URL_FIELDS'));
    // The batch answers (decision D6): batchJson with zip_parts, batchRowJson and the ZIP parts.
    expect(properties(component(v3, 'schemas', 'Batch'))).toEqual([...interfaceFields('src/batch/view.ts', 'BatchJson'), 'zip_parts']);
    expect(properties(component(v3, 'schemas', 'BatchRow'))).toEqual(interfaceFields('src/batch/view.ts', 'BatchRowJson'));
    expect(properties(component(v3, 'schemas', 'BatchZipPart'))).toEqual(interfaceFields('src/routes/batches.ts', 'ZipPartJson'));
    expect(properties(component(v3, 'schemas', 'ToolkitSplitResult'))).toEqual(['op', 'files', 'pages', 'credits_used', 'created_at', 'expires_at', 'usage']);
    expect(properties(component(v3, 'schemas', 'ToolkitMultipart'))).toEqual(stringList('src/routes/pdf-toolkit.ts', 'MULTIPART_FIELDS'));
    expect(properties(component(v3, 'schemas', 'Certificate'))).toEqual(interfaceFields('src/batch/verify-page.ts', 'VerifyJson'));
    expect(properties(component(v3, 'schemas', 'PdfFormField'))).toEqual(interfaceFields('src/pdftools/forms.ts', 'FieldInfo'));
  });

  it('states the limits that src/config.ts enforces', () => {
    const text = v3.replace(/\s+/g, ' ');
    const plans = (values: Record<'free' | 'starter' | 'pro', number>): string => PLAN_ORDER.map((id) => `${PLANS[id].name} ${values[id]}`).join(', ');
    for (const expected of [
      `Rows per batch by plan: ${plans(BATCH.maxRows)}`,
      `at least ${PDF.baseUnits} images for every row`,
      `at most ${BATCH.maxActivePerAccount} batches queued or running`,
      `at most ${BATCH.maxRowAttempts} times in all`,
      `maxItems: ${BATCH.maxRows.pro}`,
      `kept for ${BATCH.revokedRetentionDays} days after the revocation`,
      `each part at most ${BATCH.zipPartMaxEntries} files and ${BATCH.zipPartMaxBytes / GB} GB`,
      `PDFs in this part, at most ${BATCH.zipPartMaxEntries}`,
      `at most ${BATCH.zipPartMaxBytes / GB} GB.`,
      `Batches per page, from 1 to ${BATCH.listMaxLimit} (default ${BATCH.listDefaultLimit})`,
      `maximum: ${BATCH.listMaxLimit}`,
      `default: ${BATCH.listDefaultLimit}`,
      `revoked more than ${BATCH.revokedRetentionDays} days ago`,
      `do not have ${PDF.baseUnits} images for every row`,
      `already has ${BATCH.maxActivePerAccount} batches queued or running`,
      `The request body is over ${BATCH.maxRequestBodyBytes / MB} MB`,
      `each started block of ${PDF_TOOLKIT.pagesPerUnit} pages`,
      `At most ${PDF_TOOLKIT.maxFiles} files, and at most ${PDF_TOOLKIT.maxPages} pages`,
      `maxItems: ${PDF_TOOLKIT.maxFiles}`,
      `at most ${PDF_TOOLKIT.maxInputBytes / MB} MB and the result at most ${PDF_TOOLKIT.maxPages} pages`,
      `at most ${PDF_TOOLKIT.maxImageBytes / MB} MB (a PNG at most ${LIMITS.maxImagePixels / 1_000_000} megapixels)`,
      `The body is over ${PDF_TOOLKIT.maxRequestBodyBytes / MB} MB, the files together over ${PDF_TOOLKIT.maxInputBytes / MB} MB, an image over ${PDF_TOOLKIT.maxImageBytes / MB} MB, a PNG over ${LIMITS.maxImagePixels / 1_000_000} megapixels, a file or the result over ${PDF_TOOLKIT.maxPages} pages`,
      `one line of at most ${PDF.maxDataValueChars} characters`,
      `maxLength: ${PDF.maxDataValueChars}`,
      `Text values at most ${PDF.maxDataValueChars} characters`,
      `https only, ${INSPECT.pageTimeoutMs / 1000} seconds, ${INSPECT.pageMaxBytes / MB} MB, at most ${INSPECT.maxRedirects} redirects; a result is reused for ${INSPECT.cacheTtlMs / 60_000} minutes`,
      `(the GET /v1/inspect allowance, UTC day): ${plans(INSPECT.dailyInspectionsByPlan)}`,
      `daily allowance per site, by plan: ${plans(INSPECT.dailyInspectionsByPlan)}`,
      `at most ${INSPECT.maxUrlChars} characters`,
      `maxLength: ${INSPECT.maxUrlChars}`,
      `Default ${LINK_CARDS.defaultTemplate}.`,
      `default: ${LINK_CARDS.defaultTemplate}`,
      `is at most ${LIMITS.maxDataValueChars} characters, and path and query together at most ${LIMITS.maxSignedUrlChars} characters`,
      `maxLength: ${LIMITS.maxDataValueChars}`,
      `enum: [${PDF.formats.join(', ')}, auto]`,
      `(${PDF_TEMPLATE_IDS.join(', ')})`,
      `(${STARTER_TEMPLATE_IDS.join(', ')})`,
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('uses the not_configured messages of the switches', () => {
    const features = read('src/lib/features.ts');
    for (const [name, message] of [
      ['batch', 'Bulk documents are not enabled yet.'],
      ['toolkit', 'The PDF toolkit is not enabled yet.'],
      ['linkcards', 'Cards from links are not enabled yet.'],
    ] as const) {
      expect(features).toContain(`${name}: '${message.replace(' not enabled yet.', '')}'`);
      expect(v3).toContain(`("${message}")`);
    }
  });
});

describe('scripts/v3-site-tokens.ts', () => {
  it('prints the numbers of src/config.ts', () => {
    const v3 = v3SiteTokens();
    expect(v3).toMatchObject({
      'batch.maxRowsFree': String(BATCH.maxRows.free),
      'batch.maxActive': String(BATCH.maxActivePerAccount),
      'batch.maxRequestBodyMb': String(BATCH.maxRequestBodyBytes / MB),
      'batch.maxRowAttempts': String(BATCH.maxRowAttempts),
      'batch.revokedRetentionDays': String(BATCH.revokedRetentionDays),
      'batch.staleAfterDays': String(BATCH.staleAfterDays),
      'batch.listDefaultLimit': String(BATCH.listDefaultLimit),
      'batch.listMaxLimit': String(BATCH.listMaxLimit),
      'batch.zipPartMaxGb': String(BATCH.zipPartMaxBytes / GB),
      'batch.exampleCredits': String(2 * PDF.baseUnits),
      'toolkit.ops': PDF_TOOLKIT.ops.join(', '),
      'toolkit.maxInputMb': String(PDF_TOOLKIT.maxInputBytes / MB),
      'toolkit.maxFiles': String(PDF_TOOLKIT.maxFiles),
      'toolkit.maxImageMb': String(PDF_TOOLKIT.maxImageBytes / MB),
      'toolkit.maxRequestBodyMb': String(PDF_TOOLKIT.maxRequestBodyBytes / MB),
      'toolkit.pagesPerUnit': String(PDF_TOOLKIT.pagesPerUnit),
      'toolkit.maxUnits': String(pdfToolkitUnits('merge', PDF_TOOLKIT.maxPages)),
      'inspect.pageTimeoutSeconds': String(INSPECT.pageTimeoutMs / 1000),
      'inspect.pageMaxMb': String(INSPECT.pageMaxBytes / MB),
      'inspect.maxRedirects': String(INSPECT.maxRedirects),
      'inspect.cacheMinutes': String(INSPECT.cacheTtlMs / 60_000),
      'linkCards.defaultTemplate': LINK_CARDS.defaultTemplate,
    });
    expect(Number(v3['batch.maxRowsPro']?.replace(/,/g, ''))).toBe(BATCH.maxRows.pro);
    expect(Number(v3['batch.zipPartMaxEntries']?.replace(/,/g, ''))).toBe(BATCH.zipPartMaxEntries);
    expect(Number(v3['batch.maxCsvColumns']?.replace(/,/g, ''))).toBe(BATCH.maxCsvColumns);
    expect(Number(v3['toolkit.maxPages']?.replace(/,/g, ''))).toBe(PDF_TOOLKIT.maxPages);
    expect(Number(v3['inspect.maxUrlChars']?.replace(/,/g, ''))).toBe(INSPECT.maxUrlChars);
    expect(Number(v3['inspect.dailyPro']?.replace(/,/g, ''))).toBe(INSPECT.dailyInspectionsByPlan.pro);
  });

  it('defines no token that scripts/build-site.ts already has with another value', () => {
    const { tokens: existing } = listTokens({ env: {}, now: NOW });
    for (const [name, value] of Object.entries(v3SiteTokens())) {
      if (Object.hasOwn(existing, name)) expect(existing[name], name).toBe(value);
    }
  });
});
