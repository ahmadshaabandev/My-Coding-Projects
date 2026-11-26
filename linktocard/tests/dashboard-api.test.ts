// The dashboard API (/api/*) through the real app: session and CSRF guards,
// account, keys, sites, the URL signer, templates, preview, fonts, billing,
// the contact form and the render history.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP } from '../src/billing/plans';
import { DAY_MS, LIMITS, RATE_LIMITS } from '../src/config';
import { all, first, run } from '../src/db/client';
import { FONTS } from '../src/render/fonts';
import { STARTER_TEMPLATE_IDS } from '../src/render/templates';
import type { Env, FontRow, RateLimitBinding } from '../src/types';
import {
  ORIGIN,
  TINY_CSS,
  TINY_HTML,
  apiKeyFor,
  bytesOf,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  errorOf,
  isJpeg,
  isPng,
  pngDimensions,
  postImage,
  renderCount,
  requestUrl,
  sessionCookieFor,
  setUsed,
  signedPath,
  usageOf,
} from './app-helpers';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function signedIn(plan: 'free' | 'starter' | 'pro' = 'free') {
  const user = await createUser(plan);
  return { user, cookie: await sessionCookieFor(user.id) };
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

/** Every session route with the least body that gets past parsing. */
const SESSION_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/me'],
  ['GET', '/api/renders'],
  ['GET', '/api/keys'],
  ['POST', '/api/keys', { name: 'k' }],
  ['DELETE', '/api/keys/k_x'],
  ['GET', '/api/sites'],
  ['POST', '/api/sites', { name: 's' }],
  ['GET', '/api/sites/s_x/secret'],
  ['POST', '/api/sites/s_x/rotate', {}],
  ['DELETE', '/api/sites/s_x'],
  ['POST', '/api/sign', { site_id: 's_x', template: 'blog', data: {} }],
  ['GET', '/api/templates'],
  ['GET', '/api/templates/t_x'],
  ['POST', '/api/templates', { name: 't', html: '<b>x</b>' }],
  ['PUT', '/api/templates/t_x', { name: 't' }],
  ['DELETE', '/api/templates/t_x'],
  ['POST', '/api/preview', { template: 'blog' }],
  ['GET', '/api/fonts'],
  ['DELETE', '/api/fonts/f_x'],
  ['POST', '/api/billing/portal', {}],
  ['POST', '/api/billing/change-plan', { plan: 'pro' }],
];

describe('guards', () => {
  it('answers 401 to every session route when signed out', async () => {
    for (const [method, path, body] of SESSION_ROUTES) {
      const response = await dashboard(null, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect((await errorOf(response)).code, `${method} ${path}`).toBe('unauthorized');
    }
    const upload = await call('/api/fonts?family=Brand', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'font/woff' }, body: 'x' });
    expect(upload.status).toBe(401);
  });

  it('refuses cross-site writes and non-JSON bodies even with a valid session', async () => {
    const { user, cookie } = await signedIn();
    const crossSite = await call('/api/keys', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'stolen' }),
    });
    expect(crossSite.status).toBe(403);
    expect((await errorOf(crossSite)).code).toBe('forbidden');

    // What an HTML form on another site could send without a preflight.
    const form = await call('/api/keys', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'form' }),
    });
    expect(form.status).toBe(403);

    const crossSiteDelete = await call('/api/sites/s_x', { method: 'DELETE', headers: { cookie, origin: 'https://evil.example' } });
    expect(crossSiteDelete.status).toBe(403);
    expect(await json<{ keys: unknown[] }>(await dashboard(cookie, 'GET', '/api/keys'))).toEqual({ keys: [] });
    expect(user.plan).toBe('free');
  });

  it('treats "Content-Length: 0" as no body, the way browsers and wrangler dev send bodyless writes', async () => {
    const { user, cookie } = await signedIn();
    const key = await apiKeyFor(user.id);
    const emptyBody = (): ReadableStream<Uint8Array> => new ReadableStream({ start: (controller) => controller.close() });
    const bodyless = (method: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
      call(path, { method, headers: { cookie, origin: ORIGIN, 'content-length': '0', ...headers }, body: emptyBody() });

    const revoked = await bodyless('DELETE', `/api/keys/${key.id}`);
    expect(revoked.status).toBe(200);
    expect(await json(await dashboard(cookie, 'GET', '/api/keys'))).toEqual({ keys: [] });
    expect((await bodyless('POST', '/auth/logout')).status).toBe(200);

    // The Origin rule still applies to them.
    const other = await signedIn();
    const theirKey = await apiKeyFor(other.user.id);
    const crossSite = await call(`/api/keys/${theirKey.id}`, {
      method: 'DELETE',
      headers: { cookie: other.cookie, origin: 'https://evil.example', 'content-length': '0' },
      body: emptyBody(),
    });
    expect(crossSite.status).toBe(403);
  });

  it('lets a suspended account read /api/me and nothing else', async () => {
    const { user, cookie } = await signedIn();
    await run(env.DB, 'UPDATE users SET suspended_at = ?1 WHERE id = ?2', Date.now(), user.id);
    const me = await dashboard(cookie, 'GET', '/api/me');
    expect(me.status).toBe(200);
    expect((await json<{ user: { suspended: boolean } }>(me)).user.suspended).toBe(true);
    for (const [method, path, body] of SESSION_ROUTES.filter(([, path]) => path !== '/api/me')) {
      const response = await dashboard(cookie, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await errorOf(response)).code, `${method} ${path}`).toBe('account_suspended');
    }
  });
});

