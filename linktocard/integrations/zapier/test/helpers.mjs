// Shared by the tests: the app under test, Zapier's app tester, nock bound to the API origin with
// the bearer key, and the fixtures the API would answer with. All keys and ids are dummies.
import { createRequire } from 'node:module';
import { expect } from 'vitest';

export const require = createRequire(import.meta.url);
export const nock = require('nock');
export const zapier = require('zapier-platform-core');
export const App = require('../index.js');
export const appTester = zapier.createAppTester(App);

export const BASE = 'https://linktocard.com';
export const API_KEY = 'ltc_test_not_a_real_key_0123456789';
export const authData = { api_key: API_KEY };

/** nock for the API origin that only matches requests carrying the connection's key. */
export function api(base = BASE) {
  return nock(base, { reqheaders: { authorization: `Bearer ${API_KEY}` } });
}

/** The { message, code, status } inside a Zapier AppError (its message is that JSON). */
export async function appError(promise) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the call to throw').toBeInstanceOf(Error);
  try {
    return { name: caught.name, ...JSON.parse(caught.message) };
  } catch {
    return { name: caught.name, message: caught.message };
  }
}

/** The method and data a z.dehydrateFile() pointer refers to. */
export function hydratePointer(value) {
  expect(value).toMatch(/^hydrate\|\|\|.*\|\|\|hydrate$/);
  return JSON.parse(value.slice('hydrate|||'.length, -'|||hydrate'.length));
}

/** The error envelope the API answers with (src/lib/errors.ts). */
export function apiError(code, message) {
  return { error: { code, message, docs: `${BASE}/docs/api#errors` } };
}

/** GET /v1/templates: the blog starter as the API lists it, and one template of the account's own. */
export const TEMPLATES = {
  starter: [
    {
      id: 'blog',
      name: 'Blog post',
      description: 'An article card.',
      fields: [
        { name: 'title', description: 'Headline of the article.', example: 'Design for the first glance', required: true },
        { name: 'description', description: 'One or two lines under the headline.', example: 'What people notice before they read a single word.', required: false },
        { name: 'theme', description: 'light (default) or dark.', example: 'light', required: false },
      ],
    },
  ],
  custom: [{ id: 't_launch01', name: 'Launch banner', version: 3, updated_at: '2026-11-20T10:00:00.000Z' }],
};

export const USAGE = {
  plan: 'starter',
  period_start: '2026-11-01T00:00:00.000Z',
  period_end: '2026-12-01T00:00:00.000Z',
  limit: 2000,
  used: 412,
  remaining: 1588,
  topup_remaining: 0,
  total_remaining: 1588,
  cache_days: 30,
  watermark: false,
};

export const IMAGE = {
  id: 'k'.repeat(64),
  url: `${BASE}/i/u_test/${'k'.repeat(64)}.png`,
  width: 1200,
  height: 630,
  format: 'png',
  bytes: 1234,
  cached: false,
  template: 'blog',
  created_at: '2026-11-26T09:00:00.000Z',
  expires_at: '2026-12-26T09:00:00.000Z',
  warnings: [],
  usage: USAGE,
};
