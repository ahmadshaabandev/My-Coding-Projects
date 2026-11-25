// The browser call (src/pdf/render.ts), the image inliner (src/pdf/assets.ts) and the page
// setup (src/pdf/page.ts), without the HTTP routes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { inlineRemoteAssets, isOwnHost } from '../src/pdf/assets';
import {
  EMPTY_TEMPLATE,
  FREE_MARK_HTML,
  contentDisposition,
  headerFooter,
  marginToMm,
  parseFilename,
  parseMargin,
  sanitizeFilename,
  withMarkRoom,
} from '../src/pdf/page';
import { browserError, pdfEnabled, printPdf, quickActionOptions, type PrintRequest } from '../src/pdf/render';
import { dohAnswer, requestUrl } from './app-helpers';
import { browserErrorResponse, mockBrowser, pdfResponse } from './pdf-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: PrintRequest = {
  html: '<!doctype html><html><head><meta charset="utf-8"><style></style></head><body><p>x</p></body></html>',
  setup: { format: 'a4', landscape: false, margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } },
  headerFooter: { displayHeaderFooter: false },
};

describe('quickActionOptions', () => {
  it('are exactly the documented options', () => {
    expect(quickActionOptions(REQUEST)).toEqual({
      html: REQUEST.html,
      setJavaScriptEnabled: false,
      allowRequestPattern: ['^data:'],
      cacheTTL: 0,
      gotoOptions: { waitUntil: 'load', timeout: PDF.renderTimeoutMs },
      pdfOptions: {
        format: 'a4',
        landscape: false,
        margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
        printBackground: true,
        displayHeaderFooter: false,
        pageRanges: `1-${PDF.maxPages + 1}`,
        timeout: PDF.renderTimeoutMs,
        preferCSSPageSize: false,
        tagged: false,
        outline: false,
      },
    });
  });

  it('never carry url, addScriptTag, addStyleTag, cookies or headers, whatever the request', () => {
    const options = quickActionOptions({ ...REQUEST, headerFooter: headerFooter('<b>h</b>', '<i>f</i>', true) }) as unknown as Record<string, unknown>;
    for (const key of ['url', 'addScriptTag', 'addStyleTag', 'cookies', 'setExtraHTTPHeaders', 'authenticate', 'rejectRequestPattern']) {
      expect(options).not.toHaveProperty(key);
    }
    expect(options).toMatchObject({ setJavaScriptEnabled: false, allowRequestPattern: ['^data:'], cacheTTL: 0 });
  });

  it('pass the header and footer templates only with displayHeaderFooter', () => {
    const options = quickActionOptions({ ...REQUEST, headerFooter: headerFooter(null, '<p>f</p>', false) });
    expect(options.pdfOptions).toMatchObject({ displayHeaderFooter: true, headerTemplate: EMPTY_TEMPLATE, footerTemplate: '<p>f</p>' });
  });
});

