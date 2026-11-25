// The free PDF tools: /tools/html-to-pdf, /tools/invoice-generator and
// /tools/certificate-generator. One form in, one PDF download out.
//
// API (see the feature contract): POST /api/tools/pdf with
//   { tool: "html-to-pdf" | "invoice" | "certificate", html?, css?, data?, pdf?: { format?, landscape? }, turnstile? }
// answers the PDF bytes (application/pdf, X-LTC-Pages) or the usual
// { error: { code, message, details } } body. Nothing is stored on the server.
//
// What the visitor types is only ever set with textContent or as a form value,
// never parsed as HTML. The PDF is handed over as a blob: URL on an <a download>,
// so no frame and no extra CSP source is needed.
//
// The invoice page does the arithmetic (line amounts, subtotal, tax, total) here,
// in whole cents, and shows it before anything is sent: the API never computes.

export const API_PATH = '/api/tools/pdf';
export const CONFIG_PATH = '/api/config';
export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const TOOLS = ['html-to-pdf', 'invoice', 'certificate'];
export const NOT_ENABLED = 'PDF rendering is not enabled yet.';

/* ------------------------------------------------------------------ numbers and money */

const MONEY = /^(-)?(\d{0,13})(?:\.(\d*))?$/;
/** Commas are only accepted as thousands separators: "1,250.00" yes, "1,5" (a decimal comma) no. */
const THOUSANDS = /^-?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Cents from what someone typed: "1,250", "1250.5", "-40.00". A dot is the decimal point,
 * commas may only separate thousands, spaces are ignored, and a third decimal rounds half up.
 * null for an empty field, NaN for anything that is not a number (including "1,5", which
 * would otherwise be read as 15).
 */
export function parseMoney(text) {
  const spaced = String(text ?? '').replace(/\s/g, '');
  if (spaced === '') return null;
  if (spaced.includes(',') && !THOUSANDS.test(spaced)) return Number.NaN;
  const raw = spaced.replace(/,/g, '');
  const match = MONEY.exec(raw);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return Number.NaN;
  const fraction = (match[3] ?? '').padEnd(3, '0');
  let cents = Number(match[2] || '0') * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return match[1] ? -cents : cents;
}

/**
 * A quantity: a positive number with at most 4 decimals ("2", "1.5", "0.25"). null when empty,
 * NaN when invalid. No commas at all: "1,5" could mean 1.5 or 15.
 */
export function parseQuantity(text) {
  const raw = String(text ?? '').replace(/\s/g, '');
  if (raw === '') return null;
  if (!/^\d{1,9}(?:\.\d{1,4})?$|^\.\d{1,4}$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return value > 0 ? value : Number.NaN;
}

/** A tax rate in percent, 0 to 100 ("8", "8.5", "20 %"). null when empty, NaN when invalid. */
export function parseRate(text) {
  const raw = String(text ?? '').replace(/[\s%]/g, '').replace(',', '.');
  if (raw === '') return null;
  if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(raw)) return Number.NaN;
  const value = Number(raw);
  return value <= 100 ? value : Number.NaN;
}

/** "1,250.00" from cents: a comma between thousands and two decimals, the same in every browser. */
export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** A rate as the visitor would write it: 8.5, not 8.500. */
const formatRate = (rate) => String(Math.round(rate * 1000) / 1000);

/**
 * The invoice arithmetic. `rows`: [{ description, quantity, unit_price }] as typed; `taxRate`: text.
 * Blank rows are skipped. An empty quantity means 1. Every amount is rounded to the cent once:
 * line = quantity x unit price, tax = subtotal x rate, total = subtotal + tax.
 * Returns the lines to print, the totals in cents and a list of problems in plain words.
 */
