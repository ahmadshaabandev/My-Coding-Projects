import { NodeApiError, type IDataObject, type IN8nHttpFullResponse, type INodeParameters } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import {
	bodyBytes,
	decodeWarnings,
	fileMetadata,
	fileNameFromDisposition,
	headerValue,
	simplified,
} from '../nodes/LinkToCard/shared/postreceive';
import { simulateRequest, simulateResponse } from './helpers';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7\n%test\n', 'latin1');
const IMAGE_ID = 'a'.repeat(64);
const USAGE = {
	plan: 'free',
	period_start: '2026-11-01T00:00:00.000Z',
	period_end: '2026-12-01T00:00:00.000Z',
	limit: 50,
	used: 3,
	remaining: 47,
	topup_remaining: 0,
	total_remaining: 47,
	cache_days: 7,
	watermark: true,
};

/** Responses shaped like the service's (src/routes/api.ts, src/routes/pdf.ts, openapi.yaml). */
const IMAGE_JSON = {
	id: IMAGE_ID,
	url: `https://linktocard.com/i/u_hkr8wty4jftnyum3/${IMAGE_ID}.png`,
	width: 1200,
	height: 630,
	format: 'png',
	bytes: 48213,
	cached: false,
	template: 'blog',
	created_at: '2026-11-26T10:00:00.000Z',
	expires_at: '2026-12-03T10:00:00.000Z',
	warnings: [],
	usage: USAGE,
};

function response(body: unknown, headers: IDataObject = {}, statusCode = 200): IN8nHttpFullResponse {
	return { body: body as IN8nHttpFullResponse['body'], headers, statusCode };
}

const imageValues: INodeParameters = { resource: 'image', operation: 'create', template: 'blog' };

describe('JSON answers', () => {
	it('pass through unchanged by default', async () => {
		const { items } = await simulateResponse(imageValues, response(IMAGE_JSON));
		expect(items).toEqual([{ json: IMAGE_JSON }]);
	});

	it('Simplify keeps at most ten flat fields, most used first', async () => {
		const { items } = await simulateResponse({ ...imageValues, simplify: true }, response(IMAGE_JSON));
		expect(items[0].json).toEqual({
			url: IMAGE_JSON.url,
			id: IMAGE_ID,
			width: 1200,
			height: 630,
			format: 'png',
			cached: false,
			expires_at: '2026-12-03T10:00:00.000Z',
			warnings: [],
			images_remaining: 47,
		});
	});

	it('Simplify has a view for each JSON operation, never above ten fields', () => {
		const pdf = simplified('pdf', {
			id: 'b'.repeat(64),
			url: 'https://linktocard.com/i/u_1/x.pdf',
			pages: 3,
			bytes: 1000,
			credits_used: 2,
			cached: false,
			template: 'invoice',
			filename: 'invoice.pdf',
			created_at: 'x',
			expires_at: 'y',
			warnings: [],
			usage: USAGE,
		});
		expect(pdf).toMatchObject({ filename: 'invoice.pdf', pages: 3, credits_used: 2, images_remaining: 47 });

		const linkCard = simplified('linkCard', { ...IMAGE_JSON, link: { url: 'https://a.example/', final_url: 'https://www.a.example/' } });
		expect(linkCard).toMatchObject({ page_url: 'https://www.a.example/', url: IMAGE_JSON.url });

		const check = simplified('check', {
			id: 'chk_0123456789abcdef',
			url: 'https://a.example/',
			final_url: 'https://a.example/post',
			status: 200,
			preview: { title: 'Launch week', description: 'Five launches', domain: 'a.example' },
			og: { title: 'Launch week' },
			image: { url: 'https://a.example/og.png', width: 1200, height: 630 },
			checks: [
				{ id: 'og_image', status: 'pass' },
				{ id: 'og_image_size', status: 'warn' },
				{ id: 'twitter_card', status: 'fail' },
				{ id: 'og_description', status: 'fail' },
			],
		});
		expect(check).toEqual({
			final_url: 'https://a.example/post',
			status: 200,
			title: 'Launch week',
			description: 'Five launches',
			image: 'https://a.example/og.png',
			image_width: 1200,
			image_height: 630,
			failed_checks: ['twitter_card', 'og_description'],
			warned_checks: ['og_image_size'],
			id: 'chk_0123456789abcdef',
		});
		expect(simplified('check', { image: null, checks: [] })).toMatchObject({ image: null, failed_checks: [] });

		for (const view of [pdf, linkCard, check, simplified('image', IMAGE_JSON)]) {
			expect(Object.keys(view).length).toBeLessThanOrEqual(10);
			for (const value of Object.values(view)) expect(typeof value === 'object' && value !== null && !Array.isArray(value)).toBe(false);
		}
	});

	it('Link Preview > Check can be simplified too', async () => {
		const { items } = await simulateResponse(
			{ resource: 'linkPreview', operation: 'check', url: 'https://a.example', simplify: true },
			response({ id: 'chk_1', final_url: 'https://a.example/', status: 200, checks: [] }),
		);
		expect(items[0].json).toMatchObject({ id: 'chk_1', status: 200, failed_checks: [] });
	});
});

