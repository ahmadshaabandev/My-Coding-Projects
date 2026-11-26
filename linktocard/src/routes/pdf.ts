/**
 * PDF documents under /v1/pdf, rendered by Cloudflare Browser Run (src/pdf/*):
 *
 *   POST /v1/pdf                                   API key: render one PDF, answer with its URL or bytes
 *   GET  /v1/pdf/{siteId}/{template}.pdf?...&sig=  signed link, the PDF twin of /v1/og
 *
 * Mounted before the API-key routes, which share the /v1 prefix. Unless PDF_ENABLED is "true"
 * and the BROWSER binding exists, every request answers 503 not_configured before anything else.
 *
 * Signed links are signed exactly like card URLs (src/lib/signed-url.ts: pathname, sorted
 * parameter names, name=value lines); the signature is checked before anything renders.
 * Reserved parameters: format, landscape, filename, items (a JSON-encoded list).
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { requireApiKey } from '../auth/middleware';
import { PDF } from '../config';
import { first, getUserById } from '../db/client';
import { ApiError } from '../lib/errors';
import { backgroundFor, etagFor, iso, matchesEtag, notModified, readJsonObject, usageJson } from '../lib/http';
import { warningsHeader } from '../lib/images';
import { getUsage } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { deriveSiteSecret, describeSignedUrlFailure, verifySignedUrl } from '../lib/signed-url';
import { parsePdfPath, parsePdfRequest, signedPdfJob } from '../pdf/input';
import { assertPdfEnabled } from '../pdf/render';
import { assertPdfWouldRender, getPdf, pdfCacheKey, pdfHeaders, pdfUrl, readStoredPdf, storedPdfHeaders, type PdfRequest } from '../pdf/service';
import type { AppEnv, Env, SiteRow } from '../types';

export const pdfRouter = new Hono<AppEnv>();

pdfRouter.use('*', async (c, next) => {
  assertPdfEnabled(c.env);
  await next();
});

const limitIp: MiddlewareHandler<AppEnv> = async (c, next) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  await next();
};

pdfRouter.post('/', limitIp, requireApiKey, async (c) => {
  const user = c.var.user;
  await enforceRateLimit(c.env, 'RL_PDF_KEY', c.var.apiKey?.id ?? user.id);

  const body = await readJsonObject(c.req.raw, PDF.maxRequestBodyBytes);
  const { job, mode } = await parsePdfRequest(c.env.DB, user, body);
  const now = Date.now();
  const result = await getPdf(c.env, backgroundFor(c), { user, job, source: 'api', siteId: null }, { now, withBody: mode === 'binary' });
  const { pdf } = result;
  const url = pdfUrl(c.env, user.id, pdf.cacheKey);

  if (mode === 'binary') {
    const headers = storedPdfHeaders(pdf, result.cached ? 'hit' : 'miss', now);
    headers.set('x-ltc-credits-used', String(result.creditsUsed));
    headers.set('x-ltc-pdf-url', url);
    headers.set('x-ltc-warnings', warningsHeader(result.warnings));
    return new Response(result.body, { headers });
  }
  return c.json({
    id: pdf.cacheKey,
    url,
    pages: pdf.pages,
    bytes: pdf.bytes,
    credits_used: result.creditsUsed,
    cached: result.cached,
    template: pdf.template,
    filename: pdf.filename,
    created_at: iso(pdf.createdAt),
    expires_at: iso(pdf.expiresAt),
    warnings: result.warnings,
    usage: usageJson(result.usage ?? (await getUsage(c.env.DB, user, now))),
  });
});

/** The edge cache is an optimisation: when it is unavailable the request simply continues. */
async function edgeCacheMatch(url: string): Promise<Response | undefined> {
  try {
    return await caches.default.match(url);
  } catch {
    return undefined;
  }
}

async function signedRequestFor(env: Env, url: URL, request: Request): Promise<PdfRequest> {
  const path = parsePdfPath(url.pathname);
  if (!path) throw new ApiError('not_found', 'Not found. Signed PDF links look like /v1/pdf/{site id}/{template}.pdf?...&sig=...');
  await enforceRateLimit(env, 'RL_IP', clientIp(request));

  const site = await first<SiteRow>(env.DB, 'SELECT * FROM sites WHERE id = ?1 AND deleted_at IS NULL', path.siteId);
  const owner = site ? await getUserById(env.DB, site.user_id) : null;
  if (!site || !owner) throw new ApiError('not_found', 'Site not found. Check the site id in the URL.');

  const verified = await verifySignedUrl(url, await deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version));
  if (!verified.ok) {
    throw new ApiError('invalid_signature', describeSignedUrlFailure(verified.reason), { details: { reason: verified.reason } });
  }
  if (owner.suspended_at !== null) throw new ApiError('account_suspended', `This account is suspended. Contact ${env.SUPPORT_EMAIL}.`);

  const job = await signedPdfJob(env.DB, owner, path.template, verified.params);
  return { user: owner, job, source: 'signed', siteId: site.id, renderRateLimitKey: site.id };
}

pdfRouter.get('/*', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const edge = await edgeCacheMatch(url.href);
  if (edge) {
    const etag = edge.headers.get('etag');
    return etag !== null && matchesEtag(request, etag) ? notModified(edge.headers) : edge;
  }

  const pdfRequest = await signedRequestFor(c.env, url, request);
  const now = Date.now();
  const cacheKey = await pdfCacheKey(pdfRequest.user.id, pdfRequest.job);
  const conditional = matchesEtag(request, etagFor(cacheKey));

  // HEAD never renders, charges or counts: the stored PDF's headers, or what a GET would most
  // likely say (the same 402 and 429 checks a render passes first, and a remembered failure).
  if (request.method === 'HEAD') {
    const stored = await readStoredPdf(c.env.BUCKET, pdfRequest.user.id, cacheKey, now, false);
    if (stored) {
      const headers = storedPdfHeaders(stored.pdf, 'hit', now);
      headers.set('content-length', String(stored.pdf.bytes));
      return new Response(null, { headers });
    }
    await assertPdfWouldRender(c.env, pdfRequest, cacheKey, now);
    return new Response(null, { headers: pdfHeaders({ filename: pdfRequest.job.filename, disposition: 'inline', cacheControl: 'no-store', cacheKey, cache: 'miss' }) });
  }

  const background = backgroundFor(c);
  const result = await getPdf(c.env, background, pdfRequest, { now, cacheKey, withBody: !conditional });
  const headers = storedPdfHeaders(result.pdf, result.cached ? 'hit' : 'miss', now);
  if (result.cached && conditional) return notModified(headers);

  const response = new Response(result.body, { headers });
  if (!headers.get('cache-control')!.endsWith('max-age=0')) {
    // The copy at the edge answers repeat requests for this exact URL without reaching R2 or D1.
    const copyHeaders = new Headers(headers);
    copyHeaders.set('x-ltc-cache', 'hit');
    const copy = new Response(response.clone().body, { headers: copyHeaders });
    background(Promise.resolve().then(() => caches.default.put(url.href, copy)));
  }
  return response;
});
