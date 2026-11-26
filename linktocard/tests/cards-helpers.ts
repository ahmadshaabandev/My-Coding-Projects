// Helpers for the "link in, card out" tests (tests/cards-*.test.ts): settings, check results
// built from the OG fixtures, a mocked network, and a small app that mounts the new routes
// the way src/index.ts will once they are integrated.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { vi } from 'vitest';
import { requireApiKey } from '../src/auth/middleware';
import { fromCheckHandler, fromUrlHandler, requireLinkCards } from '../src/cards/handlers';
import type { LinkCardSettings } from '../src/cards/service';
import { DAY_MS } from '../src/config';
import { runInspection } from '../src/inspect/check';
import type { CheckResult } from '../src/inspect/types';
import { ApiError, errorResponse } from '../src/lib/errors';
import { encodePng } from '../src/render/png-writer';
import { createLinkRouter } from '../src/routes/link';
import type { AppEnv, Env } from '../src/types';
import { dohAnswer, requestUrl } from './app-helpers';
import { imageFile } from './fixtures/og/images';

/** The values proposed for src/config.ts LINK_CARDS (the playground's text limits). */
export const SETTINGS: LinkCardSettings = {
  defaultTemplate: 'blog',
  maxChars: { title: 120, description: 200, site: 60 },
  refreshAfterMs: DAY_MS,
};

/** The test bindings with link cards switched on. */
export const enabled: Env = { ...env, LINK_CARDS_ENABLED: 'true' };

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export type Handler = (url: URL, method: string) => Response | Promise<Response>;

export const html = (body: string): Handler => () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A header-only PNG: enough for the checker's probe, not decodable by the renderer. */
export const probePng = (width = 1200, height = 630): Handler => () => new Response(imageFile('png', width, height), { headers: { 'content-type': 'image/png' } });

/** A real, decodable PNG of one colour. */
export async function solidPng(width = 4, height = 4, rgba: [number, number, number, number] = [15, 118, 110, 255]): Promise<Uint8Array> {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return encodePng({ data, width, height });
}

export const bytes = (body: Uint8Array, type = 'image/png'): Handler => () => new Response(body, { headers: { 'content-type': type } });

function route(routes: Record<string, Handler>, url: URL, method: string): Response | Promise<Response> {
  const handler = routes[`${url.origin}${url.pathname}`];
  return handler ? handler(url, method) : new Response('not found', { status: 404 });
}

export interface Seen {
  url: URL;
  method: string;
}

/**
 * Replaces every outbound request: DoH answers with a public address, `routes` maps an exact
 * URL (no query) to a handler, anything else is 404. Returns the requests seen (DoH excluded).
 */
export function mockNet(routes: Record<string, Handler>): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.hostname === 'cloudflare-dns.com') return dohAnswer(url);
    const method = init?.method ?? 'GET';
    seen.push({ url, method });
    return route(routes, url, method);
  });
  return seen;
}

/** Unique host names per test: DoH answers and checks are cached by host. */
let serial = 0;
export const host = (label: string): string => `${label}-${++serial}.cardfixtures.com`;

/* ------------------------------------------------------------------ */
/* Check results                                                       */
/* ------------------------------------------------------------------ */

/** A real CheckResult: the inspector run on `page` served at `url`, with `routes` for its images. */
export async function checkOf(url: string, page: string, routes: Record<string, Handler> = {}): Promise<CheckResult> {
  const all: Record<string, Handler> = { [`${new URL(url).origin}${new URL(url).pathname}`]: html(page), ...routes };
  const fetchImpl: typeof fetch = async (input, init) => route(all, requestUrl(input), init?.method ?? 'GET');
  const outcome = await runInspection(new URL(url), { fetchImpl, resolveHost: async () => ['93.184.216.34'], now: () => Date.now() });
  return outcome.result;
}

/** A hand-made CheckResult with nothing set but the URL; tests fill in what they need. */
export function bareCheck(url = 'https://www.example.com/post'): CheckResult {
  return {
    id: 'chk_0000000000000000',
    url,
    final_url: url,
    status: 200,
    fetched_at: new Date(0).toISOString(),
    response_ms: 1,
    cached: false,
    expires_at: new Date(600_000).toISOString(),
    page: { title: null, description: null, canonical: null, favicon: `${new URL(url).origin}/favicon.ico`, theme_color: null },
    og: { title: null, description: null, image: null, image_alt: null, image_width: null, image_height: null, url: null, type: null, site_name: null },
    twitter: { card: null, title: null, description: null, image: null, site: null },
    image: null,
    robots: { checked: true, allowed: true, note: null },
    checks: [],
    preview: { title: null, description: null, domain: new URL(url).hostname, site_name: null, image: null, favicon: null },
  };
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

/** The new routes mounted as the integration steps describe, with the app's error handling. */
export const cardsApp = new Hono<AppEnv>();
cardsApp.route('/v1/link', createLinkRouter(SETTINGS));
cardsApp.post('/v1/cards/from-url', requireLinkCards, requireApiKey, fromUrlHandler(SETTINGS));
cardsApp.get('/playground/from-check/:checkId/:file', requireLinkCards, fromCheckHandler(SETTINGS));
cardsApp.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(error, c.env.APP_URL);
  console.error('cards test app:', error);
  return errorResponse(new ApiError('internal_error', 'Unexpected error.'), c.env.APP_URL);
});

/** One request through the test app; background work (pointer and edge-cache writes) is finished on return. */
export async function callCards(path: string, init: RequestInit = {}, bindings: Env = enabled): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await cardsApp.fetch(new Request(new URL(path, 'http://localhost'), init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function postFromUrl(secret: string, body: unknown, bindings: Env = enabled): Promise<Response> {
  return callCards(
    '/v1/cards/from-url',
    { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    bindings,
  );
}
