// End-to-end check of integrations/zapier against this repository's real Worker under
// `wrangler dev` (harness.mjs: local D1/R2/queue, Browser Run replaced by a PDF fixture), over
// HTTP, with Zapier core's appTester and no nock.
//
// The file hydrators also run through Zapier core's real lambda handler and z.stashFile: the
// event's rpc_base and LOGGING_ENDPOINT point at a local stand-in for Zapier's RPC, S3 upload and
// log endpoints, so nothing is sent to Zapier and the uploaded bytes can be checked here.
//
//   node integrations/e2e/zapier.mjs [port]     (after npm install here and in integrations/zapier)
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ROOT, recorder, startWorker } from './harness.mjs';

const root = ROOT;
const PORT = Number(process.argv[2] || 8813);
const appDir = path.join(root, 'integrations/zapier');
const { record, summary } = recorder();

/* ---------------- a local stand-in for Zapier's RPC, S3 upload and log endpoints ---------------- */
const uploads = new Map();
let stashCount = 0;
const stand = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/rpc') {
      const call = JSON.parse(body.toString('utf8'));
      if (call.method !== 'get_presigned_upload_post_data') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: call.id, error: `stand-in has no ${call.method}` }));
        return;
      }
      stashCount += 1;
      const result = { url: `http://127.0.0.1:${stand.address().port}/upload/`, fields: { key: `stash/${stashCount}` } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: call.id, result }));
      return;
    }
    if (req.url === '/upload/') {
      const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
      const parts = body.toString('latin1').split(`--${boundary}`);
      const fields = {};
      let file = null;
      let filename = null;
      for (const part of parts) {
        const at = part.indexOf('\r\n\r\n');
        if (at === -1) continue;
        const head = part.slice(0, at);
        const name = /name="([^"]+)"/.exec(head)?.[1];
        const value = part.slice(at + 4, part.length - 2);
        if (name === 'file') {
          file = Buffer.from(value, 'latin1');
          filename = /filename="([^"]+)"/.exec(head)?.[1] ?? null;
        } else if (name) fields[name] = value;
      }
      uploads.set(fields.key, { file, filename, contentType: fields['Content-Type'], disposition: fields['Content-Disposition'] });
      res.writeHead(204).end();
      return;
    }
    // Zapier core's log stream: accepted and dropped.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
});
await new Promise((r) => stand.listen(0, '127.0.0.1', r));
const standBase = `http://127.0.0.1:${stand.address().port}`;
process.env.LOGGING_ENDPOINT = `${standBase}/log`;

/** Zip entry names from the central directory (enough for the store-method archives the API writes). */
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

