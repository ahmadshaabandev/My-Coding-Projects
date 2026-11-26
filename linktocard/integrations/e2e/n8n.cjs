// End-to-end check of the built n8n node of integrations/n8n, run by n8n-core's real RoutingNode, whose requests go out through n8n-core's own HTTP client
// (httpRequestWithAuthentication -> sendHttpRequest) to the repository's real Worker under
// `wrangler dev` (harness.mjs). Only n8n's CredentialsHelper is a stand-in: it applies the
// credential's own `authenticate` definition (generic: an Authorization header whose
// {{$credentials.x}} values are filled in), which n8n's real helper resolves as an expression.
//
//   node integrations/e2e/n8n.cjs <folder with n8n-core installed> [port]
//
// n8n-core is not a dependency of the node package; install it in a separate folder as the header
// of integrations/n8n/scripts/engine-check.cjs says, and run `npm run build` in integrations/n8n.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const coreDir = path.resolve(process.argv[2] || '');
const PORT = Number(process.argv[3] || 8815);
if (!process.argv[2] || !fs.existsSync(path.join(coreDir, 'node_modules', 'n8n-core'))) {
  console.error('Usage: node integrations/e2e/n8n.cjs <folder where n8n-core is installed> [port]');
  process.exit(2);
}
const packageDir = path.join(root, 'integrations/n8n');
const nodeDir = path.join(coreDir, 'linktocard-node-e2e');
fs.rmSync(nodeDir, { recursive: true, force: true });
fs.cpSync(path.join(packageDir, 'dist'), path.join(nodeDir, 'dist'), { recursive: true });
process.env.N8N_USER_FOLDER = path.join(coreDir, 'n8n-user-folder');

const load = (name) => require(require.resolve(name, { paths: [coreDir] }));
const { RoutingNode, ExecuteContext } = load('n8n-core');
const { Workflow, createRunExecutionData } = load('n8n-workflow');
const { LinkToCard } = require(path.join(nodeDir, 'dist/nodes/LinkToCard/LinkToCard.node.js'));
const { LinkToCardApi } = require(path.join(nodeDir, 'dist/credentials/LinkToCardApi.credentials.js'));
const nodeType = new LinkToCard();
const credentialType = new LinkToCardApi();

/** The generic `authenticate` of the credential, with {{$credentials.x}} filled in. */
function applyAuthenticate(credentials, requestOptions) {
  const fill = (value) => String(value).replace(/^=/, '').replace(/\{\{\s*\$credentials\.([A-Za-z]+)\s*\}\}/g, (_m, key) => credentials[key]);
  const { headers = {}, qs = {} } = credentialType.authenticate.properties;
  return {
    ...requestOptions,
    headers: { ...(requestOptions.headers || {}), ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, fill(v)])) },
    qs: { ...(requestOptions.qs || {}), ...Object.fromEntries(Object.entries(qs).map(([k, v]) => [k, fill(v)])) },
  };
}

const sent = [];
const additionalData = new Proxy(
  {
    executionId: 'execution-1',
    userId: 'user-1',
    variables: {},
    restApiUrl: 'http://localhost:5678/rest',
    instanceBaseUrl: 'http://localhost:5678',
    webhookBaseUrl: 'http://localhost:5678/webhook',
    webhookWaitingBaseUrl: 'http://localhost:5678/webhook-waiting',
    formWaitingBaseUrl: 'http://localhost:5678/form-waiting',
    credentialsHelper: {
      getParentTypes: () => [],
      preAuthentication: async () => undefined,
      authenticate: async (credentials, _type, requestOptions) => {
        const out = applyAuthenticate(credentials, requestOptions);
        sent.push({ method: out.method, url: `${out.baseURL ?? ''}${out.url}`, qs: out.qs, hasAuth: /^Bearer ltc_/.test(out.headers.Authorization ?? '') });
        return out;
      },
    },
  },
  { get: (target, key) => (key in target ? target[key] : undefined) },
);

