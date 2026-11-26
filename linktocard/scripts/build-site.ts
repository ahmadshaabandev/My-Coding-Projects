/**
 * Static-site build: site/pages + site/content -> site/dist, as flat .html files.
 *
 *   npm run build:site                     build site/dist
 *   SITE_PDF=on npm run build:site         the same, with the PDF pages and blocks (staging)
 *   SITE_FEATURES=pdf,toolkit npm run build:site   the same, with any list of features (FEATURES)
 *   npm run build:site -- --tokens         print every [[token]] and partial
 *   npm run build:site -- --check-golive   exit 1 while placeholders remain
 *
 * No framework and no bundler: token expansion, marked and four small layouts.
 * Every number on the site comes from src/billing/plans.ts and src/config.ts,
 * so published prices and limits cannot drift from the enforced ones.
 *
 * Feature switches (FEATURES: pdf, batch, toolkit, linkcards, email, previews, integrations), so
 * a feature can be published on staging before production. SITE_FEATURES is a comma list of the
 * features to publish; SITE_PDF=on is the older spelling of "pdf". SITE_PDF must be "on", "off" or unset (= off), and SITE_FEATURES may
 * name only known features; anything else stops the build, so a typo cannot silently publish
 * the wrong site.
 *   - A page or Markdown file with `feature: pdf` in its front matter is built only when
 *     SITE_PDF is "on" (`feature: no-pdf`: only when it is off). A page that is not built is
 *     also absent from sitemap.xml and the docs navigation, which are made from built pages.
 *   - In any page, Markdown file, partial or layout, <!-- feature:pdf --> ... <!-- /feature:pdf -->
 *     is kept only when on, <!-- feature:no-pdf --> ... <!-- /feature:no-pdf --> only when off.
 *     The markers never reach the output. A marker alone on its line takes the line with it,
 *     so a block can sit between Markdown table rows or list items. Blocks do not nest.
 *   - openapi.yaml uses the same blocks as YAML comment lines (# feature:pdf ... # /feature:pdf):
 *     the copy in the repository describes everything, the published copy only what is switched on.
 *   - site/public files listed in FEATURE_PUBLIC_FILES are copied only when their feature is on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked, Renderer, type Tokens } from 'marked';
import { PLANS, PLAN_ORDER, TOPUP, formatCount, formatUsd, type Plan } from '../src/billing/plans';
import { AUTH, BATCH, DAY_MS, EMAIL_FIELDS, FORMATS, HTTP_CACHE, LIMITS, LOCAL_PDF, PDF, RATE_LIMITS, SIZES, pdfUnits, type PdfFormat, type RateLimitName } from '../src/config';
import { PDF_TEMPLATES, type PdfStarterTemplate } from '../src/pdf/templates';
import { STARTER_TEMPLATES as RENDER_TEMPLATES } from '../src/render/templates';
import { emailSiteTokens } from './email-site-tokens';
import { previewsSiteTokens } from './previews-site-tokens';
import { v3SiteTokens } from './v3-site-tokens';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KB = 1024;
const MB = 1024 * 1024;

export interface BuildOptions {
  /** Holds site.config.json, layouts/, partials/, pages/ and public/. Default: <repo>/site. */
  siteDir?: string;
  /** Markdown root. Default: <siteDir>/content. */
  contentDir?: string;
  /** Default: <siteDir>/dist. */
  outDir?: string;
  /** Source of SITE_URL / SITE_LEGAL_NAME / SITE_LEGAL_ADDRESS. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Build date (footer year). Default: now. */
  now?: Date;
}

export interface SiteConfig {
  name: string;
  url: string;
  supportEmail: string;
  legalName: string;
  legalAddress: string;
  /** Town, district and country, for the one-line seller notice in the footer. */
  legalLocality: string;
  legalUpdated: string;
  governingLaw: string;
}

export interface RenderedPage {
  /** Repo-relative source file, for error messages and reports. */
  source: string;
  /** Path inside the output directory, e.g. "docs/quickstart.html". */
  outPath: string;
  /** Extensionless public path, e.g. "/docs/quickstart" ("/" for the landing page). */
  url: string;
  /** False for pages kept out of sitemap.xml and marked noindex. */
  indexed: boolean;
  html: string;
}

export interface RenderedSite {
  config: SiteConfig;
  /** The feature switches this build was made with. */
  features: SiteFeatures;
  pages: RenderedPage[];
  sitemap: string;
  /** openapi.yaml as published: the repository copy with the feature blocks applied. */
  openapi: string;
}

export interface TokenListing {
  tokens: Record<string, string>;
  partials: string[];
}

export interface Placeholder {
  value: string;
  /** Output files that display it. */
  pages: string[];
}

type Layout = 'site' | 'page' | 'doc' | 'legal';

interface Paths {
  siteDir: string;
  contentDir: string;
  outDir: string;
}

interface TokenContext {
  tokens: Record<string, string>;
  /** Token names whose value is still a config placeholder. */
  placeholders: Set<string>;
  /** Partial name -> source (file partials may contain tokens and other partials). */
  partials: Record<string, string>;
  features: SiteFeatures;
}

interface PageSource {
  source: string;
  outPath: string;
  url: string;
  layout: Layout;
  title: string;
  description: string;
  nav: string;
  order: number;
  indexed: boolean;
  scripts: string[];
  content: string;
}

// ------------------------------------------------------------------ config

const CONFIG_KEYS = ['name', 'url', 'supportEmail', 'legalName', 'legalAddress', 'legalLocality', 'legalUpdated', 'governingLaw'] as const;

const ENV_OVERRIDES: Partial<Record<keyof SiteConfig, string>> = {
  url: 'SITE_URL',
  legalName: 'SITE_LEGAL_NAME',
  legalAddress: 'SITE_LEGAL_ADDRESS',
  legalLocality: 'SITE_LEGAL_LOCALITY',
};

/** LEGAL_NAME, LEGAL_ADDRESS, ...: an ALL_CAPS_WITH_UNDERSCORES value has not been filled in. */
const isPlaceholder = (value: string): boolean => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value);

function resolvePaths(options: BuildOptions): Paths {
  const siteDir = options.siteDir ?? join(ROOT, 'site');
  return {
    siteDir,
    contentDir: options.contentDir ?? join(siteDir, 'content'),
    outDir: options.outDir ?? join(siteDir, 'dist'),
  };
}

const display = (file: string): string => relative(ROOT, file).split('\\').join('/');

