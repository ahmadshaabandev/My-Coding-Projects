// Signed link-card URLs (src/cards/link-url.ts): GET /v1/link/{siteId}/{template}.{ext}?url=...&sig=
// The scheme is the card URLs' one (src/lib/signed-url.ts), so these tests are about what is
// specific to links: the page address is signed, normalised only after verification, and
// nothing can be added, removed or changed without breaking the signature.
import { describe, expect, it } from 'vitest';
import {
  LINK_RESERVED_PARAMS,
  MAX_LINK_TARGET_CHARS,
  OPEN_PARAM,
  URL_PARAM,
  buildLinkUrl,
  describeLinkUrlFailure,
  linkCanonical,
  linkPathname,
  parseLinkPath,
  verifyLinkUrl,
  type LinkUrlInput,
} from '../src/cards/link-url';
import { LIMITS } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { buildSignedUrl, canonicalString, describeSignedUrlFailure, signCanonical, verifySignedUrl } from '../src/lib/signed-url';

const SECRET = 'ltcs_test_site_secret_for_link_url_tests_only';
const BASE = 'https://linktocard.test';
const PATH = '/v1/link/s_abc123/blog.png';
const PAGE = 'https://example.com/posts/hello-world?ref=home';

function build(overrides: Partial<LinkUrlInput> = {}): Promise<{ url: string; canonical: string }> {
  return buildLinkUrl({ baseUrl: BASE, siteId: 's_abc123', template: 'blog', ext: 'png', url: PAGE, secret: SECRET, ...overrides });
}

/** What a customer's own signer does: sign the decoded values, then send any raw query. */
async function signedByHand(rawQuery: string, decoded: Record<string, string>, path = PATH, secret = SECRET): Promise<URL> {
  const sig = await signCanonical(secret, canonicalString(path, Object.entries(decoded)));
  return new URL(`${BASE}${path}?${rawQuery}${rawQuery ? '&' : ''}sig=${sig}`);
}

async function reasonFor(url: URL | string, secret = SECRET): Promise<string> {
  const result = await verifyLinkUrl(new URL(url), secret);
  return result.ok ? 'ok' : result.reason;
}

/** The URL with one query parameter changed, added or removed, keeping sig. */
function edit(url: string, change: (query: URLSearchParams) => void): URL {
  const parsed = new URL(url);
  change(parsed.searchParams);
  return parsed;
}

