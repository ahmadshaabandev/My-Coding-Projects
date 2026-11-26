// Pure rules of the dashboard's Bulk tab (./bulk.js): a PDF template's fields, matching
// spreadsheet columns to them, the rows and requests sent to the API, and how a batch's
// progress reads. No DOM and no fetch, so tests/node/bulk-ui.test.ts covers every rule here.
import { columnLetter } from './csv.js';
import { fieldLabel, formatBytes, formatCount } from './helpers.js';

/** Data keys Link To Card fills in for a verified document (src/batch/certificates.ts). A row may not bring its own. */
export const VERIFICATION_KEYS = ['certificate_id', 'verify_url', 'verify_qr'];

/** The one list a PDF template can loop over (src/pdf/template.ts). */
export const LIST_KEY = 'items';

/** Starters the free PDF tools render by id; any other template is previewed through html-to-pdf with its own source. */
export const TOOL_STARTERS = ['invoice', 'certificate'];

/** Batch statuses after which nothing changes any more. queued and running are the others. */
export const FINISHED_STATUSES = ['done', 'partial', 'failed', 'cancelled'];

/* ------------------------------------------------------------------ */
/* Template fields                                                     */
/* ------------------------------------------------------------------ */

/**
 * A field as the Bulk tab uses it: { key, label, kind: 'text' | 'items', required, itemFields }.
 * Starters come from GET /api/batches/templates as { key, label, kind, required, item_fields? }.
 */
export function starterFields(template) {
  return (template?.fields ?? []).map((field) => ({
    key: field.key,
    label: field.label || fieldLabel(field.key),
    kind: field.kind === 'items' ? 'items' : 'text',
    required: field.required === true,
    itemFields: field.kind === 'items' && Array.isArray(field.item_fields) ? [...field.item_fields] : [],
  }));
}

