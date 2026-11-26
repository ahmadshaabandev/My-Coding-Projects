import type { INodeProperties } from 'n8n-workflow';
import { PDF_PAGE_FORMAT_OPTIONS } from '../shared/options';
import { omitEmptyText, sendBatchIdInPath, sendBatchRows } from '../shared/presend';
import { fileOutput, showFor, type OperationTarget } from './common';

/**
 * Bulk PDF: POST /v1/batches queues one PDF per row; GET /v1/batches/{id} reports progress, each
 * finished row's link and the batch's ZIP parts; GET /v1/batches/{id}/zip?part=N downloads one
 * part. Rendering happens in the background on Link To Card, so a workflow starts the batch,
 * waits, and then gets it (README: "Bulk PDFs from a sheet"). The API packs the finished PDFs
 * into ZIP parts of at most 500 files and 2 GiB each, in row order; most batches have one part.
 */
const start: OperationTarget = { resource: 'bulk', operation: 'start' };
const downloadZip: OperationTarget = { resource: 'bulk', operation: 'downloadZip' };

export const bulkOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['bulk'] } },
		options: [
			{
				name: 'Download ZIP',
				value: 'downloadZip',
				action: 'Download bulk PDF ZIP',
				description: 'Download the finished PDFs of a batch as a ZIP file, one part at a time',
				// sendBatchIdInPath (on 'Batch ID') completes the path: /v1/batches/{id}/zip.
				routing: { request: { method: 'GET', url: '/v1/batches' }, output: fileOutput('zip') },
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get bulk PDF batch',
				description: 'Retrieve the status of a batch, the link to each finished PDF and its ZIP parts',
				// sendBatchIdInPath (on 'Batch ID') completes the path: /v1/batches/{id}.
				routing: { request: { method: 'GET', url: '/v1/batches' } },
			},
			{
				name: 'Start',
				value: 'start',
				action: 'Start bulk PDF batch',
				description: 'Queue one PDF per row of data; Link To Card renders them in the background',
				routing: { request: { method: 'POST', url: '/v1/batches' } },
			},
		],
		default: 'start',
	},
];

export const bulkFields: INodeProperties[] = [
	{
		displayName: 'Template',
		name: 'template',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. certificate',
		description: 'ID of a PDF starter template, such as certificate, or of one of your saved templates (t_...)',
		displayOptions: showFor(start),
		routing: { send: { type: 'body', property: 'template' } },
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'json',
		required: true,
		default: '[]',
		description:
			'A JSON array with one object of template data per PDF. To use many input items, combine them into one list first, for example with the Aggregate node.',
		displayOptions: showFor(start),
		routing: { send: { preSend: [sendBatchRows] } },
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		routing: { send: { preSend: [omitEmptyText(['filename'])] } },
		displayOptions: showFor(start),
		options: [
			{
				displayName: 'Certificate Verification',
				name: 'verify',
				type: 'boolean',
				default: true,
				description:
					'Whether each PDF gets a certificate ID and a public verification page. When not added, it is on for the certificate template and off for the others.',
				routing: { send: { type: 'body', property: 'verify' } },
			},
			{
				displayName: 'File Name Pattern',
				name: 'filename',
				type: 'string',
				default: '',
				placeholder: 'e.g. {{recipient_name}}.pdf',
				description:
					'Download name of each PDF. {{field}} placeholders take the values of the row, {{n}} the row number. Keep this field in Fixed mode so n8n leaves them to Link To Card. When not added: certificate-1.pdf, certificate-2.pdf, ... (the starter template\'s ID), or document-1.pdf, ... for a saved template.',
				routing: { send: { type: 'body', property: 'filename' } },
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
	{
		displayName: 'Batch ID',
		name: 'batchId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. bat_...',
		description: "The ID returned by 'Start', in its \"ID\" field",
		// One parameter for both: sendBatchIdInPath adds /zip for Download ZIP.
		displayOptions: { show: { resource: ['bulk'], operation: ['get', 'downloadZip'] } },
		routing: { send: { preSend: [sendBatchIdInPath] } },
	},
	{
		displayName: 'ZIP Part',
		name: 'zipPart',
		type: 'number',
		required: true,
		default: 1,
		typeOptions: { minValue: 1, numberPrecision: 0 },
		description:
			"Which part of the batch's ZIP to download, from 1. One part holds up to 500 PDFs; 'Get' lists the parts in its zip_parts field.",
		displayOptions: showFor(downloadZip),
		routing: { send: { type: 'query', property: 'part' } },
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		description: 'The name of the binary field to put the ZIP file in',
		displayOptions: showFor(downloadZip),
	},
];
