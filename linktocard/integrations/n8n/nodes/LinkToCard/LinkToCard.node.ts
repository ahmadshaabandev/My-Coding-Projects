import { NodeConnectionTypes, type INodeType, type INodeTypeDescription } from 'n8n-workflow';
import { bulkFields, bulkOperations } from './descriptions/bulk';
import { imageFields, imageOperations } from './descriptions/image';
import { linkCardFields, linkCardOperations } from './descriptions/linkCard';
import { linkPreviewFields, linkPreviewOperations } from './descriptions/linkPreview';
import { pdfFields, pdfOperations } from './descriptions/pdf';

/**
 * Link To Card in the declarative style: every operation is a request description (method, path,
 * body fields), with small preSend and postReceive hooks in ./shared for what plain routing cannot
 * express. There is no execute() method; n8n's routing engine sends one request per input item.
 */
export class LinkToCard implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Link To Card',
		name: 'linkToCard',
		icon: { light: 'file:../../icons/linktocard.svg', dark: 'file:../../icons/linktocard.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Create card images and PDF documents with Link To Card',
		defaults: { name: 'Link To Card' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'linkToCardApi', required: true }],
		requestDefaults: {
			baseURL: '={{$credentials.baseUrl}}',
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Bulk PDF', value: 'bulk' },
					{ name: 'Image', value: 'image' },
					{ name: 'Link Card', value: 'linkCard' },
					{ name: 'Link Preview', value: 'linkPreview' },
					{ name: 'PDF', value: 'pdf' },
				],
				default: 'image',
			},
			...imageOperations,
			...imageFields,
			...pdfOperations,
			...pdfFields,
			...linkCardOperations,
			...linkCardFields,
			...bulkOperations,
			...bulkFields,
			...linkPreviewOperations,
			...linkPreviewFields,
		],
	};
}
