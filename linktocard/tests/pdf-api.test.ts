// The PDF endpoints end to end through the Worker, with a mock Browser Run binding:
// POST /v1/pdf, GET /i/{user}/{key}.pdf, signed GET /v1/pdf/..., the kill switch, quota,
// the free mark, browser_usage, rate limits, /api/config and /api/me.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { PDF, RATE_LIMITS, pdfUnits } from '../src/config';
import { all, first, run } from '../src/db/client';
import type { BrowserUsageRow, Env, RateLimitBinding } from '../src/types';
import {
  apiKeyFor,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  dohAnswer,
  errorOf,
  requestUrl,
  sessionCookieFor,
  setUsed,
  usageOf,
  userRow,
} from './app-helpers';
import { resetFreeBrake } from '../src/pdf/guard';
import { browserErrorResponse, footerOf, mockBrowser, pdfEnv, pdfResponse, postPdf, signedPdfPath, type MockBrowser } from './pdf-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const INVOICE_DATA = { seller_name: 'Fernhill Studio', buyer_name: 'Acme Ltd', invoice_number: 'INV-1', issue_date: '25 Nov 2026', total: '100.00', items: [{ description: 'Design', amount: '100.00' }] };
let seq = 0;
/** Unique data, so no two tests share a cache key. */
const unique = (data: Record<string, unknown> = {}): Record<string, unknown> => ({ ...data, note_id: `n${++seq}` });

async function account(plan: 'free' | 'starter' = 'free'): Promise<{ userId: string; secret: string; keyId: string }> {
  const user = await createUser(plan);
  const key = await apiKeyFor(user.id);
  return { userId: user.id, secret: key.secret, keyId: key.id };
}

const browserRows = (userId: string): Promise<BrowserUsageRow[]> => all<BrowserUsageRow>(env.DB, 'SELECT * FROM browser_usage WHERE user_id = ?1 ORDER BY created_at, id', userId);
const ledgerCount = async (userId: string): Promise<number> => (await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM renders WHERE user_id = ?1', userId))!.n;

interface PdfJson {
  id: string;
  url: string;
  pages: number;
  bytes: number;
  credits_used: number;
  cached: boolean;
  template: string;
  filename: string;
  created_at: string;
  expires_at: string;
  warnings: string[];
  usage: { used: number; plan: string };
}

describe('kill switch', () => {
  const routes = async (bindings: Env): Promise<Response[]> => {
    const { secret } = await account();
    const site = await createSite((await createUser()).id);
    return [
      await postPdf(secret, { template: 'invoice' }, bindings),
      await call(await signedPdfPath(site, 'invoice', { a: '1' }), {}, bindings),
      await call('/i/u_x/' + '0'.repeat(64) + '.pdf', {}, bindings),
      await call('/api/tools/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tool":"invoice"}' }, bindings),
    ];
  };

  it.each([
    ['PDF_ENABLED is "false"', (browser: MockBrowser) => pdfEnv(browser, { PDF_ENABLED: 'false' })],
    ['PDF_ENABLED is missing', (browser: MockBrowser) => pdfEnv(browser, { PDF_ENABLED: undefined })],
    ['the BROWSER binding is missing', () => pdfEnv(undefined)],
  ])('every PDF endpoint answers 503 not_configured when %s', async (_label, bindings) => {
    const browser = mockBrowser();
    for (const response of await routes(bindings(browser))) {
      expect(response.status).toBe(503);
      const error = await errorOf(response);
      expect(error).toMatchObject({ code: 'not_configured', message: 'PDF rendering is not enabled yet.' });
    }
    expect(browser.calls).toEqual([]);
  });

  it('/api/config reports pdf_enabled only with PDF_ENABLED "true" and the binding', async () => {
    const enabled = async (bindings: Env): Promise<unknown> => ((await (await call('/api/config', {}, bindings)).json()) as { pdf_enabled: unknown }).pdf_enabled;
    expect(await enabled(pdfEnv(mockBrowser()))).toBe(true);
    expect(await enabled(pdfEnv(mockBrowser(), { PDF_ENABLED: 'false' }))).toBe(false);
    expect(await enabled(env)).toBe(false);
  });
});