describe('downloaded files', () => {
	it('an image becomes binary data named after its id, with the header facts as JSON', async () => {
		const { items, context } = await simulateResponse(
			{ ...imageValues, download: true },
			response(PNG, {
				'content-type': 'image/png',
				etag: `"${IMAGE_ID}"`,
				'x-ltc-cache': 'miss',
				'x-ltc-image-url': IMAGE_JSON.url,
				'x-ltc-warnings': encodeURIComponent(JSON.stringify(['Removed <script>'])),
			}),
		);
		expect(items).toHaveLength(1);
		expect(items[0].json).toEqual({
			id: IMAGE_ID,
			url: IMAGE_JSON.url,
			format: 'png',
			bytes: PNG.length,
			cached: false,
			warnings: ['Removed <script>'],
		});
		expect(Object.keys(items[0].binary ?? {})).toEqual(['data']);
		expect(context.prepared).toEqual([{ bytes: PNG, fileName: `${IMAGE_ID}.png`, mimeType: 'image/png' }]);
	});

	it('a PDF keeps its file name and page count, in the binary field asked for', async () => {
		const { items, context } = await simulateResponse(
			{ resource: 'pdf', operation: 'create', template: 'invoice', download: true, binaryPropertyName: 'invoice' },
			response(PDF, {
				'Content-Type': 'application/pdf',
				'Content-Disposition': 'inline; filename="invoice-INV-2026-0142.pdf"',
				ETag: '"' + 'c'.repeat(64) + '"',
				'X-LTC-Pages': '3',
				'X-LTC-Credits-Used': '2',
				'X-LTC-Cache': 'hit',
				'X-LTC-Pdf-Url': 'https://linktocard.com/i/u_1/c.pdf',
				'X-LTC-Warnings': encodeURIComponent('[]'),
			}),
		);
		expect(items[0].json).toEqual({
			id: 'c'.repeat(64),
			url: 'https://linktocard.com/i/u_1/c.pdf',
			filename: 'invoice-INV-2026-0142.pdf',
			pages: 3,
			bytes: PDF.length,
			credits_used: 2,
			cached: true,
			warnings: [],
		});
		expect(Object.keys(items[0].binary ?? {})).toEqual(['invoice']);
		expect(context.prepared[0]).toMatchObject({ fileName: 'invoice-INV-2026-0142.pdf', mimeType: 'application/pdf' });
	});

	it('a link card downloads like an image', async () => {
		const { context } = await simulateResponse(
			{ resource: 'linkCard', operation: 'createFromUrl', url: 'https://a.example', download: true },
			response(new Uint8Array(PNG), { 'content-type': 'image/jpeg', etag: '"d1"' }),
		);
		expect(context.prepared[0]).toMatchObject({ fileName: 'd1.jpg', mimeType: 'image/jpeg' });
		expect(context.prepared[0].bytes.equals(PNG)).toBe(true);
	});

	it('an HTTP error while downloading becomes a NodeApiError with the API message', async () => {
		const body = {
			error: {
				code: 'quota_exceeded',
				message: 'This account has no images left this period.',
				docs: 'https://linktocard.com/docs/api#errors',
			},
		};
		const attempt = simulateResponse(
			{ ...imageValues, download: true },
			response(Buffer.from(JSON.stringify(body)), { 'content-type': 'application/json' }, 402),
		);
		await expect(attempt).rejects.toBeInstanceOf(NodeApiError);
		const error = (await attempt.catch((caught: unknown) => caught)) as NodeApiError;
		expect(error.httpCode).toBe('402');
		expect(error.description).toBe('This account has no images left this period.');
	});

	it("a batch ZIP part becomes binary data under the API's file name, with its part numbers", async () => {
		const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
		const { items, context } = await simulateResponse(
			{ resource: 'bulk', operation: 'downloadZip', batchId: 'bat_1', zipPart: 2, binaryPropertyName: 'zip' },
			response(ZIP, {
				'Content-Type': 'application/zip',
				'Content-Disposition': 'attachment; filename="bat_1-part-2-of-3.zip"',
				'X-LTC-Zip-Part': '2',
				'X-LTC-Zip-Parts': '3',
			}),
		);
		expect(items[0].json).toEqual({ filename: 'bat_1-part-2-of-3.zip', part: 2, parts: 3, bytes: ZIP.length });
		expect(Object.keys(items[0].binary ?? {})).toEqual(['zip']);
		expect(context.prepared).toEqual([{ bytes: ZIP, fileName: 'bat_1-part-2-of-3.zip', mimeType: 'application/zip' }]);
	});

	it("a ZIP part that does not exist stops with the API's message", async () => {
		const body = { error: { code: 'not_found', message: "This batch's ZIP has 1 part; ask for part=1 to part=1 (zip_parts in GET of the batch lists them)." } };
		const error = (await simulateResponse(
			{ resource: 'bulk', operation: 'downloadZip', batchId: 'bat_1', zipPart: 2 },
			response(Buffer.from(JSON.stringify(body)), { 'content-type': 'application/json' }, 404),
		).catch((caught: unknown) => caught)) as NodeApiError;
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('404');
		expect(error.description).toBe(body.error.message);
	});

	it('a non-JSON error body still produces a readable error', async () => {
		const error = (await simulateResponse(
			{ ...imageValues, download: true },
			response(Buffer.from('<html>Bad gateway</html>'), { 'content-type': 'text/html' }, 502),
		).catch((caught: unknown) => caught)) as NodeApiError;
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.httpCode).toBe('502');
		expect(error.description).toContain('Bad gateway');
	});
});