export function invoiceTotals(rows, taxRate) {
  const problems = [];
  const lines = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const description = String(row?.description ?? '').trim();
    const quantityText = String(row?.quantity ?? '').trim();
    const priceText = String(row?.unit_price ?? '').trim();
    if (description === '' && quantityText === '' && priceText === '') return;
    const label = `Line ${index + 1}`;
    const quantity = quantityText === '' ? 1 : parseQuantity(quantityText);
    const unit = parseMoney(priceText);
    if (description === '') problems.push(`${label} needs a description.`);
    if (Number.isNaN(quantity)) problems.push(`${label}: the quantity must be a number above 0 with a dot for decimals, such as 2 or 1.5.`);
    if (unit === null) problems.push(`${label} needs a unit price.`);
    else if (Number.isNaN(unit)) problems.push(`${label}: the unit price must be a number with a dot for decimals, such as 1250 or 1,250.00.`);
    const valid = !Number.isNaN(quantity) && unit !== null && !Number.isNaN(unit);
    lines.push({
      description,
      quantity: quantityText === '' ? '1' : quantityText,
      unitCents: valid ? unit : null,
      amountCents: valid ? Math.round(quantity * unit) : null,
    });
  });
  if (lines.length === 0) problems.push('Add at least one line with a description and a unit price.');
  const rate = parseRate(taxRate);
  if (Number.isNaN(rate)) problems.push('The tax rate must be a percentage from 0 to 100, such as 8 or 8.5.');
  const subtotalCents = lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0);
  const taxCents = rate === null || Number.isNaN(rate) ? null : Math.round((subtotalCents * rate) / 100);
  return { lines, rate: Number.isNaN(rate) ? null : rate, subtotalCents, taxCents, totalCents: subtotalCents + (taxCents ?? 0), problems };
}

/* ------------------------------------------------------------------ dates and names */

/** "Nov 25, 2026" (short) or "November 25, 2026" (long) from a date input's "2026-11-25"; '' for anything else. */
export function displayDate(iso, style = 'short') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return '';
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: style === 'long' ? 'long' : 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

/** "2026-11-25" for a date, in UTC (what a date input expects), `days` later. */
export function isoDate(date, days = 0) {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The download name: "invoice-INV-2026-0142.pdf", "certificate-Amara-Nwosu.pdf", "document.pdf". */
export function fileNameFor(tool, data) {
  const part = (text) =>
    String(text ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60)
      .replace(/[-.]+$/, '');
  if (tool === 'invoice') return part(data?.invoice_number) ? `invoice-${part(data.invoice_number)}.pdf` : 'invoice.pdf';
  if (tool === 'certificate') return part(data?.recipient_name) ? `certificate-${part(data.recipient_name)}.pdf` : 'certificate.pdf';
  return 'document.pdf';
}

/** Trimmed, non-empty values only: an empty field is left out, so the template collapses its row. */
export function compact(values) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const text = typeof value === 'string' ? value.trim() : value;
    if (text !== '' && text !== null && text !== undefined) out[key] = text;
  }
  return out;
}

/* ------------------------------------------------------------------ request bodies */

/** The keys of the invoice and certificate templates the forms send (the contract's data keys). */
export const INVOICE_TEXT_KEYS = [
  'seller_name', 'seller_address', 'seller_email', 'seller_tax_id', 'logo_url',
  'buyer_name', 'buyer_address', 'buyer_email', 'invoice_number', 'currency', 'payment_terms', 'notes',
];
export const CERTIFICATE_TEXT_KEYS = ['title', 'recipient_name', 'achievement', 'issuer_name', 'signer_name', 'signer_title', 'certificate_id', 'logo_url'];

/**
 * The invoice template's data from the form: `values` holds the text fields, the two dates
 * ("2026-11-25"), tax_label and tax_rate; `rows` the line items as typed.
 * { data, problems }: data is null while there are problems.
 */
export function invoiceData(values, rows) {
  const totals = invoiceTotals(rows, values?.tax_rate);
  const problems = [...totals.problems];
  for (const [key, label] of [['seller_name', 'your business name'], ['buyer_name', 'who the invoice is for'], ['invoice_number', 'an invoice number']]) {
    if (String(values?.[key] ?? '').trim() === '') problems.push(`Fill in ${label}.`);
  }
  const issued = displayDate(values?.issue_date);
  if (issued === '') problems.push('Pick the issue date.');
  if (problems.length > 0) return { data: null, problems, totals };

  const text = {};
  for (const key of INVOICE_TEXT_KEYS) text[key] = values?.[key];
  const taxed = totals.taxCents !== null;
  const data = compact({
    ...text,
    issue_date: issued,
    due_date: displayDate(values?.due_date),
    ...(taxed
      ? {
          subtotal: formatMoney(totals.subtotalCents),
          tax_label: String(values?.tax_label ?? '').trim() || `Tax (${formatRate(totals.rate)}%)`,
          tax: formatMoney(totals.taxCents),
        }
      : {}),
    total: formatMoney(totals.totalCents),
  });
  data.items = totals.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit_price: formatMoney(line.unitCents),
    amount: formatMoney(line.amountCents),
  }));
  return { data, problems: [], totals };
}

