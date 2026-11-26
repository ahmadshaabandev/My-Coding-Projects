// End-to-end check of the Make app of integrations/make against this repository's real Worker
// under `wrangler dev` (harness.mjs).
//
// There is no Make runtime outside Make, so this script is a small executor of the app's own JSON
// files: base (base URL, Authorization header, error mapping), the connection check, the RPCs and
// every module's communication (requests in order, `condition`, `temp`, `iterate`, `output`,
// response `type`). Expressions inside {{...}} are evaluated by a small interpreter of the
// built-ins the app uses (ifempty, toCollection, merge, replace, decodeURL, length, map and the
// keywords undefined, emptyarray, emptystring), with the semantics integrations/make/README.md
// assumes and lists as unverified; a body key whose value is `undefined` is left out. What this
// proves: every request the definitions produce is one the real API accepts, and the responses
// map into the declared outputs. What it cannot prove: that Make itself evaluates them this way.
//
//   node integrations/e2e/make.mjs [port]     (after npm install in the repository folder)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, recorder, startWorker } from './harness.mjs';

const root = ROOT;
const PORT = Number(process.argv[2] || 8817);
const APP = path.join(root, 'integrations/make/app');
const readApp = (rel) => JSON.parse(readFileSync(path.join(APP, rel), 'utf8'));
const project = readApp('makecomapp.json');
const base = readApp('general/base.iml.json');
const { record, summary } = recorder();

/* ------------------------------------------------------------------ */
/* A small IML interpreter                                             */
/* ------------------------------------------------------------------ */

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== "'") value += text[j++];
      if (text[j] !== "'") throw new Error(`unterminated string in ${text}`);
      tokens.push({ t: 'str', v: value });
      i = j + 1;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      tokens.push({ t: 'num', v: Number(text.slice(i, j)) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push({ t: 'id', v: text.slice(i, j) });
      i = j;
    } else if ('(),.[]'.includes(c)) {
      tokens.push({ t: c });
      i++;
    } else throw new Error(`unexpected "${c}" in ${text}`);
  }
  return tokens;
}

const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const FUNCTIONS = {
  ifempty: (a, b) => (isEmpty(a) ? b : a),
  toCollection: (array, key, value) => Object.fromEntries((array ?? []).map((entry) => [entry[key], entry[value]])),
  merge: (...arrays) => arrays.flatMap((a) => (Array.isArray(a) ? a : a === undefined || a === null ? [] : [a])),
  replace: (text, search, replacement) => String(text ?? '').split(search).join(replacement),
  decodeURL: (text) => decodeURIComponent(String(text)),
  length: (v) => (v === undefined || v === null ? 0 : v.length),
  map: (array, key, filterKey, filterValues) =>
    (array ?? []).filter((item) => filterKey === undefined || String(filterValues).split(',').includes(String(item[filterKey]))).map((item) => item[key]),
};
const KEYWORDS = { undefined: undefined, emptyarray: [], emptystring: '', true: true, false: false, null: null };

function evaluate(text, scope) {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const take = (t) => {
    const token = tokens[at++];
    if (t && token?.t !== t) throw new Error(`expected ${t} in ${text}`);
    return token;
  };
  function primary() {
    const token = take();
    if (token.t === 'str' || token.t === 'num') return token.v;
    if (token.t !== 'id') throw new Error(`unexpected token in ${text}`);
    if (peek()?.t === '(') {
      take('(');
      const args = [];
      while (peek()?.t !== ')') {
        args.push(primary());
        if (peek()?.t === ',') take(',');
      }
      take(')');
      const fn = FUNCTIONS[token.v];
      if (!fn) throw new Error(`unknown function ${token.v}`);
      return fn(...args);
    }
    if (token.v in KEYWORDS) return KEYWORDS[token.v];
    let value = scope[token.v];
    while (peek()?.t === '.' || peek()?.t === '[') {
      if (take().t === '.') value = value?.[take('id').v];
      else {
        const key = primary();
        take(']');
        value = value?.[key];
      }
    }
    return value;
  }
  const value = primary();
  if (at !== tokens.length) throw new Error(`trailing tokens in ${text}`);
  return value;
}

