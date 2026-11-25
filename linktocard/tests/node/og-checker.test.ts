// The OG checker page (/tools/og-checker): the pure functions of
// site/public/assets/js/og-checker.js (preview text per platform, the sign-up
// link, input and error handling), the dashboard's ?title= prefill, and static
// checks on the built page (no inline script or style, in the sitemap, CSP,
// redirect, nothing that parses third-party text as HTML).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-25T12:00:00Z');
const JS = join(ROOT, 'site/public/assets/js');
// The rule safeNextPath (src/auth/magic-link.ts) applies to a sign-in's next path. It is
// restated here because that module needs Workers types the Node project does not have.
const safeNext = (path: string | null): boolean => path !== null && path.length <= 512 && /^\/(?![/\\])[\x21-\x7e]*$/.test(path);

type Platform = 'facebook' | 'x' | 'whatsapp' | 'slack' | 'discord' | 'imessage';
interface Problem {
  code: string | null;
  title: string;
  message: string;
  retryAt: Date | null;
  siteKey: string | null;
}
interface Checker {
  PLATFORMS: { id: Platform; name: string }[];
  PREVIEW_LIMITS: Record<Platform, { title: number; description: number }>;
  CTA_TEXT: string;
  API_PATH: string;
  truncate(text: unknown, max: number): string;
  previewText(platform: string, preview: unknown): { title: string; description: string; domain: string; siteName: string };
  ctaHref(title: unknown): string;
  ctaTitle(result: unknown): string;
  normaliseInput(value: unknown): { url?: string; error?: string };
  shareUrl(url: string): string;
  checkRequestUrl(url: string, token?: string | null): string;
  proxySrc(path: unknown): string | null;
  safeColour(value: unknown): string | null;
  retryAfterSeconds(header: unknown, now?: Date): number | null;
  describeError(status: number, body: unknown, options?: { retryAfter?: number | null; now?: Date }): Problem;
  verdict(checks: unknown): { tone: string; title: string; text: string };
  sortChecks(checks: unknown): { id: string; status: string }[];
  formatBytes(bytes: number): string | null;
  formatRatio(ratio: number): string | null;
  tagRows(result: unknown): [string, string | null][];
}
interface DashboardHelpers {
  prefillFromQuery(search: string): { title?: string };
  MAX_PREFILL_TITLE: number;
}

let checker: Checker;
let helpers: DashboardHelpers;
beforeAll(async () => {
  checker = (await import(pathToFileURL(join(JS, 'og-checker.js')).href)) as Checker;
  helpers = (await import(pathToFileURL(join(JS, 'dashboard/helpers.js')).href)) as DashboardHelpers;
});

const apiError = (code: string, message = 'Server says no.', details?: Record<string, unknown>) => ({
  error: { code, message, docs: 'https://linktocard.com/docs/api#errors', ...(details ? { details } : {}) },
});

describe('preview text per platform', () => {
  const long = 'Abcdefghij'.repeat(50);

  it('covers the six mockups the contract names, each with a budget', () => {
    expect(checker.PLATFORMS.map((p) => p.id)).toEqual(['facebook', 'x', 'whatsapp', 'slack', 'discord', 'imessage']);
    for (const { id } of checker.PLATFORMS) expect(checker.PREVIEW_LIMITS[id].title).toBeGreaterThan(0);
  });

  it('cuts each platform to its own budget and ends a cut text with an ellipsis', () => {
    for (const { id } of checker.PLATFORMS) {
      const limits = checker.PREVIEW_LIMITS[id];
      const text = checker.previewText(id, { title: long, description: long, domain: 'example.com', site_name: null });
      expect(Array.from(text.title).length, id).toBe(limits.title);
      expect(text.title.endsWith('…'), id).toBe(true);
      if (limits.description === 0) expect(text.description, id).toBe('');
      else expect(Array.from(text.description).length, id).toBeLessThanOrEqual(limits.description);
      expect(text.domain).toBe('example.com');
    }
  });

  it('gives different platforms different lengths, and leaves short text alone', () => {
    const lengths = new Set(checker.PLATFORMS.map(({ id }) => checker.previewText(id, { title: long, domain: 'a.b' }).title.length));
    expect(lengths.size).toBeGreaterThan(3);
    expect(checker.previewText('slack', { title: '  Short   title ', domain: 'a.b' }).title).toBe('Short title');
  });

  it('never splits an emoji or a surrogate pair, and survives broken input', () => {
    expect(checker.truncate('\u{1F600}'.repeat(10), 5)).toBe(`${'\u{1F600}'.repeat(4)}…`);
    expect(checker.truncate('abc\uD800def', 10)).toBe('abc�def');
    expect(checker.truncate(null, 10)).toBe('');
    expect(checker.truncate('abc', 0)).toBe('');
    expect(checker.previewText('x', null)).toEqual({ title: '', description: '', domain: '', siteName: '' });
    expect(() => checker.previewText('myspace', {})).toThrow();
  });
});