describe('POST /v1/pdf', () => {
  it('renders a starter template, charges pdfUnits(pages), records the browser time and answers with a URL', async () => {
    const { userId, secret } = await account();
    const browser = mockBrowser(() => pdfResponse('1-page', 1500));
    const response = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA) }, pdfEnv(browser));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PdfJson;
    expect(body).toMatchObject({ pages: 1, credits_used: pdfUnits(1), cached: false, template: 'invoice', filename: 'invoice.pdf', warnings: [] });
    expect(body.id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.url).toBe(`${env.APP_URL}/i/${userId}/${body.id}.pdf`);
    expect(body.usage).toMatchObject({ plan: 'free', used: pdfUnits(1) });
    expect(Date.parse(body.expires_at) - Date.parse(body.created_at)).toBe(PLANS.free.cacheDays * 86_400_000);

    expect(browser.calls).toHaveLength(1);
    const { options } = browser.calls[0]!;
    expect(options).toMatchObject({ setJavaScriptEnabled: false, allowRequestPattern: ['^data:'], cacheTTL: 0 });
    expect(options).not.toHaveProperty('url');
    expect(options).not.toHaveProperty('addScriptTag');
    expect((options as { html: string }).html).toContain('Fernhill Studio');

    expect(await browserRows(userId)).toMatchObject([{ source: 'api', status: 200, browser_ms: 1500, pages: 1 }]);
    expect((await usageOf(userId)).used).toBe(pdfUnits(1));
  });

  it('serves an identical request from storage: cached, 0 credits, no browser call', async () => {
    const { userId, secret } = await account();
    const browser = mockBrowser();
    const request = { template: 'invoice', data: unique(INVOICE_DATA) };
    const first = (await (await postPdf(secret, request, pdfEnv(browser))).json()) as PdfJson;
    const again = (await (await postPdf(secret, request, pdfEnv(browser))).json()) as PdfJson;
    expect(again).toMatchObject({ id: first.id, cached: true, credits_used: 0, pages: 1 });
    expect(browser.calls).toHaveLength(1);
    expect((await usageOf(userId)).used).toBe(pdfUnits(1));
  });

  it('counts a 12-page PDF as 3 images and reports PDFs separately in /api/me', async () => {
    const { userId, secret } = await account();
    const response = await postPdf(secret, { html: '<p>{{x}}</p>', data: unique() }, pdfEnv(mockBrowser(() => pdfResponse('12-pages'))));
    expect((await response.json()) as PdfJson).toMatchObject({ pages: 12, credits_used: 3, template: 'inline', filename: 'document.pdf' });
    const me = (await (await dashboard(await sessionCookieFor(userId), 'GET', '/api/me')).json()) as { usage: { used: number; pdf: unknown } };
    expect(me.usage).toMatchObject({ used: 3, pdf: { count: 1, images: 3 } });
  });

  it('answers with the bytes: inline Content-Disposition, page count, credits and cache headers', async () => {
    const { secret } = await account();
    const browser = mockBrowser(() => pdfResponse('3-pages'));
    const request = { template: 'invoice', data: unique(INVOICE_DATA), filename: 'Invoice 2026/001 "final"', response: 'binary' };
    const response = await postPdf(secret, request, pdfEnv(browser));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="Invoice 2026-001 -final.pdf"');
    expect(response.headers.get('x-ltc-pages')).toBe('3');
    expect(response.headers.get('x-ltc-credits-used')).toBe('2');
    expect(response.headers.get('x-ltc-cache')).toBe('miss');
    expect(response.headers.get('x-ltc-pdf-url')).toMatch(/\/i\/u_[a-z0-9]+\/[0-9a-f]{64}\.pdf$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe('%PDF-');

    const again = await postPdf(secret, request, pdfEnv(browser));
    expect(again.headers.get('x-ltc-cache')).toBe('hit');
    expect(again.headers.get('x-ltc-credits-used')).toBe('0');
    expect((await again.arrayBuffer()).byteLength).toBe(bytes.byteLength);
  });

  it('puts the free mark in the footer of a Free account, with room for it, and not for Starter', async () => {
    const free = await account('free');
    const freeBrowser = mockBrowser();
    await postPdf(free.secret, { html: '<p>x</p>', data: unique(), pdf: { margin: { bottom: '5mm' } } }, pdfEnv(freeBrowser));
    const freeOptions = freeBrowser.calls[0]!.options;
    expect(freeOptions.pdfOptions).toMatchObject({ displayHeaderFooter: true, margin: { bottom: `${PDF.freeMarkMinBottomMm}mm` } });
    expect(footerOf(freeOptions)).toContain(PDF.freeMark);

    const starter = await account('starter');
    const starterBrowser = mockBrowser();
    await postPdf(starter.secret, { html: '<p>x</p>', data: unique(), pdf: { margin: { bottom: '5mm' } } }, pdfEnv(starterBrowser));
    const starterOptions = starterBrowser.calls[0]!.options;
    expect(starterOptions.pdfOptions).toMatchObject({ displayHeaderFooter: false, margin: { bottom: '5mm' } });
    expect(JSON.stringify(starterOptions)).not.toContain(PDF.freeMark);
  });

  it('does not serve a marked PDF after an upgrade: the mark is part of the cache key', async () => {
    const { userId, secret } = await account('free');
    const browser = mockBrowser();
    const request = { template: 'invoice', data: unique(INVOICE_DATA) };
    const before = (await (await postPdf(secret, request, pdfEnv(browser))).json()) as PdfJson;
    await run(env.DB, "UPDATE users SET plan = 'starter' WHERE id = ?1", userId);
    const after = (await (await postPdf(secret, request, pdfEnv(browser))).json()) as PdfJson;
    expect(after.cached).toBe(false);
    expect(after.id).not.toBe(before.id);
    expect(footerOf(browser.calls[1]!.options) ?? '').not.toContain(PDF.freeMark);
  });

  it('passes the customer header and footer, sanitised, with the mark below the footer on Free', async () => {
    const { secret } = await account();
    const browser = mockBrowser();
    const pdf = { header: '<div onclick="x()">{{seller_name}}<script>1</script></div>', footer: '<div>Page <span class="pageNumber"></span></div>' };
    await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA), pdf }, pdfEnv(browser));
    const { pdfOptions } = browser.calls[0]!.options;
    // Next to the mark, each customer part sits in a box it cannot paint outside of (src/pdf/page.ts).
    expect(pdfOptions?.headerTemplate).toMatch(/^<div style="[^"]*contain:layout paint[^"]*"><div>Fernhill Studio<\/div><\/div>$/);
    expect(pdfOptions?.footerTemplate).toContain('<div>Page <span class="pageNumber"></span></div>');
    expect(pdfOptions?.footerTemplate).toContain(PDF.freeMark);
  });

  it('removes header and footer stylesheets on Free, so they cannot hide the mark; paid plans keep them', async () => {
    const pdf = {
      header: '<style>#footer{display:none!important}</style><span>Acme</span>',
      footer: '<style>div[style*="6b7280"]{display:none!important}</style><div style="font-size:8px">Page <span class="pageNumber"></span></div>',
    };
    const free = await account('free');
    const browser = mockBrowser();
    const response = await postPdf(free.secret, { template: 'invoice', data: unique(INVOICE_DATA), pdf }, pdfEnv(browser));
    expect(((await response.json()) as PdfJson).warnings).toEqual(expect.arrayContaining([expect.stringContaining('<style> in the header was removed')]));
    const options = browser.calls[0]!.options.pdfOptions!;
    expect(`${options.headerTemplate}${options.footerTemplate}`).not.toMatch(/<style/i);
    expect(options.footerTemplate).toContain('<div style="font-size:8px">Page <span class="pageNumber"></span></div>');
    expect(options.footerTemplate).toContain(PDF.freeMark);

    const paid = await account('starter');
    const paidBrowser = mockBrowser();
    await postPdf(paid.secret, { template: 'invoice', data: unique(INVOICE_DATA), pdf }, pdfEnv(paidBrowser));
    expect(paidBrowser.calls[0]!.options.pdfOptions!.headerTemplate).toBe('<style>#footer{display:none!important;}</style><span>Acme</span>');
  });

  it('applies format, landscape and margins, and the template defaults otherwise', async () => {
    const { secret } = await account('starter');
    const browser = mockBrowser();
    await postPdf(secret, { template: 'certificate', data: unique() }, pdfEnv(browser));
    await postPdf(secret, { template: 'invoice', data: unique(), pdf: { format: 'letter', landscape: true, margin: { top: '1in', left: '0' } } }, pdfEnv(browser));
    expect(browser.calls[0]!.options.pdfOptions).toMatchObject({ landscape: true });
    expect(browser.calls[1]!.options.pdfOptions).toMatchObject({ format: 'letter', landscape: true, margin: { top: '25.4mm', left: '0mm' } });
  });

  it('renders a custom template of the account; someone else\'s is 404', async () => {
    const { userId, secret } = await account();
    const templateId = await createTemplate(await sessionCookieFor(userId), '<div>{{title}}</div>', '');
    const browser = mockBrowser();
    const response = await postPdf(secret, { template: templateId, data: unique({ title: 'Mine' }) }, pdfEnv(browser));
    expect(((await response.json()) as PdfJson).template).toBe(templateId);
    expect((browser.calls[0]!.options as { html: string }).html).toContain('Mine');

    const other = await account();
    const refused = await postPdf(other.secret, { template: templateId }, pdfEnv(browser));
    expect(refused.status).toBe(404);
  });

  it.each([
    ['both template and html', { template: 'invoice', html: '<p>x</p>' }, 'exactly one of'],
    ['neither', { data: {} }, 'exactly one of'],
    ['css with a template', { template: 'invoice', css: 'p{}' }, '"css" can only be sent together with "html"'],
    ['an unknown field', { template: 'invoice', size: 'og' }, 'Unknown field "size"'],
    ['an unknown pdf field', { template: 'invoice', pdf: { scale: 2 } }, 'Unknown field "pdf.scale"'],
    ['a bad format', { template: 'invoice', pdf: { format: 'legal' } }, '"format" must be one of'],
    ['a margin over the cap', { template: 'invoice', pdf: { margin: { top: '61mm' } } }, 'at most'],
    ['a bad response mode', { template: 'invoice', response: 'json' }, '"response" must be "url"'],
    ['bad data', { template: 'invoice', data: { paid: true } }, 'Send true/false as text'],
  ])('refuses %s with 400 and renders nothing', async (_label, body, message) => {
    const { secret } = await account();
    const browser = mockBrowser();
    const response = await postPdf(secret, body, pdfEnv(browser));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain(message);
    expect(browser.calls).toEqual([]);
  });

  it('answers 404 for an unknown template and 401 without a key', async () => {
    const { secret } = await account();
    expect((await postPdf(secret, { template: 'bank-statement' }, pdfEnv(mockBrowser()))).status).toBe(404);
    expect((await postPdf('ltc_not_a_key', { template: 'invoice' }, pdfEnv(mockBrowser()))).status).toBe(401);
  });

  it(`caps the body at ${PDF.maxRequestBodyBytes} bytes`, async () => {
    const { secret } = await account();
    const response = await postPdf(secret, { html: `<p>${'x'.repeat(PDF.maxRequestBodyBytes)}</p>` }, pdfEnv(mockBrowser()));
    expect(response.status).toBe(413);
  });

  it('answers 422 for markup it refuses, before calling the browser and without charging', async () => {
    const { userId, secret } = await account();
    const browser = mockBrowser();
    const response = await postPdf(secret, { html: '<p>x</p>', css: '@import url(https://evil.example/x.css);', data: unique() }, pdfEnv(browser));
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe('template_error');
    expect(browser.calls).toEqual([]);
    expect(await browserRows(userId)).toEqual([]);
    expect((await usageOf(userId)).used).toBe(0);
  });

  it('inlines remote images before the browser runs, and refuses our own hosts', async () => {
    const { secret } = await account();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.hostname === 'cloudflare-dns.com') return dohAnswer(url);
      if (url.href === 'https://cdn.example.com/logo.png') return new Response(png.slice(), { headers: { 'content-type': 'image/png' } });
      throw new Error(`unexpected request ${url.href}`);
    });
    const browser = mockBrowser();
    const ok = await postPdf(secret, { html: '<img src="{{logo}}"><div style="background:url({{logo}})"></div>', data: unique({ logo: 'https://cdn.example.com/logo.png' }) }, pdfEnv(browser));
    expect(ok.status).toBe(200);
    const html = (browser.calls[0]!.options as { html: string }).html;
    expect(html).not.toContain('cdn.example.com');
    expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+">/);

    const own = await postPdf(secret, { html: '<img src="https://linktocard.com/i/u_x/k.png">', data: unique() }, pdfEnv(browser));
    expect(own.status).toBe(422);
    expect(await errorOf(own)).toMatchObject({ code: 'image_fetch_failed', details: { reason: 'blocked_host' } });
    expect(browser.calls).toHaveLength(1);
  });
});

