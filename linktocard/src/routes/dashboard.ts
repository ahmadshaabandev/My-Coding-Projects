/**
 * Dashboard API under /api: account, API keys, sites, the signed-URL builder,
 * billing, the contact form and the public site configuration. The template
 * studio (templates, preview, fonts) lives in ./studio.ts on the same prefix.
 *
 * Auth is the session cookie. Every write requires a same-origin JSON request
 * (requireSameOrigin), which is the CSRF defence. Guards are attached per
 * route so an unknown /api path is a plain 404.
 */
import { Hono, type Context } from 'hono';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeySummary } from '../auth/api-keys';
import { requireSameOrigin, requireSession, requireSessionAllowSuspended } from '../auth/middleware';
import { changeSubscriptionPlan, createPortalSession, paddleClientConfig, upgradeAddsImages, type PaidPlanId } from '../billing/paddle';
import { PLANS, PLAN_ORDER, TOPUP, getPlan } from '../billing/plans';
import { FORMATS, FORMAT_TO_EXTENSION, LIMITS, SIZES } from '../config';
import { all, first, normalizeEmail, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { contactFormEmail, sendEmail } from '../lib/email';
import { ApiError } from '../lib/errors';
import { cleanName, codePointLength, iso, isoOrNull, readJsonObject, usageJson } from '../lib/http';
import { imageUrl, parseFormat, parseSize, resolveTemplate, templateNotFound, validateData } from '../lib/images';
import { getUsage, listRecentRenders } from '../lib/quota';
import { clientIp, enforceRateLimit } from '../lib/rate-limit';
import { SIG_PARAM, SIZE_PARAM, buildSignedUrl, canonicalString, deriveSiteSecret, type OgExtension } from '../lib/signed-url';
import type { AppEnv, Env, SiteRow, TopupRow, UserRow } from '../types';

const MAX_CONTACT_MESSAGE_CHARS = 4000;
const RECENT_RENDERS = 50;
const ACTIVE_SUBSCRIPTION_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];
const PAID_PLANS: readonly PaidPlanId[] = ['starter', 'pro'];

export const dashboardRouter = new Hono<AppEnv>();

const notFound = (what: string): ApiError => new ApiError('not_found', `${what} not found.`);

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

const fontLimits = (plan: { fonts: { maxFiles: number; maxBytesPerFile: number } }): { max_files: number; max_bytes_per_file: number } => ({
  max_files: plan.fonts.maxFiles,
  max_bytes_per_file: plan.fonts.maxBytesPerFile,
});

dashboardRouter.get('/config', (c) => {
  const paddle = paddleClientConfig(c.env);
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    app_url: c.env.APP_URL,
    support_email: c.env.SUPPORT_EMAIL,
    environment: c.env.ENVIRONMENT,
    paddle: paddle ? { environment: paddle.environment, client_token: paddle.clientToken, prices: paddle.prices } : null,
    plans: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        id: plan.id,
        name: plan.name,
        price_usd: plan.priceUsd,
        monthly_images: plan.monthlyImages,
        cache_days: plan.cacheDays,
        watermark: plan.watermark,
        fonts: fontLimits(plan),
        top_ups: plan.topUps,
      };
    }),
    topup: { price_usd: TOPUP.priceUsd, images: TOPUP.images, valid_days: TOPUP.validDays },
    sizes: Object.values(SIZES).map(({ id, width, height }) => ({ id, width, height })),
    formats: FORMATS,
  });
});

dashboardRouter.post('/contact', requireSameOrigin, async (c) => {
  await enforceRateLimit(c.env, 'RL_AUTH', `contact:${clientIp(c.req.raw)}`);
  const body = await readJsonObject(c.req.raw);
  // Honeypot: a field no human sees. Bots that fill it get a success and nothing is sent.
  if (typeof body.website === 'string' && body.website.trim() !== '') return c.json({ ok: true });

  const email = normalizeEmail(body.email);
  if (!email) throw new ApiError('invalid_request', 'Enter a valid email address so we can reply.');
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message === '') throw new ApiError('invalid_request', 'Write a message.');
  if (codePointLength(message) > MAX_CONTACT_MESSAGE_CHARS) {
    throw new ApiError('invalid_request', `A message can be at most ${MAX_CONTACT_MESSAGE_CHARS} characters.`);
  }

  const sent = await sendEmail(c.env, { to: c.env.SUPPORT_EMAIL, replyTo: email, ...contactFormEmail({ fromEmail: email, message }) });
  if (!sent.ok) {
    const advice = `The message could not be sent. Please email ${c.env.SUPPORT_EMAIL} instead.`;
    throw new ApiError(sent.error === 'not_configured' ? 'not_configured' : 'internal_error', advice);
  }
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

dashboardRouter.get('/me', requireSessionAllowSuspended, async (c) => {
  const user = c.var.user;
  const now = Date.now();
  const plan = getPlan(user.plan);
  const topups = await all<Pick<TopupRow, 'id' | 'images' | 'remaining' | 'expires_at'>>(
    c.env.DB,
    `SELECT id, images, remaining, expires_at FROM topups
     WHERE user_id = ?1 AND refunded_at IS NULL AND remaining > 0 AND expires_at > ?2 ORDER BY expires_at, id`,
    user.id,
    now,
  );
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      plan: user.plan,
      created_at: iso(user.created_at),
      suspended: user.suspended_at !== null,
      subscription:
        user.subscription_status === null
          ? null
          : { status: user.subscription_status, period_end: isoOrNull(user.period_end), cancel_at: isoOrNull(user.cancel_at) },
      has_billing: user.paddle_customer_id !== null,
    },
    usage: usageJson(await getUsage(c.env.DB, user, now)),
    topups: topups.map((topup) => ({ ...topup, expires_at: iso(topup.expires_at) })),
    limits: {
      fonts: fontLimits(plan),
      templates: LIMITS.maxTemplatesPerUser,
      sites: LIMITS.maxSitesPerUser,
      api_keys: LIMITS.maxApiKeysPerUser,
    },
  });
});

