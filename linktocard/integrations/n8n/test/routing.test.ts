import type { INodeParameters } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { collectRouting, description, operationsByResource, simulateRequest } from './helpers';

/**
 * Each operation, the Link To Card endpoint it must call (openapi.yaml of the service, and
 * contract T1/T3 for the new batch and link-card endpoints), and the least input that is valid.
 */
const ENDPOINTS: Array<{ resource: string; operation: string; method: string; url: string; values: INodeParameters }> = [
	{ resource: 'image', operation: 'create', method: 'POST', url: '/v1/images', values: { template: 'blog' } },
	{ resource: 'pdf', operation: 'create', method: 'POST', url: '/v1/pdf', values: { template: 'invoice' } },
	{
		resource: 'linkCard',
		operation: 'createFromUrl',
		method: 'POST',
		url: '/v1/cards/from-url',
		values: { url: 'https://example.com/post' },
	},
	{
		resource: 'bulk',
		operation: 'start',
		method: 'POST',
		url: '/v1/batches',
		values: { template: 'certificate', rows: '[{"recipient_name":"Maya Chen"}]' },
	},
	{ resource: 'bulk', operation: 'get', method: 'GET', url: '/v1/batches/bat_7k2m9q', values: { batchId: 'bat_7k2m9q' } },
	{ resource: 'bulk', operation: 'downloadZip', method: 'GET', url: '/v1/batches/bat_7k2m9q/zip', values: { batchId: 'bat_7k2m9q' } },
	{
		resource: 'linkPreview',
		operation: 'check',
		method: 'GET',
		url: '/v1/inspect',
		values: { url: 'https://example.com/post' },
	},
];

const request = (resource: string, operation: string, values: INodeParameters = {}) =>
	simulateRequest({ resource, operation, ...values });