describe('round trip', () => {
  it('a built URL verifies, with the page normalised, the size and the data overrides', async () => {
    const { url, canonical } = await build({ data: { tag: 'News', theme: 'dark' }, size: 'square' });
    expect(url.startsWith(`${BASE}${PATH}?url=`)).toBe(true);
    expect(canonical).toBe(['/v1/link/s_abc123/blog.png', 'size,tag,theme,url', 'size=square', 'tag=News', 'theme=dark', `url=${PAGE}`].join('\n'));
    const result = await verifyLinkUrl(new URL(url), SECRET);
    expect(result).toEqual({ ok: true, target: new URL(PAGE), size: 'square', overrides: { tag: 'News', theme: 'dark' } });
  });

  it('signs the normalised page: host case, default port and fragment do not make another URL', async () => {
    const a = await build({ url: 'https://EXAMPLE.com:443/posts/hello-world?ref=home#top' });
    const b = await build();
    expect(a.url).toBe(b.url);
    expect(new URL(a.url).searchParams.get(URL_PARAM)).toBe(PAGE);
  });

  it('leaves the default size out and works for every extension', async () => {
    expect(new URL((await build({ size: 'og' })).url).searchParams.has('size')).toBe(false);
    for (const ext of ['png', 'jpg', 'jpeg', 'webp'] as const) {
      const { url } = await build({ ext });
      expect(await reasonFor(url), ext).toBe('ok');
    }
  });

  it('verifies however the query is ordered or encoded (decoded values are signed)', async () => {
    const decoded = { url: 'https://example.com/a?b=c&d=\u00e9', title: 'Zo\u00eb & co' };
    const raw = `title=Zo%C3%AB+%26+co&url=${encodeURIComponent(decoded.url)}`;
    const url = await signedByHand(raw, decoded);
    expect(await reasonFor(url)).toBe('ok');
    const reordered = new URL(`${BASE}${PATH}?sig=${url.searchParams.get('sig')}&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc%26d%3D%C3%A9&title=Zo%C3%AB%20%26%20co`);
    expect(await reasonFor(reordered)).toBe('ok');
  });

  it('accepts a customer signer that signed a page it did not normalise, and normalises it afterwards', async () => {
    const url = await signedByHand(`url=${encodeURIComponent('https://Example.COM/x#frag')}`, { url: 'https://Example.COM/x#frag' });
    const result = await verifyLinkUrl(url, SECRET);
    expect(result.ok && result.target.href).toBe('https://example.com/x');
  });

  it('linkCanonical names one link whatever the query order', async () => {
    const { url, canonical } = await build({ data: { tag: 'A', author: 'B' } });
    const reversed = new URL(url);
    reversed.search = `?${[...reversed.searchParams].reverse().map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
    expect(linkCanonical(new URL(url))).toBe(canonical);
    expect(linkCanonical(reversed)).toBe(canonical);
  });
});

describe('tampering', () => {
  it('a changed page address breaks the signature, even a change of case or a trailing slash', async () => {
    const { url } = await build();
    for (const page of ['https://evil.example/', 'https://example.com/posts/hello-world?ref=home2', 'https://Example.com/posts/hello-world?ref=home', `${PAGE}/`]) {
      expect(await reasonFor(edit(url, (q) => q.set('url', page))), page).toBe('signature_mismatch');
    }
  });

  it('an extra parameter, a removed one or a changed value breaks the signature', async () => {
    const { url } = await build({ data: { tag: 'News' } });
    expect(await reasonFor(edit(url, (q) => q.append('title', 'Injected')))).toBe('signature_mismatch');
    expect(await reasonFor(edit(url, (q) => q.append('size', 'square')))).toBe('signature_mismatch');
    expect(await reasonFor(edit(url, (q) => q.delete('tag')))).toBe('signature_mismatch');
    expect(await reasonFor(edit(url, (q) => q.set('tag', 'Old')))).toBe('signature_mismatch');
    // Removing the page itself is just another unsigned change.
    expect(await reasonFor(edit(url, (q) => q.delete('url')))).toBe('signature_mismatch');
  });

  it('a duplicated page parameter, a missing or malformed sig are refused like on card URLs', async () => {
    const { url } = await build();
    expect(await reasonFor(edit(url, (q) => q.append('url', 'https://evil.example/')))).toBe('duplicate_param');
    expect(await reasonFor(edit(url, (q) => q.delete('sig')))).toBe('missing_sig');
    expect(await reasonFor(edit(url, (q) => q.set('sig', 'abc')))).toBe('malformed_sig');
    expect(await reasonFor(edit(url, (q) => q.append('Bad-Name', 'x')))).toBe('bad_param_name');
  });

  it('another site, template or extension in the path breaks the signature', async () => {
    const { url } = await build();
    for (const path of ['/v1/link/s_other/blog.png', '/v1/link/s_abc123/dark.png', '/v1/link/s_abc123/blog.webp']) {
      const moved = new URL(url);
      moved.pathname = path;
      expect(await reasonFor(moved), path).toBe('signature_mismatch');
    }
  });

  it('a /v1/og URL cannot be replayed as a link URL, nor the other way round', async () => {
    const og = await buildSignedUrl({ baseUrl: BASE, siteId: 's_abc123', template: 'blog', ext: 'png', params: { url: PAGE }, secret: SECRET });
    const asLink = new URL(og);
    asLink.pathname = PATH;
    expect(await reasonFor(asLink)).toBe('signature_mismatch');

    const { url } = await build();
    const asOg = new URL(url);
    asOg.pathname = '/v1/og/s_abc123/blog.png';
    expect((await verifySignedUrl(asOg, SECRET)).ok).toBe(false);
  });

  it('another secret (a rotated site secret) does not verify', async () => {
    const { url } = await build();
    expect(await reasonFor(url, `${SECRET}-rotated`)).toBe('signature_mismatch');
  });
});

describe('what a correctly signed URL may still not do', () => {
  it('a signed URL without a page is refused', async () => {
    expect(await reasonFor(await signedByHand('title=Hello', { title: 'Hello' }))).toBe('missing_url');
    expect(await reasonFor(await signedByHand('url=+', { url: ' ' }))).toBe('missing_url');
  });

  it('open fields are refused on link URLs, even signed', async () => {
    const url = await signedByHand(`url=${encodeURIComponent(PAGE)}&open=title`, { url: PAGE, open: 'title' });
    expect(await reasonFor(url)).toBe('open_not_supported');
  });

  it('a signed page that is not a public https URL throws the checker errors after verification', async () => {
    const plain = await signedByHand(`url=${encodeURIComponent('http://example.com/')}`, { url: 'http://example.com/' });
    await expect(verifyLinkUrl(plain, SECRET)).rejects.toMatchObject({ code: 'invalid_request' });
    const local = await signedByHand(`url=${encodeURIComponent('https://127.0.0.1/admin')}`, { url: 'https://127.0.0.1/admin' });
    await expect(verifyLinkUrl(local, SECRET)).rejects.toMatchObject({ code: 'forbidden' });
    // Unsigned, the same URL is only a signature problem: nothing is parsed before the signature holds.
    const unsigned = edit(local.href, (q) => q.set('sig', '0'.repeat(64)));
    expect(await reasonFor(unsigned)).toBe('signature_mismatch');
  });

  it('a page address longer than one signed value is refused by both sides', async () => {
    const long = `https://example.com/${'a'.repeat(MAX_LINK_TARGET_CHARS)}`;
    expect(MAX_LINK_TARGET_CHARS).toBe(LIMITS.maxDataValueChars);
    await expect(build({ url: long })).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'bad_value' } });
    const url = await signedByHand(`url=${encodeURIComponent(long)}`, { url: long });
    expect(await reasonFor(url)).toBe('bad_value');
  });
});

