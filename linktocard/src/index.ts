/**
 * The Worker: one Hono app for every dynamic path, plus the daily cleanup.
 *
 * Static pages never reach this code: wrangler.toml lists the dynamic prefixes
 * in run_worker_first and everything else is answered from static assets.
 *
 *   /webhooks/paddle        Paddle Billing notifications (raw body, own signature check)
 *   /healthz                liveness
 *   /auth/*                 magic-link sign-in
 *   /playground/card.png    homepage playground
 *   /v1/og/...              signed card URLs (public)
 *   /v1/pdf, /v1/pdf/...    PDF documents: API key, and signed PDF links (public)
 *   /v1/*                   API-key endpoints
 *   /i/...                  stored images and PDFs
 *   /api/tools/*            free tools (public, no session): the OG checker, the PDF tools
 *   /api/*                  dashboard API (session cookie)
 */
import { Hono } from 'hono';
import { WORKER_PATHS } from './config';
import { runCleanup } from './lib/cleanup';
import { ApiError, errorResponse } from './lib/errors';
import { runPdfBudgetAlarm } from './pdf/alarm';
import { apiRouter } from './routes/api';
import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { imagesRouter } from './routes/images';
import { ogRouter } from './routes/og';
import { pdfRouter } from './routes/pdf';
import { playgroundRouter } from './routes/playground';
import { studioRouter } from './routes/studio';
import { toolsRouter } from './routes/tools';
import { toolsPdfRouter } from './routes/tools-pdf';
import { paddleWebhookRouter } from './routes/webhooks/paddle';
import type { AppEnv, Env } from './types';

/** The router. Requests enter through the default export below, which the tests call too. */
export const app = new Hono<AppEnv>();

// Request id and security headers. This middleware reads nothing from the
// request body, so the webhook below still sees the exact bytes Paddle signed.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  await next();

  // One mutable copy: cached and R2-backed responses arrive with immutable headers.
  const response = new Response(c.res.body, c.res);
  const { headers } = response;
  headers.set('X-Request-Id', requestId);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // JSON here is account data or an error: never cached unless a route says otherwise.
  if ((headers.get('content-type') ?? '').startsWith('application/json') && !headers.has('cache-control')) {
    headers.set('Cache-Control', 'no-store');
  }
  c.res = undefined;
  c.res = response;
});

// Mounted first: nothing above or beside it may read the body or demand a session or an Origin.
app.route('/webhooks', paddleWebhookRouter);

app.get('/healthz', (c) => c.json({ ok: true }));
app.route('/auth', authRouter);
app.route('/playground', playgroundRouter);
// Before the API-key routes: signed URLs share the /v1 prefix but carry no key.
app.route('/v1/og', ogRouter);
app.route('/v1/pdf', pdfRouter);
app.route('/v1', apiRouter);
app.route('/i', imagesRouter);
app.route('/api/tools', toolsRouter);
app.route('/api/tools', toolsPdfRouter);
app.route('/api', dashboardRouter);
app.route('/api', studioRouter);

app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (WORKER_PATHS.some((prefix) => (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix))) {
    return errorResponse(new ApiError('not_found', 'Not found. See the API reference for the available endpoints.'), c.env.APP_URL);
  }
  // Only reachable if routing sends a page request here: let static assets answer with the 404 page.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(error, c.env.APP_URL);
  console.error(`request ${c.get('requestId')} failed:`, error);
  return errorResponse(new ApiError('internal_error', 'Unexpected error. Try again; if it keeps happening, contact support.'), c.env.APP_URL);
});

/**
 * workerd turns a request that declares "Content-Length: 0" (what browsers send for a
 * bodyless POST, and what `wrangler dev` adds to a bodyless DELETE) into an empty body
 * stream. To the app that is simply "no body": the same-origin guard asks for a JSON
 * content type only on requests that carry one.
 */
function withoutEmptyBody(request: Request): Request {
  return request.body !== null && request.headers.get('content-length') === '0' ? new Request(request, { body: null }) : request;
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> => app.fetch(withoutEmptyBody(request), env, ctx),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(
      runCleanup(env, now).then(
        (report) => console.log('cleanup:', JSON.stringify(report)),
        (error: unknown) => console.error('cleanup failed:', error),
      ),
    );
    // Browser Run time of the last 24 h against the daily budget; one email per UTC day when over.
    ctx.waitUntil(
      runPdfBudgetAlarm(env, now).then(
        (report) => console.log('pdf budget:', JSON.stringify(report)),
        (error: unknown) => console.error('pdf budget alarm failed:', error),
      ),
    );
  },
};