function context(parameters, items) {
  const nodeTypes = { getByName: () => nodeType, getByNameAndVersion: () => nodeType, getKnownTypes: () => ({}) };
  const workflow = new Workflow({
    id: 'workflow-1',
    nodes: [{ id: 'node-1', name: 'Link To Card', type: 'n8n-nodes-linktocard.linkToCard', typeVersion: 1, position: [0, 0], parameters }],
    connections: {},
    active: false,
    nodeTypes,
  });
  const node = workflow.getNode('Link To Card');
  const inputData = { main: [items] };
  return new ExecuteContext(workflow, node, additionalData, 'manual', createRunExecutionData(), 0, items, inputData, { node, data: inputData, source: null }, []);
}

async function run(parameters, creds, items = [{ json: {} }]) {
  const ctx = context(parameters, items);
  const routing = new RoutingNode(ctx, nodeType, { id: 'credential-1', name: 'Link To Card', type: 'linkToCardApi', data: creds });
  const before = sent.length;
  try {
    return { items: (await routing.runNode())[0], requests: sent.slice(before) };
  } catch (error) {
    return { error, requests: sent.slice(before) };
  }
}

/** The credential's own test request, sent the way n8n sends it (with the credential applied). */
async function credentialTest(creds) {
  const ctx = context({ resource: 'image', operation: 'create', template: 'blog' }, [{ json: {} }]);
  const { request } = credentialType.test;
  const options = { method: request.method, baseURL: creds.baseUrl, url: request.url, json: true };
  try {
    return { value: await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'linkToCardApi', options, { credentialsDecrypted: { id: 'credential-1', name: 'Link To Card', type: 'linkToCardApi', data: creds } }) };
  } catch (error) {
    return { error };
  }
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

const errText = (error) => (error ? `${error.constructor?.name} ${error.httpCode ?? ''} ${error.description ?? error.message}` : '');

