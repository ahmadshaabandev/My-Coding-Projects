'use strict';

const { apiUrl } = require('./base-url');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */

/**
 * POST a JSON body to the API.
 *
 * The body is serialized here, not handed to z.request as an object. Zapier core removes every
 * `{{...}}` from the top-level string values of an object body before sending it
 * (normalizeEmptyBodyFields in packages/core/src/tools/cleaner.js, run by prepare-request.js),
 * and Link To Card uses exactly that syntax: inline HTML placeholders and the batch file name
 * pattern ("certificate-{{recipient_name}}.pdf") would arrive empty. A string body is left alone.
 *
 * @param {ZObject} z
 * @param {string} path such as "/v1/images"
 * @param {Record<string, unknown>} payload
 */
function postJson(z, path, payload) {
  return z.request({
    url: apiUrl(path),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * GET with query parameters. Unlike a body, a query cannot be protected from core's cleaning:
 * core moves the URL's query into `params` (packages/core/src/tools/request-clean.js) and then
 * removes `{{...}}` from every value (normalizeEmptyParamFields, tools/cleaner.js). So a page
 * address whose query holds double curly braces loses them; test/api.test.mjs pins this down.
 *
 * @param {ZObject} z
 * @param {string} path
 * @param {Record<string, string>} [query]
 * @param {{ skipThrowForStatus?: boolean }} [options]
 */
function getJson(z, path, query, options = {}) {
  return z.request({ url: apiUrl(path), ...(query ? { params: query } : {}), ...options });
}

module.exports = { postJson, getJson };