/** The certificate template's data: the text fields and the date ("2026-11-25", printed in full). */
export function certificateData(values) {
  const problems = [];
  for (const [key, label] of [['title', 'a title'], ['recipient_name', 'who receives it'], ['achievement', 'what it is for'], ['issuer_name', 'who issues it']]) {
    if (String(values?.[key] ?? '').trim() === '') problems.push(`Fill in ${label}.`);
  }
  const date = displayDate(values?.date, 'long');
  if (date === '') problems.push('Pick the date.');
  if (problems.length > 0) return { data: null, problems };
  const text = {};
  for (const key of CERTIFICATE_TEXT_KEYS) text[key] = values?.[key];
  return { data: compact({ ...text, date }), problems: [] };
}

/** The JSON body for POST /api/tools/pdf. The Turnstile token rides along only on the retry after a challenge. */
export function toolRequest(tool, { html, css, data, format, landscape, turnstile } = {}) {
  if (!TOOLS.includes(tool)) throw new Error(`Unknown tool "${tool}"`);
  const body = { tool };
  if (tool === 'html-to-pdf') body.html = String(html ?? '');
  else body.data = data ?? {};
  if (typeof css === 'string' && css.trim() !== '') body.css = css;
  const pdf = {};
  if (format) pdf.format = format;
  if (typeof landscape === 'boolean') pdf.landscape = landscape;
  if (Object.keys(pdf).length > 0) body.pdf = pdf;
  if (turnstile) body.turnstile = turnstile;
  return body;
}

/* ------------------------------------------------------------------ answers */

/** Seconds from a Retry-After header (seconds or HTTP date), or null. */
export function retryAfterSeconds(header, now = new Date()) {
  if (header === null || header === undefined || header === '') return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** "14:05" in the visitor's own clock format. */
export function clockTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const cleanMessage = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The friendly message for a failed request.
 * @param status  HTTP status (0 when the request never reached us)
 * @param body    the parsed JSON body, if any
 * @returns { code, title, message, retryAt: Date|null, siteKey: string|null }
 */
export function describeError(status, body, { retryAfter = null, now = new Date() } = {}) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const code = typeof error.code === 'string' ? error.code : null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const server = cleanMessage(error.message);
  const base = { code, retryAt: null, siteKey: null };

  if (status === 0) return { ...base, code: 'network', title: 'Link To Card could not be reached.', message: 'Check your internet connection, then try again.' };
  switch (code) {
    case 'invalid_request':
      return { ...base, title: 'Check the form.', message: server || 'One of the fields is not valid.' };
    case 'template_error':
      return { ...base, title: 'The PDF could not be made from this document.', message: server || 'Change the document and try again.' };
    case 'image_fetch_failed':
      return { ...base, title: 'An image could not be loaded.', message: server || 'Check that every image address is public and starts with https://.' };
    case 'payload_too_large':
      return { ...base, title: 'That is too much for one PDF.', message: server || 'Make the document smaller and try again.' };
    case 'not_configured':
      return { ...base, title: NOT_ENABLED, message: 'The free PDF tools are not switched on here. The rest of the site works as usual.' };
    case 'verification_required': {
      const siteKey = typeof details.site_key === 'string' && details.site_key ? details.site_key : null;
      return {
        ...base,
        siteKey,
        title: 'Please confirm you are a person.',
        message: siteKey
          ? 'You have made a few PDFs this hour. Complete the quick check below and your PDF is made straight away.'
          : 'A verification step is needed, but it could not be shown. Wait a few minutes, then try again.',
      };
    }
    case 'rate_limited': {
      // Retry-After first; a busy renderer also says it in details.retry_after_seconds (src/pdf/render.ts).
      const fromDetails = Number(details.retry_after_seconds ?? details.retry_after);
      const seconds = retryAfter ?? (Number.isFinite(fromDetails) && fromDetails >= 0 ? fromDetails : null);
      const retryAt = seconds === null ? null : new Date(now.getTime() + seconds * 1000);
      const minutes = seconds === null ? null : Math.max(1, Math.ceil(seconds / 60));
      const when = retryAt === null ? 'Try again later.' : `Try again after ${clockTime(retryAt)} (in about ${minutes} minute${minutes === 1 ? '' : 's'}).`;
      // The server's own message already says when (the hourly limit) or that it is a short burst limit.
      return { ...base, retryAt, title: 'Too many PDFs for now.', message: server || `The free tools make a few PDFs per hour from one network. ${when}` };
    }
    case 'render_timeout':
      return { ...base, title: 'The PDF took too long to make.', message: server || 'Make the document shorter or simpler, then try again.' };
    case 'render_failed':
      return { ...base, title: 'The PDF could not be made.', message: server || 'Wait a minute, then try again.' };
    case 'forbidden':
      return { ...base, title: 'The request was refused.', message: 'Reload the page and try again.' };
    default:
      break;
  }
  if (status === 429) return { ...base, code: 'rate_limited', title: 'Too many requests.', message: 'Wait a minute, then try again.' };
  if (status >= 500) return { ...base, title: 'The PDF tool had a problem.', message: `The server answered HTTP ${status}. Wait a minute, then try again.` };
  return { ...base, title: 'The PDF could not be made.', message: server || `The server answered HTTP ${status}. Reload the page and try again.` };
}

