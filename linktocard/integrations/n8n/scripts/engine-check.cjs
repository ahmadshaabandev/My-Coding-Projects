#!/usr/bin/env node
/*
 * Runs the built node (dist/) through n8n's real declarative routing engine, n8n-core's
 * RoutingNode, with only the HTTP call replaced by a recorder, and checks the request each
 * operation sends and the items it outputs. It complements test/routing.test.ts, whose engine is a
 * re-implementation: here n8n itself evaluates the expressions (the credential's base URL, an
 * expression in 'Rows'), applies displayOptions, runs the hooks and stores binary data.
 *
 * n8n-core is not a dependency of this package (n8n verification allows no runtime dependencies,
 * and it is large), so install it in a separate folder first:
 *
 *   mkdir ../n8n-core-check && cd ../n8n-core-check && npm init -y
 *   npm install --ignore-scripts --legacy-peer-deps n8n-core@2.49.7 n8n-workflow@2.49.5 zod@3.25.76
 *   cd - && npm run build && node scripts/engine-check.cjs ../n8n-core-check
 *
 * (zod is pinned because n8n-workflow needs 3.25.76 and --legacy-peer-deps can hoist 4.x.)
 * The built node is copied into that folder so it loads the same n8n-workflow as n8n-core, as a
 * community node does inside n8n. Overriding rawRoutingRequest relies on n8n-core internals
 * (checked with 2.49.7); if a later version renames it, this script says so instead of passing.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const coreDir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(coreDir, 'node_modules', 'n8n-core'))) {
	console.error('Usage: node scripts/engine-check.cjs <folder where n8n-core is installed>');
	process.exit(2);
}
const packageDir = path.resolve(__dirname, '..');
const nodeDir = path.join(coreDir, 'linktocard-node');
fs.rmSync(nodeDir, { recursive: true, force: true });
fs.cpSync(path.join(packageDir, 'dist'), path.join(nodeDir, 'dist'), { recursive: true });
// n8n-core keeps an encryption key in the user folder; keep it out of the home directory.
process.env.N8N_USER_FOLDER = path.join(coreDir, 'n8n-user-folder');

const load = (name) => require(require.resolve(name, { paths: [coreDir] }));
const { RoutingNode, ExecuteContext } = load('n8n-core');
const { Workflow, createRunExecutionData } = load('n8n-workflow');
const { LinkToCard } = require(path.join(nodeDir, 'dist/nodes/LinkToCard/LinkToCard.node.js'));
const nodeType = new LinkToCard();
if (typeof RoutingNode.prototype.rawRoutingRequest !== 'function') {
	console.error('n8n-core no longer has RoutingNode.rawRoutingRequest: update this script.');
	process.exit(2);
}

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
	},
	{ get: (target, key) => (key in target ? target[key] : undefined) },
);

/** One run of the node for one input item; returns the recorded request and the output or error. */
async function run(parameters, response, baseUrl = 'https://linktocard.com') {
	const nodeTypes = { getByName: () => nodeType, getByNameAndVersion: () => nodeType, getKnownTypes: () => ({}) };
	const workflow = new Workflow({
		id: 'workflow-1',
		nodes: [{ id: 'node-1', name: 'Link To Card', type: 'n8n-nodes-linktocard.linkToCard', typeVersion: 1, position: [0, 0], parameters }],
		connections: {},
		active: false,
		nodeTypes,
	});
	const node = workflow.getNode('Link To Card');
	const items = [{ json: {} }];
	const inputData = { main: [items] };
	const context = new ExecuteContext(workflow, node, additionalData, 'manual', createRunExecutionData(), 0, items, inputData, { node, data: inputData, source: null }, []);
	const routing = new RoutingNode(context, nodeType, {
		id: 'credential-1',
		name: 'Link To Card',
		type: 'linkToCardApi',
		data: { apiKey: 'ltc_example', baseUrl },
	});
	const requests = [];
	routing.rawRoutingRequest = async (_context, requestData, credentialType) => {
		requests.push({ ...requestData.options, credentialType });
		return response;
	};
	try {
		return { requests, items: (await routing.runNode())[0] };
	} catch (error) {
		return { requests, error };
	}
}

