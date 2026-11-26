import {
	NodeConnectionTypes,
	NodeHelpers,
	type INodeParameters,
	type INodeProperties,
	type INodePropertyOptions,
} from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { NODE, allProperties, credential, description, nodeParameters, operationsByResource } from './helpers';

/** Parameter names n8n reports as missing (required and empty) for these values. */
function missingRequired(values: INodeParameters): string[] {
	const parameters = nodeParameters(values);
	const issues = NodeHelpers.getNodeParametersIssues(description.properties, { ...NODE, parameters }, description);
	return Object.keys(issues?.parameters ?? {}).sort();
}

/** Every routing.request url / routing.send property and value in the description. */
function routingStrings(): string[] {
	const strings: string[] = [];
	const visit = (item: INodeProperties | INodePropertyOptions): void => {
		const { routing } = item;
		if (routing?.request?.url !== undefined) strings.push(String(routing.request.url));
		if (routing?.send?.property !== undefined) strings.push(routing.send.property);
		if (routing?.send?.value !== undefined) strings.push(routing.send.value);
	};
	for (const { property } of allProperties()) {
		visit(property);
		if (property.type === 'options') (property.options as INodePropertyOptions[]).forEach(visit);
	}
	return strings;
}

describe('credential', () => {
	it('is an API key sent as a bearer token', () => {
		expect(credential.name).toBe('linkToCardApi');
		expect(credential.displayName).toBe('Link To Card API');
		const apiKey = credential.properties.find((property) => property.name === 'apiKey');
		expect(apiKey).toMatchObject({ type: 'string', required: true, typeOptions: { password: true } });
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('has a base URL that defaults to production', () => {
		const baseUrl = credential.properties.find((property) => property.name === 'baseUrl');
		expect(baseUrl).toMatchObject({ type: 'string', default: 'https://linktocard.com' });
		expect(baseUrl?.typeOptions?.password).toBeUndefined();
	});

	it('is tested with GET /v1/usage on that base URL', () => {
		expect(credential.test).toEqual({
			request: { baseURL: '={{$credentials.baseUrl}}', url: '/v1/usage', method: 'GET' },
		});
	});

	it('links to existing documentation and has themed icons', () => {
		expect(credential.documentationUrl).toBe('https://linktocard.com/docs/api#authentication');
		expect(credential.icon).toEqual({ light: 'file:../icons/linktocard.svg', dark: 'file:../icons/linktocard.dark.svg' });
	});
});

describe('node', () => {
	it('is a regular declarative node using the credential', () => {
		expect(description.name).toBe('linkToCard');
		expect(description.displayName).toBe('Link To Card');
		expect(description.version).toBe(1);
		expect(description.usableAsTool).toBe(true);
		expect(description.inputs).toEqual([NodeConnectionTypes.Main]);
		expect(description.outputs).toEqual([NodeConnectionTypes.Main]);
		expect(description.credentials).toEqual([{ name: credential.name, required: true }]);
		expect(description.requestDefaults?.baseURL).toBe('={{$credentials.baseUrl}}');
		expect(description.subtitle).toBe('={{$parameter["operation"] + ": " + $parameter["resource"]}}');
		expect(description.icon).toEqual({
			light: 'file:../../icons/linktocard.svg',
			dark: 'file:../../icons/linktocard.dark.svg',
		});
	});

	it('has no execute method, so n8n runs it through the routing engine', () => {
		expect('execute' in description).toBe(false);
	});

	it('offers the five resources and their operations', () => {
		expect(operationsByResource().map(({ resource, operation }) => `${resource}:${String(operation.value)}`)).toEqual([
			'bulk:downloadZip',
			'bulk:get',
			'bulk:start',
			'image:create',
			'linkCard:createFromUrl',
			'linkPreview:check',
			'pdf:create',
		]);
	});

	it('gives every operation an action, a description and a request', () => {
		for (const { resource, operation } of operationsByResource()) {
			const label = `${resource}:${String(operation.value)}`;
			// Sentence case: only the first word is capitalised, apart from acronyms such as PDF.
			const [first, ...rest] = String(operation.action).split(' ');
			expect(first, label).toMatch(/^[A-Z][a-z]+$/);
			for (const word of rest) expect(word, label).toMatch(/^([a-z]+|[A-Z]{2,})$/);
			expect(operation.action, label).not.toMatch(/\b(a|an|the)\b/i);
			expect(operation.description, label).toMatch(/^[A-Z].*[^.]$/);
			expect(operation.routing?.request?.method, label).toMatch(/^(GET|POST)$/);
			expect(operation.routing?.request?.url, label).toMatch(/^\/v1\//);
		}
	});

	it('uses no n8n expressions in its routing, so test/routing.test.ts sees exactly what is sent', () => {
		const strings = routingStrings();
		expect(strings.length).toBeGreaterThan(10);
		expect(strings.filter((text) => text.startsWith('=') || text.includes('{{'))).toEqual([]);
	});

	it('keeps routing out of fixed-collection values (the simulator does not walk them)', () => {
		const inside = allProperties().filter(({ path, property }) => path.split('.').length > 2 && property.routing);
		expect(inside).toEqual([]);
	});
});

describe('parameters', () => {
	const resources = ['bulk', 'image', 'linkCard', 'linkPreview', 'pdf'];
	const operationsOf = (resource: string) =>
		operationsByResource()
			.filter((entry) => entry.resource === resource)
			.map((entry) => String(entry.operation.value));

	it('shows every parameter for one resource and its own operations only', () => {
		for (const property of description.properties) {
			if (property.name === 'resource') continue;
			const show = property.displayOptions?.show ?? {};
			const shownResources = show.resource as string[] | undefined;
			expect(shownResources, property.name).toHaveLength(1);
			const resource = shownResources![0];
			expect(resources, property.name).toContain(resource);
			if (property.name === 'operation') continue;
			const shownOperations = show.operation as string[] | undefined;
			expect(shownOperations?.length, `${property.name} of ${resource}`).toBeGreaterThan(0);
			for (const operation of shownOperations ?? []) expect(operationsOf(resource), property.name).toContain(operation);
		}
	});

	it('never shows two parameters with the same name at once', () => {
		for (const { resource, operation } of operationsByResource()) {
			for (const extra of [{}, { source: 'html' }, { download: true }]) {
				const parameters = nodeParameters({ resource, operation: String(operation.value), ...extra });
				const shown = description.properties
					.filter((property) => NodeHelpers.displayParameter(parameters, property, NODE, description, parameters))
					.map((property) => property.name);
				expect(shown, `${resource}:${String(operation.value)}`).toEqual([...new Set(shown)]);
			}
		}
	});

	it('marks the fields each operation cannot do without as required', () => {
		expect(missingRequired({ resource: 'image', operation: 'create' })).toEqual(['template']);
		expect(missingRequired({ resource: 'image', operation: 'create', source: 'html' })).toEqual(['html']);
		expect(missingRequired({ resource: 'pdf', operation: 'create' })).toEqual(['template']);
		expect(missingRequired({ resource: 'pdf', operation: 'create', source: 'html' })).toEqual(['html']);
		expect(missingRequired({ resource: 'linkCard', operation: 'createFromUrl' })).toEqual(['url']);
		// n8n checks emptiness only for some types; a required "json" parameter is checked by its preSend.
		expect(missingRequired({ resource: 'bulk', operation: 'start', rows: '' })).toEqual(['template']);
		const rows = description.properties.find((property) => property.name === 'rows');
		expect(rows).toMatchObject({ type: 'json', required: true });
		expect(missingRequired({ resource: 'bulk', operation: 'get' })).toEqual(['batchId']);
		expect(missingRequired({ resource: 'bulk', operation: 'downloadZip' })).toEqual(['batchId']);
		expect(missingRequired({ resource: 'bulk', operation: 'downloadZip', batchId: 'bat_1', binaryPropertyName: '' })).toEqual(['binaryPropertyName']);
		expect(missingRequired({ resource: 'linkPreview', operation: 'check' })).toEqual(['url']);
		expect(
			missingRequired({ resource: 'image', operation: 'create', template: 'blog', download: true, binaryPropertyName: '' }),
		).toEqual(['binaryPropertyName']);
	});

	it('has nothing missing once the required fields are filled in', () => {
		expect(missingRequired({ resource: 'image', operation: 'create', template: 'blog' })).toEqual([]);
		expect(missingRequired({ resource: 'bulk', operation: 'start', template: 'certificate', rows: '[{}]' })).toEqual([]);
		expect(missingRequired({ resource: 'linkPreview', operation: 'check', url: 'https://example.com' })).toEqual([]);
	});

	it('follows the n8n copy rules: "Whether" booleans, "e.g." placeholders, Title Case labels', () => {
		const smallWords = new Set(['a', 'an', 'and', 'as', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to']);
		for (const { path, property } of allProperties()) {
			if (property.type === 'boolean') expect(property.description, path).toMatch(/^Whether /);
			if (property.placeholder !== undefined && property.type !== 'fixedCollection' && property.type !== 'collection') {
				expect(property.placeholder, path).toMatch(/^e\.g\. /);
			}
			for (const word of property.displayName.split(' ')) {
				if (!smallWords.has(word)) expect(word, `${path}: ${property.displayName}`).toMatch(/^[A-Z(]/);
			}
		}
	});

	it('lets the API defaults apply: optional fields sit in Additional Fields and start empty', () => {
		const additional = description.properties.filter((property) => property.name === 'additionalFields');
		expect(additional).toHaveLength(4);
		for (const collection of additional) {
			expect(collection.type).toBe('collection');
			expect(collection.default).toEqual({});
		}
	});
});
