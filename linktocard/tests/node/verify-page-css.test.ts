// The certificate verification page (src/batch/verify-page.ts) is served by the Worker with its
// own Content-Security-Policy: same-origin styles, images and fonts only. It links the site's
// stylesheet, so that stylesheet must load nothing from elsewhere (and no data: images, which the
// page's img-src does not allow). Here because the Workers test pool turns CSS imports into empty
// strings. Also: robots.txt must leave /v/ crawlable, or crawlers could not read the page's noindex.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

describe('what the verification page relies on in the static site', () => {
  it('site.css imports nothing and loads only same-origin files', () => {
    const css = read('site/public/assets/css/site.css');
    expect(css).not.toMatch(/@import/i);
    const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\/(?!\/)/);
  });

  it('robots.txt does not disallow /v/ (noindex works only on pages a crawler may fetch)', () => {
    const disallowed = [...read('site/public/robots.txt').matchAll(/^\s*Disallow:\s*(\S*)/gim)].map((match) => match[1]!);
    for (const rule of disallowed) {
      if (rule === '') continue;
      const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const pattern = new RegExp(`^${escaped}`);
      expect(pattern.test('/v/crt_0123456789abcdefghjk'), rule).toBe(false);
    }
  });
});
