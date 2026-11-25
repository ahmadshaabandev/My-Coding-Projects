/**
 * POST /api/tools/pdf - the free PDF tools (/tools/html-to-pdf, /tools/invoice-generator,
 * /tools/certificate-generator). No account: public like the OG checker.
 *
 *   { tool: "html-to-pdf", html, css?, data?, pdf?: { format?, landscape? } }
 *   { tool: "invoice" | "certificate", data, css?, pdf?: { format?, landscape? } }
 *   -> 200 application/pdf, Content-Disposition: attachment; filename="<tool>.pdf", X-LTC-Pages
 *
 * Every page carries the "Made with Link To Card" footer. Nothing is stored, nothing is counted
 * against an account; the browser time is recorded in browser_usage (source "tool").
 *
 * Limits, in this order: the kill switch (503), RL_TOOLS_PDF per client (burst), the request
 * itself (400/422 before anything is counted), then PDF.toolPdfsPerHour per client and hour in
 * D1 with Turnstile after the first few when TURNSTILE_SECRET_KEY is set (src/pdf/limits.ts).
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { requireSameOrigin } from '../auth/middleware';
import { PDF } from '../config';
import { readJsonObject } from '../lib/http';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { parseToolRequest } from '../pdf/input';
import { enforceToolPdfLimit } from '../pdf/limits';
import { assertPdfEnabled } from '../pdf/render';
import { pdfHeaders, preparePdf, printPrepared } from '../pdf/service';
import type { AppEnv } from '../types';

export const toolsPdfRouter = new Hono<AppEnv>();

const pdfEnabledOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertPdfEnabled(c.env);
  await next();
};

toolsPdfRouter.post('/pdf', pdfEnabledOnly, requireSameOrigin, async (c) => {
  const request = c.req.raw;
  const client = clientIp(request);
  await enforceRateLimit(c.env, 'RL_TOOLS_PDF', client);

  const body = await readJsonObject(request, PDF.maxRequestBodyBytes);
  const { tool, job, turnstile } = await parseToolRequest(body);
  // Template errors come back before the PDF is counted.
  const prepared = preparePdf(job);
  const now = Date.now();
  await enforceToolPdfLimit(c.env, client, request.headers.get('cf-connecting-ip'), turnstile, now);

  const rendered = await printPrepared(c.env, prepared, { userId: null, source: 'tool' }, now);
  const headers = pdfHeaders({ filename: `${tool}.pdf`, disposition: 'attachment', pages: rendered.pages, cacheControl: 'no-store', bytes: rendered.bytes.byteLength });
  return new Response(rendered.bytes, { headers });
});