describe('printPdf', () => {
  it('measures every call, so attempts without X-Browser-Ms-Used still have a length', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const slow = mockBrowser(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return browserErrorResponse(500, 'Navigation timeout of 30000 ms exceeded', null);
    });
    const timedOut = await printPdf(slow.binding, REQUEST);
    expect(timedOut).toMatchObject({ status: 500, browserMs: null });
    expect(timedOut.wallMs).toBeGreaterThanOrEqual(25);
    const thrown = await printPdf(mockBrowser(() => Promise.reject(new Error('boom'))).binding, REQUEST);
    expect(thrown).toMatchObject({ status: 0, browserMs: null });
    expect(typeof thrown.wallMs).toBe('number');
  });

  it('returns the bytes, the page count and X-Browser-Ms-Used', async () => {
    const browser = mockBrowser(() => pdfResponse('3-pages', 2500));
    const outcome = await printPdf(browser.binding, REQUEST);
    expect(outcome).toMatchObject({ status: 200, browserMs: 2500, pages: 3, error: null });
    expect(outcome.bytes?.byteLength).toBeGreaterThan(1000);
    expect(browser.calls).toEqual([{ action: 'pdf', options: quickActionOptions(REQUEST) }]);
  });

  it('refuses more than PDF.maxPages pages with template_error, keeping the browser time', async () => {
    const outcome = await printPdf(mockBrowser(() => pdfResponse('51-pages', 9000)).binding, REQUEST);
    expect(outcome).toMatchObject({ status: 200, browserMs: 9000, pages: 51 });
    expect(outcome.error).toMatchObject({ code: 'template_error', status: 422 });
    expect(outcome.error?.message).toContain(`more than ${PDF.maxPages} pages`);
  });

  it('treats a PDF whose page count cannot be read as a failed render, not as zero pages', async () => {
    const broken = new Response('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF', { headers: { 'content-type': 'application/pdf', 'x-browser-ms-used': '700' } });
    const outcome = await printPdf(mockBrowser(() => broken).binding, REQUEST);
    expect(outcome).toMatchObject({ status: 200, browserMs: 700, pages: null });
    expect(outcome.error).toMatchObject({ code: 'render_failed', status: 500 });
  });

  it('treats a 200 that is not application/pdf as a failed render', async () => {
    const html = new Response('<html></html>', { headers: { 'content-type': 'text/html', 'x-browser-ms-used': '10' } });
    expect((await printPdf(mockBrowser(() => html).binding, REQUEST)).error).toMatchObject({ code: 'render_failed' });
  });

  it.each([
    [400, 'Invalid margin', 'render_failed', 500],
    [422, 'Unable to render', 'template_error', 422],
    [429, 'Rate limit exceeded', 'rate_limited', 429],
    [500, 'Internal error', 'render_failed', 500],
    [503, 'Service unavailable', 'render_failed', 500],
    [422, 'Navigation timeout of 30000 ms exceeded', 'render_timeout', 504],
  ])('maps a browser %i "%s" to %s', async (status, message, code, ourStatus) => {
    const outcome = await printPdf(mockBrowser(() => browserErrorResponse(status, message, status < 500 ? 40 : null)).binding, REQUEST);
    expect(outcome).toMatchObject({ status, browserMs: status < 500 ? 40 : null, bytes: null, pages: null });
    expect(outcome.error).toMatchObject({ code, status: ourStatus });
    if (code !== 'rate_limited' && code !== 'render_timeout') expect(outcome.error?.message).toContain(message);
  });

  it('makes a busy browser retryable', () => {
    const error = browserError(429, 'too many');
    expect(error.headers).toEqual({ 'retry-after': expect.stringMatching(/^\d+$/) });
  });

  it('turns a thrown call into render_failed without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const browser = mockBrowser(() => Promise.reject(new Error('binding exploded')));
    expect(await printPdf(browser.binding, REQUEST)).toMatchObject({ status: 0, browserMs: null, error: { code: 'render_failed' } });
  });

  it('ignores an X-Browser-Ms-Used header that is not a number', async () => {
    const response = pdfResponse('1-page');
    response.headers.set('x-browser-ms-used', 'soon');
    expect((await printPdf(mockBrowser(() => response).binding, REQUEST)).browserMs).toBeNull();
  });
});

describe('pdfEnabled (kill switch)', () => {
  const browser = mockBrowser().binding;
  it('needs PDF_ENABLED "true" and a binding', () => {
    expect(pdfEnabled({ PDF_ENABLED: 'true', BROWSER: browser })).toBe(true);
    expect(pdfEnabled({ PDF_ENABLED: 'false', BROWSER: browser })).toBe(false);
    expect(pdfEnabled({ PDF_ENABLED: 'TRUE', BROWSER: browser })).toBe(false);
    expect(pdfEnabled({ PDF_ENABLED: undefined, BROWSER: browser })).toBe(false);
    expect(pdfEnabled({ PDF_ENABLED: 'true', BROWSER: undefined })).toBe(false);
  });
});