const json = (body) => ({ body, headers: { 'content-type': 'application/json' }, statusCode: 200 });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from('%PDF-1.7\n%engine-check\n', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

/** [name, parameters, response, check(result), baseUrl?] */
const cases = [
	['Image > Create sends the template only', { resource: 'image', operation: 'create', template: 'blog' }, json({ id: 'i1', url: 'https://linktocard.com/i/u/i1.png' }), ({ requests, items }) => {
		assert.equal(requests.length, 1);
		const [request] = requests;
		assert.deepEqual([request.method, request.baseURL, request.url, request.credentialType], ['POST', 'https://linktocard.com', '/v1/images', 'linkToCardApi']);
		assert.deepEqual(request.headers, HEADERS);
		assert.deepEqual(request.body, { template: 'blog' });
		assert.equal(request.encoding, undefined);
		assert.deepEqual(items.map((item) => item.json), [{ id: 'i1', url: 'https://linktocard.com/i/u/i1.png' }]);
	}],
	['Image > Create merges Data (JSON) and Template Fields', {
		resource: 'image', operation: 'create', template: 'blog',
		templateFields: { field: [{ name: 'title', value: 'Hello' }] },
		additionalFields: { dataJson: '{"author": "Maya Chen", "title": "replaced"}', size: 'square', format: 'webp' },
	}, json({}), ({ requests }) => {
		assert.deepEqual(requests[0].body, { template: 'blog', format: 'webp', size: 'square', data: { author: 'Maya Chen', title: 'Hello' } });
	}],
	['Image > Create with inline HTML', { resource: 'image', operation: 'create', source: 'html', html: '<h1>{{title}}</h1>', css: '' }, json({}), ({ requests }) => {
		assert.deepEqual(requests[0].body, { html: '<h1>{{title}}</h1>', css: '' });
	}],
	['Image > Create downloads the file as binary data', { resource: 'image', operation: 'create', template: 'blog', download: true }, {
		body: PNG,
		headers: { 'content-type': 'image/png', etag: '"i2"', 'x-ltc-cache': 'miss', 'x-ltc-image-url': 'https://linktocard.com/i/u/i2.png', 'x-ltc-warnings': '%5B%5D' },
		statusCode: 200,
	}, ({ requests, items }) => {
		assert.deepEqual(requests[0].body, { template: 'blog', response: 'binary' });
		assert.equal(requests[0].encoding, 'arraybuffer');
		assert.equal(requests[0].ignoreHttpStatusErrors, true);
		assert.deepEqual(items[0].json, { id: 'i2', url: 'https://linktocard.com/i/u/i2.png', format: 'png', bytes: PNG.length, cached: false, warnings: [] });
		const file = items[0].binary.data;
		assert.deepEqual([file.mimeType, file.fileName, file.fileExtension], ['image/png', 'i2.png', 'png']);
		assert.ok(Buffer.from(file.data, 'base64').equals(PNG));
	}],
	['Image > Create turns an HTTP error during download into NodeApiError', { resource: 'image', operation: 'create', template: 'blog', download: true }, {
		body: Buffer.from('{"error":{"code":"quota_exceeded","message":"No images left this period."}}'),
		headers: { 'content-type': 'application/json' },
		statusCode: 402,
	}, ({ error }) => {
		assert.equal(error?.constructor?.name, 'NodeApiError');
		assert.equal(error.httpCode, '402');
		assert.equal(error.description, 'No images left this period.');
	}],
	['Image > Create Simplify', { resource: 'image', operation: 'create', template: 'blog', simplify: true }, json({ id: 'i3', url: 'u', width: 1200, height: 630, format: 'png', cached: true, expires_at: 'e', warnings: [], template: 'blog', usage: { total_remaining: 9 } }), ({ items }) => {
		assert.deepEqual(items[0].json, { url: 'u', id: 'i3', width: 1200, height: 630, format: 'png', cached: true, expires_at: 'e', warnings: [], images_remaining: 9 });
	}],
	['PDF > Create sends page setup under "pdf" and drops empty text fields', {
		resource: 'pdf', operation: 'create', template: 'invoice',
		additionalFields: { pageFormat: 'letter', landscape: true, filename: ' ', header: '<b>Fernhill</b>', footer: '', dataJson: '{"items": [{"description": "Workshop"}]}' },
	}, json({}), ({ requests }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['POST', '/v1/pdf']);
		assert.deepEqual(requests[0].body, { template: 'invoice', pdf: { header: '<b>Fernhill</b>', landscape: true, format: 'letter' }, data: { items: [{ description: 'Workshop' }] } });
	}],
	['PDF > Create downloads the PDF under its own name', { resource: 'pdf', operation: 'create', template: 'invoice', download: true, binaryPropertyName: 'invoice' }, {
		body: PDF,
		headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="invoice-0142.pdf"', etag: '"p1"', 'x-ltc-pages': '2', 'x-ltc-credits-used': '2', 'x-ltc-cache': 'miss', 'x-ltc-pdf-url': 'https://linktocard.com/i/u/p1.pdf' },
		statusCode: 200,
	}, ({ requests, items }) => {
		assert.deepEqual(requests[0].body, { template: 'invoice', response: 'binary' });
		assert.deepEqual(items[0].json, { id: 'p1', url: 'https://linktocard.com/i/u/p1.pdf', filename: 'invoice-0142.pdf', pages: 2, bytes: PDF.length, credits_used: 2, cached: false, warnings: [] });
		assert.deepEqual([items[0].binary.invoice.mimeType, items[0].binary.invoice.fileName], ['application/pdf', 'invoice-0142.pdf']);
	}],
	['Link Card > Create From URL leaves an empty template out', { resource: 'linkCard', operation: 'createFromUrl', url: 'https://example.com/post', additionalFields: { template: '' } }, json({}), ({ requests }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['POST', '/v1/cards/from-url']);
		assert.deepEqual(requests[0].body, { url: 'https://example.com/post' });
	}],
	['Bulk PDF > Start parses the rows', {
		resource: 'bulk', operation: 'start', template: 'certificate', rows: '[{"recipient_name": "Maya Chen"}]',
		additionalFields: { verify: false, filename: '{{recipient_name}}.pdf' },
	}, json({ id: 'bat_1', status: 'queued' }), ({ requests, items }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['POST', '/v1/batches']);
		assert.deepEqual(requests[0].body, { template: 'certificate', verify: false, filename: '{{recipient_name}}.pdf', rows: [{ recipient_name: 'Maya Chen' }] });
		assert.deepEqual(items[0].json, { id: 'bat_1', status: 'queued' });
	}],
	['Bulk PDF > Start takes rows from an n8n expression', { resource: 'bulk', operation: 'start', template: 'certificate', rows: '={{ [{"recipient_name": "From an expression"}] }}' }, json({}), ({ requests }) => {
		assert.deepEqual(requests[0].body.rows, [{ recipient_name: 'From an expression' }]);
	}],
	['Bulk PDF > Get puts the id in the path', { resource: 'bulk', operation: 'get', batchId: 'bat_7k2m9q' }, json({ id: 'bat_7k2m9q' }), ({ requests }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['GET', '/v1/batches/bat_7k2m9q']);
	}],
	['Bulk PDF > Download ZIP asks for the part and stores the ZIP as binary data', { resource: 'bulk', operation: 'downloadZip', batchId: 'bat_7k2m9q', zipPart: 2 }, {
		body: ZIP,
		headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="bat_7k2m9q-part-2-of-2.zip"', 'x-ltc-zip-part': '2', 'x-ltc-zip-parts': '2' },
		statusCode: 200,
	}, ({ requests, items }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['GET', '/v1/batches/bat_7k2m9q/zip']);
		assert.deepEqual(requests[0].qs, { part: 2 });
		assert.equal(requests[0].encoding, 'arraybuffer');
		assert.equal(requests[0].ignoreHttpStatusErrors, true);
		assert.deepEqual(items[0].json, { filename: 'bat_7k2m9q-part-2-of-2.zip', part: 2, parts: 2, bytes: ZIP.length });
		const file = items[0].binary.data;
		assert.deepEqual([file.mimeType, file.fileName], ['application/zip', 'bat_7k2m9q-part-2-of-2.zip']);
		assert.ok(Buffer.from(file.data, 'base64').equals(ZIP));
	}],
	['Bulk PDF > Download ZIP of a part that does not exist raises the API message', { resource: 'bulk', operation: 'downloadZip', batchId: 'bat_7k2m9q', zipPart: 3 }, {
		body: Buffer.from('{"error":{"code":"not_found","message":"This batch\'s ZIP has 2 parts; ask for part=1 to part=2."}}'),
		headers: { 'content-type': 'application/json' },
		statusCode: 404,
	}, ({ error }) => {
		assert.equal(error?.constructor?.name, 'NodeApiError');
		assert.equal(error.httpCode, '404');
		assert.equal(error.description, "This batch's ZIP has 2 parts; ask for part=1 to part=2.");
	}],
	['Bulk PDF > Get refuses a dot segment before any request', { resource: 'bulk', operation: 'get', batchId: '..' }, json({}), ({ requests, error }) => {
		assert.equal(requests.length, 0);
		assert.equal(error?.message, "'Batch ID' is not a valid ID");
	}],
	['Link Preview > Check sends the URL as a query parameter, simplified', { resource: 'linkPreview', operation: 'check', url: 'https://example.com/post?ref=n8n', simplify: true }, json({ id: 'chk_1', final_url: 'https://example.com/post', status: 200, checks: [{ id: 'twitter_card', status: 'fail' }] }), ({ requests, items }) => {
		assert.deepEqual([requests[0].method, requests[0].url], ['GET', '/v1/inspect']);
		assert.deepEqual(requests[0].qs, { url: 'https://example.com/post?ref=n8n' });
		assert.deepEqual(items[0].json.failed_checks, ['twitter_card']);
	}],
	['the credential base URL is used', { resource: 'linkPreview', operation: 'check', url: 'https://example.com' }, json({}), ({ requests }) => {
		assert.equal(requests[0].baseURL, 'https://staging.example.com');
	}, 'https://staging.example.com'],
];

(async () => {
	let failed = 0;
	for (const [name, parameters, response, check, baseUrl] of cases) {
		const result = await run(parameters, response, baseUrl);
		try {
			check(result);
			console.log(`ok   ${name}`);
		} catch (error) {
			failed += 1;
			console.log(`FAIL ${name}\n     ${error.message}`);
			if (result.error) console.log(`     node error: ${result.error.message}`);
		}
	}
	console.log(`\n${cases.length - failed} passed, ${failed} failed (n8n-core ${load('n8n-core/package.json').version}, n8n-workflow ${load('n8n-workflow/package.json').version})`);
	process.exit(failed === 0 ? 0 : 1);
})();