describe('the "Fix it automatically" link', () => {
  const titleFrom = (href: string): string | null => {
    const next = new URLSearchParams(href.slice(href.indexOf('?'))).get('next') ?? '';
    return new URLSearchParams(next.slice(next.indexOf('?') + 1)).get('title');
  };

  it('is /login?next=%2Fdashboard%3Ftitle%3D<encoded title>', () => {
    expect(checker.ctaHref('Hello')).toBe('/login?next=%2Fdashboard%3Ftitle%3DHello');
    expect(checker.ctaHref('My post & more')).toBe(`/login?next=${encodeURIComponent(`/dashboard?title=${encodeURIComponent('My post & more')}`)}`);
    expect(titleFrom(checker.ctaHref('My post & more ?#'))).toBe('My post & more ?#');
    expect(checker.CTA_TEXT).toBe('Fix it automatically: generate a correct card with Link To Card');
  });

  it('falls back to the plain dashboard without a title', () => {
    expect(checker.ctaHref('')).toBe('/login?next=%2Fdashboard');
    expect(checker.ctaHref(null)).toBe('/login?next=%2Fdashboard');
    expect(checker.ctaHref('   ')).toBe('/login?next=%2Fdashboard');
  });

  it('keeps the next path acceptable to the sign-in redirect check, however long or non-Latin the title', () => {
    for (const title of ['Plain title', 'x'.repeat(5000), 'مرحبا '.repeat(300), '\u{1F680}'.repeat(400), 'a\uDC00b']) {
      const href = checker.ctaHref(title);
      const next = new URLSearchParams(href.slice(href.indexOf('?'))).get('next');
      expect(safeNext(next), title.slice(0, 20)).toBe(true);
      expect(titleFrom(href)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('carries the title the previews show, else og:title, else <title>', () => {
    expect(checker.ctaTitle({ preview: { title: 'P' }, og: { title: 'O' }, page: { title: 'T' } })).toBe('P');
    expect(checker.ctaTitle({ preview: { title: null }, og: { title: 'O' }, page: { title: 'T' } })).toBe('O');
    expect(checker.ctaTitle({ preview: {}, og: {}, page: { title: 'T' } })).toBe('T');
    expect(checker.ctaTitle(null)).toBe('');
  });

  it('pre-fills the dashboard guide from ?title=, trimmed and capped', () => {
    expect(helpers.prefillFromQuery('?title=My%20post%20%26%20more')).toEqual({ title: 'My post & more' });
    expect(helpers.prefillFromQuery('?title=%20%20')).toEqual({});
    expect(helpers.prefillFromQuery('')).toEqual({});
    expect(Array.from(helpers.prefillFromQuery(`?title=${'\u{1F680}'.repeat(500)}`).title ?? '').length).toBe(helpers.MAX_PREFILL_TITLE);
  });
});

describe('input, request and safe values', () => {
  it('adds https:// when no scheme is typed and refuses http, other schemes and over-long URLs', () => {
    expect(checker.normaliseInput('  example.com/post ')).toEqual({ url: 'https://example.com/post' });
    expect(checker.normaliseInput('https://example.com')).toEqual({ url: 'https://example.com' });
    expect(checker.normaliseInput('').error).toMatch(/Paste a page URL/);
    expect(checker.normaliseInput('http://example.com').error).toMatch(/https/);
    expect(checker.normaliseInput('javascript:alert(1)').error).toBeTruthy();
    expect(checker.normaliseInput(`https://example.com/${'a'.repeat(2048)}`).error).toMatch(/2,048/);
  });

  it('builds the API and share URLs the contract names', () => {
    expect(checker.checkRequestUrl('https://e.com/a?b=c')).toBe('/api/tools/og-check?url=https%3A%2F%2Fe.com%2Fa%3Fb%3Dc');
    expect(checker.checkRequestUrl('https://e.com', 'tok.en')).toBe('/api/tools/og-check?url=https%3A%2F%2Fe.com&turnstile=tok.en');
    expect(checker.shareUrl('https://e.com/a b')).toBe('/tools/og-checker?url=https%3A%2F%2Fe.com%2Fa+b');
  });

  it('shows images only from our own proxy path and colours only as plain hex', () => {
    expect(checker.proxySrc('/api/tools/og-check/chk_0123456789abcdef/image')).toBe('/api/tools/og-check/chk_0123456789abcdef/image');
    expect(checker.proxySrc('/api/tools/og-check/chk_0123456789abcdef/favicon')).not.toBeNull();
    for (const bad of ['https://evil.example/x.png', '//evil.example/x', '/api/tools/og-check/chk_1/image?u=x', 'javascript:x', null]) {
      expect(checker.proxySrc(bad)).toBeNull();
    }
    expect(checker.safeColour('#ff5a26')).toBe('#ff5a26');
    expect(checker.safeColour('red; background:url(x)')).toBeNull();
    expect(checker.safeColour('rgb(1,2,3)')).toBeNull();
  });

  it('formats image facts', () => {
    expect(checker.formatBytes(512)).toBe('512 bytes');
    expect(checker.formatBytes(1_234_567)).toBe('1.2 MB (1,234,567 bytes)');
    expect(checker.formatRatio(1.9047)).toBe('1.90:1');
    expect(checker.formatRatio(Number.NaN)).toBeNull();
    const rows = checker.tagRows({ og: { title: 'T', image_width: '1200' }, twitter: {}, page: { theme_color: '#fff' } });
    expect(rows.map(([name]) => name)).toEqual(expect.arrayContaining(['og:title', 'twitter:card', '<title>', 'meta description', 'canonical', 'theme-color', 'favicon']));
    expect(rows.find(([name]) => name === 'og:title')?.[1]).toBe('T');
    expect(rows.find(([name]) => name === 'twitter:card')?.[1]).toBeNull();
  });
});

describe('error messages', () => {
  it('has a friendly message for each error code in the contract', () => {
    const invalid = checker.describeError(400, apiError('invalid_request', 'The url must use https.'));
    expect(invalid).toMatchObject({ code: 'invalid_request', message: 'The url must use https.' });
    expect(checker.describeError(400, apiError('invalid_request', '')).message).toMatch(/https:\/\//);

    const forbidden = checker.describeError(403, apiError('forbidden', 'Resolved to 10.0.0.1'));
    expect(forbidden.title).toMatch(/public internet/);
    expect(forbidden.message).not.toContain('10.0.0.1');

    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'timeout' })).message).toMatch(/in time/);
    // The reasons src/inspect/fetch.ts sends (FetchFailureReason), plus a few spellings of the same thing.
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'dns_failed' })).message).toMatch(/domain name/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'connect_failed' })).message).toMatch(/connection/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'insecure_redirect' })).message).toMatch(/http:\/\//);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'bad_redirect' })).message).toMatch(/valid URL/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'too_large' })).message).toMatch(/larger/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'http_error', status: 503 })).message).toMatch(/HTTP 503/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'dns' })).message).toMatch(/domain name/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'tls' })).message).toMatch(/certificate/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'not_html' })).message).toMatch(/not an HTML page/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'too_many_redirects' })).message).toMatch(/redirected/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'x', { reason: 'http_status', status: 404 })).message).toMatch(/HTTP 404/);
    expect(checker.describeError(422, apiError('page_fetch_failed', 'The site said no.', { reason: 'something_new' })).message).toBe('The site said no.');
  });

  it('says when to retry after a 429, from Retry-After', () => {
    const problem = checker.describeError(429, apiError('rate_limited'), { retryAfter: 1500, now: NOW });
    expect(problem.code).toBe('rate_limited');
    expect(problem.retryAt?.toISOString()).toBe('2026-11-25T12:25:00.000Z');
    expect(problem.message).toMatch(/in about 25 minutes/);
    expect(checker.describeError(429, null, { now: NOW }).message).toMatch(/minute/);
    expect(checker.retryAfterSeconds('120')).toBe(120);
    expect(checker.retryAfterSeconds('Wed, 25 Nov 2026 12:10:00 GMT', NOW)).toBe(600);
    expect(checker.retryAfterSeconds(null)).toBeNull();
    expect(checker.retryAfterSeconds('soon')).toBeNull();
  });

  it('asks for Turnstile only with a site key', () => {
    expect(checker.describeError(403, apiError('verification_required', 'x', { site_key: '0x4AAA' }))).toMatchObject({ code: 'verification_required', siteKey: '0x4AAA' });
    expect(checker.describeError(403, apiError('verification_required', 'x')).siteKey).toBeNull();
  });

  it('covers no answer, server errors and unknown bodies', () => {
    expect(checker.describeError(0, null).code).toBe('network');
    expect(checker.describeError(502, '<html>').message).toMatch(/HTTP 502/);
    expect(checker.describeError(418, { error: 'teapot' }).message).toMatch(/HTTP 418/);
  });
});

