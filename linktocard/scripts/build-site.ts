/**
 * Static-site build: site/pages + site/content -> site/dist, as flat .html files.
 *
 *   npm run build:site                     build site/dist
 *   npm run build:site -- --tokens         print every [[token]] and partial
 *   npm run build:site -- --check-golive   exit 1 while placeholders remain
 *
 * No framework and no bundler: token expansion, marked and four small layouts.
 * Every number on the site comes from src/billing/plans.ts and src/config.ts,
 * so published prices and limits cannot drift from the enforced ones.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked, Renderer, type Tokens } from 'marked';
import { PLANS, PLAN_ORDER, TOPUP, formatCount, formatUsd, type Plan } from '../src/billing/plans';
import { AUTH, DAY_MS, FORMATS, LIMITS, RATE_LIMITS, SIZES } from '../src/config';
import { STARTER_TEMPLATES as RENDER_TEMPLATES } from '../src/render/templates';

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
  pages: RenderedPage[];
  sitemap: string;
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

const CONFIG_KEYS = ['name', 'url', 'supportEmail', 'legalName', 'legalAddress', 'legalUpdated', 'governingLaw'] as const;

const ENV_OVERRIDES: Partial<Record<keyof SiteConfig, string>> = {
  url: 'SITE_URL',
  legalName: 'SITE_LEGAL_NAME',
  legalAddress: 'SITE_LEGAL_ADDRESS',
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

function buildTokens(config: SiteConfig, now: Date): Record<string, string> {
  const tokens: Record<string, string> = {
    'site.name': config.name,
    'site.url': config.url,
    'site.host': new URL(config.url).host,
    'site.supportEmail': config.supportEmail,
    'site.year': String(now.getUTCFullYear()),
    'legal.name': config.legalName,
    'legal.address': config.legalAddress,
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
  };
  for (const id of PLAN_ORDER) Object.assign(tokens, planTokens(PLANS[id]));
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

/** "Start free" is the one primary action on the site, so the paid plans get the quieter button. */
function planCard(plan: Plan): string {
  const paid = plan.paddleProductName !== null;
  const features = [
    `Rendered images cached for ${plan.cacheDays} days`,
    plan.watermark ? 'Small watermark in one corner' : 'No watermark',
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

const pricingTable = (): string => `<div class="plans">\n${PLAN_ORDER.map((id) => planCard(PLANS[id])).join('\n')}\n</div>`;

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

function limitsTable(): string {
  const plans = PLAN_ORDER.map((id) => PLANS[id]);
  const perPlan = (label: string, value: (plan: Plan) => string): string[] => [label, ...plans.map(value)];
  const planRows = [
    perPlan('Price per month', (plan) => formatUsd(plan.priceUsd)),
    perPlan('Images per month', (plan) => formatCount(plan.monthlyImages)),
    perPlan('Rendered image cached for', (plan) => `${plan.cacheDays} days`),
    perPlan('Watermark', (plan) => (plan.watermark ? 'Small corner mark' : 'None')),
    perPlan('Custom fonts', (plan) => (plan.fonts.maxFiles === 0 ? 'Not available' : fontAllowance(plan))),
    perPlan('Top-up', topUpAllowance),
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
    ['Shadow and blur radius', `${LIMITS.maxBlurRadiusPx} px`],
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

function rateLimitsTable(): string {
  const period = (seconds: number): string => (seconds === 60 ? 'minute' : `${seconds} seconds`);
  const rows = Object.values(RATE_LIMITS).map((rule) => {
    const scope = rule.scope.charAt(0).toUpperCase() + rule.scope.slice(1);
    return [scope, `${formatCount(rule.limit)} requests per ${period(rule.periodSeconds)}`];
  });
  return htmlTable(['Applies to', 'Limit'], rows);
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

function loadPartials(paths: Paths): Record<string, string> {
  const partials: Record<string, string> = {
    'pricing-table': pricingTable(),
    'limits-table': limitsTable(),
    'rate-limits-table': rateLimitsTable(),
    'template-picker': templatePicker(paths.siteDir),
    'playground-image': playgroundImage(paths.siteDir),
    'template-gallery': templateGallery(paths.siteDir),
  };
  const dir = join(paths.siteDir, 'partials');
  for (const file of walk(dir).filter((name) => name.endsWith('.html'))) {
    const name = file.slice(0, -'.html'.length);
    if (partials[name] !== undefined) throw new Error(`${display(join(dir, file))}: "${name}" is a generated partial`);
    partials[name] = readFileSync(join(dir, file), 'utf8');
  }
  return partials;
}

function tokenContext(paths: Paths, options: BuildOptions): { config: SiteConfig; ctx: TokenContext } {
  const config = loadConfig(join(paths.siteDir, 'site.config.json'), options.env ?? process.env);
  const ctx: TokenContext = {
    tokens: buildTokens(config, options.now ?? new Date()),
    placeholders: placeholderTokens(config),
    partials: loadPartials(paths),
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

function loadPage(root: string, rel: string, kind: 'content' | 'page', ctx: TokenContext): PageSource {
  const source = display(join(root, rel));
  const outPath = rel.replace(/\.(md|html)$/, '.html');
  if (/(^|\/)index\.html$/.test(outPath) && !(kind === 'page' && outPath === 'index.html')) {
    throw new Error(`${source}: would emit ${outPath}; pages are flat files (write docs.md, not docs/index.md)`);
  }
  const { data, body } = parseFrontMatter(readFileSync(join(root, rel), 'utf8'), source);
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
  ];
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

function renderWith(paths: Paths, config: SiteConfig, ctx: TokenContext): RenderedSite {
  const layoutFile = (name: string): string => join(paths.siteDir, 'layouts', `${name}.html`);
  const layout = (name: string): string => expand(readFileSync(layoutFile(name), 'utf8'), ctx, display(layoutFile(name)), 'html');
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
  return { config, pages, sitemap: renderSitemap(sources, config) };
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
  const written = new Set<string>();
  const emit = (rel: string, data: string | Buffer): void => {
    const target = join(paths.outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written.add(rel);
  };

  for (const page of site.pages) emit(page.outPath, page.html);
  emit('sitemap.xml', site.sitemap);

  const publicDir = join(paths.siteDir, 'public');
  for (const file of walk(publicDir)) {
    const data = readFileSync(join(publicDir, file));
    emit(file, TOKENIZED_PUBLIC_FILES.has(file) ? expand(data.toString('utf8'), ctx, display(join(publicDir, file)), 'text') : data);
  }

  const modules = join(ROOT, 'node_modules');
  for (const { from, to } of VENDOR_FILES) emit(to, readFileSync(join(modules, from)));
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
  console.log(`Built ${site.pages.length} pages into ${display(site.outDir)} (${site.config.url})`);
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
