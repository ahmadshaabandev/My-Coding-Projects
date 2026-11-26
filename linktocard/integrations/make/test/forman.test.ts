// Parameters, interfaces and samples through Make's own validator for the parameter format
// ("Forman", @makehq/forman-schema): the samples Make shows before a run fit each interface, the
// inputs a scenario would send fit each module's parameters, and wrong inputs are refused before
// they reach the API. Option lists behind rpc:// are answered by a stub with real-looking values.
import { validateForman, type FormanSchemaField } from '@makehq/forman-schema';
import { describe, expect, it } from 'vitest';
import { connection, moduleById, modules, type Param } from './helpers';

const TEMPLATE_OPTIONS: Record<string, Array<{ label: string; value: string }>> = {
  'rpc://listCardTemplates': [
    { label: 'Blog post', value: 'blog' },
    { label: 'Dark', value: 'dark' },
    { label: 'Spring launch', value: 't_mnd7x9sk3v8bwbmc' },
  ],
  'rpc://listOwnTemplates': [{ label: 'Spring launch', value: 't_mnd7x9sk3v8bwbmc' }],
};
async function resolveRemote(path: string): Promise<unknown> {
  const options = TEMPLATE_OPTIONS[path];
  if (!options) throw new Error(`unexpected remote ${path}`);
  return options;
}

const fields = (list: Param[]): FormanSchemaField[] => list as unknown as FormanSchemaField[];

async function inputErrors(id: string, values: Record<string, unknown>): Promise<string[]> {
  const module = moduleById(id);
  const result = await validateForman(values, fields([...module.staticParams, ...module.mappableParams]), { strict: true, resolveRemote });
  return result.errors.map((error) => `${error.path}: ${error.message}`);
}

