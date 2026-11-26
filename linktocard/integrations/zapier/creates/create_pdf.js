'use strict';

const { postJson } = require('../lib/api');
const { ITEM_PREFIX, collectData, jsonList, lineItems, optionalText, pageSetup, pdfValue } = require('../lib/data');
const { inputError } = require('../lib/errors');
const { dataDictField, pageFields, pdfDataFields, pdfTemplateChoices } = require('../lib/fields');
const hydrators = require('../lib/hydrators');
const { SAMPLE_PDF, USAGE_OUTPUT_FIELDS } = require('../lib/outputs');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * `data` for POST /v1/pdf: the template's fields, Data, and the list from either the line items
 * (starter templates) or the JSON field (own templates and HTML).
 *
 * @param {Record<string, unknown>} input
 */
function pdfData(input) {
  /** @type {Record<string, unknown>} */
  const data = collectData(input, pdfValue);
  const items = lineItems(input.items, ITEM_PREFIX, pdfValue, 'Line item');
  const itemsJson = jsonList(input.items_json, 'Line items (JSON)');
  if (items.length > 0 && itemsJson !== undefined) throw inputError('Fill in the line items or Line items (JSON), not both.');
  if (items.length > 0) data.items = items;
  if (itemsJson !== undefined) data.items = itemsJson;
  return data;
}

/**
 * POST /v1/pdf with the default `"response": "url"`: the PDF is stored and the answer has its
 * link, page count and the images it counted (`credits_used`).
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const input = bundle.inputData;
  const template = optionalText(input.template);
  const html = optionalText(input.html);
  const css = optionalText(input.css);
  if ((template === undefined) === (html === undefined)) throw inputError('Pick a Template or fill in HTML (one of the two).');
  if (template !== undefined && css !== undefined) throw inputError('CSS can only be used together with HTML.');
  const filename = optionalText(input.filename);
  const pdf = pageSetup(input);

  const response = await postJson(z, '/v1/pdf', {
    ...(template === undefined ? { html, ...(css === undefined ? {} : { css }) } : { template }),
    data: pdfData(input),
    ...(filename === undefined ? {} : { filename }),
    ...(pdf === undefined ? {} : { pdf }),
  });
  const document = response.data;
  return { ...document, file: z.dehydrateFile(hydrators.downloadFile, { url: document.url }) };
}

module.exports = {
  key: 'create_pdf',
  noun: 'PDF',
  display: {
    label: 'Create PDF',
    description:
      'Makes a PDF from a PDF template (an invoice, a receipt, a quote, a certificate, a report, or one of your own templates) or from your own HTML. Returns its link, its page count, the images it counted and the file.',
  },
  operation: {
    inputFields: [
      {
        key: 'template',
        label: 'Template',
        altersDynamicFields: true,
        choices: { perform: pdfTemplateChoices },
        helpText: 'A PDF starter template or one of your own templates. Leave empty to use **HTML** instead.',
      },
      {
        key: 'html',
        label: 'HTML',
        type: 'code',
        helpText:
          'Instead of a template: the whole HTML of the document. For HTML you use again and again, save it as a template in your dashboard and pick it under **Template**; its placeholders are then filled from the fields here.',
      },
      { key: 'css', label: 'CSS', type: 'code', helpText: 'Only together with **HTML**: the styles of the document.' },
      pdfDataFields,
      dataDictField(),
      {
        key: 'filename',
        label: 'File Name',
        helpText: 'The name the PDF downloads under, for example `invoice-2026-001.pdf`. Leave empty to name it after the template.',
      },
      ...pageFields(),
    ],
    perform,
    sample: SAMPLE_PDF,
    outputFields: [
      { key: 'id', label: 'PDF ID' },
      { key: 'url', label: 'PDF URL' },
      { key: 'file', label: 'PDF File', type: 'file' },
      { key: 'pages', label: 'Pages', type: 'integer' },
      { key: 'credits_used', label: 'Images Counted', type: 'integer' },
      { key: 'bytes', label: 'File Size (bytes)', type: 'integer' },
      { key: 'cached', label: 'Served From Storage', type: 'boolean' },
      { key: 'template', label: 'Template' },
      { key: 'filename', label: 'File Name' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
      { key: 'expires_at', label: 'Link Expires At', type: 'datetime' },
      { key: 'warnings', label: 'Warnings', list: true },
      ...USAGE_OUTPUT_FIELDS,
    ],
  },
};
