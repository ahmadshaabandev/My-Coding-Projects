import type { INodeProperties } from 'n8n-workflow';
import { CARD_SIZE_OPTIONS, IMAGE_FORMAT_OPTIONS } from '../shared/options';
import {
	dataJsonOption,
	fileOutput,
	outputProperties,
	showFor,
	templateFieldsProperty,
	templateSourceProperties,
	type OperationTarget,
} from './common';

/** Image > Create: POST /v1/images (docs: linktocard.com/docs/api#post-v1-images). */
const create: OperationTarget = { resource: 'image', operation: 'create' };

export const imageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['image'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create image',
				description: 'Render a card image from a template, or get the stored one if it was made before',
				routing: {
					request: { method: 'POST', url: '/v1/images' },
					output: fileOutput('image'),
				},
			},
		],
		default: 'create',
	},
];

export const imageFields: INodeProperties[] = [
	...templateSourceProperties(create, {
		placeholder: 'e.g. blog',
		description: 'ID of a starter template, such as blog, or of one of your saved templates (t_...)',
	}),
	templateFieldsProperty(create, {
		displayName: 'Template Fields',
		description: "Values for the template's {{field}} placeholders",
	}),
	...outputProperties(create, { noun: 'image file', simplify: 'image' }),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showFor(create),
		options: [
			dataJsonOption("Template data as one JSON object. Entries in 'Template Fields' are applied on top."),
			{
				displayName: 'Format',
				name: 'format',
				type: 'options',
				options: IMAGE_FORMAT_OPTIONS,
				default: 'png',
				description: 'File format of the image',
				routing: { send: { type: 'body', property: 'format' } },
			},
			{
				displayName: 'Size',
				name: 'size',
				type: 'options',
				options: CARD_SIZE_OPTIONS,
				default: 'og',
				description: 'Width and height of the image',
				routing: { send: { type: 'body', property: 'size' } },
			},
		],
	},
];
