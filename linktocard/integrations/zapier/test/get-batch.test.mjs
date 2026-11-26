// Find Batch: GET /v1/batches/{id} as a search (a list), with `finished` and, once there is
// something to download, a file for every ZIP part (`zip_parts[].file`, `zip_file` = part 1).
import { describe, expect, it } from 'vitest';
import { App, BASE, api, apiError, appError, appTester, authData, hydratePointer, require } from './helpers.mjs';

const { ZAPIER_MAX_FILE_BYTES } = require('../lib/constants');

const action = App.searches.get_batch;
const run = (id) => appTester(action.operation.perform, { authData, inputData: { id } });
const zipPart = (id, part, entries, bytes) => ({ part, entries, bytes, url: `${BASE}/v1/batches/${id}/zip?part=${part}` });
const batch = (status, counts, zipParts = []) => ({
  id: 'bat_m4q8x2k7v1c9d3e6',
  status,
  template: 'certificate',
  verify: true,
  total: 2,
  counts: { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, ...counts },
  pages: 0,
  credits_used: 0,
  created_at: '2026-11-26T09:12:44.031Z',
  started_at: null,
  finished_at: null,
  cancelled_at: null,
  zip_url: `${BASE}/v1/batches/bat_m4q8x2k7v1c9d3e6/zip`,
  rows: [],
  zip_parts: zipParts,
});