describe('GET /api/config and /api/me', () => {
  it('publishes plans, sizes and the Paddle client settings, cacheable for five minutes', async () => {
    const response = await call('/api/config');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const config = await json<Record<string, unknown>>(response);
    expect(config).toMatchObject({
      app_url: env.APP_URL,
      support_email: env.SUPPORT_EMAIL,
      environment: 'test',
      paddle: {
        environment: 'sandbox',
        client_token: env.PADDLE_CLIENT_TOKEN,
        prices: { starter: env.PADDLE_PRICE_STARTER, pro: env.PADDLE_PRICE_PRO, topup: env.PADDLE_PRICE_TOPUP },
      },
      topup: { price_usd: TOPUP.priceUsd, images: TOPUP.images, valid_days: TOPUP.validDays },
      sizes: [
        { id: 'og', width: 1200, height: 630 },
        { id: 'square', width: 1080, height: 1080 },
        { id: 'portrait', width: 1080, height: 1350 },
        { id: 'email', width: 1200, height: 400 },
      ],
      formats: ['png', 'jpeg', 'webp'],
    });
    expect(config.plans).toEqual(
      (['free', 'starter', 'pro'] as const).map((id) => ({
        id,
        name: PLANS[id].name,
        price_usd: PLANS[id].priceUsd,
        monthly_images: PLANS[id].monthlyImages,
        cache_days: PLANS[id].cacheDays,
        watermark: PLANS[id].watermark,
        fonts: { max_files: PLANS[id].fonts.maxFiles, max_bytes_per_file: PLANS[id].fonts.maxBytesPerFile },
        top_ups: PLANS[id].topUps,
      })),
    );
    // No secret of any kind is published.
    expect(JSON.stringify(config)).not.toContain(env.PADDLE_API_KEY);
    expect(JSON.stringify(config)).not.toContain(env.SIGNING_MASTER_SECRET);
  });

  it('reports paddle as null until checkout is configured', async () => {
    const response = await call('/api/config', {}, { ...env, PADDLE_CLIENT_TOKEN: '' });
    expect((await json<{ paddle: unknown }>(response)).paddle).toBeNull();
  });

  it('describes the signed-in account: plan, subscription, usage, top-ups and limits', async () => {
    const { user, cookie } = await signedIn('starter');
    const now = Date.now();
    const periodEnd = now + 10 * DAY_MS;
    await run(
      env.DB,
      `UPDATE users SET paddle_customer_id = 'ctm_me', paddle_subscription_id = 'sub_me', subscription_status = 'active',
       period_start = ?1, period_end = ?2, cancel_at = ?2 WHERE id = ?3`,
      now - 20 * DAY_MS,
      periodEnd,
      user.id,
    );
    await run(
      env.DB,
      `INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at, refunded_at) VALUES
       ('tu_me_live', ?1, 'txn_me_live', 1000, 640, ?2, ?3, NULL),
       ('tu_me_spent', ?1, 'txn_me_spent', 1000, 0, ?2, ?3, NULL),
       ('tu_me_refunded', ?1, 'txn_me_refunded', 1000, 1000, ?2, ?3, ?2),
       ('tu_me_expired', ?1, 'txn_me_expired', 1000, 1000, ?2, ?2, NULL)`,
      user.id,
      now - DAY_MS,
      now + 100 * DAY_MS,
    );
    const me = await json<Record<string, unknown>>(await dashboard(cookie, 'GET', '/api/me'));
    expect(me).toEqual({
      user: {
        id: user.id,
        email: user.email,
        plan: 'starter',
        created_at: new Date(user.created_at).toISOString(),
        suspended: false,
        subscription: { status: 'active', period_end: new Date(periodEnd).toISOString(), cancel_at: new Date(periodEnd).toISOString() },
        has_billing: true,
      },
      usage: expect.objectContaining({ plan: 'starter', limit: 2000, used: 0, topup_remaining: 640, period_end: new Date(periodEnd).toISOString() }),
      topups: [{ id: 'tu_me_live', images: 1000, remaining: 640, expires_at: new Date(now + 100 * DAY_MS).toISOString() }],
      limits: {
        fonts: { max_files: PLANS.starter.fonts.maxFiles, max_bytes_per_file: PLANS.starter.fonts.maxBytesPerFile },
        templates: LIMITS.maxTemplatesPerUser,
        sites: LIMITS.maxSitesPerUser,
        api_keys: LIMITS.maxApiKeysPerUser,
      },
    });

    const free = await signedIn();
    const freeMe = await json<{ user: Record<string, unknown>; topups: unknown[] }>(await dashboard(free.cookie, 'GET', '/api/me'));
    expect(freeMe.user).toMatchObject({ plan: 'free', subscription: null, has_billing: false });
    expect(freeMe.topups).toEqual([]);
  });
});

describe('API keys', () => {
  it('creates a key whose secret is shown once, lists it without the secret and revokes it', async () => {
    const { cookie } = await signedIn();
    const created = await dashboard(cookie, 'POST', '/api/keys', { name: '  Production   server ' });
    expect(created.status).toBe(201);
    const { key, secret } = await json<{ key: Record<string, string | null>; secret: string }>(created);
    expect(secret).toMatch(/^ltc_/);
    expect(key).toMatchObject({ name: 'Production server', last_used_at: null });
    expect(key.id).toMatch(/^k_/);
    expect(secret.startsWith(key.prefix!)).toBe(true);
    expect(Object.keys(key).sort()).toEqual(['created_at', 'id', 'last_used_at', 'name', 'prefix']);

    const listed = await dashboard(cookie, 'GET', '/api/keys');
    expect(JSON.stringify(await listed.clone().json())).not.toContain(secret);
    expect((await json<{ keys: Array<{ id: string }> }>(listed)).keys.map((entry) => entry.id)).toEqual([key.id]);

    expect(await json(await dashboard(cookie, 'DELETE', `/api/keys/${key.id}`))).toEqual({ ok: true });
    expect((await dashboard(cookie, 'DELETE', `/api/keys/${key.id}`)).status).toBe(404);
    expect(await json(await dashboard(cookie, 'GET', '/api/keys'))).toEqual({ keys: [] });
  });

  it('validates the name, enforces the cap and hides other accounts\' keys', async () => {
    const { user, cookie } = await signedIn();
    for (const name of [undefined, '', '   ', 'x'.repeat(LIMITS.maxNameChars + 1), 42]) {
      const response = await dashboard(cookie, 'POST', '/api/keys', { name });
      expect(response.status, String(name)).toBe(400);
    }
    for (let i = 0; i < LIMITS.maxApiKeysPerUser; i++) await apiKeyFor(user.id);
    const overCap = await dashboard(cookie, 'POST', '/api/keys', { name: 'one too many' });
    expect(overCap.status).toBe(409);
    expect((await errorOf(overCap)).code).toBe('conflict');

    const other = await signedIn();
    const theirs = await apiKeyFor(other.user.id);
    const stolen = await dashboard(cookie, 'DELETE', `/api/keys/${theirs.id}`);
    expect(stolen.status).toBe(404);
    expect(await json<{ keys: unknown[] }>(await dashboard(other.cookie, 'GET', '/api/keys'))).toMatchObject({ keys: [{ id: theirs.id }] });
  });
});