describe('verdict and checklist order', () => {
  const checks = [
    { id: 'og_image', status: 'pass' },
    { id: 'robots', status: 'warn' },
    { id: 'og_title', status: 'fail' },
    { id: 'twitter_card', status: 'warn' },
  ];
  it('puts failures first and keeps the API order within a group', () => {
    expect(checker.sortChecks(checks).map((check) => check.id)).toEqual(['og_title', 'robots', 'twitter_card', 'og_image']);
  });
  it('sums up fails and warnings', () => {
    expect(checker.verdict(checks)).toMatchObject({ tone: 'fail', title: '1 problem to fix, 2 warnings.' });
    expect(checker.verdict(checks.filter((c) => c.status !== 'fail'))).toMatchObject({ tone: 'warn' });
    expect(checker.verdict([{ status: 'pass' }])).toMatchObject({ tone: 'ok', title: 'Ready to share.' });
  });
});

describe('the built page', () => {
  let site: RenderedSite;
  let html: string;
  beforeAll(() => {
    site = renderSite({ env: {}, now: NOW });
    html = site.pages.find((page) => page.outPath === 'tools/og-checker.html')?.html ?? '';
  });

  it('renders at /tools/og-checker with its script, one URL field and one button', () => {
    expect(html).toContain('<script type="module" src="/assets/js/og-checker.js"></script>');
    expect(html).toContain('<label class="label" for="check-url">Paste a page URL</label>');
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html.match(/<button class="btn/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://linktocard.com/tools/og-checker">');
  });

  it('has no inline script, inline handler or inline style', () => {
    expect(html.match(/<script\b(?![^>]*\ssrc=)[^>]*>/g)).toBeNull();
    expect(html.match(/<[a-z][^>]*\son[a-z]+\s*=/g)).toBeNull();
    expect(html.match(/<[a-z][^>]*\sstyle\s*=/g)).toBeNull();
    expect(html).not.toMatch(/<style\b/);
  });

  it('is in the sitemap, with the /bot page', () => {
    expect(site.sitemap).toContain('<loc>https://linktocard.com/tools/og-checker</loc>');
    expect(site.sitemap).toContain('<loc>https://linktocard.com/bot</loc>');
    const bot = site.pages.find((page) => page.outPath === 'bot.html')?.html ?? '';
    expect(bot).toContain('LinkToCardBot/1.0 (+https://linktocard.com/bot)');
    expect(bot).toContain('mailto:support@linktocard.com');
  });

  it('allows Turnstile in the CSP and redirects the old path', () => {
    const headers = readFileSync(join(ROOT, 'site/public/_headers'), 'utf8');
    const csp = headers.split('\n').find((line) => line.trim().startsWith('Content-Security-Policy:')) ?? '';
    expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/img-src 'self' data: blob: https:\/\/\*\.paddle\.com;/);
    const redirects = readFileSync(join(ROOT, 'site/public/_redirects'), 'utf8');
    expect(redirects.split('\n').map((line) => line.trim())).toContain('/tools/og-image-checker /tools/og-checker 301');
  });

  it('never turns third-party text into HTML in the page script', () => {
    const source = readFileSync(join(JS, 'og-checker.js'), 'utf8');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
    // The only other origin the script loads from is Turnstile; example.com appears in help text only.
    const origins = new Set(source.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g));
    expect([...origins].sort()).toEqual(['https://challenges.cloudflare.com', 'https://example.com']);
    expect(source).toContain(checker.API_PATH);
  });
});
