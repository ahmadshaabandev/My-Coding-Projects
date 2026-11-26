// Bulk documents: one PDF per spreadsheet row through POST /api/batches, each with an
// optional public verification page (certificates). Two screens:
//   #bulk            choose a template, read a CSV, match columns, check row 1, start; and
//                    the account's batches (GET /api/batches, newest first)
//   #bulk/{batch id} one batch: progress, the documents, the ZIP parts, cancel, revoke
//
// The CSV file never leaves the browser: it is read here (./csv.js) and only the matched
// values are sent, row 1 to the free PDF tool for a watermarked preview and every row when the
// batch starts. Everything on screen is built from nodes and textContent (./dom.js); the
// rules are pure functions in ./bulk-helpers.js.
import { fallbackMessage } from '../api.js';
import { api } from './client.js';
import { alertBox, button, confirmDialog, dataTable, errorSlot, field, h, segmented, showError, toast, withBusy } from './dom.js';
import {
  VERIFICATION_KEYS,
  autoMatch,
  batchListEntry,
  batchProgress,
  batchCancellable,
  batchRequest,
  batchSettled,
  batchStatusView,
  batchTotalsText,
  buildRows,
  certificateState,
  columnName,
  explainRowIndex,
  fileSizeProblem,
  mappingProblems,
  mappingTargets,
  minimumImages,
  paperLabel,
  pdfTemplateFields,
  pollDelay,
  previewRequest,
  printsVerification,
  progressText,
  ranOutOfImages,
  requestBytes,
  rowErrorText,
  rowFilename,
  rowStatusView,
  starterFields,
  zipDownloads,
  zipPartDetail,
  zipPartLabel,
} from './bulk-helpers.js';
import { DELIMITER_NAMES, parseCsv } from './csv.js';
import { formatCount, formatDateTime } from './helpers.js';

const STYLESHEET = '/assets/css/dashboard-bulk.css';
const PREVIEW_PATH = '/api/tools/pdf';
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** Rows of a batch listed before "Show all": a 2,000-row table is slow to build and to read. */
const ROWS_SHOWN = 100;

const batchHash = (id) => `#bulk/${encodeURIComponent(id)}`;
const batchPath = (id) => `/api/batches/${encodeURIComponent(id)}`;
const badgeClass = (tone) => `badge${tone ? ` badge-${tone}` : ''}`;
const plural = (count, word) => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;
/** replaceChildren() without the "null" text it makes of a skipped child: like h(), null, undefined and false are left out. */
const fill = (node, ...children) => node.replaceChildren(...children.filter((child) => child !== null && child !== undefined && child !== false));

let stylesheet = null;

/** The tab's own styles, loaded the first time it opens (dashboard.html may link them too). Never holds the tab back. */
function ensureStylesheet() {
  if (stylesheet) return stylesheet;
  if (document.querySelector(`link[rel="stylesheet"][href="${STYLESHEET}"]`)) return (stylesheet = Promise.resolve());
  stylesheet = new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: STYLESHEET, onload: resolve, onerror: resolve });
    setTimeout(resolve, 1500);
    document.head.append(link);
  });
  return stylesheet;
}

const head = (lead) => h('header', { class: 'panel-head' }, h('h2', {}, 'Bulk documents'), h('p', { class: 'lead-sm' }, lead));

const LEAD = 'One PDF for every row of a spreadsheet: certificates, invoices, quotes or reports. Each document counts like one made through the API.';

function notEnabled() {
  return h(
    'div',
    { class: 'panel-stack' },
    head(LEAD),
    h('div', { class: 'empty' }, h('h3', {}, 'Bulk documents are not switched on here yet'), h('p', {}, 'Everything else in the dashboard works as usual.')),
  );
}

export async function mount(ctx, param) {
  await ensureStylesheet();
  if (ctx.config.batch?.enabled !== true) return { node: notEnabled() };
  if (ctx.me.user.suspended) {
    return { node: h('div', { class: 'panel-stack' }, head(LEAD), alertBox('warn', 'Bulk documents are not available while the account is suspended.')) };
  }
  return param ? batchView(ctx, decodeParam(param)) : setupView(ctx);
}

/** The id after #bulk/, as typed or linked; a malformed escape is kept as it is (and then simply not found). */
function decodeParam(param) {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}

/* ------------------------------------------------------------------ */
/* Turnstile, for the free tool's preview after a few per hour          */
/* ------------------------------------------------------------------ */

let turnstileLoad = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  turnstileLoad ??= new Promise((resolve, reject) => {
    const script = h('script', { src: TURNSTILE_SRC, async: true });
    script.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'))));
    script.addEventListener('error', () => {
      turnstileLoad = null;
      script.remove();
      reject(new Error('script failed'));
    });
    document.head.append(script);
  });
  return turnstileLoad;
}

