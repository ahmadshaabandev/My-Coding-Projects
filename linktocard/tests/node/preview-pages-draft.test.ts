// The one-app preview pages of build v3 (contract T6, site feature "previews"): /tools/x-card-validator,
// /tools/linkedin-post-preview, /tools/slack-link-preview, /tools/discord-embed-preview,
// /tools/whatsapp-link-preview, the tool hub /tools, and their script site/public/assets/js/og-platform.js.
//
// They are drafts (site/pages/**.html.draft) until scripts/build-site.ts knows the "previews" feature and
// the tokens of scripts/v3-site-tokens.ts and scripts/previews-site-tokens.ts, so this test reads the
// files itself (the published .html once renamed, the .html.draft before) and checks:
//   - front matter, the page skeleton the script needs, no inline script, style or handler;
//   - every app fact sits in an element marked data-fact, right after a <!-- source: URL --> comment
//     naming a page read in the vendor's own documents, and every other element that names an app is
//     marked data-own; the LinkedIn, Slack and WhatsApp pages state no app fact and no app number;
//   - no number of src/config.ts is typed: the pages print them through [[tokens]];
//   - the Discord numbers of the page and of the script are the same;
//   - the script's pure functions (Discord's layout, byte limits, colour rule, X's https rule, the
//     mockup data), its static safety (textContent only, our own API and stylesheet only), and the
//     script run on the real page skeleton in a small fake DOM: a shared ?url= check, a typed check,
//     a rate limit and the Turnstile retry;
//   - the drafts build with the real scripts/build-site.ts into a temporary site (the "previews" and
//     "toolkit" blocks and tokens build-site.ts does not know yet are applied here first), with unique
//     titles and descriptions, working links and a hub that lists every free tool.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildNode, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INSPECT } from '../../src/config';
import { FEATURES, listTokens, renderSite, type RenderedSite } from '../../scripts/build-site';
import { previewsSiteTokens } from '../../scripts/previews-site-tokens';
import { v3SiteTokens } from '../../scripts/v3-site-tokens';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JS = join(ROOT, 'site/public/assets/js');
const NOW = new Date('2026-11-26T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'ltc-previews-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* The drafts                                                          */
/* ------------------------------------------------------------------ */

type PlatformId = 'x' | 'linkedin' | 'slack' | 'discord' | 'whatsapp';

interface Draft {
  /** Path under site/pages without extension, e.g. "tools/x-card-validator". */
  page: string;
  platform: PlatformId | null;
}

const PLATFORM_PAGES: Readonly<Record<PlatformId, string>> = {
  x: 'tools/x-card-validator',
  linkedin: 'tools/linkedin-post-preview',
  slack: 'tools/slack-link-preview',
  discord: 'tools/discord-embed-preview',
  whatsapp: 'tools/whatsapp-link-preview',
};
const HUB = 'tools';
const DRAFTS: readonly Draft[] = [
  ...(Object.entries(PLATFORM_PAGES) as Array<[PlatformId, string]>).map(([platform, page]) => ({ page, platform })),
  { page: HUB, platform: null },
];

/** The published page (.html) once renamed, the draft (.html.draft) before. */
function draftFile(page: string): string {
  const published = `site/pages/${page}.html`;
  return existsSync(join(ROOT, published)) ? published : `${published}.draft`;
}
const source = (page: string): string => read(draftFile(page));

function frontMatter(text: string, file: string): { data: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${file}: no front matter`);
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    data[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { data, body: text.slice(match[0].length) };
}

/**
 * Pages read in the vendors' own documents on 2026-11-26, and which page may cite which. A fact may be
 * stated only with one of these as its source; nothing for LinkedIn, Slack or WhatsApp could be read.
 */
const VERIFIED_SOURCES: Readonly<Record<string, string>> = {
  'https://docs.discord.com/developers/link-previews/overview': 'Discord, Link Previews (discord/discord-api-docs@62ab2d50, developers/link-previews/overview.mdx)',
  'https://docs.x.com/developer-terms/policy': 'X Developer Policy, "X Cards" (xdevplatform/docs@ad1e5df9, developer-terms/policy.mdx)',
  'https://github.com/xdevplatform/docs': 'the source of docs.x.com at ad1e5df9: no page about card markup or a card validator',
};
const PAGE_SOURCES: Readonly<Record<PlatformId, readonly string[]>> = {
  discord: ['https://docs.discord.com/developers/link-previews/overview'],
  x: ['https://docs.x.com/developer-terms/policy', 'https://github.com/xdevplatform/docs'],
  linkedin: [],
  slack: [],
  whatsapp: [],
};
/** App names that make a sentence an app claim (case-sensitive: twitter:card is a tag, Twitter is a company). */
const VENDOR = /\b(?:X|Twitter|LinkedIn|Slack|Discord|WhatsApp|Facebook|Meta|Apple|iMessage|Telegram)\b/;

/* ------------------------------------------------------------------ */
/* HTML helpers                                                        */
/* ------------------------------------------------------------------ */

const isElement = (node: ChildNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

function elements(nodes: readonly ChildNode[]): Element[] {
  return nodes.flatMap((node) => (isElement(node) ? [node, ...elements(node.children)] : []));
}

/** The text of a node, leaving out the elements `skip` names (code samples, for instance). */
function textOf(node: ChildNode, skip: (element: Element) => boolean = () => false): string {
  if (node.type === 'text') return node.data;
  return isElement(node) && !skip(node) ? node.children.map((child) => textOf(child, skip)).join('') : '';
}

/** The element itself or an ancestor carries the attribute. */
function marked(node: Element, attribute: string): boolean {
  for (let at: Element | null = node; at; at = at.parent && isElement(at.parent as ChildNode) ? (at.parent as Element) : null) {
    if (at.attribs[attribute] !== undefined) return true;
  }
  return false;
}

/** The comment right before an element (whitespace between them allowed), or null. */
function commentBefore(node: Element): string | null {
  let at = node.prev;
  while (at && at.type === 'text' && at.data.trim() === '') at = at.prev;
  return at && at.type === 'comment' ? at.data : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', times: '×', hellip: '…', middot: '·', nbsp: ' ' };
const decode = (text: string): string => text.replace(/&([a-z]+);/g, (match, name: string) => ENTITIES[name] ?? match);

/* ------------------------------------------------------------------ */
/* The script                                                          */
/* ------------------------------------------------------------------ */

interface Item {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  title: string;
  detail: string;
  fix: string | null;
}
interface Platform {
  STYLESHEET: string;
  CHECKER_PATH: string;
  FIX_TEXT: string;
  PLATFORMS: Record<PlatformId, { id: PlatformId; name: string; path: string }>;
  PLATFORM_IDS: PlatformId[];
  SOURCES: Record<string, string>;
  DISCORD: {
    titleMaxBytes: number;
    titleMaxLines: number;
    descriptionMaxBytes: number;
    descriptionMaxLines: number;
    siteNameMaxChars: number;
    imageAltMaxChars: number;
    urlMaxChars: number;
    fetchBudgetMs: number;
    maxRedirects: number;
    cacheMinutes: number;
    galleryMaxImages: number;
    imageTypes: string[];
    accentColour: RegExp;
    embedDebugger: string;
  };
  utf8Bytes(text: unknown): number;
  truncateBytes(text: unknown, max: number): string;
  shareUrlFor(platform: string, url: string): string;
  checkerHref(url: unknown): string;
  sortPlatformChecks(checks: unknown): Item[];
  discordText(result: unknown): { title: string; description: string; source: 'tags' | 'page' | null; siteName: string; tagsDiffer: boolean; pageTitleUnused: boolean };
  discordLayout(result: unknown): { layout: 'small' | 'large' | 'photo' | 'rich'; askedForVideo: boolean };
  discordAccent(value: unknown): string | null;
  discordChecks(result: unknown): Item[];
  xChecks(result: unknown): Item[];
  xLayout(result: unknown): 'large' | 'small';
  xCardNote(result: unknown): string;
  xText(result: unknown): { title: string; description: string };
  platformChecks(platform: string, result: unknown): Item[];
  platformVerdict(platform: string, result: unknown): { tone: string; title: string; text: string };
  mockupModel(platform: string, result: unknown): Record<string, unknown> & { layout: string; title: string; description: string; image: string | null; notes: string[] };
}

let platform: Platform;
let checkerSource: string;
let platformSource: string;
beforeAll(async () => {
  platform = (await import(pathToFileURL(join(JS, 'og-platform.js')).href)) as Platform;
  checkerSource = readFileSync(join(JS, 'og-checker.js'), 'utf8');
  platformSource = readFileSync(join(JS, 'og-platform.js'), 'utf8');
});

const IMAGE = '/api/tools/og-check/chk_test1/image';
const FAVICON = '/api/tools/og-check/chk_test1/favicon';

/** A CheckResult as GET /api/tools/og-check answers it (src/inspect/types.ts), with overrides. */
function result(overrides: {
  page?: Record<string, unknown>;
  og?: Record<string, unknown>;
  twitter?: Record<string, unknown>;
  image?: Record<string, unknown> | null;
  preview?: Record<string, unknown>;
  [key: string]: unknown;
} = {}): Record<string, unknown> {
  const { page, og, twitter, image, preview, ...rest } = overrides;
  return {
    id: 'chk_test1',
    url: 'https://example.com/blog/post',
    final_url: 'https://example.com/blog/post',
    status: 200,
    fetched_at: '2026-11-26T12:00:00.000Z',
    response_ms: 420,
    cached: false,
    expires_at: '2026-11-26T12:10:00.000Z',
    page: { title: 'Page title', description: 'Page description', canonical: null, favicon: 'https://example.com/favicon.ico', theme_color: '#2f6feb', ...page },
    og: {
      title: 'How we cut our build time in half',
      description: 'Three changes that took our CI from 14 minutes to 6.',
      image: 'https://example.com/card.png',
      image_alt: null,
      image_width: '1200',
      image_height: '630',
      url: 'https://example.com/blog/post',
      type: 'article',
      site_name: 'Example Blog',
      ...og,
    },
    twitter: { card: 'summary_large_image', title: null, description: null, image: null, site: null, ...twitter },
    image:
      image === null
        ? null
        : { url: 'https://example.com/card.png', status: 200, content_type: 'image/png', bytes: 80_000, width: 1200, height: 630, aspect_ratio: 1.9, response_ms: 180, ...image },
    robots: { checked: true, allowed: true, note: null },
    checks: [
      { id: 'og_image', status: 'pass', title: 'og:image is set', detail: 'og:image is set.', fix: null },
      { id: 'og_title', status: 'pass', title: 'og:title is set', detail: 'og:title is 34 characters.', fix: null },
    ],
    preview: { title: 'How we cut our build time in half', description: 'Three changes.', domain: 'example.com', site_name: 'Example Blog', image: IMAGE, favicon: FAVICON, ...preview },
    ...rest,
  };
}

const byId = (items: Item[], id: string): Item | undefined => items.find((item) => item.id === id);

/* ------------------------------------------------------------------ */
/* Front matter and skeleton                                           */
/* ------------------------------------------------------------------ */

describe('the drafts', () => {
  it('exist, one per platform of the script, with front matter that publishes them only with "previews"', () => {
    expect(Object.keys(platform.PLATFORMS).sort()).toEqual(Object.keys(PLATFORM_PAGES).sort());
    for (const draft of DRAFTS) {
      const file = draftFile(draft.page);
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      const { data } = frontMatter(source(draft.page), file);
      expect(data.feature, file).toBe('previews');
      expect(data.title, file).toMatch(/\S/);
      expect(data.description?.length ?? 0, file).toBeGreaterThanOrEqual(80);
      expect(data.description?.length ?? 0, file).toBeLessThanOrEqual(220);
      if (draft.platform) {
        expect(data.scripts, file).toBe('og-platform');
        expect(platform.PLATFORMS[draft.platform].path).toBe(`/${draft.page}`);
      } else {
        expect(data.scripts, file).toBeUndefined();
      }
    }
  });

  it('has the skeleton og-platform.js fills, the form of its own platform and the "Fix it" link', () => {
    const ids = ['platform-form', 'platform-url', 'platform-submit', 'platform-hint', 'platform-error', 'platform-verify', 'platform-verify-text', 'platform-widget', 'platform-status',
      'platform-results', 'platform-results-title', 'platform-preview', 'platform-preview-notes', 'platform-compare', 'platform-verdict', 'platform-verdict-title', 'platform-verdict-text',
      'platform-verdict-meta', 'platform-checklist', 'platform-facts', 'platform-facts-image', 'platform-tags'];
    for (const [id, page] of Object.entries(PLATFORM_PAGES) as Array<[PlatformId, string]>) {
      const html = source(page);
      for (const name of ids) expect(html.match(new RegExp(`\\sid="${name}"`, 'g'))?.length, `${page} #${name}`).toBe(1);
      expect(html).toContain(`<form class="card card-pop tool-form" id="platform-form" data-platform="${id}" action="/${page}" method="get" novalidate>`);
      expect(html).toContain('maxlength="[[inspect.raw.maxUrlChars]]" required');
      expect(html).toContain(`<a class="btn btn-primary" href="/login" data-fix-link>${platform.FIX_TEXT}</a>`);
      expect(html).toMatch(/<h2>Fix it: make the card\.<\/h2>/);
      // The app's own checks have a list only where the script has some (Discord and X).
      const own = platform.platformChecks(id, result()).length > 0;
      expect(html.includes('id="platform-checks"'), page).toBe(own);
      // og-checker.js starts on #check-form; these pages must not have one, or both scripts would drive it.
      expect(html).not.toMatch(/id="check-/);
      // The preview comes first: the results open with it, before the verdict and the checklists.
      expect(html.indexOf('id="platform-preview"')).toBeLessThan(html.indexOf('id="platform-verdict"'));
    }
  });

  it('has no inline script, inline handler or inline style, and no feature marker the build would reject', () => {
    for (const draft of DRAFTS) {
      const html = source(draft.page);
      expect(html.match(/<script\b/g), draft.page).toBeNull();
      expect(html.match(/<[a-z][^>]*\son[a-z]+\s*=/g), draft.page).toBeNull();
      expect(html.match(/<[a-z][^>]*\sstyle\s*=/g), draft.page).toBeNull();
      expect(html, draft.page).not.toMatch(/<style\b/);
      // build-site.ts rejects any comment that looks like a marker but is not one.
      const masked = html.replace(/<!--[ \t]*\/?feature:[a-z][a-z0-9-]*[ \t]*-->/g, '');
      expect(masked, draft.page).not.toMatch(/<!--[^>]*?\bfeature\s*:/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Facts and numbers                                                   */
/* ------------------------------------------------------------------ */

describe('app facts', () => {
  it('lists only vendor pages that were read, and the script cites the same ones', () => {
    for (const url of Object.values(platform.SOURCES)) expect(Object.keys(VERIFIED_SOURCES)).toContain(url);
    for (const url of Object.keys(VERIFIED_SOURCES).filter((url) => !url.startsWith('https://github.com/'))) expect(platformSource).toContain(url);
    // The Discord numbers and the X rule each name their source right where they are defined.
    expect(platformSource).toMatch(/\/\/ Source: https:\/\/docs\.discord\.com\/developers\/link-previews\/overview[^\n]*\n(?:\/\/[^\n]*\n)*export const DISCORD/);
    expect(platformSource).toMatch(/Source: https:\/\/docs\.x\.com\/developer-terms\/policy[^\n]*\n(?:\s*\*[^\n]*\n)*\s*\*\/\nexport function xChecks/);
  });

  it('puts every app fact right after a source comment for a page read in that vendor\'s own documents', () => {
    for (const draft of DRAFTS) {
      const doc = parseDocument(source(draft.page), { withStartIndices: false });
      const facts = elements(doc.children).filter((node) => node.attribs['data-fact'] !== undefined);
      const allowed = draft.platform ? PAGE_SOURCES[draft.platform] : [];
      if (allowed.length === 0) expect(facts.length, `${draft.page} states an app fact, but nothing was verified for it`).toBe(0);
      else expect(facts.length, draft.page).toBeGreaterThan(0);
      for (const fact of facts) {
        const where = `${draft.page}: "${textOf(fact).trim().slice(0, 60)}"`;
        const comment = commentBefore(fact);
        expect(comment, where).not.toBeNull();
        const url = /^\s*source:\s*(\S+)\s*$/.exec(comment ?? '')?.[1];
        expect(url, `${where} needs <!-- source: URL --> right before it`).toBeDefined();
        expect(allowed, where).toContain(url);
        expect(fact.attribs['data-own'], where).toBeUndefined();
      }
    }
  });

  it('marks every other sentence that names an app as our own, and never gives a number for an app nothing was verified for', () => {
    for (const draft of DRAFTS) {
      const doc = parseDocument(source(draft.page));
      for (const node of elements(doc.children).filter((candidate) => ['p', 'li', 'dd', 'td'].includes(candidate.name))) {
        const text = decode(textOf(node)).replace(/\[\[[^\]]+\]\]/g, '');
        if (!VENDOR.test(text)) continue;
        const where = `${draft.page}: "${text.trim().slice(0, 70)}"`;
        expect(marked(node, 'data-fact') || marked(node, 'data-own'), `${where} names an app: mark it data-fact (with a source) or data-own`).toBe(true);
        if (!draft.platform || PAGE_SOURCES[draft.platform].length === 0) {
          const prose = decode(textOf(node, (element) => element !== node && element.name === 'code'));
          expect(prose.replace(/\[\[[^\]]+\]\]/g, ''), `${where}: a number next to an app name needs a verified source`).not.toMatch(/\d/);
        }
      }
    }
  });

  it('types no number outside a sourced fact, a [[token]] or code: limits come from src/config.ts', () => {
    for (const draft of DRAFTS) {
      const { body } = frontMatter(source(draft.page), draftFile(draft.page));
      const doc = parseDocument(body);
      const prose = (nodes: readonly ChildNode[]): string =>
        nodes
          .map((node) => {
            if (node.type === 'text') return node.data;
            if (!isElement(node) || node.name === 'code' || node.attribs['data-fact'] !== undefined) return ' ';
            return prose(node.children);
          })
          .join(' ');
      const text = decode(prose(doc.children)).replace(/\[\[[^\]]+\]\]/g, ' ');
      expect(text.match(/[^\s]*\d[^\s]*/g), draft.page).toBeNull();
    }
  });

  it('states the Discord numbers the script checks, and only those', () => {
    const { DISCORD } = platform;
    const html = decode(source(PLATFORM_PAGES.discord));
    const n = (value: number): string => value.toLocaleString('en-US');
    for (const phrase of [
      `${n(DISCORD.titleMaxBytes)} bytes or ${n(DISCORD.titleMaxLines)} lines`,
      `${n(DISCORD.descriptionMaxBytes)} bytes or ${n(DISCORD.descriptionMaxLines)} lines`,
      `over ${n(DISCORD.siteNameMaxChars)} characters`,
      `over ${n(DISCORD.imageAltMaxChars)} characters`,
      `over ${n(DISCORD.urlMaxChars)} characters`,
      `within ${DISCORD.fetchBudgetMs / 1000} seconds`,
      `at most ${DISCORD.maxRedirects} redirects`,
      `follows up to ${DISCORD.maxRedirects}.`,
      `about ${DISCORD.cacheMinutes} minutes`,
      `up to ${DISCORD.galleryMaxImages} images`,
    ]) {
      expect(html, phrase).toContain(phrase);
    }
    expect(html).toContain(DISCORD.embedDebugger);
    // Our own checker's numbers on the same page come from config, never typed.
    expect(source(PLATFORM_PAGES.discord)).toContain('follows up to [[inspect.maxRedirects]] redirects');
    expect(INSPECT.maxRedirects).not.toBe(DISCORD.maxRedirects);
  });
});

/* ------------------------------------------------------------------ */
/* Pure functions                                                      */
/* ------------------------------------------------------------------ */

describe('Discord rules', () => {
  it('counts UTF-8 bytes and cuts between characters, never over the budget', () => {
    expect(platform.utf8Bytes('abc')).toBe(3);
    expect(platform.utf8Bytes('é')).toBe(2);
    expect(platform.utf8Bytes('😀')).toBe(4);
    expect(platform.utf8Bytes(null)).toBe(0);
    expect(platform.truncateBytes('short', 70)).toBe('short');
    expect(platform.truncateBytes('ééééé', 5)).toBe('éé…');
    expect(platform.truncateBytes('ab😀cd', 5)).toBe('ab…');
    const long = 'Ünïcödé '.repeat(20);
    const cut = platform.truncateBytes(long, 70);
    expect(cut.endsWith('…')).toBe(true);
    expect(platform.utf8Bytes(cut.slice(0, -1))).toBeLessThanOrEqual(70);
    expect(platform.truncateBytes('x', 0)).toBe('');
  });

  it('takes the title from og: or twitter: tags, and <title> only as a pair when the page has neither', () => {
    expect(platform.discordText(result())).toMatchObject({ title: 'How we cut our build time in half', source: 'tags', tagsDiffer: false });
    expect(platform.discordText(result({ og: { title: null }, twitter: { title: 'From twitter' } })).title).toBe('From twitter');
    expect(platform.discordText(result({ twitter: { title: 'Other' } })).tagsDiffer).toBe(true);
    const pair = platform.discordText(result({ og: { title: null, description: null } }));
    expect(pair).toMatchObject({ title: 'Page title', description: 'Page description', source: 'page' });
    // A description tag without a title tag: <title> is not used.
    const unused = platform.discordText(result({ og: { title: null } }));
    expect(unused).toMatchObject({ title: '', source: 'tags', pageTitleUnused: true });
    // Only half the pair: nothing.
    expect(platform.discordText(result({ og: { title: null, description: null }, page: { description: null } }))).toMatchObject({ title: '', source: null });
  });

  it('picks the layout from twitter:card and og:type, not from the image', () => {
    expect(platform.discordLayout(result()).layout).toBe('large');
    expect(platform.discordLayout(result({ twitter: { card: null } })).layout).toBe('small');
    expect(platform.discordLayout(result({ twitter: { card: 'summary' } })).layout).toBe('small');
    expect(platform.discordLayout(result({ twitter: { card: 'photo' } })).layout).toBe('photo');
    expect(platform.discordLayout(result({ twitter: { card: null }, og: { type: 'rich' } })).layout).toBe('rich');
    expect(platform.discordLayout(result({ twitter: { card: 'player' } }))).toEqual({ layout: 'small', askedForVideo: true });
    expect(platform.discordLayout(result({ twitter: { card: null }, og: { type: 'video.other' } })).askedForVideo).toBe(true);
  });

  it('accepts only 6- or 8-digit hex as the accent colour', () => {
    for (const ok of ['#2f6feb', '#2F6FEB', '#2f6feb80']) expect(platform.discordAccent(ok)).toBe(ok);
    for (const bad of ['#fff', '#ffff', 'red', 'rgb(0,0,0)', '#2f6feb8', '2f6feb', '', null]) expect(platform.discordAccent(bad)).toBeNull();
  });

  it('passes a well-tagged page, with the layout as a note', () => {
    const checks = platform.discordChecks(result());
    expect(checks.filter((item) => item.status === 'fail' || item.status === 'warn')).toEqual([]);
    expect(byId(checks, 'discord_layout')).toMatchObject({ status: 'info', title: 'Layout: large image below the text', fix: null });
    expect(byId(checks, 'discord_title')?.title).toBe('Title fits: 33 of 70 bytes');
    expect(byId(checks, 'discord_accent')?.status).toBe('pass');
    expect(byId(checks, 'discord_fetch_time')?.title).toBe("Fetch time: 0.6 s of Discord's 10");
    expect(platform.platformVerdict('discord', result()).tone).toBe('ok');
  });

  it('fails what makes Discord show no preview or no part of it', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    const checks = platform.discordChecks(
      result({
        og: { title: null, site_name: 'S'.repeat(257), image: 'images/card.png', url: long },
        image: { content_type: 'image/svg+xml' },
        response_ms: 6000,
        // A result carries at most 2,048 characters of a tag plus an ellipsis.
      }),
    );
    expect(byId(checks, 'discord_title')).toMatchObject({ status: 'fail', title: 'Discord has no title to show' });
    expect(byId(checks, 'discord_title')?.detail).toMatch(/will not use your <title> here/);
    expect(byId(checks, 'discord_site_name')?.status).toBe('fail');
    expect(byId(checks, 'discord_url_length')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'discord_url_length')?.detail).toMatch(/^og:url is longer/);
    expect(byId(checks, 'discord_image_relative')?.status).toBe('fail');
    expect(byId(checks, 'discord_image_format')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'discord_fetch_time')).toMatchObject({ status: 'pass' });
    const slow = platform.discordChecks(result({ response_ms: 9000, image: { response_ms: 1500 } }));
    expect(byId(slow, 'discord_fetch_time')).toMatchObject({ status: 'fail', title: "Over Discord's 10-second budget" });
  });

  it('warns about trimmed text, a colour Discord ignores, HTML in the description and missing size tags', () => {
    const checks = platform.discordChecks(
      result({
        og: { title: 'Ä'.repeat(36), description: 'Read <b>this</b> now. '.repeat(20), image_width: null },
        page: { theme_color: '#fff' },
        image: { width: 1000, height: 500 },
      }),
    );
    expect(byId(checks, 'discord_title')).toMatchObject({ status: 'warn', title: 'Title is over 70 bytes, so Discord trims it' });
    expect(byId(checks, 'discord_title')?.detail).toMatch(/^The title is 72 bytes/);
    expect(byId(checks, 'discord_description')?.status).toBe('warn');
    expect(byId(checks, 'discord_description_html')?.detail).toContain('"<b>"');
    expect(byId(checks, 'discord_accent')?.status).toBe('warn');
    // The fix suggests the image's real size when the probe measured it.
    expect(byId(checks, 'discord_image_size_tags')?.fix).toContain('content="1000"> and <meta property="og:image:height" content="500">');
    // og:type rich renders markdown, so HTML is not flagged there; a relative URL from / is fine.
    const rich = platform.discordChecks(result({ og: { type: 'rich', description: 'a <b>b</b>', image: '/card.png' }, twitter: { card: null } }));
    expect(byId(rich, 'discord_description_html')).toBeUndefined();
    expect(byId(rich, 'discord_image_relative')).toBeUndefined();
  });

  it('notes what Discord leaves out, without counting it as a problem', () => {
    const checks = platform.discordChecks(result({ og: { site_name: null, description: null, image: null }, page: { theme_color: null }, twitter: { card: null }, image: null }));
    expect(byId(checks, 'discord_layout')).toMatchObject({ status: 'info', title: 'Layout: text only' });
    expect(byId(checks, 'discord_site_name')?.status).toBe('info');
    expect(byId(checks, 'discord_accent')?.status).toBe('info');
    expect(byId(checks, 'discord_description')?.status).toBe('info');
    expect(byId(checks, 'discord_image_format')).toBeUndefined();
    expect(byId(checks, 'discord_image_size_tags')).toBeUndefined();
    const photo = platform.discordChecks(result({ twitter: { card: 'photo' } }));
    expect(byId(photo, 'discord_description')).toMatchObject({ status: 'info', title: 'No description in this layout' });
    const video = platform.discordChecks(result({ twitter: { card: 'player' } }));
    expect(byId(video, 'discord_layout')?.detail).toMatch(/og:video points at a video file, which this checker does not read/);
  });
});

