/// <reference path="./fixtures/og/raw.d.ts" />
// OG checker building blocks, without the route: the tag parser on the fixture pages,
// image header parsing, robots.txt matching, the checklist (every check id) and the
// injected time budgets.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSPECT } from '../src/config';
import { buildChecks, type ChecklistInput } from '../src/inspect/checks';
import { runInspection } from '../src/inspect/check';
import { readBody } from '../src/inspect/fetch';
import { type ImageOutcome, probeImage, readImageSize } from '../src/inspect/image';
import { decodeHtml, parseHead, pickFavicon, urlForm } from '../src/inspect/parse';
import { robotsAllows } from '../src/inspect/robots';
import { CHECK_IDS, type CheckItem, type ImageProbe } from '../src/inspect/types';
import { ApiError } from '../src/lib/errors';
import goodHtml from './fixtures/og/good.html?raw';
import httpImageHtml from './fixtures/og/http-image.html?raw';
import missingHtml from './fixtures/og/missing-tags.html?raw';
import relativeHtml from './fixtures/og/relative-image.html?raw';
import { type FixtureFormat, imageFile } from './fixtures/og/images';

afterEach(() => {
  vi.restoreAllMocks();
});

const MB = 1024 * 1024;

describe('parseHead on the fixture pages', () => {
  it('reads every preview tag of a good page; the first value wins and SVG titles are ignored', () => {
    const head = parseHead(goodHtml);
    expect(head.title).toBe('Acme Widgets & Gadgets');
    expect(head.description).toBe('Hand-made widgets, shipped worldwide.');
    expect(head.canonical).toBe('https://shop.ogfixtures.com/widgets');
    expect(head.themeColor).toBe('#0f766e');
    expect(head.og).toEqual({
      title: 'Acme Widgets',
      description: 'Hand-made widgets, shipped worldwide.',
      image: 'https://cdn.ogfixtures.com/card.png',
      image_alt: 'A row of widgets',
      image_width: '1200',
      image_height: '630',
      url: 'https://shop.ogfixtures.com/widgets',
      type: 'website',
      site_name: 'Acme',
    });
    expect(head.twitter).toEqual({
      card: 'summary_large_image',
      title: 'Acme Widgets on X',
      description: 'Widgets for everyone.',
      image: 'https://cdn.ogfixtures.com/card-x.png',
      site: '@acme',
    });
    // rel=icon is preferred over apple-touch-icon even though it comes later.
    expect(pickFavicon(head.icons, new URL('https://shop.ogfixtures.com/widgets')).href).toBe('https://shop.ogfixtures.com/static/icon-32.png');
  });

  it('reports missing tags as null and falls back to /favicon.ico', () => {
    const head = parseHead(missingHtml);
    expect(head.title).toBe('Only a title');
    expect(Object.values(head.og).every((value) => value === null)).toBe(true);
    expect(Object.values(head.twitter).every((value) => value === null)).toBe(true);
    expect(pickFavicon(head.icons, new URL('https://a.ogfixtures.com/x/y')).href).toBe('https://a.ogfixtures.com/favicon.ico');
  });

  it('keeps a relative og:image as written and resolves icons against the final URL', () => {
    const head = parseHead(relativeHtml);
    expect(head.og.image).toBe('images/card.png');
    expect(urlForm(head.og.image!)).toBe('relative');
    expect(pickFavicon(head.icons, new URL('https://r.ogfixtures.com/blog/post')).href).toBe('https://r.ogfixtures.com/blog/favicon-16.ico');
  });

  it('keeps an http og:image as written', () => {
    expect(parseHead(httpImageHtml).og.image).toBe('http://cdn.ogfixtures.com/card.png');
    expect(urlForm('//cdn.ogfixtures.com/a.png')).toBe('scheme_relative');
    expect(urlForm('https://cdn.ogfixtures.com/a.png')).toBe('absolute');
  });

  it('decodes the declared character set', () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('<title>Caf'), 0xe9, ...new TextEncoder().encode('</title>')]);
    expect(parseHead(decodeHtml(latin1, 'text/html; charset=ISO-8859-1')).title).toBe('Café');
    const meta = new TextEncoder().encode('<meta charset="utf-8"><title>Café</title>');
    expect(parseHead(decodeHtml(meta, 'text/html')).title).toBe('Café');
  });

  it('takes name= and property= alike, and entity-decodes attribute values', () => {
    const head = parseHead('<meta name="og:title" content="Tom &amp; Jerry"><meta property="twitter:card" content="summary">');
    expect(head.og.title).toBe('Tom & Jerry');
    expect(head.twitter.card).toBe('summary');
  });
});

