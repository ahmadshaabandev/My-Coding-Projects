// Pure helpers for the dashboard: no DOM and no fetch, so every rule here is
// covered by tests/node/dashboard.test.ts.

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'sites', label: 'Sites & URLs' },
  { id: 'templates', label: 'Templates' },
  { id: 'keys', label: 'API keys' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'renders', label: 'Renders' },
];

/**
 * Tabs that only appear while a switch in GET /api/config is on, each placed right after the
 * tab named in `after`. Their modules are imported only when opened (dashboard.js): a site
 * built without the feature does not publish them.
 */
export const FEATURE_TABS = [{ id: 'bulk', label: 'Bulk documents', after: 'templates', flag: 'batch' }];

/** True when /api/config says the feature behind a FEATURE_TABS entry is on: `config[flag].enabled`. */
const tabSwitchedOn = (tab, config) => config?.[tab.flag]?.enabled === true;

/** The tabs this account sees, in order: TABS, plus each feature tab whose switch is on. */
export function dashboardTabs(config) {
  const tabs = TABS.map(({ id, label }) => ({ id, label }));
  for (const tab of FEATURE_TABS) {
    if (!tabSwitchedOn(tab, config)) continue;
    const at = tabs.findIndex((candidate) => candidate.id === tab.after);
    tabs.splice(at === -1 ? tabs.length : at + 1, 0, { id: tab.id, label: tab.label });
  }
  return tabs;
}

/**
 * '#templates/t_1' -> { tab: 'templates', param: 't_1' }. Anything unknown opens the overview,
 * and so does a feature tab that is not in `tabs` (switched off).
 */
