import {
	NodeApiError,
	type IDataObject,
	type IExecuteSingleFunctions,
	type IN8nHttpFullResponse,
	type INodeExecutionData,
	type JsonObject,
	type PostReceiveAction,
} from 'n8n-workflow';

/*
 * postReceive hooks of the declarative routing: the downloaded file as n8n binary data, and the
 * 'Simplify' views. Field names follow the API's JSON responses (docs: linktocard.com/docs/api),
 * so a workflow can switch between a URL and a downloaded file without renaming fields.
 */

export type FileKind = 'image' | 'pdf' | 'zip';

/** A header value from a response whose header names may come in any case. */
export function headerValue(headers: IDataObject | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== wanted) continue;
		if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : undefined;
		return value === undefined || value === null ? undefined : String(value);
	}
	return undefined;
}

/** The body when it is bytes (download mode reads responses as an ArrayBuffer), else null. */
export function bodyBytes(body: unknown): Buffer | null {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	return null;
}

/** X-LTC-Warnings: a URI-encoded JSON array of strings. Anything else reads as no warnings. */
export function decodeWarnings(header: string | undefined): string[] {
	if (!header) return [];
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(header));
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/** `inline; filename="invoice.pdf"`: the API sanitises names, so there is never a quote inside. */
export function fileNameFromDisposition(header: string | undefined): string | undefined {
	const match = header ? /filename="([^"]+)"/i.exec(header) : null;
	return match ? match[1] : undefined;
}

function integerOrNull(text: string | undefined): number | null {
	if (text === undefined || !/^\d+$/.test(text.trim())) return null;
	return Number(text.trim());
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
};

/** What the binary-response headers say about the file, under the JSON response's field names. */
export function fileMetadata(kind: FileKind, headers: IDataObject, bytes: number): IDataObject {
	if (kind === 'zip') {
		// GET /v1/batches/{id}/zip: X-LTC-Zip-Part and X-LTC-Zip-Parts say which part this is.
		return {
			filename: fileNameFromDisposition(headerValue(headers, 'content-disposition')) ?? null,
			part: integerOrNull(headerValue(headers, 'x-ltc-zip-part')),
			parts: integerOrNull(headerValue(headers, 'x-ltc-zip-parts')),
			bytes,
		};
	}
	const etag = headerValue(headers, 'etag');
	const id = etag ? etag.replace(/^W\//, '').replace(/"/g, '') : null;
	const cached = headerValue(headers, 'x-ltc-cache') === 'hit';
	const warnings = decodeWarnings(headerValue(headers, 'x-ltc-warnings'));
	if (kind === 'pdf') {
		return {
			id,
			url: headerValue(headers, 'x-ltc-pdf-url') ?? null,
			filename: fileNameFromDisposition(headerValue(headers, 'content-disposition')) ?? null,
			pages: integerOrNull(headerValue(headers, 'x-ltc-pages')),
			bytes,
			credits_used: integerOrNull(headerValue(headers, 'x-ltc-credits-used')),
			cached,
			warnings,
		};
	}
	const contentType = (headerValue(headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
	const extension = IMAGE_EXTENSIONS[contentType];
	return {
		id,
		url: headerValue(headers, 'x-ltc-image-url') ?? null,
		format: extension === 'jpg' ? 'jpeg' : (extension ?? null),
		bytes,
		cached,
		warnings,
	};
}

/** A name for the binary property: the PDF's or ZIP's own file name, or the image id with its extension. */
export function fileNameFor(kind: FileKind, metadata: IDataObject): string {
	if (kind === 'pdf') return typeof metadata.filename === 'string' ? metadata.filename : 'document.pdf';
	if (kind === 'zip') return typeof metadata.filename === 'string' ? metadata.filename : 'batch.zip';
	const extension = metadata.format === 'jpeg' ? 'jpg' : typeof metadata.format === 'string' ? metadata.format : 'png';
	return `${typeof metadata.id === 'string' && metadata.id !== '' ? metadata.id : 'card'}.${extension}`;
}

/** The API's error body ({"error": {"code", "message", "docs"}}) read from bytes, if it is one. */
export function errorFromBytes(bytes: Buffer): { body: JsonObject; message?: string } {
	const text = bytes.toString('utf8');
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			const error = (parsed as { error?: { message?: unknown } }).error;
			const message = typeof error?.message === 'string' ? error.message : undefined;
			return { body: parsed as JsonObject, message };
		}
	} catch {
		// Not JSON (a proxy's HTML page, for example): keep the start of the text below.
	}
	const snippet = text.slice(0, 300);
	return { body: { message: snippet }, message: snippet || undefined };
}

const DEFAULT_MIME_TYPES: Record<FileKind, string> = { image: 'image/png', pdf: 'application/pdf', zip: 'application/zip' };

/**
 * The operation's file output. In JSON mode (the default) the items pass through untouched.
 * With 'Download File' on, the bytes become a binary property and the JSON part carries the
 * response headers' facts; an HTTP error becomes the same NodeApiError n8n raises in JSON mode.
 */
export function fileResponse(kind: FileKind): PostReceiveAction {
	return async function (
		this: IExecuteSingleFunctions,
		items: INodeExecutionData[],
		response: IN8nHttpFullResponse,
	): Promise<INodeExecutionData[]> {
		const bytes = bodyBytes(response.body);
		if (bytes === null) return items;

		if (response.statusCode >= 400) {
			const { body, message } = errorFromBytes(bytes);
			throw new NodeApiError(this.getNode(), body, {
				httpCode: String(response.statusCode),
				description: message,
				itemIndex: this.getItemIndex(),
			});
		}

		const headers = response.headers ?? {};
		const metadata = fileMetadata(kind, headers, bytes.length);
		const mimeType = (headerValue(headers, 'content-type') ?? DEFAULT_MIME_TYPES[kind])
			.split(';')[0]
			.trim();
		const propertyName = String(this.getNodeParameter('binaryPropertyName', 'data') || 'data');
		const binary = await this.helpers.prepareBinaryData(bytes, fileNameFor(kind, metadata), mimeType);
		return [{ json: metadata, binary: { [propertyName]: binary } }];
	};
}

/* ------------------------------------------------------------------ */
/* Simplify                                                            */
/* ------------------------------------------------------------------ */

export type SimplifyKind = 'image' | 'pdf' | 'linkCard' | 'check';

function objectAt(value: unknown): IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as IDataObject) : {};
}