describe('readImageSize', () => {
  const cases: [FixtureFormat, number, number][] = [
    ['png', 1200, 630],
    ['jpeg', 1200, 628],
    ['gif', 600, 315],
    ['webp-vp8', 1200, 630],
    ['webp-vp8l', 800, 419],
    ['webp-vp8x', 2400, 1260],
  ];
  for (const [format, width, height] of cases) {
    it(`reads ${width}x${height} from a ${format} header`, () => {
      expect(readImageSize(imageFile(format, width, height))).toEqual({ format: format.startsWith('webp') ? 'webp' : format, width, height });
    });
  }

  it('returns null for unknown or truncated files', () => {
    expect(readImageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageSize(imageFile('png', 10, 10).subarray(0, 20))).toBeNull();
    expect(readImageSize(imageFile('jpeg', 10, 10).subarray(0, 30))).toBeNull();
  });
});

describe('robotsAllows', () => {
  it('prefers our own group over *, and the longest rule, Allow on a tie', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: LinkToCardBot\nDisallow: /private\nAllow: /private/ok\n';
    expect(robotsAllows(text, '/blog').allowed).toBe(true);
    expect(robotsAllows(text, '/private/x')).toMatchObject({ allowed: false, agent: 'linktocardbot' });
    expect(robotsAllows(text, '/private/ok/1').allowed).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a\n', '/a').allowed).toBe(true);
  });

  it('falls back to *, supports * and $, and treats an empty Disallow as allow-all', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /search\n', '/search?q=1')).toMatchObject({ allowed: false, agent: '*' });
    expect(robotsAllows('User-agent: *\nDisallow: /*.pdf$\n', '/files/a.pdf').allowed).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.pdf$\n', '/files/a.pdf?x').allowed).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/anything').allowed).toBe(true);
    expect(robotsAllows('User-agent: Googlebot\nDisallow: /\n', '/x')).toMatchObject({ allowed: true, agent: null });
    // Several user-agent lines share one group.
    expect(robotsAllows('User-agent: a\nUser-agent: linktocardbot/1.0\nDisallow: /x\n', '/x/y').allowed).toBe(false);
  });
});