function loadConfig(file: string, env: Record<string, string | undefined>): SiteConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const config = {} as SiteConfig;
  for (const key of CONFIG_KEYS) {
    const envName = ENV_OVERRIDES[key];
    const value = (envName ? env[envName]?.trim() : '') || raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${display(file)}: "${key}" must be a non-empty string`);
    }
    config[key] = value.trim();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.legalUpdated)) {
    throw new Error(`${display(file)}: "legalUpdated" must be a YYYY-MM-DD date`);
  }
  // Origin only: every page appends its own path.
  config.url = new URL(config.url).origin;
  return config;
}

// ------------------------------------------------------------------ feature switches

/**
 * pdf: PDFs (POST /v1/pdf, the PDF tools). batch: bulk documents and certificate verification.
 * toolkit: the PDF toolkit API and the in-browser merge and image-to-PDF pages. linkcards: cards
 * from links. email: personalized email images. previews: the one-app link preview pages and the
 * tool hub. integrations: the Zapier, Make and n8n docs page.
 */
export const FEATURES = ['pdf', 'batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations'] as const;
export type Feature = (typeof FEATURES)[number];
export type SiteFeatures = Record<Feature, boolean>;

/** The in-browser PDF engine, written by scripts/build-browser-bundles.mts before this build runs. */
export const LOCAL_PDF_BUNDLE = 'assets/js/vendor/pdf-local.js';

/** site/public files that exist only for a feature (everything else is always copied). */
const FEATURE_PUBLIC_FILES: Readonly<Record<string, Feature>> = {
  'assets/js/pdf-tools.js': 'pdf',
  // /tools/merge-pdf and /tools/image-to-pdf: they run in the browser and need no API, but
  // they offer the PDF toolkit API, so they are published with it.
  'assets/js/local-files.js': 'toolkit',
  'assets/js/merge-pdf.js': 'toolkit',
  'assets/js/image-to-pdf.js': 'toolkit',
  [LOCAL_PDF_BUNDLE]: 'toolkit',
  // The one-app link preview pages.
  'assets/js/og-platform.js': 'previews',
  'assets/css/og-platform.css': 'previews',
  // The dashboard's Bulk documents tab: the dashboard imports it only when the API says batches are on.
  'assets/js/dashboard/bulk.js': 'batch',
  'assets/js/dashboard/bulk-helpers.js': 'batch',
  'assets/js/dashboard/csv.js': 'batch',
  'assets/css/dashboard-bulk.css': 'batch',
};

/**
 * Which features this build publishes: the names in SITE_FEATURES ("pdf,toolkit"), and "pdf"
 * also for SITE_PDF=on. Anything but "on", "off" or unset in SITE_PDF, or an unknown name in
 * SITE_FEATURES, stops the build.
 */
export function siteFeatures(env: Record<string, string | undefined>): SiteFeatures {
  const features = Object.fromEntries(FEATURES.map((feature) => [feature, false])) as SiteFeatures;
  const pdf = (env.SITE_PDF ?? '').trim();
  if (pdf !== '' && pdf !== 'on' && pdf !== 'off') throw new Error(`SITE_PDF must be "on" or "off" (or unset), not "${pdf}"`);
  if (pdf === 'on') features.pdf = true;
  for (const name of (env.SITE_FEATURES ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    if (!(FEATURES as readonly string[]).includes(name)) throw new Error(`SITE_FEATURES names an unknown feature "${name}" (known: ${FEATURES.join(', ')})`);
    features[name as Feature] = true;
  }
  return features;
}

interface FeatureSwitch {
  feature: Feature;
  /** true for "pdf" (kept when on), false for "no-pdf" (kept when off). */
  when: boolean;
}

function parseSwitch(name: string, where: string): FeatureSwitch {
  const negated = name.startsWith('no-');
  const feature = negated ? name.slice('no-'.length) : name;
  if (!(FEATURES as readonly string[]).includes(feature)) {
    throw new Error(`${where}: unknown feature "${name}" (known: ${FEATURES.flatMap((known) => [known, `no-${known}`]).join(', ')})`);
  }
  return { feature: feature as Feature, when: !negated };
}

const switchedOn = (rule: FeatureSwitch, features: SiteFeatures): boolean => features[rule.feature] === rule.when;

/** A marker: <!-- feature:x --> or <!-- /feature:x --> in HTML and Markdown; a whole "# feature:x" comment line in YAML. */
const FEATURE_MARKERS = {
  html: /<!--[ \t]*(\/?)feature:([a-z][a-z0-9-]*)[ \t]*-->/g,
  yaml: /^[ \t]*#[ \t]*(\/?)feature:([a-z][a-z0-9-]*)[ \t]*\r?$/gm,
} as const;

/** Anything that still looks like a marker after the real ones are gone is a typo, not a comment to publish. */
const STRAY_MARKERS = {
  html: /<!--[^>]*?\bfeature\s*:/,
  yaml: /^[ \t]*#[ \t]*\/?feature\s*:/m,
} as const;

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Removes [start, end); when that leaves its line blank, the whole line goes, so no empty line splits a Markdown block. */
function removeRange(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline < 0 ? text.length : newline;
  const blank = text.slice(lineStart, start).trim() === '' && text.slice(end, lineEnd).trim() === '';
  return blank ? text.slice(0, lineStart) + text.slice(newline < 0 ? text.length : newline + 1) : text.slice(0, start) + text.slice(end);
}

/**
 * Keeps or drops the feature blocks of one source file (see the header of this file).
 * Throws, naming the file and line, on an unknown feature, a nested, unclosed or
 * mismatched block, and on anything left over that looks like a marker.
 */
export function applyFeatureBlocks(text: string, features: SiteFeatures, file: string, syntax: 'html' | 'yaml' = 'html'): string {
  // Real markers blanked out (positions kept), whatever still looks like one is a typo.
  const masked = text.replace(FEATURE_MARKERS[syntax], (marker) => ' '.repeat(marker.length));
  const stray = STRAY_MARKERS[syntax].exec(masked);
  if (stray) throw new Error(`${file}:${lineOf(text, stray.index)}: malformed feature marker (write <!-- feature:pdf --> or # feature:pdf exactly)`);

  const ranges: Array<[start: number, end: number]> = [];
  let open: { name: string; rule: FeatureSwitch; start: number; end: number } | null = null;
  for (const match of text.matchAll(FEATURE_MARKERS[syntax])) {
    const name = match[2] ?? '';
    const start = match.index;
    const end = start + match[0].length;
    const where = `${file}:${lineOf(text, start)}`;
    if (match[1] !== '/') {
      if (open) throw new Error(`${where}: feature:${name} opens inside feature:${open.name}; feature blocks do not nest`);
      open = { name, rule: parseSwitch(name, where), start, end };
      continue;
    }
    if (!open) throw new Error(`${where}: /feature:${name} closes a block that was never opened`);
    if (open.name !== name) throw new Error(`${where}: /feature:${name} closes feature:${open.name}`);
    if (switchedOn(open.rule, features)) ranges.push([open.start, open.end], [start, end]);
    else ranges.push([open.start, end]);
    open = null;
  }
  if (open) throw new Error(`${file}:${lineOf(text, open.start)}: feature:${open.name} is never closed`);
  // From the end, so every earlier position stays valid.
  let out = text;
  for (const [start, end] of ranges.reverse()) out = removeRange(out, start, end);
  return out;
}

// ------------------------------------------------------------------ tokens

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function planTokens(plan: Plan): Record<string, string> {
  const prefix = `plan.${plan.id}`;
  return {
    [`${prefix}.name`]: plan.name,
    [`${prefix}.price`]: formatUsd(plan.priceUsd),
    [`${prefix}.images`]: formatCount(plan.monthlyImages),
    [`${prefix}.cacheDays`]: String(plan.cacheDays),
    [`${prefix}.fontFiles`]: String(plan.fonts.maxFiles),
    [`${prefix}.fontMb`]: String(plan.fonts.maxBytesPerFile / MB),
    [`${prefix}.support`]: plan.support,
    // Free has no Paddle product; say so instead of leaving the token undefined.
    [`${prefix}.paddleName`]: plan.paddleProductName ?? '(no Paddle product)',
  };
}

/** A byte limit in KB or MB as the site prints it: "256", "1.5". */
const inUnits = (bytes: number, unit: number): string => String(Math.round((bytes / unit) * 100) / 100);

/** A template's sample as one JSON value, for the free tools' "Fill in an example" button. */
function pdfSampleJson(id: PdfStarterTemplate['id']): string {
  const template = PDF_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`src/pdf/templates exports no "${id}" template`);
  return JSON.stringify(template.sample);
}

/**
 * How long a PDF request waits for an identical one that is making the same PDF:
 * PDF_DUPLICATE_WAIT_MS in src/pdf/service.ts, one browser call (CALL_TIMEOUT_MS in
 * src/pdf/render.ts) plus 15 s. Those modules do not load outside the Worker, so the formula is
 * repeated here; tests/node/pdf-site.test.ts checks that both still read this way.
 */
function pdfDuplicateWaitMs(): number {
  const callTimeoutMs = 2 * PDF.renderTimeoutMs + 15_000;
  return callTimeoutMs + 15_000;
}