/** "48 KB", "1.2 MB" */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Your PDF is ready: 2 pages, 48 KB." */
export function readyText(pages, bytes) {
  const count = Number.isInteger(pages) && pages > 0 ? `${pages} page${pages === 1 ? '' : 's'}, ` : '';
  return `Your PDF is ready: ${count}${formatSize(bytes)}.`;
}

/* ------------------------------------------------------------------ DOM */

/** createElement with attributes and children. Strings become text nodes; nothing is parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === '') continue;
    node.append(child);
  }
  return node;
}

/** The form's named fields as { name: value }; checkboxes as booleans. */
function formValues(form) {
  const values = {};
  for (const field of form.elements) {
    if (!field.name || field.closest('[data-row]')) continue;
    values[field.name] = field.type === 'checkbox' ? field.checked : field.value;
  }
  return values;
}

function readJsonAttribute(node, name) {
  try {
    return JSON.parse(node.getAttribute(name) ?? 'null');
  } catch {
    return null;
  }
}

/** The line-item editor of the invoice page: rows of description, quantity, unit price and the computed amount. */
function itemEditor(form, onchange) {
  const list = form.querySelector('[data-items]');
  const addButton = form.querySelector('[data-add-item]');
  const maxRows = Number(form.dataset.maxItems) || 1;
  const maxChars = Number(form.dataset.maxItemChars) || undefined;
  let counter = 0;

  function sync() {
    const rows = list.querySelectorAll('[data-row]');
    addButton.disabled = rows.length >= maxRows;
    rows.forEach((row, index) => {
      row.querySelector('[data-row-number]').textContent = String(index + 1);
      const remove = row.querySelector('[data-remove]');
      remove.disabled = rows.length === 1;
      remove.setAttribute('aria-label', `Remove line ${index + 1}`);
    });
  }

  function addRow(values = {}) {
    if (list.querySelectorAll('[data-row]').length >= maxRows) return null;
    counter += 1;
    const id = (name) => `item-${counter}-${name}`;
    const input = (name, label, extra) =>
      el(
        'div',
        { class: `field item-${name.replace('_', '-')}` },
        el('label', { class: 'label', for: id(name) }, label),
        el('input', { class: 'input', id: id(name), 'data-field': name, maxlength: maxChars, autocomplete: 'off', ...extra }),
      );
    const row = el(
      'li',
      { class: 'item-row', 'data-row': '' },
      el('span', { class: 'item-number', 'aria-hidden': 'true', 'data-row-number': '' }),
      input('description', 'Description', { placeholder: 'What you did or sold' }),
      input('quantity', 'Qty', { inputmode: 'decimal', placeholder: '1' }),
      input('unit_price', 'Unit price', { inputmode: 'decimal', placeholder: '0.00' }),
      el('div', { class: 'field item-amount' }, el('span', { class: 'label' }, 'Amount'), el('output', { class: 'item-amount-value', 'data-amount': '' }, '-')),
      el('button', { class: 'btn btn-ghost btn-sm item-remove', type: 'button', 'data-remove': '' }, 'Remove'),
    );
    for (const [name, value] of Object.entries(values)) {
      const field = row.querySelector(`[data-field="${name}"]`);
      if (field) field.value = String(value);
    }
    row.querySelector('[data-remove]').addEventListener('click', () => {
      row.remove();
      sync();
      onchange();
      form.querySelector('[data-add-item]').focus();
    });
    row.addEventListener('input', onchange);
    list.append(row);
    sync();
    return row;
  }

  addButton.addEventListener('click', () => {
    const row = addRow();
    onchange();
    row?.querySelector('input')?.focus();
  });

  return {
    addRow,
    rows() {
      return [...list.querySelectorAll('[data-row]')].map((row) => {
        const value = (name) => row.querySelector(`[data-field="${name}"]`).value;
        return { description: value('description'), quantity: value('quantity'), unit_price: value('unit_price') };
      });
    },
    showAmounts(lines) {
      const rows = [...list.querySelectorAll('[data-row]')];
      let at = 0;
      for (const row of rows) {
        const value = (name) => row.querySelector(`[data-field="${name}"]`).value.trim();
        const blank = value('description') === '' && value('quantity') === '' && value('unit_price') === '';
        const line = blank ? null : lines[at++];
        row.querySelector('[data-amount]').textContent = line && line.amountCents !== null ? formatMoney(line.amountCents) : '-';
      }
    },
    replace(items) {
      list.replaceChildren();
      for (const item of items.length > 0 ? items : [{}]) addRow(item);
    },
  };
}

