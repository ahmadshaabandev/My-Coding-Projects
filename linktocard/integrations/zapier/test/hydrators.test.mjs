// The hydrators that turn `file`, `zip_file` and ZIP part pointers into files. z.stashFile needs Zapier's
// RPC (a deploy key), so these tests hand the hydrators a z whose stashFile records its input;
// the last test shows what happens with the real one offline.
import { describe, expect, it } from 'vitest';
import { App, BASE, appTester, authData, nock, require, zapier } from './helpers.mjs';

const { downloadBatchZip, downloadFile } = require('../lib/hydrators');

function fakeZ() {
  const calls = { requests: [], stashed: [] };
  const z = {
    errors: zapier.errors,
    request: async (options) => {
      calls.requests.push(options);
      return { status: 200, request: options };
    },
    stashFile: async (...args) => {
      calls.stashed.push(args);
      return 'https://zapier-files.example/stashed';
    },
  };
  return { z, calls };
}

describe('downloadFile', () => {
  it('streams a Link To Card file into Zapier file storage', async () => {
    const { z, calls } = fakeZ();
    const url = `${BASE}/i/u_test/${'a'.repeat(64)}.pdf`;
    expect(await downloadFile(z, { inputData: { url } })).toBe('https://zapier-files.example/stashed');
    expect(calls.requests).toEqual([{ url, raw: true }]);
    expect(calls.stashed).toHaveLength(1);
  });

  it('downloads nothing from another host', async () => {
    const { z, calls } = fakeZ();
    for (const url of ['https://example.com/file.pdf', 'http://linktocard.com/i/x.png', undefined]) {
      await expect(downloadFile(z, { inputData: { url } })).rejects.toThrow(/Only Link To Card files/);
    }
    expect(calls.requests).toEqual([]);
  });
});

describe('downloadBatchZip', () => {
  it('fetches the first part with the API key route and names the file after the batch', async () => {
    const { z, calls } = fakeZ();
    await downloadBatchZip(z, { inputData: { id: 'bat_m4q8x2k7v1c9d3e6', part: 1, parts: 1 } });
    expect(calls.requests).toEqual([{ url: `${BASE}/v1/batches/bat_m4q8x2k7v1c9d3e6/zip`, params: { part: '1' }, raw: true, skipThrowForStatus: true }]);
    expect(calls.stashed[0].slice(1)).toEqual([undefined, 'bat_m4q8x2k7v1c9d3e6.zip', 'application/zip']);
  });

  it('fetches a later part and names it as the API does', async () => {
    const { z, calls } = fakeZ();
    await downloadBatchZip(z, { inputData: { id: 'bat_m4q8x2k7v1c9d3e6', part: 2, parts: 3 } });
    expect(calls.requests).toEqual([{ url: `${BASE}/v1/batches/bat_m4q8x2k7v1c9d3e6/zip`, params: { part: '2' }, raw: true, skipThrowForStatus: true }]);
    expect(calls.stashed[0].slice(1)).toEqual([undefined, 'bat_m4q8x2k7v1c9d3e6-part-2-of-3.zip', 'application/zip']);
  });

  it('reads a pointer without a part as part 1 of 1', async () => {
    const { z, calls } = fakeZ();
    await downloadBatchZip(z, { inputData: { id: 'bat_1' } });
    expect(calls.requests[0].params).toEqual({ part: '1' });
    expect(calls.stashed[0][2]).toBe('bat_1.zip');
  });

  it('refuses an id that could change the path', async () => {
    const { z, calls } = fakeZ();
    for (const id of ['../usage', 'bat_1/zip', '', undefined]) {
      await expect(downloadBatchZip(z, { inputData: { id } })).rejects.toThrow(/not a batch id/);
    }
    expect(calls.requests).toEqual([]);
  });

  it("shows the API's message when the part is gone, and the key hint on 401", async () => {
    const answer = (status, body) => ({
      errors: zapier.errors,
      request: async () => ({ status, text: async () => body }),
      stashFile: async () => {
        throw new Error('not reached');
      },
    });
    const gone = JSON.stringify({ error: { code: 'not_found', message: "This batch's ZIP has 1 part; ask for part=1 to part=1 (zip_parts in GET of the batch lists them)." } });
    await expect(downloadBatchZip(answer(404, gone), { inputData: { id: 'bat_1', part: 2, parts: 2 } })).rejects.toThrow(/This batch's ZIP has 1 part/);
    const revoked = JSON.stringify({ error: { code: 'invalid_api_key', message: 'This API key is not valid.' } });
    await expect(downloadBatchZip(answer(401, revoked), { inputData: { id: 'bat_1' } })).rejects.toThrow(/This API key is not valid\. Check the API key/);
    await expect(downloadBatchZip(answer(502, '<html>bad gateway</html>'), { inputData: { id: 'bat_1' } })).rejects.toThrow(/HTTP 502/);
  });

  it('refuses a part that is not a whole number from 1', async () => {
    const { z, calls } = fakeZ();
    for (const part of [0, -1, '1&x=2', 'two', 1.5]) {
      await expect(downloadBatchZip(z, { inputData: { id: 'bat_1', part, parts: 2 } })).rejects.toThrow(/not a part/);
    }
    await expect(downloadBatchZip(z, { inputData: { id: 'bat_1', part: 1, parts: '0' } })).rejects.toThrow(/not a part/);
    expect(calls.requests).toEqual([]);
  });
});

describe('with the real z.stashFile', () => {
  it('is registered on the app, and only fails offline at the stash, which needs a Zapier deploy key', async () => {
    expect(App.hydrators).toEqual({ downloadFile, downloadBatchZip });
    nock(BASE).get(/\/i\//).optionally().reply(200, Buffer.from('%PDF-1.7'), { 'content-type': 'application/pdf' });
    await expect(appTester(App.hydrators.downloadFile, { authData, inputData: { url: `${BASE}/i/u_test/${'a'.repeat(64)}.pdf` } })).rejects.toThrow(
      /deploy key/i,
    );
  });
});
