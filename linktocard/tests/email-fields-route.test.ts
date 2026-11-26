// Open fields through the real app (needs the og.ts and /api/sign integration and
// EMAIL_FIELDS_ENABLED = "true" in wrangler.toml [vars]): signing in the dashboard, verifying and
// rendering on GET /v1/og, the cache, the email cache headers, the daily cap and the kill switch.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS, EMAIL_FIELDS } from '../src/config';
import { first, run } from '../src/db/client';
import { openRenderBucket } from '../src/lib/open-fields';
import { canonicalString, signCanonical } from '../src/lib/signed-url';
import type { Env } from '../src/types';
import { apiKeyFor, bearer, bytesOf, call, createSite, createUser, dashboard, errorOf, isPng, pngDimensions, renderCount, sessionCookieFor, setUsed, siteSecret, signedPath } from './app-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const off: Env = { ...env, EMAIL_FIELDS_ENABLED: 'false' };
/** Limits on: the daily cap is a limit, and tests switch limits off by default. */
const limited: Env = { ...env, RATE_LIMITS_DISABLED: '' };

async function account(plan: 'free' | 'starter' | 'pro' = 'free') {
  const user = await createUser(plan);
  const cookie = await sessionCookieFor(user.id);
  const site = await createSite(user.id);
  return { user, cookie, site };
}

/** The URL builder's answer for the email banner with "name" open. */
async function signBanner(cookie: string, siteId: string, open: unknown = ['name'], data: Record<string, string> = {}): Promise<Response> {
  return dashboard(cookie, 'POST', '/api/sign', {
    site_id: siteId,
    template: 'email-banner',
    data: { title: 'Your spring picks are ready', greeting: 'Hi', name_default: 'there', ...data },
    open,
  });
}

async function openUrl(cookie: string, siteId: string): Promise<string> {
  const response = await signBanner(cookie, siteId);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string; canonical: string; open: string[] };
  expect(body.open).toEqual(['name']);
  expect(body.url).toMatch(/&sig=[0-9a-f]{64}&name=$/);
  return new URL(body.url).pathname + new URL(body.url).search;
}

const etagOf = (response: Response): string => response.headers.get('etag') ?? '';

async function used(siteId: string): Promise<number> {
  return (await first<{ count: number }>(env.DB, 'SELECT count FROM tool_usage WHERE bucket = ?1', openRenderBucket(siteId, Date.now())))?.count ?? 0;
}

