// The social starter templates (blog, dark, quote, launch, docs) are not laid out for the 1200x400
// email preset, and the server refuses it for them on every path that renders or signs a card
// (owner decision of 2026-11-27): POST /v1/images, signed GET /v1/og/..., GET /v1/link/...,
// POST /v1/cards/from-url, /api/sign, /api/preview, buildLinkUrl and getCard itself. The
// playground routes render the og preset only. The account's own templates and inline HTML take
// every preset; the email starters are laid out for all four. Real app, D1, R2 and renderer.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLinkUrl } from '../src/cards/link-url';
import { SIZES, type SizeId } from '../src/config';
import { runInspection, storeResult } from '../src/inspect/check';
import { ApiError } from '../src/lib/errors';
import { assertTemplateSize, getCard, resolveTemplate } from '../src/lib/images';
import { canonicalString, signCanonical } from '../src/lib/signed-url';
import { EMAIL_TEMPLATES, STARTER_TEMPLATES, STARTER_TEMPLATE_IDS } from '../src/render/templates';
import type { Env } from '../src/types';
import {
  apiKeyFor,
  bearer,
  bytesOf,
  call,
  createSite,
  createTemplate,
  createUser,
  dashboard,
  errorOf,
  isPng,
  pngDimensions,
  postImage,
  renderCount,
  requestUrl,
  sessionCookieFor,
  siteSecret,
  signedPath,
  usageOf,
} from './app-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const off: Env = { ...env, EMAIL_FIELDS_ENABLED: 'false' };
const SOCIAL: readonly SizeId[] = ['og', 'square', 'portrait'];
const EMAIL_STARTERS = EMAIL_TEMPLATES.map((template) => template.id);

async function account() {
  const user = await createUser('starter');
  const cookie = await sessionCookieFor(user.id);
  const site = await createSite(user.id);
  const key = await apiKeyFor(user.id);
  return { user, cookie, site, key };
}

/** The refusal every path answers for a social starter at the email size. */
async function expectSizeRefused(response: Response, template: string, label: string): Promise<string> {
  expect(response.status, label).toBe(400);
  const error = await errorOf(response);
  expect(error, label).toMatchObject({
    code: 'invalid_request',
    details: { reason: 'size_not_supported', template, size: 'email', supported_sizes: [...SOCIAL] },
  });
  expect(error.message, label).toContain('og (1200x630), square (1080x1080), portrait (1080x1350)');
  return error.message;
}

/** No network at all: a refused request must not read a page or an image. */
function noNetwork() {
  return vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no request may leave the Worker in this test'));
}

describe('the sizes each starter template is laid out for', () => {
  it('the social starters take og, square and portrait; the email starters every preset', () => {
    for (const template of STARTER_TEMPLATES) expect(template.sizes, template.id).toEqual(SOCIAL);
    for (const template of EMAIL_TEMPLATES) expect(template.sizes, template.id).toEqual(Object.keys(SIZES));
    // Listed in SIZES order and only presets that exist.
    for (const template of [...STARTER_TEMPLATES, ...EMAIL_TEMPLATES]) {
      expect(template.sizes, template.id).toEqual(Object.keys(SIZES).filter((id) => template.sizes.includes(id as SizeId)));
    }
  });

  it('the refusal names the supported sizes and the starters made for the size, switched on or not', () => {
    const blog = { label: 'blog', sizes: STARTER_TEMPLATES[0]!.sizes };
    const refusal = (options: { emailTemplates?: boolean }): ApiError => {
      try {
        assertTemplateSize(blog, SIZES.email, options);
      } catch (error) {
        if (error instanceof ApiError) return error;
      }
      throw new Error('not refused');
    };
    expect(refusal({ emailTemplates: true }).message).toBe(
      'The starter template "blog" is not laid out for the email (1200x400) size. It supports og (1200x630), square (1080x1080), portrait (1080x1350). ' +
        'For the email size, use one of the starter templates email-banner, email-offer, or one of your own templates (they take every size).',
    );
    expect(refusal({}).message).toContain('The starter templates made for the email size (email-banner, email-offer) are not switched on yet; your own templates take every size.');
    expect(refusal({}).status).toBe(400);
    // Supported sizes, custom templates (no list) and inline HTML pass.
    for (const id of SOCIAL) expect(() => assertTemplateSize(blog, SIZES[id])).not.toThrow();
    expect(() => assertTemplateSize({ label: 't_custom', sizes: undefined }, SIZES.email)).not.toThrow();
  });
});