describe('samples fit the interface', () => {
  it.each(modules.map((module) => [module.id, module] as const))('%s', async (_id, module) => {
    const result = await validateForman(module.samples, fields(module.interface), { strict: true });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

const VALID: Array<[string, Record<string, unknown>]> = [
  ['createCardImage', { downloadFile: false, template: 'blog', data: [{ key: 'title', value: 'Design for the first glance' }, { key: 'author', value: 'Maya Lindqvist' }], size: 'og', format: 'png' }],
  ['createCardImage', { downloadFile: true, template: 't_mnd7x9sk3v8bwbmc' }],
  [
    'createPdf',
    {
      downloadFile: true,
      template: 'invoice',
      data: {
        seller_name: 'Fernhill Studio',
        buyer_name: 'Okafor & Lund Architects',
        invoice_number: 'INV-2026-0142',
        issue_date: 'Nov 25, 2026',
        items: [{ description: 'Brand strategy workshop', quantity: '2', unit_price: '1,200.00', amount: '2,400.00' }],
        total: '2,400.00',
      },
      filename: 'invoice-INV-2026-0142.pdf',
      pageFormat: 'letter',
    },
  ],
  ['createPdf', { downloadFile: false, template: 'own', ownTemplate: 't_mnd7x9sk3v8bwbmc', fields: [{ key: 'title', value: 'Release notes' }, { key: 'items', value: [{ body: 'Faster exports.' }] }], landscape: true }],
  ['cardFromLink', { downloadFile: false, url: 'https://example.com/blog/launch-week' }],
  ['cardFromLink', { downloadFile: true, url: 'https://example.com/blog/launch-week', template: 'dark', overrides: [{ key: 'tag', value: 'Launch week' }], format: 'webp' }],
  [
    'startBulkPdfs',
    {
      template: 'certificate',
      rows: [
        { title: 'Certificate of Completion', recipient_name: 'Amara Nwosu', achievement: 'for completing the Advanced TypeScript workshop.', issuer_name: 'Lanternworks Training', date: 'November 25, 2026' },
        { title: 'Certificate of Completion', recipient_name: 'Jonas Berg', achievement: 'for completing the Advanced TypeScript workshop.', issuer_name: 'Lanternworks Training', date: 'November 25, 2026' },
      ],
      verify: true,
      filename: 'certificate-[recipient_name].pdf',
    },
  ],
  ['startBulkPdfs', { template: 'own', ownTemplate: 't_mnd7x9sk3v8bwbmc', rows: [{ title: 'A' }, { title: 'B' }], pageFormat: 'a4', landscape: false }],
  ['getBatch', { downloadZip: false, id: 'bat_m4q8x2k7v1c9d3e6' }],
  ['getBatch', { downloadZip: true, id: 'bat_m4q8x2k7v1c9d3e6', zipPart: 2 }],
  ['checkLinkPreview', { url: 'https://example.com/blog/launch-week' }],
  ['makeApiCall', { url: 'v1/usage', method: 'GET' }],
  ['makeApiCall', { url: 'v1/images', method: 'POST', body: { template: 'blog', data: { title: 'Hello' } } }],
];

describe('scenario inputs fit the parameters', () => {
  it.each(VALID)('%s accepts %j', async (id, values) => {
    expect(await inputErrors(id, values)).toEqual([]);
  });
});

/** Module, what is wrong, the input, and the field Forman names in its error. */
const INVALID: Array<[string, string, Record<string, unknown>, string]> = [
  ['createCardImage', 'no template', { downloadFile: false, data: [{ key: 'title', value: 'x' }] }, 'template'],
  ['createCardImage', 'a size the API does not have', { downloadFile: false, template: 'blog', size: 'huge' }, 'size'],
  ['createCardImage', 'a format the API does not have', { downloadFile: false, template: 'blog', format: 'gif' }, 'format'],
  ['createCardImage', 'a field name the API would refuse', { downloadFile: false, template: 'blog', data: [{ key: 'Title', value: 'x' }] }, 'data.0.key'],
  ['createCardImage', 'a template the account does not have', { downloadFile: false, template: 'nope' }, 'template'],
  ['createPdf', 'a PDF starter that does not exist', { downloadFile: true, template: 'letterhead' }, 'template'],
  ['createPdf', 'an own template without picking it', { downloadFile: true, template: 'own' }, 'ownTemplate'],
  ['createPdf', 'a page size the API does not have', { downloadFile: true, template: 'report', data: { title: 'Q3' }, pageFormat: 'legal' }, 'pageFormat'],
  ['createPdf', 'an invoice without its required fields', { downloadFile: true, template: 'invoice', data: { seller_name: 'Fernhill Studio' } }, 'data.'],
  ['cardFromLink', 'no page URL', { downloadFile: false }, 'url'],
  ['startBulkPdfs', 'no rows', { template: 'certificate' }, 'rows'],
  ['startBulkPdfs', 'a certificate ID in a row (the batch makes them)', { template: 'certificate', rows: [{ title: 'T', recipient_name: 'R', achievement: 'A', issuer_name: 'I', date: 'D', certificate_id: 'mine' }] }, 'rows.0'],
  ['getBatch', 'something that is not a batch id', { downloadZip: false, id: 'chk_7q2m9x4k1v8c3d6e' }, 'id'],
  ['getBatch', 'zip part 0 (parts count from 1)', { downloadZip: true, id: 'bat_m4q8x2k7v1c9d3e6', zipPart: 0 }, 'zipPart'],
  ['makeApiCall', 'a URL with a leading slash (the module adds it)', { url: '/v1/usage', method: 'GET' }, 'url'],
];

describe('wrong inputs are refused before they reach the API', () => {
  it.each(INVALID)('%s: %s', async (id, _why, values, field) => {
    const errors = await inputErrors(id, values);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => error.startsWith(`${field}`)), errors.join('\n')).toBe(true);
  });
});

describe('connection parameters', () => {
  const check = async (values: Record<string, unknown>): Promise<boolean> =>
    (await validateForman(values, fields(connection.params), { strict: true })).valid;

  it('accept a Link To Card key and an https address without a path', async () => {
    expect(await check({ apiKey: 'ltc_4f8a2c9e1b7d3a6f0c5e2b9d4a7c1e8f' })).toBe(true);
    expect(await check({ apiKey: 'ltc_4f8a2c9e1b7d3a6f0c5e2b9d4a7c1e8f', apiUrl: 'https://linktocard.com' })).toBe(true);
  });

  it('refuse a missing key, a key from another service, and an address that would break the request URL', async () => {
    expect(await check({})).toBe(false);
    expect(await check({ apiKey: 'sk_live_123' })).toBe(false);
    expect(await check({ apiKey: 'ltc_x', apiUrl: 'https://linktocard.com/' })).toBe(false);
    expect(await check({ apiKey: 'ltc_x', apiUrl: 'http://linktocard.com' })).toBe(false);
    expect(await check({ apiKey: 'ltc_x', apiUrl: 'https://linktocard.com/v1' })).toBe(false);
  });
});