describe('buildChecks covers every check id', () => {
  const probe = (overrides: Partial<ImageProbe> = {}): ImageProbe => ({
    url: 'https://cdn.ogfixtures.com/card.png',
    status: 200,
    content_type: 'image/png',
    bytes: 120_000,
    width: 1200,
    height: 630,
    aspect_ratio: 1.905,
    response_ms: 80,
    ...overrides,
  });
  const outcome = (overrides: Partial<ImageProbe> = {}, extra: Partial<ImageOutcome> = {}): ImageOutcome => ({
    probe: probe(overrides),
    error: null,
    overReadCap: false,
    format: 'png',
    ...extra,
  });
  const base = (): ChecklistInput => ({
    og: {
      title: 'A good title',
      description: 'A good description.',
      image: 'https://cdn.ogfixtures.com/card.png',
      image_alt: null,
      image_width: null,
      image_height: null,
      url: null,
      type: null,
      site_name: null,
    },
    twitter: { card: 'summary_large_image', title: null, description: null, image: null, site: null },
    imageSource: 'og',
    imageRaw: 'https://cdn.ogfixtures.com/card.png',
    imageUrl: new URL('https://cdn.ogfixtures.com/card.png'),
    image: outcome(),
    robots: { checked: true, allowed: true, note: null },
    responseMs: 400,
  });
  const statusOf = (checks: CheckItem[], id: string): string | undefined => checks.find((check) => check.id === id)?.status;

  it('a good page passes everything, in CHECK_IDS order, with no fix text', () => {
    const checks = buildChecks(base());
    expect(checks.map((check) => check.id)).toEqual([...CHECK_IDS]);
    expect(checks.every((check) => check.status === 'pass' && check.fix === null)).toBe(true);
  });

  it('og_image: fail when missing; dependent image checks warn as not checked', () => {
    const checks = buildChecks({ ...base(), og: { ...base().og, image: null }, imageSource: null, imageRaw: null, imageUrl: null, image: null });
    expect(statusOf(checks, 'og_image')).toBe('fail');
    for (const id of ['og_image_absolute', 'og_image_https', 'og_image_reachable', 'og_image_size', 'og_image_dimensions', 'og_image_ratio']) {
      expect(statusOf(checks, id), id).toBe('warn');
    }
    expect(checks.find((check) => check.id === 'og_image')?.fix).toContain('og:image');
  });

  it('og_image_absolute: fail when relative, warn when scheme-relative', () => {
    expect(statusOf(buildChecks({ ...base(), imageRaw: '/card.png' }), 'og_image_absolute')).toBe('fail');
    expect(statusOf(buildChecks({ ...base(), imageRaw: '//cdn.ogfixtures.com/card.png' }), 'og_image_absolute')).toBe('warn');
  });

  it('og_image_https: fail over http', () => {
    expect(statusOf(buildChecks({ ...base(), imageUrl: new URL('http://cdn.ogfixtures.com/card.png') }), 'og_image_https')).toBe('fail');
  });

  it('og_image_reachable: fail on an HTTP error or a non-image', () => {
    expect(statusOf(buildChecks({ ...base(), image: outcome({ status: 404 }, { error: 'The image URL answered HTTP 404.' }) }), 'og_image_reachable')).toBe('fail');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ content_type: 'text/html' }, { error: 'It is served as text/html, not as an image.' }) }), 'og_image_reachable')).toBe(
      'fail',
    );
  });

  it('og_image_size: warn over 5 MB and when over the read cap', () => {
    expect(statusOf(buildChecks({ ...base(), image: outcome({ bytes: 6 * MB }) }), 'og_image_size')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ bytes: 5 * MB }) }), 'og_image_size')).toBe('pass');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ bytes: null }, { overReadCap: true }) }), 'og_image_size')).toBe('warn');
  });

  it('og_image_dimensions: fail under 200 px on either side', () => {
    expect(statusOf(buildChecks({ ...base(), image: outcome({ width: 1200, height: 199 }) }), 'og_image_dimensions')).toBe('fail');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ width: 200, height: 200 }) }), 'og_image_dimensions')).toBe('pass');
  });

  it('og_image_ratio: pass within 3 % of 1.91:1, warn outside', () => {
    expect(statusOf(buildChecks({ ...base(), image: outcome({ width: 1200, height: 640 }) }), 'og_image_ratio')).toBe('pass');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ width: 1200, height: 675 }) }), 'og_image_ratio')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), image: outcome({ width: 1000, height: 1000 }) }), 'og_image_ratio')).toBe('warn');
  });

  it('twitter_card: warn when missing or unknown', () => {
    expect(statusOf(buildChecks({ ...base(), twitter: { ...base().twitter, card: null } }), 'twitter_card')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), twitter: { ...base().twitter, card: 'huge' } }), 'twitter_card')).toBe('warn');
  });

  it('og_title: fail when missing, warn over 70 characters (code points)', () => {
    expect(statusOf(buildChecks({ ...base(), og: { ...base().og, title: null } }), 'og_title')).toBe('fail');
    expect(statusOf(buildChecks({ ...base(), og: { ...base().og, title: 'x'.repeat(71) } }), 'og_title')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), og: { ...base().og, title: '😀'.repeat(70) } }), 'og_title')).toBe('pass');
  });

  it('og_description: warn when missing or over 200 characters', () => {
    expect(statusOf(buildChecks({ ...base(), og: { ...base().og, description: null } }), 'og_description')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), og: { ...base().og, description: 'x'.repeat(201) } }), 'og_description')).toBe('warn');
  });

  it('robots: warn when disallowed, pass when unreadable', () => {
    expect(statusOf(buildChecks({ ...base(), robots: { checked: true, allowed: false, note: 'robots.txt disallows / for all crawlers.' } }), 'robots')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), robots: { checked: false, allowed: null, note: 'robots.txt could not be read.' } }), 'robots')).toBe('pass');
  });

  it('response_time: warn over 3 s', () => {
    expect(statusOf(buildChecks({ ...base(), responseMs: INSPECT.slowResponseMs + 1 }), 'response_time')).toBe('warn');
    expect(statusOf(buildChecks({ ...base(), responseMs: INSPECT.slowResponseMs }), 'response_time')).toBe('pass');
  });

  it('every warn and fail carries a fix', () => {
    const bad = buildChecks({
      ...base(),
      og: { ...base().og, title: null, description: null },
      twitter: { ...base().twitter, card: null },
      imageRaw: 'card.png',
      imageUrl: new URL('http://cdn.ogfixtures.com/card.png'),
      image: outcome({ width: 100, height: 100, bytes: 6 * MB }),
      robots: { checked: true, allowed: false, note: null },
      responseMs: 4000,
    });
    expect(bad.filter((check) => check.status !== 'pass').length).toBeGreaterThanOrEqual(10);
    for (const check of bad) if (check.status !== 'pass') expect(check.fix, check.id).toBeTruthy();
  });
});

