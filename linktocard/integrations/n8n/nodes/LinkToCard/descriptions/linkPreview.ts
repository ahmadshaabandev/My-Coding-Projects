import type { INodeProperties } from 'n8n-workflow';
import { showFor, simplifyProperty, type OperationTarget } from './common';

/**
 * Link Preview > Check: GET /v1/inspect (docs: linktocard.com/docs/api#get-v1-inspect). Reads one
 * page's Open Graph and Twitter tags and measures its og:image; it never counts as an image.
 */
const check: OperationTarget = { resource: 'linkPreview', operation: 'check' };

export const linkPreviewOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['linkPreview'] } },
		options: [
			{
				name: 'Check',
				value: 'check',
				action: 'Check link preview',
				description: "Check a page's link-preview tags and its og:image, with what to change for each check that does not pass",
				routing: { request: { method: 'GET', url: '/v1/inspect' } },
			},
		],
		default: 'check',
	},
];

export const linkPreviewFields: INodeProperties[] = [
	{
		displayName: 'Page URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/blog/launch-week',
		description: 'The https:// address of the page to check',
		displayOptions: showFor(check),
		routing: { send: { type: 'query', property: 'url' } },
	},
	simplifyProperty(check, 'check'),
];
