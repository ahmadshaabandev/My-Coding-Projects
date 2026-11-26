import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * An API key from the Link To Card dashboard, sent as "Authorization: Bearer ltc_...".
 *
 * The base URL is a field so the same node can be pointed at a staging deployment or at a local
 * `wrangler dev` while testing; everyone else keeps the default.
 */
export class LinkToCardApi implements ICredentialType {
	name = 'linkToCardApi';

	displayName = 'Link To Card API';

	icon: Icon = { light: 'file:../icons/linktocard.svg', dark: 'file:../icons/linktocard.dark.svg' };

	documentationUrl = 'https://linktocard.com/docs/api#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'e.g. ltc_...',
			description: 'An API key from the API keys section of your Link To Card dashboard',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'https://linktocard.com',
			description: 'Leave as is unless you test against another Link To Card deployment',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/** GET /v1/usage needs a valid key and never counts against the allowance. */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/usage',
			method: 'GET',
		},
	};
}
