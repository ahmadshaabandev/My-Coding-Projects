'use strict';

const { getJson } = require('../lib/api');
const { optionalText } = require('../lib/data');
const { inputError } = require('../lib/errors');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */
/** @typedef {{ id?: string, status?: string, title?: string, detail?: string, fix?: string | null }} CheckItem */

/**
 * Counts and a plain list of what to fix, so a Filter, Paths or message step can use the result
 * without reading the `checks` line items one by one.
 *
 * @param {CheckItem[]} checks
 */
function summarise(checks) {
  const count = (/** @type {string} */ status) => checks.filter((check) => check.status === status).length;
  const problems = checks
    .filter((check) => check.status === 'fail' || check.status === 'warn')
    .map((check) => `${check.title}: ${check.fix || check.detail}`);
  const failCount = count('fail');
  return { pass_count: count('pass'), warn_count: count('warn'), fail_count: failCount, ok: failCount === 0, problems };
}

/**
 * GET /v1/inspect: one fetch of the page (or the cached result), the same JSON as the free link
 * checker. It counts no images; uncached checks count against the key's daily inspections.
 * A search must answer with a list, so the one result is wrapped.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const url = optionalText(bundle.inputData.url);
  if (url === undefined) throw inputError('Fill in the Page URL.');
  const response = await getJson(z, '/v1/inspect', { url });
  const result = response.data;
  return [{ ...result, ...summarise(Array.isArray(result.checks) ? result.checks : []) }];
}

const SAMPLE_CHECK = {
  id: 'chk_7q2m9x4k1v8c3d6e',
  url: 'https://fieldnotes.example/design-for-the-first-glance',
  final_url: 'https://fieldnotes.example/design-for-the-first-glance',
  status: 200,
  fetched_at: '2026-11-26T09:12:44.031Z',
  response_ms: 412,
  cached: false,
  expires_at: '2026-11-26T09:22:44.031Z',
  page: {
    title: 'Design for the first glance | Field Notes',
    description: 'What people notice before they read a single word.',
    canonical: 'https://fieldnotes.example/design-for-the-first-glance',
    favicon: 'https://fieldnotes.example/favicon.png',
    theme_color: '#1f6feb',
  },
  og: {
    title: 'Design for the first glance',
    description: 'What people notice before they read a single word.',
    image: null,
    image_alt: null,
    image_width: null,
    image_height: null,
    url: 'https://fieldnotes.example/design-for-the-first-glance',
    type: 'article',
    site_name: 'Field Notes',
  },
  twitter: { card: null, title: null, description: null, image: null, site: null },
  image: null,
  robots: { checked: true, allowed: true, note: null },
  checks: [
    {
      id: 'og_image',
      status: 'fail',
      title: 'og:image is missing',
      detail: 'The page has no og:image tag.',
      fix: 'Add <meta property="og:image" content="https://example.com/card.png"> to the page <head>, pointing at a 1200x630 PNG or JPEG.',
    },
    { id: 'og_title', status: 'pass', title: 'og:title is set', detail: 'og:title is 27 characters.', fix: null },
  ],
  preview: {
    title: 'Design for the first glance',
    description: 'What people notice before they read a single word.',
    domain: 'fieldnotes.example',
    site_name: 'Field Notes',
    image: null,
    favicon: 'https://fieldnotes.example/favicon.png',
  },
  pass_count: 1,
  warn_count: 0,
  fail_count: 1,
  ok: false,
  problems: ['og:image is missing: Add <meta property="og:image" content="https://example.com/card.png"> to the page <head>, pointing at a 1200x630 PNG or JPEG.'],
};

module.exports = {
  key: 'check_link_preview',
  noun: 'Link Preview',
  display: {
    label: 'Check Link Preview',
    description:
      "Checks a page's link-preview tags (Open Graph and Twitter card) and its preview image, with a fix for each problem it finds. Counts no images.",
  },
  operation: {
    inputFields: [{ key: 'url', label: 'Page URL', required: true, helpText: 'The `https://` address of the page to check.' }],
    perform,
    sample: SAMPLE_CHECK,
    outputFields: [
      { key: 'id', label: 'Check ID' },
      { key: 'ok', label: 'No Failed Checks', type: 'boolean' },
      { key: 'fail_count', label: 'Failed Checks', type: 'integer' },
      { key: 'warn_count', label: 'Warnings', type: 'integer' },
      { key: 'pass_count', label: 'Passed Checks', type: 'integer' },
      { key: 'problems', label: 'Problems and Fixes', list: true },
      { key: 'final_url', label: 'Page URL After Redirects' },
      { key: 'status', label: 'HTTP Status', type: 'integer' },
      { key: 'preview__title', label: 'Preview Title' },
      { key: 'preview__description', label: 'Preview Description' },
      { key: 'preview__image', label: 'Preview Image URL' },
      { key: 'cached', label: 'Result From Cache', type: 'boolean' },
    ],
  },
};