/** A value of a communication file: "{{x}}" keeps x's type; text with {{...}} inside is text. */
function resolve(value, scope) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^{}]*)\}\}$/.exec(value);
    if (whole) return evaluate(whole[1], scope);
    return value.replace(/\{\{([^{}]*)\}\}/g, (_m, expr) => {
      const v = evaluate(expr, scope);
      return v === undefined || v === null ? '' : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const resolved = resolve(entry, scope);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Executing a component                                               */
/* ------------------------------------------------------------------ */

class MakeError extends Error {
  constructor(type, message, statusCode) {
    super(message);
    this.type = type;
    this.statusCode = statusCode;
  }
}

/** Parameter defaults, as a new module in a scenario starts with them (nested ones of the chosen option too). */
function withDefaults(params, values) {
  const out = { ...values };
  for (const param of params) {
    if (out[param.name] === undefined && param.default !== undefined) out[param.name] = param.default;
    if (Array.isArray(param.options)) {
      const chosen = param.options.find((option) => option.value === out[param.name]);
      if (chosen?.nested) Object.assign(out, withDefaults(chosen.nested, out));
    }
  }
  return out;
}

const sentRequests = [];

async function send(request, scope, { useBase = true } = {}) {
  const baseUrl = useBase ? resolve(base.baseUrl, scope) : '';
  let url = resolve(request.url, scope);
  if (url.startsWith('/')) url = `${baseUrl}${url}`;
  const qs = request.qs === undefined ? {} : resolve(request.qs, scope);
  const target = new URL(url);
  for (const [key, value] of Object.entries(qs ?? {})) target.searchParams.set(key, String(value));
  const headers = { ...(useBase ? resolve(base.headers, scope) : {}), ...(request.headers ? resolve(request.headers, scope) : {}) };
  const method = resolve(request.method ?? 'GET', scope);
  const body = request.body === undefined ? undefined : resolve(request.body, scope);
  const init = { method, headers: { ...headers } };
  if (body !== undefined && method !== 'GET') {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  sentRequests.push({ method, url: target.toString(), body });
  const response = await fetch(target, init);
  const types = request.response?.type;
  const type = types ? (types[String(response.status)] ?? types['*'] ?? 'json') : 'json';
  let parsed;
  if (type === 'binary') parsed = Buffer.from(await response.arrayBuffer());
  else {
    const text = await response.text();
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  const responseScope = { ...scope, body: parsed, headers: Object.fromEntries(response.headers), statusCode: response.status };
  if (response.status >= 400) {
    const errors = { ...(base.response?.error ?? {}), ...(request.response?.error ?? {}) };
    const rule = errors[String(response.status)];
    const message = resolve(rule?.message ?? errors.message, responseScope);
    throw new MakeError(rule?.type ?? 'RuntimeError', message, response.status);
  }
  return responseScope;
}

async function runCommunication(communication, scope, options) {
  const requests = Array.isArray(communication) ? communication : [communication];
  const temp = {};
  let output;
  for (const request of requests) {
    const here = { ...scope, temp };
    if (request.condition) {
      const condition = typeof request.condition === 'object' ? request.condition : { condition: request.condition };
      if (!resolve(condition.condition, here)) {
        output = condition.default === undefined ? output : resolve(condition.default, here);
        break;
      }
    }
    const answered = await send(request, here, options);
    if (request.response?.temp) Object.assign(temp, resolve(request.response.temp, answered));
    if (request.response?.iterate) {
      const list = resolve(request.response.iterate, answered) ?? [];
      output = list.map((item) => resolve(request.response.output, { ...answered, item }));
    } else if (request.response?.metadata) {
      output = resolve(request.response.metadata, answered);
    } else if (request.response?.output !== undefined) {
      output = resolve(request.response.output, { ...answered, temp });
    }
  }
  return output;
}

function moduleFiles(id) {
  const files = project.components.module[id].codeFiles;
  return {
    communication: readApp(files.communication),
    params: [...readApp(files.staticParams), ...readApp(files.mappableParams)],
    interface: readApp(files.interface),
  };
}

async function runModule(id, connection, values) {
  const { communication, params } = moduleFiles(id);
  const parameters = withDefaults(params, values);
  try {
    return { value: await runCommunication(communication, { connection, parameters }) };
  } catch (error) {
    return { error };
  }
}

async function runRpc(id, connection) {
  const files = project.components.rpc[id].codeFiles;
  try {
    return { value: await runCommunication(readApp(files.communication), { connection, parameters: {} }) };
  } catch (error) {
    return { error };
  }
}

/** The connection's check: its own URL and header (it does not inherit base). */
async function checkConnection(values) {
  const files = project.components.connection.apiKey.codeFiles;
  const parameters = withDefaults(readApp(files.params), values);
  try {
    return { value: await runCommunication(readApp(files.communication), { parameters }, { useBase: false }) };
  } catch (error) {
    return { error };
  }
}

/** Interface fields the output lacks (top level, and the first row's fields for arrays of collections). */
function missingFields(output, iface) {
  const missing = [];
  for (const field of iface) {
    if (!(field.name in (output ?? {}))) missing.push(field.name);
    else if (field.type === 'array' && Array.isArray(field.spec) && Array.isArray(output[field.name]) && output[field.name].length > 0) {
      for (const child of field.spec) if (!(child.name in output[field.name][0])) missing.push(`${field.name}[].${child.name}`);
    }
  }
  return missing;
}

function zipNames(buf) {
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const n = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + n).toString('utf8'));
    i += 45 + n;
  }
  return names;
}

const errText = (error) => (error ? `${error.type ?? error.name}: ${error.message}` : '');

/* ------------------------------------------------------------------ */

let worker;
try {
  worker = await startWorker(root, PORT, { label: 'make-e2e' });
  const { apiKey, cookie } = await worker.account('make-e2e');
  // The connection's "API address" field only accepts https:// in Make; the local Worker is http://, so it is set here directly.
  const connection = { apiKey, apiUrl: worker.base };
  record('local account and API key', apiKey.startsWith('ltc_'));

  // One template of the account's own, made through the dashboard API, for the "own template" paths.
  const own = await (
    await fetch(`${worker.base}/api/templates`, {
      method: 'POST',
      headers: { origin: worker.base, 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Make letter', html: '<h1>{{title}}</h1><p>{{body}}</p>', css: 'h1 { font-size: 64px }' }),
    })
  ).json();
  record('an own template for the "own template" paths (dashboard API)', /^t_/.test(own.template?.id ?? ''), own.template?.id);

  /* connection */
  const check = await checkConnection({ apiKey, apiUrl: worker.base });
  record('connection check: GET /v1/usage, labelled with the plan', check.value?.type === 'text' && check.value?.value === 'free plan', JSON.stringify(check.value ?? errText(check.error)));
  const badCheck = await checkConnection({ apiKey: 'ltc_wrong_key_for_e2e', apiUrl: worker.base });
  record('a wrong key: InvalidAccessTokenError "[401] ... (error code: invalid_api_key)"', badCheck.error?.type === 'InvalidAccessTokenError' && /^\[401\] .+ \(error code: invalid_api_key\)$/.test(badCheck.error.message), errText(badCheck.error));

  /* RPCs */
  const cards = await runRpc('listCardTemplates', connection);
  record('RPC listCardTemplates: the five starters and the own template', cards.value?.length === 6 && cards.value.some((o) => o.value === 'blog') && cards.value.some((o) => o.value === own.template?.id), JSON.stringify(cards.value ?? errText(cards.error)));
  const owns = await runRpc('listOwnTemplates', connection);
  record('RPC listOwnTemplates: only the own template', owns.value?.length === 1 && owns.value[0].value === own.template?.id && owns.value[0].label === 'Make letter', JSON.stringify(owns.value ?? errText(owns.error)));

  /* cards */
  const card = await runModule('createCardImage', connection, { template: 'blog', data: [{ key: 'title', value: 'Make end to end' }] });
  record('Create a card image: POST /v1/images, the API answer unchanged', card.value?.width === 1200 && card.value?.format === 'png' && /\/i\//.test(card.value?.url), card.value?.url ?? errText(card.error));
  const cardEmpty = await runModule('createCardImage', connection, { template: 'blog', data: [{ key: 'title', value: 'Empty optional fields' }], size: '', format: '' });
  record('empty Size and Image format are left out: 1200 x 630 PNG', cardEmpty.value?.width === 1200 && cardEmpty.value?.height === 630 && cardEmpty.value?.format === 'png', cardEmpty.value ? `${cardEmpty.value.width}x${cardEmpty.value.height} ${cardEmpty.value.format}` : errText(cardEmpty.error));
  const cardFile = await runModule('createCardImage', connection, { template: 'blog', data: [{ key: 'title', value: 'Make download' }], size: 'square', format: 'webp', downloadFile: true });
  const cardIface = moduleFiles('createCardImage').interface;
  record(
    'Download the file = Yes: the image as File name and Data, every interface field present',
    Buffer.isBuffer(cardFile.value?.data) && cardFile.value.data.subarray(0, 4).toString() === 'RIFF' && cardFile.value.fileName === `${cardFile.value.id}.webp` && missingFields(cardFile.value, cardIface).length === 0,
    cardFile.value ? `${cardFile.value.fileName} ${cardFile.value.data?.length} bytes; missing: ${missingFields(cardFile.value, cardIface).join(',')}` : errText(cardFile.error),
  );
  const email = await runModule('createCardImage', connection, { template: 'email-banner', data: [{ key: 'title', value: 'Email' }], size: 'email' });
  record('Size "Email": 1200 x 400', email.value?.width === 1200 && email.value?.height === 400, email.value ? `${email.value.width}x${email.value.height}` : errText(email.error));
  const ownCard = await runModule('createCardImage', connection, { template: own.template?.id, data: [{ key: 'title', value: 'Own' }] });
  record('Create a card image with the own template', ownCard.value?.template === own.template?.id, ownCard.value?.template ?? errText(ownCard.error));
  const badField = await runModule('createCardImage', connection, { template: 'blog', data: [{ key: 'Bad-Key', value: 'x' }] });
  record('an invalid field name: DataError "[400] ... (error code: invalid_request)"', badField.error?.type === 'DataError' && /^\[400\] /.test(badField.error.message), errText(badField.error));

  /* PDF */
  const invoice = {
    seller_name: 'Fernhill Studio',
    buyer_name: 'Acme',
    invoice_number: 'INV-9',
    issue_date: '2026-11-26',
    total: '120.00',
    items: [{ description: 'Workshop', amount: '120.00' }],
  };
  const pdf = await runModule('createPdf', connection, { template: 'invoice', data: invoice, filename: 'invoice-INV-9.pdf', pageFormat: 'letter' });
  const pdfIface = moduleFiles('createPdf').interface;
  record(
    'Create a PDF (download on by default): POST /v1/pdf then the stored PDF as a file under its own name',
    Buffer.isBuffer(pdf.value?.data) && pdf.value.data.subarray(0, 5).toString() === '%PDF-' && pdf.value.fileName === 'invoice-INV-9.pdf' && pdf.value.pages === 1 && pdf.value.credits_used === 2 && missingFields(pdf.value, pdfIface).length === 0,
    pdf.value ? `${pdf.value.fileName} pages=${pdf.value.pages}; missing: ${missingFields(pdf.value, pdfIface).join(',')}` : errText(pdf.error),
  );
  const pdfLink = await runModule('createPdf', connection, { template: 'own', ownTemplate: own.template?.id, fields: [{ key: 'title', value: 'Letter' }, { key: 'body', value: 'Hello' }], downloadFile: false });
  record('Create a PDF from the own template with a key/value list, link only', pdfLink.value?.pages === 1 && pdfLink.value?.template === own.template?.id && !('data' in pdfLink.value), pdfLink.value ? `${pdfLink.value.filename} ${pdfLink.value.url}` : errText(pdfLink.error));
  const pdfEmpty = await runModule('createPdf', connection, { template: 'report', data: { title: 'Q3' }, filename: '', pageFormat: '', downloadFile: false });
  record('empty File name and Page size are left out (the API refuses them empty)', pdfEmpty.value?.pages === 1, pdfEmpty.value ? pdfEmpty.value.filename : errText(pdfEmpty.error));

  /* link cards */
  const local = await runModule('cardFromLink', connection, { url: `${worker.base}/` });
  record('Create a card from a link reaches the route; a non-public address: DataError [400]', local.error?.type === 'DataError' && /^\[400\] /.test(local.error.message), errText(local.error));
  const outside = await runModule('cardFromLink', connection, { url: 'https://example.com/', overrides: [{ key: 'title', value: 'Override' }] });
  record('Create a card from a link of https://example.com/ (needs outbound network from workerd)', true, outside.value ? `${outside.value.width}x${outside.value.height} title=${outside.value.link?.data?.title}` : errText(outside.error));

  /* bulk PDFs */
  const people = ['Amara Nwosu', 'Jonas Berg', 'Mei Lin'].map((name) => ({ title: 'Certificate', recipient_name: name, achievement: 'Intro course', issuer_name: 'Fernhill', date: '2026-11-26' }));
  const start = await runModule('startBulkPdfs', connection, { template: 'certificate', rows: people, verify: true, filename: 'certificate-[recipient_name]-[n].pdf' });
  const startIface = moduleFiles('startBulkPdfs').interface;
  record(
    'Start bulk PDFs: POST /v1/batches, 202 queued, every interface field present',
    start.value?.status === 'queued' && start.value.total === 3 && missingFields(start.value, startIface).length === 0,
    start.value ? `${start.value.id}; sent filename ${JSON.stringify(sentRequests.at(-1)?.body?.filename)}` : errText(start.error),
  );
  if (start.value?.id) {
    await worker.waitForBatch(apiKey, start.value.id);
    const got = await runModule('getBatch', connection, { id: start.value.id });
    const getIface = moduleFiles('getBatch').interface.filter((field) => field.name !== 'fileName' && field.name !== 'data');
    record(
      'Get a batch (no download): the API answer, rows named from [key]/[n], one zip part, every interface field present',
      got.value?.status === 'done' && got.value.rows.length === 3 && got.value.zip_parts.length === 1 && missingFields(got.value, getIface).length === 0,
      got.value ? `${got.value.rows.map((r) => r.filename).join(' | ')}; missing: ${missingFields(got.value, getIface).join(',')}` : errText(got.error),
    );
    const zip = await runModule('getBatch', connection, { id: start.value.id, downloadZip: true });
    const names = Buffer.isBuffer(zip.value?.data) ? zipNames(zip.value.data) : [];
    record(
      'Get a batch with Download the zip file: part 1 (the default) as File name and Data',
      zip.value?.data?.readUInt32LE(0) === 0x04034b50 && zip.value.fileName === `${start.value.id}-part-1.zip` && zip.value.data.length === got.value?.zip_parts?.[0]?.bytes && names.length === 3 && sentRequests.at(-1).url.endsWith('/zip?part=1'),
      zip.value ? `${zip.value.fileName} ${zip.value.data?.length} bytes: ${names.join(', ')}` : errText(zip.error),
    );
    record('every Get a batch interface field is in the download output', zip.value && missingFields(zip.value, moduleFiles('getBatch').interface).length === 0, missingFields(zip.value, moduleFiles('getBatch').interface).join(','));
    const part2 = await runModule('getBatch', connection, { id: start.value.id, downloadZip: true, zipPart: 2 });
    record('Zip part 2 of a one-part batch: DataError "[404] ... (error code: not_found)" with the API message', part2.error?.type === 'DataError' && /^\[404\] This batch's ZIP has 1 part/.test(part2.error.message), errText(part2.error));
  }
  const ownBatch = await runModule('startBulkPdfs', connection, { template: 'own', ownTemplate: own.template?.id, rows: [{ title: 'A', body: 'x' }, { title: 'B', body: 'y' }] });
  record('Start bulk PDFs with the own template: queued, verification off by default', ownBatch.value?.status === 'queued' && ownBatch.value.verify === false && ownBatch.value.template === own.template?.id, ownBatch.value ? ownBatch.value.id : errText(ownBatch.error));
  if (ownBatch.value?.id) {
    await worker.waitForBatch(apiKey, ownBatch.value.id);
    const got = await runModule('getBatch', connection, { id: ownBatch.value.id });
    record('own-template rows are named document-1.pdf, document-2.pdf (decision D4)', got.value?.rows?.map((r) => r.filename).join(',') === 'document-1.pdf,document-2.pdf', got.value?.rows?.map((r) => r.filename).join(',') ?? errText(got.error));
  }
  const tooMany = await runModule('startBulkPdfs', connection, { template: 'report', rows: Array.from({ length: 26 }, (_, i) => ({ title: `T${i}` })) });
  record('26 rows on Free: "[403] ... (error code: plan_required)"', /^\[403\] A batch on the Free plan may have at most 25 rows.*\(error code: plan_required\)$/.test(tooMany.error?.message ?? ''), errText(tooMany.error));
  let conflict = null;
  for (let i = 0; i < 3 && !conflict; i++) {
    const next = await runModule('startBulkPdfs', connection, { template: 'report', rows: [{ title: 'A' }, { title: 'B' }] });
    if (next.error) conflict = next.error;
  }
  record('a batch over the active limit: "[409] ... (error code: conflict)"', /^\[409\] .+\(error code: conflict\)$/.test(conflict?.message ?? ''), errText(conflict));
  const missing = await runModule('getBatch', connection, { id: 'bat_nope' });
  record('Get a batch of an unknown id: DataError [404]', missing.error?.type === 'DataError' && /^\[404\] No batch/.test(missing.error.message), errText(missing.error));

  /* link preview */
  const inspectLocal = await runModule('checkLinkPreview', connection, { url: `${worker.base}/` });
  record('Check a link preview of a non-public address: DataError [400] with the API message', inspectLocal.error?.type === 'DataError', errText(inspectLocal.error));
  const inspect = await runModule('checkLinkPreview', connection, { url: 'https://example.com/' });
  record('Check a link preview of https://example.com/ (needs outbound network from workerd)', true, inspect.value ? `fail_count=${inspect.value.fail_count}` : errText(inspect.error));

  /* universal module */
  const usage = await runModule('makeApiCall', connection, { url: 'v1/usage', method: 'GET' });
  record('Make an API call: GET v1/usage', usage.value?.statusCode === 200 && usage.value.body.plan === 'free', JSON.stringify({ statusCode: usage.value?.statusCode, plan: usage.value?.body?.plan }));
  const viaUniversal = await runModule('makeApiCall', connection, { url: 'v1/images', method: 'POST', body: { template: 'blog', data: { title: 'Universal' } }, headers: [{ key: 'Accept', value: 'application/json' }] });
  record('Make an API call: POST v1/images with a body and a header', viaUniversal.value?.statusCode === 200 && viaUniversal.value.body.width === 1200, JSON.stringify({ statusCode: viaUniversal.value?.statusCode, error: errText(viaUniversal.error) }));
  const batches = await runModule('makeApiCall', connection, { url: 'v1/batches', method: 'GET', qs: [{ key: 'limit', value: '2' }] });
  record('Make an API call: GET v1/batches?limit=2 (the listing no module covers)', batches.value?.statusCode === 200 && batches.value.body.batches.length === 2, JSON.stringify({ count: batches.value?.body?.batches?.length, next: batches.value?.body?.next_before }));
} catch (error) {
  record('run', false, `${error.stack}\n${worker?.log().slice(-2000) ?? ''}`);
} finally {
  await worker?.stop();
}
process.exit(summary('make') ? 1 : 0);