/* ------------------------------------------------------------------ */
/* Setup: template, file, columns, preview, start                      */
/* ------------------------------------------------------------------ */

function step(number, id, title, ...content) {
  return h('section', { class: 'card bulk-step', 'aria-labelledby': id }, h('h3', { id, class: 'bulk-step-title' }, h('span', { class: 'bulk-num', 'aria-hidden': 'true' }, String(number)), title), ...content);
}

/**
 * The account's batches, newest first (GET /api/batches: the first page, as many as the API
 * lists by default). Loaded after the setup screen is on show, so a slow list never holds it back.
 */
function batchList(templateNames) {
  const slot = h('div', { class: 'stack' }, h('p', { class: 'hint', role: 'status' }, 'Loading your batches…'));
  const node = h('section', { class: 'stack bulk-history', 'aria-labelledby': 'bulk-history-title' }, h('h3', { id: 'bulk-history-title', class: 'kicker' }, 'Your batches'), slot);
  let gone = false;

  async function load() {
    let page;
    try {
      page = await api.get('/api/batches');
    } catch (failure) {
      if (gone || failure.status === 401) return;
      fill(slot, alertBox('warn', 'Your batches could not be listed. ', failure.message || '', ' ', button('Try again', { small: true, onclick: () => load() })));
      return;
    }
    if (gone) return;
    const batches = Array.isArray(page?.batches) ? page.batches : [];
    if (batches.length === 0) {
      fill(slot, h('p', { class: 'hint' }, 'No batches yet. The ones you start are listed here, on any device you sign in on.'));
      return;
    }
    fill(
      slot,
      h(
        'ul',
        { class: 'row-list' },
        batches.map((batch) => {
          const entry = batchListEntry(batch, templateNames);
          return h(
            'li',
            { class: 'row-card row-inline' },
            h(
              'div',
              { class: 'bulk-history-main' },
              h('h4', {}, h('a', { href: batchHash(entry.id) }, entry.title)),
              h('p', { class: 'bulk-history-status' }, h('span', { class: badgeClass(entry.status.tone) }, entry.status.label), h('span', { class: 'hint' }, entry.progress)),
              h('p', { class: 'hint' }, batch.created_at ? `Started ${formatDateTime(batch.created_at)}. ID ` : 'ID ', h('code', {}, entry.id)),
            ),
            h('a', { class: 'btn btn-secondary btn-sm', href: batchHash(entry.id), 'aria-label': `Open batch ${entry.id}` }, 'Open'),
          );
        }),
      ),
      page.next_before ? h('p', { class: 'hint' }, `These are your ${formatCount(batches.length)} most recent batches. The API lists older ones (GET /v1/batches).`) : null,
    );
  }

  return {
    node,
    load,
    destroy() {
      gone = true;
    },
  };
}