// The PDF engine's own syntax: {{key}}, {{#key}}, {{^key}}, {{/key}} (src/pdf/template.ts).
const TAG = /\{\{\s*([#^/]?)\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

/**
 * The fields of one of the account's own templates, read from its HTML: every {{key}} and
 * section name in order of first use, all optional (a custom template declares nothing), plus
 * `items` when the template loops over {{#items}}. Names used only inside that loop are the
 * line items' fields; a name also used outside it is a field of the document, which the loop
 * can read too.
 */
export function pdfTemplateFields(html) {
  const flat = [];
  const inItems = [];
  const open = [];
  let hasItems = false;
  const note = (name) => {
    const looping = open.some((section) => section.name === LIST_KEY && !section.inverted);
    const list = looping ? inItems : flat;
    if (!list.includes(name)) list.push(name);
  };
  for (const [, marker, name] of String(html ?? '').matchAll(TAG)) {
    if (marker === '/') {
      const at = open.map((section) => section.name).lastIndexOf(name);
      if (at !== -1) open.splice(at);
      continue;
    }
    if (name === LIST_KEY) {
      hasItems = true;
      if (marker) open.push({ name, inverted: marker === '^' });
      continue;
    }
    note(name);
    if (marker) open.push({ name, inverted: marker === '^' });
  }
  const fields = flat.map((key) => ({ key, label: fieldLabel(key), kind: 'text', required: false, itemFields: [] }));
  if (hasItems) {
    fields.push({ key: LIST_KEY, label: 'Line items', kind: 'items', required: false, itemFields: inItems.filter((name) => !flat.includes(name)) });
  }
  return fields;
}

/** True when the template prints a verification field, so "verify" shows on the document itself. */
export function printsVerification(fields) {
  return fields.some((field) => VERIFICATION_KEYS.includes(field.key));
}

/* ------------------------------------------------------------------ */
/* Matching columns to fields                                          */
/* ------------------------------------------------------------------ */

/**
 * What a column can be matched to. A text field is one target; the list is two kinds of
 * target: `items` (a column holding the whole list as JSON) and `items.<field>` (one column per
 * line-item field, which makes a one-line list). With verify on, the verification keys are not
 * targets: Link To Card fills them in, and a row that brings its own is refused.
 */
export function mappingTargets(fields, { verify = false } = {}) {
  const targets = [];
  for (const field of fields) {
    if (verify && VERIFICATION_KEYS.includes(field.key)) continue;
    if (field.kind === 'items') {
      targets.push({ id: LIST_KEY, key: LIST_KEY, kind: 'items', label: `${field.label} (a JSON list)`, required: field.required });
      for (const name of field.itemFields) {
        targets.push({ id: `${LIST_KEY}.${name}`, key: LIST_KEY, item: name, kind: 'item', label: `${field.label}: ${fieldLabel(name).toLowerCase()}`, required: false });
      }
      continue;
    }
    targets.push({ id: field.key, key: field.key, kind: 'text', label: field.label, required: field.required });
  }
  return targets;
}

/** "Recipient Name" -> "recipient_name", "Prénom" -> "prenom": the form column names are compared in. */
export function normaliseName(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const squeeze = (name) => name.replace(/_/g, '');

/** The names a column may carry to match a target, strictest first. */
function targetNames(target) {
  if (target.kind === 'item') return [target.item, `item_${target.item}`, `line_${target.item}`, normaliseName(target.label)];
  if (target.kind === 'items') return [LIST_KEY, 'line_items', normaliseName(target.label)];
  return [target.key, normaliseName(target.label)];
}

/**
 * { [target id]: column index } for the columns whose names match a target: exactly (after
 * normaliseName), then ignoring underscores ("RecipientName"). Each column is matched at most
 * once, document fields before line-item fields, so a "description" column fills a document
 * field of that name when the template has one. `keep` is a mapping to start from (choices
 * already made stay, for targets that still exist); only the targets it leaves open are matched.
 */
export function autoMatch(headers, targets, keep = {}) {
  const names = headers.map(normaliseName);
  const mapping = {};
  for (const target of targets) {
    const column = keep[target.id];
    if (Number.isInteger(column) && column >= 0 && column < headers.length) mapping[target.id] = column;
  }
  const used = new Set(Object.values(mapping));
  const ordered = [...targets.filter((target) => target.kind === 'text'), ...targets.filter((target) => target.kind !== 'text')];
  for (const compare of [(a, b) => a === b, (a, b) => squeeze(a) === squeeze(b)]) {
    for (const target of ordered) {
      if (target.id in mapping) continue;
      const wanted = targetNames(target).filter(Boolean);
      const column = names.findIndex((name, index) => name !== '' && !used.has(index) && wanted.some((candidate) => compare(name, candidate)));
      if (column === -1) continue;
      mapping[target.id] = column;
      used.add(column);
    }
  }
  return mapping;
}

/** "Recipient Name (column B)", or "Column D (no name)" for a header cell left empty. */
export function columnName(headers, index) {
  const name = String(headers[index] ?? '').trim();
  return name === '' ? `Column ${columnLetter(index)} (no name)` : `${name} (column ${columnLetter(index)})`;
}

/** Sentences for what the mapping still lacks before any row can be checked; empty when nothing. */
export function mappingProblems(targets, mapping) {
  const mapped = (target) => mapping[target.id] !== undefined && mapping[target.id] !== null;
  const problems = [];
  for (const target of targets) {
    if (target.kind === 'text' && target.required && !mapped(target)) problems.push(`Choose the column for ${target.label}: the template needs it.`);
  }
  const list = targets.filter((target) => target.key === LIST_KEY);
  if (list.some((target) => target.required) && !list.some(mapped)) {
    problems.push('Choose a column for the line items: the template needs at least one line. Use a column with a JSON list, or one column per line-item field.');
  }
  if (targets.length === 0) problems.push('This template has no {{placeholders}}, so every document would be the same. Choose another template.');
  else if (!targets.some(mapped)) problems.push('Match at least one column to a template field.');
  return problems;
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const isFlat = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** A cell holding the whole list, as JSON: [{"description": "Design", "amount": "1,200.00"}]. */
function parseList(text, label) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { problem: `${label} is not valid JSON. Write it as [{"description": "Design", "amount": "1,200.00"}].` };
  }
  if (!Array.isArray(list) || !list.every((item) => item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).every(isFlat))) {
    return { problem: `${label} must be a JSON list of objects with text or number values.` };
  }
  return { list };
}

/**
 * One row's `data`: the matched cells, trimmed, with empty ones left out (so the template's
 * "no value" state applies), and nothing from an unmatched column. Problems are sentences
 * about this row; the server validates again and has the last word.
 */
export function rowData(cells, mapping, targets, { maxValueChars = Infinity } = {}) {
  const data = {};
  const problems = [];
  const item = {};
  let listTarget = null;
  let listText = '';
  let anyMapped = false;
  for (const target of targets) {
    const column = mapping[target.id];
    if (column === undefined || column === null) continue;
    anyMapped = true;
    const value = String(cells[column] ?? '').trim();
    if (target.kind === 'items') {
      listTarget = target;
      listText = value;
    } else if (target.kind === 'item') {
      if (value !== '') item[target.item] = value;
    } else if (value === '') {
      if (target.required) problems.push(`${target.label} is empty.`);
    } else {
      if (Array.from(value).length > maxValueChars) problems.push(`${target.label} is longer than ${formatCount(maxValueChars)} characters.`);
      data[target.key] = value;
    }
  }
  let listInvalid = false;
  if (listTarget && listText !== '') {
    const { list, problem } = parseList(listText, listTarget.label);
    listInvalid = Boolean(problem);
    if (problem) problems.push(problem);
    else if (list.length > 0) data[LIST_KEY] = list;
  } else if (Object.keys(item).length > 0) {
    data[LIST_KEY] = [item];
  }
  const list = targets.filter((target) => target.key === LIST_KEY);
  const listMapped = list.some((target) => mapping[target.id] !== undefined && mapping[target.id] !== null);
  if (listMapped && list.some((target) => target.required) && !(LIST_KEY in data) && !listInvalid) problems.push('The line items are empty.');
  if (anyMapped && Object.keys(data).length === 0 && problems.length === 0) problems.push('Every matched column is empty.');
  return { data, problems };
}

/**
 * Every row of a parsed file as `data`, and the first `maxProblems` problems as "Row 7: ...",
 * with the spreadsheet's row numbers. `problemCount` counts them all.
 */
export function buildRows(parsed, mapping, targets, { maxValueChars = Infinity, maxProblems = 10 } = {}) {
  const rows = [];
  const problems = [];
  let problemCount = 0;
  parsed.rows.forEach((cells, index) => {
    const built = rowData(cells, mapping, targets, { maxValueChars });
    rows.push(built.data);
    for (const message of built.problems) {
      problemCount++;
      if (problems.length < maxProblems) problems.push(`Row ${parsed.rowNumbers[index]}: ${message}`);
    }
  });
  return { rows, problems, problemCount };
}

/** "rows[3]: ..." from the API, with the spreadsheet row it came from: "rows[3] (row 5 of the file): ...". */
export function explainRowIndex(message, rowNumbers) {
  return String(message ?? '').replace(/rows\[(\d+)\]/g, (whole, index) => (rowNumbers[Number(index)] ? `${whole} (row ${rowNumbers[Number(index)]} of the file)` : whole));
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

function pageOptions(format, landscape) {
  const pdf = {};
  if (typeof format === 'string' && format !== '') pdf.format = format;
  if (typeof landscape === 'boolean') pdf.landscape = landscape;
  return Object.keys(pdf).length > 0 ? pdf : null;
}

/**
 * The body of POST /api/batches. `pdf` and `filename` only when chosen, so the template's
 * page setup and the default file names apply otherwise; `verify` always, as the box says.
 */
export function batchRequest({ template, rows, verify = false, format, landscape, filename }) {
  const body = { template, rows, verify: verify === true };
  const pdf = pageOptions(format, landscape);
  if (pdf) body.pdf = pdf;
  const name = String(filename ?? '').trim();
  if (name !== '') body.filename = name;
  return body;
}

/**
 * The body of POST /api/tools/pdf that previews one row: watermarked, never stored, never
 * counted. The invoice and certificate starters go by id; any other template sends its own
 * source to html-to-pdf, with the starter's paper and orientation unless others were chosen.
 * Verification fields are left out: they exist only once the batch runs.
 * @param template { id, starter: boolean, html?, css?, default_pdf?: { format, landscape } }
 */
export function previewRequest(template, data, { format, landscape } = {}) {
  const clean = Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !VERIFICATION_KEYS.includes(key)));
  let body;
  if (template.starter && TOOL_STARTERS.includes(template.id)) {
    body = { tool: template.id, data: clean };
  } else {
    body = { tool: 'html-to-pdf', html: String(template.html ?? ''), data: clean };
    if (typeof template.css === 'string' && template.css.trim() !== '') body.css = template.css;
    format ||= template.default_pdf?.format;
    if (typeof landscape !== 'boolean' && typeof template.default_pdf?.landscape === 'boolean') landscape = template.default_pdf.landscape;
  }
  const pdf = pageOptions(format, landscape);
  if (pdf) body.pdf = pdf;
  return body;
}

const encoder = new TextEncoder();

/** Size of a JSON body in UTF-8 bytes, as the server counts it. */
export const requestBytes = (body) => encoder.encode(JSON.stringify(body)).length;

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * GET /api/batches/{id} in numbers. `counts` from the server wins; without it the rows are
 * counted. percent only reaches 100 when every document is settled (made, failed or cancelled).
 * `finished` once nothing can change any more: the status is final and no row is being made (a
 * cancelled batch finishes the rows that had already started).
 */
export function batchProgress(batch) {
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  const total = count(batch?.total) ?? rows.length;
  const tally = (status) => count(batch?.counts?.[status]) ?? rows.filter((row) => row.status === status).length;
  const done = tally('done');
  const failed = tally('failed');
  const cancelled = tally('cancelled');
  const settled = Math.min(total, done + failed + cancelled);
  const finished = FINISHED_STATUSES.includes(batch?.status) && tally('running') === 0;
  return {
    total,
    done,
    failed,
    cancelled,
    pending: total - settled,
    percent: total > 0 ? Math.floor((settled / total) * 100) : finished ? 100 : 0,
    finished,
  };
}

const documents = (n) => `${formatCount(n)} document${n === 1 ? '' : 's'}`;

/** "37 of 120 documents made, 2 failed, 81 waiting." */
export function progressText(progress) {
  const parts = [`${formatCount(progress.done)} of ${documents(progress.total)} made`];
  if (progress.failed > 0) parts.push(`${formatCount(progress.failed)} failed`);
  if (progress.cancelled > 0) parts.push(`${formatCount(progress.cancelled)} cancelled`);
  if (progress.pending > 0) parts.push(`${formatCount(progress.pending)} ${progress.finished ? 'not made' : 'waiting'}`);
  return `${parts.join(', ')}.`;
}

const BATCH_STATUS = {
  queued: { label: 'Waiting to start', tone: '' },
  running: { label: 'Making documents', tone: 'accent' },
  done: { label: 'Finished', tone: 'ok' },
  partial: { label: 'Finished, some failed', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: '' },
};

const ROW_STATUS = {
  queued: { label: 'Waiting', tone: '' },
  running: { label: 'Being made', tone: 'accent' },
  done: { label: 'Made', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: '' },
};

/** A status as a badge: { label, tone } where tone is '' or a badge modifier (ok, warn, danger, accent). */
export const batchStatusView = (status) => BATCH_STATUS[status] ?? { label: String(status ?? 'Unknown'), tone: '' };
export const rowStatusView = (status) => ROW_STATUS[status] ?? { label: String(status ?? 'Unknown'), tone: '' };

/** A row's failure as one sentence; the API may send a string or { code, message }. */
export function rowErrorText(row) {
  const error = row?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return typeof error.message === 'string' ? error.message : typeof error.code === 'string' ? error.code : 'Failed.';
}

const errorCode = (row) => (row?.error && typeof row.error === 'object' && typeof row.error.code === 'string' ? row.error.code : null);

/** True when documents failed because the account ran out of images: the fix is billing, not the data. */
export const ranOutOfImages = (batch) => (batch?.rows ?? []).some((row) => errorCode(row) === 'quota_exceeded');

/**
 * Milliseconds before the next look at a running batch: every 2 s for small batches, 4 s for
 * large ones (a large batch's answer is large), twice that after two minutes, when nobody is
 * watching every row any more.
 */
export function pollDelay(elapsedMs, total) {
  const base = total > 500 ? 4000 : 2000;
  return elapsedMs > 120_000 ? base * 2 : base;
}

/** At least this many images: every document counts as at least `unitsPerDocument` (more past the base pages). */
export const minimumImages = (documentCount, unitsPerDocument) => documentCount * unitsPerDocument;

/**
 * The batches this browser started, newest first, at most `max`: the tab lists them so a batch
 * can be found again after the page was closed. Starting the same id again moves it to the top.
 */
export function rememberBatch(list, entry, max = 10) {
  const others = (Array.isArray(list) ? list : []).filter((item) => item && typeof item.id === 'string' && item.id !== entry.id);
  return [entry, ...others].slice(0, max);
}

/** A sentence when a file is too large to read for one batch (checked before reading it), else null. */
export function fileSizeProblem(bytes, maxBytes) {
  if (!(maxBytes > 0) || bytes <= maxBytes) return null;
  return `This file is ${formatBytes(bytes)}. One batch can send at most ${formatBytes(maxBytes)}: split the spreadsheet into smaller files.`;
}

/** "a4" -> "A4", "letter" -> "Letter". */
export const paperLabel = (format) => (/^[a-z]\d$/.test(format) ? format.toUpperCase() : format.charAt(0).toUpperCase() + format.slice(1));

/* ------------------------------------------------------------------ */
/* The batch screen: ZIP parts, totals, the list of batches            */
/* ------------------------------------------------------------------ */

const wholeOrNull = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

/**
 * The ZIP downloads of a batch: one per entry of `zip_parts` ({ part, entries, bytes, url }),
 * in part order, each linking to `<path>/zip?part=N` on this origin (the server's `url` names
 * APP_URL, which a dashboard opened on another host name would not send its cookie to). A batch
 * JSON without `zip_parts` (an older server) gets one download of every finished PDF while any
 * row is done. Nothing finished: no downloads.
 */
export function zipDownloads(batch, path) {
  const parts = Array.isArray(batch?.zip_parts) ? batch.zip_parts : null;
  if (parts === null) {
    const done = wholeOrNull(batch?.counts?.done) ?? (batch?.rows ?? []).filter((row) => row?.status === 'done').length;
    return done > 0 ? [{ part: 1, href: `${path}/zip`, entries: done, bytes: null }] : [];
  }
  return parts
    .filter((part) => Number.isInteger(part?.part) && part.part >= 1)
    .sort((a, b) => a.part - b.part)
    .map((part) => ({ part: part.part, href: `${path}/zip?part=${part.part}`, entries: wholeOrNull(part.entries), bytes: wholeOrNull(part.bytes) }));
}

/** "3 PDFs, 1.2 MB" for one download; without a size, the count alone. */
export function zipPartDetail(download) {
  const count = download.entries === null ? '' : `${formatCount(download.entries)} PDF${download.entries === 1 ? '' : 's'}`;
  const size = download.bytes === null ? '' : formatBytes(download.bytes);
  return [count, size].filter(Boolean).join(', ');
}

/**
 * The label of a download button: one part is "the PDFs", several are numbered. `finished`
 * says whether more documents can still arrive (then it says "made so far").
 */
export function zipPartLabel(download, partCount, finished) {
  if (partCount <= 1) return finished ? 'Download the PDFs (.zip)' : 'Download the PDFs made so far (.zip)';
  return `Download part ${formatCount(download.part)} of ${formatCount(partCount)} (.zip)`;
}

/** "12 pages, 24 images counted." from a batch's totals; '' before anything was made. */
export function batchTotalsText(batch) {
  const pages = wholeOrNull(batch?.pages);
  const images = wholeOrNull(batch?.credits_used);
  if (!pages && !images) return '';
  const parts = [];
  if (pages) parts.push(`${formatCount(pages)} page${pages === 1 ? '' : 's'}`);
  parts.push(`${formatCount(images ?? 0)} image${images === 1 ? '' : 's'} counted`);
  return `${parts.join(', ')}.`;
}

/** A row's file name as the ZIP would carry it, or '' when the API sent none. */
export const rowFilename = (row) => (typeof row?.filename === 'string' ? row.filename : '');

/**
 * Where a row's certificate stands: null without one; otherwise { id, url, revoked }. Revoked
 * when the row says so (`certificate_status` or `revoked_at`, if the server sends them) or when
 * this page revoked it (`revokedHere`, a Set of ids).
 */
export function certificateState(row, revokedHere = new Set()) {
  if (typeof row?.certificate_id !== 'string' || row.certificate_id === '') return null;
  const revoked = row.certificate_status === 'revoked' || (typeof row.revoked_at === 'string' && row.revoked_at !== '') || revokedHere.has(row.certificate_id);
  return { id: row.certificate_id, url: typeof row.verify_url === 'string' && row.verify_url !== '' ? row.verify_url : null, revoked };
}

/**
 * One line of the batch list (GET /api/batches): its title ("Certificate: 3 documents", with
 * the template's name when `templateNames` knows it) and progress in words.
 */
export function batchListEntry(batch, templateNames = {}) {
  const total = wholeOrNull(batch?.total) ?? 0;
  const template = templateNames[batch?.template] ?? batch?.template ?? 'Batch';
  return {
    id: String(batch?.id ?? ''),
    title: `${template}: ${formatCount(total)} document${total === 1 ? '' : 's'}`,
    status: batchStatusView(batch?.status),
    progress: progressText(batchProgress(batch)),
  };
}

/**
 * True once nothing in the batch can change any more (batchProgress's `finished`): its status
 * is final and no row is still being made. A cancelled batch can still have rows running
 * (cancelling stops only the rows that have not started); they finish, and count, after the
 * batch says "cancelled", so the page keeps watching until then.
 */
export const batchSettled = (batch) => batchProgress(batch).finished;

/** True while "Cancel the rest" can still do something: the batch is queued or running. */
export const batchCancellable = (batch) => !FINISHED_STATUSES.includes(batch?.status);
