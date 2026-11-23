import { describe, expect, it } from 'vitest';
import worker, { canonicalUrl } from '../../redirect/www';

describe('www redirect Worker', () => {
  it('sends every www request to the same path and query on the main domain, permanently', () => {
    const response = worker.fetch(new Request('https://www.linktocard.com/docs/quickstart?from=x#top'));
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://linktocard.com/docs/quickstart?from=x#top');
  });

  it('also upgrades plain http and drops a port', () => {
    expect(canonicalUrl('http://www.linktocard.com:8080/')).toBe('https://linktocard.com/');
  });
});