describe('POST /v1/pdf: failed renders are recorded and never charged', () => {
  it.each([
    ['a browser 400', () => browserErrorResponse(400, 'bad options'), 500, 'render_failed', 400, 50],
    ['a browser 422', () => browserErrorResponse(422, 'could not render'), 422, 'template_error', 422, 50],
    ['a busy browser (429)', () => browserErrorResponse(429, 'rate limited'), 429, 'rate_limited', 429, 50],
    ['a browser 500', () => browserErrorResponse(500, 'crashed', null), 500, 'render_failed', 500, null],
    ['a browser 503', () => browserErrorResponse(503, 'unavailable', null), 500, 'render_failed', 503, null],
  ] as const)('%s', async (_label, respond, status, code, browserStatus, browserMs) => {
    const { userId, secret } = await account();
    const response = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA) }, pdfEnv(mockBrowser(respond)));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).code).toBe(code);
    if (code === 'rate_limited') expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await browserRows(userId)).toMatchObject([{ status: browserStatus, browser_ms: browserMs, pages: null }]);
    expect((await usageOf(userId)).used).toBe(0);
    expect(await ledgerCount(userId)).toBe(0);
  });

  it('a 51-page PDF is 422 "more than 50 pages", not charged, its browser time recorded', async () => {
    const { userId, secret } = await account();
    const response = await postPdf(secret, { template: 'report', data: unique() }, pdfEnv(mockBrowser(() => pdfResponse('51-pages', 8000))));
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe('template_error');
    expect(error.message).toContain(`more than ${PDF.maxPages} pages`);
    expect(await browserRows(userId)).toMatchObject([{ status: 200, browser_ms: 8000, pages: 51 }]);
    expect((await usageOf(userId)).used).toBe(0);
    expect(await ledgerCount(userId)).toBe(0);
  });

  it('a PDF without a readable page count is 500 render_failed, not charged, recorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { userId, secret } = await account();
    const broken = (): Response => new Response('%PDF-1.4\n%%EOF', { headers: { 'content-type': 'application/pdf', 'x-browser-ms-used': '900' } });
    const response = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA) }, pdfEnv(mockBrowser(broken)));
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('render_failed');
    expect(await browserRows(userId)).toMatchObject([{ status: 200, browser_ms: 900, pages: null }]);
    expect((await usageOf(userId)).used).toBe(0);
  });
});

