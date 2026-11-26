/*
 * Test helpers: a fake IExecuteSingleFunctions and a small re-implementation of the parts of n8n's
 * declarative routing engine (n8n-core, execution-engine/routing-node.js) that this node uses.
 *
 * The simulator walks the node's properties the way RoutingNode.getRequestOptionsFromParameters
 * does: only displayed parameters count (n8n-workflow's own NodeHelpers.displayParameter decides),
 * "options" parameters contribute their selected option's routing, "collection" parameters only
 * the options the user added, and routing.send writes the raw value with dot paths into the body
 * or the query string. Then it runs the collected preSend hooks in order. It does not evaluate n8n
 * expressions; description.test.ts checks that the routing uses none besides the credential's
 * base URL, which is why this is enough to see the request n8n would send.
 */
import {
	NodeHelpers,
	type IBinaryData,
	type IDataObject,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	type IN8nHttpFullResponse,
	type INode,
	type INodeExecutionData,
	type INodeParameters,
	type INodeProperties,
	type INodePropertyOptions,
	type PostReceiveAction,
	type PreSendAction,
} from 'n8n-workflow';
import { LinkToCardApi } from '../credentials/LinkToCardApi.credentials';
import { LinkToCard } from '../nodes/LinkToCard/LinkToCard.node';

export const description = new LinkToCard().description;
export const credential = new LinkToCardApi();