describe('Find Batch', () => {
  it('returns a finished batch with a zip of its documents', async () => {
    api()
      .get('/v1/batches/bat_m4q8x2k7v1c9d3e6')
      .reply(200, batch('partial', { done: 1, failed: 1 }, [zipPart('bat_m4q8x2k7v1c9d3e6', 1, 1, 35068)]));
    const results = await run('bat_m4q8x2k7v1c9d3e6');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'bat_m4q8x2k7v1c9d3e6', status: 'partial', finished: true, zip_part_count: 1 });
    const pointer = { type: 'file', method: 'hydrators.downloadBatchZip', bundle: { id: 'bat_m4q8x2k7v1c9d3e6', part: 1, parts: 1 } };
    expect(hydratePointer(results[0].zip_file)).toEqual(pointer);
    expect(results[0].zip_parts).toHaveLength(1);
    expect(results[0].zip_parts[0]).toMatchObject({ part: 1, entries: 1, bytes: 35068 });
    expect(hydratePointer(results[0].zip_parts[0].file)).toEqual(pointer);
  });

  it('gives every ZIP part its own file, and zip_file is the first part', async () => {
    const id = 'bat_m4q8x2k7v1c9d3e6';
    const parts = [zipPart(id, 1, 500, 900_000_000), zipPart(id, 2, 500, 850_000_000), zipPart(id, 3, 12, 40_000_000)];
    api().get(`/v1/batches/${id}`).reply(200, batch('done', { done: 1012 }, parts));
    const [result] = await run(id);
    expect(result.zip_part_count).toBe(3);
    expect(result.zip_parts.map((part) => hydratePointer(part.file).bundle)).toEqual([
      { id, part: 1, parts: 3 },
      { id, part: 2, parts: 3 },
      { id, part: 3, parts: 3 },
    ]);
    expect(result.zip_parts.map((part) => part.url)).toEqual(parts.map((part) => part.url));
    expect(hydratePointer(result.zip_file).bundle).toEqual({ id, part: 1, parts: 3 });
  });

  it('offers no file for a part larger than Zapier keeps, and no zip_file when that is part 1', async () => {
    const id = 'bat_m4q8x2k7v1c9d3e6';
    const parts = [zipPart(id, 1, 40, ZAPIER_MAX_FILE_BYTES + 1), zipPart(id, 2, 3, ZAPIER_MAX_FILE_BYTES)];
    api().get(`/v1/batches/${id}`).reply(200, batch('done', { done: 43 }, parts));
    const [result] = await run(id);
    expect(result.zip_parts[0]).not.toHaveProperty('file');
    expect(hydratePointer(result.zip_parts[1].file).bundle).toEqual({ id, part: 2, parts: 2 });
    expect(result).not.toHaveProperty('zip_file');
    expect(result.zip_part_count).toBe(2);
  });

  it("the file limit is the installed zapier-platform-core's own upload limit", () => {
    expect(ZAPIER_MAX_FILE_BYTES).toBe(require('zapier-platform-core/src/constants').UPLOAD_MAX_SIZE);
  });

  it('says a running batch has not finished, and offers no zip yet', async () => {
    api()
      .get('/v1/batches/bat_1')
      .reply(200, { ...batch('running', { done: 1, running: 1 }, [zipPart('bat_1', 1, 1, 35068)]), id: 'bat_1' });
    const [result] = await run('bat_1');
    expect(result.finished).toBe(false);
    expect(result).not.toHaveProperty('zip_file');
    expect(result.zip_part_count).toBe(1);
    expect(result.zip_parts[0]).not.toHaveProperty('file');
  });

  it('offers no zip for a finished batch without a single document', async () => {
    api().get('/v1/batches/bat_1').reply(200, { ...batch('failed', { failed: 2 }), id: 'bat_1' });
    const [result] = await run('bat_1');
    expect(result.finished).toBe(true);
    expect(result).not.toHaveProperty('zip_file');
    expect(result).toMatchObject({ zip_part_count: 0, zip_parts: [] });
  });

  it('offers no zip once the documents of a finished batch have expired (no parts listed)', async () => {
    api().get('/v1/batches/bat_1').reply(200, { ...batch('done', { done: 2 }), id: 'bat_1' });
    const [result] = await run('bat_1');
    expect(result.finished).toBe(true);
    expect(result).not.toHaveProperty('zip_file');
  });

  it('finds nothing (an empty list) for an id this account has no batch with', async () => {
    api().get('/v1/batches/bat_nope').reply(404, apiError('not_found', 'No batch with this id on your account.'));
    expect(await run('bat_nope')).toEqual([]);
  });

  it('still shows other errors, although it reads the status itself', async () => {
    api().get('/v1/batches/bat_1').reply(401, apiError('invalid_api_key', 'This API key is not valid.'));
    expect(await appError(run('bat_1'))).toMatchObject({ code: 'AuthenticationError', status: 401 });
    api().get('/v1/batches/bat_1').reply(503, apiError('not_configured', 'Bulk documents are not enabled yet.'));
    expect(await appError(run('bat_1'))).toMatchObject({ code: 'not_configured', message: 'Bulk documents are not enabled yet.' });
  });

  it('puts the id into the path encoded, and trims it', async () => {
    const scope = api().get('/v1/batches/bat%2F..%2Fx').reply(404, apiError('not_found', 'No batch.'));
    expect(await run(' bat/../x ')).toEqual([]);
    expect(scope.isDone()).toBe(true);
  });

  it('needs an id', async () => {
    expect(await appError(run(''))).toMatchObject({ code: 'invalid_request', message: 'Fill in the Batch ID.' });
  });

  it('describes its outputs for later steps, rows included', () => {
    const rows = action.operation.outputFields.find((field) => field.key === 'rows');
    expect(rows.children.map((child) => child.key)).toEqual([
      'index',
      'status',
      'filename',
      'url',
      'pages',
      'credits_used',
      'certificate_id',
      'verify_url',
      'error__code',
      'error__message',
    ]);
    expect(action.operation.sample.rows[0].url.startsWith(`${BASE}/i/`)).toBe(true);
    const parts = action.operation.outputFields.find((field) => field.key === 'zip_parts');
    expect(parts.children.map((child) => [child.key, child.type])).toEqual([
      ['part', 'integer'],
      ['entries', 'integer'],
      ['bytes', 'integer'],
      ['file', 'file'],
    ]);
  });
});