describe('X rules', () => {
  it('checks that card images are on https, resolving relative ones against the page', () => {
    expect(platform.xChecks(result())).toEqual([expect.objectContaining({ id: 'x_https_assets', status: 'pass' })]);
    expect(platform.xChecks(result({ og: { image: '/card.png' } }))[0]?.status).toBe('pass');
    const http = platform.xChecks(result({ twitter: { image: 'http://cdn.example.com/x.png' } }))[0];
    expect(http).toMatchObject({ status: 'fail' });
    expect(http?.detail).toMatch(/^twitter:image does not point at an https:\/\/ address\. X's developer policy says all assets within a card must be hosted on HTTPS\.$/);
    expect(platform.xChecks(result({ og: { image: null }, twitter: { image: 'https://example.com/x.png' } }))).toEqual([expect.objectContaining({ status: 'pass' })]);
    expect(platform.xChecks(result({ og: { image: null }, twitter: { image: null } }))).toEqual([]);
  });

  it('draws the large card only for summary_large_image and says why otherwise', () => {
    expect(platform.xLayout(result())).toBe('large');
    expect(platform.xCardNote(result())).toBe('');
    for (const card of [null, 'summary', 'player']) {
      expect(platform.xLayout(result({ twitter: { card } }))).toBe('small');
      expect(platform.xCardNote(result({ twitter: { card } }))).toMatch(/mockup shows .*small.*summary_large_image/);
    }
    expect(platform.xText(result({ twitter: { title: 'On X' } })).title).toBe('On X');
    expect(platform.xText(result({ og: { title: null }, twitter: { title: null } })).title).toBe('Page title');
  });

  it('gives LinkedIn, Slack and WhatsApp no checks of their own, since none of their rules was verified', () => {
    for (const id of ['linkedin', 'slack', 'whatsapp']) expect(platform.platformChecks(id, result({ twitter: { image: 'http://x.example/a.png' } }))).toEqual([]);
  });
});

describe('mockups and links', () => {
  it('cuts Discord text to Discord\'s byte limits and follows the layout', () => {
    const long = platform.mockupModel('discord', result({ og: { title: 'é'.repeat(50), description: 'd'.repeat(400) } }));
    expect(platform.utf8Bytes(long.title.slice(0, -1))).toBeLessThanOrEqual(70);
    expect(long.description.length).toBe(351);
    expect(platform.mockupModel('discord', result({ twitter: { card: 'photo' } })).description).toBe('');
    expect(platform.mockupModel('discord', result({ og: { image: null }, twitter: { image: null } })).layout).toBe('text');
    expect(platform.mockupModel('discord', result()).accent).toBe('#2f6feb');
    expect(platform.mockupModel('discord', result({ page: { theme_color: '#abc' } })).accent).toBeNull();
  });

  it('shows images only from our own proxy, and carries the X note', () => {
    for (const id of platform.PLATFORM_IDS) {
      expect(platform.mockupModel(id, result()).image, id).toBe(IMAGE);
      expect(platform.mockupModel(id, result({ preview: { image: 'https://evil.example/x.png', favicon: 'javascript:alert(1)' } })).image, id).toBeNull();
    }
    expect(platform.mockupModel('x', result({ twitter: { card: null } })).notes).toHaveLength(1);
    expect(platform.mockupModel('whatsapp', result()).url).toBe('https://example.com/blog/post');
    expect(() => platform.mockupModel('myspace', result())).toThrow();
  });

  it('builds share links to the page itself and to the six-app checker', () => {
    expect(platform.shareUrlFor('discord', 'https://example.com/a?b=c')).toBe('/tools/discord-embed-preview?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc');
    expect(platform.checkerHref('https://example.com/a')).toBe('/tools/og-checker?url=https%3A%2F%2Fexample.com%2Fa');
    expect(platform.checkerHref('')).toBe('/tools/og-checker');
    expect(() => platform.shareUrlFor('myspace', 'https://example.com')).toThrow();
  });

  it('lists problems first, then notes, then passes, keeping the order within each', () => {
    const items = ['pass:a', 'info:b', 'fail:c', 'warn:d', 'pass:e', 'fail:f'].map((pair) => {
      const [status, id] = pair.split(':');
      return { id, status };
    });
    expect(platform.sortPlatformChecks(items).map((item) => item.id)).toEqual(['c', 'f', 'd', 'b', 'a', 'e']);
  });
});

/* ------------------------------------------------------------------ */
/* Static safety of the script and the stylesheet                      */
/* ------------------------------------------------------------------ */

describe('og-platform.js and og-platform.css', () => {
  it('reuses og-checker.js unchanged, through its exports only', () => {
    const imported = /import \{([^}]+)\} from '\.\/og-checker\.js';/.exec(platformSource)?.[1] ?? '';
    const names = imported.split(',').map((name) => name.trim()).filter(Boolean);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(checkerSource, name).toMatch(new RegExp(`export (?:const|function) ${name}\\b`));
    // og-checker.js binds only to #check-form, which these pages do not have.
    expect(checkerSource).toContain("document.getElementById('check-form')");
  });

  it('never turns third-party text into HTML and talks only to our own API', () => {
    expect(platformSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\beval\(|new Function/);
    expect(platformSource.match(/\bfetch\(/g)).toHaveLength(1);
    expect(platformSource).toContain('fetch(checkRequestUrl(url, token)');
    // Other origins appear only in source comments and as the Embed Debugger link the checks mention.
    const code = platformSource.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const origins = new Set(code.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g));
    expect([...origins].sort()).toEqual(['https://discord.com', 'https://docs.discord.com', 'https://docs.x.com']);
    expect(platformSource).toContain("STYLESHEET = '/assets/css/og-platform.css'");
  });

  it('styles with site.css tokens only, and styles every class the script adds', () => {
    const css = read('site/public/assets/css/og-platform.css');
    const site = read('site/public/assets/css/site.css');
    for (const [, token] of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(site, token).toContain(`${token}:`);
    expect(css).not.toMatch(/@import|url\(/);
    const classes = new Set<string>();
    for (const [, list] of platformSource.matchAll(/class: [`'"]([^`'"]+)[`'"]/g)) for (const name of (list ?? '').split(/\s+/)) if (!name.includes('$')) classes.add(name);
    for (const layout of ['small', 'large', 'photo', 'text', 'rich']) classes.add(`pv-layout-${layout}`);
    classes.add('cl-info');
    const styled = `${css}\n${site}`;
    for (const name of classes) {
      if (['pv-layout-large'].includes(name)) continue; // the large Discord layout is site.css's plain .pv-discord card
      expect(styled, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
    for (const name of ['platform-preview', 'platform-preview-notes', 'platform-fix']) expect(css).toContain(`.${name} `);
  });
});

/* ------------------------------------------------------------------ */
/* The script on the real page, in a small fake DOM                    */
/* ------------------------------------------------------------------ */

type Listener = (event: FakeEvent) => void;
interface FakeEvent {
  type: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

class FakeText {
  parent: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  parent: FakeElement | null = null;
  children: Array<FakeElement | FakeText> = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  style = { props: new Map<string, string>(), setProperty: (name: string, value: string): void => void this.style.props.set(name, value) };
  value = '';
  disabled = false;
  clientWidth = 480;
  constructor(public tagName: string, private readonly doc: FakeDocument) {}

  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', value);
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  get hidden(): boolean {
    return this.attributes.has('hidden');
  }
  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }
  get dataset(): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [name, value] of this.attributes) if (name.startsWith('data-')) data[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value;
    return new Proxy(data, {
      set: (_target, key, value) => {
        this.setAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
      // Stylesheets "load" at once; scripts never do (nothing runs in this DOM).
      if (child instanceof FakeElement && child.tagName === 'link') queueMicrotask(() => child.dispatch('load'));
    }
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  replaceWith(node: FakeElement): void {
    const parent = this.parent;
    if (!parent) return;
    parent.children[parent.children.indexOf(this)] = node;
    node.parent = parent;
    this.parent = null;
  }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.replaceChildren(String(value));
  }
  get childElementCount(): number {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string): FakeEvent {
    const event: FakeEvent = { type, defaultPrevented: false, preventDefault: () => void (event.defaultPrevented = true) };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  focus(): void {
    this.doc.focused = this;
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => (child instanceof FakeElement ? [child, ...child.descendants()] : []));
  }
  /** Enough of querySelectorAll for the script: tag[attr] and tag[attr="value"] lists. */
  querySelectorAll(selector: string): FakeElement[] {
    const match = /^([a-z]*)((?:\[[a-z-]+(?:="[^"]*")?\])*)$/.exec(selector);
    if (!match) throw new Error(`unsupported selector ${selector}`);
    const tests = [...(match[2] ?? '').matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)].map(([, name, value]) => ({ name: name ?? '', value }));
    return this.descendants().filter((node) => (!match[1] || node.tagName === match[1]) && tests.every(({ name, value }) => node.attributes.has(name) && (value === undefined || node.attributes.get(name) === value)));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  focused: FakeElement | null = null;
  root: FakeElement;
  head: FakeElement;
  body: FakeElement;
  constructor(html: string) {
    this.root = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.root.append(this.head, this.body);
    const build = (nodes: readonly ChildNode[], into: FakeElement): void => {
      for (const node of nodes) {
        if (node.type === 'text') into.append(node.data);
        else if (isElement(node)) {
          if (node.name === 'html' || node.name === 'body') {
            build(node.children, node.name === 'body' ? this.body : into);
            continue;
          }
          if (node.name === 'head') {
            build(node.children, this.head);
            continue;
          }
          const element = new FakeElement(node.name, this);
          for (const [name, value] of Object.entries(node.attribs)) element.setAttribute(name, value);
          if (node.name === 'input') element.value = node.attribs.value ?? '';
          into.append(element);
          build(node.children, element);
        }
      }
    };
    build(parseDocument(html).children, this.body);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement | null {
    return this.root.descendants().find((node) => node.id === id) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.root.querySelectorAll(selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.root.querySelector(selector);
  }
}

interface FakeResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Loads a fresh copy of og-platform.js into the page's fake DOM, with fetch answering from `responses`. */
async function runPage(platformId: PlatformId, html: string, { search = '', responses = [] as FakeResponse[], turnstile = null as unknown } = {}) {
  const doc = new FakeDocument(html);
  const requests: string[] = [];
  const replaced: string[] = [];
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { turnstile });
  vi.stubGlobal('location', { search });
  vi.stubGlobal('history', { replaceState: (_state: unknown, _title: string, url: string) => void replaced.push(url) });
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    const next = responses.shift() ?? { status: 500, body: null };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
      json: async () => next.body,
    };
  });
  await import(`${pathToFileURL(join(JS, 'og-platform.js')).href}?page=${platformId}&run=${Math.random()}`);
  const $ = (id: string): FakeElement => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`no #${id}`);
    return node;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  return { doc, $, requests, replaced, settle };
}

describe('og-platform.js on the real pages', () => {
  let site: RenderedSite;
  beforeAll(() => {
    site = buildDrafts({ pdf: true, toolkit: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  const pageHtml = (id: PlatformId): string => {
    const html = site.pages.find((page) => page.outPath === `${PLATFORM_PAGES[id]}.html`)?.html;
    if (!html) throw new Error(`no ${PLATFORM_PAGES[id]}`);
    return html;
  };
  const shared = `?url=${encodeURIComponent('https://example.com/blog/post')}`;

  it('runs a shared ?url= check and fills every part of the page, the preview first', async () => {
    for (const id of Object.keys(PLATFORM_PAGES) as PlatformId[]) {
      const hostile = '<img src=x onerror=alert(1)> Title';
      const { doc, $, requests, replaced } = await runPage(id, pageHtml(id), {
        search: shared,
        responses: [{ status: 200, body: result({ og: { title: hostile }, preview: { title: hostile } }) }],
      });
      expect(requests, id).toEqual(['/api/tools/og-check?url=https%3A%2F%2Fexample.com%2Fblog%2Fpost']);
      expect($('platform-results').hidden, id).toBe(false);
      const figure = $('platform-preview').querySelector(`figure[class="pv pv-${id}"]`);
      expect(figure, id).not.toBeNull();
      expect(figure?.querySelector('span[class="pv-approx"]')?.textContent, id).toBe('Approximate preview');
      // Third-party text stays text: no element came out of it.
      expect(figure?.textContent, id).toContain(hostile);
      expect(doc.root.descendants().some((node) => node.tagName === 'img' && node.getAttribute('src') === 'x'), id).toBe(false);
      for (const img of doc.root.descendants().filter((node) => node.tagName === 'img' && node.getAttribute('src')?.startsWith('/api/'))) {
        expect(img.getAttribute('src'), id).toMatch(/^\/api\/tools\/og-check\/chk_test1\/(?:image|favicon)$/);
      }
      expect($('platform-verdict').getAttribute('data-tone'), id).toMatch(/^(ok|warn|fail)$/);
      expect($('platform-verdict-title').textContent, id).not.toBe('');
      expect($('platform-checklist').childElementCount, id).toBe(2);
      expect($('platform-tags').childElementCount, id).toBeGreaterThan(10);
      expect($('platform-facts').childElementCount, id).toBeGreaterThan(0);
      if (id === 'discord' || id === 'x') expect($('platform-checks').childElementCount, id).toBe(platform.platformChecks(id, result()).length);
      const fix = doc.querySelectorAll('a[data-fix-link]');
      expect(fix.length, id).toBe(1);
      expect(fix[0]?.getAttribute('href'), id).toMatch(/^\/login\?next=%2Fdashboard%3Ftitle%3D/);
      expect($('platform-compare').getAttribute('href'), id).toBe(platform.checkerHref('https://example.com/blog/post'));
      // A shared link does not rewrite the address bar or move focus.
      expect(replaced, id).toEqual([]);
      expect(doc.focused, id).toBeNull();
      expect(doc.head.querySelectorAll(`link[rel="stylesheet"][href="${platform.STYLESHEET}"]`), id).toHaveLength(1);
    }
  });

  it('draws the Discord layout and accent from the tags, and the X note under a small card', async () => {
    const discord = await runPage('discord', pageHtml('discord'), { search: shared, responses: [{ status: 200, body: result({ twitter: { card: null } }) }] });
    const card = discord.$('platform-preview').querySelector('div[class="pv-card pv-layout-small"]');
    expect(card).not.toBeNull();
    expect(card?.style.props.get('--pv-accent')).toBe('#2f6feb');
    vi.unstubAllGlobals();
    const x = await runPage('x', pageHtml('x'), { search: shared, responses: [{ status: 200, body: result({ twitter: { card: 'summary' } }) }] });
    expect(x.$('platform-preview').querySelector('div[class="pv-card pv-small"]')).not.toBeNull();
    expect(x.$('platform-preview-notes').hidden).toBe(false);
    expect(x.$('platform-preview-notes').textContent).toContain('summary_large_image');
  });

  it('checks what the visitor types, fixes the address and shares the result under the page\'s own path', async () => {
    const page = await runPage('slack', pageHtml('slack'), { responses: [{ status: 200, body: result() }] });
    expect(page.requests).toEqual([]);
    page.$('platform-url').value = 'example.com/blog/post';
    const event = page.$('platform-form').dispatch('submit');
    expect(event.defaultPrevented).toBe(true);
    await page.settle();
    expect(page.$('platform-url').value).toBe('https://example.com/blog/post');
    expect(page.replaced).toEqual(['/tools/slack-link-preview?url=https%3A%2F%2Fexample.com%2Fblog%2Fpost']);
    expect(page.$('platform-results').hidden).toBe(false);
    expect(page.doc.focused?.id).toBe('platform-results-title');
    // http:// is refused before any request.
    page.$('platform-url').value = 'http://example.com';
    page.$('platform-form').dispatch('submit');
    await page.settle();
    expect(page.requests).toHaveLength(1);
    expect(page.$('platform-error').hidden).toBe(false);
    expect(page.$('platform-url').getAttribute('aria-invalid')).toBe('true');
  });

  it('explains a rate limit and hides old results', async () => {
    const page = await runPage('whatsapp', pageHtml('whatsapp'), {
      search: shared,
      responses: [{ status: 429, body: { error: { code: 'rate_limited', message: 'Too many', details: {} } }, headers: { 'retry-after': '120' } }],
    });
    expect(page.$('platform-results').hidden).toBe(true);
    expect(page.$('platform-error').hidden).toBe(false);
    expect(page.$('platform-error').textContent).toMatch(/^That is the free limit for this hour\. Too many fresh checks came from your network this hour\. Try again after .+ \(in about 2 minutes\)\.$/);
    expect(page.$('platform-status').textContent).toBe('That is the free limit for this hour.');
  });

  it('shows Turnstile when asked and retries with its token', async () => {
    const rendered: Array<{ sitekey: string; callback: (token: string) => void }> = [];
    const turnstile = { render: (_slot: unknown, options: { sitekey: string; callback: (token: string) => void }) => (rendered.push(options), 'widget-1'), remove: () => undefined, reset: () => undefined };
    const page = await runPage('linkedin', pageHtml('linkedin'), {
      search: shared,
      turnstile,
      responses: [
        { status: 403, body: { error: { code: 'verification_required', message: 'x', details: { site_key: '0x4AAAA' } } } },
        { status: 200, body: result() },
      ],
    });
    expect(page.$('platform-verify').hidden).toBe(false);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.sitekey).toBe('0x4AAAA');
    rendered[0]?.callback('tok-1');
    await page.settle();
    expect(page.requests[1]).toBe('/api/tools/og-check?url=https%3A%2F%2Fexample.com%2Fblog%2Fpost&turnstile=tok-1');
    expect(page.$('platform-results').hidden).toBe(false);
    expect(page.$('platform-verify').hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The drafts built by the real build                                  */
/* ------------------------------------------------------------------ */

/**
 * Features of build v3 that the drafts use; whichever build-site.ts does not know yet is applied here.
 * localpdf: the hub's in-browser PDF tools, their own feature since the owner decision of 2026-11-27.
 */
const DRAFT_FEATURES = ['previews', 'toolkit', 'localpdf'] as const;

/** Keeps (on) or drops (off) the blocks of the features build-site.ts does not know yet. Blocks do not nest. */
function applyUnknownBlocks(text: string, on: Record<string, boolean>): string {
  const unknown = DRAFT_FEATURES.filter((feature) => !(FEATURES as readonly string[]).includes(feature));
  let out = text;
  for (const feature of unknown) {
    const block = new RegExp(`^[ \\t]*<!--[ \\t]*feature:${feature}[ \\t]*-->[ \\t]*\\n([\\s\\S]*?)^[ \\t]*<!--[ \\t]*/feature:${feature}[ \\t]*-->[ \\t]*\\n`, 'gm');
    out = out.replace(block, (_match, inner: string) => (on[feature] ? inner : ''));
  }
  // The page-level switch: build-site.ts would reject an unknown feature name in front matter.
  if (unknown.includes('previews')) out = out.replace(/^feature: previews[ \t]*\n/m, '');
  return out;
}

/** Expands the tokens build-site.ts does not print yet (v3SiteTokens, previewsSiteTokens), escaped as it would. */
function applyPendingTokens(text: string): string {
  const known = new Set(Object.keys(listTokens({ env: {}, now: NOW }).tokens));
  const pending = { ...v3SiteTokens(), ...previewsSiteTokens() };
  return text.replace(/\[\[([a-zA-Z][\w.]*)\]\]/g, (match, name: string) => {
    if (known.has(name) || pending[name] === undefined) return match;
    return pending[name].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  });
}

/**
 * A copy of site/ (pages, layouts, partials, config; public/ linked) with the drafts written as pages,
 * rendered by the real build-site.ts. Content stays the repository's own.
 */
function buildDrafts(on: { pdf: boolean; toolkit: boolean }): RenderedSite {
  // The in-browser PDF pages (localpdf) come with the toolkit here, as they did before they had their own feature.
  const features = { previews: true, ...on, localpdf: on.toolkit };
  const dir = join(scratch, `site-${features.pdf ? 'pdf' : 'nopdf'}-${features.toolkit ? 'kit' : 'nokit'}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  for (const part of ['layouts', 'partials', 'pages']) cpSync(join(ROOT, 'site', part), join(dir, part), { recursive: true });
  cpSync(join(ROOT, 'site/site.config.json'), join(dir, 'site.config.json'));
  symlinkSync(join(ROOT, 'site/public'), join(dir, 'public'));
  for (const draft of DRAFTS) {
    const out = join(dir, 'pages', `${draft.page}.html`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, applyPendingTokens(applyUnknownBlocks(source(draft.page), features)));
  }
  const known = DRAFT_FEATURES.filter((feature) => (FEATURES as readonly string[]).includes(feature) && features[feature]);
  const env: Record<string, string> = { SITE_PDF: features.pdf ? 'on' : 'off' };
  if (known.length > 0) env.SITE_FEATURES = [...known, ...(features.pdf ? ['pdf'] : [])].join(',');
  return renderSite({ siteDir: dir, contentDir: join(ROOT, 'site/content'), env, now: NOW });
}

/** Every page under site/pages that another build v3 step left as a draft, as its URL. */
function draftUrls(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.html.draft')) found.add(`/${prefix}${entry.name.slice(0, -'.html.draft'.length)}`);
    }
  };
  walk('site/pages', '');
  return found;
}

describe('the drafts, built', () => {
  let all: RenderedSite;
  let none: RenderedSite;
  beforeAll(() => {
    all = buildDrafts({ pdf: true, toolkit: true });
    none = buildDrafts({ pdf: false, toolkit: false });
  });

  const html = (site: RenderedSite, page: string): string => {
    const found = site.pages.find((candidate) => candidate.outPath === `${page}.html`);
    if (!found) throw new Error(`${page} was not built`);
    return found.html;
  };
  const main = (page: string): string => page.slice(page.indexOf('<main'), page.indexOf('</main>'));

  it('builds every draft at its own URL with its script, canonical link and a place in the sitemap', () => {
    for (const draft of DRAFTS) {
      const page = html(all, draft.page);
      expect(page, draft.page).toContain(`<link rel="canonical" href="https://linktocard.com/${draft.page}">`);
      expect(all.sitemap, draft.page).toContain(`<loc>https://linktocard.com/${draft.page}</loc>`);
      if (draft.platform) expect(page, draft.page).toContain('<script type="module" src="/assets/js/og-platform.js"></script>');
      if (draft.platform) expect(page, draft.page).toContain(`maxlength="${INSPECT.maxUrlChars}" required`);
      expect(page, draft.page).not.toMatch(/\[\[|\]\]|feature:/);
      expect(page.match(/<script\b(?![^>]*\ssrc=)[^>]*>/g), draft.page).toBeNull();
      expect(page.match(/<[a-z][^>]*\sstyle\s*=/g), draft.page).toBeNull();
    }
  });

  it('gives each page a title and description no other page of the site has', () => {
    for (const site of [all, none]) {
      const titles = new Map<string, string>();
      const descriptions = new Map<string, string>();
      for (const page of site.pages) {
        const title = /<title>([^<]+)<\/title>/.exec(page.html)?.[1] ?? '';
        const description = /<meta name="description" content="([^"]+)">/.exec(page.html)?.[1] ?? '';
        expect(titles.get(title), `${page.outPath} repeats the title of ${titles.get(title)}`).toBeUndefined();
        expect(descriptions.get(description), `${page.outPath} repeats the description of ${descriptions.get(description)}`).toBeUndefined();
        titles.set(title, page.outPath);
        descriptions.set(description, page.outPath);
      }
    }
  });

  it('links only to pages, drafts, anchors and API paths that exist', () => {
    const drafts = draftUrls();
    for (const site of [all, none]) {
      const urls = new Map(site.pages.map((page) => [page.url, page.html]));
      for (const draft of DRAFTS) {
        for (const [, href] of main(html(site, draft.page)).matchAll(/href="([^"]+)"/g)) {
          if (!href || /^(?:https:|mailto:)/.test(href)) continue;
          const [path = '', anchor] = href.split('#');
          const target = path || `/${draft.page}`;
          expect(urls.has(target) || drafts.has(target) || /^\/(?:api|v1)\//.test(target), `${draft.page} links to ${href}`).toBe(true);
          if (anchor && urls.has(target)) expect(urls.get(target), `${draft.page} links to ${href}`).toContain(` id="${anchor}"`);
        }
      }
    }
    // External links: only the vendor page the Discord facts cite (its Embed Debugger).
    const external = DRAFTS.flatMap((draft) => [...main(html(all, draft.page)).matchAll(/href="(https:[^"]+)"/g)].map((match) => match[1]));
    expect([...new Set(external)]).toEqual(['https://discord.com/developers/embeds']);
  });

  it('lists every free tool on the hub, the PDF ones only with their feature', () => {
    const hub = main(html(all, HUB));
    const tools = readdirSync(join(ROOT, 'site/pages/tools'))
      .filter((name) => /\.html(?:\.draft)?$/.test(name))
      .map((name) => `/tools/${name.replace(/\.html(?:\.draft)?$/, '')}`)
      // The chart pages belong to "charts", which this draft build leaves out; tests/node/charts-site.test.ts
      // checks that the staging hub lists all four.
      .filter((tool) => !/(?:chart|graph)-maker$/.test(tool));
    expect(tools.length).toBeGreaterThanOrEqual(11);
    for (const tool of tools) expect(hub, tool).toContain(`href="${tool}"`);
    expect(hub).toContain('href="/#playground"');
    const bare = main(html(none, HUB));
    for (const tool of ['/tools/html-to-pdf', '/tools/invoice-generator', '/tools/certificate-generator', '/tools/merge-pdf', '/tools/image-to-pdf']) expect(bare, tool).not.toContain(tool);
    for (const page of Object.values(PLATFORM_PAGES)) expect(bare, page).toContain(`href="/${page}"`);
    expect(bare).toContain('href="/tools/og-checker"');
  });

  it('is left out of the build while "previews" is off', () => {
    if ((FEATURES as readonly string[]).includes('previews')) {
      const off = renderSite({ env: {}, now: NOW });
      for (const draft of DRAFTS) expect(off.pages.some((page) => page.outPath === `${draft.page}.html`), draft.page).toBe(false);
    } else {
      // Until build-site.ts knows the feature, the pages are .draft files that no build reads.
      const site = renderSite({ env: { SITE_PDF: 'on' }, now: NOW });
      for (const draft of DRAFTS) {
        expect(draftFile(draft.page).endsWith('.html.draft'), draft.page).toBe(true);
        expect(site.pages.some((page) => page.outPath === `${draft.page}.html`), draft.page).toBe(false);
      }
    }
  });
});
