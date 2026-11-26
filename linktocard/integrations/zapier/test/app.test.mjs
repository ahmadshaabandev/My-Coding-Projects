// The app definition as Zapier will see it: schema-valid offline, every visible action complete
// (label, description, sample, labelled outputs), unique field keys, and a package that the CLI
// accepts (exact core version, changelog entry for promote, a .gitignore for source.zip).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, TEMPLATES, appTester, authData, nock, require, BASE } from './helpers.mjs';

const schemaTools = require('zapier-platform-core/src/tools/schema');
const CreateSchema = require('zapier-platform-schema/lib/schemas/CreateSchema');
const SearchSchema = require('zapier-platform-schema/lib/schemas/SearchSchema');
const { PDF_STARTER_TEMPLATES } = require('../lib/constants');
const { batchRowFields, pdfDataFields } = require('../lib/fields');
const pkg = require('../package.json');

const packageFile = (name) => new URL(`../${name}`, import.meta.url);
const serialized = schemaTools.serializeApp(schemaTools.prepareApp(App));
const actions = [
  ...Object.values(serialized.creates).map((action) => ({ kind: 'create', schema: CreateSchema, action })),
  ...Object.values(serialized.searches).map((action) => ({ kind: 'search', schema: SearchSchema, action })),
];

describe('schema', () => {
  it('the whole app validates offline with zapier-platform-schema', () => {
    expect(schemaTools.validateApp(schemaTools.prepareApp(App))).toEqual([]);
  });

  it.each(actions.map((entry) => [entry.action.key, entry]))('%s validates on its own (this also requires a sample)', (_key, { schema, action }) => {
    expect(schema.validate(action).errors.map((error) => error.stack)).toEqual([]);
  });

  it('the per-action check really catches a missing sample', () => {
    const copy = JSON.parse(JSON.stringify(serialized.creates.create_pdf));
    delete copy.operation.sample;
    expect(CreateSchema.validate(copy).errors.map((error) => error.message).join(' ')).toMatch(/requires "sample"/);
  });

  it('has exactly the six actions and no trigger', () => {
    expect(Object.keys(App.creates).sort()).toEqual(['card_from_link', 'create_card_image', 'create_pdf', 'start_bulk_pdfs']);
    expect(Object.keys(App.searches).sort()).toEqual(['check_link_preview', 'get_batch']);
    expect(App.triggers).toEqual({});
  });
});

describe('every action', () => {
  const all = [...Object.values(App.creates), ...Object.values(App.searches)];

  it.each(all.map((action) => [action.key, action]))('%s is visible, described and has a sample', (_key, action) => {
    expect(action.display.hidden).toBeUndefined();
    expect(action.display.label.length).toBeGreaterThanOrEqual(2);
    expect(action.display.label.length).toBeLessThanOrEqual(64);
    expect(action.display.description.length).toBeLessThanOrEqual(1000);
    expect(Object.keys(action.operation.sample).length).toBeGreaterThan(0);
  });

  it.each(all.map((action) => [action.key, action]))('%s labels every output field, once per key', (_key, action) => {
    const keys = action.operation.outputFields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of action.operation.outputFields) expect(field.label, field.key).toBeTruthy();
  });

  it.each(all.map((action) => [action.key, action]))("%s's sample has every top-level output field", (_key, action) => {
    for (const field of action.operation.outputFields) {
      const top = field.key.split('__')[0];
      expect(action.operation.sample, field.key).toHaveProperty(top);
    }
  });
});

/** Static input keys of an action, plus the keys of children. */
function staticKeys(action) {
  return action.operation.inputFields
    .filter((field) => typeof field !== 'function')
    .flatMap((field) => [field.key, ...(field.children || []).map((child) => child.key)]);
}

/** Dynamic fields with their children flattened. */
const flatKeys = (fields) => fields.flatMap((field) => [field.key, ...(field.children || []).map((child) => child.key)]);

describe('dynamic fields never collide with the static ones (Zapier needs unique keys, children included)', () => {
  it.each(PDF_STARTER_TEMPLATES.map((template) => [template.id]))('Create PDF with %s', (id) => {
    const keys = [...staticKeys(App.creates.create_pdf), ...flatKeys(pdfDataFields(null, { inputData: { template: id } }))];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(PDF_STARTER_TEMPLATES.flatMap((template) => [[template.id, 'true'], [template.id, 'false']]))('Start Bulk PDFs with %s, verify %s', (id, verify) => {
    const keys = [...staticKeys(App.creates.start_bulk_pdfs), ...flatKeys(batchRowFields(null, { inputData: { template: id, verify } }))];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('Create Card Image with a starter template', async () => {
    nock(BASE).get('/v1/templates').reply(200, TEMPLATES);
    const fields = await appTester(App.creates.create_card_image.operation.inputFields[1], { authData, inputData: { template: 'blog' } });
    expect(fields.length).toBeGreaterThan(0);
    const keys = [...staticKeys(App.creates.create_card_image), ...flatKeys(fields)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('package', () => {
  it('pins zapier-platform-core to the exact installed version (the CLI refuses ranges)', () => {
    expect(pkg.dependencies['zapier-platform-core']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['zapier-platform-core']).toBe(require('zapier-platform-core').version);
    expect(App.platformVersion).toBe(pkg.dependencies['zapier-platform-core']);
    expect(App.version).toBe(pkg.version);
  });

  it('pins every dev dependency exactly too', () => {
    for (const [name, version] of Object.entries(pkg.devDependencies)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has a CHANGELOG.md entry for this version, read by the CLI the way promote reads it', async () => {
    const { getVersionChangelog } = require('zapier-platform-cli/src/utils/changelog');
    const { changelog } = await getVersionChangelog(pkg.version, new URL('..', import.meta.url).pathname);
    expect(changelog).toMatch(/create_card_image/);
  });

  it('keeps node_modules, builds and .env files out of the uploaded source.zip', () => {
    const ignored = readFileSync(packageFile('.gitignore'), 'utf8').split('\n').map((line) => line.trim());
    for (const entry of ['node_modules/', 'build/', '.env', '.env.*', '*.zip']) expect(ignored, entry).toContain(entry);
    expect(existsSync(packageFile('.env'))).toBe(false);
  });

  it('installs no other payment provider and no headless browser', () => {
    const forbidden = /stripe|lemon[\s_.-]?squeezy|puppeteer|playwright|chrome-aws-lambda|@sparticuz\/chromium/i;
    const lock = JSON.parse(readFileSync(packageFile('package-lock.json'), 'utf8'));
    const installed = Object.keys(lock.packages).filter(Boolean).map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(installed.length).toBeGreaterThan(50);
    expect(installed.filter((name) => forbidden.test(name))).toEqual([]);
  });
});