export function routeFromHash(hash, tabs = TABS) {
  const [name = '', ...rest] = String(hash).replace(/^#\/?/, '').split('/');
  // The pricing page sends paid accounts to /dashboard#billing; billing lives on the overview.
  if (name === 'billing') return { tab: 'overview', param: 'billing' };
  const known = tabs.some((tab) => tab.id === name);
  return { tab: known ? name : 'overview', param: known ? rest.join('/') : '' };
}

/* ------------------------------------------------------------------ */
/* Templates and card data                                             */
/* ------------------------------------------------------------------ */

// The renderer's own placeholder syntax (src/render/template.ts).
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

/** Placeholder names in a template's HTML, in order of first use. */
export function detectPlaceholders(html) {
  const names = [];
  for (const match of String(html).matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

// Whatever order a template uses them in, a form reads best with these first.
const LEADING_FIELDS = ['title', 'description'];

/**
 * The inputs a custom template needs: one per placeholder (title and
 * description first, the rest in order of first use), plus `theme` when the
 * template styles .theme-dark or .theme-light (theme is a state class, never
 * a placeholder).
 */
export function customTemplateFields(html, css) {
  const found = detectPlaceholders(html);
  const names = [...LEADING_FIELDS.filter((name) => found.includes(name)), ...found.filter((name) => !LEADING_FIELDS.includes(name))];
  if (!names.includes('theme') && /\.theme-(?:light|dark)\b/.test(`${html}\n${css}`)) names.push('theme');
  return names.map((name) => ({ name, description: '', example: '', required: false }));
}

const SAMPLE_VALUES = {
  title: 'Your title goes here',
  description: 'One or two sentences about the page.',
  author: 'Your name',
  site: 'your-site.com',
  tag: 'News',
  theme: 'light',
};
// Fields that must hold an image URL stay empty: a made-up URL would only fail to load.
const URL_FIELD = /image|logo|avatar|photo|picture|icon|url|src/;

/** 'author_name' -> 'Author name' */
export function fieldLabel(name) {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A believable value for a placeholder, so a new template previews with text in it. */
export function sampleValue(name) {
  if (name in SAMPLE_VALUES) return SAMPLE_VALUES[name];
  return URL_FIELD.test(name) ? '' : fieldLabel(name);
}

/**
 * Starting values for a list of fields: known ones (a starter's sample, or what
 * was typed last time) win; the rest come from `fallback`, empty by default.
 */
export function initialValues(fields, known = {}, fallback = () => '') {
  return Object.fromEntries(fields.map((field) => [field.name, typeof known[field.name] === 'string' ? known[field.name] : fallback(field.name)]));
}

/**
 * Starting values for a starter template in the card builder. Only what the
 * customer is sure to see and retype (the required title) and the theme switch
 * come from the sample; the made-up author, site, tag and description stay
 * empty, shown as grey placeholders, so a copied meta tag never carries a
 * stranger's name onto the customer's card.
 */
export function starterValues(fields, sample = {}) {
  const kept = Object.fromEntries(fields.filter((field) => field.required || field.name === 'theme').map((field) => [field.name, sample[field.name]]));
  return initialValues(fields, kept);
}

/** The `data` object for the API: empty inputs are left out, so the template's "no-<field>" state applies. */
export function cardData(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'string' && value !== ''));
}

/* ------------------------------------------------------------------ */
/* Open fields (personalised email images)                             */
/* ------------------------------------------------------------------ */

/** `<field>_default` holds an open field's signed fallback (src/lib/open-fields.ts DEFAULT_SUFFIX). */
export const OPEN_DEFAULT_SUFFIX = '_default';

const positiveInteger = (value) => (Number.isInteger(value) && value > 0 ? value : null);

/**
 * The open-fields switch from GET /api/config, or null while it is off (or the server does not
 * say): { email_fields: { enabled, max_open_fields, max_value_chars, max_unique_renders_per_day } }.
 * A boolean `email_fields_enabled` is read too. Limits the server leaves out are null: the
 * server checks them anyway.
 */
export function openFieldsSettings(config) {
  const block = config?.email_fields;
  const on = (block && typeof block === 'object' && block.enabled === true) || config?.email_fields_enabled === true;
  if (!on) return null;
  const perDay = block?.max_unique_renders_per_day;
  return {
    maxOpenFields: positiveInteger(block?.max_open_fields),
    maxValueChars: positiveInteger(block?.max_value_chars),
    maxUniqueRendersPerDay: perDay && typeof perDay === 'object' ? perDay : null,
  };
}

/**
 * The fields of a card template that can be open: text the template prints. Not `theme` (a
 * switch), not a field holding an image or a link (an open value can never be a URL, so it
 * would always show its default), and not a name that is reserved or ends in `_default`.
 */
export function openFieldCandidates(specs) {
  return specs
    .map((spec) => spec.name)
    .filter((name) => name !== 'theme' && name !== 'open' && name !== 'size' && name !== 'sig' && !name.endsWith(OPEN_DEFAULT_SUFFIX) && !URL_FIELD.test(name));
}

/**
 * The body of POST /api/sign. With open fields, each one's typed value is sent as its
 * `<field>_default` (shown when a reader's value is missing or unusable) and never as the field
 * itself: the server refuses a signed value for an open field. `open` only when there are some.
 */
export function signRequest({ siteId, template, format, size, values, open = [] }) {
  const data = cardData(values ?? {});
  const body = { site_id: siteId, template, format, size, data };
  if (open.length === 0) return body;
  for (const name of open) {
    const fallback = data[name];
    delete data[name];
    if (fallback !== undefined) data[name + OPEN_DEFAULT_SUFFIX] = fallback;
  }
  body.open = [...open];
  return body;
}

const escapeAttribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * An <img> tag for an email, at half the image's pixel size so it stays sharp on high-density
 * screens (a 1200 × 400 image fills a 600 × 200 slot).
 */
export function emailImageTag(url, size, alt = '') {
  const width = Math.round(size.width / 2);
  const height = Math.round(size.height / 2);
  return `<img src="${escapeAttribute(url)}" width="${width}" height="${height}" alt="${escapeAttribute(alt)}">`;
}

/** X-LTC-Warnings is encodeURIComponent(JSON array of strings). Anything else reads as no warnings. */
export function parseWarnings(header) {
  if (!header) return [];
  try {
    const list = JSON.parse(decodeURIComponent(header));
    return Array.isArray(list) ? list.filter((warning) => typeof warning === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A sentence when a template must not be saved as it stands, else null. The
 * server accepts an empty HTML body, but every card made from it would then
 * fail to render, so the editor refuses it first.
 */
export function templateSaveProblem(html) {
  return String(html ?? '').trim() === '' ? 'The HTML is empty, so every card made from this template would fail. Write the card\'s markup first, for example <h1>{{title}}</h1>.' : null;
}

const INDENT = '  ';

/** What the Tab key does in a code textarea: the selection becomes two spaces. */
export function insertIndent(value, start, end) {
  return { value: value.slice(0, start) + INDENT + value.slice(end), caret: start + INDENT.length };
}

/** A blank template that already renders, so the first preview is never an error. */
export const BLANK_TEMPLATE = {
  name: 'Untitled template',
  html: '<div class="card">\n  <h1 class="title">{{title}}</h1>\n  <p class="description">{{description}}</p>\n</div>',
  css: [
    'body { background: #f6efe0; color: #18150f; }',
    '.card { display: flex; flex-direction: column; justify-content: center; height: 100%; padding: 80px; }',
    '.title { margin: 0; font-size: 72px; font-weight: 700; line-height: 1.1; }',
    '.description { margin: 24px 0 0; font-size: 32px; color: #5a5245; }',
    '.no-description .description { display: none; }',
  ].join('\n'),
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const COUNT = new Intl.NumberFormat('en-US');

export const formatCount = (count) => COUNT.format(count);

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  // A bulk ZIP part can reach gigabytes ("1.8 GB", not "1812.0 MB").
  const gigabytes = bytes / (1024 * 1024 * 1024);
  if (gigabytes >= 1) return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

/** "Nov 22, 2026". The time zone is the viewer's unless one is given. */
export function formatDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(iso));
}

/** "Nov 22, 2026, 9:14 AM" */
export function formatDateTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

const SIZE_NAMES = { og: 'Link preview', square: 'Square', portrait: 'Portrait', email: 'Email' };

/** { id: 'og', width: 1200, height: 630 } -> { value: 'og', label: 'Link preview', detail: '1200 × 630' } */
export function sizeOption(size) {
  return { value: size.id, label: SIZE_NAMES[size.id] ?? size.id, detail: `${size.width} × ${size.height}` };
}

/** One row of the recent-renders table, in words. */
export function renderSummary(render, templateNames = {}) {
  return {
    template: templateNames[render.template] ?? (render.template === 'inline' ? 'Inline HTML' : render.template),
    via: render.source === 'og' ? 'Signed URL' : 'API',
    size: `${render.width} × ${render.height}`,
    format: render.format === 'jpeg' ? 'JPG' : render.format.toUpperCase(),
    bytes: formatBytes(render.bytes),
    counted: render.charged_to === 'topup' ? 'Top-up' : 'Plan',
  };
}

/* ------------------------------------------------------------------ */
/* Usage and billing                                                   */
/* ------------------------------------------------------------------ */

/** How full the monthly allowance is and how loud the meter should be. */
export function usageView(usage) {
  const percent = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 100;
  const exhausted = usage.total_remaining <= 0;
  const level = exhausted ? 'danger' : percent >= 90 ? 'warn' : 'ok';
  return { percent, level, exhausted };
}

/**
 * The overview's PDF line, or null when there is nothing to show: /api/me sends usage.pdf
 * ({ count, images }: PDFs charged this period and the images they counted as). Those images
 * are not always part of usage.used: a PDF that did not fit in the allowance is taken whole from
 * a top-up, so the line names no share of usage.used. It is shown when PDFs are switched on
 * here, or when the period already has some.
 */
export function pdfUsageLine(usage, config) {
  const pdf = usage?.pdf;
  if (!pdf || typeof pdf !== 'object') return null;
  const count = Number.isInteger(pdf.count) && pdf.count > 0 ? pdf.count : 0;
  const images = Number.isInteger(pdf.images) && pdf.images > 0 ? pdf.images : 0;
  if (count === 0 && config?.pdf_enabled !== true) return null;
  if (count === 0) return 'No PDFs made this period.';
  const pdfs = `${formatCount(count)} PDF${count === 1 ? '' : 's'} this period`;
  return `${pdfs}, counted as ${formatCount(images)} image${images === 1 ? '' : 's'}.`;
}

// The statuses for which the API accepts a plan change (src/routes/dashboard.ts).
const CHANGEABLE = ['active', 'trialing', 'past_due'];

/**
 * The billing buttons an account gets, in display order. Empty when Paddle is
 * not configured: the dashboard then says so instead of showing dead buttons.
 */
export function billingActions(user, config) {
  if (!config?.paddle) return [];
  const portal = user.has_billing ? [{ type: 'portal' }] : [];
  if (user.plan === 'free') {
    return [{ type: 'checkout', item: 'starter' }, { type: 'checkout', item: 'pro' }, ...portal];
  }
  const change = CHANGEABLE.includes(user.subscription?.status)
    ? [{ type: 'change-plan', plan: user.plan === 'starter' ? 'pro' : 'starter' }]
    : [];
  return [{ type: 'checkout', item: 'topup' }, ...change, ...portal];
}

/** What to remember before a checkout opens, so the return page knows what "done" looks like. */
export function checkoutSnapshot(item, me) {
  return { item, plan: me.user.plan, topup_remaining: me.usage.topup_remaining };
}

/** True once /api/me shows what the checkout bought: another plan, or more top-up images. */
export function checkoutSettled(before, me) {
  if (before.item === 'topup') return me.usage.topup_remaining > before.topup_remaining;
  return me.user.plan !== before.plan;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads a value until `done` accepts it or the attempts run out (about 30 s by
 * default: plan changes arrive through Paddle's webhook, a few seconds after
 * the payment).
 */
export async function pollUntil(load, done, { attempts = 15, delayMs = 2000, sleep = wait } = {}) {
  let value = await load();
  for (let attempt = 1; attempt < attempts && !done(value); attempt++) {
    await sleep(delayMs);
    value = await load();
  }
  return { value, settled: done(value) };
}

/** Where the first-run guide stands: 'site' (create one), 'card' (design and copy) or 'done'. */
export function guideStage({ siteCount, finished }) {
  if (finished) return 'done';
  return siteCount === 0 ? 'site' : 'card';
}

/* ------------------------------------------------------------------ */
/* Copyable examples                                                   */
/* ------------------------------------------------------------------ */

export const KEY_PLACEHOLDER = 'ltc_YOUR_API_KEY';

/** A working curl call for POST /v1/images. */
export function curlExample(origin, secret = KEY_PLACEHOLDER) {
  return [
    `curl -X POST ${origin}/v1/images \\`,
    `  -H "Authorization: Bearer ${secret}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"template":"blog","data":{"title":"Hello from the API"},"size":"og","format":"png"}'`,
  ].join('\n');
}

/** How to use an uploaded font family in a template's CSS. */
export function fontCssExample(family, weight = 400, style = 'normal') {
  const lines = [`  font-family: "${family}", sans-serif;`, `  font-weight: ${weight};`];
  if (style !== 'normal') lines.push(`  font-style: ${style};`);
  return ['.title {', ...lines, '}'].join('\n');
}

/** POST target for a font upload: the descriptor travels in the query, the file is the body. */
export function fontUploadUrl({ family, weight, style }) {
  return `/api/fonts?${new URLSearchParams({ family, weight: String(weight), style })}`;
}

/** A sentence when a font file is larger than the plan allows (checked before uploading megabytes), else null. */
export function fontSizeProblem(fileBytes, maxBytes) {
  if (fileBytes <= maxBytes) return null;
  return `This file is ${formatBytes(fileBytes)}. Your plan allows ${formatBytes(maxBytes)} per font file.`;
}

/** Most characters of a ?title= taken into the first card (the OG checker's sign-up link carries the page title). */
export const MAX_PREFILL_TITLE = 200;

/** { title } from /dashboard?title=..., trimmed and capped; {} when there is none. */
export function prefillFromQuery(search) {
  const title = String(new URLSearchParams(search ?? '').get('title') ?? '').replace(/\s+/g, ' ').trim();
  return title ? { title: Array.from(title).slice(0, MAX_PREFILL_TITLE).join('') } : {};
}