describe('sites and the URL signer', () => {
  it('creates a site, shows its secret again, rotates it and deletes it', async () => {
    const { cookie } = await signedIn();
    const created = await dashboard(cookie, 'POST', '/api/sites', { name: 'My blog' });
    expect(created.status).toBe(201);
    const { site, secret } = await json<{ site: { id: string; name: string; secret_version: number; created_at: string }; secret: string }>(created);
    expect(site).toMatchObject({ name: 'My blog', secret_version: 1 });
    expect(site.id).toMatch(/^s_/);
    expect(secret).toMatch(/^ltcs_/);

    expect(await json(await dashboard(cookie, 'GET', `/api/sites/${site.id}/secret`))).toEqual({ secret });
    expect((await json<{ sites: unknown[] }>(await dashboard(cookie, 'GET', '/api/sites'))).sites).toEqual([site]);

    const rotated = await json<{ site: { secret_version: number }; secret: string }>(await dashboard(cookie, 'POST', `/api/sites/${site.id}/rotate`, {}));
    expect(rotated.site.secret_version).toBe(2);
    expect(rotated.secret).not.toBe(secret);
    expect(await json(await dashboard(cookie, 'GET', `/api/sites/${site.id}/secret`))).toEqual({ secret: rotated.secret });

    expect(await json(await dashboard(cookie, 'DELETE', `/api/sites/${site.id}`))).toEqual({ ok: true });
    for (const [method, path] of [['GET', `/api/sites/${site.id}/secret`], ['POST', `/api/sites/${site.id}/rotate`], ['DELETE', `/api/sites/${site.id}`]] as const) {
      expect((await dashboard(cookie, method, path, method === 'POST' ? {} : undefined)).status).toBe(404);
    }
    expect(await json(await dashboard(cookie, 'GET', '/api/sites'))).toEqual({ sites: [] });
  });

  it('hides other accounts\' sites, enforces the cap and needs the signing secret', async () => {
    const { user, cookie } = await signedIn();
    const other = await signedIn();
    const theirs = await createSite(other.user.id);
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/api/sites/${theirs.id}/secret`],
      ['POST', `/api/sites/${theirs.id}/rotate`, {}],
      ['DELETE', `/api/sites/${theirs.id}`],
      ['POST', '/api/sign', { site_id: theirs.id, template: 'blog', data: { title: 'x' } }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await dashboard(cookie, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect((await first<{ secret_version: number; deleted_at: number | null }>(env.DB, 'SELECT * FROM sites WHERE id = ?1', theirs.id))).toMatchObject({
      secret_version: 1,
      deleted_at: null,
    });

    const unconfigured = await dashboard(cookie, 'POST', '/api/sites', { name: 'No secret' }, { ...env, SIGNING_MASTER_SECRET: '' });
    expect(unconfigured.status).toBe(503);
    expect((await errorOf(unconfigured)).code).toBe('not_configured');
    expect(await json(await dashboard(cookie, 'GET', '/api/sites'))).toEqual({ sites: [] });

    for (let i = 0; i < LIMITS.maxSitesPerUser; i++) await createSite(user.id);
    const overCap = await dashboard(cookie, 'POST', '/api/sites', { name: 'one too many' });
    expect(overCap.status).toBe(409);
    expect((await errorOf(overCap)).code).toBe('conflict');
    expect((await dashboard(cookie, 'POST', '/api/sites', { name: '' })).status).toBe(400);
  });

  it('signs a URL that the card endpoint accepts, with ready-to-paste meta tags, without rendering anything', async () => {
    const { user, cookie } = await signedIn();
    const site = await createSite(user.id);
    const signed = await dashboard(cookie, 'POST', '/api/sign', {
      site_id: site.id,
      template: 'blog',
      data: { title: 'Ampersands & "quotes"', author: 'Ahmad' },
    });
    expect(signed.status).toBe(200);
    const { url, canonical, meta_tags: metaTags } = await json<{ url: string; canonical: string; meta_tags: string }>(signed);
    expect(url.startsWith(`${ORIGIN}/v1/og/${site.id}/blog.png?`)).toBe(true);
    expect(url).not.toContain('size=');
    expect(canonical).toBe(`/v1/og/${site.id}/blog.png\nauthor,title\nauthor=Ahmad\ntitle=Ampersands & "quotes"`);
    expect(metaTags.split('\n')).toEqual([
      `<meta property="og:image" content="${url.replaceAll('&', '&amp;')}">`,
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta name="twitter:card" content="summary_large_image">',
      `<meta name="twitter:image" content="${url.replaceAll('&', '&amp;')}">`,
    ]);
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);

    const card = await call(url.slice(ORIGIN.length));
    expect(card.status).toBe(200);
    expect(isPng(await bytesOf(card))).toBe(true);

    const square = await json<{ url: string; canonical: string; meta_tags: string }>(
      await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'quote', format: 'jpeg', size: 'square', data: { quote: 'Hi' } }),
    );
    expect(square.url).toContain(`/v1/og/${site.id}/quote.jpg?`);
    expect(new URL(square.url).searchParams.get('size')).toBe('square');
    expect(square.canonical).toContain('\nquote,size\n');
    expect(square.meta_tags).toContain('content="1080"');
    const squareCard = await call(square.url.slice(ORIGIN.length));
    expect(squareCard.headers.get('content-type')).toBe('image/jpeg');
    expect(isJpeg(await bytesOf(squareCard))).toBe(true);
  });

  it('signs for the account\'s own custom template only, and validates the request', async () => {
    const { user, cookie } = await signedIn();
    const other = await signedIn();
    const site = await createSite(user.id);
    const mine = await createTemplate(cookie);
    const theirs = await createTemplate(other.cookie);

    const own = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: mine, data: { title: 'Mine' } });
    expect((await json<{ url: string }>(own)).url).toContain(`/${mine}.png?`);

    const rejected: Array<[Record<string, unknown>, number, string]> = [
      [{ site_id: site.id, template: theirs, data: {} }, 404, 'not_found'],
      [{ site_id: site.id, template: 'nope', data: {} }, 404, 'not_found'],
      [{ template: 'blog', data: {} }, 404, 'not_found'],
      [{ site_id: site.id, template: 'blog', data: { sig: 'abc' } }, 400, 'invalid_request'],
      [{ site_id: site.id, template: 'blog', data: { size: 'square' } }, 400, 'invalid_request'],
      [{ site_id: site.id, template: 'blog', data: { Title: 'x' } }, 400, 'invalid_request'],
      [{ site_id: site.id, template: 'blog', data: { title: 'line\nbreak' } }, 400, 'invalid_request'],
      [{ site_id: site.id, template: 'blog', size: 'huge', data: {} }, 400, 'unsupported_size'],
      [{ site_id: site.id, template: 'blog', format: 'bmp', data: {} }, 400, 'unsupported_format'],
    ];
    for (const [body, status, code] of rejected) {
      const response = await dashboard(cookie, 'POST', '/api/sign', body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect((await errorOf(response)).code, JSON.stringify(body)).toBe(code);
    }
  });
});

describe('templates', () => {
  interface TemplateJson {
    id: string;
    name: string;
    html: string;
    css: string;
    version: number;
    created_at: string;
    updated_at: string;
  }

  it('refuses to create or save a template whose HTML is empty, so no live card can be broken that way', async () => {
    const { cookie } = await signedIn();
    for (const html of ['', '   \n\t']) {
      const created = await dashboard(cookie, 'POST', '/api/templates', { name: 'Empty', html, css: '' });
      expect(created.status).toBe(400);
      expect((await errorOf(created)).message).toContain('The template HTML is empty');
    }
    const { template } = await json<{ template: TemplateJson }>(await dashboard(cookie, 'POST', '/api/templates', { name: 'Card', html: TINY_HTML, css: TINY_CSS }));
    const emptied = await dashboard(cookie, 'PUT', `/api/templates/${template.id}`, { html: ' ' });
    expect(emptied.status).toBe(400);
    expect(await json(await dashboard(cookie, 'GET', `/api/templates/${template.id}`))).toEqual({ template });
  });

  it('lists starters with their source and sample, and creates, reads, updates and deletes custom templates', async () => {
    const { cookie } = await signedIn();
    const created = await dashboard(cookie, 'POST', '/api/templates', { name: 'Launch card', html: TINY_HTML, css: TINY_CSS });
    expect(created.status).toBe(201);
    const { template, warnings } = await json<{ template: TemplateJson; warnings: string[] }>(created);
    expect(template).toMatchObject({ name: 'Launch card', html: TINY_HTML, css: TINY_CSS, version: 1 });
    expect(template.id).toMatch(/^t_/);
    expect(warnings).toEqual([]);

    const list = await json<{ starter: Array<Record<string, unknown>>; custom: Array<Record<string, unknown>> }>(
      await dashboard(cookie, 'GET', '/api/templates'),
    );
    expect(list.starter.map((starter) => starter.id)).toEqual([...STARTER_TEMPLATE_IDS]);
    for (const starter of list.starter) {
      expect(Object.keys(starter).sort()).toEqual(['css', 'description', 'fields', 'html', 'id', 'name', 'sample']);
      expect(typeof starter.html).toBe('string');
    }
    expect(list.custom).toEqual([{ id: template.id, name: 'Launch card', version: 1, updated_at: template.updated_at }]);
    expect(await json(await dashboard(cookie, 'GET', `/api/templates/${template.id}`))).toEqual({ template });

    // A new name is not a new version; new source is.
    const renamed = await json<{ template: TemplateJson }>(await dashboard(cookie, 'PUT', `/api/templates/${template.id}`, { name: 'Renamed' }));
    expect(renamed.template).toMatchObject({ name: 'Renamed', version: 1, html: TINY_HTML });
    const same = await json<{ template: TemplateJson }>(await dashboard(cookie, 'PUT', `/api/templates/${template.id}`, { html: TINY_HTML, css: TINY_CSS }));
    expect(same.template.version).toBe(1);
    const edited = await json<{ template: TemplateJson; warnings: string[] }>(
      await dashboard(cookie, 'PUT', `/api/templates/${template.id}`, { css: `${TINY_CSS} .title { color: #b91c1c; }` }),
    );
    expect(edited.template).toMatchObject({ name: 'Renamed', version: 2, html: TINY_HTML });

    const withWarning = await json<{ warnings: string[] }>(
      await dashboard(cookie, 'PUT', `/api/templates/${template.id}`, { html: '<div class="card"><button>Buy</button>{{title}}</div>' }),
    );
    expect(withWarning.warnings.length).toBeGreaterThan(0);

    expect(await json(await dashboard(cookie, 'DELETE', `/api/templates/${template.id}`))).toEqual({ ok: true });
    for (const [method, body] of [['GET', undefined], ['PUT', { name: 'x' }], ['DELETE', undefined]] as const) {
      expect((await dashboard(cookie, method, `/api/templates/${template.id}`, body)).status).toBe(404);
    }
    expect((await json<{ custom: unknown[] }>(await dashboard(cookie, 'GET', '/api/templates'))).custom).toEqual([]);
  });

  it('refuses invalid templates, other accounts\' templates and more than the cap', async () => {
    const { user, cookie } = await signedIn();
    const other = await signedIn();
    const theirs = await createTemplate(other.cookie);
    for (const [method, body] of [['GET', undefined], ['PUT', { html: '<b>hijacked</b>' }], ['DELETE', undefined]] as const) {
      expect((await dashboard(cookie, method, `/api/templates/${theirs}`, body)).status, method).toBe(404);
    }
    expect((await json<{ template: { html: string } }>(await dashboard(other.cookie, 'GET', `/api/templates/${theirs}`))).template.html).toBe(TINY_HTML);

    const invalid: Array<[Record<string, unknown>, number]> = [
      [{ name: 'No html' }, 400],
      [{ name: 'Bad css', html: '<b>x</b>', css: 5 }, 400],
      [{ html: '<b>x</b>' }, 400],
      [{ name: 'Too big', html: `<div>${'x'.repeat(LIMITS.maxHtmlBytes)}</div>` }, 413],
      [{ name: 'Too many nodes', html: `<div>${'<i>x</i>'.repeat(LIMITS.maxNodes + 10)}</div>` }, 422],
    ];
    for (const [body, status] of invalid) {
      expect((await dashboard(cookie, 'POST', '/api/templates', body)).status, String(body.name)).toBe(status);
    }
    const mine = await createTemplate(cookie);
    const brokenEdit = await dashboard(cookie, 'PUT', `/api/templates/${mine}`, { html: `<div>${'<i>x</i>'.repeat(LIMITS.maxNodes + 10)}</div>` });
    expect(brokenEdit.status).toBe(422);
    expect((await json<{ template: { html: string; version: number } }>(await dashboard(cookie, 'GET', `/api/templates/${mine}`))).template).toMatchObject({
      html: TINY_HTML,
      version: 1,
    });

    const now = Date.now();
    for (let i = 1; i < LIMITS.maxTemplatesPerUser; i++) {
      await run(
        env.DB,
        'INSERT INTO templates (id, user_id, name, html, css, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)',
        `t_cap_${user.id}_${i}`,
        user.id,
        `Template ${i}`,
        '<b>x</b>',
        '',
        now,
      );
    }
    const overCap = await dashboard(cookie, 'POST', '/api/templates', { name: 'One too many', html: '<b>x</b>' });
    expect(overCap.status).toBe(409);
    expect((await errorOf(overCap)).code).toBe('conflict');
  });
});