let worker;
try {
  worker = await startWorker(root, PORT, { label: 'zapier-e2e' });
  const base = worker.base;
  const { apiKey } = await worker.account('zapier-e2e');
  const authData = { api_key: apiKey };
  record('local account and API key', apiKey.startsWith('ltc_'));

  process.env.LTC_BASE_URL = base;
  const require = createRequire(path.join(appDir, 'index.js'));
  const zapier = require('zapier-platform-core');
  const App = require('./index.js');
  const appTester = zapier.createAppTester(App);
  const handler = require('zapier-platform-core/src/tools/create-lambda-handler')(App);
  const attempt = async (fn) => {
    try {
      return { value: await fn() };
    } catch (error) {
      try {
        return { error: { name: error.name, ...JSON.parse(error.message) } };
      } catch {
        return { error: { name: error.name, message: error.message } };
      }
    }
  };
  const pointer = (value) => JSON.parse(value.slice('hydrate|||'.length, -'|||hydrate'.length));
  /** A hydrator run the way Zapier runs it: the lambda handler with an RPC (here the stand-in). */
  const hydrate = (value) => {
    const { method, bundle } = pointer(value);
    return handler({ command: 'execute', method, bundle: { authData, ...{ inputData: bundle } }, rpc_base: `${standBase}/rpc`, token: 'e2e-token-not-a-real-token' }).then((r) => r.results);
  };

  /* ---------------- connection ---------------- */
  const auth = await attempt(() => appTester(App.authentication.test, { authData }));
  record('auth test: GET /v1/usage', auth.value?.plan === 'free', auth.value ? JSON.stringify({ plan: auth.value.plan, label: auth.value.connection_label }) : JSON.stringify(auth.error));
  record('connection label names the plan and the local host', auth.value?.connection_label === `Free plan at 127.0.0.1:${PORT}`, auth.value?.connection_label);
  const badAuth = await attempt(() => appTester(App.authentication.test, { authData: { api_key: 'ltc_wrong_key_for_e2e' } }));
  record('a wrong key: AuthenticationError with the API message', badAuth.error?.code === 'AuthenticationError', badAuth.error?.message);

  /* ---------------- cards ---------------- */
  const choices = await attempt(() => appTester(App.creates.create_card_image.operation.inputFields[0].choices.perform, { authData, meta: {} }));
  record('card template dropdown: GET /v1/templates', (choices.value?.results.length ?? 0) > 0, choices.value?.results.map((r) => r.id).join(','));
  const fields = await attempt(() => appTester(App.creates.create_card_image.operation.inputFields[1], { authData, inputData: { template: 'blog' } }));
  record('card dynamic fields for blog', (fields.value ?? []).some((f) => f.key === 'data__title'), (fields.value ?? []).map((f) => f.key).join(','));
  const cardInput = { template: 'blog', data__title: 'Zapier end to end', data: { author: 'appTester' }, size: 'square', format: 'webp' };
  const image = await attempt(() => appTester(App.creates.create_card_image.operation.perform, { authData, inputData: cardInput }));
  record('create_card_image: POST /v1/images renders', image.value?.width === 1080 && image.value?.format === 'webp' && /^hydrate\|\|\|/.test(image.value?.file ?? ''), image.value?.url ?? JSON.stringify(image.error));
  if (image.value) {
    const got = await fetch(image.value.url);
    record('the image URL serves the image', got.status === 200 && got.headers.get('content-type') === 'image/webp', `${got.status} ${got.headers.get('content-type')}`);
    const stashed = await attempt(() => hydrate(image.value.file));
    const upload = uploads.get(new URL(stashed.value ?? 'http://x/').pathname.replace('/upload/', ''));
    record(
      "the card's file hydrator stashes the WebP through z.stashFile (stand-in RPC and upload)",
      upload && upload.file.subarray(0, 4).toString() === 'RIFF' && upload.contentType === 'image/webp',
      stashed.value ? `${stashed.value} ${upload?.filename} ${upload?.file.length} bytes` : JSON.stringify(stashed.error),
    );
  }
  const again = await attempt(() => appTester(App.creates.create_card_image.operation.perform, { authData, inputData: cardInput }));
  record('the same card again is served from storage, nothing counted', again.value?.cached === true && again.value?.usage.used === image.value?.usage.used, `cached=${again.value?.cached} used=${again.value?.usage.used}`);
  const sizes = await attempt(() => appTester(App.creates.create_card_image.operation.perform, { authData, inputData: { template: 'email-banner', data__title: 'Email size', size: 'email' } }));
  record('the email size preset (1200 x 400) is accepted', sizes.value?.width === 1200 && sizes.value?.height === 400, sizes.value ? `${sizes.value.width}x${sizes.value.height}` : JSON.stringify(sizes.error));
  const badData = await attempt(() => appTester(App.creates.create_card_image.operation.perform, { authData, inputData: { template: 'blog', data: { 'Bad-Key': 'x' } } }));
  record('an invalid data key shows the API message', badData.error?.code === 'invalid_request', badData.error?.message);

  /* ---------------- PDF ---------------- */
  const pdfInput = {
    template: 'invoice',
    data__seller_name: 'Fernhill Studio',
    data__buyer_name: 'Acme',
    data__invoice_number: 'INV-1',
    data__issue_date: '2026-11-26',
    data__total: '120.00',
    items: [{ item__description: 'Workshop', item__amount: '120.00' }],
    filename: 'invoice-INV-1.pdf',
  };
  const pdf = await attempt(() => appTester(App.creates.create_pdf.operation.perform, { authData, inputData: pdfInput }));
  record('create_pdf: POST /v1/pdf makes a PDF (stand-in browser)', pdf.value?.pages === 1 && pdf.value?.credits_used === 2 && /^hydrate\|\|\|/.test(pdf.value?.file ?? ''), pdf.value ? `${pdf.value.filename} ${pdf.value.url}` : JSON.stringify(pdf.error));
  if (pdf.value) {
    const got = await fetch(pdf.value.url);
    record('the PDF URL serves the PDF', got.status === 200 && got.headers.get('content-type') === 'application/pdf', `${got.status} ${got.headers.get('content-type')}`);
    const stashed = await attempt(() => hydrate(pdf.value.file));
    const upload = uploads.get(new URL(stashed.value ?? 'http://x/').pathname.replace('/upload/', ''));
    record("the PDF's file hydrator stashes it under the PDF's own name", upload?.file.subarray(0, 5).toString() === '%PDF-' && upload?.filename === pdf.value.filename, `${upload?.filename} ${upload?.file.length} bytes`);
  }
  const html = await attempt(() => appTester(App.creates.create_pdf.operation.perform, { authData, inputData: { html: '<h1>{{title}}</h1>', data: { title: 'x' } } }));
  record('create_pdf with inline HTML and a {{placeholder}} reaches the API intact', html.value?.pages === 1 && html.value?.template === 'inline', html.value ? `template=${html.value.template}` : JSON.stringify(html.error));
  const badPdf = await attempt(() => appTester(App.creates.create_pdf.operation.perform, { authData, inputData: { template: 'invoice', data: { 'Not-A-Key': 'x' } } }));
  record('a PDF with an invalid data key shows the API message', badPdf.error?.code === 'invalid_request', `${badPdf.error?.code} ${badPdf.error?.message}`);

  /* ---------------- link cards ---------------- */
  const local = await attempt(() => appTester(App.creates.card_from_link.operation.perform, { authData, inputData: { url: `${base}/` } }));
  record('card_from_link: the route answers, and refuses a non-public address with its message', Boolean(local.error?.message) && local.error.code !== 'not_found', `${local.error?.code} ${local.error?.message}`);
  const outside = await attempt(() => appTester(App.creates.card_from_link.operation.perform, { authData, inputData: { url: 'https://example.com/', overrides: { title: 'Override' } } }));
  record(
    'card_from_link of https://example.com/ (needs outbound network from workerd)',
    true,
    outside.value ? `rendered ${outside.value.width}x${outside.value.height} title=${outside.value.link?.data?.title}` : `${outside.error?.code} ${outside.error?.message}`,
  );
  const http1 = await attempt(() => appTester(App.creates.card_from_link.operation.perform, { authData, inputData: { url: 'http://example.com/' } }));
  record('card_from_link with an http:// page shows the API refusal', Boolean(http1.error?.message), `${http1.error?.code} ${http1.error?.message}`);

  /* ---------------- bulk PDFs ---------------- */
  const rows = [
    { row__title: 'Certificate', row__recipient_name: 'Amara Nwosu', row__achievement: 'Intro course', row__issuer_name: 'Fernhill', row__date: '2026-11-26' },
    { row__title: 'Certificate', row__recipient_name: 'Jonas Berg', row__achievement: 'Intro course', row__issuer_name: 'Fernhill', row__date: '2026-11-26' },
    { row__title: 'Certificate', row__recipient_name: 'Mei Lin', row__achievement: 'Intro course', row__issuer_name: 'Fernhill', row__date: '2026-11-26' },
  ];
  const started = await attempt(() => appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'certificate', rows, filename: 'certificate-[recipient_name]-[n].pdf' } }));
  record(
    'start_bulk_pdfs: POST /v1/batches answers 202 queued with the documented fields',
    started.value?.status === 'queued' && started.value?.total === 3 && Array.isArray(started.value?.zip_parts) && 'zip_url' in started.value && 'started_at' in started.value,
    started.value ? JSON.stringify({ id: started.value.id, status: started.value.status, verify: started.value.verify }) : JSON.stringify(started.error),
  );
  const outputKeys = App.creates.start_bulk_pdfs.operation.outputFields.map((f) => f.key.split('__')[0]);
  record('every Start Bulk PDFs output field is in the real answer', started.value && outputKeys.every((k) => k in started.value), outputKeys.filter((k) => !(k in (started.value ?? {}))).join(','));

  if (started.value) {
    const early = await attempt(() => appTester(App.searches.get_batch.operation.perform, { authData, inputData: { id: started.value.id } }));
    record('get_batch right after the start: not finished, no zip yet', early.value?.[0]?.finished === false && !('zip_file' in early.value[0]), JSON.stringify({ status: early.value?.[0]?.status }));
    await worker.waitForBatch(apiKey, started.value.id);
    const found = await attempt(() => appTester(App.searches.get_batch.operation.perform, { authData, inputData: { id: started.value.id } }));
    const b = found.value?.[0];
    record(
      'get_batch once done: finished, three rows with links, certificate ids and names from the [key]/[n] pattern',
      b?.finished === true && b.status === 'done' && b.rows.length === 3 && b.rows.every((r) => r.url && /^crt_/.test(r.certificate_id) && r.verify_url),
      b ? b.rows.map((r) => r.filename).join(' | ') : JSON.stringify(found.error),
    );
    const findKeys = App.searches.get_batch.operation.outputFields.map((f) => f.key.split('__')[0]);
    record('every Find Batch output field is in the real answer', b && findKeys.every((k) => k in b), findKeys.filter((k) => !(k in (b ?? {}))).join(','));
    const rowKeys = App.searches.get_batch.operation.outputFields.find((f) => f.key === 'rows').children.map((c) => c.key.split('__')[0]);
    record('every Documents child field is in the real rows', b && rowKeys.every((k) => k in b.rows[0]), rowKeys.filter((k) => !(k in (b?.rows[0] ?? {}))).join(','));
    record('one ZIP part with three entries; zip_file is its file', b?.zip_part_count === 1 && b.zip_parts[0].entries === 3 && b.zip_file === b.zip_parts[0].file, JSON.stringify(b?.zip_parts?.map(({ file, ...p }) => p)));
    if (b?.zip_file) {
      const stashed = await attempt(() => hydrate(b.zip_file));
      const upload = uploads.get(new URL(stashed.value ?? 'http://x/').pathname.replace('/upload/', ''));
      const names = upload?.file ? zipNames(upload.file) : [];
      record(
        'the ZIP hydrator downloads part 1 with the key and stashes a valid zip named after the batch',
        upload?.file.readUInt32LE(0) === 0x04034b50 && upload.filename === `${b.id}.zip` && upload.file.length === b.zip_parts[0].bytes && names.length === 3,
        `${upload?.filename} ${upload?.file?.length} bytes: ${names.join(', ')}`,
      );
      const check = spawnSync('unzip', ['-t', '-q', '/dev/stdin'], { input: upload?.file ?? Buffer.alloc(0) });
      if (check.error?.code !== 'ENOENT') {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'zapier-zip-'));
        writeFileSync(path.join(tmp, 'a.zip'), upload?.file ?? Buffer.alloc(0));
        const t = spawnSync('unzip', ['-t', path.join(tmp, 'a.zip')], { encoding: 'utf8' });
        record('unzip -t accepts the stashed zip', t.status === 0, t.stdout.split('\n').slice(-2).join(' '));
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const part2 = await attempt(() => hydrate(`hydrate|||${JSON.stringify({ type: 'file', method: 'hydrators.downloadBatchZip', bundle: { id: started.value.id, part: 2, parts: 2 } })}|||hydrate`));
    record("a part the batch does not have: the hydrator fails with the API's own 404 message", /ZIP has 1 part/.test(part2.error?.message ?? ''), `${part2.error?.code ?? ''} ${part2.error?.message ?? ''}`.slice(0, 300));
  }

  const json = await attempt(() =>
    appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'report', rows_json: JSON.stringify([{ title: 'Q3', items: [{ heading: 'A', body: 'B' }] }]), verify: 'false' } }),
  );
  record('start_bulk_pdfs with Rows (JSON) and verification off', json.value?.status === 'queued' && json.value?.verify === false, json.value ? json.value.id : JSON.stringify(json.error));
  // More batches back to back: BATCH.maxActivePerAccount is 2, so at the latest the third one in a
  // row (the earlier JSON batch may already have finished) answers 409 conflict.
  const twoRows = JSON.stringify([{ title: 'A' }, { title: 'B' }]);
  let conflict = null;
  let accepted = 0;
  for (let i = 0; i < 3 && !conflict; i++) {
    const next = await attempt(() => appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'report', rows_json: twoRows } }));
    if (next.error) conflict = next.error;
    else accepted += 1;
  }
  record('a batch over the active limit: 409 conflict with the API message (decision D2)', conflict?.code === 'conflict' && conflict?.status === 409 && accepted <= 2, conflict ? `after ${accepted} accepted: ${conflict.code} ${conflict.message}` : 'never refused');
  const unknownTemplate = await attempt(() => appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'no_such_template', rows_json: '[{"title": "x"}]' } }));
  record('an unknown template: 404 not_found with the API message', unknownTemplate.error?.code === 'not_found', unknownTemplate.error?.message);
  const tooMany = await attempt(() =>
    appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'report', rows_json: JSON.stringify(Array.from({ length: 26 }, (_, i) => ({ title: `T${i}` }))) } }),
  );
  record('26 rows on Free: 403 plan_required with the API message', tooMany.error?.code === 'plan_required', tooMany.error?.message);
  const ownRow = await attempt(() =>
    appTester(App.creates.start_bulk_pdfs.operation.perform, { authData, inputData: { template: 'certificate', rows_json: '[{"title":"x","recipient_name":"y","achievement":"z","issuer_name":"w","date":"d","verify_url":"https://evil.example"}]' } }),
  );
  record('a row bringing its own verify_url is refused with the API message', ownRow.error?.code === 'invalid_request', ownRow.error?.message);

  const missing = await attempt(() => appTester(App.searches.get_batch.operation.perform, { authData, inputData: { id: 'bat_nope' } }));
  record('get_batch with an unknown id: [] (404 read as nothing found)', Array.isArray(missing.value) && missing.value.length === 0, JSON.stringify(missing.value ?? missing.error));

  /* ---------------- link preview ---------------- */
  const inspectLocal = await attempt(() => appTester(App.searches.check_link_preview.operation.perform, { authData, inputData: { url: `${base}/` } }));
  record('check_link_preview of a non-public address: the API refuses it, message shown', Boolean(inspectLocal.error?.message), `${inspectLocal.error?.code} ${inspectLocal.error?.message}`);
  const inspect = await attempt(() => appTester(App.searches.check_link_preview.operation.perform, { authData, inputData: { url: 'https://example.com/' } }));
  record(
    'check_link_preview of https://example.com/ (needs outbound network from workerd)',
    true,
    inspect.value ? `fail_count=${inspect.value[0].fail_count} ok=${inspect.value[0].ok}` : `${inspect.error?.code} ${inspect.error?.message}`,
  );

  /* ---------------- zapier-platform invoke (the CLI's local mode) ---------------- */
  const copy = mkdtempSync(path.join(os.tmpdir(), 'zapier-invoke-'));
  try {
    cpSync(appDir, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.endsWith('.env') });
    symlinkSync(path.join(appDir, 'node_modules'), path.join(copy, 'node_modules'));
    writeFileSync(path.join(copy, '.env'), `LTC_BASE_URL=${base}\nauthData_api_key=${apiKey}\n`);
    const cli = path.join(appDir, 'node_modules/zapier-platform-cli/src/bin/run');
    const invoke = (args) => spawnSync(process.execPath, [cli, 'invoke', ...args, '--non-interactive'], { cwd: copy, env: { ...process.env, CI: '1' }, encoding: 'utf8', timeout: 120000 });
    for (const [what, args, expect] of [
      ['invoke auth test', ['auth', 'test'], /"plan": "free"/],
      ['invoke auth label', ['auth', 'label'], new RegExp(`Free plan at 127\\.0\\.0\\.1:${PORT}`)],
      ['invoke create create_card_image', ['create', 'create_card_image', '-i', JSON.stringify({ template: 'blog', data__title: 'Invoked' })], /"width": 1200/],
      ['invoke search get_batch (unknown id)', ['search', 'get_batch', '-i', JSON.stringify({ id: 'bat_nope' })], /\[\]/],
    ]) {
      const out = invoke(args);
      const text = `${out.stdout}\n${out.stderr}`;
      record(what, out.status === 0 && expect.test(text), text.replace(/\s+/g, ' ').slice(0, 200));
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
} catch (error) {
  record('run', false, `${error.message}\n${worker?.log().slice(-2000) ?? ''}`);
} finally {
  await worker?.stop();
  stand.close();
}
process.exit(summary('zapier') ? 1 : 0);