/** The in-browser PDF tools (LOCAL_PDF). The toolkit numbers they point to come from scripts/v3-site-tokens.ts. */
function localPdfTokens(): Record<string, string> {
  return {
    'localPdf.maxFiles': String(LOCAL_PDF.maxFiles),
    'localPdf.maxTotalMb': inUnits(LOCAL_PDF.maxTotalBytes, MB),
    'localPdf.maxPages': formatCount(LOCAL_PDF.maxPages),
    'localPdf.maxImageMegapixels': inUnits(LOCAL_PDF.maxImagePixels, 1_000_000),
    // Unformatted, for the data-max-* attributes the page scripts read.
    'localPdf.raw.maxFiles': String(LOCAL_PDF.maxFiles),
    'localPdf.raw.maxTotalBytes': String(LOCAL_PDF.maxTotalBytes),
    'localPdf.raw.maxPages': String(LOCAL_PDF.maxPages),
    'localPdf.raw.maxImagePixels': String(LOCAL_PDF.maxImagePixels),
  };
}

/**
 * [[pdf.*]]: every PDF number the pages print, from PDF and pdfUnits() in src/config.ts and
 * the starter list in src/pdf/templates. Pages never type a PDF number themselves.
 */
function pdfTokens(): Record<string, string> {
  return {
    'pdf.maxPages': String(PDF.maxPages),
    'pdf.basePages': String(PDF.basePages),
    'pdf.baseUnits': String(PDF.baseUnits),
    'pdf.extraPagesPerUnit': String(PDF.extraPagesPerUnit),
    'pdf.maxUnits': String(pdfUnits(PDF.maxPages)),
    'pdf.maxHtmlKb': formatCount(PDF.maxHtmlBytes / KB),
    'pdf.maxHtmlMb': inUnits(PDF.maxHtmlBytes, MB),
    'pdf.maxCssKb': inUnits(PDF.maxCssBytes, KB),
    'pdf.maxAssetMb': inUnits(PDF.maxAssetBytes, MB),
    'pdf.maxRequestBodyMb': inUnits(PDF.maxRequestBodyBytes, MB),
    'pdf.maxPdfMb': inUnits(PDF.maxPdfBytes, MB),
    'pdf.failedRenderMemoryMinutes': String(PDF.failedRenderMemoryMs / 60_000),
    'pdf.duplicateWaitSeconds': String(pdfDuplicateWaitMs() / 1000),
    'pdf.maxHeaderFooterKb': inUnits(PDF.maxHeaderFooterBytes, KB),
    'pdf.renderTimeoutSeconds': String(PDF.renderTimeoutMs / 1000),
    'pdf.maxMarginMm': String(PDF.maxMarginMm),
    'pdf.defaultMarginMm': String(PDF.defaultMarginMm),
    'pdf.maxDataKeys': String(PDF.maxDataKeys),
    'pdf.maxDataValueChars': formatCount(PDF.maxDataValueChars),
    'pdf.maxItems': String(PDF.maxItems),
    'pdf.maxItemFields': String(PDF.maxItemFields),
    'pdf.maxItemValueChars': formatCount(PDF.maxItemValueChars),
    'pdf.maxElements': formatCount(PDF.maxElements),
    'pdf.maxDepth': String(PDF.maxDepth),
    'pdf.maxRemoteAssets': String(PDF.maxRemoteAssets),
    'pdf.maxFilenameChars': String(PDF.maxFilenameChars),
    'pdf.freeMark': PDF.freeMark,
    'pdf.freeMarkMinBottomMm': String(PDF.freeMarkMinBottomMm),
    'pdf.toolPdfsPerHour': String(PDF.toolPdfsPerHour),
    'pdf.toolTurnstileAfterPdfs': String(PDF.toolTurnstileAfterPdfs),
    'pdf.maxFailedRendersPerDayFree': String(PDF.maxFailedRendersPerDay.free),
    'pdf.maxFailedRendersPerDayPaid': String(PDF.maxFailedRendersPerDay.paid),
    'pdf.maxFailedSignedRendersPerDayFree': String(PDF.maxFailedSignedRendersPerDay.free),
    'pdf.maxFailedSignedRendersPerDayPaid': String(PDF.maxFailedSignedRendersPerDay.paid),
    'pdf.browserUsageRetentionDays': String(PDF.browserUsageRetentionDays),
    'pdf.formats': PDF.formats.join(', '),
    'pdf.defaultFormat': PDF.defaultFormat,
    'pdf.templateIds': PDF_TEMPLATES.map((template) => template.id).join(', '),
    'pdf.templateCount': String(PDF_TEMPLATES.length),
    'pdf.sample.invoice': pdfSampleJson('invoice'),
    'pdf.sample.certificate': pdfSampleJson('certificate'),
    // Unformatted, for attributes such as maxlength="..." and data-max-items="...".
    'pdf.raw.maxDataValueChars': String(PDF.maxDataValueChars),
    'pdf.raw.maxItems': String(PDF.maxItems),
    'pdf.raw.maxItemValueChars': String(PDF.maxItemValueChars),
  };
}

function buildTokens(config: SiteConfig, now: Date): Record<string, string> {
  const tokens: Record<string, string> = {
    'site.name': config.name,
    'site.url': config.url,
    'site.host': new URL(config.url).host,
    'site.supportEmail': config.supportEmail,
    'site.year': String(now.getUTCFullYear()),
    'legal.name': config.legalName,
    'legal.address': config.legalAddress,
    'legal.locality': config.legalLocality,
    'legal.updated': longDate(config.legalUpdated),
    'legal.updatedIso': config.legalUpdated,
    'legal.governingLaw': config.governingLaw,
    'topup.price': formatUsd(TOPUP.priceUsd),
    'topup.images': formatCount(TOPUP.images),
    'topup.validDays': String(TOPUP.validDays),
    'topup.paddleName': TOPUP.paddleProductName,
    'limit.maxHtmlKb': String(LIMITS.maxHtmlBytes / KB),
    'limit.maxCssKb': String(LIMITS.maxCssBytes / KB),
    'limit.maxNodes': formatCount(LIMITS.maxNodes),
    'limit.maxDepth': String(LIMITS.maxDepth),
    'limit.maxTextChars': formatCount(LIMITS.maxTextChars),
    'limit.maxDataKeys': String(LIMITS.maxDataKeys),
    'limit.maxDataValueChars': formatCount(LIMITS.maxDataValueChars),
    'limit.maxImages': String(LIMITS.maxImagesPerRender),
    'limit.maxImageMb': String(LIMITS.maxImageBytes / MB),
    'limit.maxImageMegapixels': String(LIMITS.maxImagePixels / 1_000_000),
    'limit.maxBlurPx': String(LIMITS.maxBlurRadiusPx),
    'limit.maxFilters': String(LIMITS.maxFilterEffects),
    'limit.renderTimeoutSeconds': String(LIMITS.renderTimeoutMs / 1000),
    'limit.maxTemplates': String(LIMITS.maxTemplatesPerUser),
    'limit.maxSites': String(LIMITS.maxSitesPerUser),
    'limit.maxApiKeys': String(LIMITS.maxApiKeysPerUser),
    'limit.maxRequestBodyKb': String(LIMITS.maxRequestBodyBytes / KB),
    'limit.maxSignedUrlChars': formatCount(LIMITS.maxSignedUrlChars),
    'auth.magicLinkMinutes': String(AUTH.magicLinkTtlMs / 60_000),
    'auth.sessionDays': String(AUTH.sessionTtlMs / DAY_MS),
    'http.imageMaxAgeSeconds': String(HTTP_CACHE.imageMaxAgeSeconds),
  };
  for (const id of PLAN_ORDER) Object.assign(tokens, planTokens(PLANS[id]));
  // The v3 modules print the numbers of their own pages; no token name is defined twice.
  for (const extra of [pdfTokens(), localPdfTokens(), v3SiteTokens(), previewsSiteTokens(), emailSiteTokens()]) {
    for (const [name, value] of Object.entries(extra)) {
      if (Object.hasOwn(tokens, name)) throw new Error(`token [[${name}]] is defined twice`);
      tokens[name] = value;
    }
  }
  for (const size of Object.values(SIZES)) {
    tokens[`size.${size.id}.width`] = String(size.width);
    tokens[`size.${size.id}.height`] = String(size.height);
  }
  const start = playgroundStart();
  Object.assign(tokens, {
    'playground.title': start.values.title,
    'playground.description': start.values.description,
    'playground.author': start.values.author,
    'playground.slug': linkSlug(start.values.title),
    'playground.snippet': metaTagSnippet(config.url, start.template, start.values),
  });
  return tokens;
}

