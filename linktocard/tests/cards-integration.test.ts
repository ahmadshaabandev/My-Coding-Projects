/// <reference path="./fixtures/og/raw.d.ts" />
// The link-card routes answer through the real app (src/index.ts), where the integration mounted them.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLinkUrl } from '../src/cards/link-url';
import { LINK_CARDS } from '../src/config';
import { storeResult, runInspection } from '../src/inspect/check';
import { apiKeyFor, bearer, call, createSite, createUser, siteSecret } from './app-helpers';
import { SETTINGS, bytes, html, mockNet, probePng, solidPng, host } from './cards-helpers';
import goodHtml from './fixtures/og/good.html?raw';

afterEach(() => vi.restoreAllMocks());

describe('integrated app', () => {
  it('config matches the test settings', () => {
    expect({ ...LINK_CARDS, maxChars: { ...LINK_CARDS.maxChars } }).toEqual(SETTINGS);
  });

  it('all three routes answer through src/index.ts, and 503 when switched off', async () => {
    const domain = host('integ');
    const page = goodHtml.replaceAll('https://cdn.ogfixtures.com', `https://${domain}`).replaceAll('https://shop.ogfixtures.com', `https://${domain}`);
    const routes = { [`https://${domain}/widgets`]: html(page), [`https://${domain}/card.png`]: probePng(), [`https://${domain}/static/icon-32.png`]: bytes(await solidPng()) };
    mockNet(routes);
    const on = { ...env, LINK_CARDS_ENABLED: 'true' };
    const off = { ...env, LINK_CARDS_ENABLED: 'false' };
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const site = await createSite(user.id);

    const post = (bindings: typeof env) => call('/v1/cards/from-url', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify({ url: `https://${domain}/widgets` }) }, bindings);
    const posted = await post(on);
    expect(posted.status, await posted.clone().text()).toBe(200);
    expect((await post(off)).status).toBe(503);

    const { url } = await buildLinkUrl({ baseUrl: 'http://localhost', siteId: site.id, template: 'blog', ext: 'png', url: `https://${domain}/widgets`, secret: await siteSecret(site) });
    const path = url.slice('http://localhost'.length);
    const link = await call(path, {}, on);
    expect(link.status).toBe(200);
    expect(link.headers.get('content-type')).toBe('image/png');
    expect((await call(path.replace(/&sig=.*/, ''), {}, on)).status).toBe(403);
    expect((await call(`${path}&x=1`, {}, off)).status).toBe(503);

    const fetchImpl: typeof fetch = async (input) => fetch(input);
    const outcome = await runInspection(new URL(`https://${domain}/widgets`), { fetchImpl, resolveHost: async () => ['93.184.216.34'], now: () => Date.now() });
    await storeResult(env.DB, outcome, Date.now());
    const preview = await call(`/playground/from-check/${outcome.result.id}/blog.png`, {}, on);
    expect(preview.status).toBe(200);
    expect((await call(`/playground/from-check/${outcome.result.id}/blog.png`, {}, off)).status).toBe(503);
    // The homepage playground is unchanged.
    expect((await call('/playground/card.png?title=Still%20here', {}, env)).status).toBe(200);
  });
});
