/// <reference path="./fixtures/pdf/inline.d.ts" />
// Helpers for the PDF tests: real Chrome PDFs from tests/fixtures/pdf (made once with a
// throw-away script and a local Chromium; only the .pdf files are committed), a mock Browser
// Run binding that records every quickAction call, and request helpers.
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { canonicalString, signCanonical } from '../src/lib/signed-url';
import type { Env, SiteRow } from '../src/types';
import { bearer, call, siteSecret } from './app-helpers';
import onePageHeaderFooter from './fixtures/pdf/1-page-header-footer.pdf?inline';
import onePage from './fixtures/pdf/1-page.pdf?inline';
import twelvePagesHeaderFooter from './fixtures/pdf/12-pages-header-footer.pdf?inline';
import twelvePagesTagged from './fixtures/pdf/12-pages-tagged.pdf?inline';
import twelvePages from './fixtures/pdf/12-pages.pdf?inline';
import threePages from './fixtures/pdf/3-pages.pdf?inline';
import fiftyOnePagesHeaderFooter from './fixtures/pdf/51-pages-header-footer.pdf?inline';
import fiftyOnePages from './fixtures/pdf/51-pages.pdf?inline';

function bytesOfDataUrl(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The fixtures and the page count pdfinfo reports for each. */
export const FIXTURES = {
  '1-page': { bytes: bytesOfDataUrl(onePage), pages: 1 },
  '3-pages': { bytes: bytesOfDataUrl(threePages), pages: 3 },
  '12-pages': { bytes: bytesOfDataUrl(twelvePages), pages: 12 },
  '51-pages': { bytes: bytesOfDataUrl(fiftyOnePages), pages: 51 },
  '1-page-header-footer': { bytes: bytesOfDataUrl(onePageHeaderFooter), pages: 1 },
  '12-pages-header-footer': { bytes: bytesOfDataUrl(twelvePagesHeaderFooter), pages: 12 },
  '51-pages-header-footer': { bytes: bytesOfDataUrl(fiftyOnePagesHeaderFooter), pages: 51 },
  // Tagged, with an outline: its /Outlines dictionary has a /Count of its own.
  '12-pages-tagged': { bytes: bytesOfDataUrl(twelvePagesTagged), pages: 12 },
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function pdfResponse(fixture: FixtureName = '1-page', browserMs = 1234): Response {
  return new Response(FIXTURES[fixture].bytes.slice(), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'x-browser-ms-used': String(browserMs) },
  });
}

export function browserErrorResponse(status: number, message: string, browserMs: number | null = 50): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (browserMs !== null) headers['x-browser-ms-used'] = String(browserMs);
  return new Response(JSON.stringify({ success: false, errors: [{ message, code: status }] }), { status, headers });
}

export interface MockBrowser {
  binding: BrowserRun;
  calls: Array<{ action: string; options: BrowserRunPDFOptions }>;
  quickAction: ReturnType<typeof vi.fn>;
}

/** A Browser Run binding that answers with `respond` (default: the 1-page fixture) and records the calls. */
export function mockBrowser(respond: (options: BrowserRunPDFOptions) => Response | Promise<Response> = () => pdfResponse()): MockBrowser {
  const calls: MockBrowser['calls'] = [];
  const quickAction = vi.fn(async (action: string, options: BrowserRunPDFOptions) => {
    calls.push({ action, options });
    return respond(options);
  });
  const binding = { quickAction, fetch: () => Promise.reject(new Error('not used')) } as unknown as BrowserRun;
  return { binding, calls, quickAction };
}

/** The test env with a Browser Run binding (and any other overrides). */
export function pdfEnv(browser: MockBrowser | BrowserRun | undefined, overrides: Partial<Env> = {}): Env {
  const binding = browser && 'binding' in browser ? browser.binding : browser;
  return { ...env, BROWSER: binding, ...overrides };
}

export function postPdf(secret: string, body: unknown, bindings: Env): Promise<Response> {
  return call(
    '/v1/pdf',
    { method: 'POST', headers: { ...bearer(secret), 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    bindings,
  );
}

export function postTool(body: unknown, bindings: Env, headers: Record<string, string> = {}): Promise<Response> {
  return call(
    '/api/tools/pdf',
    { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7', ...headers }, body: JSON.stringify(body) },
    bindings,
  );
}

/** Path + query of a signed PDF link, signed exactly like a /v1/og URL. */
export async function signedPdfPath(site: SiteRow, template: string, params: Record<string, string>, secret?: string): Promise<string> {
  const pathname = `/v1/pdf/${site.id}/${template}.pdf`;
  const entries = Object.entries(params);
  const sig = await signCanonical(secret ?? (await siteSecret(site)), canonicalString(pathname, entries));
  const query = new URLSearchParams(entries);
  query.append('sig', sig);
  return `${pathname}?${query.toString()}`;
}

/** The text of a PDF's footer/header template as the browser received it. */
export function footerOf(options: BrowserRunPDFOptions): string | undefined {
  return options.pdfOptions?.footerTemplate;
}