describe('page setup', () => {
  it.each([
    ['12mm', 12],
    ['1.5cm', 15],
    ['0.5in', 12.7],
    ['96px', 25.4],
    ['0', 0],
    [' 20MM ', 20],
  ])('reads margin %s as %f mm', (value, mm) => {
    expect(marginToMm(value, 'top')).toBe(mm);
  });

  it.each(['12', '12pt', '-1mm', 'calc(1mm)', '12 mm', 12])('refuses margin %s', (value) => {
    expect(() => marginToMm(value, 'top')).toThrow(ApiError);
  });

  it(`refuses a margin over ${PDF.maxMarginMm}mm`, () => {
    expect(() => marginToMm(`${PDF.maxMarginMm + 1}mm`, 'left')).toThrow(`at most ${PDF.maxMarginMm}mm`);
    expect(marginToMm(`${PDF.maxMarginMm}mm`, 'left')).toBe(PDF.maxMarginMm);
  });

  it('overrides the defaults side by side, and refuses unknown sides', () => {
    expect(parseMargin({ top: '1in' }, null)).toEqual({ top: '25.4mm', right: `${PDF.defaultMarginMm}mm`, bottom: `${PDF.defaultMarginMm}mm`, left: `${PDF.defaultMarginMm}mm` });
    expect(parseMargin(undefined, { top: '10mm', right: '1cm', bottom: '20mm', left: '0' })).toEqual({ top: '10mm', right: '10mm', bottom: '20mm', left: '0mm' });
    expect(() => parseMargin({ middle: '1mm' }, null)).toThrow('Unknown margin field');
  });

  it(`raises the bottom margin to ${PDF.freeMarkMinBottomMm}mm for the free mark, and never lowers it`, () => {
    const setup = { format: 'a4' as const, landscape: false, margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' } };
    expect(withMarkRoom(setup).margin).toEqual({ top: '5mm', right: '5mm', bottom: `${PDF.freeMarkMinBottomMm}mm`, left: '5mm' });
    const roomy = { ...setup, margin: { ...setup.margin, bottom: '30mm' } };
    expect(withMarkRoom(roomy)).toBe(roomy);
  });
});

describe('free mark', () => {
  it(`is "${PDF.freeMark}" in Chrome's footer, below the customer's footer`, () => {
    expect(FREE_MARK_HTML).toContain(`>${PDF.freeMark}</div>`);
    expect(headerFooter(null, null, true)).toEqual({ displayHeaderFooter: true, headerTemplate: EMPTY_TEMPLATE, footerTemplate: FREE_MARK_HTML });
    // The customer's header and footer each sit in a box they cannot paint outside of, sized
    // to the margin; the mark is outside the footer's box, after it.
    const box = (maxHeight: string, html: string): string => `<div style="position:relative;width:100%;max-height:${maxHeight};overflow:hidden;contain:layout paint">${html}</div>`;
    expect(headerFooter('<b>h</b>', '<i>f</i>', true, { top: '20mm', bottom: '22mm' })).toEqual({
      displayHeaderFooter: true,
      headerTemplate: box('16mm', '<b>h</b>'),
      footerTemplate: `<div style="width:100%">${box('13mm', '<i>f</i>')}${FREE_MARK_HTML}</div>`,
    });
    // A margin with no room left for them gives the boxes no height at all, never a negative one.
    expect(headerFooter('<b>h</b>', '<i>f</i>', true, { top: '0', bottom: `${PDF.freeMarkMinBottomMm}mm` }).headerTemplate).toBe(box('0mm', '<b>h</b>'));
  });

  it('draws the mark on its own white background, so no colour under it can hide it', () => {
    expect(FREE_MARK_HTML).toMatch(/<div style="[^"]*background:#fff[^"]*">Made with Link To Card<\/div><\/div>$/);
    expect(FREE_MARK_HTML).toContain('z-index:2147483647');
  });

  it('keeps its own size and grey: Chrome would otherwise darken light text when printing', () => {
    expect(FREE_MARK_HTML).toContain('font-size:7.5pt');
    expect(FREE_MARK_HTML).toContain('color:#6b7280');
    expect(FREE_MARK_HTML).toContain('-webkit-print-color-adjust:exact;print-color-adjust:exact');
  });

  it('is absent without the mark; no header and no footer turns header/footer printing off', () => {
    expect(headerFooter(null, null, false)).toEqual({ displayHeaderFooter: false });
    expect(headerFooter('<b>h</b>', null, false)).toEqual({ displayHeaderFooter: true, headerTemplate: '<b>h</b>', footerTemplate: EMPTY_TEMPLATE });
  });
});

describe('download names', () => {
  it.each([
    ['invoice-2026-001.pdf', 'invoice-2026-001.pdf'],
    ['Invoice 2026/001', 'Invoice 2026-001.pdf'],
    ['Rechnung Müller & Söhne.PDF', 'Rechnung Muller - Sohne.pdf'],
    ['"quoted"\\name\r\n.pdf', 'quoted-name.pdf'],
    ['../../etc/passwd', 'etc-passwd.pdf'],
    ['.hidden', 'hidden.pdf'],
    ['報告書', 'fallback.pdf'],
    ['', 'fallback.pdf'],
  ])('%j -> %j', (input, output) => {
    expect(sanitizeFilename(input, 'fallback.pdf')).toBe(output);
  });

  it(`are at most ${PDF.maxFilenameChars} characters and always end in .pdf`, () => {
    const name = sanitizeFilename('a'.repeat(500), 'x.pdf');
    expect(name).toHaveLength(PDF.maxFilenameChars);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('only ASCII without quotes, slashes or control characters reaches Content-Disposition', () => {
    for (const input of ['a"b', 'a\\b', 'a/b', 'a\u0000b', 'a\u202eb', 'ünïcödé', 'tab\there']) {
      expect(sanitizeFilename(input, 'x.pdf')).toMatch(/^[A-Za-z0-9 ._()-]+\.pdf$/);
    }
    expect(contentDisposition('inline', 'a b.pdf')).toBe('inline; filename="a b.pdf"');
  });

  it('come from "filename" or the default, and refuse a non-string', () => {
    expect(parseFilename(undefined, 'invoice.pdf')).toBe('invoice.pdf');
    expect(() => parseFilename(42, 'invoice.pdf')).toThrow('"filename" must be text');
  });
});

describe('inlineRemoteAssets', () => {
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

  function mockNetwork(images: Record<string, () => Response>): string[] {
    const fetched: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.hostname === 'cloudflare-dns.com') return dohAnswer(url);
      fetched.push(url.href);
      const respond = images[url.href];
      if (!respond) throw new Error(`unexpected request ${url.href}`);
      return respond();
    });
    return fetched;
  }

  it('downloads each image through the guarded fetcher and returns data: URIs', async () => {
    const fetched = mockNetwork({ 'https://cdn.example.com/a.png': () => new Response(PNG.slice(), { headers: { 'content-type': 'image/png' } }) });
    const inlined = await inlineRemoteAssets(['https://cdn.example.com/a.png'], { appUrl: 'https://linktocard.test' });
    expect(inlined.get('https://cdn.example.com/a.png')).toMatch(/^data:image\/png;base64,/);
    expect(fetched).toEqual(['https://cdn.example.com/a.png']);
  });

  it.each(['https://linktocard.com/i/u/x.png', 'https://www.linktocard.com/logo.png', 'https://linktocard-staging.names-on-base.workers.dev/v1/og/s/x.png', 'https://app.linktocard.test/x.png'])(
    'refuses our own host %s without a request',
    async (url) => {
      const fetched = mockNetwork({});
      const error = await inlineRemoteAssets([url], { appUrl: 'https://app.linktocard.test' }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'image_fetch_failed', details: { reason: 'blocked_host', url } });
      expect(fetched).toEqual([]);
    },
  );

  it('refuses a redirect to our own host', async () => {
    mockNetwork({ 'https://cdn.example.com/r.png': () => new Response(null, { status: 302, headers: { location: 'https://linktocard.com/i/u/k.png' } }) });
    const error = await inlineRemoteAssets(['https://cdn.example.com/r.png'], { appUrl: 'https://linktocard.test' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'image_fetch_failed' });
  });

  it('refuses private addresses like every customer image', async () => {
    const error = await inlineRemoteAssets(['http://127.0.0.1/a.png'], { appUrl: 'https://linktocard.test' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'image_fetch_failed', details: { reason: 'blocked_host' } });
  });

  it(`refuses images that add up to more than ${PDF.maxAssetBytes / (1024 * 1024)} MB`, async () => {
    // A real 1x1 PNG padded with trailing bytes: valid to the fetcher, just large.
    const padded = new Uint8Array(PDF.maxAssetBytes / 2 + 1);
    padded.set(PNG);
    const big = (): Response => new Response(padded.slice(), { headers: { 'content-type': 'image/png' } });
    mockNetwork({ 'https://cdn.example.com/1.png': big, 'https://cdn.example.com/2.png': big });
    const error = await inlineRemoteAssets(['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'], { appUrl: 'https://linktocard.test' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'template_error', details: { limit: PDF.maxAssetBytes } });
  });

  /** A PNG of `size` bytes streamed in 256 KB chunks with no content-length; tracks the bytes read by downloads still open. */
  function streamingImages(size: number): { fetchImpl: typeof fetch; peakOpenBytes: () => number } {
    const png = new Uint8Array(size);
    png.set(PNG);
    let open = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (sent >= size) {
            open -= sent;
            controller.close();
            return;
          }
          const chunk = png.slice(sent, sent + 256 * 1024);
          sent += chunk.byteLength;
          open += chunk.byteLength;
          peak = Math.max(peak, open);
          controller.enqueue(chunk);
        },
        cancel() {
          open -= sent;
        },
      });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, peakOpenBytes: () => peak };
  }
  const resolveHost = async (): Promise<string[]> => ['93.184.216.34'];

  it(`never has more than ${PDF.maxAssetBytes / (1024 * 1024)} MB of images in flight, across its parallel downloads`, async () => {
    const { fetchImpl, peakOpenBytes } = streamingImages(9 * 1024 * 1024);
    const urls = Array.from({ length: 8 }, (_, i) => `https://img${i}.example.org/big.png`);
    const error = await inlineRemoteAssets(urls, { appUrl: 'https://linktocard.test', fetchOptions: { fetchImpl, resolveHost, timeoutMs: 60_000 } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'template_error', details: { limit: PDF.maxAssetBytes } });
    // Each of the 4 parallel downloads notices it is over its share a chunk or two late (the
    // stream reads one chunk ahead). Before the shares, all four could read 9 MB each.
    expect(peakOpenBytes()).toBeLessThanOrEqual(PDF.maxAssetBytes + 4 * 2 * 256 * 1024);
  });

  it('still takes one image larger than a parallel download\'s share, alone, within the total', async () => {
    const { fetchImpl, peakOpenBytes } = streamingImages(6 * 1024 * 1024);
    const inlined = await inlineRemoteAssets(['https://img.example.org/big.png'], { appUrl: 'https://linktocard.test', fetchOptions: { fetchImpl, resolveHost, timeoutMs: 60_000 } });
    expect(inlined.get('https://img.example.org/big.png')).toMatch(/^data:image\/png;base64,/);
    expect(peakOpenBytes()).toBeLessThanOrEqual(PDF.maxAssetBytes);
  });

  it('knows our hosts', () => {
    expect(isOwnHost('LINKTOCARD.COM.', 'http://localhost:8787')).toBe(true);
    expect(isOwnHost('notlinktocard.com', 'http://localhost:8787')).toBe(false);
    expect(isOwnHost('localhost', 'http://localhost:8787')).toBe(true);
  });
});
