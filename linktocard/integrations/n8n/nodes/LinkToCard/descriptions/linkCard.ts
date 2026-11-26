import type { INodeProperties } from 'n8n-workflow';
import { CARD_SIZE_OPTIONS, IMAGE_FORMAT_OPTIONS } from '../shared/options';
import { omitEmptyText } from '../shared/presend';
import {
	dataJsonOption,
	fileOutput,
	outputProperties,
	showFor,
	templateFieldsProperty,
	type OperationTarget,
} from './common';

/**
 * Link Card > Create From URL: POST /v1/cards/from-url. The service reads the page's title,
 * description, site name and logo and fills a card template with them; fields given here win.
 */
const createFromUrl: OperationTarget = { resource: 'linkCard', operation: 'createFromUrl' };

export const linkCardOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['linkCard'] } },
		options: [
			{
				name: 'Create From URL',
				value: 'createFromUrl',
				action: 'Create link card from URL',
				description: "Make a card image from a web page's own title, description and logo",
				routing: {
					request: { method: 'POST', url: '/v1/cards/from-url' },
					output: fileOutput('image'),
				},
			},
		],
		default: 'createFromUrl',
	},
];

export const linkCardFields: INodeProperties[] = [
	{
		displayName: 'Page URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/blog/launch-week',
		description: 'The https:// address of the page to make the card from',
		displayOptions: showFor(createFromUrl),
		routing: { send: { type: 'body', property: 'url' } },
	},
	templateFieldsProperty(createFromUrl, {
		displayName: 'Override Fields',
		description: 'Template fields to use instead of what the page provides',
	}),
	...outputProperties(createFromUrl, { noun: 'image file', simplify: 'linkCard' }),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		routing: { send: { preSend: [omitEmptyText(['template'])] } },
		displayOptions: showFor(createFromUrl),
		options: [
			dataJsonOption("Overrides as one JSON object. Entries in 'Override Fields' are applied on top."),
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
			{
				displayName: 'Template',
				name: 'template',
				type: 'string',
				default: '',
				placeholder: 'e.g. blog',
				description: "ID of a starter or saved card template. When not set, Link To Card's default card template is used.",
				routing: { send: { type: 'body', property: 'template' } },
			},
		],
	},
];