/** Tokens that print a config value which is still a placeholder. */
function placeholderTokens(config: SiteConfig): Set<string> {
  const byToken: Record<string, string> = {
    'site.name': config.name,
    'site.supportEmail': config.supportEmail,
    'legal.name': config.legalName,
    'legal.address': config.legalAddress,
    'legal.locality': config.legalLocality,
    'legal.governingLaw': config.governingLaw,
  };
  return new Set(Object.keys(byToken).filter((name) => isPlaceholder(byToken[name] ?? '')));
}

// A leading backslash (\[[name]]) prints the brackets literally.
const TOKEN_RE = /(\\?)\[\[(?:>\s*([a-z][a-z0-9-]*)\s*|([a-zA-Z][\w.]*))\]\]/g;
const MAX_PARTIAL_DEPTH = 8;

/** Markdown would split an HTML block at a blank line, so included partials have none. */
const squeeze = (html: string): string => html.trim().replace(/\n\s*\n/g, '\n');

/**
 * Replaces [[name]] tokens and [[> partial]] includes. `html` mode escapes
 * values and highlights placeholders; `text` mode (front matter) returns the
 * raw value because the layout escapes it later.
 */
function expand(source: string, ctx: TokenContext, file: string, mode: 'html' | 'text', depth = 0): string {
  return source.replace(TOKEN_RE, (match: string, escaped: string, partial?: string, name?: string): string => {
    if (escaped) return match.slice(1);
    if (partial !== undefined) {
      const body = ctx.partials[partial];
      if (body === undefined) throw new Error(`${file}: unknown partial [[> ${partial}]]`);
      if (depth >= MAX_PARTIAL_DEPTH) throw new Error(`${file}: partial [[> ${partial}]] includes itself`);
      return squeeze(expand(body, ctx, file, mode, depth + 1));
    }
    const value = ctx.tokens[name ?? ''];
    if (value === undefined) throw new Error(`${file}: unknown token [[${name}]]`);
    if (mode === 'text') return value;
    const safe = escapeHtml(value);
    return ctx.placeholders.has(name ?? '') ? `<mark class="placeholder">${safe}</mark>` : safe;
  });
}

// ------------------------------------------------------------------ generated partials

/** Form fields of the landing-page playground, in the order playground.js puts them in a URL. */
const PLAYGROUND_FIELDS = ['title', 'description', 'author', 'theme'] as const;
type PlaygroundValues = Record<(typeof PLAYGROUND_FIELDS)[number], string>;

/** A starter template's own sample, cut down to what the playground form can send. */
function playgroundValues(sample: Readonly<Record<string, string>>): PlaygroundValues {
  return {
    title: sample.title ?? '',
    description: sample.description ?? '',
    author: sample.author ?? '',
    theme: sample.theme === 'dark' ? 'dark' : 'light',
  };
}

/** The playground opens on the first starter template with its sample text, so the pre-rendered image matches the form. */
function playgroundStart(): { template: string; values: PlaygroundValues } {
  const first = RENDER_TEMPLATES[0];
  if (!first) throw new Error('src/render/templates exports no starter template');
  return { template: first.id, values: playgroundValues(first.sample) };
}

/** Same output as linkSlug() in site/public/assets/js/playground.js (tests/node/site.test.ts compares them). */
function linkSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'your-page';
}

/** Same output as metaTagSnippet() in playground.js for the form's starting values (compared by the same test). */
function metaTagSnippet(origin: string, template: string, values: PlaygroundValues): string {
  const params = new URLSearchParams();
  for (const name of PLAYGROUND_FIELDS) {
    if (values[name]) params.set(name, values[name]);
  }
  params.set('sig', 'YOUR_SIGNATURE');
  const content = `${origin}/v1/og/YOUR_SITE_ID/${template}.png?${params}`.replace(/&/g, '&amp;');
  return [
    `<meta property="og:image" content="${content}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${content}">`,
  ].join('\n');
}

const samplePath = (id: string): string => `assets/img/samples/${id}.png`;
const hasSample = (siteDir: string, id: string): boolean => existsSync(join(siteDir, 'public', samplePath(id)));

const plural = (n: number, word: string): string => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

const fontAllowance = (plan: Plan): string =>
  plan.fonts.maxFiles === 0
    ? 'Bundled fonts only'
    : `${plural(plan.fonts.maxFiles, 'custom font file')}, up to ${plan.fonts.maxBytesPerFile / MB} MB each`;

const topUpAllowance = (plan: Plan): string =>
  plan.topUps ? `${formatUsd(TOPUP.priceUsd)} per ${formatCount(TOPUP.images)} images` : 'Not available';

/** What a plan's PDFs look like: the Free plan prints the mark in every page's footer (src/pdf/service.ts planMark). */
const pdfMarkLine = (plan: Plan): string => (plan.watermark ? `PDFs carry a “${PDF.freeMark}” footer line` : 'PDFs without a footer mark');

/** "Start free" is the one primary action on the site, so the paid plans get the quieter button. */
function planCard(plan: Plan, site: SiteFeatures): string {
  const paid = plan.paddleProductName !== null;
  const features = [
    `Rendered images cached for ${plan.cacheDays} days`,
    plan.watermark ? 'Small watermark in one corner' : 'No watermark',
    ...(site.pdf ? [pdfMarkLine(plan)] : []),
    fontAllowance(plan),
    plan.topUps ? `Top-ups: ${topUpAllowance(plan)}` : 'No top-ups: a hard stop at the limit',
    plan.support,
  ];
  const action = paid
    ? `<a class="btn btn-secondary btn-block" href="/pricing?checkout=${plan.id}" data-checkout="${plan.id}">Choose ${escapeHtml(plan.name)}</a>`
    : '<a class="btn btn-primary btn-block" href="/login">Start free</a>';
  const smallPrint = paid
    ? `Billed by Paddle as &ldquo;${escapeHtml(plan.paddleProductName ?? '')}&rdquo;.`
    : 'No card required.';
  return `<article class="plan" data-plan="${plan.id}">
<h3 class="plan-name">${escapeHtml(plan.name)}</h3>
<p class="plan-price"><span class="plan-amount">${formatUsd(plan.priceUsd)}</span> <span class="plan-period">per month</span></p>
<p class="plan-quota"><strong>${formatCount(plan.monthlyImages)}</strong> images per month</p>
<ul class="plan-features">
${features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join('\n')}
</ul>
${action}
<p class="plan-billing">${smallPrint}</p>
</article>`;
}

const pricingTable = (site: SiteFeatures): string => `<div class="plans">\n${PLAN_ORDER.map((id) => planCard(PLANS[id], site)).join('\n')}\n</div>`;