describe('every path refuses a social starter at the email size', () => {
  it('POST /v1/images: each social starter, by size and by width and height, while email images are on and off', async () => {
    const { user, key } = await account();
    for (const template of STARTER_TEMPLATE_IDS) {
      await expectSizeRefused(await postImage(key.secret, { template, size: 'email', data: { title: 'Hi' } }), template, `${template} size`);
      await expectSizeRefused(await postImage(key.secret, { template, width: 1200, height: 400, data: { title: 'Hi' } }), template, `${template} width/height`);
    }
    const offMessage = await expectSizeRefused(
      await call('/v1/images', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ template: 'quote', size: 'email', data: { title: 'Hi' } }) }, off),
      'quote',
      'off',
    );
    expect(offMessage).toContain('are not switched on yet');
    // Refused before anything is rendered or counted.
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('POST /v1/images: the sizes a starter is laid out for, the email starters and the account\'s own templates still render', async () => {
    const { cookie, key } = await account();
    const custom = await createTemplate(cookie);
    const cases: [Record<string, unknown>, { width: number; height: number }][] = [
      [{ template: 'blog', size: 'square' }, SIZES.square],
      [{ template: 'email-banner', size: 'email' }, SIZES.email],
      [{ template: 'email-offer', size: 'email' }, SIZES.email],
      [{ template: custom, size: 'email' }, SIZES.email],
      [{ html: '<div class="t">{{title}}</div>', width: 1200, height: 400 }, SIZES.email],
    ];
    for (const [body, size] of cases) {
      const response = await postImage(key.secret, { ...body, data: { title: 'Sized' }, response: 'binary' });
      expect(response.status, JSON.stringify(body)).toBe(200);
      const png = await bytesOf(response);
      expect(isPng(png)).toBe(true);
      expect(pngDimensions(png)).toEqual({ width: size.width, height: size.height });
    }
  });

  it('signed GET /v1/og: refused for GET and HEAD, with or without open fields, before anything is charged', async () => {
    const { user, cookie, site } = await account();
    for (const template of STARTER_TEMPLATE_IDS) {
      const path = await signedPath(site, template, { title: 'Hello', size: 'email' });
      await expectSizeRefused(await call(path), template, template);
      const head = await call(path, { method: 'HEAD' });
      expect(head.status, `${template} HEAD`).toBe(400);
    }
    // An open-fields URL for a social starter, signed by the customer's own code.
    const decoded = { title: 'Hello', size: 'email', open: 'author', author_default: 'you' };
    const pathname = `/v1/og/${site.id}/blog.png`;
    const sig = await signCanonical(await siteSecret(site), canonicalString(pathname, Object.entries(decoded)));
    await expectSizeRefused(await call(`${pathname}?${new URLSearchParams(decoded)}&sig=${sig}&author=Maya`), 'blog', 'open fields');
    expect(await renderCount(user.id)).toBe(0);
    expect((await usageOf(user.id)).used).toBe(0);

    // The email starters and the account's own templates at the email size, and the blog at its own sizes.
    const custom = await createTemplate(cookie);
    for (const [template, size] of [['email-banner', 'email'], [custom, 'email'], ['blog', 'portrait']] as const) {
      const response = await call(await signedPath(site, template, { title: 'Hello', size }));
      expect(response.status, template).toBe(200);
      expect(pngDimensions(await bytesOf(response))).toEqual({ width: SIZES[size].width, height: SIZES[size].height });
    }
  });

  it('GET /v1/link: refused before the page is read, and buildLinkUrl does not sign it', async () => {
    const { user, site } = await account();
    const fetches = noNetwork();
    const entries: [string, string][] = [['url', 'https://www.example.com/post'], ['size', 'email']];
    const pathname = `/v1/link/${site.id}/dark.png`;
    const sig = await signCanonical(await siteSecret(site), canonicalString(pathname, entries));
    await expectSizeRefused(await call(`${pathname}?${new URLSearchParams(entries)}&sig=${sig}`), 'dark', 'link');
    expect((await call(`${pathname}?${new URLSearchParams(entries)}&sig=${sig}`, { method: 'HEAD' })).status).toBe(400);
    expect(fetches).not.toHaveBeenCalled();
    expect(await renderCount(user.id)).toBe(0);

    const sign = (template: string, size: string) =>
      buildLinkUrl({ baseUrl: 'http://localhost', siteId: site.id, template, ext: 'png', url: 'https://www.example.com/post', size, secret: 'test-secret' });
    await expect(sign('dark', 'email')).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'size_not_supported' } });
    await expect(sign('dark', 'square')).resolves.toMatchObject({ url: expect.stringContaining('size=square') });
    await expect(sign('email-banner', 'email')).resolves.toMatchObject({ url: expect.stringContaining('size=email') });
    // A custom template's id is not known to the signer: it is not restricted.
    await expect(sign('t_custom', 'email')).resolves.toMatchObject({ url: expect.stringContaining('size=email') });
  });

  it('POST /v1/cards/from-url: refused before the page is read (the default template is a social starter)', async () => {
    const { user, key } = await account();
    const fetches = noNetwork();
    const post = (body: Record<string, unknown>) =>
      call('/v1/cards/from-url', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.example.com/post', ...body }) });
    await expectSizeRefused(await post({ size: 'email' }), 'blog', 'default template');
    await expectSizeRefused(await post({ template: 'launch', width: 1200, height: 400 }), 'launch', 'width/height');
    expect(fetches).not.toHaveBeenCalled();
    expect(await renderCount(user.id)).toBe(0);
  });

  it('/api/sign signs no URL for it, with or without open fields; /api/preview does not render it', async () => {
    const { cookie, site } = await account();
    for (const template of STARTER_TEMPLATE_IDS) {
      await expectSizeRefused(await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template, size: 'email', data: { title: 'x' } }), template, `${template} sign`);
      await expectSizeRefused(await dashboard(cookie, 'POST', '/api/preview', { template, size: 'email', data: { title: 'x' } }), template, `${template} preview`);
    }
    await expectSizeRefused(
      await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'blog', size: 'email', data: { title: 'x' }, open: ['author'] }),
      'blog',
      'sign with open fields',
    );
    // Off, the open-fields switch answers first (503), as before; without "open" the size is refused.
    expect((await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'blog', size: 'email', data: { title: 'x' }, open: ['author'] }, off)).status).toBe(503);
    await expectSizeRefused(await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template: 'blog', size: 'email', data: { title: 'x' } }, off), 'blog', 'sign off');

    // What stays possible: an email starter or the account's own template at the email size, the blog at og.
    const custom = await createTemplate(cookie);
    for (const [template, size] of [['email-banner', 'email'], [custom, 'email'], ['blog', 'og']] as const) {
      const signed = await dashboard(cookie, 'POST', '/api/sign', { site_id: site.id, template, size, data: { title: 'x' } });
      expect(signed.status, template).toBe(200);
      await signed.arrayBuffer();
    }
    const preview = await dashboard(cookie, 'POST', '/api/preview', { template: custom, size: 'email', data: { title: 'x' } });
    expect(preview.status).toBe(200);
    expect(pngDimensions(await bytesOf(preview))).toEqual({ width: 1200, height: 400 });
  });

  it('the playground routes render the og preset only, whatever the query says', async () => {
    const response = await call('/playground/card.png?template=blog&title=Hi&size=email&width=1200&height=400');
    expect(response.status).toBe(200);
    expect(pngDimensions(await bytesOf(response))).toEqual({ width: 1200, height: 630 });

    // The OG checker's "Make this card" preview from a stored check.
    const page = '<!doctype html><html><head><title>Sized page</title><meta property="og:title" content="Sized page"></head><body></body></html>';
    const fetchImpl: typeof fetch = async (input) =>
      requestUrl(input).pathname === '/post' ? new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
    const outcome = await runInspection(new URL('https://sizes.cardfixtures.com/post'), { fetchImpl, resolveHost: async () => ['93.184.216.34'], now: () => Date.now() });
    await storeResult(env.DB, outcome, Date.now());
    noNetwork();
    const preview = await call(`/playground/from-check/${outcome.result.id}/dark.png?size=email`);
    expect(preview.status).toBe(200);
    expect(pngDimensions(await bytesOf(preview))).toEqual({ width: 1200, height: 630 });
  });

  it('getCard itself refuses it, so no future caller can render or charge it', async () => {
    const { user } = await account();
    const template = await resolveTemplate(env.DB, user.id, 'docs');
    expect(template?.sizes).toEqual(SOCIAL);
    const request = { user, template: template!, data: { title: 'x' }, size: SIZES.email, format: 'png' as const, source: 'api' as const, siteId: null };
    await expect(getCard(env, () => undefined, request, { now: Date.now(), withBody: false })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'size_not_supported' } });
    expect(await renderCount(user.id)).toBe(0);
    // The email starters' ids are known to it only while email images are on, as before.
    expect((await resolveTemplate(env.DB, user.id, EMAIL_STARTERS[0], { emailTemplates: true }))?.sizes).toEqual(Object.keys(SIZES));
  });
});
