'use strict';

const { getJson } = require('./api');
const {
  CARD_SIZES,
  DEFAULT_CARD_SIZE,
  DEFAULT_IMAGE_FORMAT,
  DEFAULT_PDF_PAGE_FORMAT,
  IMAGE_FORMATS,
  PDF_PAGE_FORMATS,
  PDF_STARTER_TEMPLATES,
  VERIFY_KEYS,
} = require('./constants');
const { DATA_PREFIX, ITEM_PREFIX, ROW_PREFIX, optionalBoolean } = require('./data');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */
/** @typedef {import('zapier-platform-core').PlainInputField} InputField */
/** @typedef {{ id: string, name: string, description?: string, fields?: Array<{ name: string, description?: string, example?: string, required?: boolean }> }} StarterCardTemplate */
/** @typedef {{ starter: StarterCardTemplate[], custom: Array<{ id: string, name?: string }> }} TemplateList */

/** Zapier's longest helpText (PlainInputFieldSchema in zapier-platform-schema). */
const HELP_TEXT_MAX = 1000;

/** "unit_price" -> "Unit price": labels for keys that have no label of their own. */
function humanize(/** @type {string} */ key) {
  const words = key.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** @param {string} text */
function helpText(text) {
  return text.length <= HELP_TEXT_MAX ? text : `${text.slice(0, HELP_TEXT_MAX - 1)}…`;
}

/**
 * A static dropdown in a fixed order: Zapier's FieldChoiceWithLabel needs value, label and a
 * legacy `sample` equal to the value (zapier-platform-schema).
 *
 * @param {Array<{ id: string, label: string }>} options
 */
function orderedChoices(options) {
  return options.map((option) => ({ value: option.id, sample: option.id, label: option.label }));
}

/** @param {string} id */
function sizeLabel(id) {
  const size = CARD_SIZES.find((candidate) => candidate.id === id);
  return size ? `${size.label} (${size.width} x ${size.height})` : id;
}

/** @param {string} id */
function formatLabel(id) {
  const format = IMAGE_FORMATS.find((candidate) => candidate.id === id);
  return format ? format.label : id;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /v1/templates: the card starter templates (with their fields) and the account's own.
 *
 * @param {ZObject} z
 * @returns {Promise<TemplateList>}
 */
async function fetchTemplates(z) {
  const response = await getJson(z, '/v1/templates');
  const data = /** @type {Partial<TemplateList>} */ (response.data || {});
  return { starter: Array.isArray(data.starter) ? data.starter : [], custom: Array.isArray(data.custom) ? data.custom : [] };
}

/**
 * Dropdown of card templates: starters first, then the account's own (newest first, as the API
 * lists them). Perform-based dynamic choices (Zapier's dynamic-dropdown example app).
 *
 * @param {ZObject} z
 */
async function cardTemplateChoices(z) {
  const { starter, custom } = await fetchTemplates(z);
  return {
    results: [
      ...starter.map((template) => ({ id: template.id, label: `${template.name} (starter)` })),
      ...custom.map((template) => ({ id: template.id, label: template.name || template.id })),
    ],
    paging_token: null,
  };
}

/**
 * Dropdown of PDF templates: the PDF starters (no endpoint lists them) and the account's own
 * templates, which POST /v1/pdf and POST /v1/batches accept by id too.
 *
 * @param {ZObject} z
 */
async function pdfTemplateChoices(z) {
  const { custom } = await fetchTemplates(z);
  return {
    results: [
      ...PDF_STARTER_TEMPLATES.map((template) => ({ id: template.id, label: `${template.name} (starter)` })),
      ...custom.map((template) => ({ id: template.id, label: template.name || template.id })),
    ],
    paging_token: null,
  };
}

/** @param {unknown} id */
function pdfStarter(id) {
  return typeof id === 'string' ? PDF_STARTER_TEMPLATES.find((template) => template.id === id.trim()) : undefined;
}

/* ------------------------------------------------------------------ */
/* Dynamic fields                                                      */
/* ------------------------------------------------------------------ */

/**
 * One input per field of the chosen card starter template, from GET /v1/templates. The account's
 * own templates do not list their fields, so for them the Data key/value field is the way in.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 * @returns {Promise<InputField[]>}
 */
async function cardDataFields(z, bundle) {
  const id = typeof bundle.inputData.template === 'string' ? bundle.inputData.template.trim() : '';
  if (id === '') return [];
  const { starter } = await fetchTemplates(z);
  const template = starter.find((candidate) => candidate.id === id);
  if (!template || !Array.isArray(template.fields)) return [];
  return template.fields.map((field) => {
    /** @type {InputField} */
    const input = { key: `${DATA_PREFIX}${field.name}`, label: humanize(field.name), required: field.required === true };
    if (field.description) input.helpText = helpText(field.description);
    if (typeof field.example === 'string' && field.example !== '') input.placeholder = field.example;
    return input;
  });
}

/** Long values get a text box instead of a single line. */
const LONG_TEXT = /(address|notes|summary|terms|achievement)$/;

/**
 * Inputs for the chosen PDF starter: one per text field, and its list as line items. For the
 * account's own templates and for HTML, a JSON field takes the list (`items`) instead.
 *
 * @param {ZObject} _z
 * @param {Bundle} bundle
 * @returns {InputField[]}
 */
function pdfDataFields(_z, bundle) {
  const template = pdfStarter(bundle.inputData.template);
  if (!template) {
    return [
      {
        key: 'items_json',
        label: 'Line items (JSON)',
        type: 'code',
        helpText: 'For a template with an `items` list: a JSON list of objects, for example `[{"description": "Design", "amount": "1,200.00"}]`.',
      },
    ];
  }
  return template.fields.map((field) => {
    if (field.kind === 'items') {
      return {
        key: field.key,
        label: field.label,
        required: field.required,
        children: (field.itemFields || []).map((name) => ({ key: `${ITEM_PREFIX}${name}`, label: humanize(name) })),
      };
    }
    return { key: `${DATA_PREFIX}${field.key}`, label: field.label, required: field.required, type: LONG_TEXT.test(field.key) ? 'text' : 'string' };
  });
}

/**
 * Line items for a batch: one entry per document, with the chosen starter's text fields. A list
 * inside a row (an invoice's items) cannot be a line item of a line item, which Zapier does not
 * nest, so such rows go in Rows (JSON). With verification on (the certificate template's default)
 * the keys the batch fills in are left out, because the API refuses rows that bring them.
 *
 * @param {ZObject} _z
 * @param {Bundle} bundle
 * @returns {InputField[]}
 */
function batchRowFields(_z, bundle) {
  const template = pdfStarter(bundle.inputData.template);
  if (!template) return [];
  /** @type {boolean | undefined} */
  let verify;
  try {
    verify = optionalBoolean(bundle.inputData.verify, 'Certificate verification');
  } catch {
    verify = undefined; // shown as an error when the action runs, not while the form loads
  }
  const verifyOn = verify === true || (verify === undefined && template.id === 'certificate');
  const fields = template.fields.filter((field) => field.kind === 'text' && !(verifyOn && VERIFY_KEYS.includes(field.key)));
  return [{ key: 'rows', label: 'Rows', children: fields.map((field) => ({ key: `${ROW_PREFIX}${field.key}`, label: field.label })) }];
}

/* ------------------------------------------------------------------ */
/* Shared static fields                                                */
/* ------------------------------------------------------------------ */

/** @returns {InputField} */
function dataDictField() {
  return {
    key: 'data',
    label: 'Data',
    dict: true,
    helpText:
      'More template fields as key and value, for example `title` and `Hello`. Keys are lower-case letters, digits and `_`. A field filled in above wins over the same key here.',
  };
}

/** @returns {InputField} */
function sizeField() {
  return {
    key: 'size',
    label: 'Size',
    choices: orderedChoices(CARD_SIZES.map((size) => ({ id: size.id, label: sizeLabel(size.id) }))),
    helpText: `Leave empty for ${sizeLabel(DEFAULT_CARD_SIZE)}.`,
  };
}

/** @returns {InputField} */
function formatField() {
  return {
    key: 'format',
    label: 'Image Format',
    choices: orderedChoices(IMAGE_FORMATS),
    helpText: `Leave empty for ${formatLabel(DEFAULT_IMAGE_FORMAT)}.`,
  };
}

/** @returns {InputField[]} */
function pageFields() {
  const fallback = PDF_PAGE_FORMATS.find((format) => format.id === DEFAULT_PDF_PAGE_FORMAT);
  return [
    {
      key: 'page_format',
      label: 'Page Size',
      choices: orderedChoices(PDF_PAGE_FORMATS),
      helpText: `Leave empty for the template's own page size (${fallback ? fallback.label : DEFAULT_PDF_PAGE_FORMAT} when it has none).`,
    },
    {
      key: 'landscape',
      label: 'Landscape',
      type: 'boolean',
      helpText: "Leave empty for the template's own orientation (portrait when it has none).",
    },
  ];
}

module.exports = {
  humanize,
  cardTemplateChoices,
  pdfTemplateChoices,
  pdfStarter,
  cardDataFields,
  pdfDataFields,
  batchRowFields,
  dataDictField,
  sizeField,
  formatField,
  pageFields,
};
