/**
 * Emoji graphics: Twemoji SVGs shipped as static assets under /_emoji/ (copied from
 * @twemoji/svg by the site build), so a render never calls a third party for them.
 */
import { base64Encode } from '../lib/crypto';

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f;
/** The longest emoji sequences are about ten code points; anything longer is not an emoji. */
const MAX_CODE_POINTS = 16;
const CACHE_ENTRIES = 256;
const ASSET_ORIGIN = 'https://assets.local';

type EmojiLookup = Promise<string | undefined>;
type FetchOutcome = { dataUri: string } | 'missing' | 'failed';

// Keyed by the assets binding, so loaders created per request share one cache per isolate.
/** The part of the Workers static-assets binding (env.ASSETS) this module uses. */
export interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

const caches = new WeakMap<AssetFetcher, Map<string, EmojiLookup>>();

function codePoints(text: string): number[] {
  return Array.from(text, (char) => char.codePointAt(0)!);
}

/**
 * Twemoji file name (without ".svg") for an emoji: lower-case hex code points joined by
 * "-". The U+FE0F variation selector is dropped unless the sequence contains a zero-width
 * joiner, which is how Twemoji names its files (2764.svg, but 1f3f3-fe0f-200d-1f308.svg).
 */
export function emojiFileName(grapheme: string): string {
  const points = codePoints(grapheme);
  const kept = points.includes(ZERO_WIDTH_JOINER) ? points : points.filter((point) => point !== VARIATION_SELECTOR_16);
  return kept.map((point) => point.toString(16)).join('-');
}

/** A few ZWJ files omit the variation selectors (1f441-200d-1f5e8.svg), so that spelling is tried second. */
function candidateNames(grapheme: string): string[] {
  const name = emojiFileName(grapheme);
  const bare = name
    .split('-')
    .filter((part) => part !== 'fe0f')
    .join('-');
  return bare === name ? [name] : [name, bare];
}

async function fetchSvg(assets: AssetFetcher, name: string): Promise<FetchOutcome> {
  try {
    const response = await assets.fetch(new Request(`${ASSET_ORIGIN}/_emoji/${name}.svg`));
    // A missing asset can come back as an HTML 404 (or fallback) page; only real SVG is embedded.
    const isSvg = (response.headers.get('content-type') ?? '').toLowerCase().startsWith('image/svg+xml');
    if (response.ok && isSvg) return { dataUri: `data:image/svg+xml;base64,${base64Encode(await response.arrayBuffer())}` };
    await response.body?.cancel();
    return response.status >= 500 ? 'failed' : 'missing';
  } catch {
    return 'failed';
  }
}

async function lookUp(assets: AssetFetcher, grapheme: string): Promise<FetchOutcome> {
  for (const name of candidateNames(grapheme)) {
    const outcome = await fetchSvg(assets, name);
    if (outcome !== 'missing') return outcome;
  }
  return 'missing';
}

/**
 * Loader for RenderDeps.loadEmoji: resolves an emoji to a data:image/svg+xml;base64 URI,
 * or undefined when there is no graphic for it (the renderer then drops the emoji).
 * Results, including "no such emoji", are kept in a small LRU; transient failures are not.
 */
export function createEmojiLoader(assets: AssetFetcher): (grapheme: string) => Promise<string | undefined> {
  let cache = caches.get(assets);
  if (!cache) {
    cache = new Map();
    caches.set(assets, cache);
  }
  const entries = cache;

  return (grapheme) => {
    const count = codePoints(grapheme).length;
    if (count < 1 || count > MAX_CODE_POINTS) return Promise.resolve(undefined);

    const key = emojiFileName(grapheme);
    const cached = entries.get(key);
    if (cached) {
      // Re-insert so that Map order is recency order.
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const pending: EmojiLookup = lookUp(assets, grapheme).then((outcome) => {
      if (outcome === 'failed' && entries.get(key) === pending) entries.delete(key);
      return typeof outcome === 'object' ? outcome.dataUri : undefined;
    });
    entries.set(key, pending);
    if (entries.size > CACHE_ENTRIES) entries.delete(entries.keys().next().value as string);
    return pending;
  };
}