describe('POST /api/preview', () => {
  it('returns a watermarked image that is neither stored nor counted, even at the limit', async () => {
    const { user, cookie } = await signedIn();
    await setUsed(user, PLANS.free.monthlyImages);
    const response = await dashboard(cookie, 'POST', '/api/preview', { html: TINY_HTML, css: TINY_CSS, data: { title: 'Preview' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-ltc-warnings')!))).toEqual([]);
    const bytes = await bytesOf(response);
    expect(isPng(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });

    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(PLANS.free.monthlyImages);
    expect((await env.BUCKET.list({ prefix: `r/${user.id}/` })).objects).toEqual([]);
  });

  it('differs from the same card rendered for real (the preview watermark is always on)', async () => {
    const { user, cookie } = await signedIn('starter');
    const key = await apiKeyFor(user.id);
    const body = { html: TINY_HTML, css: TINY_CSS, data: { title: 'Paid plan' } };
    const preview = await bytesOf(await dashboard(cookie, 'POST', '/api/preview', body));
    const real = await bytesOf(await postImage(key.secret, { ...body, response: 'binary' }));
    expect(isPng(preview) && isPng(real)).toBe(true);
    expect(preview).not.toEqual(real);
  });

  it('renders starters and own templates in any size and format, reports warnings and validates like the API', async () => {
    const { cookie } = await signedIn();
    const other = await signedIn();
    const mine = await createTemplate(cookie);
    const theirs = await createTemplate(other.cookie);

    const square = await dashboard(cookie, 'POST', '/api/preview', { template: 'blog', data: { title: 'Square' }, size: 'square', format: 'jpeg' });
    expect(square.headers.get('content-type')).toBe('image/jpeg');
    expect(isJpeg(await bytesOf(square))).toBe(true);
    expect((await dashboard(cookie, 'POST', '/api/preview', { template: mine, data: { title: 'Mine' } })).status).toBe(200);

    const warned = await dashboard(cookie, 'POST', '/api/preview', { html: '<div class="card"><button>Buy</button>x</div>', css: TINY_CSS });
    expect((JSON.parse(decodeURIComponent(warned.headers.get('x-ltc-warnings')!)) as string[]).length).toBeGreaterThan(0);

    const rejected: Array<[Record<string, unknown>, number, string]> = [
      [{ template: theirs }, 404, 'not_found'],
      [{ template: 'blog', response: 'binary' }, 400, 'invalid_request'],
      [{ template: 'blog', data: { 'bad key': 'x' } }, 400, 'invalid_request'],
      [{ html: `<div>${'<i>x</i>'.repeat(LIMITS.maxNodes + 10)}</div>` }, 422, 'template_error'],
      [{ html: '<img src="{{image}}">', data: { image: 'http://127.0.0.1/x.png' } }, 422, 'image_fetch_failed'],
    ];
    for (const [body, status, code] of rejected) {
      const response = await dashboard(cookie, 'POST', '/api/preview', body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
  });

  it('is rate-limited per account', async () => {
    const { user, cookie } = await signedIn();
    const keys: string[] = [];
    const deny: RateLimitBinding = {
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    };
    const bindings: Env = { ...env, RATE_LIMITS_DISABLED: '0', RL_PREVIEW: deny };
    const response = await dashboard(cookie, 'POST', '/api/preview', { template: 'blog' }, bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe(String(RATE_LIMITS.RL_PREVIEW.periodSeconds));
    expect(keys).toEqual([user.id]);
  });
});

describe('fonts', () => {
  const WOFF = new Uint8Array(FONTS[0]!.data);
  const FONT_CSS = '.card { display: flex; font-family: "Brand Sans"; font-size: 60px; }';
  const FONT_CARD = { html: '<div class="card">{{title}}</div>', css: FONT_CSS, data: { title: 'Custom font' } };

  function upload(cookie: string | null, query: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return call(`/api/fonts?${query}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'font/woff', ...(cookie ? { cookie } : {}), ...headers },
      body,
    });
  }

  const fontRows = (userId: string): Promise<FontRow[]> => all<FontRow>(env.DB, 'SELECT * FROM fonts WHERE user_id = ?1', userId);
  const fontObjects = async (userId: string): Promise<string[]> => (await env.BUCKET.list({ prefix: `f/${userId}/` })).objects.map((object) => object.key);

  async function previewWarnings(cookie: string): Promise<string[]> {
    const response = await dashboard(cookie, 'POST', '/api/preview', FONT_CARD);
    expect(response.status).toBe(200);
    return JSON.parse(decodeURIComponent(response.headers.get('x-ltc-warnings')!)) as string[];
  }
  const missingFont = (warnings: string[]): boolean => warnings.some((warning) => warning.includes('Font families not available'));

  it('uploading is a paid feature: a Free account gets 403 plan_required and nothing is stored', async () => {
    const { user, cookie } = await signedIn();
    const response = await upload(cookie, 'family=Brand%20Sans', WOFF);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('plan_required');
    expect(await fontRows(user.id)).toEqual([]);

    const list = await dashboard(cookie, 'GET', '/api/fonts');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ fonts: [], limits: { max_files: 0, max_bytes_per_file: 0 } });
    expect((await dashboard(cookie, 'DELETE', '/api/fonts/f_x')).status).toBe(404);
  });

  it('an account that went back to Free can still list and delete the fonts it uploaded', async () => {
    const { user, cookie } = await signedIn('starter');
    const uploaded = await upload(cookie, 'family=Leftover%20Sans', WOFF);
    expect(uploaded.status).toBe(201);
    const { font } = (await uploaded.json()) as { font: { id: string } };
    await run(env.DB, "UPDATE users SET plan = 'free' WHERE id = ?1", user.id);

    const list = (await (await dashboard(cookie, 'GET', '/api/fonts')).json()) as { fonts: { id: string }[]; limits: { max_files: number } };
    expect(list.fonts.map((entry) => entry.id)).toEqual([font.id]);
    expect(list.limits.max_files).toBe(0);
    expect((await upload(cookie, 'family=Another%20Sans', WOFF)).status).toBe(403);

    expect((await dashboard(cookie, 'DELETE', `/api/fonts/${font.id}`)).status).toBe(200);
    expect(await fontObjects(user.id)).toEqual([]);
    expect((await dashboard(cookie, 'GET', '/api/fonts').then((r) => r.json())) as { fonts: unknown[] }).toMatchObject({ fonts: [] });
  });

  it('accepts a font that renders, uses it in the account\'s cards, lists it and deletes it', async () => {
    const { user, cookie } = await signedIn('starter');
    expect(missingFont(await previewWarnings(cookie))).toBe(true);

    const uploaded = await upload(cookie, 'family=Brand%20Sans&weight=700&style=italic', WOFF);
    expect(uploaded.status).toBe(201);
    const { font } = await json<{ font: Record<string, unknown> }>(uploaded);
    expect(font).toMatchObject({ family: 'Brand Sans', weight: 700, style: 'italic', format: 'woff', bytes: WOFF.byteLength });
    expect(String(font.id)).toMatch(/^f_/);
    expect(Object.keys(font).sort()).toEqual(['bytes', 'created_at', 'family', 'format', 'id', 'style', 'weight']);
    expect(await fontObjects(user.id)).toEqual([`f/${user.id}/${String(font.id)}`]);

    expect(missingFont(await previewWarnings(cookie))).toBe(false);
    expect(await json(await dashboard(cookie, 'GET', '/api/fonts'))).toEqual({
      fonts: [font],
      limits: { max_files: PLANS.starter.fonts.maxFiles, max_bytes_per_file: PLANS.starter.fonts.maxBytesPerFile },
    });

    // Another account neither sees nor can delete it, and its cards do not get the font.
    const other = await signedIn('starter');
    expect((await json<{ fonts: unknown[] }>(await dashboard(other.cookie, 'GET', '/api/fonts'))).fonts).toEqual([]);
    expect((await dashboard(other.cookie, 'DELETE', `/api/fonts/${String(font.id)}`)).status).toBe(404);
    expect(missingFont(await previewWarnings(other.cookie))).toBe(true);

    // Fonts are used only while the account is on a paid plan.
    await run(env.DB, "UPDATE users SET plan = 'free' WHERE id = ?1", user.id);
    expect(missingFont(await previewWarnings(cookie))).toBe(true);
    await run(env.DB, "UPDATE users SET plan = 'starter' WHERE id = ?1", user.id);

    expect(await json(await dashboard(cookie, 'DELETE', `/api/fonts/${String(font.id)}`))).toEqual({ ok: true });
    expect(await fontObjects(user.id)).toEqual([]);
    expect((await dashboard(cookie, 'DELETE', `/api/fonts/${String(font.id)}`)).status).toBe(404);
    expect(missingFont(await previewWarnings(cookie))).toBe(true);
  });

  it('refuses files that are not usable fonts and stores nothing', async () => {
    const { user, cookie } = await signedIn('starter');
    const garbage = (magic: number[]): Uint8Array => {
      const bytes = new Uint8Array(4096).map((_, index) => (index * 37) % 251);
      bytes.set(magic);
      return bytes;
    };
    const truncated = WOFF.slice(0, 600);
    const cases: Array<[string, Uint8Array, string]> = [
      ['TrueType magic, garbage inside', garbage([0x00, 0x01, 0x00, 0x00]), 'could not be used as a font'],
      ['OpenType magic, garbage inside', garbage([0x4f, 0x54, 0x54, 0x4f]), 'could not be used as a font'],
      ['a truncated WOFF', truncated, 'could not be used as a font'],
      ['WOFF2', garbage([0x77, 0x4f, 0x46, 0x32]), 'Convert the file to WOFF, TTF or OTF'],
      ['a font collection', garbage([0x74, 0x74, 0x63, 0x66]), 'Font collections'],
      ['a PNG', garbage([0x89, 0x50, 0x4e, 0x47]), 'not a font'],
      ['three bytes', new Uint8Array([1, 2, 3]), 'not a font'],
    ];
    for (const [label, bytes, fragment] of cases) {
      const response = await upload(cookie, 'family=Brand%20Sans', bytes);
      expect(response.status, label).toBe(400);
      const error = await errorOf(response);
      expect(error.code, label).toBe('invalid_request');
      expect(error.message, label).toContain(fragment);
    }
    expect(await fontRows(user.id)).toEqual([]);
    expect(await fontObjects(user.id)).toEqual([]);
    // A refused font leaves the renderer healthy.
    expect((await dashboard(cookie, 'POST', '/api/preview', FONT_CARD)).status).toBe(200);
    expect((await upload(cookie, 'family=Brand%20Sans', WOFF)).status).toBe(201);
  });

  it('validates the descriptor, the origin, the content type and the plan caps', async () => {
    const { user, cookie } = await signedIn('starter');
    const badDescriptors = [
      '',
      'family=',
      'family=Inter',
      'family=sans-serif',
      'family=inter%20latin%20ext',
      'family=Bad%22Name',
      `family=${'x'.repeat(65)}`,
      'family=Brand&weight=450',
      'family=Brand&weight=1000',
      'family=Brand&weight=bold',
      'family=Brand&style=oblique',
    ];
    for (const query of badDescriptors) {
      const response = await upload(cookie, query, WOFF);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code, query).toBe('invalid_request');
    }

    const noOrigin = await call('/api/fonts?family=Brand', { method: 'POST', headers: { cookie, 'content-type': 'font/woff' }, body: WOFF });
    expect(noOrigin.status).toBe(403);
    const crossSite = await upload(cookie, 'family=Brand', WOFF, { origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    expect((await errorOf(crossSite)).code).toBe('forbidden');

    const wrongType = await upload(cookie, 'family=Brand', WOFF, { 'content-type': 'application/json' });
    expect(wrongType.status).toBe(415);
    expect((await upload(cookie, 'family=Brand', new Uint8Array(0))).status).toBe(400);

    const tooBig = await upload(cookie, 'family=Brand', new Uint8Array(PLANS.starter.fonts.maxBytesPerFile + 1));
    expect(tooBig.status).toBe(413);
    expect((await errorOf(tooBig)).details).toEqual({ max_bytes: PLANS.starter.fonts.maxBytesPerFile });

    // Defaults: weight 400, style normal; octet-stream is accepted because the bytes decide.
    const first = await upload(cookie, 'family=Brand', WOFF, { 'content-type': 'application/octet-stream' });
    expect(first.status).toBe(201);
    expect((await json<{ font: Record<string, unknown> }>(first)).font).toMatchObject({ weight: 400, style: 'normal' });

    const duplicate = await upload(cookie, 'family=brand&weight=400&style=normal', WOFF);
    expect(duplicate.status).toBe(409);
    expect((await errorOf(duplicate)).message).toContain('already have');

    expect((await upload(cookie, 'family=Brand&weight=700', WOFF)).status).toBe(201);
    expect((await upload(cookie, 'family=Brand&weight=800', WOFF)).status).toBe(201);
    const overCap = await upload(cookie, 'family=Brand&weight=900', WOFF);
    expect(overCap.status).toBe(409);
    expect((await errorOf(overCap)).details).toEqual({ max_files: PLANS.starter.fonts.maxFiles });
    expect(await fontRows(user.id)).toHaveLength(PLANS.starter.fonts.maxFiles);
    expect(await fontObjects(user.id)).toHaveLength(PLANS.starter.fonts.maxFiles);
  });
});

describe('billing', () => {
  interface PaddleCall {
    url: string;
    method: string | undefined;
    body: unknown;
  }

  function mockPaddleApi(respond: () => Response): PaddleCall[] {
    const calls: PaddleCall[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.origin !== 'https://sandbox-api.paddle.com') throw new Error(`unexpected fetch ${url.href}`);
      calls.push({ url: url.href, method: init?.method, body: JSON.parse(String(init?.body)) });
      return respond();
    });
    return calls;
  }

  async function subscriber(plan: 'starter' | 'pro', status = 'active') {
    const account = await signedIn(plan);
    const customerId = `ctm_${account.user.id}`;
    const subscriptionId = `sub_${account.user.id}`;
    await run(
      env.DB,
      'UPDATE users SET paddle_customer_id = ?1, paddle_subscription_id = ?2, subscription_status = ?3 WHERE id = ?4',
      customerId,
      subscriptionId,
      status,
      account.user.id,
    );
    return { ...account, customerId, subscriptionId };
  }

  it('opens the customer portal for an account with a Paddle customer', async () => {
    const { cookie, customerId, subscriptionId } = await subscriber('starter');
    const calls = mockPaddleApi(() =>
      Response.json(
        {
          data: {
            urls: {
              general: { overview: 'https://customer-portal.paddle.com/cpl_1?action=overview' },
              subscriptions: [
                {
                  id: subscriptionId,
                  cancel_subscription: 'https://customer-portal.paddle.com/cpl_1?action=cancel',
                  update_subscription_payment_method: 'https://customer-portal.paddle.com/cpl_1?action=update',
                },
              ],
            },
          },
        },
        { status: 201 },
      ),
    );
    const response = await dashboard(cookie, 'POST', '/api/billing/portal', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://customer-portal.paddle.com/cpl_1?action=overview',
      cancel_url: 'https://customer-portal.paddle.com/cpl_1?action=cancel',
      update_payment_method_url: 'https://customer-portal.paddle.com/cpl_1?action=update',
    });
    expect(calls).toEqual([
      { url: `https://sandbox-api.paddle.com/customers/${customerId}/portal-sessions`, method: 'POST', body: { subscription_ids: [subscriptionId] } },
    ]);
  });

  it('answers 409 for the portal before the first purchase', async () => {
    const { cookie } = await signedIn();
    const calls = mockPaddleApi(() => Response.json({}));
    const response = await dashboard(cookie, 'POST', '/api/billing/portal', {});
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('conflict');
    expect(calls).toEqual([]);
  });

  it('changes the plan of an active subscription and sends everyone else to checkout', async () => {
    const active = await subscriber('starter');
    const calls = mockPaddleApi(() => Response.json({ data: { id: active.subscriptionId, status: 'active' } }));
    const changed = await dashboard(active.cookie, 'POST', '/api/billing/change-plan', { plan: 'pro' });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: `https://sandbox-api.paddle.com/subscriptions/${active.subscriptionId}`,
        method: 'PATCH',
        body: { items: [{ price_id: env.PADDLE_PRICE_PRO, quantity: 1 }], proration_billing_mode: 'prorated_immediately' },
      },
    ]);

    const samePlan = await dashboard(active.cookie, 'POST', '/api/billing/change-plan', { plan: 'starter' });
    expect(samePlan.status).toBe(409);
    for (const plan of ['free', 'enterprise', undefined]) {
      expect((await dashboard(active.cookie, 'POST', '/api/billing/change-plan', { plan })).status).toBe(400);
    }

    const free = await signedIn();
    const canceled = await subscriber('starter', 'canceled');
    for (const { cookie } of [free, canceled]) {
      const response = await dashboard(cookie, 'POST', '/api/billing/change-plan', { plan: 'pro' });
      expect(response.status).toBe(409);
      expect((await errorOf(response)).details).toEqual({ action: 'checkout' });
    }
    expect(calls).toHaveLength(1);
  });
});

describe('POST /api/contact', () => {
  interface Mail {
    to: string;
    reply_to?: string;
    subject: string;
    text: string;
  }

  function mockResend(respond: () => Response = () => Response.json({ id: 'email_contact' })): Mail[] {
    const sent: Mail[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url.href}`);
      sent.push(JSON.parse(String(init?.body)) as Mail);
      return respond();
    });
    return sent;
  }

  it('mails the message to support with the visitor as Reply-To, signed in or not', async () => {
    const sent = mockResend();
    const response = await dashboard(null, 'POST', '/api/contact', { email: ' Visitor@Example.org ', message: '  Do you support RTL text?  ', website: '' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: env.SUPPORT_EMAIL, reply_to: 'visitor@example.org' });
    expect(sent[0]!.text).toContain('Do you support RTL text?');
  });

  it('pretends to succeed for the honeypot and sends nothing', async () => {
    const sent = mockResend();
    const response = await dashboard(null, 'POST', '/api/contact', { email: 'bot@example.org', message: 'Buy pills', website: 'https://spam.example' });
    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });

  it('validates the email and the message, and refuses cross-site posts', async () => {
    const sent = mockResend();
    const invalid = [
      { email: 'not-an-email', message: 'Hello' },
      { message: 'Hello' },
      { email: 'a@example.org', message: '   ' },
      { email: 'a@example.org' },
      { email: 'a@example.org', message: 'x'.repeat(4001) },
    ];
    for (const body of invalid) {
      const response = await dashboard(null, 'POST', '/api/contact', body);
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    const atLimit = await dashboard(null, 'POST', '/api/contact', { email: 'a@example.org', message: 'x'.repeat(4000) });
    expect(atLimit.status).toBe(200);
    expect(sent).toHaveLength(1);

    const crossSite = await call('/api/contact', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.org', message: 'Hello' }),
    });
    expect(crossSite.status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it('tells the page to fall back to the email address when sending fails or is not configured', async () => {
    mockResend(() => Response.json({ name: 'internal_server_error', message: 'boom' }, { status: 500 }));
    const body = { email: 'a@example.org', message: 'Hello' };
    const failed = await dashboard(null, 'POST', '/api/contact', body);
    expect(failed.status).toBe(500);
    const error = await errorOf(failed);
    expect(error.code).toBe('internal_error');
    expect(error.message).toContain(env.SUPPORT_EMAIL);

    const unconfigured = await dashboard(null, 'POST', '/api/contact', body, { ...env, RESEND_API_KEY: undefined });
    expect(unconfigured.status).toBe(503);
    expect((await errorOf(unconfigured)).code).toBe('not_configured');
  });

  it('is rate-limited per IP, separately from sign-in', async () => {
    const sent = mockResend();
    const keys: string[] = [];
    const deny: RateLimitBinding = {
      limit: ({ key }) => {
        keys.push(key);
        return Promise.resolve({ success: false });
      },
    };
    const response = await call(
      '/api/contact',
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' },
        body: JSON.stringify({ email: 'a@example.org', message: 'Hello' }),
      },
      { ...env, RATE_LIMITS_DISABLED: '0', RL_AUTH: deny },
    );
    expect(response.status).toBe(429);
    expect(keys).toEqual(['contact:203.0.113.50']);
    expect(sent).toEqual([]);
  });
});

describe('GET /api/renders', () => {
  it('lists the account\'s latest renders, newest first, with working URLs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2027, 7, 3, 9);
    vi.setSystemTime(start);
    const user = await createUser('free', start);
    const cookie = await sessionCookieFor(user.id, start);
    const key = await apiKeyFor(user.id, start);
    const site = await createSite(user.id, start);
    const stranger = await createUser('free', start);
    await postImage((await apiKeyFor(stranger.id, start)).secret, { html: TINY_HTML, css: TINY_CSS, data: { title: 'Not yours' } });

    const viaApi = await json<{ id: string; url: string; bytes: number }>(
      await postImage(key.secret, { html: TINY_HTML, css: TINY_CSS, data: { title: 'Via the API' }, format: 'webp' }),
    );
    vi.setSystemTime(start + 60_000);
    const viaUrl = await call(await signedPath(site, 'blog', { title: 'Via a signed URL' }));
    expect(viaUrl.status).toBe(200);
    const ogKey = (viaUrl.headers.get('etag') ?? '').replaceAll('"', '');

    const response = await dashboard(cookie, 'GET', '/api/renders');
    expect(response.status).toBe(200);
    const { renders } = await json<{ renders: Array<Record<string, unknown>> }>(response);
    expect(renders).toEqual([
      {
        id: ogKey,
        url: `${ORIGIN}/i/${user.id}/${ogKey}.png`,
        template: 'blog',
        source: 'og',
        width: 1200,
        height: 630,
        format: 'png',
        bytes: expect.any(Number),
        charged_to: 'plan',
        created_at: new Date(start + 60_000).toISOString(),
        expires_at: new Date(start + 60_000 + PLANS.free.cacheDays * DAY_MS).toISOString(),
      },
      {
        id: viaApi.id,
        url: viaApi.url,
        template: 'inline',
        source: 'api',
        width: 1200,
        height: 630,
        format: 'webp',
        bytes: viaApi.bytes,
        charged_to: 'plan',
        created_at: new Date(start).toISOString(),
        expires_at: new Date(start + PLANS.free.cacheDays * DAY_MS).toISOString(),
      },
    ]);
    expect((await call(String(renders[0]!.url).slice(ORIGIN.length))).status).toBe(200);
  });
});