dashboardRouter.get('/renders', requireSession, async (c) => {
  const user = c.var.user;
  const renders = await listRecentRenders(c.env.DB, user.id, RECENT_RENDERS);
  return c.json({
    renders: renders.map((render) => ({
      id: render.cache_key,
      url: imageUrl(c.env, user.id, render.cache_key, render.format),
      template: render.template,
      source: render.source,
      width: render.width,
      height: render.height,
      format: render.format,
      bytes: render.bytes,
      charged_to: render.charged_to,
      created_at: iso(render.created_at),
      expires_at: iso(render.expires_at),
    })),
  });
});

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */

const keyJson = (key: ApiKeySummary): Record<string, unknown> => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  created_at: iso(key.created_at),
  last_used_at: isoOrNull(key.last_used_at),
});

dashboardRouter.get('/keys', requireSession, async (c) => {
  return c.json({ keys: (await listApiKeys(c.env.DB, c.var.user.id)).map(keyJson) });
});

dashboardRouter.post('/keys', requireSameOrigin, requireSession, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const name = cleanName(body.name, 'API key');
  const { row, secret } = await createApiKey(c.env.DB, c.var.user.id, name, Date.now());
  return c.json({ key: keyJson(row), secret }, 201);
});

dashboardRouter.delete('/keys/:id', requireSameOrigin, requireSession, async (c) => {
  if (!(await revokeApiKey(c.env.DB, c.var.user.id, c.req.param('id'), Date.now()))) throw notFound('API key');
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Sites and signed URLs                                               */
/* ------------------------------------------------------------------ */

const siteJson = (site: SiteRow): Record<string, unknown> => ({
  id: site.id,
  name: site.name,
  created_at: iso(site.created_at),
  secret_version: site.secret_version,
});

/** The caller's site; someone else's id is "not found" exactly like a missing one. */
async function ownSite(c: Context<AppEnv>, siteId: unknown): Promise<SiteRow> {
  const site =
    typeof siteId === 'string'
      ? await first<SiteRow>(c.env.DB, 'SELECT * FROM sites WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL', siteId, c.var.user.id)
      : null;
  if (!site) throw notFound('Site');
  return site;
}

const siteSecret = (env: Env, site: SiteRow): Promise<string> => deriveSiteSecret(env.SIGNING_MASTER_SECRET, site.id, site.secret_version);

dashboardRouter.get('/sites', requireSession, async (c) => {
  const sites = await all<SiteRow>(
    c.env.DB,
    'SELECT * FROM sites WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY created_at DESC, id',
    c.var.user.id,
  );
  return c.json({ sites: sites.map(siteJson) });
});

dashboardRouter.post('/sites', requireSameOrigin, requireSession, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const site: SiteRow = {
    id: randomId('s'),
    user_id: c.var.user.id,
    name: cleanName(body.name, 'site'),
    secret_version: 1,
    created_at: Date.now(),
    deleted_at: null,
  };
  // Derive first: without a signing master secret no site may be created at all.
  const secret = await siteSecret(c.env, site);
  // The cap is checked inside the INSERT so concurrent requests cannot overshoot it.
  const inserted = await run(
    c.env.DB,
    `INSERT INTO sites (id, user_id, name, secret_version, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT COUNT(*) FROM sites WHERE user_id = ?2 AND deleted_at IS NULL) < ?6`,
    site.id,
    site.user_id,
    site.name,
    site.secret_version,
    site.created_at,
    LIMITS.maxSitesPerUser,
  );
  if (inserted !== 1) {
    throw new ApiError('conflict', `You can have at most ${LIMITS.maxSitesPerUser} sites. Delete one to create another.`);
  }
  return c.json({ site: siteJson(site), secret }, 201);
});

dashboardRouter.get('/sites/:id/secret', requireSession, async (c) => {
  return c.json({ secret: await siteSecret(c.env, await ownSite(c, c.req.param('id'))) });
});

dashboardRouter.post('/sites/:id/rotate', requireSameOrigin, requireSession, async (c) => {
  const site = await first<SiteRow>(
    c.env.DB,
    'UPDATE sites SET secret_version = secret_version + 1 WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL RETURNING *',
    c.req.param('id'),
    c.var.user.id,
  );
  if (!site) throw notFound('Site');
  return c.json({ site: siteJson(site), secret: await siteSecret(c.env, site) });
});

dashboardRouter.delete('/sites/:id', requireSameOrigin, requireSession, async (c) => {
  const changed = await run(
    c.env.DB,
    'UPDATE sites SET deleted_at = ?1 WHERE id = ?2 AND user_id = ?3 AND deleted_at IS NULL',
    Date.now(),
    c.req.param('id'),
    c.var.user.id,
  );
  if (changed !== 1) throw notFound('Site');
  return c.json({ ok: true });
});

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function metaTags(url: string, width: number, height: number): string {
  const content = escapeAttribute(url);
  return [
    `<meta property="og:image" content="${content}">`,
    `<meta property="og:image:width" content="${width}">`,
    `<meta property="og:image:height" content="${height}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${content}">`,
  ].join('\n');
}

dashboardRouter.post('/sign', requireSameOrigin, requireSession, async (c) => {
  const body = await readJsonObject(c.req.raw);
  const site = await ownSite(c, body.site_id);
  const template = await resolveTemplate(c.env.DB, c.var.user.id, body.template);
  if (!template) throw templateNotFound();
  const format = parseFormat(body.format);
  const size = parseSize(body.size);
  const data = validateData(body.data, [SIZE_PARAM, SIG_PARAM]);

  const ext = FORMAT_TO_EXTENSION[format] as OgExtension;
  const params = size.id === 'og' ? data : { ...data, [SIZE_PARAM]: size.id };
  const url = await buildSignedUrl({
    baseUrl: c.env.APP_URL,
    siteId: site.id,
    template: template.label,
    ext,
    params,
    secret: await siteSecret(c.env, site),
  });
  return c.json({
    url,
    // The exact string that was signed, so a customer can compare it with their own signer's.
    canonical: canonicalString(new URL(url).pathname, Object.entries(params)),
    meta_tags: metaTags(url, size.width, size.height),
  });
});

/* ------------------------------------------------------------------ */
/* Billing                                                             */
/* ------------------------------------------------------------------ */

const hasActiveSubscription = (user: UserRow): boolean =>
  user.paddle_subscription_id !== null && user.subscription_status !== null && ACTIVE_SUBSCRIPTION_STATUSES.includes(user.subscription_status);

dashboardRouter.post('/billing/portal', requireSameOrigin, requireSession, async (c) => {
  const user = c.var.user;
  if (user.paddle_customer_id === null) {
    throw new ApiError('conflict', 'There is no billing account yet: it is created by your first purchase. Choose a plan on the pricing page.');
  }
  const subscriptions = hasActiveSubscription(user) && user.paddle_subscription_id ? [user.paddle_subscription_id] : [];
  const portal = await createPortalSession(c.env, user.paddle_customer_id, subscriptions);
  return c.json({
    url: portal.overviewUrl,
    ...(portal.cancelUrl ? { cancel_url: portal.cancelUrl } : {}),
    ...(portal.updatePaymentMethodUrl ? { update_payment_method_url: portal.updatePaymentMethodUrl } : {}),
  });
});

dashboardRouter.post('/billing/change-plan', requireSameOrigin, requireSession, async (c) => {
  const user = c.var.user;
  const body = await readJsonObject(c.req.raw);
  const target = PAID_PLANS.find((plan) => plan === body.plan);
  if (!target) throw new ApiError('invalid_request', '"plan" must be "starter" or "pro".');
  if (!hasActiveSubscription(user) || user.paddle_subscription_id === null) {
    throw new ApiError('conflict', 'You have no active subscription to change. Subscribe through the checkout on the pricing page.', {
      details: { action: 'checkout' },
    });
  }
  if (user.plan === target) throw new ApiError('conflict', `You are already on the ${PLANS[target].name} plan.`);
  const current = PAID_PLANS.find((plan) => plan === user.plan);
  if (!current) throw new ApiError('conflict', 'Your plan cannot be switched from here. Contact support.');
  const now = Date.now();
  const addsImages = upgradeAddsImages(current, target, await getUsage(c.env.DB, user, now), now);
  await changeSubscriptionPlan(c.env, user.paddle_subscription_id, current, target, addsImages);
  return c.json({ ok: true });
});
