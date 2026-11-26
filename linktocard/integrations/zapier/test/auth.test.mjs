// The connection: an API key sent as a bearer token, checked with GET /v1/usage, with a label
// that says which plan (and, off linktocard.com, which host) the connection talks to.
import { describe, expect, it } from 'vitest';
import { API_KEY, App, BASE, USAGE, api, apiError, appError, appTester, authData, require } from './helpers.mjs';

const { connectionLabelFor } = require('../lib/authentication');
const { includeApiKey } = require('../lib/middleware');

describe('authentication', () => {
  it('is an API key in a password field, which Zapier keeps secret', () => {
    expect(App.authentication.type).toBe('custom');
    expect(App.authentication.fields).toHaveLength(1);
    const [field] = App.authentication.fields;
    expect(field).toMatchObject({ key: 'api_key', type: 'password', required: true });
    expect(field.isNoSecret).toBeUndefined();
    expect(App.authentication.connectionLabel).toBe('{{connection_label}}');
  });

  it('tests the key with GET /v1/usage and returns the usage with a label', async () => {
    const scope = api().get('/v1/usage').reply(200, USAGE);
    const result = await appTester(App.authentication.test, { authData });
    expect(scope.isDone()).toBe(true);
    expect(result).toEqual({ ...USAGE, connection_label: 'Starter plan' });
  });

  it('trims spaces pasted around the key', async () => {
    const scope = api().get('/v1/usage').reply(200, USAGE);
    await appTester(App.authentication.test, { authData: { api_key: `  ${API_KEY}\n` } });
    expect(scope.isDone()).toBe(true);
  });

  it("shows the API's own message for a bad key, as an authentication error", async () => {
    api().get('/v1/usage').reply(401, apiError('invalid_api_key', 'This API key is not valid.'));
    const error = await appError(appTester(App.authentication.test, { authData }));
    expect(error).toMatchObject({ name: 'AppError', code: 'AuthenticationError', status: 401 });
    expect(error.message).toMatch(/^This API key is not valid\. Check the API key of this Link To Card connection/);
  });

  it('leaves 429 to Zapier core, which throws a ThrottledError with the Retry-After delay', async () => {
    api().get('/v1/usage').reply(429, apiError('rate_limited', 'Too many requests.'), { 'retry-after': '30' });
    const error = await appError(appTester(App.authentication.test, { authData }));
    expect(error.name).toBe('ThrottledError');
    expect(error.delay).toBe(30);
  });

  it('talks to the LTC_BASE_URL host when it is set, and the label says so', async () => {
    process.env.LTC_BASE_URL = 'https://linktocard-staging.example.workers.dev';
    const scope = api('https://linktocard-staging.example.workers.dev').get('/v1/usage').reply(200, USAGE);
    const result = await appTester(App.authentication.test, { authData });
    expect(scope.isDone()).toBe(true);
    expect(result.connection_label).toBe('Starter plan at linktocard-staging.example.workers.dev');
  });
});

describe('connectionLabelFor', () => {
  it('names the plan', () => {
    expect(connectionLabelFor({ plan: 'free' }, BASE)).toBe('Free plan');
    expect(connectionLabelFor({ plan: 'pro' }, BASE)).toBe('Pro plan');
    expect(connectionLabelFor({}, BASE)).toBe('Link To Card');
  });

  it("adds the key's name once GET /v1/usage returns one", () => {
    expect(connectionLabelFor({ plan: 'pro', key: { name: 'Zapier', prefix: 'ltc_ab12' } }, BASE)).toBe('Zapier (Pro plan)');
    expect(connectionLabelFor({ plan: 'pro', key: { name: '  ' } }, BASE)).toBe('Pro plan');
  });

  it('adds the host when it is not linktocard.com', () => {
    expect(connectionLabelFor({ plan: 'free' }, 'http://localhost:8787')).toBe('Free plan at localhost:8787');
  });
});

describe('includeApiKey', () => {
  const bundle = { authData };

  it('adds the bearer key to API requests and keeps other headers', () => {
    const request = includeApiKey({ url: `${BASE}/v1/images`, headers: { 'X-Other': '1' } }, null, bundle);
    expect(request.headers).toEqual({ 'X-Other': '1', Authorization: `Bearer ${API_KEY}` });
  });

  it('never sends the key to another host', () => {
    for (const url of ['https://example.com/v1/images', 'https://www.linktocard.com/v1/images', 'https://linktocard.com.example/v1']) {
      expect(includeApiKey({ url, headers: {} }, null, bundle).headers).toEqual({});
    }
  });

  it('adds nothing without a key', () => {
    expect(includeApiKey({ url: `${BASE}/v1/usage`, headers: {} }, null, { authData: {} }).headers).toEqual({});
  });
});
