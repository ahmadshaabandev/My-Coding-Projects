'use strict';

const { DEFAULT_BASE_URL } = require('./constants');

/** http:// is accepted only for these hosts, so `wrangler dev` can be tried with `zapier-platform invoke`. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The origin every request goes to: https://linktocard.com, or the LTC_BASE_URL environment
 * variable when it is set. Users never see or set it; Ahmad sets it on a version he alone uses
 * (`zapier-platform env:set <version> LTC_BASE_URL=...`) to try the app against staging, or in a
 * local .env for `zapier-platform invoke`.
 *
 * It is read on every call, not once at load, because Zapier provides a version's environment
 * variables at run time and the tests change it. A malformed value is an error, never a silent
 * fallback: requests (and the API key) must not go somewhere nobody chose.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} an origin without a trailing slash, e.g. "https://linktocard.com"
 */
function apiBaseUrl(env = process.env) {
  const raw = (env.LTC_BASE_URL || '').trim();
  if (raw === '') return DEFAULT_BASE_URL;

  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`LTC_BASE_URL is not a URL: "${raw.slice(0, 100)}".`);
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('LTC_BASE_URL must start with https:// (http:// only for localhost).');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('LTC_BASE_URL must be an origin only, like https://linktocard.com, without a path, query or credentials.');
  }
  return url.origin;
}

/**
 * Whether `url` is on the API's origin. The API key is only ever attached to such requests, and
 * the file hydrator only downloads from it.
 *
 * @param {string | undefined} url
 * @param {string} [base]
 */
function isApiUrl(url, base = apiBaseUrl()) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).origin === base;
  } catch {
    return false;
  }
}

/**
 * Absolute API URL for a path such as "/v1/images".
 *
 * @param {string} path
 */
function apiUrl(path) {
  return `${apiBaseUrl()}${path}`;
}

module.exports = { apiBaseUrl, apiUrl, isApiUrl };