function valueOrNull(value: unknown): IDataObject[string] {
	return value === undefined ? null : (value as IDataObject[string]);
}

/** Ids of the checks with one status, in the API's order. */
function checkIds(checks: unknown, status: string): string[] {
	if (!Array.isArray(checks)) return [];
	return checks
		.map(objectAt)
		.filter((check) => check.status === status)
		.map((check) => String(check.id));
}

/**
 * At most 10 flat fields, most used first (n8n's UX guidelines for responses with more than 10
 * fields). `images_remaining` is usage.total_remaining: what the account can still render.
 */
export function simplified(kind: SimplifyKind, json: IDataObject): IDataObject {
	const usage = objectAt(json.usage);
	switch (kind) {
		case 'image':
			return {
				url: valueOrNull(json.url),
				id: valueOrNull(json.id),
				width: valueOrNull(json.width),
				height: valueOrNull(json.height),
				format: valueOrNull(json.format),
				cached: valueOrNull(json.cached),
				expires_at: valueOrNull(json.expires_at),
				warnings: valueOrNull(json.warnings),
				images_remaining: valueOrNull(usage.total_remaining),
			};
		case 'pdf':
			return {
				url: valueOrNull(json.url),
				id: valueOrNull(json.id),
				filename: valueOrNull(json.filename),
				pages: valueOrNull(json.pages),
				credits_used: valueOrNull(json.credits_used),
				cached: valueOrNull(json.cached),
				expires_at: valueOrNull(json.expires_at),
				warnings: valueOrNull(json.warnings),
				images_remaining: valueOrNull(usage.total_remaining),
			};
		case 'linkCard':
			return {
				url: valueOrNull(json.url),
				id: valueOrNull(json.id),
				page_url: valueOrNull(objectAt(json.link).final_url),
				width: valueOrNull(json.width),
				height: valueOrNull(json.height),
				format: valueOrNull(json.format),
				cached: valueOrNull(json.cached),
				expires_at: valueOrNull(json.expires_at),
				warnings: valueOrNull(json.warnings),
				images_remaining: valueOrNull(usage.total_remaining),
			};
		case 'check': {
			const preview = objectAt(json.preview);
			const image = objectAt(json.image);
			return {
				final_url: valueOrNull(json.final_url),
				status: valueOrNull(json.status),
				title: valueOrNull(preview.title),
				description: valueOrNull(preview.description),
				image: valueOrNull(image.url),
				image_width: valueOrNull(image.width),
				image_height: valueOrNull(image.height),
				failed_checks: checkIds(json.checks, 'fail'),
				warned_checks: checkIds(json.checks, 'warn'),
				id: valueOrNull(json.id),
			};
		}
	}
}

/** The 'Simplify' switch: applied only when it is on. */
export function simplifyResponse(kind: SimplifyKind): PostReceiveAction {
	return async function (this: IExecuteSingleFunctions, items: INodeExecutionData[]): Promise<INodeExecutionData[]> {
		if (this.getNodeParameter('simplify', false) !== true) return items;
		return items.map((item) => ({ ...item, json: simplified(kind, objectAt(item.json)) }));
	};
}
