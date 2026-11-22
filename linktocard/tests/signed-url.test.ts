import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import vector from '../examples/signing/vector.json';
import { LIMITS, SITE_SECRET_PREFIX } from '../src/config';
import {
  SIG_PARAM,
  SIZE_PARAM,
  buildSignedUrl,
  canonicalString,
  deriveSiteSecret,
  describeSignedUrlFailure,
  parseOgPath,
  signCanonical,
  verifySignedUrl,
  type OgExtension,
  type SignedUrlFailure,
  type SignedUrlInput,
} from '../src/lib/signed-url';

const SECRET = 'ltcs_test_site_secret_for_signed_url_tests_only';
const BASE = 'https://linktocard.test';
const PATH = '/v1/og/s_abc123/blog.png';
const PARAMS: Record<string, string> = { title: 'Hello world & more', author: 'Zoë', v: '1' };

const ALL_REASONS: SignedUrlFailure[] = [
  'missing_sig',
  'malformed_sig',
  'bad_param_name',
  'duplicate_param',
  'bad_value',
  'too_many_params',
  'url_too_long',
  'signature_mismatch',
];

function build(overrides: Partial<SignedUrlInput> = {}): Promise<string> {
  return buildSignedUrl({ baseUrl: BASE, siteId: 's_abc123', template: 'blog', ext: 'png', params: PARAMS, secret: SECRET, ...overrides });
}

/**
 * What a customer's own signer does: sign the decoded values, then put any
 * raw query it likes on the URL. Bypasses buildSignedUrl's own checks on purpose.
 */
async function signedByHand(rawQuery: string, decoded: Record<string, string>, path = PATH, secret = SECRET): Promise<URL> {
  const sig = await signCanonical(secret, canonicalString(path, Object.entries(decoded)));
  return new URL(`${BASE}${path}?${rawQuery}${rawQuery ? '&' : ''}sig=${sig}`);
}

async function reasonFor(url: URL | string, secret = SECRET): Promise<string> {
  const result = await verifySignedUrl(new URL(url), secret);
  return result.ok ? 'ok' : result.reason;
}

