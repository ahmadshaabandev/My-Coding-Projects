// Why lib/api.js serializes bodies itself: Zapier core strips {{...}} from top-level strings of an
// object body, and from query values. The tests pin both core behaviours down (a core upgrade
// that changes them shows up here) and show that postJson delivers such values intact.
import { describe, expect, it } from 'vitest';
import { BASE, api, appTester, authData, require } from './helpers.mjs';

const { getJson, postJson } = require('../lib/api');

/** Records the raw body of one POST to `path`. */
function captureBody(path) {
  const seen = {};
  api()
    .post(path, (body) => {
      seen.body = body;
      return true;
    })
    .reply(200, {});
  return seen;
}

describe('Zapier core and {{curly braces}}', () => {
  it('core empties {{...}} in top-level strings of an object body (the reason for postJson)', async () => {
    const seen = captureBody('/v1/batches');
    await appTester(
      (z) => z.request({ url: `${BASE}/v1/batches`, method: 'POST', body: { filename: 'certificate-{{recipient_name}}.pdf', data: { html: '{{kept}}' } } }),
      { authData },
    );
    expect(seen.body).toEqual({ filename: 'certificate-.pdf', data: { html: '{{kept}}' } });
  });

  it('postJson sends them as written, as JSON', async () => {
    let contentType;
    const seen = {};
    api()
      .post('/v1/batches', (body) => {
        seen.body = body;
        return true;
      })
      .reply(function reply() {
        contentType = this.req.headers['content-type'];
        return [202, { id: 'bat_1' }];
      });
    const response = await appTester((z) => postJson(z, '/v1/batches', { filename: 'certificate-{{recipient_name}}.pdf', html: '<h1>{{title}}</h1>' }), { authData });
    expect(seen.body).toEqual({ filename: 'certificate-{{recipient_name}}.pdf', html: '<h1>{{title}}</h1>' });
    expect(contentType).toMatch(/^application\/json/);
    expect(response.data).toEqual({ id: 'bat_1' });
  });

  it('getJson sends query values with & and + intact', async () => {
    const page = 'https://example.com/a?b=1+2&c=d';
    const scope = api().get('/v1/inspect').query({ url: page }).reply(200, { ok: true });
    const response = await appTester((z) => getJson(z, '/v1/inspect', { url: page }), { authData });
    expect(scope.isDone()).toBe(true);
    expect(response.data).toEqual({ ok: true });
  });

  it('core still empties {{...}} in query values, however they are encoded (a known limit of GET)', async () => {
    const scope = api().get('/v1/inspect').query({ url: 'https://example.com/a?q=' }).reply(200, { ok: true });
    await appTester((z) => z.request({ url: `${BASE}/v1/inspect?url=${encodeURIComponent('https://example.com/a?q={{x}}')}` }), { authData });
    expect(scope.isDone()).toBe(true);
  });
});