function init() {
  const form = document.getElementById('pdf-form');
  if (!form) return;
  const tool = form.dataset.tool;
  if (!TOOLS.includes(tool)) return;
  const $ = (id) => document.getElementById(id);
  const submit = $('pdf-submit');
  const status = $('pdf-status');
  const errorBox = $('pdf-error');
  const verifyBox = $('pdf-verify');
  const widgetSlot = $('pdf-widget');
  const result = $('pdf-result');
  const download = $('pdf-download');
  const offNote = $('pdf-off');

  let busy = false;
  let objectUrl = null;
  let widgetId = null;
  let turnstileLoad = null;

  const items = tool === 'invoice' ? itemEditor(form, () => refreshTotals()) : null;

  function refreshTotals() {
    if (!items) return null;
    const totals = invoiceTotals(items.rows(), form.elements.tax_rate.value);
    items.showAmounts(totals.lines);
    const taxed = totals.taxCents !== null;
    $('total-subtotal').textContent = formatMoney(totals.subtotalCents);
    $('total-tax').textContent = taxed ? formatMoney(totals.taxCents) : '-';
    $('total-total').textContent = formatMoney(totals.totalCents);
    // As in the PDF: without a tax rate there is no subtotal or tax line, only the total.
    $('total-subtotal-row').hidden = !taxed;
    $('total-tax-row').hidden = !taxed;
    return totals;
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    submit.setAttribute('aria-busy', String(value));
    submit.textContent = value ? 'Making your PDF…' : 'Create PDF';
  }

  function showError(problem) {
    errorBox.replaceChildren(el('strong', {}, `${problem.title} `), problem.message);
    errorBox.hidden = false;
  }

  function showProblems(problems) {
    errorBox.replaceChildren(el('strong', {}, 'Check the form. '), el('ul', {}, problems.map((text) => el('li', {}, text))));
    errorBox.hidden = false;
  }

  function clearVerify() {
    if (widgetId !== null && window.turnstile) {
      try {
        window.turnstile.remove(widgetId);
      } catch {
        // Already gone.
      }
    }
    widgetId = null;
    widgetSlot.replaceChildren();
    verifyBox.hidden = true;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    turnstileLoad ??= new Promise((resolve, reject) => {
      const script = el('script', { src: TURNSTILE_SRC, async: true });
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

  async function showVerify(siteKey, body) {
    clearVerify();
    verifyBox.hidden = false;
    try {
      const turnstile = await loadTurnstile();
      widgetId = turnstile.render(widgetSlot, {
        sitekey: siteKey,
        theme: 'auto',
        size: widgetSlot.clientWidth < 300 ? 'compact' : 'flexible',
        callback: (token) => send({ ...body, turnstile: token }),
        'error-callback': () => showError({ title: 'The verification did not work.', message: 'Reload the page and try again. Browser extensions that block scripts can stop it.' }),
        'expired-callback': () => {
          if (widgetId !== null) turnstile.reset(widgetId);
        },
      });
    } catch {
      verifyBox.hidden = true;
      showError({ title: 'The verification could not load.', message: 'A browser extension or network filter may be blocking challenges.cloudflare.com. Allow it, or try again later.' });
    }
  }

  /** Builds the request from the form, or shows what to fix and returns null. */
  function buildBody() {
    const values = formValues(form);
    const page = { format: values.format || undefined, landscape: typeof values.landscape === 'boolean' ? values.landscape : undefined };
    if (tool === 'html-to-pdf') {
      if (String(values.html ?? '').trim() === '') {
        showProblems(['Paste or write some HTML first.']);
        return null;
      }
      return { body: toolRequest(tool, { html: values.html, css: values.css, ...page }), filename: fileNameFor(tool) };
    }
    const built = tool === 'invoice' ? invoiceData(values, items.rows()) : certificateData(values);
    if (!built.data) {
      showProblems(built.problems);
      return null;
    }
    return { body: toolRequest(tool, { data: built.data, ...page }), filename: fileNameFor(tool, built.data) };
  }

  let filename = 'document.pdf';

  async function send(body) {
    if (busy) return;
    errorBox.hidden = true;
    if (!body.turnstile) clearVerify();
    setBusy(true);
    status.textContent = 'Making your PDF…';
    let response = null;
    let problem = null;
    try {
      response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/pdf, application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch {
      problem = describeError(0, null);
    }
    if (response && response.ok && (response.headers.get('content-type') ?? '').startsWith('application/pdf')) {
      const blob = await response.blob();
      setBusy(false);
      if (body.turnstile) clearVerify();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      download.href = objectUrl;
      download.download = filename;
      download.textContent = `Download ${filename}`;
      const pages = Number(response.headers.get('x-ltc-pages'));
      $('pdf-result-text').textContent = readyText(Number.isInteger(pages) ? pages : null, blob.size);
      result.hidden = false;
      status.textContent = $('pdf-result-text').textContent;
      download.click();
      download.focus();
      return;
    }
    if (!problem) {
      const json = response ? await response.json().catch(() => null) : null;
      problem = response?.ok
        ? { code: null, title: 'The answer was not a PDF.', message: 'Reload the page and try again.', siteKey: null }
        : describeError(response ? response.status : 0, json, { retryAfter: response ? retryAfterSeconds(response.headers.get('retry-after')) : null });
    }
    setBusy(false);
    if (body.turnstile) clearVerify();
    status.textContent = problem.title;
    if (problem.code === 'verification_required' && problem.siteKey) {
      $('pdf-verify-text').textContent = problem.message;
      showVerify(problem.siteKey, { ...body, turnstile: undefined });
      return;
    }
    if (problem.code === 'not_configured') markNotEnabled();
    showError(problem);
  }

  function markNotEnabled() {
    offNote.hidden = false;
    submit.disabled = true;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const built = buildBody();
    if (!built) {
      errorBox.focus();
      return;
    }
    result.hidden = true;
    filename = built.filename;
    send(built.body);
  });

  // "Fill in an example": the template's own sample, with today's dates.
  const exampleButton = form.querySelector('[data-example]');
  exampleButton?.addEventListener('click', () => {
    const sample = readJsonAttribute(form, 'data-sample') ?? {};
    for (const [key, value] of Object.entries(sample)) {
      const field = form.elements[key];
      // Logo: the samples embed a data: image, which the address field is not for.
      if (field && key !== 'logo_url' && typeof value === 'string' && field.type !== 'date') field.value = value;
    }
    const today = new Date();
    if (form.elements.issue_date) form.elements.issue_date.value = isoDate(today);
    if (form.elements.due_date) form.elements.due_date.value = isoDate(today, 30);
    if (form.elements.date) form.elements.date.value = isoDate(today);
    if (items) {
      items.replace((Array.isArray(sample.items) ? sample.items : []).map(({ description, quantity, unit_price }) => ({ description, quantity, unit_price })));
      // The sample's own rate, worked out from its subtotal and tax, so the totals match the sample.
      const subtotal = parseMoney(sample.subtotal);
      const tax = parseMoney(sample.tax);
      form.elements.tax_rate.value = subtotal > 0 && tax >= 0 ? formatRate((tax / subtotal) * 100) : '';
      refreshTotals();
    }
    errorBox.hidden = true;
    status.textContent = 'The form is filled in with an example.';
  });

  form.querySelector('[data-clear]')?.addEventListener('click', () => {
    form.reset();
    items?.replace([]);
    refreshTotals();
    errorBox.hidden = true;
    status.textContent = 'The form is empty.';
  });

  if (items) {
    items.addRow();
    form.elements.tax_rate.addEventListener('input', () => refreshTotals());
    refreshTotals();
  }
  if (form.elements.issue_date && !form.elements.issue_date.value) form.elements.issue_date.value = isoDate(new Date());
  if (form.elements.date && !form.elements.date.value) form.elements.date.value = isoDate(new Date());

  // Say so up front when this deployment has PDFs switched off, instead of after a failed request.
  fetch(CONFIG_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      if (config && config.pdf_enabled !== true) markNotEnabled();
    })
    .catch(() => {
      // Without the config the form stays usable; the API answers 503 itself when PDFs are off.
    });
}

if (typeof document !== 'undefined') init();
