import { describe, expect, it } from 'vitest';
import { createEmojiLoader, emojiFileName } from '../src/render/emoji';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="18"/></svg>';

type Responder = (name: string) => Response | Promise<Response>;

/** Fake ASSETS binding: records the requested /_emoji/ file names and answers from `respond`. */
function fakeAssets(respond: Responder): { assets: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const assets = {
    fetch: async (input: Request): Promise<Response> => {
      const { origin, pathname } = new URL(input.url);
      const match = /^\/_emoji\/([0-9a-f-]+)\.svg$/.exec(pathname);
      if (origin !== 'https://assets.local' || !match) throw new Error(`unexpected asset request ${input.url}`);
      requested.push(match[1]!);
      return respond(match[1]!);
    },
  } as unknown as Fetcher;
  return { assets, requested };
}

const svgResponse = (): Response => new Response(SVG, { headers: { 'content-type': 'image/svg+xml' } });
const notFound = (): Response => new Response('<h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } });

function decodeDataUri(uri: string): string {
  const prefix = 'data:image/svg+xml;base64,';
  expect(uri.startsWith(prefix)).toBe(true);
  return atob(uri.slice(prefix.length));
}

describe('emojiFileName', () => {
  it.each([
    ['simple emoji', '\u{1F680}', '1f680'],
    ['variation selector dropped', '❤️', '2764'],
    ['keycap', '#️⃣', '23-20e3'],
    ['ZWJ sequence', '\u{1F468}‍\u{1F4BB}', '1f468-200d-1f4bb'],
    ['ZWJ sequence keeps its variation selector', '\u{1F3F3}️‍\u{1F308}', '1f3f3-fe0f-200d-1f308'],
    ['flag', '\u{1F1F1}\u{1F1E7}', '1f1f1-1f1e7'],
    ['skin-tone modifier', '\u{1F44D}\u{1F3FD}', '1f44d-1f3fd'],
  ])('%s', (_label, grapheme, expected) => {
    expect(emojiFileName(grapheme)).toBe(expected);
  });
});

describe('createEmojiLoader', () => {
  it('returns the asset as a base64 SVG data URI', async () => {
    const { assets, requested } = fakeAssets(svgResponse);
    const uri = await createEmojiLoader(assets)('\u{1F680}');
    expect(decodeDataUri(uri!)).toBe(SVG);
    expect(requested).toEqual(['1f680']);
  });

  it('accepts a content-type with parameters', async () => {
    const { assets } = fakeAssets(() => new Response(SVG, { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } }));
    expect(decodeDataUri((await createEmojiLoader(assets)('\u{1F600}'))!)).toBe(SVG);
  });

  it('returns undefined for a missing asset and remembers the miss', async () => {
    const { assets, requested } = fakeAssets(notFound);
    const load = createEmojiLoader(assets);
    expect(await load('\u{1F9FF}')).toBeUndefined();
    expect(await load('\u{1F9FF}')).toBeUndefined();
    expect(requested).toEqual(['1f9ff']);
  });

  it('never embeds a non-SVG response, even with status 200', async () => {
    const { assets } = fakeAssets(() => new Response('<!doctype html><title>404</title>', { headers: { 'content-type': 'text/html' } }));
    expect(await createEmojiLoader(assets)('\u{1F680}')).toBeUndefined();
  });

  it('serves repeats from the cache, also across loaders for the same binding', async () => {
    const { assets, requested } = fakeAssets(svgResponse);
    const first = createEmojiLoader(assets);
    const [a, b] = await Promise.all([first('\u{1F680}'), first('\u{1F680}')]);
    const c = await createEmojiLoader(assets)('\u{1F680}');
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(requested).toEqual(['1f680']);
  });

  it('does not share a cache between different bindings', async () => {
    const one = fakeAssets(svgResponse);
    const two = fakeAssets(notFound);
    expect(await createEmojiLoader(one.assets)('\u{1F680}')).toBeDefined();
    expect(await createEmojiLoader(two.assets)('\u{1F680}')).toBeUndefined();
  });

  it('retries after a transient failure instead of caching it', async () => {
    let calls = 0;
    const { assets } = fakeAssets(() => {
      calls += 1;
      if (calls === 1) throw new Error('assets unavailable');
      if (calls === 2) return new Response('upstream error', { status: 503 });
      return svgResponse();
    });
    const load = createEmojiLoader(assets);
    expect(await load('\u{1F680}')).toBeUndefined();
    expect(await load('\u{1F680}')).toBeUndefined();
    expect(decodeDataUri((await load('\u{1F680}'))!)).toBe(SVG);
    expect(calls).toBe(3);
  });

  it('falls back to the name without variation selectors for ZWJ sequences', async () => {
    const { assets, requested } = fakeAssets((name) => (name === '1f441-200d-1f5e8' ? svgResponse() : notFound()));
    const uri = await createEmojiLoader(assets)('\u{1F441}️‍\u{1F5E8}️');
    expect(decodeDataUri(uri!)).toBe(SVG);
    expect(requested).toEqual(['1f441-fe0f-200d-1f5e8-fe0f', '1f441-200d-1f5e8']);
  });

  it('ignores input that cannot be an emoji without asking for an asset', async () => {
    const { assets, requested } = fakeAssets(svgResponse);
    const load = createEmojiLoader(assets);
    expect(await load('')).toBeUndefined();
    expect(await load('a'.repeat(17))).toBeUndefined();
    expect(requested).toEqual([]);
  });

  it('evicts the least recently used entry when the cache is full', async () => {
    const { assets, requested } = fakeAssets(svgResponse);
    const load = createEmojiLoader(assets);
    const emoji = (i: number): string => String.fromCodePoint(0x1f300 + i);
    for (let i = 0; i < 256; i++) await load(emoji(i));
    await load(emoji(0)); // refresh the oldest entry, so emoji(1) is now the oldest
    await load(emoji(256)); // one more than fits
    expect(requested).toHaveLength(257);
    await load(emoji(0));
    expect(requested).toHaveLength(257);
    await load(emoji(1));
    expect(requested).toHaveLength(258);
  });
});
