// Create Card From Link: POST /v1/cards/from-url with the page address and optional template,
// overrides, size and format.
import { describe, expect, it } from 'vitest';
import { App, IMAGE, api, appError, appTester, authData, hydratePointer } from './helpers.mjs';

const action = App.creates.card_from_link;
const run = (inputData) => appTester(action.operation.perform, { authData, inputData });
const LINK = { url: 'https://example.com/post', final_url: 'https://example.com/post', check_id: 'chk_0123456789abcdef', check_cached: false, data: { title: 'Post' } };

describe('Create Card From Link', () => {
  it('sends only the URL when nothing else is filled in, so the API picks the template', async () => {
    const scope = api().post('/v1/cards/from-url', { url: 'https://example.com/post' }).reply(200, { ...IMAGE, link: LINK });
    const result = await run({ url: ' https://example.com/post ', template: '', overrides: {}, size: '', format: '' });
    expect(scope.isDone()).toBe(true);
    expect(result.link).toEqual(LINK);
    expect(hydratePointer(result.file)).toMatchObject({ method: 'hydrators.downloadFile', bundle: { url: IMAGE.url } });
  });

  it('sends the template, overrides, size and format when given', async () => {
    const scope = api()
      .post('/v1/cards/from-url', { url: 'https://example.com/post', template: 'dark', data: { title: 'Shorter' }, size: 'portrait', format: 'jpeg' })
      .reply(200, { ...IMAGE, link: LINK });
    await run({ url: 'https://example.com/post', template: 'dark', overrides: { title: 'Shorter', tag: '' }, size: 'portrait', format: 'jpeg' });
    expect(scope.isDone()).toBe(true);
  });

  it('names the default template in the help text', () => {
    const template = action.operation.inputFields.find((input) => input.key === 'template');
    expect(template.helpText).toContain('`blog` starter template');
  });

  it('needs the page URL', async () => {
    const error = await appError(run({ url: '  ' }));
    expect(error).toMatchObject({ code: 'invalid_request', message: 'Fill in the Page URL.' });
  });
});
