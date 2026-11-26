'use strict';

const { inputError } = require('./errors');

/**
 * Turning what a Zap step filled in (bundle.inputData) into the JSON the API expects.
 *
 * Template fields are offered one by one as dynamic fields. Their input keys carry a prefix
 * (data__title, item__amount, row__recipient_name) for two reasons: Zapier needs every input key
 * of an action to be unique, children included, and a template field may be called like one of
 * the action's own fields ("format", "template"). The prefix is removed before sending.
 *
 * Empty values are left out rather than sent as "": a missing key prints as empty anyway, and
 * leaving it out lets a template use its own default (a card's "theme", for example).
 */

const DATA_PREFIX = 'data__';
const ITEM_PREFIX = 'item__';
const ROW_PREFIX = 'row__';

/** @typedef {Record<string, unknown>} InputData */
/** @typedef {(value: unknown, where: string) => string | number} Convert */

/** @param {unknown} value */
function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Card data values are text (src/lib/images.ts validateData). Numbers and true/false from an
 * earlier step become text; a list or an object cannot be printed on a card.
 *
 * @type {Convert}
 */
function cardValue(value, where) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw inputError(`${where} must be text, not a list or an object.`);
}

/**
 * PDF data values are text or numbers (src/pdf/template.ts validatePdfData); true/false is sent
 * as text, as the API asks.
 *
 * @type {Convert}
 */
function pdfValue(value, where) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return String(value);
  throw inputError(`${where} must be text or a number, not a list or an object.`);
}

/**
 * The Data key/value field plus the prefixed template fields. A template field wins over the same
 * key in Data, because it is the more specific of the two.
 *
 * @param {InputData} inputData
 * @param {Convert} convert
 * @returns {Record<string, string | number>}
 */
function collectData(inputData, convert) {
  /** @type {Record<string, string | number>} */
  const data = {};
  const dict = inputData.data;
  if (!isEmpty(dict) && !isPlainObject(dict)) throw inputError('Data must be a list of keys and values.');
  for (const [key, value] of Object.entries(isPlainObject(dict) ? dict : {})) {
    const name = key.trim();
    if (name !== '' && !isEmpty(value)) data[name] = convert(value, `Data "${name}"`);
  }
  for (const [key, value] of Object.entries(inputData)) {
    if (key.startsWith(DATA_PREFIX) && !isEmpty(value)) {
      const name = key.slice(DATA_PREFIX.length);
      data[name] = convert(value, `"${name}"`);
    }
  }
  return data;
}

/**
 * Zapier line items (a field with children) arrive as a list of objects keyed by the child keys
 * (Zapier's line-items example app). Prefixes are removed, empty values and wholly empty entries
 * dropped, so the blank set the editor shows by default sends nothing.
 *
 * @param {unknown} list
 * @param {string} prefix
 * @param {Convert} convert
 * @param {string} what the field's label, for messages
 * @returns {Array<Record<string, string | number>>}
 */
function lineItems(list, prefix, convert, what) {
  if (isEmpty(list)) return [];
  if (!Array.isArray(list)) throw inputError(`${what} must be line items.`);
  /** @type {Array<Record<string, string | number>>} */
  const entries = [];
  list.forEach((entry, index) => {
    if (!isPlainObject(entry)) throw inputError(`${what} ${index + 1} must be a set of fields.`);
    /** @type {Record<string, string | number>} */
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
      const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
      if (!isEmpty(value)) out[name] = convert(value, `${what} ${index + 1}, "${name}"`);
    }
    if (Object.keys(out).length > 0) entries.push(out);
  });
  return entries;
}

/**
 * A JSON list of objects typed into a code field (or already parsed, should Zapier hand one over).
 * Returns undefined when the field is empty.
 *
 * @param {unknown} value
 * @param {string} what the field's label, for messages
 * @returns {Array<Record<string, unknown>> | undefined}
 */
function jsonList(value, what) {
  if (isEmpty(value)) return undefined;
  /** @type {unknown} */
  let parsed = value;
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw inputError(`${what} is not valid JSON. Write a list of objects, for example [{"name": "Ada"}, {"name": "Grace"}].`);
    }
  }
  if (!Array.isArray(parsed)) throw inputError(`${what} must be a JSON list of objects, starting with [.`);
  parsed.forEach((entry, index) => {
    if (!isPlainObject(entry)) throw inputError(`${what}: entry ${index + 1} must be an object, like {"name": "Ada"}.`);
  });
  return /** @type {Array<Record<string, unknown>>} */ (parsed);
}

/**
 * A Zapier boolean field, which may arrive as a boolean or as text. Empty means "not set", so the
 * API's own default applies.
 *
 * @param {unknown} value
 * @param {string} what the field's label, for messages
 * @returns {boolean | undefined}
 */
function optionalBoolean(value, what) {
  if (isEmpty(value)) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  throw inputError(`${what} must be true or false.`);
}

/**
 * A text field that is either empty (undefined) or text without surrounding spaces.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalText(value) {
  if (isEmpty(value)) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * The batch file name pattern. The API writes row values as {{key}} and the row number as {{n}}.
 * The form also takes [key] and [n], so a pattern never needs double curly braces, which
 * automation tools tend to read as their own placeholders. Square brackets cannot be part of a
 * file name anyway: the API removes them when it cleans the name.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function filenamePattern(value) {
  const text = optionalText(value);
  return text === undefined ? undefined : text.replace(/\[([A-Za-z0-9_]+)\]/g, '{{$1}}');
}

/**
 * The `pdf` part of a body (page size and orientation), or undefined to keep the template's own
 * page setup. Used by Create PDF and Start Bulk PDFs, which share the Page Size and Landscape fields.
 *
 * @param {InputData} input
 * @returns {{ format?: string, landscape?: boolean } | undefined}
 */
function pageSetup(input) {
  const format = optionalText(input.page_format);
  const landscape = optionalBoolean(input.landscape, 'Landscape');
  if (format === undefined && landscape === undefined) return undefined;
  return { ...(format === undefined ? {} : { format }), ...(landscape === undefined ? {} : { landscape }) };
}

module.exports = {
  DATA_PREFIX,
  ITEM_PREFIX,
  ROW_PREFIX,
  isEmpty,
  cardValue,
  pdfValue,
  collectData,
  lineItems,
  jsonList,
  optionalBoolean,
  optionalText,
  filenamePattern,
  pageSetup,
};