describe('POST /v1/pdf: quota', () => {
  it(`is 402 without rendering when fewer than ${PDF.baseUnits} images are left`, async () => {
    const { userId, secret } = await account();
    await setUsed(await userRow(userId), PLANS.free.monthlyImages - 1);
    const browser = mockBrowser();
    const response = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA) }, pdfEnv(browser));
    expect(response.status).toBe(402);
    const error = await errorOf(response);
    expect(error.code).toBe('quota_exceeded');
    expect(error.details).toMatchObject({ usage: { plan: 'free', remaining: 1 }, units_needed: PDF.baseUnits });
    expect(browser.calls).toEqual([]);
  });

  it('is 402 after rendering when the real page count needs more than is left: no PDF, no charge, browser time kept', async () => {
    const { userId, secret } = await account();
    await setUsed(await userRow(userId), PLANS.free.monthlyImages - 2);
    const browser = mockBrowser(() => pdfResponse('12-pages', 3000));
    const response = await postPdf(secret, { template: 'report', data: unique(), response: 'binary' }, pdfEnv(browser));
    expect(response.status).toBe(402);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await errorOf(response)).details).toMatchObject({ units_needed: 3, usage: { remaining: 2 } });
    expect(browser.calls).toHaveLength(1);
    expect(await browserRows(userId)).toMatchObject([{ status: 200, browser_ms: 3000, pages: 12 }]);
    expect((await usageOf(userId)).used).toBe(PLANS.free.monthlyImages - 2);
    expect(await ledgerCount(userId)).toBe(0);
    expect((await env.BUCKET.list({ prefix: `r/${userId}/` })).objects).toEqual([]);
  });
});

