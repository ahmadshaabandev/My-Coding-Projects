'use strict';

const { getJson } = require('../lib/api');
const { BATCH_FINAL_STATUSES, ZAPIER_MAX_FILE_BYTES } = require('../lib/constants');
const { optionalText } = require('../lib/data');
const { inputError } = require('../lib/errors');
const hydrators = require('../lib/hydrators');
const { BATCH_OUTPUT_FIELDS, SAMPLE_BATCH } = require('../lib/outputs');
const { handleErrors } = require('../lib/middleware');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * GET /v1/batches/{id}. A search answers with a list (Zapier core checks it): one batch, or an
 * empty list for an id this account has no batch with, which Zapier shows as "nothing found".
 *
 * Fields added for later steps: `finished` (nothing changes any more, so a Filter or Paths step
 * can wait for it) and, once finished with something to download, the ZIP. The API packs a
 * batch's finished documents into ZIP parts of at most 500 files and 2 GiB each and lists them as
 * `zip_parts`; each part gets a `file` here, `zip_file` is the first part (every document when
 * there is one part, which `zip_part_count` tells), and Zapier downloads a part only if a later
 * step uses it. A part's own `url` needs the API key, so later steps use its `file`. Zapier stores
 * files of up to 1 GB (ZAPIER_MAX_FILE_BYTES), so a larger part gets no `file`; its documents'
 * own PDF links (`rows[].url`) still work.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const id = optionalText(bundle.inputData.id);
  if (id === undefined) throw inputError('Fill in the Batch ID.');
  const response = await getJson(z, `/v1/batches/${encodeURIComponent(id)}`, {}, { skipThrowForStatus: true });
  if (response.status === 404) return [];
  // skipThrowForStatus also skips the app's error middleware, so every other error is mapped here.
  handleErrors({ ...response, skipThrowForStatus: false }, z);

  const batch = response.data;
  const finished = BATCH_FINAL_STATUSES.includes(batch.status);
  /** @type {Array<{ part: number, entries: number, bytes: number, url: string }>} */
  const listed = Array.isArray(batch.zip_parts) ? batch.zip_parts : [];
  /** @type {Array<{ part: number, entries: number, bytes: number, url: string, file?: string }>} */
  const parts = finished
    ? listed.map((part) =>
        part.bytes > ZAPIER_MAX_FILE_BYTES ? part : { ...part, file: z.dehydrateFile(hydrators.downloadBatchZip, { id: batch.id, part: part.part, parts: listed.length }) },
      )
    : listed;
  return [
    {
      ...batch,
      zip_parts: parts,
      finished,
      zip_part_count: listed.length,
      ...(finished && parts.length > 0 && parts[0].file !== undefined ? { zip_file: parts[0].file } : {}),
    },
  ];
}

module.exports = {
  key: 'get_batch',
  noun: 'Batch',
  display: {
    label: 'Find Batch',
    description:
      "Looks up a batch from Start Bulk PDFs by its ID: its status, how many documents are done, and each document's link. Once it has finished, also its documents as zip files: one zip for up to 500 documents, more parts for larger batches. A part over 1 GB, the largest file Zapier keeps, comes without a file.",
  },
  operation: {
    inputFields: [
      { key: 'id', label: 'Batch ID', required: true, helpText: 'The ID that Start Bulk PDFs returned, for example `bat_m4q8x2k7v1c9d3e6`.' },
    ],
    perform,
    sample: SAMPLE_BATCH,
    outputFields: [
      ...BATCH_OUTPUT_FIELDS,
      { key: 'finished', label: 'Finished', type: 'boolean' },
      { key: 'zip_file', label: 'Zip File (First Part; All PDFs When There Is One Part)', type: 'file' },
      { key: 'zip_part_count', label: 'Zip Parts', type: 'integer' },
      {
        key: 'zip_parts',
        label: 'Zip Files',
        children: [
          { key: 'part', label: 'Part', type: 'integer' },
          { key: 'entries', label: 'PDFs in This Part', type: 'integer' },
          { key: 'bytes', label: 'Zip Size (bytes)', type: 'integer' },
          { key: 'file', label: 'Zip File', type: 'file' },
        ],
      },
      {
        key: 'rows',
        label: 'Documents',
        children: [
          { key: 'index', label: 'Row Index (from 0)', type: 'integer' },
          { key: 'status', label: 'Document Status' },
          { key: 'filename', label: 'File Name' },
          { key: 'url', label: 'PDF URL' },
          { key: 'pages', label: 'Pages', type: 'integer' },
          { key: 'credits_used', label: 'Images Counted', type: 'integer' },
          { key: 'certificate_id', label: 'Certificate ID' },
          { key: 'verify_url', label: 'Verification Page' },
          { key: 'error__code', label: 'Error Code' },
          { key: 'error__message', label: 'Error' },
        ],
      },
    ],
  },
};