/** Percent-encodes every UTF-8 byte, including letters and digits. */
function encodeEveryByte(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

function repeat(char: string, count: number): string {
  return char.repeat(count);
}

describe('canonicalString', () => {
  it('is the path, the sorted names, then name=value lines in that order, joined with a single newline', () => {
    const canonical = canonicalString(PATH, [
      ['title', 'Hello world & more'],
      ['v', '1'],
      ['author', 'Zoë'],
    ]);
    expect(canonical).toBe('/v1/og/s_abc123/blog.png\nauthor,title,v\nauthor=Zoë\ntitle=Hello world & more\nv=1');
  });

  it('is the path and an empty names line when there are no parameters', () => {
    expect(canonicalString(PATH, [])).toBe(`${PATH}\n`);
  });

  it('leaves sig out of the signed message', () => {
    expect(canonicalString(PATH, new URLSearchParams('b=2&sig=deadbeef&a=1'))).toBe(`${PATH}\na,b\na=1\nb=2`);
  });

  it('sorts names in ascending byte order (digits < "_" < letters)', () => {
    const names = ['b', 'ab', 'a_b', 'a1', 'a'];
    const canonical = canonicalString(PATH, names.map((name): [string, string] => [name, 'x']));
    expect(canonical.split('\n').slice(1)).toEqual(['a,a1,a_b,ab,b', 'a=x', 'a1=x', 'a_b=x', 'ab=x', 'b=x']);
  });

  it('does not depend on the order the parameters arrive in', () => {
    const entries = Object.entries(PARAMS);
    expect(canonicalString(PATH, [...entries].reverse())).toBe(canonicalString(PATH, entries));
  });
});

describe('signCanonical', () => {
  it('is lowercase hex HMAC-SHA256 (RFC 4231 test case 2)', async () => {
    expect(await signCanonical('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('signs the UTF-8 bytes of both the secret and the message', async () => {
    // Independent reference: python3 hmac.new('ключ'.encode(), 'Zoë 🚀'.encode(), hashlib.sha256).hexdigest()
    expect(await signCanonical('ключ', 'Zoë 🚀')).toBe('715e531cf1a3d7c53dc8d37cfe7d8d2c32f5c60083e4117f399cab89249a1e79');
  });
});

describe('deriveSiteSecret', () => {
  // Expected values computed independently with Python's hmac + base64 modules.
  it('is SITE_SECRET_PREFIX + base64url(HMAC-SHA256(master, "site:<id>:<version>"))', async () => {
    expect(await deriveSiteSecret('test-master-secret-not-a-real-secret', 's_abc123', 1)).toBe(
      'ltcs_GM_xvGEAy8d5Qfb_u9gMvL8OjYtpAlqJByMDgJwZly0',
    );
    expect(await deriveSiteSecret('test-master-secret-not-a-real-secret', 's_abc123', 2)).toBe(
      'ltcs_b_J8bjSmtY99r5Mr9O_yeZNPJFTdpFGpwzIXoCJ333Y',
    );
  });

  it('is deterministic and URL-safe, and differs per site, version and master secret', async () => {
    const master = env.SIGNING_MASTER_SECRET;
    const secret = await deriveSiteSecret(master, 's_one', 1);
    expect(secret).toBe(await deriveSiteSecret(master, 's_one', 1));
    expect(secret.startsWith(SITE_SECRET_PREFIX)).toBe(true);
    expect(secret.slice(SITE_SECRET_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const others = await Promise.all([
      deriveSiteSecret(master, 's_two', 1),
      deriveSiteSecret(master, 's_one', 2),
      deriveSiteSecret(`${master}x`, 's_one', 1),
    ]);
    expect(new Set([secret, ...others]).size).toBe(4);
  });

  it('refuses to derive from a missing master secret', async () => {
    await expect(deriveSiteSecret('', 's_one', 1)).rejects.toMatchObject({ name: 'ApiError', code: 'not_configured', status: 503 });
  });
});

describe('parseOgPath', () => {
  it.each([
    ['/v1/og/s_abc123/blog.png', { siteId: 's_abc123', template: 'blog', ext: 'png' }],
    ['/v1/og/s_abc123/blog.jpg', { siteId: 's_abc123', template: 'blog', ext: 'jpg' }],
    ['/v1/og/s_abc123/blog.jpeg', { siteId: 's_abc123', template: 'blog', ext: 'jpeg' }],
    ['/v1/og/s_abc123/t_9z8y7x-card.webp', { siteId: 's_abc123', template: 't_9z8y7x-card', ext: 'webp' }],
  ])('parses %s', (pathname, expected) => {
    expect(parseOgPath(pathname)).toEqual(expected);
  });

  it.each([
    '/v1/og/s_abc123/blog',
    '/v1/og/s_abc123/blog.gif',
    '/v1/og/s_abc123/blog.PNG',
    '/v1/og/s_abc123/.png',
    '/v1/og//blog.png',
    '/v1/og/s_abc123/blog.png/',
    '/v1/og/s_abc123/extra/blog.png',
    '/v1/og/s_abc123/blog.v2.png',
    '/v1/og/s_abc123/bl%6Fg.png',
    '/v1/og/s_abc123/blog.png\n',
    '/v2/og/s_abc123/blog.png',
    '/v1/images',
    `/v1/og/${repeat('s', 65)}/blog.png`,
    '',
  ])('rejects %j', (pathname) => {
    expect(parseOgPath(pathname)).toBeNull();
  });
});

describe('buildSignedUrl', () => {
  it('puts the parameters in the caller\'s order and the signature last', async () => {
    const url = new URL(await build({ baseUrl: `${BASE}/` }));
    expect(url.origin + url.pathname).toBe(`${BASE}${PATH}`);
    expect([...url.searchParams.keys()]).toEqual(['title', 'author', 'v', SIG_PARAM]);
    expect(url.searchParams.get(SIG_PARAM)).toBe(await signCanonical(SECRET, canonicalString(PATH, Object.entries(PARAMS))));
  });

  it('uses form encoding (URLSearchParams) for the query', async () => {
    const url = await build({ params: { title: "it's a+b = c ~ *!* (ok)/é" } });
    expect(url).toContain("?title=it%27s+a%2Bb+%3D+c+%7E+*%21*+%28ok%29%2F%C3%A9&sig=");
  });

  it.each<[string, Partial<SignedUrlInput>, string]>([
    ['a parameter called sig', { params: { sig: 'abc' } }, 'reserved_param'],
    ['an upper-case name', { params: { Title: 'x' } }, 'bad_param_name'],
    ['a name with a dash', { params: { 'og-title': 'x' } }, 'bad_param_name'],
    ['a line break in a value', { params: { title: 'a\nb=c' } }, 'bad_value'],
    ['a tab in a value', { params: { title: 'a\tb' } }, 'bad_value'],
    ['a value over the length limit', { params: { title: repeat('a', LIMITS.maxDataValueChars + 1) } }, 'bad_value'],
    [
      'too many parameters',
      { params: Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys + 1 }, (_, i) => [`k${i}`, 'x'])) },
      'too_many_params',
    ],
    [
      'a URL over the length limit',
      { params: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, repeat('a', 900)])) },
      'url_too_long',
    ],
    ['a site id with a slash', { siteId: 's_abc/../x' }, 'bad_path'],
    ['a template with a dot', { template: 'blog.v2' }, 'bad_path'],
    ['an unknown extension', { ext: 'gif' as OgExtension }, 'bad_path'],
  ])('refuses %s', async (_label, overrides, reason) => {
    await expect(build(overrides)).rejects.toMatchObject({ name: 'ApiError', code: 'invalid_request', status: 400, details: { reason } });
  });
});

