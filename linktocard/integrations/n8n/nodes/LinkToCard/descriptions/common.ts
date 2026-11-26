import type { IDisplayOptions, INodeProperties, INodeRequestOutput } from 'n8n-workflow';
import { fileResponse, simplifyResponse, type FileKind, type SimplifyKind } from '../shared/postreceive';
import { sendDownloadMode, sendTemplateData } from '../shared/presend';

/*
 * Property builders shared by several operations. Each takes the resource and operation it is
 * shown for, so every property ends up with an explicit displayOptions.show of both.
 */

export interface OperationTarget {
	resource: string;
	operation: string;
}

export function showFor(target: OperationTarget, extra: IDisplayOptions['show'] = {}): IDisplayOptions {
	return { show: { resource: [target.resource], operation: [target.operation], ...extra } };
}

/** postReceive of an operation that can return a file: the file itself when 'Download File' is on. */
export function fileOutput(kind: FileKind): INodeRequestOutput {
	return { postReceive: [fileResponse(kind)] };
}


/**
 * Template ID or inline HTML and CSS: the API takes exactly one of "template" and "html", and the
 * hidden choice is never sent (the routing engine skips parameters that are not displayed).
 */
export function templateSourceProperties(
	target: OperationTarget,
	templateHelp: { placeholder: string; description: string },
): INodeProperties[] {
	return [
		{
			displayName: 'Template Source',
			name: 'source',
			type: 'options',
			options: [
				{
					name: 'Template ID',
					value: 'template',
					description: 'A starter template or one of your saved templates',
				},
				{
					name: 'HTML and CSS',
					value: 'html',
					description: 'Your own HTML and CSS, sent with this request',
				},
			],
			default: 'template',
			displayOptions: showFor(target),
		},
		{
			displayName: 'Template',
			name: 'template',
			type: 'string',
			required: true,
			default: '',
			placeholder: templateHelp.placeholder,
			description: templateHelp.description,
			displayOptions: showFor(target, { source: ['template'] }),
			routing: { send: { type: 'body', property: 'template' } },
		},
		{
			displayName: 'HTML',
			name: 'html',
			type: 'string',
			typeOptions: { rows: 6 },
			required: true,
			default: '',
			placeholder: 'e.g. <h1>{{title}}</h1>',
			// In Fixed mode n8n sends {{...}} as typed; in Expression mode it would evaluate it itself.
			description:
				'Template HTML with {{field}} placeholders. Keep this field in Fixed mode so n8n leaves the placeholders to Link To Card.',
			displayOptions: showFor(target, { source: ['html'] }),
			routing: { send: { type: 'body', property: 'html' } },
		},
		{
			displayName: 'CSS',
			name: 'css',
			type: 'string',
			typeOptions: { rows: 4 },
			default: '',
			placeholder: 'e.g. h1 { font-size: 80px }',
			description: 'Styles for the HTML above',
			displayOptions: showFor(target, { source: ['html'] }),
			routing: { send: { type: 'body', property: 'css' } },
		},
	];
}

/** Name and value pairs for "data"; the preSend also merges 'Data (JSON)' from Additional Fields. */
export function templateFieldsProperty(
	target: OperationTarget,
	text: { displayName: string; description: string },
): INodeProperties {
	return {
		displayName: text.displayName,
		name: 'templateFields',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Field',
		default: {},
		description: text.description,
		displayOptions: showFor(target),
		options: [
			{
				displayName: 'Field',
				name: 'field',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. title',
						description: 'A field name of the template',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
						description: 'The text for that field',
					},
				],
			},
		],
		routing: { send: { preSend: [sendTemplateData] } },
	};
}

/** 'Data (JSON)' for an Additional Fields collection; read by sendTemplateData, so no routing here. */
export function dataJsonOption(description: string): INodeProperties {
	return {
		displayName: 'Data (JSON)',
		name: 'dataJson',
		type: 'json',
		default: '{}',
		description,
	};
}

/** 'Download File', its binary field name, and 'Simplify' for the JSON answer. */
export function outputProperties(
	target: OperationTarget,
	file: { noun: string; simplify: SimplifyKind },
): INodeProperties[] {
	return [
		{
			displayName: 'Download File',
			name: 'download',
			type: 'boolean',
			default: false,
			description: `Whether to return the ${file.noun} itself as binary data instead of a link to it`,
			displayOptions: showFor(target),
			routing: { send: { preSend: [sendDownloadMode] } },
		},
		{
			displayName: 'Put Output File in Field',
			name: 'binaryPropertyName',
			type: 'string',
			required: true,
			default: 'data',
			description: 'The name of the binary field to put the file in',
			displayOptions: showFor(target, { download: [true] }),
		},
		simplifyProperty(target, file.simplify, { download: [false] }),
	];
}

export function simplifyProperty(
	target: OperationTarget,
	kind: SimplifyKind,
	extraShow: IDisplayOptions['show'] = {},
): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: false,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: showFor(target, extraShow),
		routing: { output: { postReceive: [simplifyResponse(kind)] } },
	};
}
