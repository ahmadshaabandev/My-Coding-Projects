'use strict';

const { DEFAULT_BASE_URL } = require('./constants');
const { getJson } = require('./api');
const { apiBaseUrl } = require('./base-url');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * The name a connection gets in Zapier's list: the plan, plus the key's name when the API says it
 * (GET /v1/usage does not today; see the integration notes), plus the host whenever it is not
 * linktocard.com, so a version pointed at staging can never pass for the real one.
 *
 * @param {Record<string, unknown>} usage the GET /v1/usage answer
 * @param {string} base the API origin the connection talks to
 */
function connectionLabelFor(usage, base) {
  const plan = typeof usage.plan === 'string' && usage.plan !== '' ? `${usage.plan.charAt(0).toUpperCase()}${usage.plan.slice(1)} plan` : 'Link To Card';
  const key = /** @type {{ name?: unknown } | undefined} */ (usage.key);
  const name = key && typeof key.name === 'string' && key.name.trim() !== '' ? key.name.trim() : null;
  const label = name ? `${name} (${plan})` : plan;
  return base === DEFAULT_BASE_URL ? label : `${label} at ${new URL(base).host}`;
}

/**
 * GET /v1/usage proves the key works and counts nothing. It returns the parsed body, so the
 * label template reads its fields directly ("If you return `response.data` from your test, then
 * your label can be `{{X}}`": Zapier's custom-auth example app, authentication.js). The label is
 * computed here rather than in a label function because `zapier-platform invoke` cannot render
 * function labels locally (packages/cli/docs/cli.md, invoke limitations).
 *
 * @param {ZObject} z
 * @param {Bundle} _bundle
 */
async function test(z, _bundle) {
  const response = await getJson(z, '/v1/usage');
  const usage = /** @type {Record<string, unknown>} */ (response.data || {});
  return { ...usage, connection_label: connectionLabelFor(usage, apiBaseUrl()) };
}

/** Zapier's AuthenticationSchema: type "custom" is the API-key kind (no other settings needed). */
const authentication = {
  type: /** @type {const} */ ('custom'),
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      type: /** @type {const} */ ('password'),
      required: true,
      helpText:
        'Create a key in your [Link To Card dashboard](https://linktocard.com/dashboard) under **API keys**. It starts with `ltc_`. A key of its own for Zapier lets you revoke it without touching your other keys.',
    },
  ],
  test,
  connectionLabel: '{{connection_label}}',
};

module.exports = { authentication, connectionLabelFor };
