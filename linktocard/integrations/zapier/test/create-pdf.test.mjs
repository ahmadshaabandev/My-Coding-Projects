// Create PDF: POST /v1/pdf from a PDF starter (fields and line items), one of your own templates
// (Data and Line items (JSON)) or your own HTML.
import { describe, expect, it } from 'vitest';
import { App, BASE, TEMPLATES, USAGE, api, apiError, appError, appTester, authData, hydratePointer } from './helpers.mjs';

const action = App.creates.create_pdf;
const field = (key) => action.operation.inputFields.find((input) => typeof input !== 'function' && input.key === key);
const dynamicFields = action.operation.inputFields.find((input) => typeof input === 'function');

const PDF = {
  id: 'p'.repeat(64),
  url: `${BASE}/i/u_test/${'p'.repeat(64)}.pdf`,
  pages: 1,
  bytes: 5000,
  credits_used: 2,
  cached: false,
  template: 'invoice',
  filename: 'invoice-7.pdf',
  created_at: '2026-11-26T09:00:00.000Z',
  expires_at: '2026-12-26T09:00:00.000Z',
  warnings: [],
  usage: USAGE,
};

const run = (inputData) => appTester(action.operation.perform, { authData, inputData });

describe('Create PDF form', () => {
  it('lists the five PDF starters, then your own templates', async () => {
    api().get('/v1/templates').reply(200, TEMPLATES);
    const { results, paging_token } = await appTester(field('template').choices.perform, { authData, meta: {} });
    expect(results.map((choice) => choice.id)).toEqual(['invoice', 'receipt', 'quote', 'certificate', 'report', 't_launch01']);
    expect(results[0]).toEqual({ id: 'invoice', label: 'Invoice (starter)' });
    expect(results[5]).toEqual({ id: 't_launch01', label: 'Launch banner' });
    expect(paging_token).toBeNull();
  });

  it("shows a starter's fields, with its list as line items", async () => {
    const fields = await appTester(dynamicFields, { authData, inputData: { template: 'invoice' } });
    expect(fields.find((input) => input.key === 'data__seller_name')).toEqual({ key: 'data__seller_name', label: 'Seller name', required: true, type: 'string' });
    expect(fields.find((input) => input.key === 'data__seller_address')).toMatchObject({ type: 'text' });
    expect(fields.find((input) => input.key === 'items')).toEqual({
      key: 'items',
      label: 'Line items',
      required: true,
      children: [
        { key: 'item__description', label: 'Description' },
        { key: 'item__quantity', label: 'Quantity' },
        { key: 'item__unit_price', label: 'Unit price' },
        { key: 'item__amount', label: 'Amount' },
      ],
    });
    expect(fields.some((input) => input.key === 'items_json')).toBe(false);
  });

  it('offers Line items (JSON) for your own templates and for HTML', async () => {
    for (const inputData of [{ template: 't_launch01' }, { html: '<p>Hi</p>' }]) {
      const fields = await appTester(dynamicFields, { authData, inputData });
      expect(fields.map((input) => input.key)).toEqual(['items_json']);
    }
  });

  it('names the page defaults in the help text', () => {
    expect(field('page_format').choices.map((choice) => choice.value)).toEqual(['a4', 'letter', 'a5']);
    expect(field('page_format').helpText).toBe("Leave empty for the template's own page size (A4 when it has none).");
    expect(field('landscape').type).toBe('boolean');
  });
});

describe('Create PDF', () => {
  it('sends a starter with its fields, line items, file name and page setup', async () => {
    const scope = api()
      .post('/v1/pdf', {
        template: 'invoice',
        data: {
          seller_name: 'Fernhill Studio',
          total: 1200,
          notes: 'Thank you',
          items: [
            { description: 'Design', quantity: '1', amount: '1,200.00' },
            { description: 'Hosting', amount: '0.00' },
          ],
        },
        filename: 'invoice-7.pdf',
        pdf: { format: 'letter', landscape: false },
      })
      .reply(200, PDF);
    const result = await run({
      template: 'invoice',
      data__seller_name: 'Fernhill Studio',
      data__total: 1200,
      data: { notes: 'Thank you' },
      items: [
        { item__description: 'Design', item__quantity: '1', item__amount: '1,200.00' },
        { item__description: 'Hosting', item__quantity: '', item__amount: '0.00' },
        { item__description: '', item__quantity: '' },
      ],
      filename: 'invoice-7.pdf',
      page_format: 'letter',
      landscape: 'false',
    });
    expect(scope.isDone()).toBe(true);
    expect(result).toMatchObject({ url: PDF.url, pages: 1, credits_used: 2 });
    expect(hydratePointer(result.file)).toMatchObject({ method: 'hydrators.downloadFile', bundle: { url: PDF.url } });
  });

  it('sends HTML and CSS instead of a template, with Line items (JSON)', async () => {
    const scope = api()
      .post('/v1/pdf', { html: '<h1>{{title}}</h1>', css: 'h1 { color: red; }', data: { title: 'Hello', items: [{ name: 'A' }] } })
      .reply(200, { ...PDF, template: 'inline' });
    await run({ html: '<h1>{{title}}</h1>', css: 'h1 { color: red; }', data: { title: 'Hello' }, items_json: '[{"name": "A"}]' });
    expect(scope.isDone()).toBe(true);
  });

  it('sends only what is filled in', async () => {
    const scope = api().post('/v1/pdf', { template: 't_launch01', data: {} }).reply(200, PDF);
    await run({ template: 't_launch01', filename: '', page_format: '', landscape: '' });
    expect(scope.isDone()).toBe(true);
  });

  it.each([
    ['a template and HTML', { template: 'invoice', html: '<p>x</p>' }, 'Pick a Template or fill in HTML (one of the two).'],
    ['neither', {}, 'Pick a Template or fill in HTML (one of the two).'],
    ['CSS with a template', { template: 'invoice', css: 'p {}' }, 'CSS can only be used together with HTML.'],
    [
      'line items and JSON',
      { template: 'invoice', items: [{ item__description: 'A' }], items_json: '[{"description": "B"}]' },
      'Fill in the line items or Line items (JSON), not both.',
    ],
    ['JSON that does not parse', { html: '<p>x</p>', items_json: '[{' }, /^Line items \(JSON\) is not valid JSON\./],
    ['JSON that is not a list', { html: '<p>x</p>', items_json: '{"a": 1}' }, 'Line items (JSON) must be a JSON list of objects, starting with [.'],
    ['a landscape that is not true or false', { template: 'invoice', landscape: 'sideways' }, 'Landscape must be true or false.'],
  ])('refuses %s before sending anything', async (_what, inputData, message) => {
    const error = await appError(run(inputData));
    expect(error.code).toBe('invalid_request');
    if (message instanceof RegExp) expect(error.message).toMatch(message);
    else expect(error.message).toBe(message);
  });

  it("shows the API's message for a PDF error", async () => {
    api().post('/v1/pdf').reply(422, apiError('template_error', 'The document has more pages than a PDF may have.'));
    const error = await appError(run({ template: 'report' }));
    expect(error).toMatchObject({ code: 'template_error', status: 422, message: 'The document has more pages than a PDF may have.' });
  });
});