describe('GET /v1/og with open fields', () => {
  it('renders each recipient once, serves repeats from the cache and sends email cache headers', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);

    const maya = await call(`${path}Maya`, {}, limited);
    expect(maya.status).toBe(200);
    const bytes = await bytesOf(maya);
    expect(isPng(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });
    expect(maya.headers.get('x-ltc-cache')).toBe('miss');
    // Never longer than the Free plan's paid cache period, and never longer than the email maximum.
    expect(maya.headers.get('cache-control')).toBe(`public, max-age=${Math.min(EMAIL_FIELDS.maxAgeSeconds, PLANS.free.cacheDays * 86_400)}`);
    expect(etagOf(maya)).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await renderCount(user.id)).toBe(1);
    expect(await used(site.id)).toBe(1);

    // The same value, however it is written: the same card, no render, no count.
    for (const same of ['Maya', '+Maya+', encodeURIComponent('Ｍａｙａ')]) {
      const again = await call(`${path}${same}`, {}, limited);
      expect(again.status).toBe(200);
      await again.arrayBuffer();
      expect(etagOf(again)).toBe(etagOf(maya));
    }
    expect(await renderCount(user.id)).toBe(1);
    expect(await used(site.id)).toBe(1);

    // A conditional request from a mail proxy that kept the image.
    const revalidated = await call(`${path}Maya`, { headers: { 'if-none-match': etagOf(maya) } }, limited);
    expect(revalidated.status).toBe(304);

    const eve = await call(`${path}Eve`, {}, limited);
    expect(eve.status).toBe(200);
    await eve.arrayBuffer();
    expect(etagOf(eve)).not.toBe(etagOf(maya));
    expect(await renderCount(user.id)).toBe(2);
    expect(await used(site.id)).toBe(2);
  });

  it('shows the default for unusable values: one card, rendered once', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const empty = await call(path, {}, limited);
    expect(empty.status).toBe(200);
    await empty.arrayBuffer();
    for (const raw of ['*|FNAME|*', '<script>', 'محمد', 'W'.repeat(EMAIL_FIELDS.maxValueChars + 1)]) {
      const response = await call(`${path}${encodeURIComponent(raw)}`, {}, limited);
      expect(response.status, raw).toBe(200);
      await response.arrayBuffer();
      expect(etagOf(response), raw).toBe(etagOf(empty));
    }
    const signedDefault = await call(`${path.replace(/&name=$/, '')}`, {}, limited);
    await signedDefault.arrayBuffer();
    expect(etagOf(signedDefault)).toBe(etagOf(empty));
    expect(await renderCount(user.id)).toBe(1);
  });

  it('ignores an open field the template does not have, so it cannot vary the cache key', async () => {
    const { user, site } = await account();
    const decoded = { title: 'Spring', open: 'name,colour' };
    const pathname = `/v1/og/${site.id}/email-banner.png`;
    const sig = await signCanonical(await siteSecret(site), canonicalString(pathname, Object.entries(decoded)));
    const base = `${pathname}?${new URLSearchParams(decoded)}&sig=${sig}&name=Maya&colour=`;
    const blue = await call(`${base}blue`, {}, limited);
    const red = await call(`${base}red`, {}, limited);
    expect(blue.status).toBe(200);
    expect(red.status).toBe(200);
    await Promise.all([blue.arrayBuffer(), red.arrayBuffer()]);
    expect(etagOf(red)).toBe(etagOf(blue));
    expect(await renderCount(user.id)).toBe(1);
  });

  it('serves the default card once the site used its unique renders for the day', async () => {
    const { user, cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const limit = EMAIL_FIELDS.maxUniqueRendersPerDay.free;
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', openRenderBucket(site.id, Date.now()), limit, Date.now() + DAY_MS);

    const capped = await call(`${path}Maya`, {}, limited);
    expect(capped.status).toBe(200);
    await capped.arrayBuffer();
    expect(capped.headers.get('x-ltc-open-fields')).toBe('daily-limit');
    expect(capped.headers.get('cache-control')).toBe('no-store, max-age=0');
    const fallback = await call(path, {}, limited);
    await fallback.arrayBuffer();
    expect(etagOf(capped)).toBe(etagOf(fallback));
    // Every further recipient is the same default card: nothing more is rendered or counted.
    const another = await call(`${path}Eve`, {}, limited);
    await another.arrayBuffer();
    expect(etagOf(another)).toBe(etagOf(fallback));
    expect(await renderCount(user.id)).toBe(1);
    expect(await used(site.id)).toBe(limit);
  });

  it('gives the day\'s render back when the render fails, and counts nothing for HEAD', async () => {
    const { cookie, site, user } = await account();
    const path = await openUrl(cookie, site.id);
    const head = await call(`${path}Maya`, { method: 'HEAD' }, limited);
    expect(head.status).toBe(200);
    expect(await used(site.id)).toBe(0);

    // No images left: 402, and the reservation is given back.
    await setUsed(user, PLANS.free.monthlyImages);
    const broke = await call(`${path}Zoe`, {}, limited);
    expect(broke.status).toBe(402);
    expect(await used(site.id)).toBe(0);
  });
});