describe('POST /v1/pdf: identical requests racing for the last images', () => {
  // A pending ledger row is not a paid one: the request that claimed it may find that the block
  // does not fit and release it. Identical requests must never be served (or stored) off it.
  it(`answers 402 to every one of 8 identical 12-page requests with ${PDF.baseUnits} images left, and stores nothing`, async () => {
    const { userId, secret } = await account();
    await setUsed(await userRow(userId), PLANS.free.monthlyImages - 2);
    const browser = mockBrowser(() => pdfResponse('12-pages', 3000));
    const bindings = pdfEnv(browser);
    const body = { template: 'report', data: unique({ title: 'Race' }) };
    const responses = await Promise.all(Array.from({ length: 8 }, () => postPdf(secret, body, bindings)));
    const statuses = await Promise.all(responses.map(async (response) => `${response.status}/${(await errorOf(response)).code}`));
    expect(statuses).toEqual(Array.from({ length: 8 }, () => '402/quota_exceeded'));
    expect((await usageOf(userId)).used).toBe(PLANS.free.monthlyImages - 2);
    expect(await ledgerCount(userId)).toBe(0);
    expect((await env.BUCKET.list({ prefix: `r/${userId}/` })).objects).toEqual([]);
    // A later lone request is not a cache hit either.
    expect((await postPdf(secret, body, bindings)).status).toBe(402);
  });

  it('charges exactly one of 8 identical requests that fit, and serves the others the paid PDF', async () => {
    const { userId, secret } = await account();
    const browser = mockBrowser(() => pdfResponse('12-pages', 3000));
    const bindings = pdfEnv(browser);
    const body = { template: 'report', data: unique({ title: 'Race' }) };
    const responses = await Promise.all(Array.from({ length: 8 }, () => postPdf(secret, body, bindings)));
    const results = await Promise.all(responses.map(async (response) => ({ status: response.status, body: (await response.json()) as PdfJson })));
    expect(results.map((result) => result.status)).toEqual(Array.from({ length: 8 }, () => 200));
    expect(results.map((result) => result.body.credits_used).sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 3]);
    expect((await usageOf(userId)).used).toBe(3);
    expect(await all(env.DB, 'SELECT charged_to FROM renders WHERE user_id = ?1', userId)).toEqual([{ charged_to: 'plan' }]);
  });

  it('does not serve a PDF whose ledger row another request still holds unpaid', async () => {
    const { userId, secret } = await account();
    const browser = mockBrowser(() => pdfResponse('1-page'));
    const bindings = pdfEnv(browser);
    const body = { template: 'invoice', data: unique(INVOICE_DATA) };
    // The first request stores the PDF; its R2 object and ledger row are then replaced by a
    // pending claim, as if an identical request were in the middle of charging it.
    const paid = (await (await postPdf(secret, body, bindings)).json()) as PdfJson;
    await env.BUCKET.delete(`r/${userId}/${paid.id}.pdf`);
    await run(env.DB, "UPDATE renders SET charged_to = 'pending', created_at = ?1, expires_at = ?2 WHERE cache_key = ?3", Date.now() + 60_000, Date.now() + 86_400_000, paid.id);
    // The request waits for the holder: while the row is pending it neither renders nor serves or stores anything.
    const pending = postPdf(secret, body, bindings);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(browser.calls).toHaveLength(1);
    expect((await env.BUCKET.list({ prefix: `r/${userId}/` })).objects).toEqual([]);
    // The holder releases the row (its block did not fit): the waiting request charges the PDF itself.
    await run(env.DB, 'DELETE FROM renders WHERE cache_key = ?1', paid.id);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(((await response.json()) as PdfJson).credits_used).toBe(pdfUnits(1));
    expect(browser.calls).toHaveLength(2);
    // When the holder never finishes, the wait ends in 429 rate_limited: tests/pdf-ledger.test.ts.
  });

  it('takes over a pending row whose request has been gone for minutes, and charges it', async () => {
    const { userId, secret } = await account();
    const bindings = pdfEnv(mockBrowser(() => pdfResponse('1-page')));
    const body = { template: 'invoice', data: unique(INVOICE_DATA) };
    const paid = (await (await postPdf(secret, body, bindings)).json()) as PdfJson;
    await env.BUCKET.delete(`r/${userId}/${paid.id}.pdf`);
    await run(env.DB, "UPDATE renders SET charged_to = 'pending', created_at = ?1 WHERE cache_key = ?2", Date.now() - 10 * 60_000, paid.id);
    const response = await postPdf(secret, body, bindings);
    expect(response.status).toBe(200);
    expect(((await response.json()) as PdfJson).credits_used).toBe(pdfUnits(1));
    expect(await all(env.DB, 'SELECT charged_to FROM renders WHERE user_id = ?1', userId)).toEqual([{ charged_to: 'plan' }]);
    expect((await env.BUCKET.list({ prefix: `r/${userId}/` })).objects).toHaveLength(1);
  });
});

