// Start Bulk PDFs: POST /v1/batches with rows from line items or JSON, a file name pattern,
// certificate verification and the page setup.
import { describe, expect, it } from 'vitest';
import { App, api, apiError, appError, appTester, authData } from './helpers.mjs';

const action = App.creates.start_bulk_pdfs;
const dynamicRows = action.operation.inputFields.find((input) => typeof input === 'function');
const run = (inputData) => appTester(action.operation.perform, { authData, inputData });
const ACCEPTED = {
  id: 'bat_m4q8x2k7v1c9d3e6',
  status: 'queued',
  template: 'certificate',
  verify: true,
  total: 2,
  counts: { queued: 2, running: 0, done: 0, failed: 0, cancelled: 0 },
  pages: 0,
  credits_used: 0,
  created_at: '2026-11-26T09:12:44.031Z',
  started_at: null,
  finished_at: null,
  cancelled_at: null,
  zip_url: 'https://linktocard.com/v1/batches/bat_m4q8x2k7v1c9d3e6/zip',
  zip_parts: [],
};

const rowKeys = async (inputData) => {
  const fields = await appTester(dynamicRows, { authData, inputData });
  return fields.length === 0 ? null : fields[0].children.map((child) => child.key);
};

describe('Start Bulk PDFs form', () => {
  it("offers a starter's text fields as Rows, without the keys verification fills in", async () => {
    // Verification is on by default for the certificate template, so certificate_id is left out.
    expect(await rowKeys({ template: 'certificate' })).toEqual([
      'row__title',
      'row__recipient_name',
      'row__achievement',
      'row__issuer_name',
      'row__date',
      'row__signer_name',
      'row__signer_title',
      'row__logo_url',
    ]);
    expect(await rowKeys({ template: 'certificate', verify: 'true' })).not.toContain('row__certificate_id');
  });

  it('offers certificate_id again when verification is switched off', async () => {
    expect(await rowKeys({ template: 'certificate', verify: false })).toContain('row__certificate_id');
  });

  it('leaves the list of a row (invoice items) to Rows (JSON): Zapier does not nest line items', async () => {
    const keys = await rowKeys({ template: 'invoice' });
    expect(keys).toContain('row__invoice_number');
    expect(keys.some((key) => key.includes('items'))).toBe(false);
  });

  it('offers no Rows fields for your own templates', async () => {
    expect(await rowKeys({ template: 't_launch01' })).toBeNull();
  });
});

describe('Start Bulk PDFs', () => {
  it('sends the line-item rows, the pattern with [key] and [n] turned into placeholders, and the options', async () => {
    const scope = api()
      .post('/v1/batches', {
        template: 'certificate',
        rows: [
          { recipient_name: 'Amara Nwosu', date: 'November 25, 2026' },
          { recipient_name: 'Jonas Berg', date: 'November 25, 2026' },
        ],
        pdf: { format: 'a4', landscape: true },
        filename: 'certificate-{{recipient_name}}-{{n}}.pdf',
        verify: true,
      })
      .reply(202, ACCEPTED);
    const result = await run({
      template: 'certificate',
      rows: [
        { row__recipient_name: 'Amara Nwosu', row__date: 'November 25, 2026', row__signer_name: '' },
        { row__recipient_name: 'Jonas Berg', row__date: 'November 25, 2026' },
        { row__recipient_name: '', row__date: '' },
      ],
      filename: 'certificate-[recipient_name]-[n].pdf',
      verify: 'yes',
      page_format: 'a4',
      landscape: true,
    });
    expect(scope.isDone()).toBe(true);
    expect(result).toEqual(ACCEPTED);
  });

  it('keeps a pattern written with double curly braces as it is', async () => {
    const scope = api().post('/v1/batches', { template: 'report', rows: [{ title: 'Q3' }], filename: 'report-{{n}}.pdf' }).reply(202, ACCEPTED);
    await run({ template: 'report', rows_json: '[{"title": "Q3"}]', filename: 'report-{{n}}.pdf' });
    expect(scope.isDone()).toBe(true);
  });

  it('sends Rows (JSON) as they are, lists inside rows included', async () => {
    const rows = [{ invoice_number: 'INV-1', items: [{ description: 'Design', amount: '1,200.00' }] }];
    const scope = api().post('/v1/batches', { template: 'invoice', rows, verify: false }).reply(202, { ...ACCEPTED, template: 'invoice' });
    await run({ template: 'invoice', rows_json: JSON.stringify(rows), verify: 'false' });
    expect(scope.isDone()).toBe(true);
  });

  it.each([
    ['no rows', { template: 'report' }, 'Add at least one row: map Rows to a list from an earlier step, or fill in Rows (JSON).'],
    ['only empty rows', { template: 'report', rows: [{ row__title: '' }] }, 'Add at least one row: map Rows to a list from an earlier step, or fill in Rows (JSON).'],
    ['rows both ways', { template: 'report', rows: [{ row__title: 'A' }], rows_json: '[{"title": "B"}]' }, 'Fill in Rows or Rows (JSON), not both.'],
    ['rows that are not objects', { template: 'report', rows_json: '["A", "B"]' }, 'Rows (JSON): entry 1 must be an object, like {"name": "Ada"}.'],
    ['a verification value that is not true or false', { template: 'report', rows_json: '[{}]', verify: 'maybe' }, 'Certificate verification must be true or false.'],
    ['no template', { rows_json: '[{}]' }, 'Pick a Template.'],
  ])('refuses %s before sending anything', async (_what, inputData, message) => {
    const error = await appError(run(inputData));
    expect(error).toMatchObject({ code: 'invalid_request', message });
  });

  it("shows the API's message when too many batches are running (409 conflict)", async () => {
    api().post('/v1/batches').reply(409, apiError('conflict', 'Too many batches are waiting or running.'));
    const error = await appError(run({ template: 'report', rows_json: '[{"title": "Q3"}]' }));
    expect(error).toMatchObject({ code: 'conflict', status: 409, message: 'Too many batches are waiting or running.' });
  });

  it.each([
    [403, 'plan_required', 'A batch on the Free plan may have at most 25 rows; this one has 30. The Starter plan takes 500, or split the rows into several batches.'],
    [400, 'invalid_request', 'A batch on the Pro plan may have at most 2,000 rows; this one has 2,001. Split the rows into several batches.'],
    [404, 'not_found', 'No PDF template with this id.'],
    [402, 'quota_exceeded', 'This batch of 3 rows needs at least 6 images.'],
    [503, 'not_configured', 'Bulk documents are not enabled yet.'],
  ])("shows the API's %i %s message as it is", async (status, code, message) => {
    api().post('/v1/batches').reply(status, apiError(code, message));
    const error = await appError(run({ template: 'report', rows_json: '[{"title": "Q3"}]' }));
    expect(error).toMatchObject({ code, message });
  });

  it('describes the same batch fields as Find Batch, without the rows and ZIP', () => {
    const find = App.searches.get_batch.operation.outputFields.map((field) => field.key);
    const keys = action.operation.outputFields.map((field) => field.key);
    expect(keys.every((key) => find.includes(key))).toBe(true);
    expect(keys).not.toContain('rows');
    expect(action.operation.sample).toMatchObject({ status: 'queued', zip_parts: [] });
  });
});