describe('the kill switch and URLs without open fields', () => {
  it('while off, an open-fields URL does not verify: the unsigned value is just an unsigned parameter', async () => {
    const { cookie, site } = await account();
    const path = await openUrl(cookie, site.id);
    const response = await call(`${path}Maya`, {}, off);
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_signature', details: { reason: 'signature_mismatch' } });
    // The same URL with nothing appended is all signed, but names an email starter, which is part of
    // the email images tool: while it is off that id is unknown like any other (OPS-1; this case
    // answered 200 before the email starters were gated).
    const allSigned = await call(path.replace(/&name=$/, ''), {}, off);
    expect(allSigned.status).toBe(404);
    expect((await errorOf(allSigned)).code).toBe('not_found');
    // A social starter's URL with "open" signed as data verifies and renders "open" as ordinary data, as before.
    const blog = await signedPath(site, 'blog', { title: 'Hello', open: 'name', name_default: 'there' });
    const blogOff = await call(blog, {}, off);
    expect(blogOff.status).toBe(200);
    await blogOff.arrayBuffer();
  });

  it('while off, the email starters cannot be named anywhere, and the free playground never offers them (OPS-1)', async () => {
    const { user, cookie, site } = await account('starter');
    const key = await apiKeyFor(user.id);
    for (const template of ['email-banner', 'email-offer']) {
      const images = await call('/v1/images', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ template, size: 'email', data: { title: 'Hi' } }) }, off);
      expect(images.status, template).toBe(404);
      expect((await errorOf(images)).code).toBe('not_found');
      const signed = await call(await signedPath(site, template, { title: 'Hello', size: 'email' }), {}, off);
      expect(signed.status, template).toBe(404);
      const sign = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template, data: { title: 'x' } }, off);
      expect(sign.status, template).toBe(404);
      // The playground is the social gallery: never the email starters, whatever the switch says.
      for (const bindings of [env, off]) {
        const playground = await call(`/playground/card.png?template=${template}`, {}, bindings);
        expect(playground.status, template).toBe(400);
        await playground.arrayBuffer();
      }
      // On, the API and signed URLs take them.
      const on = await call('/v1/images', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ template, size: 'email', data: { title: 'Hi' }, response: 'binary' }) });
      expect(on.status, template).toBe(200);
      await on.arrayBuffer();
    }
    // The email size itself stays general (decision D7).
    const blog = await call('/v1/images', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ template: 'blog', size: 'email', data: { title: 'Hi' }, response: 'binary' }) }, off);
    expect(blog.status).toBe(200);
    await blog.arrayBuffer();
  });

  it('serves a URL without "open" identically with the switch on and off', async () => {
    const { site } = await account();
    const path = await signedPath(site, 'blog', { title: 'Hello', open_at: 'noon', name_default: 'x' });
    const on = await call(path);
    const offResponse = await call(path, {}, off);
    expect(on.status).toBe(200);
    expect(offResponse.status).toBe(200);
    expect(etagOf(on)).toBe(etagOf(offResponse));
    expect(on.headers.get('cache-control')).toBe(offResponse.headers.get('cache-control'));
    expect(on.headers.get('x-ltc-open-fields')).toBeNull();
    await Promise.all([on.arrayBuffer(), offResponse.arrayBuffer()]);
  });
});

describe('POST /api/sign with open fields', () => {
  it('refuses open fields while the switch is off, and the problems the signer can see', async () => {
    const { cookie, site } = await account();
    const disabled = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'email-banner', data: { title: 'x' }, open: ['name'] }, off);
    expect(disabled.status).toBe(503);
    expect((await errorOf(disabled)).code).toBe('not_configured');

    const cases: [unknown, Record<string, string>, string][] = [
      ['name', {}, '"open" must be a list'],
      [['name'], { name: 'Maya' }, 'is an open field'],
      [['colour'], {}, 'is not a field of template'],
      [['name', 'name'], {}, 'each listed once'],
    ];
    for (const [open, data, message] of cases) {
      const response = await signBanner(cookie, site.id, open, data);
      expect(response.status, message).toBe(400);
      expect((await errorOf(response)).message).toContain(message);
    }
    // "open" as a data key is reserved while open fields are on.
    const reserved = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'blog', data: { title: 'x', open: 'name' } });
    expect(reserved.status).toBe(400);
    expect((await errorOf(reserved)).message).toContain('"open" is a reserved name');
    // ... and while they are off, so that no URL signed today changes meaning when they are turned on (SEC-6).
    const reservedOff = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'blog', data: { title: 'x', open: 'Mon-Fri 8-18' } }, off);
    expect(reservedOff.status).toBe(400);
    expect((await errorOf(reservedOff)).message).toContain('"open" is a reserved name');
  });

  it('keeps a URL signed with "open" as ordinary data working once the switch is on (SEC-6)', async () => {
    const { site } = await account();
    // Signed by the customer's own code while the switch was off: "open" is a plain parameter.
    const path = await signedPath(site, 'blog', { title: 'Cafe Lumen', open: 'Mon-Fri 8-18' });
    const before = await call(path, {}, off);
    expect(before.status).toBe(200);
    const after = await call(path);
    expect(after.status).toBe(200);
    expect(after.headers.get('x-ltc-open-fields')).toBeNull();
    expect(etagOf(after)).toBe(etagOf(before));
    await Promise.all([before.arrayBuffer(), after.arrayBuffer()]);
  });

  it('returns the canonical string the URL was signed with, which leaves the open fields out', async () => {
    const { cookie, site } = await account();
    const response = await signBanner(cookie, site.id);
    const body = (await response.json()) as { url: string; canonical: string };
    expect(body.canonical).toBe(
      canonicalString(`/v1/og/${site.id}/email-banner.png`, Object.entries({ title: 'Your spring picks are ready', greeting: 'Hi', name_default: 'there', open: 'name' })),
    );
  });
});
