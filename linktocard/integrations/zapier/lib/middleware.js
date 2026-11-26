'use strict';

const { apiBaseUrl, isApiUrl } = require('./base-url');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */
/** @typedef {import('zapier-platform-core').HttpRequestOptions & { url?: string }} Request */
/** @typedef {import('zapier-platform-core').HttpResponse | import('zapier-platform-core').RawHttpResponse} Response */

/**
 * beforeRequest: `Authorization: Bearer <API key>`, the only way the API authenticates.
 *
 * Only requests to the API's own origin get the key. Every request of this app goes there today,
 * but a header that follows any URL is how keys leak, so the check stays even if a later action
 * fetches something else.
 *
 * @param {Request} request
 * @param {ZObject} _z
 * @param {Bundle} bundle
 */
function includeApiKey(request, _z, bundle) {
  const raw = bundle.authData && bundle.authData.api_key;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key !== '' && isApiUrl(request.url, apiBaseUrl())) {
    request.headers = { ...(request.headers || {}), Authorization: `Bearer ${key}` };
  }
  return request;
}

/**
 * The user-facing message and code of an API error. The API always answers
 * `{ "error": { "code", "message", "docs" } }` (src/lib/errors.ts) and the message says what to
 * change, so it is shown as it is. Anything else (an HTML page from a proxy, a cut-off body) gets
 * a plain sentence with the status.
 *
 * @param {Response} response
 * @returns {{ code: string, message: string }}
 */
function describeApiError(response) {
  const fallback = { code: `http_${response.status}`, message: `Link To Card answered with HTTP ${response.status}.` };
  // A raw (streamed) response, a file download, has no parsed body, and reading `content` throws.
  if (response.request && response.request.raw) {
    return response.status === 404
      ? { code: 'not_found', message: "The file was not found. Files are stored for the plan's storage time: run the step that made it again for a new one." }
      : fallback;
  }
  /** @type {unknown} */
  const data = /** @type {{ data?: unknown }} */ (response).data;
  if (typeof data !== 'object' || data === null) return fallback;
  const error = /** @type {{ error?: { code?: unknown, message?: unknown } }} */ (data).error;
  if (!error || typeof error.message !== 'string' || error.message.trim() === '') return fallback;
  return { code: typeof error.code === 'string' ? error.code : fallback.code, message: error.message };
}

/**
 * afterResponse: turn API errors into errors Zapier shows to the user.
 *
 * - Requests that ask to see every status themselves (`skipThrowForStatus`, used by Find Batch to
 *   read a 404 as "nothing found") pass through: core runs app middleware for them too.
 * - 401 is thrown with the code "AuthenticationError", as in Zapier's custom-auth example app
 *   (github.com/zapier/zapier-platform, example-apps/custom-auth/middleware.js).
 * - 429 never gets here: since core 18, a ThrottledError with the Retry-After delay is thrown
 *   before app middleware runs (packages/core/src/http-middlewares/after/throw-for-throttling.js).
 * - Responses from other origins are left to core's own status check.
 *
 * @param {Response} response
 * @param {ZObject} z
 */
function handleErrors(response, z) {
  if (response.skipThrowForStatus || response.status < 400) return response;
  if (!isApiUrl(response.request && response.request.url, apiBaseUrl())) return response;
  const { code, message } = describeApiError(response);
  if (response.status === 401) {
    throw new z.errors.Error(
      `${message} Check the API key of this Link To Card connection, or create a new key in the dashboard under API keys.`,
      'AuthenticationError',
      401,
    );
  }
  throw new z.errors.Error(message, code, response.status);
}

module.exports = { includeApiKey, handleErrors, describeApiError };
