'use strict';

const { postJson } = require('../lib/api');
const { ROW_PREFIX, filenamePattern, jsonList, lineItems, optionalBoolean, optionalText, pageSetup, pdfValue } = require('../lib/data');
const { inputError } = require('../lib/errors');
const { batchRowFields, pageFields, pdfTemplateChoices } = require('../lib/fields');
const { BATCH_OUTPUT_FIELDS, SAMPLE_BATCH_STARTED } = require('../lib/outputs');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * The rows of the batch: the Rows line items (a starter template's fields) or Rows (JSON), one of
 * the two. Each row is a `data` object; the API checks every row before it starts anything.
 *
 * @param {Record<string, unknown>} input
 */
function batchRows(input) {
  const fromLineItems = lineItems(input.rows, ROW_PREFIX, pdfValue, 'Row');
  const fromJson = jsonList(input.rows_json, 'Rows (JSON)');
  if (fromLineItems.length > 0 && fromJson !== undefined) throw inputError('Fill in Rows or Rows (JSON), not both.');
  const rows = fromJson === undefined ? fromLineItems : fromJson;
  if (rows.length === 0) throw inputError('Add at least one row: map Rows to a list from an earlier step, or fill in Rows (JSON).');
  return rows;
}

/**
 * POST /v1/batches: answers 202 at once with the batch id and status "queued"; the documents
 * are made in the background. Find Batch follows it. The API checks the whole request before it
 * accepts it: too many rows for the plan (403 plan_required when a higher plan takes that many,
 * 400 above every plan), an unknown template (404), not enough images left (402), or too many
 * batches waiting or running at once (409). Each shows as a Zapier error with the API's message.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const input = bundle.inputData;
  const template = optionalText(input.template);
  if (template === undefined) throw inputError('Pick a Template.');
  const rows = batchRows(input);
  const filename = filenamePattern(input.filename);
  const verify = optionalBoolean(input.verify, 'Certificate verification');
  const pdf = pageSetup(input);

  const response = await postJson(z, '/v1/batches', {
    template,
    rows,
    ...(pdf === undefined ? {} : { pdf }),
    ...(filename === undefined ? {} : { filename }),
    ...(verify === undefined ? {} : { verify }),
  });
  return response.data;
}

module.exports = {
  key: 'start_bulk_pdfs',
  noun: 'Batch',
  display: {
    label: 'Start Bulk PDFs',
    description:
      'Starts a batch that makes one PDF for every row, for example every row of a spreadsheet, with the same template. The PDFs are made in the background: follow the batch with Find Batch.',
  },
  operation: {
    inputFields: [
      {
        key: 'template',
        label: 'Template',
        required: true,
        altersDynamicFields: true,
        choices: { perform: pdfTemplateChoices },
        helpText: 'A PDF starter template or one of your own templates. For a starter template, its fields show under **Rows**.',
      },
      {
        key: 'verify',
        label: 'Certificate Verification',
        type: 'boolean',
        altersDynamicFields: true,
        helpText:
          'Give every document a certificate ID and a public page that confirms it. Leave empty for the default: on for the certificate template, off for the others.',
      },
      batchRowFields,
      {
        key: 'rows_json',
        label: 'Rows (JSON)',
        type: 'code',
        helpText:
          'Instead of **Rows**: a JSON list with one object per document, for example `[{"recipient_name": "Amara Nwosu"}, {"recipient_name": "Jonas Berg"}]`. Use it for your own templates and for rows with a list of line items.',
      },
      {
        key: 'filename',
        label: 'File Name Pattern',
        helpText:
          "The download name of each PDF. Write a row's value as `[key]` and the row's number as `[n]`, for example `certificate-[recipient_name].pdf`. Leave empty for the template and the row number: `certificate-1.pdf`, `certificate-2.pdf`, ... for a starter template, `document-1.pdf`, ... for your own.",
      },
      ...pageFields(),
    ],
    perform,
    sample: SAMPLE_BATCH_STARTED,
    outputFields: BATCH_OUTPUT_FIELDS,
  },
};