describe('GET /i/{user}/{key}.pdf', () => {
  async function stored(filename?: string): Promise<{ userId: string; body: PdfJson }> {
    const { userId, secret } = await account();
    const response = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA), ...(filename ? { filename } : {}) }, pdfEnv(mockBrowser()));
    return { userId, body: (await response.json()) as PdfJson };
  }

  it('serves the stored PDF inline under the file name it was rendered with', async () => {
    const { body } = await stored('rechnung-1.pdf');
    const path = new URL(body.url).pathname;
    const response = await call(path, {}, pdfEnv(mockBrowser()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="rechnung-1.pdf"');
    expect(response.headers.get('x-ltc-pages')).toBe('1');
    expect(response.headers.get('etag')).toBe(`"${body.id}"`);
    expect(response.headers.get('cache-control')).toMatch(/^public, max-age=\d+$/);
    expect((await response.arrayBuffer()).byteLength).toBe(body.bytes);

    const head = await call(path, { method: 'HEAD' }, pdfEnv(mockBrowser()));
    expect(head.headers.get('content-length')).toBe(String(body.bytes));
    const notModified = await call(path, { headers: { 'if-none-match': `"${body.id}"` } }, pdfEnv(mockBrowser()));
    expect(notModified.status).toBe(304);
  });

  it('is 404 when expired, unknown or malformed, and 403 for a suspended account', async () => {
    const { userId, body } = await stored();
    const path = new URL(body.url).pathname;
    expect((await call(`/i/${userId}/${'f'.repeat(64)}.pdf`, {}, pdfEnv(mockBrowser()))).status).toBe(404);
    expect((await call(`/i/${userId}/nothex.pdf`, {}, pdfEnv(mockBrowser()))).status).toBe(404);
    await run(env.DB, 'UPDATE users SET suspended_at = 1 WHERE id = ?1', userId);
    expect((await call(path, {}, pdfEnv(mockBrowser()))).status).toBe(403);
    await run(env.DB, 'UPDATE users SET suspended_at = NULL WHERE id = ?1', userId);
    const object = await env.BUCKET.get(`r/${userId}/${body.id}.pdf`);
    await env.BUCKET.put(`r/${userId}/${body.id}.pdf`, await object!.arrayBuffer(), { customMetadata: { ...object!.customMetadata, expiresAt: '1' } });
    expect((await call(path, {}, pdfEnv(mockBrowser()))).status).toBe(404);
  });

  it('leaves image URLs alone', async () => {
    expect((await call(`/i/u_nobody/${'a'.repeat(64)}.png`, {}, pdfEnv(mockBrowser()))).status).toBe(404);
  });
});

