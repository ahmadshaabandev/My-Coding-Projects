// What the privacy policy says is kept for the daily limit of personalized email images matches what
// src/lib/open-fields.ts stores (audit CHG-1, review CHG-1-R1). The daily cap counts images, not
// requests, so it keeps one tool_usage row per new image a site renders on a UTC day,
// "emailr:{site id}:{day}:{cache key}" (the cache key is a one-way hash, no text of the card), until
// the end of the next UTC day, and the daily clean-up of expired tool_usage rows deletes it. That is
// a list of image hashes per site and day, not a count, so the page must not call it a count.
//
// The sentence is in the email block of site/content/privacy.md, so it is published only where the
// email feature is on (staging), never on the production build.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../../src/config';
import { renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-27T12:00:00Z');
const ALL = 'pdf,batch,toolkit,linkcards,email,previews,integrations,localpdf,apidocs';
const PRODUCTION = 'previews,localpdf,apidocs';

const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', nbsp: ' ' };
const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function privacyOf(site: RenderedSite): string {
  const page = site.pages.find((candidate) => candidate.outPath === 'privacy.html');
  if (!page) throw new Error('no privacy.html');
  return text(page.html);
}

/** The part of src/lib/open-fields.ts this test calls. */
interface OpenFieldsModule {
  openRenderBucket(siteId: string, now: number, cacheKey: string): string;
  openRenderRange(siteId: string, now: number): { from: string; to: string };
}

let openFields: OpenFieldsModule;
beforeAll(async () => {
  // open-fields.ts imports Worker-only types, which tsconfig.node.json cannot check; at run time it
  // is plain TypeScript, so it is loaded by path (as tests/node/email-content-draft.test.ts does).
  openFields = (await import(/* @vite-ignore */ join(ROOT, 'src/lib/open-fields.ts'))) as OpenFieldsModule;
});

const KEPT = 'Which new personalized images each site rendered on each UTC day (the site id and a one-way hash of each image, no text from the image): until the end of the next day (UTC); the daily clean-up then deletes them.';

describe('the privacy policy on the daily limit of personalized email images (CHG-1-R1)', () => {
  it('describes what the code keeps: one row per image, holding the image cache key (a hash), per site and UTC day', () => {
    const now = NOW.getTime();
    const day = Math.floor(now / DAY_MS);
    const key = 'a'.repeat(64);
    // One row per image of the day, and the image's cache key is part of it: not one count per site and day.
    expect(openFields.openRenderBucket('s_site', now, key)).toBe(`emailr:s_site:${day}:${key}`);
    const { from, to } = openFields.openRenderRange('s_site', now);
    expect(from < openFields.openRenderBucket('s_site', now, key) && openFields.openRenderBucket('s_site', now, key) < to).toBe(true);

    const privacy = privacyOf(renderSite({ env: { SITE_FEATURES: ALL, SITE_PDF: 'on' }, now: NOW }));
    expect(privacy).toContain(KEPT);
    expect(privacy).not.toContain('The count of new personalized images per site and day');
    // The charge record that follows is unchanged.
    expect(privacy).toContain('For each email image we count, we keep a record that it was counted: your account id and a one-way hash of the image\'s content, no text from the image.');
  });

  it('is not published on the production build, where the email feature is off', () => {
    const privacy = privacyOf(renderSite({ env: { SITE_FEATURES: PRODUCTION, SITE_PDF: 'off' }, now: NOW }));
    expect(privacy).not.toContain(KEPT);
    expect(privacy).not.toContain('personalized images');
  });
});