describe('every operation calls its documented endpoint', () => {
	it('the table covers exactly the operations the node offers', () => {
		const offered = operationsByResource().map(({ resource, operation }) => `${resource}:${String(operation.value)}`);
		expect(offered.sort()).toEqual(ENDPOINTS.map(({ resource, operation }) => `${resource}:${operation}`).sort());
	});

	it.each(ENDPOINTS)('$resource $operation -> $method $url', async ({ resource, operation, method, url, values }) => {
		const options = await request(resource, operation, values);
		expect(options.method).toBe(method);
		expect(options.url).toBe(url);
		expect(options.baseURL).toBe('https://linktocard.com');
		expect(options.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
	});

	it('uses the base URL of the credential', async () => {
		const options = await simulateRequest({ resource: 'image', operation: 'create', template: 'blog' }, 'https://staging.example.com');
		expect(options.baseURL).toBe('https://staging.example.com');
	});
});

describe('Image > Create', () => {
	it('sends only the template when nothing else is set, so the API defaults apply', async () => {
		const options = await request('image', 'create', { template: 'blog' });
		expect(options.body).toEqual({ template: 'blog' });
		expect(options.qs).toEqual({});
		expect(options.encoding).toBeUndefined();
	});

	it('sends inline HTML and CSS instead of a template id', async () => {
		const options = await request('image', 'create', {
			source: 'html',
			template: 'ignored',
			html: '<h1>{{title}}</h1>',
			css: 'h1 { font-size: 80px }',
		});
		expect(options.body).toEqual({ html: '<h1>{{title}}</h1>', css: 'h1 { font-size: 80px }' });
	});

	it('merges Data (JSON) and Template Fields into data, the fields winning', async () => {
		const options = await request('image', 'create', {
			template: 'blog',
			templateFields: { field: [{ name: 'title', value: 'How we cut our build time in half' }] },
			additionalFields: { dataJson: '{"title": "replaced", "author": "Maya Chen"}', size: 'square', format: 'webp' },
		});
		expect(options.body).toEqual({
			template: 'blog',
			size: 'square',
			format: 'webp',
			data: { title: 'How we cut our build time in half', author: 'Maya Chen' },
		});
	});

	it('accepts data that an expression already turned into an object', async () => {
		const options = await request('image', 'create', {
			template: 'blog',
			additionalFields: { dataJson: { title: 'From an expression' } },
		});
		expect(options.body.data).toEqual({ title: 'From an expression' });
	});

	it('asks for the file and reads it as bytes when Download File is on', async () => {
		const options = await request('image', 'create', { template: 'blog', download: true });
		expect(options.body).toEqual({ template: 'blog', response: 'binary' });
		expect(options.encoding).toBe('arraybuffer');
		expect(options.ignoreHttpStatusErrors).toBe(true);
	});
});

describe('PDF > Create', () => {
	it('puts the page setup under "pdf" and the rest at the top level', async () => {
		const options = await request('pdf', 'create', {
			template: 'invoice',
			additionalFields: {
				filename: 'invoice-INV-2026-0142.pdf',
				pageFormat: 'letter',
				landscape: true,
				header: '<div style="font-size:9px">Fernhill Studio</div>',
				footer: '<div>Page <span class="pageNumber"></span></div>',
				dataJson: '{"invoice_number": "INV-2026-0142", "items": [{"description": "Workshop", "amount": "2,400.00"}]}',
			},
		});
		expect(options.body).toEqual({
			template: 'invoice',
			filename: 'invoice-INV-2026-0142.pdf',
			pdf: {
				format: 'letter',
				landscape: true,
				header: '<div style="font-size:9px">Fernhill Studio</div>',
				footer: '<div>Page <span class="pageNumber"></span></div>',
			},
			data: { invoice_number: 'INV-2026-0142', items: [{ description: 'Workshop', amount: '2,400.00' }] },
		});
	});

	it('asks for the PDF itself with "response": "binary"', async () => {
		const options = await request('pdf', 'create', { template: 'invoice', download: true });
		expect(options.body).toEqual({ template: 'invoice', response: 'binary' });
		expect(options.encoding).toBe('arraybuffer');
	});

	it('sends inline HTML for a PDF too', async () => {
		const options = await request('pdf', 'create', { source: 'html', html: '<h1>{{title}}</h1>', css: '' });
		expect(options.body).toEqual({ html: '<h1>{{title}}</h1>', css: '' });
	});
});

describe('Link Card > Create From URL', () => {
	it('sends the page URL and leaves the template to the API unless one is chosen', async () => {
		expect((await request('linkCard', 'createFromUrl', { url: 'https://example.com/post' })).body).toEqual({
			url: 'https://example.com/post',
		});
		const options = await request('linkCard', 'createFromUrl', {
			url: 'https://example.com/post',
			templateFields: { field: [{ name: 'title', value: 'A shorter title' }] },
			additionalFields: { template: 'dark', size: 'portrait', format: 'jpeg' },
		});
		expect(options.body).toEqual({
			url: 'https://example.com/post',
			template: 'dark',
			size: 'portrait',
			format: 'jpeg',
			data: { title: 'A shorter title' },
		});
	});

	it('can download the card', async () => {
		const options = await request('linkCard', 'createFromUrl', { url: 'https://example.com/post', download: true });
		expect(options.body).toEqual({ url: 'https://example.com/post', response: 'binary' });
	});
});

describe('Bulk PDF', () => {
	it('Start sends the template, the parsed rows and the options', async () => {
		const options = await request('bulk', 'start', {
			template: 'certificate',
			rows: '[{"recipient_name": "Maya Chen"}, {"recipient_name": "Sam Okafor"}]',
			additionalFields: { filename: '{{recipient_name}}.pdf', verify: false, pageFormat: 'a4', landscape: true },
		});
		expect(options.body).toEqual({
			template: 'certificate',
			rows: [{ recipient_name: 'Maya Chen' }, { recipient_name: 'Sam Okafor' }],
			filename: '{{recipient_name}}.pdf',
			verify: false,
			pdf: { format: 'a4', landscape: true },
		});
	});

	it('Start accepts rows that an expression already turned into a list', async () => {
		const rows = [{ recipient_name: 'Maya Chen' }];
		const options = await request('bulk', 'start', { template: 'certificate', rows });
		expect(options.body).toEqual({ template: 'certificate', rows });
	});

	it('Get puts the batch id in the path, encoded, and sends no body fields', async () => {
		const options = await request('bulk', 'get', { batchId: ' bat_7k2m9q ' });
		expect(options.url).toBe('/v1/batches/bat_7k2m9q');
		expect(options.body).toEqual({});
		expect((await request('bulk', 'get', { batchId: 'a/b?c' })).url).toBe('/v1/batches/a%2Fb%3Fc');
	});

	it('Get refuses ids that would leave the batch path', async () => {
		for (const batchId of ['', '  ', '.', '..', '../usage', 'a/../b']) {
			await expect(request('bulk', 'get', { batchId })).rejects.toThrow("'Batch ID' is not a valid ID");
			await expect(request('bulk', 'downloadZip', { batchId })).rejects.toThrow("'Batch ID' is not a valid ID");
		}
	});

	it('Get reads the JSON answer: no byte encoding, HTTP errors raised by n8n', async () => {
		const options = await request('bulk', 'get', { batchId: 'bat_1' });
		expect(options.encoding).toBeUndefined();
		expect(options.ignoreHttpStatusErrors).toBeUndefined();
		expect(options.qs).toEqual({});
	});

	it('Download ZIP asks for part 1 unless told otherwise, as bytes, and reads errors itself', async () => {
		const first = await request('bulk', 'downloadZip', { batchId: ' bat_7k2m9q ' });
		expect(first.url).toBe('/v1/batches/bat_7k2m9q/zip');
		expect(first.qs).toEqual({ part: 1 });
		expect(first.body).toEqual({});
		expect(first.encoding).toBe('arraybuffer');
		expect(first.ignoreHttpStatusErrors).toBe(true);
		expect((await request('bulk', 'downloadZip', { batchId: 'bat_1', zipPart: 3 })).qs).toEqual({ part: 3 });
	});

	it('Download ZIP takes whole part numbers from 1', () => {
		const part = description.properties.find((property) => property.name === 'zipPart');
		expect(part).toMatchObject({ type: 'number', default: 1, required: true, typeOptions: { minValue: 1, numberPrecision: 0 } });
	});
});

describe('Link Preview > Check', () => {
	it('sends the page URL as the url query parameter', async () => {
		const options = await request('linkPreview', 'check', { url: 'https://example.com/post?ref=n8n' });
		expect(options.qs).toEqual({ url: 'https://example.com/post?ref=n8n' });
		expect(options.body).toEqual({});
	});
});

describe('Additional Fields added but left empty', () => {
	it('are left out, so the API default applies instead of an empty value', async () => {
		const pdf = await request('pdf', 'create', {
			template: 'invoice',
			additionalFields: { filename: '  ', header: '', footer: '', pageFormat: 'a5' },
		});
		expect(pdf.body).toEqual({ template: 'invoice', pdf: { format: 'a5' } });
		const onlyEmpty = await request('pdf', 'create', { template: 'invoice', additionalFields: { header: ' ' } });
		expect(onlyEmpty.body).toEqual({ template: 'invoice' });
		const card = await request('linkCard', 'createFromUrl', { url: 'https://example.com', additionalFields: { template: '' } });
		expect(card.body).toEqual({ url: 'https://example.com' });
		const bulk = await request('bulk', 'start', { template: 'certificate', rows: '[{}]', additionalFields: { filename: '' } });
		expect(bulk.body).toEqual({ template: 'certificate', rows: [{}] });
	});
});

describe('parameters of other operations are never sent', () => {
	it('a value left over from another resource does not reach the request', async () => {
		const options = await request('linkPreview', 'check', {
			url: 'https://example.com/post',
			template: 'blog',
			rows: '[{}]',
			batchId: 'bat_1',
			download: true,
			additionalFields: { size: 'square' },
		});
		expect(options.body).toEqual({});
		expect(options.qs).toEqual({ url: 'https://example.com/post' });
		expect(options.encoding).toBeUndefined();
	});

	it('only the selected operation contributes a postReceive file handler', () => {
		expect(collectRouting({ resource: 'linkPreview', operation: 'check', url: 'https://example.com' }).routing.postReceive).toHaveLength(1);
		expect(collectRouting({ resource: 'image', operation: 'create', template: 'blog' }).routing.postReceive).toHaveLength(2);
		expect(collectRouting({ resource: 'bulk', operation: 'get', batchId: 'bat_1' }).routing.postReceive).toHaveLength(0);
		expect(collectRouting({ resource: 'bulk', operation: 'downloadZip', batchId: 'bat_1' }).routing.postReceive).toHaveLength(1);
	});
});
