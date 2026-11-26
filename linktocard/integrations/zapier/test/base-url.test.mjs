// The API origin: linktocard.com unless LTC_BASE_URL (set only by the owner) says otherwise, and
// never a value that could send the API key somewhere unintended.
import { describe, expect, it } from 'vitest';
import { require } from './helpers.mjs';

const { apiBaseUrl, apiUrl, isApiUrl } = require('../lib/base-url');

describe('apiBaseUrl', () => {
  it('is https://linktocard.com without an override', () => {
    expect(apiBaseUrl({})).toBe('https://linktocard.com');
    expect(apiBaseUrl({ LTC_BASE_URL: '' })).toBe('https://linktocard.com');
    expect(apiBaseUrl({ LTC_BASE_URL: '   ' })).toBe('https://linktocard.com');
  });

  it('takes an https origin, with or without a trailing slash', () => {
    expect(apiBaseUrl({ LTC_BASE_URL: 'https://linktocard-staging.example.workers.dev' })).toBe('https://linktocard-staging.example.workers.dev');
    expect(apiBaseUrl({ LTC_BASE_URL: 'https://linktocard-staging.example.workers.dev/' })).toBe('https://linktocard-staging.example.workers.dev');
  });

  it('takes http only for a local wrangler dev', () => {
    expect(apiBaseUrl({ LTC_BASE_URL: 'http://localhost:8787' })).toBe('http://localhost:8787');
    expect(apiBaseUrl({ LTC_BASE_URL: 'http://127.0.0.1:8787' })).toBe('http://127.0.0.1:8787');
    expect(() => apiBaseUrl({ LTC_BASE_URL: 'http://linktocard.com' })).toThrow(/https/);
  });

  it.each([
    ['a path', 'https://linktocard.com/v1'],
    ['a query', 'https://linktocard.com/?x=1'],
    ['credentials', 'https://user:pass@linktocard.com'],
    ['another scheme', 'ftp://linktocard.com'],
    ['no URL at all', 'linktocard.com'],
  ])('refuses %s instead of guessing', (_what, value) => {
    expect(() => apiBaseUrl({ LTC_BASE_URL: value })).toThrow(/LTC_BASE_URL/);
  });

  it('is read at call time, so a version environment variable applies without a reload', () => {
    process.env.LTC_BASE_URL = 'https://staging.example';
    expect(apiUrl('/v1/usage')).toBe('https://staging.example/v1/usage');
    delete process.env.LTC_BASE_URL;
    expect(apiUrl('/v1/usage')).toBe('https://linktocard.com/v1/usage');
  });
});

describe('isApiUrl', () => {
  it('is true only for the same origin', () => {
    const base = 'https://linktocard.com';
    expect(isApiUrl('https://linktocard.com/i/u_1/abc.png', base)).toBe(true);
    expect(isApiUrl('https://linktocard.com:443/v1/usage', base)).toBe(true);
    expect(isApiUrl('https://www.linktocard.com/v1/usage', base)).toBe(false);
    expect(isApiUrl('https://linktocard.com.evil.example/v1/usage', base)).toBe(false);
    expect(isApiUrl('http://linktocard.com/v1/usage', base)).toBe(false);
    expect(isApiUrl('not a url', base)).toBe(false);
    expect(isApiUrl(undefined, base)).toBe(false);
  });
});