describe('signed GET /v1/pdf/{site}/{template}.pdf', () => {
  async function signedAccount(plan: 'free' | 'starter' = 'free') {
    const user = await createUser(plan);
    const site = await createSite(user.id);
    return { user, site };
  }

  it('renders on the first request, then serves from storage; inline with the default file name', async () => {
    const { user, site } = await signedAccount();
    const browser = mockBrowser();
    const path = await signedPdfPath(site, 'invoice', { seller_name: 'Fernhill', invoice_number: `S-${++seq}` });
    const response = await call(path, {}, pdfEnv(browser));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="invoice.pdf"');
    expect(response.headers.get('x-ltc-cache')).toBe('miss');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await browserRows(user.id)).toMatchObject([{ source: 'signed' }]);
    expect((await usageOf(user.id)).used).toBe(2);

    // The query in another order is the same signed link (and not the edge copy).
    const [pathname, query] = path.split('?');
    const reordered = `${pathname}?${query!.split('&').reverse().join('&')}`;
    const again = await call(reordered, {}, pdfEnv(browser));
    expect(again.headers.get('x-ltc-cache')).toBe('hit');
    expect(browser.calls).toHaveLength(1);
    expect((await usageOf(user.id)).used).toBe(2);
  });

  it('reads format, landscape, filename and items (a JSON list) as reserved parameters', async () => {
    const { site } = await signedAccount('starter');
    const browser = mockBrowser();
    const items = JSON.stringify([{ description: 'Signed item', amount: '9.00' }]);
    const path = await signedPdfPath(site, 'invoice', { buyer_name: 'Acme', format: 'letter', landscape: 'true', filename: 'acme invoice', items, n: `${++seq}` });
    const response = await call(path, {}, pdfEnv(browser));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('inline; filename="acme invoice.pdf"');
    const { options } = browser.calls[0]!;
    expect(options.pdfOptions).toMatchObject({ format: 'letter', landscape: true });
    expect((options as { html: string }).html).toContain('Signed item');
  });

  it.each([
    ['a tampered signature', (path: string) => path.replace(/sig=([0-9a-f])/, (_m, d: string) => `sig=${d === '0' ? '1' : '0'}`), 'signature_mismatch'],
    ['a missing signature', (path: string) => path.replace(/&sig=[0-9a-f]+/, ''), 'missing_sig'],
    ['an extra parameter', (path: string) => `${path}&extra=1`, 'signature_mismatch'],
    ['a changed items parameter', (path: string) => path.replace(/items=[^&]+/, `items=${encodeURIComponent('[{"description":"free"}]')}`), 'signature_mismatch'],
  ])('is 403 invalid_signature for %s, before any render', async (_label, tamper, reason) => {
    const { user, site } = await signedAccount();
    const browser = mockBrowser();
    const path = await signedPdfPath(site, 'invoice', { buyer_name: 'Acme', items: JSON.stringify([{ description: 'x' }]), n: `${++seq}` });
    const response = await call(tamper(path), {}, pdfEnv(browser));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_signature', details: { reason } });
    expect(browser.calls).toEqual([]);
    expect(await browserRows(user.id)).toEqual([]);
  });

  it('is 400 for an items parameter that is not JSON, and 404 for an unknown site or template', async () => {
    const { site } = await signedAccount();
    expect((await call(await signedPdfPath(site, 'invoice', { items: 'not json' }), {}, pdfEnv(mockBrowser()))).status).toBe(400);
    expect((await call(await signedPdfPath(site, 'payslip', { a: '1' }), {}, pdfEnv(mockBrowser()))).status).toBe(404);
    expect((await call(`/v1/pdf/s_unknown/invoice.pdf?sig=${'0'.repeat(64)}`, {}, pdfEnv(mockBrowser()))).status).toBe(404);
    expect((await call('/v1/pdf/bad', {}, pdfEnv(mockBrowser()))).status).toBe(404);
  });

  it('HEAD renders nothing', async () => {
    const { user, site } = await signedAccount();
    const browser = mockBrowser();
    const head = await call(await signedPdfPath(site, 'invoice', { n: `${++seq}` }), { method: 'HEAD' }, pdfEnv(browser));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/pdf');
    expect(browser.calls).toEqual([]);
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('carries the free mark for a Free account', async () => {
    const { site } = await signedAccount('free');
    const browser = mockBrowser();
    await call(await signedPdfPath(site, 'receipt', { n: `${++seq}` }), {}, pdfEnv(browser));
    expect(footerOf(browser.calls[0]!.options)).toContain(PDF.freeMark);
  });
});

describe('rate limits', () => {
  function limiter(allow: boolean): { binding: RateLimitBinding; keys: string[] } {
    const keys: string[] = [];
    return { keys, binding: { limit: ({ key }) => (keys.push(key), Promise.resolve({ success: allow })) } };
  }
  const limited = (browser: MockBrowser, overrides: Partial<Env>): Env => pdfEnv(browser, { RATE_LIMITS_DISABLED: '0', ...overrides });

  it('RL_PDF_KEY limits POST /v1/pdf per API key', async () => {
    const { secret, keyId } = await account('starter');
    const perKey = limiter(false);
    const browser = mockBrowser();
    const response = await postPdf(secret, { template: 'invoice', data: unique() }, limited(browser, { RL_IP: limiter(true).binding, RL_PDF_KEY: perKey.binding }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_PDF_KEY.periodSeconds));
    expect(perKey.keys).toEqual([keyId]);
    expect(browser.calls).toEqual([]);
  });

  it('RL_PDF_FREE limits renders of a Free account, not of Starter', async () => {
    const free = await account('free');
    const perAccount = limiter(false);
    const allow = { RL_IP: limiter(true).binding, RL_PDF_KEY: limiter(true).binding };
    const refused = await postPdf(free.secret, { template: 'invoice', data: unique() }, limited(mockBrowser(), { ...allow, RL_PDF_FREE: perAccount.binding }));
    expect(refused.status).toBe(429);
    expect(perAccount.keys).toEqual([free.userId]);

    const starter = await account('starter');
    const untouched = limiter(false);
    const ok = await postPdf(starter.secret, { template: 'invoice', data: unique() }, limited(mockBrowser(), { ...allow, RL_PDF_FREE: untouched.binding }));
    expect(ok.status).toBe(200);
    expect(untouched.keys).toEqual([]);
  });

  it(`stops an account after ${PDF.maxFailedRendersPerDay.free} renders in a UTC day that produced no PDF; stored PDFs keep working`, async () => {
    const { userId, secret } = await account('free');
    const allow = { RL_IP: limiter(true).binding, RL_PDF_KEY: limiter(true).binding, RL_PDF_FREE: limiter(true).binding };
    const stored = { template: 'invoice', data: unique(INVOICE_DATA) };
    expect((await postPdf(secret, stored, limited(mockBrowser(), allow))).status).toBe(200);

    // Too long (422), the renderer busy (429, not counted: it did no work), a timeout (504).
    const tooLong = mockBrowser(() => pdfResponse('51-pages', 8000));
    for (let i = 1; i < PDF.maxFailedRendersPerDay.free; i++) {
      expect((await postPdf(secret, { template: 'report', data: unique() }, limited(tooLong, allow))).status).toBe(422);
    }
    const busy = mockBrowser(() => browserErrorResponse(429, 'Too many requests', null));
    expect((await postPdf(secret, { template: 'report', data: unique() }, limited(busy, allow))).status).toBe(429);
    const timeout = mockBrowser(() => browserErrorResponse(500, 'Navigation timeout of 30000 ms exceeded', null));
    expect((await postPdf(secret, { template: 'report', data: unique() }, limited(timeout, allow))).status).toBe(504);

    const browser = mockBrowser();
    const refused = await postPdf(secret, { template: 'invoice', data: unique(INVOICE_DATA) }, limited(browser, allow));
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toMatchObject({ code: 'rate_limited', details: { limit: PDF.maxFailedRendersPerDay.free } });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(browser.calls).toEqual([]);
    // The stored PDF is not a render: still served.
    expect(((await (await postPdf(secret, stored, limited(browser, allow))).json()) as PdfJson).cached).toBe(true);
    // Every attempt that reached the browser is on record, with its measured length.
    expect((await browserRows(userId)).every((row) => typeof row.wall_ms === 'number')).toBe(true);
  });

  it('counts a PDF the account could not pay for after rendering as a failed render', async () => {
    const { userId, secret } = await account('free');
    await setUsed(await userRow(userId), PLANS.free.monthlyImages - 2);
    const allow = { RL_IP: limiter(true).binding, RL_PDF_KEY: limiter(true).binding, RL_PDF_FREE: limiter(true).binding };
    const browser = mockBrowser(() => pdfResponse('12-pages', 3000));
    expect((await postPdf(secret, { template: 'report', data: unique() }, limited(browser, allow))).status).toBe(402);
    const day = Math.floor(Date.now() / 86_400_000);
    expect(await first(env.DB, 'SELECT count FROM tool_usage WHERE bucket = ?1', `pdff:${userId}:${day}`)).toEqual({ count: 1 });
  });

  it('brakes Free-plan renders and the free tools, not paid ones, while the last 24 hours used too much browser time', async () => {
    resetFreeBrake();
    const budget = 1000;
    // A timeout's time is not reported by Browser Run; its measured length counts instead.
    await run(
      env.DB,
      "INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at) VALUES ('bu_brake', NULL, 'tool', 500, NULL, ?1, NULL, ?2)",
      budget * PDF.freeBrakeBudgetMultiple + 1,
      Date.now() - 60_000,
    );
    try {
      const allow = { RL_IP: limiter(true).binding, RL_PDF_KEY: limiter(true).binding, RL_PDF_FREE: limiter(true).binding, RL_TOOLS_PDF: limiter(true).binding };
      const overrides = { ...allow, PDF_DAILY_BROWSER_MS_BUDGET: String(budget) };
      const browser = mockBrowser();
      const free = await account('free');
      const braked = await postPdf(free.secret, { template: 'invoice', data: unique(INVOICE_DATA) }, limited(browser, overrides));
      expect(braked.status).toBe(429);
      expect((await errorOf(braked)).message).toContain('Starter and Pro are not affected');
      const tool = await call(
        '/api/tools/pdf',
        { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' }, body: JSON.stringify({ tool: 'invoice', data: {} }) },
        limited(browser, overrides),
      );
      expect(tool.status).toBe(429);
      expect(browser.calls).toEqual([]);

      const starter = await account('starter');
      expect((await postPdf(starter.secret, { template: 'invoice', data: unique(INVOICE_DATA) }, limited(browser, overrides))).status).toBe(200);
    } finally {
      await run(env.DB, "DELETE FROM browser_usage WHERE id = 'bu_brake'");
      resetFreeBrake();
    }
  });

  it('signed links use RL_KEY per site, only when a render is needed', async () => {
    const user = await createUser('starter');
    const site = await createSite(user.id);
    const perSite = limiter(false);
    const response = await call(await signedPdfPath(site, 'invoice', { n: `${++seq}` }), {}, limited(mockBrowser(), { RL_IP: limiter(true).binding, RL_KEY: perSite.binding }));
    expect(response.status).toBe(429);
    expect(perSite.keys).toEqual([site.id]);
  });
});
