// Check Link Preview: GET /v1/inspect?url=..., wrapped in a list (a search) and summarised.
import { describe, expect, it } from 'vitest';
import { App, api, apiError, appError, appTester, authData } from './helpers.mjs';

const action = App.searches.check_link_preview;
const run = (url) => appTester(action.operation.perform, { authData, inputData: { url } });

const CHECK = {
  id: 'chk_0123456789abcdef',
  url: 'https://example.com/post',
  final_url: 'https://example.com/post',
  status: 200,
  cached: true,
  checks: [
    { id: 'og_image', status: 'fail', title: 'og:image is missing', detail: 'The page has no og:image tag.', fix: 'Add an og:image tag.' },
    { id: 'og_description', status: 'warn', title: 'og:description is missing', detail: 'The page has no og:description tag.', fix: null },
    { id: 'og_title', status: 'pass', title: 'og:title is set', detail: 'og:title is 4 characters.', fix: null },
  ],
  preview: { title: 'Post', description: null, domain: 'example.com', site_name: null, image: null, favicon: null },
};

describe('Check Link Preview', () => {
  it('asks the API for the page and adds counts and a list of problems', async () => {
    const scope = api().get('/v1/inspect').query({ url: 'https://example.com/post' }).reply(200, CHECK);
    const results = await run(' https://example.com/post ');
    expect(scope.isDone()).toBe(true);
    expect(results).toEqual([
      {
        ...CHECK,
        pass_count: 1,
        warn_count: 1,
        fail_count: 1,
        ok: false,
        problems: ['og:image is missing: Add an og:image tag.', 'og:description is missing: The page has no og:description tag.'],
      },
    ]);
  });

  it('is ok when nothing failed', async () => {
    api().get('/v1/inspect').query(true).reply(200, { ...CHECK, checks: [CHECK.checks[2]] });
    const [result] = await run('https://example.com/post');
    expect(result).toMatchObject({ ok: true, fail_count: 0, problems: [] });
  });

  it("shows the API's message when the page cannot be read", async () => {
    api().get('/v1/inspect').query(true).reply(422, apiError('page_fetch_failed', 'The page did not answer in time.'));
    expect(await appError(run('https://example.com/slow'))).toMatchObject({ code: 'page_fetch_failed', status: 422, message: 'The page did not answer in time.' });
  });

  it('needs a URL', async () => {
    expect(await appError(run(''))).toMatchObject({ code: 'invalid_request', message: 'Fill in the Page URL.' });
  });
});
