// Error mapping: the API's own message reaches the user; anything that is not the API's envelope
// gets a plain sentence; requests that read the status themselves are left alone.
import { describe, expect, it } from 'vitest';
import { App, BASE, api, apiError, appError, appTester, authData, nock, require, zapier } from './helpers.mjs';

const { describeApiError, handleErrors } = require('../lib/middleware');
const z = { errors: zapier.errors };
const response = (status, data, url = `${BASE}/v1/images`, extra = {}) => ({ status, data, request: { url }, ...extra });

describe('describeApiError', () => {
  it("uses the envelope's code and message", () => {
    expect(describeApiError(response(503, apiError('not_configured', 'Link cards are not enabled yet.')))).toEqual({
      code: 'not_configured',
      message: 'Link cards are not enabled yet.',
    });
  });

  it('falls back to the status for anything else', () => {
    for (const data of [undefined, null, 'Bad gateway', { error: 'x' }, { error: { message: '' } }]) {
      expect(describeApiError(response(502, data))).toEqual({ code: 'http_502', message: 'Link To Card answered with HTTP 502.' });
    }
  });

  it('never reads the body of a streamed (raw) download, and explains a missing file', () => {
    const raw = (status) => {
      const response = { status, request: { url: `${BASE}/i/x.png`, raw: true } };
      Object.defineProperty(response, 'data', {
        get() {
          throw new Error('read');
        },
      });
      return response;
    };
    expect(describeApiError(raw(404))).toEqual({
      code: 'not_found',
      message: "The file was not found. Files are stored for the plan's storage time: run the step that made it again for a new one.",
    });
    expect(describeApiError(raw(500))).toEqual({ code: 'http_500', message: 'Link To Card answered with HTTP 500.' });
  });
});

describe('handleErrors', () => {
  it('passes successful responses and those that asked to see every status', () => {
    const ok = response(200, {});
    expect(handleErrors(ok, z)).toBe(ok);
    const skipped = response(404, apiError('not_found', 'No batch.'), `${BASE}/v1/batches/x`, { skipThrowForStatus: true });
    expect(handleErrors(skipped, z)).toBe(skipped);
  });

  it("leaves other hosts' errors to Zapier core", () => {
    const other = response(500, {}, 'https://example.com/x');
    expect(handleErrors(other, z)).toBe(other);
  });

  it('throws an AppError with the code and status of the API', () => {
    let thrown;
    try {
      handleErrors(response(409, apiError('conflict', 'Too many batches are waiting or running.')), z);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.name).toBe('AppError');
    expect(JSON.parse(thrown.message)).toEqual({ message: 'Too many batches are waiting or running.', code: 'conflict', status: 409 });
  });
});

describe('through a real action', () => {
  it('a switched-off feature shows the API message (503 not_configured)', async () => {
    api().post('/v1/cards/from-url').reply(503, apiError('not_configured', 'Link cards are not enabled yet.'));
    const error = await appError(appTester(App.creates.card_from_link.operation.perform, { authData, inputData: { url: 'https://example.com' } }));
    expect(error).toMatchObject({ code: 'not_configured', status: 503, message: 'Link cards are not enabled yet.' });
  });

  it('an HTML error page from in front of the API still gives a readable message', async () => {
    nock(BASE).post('/v1/images').reply(502, '<html>Bad gateway</html>', { 'content-type': 'text/html' });
    const error = await appError(appTester(App.creates.create_card_image.operation.perform, { authData, inputData: { template: 'blog' } }));
    expect(error).toMatchObject({ code: 'http_502', status: 502, message: 'Link To Card answered with HTTP 502.' });
  });
});
