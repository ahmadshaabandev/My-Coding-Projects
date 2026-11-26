'use strict';

const { apiUrl, isApiUrl } = require('./base-url');
const { handleErrors } = require('./middleware');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */

/** Batch ids are "bat_" plus letters and digits; anything else never reaches the URL path. */
const BATCH_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Hydrators turn the `file` outputs into real files, lazily: an action returns a pointer made
 * with z.dehydrateFile(), and Zapier calls the hydrator only when a later step uses the file
 * (Zapier's files example, github.com/zapier/zapier-platform example-apps/files). Its requests
 * carry the connection's auth, as the example's comment says, which the zip download needs.
 *
 * z.stashFile() copies the bytes to Zapier's file storage and answers with its URL. Zapier only
 * allows it inside a create or a hydrator (packages/core/src/tools/create-file-stasher.js).
 */

/**
 * A stored image or PDF from its `url` (GET /i/...). The link itself is public until the plan's
 * storage time ends; the file name comes from the response (PDFs send Content-Disposition).
 * Only Link To Card URLs are downloaded: a pointer can never make this fetch another site.
 *
 * @param {ZObject} z
 * @param {import('zapier-platform-core').Bundle<{ url?: string }>} bundle
 */
async function downloadFile(z, bundle) {
  const url = bundle.inputData.url;
  if (!isApiUrl(url)) throw new z.errors.Error('Only Link To Card files can be downloaded here.', 'invalid_request', 400);
  return z.stashFile(z.request({ url: /** @type {string} */ (url), raw: true }));
}

/** A part number of a batch ZIP: a whole number from 1 (GET /v1/batches/{id}/zip?part=N). */
const PART = /^[1-9][0-9]{0,5}$/;

/**
 * One part of a batch's ZIP (GET /v1/batches/{id}/zip?part=N, API key). The API packs a batch's
 * finished documents into parts of at most 500 files and 2 GiB each, in row order, and lists
 * them as `zip_parts`; most batches have one part. The file is named like the API names it:
 * `<batch id>.zip` for a single part, `<batch id>-part-<n>-of-<parts>.zip` otherwise.
 *
 * @param {ZObject} z
 * @param {import('zapier-platform-core').Bundle<{ id?: string, part?: number | string, parts?: number | string }>} bundle
 */
async function downloadBatchZip(z, bundle) {
  const { id } = bundle.inputData;
  if (typeof id !== 'string' || !BATCH_ID.test(id)) throw new z.errors.Error('This is not a batch id.', 'invalid_request', 400);
  const part = bundle.inputData.part === undefined ? '1' : String(bundle.inputData.part);
  const parts = bundle.inputData.parts === undefined ? '1' : String(bundle.inputData.parts);
  if (!PART.test(part) || !PART.test(parts)) throw new z.errors.Error('This is not a part of a batch ZIP.', 'invalid_request', 400);
  // The status is read here, not by the app middleware: a streamed response's error body can only
  // be read asynchronously, and the API's message ("This batch's ZIP has 2 parts; ask for part=1
  // to part=2 ...") says more than a generic "not found" when the parts changed since the search.
  const response = await z.request({ url: apiUrl(`/v1/batches/${id}/zip`), params: { part }, raw: true, skipThrowForStatus: true });
  if (response.status >= 400) {
    /** @type {unknown} */
    let data = null;
    try {
      data = JSON.parse(await response.text());
    } catch {
      data = null; // not the API's JSON: handleErrors falls back to the status
    }
    handleErrors(/** @type {any} */ ({ status: response.status, request: { url: apiUrl(`/v1/batches/${id}/zip`) }, data, skipThrowForStatus: false }), z);
  }
  // The types only list (promise) for a request; core also takes the name and type after it.
  /** @type {(input: unknown, knownLength?: number, filename?: string, contentType?: string) => Promise<string>} */
  const stash = /** @type {any} */ (z.stashFile);
  const filename = parts === '1' ? `${id}.zip` : `${id}-part-${part}-of-${parts}.zip`;
  return stash(response, undefined, filename, 'application/zip');
}

module.exports = { downloadFile, downloadBatchZip };
