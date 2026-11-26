import {
	NodeOperationError,
	type IDataObject,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	type PreSendAction,
} from 'n8n-workflow';

/*
 * preSend hooks of the declarative routing. Plain `routing.send` covers the scalar fields; these
 * cover what it cannot express: template data assembled from two parameters, JSON parameters that
 * must be parsed and checked before they are sent, the download switch (which changes how the
 * response is read, not only the body) and the batch id in the URL path.
 */

/** The request body as an object. The routing engine starts every request with `{}`. */
function bodyOf(requestOptions: IHttpRequestOptions): IDataObject {
	const { body } = requestOptions;
	if (body === undefined || body === null) {
		requestOptions.body = {};
		return requestOptions.body as IDataObject;
	}
	return body as IDataObject;
}

function isPlainObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `json` parameter's value. Typed in the editor it is a string; set by an expression such as
 * `{{ $json.rows }}` it can already be an object or an array. Empty means "not given".
 */
export function parseJsonParameter(
	context: IExecuteSingleFunctions,
	value: unknown,
	label: string,
): unknown {
	if (typeof value !== 'string') return value ?? undefined;
	const text = value.trim();
	if (text === '') return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), `'${label}' is not valid JSON`, {
			itemIndex: context.getItemIndex(),
			description: `Check the brackets, quotes and commas in '${label}': ${(error as Error).message}`,
		});
	}
}

interface TemplateFieldEntry {
	name?: string;
	value?: unknown;
}

/**
 * Template data: 'Data (JSON)' from Additional Fields first, then each 'Template Fields' entry
 * on top, so a field set in the editor wins over the same key in the JSON. Sent only when there
 * is something to send, so a template's own defaults apply otherwise.
 */
export async function sendTemplateData(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const data: IDataObject = {};

	const json = parseJsonParameter(this, this.getNodeParameter('additionalFields.dataJson', ''), 'Data (JSON)');
	if (json !== undefined) {
		if (!isPlainObject(json)) {
			throw new NodeOperationError(this.getNode(), "'Data (JSON)' must be a JSON object", {
				itemIndex: this.getItemIndex(),
				description: 'Use one object whose keys are the template\'s field names, e.g. {"title": "Hello"}',
			});
		}
		Object.assign(data, json);
	}

	const fields = this.getNodeParameter('templateFields.field', []) as TemplateFieldEntry[];
	for (const entry of Array.isArray(fields) ? fields : []) {
		const name = typeof entry.name === 'string' ? entry.name.trim() : '';
		if (name === '') {
			throw new NodeOperationError(this.getNode(), "Every entry in 'Template Fields' needs a name", {
				itemIndex: this.getItemIndex(),
				description: 'Fill in the field name, such as title, or remove the empty entry',
			});
		}
		data[name] = entry.value === undefined || entry.value === null ? '' : (entry.value as IDataObject[string]);
	}

	if (Object.keys(data).length > 0) bodyOf(requestOptions).data = data;
	return requestOptions;
}

/**
 * 'Rows' of Bulk PDF > Start: one object of template data per document. Checked here so a
 * malformed list fails in n8n with a pointer to the row, before anything reaches the API.
 */
export async function sendBatchRows(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const rows = parseJsonParameter(this, this.getNodeParameter('rows', ''), 'Rows');
	if (!Array.isArray(rows) || rows.length === 0) {
		throw new NodeOperationError(this.getNode(), "'Rows' must be a JSON array with at least one row", {
			itemIndex: this.getItemIndex(),
			description: 'Each row is one object of template data, e.g. [{"recipient_name": "Maya Chen"}]',
		});
	}
	rows.forEach((row: unknown, index: number) => {
		if (!isPlainObject(row)) {
			throw new NodeOperationError(this.getNode(), `Row ${index + 1} in 'Rows' is not a JSON object`, {
				itemIndex: this.getItemIndex(),
				description: 'Each row is one object of template data, e.g. {"recipient_name": "Maya Chen"}',
			});
		}
	});
	bodyOf(requestOptions).rows = rows as IDataObject[];
	return requestOptions;
}

/**
 * 'Download File' on: ask for the file itself ("response": "binary") and read the answer as
 * bytes. HTTP errors are then handled by fileResponse() (shared/postreceive.ts), because a
 * byte-encoded error body would otherwise reach the n8n error view unreadable.
 */
export async function sendDownloadMode(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	if (this.getNodeParameter('download', false) !== true) return requestOptions;
	bodyOf(requestOptions).response = 'binary';
	requestOptions.encoding = 'arraybuffer';
	requestOptions.ignoreHttpStatusErrors = true;
	return requestOptions;
}

/**
 * Text fields of Additional Fields that were added but left empty (or only spaces) are left out of
 * the body, so the API's default applies instead of an empty value it would refuse or keep. `paths`
 * are the body paths those fields are sent to; a "pdf" object left empty goes too.
 */
export function omitEmptyText(paths: readonly string[]): PreSendAction {
	return async function (this: IExecuteSingleFunctions, requestOptions: IHttpRequestOptions): Promise<IHttpRequestOptions> {
		const body = bodyOf(requestOptions);
		for (const path of paths) {
			const keys = path.split('.');
			const last = keys.pop() as string;
			const parent = keys.reduce<unknown>(
				(cursor, key) => (isPlainObject(cursor) ? cursor[key] : undefined),
				body,
			);
			if (!isPlainObject(parent)) continue;
			const value = parent[last];
			if (typeof value === 'string' && value.trim() === '') delete parent[last];
			if (keys.length === 1 && isPlainObject(body[keys[0]]) && Object.keys(body[keys[0]] as IDataObject).length === 0) {
				delete body[keys[0]];
			}
		}
		return requestOptions;
	};
}

/** "." and ".." survive encodeURIComponent but are removed when a URL path is normalised. */
const DOT_SEGMENT = /(^|[/\\])\.{1,2}([/\\]|$)/;

/**
 * One URL path segment from an id. Same rules as n8n's toPathSegment(), written out because that
 * expression function only exists from n8n 2.46.1 and this node also runs on older versions.
 */
export function pathSegment(context: IExecuteSingleFunctions, value: unknown, label: string): string {
	const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
	if (text === '' || DOT_SEGMENT.test(text)) {
		throw new NodeOperationError(context.getNode(), `'${label}' is not a valid ID`, {
			itemIndex: context.getItemIndex(),
			description: `Use the ID returned when the batch was started, e.g. bat_...`,
		});
	}
	return encodeURIComponent(text);
}

/**
 * Bulk PDF > Get: GET /v1/batches/{id}. Bulk PDF > Download ZIP: GET /v1/batches/{id}/zip, read
 * as bytes; HTTP errors are then handled by fileResponse('zip') (shared/postreceive.ts), as for
 * 'Download File', so the API's message (for example which parts exist) reaches the error view.
 */
export async function sendBatchIdInPath(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const id = pathSegment(this, this.getNodeParameter('batchId', ''), 'Batch ID');
	if (this.getNodeParameter('operation', '') === 'downloadZip') {
		requestOptions.url = `/v1/batches/${id}/zip`;
		requestOptions.encoding = 'arraybuffer';
		requestOptions.ignoreHttpStatusErrors = true;
		return requestOptions;
	}
	requestOptions.url = `/v1/batches/${id}`;
	return requestOptions;
}