describe('verifySignedUrl - round trip', () => {
  it('accepts what buildSignedUrl produced and returns the decoded parameters without sig', async () => {
    const result = await verifySignedUrl(new URL(await build()), SECRET);
    expect(result).toEqual({ ok: true, params: PARAMS });
  });

  it.each<OgExtension>(['png', 'jpg', 'jpeg', 'webp'])('round-trips a .%s URL with a size parameter', async (ext) => {
    const params = { ...PARAMS, [SIZE_PARAM]: 'square' };
    const result = await verifySignedUrl(new URL(await build({ ext, params })), SECRET);
    expect(result).toEqual({ ok: true, params });
  });

  it('round-trips a URL with no parameters and one with an empty value', async () => {
    expect(await verifySignedUrl(new URL(await build({ params: {} })), SECRET)).toEqual({ ok: true, params: {} });
    expect(await verifySignedUrl(new URL(await build({ params: { subtitle: '' } })), SECRET)).toEqual({
      ok: true,
      params: { subtitle: '' },
    });
  });

  it('round-trips unicode and emoji values', async () => {
    const params = {
      japanese: '日本語のタイトル',
      arabic: 'مرحبا بالعالم',
      accents: 'Zoë Müller, naïve façade',
      rocket: 'Ship it 🚀',
      family: '👨‍👩‍👧‍👦 and 👩🏽‍🚀',
      math: '𝒜 ≠ ℬ',
    };
    expect(await verifySignedUrl(new URL(await build({ params })), SECRET)).toEqual({ ok: true, params });
  });

  it('ignores the fragment and accepts an upper-case signature', async () => {
    const url = new URL(await build());
    url.searchParams.set(SIG_PARAM, url.searchParams.get(SIG_PARAM)!.toUpperCase());
    url.hash = '#anything';
    expect(await reasonFor(url)).toBe('ok');
  });

  it('accepts the published cross-language vector', async () => {
    const pathname = `/v1/og/${vector.site_id}/${vector.template}.${vector.ext}`;
    expect(canonicalString(pathname, Object.entries(vector.params))).toBe(vector.canonical);
    expect(await signCanonical(vector.secret, vector.canonical)).toBe(vector.signature);
    expect(
      await buildSignedUrl({
        baseUrl: vector.base_url,
        siteId: vector.site_id,
        template: vector.template,
        ext: vector.ext as OgExtension,
        params: vector.params,
        secret: vector.secret,
      }),
    ).toBe(vector.url);
    expect(await verifySignedUrl(new URL(vector.url), vector.secret)).toEqual({ ok: true, params: vector.params });
  });
});

