/**
 * Certificate verification (bulk documents with "verify": true):
 *
 *   GET  /v/{id}                          public HTML record (src/batch/verify-page.ts)
 *   GET  /v/{id}.json                     the same record as JSON
 *   POST /v1/certificates/{id}/revoke     API key: revoke one of the account's certificates
 *   POST /api/certificates/{id}/revoke    dashboard twin (session cookie, same origin)
 *
 * Only BATCH_ENABLED gates these, not pdfEnabled(): showing or revoking a record needs no
 * browser, so a PDF outage (or the browser-time brake) leaves printed QR codes working. While
 * BATCH_ENABLED is off, the page answers 503 with an HTML notice, and the JSON and revoke routes
 * 503 not_configured like every switched-off feature.
 *
 * The public routes count against RL_IP per client. Ids carry 100 random bits, so the limit is
 * about D1 reads, not about guessing.
 */
import { Hono, type Context } from 'hono';
import { requireApiKey, requireSameOrigin, requireSession } from '../auth/middleware';
import { getCertificate, parseCertificateId, revokeCertificate } from '../batch/certificates';
import { loadSiteFooter, notFoundPageHtml, unavailablePageHtml, verifyHtmlResponse, verifyJson, verifyJsonResponse, verifyPageHtml, type VerifyContext } from '../batch/verify-page';
import { ApiError } from '../lib/errors';
import { assertFeatureEnabled, featureEnabled } from '../lib/features';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import type { AppEnv } from '../types';

const JSON_SUFFIX = '.json';

const context = (c: Context<AppEnv>): VerifyContext => ({ appUrl: c.env.APP_URL, supportEmail: c.env.SUPPORT_EMAIL, now: Date.now() });
/** For the HTML pages: with the static site's own footer (its tools links included), read from env.ASSETS. */
const pageContext = async (c: Context<AppEnv>, ctx: VerifyContext): Promise<VerifyContext> => ({ ...ctx, footer: await loadSiteFooter(c.env.ASSETS) });
const notFound = (): ApiError => new ApiError('not_found', 'No certificate with this ID.');

/** Mounted at /v (wrangler.toml run_worker_first must list "/v/*"). */
export const verifyRouter = new Hono<AppEnv>();

verifyRouter.get('/:file', async (c) => {
  await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
  const file = c.req.param('file');
  const json = file.endsWith(JSON_SUFFIX);
  const ctx = context(c);
  if (!featureEnabled(c.env, 'batch')) {
    if (json) assertFeatureEnabled(c.env, 'batch');
    return verifyHtmlResponse(unavailablePageHtml(await pageContext(c, ctx)), 503);
  }
  const id = parseCertificateId(json ? file.slice(0, -JSON_SUFFIX.length) : file);
  const record = id === null ? null : await getCertificate(c.env.DB, id, ctx.now);
  if (json) {
    if (!record) throw notFound();
    return verifyJsonResponse(verifyJson(record, ctx));
  }
  const page = await pageContext(c, ctx);
  return record ? verifyHtmlResponse(verifyPageHtml(record, page), 200) : verifyHtmlResponse(notFoundPageHtml(id, page), 404);
});

async function revoke(c: Context<AppEnv>): Promise<Response> {
  assertFeatureEnabled(c.env, 'batch');
  const id = parseCertificateId(c.req.param('id') ?? '');
  if (id === null) throw notFound();
  const record = await revokeCertificate(c.env.DB, c.var.user, id, Date.now());
  if (!record) throw notFound();
  return c.json(verifyJson(record, context(c)));
}

/** Mounted at /v1/certificates, before the /v1 API router (it limits per IP itself). */
export const certificatesApiRouter = new Hono<AppEnv>();

certificatesApiRouter.post(
  '/:id/revoke',
  async (c, next) => {
    await enforceRateLimit(c.env, 'RL_IP', clientIp(c.req.raw));
    await next();
  },
  requireApiKey,
  async (c) => {
    await enforceRateLimit(c.env, 'RL_KEY', c.var.apiKey?.id ?? c.var.user.id);
    return revoke(c);
  },
);

/** Mounted at /api/certificates. */
export const certificatesDashboardRouter = new Hono<AppEnv>();

certificatesDashboardRouter.post('/:id/revoke', requireSameOrigin, requireSession, revoke);