/** A fetch that never answers until its signal aborts. */
function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
}

const publicResolver = async (): Promise<string[]> => ['93.184.216.34'];

describe('time budgets are injectable', () => {
  it('a page that does not answer in time is page_fetch_failed / timeout', async () => {
    const started = Date.now();
    const error = await runInspection(new URL('https://slow.ogfixtures.com/'), {
      fetchImpl: hangingFetch(),
      resolveHost: publicResolver,
      now: () => Date.now(),
      pageTimeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('page_fetch_failed');
    expect((error as ApiError).details).toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(INSPECT.pageTimeoutMs);
  });

  it('a stalled resolver also counts against the budget', async () => {
    const error = await runInspection(new URL('https://dns-stall.ogfixtures.com/'), {
      fetchImpl: hangingFetch(),
      resolveHost: () => new Promise<string[]>(() => undefined),
      now: () => Date.now(),
      pageTimeoutMs: 50,
    }).catch((caught: unknown) => caught);
    expect((error as ApiError).details).toMatchObject({ reason: 'timeout' });
  });

  it('an image that does not answer in time is reported, not thrown', async () => {
    const outcome = await probeImage('https://cdn.ogfixtures.com/slow.png', { fetchImpl: hangingFetch(), resolveHost: publicResolver, now: () => Date.now(), timeoutMs: 50 });
    expect(outcome.error).toContain('did not finish loading');
    expect(outcome.probe.status).toBeNull();
  });
});

describe('readBody', () => {
  it('stops pulling at the cap and keeps exactly maxBytes', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 3 * MB) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk.slice());
      },
    });
    const read = await readBody(new Response(stream), { maxBytes: 2 * MB });
    expect(read.kept.byteLength).toBe(2 * MB);
    expect(read.overCap).toBe(true);
    expect(pulled).toBeLessThanOrEqual(2 * MB + 3 * chunk.byteLength);
  });
});

describe('own API paths', () => {
  it('refuses Link To Card Worker paths on our own hosts at every hop, and still allows our pages and other sites', async () => {
    const { vetUrl, FetchFailure } = await import('../src/inspect/fetch');
    for (const url of [
      'https://linktocard.com/api/tools/og-check?url=https://example.com',
      'https://www.linktocard.com/v1/og/s_x/blog.png',
      'https://LINKTOCARD.com./i/u_x/abc.png',
      'https://linktocard-staging.names-on-base.workers.dev/api/config',
      'https://linktocard.com/healthz',
      'https://linktocard.com/api',
    ]) {
      expect(() => vetUrl(url, true), url).toThrow(FetchFailure);
      try { vetUrl(url, true); } catch (error) { expect((error as InstanceType<typeof FetchFailure>).reason, url).toBe('blocked'); }
    }
    for (const url of ['https://linktocard.com/', 'https://linktocard.com/pricing', 'https://linktocard.com/apis-guide', 'https://example.com/api/thing', 'https://notlinktocard.com/api/x']) {
      expect(vetUrl(url, true).href, url).toBe(new URL(url).href);
    }
  });
});

describe('checking our own site', () => {
  it('reads our own pages from the static files, answers www with the redirect, and sends other hosts to the network', async () => {
    const { defaultFetchDeps } = await import('../src/inspect/fetch');
    const served: string[] = [];
    const ASSETS = { fetch: async (request: Request) => { served.push(request.url); return new Response('<html><head><title>Ours</title></head></html>', { headers: { 'content-type': 'text/html' } }); } };
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('elsewhere'));
    const deps = defaultFetchDeps({ ASSETS, APP_URL: 'https://linktocard.com' });

    expect(await (await deps.fetchImpl('https://linktocard.com/pricing', { method: 'GET' })).text()).toContain('Ours');
    expect(served).toEqual(['https://linktocard.com/pricing']);
    const www = await deps.fetchImpl('https://www.linktocard.com/docs?x=1', { method: 'GET' });
    expect(www.status).toBe(301);
    expect(www.headers.get('location')).toBe('https://linktocard.com/docs?x=1');
    expect(network).not.toHaveBeenCalled();
    expect(await (await deps.fetchImpl('https://example.com/', { method: 'GET' })).text()).toBe('elsewhere');
    expect(network).toHaveBeenCalledTimes(1);
  });
});

