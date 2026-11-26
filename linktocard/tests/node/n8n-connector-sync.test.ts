// integrations/n8n is published on its own (npm package n8n-nodes-linktocard), so it cannot import
// src/config.ts and lists the API's fixed choices itself. This test fails when the service and the
// node drift apart, and keeps the node's lock file free of the packages the service never ships.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORMATS, PDF, SIZES } from '../../src/config';

const packageDir = fileURLToPath(new URL('../../integrations/n8n/', import.meta.url));
const optionsSource = readFileSync(path.join(packageDir, 'nodes/LinkToCard/shared/options.ts'), 'utf8');

/** The { name, value } pairs of one exported option list in options.ts. */
function optionList(constName: string): Array<{ name: string; value: string }> {
  const block = new RegExp(`export const ${constName}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(optionsSource);
  expect(block, constName).not.toBeNull();
  return [...block![1]!.matchAll(/\{\s*name:\s*'([^']+)',\s*value:\s*'([^']+)'\s*\}/g)].map((entry) => ({
    name: entry[1]!,
    value: entry[2]!,
  }));
}

describe('integrations/n8n lists the choices src/config.ts defines', () => {
  it('card sizes, with their pixel sizes in the label', () => {
    const options = optionList('CARD_SIZE_OPTIONS');
    expect(options.map((option) => option.value)).toEqual(Object.keys(SIZES));
    for (const option of options) {
      const size = SIZES[option.value as keyof typeof SIZES];
      expect(option.name).toContain(`${size.width}×${size.height}`);
    }
  });

  it('image formats', () => {
    expect(optionList('IMAGE_FORMAT_OPTIONS').map((option) => option.value)).toEqual([...FORMATS]);
  });

  it('PDF page formats', () => {
    expect(optionList('PDF_PAGE_FORMAT_OPTIONS').map((option) => option.value)).toEqual([...PDF.formats]);
  });
});

describe('integrations/n8n dependencies', () => {
  const FORBIDDEN = /stripe|lemon[\s_.-]?squeezy|puppeteer|playwright|chrome-aws-lambda|@sparticuz\/chromium/i;

  it('package.json has no runtime dependencies and names no forbidden package', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    const named = Object.keys({ ...(manifest.devDependencies as object), ...(manifest.peerDependencies as object) });
    expect(named.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });

  it('package-lock.json installs no forbidden package', () => {
    const lockPath = path.join(packageDir, 'package-lock.json');
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, { dependencies?: object; devDependencies?: object; optionalDependencies?: object }>;
    };
    const installed = Object.keys(lock.packages)
      .filter((key) => key !== '')
      .map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(installed.length).toBeGreaterThan(50);
    expect(installed.filter((name) => FORBIDDEN.test(name))).toEqual([]);
    const declared = Object.values(lock.packages).flatMap((entry) =>
      Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }),
    );
    expect(declared.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});
