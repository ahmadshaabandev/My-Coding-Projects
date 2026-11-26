import type { INodeProperties } from 'n8n-workflow';
import { PDF_PAGE_FORMAT_OPTIONS } from '../shared/options';
import { omitEmptyText } from '../shared/presend';
import {
	dataJsonOption,
	fileOutput,
	outputProperties,
	showFor,
	templateFieldsProperty,
	templateSourceProperties,
	type OperationTarget,
} from './common';

/** PDF > Create: POST /v1/pdf (operation createPdf in the service's openapi.yaml). */
const create: OperationTarget = { resource: 'pdf', operation: 'create' };

export const pdfOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['pdf'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create PDF',
				description: 'Render a PDF document from a template, or get the stored one if it was made before',
				routing: {
					request: { method: 'POST', url: '/v1/pdf' },
					output: fileOutput('pdf'),
				},
			},
		],
		default: 'create',
	},
];

export const pdfFields: INodeProperties[] = [
	...templateSourceProperties(create, {
		placeholder: 'e.g. invoice',
		description: 'ID of a PDF starter template, such as invoice, or of one of your saved templates (t_...)',
	}),
	templateFieldsProperty(create, {
		displayName: 'Template Fields',
		description: "Values for the template's {{field}} placeholders. Lists such as invoice items go in 'Data (JSON)'.",
	}),
	...outputProperties(create, { noun: 'PDF file', simplify: 'pdf' }),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		routing: { send: { preSend: [omitEmptyText(['filename', 'pdf.header', 'pdf.footer'])] } },
		displayOptions: showFor(create),
		options: [
			dataJsonOption(
				"Template data as one JSON object, including lists such as \"items\" and numbers. Entries in 'Template Fields' are applied on top.",
			),
			{
				displayName: 'File Name',
				name: 'filename',
				type: 'string',
				default: '',
				placeholder: 'e.g. invoice-2026-0142.pdf',
				description: 'Download name of the PDF',
				routing: { send: { type: 'body', property: 'filename' } },
			},
			{
				displayName: 'Footer HTML',
				name: 'footer',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description:
					'HTML printed at the bottom of every page. Style it inline. &lt;span class="pageNumber"&gt;&lt;/span&gt; and &lt;span class="totalPages"&gt;&lt;/span&gt; print page numbers.',
				routing: { send: { type: 'body', property: 'pdf.footer' } },
			},
			{
				displayName: 'Header HTML',
				name: 'header',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'HTML printed at the top of every page. Style it inline.',
				routing: { send: { type: 'body', property: 'pdf.header' } },
			},
			{
				displayName: 'Landscape',
				name: 'landscape',
				type: 'boolean',
				default: false,
				description: 'Whether to print the pages in landscape orientation',
				routing: { send: { type: 'body', property: 'pdf.landscape' } },
			},
			{
				displayName: 'Page Format',
				name: 'pageFormat',
				type: 'options',
				options: PDF_PAGE_FORMAT_OPTIONS,
				default: 'a4',
				description: 'Paper size of the pages',
				routing: { send: { type: 'body', property: 'pdf.format' } },
			},
		],
	},
];