describe('buildLinkUrl input checks', () => {
  it('refuses reserved names as data', async () => {
    expect(LINK_RESERVED_PARAMS).toEqual(['url', 'size', 'sig', OPEN_PARAM]);
    for (const name of LINK_RESERVED_PARAMS) {
      await expect(build({ data: { [name]: 'x' } }), name).rejects.toMatchObject({ code: 'invalid_request', details: { reason: 'reserved_param' } });
    }
  });

  it('refuses a path it would not serve and a page the checker would not read', async () => {
    await expect(build({ siteId: 's/../x' })).rejects.toMatchObject({ details: { reason: 'bad_path' } });
    await expect(build({ template: 'blog.png' })).rejects.toMatchObject({ details: { reason: 'bad_path' } });
    await expect(build({ url: 'http://example.com/' })).rejects.toBeInstanceOf(ApiError);
    await expect(build({ url: 'https://localhost/' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(build({ url: '' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('refuses a size preset that does not exist', async () => {
    await expect(build({ size: 'huge' })).rejects.toMatchObject({ code: 'unsupported_size' });
    expect(await reasonFor((await build({ size: 'portrait' })).url)).toBe('ok');
  });

  it('refuses data the verifier would refuse', async () => {
    await expect(build({ data: { title: 'a\nb' } })).rejects.toMatchObject({ details: { reason: 'bad_value' } });
    await expect(build({ data: { Title: 'x' } })).rejects.toMatchObject({ details: { reason: 'bad_param_name' } });
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys }, (_, i) => [`k${i}`, 'v']));
    await expect(build({ data: many })).rejects.toMatchObject({ details: { reason: 'too_many_params' } });
  });
});

describe('paths and messages', () => {
  it('parses link paths and nothing else', () => {
    expect(parseLinkPath(linkPathname('s_1', 'my-template', 'webp'))).toEqual({ siteId: 's_1', template: 'my-template', ext: 'webp' });
    for (const path of ['/v1/og/s_1/blog.png', '/v1/link/s_1/blog.gif', '/v1/link/s_1/blog', '/v1/link/s 1/blog.png', '/v1/link/s_1/a/blog.png']) {
      expect(parseLinkPath(path), path).toBeNull();
    }
  });

  it('explains every failure', () => {
    expect(describeLinkUrlFailure('missing_url')).toContain('"url"');
    expect(describeLinkUrlFailure('open_not_supported')).toContain('"open"');
    expect(describeLinkUrlFailure('signature_mismatch')).toBe(describeSignedUrlFailure('signature_mismatch'));
  });
});
