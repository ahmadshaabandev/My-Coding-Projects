import { defineConfig } from 'vitest/config';

// Unit tests of the node and credential descriptions, in plain Node. Kept outside nodes/ and
// credentials/ so they are never built into dist/ or published.
export default defineConfig({
	resolve: {
		// n8n loads community nodes as CommonJS, so the tests use n8n-workflow's CommonJS build too.
		alias: { 'n8n-workflow': new URL('./node_modules/n8n-workflow/dist/cjs/index.js', import.meta.url).pathname },
	},
	test: {
		include: ['test/**/*.test.ts'],
		server: { deps: { external: [/node_modules\/n8n-workflow\//] } },
	},
});
