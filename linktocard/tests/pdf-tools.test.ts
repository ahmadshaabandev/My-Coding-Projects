// POST /api/tools/pdf, the free PDF tools: always marked, never stored, limited per client.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF, RATE_LIMITS } from '../src/config';
import { all, first } from '../src/db/client';
import type { BrowserUsageRow, Env, RateLimitBinding } from '../src/types';
import { errorOf, requestUrl } from './app-helpers';
import { footerOf, mockBrowser, pdfEnv, pdfResponse, postTool, type MockBrowser } from './pdf-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let ipSeq = 0;
/** A fresh client address per test, so the hourly counters never meet. */
const nextIp = (): string => `203.0.113.${++ipSeq}`;
const allow: RateLimitBinding = { limit: () => Promise.resolve({ success: true }) };
const limited = (browser: MockBrowser, overrides: Partial<Env> = {}): Env => pdfEnv(browser, { RATE_LIMITS_DISABLED: '0', RL_TOOLS_PDF: allow, ...overrides });

describe('POST /api/tools/pdf', () => {
  it('html-to-pdf: the PDF as a download, marked on every page, never stored, browser time recorded without an account', async () => {
    const browser = mockBrowser(() => pdfResponse('3-pages', 777));
    const marker = `tool-${Date.now()}`;
    const response = await postTool({ tool: 'html-to-pdf', html: `<h1>${marker}</h1>`, css: 'h1 { color: red }', pdf: { format: 'letter', landscape: true } }, pdfEnv(browser));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="html-to-pdf.pdf"');
    expect(response.headers.get('x-ltc-pages')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(String.fromCharCode(...new Uint8Array(await response.arrayBuffer()).subarray(0, 5))).toBe('%PDF-');

    const { options } = browser.calls[0]!;
    expect(options).toMatchObject({ setJavaScriptEnabled: false, allowRequestPattern: ['^data:'], cacheTTL: 0 });
    expect(options.pdfOptions).toMatchObject({ format: 'letter', landscape: true, displayHeaderFooter: true });
    expect(footerOf(options)).toContain(PDF.freeMark);
    expect((options as { html: string }).html).toContain(marker);

    const rows = await all<BrowserUsageRow>(env.DB, "SELECT * FROM browser_usage WHERE source = 'tool' AND browser_ms = 777");
    expect(rows).toMatchObject([{ user_id: null, status: 200, pages: 3 }]);
    expect((await env.BUCKET.list({ prefix: 'r/' })).objects.filter((object) => object.key.endsWith('.pdf'))).toEqual([]);
    expect((await first<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM renders WHERE format = 'pdf'"))!.n).toBe(0);
  });

  it('invoice and certificate use the starter template with the data; the PDF is always marked', async () => {
    const browser = mockBrowser();
    const invoice = await postTool({ tool: 'invoice', data: { seller_name: 'Fernhill Studio', items: [{ description: 'Tool item', amount: '5.00' }] } }, pdfEnv(browser));
    expect(invoice.status).toBe(200);
    expect(invoice.headers.get('content-disposition')).toBe('attachment; filename="invoice.pdf"');
    expect((browser.calls[0]!.options as { html: string }).html).toContain('Tool item');

    const certificate = await postTool({ tool: 'certificate', data: { recipient_name: 'Mira Okafor' } }, pdfEnv(browser));
    expect(certificate.status).toBe(200);
    expect(browser.calls[1]!.options.pdfOptions).toMatchObject({ landscape: true });
    for (const call of browser.calls) {
      expect(footerOf(call.options)).toContain(PDF.freeMark);
      expect(Number.parseFloat(call.options.pdfOptions!.margin!.bottom as string)).toBeGreaterThanOrEqual(PDF.freeMarkMinBottomMm);
    }
  });

  it.each([
    ['an unknown tool', { tool: 'payslip' }, '"tool" must be one of'],
    ['html-to-pdf without html', { tool: 'html-to-pdf' }, '"html" is required'],
    ['html for the invoice tool', { tool: 'invoice', html: '<p>x</p>' }, 'send "data", not "html"'],
    ['margins (not offered by the tools)', { tool: 'invoice', pdf: { margin: { top: '1mm' } } }, 'Unknown field "pdf.margin"'],
    ['an unknown field', { tool: 'invoice', filename: 'x.pdf' }, 'Unknown field "filename"'],
    ['bad data', { tool: 'invoice', data: { items: 'x' } }, '"items" must be a list'],
  ])('refuses %s with 400 and renders nothing', async (_label, body, message) => {
    const browser = mockBrowser();
    const response = await postTool(body, pdfEnv(browser), { 'cf-connecting-ip': nextIp() });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain(message);
    expect(browser.calls).toEqual([]);
  });

  it('refuses cross-site requests', async () => {
    const response = await postTool({ tool: 'invoice' }, pdfEnv(mockBrowser()), { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
  });
});

describe('POST /api/tools/pdf: limits', () => {
  it(`allows ${PDF.toolPdfsPerHour} PDFs per client and hour, then 429 with Retry-After to the next hour`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:15:00Z'));
    const browser = mockBrowser();
    const ip = nextIp();
    for (let i = 1; i <= PDF.toolPdfsPerHour; i++) {
      expect((await postTool({ tool: 'html-to-pdf', html: `<p>${i}</p>` }, limited(browser), { 'cf-connecting-ip': ip })).status, `PDF ${i}`).toBe(200);
    }
    const refused = await postTool({ tool: 'html-to-pdf', html: '<p>one more</p>' }, limited(browser), { 'cf-connecting-ip': ip });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(45 * 60));
    expect(await errorOf(refused)).toMatchObject({ code: 'rate_limited', details: { limit: PDF.toolPdfsPerHour } });
    expect(browser.calls).toHaveLength(PDF.toolPdfsPerHour);
    // Another client is not affected; the next hour starts afresh.
    expect((await postTool({ tool: 'html-to-pdf', html: '<p>x</p>' }, limited(browser), { 'cf-connecting-ip': nextIp() })).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-25T11:00:00Z'));
    expect((await postTool({ tool: 'html-to-pdf', html: '<p>x</p>' }, limited(browser), { 'cf-connecting-ip': ip })).status).toBe(200);
  });

  it('does not count a request the template rules refuse', async () => {
    const ip = nextIp();
    const browser = mockBrowser();
    for (let i = 0; i < PDF.toolPdfsPerHour + 2; i++) {
      expect((await postTool({ tool: 'html-to-pdf', html: '<style>@import "x.css";</style>' }, limited(browser), { 'cf-connecting-ip': ip })).status).toBe(422);
    }
    expect((await postTool({ tool: 'html-to-pdf', html: '<p>ok</p>' }, limited(browser), { 'cf-connecting-ip': ip })).status).toBe(200);
  });

  it('answers 429 when the RL_TOOLS_PDF burst limiter says no', async () => {
    const keys: string[] = [];
    const deny: RateLimitBinding = { limit: ({ key }) => (keys.push(key), Promise.resolve({ success: false })) };
    const ip = nextIp();
    const browser = mockBrowser();
    const response = await postTool({ tool: 'html-to-pdf', html: '<p>x</p>' }, limited(browser, { RL_TOOLS_PDF: deny }), { 'cf-connecting-ip': ip });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_TOOLS_PDF.periodSeconds));
    expect(keys).toEqual([ip]);
    expect(browser.calls).toEqual([]);
  });

  it(`asks for Turnstile after ${PDF.toolTurnstileAfterPdfs} PDFs in the hour when TURNSTILE_SECRET_KEY is set`, async () => {
    const verified: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.hostname !== 'challenges.cloudflare.com') throw new Error(`unexpected request ${url.href}`);
      const token = (init?.body as FormData).get('response') as string;
      verified.push(token);
      return Response.json({ success: token === 'good-token' });
    });
    const browser = mockBrowser();
    const bindings = limited(browser, { TURNSTILE_SECRET_KEY: 'secret-not-real', TURNSTILE_SITE_KEY: '0x4AAAAAAAsitekey' });
    const ip = nextIp();
    for (let i = 0; i < PDF.toolTurnstileAfterPdfs; i++) {
      expect((await postTool({ tool: 'html-to-pdf', html: `<p>${i}</p>` }, bindings, { 'cf-connecting-ip': ip })).status).toBe(200);
    }
    const challenged = await postTool({ tool: 'html-to-pdf', html: '<p>next</p>' }, bindings, { 'cf-connecting-ip': ip });
    expect(challenged.status).toBe(403);
    expect(await errorOf(challenged)).toMatchObject({ code: 'verification_required', details: { site_key: '0x4AAAAAAAsitekey' } });
    expect((await postTool({ tool: 'html-to-pdf', html: '<p>next</p>', turnstile: 'bad-token' }, bindings, { 'cf-connecting-ip': ip })).status).toBe(403);
    expect((await postTool({ tool: 'html-to-pdf', html: '<p>next</p>', turnstile: 'good-token' }, bindings, { 'cf-connecting-ip': ip })).status).toBe(200);
    expect(verified).toEqual(['bad-token', 'good-token']);
    expect(browser.calls).toHaveLength(PDF.toolTurnstileAfterPdfs + 1);
  });

  it('never asks for Turnstile without TURNSTILE_SECRET_KEY', async () => {
    const ip = nextIp();
    const browser = mockBrowser();
    for (let i = 0; i < PDF.toolPdfsPerHour; i++) {
      expect((await postTool({ tool: 'html-to-pdf', html: `<p>${i}</p>` }, limited(browser), { 'cf-connecting-ip': ip })).status).toBe(200);
    }
  });
});
