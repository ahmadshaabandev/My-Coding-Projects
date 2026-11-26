import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import codex from '../nodes/LinkToCard/LinkToCard.node.json';
import { LinkToCardApi } from '../credentials/LinkToCardApi.credentials';
import { LinkToCard } from '../nodes/LinkToCard/LinkToCard.node';
import { description } from './helpers';

/*
 * The package rules n8n's linter and verification check (n8n-nodes-starter package.json,
 * @n8n/eslint-plugin-community-nodes 0.42.0, docs.n8n.io verification guidelines), kept as tests
 * so a change that would fail the scanner fails here first, plus Link To Card's own rule that no
 * headless-browser package is ever added.
 */

/** Categories the codex may use (docs.n8n.io codex-files page and the valid-node-categories rule). */
const ALLOWED_CATEGORIES = [
	'Data & Storage',
	'Finance & Accounting',
	'Marketing & Content',
	'Productivity',
	'Miscellaneous',
	'Sales',
	'Development',
	'Analytics',
	'Communication',
	'Utility',
];

const manifest = pkg as typeof pkg & { dependencies?: Record<string, string>; overrides?: unknown };

describe('package.json', () => {
	it('is a community node package under the MIT license', () => {
		expect(manifest.name).toBe('n8n-nodes-linktocard');
		expect(manifest.keywords).toContain('n8n-community-node-package');
		expect(manifest.license).toBe('MIT');
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(manifest.description.length).toBeGreaterThan(20);
		expect(manifest.author.name).not.toBe('');
		expect(manifest.author.email).toMatch(/@/);
		expect(manifest.repository.url).toMatch(/^https:\/\/github\.com\/[^/]+\/n8n-nodes-linktocard\.git$/);
	});

	it('has no runtime dependencies and only n8n-workflow as a peer', () => {
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.overrides).toBeUndefined();
		expect(manifest.peerDependencies).toEqual({ 'n8n-workflow': '*' });
	});

	it('has no install-time lifecycle scripts and guards npm publish', () => {
		const forbidden = ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'postprepare'];
		expect(Object.keys(manifest.scripts).filter((name) => forbidden.includes(name))).toEqual([]);
		expect(manifest.scripts.prepublishOnly).toBe('n8n-node prerelease');
		expect(manifest.scripts.build).toBe('n8n-node build');
		expect(manifest.scripts.lint).toBe('n8n-node lint');
	});

	it('publishes only dist and registers the node and the credential there', () => {
		expect(manifest.files).toEqual(['dist']);
		expect(manifest.n8n).toEqual({
			n8nNodesApiVersion: 1,
			strict: true,
			credentials: ['dist/credentials/LinkToCardApi.credentials.js'],
			nodes: ['dist/nodes/LinkToCard/LinkToCard.node.js'],
		});
		// Each registered file exports a class named after it (class-name-matches-filename).
		expect(LinkToCard.name).toBe('LinkToCard');
		expect(LinkToCardApi.name).toBe('LinkToCardApi');
	});

	it('pulls in no headless browser and no payment processor, even for development', () => {
		const names = Object.keys({ ...manifest.devDependencies, ...manifest.peerDependencies });
		expect(names.filter((name) => /puppeteer|playwright|chrom|stripe|lemon[\s_.-]?squeezy/i.test(name))).toEqual([]);
	});
});

describe('codex (LinkToCard.node.json)', () => {
	it('names the node as <package>.<node name> at the node version', () => {
		expect(codex.node).toBe(`${pkg.name}.${description.name}`);
		expect(codex.nodeVersion).toBe(`${description.version}.0`);
		expect(codex.codexVersion).toBe('1.0');
	});

	it('uses allowed categories and full documentation URLs', () => {
		expect(codex.categories.length).toBeGreaterThan(0);
		for (const category of codex.categories) expect(ALLOWED_CATEGORIES).toContain(category);
		const urls = [...codex.resources.primaryDocumentation, ...codex.resources.credentialDocumentation].map((entry) => entry.url);
		for (const url of urls) expect(url).toMatch(/^https:\/\/linktocard\.com\/docs\//);
	});
});