describe('verifySignedUrl - tampering', () => {
  const tamper: Record<string, (url: URL) => void> = {
    'a value changed': (url) => url.searchParams.set('title', 'Hello world & more!'),
    'a value changed only in case': (url) => url.searchParams.set('author', 'zoë'),
    'a trailing space added to a value': (url) => url.searchParams.set('v', '1 '),
    'a name changed': (url) => {
      url.searchParams.delete('author');
      url.searchParams.append('authors', 'Zoë');
    },
    'two values swapped between names': (url) => {
      url.searchParams.set('title', 'Zoë');
      url.searchParams.set('author', 'Hello world & more');
    },
    'a parameter added': (url) => url.searchParams.append('size', 'portrait'),
    'a parameter removed': (url) => url.searchParams.delete('v'),
    'the site id changed': (url) => {
      url.pathname = '/v1/og/s_abc124/blog.png';
    },
    'the template changed': (url) => {
      url.pathname = '/v1/og/s_abc123/blog2.png';
    },
    'the extension changed': (url) => {
      url.pathname = '/v1/og/s_abc123/blog.jpg';
    },
    'the path prefix changed': (url) => {
      url.pathname = '/v2/og/s_abc123/blog.png';
    },
    'one signature digit changed': (url) => {
      const sig = url.searchParams.get(SIG_PARAM)!;
      url.searchParams.set(SIG_PARAM, (sig[0] === '0' ? '1' : '0') + sig.slice(1));
    },
    'the signature of a different URL': (url) => url.searchParams.set(SIG_PARAM, repeat('ab', 32)),
  };

  it.each(Object.keys(tamper))('rejects a URL with %s', async (label) => {
    const url = new URL(await build());
    expect(await reasonFor(url)).toBe('ok');
    tamper[label]!(url);
    expect(await reasonFor(url)).toBe('signature_mismatch');
  });

  it('rejects the wrong secret', async () => {
    expect(await reasonFor(await build(), `${SECRET}x`)).toBe('signature_mismatch');
  });

  it('rejects a URL signed with a previous secret version (rotation)', async () => {
    const master = env.SIGNING_MASTER_SECRET;
    const v1 = await deriveSiteSecret(master, 's_abc123', 1);
    const v2 = await deriveSiteSecret(master, 's_abc123', 2);
    const url = await build({ secret: v1 });
    expect(await reasonFor(url, v1)).toBe('ok');
    expect(await reasonFor(url, v2)).toBe('signature_mismatch');
  });

  it('rejects a URL signed for another site with that site\'s secret', async () => {
    const master = env.SIGNING_MASTER_SECRET;
    const otherSecret = await deriveSiteSecret(master, 's_other', 1);
    const url = await build({ siteId: 's_other', secret: otherSecret });
    expect(await reasonFor(url, otherSecret)).toBe('ok');
    expect(await reasonFor(url, await deriveSiteSecret(master, 's_abc123', 1))).toBe('signature_mismatch');
  });
});