function htmlTable(head: string[], rows: string[][]): string {
  const cells = (tag: 'th' | 'td', values: string[], rowHeader: boolean): string =>
    values
      .map((value, i) => (rowHeader && i === 0 ? `<th scope="row">${escapeHtml(value)}</th>` : `<${tag}>${escapeHtml(value)}</${tag}>`))
      .join('');
  return `<div class="table-wrap"><table class="table">
<thead><tr>${cells('th', head, false)}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${cells('td', row, true)}</tr>`).join('\n')}
</tbody>
</table></div>`;
}

function limitsTable(site: SiteFeatures): string {
  const plans = PLAN_ORDER.map((id) => PLANS[id]);
  const perPlan = (label: string, value: (plan: Plan) => string): string[] => [label, ...plans.map(value)];
  const planRows = [
    perPlan('Price per month', (plan) => formatUsd(plan.priceUsd)),
    perPlan('Images per month', (plan) => formatCount(plan.monthlyImages)),
    perPlan('Rendered image cached for', (plan) => `${plan.cacheDays} days`),
    perPlan('Watermark', (plan) => (plan.watermark ? 'Small corner mark' : 'None')),
    perPlan('Custom fonts', (plan) => (plan.fonts.maxFiles === 0 ? 'Not available' : fontAllowance(plan))),
    perPlan('Top-up', topUpAllowance),
    // The per-plan limits of build v3 tools, published with their features (src/config.ts BATCH, EMAIL_FIELDS).
    ...(site.batch ? [perPlan('Rows per bulk-documents batch', (plan) => formatCount(BATCH.maxRows[plan.id]))] : []),
    ...(site.email ? [perPlan('New personalized email images per site per day', (plan) => formatCount(EMAIL_FIELDS.maxUniqueRendersPerDay[plan.id]))] : []),
    perPlan('Support', (plan) => plan.support),
  ];
  const sizes = Object.values(SIZES).map((size) => `${size.width} x ${size.height} (${size.id})`).join(', ');
  const sharedRows = [
    ['Output sizes', sizes],
    ['Output formats', FORMATS.join(', ')],
    ['Template HTML', `${LIMITS.maxHtmlBytes / KB} KB`],
    ['Template CSS', `${LIMITS.maxCssBytes / KB} KB`],
    ['Elements per template', formatCount(LIMITS.maxNodes)],
    ['Nesting depth', String(LIMITS.maxDepth)],
    ['Visible text per card', `${formatCount(LIMITS.maxTextChars)} characters`],
    ['Data values per request', `${LIMITS.maxDataKeys} keys, ${formatCount(LIMITS.maxDataValueChars)} characters each`],
    ['Remote images per render', `${LIMITS.maxImagesPerRender}, up to ${LIMITS.maxImageBytes / MB} MB and ${LIMITS.maxImagePixels / 1_000_000} megapixels each`],
    ['Blur radius', `${LIMITS.maxBlurRadiusPx} px for box-shadow and text-shadow; ${LIMITS.maxBlurRadiusPx / 2} px for filter: blur(), drop-shadow() and backdrop-filter`],
    ['Shadow and filter effects per card', String(LIMITS.maxFilterEffects)],
    ['Render time', `${LIMITS.renderTimeoutMs / 1000} seconds`],
    ['Request body', `${LIMITS.maxRequestBodyBytes / KB} KB`],
    ['Signed URL length', `${formatCount(LIMITS.maxSignedUrlChars)} characters`],
    ['Templates per account', String(LIMITS.maxTemplatesPerUser)],
    ['Sites per account', String(LIMITS.maxSitesPerUser)],
    ['API keys per account', String(LIMITS.maxApiKeysPerUser)],
  ];
  return `${htmlTable(['', ...plans.map((plan) => plan.name)], planRows)}
<p class="table-caption">The same on every plan:</p>
${htmlTable(['Limit', 'Value'], sharedRows)}`;
}

/**
 * The feature a limiter belongs to, or null for one that is always published: RL_PDF_TOOLS (the
 * PDF toolkit) is published with "toolkit", the other PDF limiters (RL_PDF_KEY, RL_PDF_FREE,
 * RL_TOOLS_PDF) with "pdf".
 */
export function rateLimitFeature(name: RateLimitName): Feature | null {
  if (name === 'RL_PDF_TOOLS') return 'toolkit';
  return /_PDF(?:_|$)/.test(name) ? 'pdf' : null;
}

/** The limiters published only with the PDF pages. */
export const isPdfRateLimit = (name: RateLimitName): boolean => rateLimitFeature(name) === 'pdf';

/**
 * A limiter's scope as published: RATE_LIMITS' text, plus the routes of published features that
 * count against it too (review CC-2). With no v3 feature published the text is RATE_LIMITS' own.
 */
export function rateLimitScope(name: RateLimitName, site: SiteFeatures): string {
  const scope = RATE_LIMITS[name].scope;
  if (name === 'RL_KEY') {
    const also = [
      ...(site.linkcards ? ['POST /v1/cards/from-url'] : []),
      ...(site.batch ? ['every /v1/batches request', 'POST /v1/certificates/{id}/revoke'] : []),
    ];
    return also.length === 0 ? scope : scope.replace('(POST /v1/images)', `(POST /v1/images, ${also.join(', ')})`);
  }
  if (name === 'RL_IP' && site.batch) return `${scope}; also GET /v/{id} and /v/{id}.json`;
  return scope;
}

function rateLimitsTable(site: SiteFeatures): string {
  const period = (seconds: number): string => (seconds === 60 ? 'minute' : `${seconds} seconds`);
  const names = (Object.keys(RATE_LIMITS) as RateLimitName[]).filter((name) => {
    const feature = rateLimitFeature(name);
    return feature === null || site[feature];
  });
  const rows = names.map((name) => {
    const rule = RATE_LIMITS[name];
    const text = rateLimitScope(name, site);
    const scope = text.charAt(0).toUpperCase() + text.slice(1);
    return [scope, `${formatCount(rule.limit)} requests per ${period(rule.periodSeconds)}`];
  });
  return htmlTable(['Applies to', 'Limit'], rows);
}

/** "1-10 pages" -> 2 images, "11-20 pages" -> 3, ...: every page count from 1 to PDF.maxPages, grouped by pdfUnits(). */
export function pdfUnitRows(): Array<{ from: number; to: number; units: number }> {
  const rows: Array<{ from: number; to: number; units: number }> = [];
  for (let pages = 1; pages <= PDF.maxPages; pages++) {
    const units = pdfUnits(pages);
    const last = rows.at(-1);
    if (last && last.units === units) last.to = pages;
    else rows.push({ from: pages, to: pages, units });
  }
  return rows;
}

function pdfUnitsTable(): string {
  const range = ({ from, to }: { from: number; to: number }): string => (from === to ? `${from} ${from === 1 ? 'page' : 'pages'}` : `${from}-${to} pages`);
  return htmlTable(
    ['PDF length', 'Counts as'],
    pdfUnitRows().map((row) => [range(row), plural(row.units, 'image')]),
  );
}

function pdfLimitsTable(): string {
  const formats = PDF.formats.map((format) => (format === PDF.defaultFormat ? `${format} (default)` : format)).join(', ');
  return htmlTable(
    ['Limit', 'Value'],
    [
      ['Pages per PDF', `${PDF.maxPages}; a longer document is refused (HTTP 422) and not charged`],
      ['PDF size', `${inUnits(PDF.maxPdfBytes, MB)} MB; a larger PDF is refused (HTTP 422) and not charged`],
      ['Paper formats', `${formats}; portrait or landscape`],
      ['Page margins', `Up to ${PDF.maxMarginMm} mm on each side; ${PDF.defaultMarginMm} mm when neither the request nor the template sets one`],
      ['Template HTML, after placeholders are filled in', `${inUnits(PDF.maxHtmlBytes, MB)} MB`],
      [
        'Template saved in the dashboard',
        `${LIMITS.maxHtmlBytes / KB} KB HTML, ${LIMITS.maxCssBytes / KB} KB CSS, ${formatCount(LIMITS.maxNodes)} elements nested at most ${LIMITS.maxDepth} deep (the card template limits); send larger documents inline`,
      ],
      ['Template CSS', `${inUnits(PDF.maxCssBytes, KB)} KB`],
      ['Header or footer template', `${inUnits(PDF.maxHeaderFooterBytes, KB)} KB each`],
      ['Elements after sections are repeated', `${formatCount(PDF.maxElements)}, nested at most ${PDF.maxDepth} deep`],
      ['Remote images per PDF', `${PDF.maxRemoteAssets} different URLs, ${inUnits(PDF.maxAssetBytes, MB)} MB together`],
      ['Data values', `${PDF.maxDataKeys} keys, ${formatCount(PDF.maxDataValueChars)} characters each`],
      ['List items (items)', `${PDF.maxItems} entries, ${PDF.maxItemFields} fields each, ${formatCount(PDF.maxItemValueChars)} characters per field`],
      ['Render time', `${PDF.renderTimeoutMs / 1000} seconds for loading and ${PDF.renderTimeoutMs / 1000} seconds for printing`],
      [
        'Failed renders (the document failed in the browser, or needed more images than were left)',
        `${PDF.maxFailedRendersPerDay.free} per UTC day on ${PLANS.free.name}, ${PDF.maxFailedRendersPerDay.paid} on ${PLANS.starter.name} and ${PLANS.pro.name}, ` +
          'per account for POST /v1/pdf and per site for signed PDF links; then new PDFs there answer HTTP 429 until 00:00 UTC. ' +
          `Signed PDF links of all of an account's sites together: ${PDF.maxFailedSignedRendersPerDay.free} on ${PLANS.free.name}, ${PDF.maxFailedSignedRendersPerDay.paid} on paid plans`,
      ],
      ['A failed document sent again', `the same answer, without rendering or counting, for ${PDF.failedRenderMemoryMs / 60_000} minutes`],
      ['Request body', `${inUnits(PDF.maxRequestBodyBytes, MB)} MB`],
      ['File name', `${PDF.maxFilenameChars} characters, ending in .pdf`],
    ],
  );
}

