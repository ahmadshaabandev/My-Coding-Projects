// Create Card Image: POST /v1/images with a template, its fields and the Data key/value pairs.
import { describe, expect, it } from 'vitest';
import { App, IMAGE, TEMPLATES, api, apiError, appError, appTester, authData, hydratePointer } from './helpers.mjs';

const action = App.creates.create_card_image;
const [templateField, dynamicFields] = action.operation.inputFields;

describe('Create Card Image form', () => {
  it('lists the starter templates, then your own', async () => {
    api().get('/v1/templates').reply(200, TEMPLATES);
    const choices = await appTester(templateField.choices.perform, { authData, meta: {} });
    expect(choices).toEqual({
      results: [
        { id: 'blog', label: 'Blog post (starter)' },
        { id: 't_launch01', label: 'Launch banner' },
      ],
      paging_token: null,
    });
  });

  it("offers one field per field of the chosen starter, with the API's description and example", async () => {
    api().get('/v1/templates').reply(200, TEMPLATES);
    const fields = await appTester(dynamicFields, { authData, inputData: { template: 'blog' } });
    expect(fields).toEqual([
      { key: 'data__title', label: 'Title', required: true, helpText: 'Headline of the article.', placeholder: 'Design for the first glance' },
      {
        key: 'data__description',
        label: 'Description',
        required: false,
        helpText: 'One or two lines under the headline.',
        placeholder: 'What people notice before they read a single word.',
      },
      { key: 'data__theme', label: 'Theme', required: false, helpText: 'light (default) or dark.', placeholder: 'light' },
    ]);
  });

  it('offers no extra fields for your own templates (Data takes their fields)', async () => {
    api().get('/v1/templates').reply(200, TEMPLATES);
    expect(await appTester(dynamicFields, { authData, inputData: { template: 't_launch01' } })).toEqual([]);
  });

  it('asks the API nothing before a template is picked', async () => {
    expect(await appTester(dynamicFields, { authData, inputData: {} })).toEqual([]);
  });

  it('lists the sizes and formats in the API order, with the defaults in the help', () => {
    const size = action.operation.inputFields.find((field) => field.key === 'size');
    const format = action.operation.inputFields.find((field) => field.key === 'format');
    expect(size.choices.map((choice) => choice.value)).toEqual(['og', 'square', 'portrait', 'email']);
    expect(size.choices[0]).toEqual({ value: 'og', sample: 'og', label: 'Open Graph (1200 x 630)' });
    expect(size.helpText).toBe('Leave empty for Open Graph (1200 x 630).');
    expect(format.choices.map((choice) => choice.value)).toEqual(['png', 'jpeg', 'webp']);
    expect(format.helpText).toBe('Leave empty for PNG.');
  });
});

describe('Create Card Image', () => {
  it('sends the template, the fields and Data, and returns the image with a file', async () => {
    const scope = api()
      .post('/v1/images', {
        template: 'blog',
        data: { title: 'From the field', tag: 'News', views: '42', featured: 'true' },
        size: 'square',
        format: 'webp',
      })
      .reply(200, IMAGE);
    const result = await appTester(action.operation.perform, {
      authData,
      inputData: {
        template: ' blog ',
        // The field above wins over the same key in Data; empty values are left out.
        data: { title: 'from data', tag: 'News', views: 42, featured: true, empty: '' },
        data__title: 'From the field',
        data__description: '',
        size: 'square',
        format: 'webp',
      },
    });
    expect(scope.isDone()).toBe(true);
    expect(result).toMatchObject({ id: IMAGE.id, url: IMAGE.url, width: 1200, usage: IMAGE.usage });
    expect(hydratePointer(result.file)).toEqual({ type: 'file', method: 'hydrators.downloadFile', bundle: { url: IMAGE.url } });
  });

  it('leaves size and format out when they are empty, so the API defaults apply', async () => {
    const scope = api().post('/v1/images', { template: 'blog', data: {} }).reply(200, IMAGE);
    await appTester(action.operation.perform, { authData, inputData: { template: 'blog', size: '', format: '' } });
    expect(scope.isDone()).toBe(true);
  });

  it("shows the API's message when the allowance is used up", async () => {
    api().post('/v1/images').reply(402, apiError('quota_exceeded', 'No images are left in this period.'));
    const error = await appError(appTester(action.operation.perform, { authData, inputData: { template: 'blog' } }));
    expect(error).toMatchObject({ name: 'AppError', code: 'quota_exceeded', status: 402, message: 'No images are left in this period.' });
  });

  it('refuses a list or an object as a card value before sending anything', async () => {
    const error = await appError(appTester(action.operation.perform, { authData, inputData: { template: 'blog', data: { tags: ['a', 'b'] } } }));
    expect(error).toMatchObject({ code: 'invalid_request', message: 'Data "tags" must be text, not a list or an object.' });
  });

  it('needs a template', async () => {
    const error = await appError(appTester(action.operation.perform, { authData, inputData: {} }));
    expect(error.message).toBe('Pick a Template.');
  });
});