describe('verifySignedUrl - query order and percent-encoding do not matter', () => {
  const decoded: Record<string, string> = {
    title: 'Ship it! 10 tips & tricks (part 1/2)',
    subtitle: "a+b=c ~ it's *that* easy",
    author: 'Zoë Müller 🚀',
  };
  const form = new URLSearchParams(decoded).toString();
  const pairs = (encode: (value: string) => string): string =>
    Object.entries(decoded)
      .map(([name, value]) => `${name}=${encode(value)}`)
      .join('&');

  const encodings: Record<string, string> = {
    'form encoding (JavaScript URLSearchParams)': form,
    'encodeURIComponent (%20, raw !\'()*~)': pairs(encodeURIComponent),
    'PHP urlencode (+, %2A, %7E)': form.replace(/\*/g, '%2A'),
    'Python urlencode (+, %2A, raw ~)': form.replace(/\*/g, '%2A').replace(/%7E/g, '~'),
    'lower-case hex digits': form.replace(/%[0-9A-F]{2}/g, (triplet) => triplet.toLowerCase()),
    'every byte escaped, even letters': pairs(encodeEveryByte),
    'only the query delimiters escaped (raw spaces, quotes, non-ASCII)': pairs((value) =>
      value.replace(/[%&+=#]/g, (char) => encodeURIComponent(char)),
    ),
  };

  it('the encodings under test really are different strings', () => {
    expect(new Set(Object.values(encodings)).size).toBe(Object.keys(encodings).length);
  });

  it.each(Object.keys(encodings))('verifies with %s', async (label) => {
    const url = await signedByHand(encodings[label]!, decoded);
    expect(await verifySignedUrl(url, SECRET)).toEqual({ ok: true, params: decoded });
  });

  it('treats "+" and "%20" as the same space, and "%2B" as a real plus', async () => {
    expect(await reasonFor(await signedByHand('title=a+b', { title: 'a b' }))).toBe('ok');
    expect(await reasonFor(await signedByHand('title=a%20b', { title: 'a b' }))).toBe('ok');
    expect(await reasonFor(await signedByHand('title=a%2Bb', { title: 'a+b' }))).toBe('ok');
    expect(await reasonFor(await signedByHand('title=a%2Bb', { title: 'a b' }))).toBe('signature_mismatch');
  });

  it('verifies when a crawler re-orders the query, even with sig first', async () => {
    const original = new URL(await build());
    const entries = [...original.searchParams];
    const orders = [[...entries].reverse(), [...entries].sort(([a], [b]) => a.localeCompare(b)), [entries[3]!, entries[1]!, entries[0]!, entries[2]!]];
    for (const order of orders) {
      const url = new URL(`${BASE}${PATH}?${new URLSearchParams(order)}`);
      expect(url.search).not.toBe(original.search);
      expect(await verifySignedUrl(url, SECRET)).toEqual({ ok: true, params: PARAMS });
    }
  });
});

describe('verifySignedUrl - control characters and line smuggling', () => {
  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r'],
    ['tab', '\t'],
    ['NUL', '\u0000'],
    ['unit separator', '\u001f'],
    ['DEL', '\u007f'],
  ])('rejects a %s in a value even when the HMAC over it is correct', async (_label, char) => {
    const value = `a${char}b`;
    const url = await signedByHand(`title=${encodeEveryByte(value)}`, { title: value });
    expect(new URL(url).searchParams.get('title')).toBe(value);
    expect(await reasonFor(url)).toBe('bad_value');
  });

  it('never lets {title: "a\\nb=c"} verify as {title: "a", b: "c"}', async () => {
    // 1. We refuse to sign it.
    await expect(build({ params: { title: 'a\nb=c' } })).rejects.toMatchObject({ details: { reason: 'bad_value' } });

    // 2. A signer that signs it anyway gets a signature that verifies for neither form.
    const naive = await signCanonical(SECRET, canonicalString(PATH, [['title', 'a\nb=c']]));
    expect(await reasonFor(`${BASE}${PATH}?title=a%0Ab%3Dc&sig=${naive}`)).toBe('bad_value');
    expect(await reasonFor(`${BASE}${PATH}?title=a&b=c&sig=${naive}`)).toBe('signature_mismatch');
    expect(await reasonFor(`${BASE}${PATH}?b=c&title=a&sig=${naive}`)).toBe('signature_mismatch');
  });

  it('keeps injected text from becoming a parameter even when the customer signs a raw line break', async () => {
    // The dangerous case: the smuggled name ("v") sorts after the carrier ("title"),
    // so without the names line the two messages would be byte-identical. The names
    // line ("title" against "title,v") keeps them apart.
    expect(canonicalString(PATH, [['title', 'a\nv=2']])).not.toBe(
      canonicalString(PATH, [
        ['title', 'a'],
        ['v', '2'],
      ]),
    );
    // A customer's signer that does sign the line break gets a signature that no
    // acceptable URL can use: the honest form is refused, the injected form mismatches.
    const naive = await signCanonical(SECRET, canonicalString(PATH, [['title', 'a\nv=2']]));
    expect(await reasonFor(`${BASE}${PATH}?title=a%0Av%3D2&sig=${naive}`)).toBe('bad_value');
    expect(await reasonFor(`${BASE}${PATH}?title=a&v=2&sig=${naive}`)).toBe('signature_mismatch');
    expect(await reasonFor(`${BASE}${PATH}?v=2&title=a&sig=${naive}`)).toBe('signature_mismatch');
    // And we never sign or accept one ourselves.
    await expect(build({ params: { title: 'a\nv=2' } })).rejects.toMatchObject({ details: { reason: 'bad_value' } });
    expect(await reasonFor(await signedByHand('title=a%0Av%3D2', { title: 'a\nv=2' }))).toBe('bad_value');
  });

  it('gives a value that imitates the names line no way to forge a different parameter set', async () => {
    // Same names, values shifted across a line break: only the form without control
    // characters is acceptable, and it has its own signature.
    const shifted = await signCanonical(SECRET, canonicalString(PATH, [['a', 'x\nb=y'], ['b', 'z']]));
    const honest = await signCanonical(SECRET, canonicalString(PATH, [['a', 'x'], ['b', 'y']]));
    expect(shifted).not.toBe(honest);
    expect(await reasonFor(`${BASE}${PATH}?a=x&b=y&sig=${shifted}`)).toBe('signature_mismatch');
    expect(await reasonFor(`${BASE}${PATH}?a=x&b=y&sig=${honest}`)).toBe('ok');
  });
});