/** Paper sizes as the tool pages name them; a format added to PDF.formats fails the type check until it has a label. */
const PAPER_LABELS: Record<PdfFormat, string> = {
  a4: 'A4 (210 x 297 mm)',
  letter: 'US Letter (8.5 x 11 in)',
  a5: 'A5 (148 x 210 mm)',
};

/** The <option>s of a paper-size <select>, with the default format selected. */
function pdfFormatOptions(): string {
  return PDF.formats.map((format) => `<option value="${format}"${format === PDF.defaultFormat ? ' selected' : ''}>${escapeHtml(PAPER_LABELS[format])}</option>`).join('');
}

/**
 * The PDF starter templates for /docs/pdf: description, page setup and every data key, with
 * the list fields of `items`. Generated from src/pdf/templates, so the docs list exactly the
 * keys the templates use.
 */
function pdfTemplateList(): string {
  const sections = PDF_TEMPLATES.map((template) => {
    const { format, landscape } = template.defaultPdf;
    const rows = template.fields.map((field) => {
      const key = field.kind === 'items' ? `<code>${field.key}</code>: a list; each entry has ${(field.itemFields ?? []).map((name) => `<code>${name}</code>`).join(', ')}` : `<code>${field.key}</code>`;
      return `<tr><td>${key}</td><td>${escapeHtml(field.label)}</td><td>${field.required ? 'Yes' : ''}</td></tr>`;
    });
    return `<h3 id="template-${template.id}"><code>${template.id}</code>: ${escapeHtml(template.name)}</h3>
<p>${escapeHtml(template.description)} ${format.toUpperCase()}, ${landscape ? 'landscape' : 'portrait'}.</p>
<div class="table-wrap"><table class="table">
<thead><tr><th>Key</th><th>What it is</th><th>Required</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table></div>`;
  });
  return sections.join('\n');
}

/**
 * The playground's template choice: five thumbnails. Each radio carries its
 * template's sample text, so browsing templates swaps in a pre-rendered image
 * and its matching text without calling the API.
 */
function templatePicker(siteDir: string): string {
  const options = RENDER_TEMPLATES.map(({ id, sample }, i) => {
    const values = playgroundValues(sample);
    const data = PLAYGROUND_FIELDS.map((name) => ` data-${name}="${escapeHtml(values[name])}"`).join('');
    const picture = hasSample(siteDir, id)
      ? `<img src="/${samplePath(id)}" alt="" width="1200" height="630">`
      : '<span class="thumb-blank" aria-hidden="true"></span>';
    return `<label class="thumb"><input type="radio" name="template" value="${id}"${i === 0 ? ' checked' : ''}${data}>${picture}<span>${id}</span></label>`;
  });
  return `<div class="thumbs" role="radiogroup" aria-label="Template">\n${options.join('\n')}\n</div>`;
}

/** First paint of the playground: the pre-rendered sample. Without one, playground.js renders through the API on load. */
function playgroundImage(siteDir: string): string {
  const { template } = playgroundStart();
  const source = hasSample(siteDir, template) ? ` src="/${samplePath(template)}"` : ' hidden';
  return `<img id="pg-image"${source} alt="Live preview of the share card" width="1200" height="630">`;
}

/** The starter templates as printed cards. A sample PNG that does not exist yet renders as a neutral box. */
function templateGallery(siteDir: string): string {
  const figures = RENDER_TEMPLATES.map(({ id, name }) => {
    const frame = hasSample(siteDir, id)
      ? `<img src="/${samplePath(id)}" alt="Sample card made with the ${id} template" width="1200" height="630" loading="lazy">`
      : `<div class="sample-missing" role="img" aria-label="Sample for the ${id} template is not available yet">${id}</div>`;
    return `<figure class="sample">
<div class="sample-frame">${frame}</div>
<figcaption><code>${id}</code> <span>${escapeHtml(name)}</span></figcaption>
</figure>`;
  });
  return `<div class="gallery">\n${figures.join('\n')}\n</div>\n`;
}

// ------------------------------------------------------------------ sources