describe('preSend checks', () => {
	const image = (values: INodeParameters) => simulateRequest({ ...imageValues, ...values });

	it('refuses Data (JSON) that is not valid JSON, or not an object', async () => {
		await expect(image({ additionalFields: { dataJson: '{"title": ' } })).rejects.toThrow("'Data (JSON)' is not valid JSON");
		await expect(image({ additionalFields: { dataJson: '["a"]' } })).rejects.toThrow("'Data (JSON)' must be a JSON object");
		await expect(image({ additionalFields: { dataJson: '"text"' } })).rejects.toThrow("'Data (JSON)' must be a JSON object");
	});

	it('treats empty Data (JSON) as not given', async () => {
		expect((await image({ additionalFields: { dataJson: '  ' } })).body).toEqual({ template: 'blog' });
		expect((await image({ additionalFields: { dataJson: '{}' } })).body).toEqual({ template: 'blog' });
	});

	it('refuses a template field without a name, and sends a missing value as empty text', async () => {
		await expect(image({ templateFields: { field: [{ name: ' ', value: 'x' }] } })).rejects.toThrow(
			"Every entry in 'Template Fields' needs a name",
		);
		expect((await image({ templateFields: { field: [{ name: 'title' }] } })).body.data).toEqual({ title: '' });
	});

	it('refuses rows that are not a non-empty list of objects', async () => {
		const start = (rows: unknown) => simulateRequest({ resource: 'bulk', operation: 'start', template: 'certificate', rows } as INodeParameters);
		await expect(start('[]')).rejects.toThrow("'Rows' must be a JSON array with at least one row");
		await expect(start('{"recipient_name": "Maya"}')).rejects.toThrow("'Rows' must be a JSON array");
		await expect(start('[{"a": 1}, "b"]')).rejects.toThrow("Row 2 in 'Rows' is not a JSON object");
		await expect(start('[{"a": 1}, [1]]')).rejects.toThrow("Row 2 in 'Rows' is not a JSON object");
		await expect(start('[{')).rejects.toThrow("'Rows' is not valid JSON");
	});
});

describe('header helpers', () => {
	it('read headers in any case, and the first of repeated values', () => {
		expect(headerValue({ 'X-LTC-Cache': 'hit' }, 'x-ltc-cache')).toBe('hit');
		expect(headerValue({ etag: ['"1"', '"2"'] }, 'ETag')).toBe('"1"');
		expect(headerValue({}, 'etag')).toBeUndefined();
		expect(headerValue(undefined, 'etag')).toBeUndefined();
	});

	it('decode warnings defensively', () => {
		expect(decodeWarnings(encodeURIComponent('["a","b"]'))).toEqual(['a', 'b']);
		expect(decodeWarnings('%E0%A4%A')).toEqual([]);
		expect(decodeWarnings(encodeURIComponent('{"a":1}'))).toEqual([]);
		expect(decodeWarnings(undefined)).toEqual([]);
	});

	it('read the file name from Content-Disposition', () => {
		expect(fileNameFromDisposition('inline; filename="report (2).pdf"')).toBe('report (2).pdf');
		expect(fileNameFromDisposition('inline')).toBeUndefined();
	});

	it('take bytes in the forms an HTTP client may return them, and nothing else', () => {
		expect(bodyBytes(PNG)).toBe(PNG);
		expect(bodyBytes(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length))?.equals(PNG)).toBe(true);
		expect(bodyBytes(new Uint8Array(PNG))?.equals(PNG)).toBe(true);
		expect(bodyBytes({ id: 'x' })).toBeNull();
		expect(bodyBytes('text')).toBeNull();
	});

	it('leave unknown numbers and ids as null instead of guessing', () => {
		expect(fileMetadata('pdf', { 'x-ltc-pages': 'many' }, 10)).toMatchObject({ id: null, pages: null, credits_used: null, filename: null });
		expect(fileMetadata('image', { 'content-type': 'image/gif' }, 10)).toMatchObject({ format: null, url: null });
	});
});