describe('verifySignedUrl - structural rules, each with its own reason', () => {
  it('missing_sig: no sig parameter', async () => {
    expect(await reasonFor(`${BASE}${PATH}?title=Hello`)).toBe('missing_sig');
    expect(await reasonFor(`${BASE}${PATH}`)).toBe('missing_sig');
  });

  it.each([
    ['empty', ''],
    ['63 hex digits', repeat('a', 63)],
    ['65 hex digits', repeat('a', 65)],
    ['64 characters that are not all hex', `${repeat('a', 63)}g`],
    ['a 0x prefix', `0x${repeat('a', 62)}`],
    ['base64 instead of hex', 'iWVetCmT7U65gGpKTpQhmlUH_xOSJZAhohD4Sv64l1Y'],
  ])('malformed_sig: %s', async (_label, sig) => {
    expect(await reasonFor(`${BASE}${PATH}?title=Hello&sig=${sig}`)).toBe('malformed_sig');
  });

  it.each([
    ['upper case', 'Title=x'],
    ['leading digit', '1st=x'],
    ['leading underscore', '_private=x'],
    ['dash', 'og-title=x'],
    ['dot', 'og.title=x'],
    ['brackets', 'tags%5B%5D=x'],
    ['empty name', '=x'],
    ['33 characters', `${repeat('a', 33)}=x`],
    ['line break inside the name', 'a%0Ab=x'],
    ['non-ASCII letter', 'titré=x'],
  ])('bad_param_name: %s', async (_label, rawPair) => {
    const [name, value] = [...new URLSearchParams(rawPair)][0]!;
    expect(await reasonFor(await signedByHand(rawPair, { [name]: value }))).toBe('bad_param_name');
  });

  it('accepts a 32-character name', async () => {
    const name = repeat('a', 32);
    expect(await reasonFor(await signedByHand(`${name}=x`, { [name]: 'x' }))).toBe('ok');
  });

  it('duplicate_param: a repeated name, with different or identical values, and a repeated sig', async () => {
    const sig = await signCanonical(SECRET, canonicalString(PATH, [['title', 'a']]));
    expect(await reasonFor(`${BASE}${PATH}?title=a&title=b&sig=${sig}`)).toBe('duplicate_param');
    expect(await reasonFor(`${BASE}${PATH}?title=a&title=a&sig=${sig}`)).toBe('duplicate_param');
    expect(await reasonFor(`${BASE}${PATH}?title=a&sig=${sig}&sig=${sig}`)).toBe('duplicate_param');
    expect(await reasonFor(`${BASE}${PATH}?title=a&sig=${sig}`)).toBe('ok');
  });

  it('bad_value: length is limited to maxDataValueChars code points', async () => {
    const max = LIMITS.maxDataValueChars;
    const atLimit = repeat('a', max);
    const astralAtLimit = `${repeat('a', max - 1)}🚀`;
    expect(astralAtLimit.length).toBe(max + 1);

    expect(await reasonFor(await signedByHand(`title=${atLimit}`, { title: atLimit }))).toBe('ok');
    expect(await reasonFor(await build({ params: { title: astralAtLimit } }))).toBe('ok');
    expect(await reasonFor(await signedByHand(`title=${atLimit}a`, { title: `${atLimit}a` }))).toBe('bad_value');
    expect(await reasonFor(await signedByHand(`title=${astralAtLimit}a`, { title: `${astralAtLimit}a` }))).toBe('bad_value');
  });

  it('too_many_params: maxDataKeys data parameters are fine, size does not count, one more is refused', async () => {
    const data = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys }, (_, i) => [`k${i}`, `${i}`]));
    const withSize = { ...data, [SIZE_PARAM]: 'og' };
    const oneTooMany = { ...withSize, extra: 'x' };

    expect(await reasonFor(await build({ params: data }))).toBe('ok');
    expect(await reasonFor(await build({ params: withSize }))).toBe('ok');
    expect(await reasonFor(await signedByHand(new URLSearchParams(oneTooMany).toString(), oneTooMany))).toBe('too_many_params');
  });

  it('url_too_long: path + query may be exactly maxSignedUrlChars, not one more', async () => {
    const filler = { p1: repeat('a', 1000), p2: repeat('a', 1000), p3: repeat('a', 1000) };
    const empty = new URL(await build({ params: { ...filler, p4: '' } }));
    const room = LIMITS.maxSignedUrlChars - (empty.pathname.length + empty.search.length);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(LIMITS.maxDataValueChars);

    const exact = new URL(await build({ params: { ...filler, p4: repeat('a', room) } }));
    expect(exact.pathname.length + exact.search.length).toBe(LIMITS.maxSignedUrlChars);
    expect(await reasonFor(exact)).toBe('ok');

    const over = { ...filler, p4: repeat('a', room + 1) };
    await expect(build({ params: over })).rejects.toMatchObject({ details: { reason: 'url_too_long' } });
    expect(await reasonFor(await signedByHand(new URLSearchParams(over).toString(), over))).toBe('url_too_long');
  });
});

describe('describeSignedUrlFailure', () => {
  it('has a distinct explanation for every reason and quotes the enforced limits', () => {
    const messages = ALL_REASONS.map(describeSignedUrlFailure);
    expect(messages.every((message) => message.length > 20)).toBe(true);
    expect(new Set(messages).size).toBe(ALL_REASONS.length);
    expect(describeSignedUrlFailure('bad_value')).toContain(String(LIMITS.maxDataValueChars));
    expect(describeSignedUrlFailure('too_many_params')).toContain(String(LIMITS.maxDataKeys));
    expect(describeSignedUrlFailure('url_too_long')).toContain(String(LIMITS.maxSignedUrlChars));
    expect(describeSignedUrlFailure('bad_param_name')).toContain(LIMITS.dataKeyPattern.source);
  });
});