/** Files under dir as sorted, "/"-separated relative paths. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...walk(join(dir, entry.name)).map((file) => `${entry.name}/${file}`));
    else files.push(entry.name);
  }
  return files.sort();
}

function loadPartials(paths: Paths, features: SiteFeatures): Record<string, string> {
  const partials: Record<string, string> = {
    'pricing-table': pricingTable(features),
    'limits-table': limitsTable(features),
    'rate-limits-table': rateLimitsTable(features),
    'template-picker': templatePicker(paths.siteDir),
    'playground-image': playgroundImage(paths.siteDir),
    'template-gallery': templateGallery(paths.siteDir),
    // Used only by `feature: pdf` pages; harmless to build when the feature is off.
    'pdf-units-table': pdfUnitsTable(),
    'pdf-limits-table': pdfLimitsTable(),
    'pdf-templates': pdfTemplateList(),
    'pdf-format-options': pdfFormatOptions(),
  };
  const dir = join(paths.siteDir, 'partials');
  for (const file of walk(dir).filter((name) => name.endsWith('.html'))) {
    const name = file.slice(0, -'.html'.length);
    if (partials[name] !== undefined) throw new Error(`${display(join(dir, file))}: "${name}" is a generated partial`);
    partials[name] = applyFeatureBlocks(readFileSync(join(dir, file), 'utf8'), features, display(join(dir, file)));
  }
  return partials;
}

function tokenContext(paths: Paths, options: BuildOptions): { config: SiteConfig; ctx: TokenContext } {
  const env = options.env ?? process.env;
  const config = loadConfig(join(paths.siteDir, 'site.config.json'), env);
  const features = siteFeatures(env);
  const ctx: TokenContext = {
    tokens: buildTokens(config, options.now ?? new Date()),
    placeholders: placeholderTokens(config),
    partials: loadPartials(paths, features),
    features,
  };
  return { config, ctx };
}

function parseFrontMatter(source: string, file: string): { data: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error(`${file}: missing front matter (a "---" block with title and description)`);
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`${file}: front matter line is not "key: value": ${line}`);
    const value = line.slice(colon + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    data[line.slice(0, colon).trim()] = quoted ? (quoted[2] ?? '') : value;
  }
  return { data, body: source.slice(match[0].length) };
}

function slugify(text: string, used: Map<string, number>): string {
  const base = text.toLowerCase().replace(/&[a-z0-9#]+;/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

/** GitHub-flavoured Markdown with heading anchors, copyable code blocks and scrollable tables. */
function renderMarkdown(markdown: string): string {
  const used = new Map<string, number>();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading): string {
        const inner = this.parser.parseInline(tokens);
        const id = slugify(inner.replace(/<[^>]+>/g, ''), used);
        const anchor = depth > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : '';
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      code({ text, lang, escaped }: Tokens.Code): string {
        const language = /^[\w+#.-]+/.exec(lang ?? '')?.[0] ?? '';
        const attrs = language ? ` data-lang="${language}"` : '';
        const cls = language ? ` class="language-${language}"` : '';
        const body = escaped ? text : escapeHtml(text);
        return `<div class="code-block"${attrs}><button class="copy-btn" type="button" data-copy>Copy</button><pre><code${cls}>${body}</code></pre></div>\n`;
      },
      table(token: Tokens.Table): string {
        return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}

const LAYOUTS: readonly Layout[] = ['site', 'page', 'doc', 'legal'];

/** A page, or null when its front matter names a feature this build leaves out. */
function loadPage(root: string, rel: string, kind: 'content' | 'page', ctx: TokenContext): PageSource | null {
  const source = display(join(root, rel));
  const outPath = rel.replace(/\.(md|html)$/, '.html');
  if (/(^|\/)index\.html$/.test(outPath) && !(kind === 'page' && outPath === 'index.html')) {
    throw new Error(`${source}: would emit ${outPath}; pages are flat files (write docs.md, not docs/index.md)`);
  }
  const text = applyFeatureBlocks(readFileSync(join(root, rel), 'utf8'), ctx.features, source);
  const { data, body } = parseFrontMatter(text, source);
  if (data.feature !== undefined && !switchedOn(parseSwitch(data.feature, source), ctx.features)) return null;
  const field = (key: string): string => expand(data[key] ?? '', ctx, source, 'text');
  const title = field('title');
  const description = field('description');
  if (!title || !description) throw new Error(`${source}: front matter needs both "title" and "description"`);
  const layout = (data.layout ?? (kind === 'content' ? 'page' : 'site')) as Layout;
  if (!LAYOUTS.includes(layout)) throw new Error(`${source}: unknown layout "${layout}" (use ${LAYOUTS.join(', ')})`);
  const order = data.order === undefined ? Number.MAX_SAFE_INTEGER : Number(data.order);
  if (Number.isNaN(order)) throw new Error(`${source}: "order" must be a number`);
  const expanded = expand(body, ctx, source, 'html');
  const stem = outPath.slice(0, -'.html'.length);
  return {
    source,
    outPath,
    url: stem === 'index' ? '/' : `/${stem}`,
    layout,
    title,
    description,
    nav: field('nav') || title,
    order,
    indexed: data.noindex !== 'true',
    scripts: (data.scripts ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    content: kind === 'content' ? renderMarkdown(expanded) : expanded,
  };
}

function loadPages(paths: Paths, ctx: TokenContext): PageSource[] {
  const pagesDir = join(paths.siteDir, 'pages');
  const pages = [
    ...walk(pagesDir).filter((file) => file.endsWith('.html')).map((file) => loadPage(pagesDir, file, 'page', ctx)),
    ...walk(paths.contentDir).filter((file) => file.endsWith('.md')).map((file) => loadPage(paths.contentDir, file, 'content', ctx)),
  ].filter((page): page is PageSource => page !== null);
  const seen = new Map<string, string>();
  for (const page of pages) {
    const other = seen.get(page.outPath);
    if (other) throw new Error(`${page.source}: writes ${page.outPath}, which ${other} already writes`);
    seen.set(page.outPath, page.source);
  }
  return pages;
}

// ------------------------------------------------------------------ layouts

/** Fills {{slot}} markers in a layout. Inserted values are never re-scanned, so content may contain "{{...}}". */
function fill(template: string, slots: Record<string, string>, file: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string): string => {
    const value = slots[key];
    if (value === undefined) throw new Error(`${file}: unknown slot {{${key}}}`);
    return value;
  });
}

function docsSidebar(docs: PageSource[], current: PageSource): string {
  const items = docs.map((doc) => {
    const active = doc === current ? ' aria-current="page"' : '';
    return `<li><a href="${doc.url}"${active}>${escapeHtml(doc.nav)}</a></li>`;
  });
  return `<nav class="docs-nav" aria-label="Documentation">\n<ul>\n${items.join('\n')}\n</ul>\n</nav>`;
}

function docsPager(docs: PageSource[], current: PageSource): string {
  const at = docs.indexOf(current);
  const link = (doc: PageSource | undefined, rel: 'prev' | 'next', label: string): string =>
    doc ? `<a class="pager-${rel}" rel="${rel}" href="${doc.url}"><span>${label}</span>${escapeHtml(doc.nav)}</a>` : '<span></span>';
  return `<nav class="pager" aria-label="Previous and next page">${link(docs[at - 1], 'prev', 'Previous')}${link(docs[at + 1], 'next', 'Next')}</nav>`;
}

function renderPage(page: PageSource, layouts: Record<Layout | 'base', string>, docs: PageSource[], config: SiteConfig): string {
  // Authors may or may not write their own <h1> and "Last updated" line; the layout supplies whichever is missing.
  const heading = /<h1[\s>]/.test(page.content) ? '' : `<h1>${escapeHtml(page.title)}</h1>`;
  const updated = /last updated/i.test(page.content)
    ? ''
    : `<p class="eyebrow">Last updated <time datetime="${config.legalUpdated}">${longDate(config.legalUpdated)}</time></p>`;
  const body =
    page.layout === 'site'
      ? page.content
      : fill(
          layouts[page.layout],
          { heading, updated, content: page.content, sidebar: docsSidebar(docs, page), pager: docsPager(docs, page) },
          `site/layouts/${page.layout}.html`,
        );
  const title = page.title.includes(config.name) ? page.title : `${page.title} - ${config.name}`;
  return fill(
    layouts.base,
    {
      title: escapeHtml(title),
      description: escapeHtml(page.description),
      canonical: `${config.url}${page.url}`,
      robots: page.indexed ? '' : '<meta name="robots" content="noindex">\n',
      body,
      scripts: page.scripts.map((name) => `<script type="module" src="/assets/js/${name}.js"></script>`).join('\n'),
    },
    'site/layouts/base.html',
  );
}

function renderSitemap(pages: PageSource[], config: SiteConfig): string {
  const urls = pages.filter((page) => page.indexed).map((page) => `  <url><loc>${escapeHtml(config.url + page.url)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.sort().join('\n')}\n</urlset>\n`;
}

// ------------------------------------------------------------------ public API

/** Every [[token]] with its value and every [[> partial]] name, without rendering any page. */
export function listTokens(options: BuildOptions = {}): TokenListing {
  const { ctx } = tokenContext(resolvePaths(options), options);
  return { tokens: ctx.tokens, partials: Object.keys(ctx.partials).sort() };
}

/** openapi.yaml as published: the paths and schemas of features that are off are left out. */
function renderOpenapi(features: SiteFeatures): string {
  return applyFeatureBlocks(readFileSync(join(ROOT, 'openapi.yaml'), 'utf8'), features, 'openapi.yaml', 'yaml');
}

function renderWith(paths: Paths, config: SiteConfig, ctx: TokenContext): RenderedSite {
  const layoutFile = (name: string): string => join(paths.siteDir, 'layouts', `${name}.html`);
  const layout = (name: string): string => {
    const file = display(layoutFile(name));
    return expand(applyFeatureBlocks(readFileSync(layoutFile(name), 'utf8'), ctx.features, file), ctx, file, 'html');
  };
  const layouts = { base: layout('base'), site: '', page: layout('page'), doc: layout('doc'), legal: layout('legal') };
  const sources = loadPages(paths, ctx);
  const docs = sources
    .filter((page) => page.layout === 'doc')
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const pages = sources.map((page) => ({
    source: page.source,
    outPath: page.outPath,
    url: page.url,
    indexed: page.indexed,
    html: renderPage(page, layouts, docs, config),
  }));
  return { config, features: ctx.features, pages, sitemap: renderSitemap(sources, config), openapi: renderOpenapi(ctx.features) };
}

/** Renders every page in memory. Throws (naming the file) on an unknown token, partial or layout. */
export function renderSite(options: BuildOptions = {}): RenderedSite {
  const paths = resolvePaths(options);
  const { config, ctx } = tokenContext(paths, options);
  return renderWith(paths, config, ctx);
}

const VENDOR_FILES: ReadonlyArray<{ from: string; to: string }> = [
  ...[400, 500, 600, 700].map((weight) => ({
    from: `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
    to: `assets/fonts/inter-latin-${weight}-normal.woff2`,
  })),
  { from: '@fontsource/inter/LICENSE', to: 'assets/fonts/inter-LICENSE.txt' },
  { from: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', to: 'assets/fonts/jetbrains-mono-latin-400-normal.woff2' },
  { from: '@fontsource/jetbrains-mono/LICENSE', to: 'assets/fonts/jetbrains-mono-LICENSE.txt' },
  ...['normal', 'italic'].map((style) => ({
    from: `@fontsource/source-serif-4/files/source-serif-4-latin-900-${style}.woff2`,
    to: `assets/fonts/source-serif-4-latin-900-${style}.woff2`,
  })),
  { from: '@fontsource/source-serif-4/LICENSE', to: 'assets/fonts/source-serif-4-LICENSE.txt' },
  { from: '@twemoji/svg/license', to: '_emoji/LICENSE.txt' },
];

/** Public files that carry [[tokens]]; everything else in site/public is copied byte for byte. */
const TOKENIZED_PUBLIC_FILES = new Set(['robots.txt']);

/**
 * Renders the site and writes the output directory: pages, sitemap.xml,
 * site/public, self-hosted fonts and the Twemoji SVGs the renderer loads from
 * /_emoji/. Files are overwritten in place and stale ones removed afterwards,
 * so a running `wrangler dev` never sees an empty directory.
 */
export function buildSite(options: BuildOptions = {}): RenderedSite & { outDir: string } {
  const paths = resolvePaths(options);
  // Stale files are deleted from the output directory, so it must never be a source directory.
  if (['package.json', 'site.config.json', '.git'].some((name) => existsSync(join(paths.outDir, name)))) {
    throw new Error(`${paths.outDir}: refusing to build into a source directory`);
  }
  const { config, ctx } = tokenContext(paths, options);
  const site = renderWith(paths, config, ctx);
  const publicDir = join(paths.siteDir, 'public');
  // Without the engine the in-browser tools would load and then fail on the first file.
  if (site.features.toolkit && !existsSync(join(publicDir, LOCAL_PDF_BUNDLE))) {
    throw new Error(`${display(join(publicDir, LOCAL_PDF_BUNDLE))} is missing: run "npm run build:browser" first (npm run build:site does)`);
  }
  const written = new Set<string>();
  const emit = (rel: string, data: string | Buffer): void => {
    const target = join(paths.outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.add(rel);
  };

  for (const page of site.pages) emit(page.outPath, page.html);
  emit('sitemap.xml', site.sitemap);

  for (const file of walk(publicDir)) {
    const feature = FEATURE_PUBLIC_FILES[file];
    if (feature !== undefined && !site.features[feature]) continue;
    const data = readFileSync(join(publicDir, file));
    emit(file, TOKENIZED_PUBLIC_FILES.has(file) ? expand(data.toString('utf8'), ctx, display(join(publicDir, file)), 'text') : data);
  }

  const modules = join(ROOT, 'node_modules');
  for (const { from, to } of VENDOR_FILES) emit(to, readFileSync(join(modules, from)));
  // The API description the docs link to; kept at the repository root so tools find it there too.
  // The root copy describes every feature; the published one only those this build switches on.
  emit('openapi.yaml', site.openapi);
  const emojiDir = join(modules, '@twemoji/svg');
  for (const file of readdirSync(emojiDir).filter((name) => name.endsWith('.svg'))) {
    emit(`_emoji/${file}`, readFileSync(join(emojiDir, file)));
  }

  for (const file of walk(paths.outDir)) {
    if (!written.has(file)) rmSync(join(paths.outDir, file));
  }
  return { ...site, outDir: paths.outDir };
}

/** Placeholders still visible to visitors: unfilled config values and any <mark class="placeholder"> in a page. */
export function findPlaceholders(site: RenderedSite): Placeholder[] {
  const found = new Map<string, Set<string>>();
  for (const key of CONFIG_KEYS) {
    if (isPlaceholder(site.config[key])) found.set(site.config[key], new Set());
  }
  for (const page of site.pages) {
    for (const match of page.html.matchAll(/<mark class="placeholder">([^<]*)<\/mark>/g)) {
      const value = match[1] ?? '';
      found.set(value, (found.get(value) ?? new Set()).add(page.outPath));
    }
  }
  return [...found].map(([value, pages]) => ({ value, pages: [...pages].sort() }));
}

// ------------------------------------------------------------------ command line

function printTokens(): void {
  const { tokens, partials } = listTokens();
  const width = Math.max(...Object.keys(tokens).map((name) => name.length)) + 4;
  for (const name of Object.keys(tokens).sort()) console.log(`${`[[${name}]]`.padEnd(width)}  ${tokens[name]}`);
  console.log('\nPartials:');
  for (const name of partials) console.log(`[[> ${name}]]`);
}

function checkGoLive(): number {
  const placeholders = findPlaceholders(renderSite());
  if (placeholders.length === 0) {
    console.log('Go-live check passed: no placeholders remain on the site.');
    return 0;
  }
  console.error(`Go-live check FAILED: ${placeholders.length} placeholder(s) remain.`);
  for (const { value, pages } of placeholders) {
    console.error(`  ${value}  (shown on ${pages.length} page(s)${pages.length ? `: ${pages.slice(0, 4).join(', ')}${pages.length > 4 ? ', ...' : ''}` : ''})`);
  }
  console.error('Set the real values in site/site.config.json (or SITE_LEGAL_NAME / SITE_LEGAL_ADDRESS) and rebuild.');
  return 1;
}

function main(argv: string[]): number {
  if (argv.includes('--tokens')) {
    printTokens();
    return 0;
  }
  if (argv.includes('--check-golive')) return checkGoLive();
  const site = buildSite();
  const switches = FEATURES.map((feature) => `${feature} ${site.features[feature] ? 'on' : 'off'}`).join(', ');
  console.log(`Built ${site.pages.length} pages into ${display(site.outDir)} (${site.config.url}; features: ${switches})`);
  const placeholders = findPlaceholders(site);
  if (placeholders.length > 0) {
    console.warn(`Note: placeholders remain (${placeholders.map(({ value }) => value).join(', ')}). Run "npm run build:site -- --check-golive" before go-live.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Site build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
