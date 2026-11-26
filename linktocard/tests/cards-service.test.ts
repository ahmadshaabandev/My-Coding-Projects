// Units of "link in, card out" that the route tests reach only indirectly: link pointers in
// R2, the per-site page-check limit, and the playground preview data (src/cards/service.ts,
// src/cards/playground-from-check.ts).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PAGE_IMAGE_KEYS } from '../src/cards/from-url';
import { PREVIEW_THEMES, checkForPreview, parsePreviewFile, previewDataFromCheck } from '../src/cards/playground-from-check';
import { enforceSiteInspectLimit, linkPointerKey, pointerIsFresh, readLinkPointer, writeLinkPointer } from '../src/cards/service';
import { DAY_MS, INSPECT } from '../src/config';
import { run } from '../src/db/client';
import { storeResult } from '../src/inspect/check';
import { STARTER_TEMPLATES, getStarterTemplate } from '../src/render/templates';
import { createSite, createUser } from './app-helpers';
import { SETTINGS, bareCheck } from './cards-helpers';

const KEY = 'a'.repeat(64);

describe('link pointers', () => {
  it('one key per account, template identity, watermark and canonical link', async () => {
    const free = { id: 'u_1', plan: 'free' as const };
    const base = await linkPointerKey(free, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/');
    expect(base).toMatch(/^r\/u_1\/link\/[0-9a-f]{64}$/);
    expect(await linkPointerKey(free, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/')).toBe(base);
    const others = await Promise.all([
      linkPointerKey({ id: 'u_1', plan: 'pro' }, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/'),
      linkPointerKey(free, { identity: 'custom:t_1@2' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/'),
      linkPointerKey(free, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://b.example/'),
      linkPointerKey({ id: 'u_2', plan: 'free' as const }, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/'),
    ]);
    expect(new Set([base, ...others]).size).toBe(5);
    // Starter and Pro both render without a watermark, so they share a pointer.
    expect(await linkPointerKey({ id: 'u_1', plan: 'starter' }, { identity: 'starter:blog' }, '/v1/link/s_1/blog.png\nurl\nurl=https://a.example/')).toBe(others[0]);
  });

  it('round trips through R2 and reads as absent once its card has expired', async () => {
    const key = 'r/u_rt/link/1';
    await writeLinkPointer(env.BUCKET, key, { cacheKey: KEY, checkedAt: 1000, expiresAt: 5000 });
    expect(await readLinkPointer(env.BUCKET, key, 4999)).toEqual({ cacheKey: KEY, checkedAt: 1000, expiresAt: 5000 });
    expect(await readLinkPointer(env.BUCKET, key, 5000)).toBeNull();
    expect(await readLinkPointer(env.BUCKET, 'r/u_rt/link/missing', 0)).toBeNull();
    expect((await env.BUCKET.get(key))?.size).toBe(0);
  });

  it('ignores a pointer whose metadata is not its own', async () => {
    for (const [name, meta] of [
      ['bad key', { cacheKey: 'nope', checkedAt: '1', expiresAt: '9' }],
      ['bad time', { cacheKey: KEY, checkedAt: 'x', expiresAt: '9' }],
      ['no expiry', { cacheKey: KEY, checkedAt: '1' }],
    ] as const) {
      await env.BUCKET.put(`r/u_bad/link/${name}`, new Uint8Array(0), { customMetadata: meta });
      expect(await readLinkPointer(env.BUCKET, `r/u_bad/link/${name}`, 0), name).toBeNull();
    }
  });

  it('is fresh until refreshAfterMs after its last check', () => {
    const pointer = { cacheKey: KEY, checkedAt: 0, expiresAt: 10 * DAY_MS };
    expect(pointerIsFresh(pointer, SETTINGS, SETTINGS.refreshAfterMs - 1)).toBe(true);
    expect(pointerIsFresh(pointer, SETTINGS, SETTINGS.refreshAfterMs)).toBe(false);
  });
});

describe('enforceSiteInspectLimit', () => {
  it('counts per site and names the site in the 429', async () => {
    const user = await createUser('free');
    const site = await createSite(user.id);
    const now = Date.now();
    const day = Math.floor(now / DAY_MS);
    const limited = { ...env, RATE_LIMITS_DISABLED: '0' };
    const limit = INSPECT.dailyInspectionsByPlan.free;
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', `inspect:site:${site.id}:${day}`, limit - 1, (day + 1) * DAY_MS);
    await expect(enforceSiteInspectLimit(limited, user, site.id, now)).resolves.toBeUndefined();
    await expect(enforceSiteInspectLimit(limited, user, site.id, now)).rejects.toMatchObject({
      code: 'rate_limited',
      message: expect.stringContaining("This site's link cards have read 100 pages today"),
      details: { limit },
    });
    // Another site of the same account has its own allowance.
    const other = await createSite(user.id);
    await expect(enforceSiteInspectLimit(limited, user, other.id, now)).resolves.toBeUndefined();
  });
});

describe('playground preview data', () => {
  const check = bareCheck('https://www.example.com/post');
  check.og.title = 'A post';
  check.og.description = 'About things';
  check.og.site_name = 'Example';
  check.page.favicon = 'https://www.example.com/icon.png';
  check.page.theme_color = '#000000';
  check.image = { url: 'https://www.example.com/og.png', status: 200, content_type: 'image/png', bytes: 10, width: 1200, height: 630, aspect_ratio: 1.905, response_ms: 1 };

  it('has the text of the page and no image URL, for every starter', () => {
    for (const template of STARTER_TEMPLATES) {
      const data = previewDataFromCheck(check, template, SETTINGS.maxChars);
      expect(data.title, template.id).toBe('A post');
      for (const key of PAGE_IMAGE_KEYS) expect(data[key], `${template.id} ${key}`).toBeUndefined();
      expect(Object.values(data).some((value) => /^https?:/.test(value)), template.id).toBe(false);
    }
  });

  it('a template that asks for every image still gets none', () => {
    const greedy = { html: '<img src="{{image}}"><img src="{{logo}}"><img src="{{page_image}}"><p>{{title}}</p>', css: '' };
    expect(previewDataFromCheck(check, greedy, SETTINGS.maxChars)).toEqual({ title: 'A post', theme: 'dark' });
  });

  it('the visitor theme wins over the page colour; other values are ignored', () => {
    const blog = getStarterTemplate('blog')!;
    expect(PREVIEW_THEMES).toEqual(['light', 'dark']);
    expect(previewDataFromCheck(check, blog, SETTINGS.maxChars).theme).toBe('dark');
    expect(previewDataFromCheck(check, blog, SETTINGS.maxChars, 'light').theme).toBe('light');
    expect(previewDataFromCheck(check, blog, SETTINGS.maxChars, 'neon').theme).toBe('dark');
  });

  it('reads only unexpired, well-formed checks', async () => {
    const stored = bareCheck('https://preview.example/');
    stored.id = 'chk_preview000000001';
    const now = Date.now();
    await storeResult(env.DB, { result: { ...stored, expires_at: new Date(now + 60_000).toISOString() }, imageUrl: null, faviconUrl: null }, now);
    expect((await checkForPreview(env.DB, stored.id, now))?.url).toBe('https://preview.example/');
    expect(await checkForPreview(env.DB, stored.id, now + 60_000)).toBeNull();
    expect(await checkForPreview(env.DB, 'chk_unknown0000000', now)).toBeNull();
    await run(env.DB, "UPDATE og_checks SET result = '{not json' WHERE id = ?1", stored.id);
    expect(await checkForPreview(env.DB, stored.id, now)).toBeNull();
  });

  it('parses only "{template}.png"', () => {
    expect(parsePreviewFile('blog.png')).toBe('blog');
    for (const file of ['blog.jpg', 'Blog.png', 'blog', '.png', '../blog.png', 'blog.png.png']) expect(parsePreviewFile(file), file).toBeNull();
  });
});