export const NODE: INode = {
	id: 'node-1',
	name: 'Link To Card',
	type: 'n8n-nodes-linktocard.linkToCard',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** The node's parameters with n8n's defaults filled in, as the workflow engine prepares them. */
export function nodeParameters(values: INodeParameters): INodeParameters {
	return NodeHelpers.getNodeParameters(description.properties, values, true, false, NODE, description) ?? {};
}

export function getPath(source: unknown, path: string): unknown {
	let value: unknown = source;
	for (const key of path.split('.')) {
		if (typeof value !== 'object' || value === null) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function setPath(target: IDataObject, path: string, value: unknown): void {
	const keys = path.split('.');
	let cursor: IDataObject = target;
	keys.slice(0, -1).forEach((key) => {
		if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
		cursor = cursor[key] as IDataObject;
	});
	cursor[keys[keys.length - 1]] = value as IDataObject[string];
}

export interface PreparedFile {
	bytes: Buffer;
	fileName?: string;
	mimeType?: string;
}

export type FakeContext = IExecuteSingleFunctions & { prepared: PreparedFile[] };

/** getNodeParameter reads the given parameters (dot paths allowed) and falls back like n8n. */
export function fakeContext(parameters: INodeParameters): FakeContext {
	const prepared: PreparedFile[] = [];
	const context = {
		prepared,
		getNode: () => ({ ...NODE, parameters }),
		getItemIndex: () => 0,
		getNodeParameter: (name: string, fallback?: unknown) => {
			const value = getPath(parameters, name);
			return value === undefined ? fallback : value;
		},
		helpers: {
			prepareBinaryData: async (bytes: Buffer, fileName?: string, mimeType?: string): Promise<IBinaryData> => {
				prepared.push({ bytes, fileName, mimeType });
				return { data: bytes.toString('base64'), mimeType: mimeType ?? 'text/plain', fileName };
			},
		},
	};
	return context as unknown as FakeContext;
}

export interface CollectedRouting {
	options: IHttpRequestOptions & { body: IDataObject; qs: IDataObject; headers: IDataObject };
	preSend: PreSendAction[];
	postReceive: PostReceiveAction[];
}

function isDisplayed(parameters: INodeParameters, property: INodeProperties | INodePropertyOptions): boolean {
	return NodeHelpers.displayParameter(parameters, property, NODE, description, parameters);
}

function collect(
	property: INodeProperties | INodePropertyOptions,
	parameters: INodeParameters,
	basePath: string,
	into: CollectedRouting,
): void {
	if (!isDisplayed(parameters, property)) return;
	const routing = property.routing;
	if (routing) {
		const value = 'type' in property ? getPath(parameters, basePath + property.name) : undefined;
		if (routing.request) Object.assign(into.options, routing.request);
		if (routing.send) {
			const { property: target, type, value: template, preSend } = routing.send;
			if (template !== undefined) throw new Error(`routing.send.value is not simulated (${property.name})`);
			if (target !== undefined) setPath(type === 'query' ? into.options.qs : into.options.body, target, value);
			if (preSend) into.preSend.push(...preSend);
		}
		if (routing.output?.postReceive) into.postReceive.push(...routing.output.postReceive);
	}
	if (!('type' in property)) return;
	if (property.type === 'options') {
		const selected = (property.options as INodePropertyOptions[]).find(
			(option) => option.value === getPath(parameters, basePath + property.name),
		);
		if (selected) collect(selected, parameters, `${basePath}${property.name}.`, into);
	} else if (property.type === 'collection') {
		const value = (getPath(parameters, basePath + property.name) ?? {}) as IDataObject;
		for (const option of property.options as INodeProperties[]) {
			if (Object.keys(value).includes(option.name)) collect(option, parameters, `${basePath}${property.name}.`, into);
		}
	}
}

/** routing.request/send/output of every displayed parameter, before the preSend hooks run. */
export function collectRouting(values: INodeParameters): { routing: CollectedRouting; parameters: INodeParameters } {
	const parameters = nodeParameters(values);
	const routing: CollectedRouting = {
		options: { url: '', body: {}, qs: {}, headers: { ...(description.requestDefaults?.headers ?? {}) } },
		preSend: [],
		postReceive: [],
	};
	routing.options.baseURL = description.requestDefaults?.baseURL;
	for (const property of description.properties) collect(property, parameters, '', routing);
	return { routing, parameters };
}

/** The request n8n would send for one input item, with the credential's base URL filled in. */
export async function simulateRequest(
	values: INodeParameters,
	baseUrl = 'https://linktocard.com',
): Promise<CollectedRouting['options']> {
	const { routing, parameters } = collectRouting(values);
	if (routing.options.baseURL !== '={{$credentials.baseUrl}}') {
		throw new Error(`unexpected baseURL ${String(routing.options.baseURL)}`);
	}
	let options: IHttpRequestOptions = { ...routing.options, baseURL: baseUrl };
	const context = fakeContext(parameters);
	for (const hook of routing.preSend) options = await hook.call(context, options);
	return options as CollectedRouting['options'];
}

/** What the node outputs for one response: n8n starts from [{ json: body }] and runs postReceive in order. */
export async function simulateResponse(
	values: INodeParameters,
	response: IN8nHttpFullResponse,
): Promise<{ items: INodeExecutionData[]; context: FakeContext }> {
	const { routing, parameters } = collectRouting(values);
	const context = fakeContext(parameters);
	let items: INodeExecutionData[] = [{ json: response.body as IDataObject }];
	for (const action of routing.postReceive) {
		if (typeof action !== 'function') throw new Error('only function postReceive actions are simulated');
		items = await action.call(context, items, response);
	}
	return { items, context };
}

/** Every resource/operation pair the node offers, read from its description. */
export function operationsByResource(): Array<{ resource: string; operation: INodePropertyOptions }> {
	const resources = description.properties.find((property) => property.name === 'resource');
	const result: Array<{ resource: string; operation: INodePropertyOptions }> = [];
	for (const resource of (resources?.options ?? []) as INodePropertyOptions[]) {
		const operationProperty = description.properties.find(
			(property) =>
				property.name === 'operation' &&
				(property.displayOptions?.show?.resource as string[] | undefined)?.includes(String(resource.value)),
		);
		for (const operation of (operationProperty?.options ?? []) as INodePropertyOptions[]) {
			result.push({ resource: String(resource.value), operation });
		}
	}
	return result;
}

/** Every property, including those inside collections and fixed collections, with its path. */
export function allProperties(
	properties: INodeProperties[] = description.properties,
	path = '',
): Array<{ path: string; property: INodeProperties }> {
	return properties.flatMap((property) => {
		const here = [{ path: `${path}${property.name}`, property }];
		if (property.type === 'collection') {
			return [...here, ...allProperties(property.options as INodeProperties[], `${path}${property.name}.`)];
		}
		if (property.type === 'fixedCollection') {
			const groups = (property.options ?? []) as Array<{ name: string; values: INodeProperties[] }>;
			return [
				...here,
				...groups.flatMap((group) => allProperties(group.values, `${path}${property.name}.${group.name}.`)),
			];
		}
		return here;
	});
}