async function setupView(ctx) {
  const limits = ctx.config.batch;
  const plan = ctx.config.plans.find((candidate) => candidate.id === ctx.me.user.plan);
  const maxRows = limits.max_rows?.[ctx.me.user.plan] ?? Infinity;
  const [{ starter }, { custom }] = await Promise.all([api.get('/api/batches/templates'), api.get('/api/templates')]);

  const state = { template: null, targets: [], verify: false, format: '', orientation: '', parsed: null, fileName: '', mapping: {}, built: null };

  /* ---- 1 Template ---- */
  const templateError = errorSlot();
  const description = h('p', { class: 'hint' });
  const picker = h(
    'select',
    { class: 'select', onchange: () => chooseTemplate(picker.value) },
    h('optgroup', { label: 'Starter templates' }, starter.map((template) => h('option', { value: template.id }, template.name))),
    custom.length > 0 ? h('optgroup', { label: 'Your templates' }, custom.map((template) => h('option', { value: template.id }, template.name))) : null,
  );
  const verifyBox = h('input', {
    type: 'checkbox',
    onchange: () => {
      state.verify = verifyBox.checked;
      refreshTargets();
    },
  });
  const verifyNote = h('p', { class: 'hint bulk-verify-note' });
  const filename = h('input', { class: 'input', type: 'text', maxlength: 120, autocomplete: 'off', placeholder: '{{recipient_name}}-{{n}}.pdf' });
  const formats = Array.isArray(limits.pdf_formats) ? limits.pdf_formats : [];
  const pageOptions = h(
    'div',
    { class: 'builder-shape' },
    formats.length > 0
      ? segmented('bulk-paper', 'Paper', [{ value: '', label: 'As the template' }, ...formats.map((format) => ({ value: format, label: paperLabel(format) }))], '', (value) => {
          state.format = value;
        })
      : null,
    segmented(
      'bulk-orientation',
      'Orientation',
      [
        { value: '', label: 'As the template' },
        { value: 'portrait', label: 'Portrait' },
        { value: 'landscape', label: 'Landscape' },
      ],
      '',
      (value) => {
        state.orientation = value;
      },
    ),
  );
  const templateStep = step(
    1,
    'bulk-template-title',
    'Choose a PDF template',
    field('Template', picker),
    description,
    templateError,
    h(
      'div',
      { class: 'bulk-verify' },
      h(
        'label',
        { class: 'check' },
        verifyBox,
        h(
          'span',
          {},
          h('strong', {}, 'Add a verification page to every document. '),
          'Each document gets an ID and a public page at ',
          h('code', {}, `${String(ctx.config.app_url ?? '').replace(/\/+$/, '')}/v/…`),
          ' that confirms your account issued it, and says so if you revoke it later.',
        ),
      ),
      verifyNote,
    ),
    h(
      'details',
      { class: 'more' },
      h('summary', {}, 'Paper, orientation and file names'),
      h(
        'div',
        { class: 'stack more-body' },
        pageOptions,
        field('File names (optional)', filename, 'Use {{field}} for a value from the row and {{n}} for the document number. Leave it empty for the default names.'),
      ),
    ),
  );

  /* ---- 2 Spreadsheet ---- */
  const fileInput = h('input', { class: 'input', type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain', onchange: () => readFile(fileInput.files?.[0]) });
  const fileReport = h('div', { class: 'stack', 'aria-live': 'polite' });
  const fileStep = step(
    2,
    'bulk-file-title',
    'Choose the spreadsheet',
    field('CSV file', fileInput, 'Export the sheet as CSV (UTF-8) first. The first row names the columns; every row below it becomes one document.'),
    h('p', { class: 'hint' }, 'The file is read in this browser and is not uploaded. Only the values you match below are sent: row 1 for the preview, every row when you start.'),
    fileReport,
  );

  /* ---- 3 Columns ---- */
  const mapTable = h('div', {});
  const mapNotes = h('div', { class: 'stack' });
  const samples = new Map();
  const mapStep = step(3, 'bulk-map-title', 'Match the columns', h('p', { class: 'hint' }, 'Columns whose names match a field are matched already. Change any choice; unmatched fields stay empty.'), mapTable, mapNotes);
  mapStep.hidden = true;

  /* ---- 4 Check and start ---- */
  const problemsBox = h('div', { class: 'alert alert-warn bulk-problems', role: 'status', hidden: true });
  const summary = h('div', { class: 'stack bulk-summary' });
  const previewButton = button('Preview row 1', { onclick: () => preview() });
  const previewOpen = h('a', { class: 'btn btn-secondary btn-sm', target: '_blank', rel: 'noopener', hidden: true }, 'Open the preview');
  const previewSave = h('a', { class: 'btn btn-ghost btn-sm', download: 'preview-row-1.pdf', hidden: true }, 'Download it');
  const previewStatus = h('p', { class: 'hint', role: 'status' });
  const previewError = errorSlot();
  const challengeSlot = h('div', {});
  const challenge = h('div', { class: 'alert alert-info', hidden: true }, h('p', {}, 'The free PDF tool asks for a quick check that you are a person after a few previews.'), challengeSlot);
  const start = button('Start the batch', { variant: 'primary', onclick: () => startBatch() });
  const startError = errorSlot();
  const checkStep = step(
    4,
    'bulk-start-title',
    'Check row 1, then start',
    problemsBox,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'cluster' }, previewButton, previewOpen, previewSave),
      previewStatus,
      h('p', { class: 'hint' }, 'The preview is made by the free PDF tool, so it carries that tool\'s mark. It is not stored and not counted. The free tool makes a few PDFs per hour from one network.'),
      previewError,
      challenge,
    ),
    h('hr', { class: 'rule' }),
    summary,
    h('div', { class: 'cluster' }, start),
    startError,
  );
  checkStep.hidden = true;

  /* ---- behaviour ---- */
  let objectUrl = null;
  let widgetId = null;
  let destroyed = false;

  const orientation = () => (state.orientation === '' ? undefined : state.orientation === 'landscape');

  async function chooseTemplate(id) {
    templateError.hidden = true;
    const found = starter.find((template) => template.id === id);
    let template;
    if (found) {
      template = { ...found, starter: true, fields: starterFields(found) };
    } else {
      try {
        const { template: row } = await api.get(`/api/templates/${encodeURIComponent(id)}`);
        template = { id, name: row.name, description: '', starter: false, html: row.html, css: row.css, default_pdf: null, verify_default: false, fields: pdfTemplateFields(row.html) };
      } catch (failure) {
        if (picker.value === id) showError(templateError, failure);
        return;
      }
    }
    // A slower answer for an earlier choice must not win.
    if (picker.value !== id || destroyed) return;
    state.template = template;
    state.verify = template.verify_default === true;
    verifyBox.checked = state.verify;
    description.textContent = template.starter ? template.description ?? '' : 'One of your templates: each {{placeholder}} in it can take a column.';
    refreshTargets({ rematch: true });
  }

  function refreshTargets({ rematch = false } = {}) {
    state.targets = state.template ? mappingTargets(state.template.fields, { verify: state.verify }) : [];
    if (state.parsed) state.mapping = autoMatch(state.parsed.headers, state.targets, rematch ? {} : state.mapping);
    const template = state.template;
    if (!template || !state.verify) verifyNote.textContent = '';
    else if (printsVerification(template.fields)) verifyNote.textContent = 'This template prints the verification details on each document.';
    else if (template.starter) verifyNote.textContent = 'This template does not print the ID or the link. You can still share each document\'s verification link from the list once the batch has run.';
    else verifyNote.textContent = 'Your template does not use {{certificate_id}}, {{verify_url}} or {{verify_qr}} yet, so the documents will not show them. Add them to the template, or share the links from the list once the batch has run.';
    renderMapping();
    refreshRows();
  }

  async function readFile(file) {
    state.parsed = null;
    state.fileName = '';
    fileReport.replaceChildren();
    if (file) {
      const tooLarge = fileSizeProblem(file.size, limits.max_request_bytes);
      let parsed = null;
      if (tooLarge) {
        fileReport.append(alertBox('danger', tooLarge));
      } else {
        try {
          parsed = parseCsv(await file.text(), { maxRows, maxColumns: limits.max_columns ?? Infinity });
        } catch {
          fileReport.append(alertBox('danger', 'The file could not be read. Choose it again, or export the spreadsheet as CSV once more.'));
        }
      }
      if (destroyed || fileInput.files?.[0] !== file) return;
      if (parsed) report(file, parsed);
    }
    refreshTargets({ rematch: true });
  }

  function report(file, parsed) {
    if (parsed.problems.length > 0) {
      fileReport.append(alertBox('danger', h('strong', {}, `${file.name} cannot be used. `), parsed.problems.join(' ')));
      return;
    }
    if (parsed.overLimit) {
      const larger = Object.values(limits.max_rows ?? {}).some((rows) => rows > maxRows);
      fileReport.append(
        alertBox(
          'danger',
          h('strong', {}, `${file.name} has ${plural(parsed.total, 'row')}. `),
          `One batch on the ${plan?.name ?? ctx.me.user.plan} plan can hold ${formatCount(maxRows)}. Split the file${larger ? ', or upgrade for larger batches' : ''}.`,
          larger ? h('span', {}, ' ', h('a', { href: '#billing' }, 'See the plans')) : null,
        ),
      );
      return;
    }
    state.parsed = parsed;
    state.fileName = file.name;
    const columns = parsed.headers.length;
    fileReport.append(
      h(
        'p',
        { class: 'bulk-file-summary' },
        h('strong', {}, file.name),
        `: ${plural(parsed.total, 'row')}, ${plural(columns, 'column')}, separated by ${DELIMITER_NAMES[parsed.delimiter] ?? 'commas'}.`,
        parsed.skipped > 0 ? ` ${plural(parsed.skipped, 'blank row')} ${parsed.skipped === 1 ? 'is' : 'are'} left out.` : '',
      ),
    );
    if (parsed.warnings.length > 0) fileReport.append(alertBox('warn', h('ul', { class: 'bulk-list' }, parsed.warnings.map((warning) => h('li', {}, warning)))));
  }

  function renderMapping() {
    samples.clear();
    const parsed = state.parsed;
    mapStep.hidden = !parsed;
    checkStep.hidden = !parsed;
    if (!parsed) {
      mapTable.replaceChildren();
      mapNotes.replaceChildren();
      return;
    }
    const rows = state.targets.map((target) => {
      const select = h(
        'select',
        {
          class: 'select',
          'aria-label': `Column for ${target.label}`,
          onchange: () => {
            if (select.value === '') delete state.mapping[target.id];
            else state.mapping[target.id] = Number(select.value);
            refreshRows();
          },
        },
        h('option', { value: '' }, 'Not used'),
        parsed.headers.map((_, index) => h('option', { value: String(index), selected: state.mapping[target.id] === index }, columnName(parsed.headers, index))),
      );
      const sample = h('span', { class: 'bulk-sample' });
      samples.set(target.id, sample);
      // A required list is met by the JSON column or by line-item columns, so only text fields wear the badge;
      // mappingProblems() says what a list still needs.
      return [h('span', {}, target.label, target.required && target.kind === 'text' ? h('span', { class: 'badge bulk-required' }, 'Required') : null), select, sample];
    });
    fill(mapTable, dataTable([{ label: 'Template field' }, { label: 'Column' }, { label: 'Row 1' }], rows));
    mapNotes.replaceChildren();
    const filled = state.template ? state.template.fields.filter((spec) => state.verify && VERIFICATION_KEYS.includes(spec.key)) : [];
    if (filled.length > 0) {
      mapNotes.append(h('p', { class: 'hint' }, `Filled in by Link To Card for every document: ${filled.map((spec) => spec.label).join(', ')}.`));
    }
  }

  function refreshRows() {
    const parsed = state.parsed;
    state.built = parsed ? buildRows(parsed, state.mapping, state.targets, { maxValueChars: limits.max_value_chars ?? Infinity }) : null;
    if (!parsed) return;

    const first = parsed.rows[0] ?? [];
    for (const [id, sample] of samples) {
      const column = state.mapping[id];
      const value = column === undefined ? '' : String(first[column] ?? '').trim();
      sample.textContent = column === undefined ? '' : value === '' ? '(empty)' : value;
      sample.classList.toggle('muted', value === '');
    }
    const used = new Set(Object.values(state.mapping));
    const unused = parsed.headers.map((_, index) => index).filter((index) => !used.has(index));
    const unusedNote = mapNotes.querySelector('[data-unused]') ?? mapNotes.appendChild(h('p', { class: 'hint', 'data-unused': true }));
    unusedNote.textContent = unused.length > 0 ? `Not used: ${unused.map((index) => columnName(parsed.headers, index)).join(', ')}.` : 'Every column is used.';

    const mappingIssues = mappingProblems(state.targets, state.mapping);
    const rowIssues = state.built.problems;
    const more = state.built.problemCount - rowIssues.length;
    const issues = [...mappingIssues, ...rowIssues];
    fill(
      problemsBox,
      h('strong', {}, 'Fix this before starting:'),
      h('ul', { class: 'bulk-list' }, issues.map((issue) => h('li', {}, issue)), more > 0 ? h('li', {}, `… and ${plural(more, 'more problem')} in other rows.`) : null),
    );
    problemsBox.hidden = issues.length === 0;

    const rowOneOk = mappingIssues.length === 0 && parsed.rows.length > 0 && !rowIssues.some((issue) => issue.startsWith(`Row ${parsed.rowNumbers[0]}:`));
    previewButton.disabled = !rowOneOk;
    start.disabled = issues.length > 0 || state.built.rows.length === 0;
    renderSummary();
  }

  function renderSummary() {
    const count = state.built?.rows.length ?? 0;
    const images = minimumImages(count, limits.units_per_document ?? 1);
    const remaining = ctx.me.usage.total_remaining;
    fill(
      summary,
      h('p', {}, h('strong', {}, `${plural(count, 'document')} from ${state.template?.name ?? 'the template'}. `), `Each document of up to ${plural(limits.base_pages ?? 1, 'page')} counts as ${plural(limits.units_per_document ?? 1, 'image')}, so this batch counts at least ${plural(images, 'image')}. You have ${formatCount(remaining)} left.`),
      images > remaining
        ? alertBox('warn', 'That is more than you have left, so the batch will be refused until enough images are available. ', h('a', { href: '#billing' }, 'Add images'))
        : null,
      plan?.watermark ? h('p', { class: 'hint' }, 'On the Free plan every page carries the small Link To Card mark.') : null,
      h('p', { class: 'hint' }, `The documents are made in the background. You can follow them on the next screen, download them as ZIP files and cancel the ones still waiting at any time. The PDFs are kept for ${plural(ctx.me.usage.cache_days, 'day')}. Up to ${formatCount(limits.max_active ?? 1)} batches can run at once.`),
    );
  }

  function currentRequest() {
    return batchRequest({ template: state.template.id, rows: state.built.rows, verify: state.verify, format: state.format, landscape: orientation(), filename: filename.value });
  }

  function clearChallenge() {
    if (widgetId !== null && window.turnstile) {
      try {
        window.turnstile.remove(widgetId);
      } catch {
        // Already gone.
      }
    }
    widgetId = null;
    challengeSlot.replaceChildren();
    challenge.hidden = true;
  }

  async function showChallenge(siteKey) {
    clearChallenge();
    challenge.hidden = false;
    try {
      const turnstile = await loadTurnstile();
      if (destroyed) return;
      widgetId = turnstile.render(challengeSlot, {
        sitekey: siteKey,
        theme: 'auto',
        callback: (token) => preview(token),
        'error-callback': () => showError(previewError, { message: 'The check did not work. Reload the page and try again.' }),
      });
    } catch {
      challenge.hidden = true;
      showError(previewError, { message: 'The check could not load. A browser extension or network filter may be blocking challenges.cloudflare.com.' });
    }
  }

  async function preview(token) {
    const data = state.built?.rows[0];
    if (!data || !state.template) return;
    const body = previewRequest(state.template, data, { format: state.format, landscape: orientation() });
    if (token) body.turnstile = token;
    previewError.hidden = true;
    previewButton.setAttribute('aria-busy', 'true');
    previewButton.disabled = true;
    previewStatus.textContent = 'Making the preview…';
    try {
      const response = await fetch(PREVIEW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/pdf, application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      if (token) clearChallenge();
      if (destroyed) return;
      if (response.ok && (response.headers.get('content-type') ?? '').startsWith('application/pdf')) {
        const blob = await response.blob();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        previewOpen.href = objectUrl;
        previewSave.href = objectUrl;
        previewOpen.hidden = false;
        previewSave.hidden = false;
        previewStatus.textContent = 'The preview of row 1 is ready.';
        return;
      }
      const json = await response.json().catch(() => null);
      const error = json?.error ?? {};
      previewStatus.textContent = '';
      if (error.code === 'verification_required' && typeof error.details?.site_key === 'string' && error.details.site_key) {
        showChallenge(error.details.site_key);
        return;
      }
      showError(previewError, { message: typeof error.message === 'string' && error.message ? error.message : fallbackMessage(response.status) });
    } catch {
      previewStatus.textContent = '';
      showError(previewError, { message: 'The server could not be reached. Check your connection and try again.' });
    } finally {
      previewButton.removeAttribute('aria-busy');
      if (!destroyed) refreshRows();
    }
  }

  async function startBatch() {
    startError.hidden = true;
    const body = currentRequest();
    if (limits.max_request_bytes > 0 && requestBytes(body) > limits.max_request_bytes) {
      showError(startError, { message: 'These rows hold too much data for one batch. Split the spreadsheet into smaller files and start one batch for each.' });
      return;
    }
    const count = body.rows.length;
    const images = minimumImages(count, limits.units_per_document ?? 1);
    const confirmed = await confirmDialog({
      title: `Make ${plural(count, 'document')}?`,
      body: `This counts at least ${plural(images, 'image')}, more for documents over ${plural(limits.base_pages ?? 1, 'page')}. You can cancel the documents that are still waiting at any time.`,
      confirmLabel: 'Start the batch',
      danger: false,
    });
    if (!confirmed) return;
    try {
      const created = await withBusy(start, () => api.post('/api/batches', body));
      location.hash = batchHash(created.id);
    } catch (failure) {
      showError(startError, { message: explainRowIndex(failure.message, state.parsed.rowNumbers) });
      refreshRows();
    }
  }

  const templateNames = Object.fromEntries([...starter, ...custom].map((template) => [template.id, template.name]));
  const history = batchList(templateNames);
  const node = h(
    'div',
    { class: 'panel-stack bulk' },
    head(LEAD),
    starter.length === 0 && custom.length === 0 ? alertBox('warn', 'There is no PDF template to use yet.') : null,
    h('div', { class: 'bulk-steps' }, templateStep, fileStep, mapStep, checkStep),
    history.node,
  );

  if (starter.length > 0 || custom.length > 0) chooseTemplate(picker.value);
  history.load();

  return {
    node,
    destroy() {
      destroyed = true;
      history.destroy();
      clearChallenge();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

/* ------------------------------------------------------------------ */
/* One batch                                                           */
/* ------------------------------------------------------------------ */

function missingBatch(id) {
  return h(
    'div',
    { class: 'panel-stack' },
    head(LEAD),
    h(
      'div',
      { class: 'empty' },
      h('h3', {}, 'This batch was not found'),
      h('p', {}, 'It may have been removed with its documents, or it belongs to another account. ID ', h('code', {}, id)),
      h('a', { class: 'btn btn-primary', href: '#bulk' }, 'Start a new batch'),
    ),
  );
}

async function batchView(ctx, id) {
  const path = batchPath(id);
  let batch;
  try {
    batch = await api.get(path);
  } catch (failure) {
    if (failure.status === 404) return { node: missingBatch(id) };
    throw failure;
  }

  const opened = Date.now();
  const revoked = new Set();
  let onlyFailed = false;
  let showAll = false;
  let timer = null;
  let stopped = false;
  let signature = '';
  let downloadSignature = '';

  const badge = h('span', { class: 'badge' });
  const meter = h('progress', { class: 'meter', max: 100, value: 0, 'aria-label': 'Documents made' });
  const progressLine = h('p', { class: 'bulk-progress-text', role: 'status' });
  const downloads = h('div', { class: 'bulk-zips', hidden: true });
  const cancel = button('Cancel the rest', { variant: 'ghost', onclick: (event) => cancelBatch(event.currentTarget) });
  const notice = h('div', {});
  const error = errorSlot();
  const filterSlot = h('div', {});
  const rowsSlot = h('div', {});

  const meta = h('p', { class: 'hint' });
  const node = h(
    'div',
    { class: 'panel-stack bulk' },
    h('a', { class: 'back-link', href: '#bulk' }, 'Bulk documents'),
    h('header', { class: 'panel-head' }, h('h2', {}, 'Batch ', h('code', {}, batch.id ?? id)), meta),
    h('section', { class: 'card bulk-progress', 'aria-label': 'Progress' }, h('div', { class: 'section-row' }, badge, h('div', { class: 'cluster' }, cancel)), meter, progressLine, downloads, notice),
    error,
    h('section', { class: 'stack', 'aria-labelledby': 'bulk-rows-title' }, h('div', { class: 'section-row' }, h('h3', { id: 'bulk-rows-title', class: 'kicker' }, 'Documents'), filterSlot), rowsSlot),
  );

  async function revoke(row, control) {
    const confirmed = await confirmDialog({
      title: 'Revoke this certificate?',
      body: `From now on, the verification page of ${row.certificate_id} shows it as revoked. This cannot be undone.`,
      confirmLabel: 'Revoke certificate',
    });
    if (!confirmed) return;
    try {
      const record = await withBusy(control, () => api.post(`/api/certificates/${encodeURIComponent(row.certificate_id)}/revoke`));
      // The answer is the verification record as it now is (GET /v/{id}.json): revoking twice keeps the first time.
      if (record?.status === 'revoked') revoked.add(row.certificate_id);
      signature = '';
      renderRows();
      toast(`${row.certificate_id} is revoked.`);
    } catch (failure) {
      showError(error, failure);
    }
  }

  async function cancelBatch(control) {
    const confirmed = await confirmDialog({
      title: 'Cancel the rest of this batch?',
      body: 'The documents still waiting are not made and not counted. The ones already made stay, and stay counted.',
      confirmLabel: 'Cancel the rest',
    });
    if (!confirmed) return;
    try {
      const next = await withBusy(control, () => api.post(`${path}/cancel`));
      update(Array.isArray(next?.rows) ? next : await api.get(path));
      toast('The rest of the batch is cancelled.');
    } catch (failure) {
      showError(error, failure);
    }
  }

  function certificateCells(row) {
    const certificate = certificateState(row, revoked);
    if (!certificate) return ['', ''];
    const link = certificate.url
      ? h('a', { href: certificate.url, target: '_blank', rel: 'noopener', 'aria-label': `Verification page of ${certificate.id} (opens in a new tab)` }, h('code', {}, certificate.id))
      : h('code', {}, certificate.id);
    return [
      h('span', { class: 'bulk-cert' }, link, certificate.revoked ? h('span', { class: 'badge badge-danger' }, 'Revoked') : null),
      certificate.revoked
        ? ''
        : button('Revoke', { small: true, variant: 'ghost', 'aria-label': `Revoke certificate ${certificate.id}`, onclick: (event) => revoke(row, event.currentTarget) }),
    ];
  }

  /** One button per ZIP part (decision D9): rebuilt only when the parts change, so a poll keeps focus. */
  function renderDownloads() {
    const list = zipDownloads(batch, path);
    const settled = batchSettled(batch);
    const next = JSON.stringify([list, settled]);
    if (next === downloadSignature) return;
    downloadSignature = next;
    downloads.hidden = list.length === 0;
    fill(
      downloads,
      list.length > 1
        ? h('p', { class: 'hint' }, `The PDFs come in ${formatCount(list.length)} ZIP files. Download each one: they unpack into one folder, and no file name repeats across them.`)
        : null,
      list.length > 0
        ? h(
            'ul',
            { class: 'bulk-zip-list' },
            list.map((download, position) =>
              h(
                'li',
                { class: 'bulk-zip' },
                h('a', { class: `btn ${position === 0 ? 'btn-primary' : 'btn-secondary'}`, href: download.href, download: '' }, zipPartLabel(download, list.length, settled)),
                h('span', { class: 'bulk-zip-detail' }, zipPartDetail(download)),
              ),
            ),
          )
        : null,
      list.length > 0 && !settled ? h('p', { class: 'hint' }, 'Documents still being made are added to the ZIP once they are done.') : null,
    );
  }

  function renderRows() {
    const all = Array.isArray(batch.rows) ? batch.rows : [];
    const failed = all.filter((row) => row.status === 'failed').length;
    if (failed === 0) onlyFailed = false;
    fill(
      filterSlot,
      failed > 0
        ? segmented(
            'bulk-filter',
            'Show',
            [
              { value: 'all', label: `All (${formatCount(all.length)})` },
              { value: 'failed', label: `Failed (${formatCount(failed)})` },
            ],
            onlyFailed ? 'failed' : 'all',
            (value) => {
              onlyFailed = value === 'failed';
              signature = '';
              renderRows();
            },
          )
        : null,
    );
    const list = onlyFailed ? all.filter((row) => row.status === 'failed') : all;
    const shown = showAll ? list : list.slice(0, ROWS_SHOWN);
    const verify = batch.verify === true || all.some((row) => row.certificate_id);
    const columns = [{ label: 'Document' }, { label: 'Status' }, { label: 'Pages', class: 'nowrap' }, { label: 'Images counted', class: 'nowrap' }, { label: 'PDF' }];
    if (verify) columns.push({ label: 'Verification' }, { label: '', class: 'cell-action' });
    const rows = shown.map((row) => {
      const number = Number.isInteger(row.index) ? row.index + 1 : null;
      const status = rowStatusView(row.status);
      const message = rowErrorText(row);
      const name = rowFilename(row);
      const cells = [
        h('span', { class: 'bulk-doc' }, number === null ? '' : `#${formatCount(number)}`, name ? h('span', { class: 'bulk-filename', title: name }, name) : null),
        h('span', { class: 'bulk-status' }, h('span', { class: badgeClass(status.tone) }, status.label), message ? h('span', { class: 'bulk-row-error' }, message) : null),
        Number.isInteger(row.pages) ? formatCount(row.pages) : '-',
        Number.isInteger(row.credits_used) ? formatCount(row.credits_used) : '-',
        row.url ? h('a', { href: row.url, target: '_blank', rel: 'noopener', 'aria-label': number === null ? 'Open the PDF' : `Open document ${number}` }, 'Open') : h('span', { class: 'muted' }, '-'),
      ];
      return verify ? [...cells, ...certificateCells(row)] : cells;
    });
    fill(
      rowsSlot,
      list.length === 0 ? h('p', { class: 'hint' }, 'No documents to show yet.') : dataTable(columns, rows),
      !showAll && list.length > ROWS_SHOWN
        ? button(`Show all ${formatCount(list.length)}`, {
            small: true,
            onclick: () => {
              showAll = true;
              signature = '';
              renderRows();
            },
          })
        : null,
    );
  }

  function update(next) {
    batch = next;
    const progress = batchProgress(batch);
    const status = batchStatusView(batch.status);
    badge.className = badgeClass(status.tone);
    badge.textContent = status.label;
    meter.value = progress.percent;
    meter.className = `meter${progress.failed > 0 ? ' meter-warn' : ''}`;
    progressLine.textContent = progressText(progress);
    const started = batch.created_at ? `Started ${formatDateTime(batch.created_at)}. ` : '';
    const totals = batchTotalsText(batch);
    meta.textContent = `${started}Template ${batch.template ?? ''}${batch.verify ? ', with verification pages' : ''}.${totals ? ` ${totals}` : ''}`;
    renderDownloads();
    cancel.hidden = !batchCancellable(batch);
    fill(
      notice,
      ranOutOfImages(batch)
        ? alertBox('warn', 'Your images ran out during this batch, so the rest of the documents were not made. ', h('a', { href: '#billing' }, 'Add images'), ', then start a new batch with the rows that failed.')
        : batch.status === 'cancelled'
          ? alertBox('info', 'This batch was cancelled. Documents made before that are kept.')
          : progress.finished && progress.failed > 0
            ? alertBox('warn', 'Some documents failed: the list says why. Fix those rows in the spreadsheet and start a new batch with just them.')
            : progress.finished && progress.done === progress.total && progress.total > 0
              ? alertBox('ok', `All ${plural(progress.total, 'document')} are made.`)
              : null,
    );
    // The list is rebuilt only when a row changed, so a poll does not move focus out of it.
    const nextSignature = JSON.stringify([batch.rows, onlyFailed, showAll]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      renderRows();
    }
  }

  function schedule() {
    if (stopped || batchSettled(batch)) return;
    timer = setTimeout(tick, pollDelay(Date.now() - opened, batchProgress(batch).total));
  }

  async function tick() {
    // A cancel answered while this tick was waiting already brought the final state.
    if (stopped || batchSettled(batch)) return;
    // A hidden tab does not need fresh numbers; the next visible tick catches up.
    if (!document.hidden) {
      try {
        const next = await api.get(path);
        if (stopped) return;
        update(next);
        error.hidden = true;
      } catch (failure) {
        if (stopped || failure.status === 401) return;
        if (failure.status === 404) {
          stopped = true;
          node.replaceWith(missingBatch(id));
          return;
        }
        showError(error, { message: `${failure.message} The page keeps trying.` });
      }
    }
    schedule();
  }

  update(batch);
  schedule();

  return {
    node,
    destroy() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