(async () => {
  const { startWorker, recorder } = await import(path.join(__dirname, 'harness.mjs'));
  const { record, summary } = recorder();
  let worker;
  try {
    worker = await startWorker(root, PORT, { label: 'n8n-e2e' });
    const { apiKey } = await worker.account('n8n-e2e');
    const creds = { apiKey, baseUrl: worker.base };
    record('local account and API key', apiKey.startsWith('ltc_'));

    const test = await credentialTest(creds);
    record('credential test: GET /v1/usage with the key', test.value?.plan === 'free', test.value ? `plan=${test.value.plan}` : errText(test.error));
    const bad = await credentialTest({ ...creds, apiKey: 'ltc_wrong_key_for_e2e' });
    record('credential test with a wrong key fails with 401', bad.error && String(bad.error.httpCode) === '401', errText(bad.error));

    // Image
    const image = await run({ resource: 'image', operation: 'create', template: 'blog', templateFields: { field: [{ name: 'title', value: 'n8n end to end' }] } }, creds);
    const img = image.items?.[0]?.json;
    record('Image > Create: POST /v1/images, JSON answer with the stored link', img?.width === 1200 && img?.height === 630 && /\/i\//.test(img?.url), img?.url ?? errText(image.error));
    record('every request carried the Bearer key from the credential', image.requests.length === 1 && image.requests.every((r) => r.hasAuth), JSON.stringify(image.requests));
    if (img?.url) {
      const got = await fetch(img.url);
      record('the image link serves the PNG', got.status === 200 && got.headers.get('content-type') === 'image/png', `${got.status}`);
    }
    const imageFile = await run({ resource: 'image', operation: 'create', template: 'blog', templateFields: { field: [{ name: 'title', value: 'n8n download' }] }, download: true }, creds);
    const file = imageFile.items?.[0];
    const png = file?.binary?.data ? Buffer.from(file.binary.data.data, 'base64') : null;
    record(
      'Image > Create with Download File: binary PNG from n8n\'s HTTP client, header facts as JSON',
      png && png.subarray(1, 4).toString() === 'PNG' && file.json.cached === false && /\/i\//.test(file.json.url) && file.binary.data.fileName === `${file.json.id}.png`,
      file ? JSON.stringify({ ...file.json, bytes: png?.length }) : errText(imageFile.error),
    );
    const email = await run({ resource: 'image', operation: 'create', template: 'email-banner', templateFields: { field: [{ name: 'title', value: 'Email' }] }, additionalFields: { size: 'email' }, simplify: true }, creds);
    record('Image > Create with Size "Email" and Simplify: 1200 x 400', email.items?.[0]?.json.width === 1200 && email.items?.[0]?.json.height === 400, JSON.stringify(email.items?.[0]?.json ?? errText(email.error)));
    const badKey = await run({ resource: 'image', operation: 'create', template: 'blog', templateFields: { field: [{ name: 'Bad-Key', value: 'x' }] } }, creds);
    record('an invalid field name: NodeApiError with the API message', badKey.error?.constructor?.name === 'NodeApiError' && /not valid/.test(badKey.error.description ?? badKey.error.message), errText(badKey.error));

    // PDF
    const invoice = {
      seller_name: 'Fernhill Studio',
      buyer_name: 'Acme',
      invoice_number: 'INV-7',
      issue_date: '2026-11-26',
      total: '120.00',
      items: [{ description: 'Workshop', amount: '120.00' }],
    };
    const pdf = await run({ resource: 'pdf', operation: 'create', template: 'invoice', additionalFields: { dataJson: JSON.stringify(invoice), filename: 'invoice-INV-7.pdf', pageFormat: 'letter' } }, creds);
    const p = pdf.items?.[0]?.json;
    record('PDF > Create: POST /v1/pdf (stand-in browser), JSON with pages and images counted', p?.pages === 1 && p?.credits_used === 2 && p?.filename === 'invoice-INV-7.pdf', p ? `${p.filename} ${p.url}` : errText(pdf.error));
    const pdfFile = await run({ resource: 'pdf', operation: 'create', template: 'invoice', additionalFields: { dataJson: JSON.stringify(invoice), filename: 'invoice-INV-8.pdf' }, download: true, binaryPropertyName: 'invoice' }, creds);
    const pf = pdfFile.items?.[0];
    const pdfBytes = pf?.binary?.invoice ? Buffer.from(pf.binary.invoice.data, 'base64') : null;
    record(
      'PDF > Create with Download File: binary PDF under its own name, pages from the headers',
      pdfBytes?.subarray(0, 5).toString() === '%PDF-' && pf.binary.invoice.fileName === 'invoice-INV-8.pdf' && pf.json.pages === 1 && pf.json.credits_used === 2,
      pf ? JSON.stringify(pf.json) : errText(pdfFile.error),
    );

    // Link card
    const local = await run({ resource: 'linkCard', operation: 'createFromUrl', url: `${worker.base}/` }, creds);
    record('Link Card > Create From URL reaches the route; a non-public address is refused with the API message', local.error?.constructor?.name === 'NodeApiError' && String(local.error.httpCode) === '400', errText(local.error));
    const outside = await run({ resource: 'linkCard', operation: 'createFromUrl', url: 'https://example.com/', simplify: true }, creds);
    record('Link Card > Create From URL of https://example.com/ (needs outbound network from workerd)', true, outside.items ? JSON.stringify(outside.items[0].json) : errText(outside.error));

    // Bulk PDFs: rows from an n8n expression over the input item, as after an Aggregate node.
    const people = ['Amara Nwosu', 'Jonas Berg', 'Mei Lin'].map((name) => ({ title: 'Certificate', recipient_name: name, achievement: 'Intro course', issuer_name: 'Fernhill', date: '2026-11-26' }));
    const start = await run(
      { resource: 'bulk', operation: 'start', template: 'certificate', rows: '={{ $json.rows }}', additionalFields: { filename: '{{recipient_name}}-{{n}}.pdf' } },
      creds,
      [{ json: { rows: people } }],
    );
    const batch = start.items?.[0]?.json;
    record('Bulk PDF > Start with Rows from an expression: 202 queued, verification on by default', batch?.status === 'queued' && batch.total === 3 && batch.verify === true && Array.isArray(batch.zip_parts), batch ? JSON.stringify({ id: batch.id, status: batch.status }) : errText(start.error));
    if (batch?.id) {
      await worker.waitForBatch(apiKey, batch.id);
      const got = await run({ resource: 'bulk', operation: 'get', batchId: batch.id }, creds);
      const b = got.items?.[0]?.json;
      record(
        'Bulk PDF > Get once done: rows with file names from the pattern, links, certificates, one ZIP part',
        b?.status === 'done' && b.rows.length === 3 && b.rows.every((r) => r.url && r.verify_url) && b.zip_parts.length === 1 && b.zip_parts[0].entries === 3,
        b ? b.rows.map((r) => r.filename).join(' | ') : errText(got.error),
      );
      const zip = await run({ resource: 'bulk', operation: 'downloadZip', batchId: batch.id }, creds);
      const z = zip.items?.[0];
      const zipBytes = z?.binary?.data ? Buffer.from(z.binary.data.data, 'base64') : null;
      record(
        'Bulk PDF > Download ZIP (part 1 by default): the ZIP as binary data with the API file name and part numbers',
        zipBytes?.readUInt32LE(0) === 0x04034b50 && z.binary.data.fileName === `${batch.id}.zip` && z.binary.data.mimeType === 'application/zip' && z.json.part === 1 && z.json.parts === 1 && z.json.bytes === b?.zip_parts?.[0]?.bytes,
        z ? `${JSON.stringify(z.json)} entries: ${zipBytes ? zipNames(zipBytes).join(', ') : ''}` : errText(zip.error),
      );
      const part2 = await run({ resource: 'bulk', operation: 'downloadZip', batchId: batch.id, zipPart: 2 }, creds);
      record('Bulk PDF > Download ZIP of part 2: NodeApiError 404 with the API message', part2.error?.constructor?.name === 'NodeApiError' && String(part2.error.httpCode) === '404' && /ZIP has 1 part/.test(part2.error.description ?? ''), errText(part2.error));
      record('Download ZIP sent ?part=2', part2.requests[0]?.qs?.part === 2, JSON.stringify(part2.requests[0]));
    }
    const missing = await run({ resource: 'bulk', operation: 'get', batchId: 'bat_nope' }, creds);
    record('Bulk PDF > Get of an unknown id: NodeApiError 404', missing.error?.constructor?.name === 'NodeApiError' && String(missing.error.httpCode) === '404', errText(missing.error));
    const tooMany = await run({ resource: 'bulk', operation: 'start', template: 'report', rows: JSON.stringify(Array.from({ length: 26 }, (_, i) => ({ title: `T${i}` }))) }, creds);
    record('Bulk PDF > Start with 26 rows on Free: 403 plan_required with the API message', String(tooMany.error?.httpCode) === '403' && /Free plan may have at most 25 rows/.test(tooMany.error.description ?? tooMany.error.message), errText(tooMany.error));
    const own = await run({ resource: 'bulk', operation: 'start', template: 'no_such_template', rows: '[{"title":"x"}]' }, creds);
    record('Bulk PDF > Start with an unknown template: 404', String(own.error?.httpCode) === '404', errText(own.error));
    const noVerify = await run({ resource: 'bulk', operation: 'start', template: 'report', rows: '[{"title":"x"}]', additionalFields: { verify: false, pageFormat: 'a5', landscape: true } }, creds);
    record('Bulk PDF > Start with Certificate Verification off and page setup', noVerify.items?.[0]?.json.verify === false && noVerify.items[0].json.status === 'queued', JSON.stringify(noVerify.items?.[0]?.json ?? errText(noVerify.error)));

    // Link preview
    const inspectLocal = await run({ resource: 'linkPreview', operation: 'check', url: `${worker.base}/` }, creds);
    record('Link Preview > Check of a non-public address: refused with the API message', inspectLocal.error?.constructor?.name === 'NodeApiError', errText(inspectLocal.error));
    const inspect = await run({ resource: 'linkPreview', operation: 'check', url: 'https://example.com/', simplify: true }, creds);
    record('Link Preview > Check of https://example.com/ (needs outbound network from workerd)', true, inspect.items ? JSON.stringify(inspect.items[0].json) : errText(inspect.error));
  } catch (error) {
    record('run', false, `${error.stack}\n${worker?.log().slice(-2000) ?? ''}`);
  } finally {
    await worker?.stop();
    fs.rmSync(nodeDir, { recursive: true, force: true });
  }
  process.exit(summary('n8n') ? 1 : 0);
})();
