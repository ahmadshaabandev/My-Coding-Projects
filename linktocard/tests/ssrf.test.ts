import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/config';
import { base64Encode } from '../src/lib/crypto';
import { ApiError } from '../src/lib/errors';
import { encodeRasterJpeg, encodeRasterWebp, rasterize } from '../src/render/engine';
import { crc32, encodePng, PngTooLargeError, type RgbaImage } from '../src/render/png-writer';
import {
  assertPublicHttpUrl,
  createImageFetcher,
  fetchRemoteImage,
  isBlockedHostname,
  isBlockedIp,
  resolveHostViaDoh,
  type ImageFetchFailure,
} from '../src/render/proxy';

// ---------------------------------------------------------------------------
// Helpers

type Rgba = readonly [number, number, number, number];
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const IMAGE_URL = 'https://images.example.com/photo.png';

/** 1x1 GIF89a with a global colour table and a graphic-control extension before the frame. */
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
/** The 1x1 lossless (VP8L) file from Google's WebP feature-detection snippet. */
const WEBP_LOSSLESS = Uint8Array.from(atob('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='), (c) => c.charCodeAt(0));
const HTML = new TextEncoder().encode('<!doctype html><html><body>not an image</body></html>');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

function pixels(width: number, height: number, colourAt: (x: number, y: number) => Rgba): RgbaImage & { data: Uint8Array } {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(colourAt(x, y), (y * width + x) * 4);
  return { data, width, height };
}

/** Deterministic noise, so "does not compress" tests do not depend on Math.random. */
function noise(width: number, height: number): RgbaImage & { data: Uint8Array } {
  let state = 0x2545f491;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  };
  return pixels(width, height, () => [next(), next(), next(), 255]);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** Just a PNG signature and IHDR claiming the given size (enough for the header checks). */
function pngHeader(width: number, height: number): Uint8Array {
  return concatBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), [0x49, 0x48, 0x44, 0x52], u32(width), u32(height), [8, 6, 0, 0, 0]);
}

function imageResponse(body: BodyInit, contentType: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { 'content-type': contentType, ...headers } });
}

const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

interface Harness {
  fetchImpl: typeof fetch;
  resolveHost: (hostname: string) => Promise<string[]>;
  calls: { url: string; init: RequestInit | undefined }[];
  lookups: string[];
}

/** Fake network: `routes` maps exact URLs to responses, `dns` maps hostnames to addresses (public by default). */
function network(routes: Record<string, () => Response | Promise<Response>> = {}, dns: Record<string, string[]> = {}): Harness {
  const calls: Harness['calls'] = [];
  const lookups: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  }) as typeof fetch;
  const resolveHost = async (hostname: string): Promise<string[]> => {
    lookups.push(hostname);
    return dns[hostname] ?? [PUBLIC_V4];
  };
  return { fetchImpl, resolveHost, calls, lookups };
}

async function expectFailure(attempt: Promise<unknown>, reason: ImageFetchFailure, url: string): Promise<ApiError> {
  const error: unknown = await attempt.then(
    () => {
      throw new Error(`expected ${url} to be refused with ${reason}`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.code).toBe('image_fetch_failed');
  expect(apiError.status).toBe(422);
  expect(apiError.details).toEqual({ reason, url });
  expect(apiError.message.length).toBeGreaterThan(20);
  return apiError;
}

function dataUri(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${base64Encode(bytes)}`;
}

/** Draws a data: URI with resvg (the renderer's rasteriser) at its native size over `background`. */
async function draw(uri: string, width: number, height: number, background: string): Promise<(x: number, y: number) => number[]> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="${uri}" width="${width}" height="${height}"/></svg>`;
  const raster = await rasterize(svg, width, background);
  expect([raster.width, raster.height]).toEqual([width, height]);
  return (x, y) => Array.from(raster.pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4));
}

let png: Uint8Array;
let jpeg: Uint8Array;
let webp: Uint8Array;
let webpAlpha: Uint8Array;

beforeAll(async () => {
  png = await encodePng(pixels(5, 3, () => RED));
  jpeg = await encodeRasterJpeg({ width: 6, height: 4, pixels: pixels(6, 4, () => BLUE).data });
  webp = await encodeRasterWebp({ width: 8, height: 6, pixels: pixels(8, 6, () => RED).data });
  // Left half opaque green, right half fully transparent.
  webpAlpha = await encodeRasterWebp({ width: 8, height: 4, pixels: pixels(8, 4, (x) => (x < 4 ? GREEN : CLEAR)).data });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('refused before any network I/O', () => {
  const cases: [string, ImageFetchFailure][] = [
    ['http://127.0.0.1/x.png', 'blocked_host'],
    ['http://10.1.2.3/', 'blocked_host'],
    ['http://10.255.255.255/', 'blocked_host'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_host'],
    ['http://192.168.1.1/', 'blocked_host'],
    ['http://172.16.0.1/', 'blocked_host'],
    ['http://100.64.0.1/', 'blocked_host'],
    ['http://0.0.0.0/', 'blocked_host'],
    ['http://224.0.0.1/', 'blocked_host'],
    ['http://255.255.255.255/', 'blocked_host'],
    ['http://[::1]/', 'blocked_host'],
    ['http://[::]/', 'blocked_host'],
    ['http://[::ffff:10.0.0.1]/', 'blocked_host'],
    ['http://[64:ff9b::7f00:1]/', 'blocked_host'],
    ['http://[fd12:3456::1]/', 'blocked_host'],
    ['http://[fe80::1]/', 'blocked_host'],
    // Exotic IPv4 spellings: the URL parser turns all three into 127.0.0.1.
    ['http://2130706433/', 'blocked_host'],
    ['http://0x7f.1/', 'blocked_host'],
    ['http://017700000001/', 'blocked_host'],
    ['http://127.1/', 'blocked_host'],
    ['http://１２７.０.０.１/', 'blocked_host'], // full-width digits
    ['http://127.0.0.1./', 'blocked_host'],
    ['http://[0:0:0:0:0:ffff:7f00:1]/', 'blocked_host'],
    ['http://localhost/', 'blocked_host'],
    ['http://LOCALHOST./', 'blocked_host'],
    ['http://app.localhost/', 'blocked_host'],
    ['http://printer.local/', 'blocked_host'],
    ['http://db.internal/x.png', 'blocked_host'],
    ['http://router.lan/', 'blocked_host'],
    ['http://nas.home.arpa/', 'blocked_host'],
    ['http://intranet/logo.png', 'blocked_host'],
    ['ftp://images.example.com/a.png', 'bad_scheme'],
    ['file:///etc/passwd', 'bad_scheme'],
    ['data:image/png;base64,iVBORw0KGgo=', 'bad_scheme'],
    ['javascript:alert(1)', 'bad_scheme'],
    ['http://images.example.com:8080/a.png', 'bad_port'],
    ['https://images.example.com:80/a.png', 'bad_port'],
    ['https://user:secret@images.example.com/a.png', 'bad_url'],
    ['https://user@images.example.com/a.png', 'bad_url'],
    ['/relative/a.png', 'bad_url'],
    ['not a url', 'bad_url'],
    ['', 'bad_url'],
  ];

  it.each(cases)('%s -> %s', async (url, reason) => {
    const net = network();
    await expectFailure(fetchRemoteImage(url, net), reason, url);
    expect(net.calls).toEqual([]);
    expect(net.lookups).toEqual([]);
    expect(() => assertPublicHttpUrl(url)).toThrow(ApiError);
  });

  it('confirms the URL parser normalises the exotic IPv4 spellings', () => {
    for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/']) {
      expect(new URL(url).hostname).toBe('127.0.0.1');
    }
  });

  it('explains what to do', async () => {
    const port = await expectFailure(fetchRemoteImage('http://images.example.com:8080/a.png', network()), 'bad_port', 'http://images.example.com:8080/a.png');
    expect(port.message).toContain('port 8080');
    const scheme = await expectFailure(fetchRemoteImage('ftp://images.example.com/a.png', network()), 'bad_scheme', 'ftp://images.example.com/a.png');
    expect(scheme.message).toContain('https://');
  });
});

describe('assertPublicHttpUrl', () => {
  it('returns the parsed URL for a public address', () => {
    expect(assertPublicHttpUrl(IMAGE_URL).href).toBe(IMAGE_URL);
    expect(assertPublicHttpUrl('http://Images.Example.com:80/a.png?x=1').href).toBe('http://images.example.com/a.png?x=1');
    expect(assertPublicHttpUrl('https://8.8.8.8/a.png').hostname).toBe('8.8.8.8');
  });
});

describe('isBlockedIp', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '[::1]', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:192.168.1.1', '::10.0.0.1', '64:ff9b::a00:1', '64:ff9b::169.254.169.254', '64:ff9b:1::1', '2001:db8::1',
    '2001::1', '2002:7f00:1::1', '3fff::1', '100::1',
    // Not well-formed addresses are refused rather than guessed at.
    'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', 'fe80::1%eth0', '1::2::3', '12345::1', '',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '1.1.1.1', '8.8.8.8', PUBLIC_V4, '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.1', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1', '198.17.255.255',
    '198.20.0.1', '223.255.255.255', PUBLIC_V6, '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8', '64:ff9b::808:808',
  ])('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it.each([
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'printer.local', 'api.internal', 'nas.lan', 'box.home.arpa', 'home.arpa',
    'intranet', 'server', 'db.corp', 'pc.home', 'site.test', 'x.invalid', 'x.example', 'abc.onion', 'host.localdomain',
    '127.0.0.1', '10.0.0.8', '[::1]', '[fe80::1]', '0x7f.1', '2130706433', '',
  ])('blocks %s', (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  });

  it.each(['images.example.com', 'example.org', 'cdn.local.example.com', 'internal.example.com', 'lan.io', '8.8.8.8', '[2606:4700:4700::1111]'])(
    'allows %s',
    (hostname) => {
      expect(isBlockedHostname(hostname)).toBe(false);
    },
  );
});

describe('DNS check', () => {
  it('refuses a public-looking hostname that resolves to a private address', async () => {
    const net = network({}, { 'images.example.com': ['10.0.0.5'] });
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'blocked_host', IMAGE_URL);
    expect(error.message).toContain('images.example.com');
    expect(net.lookups).toEqual(['images.example.com']);
    expect(net.calls).toEqual([]);
  });

  it.each([
    ['one private address among public ones', [PUBLIC_V4, '192.168.1.20']],
    ['a loopback AAAA next to a public A', [PUBLIC_V4, '::1']],
    ['an IPv4-mapped private address', ['::ffff:10.0.0.1']],
    ['the metadata address', ['169.254.169.254']],
    ['an answer that is not an address', [PUBLIC_V4, 'garbage']],
  ])('refuses %s', async (_label, addresses) => {
    const net = network({}, { 'images.example.com': addresses });
    await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'blocked_host', IMAGE_URL);
    expect(net.calls).toEqual([]);
  });

  it('fails closed when the name cannot be resolved', async () => {
    const net = network();
    const failing = { ...net, resolveHost: () => Promise.reject(new Error('SERVFAIL')) };
    await expectFailure(fetchRemoteImage(IMAGE_URL, failing), 'dns_failed', IMAGE_URL);
    const empty = { ...net, resolveHost: () => Promise.resolve([]) };
    await expectFailure(fetchRemoteImage(IMAGE_URL, empty), 'dns_failed', IMAGE_URL);
    expect(net.calls).toEqual([]);
  });

  it('accepts a host with public A and AAAA records', async () => {
    const net = network({ [IMAGE_URL]: () => imageResponse(png, 'image/png') }, { 'images.example.com': [PUBLIC_V4, PUBLIC_V6] });
    await expect(fetchRemoteImage(IMAGE_URL, net)).resolves.toMatchObject({ contentType: 'image/png' });
  });
});

describe('resolveHostViaDoh', () => {
  type DohAnswer = { name: string; type: number; TTL: number; data: string };

  function doh(answers: Record<'A' | 'AAAA', { Status: number; Answer?: DohAnswer[] } | Response>): { fetchImpl: typeof fetch; calls: { url: URL; init: RequestInit | undefined }[] } {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin + url.pathname !== 'https://cloudflare-dns.com/dns-query') throw new Error(`unexpected fetch ${url.href}`);
      calls.push({ url, init });
      const answer = answers[url.searchParams.get('type') as 'A' | 'AAAA'];
      return answer instanceof Response ? answer : Response.json(answer);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it('returns A and AAAA addresses and skips CNAME records', async () => {
    const host = 'doh-basic.example.org';
    const { fetchImpl, calls } = doh({
      A: {
        Status: 0,
        Answer: [
          { name: host, type: 5, TTL: 300, data: 'edge.example.net.' },
          { name: 'edge.example.net', type: 1, TTL: 300, data: PUBLIC_V4 },
        ],
      },
      AAAA: { Status: 0, Answer: [{ name: host, type: 28, TTL: 300, data: PUBLIC_V6 }] },
    });
    expect(await resolveHostViaDoh(host, fetchImpl)).toEqual([PUBLIC_V4, PUBLIC_V6]);
    expect(calls.map((call) => call.url.search).sort()).toEqual([`?name=${host}&type=A`, `?name=${host}&type=AAAA`]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('accept')).toBe('application/dns-json');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('caches an answer for at most a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    const host = 'doh-cache.example.org';
    const { fetchImpl, calls } = doh({
      A: { Status: 0, Answer: [{ name: host, type: 1, TTL: 86_400, data: PUBLIC_V4 }] },
      AAAA: { Status: 0 },
    });
    expect(await resolveHostViaDoh(host, fetchImpl)).toEqual([PUBLIC_V4]);
    expect(await resolveHostViaDoh(`${host.toUpperCase()}.`, fetchImpl)).toEqual([PUBLIC_V4]);
    expect(calls).toHaveLength(2);
    vi.setSystemTime(new Date('2026-11-22T10:01:01Z'));
    await resolveHostViaDoh(host, fetchImpl);
    expect(calls).toHaveLength(4);
  });

  it('does not cache an answer with TTL 0', async () => {
    const host = 'doh-ttl0.example.org';
    const { fetchImpl, calls } = doh({ A: { Status: 0, Answer: [{ name: host, type: 1, TTL: 0, data: PUBLIC_V4 }] }, AAAA: { Status: 0 } });
    await resolveHostViaDoh(host, fetchImpl);
    await resolveHostViaDoh(host, fetchImpl);
    expect(calls).toHaveLength(4);
  });

  it('rejects for NXDOMAIN, an empty answer, a server failure and an HTTP error', async () => {
    const nxdomain = doh({ A: { Status: 3 }, AAAA: { Status: 3 } });
    await expect(resolveHostViaDoh('doh-nx.example.org', nxdomain.fetchImpl)).rejects.toThrow('no A or AAAA record');
    const nodata = doh({ A: { Status: 0 }, AAAA: { Status: 0 } });
    await expect(resolveHostViaDoh('doh-nodata.example.org', nodata.fetchImpl)).rejects.toThrow('no A or AAAA record');
    const servfail = doh({ A: { Status: 0, Answer: [{ name: 'x', type: 1, TTL: 60, data: PUBLIC_V4 }] }, AAAA: { Status: 2 } });
    await expect(resolveHostViaDoh('doh-servfail.example.org', servfail.fetchImpl)).rejects.toThrow('status 2');
    const down = doh({ A: new Response('bad gateway', { status: 502 }), AAAA: { Status: 0 } });
    await expect(resolveHostViaDoh('doh-down.example.org', down.fetchImpl)).rejects.toThrow('HTTP 502');
  });
});

describe('default wiring (global fetch + DNS over HTTPS)', () => {
  function mockGlobalFetch(host: string, address: string, image: () => Response): { urls: string[]; imageInit: () => RequestInit | undefined } {
    const urls: string[] = [];
    let imageInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.href);
      if (url.hostname === 'cloudflare-dns.com') {
        const isA = url.searchParams.get('type') === 'A';
        return Response.json({ Status: 0, Answer: isA ? [{ name: host, type: 1, TTL: 120, data: address }] : [] });
      }
      if (url.hostname === host) {
        imageInit = init;
        return image();
      }
      throw new Error(`unexpected fetch ${url.href}`);
    });
    return { urls, imageInit: () => imageInit };
  }

  it('createImageFetcher resolves through DoH, fetches with the guard headers and exposes only the data URI', async () => {
    const host = 'cdn-default.example.org';
    const mock = mockGlobalFetch(host, PUBLIC_V4, () => imageResponse(png, 'image/png'));
    const result = await createImageFetcher()(`https://${host}/a.png`);
    expect(result).toEqual({ dataUri: dataUri('image/png', png) });
    expect(mock.urls.slice().sort()).toEqual([
      `https://${host}/a.png`,
      `https://cloudflare-dns.com/dns-query?name=${host}&type=A`,
      `https://cloudflare-dns.com/dns-query?name=${host}&type=AAAA`,
    ]);
    const init = mock.imageInit();
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(Object.fromEntries(headers)).toEqual({
      accept: 'image/png,image/jpeg,image/gif,image/webp;q=0.8',
      'user-agent': 'LinkToCard-ImageFetcher/1.0 (+https://linktocard.com/docs)',
    });
  });

  it('never requests the image when DoH reports a private address', async () => {
    const host = 'rebind-default.example.org';
    const url = `https://${host}/a.png`;
    const mock = mockGlobalFetch(host, '127.0.0.1', () => imageResponse(png, 'image/png'));
    await expectFailure(createImageFetcher()(url), 'blocked_host', url);
    expect(mock.urls).not.toContain(url);
  });

  it('passes its options through', async () => {
    const net = network({ [IMAGE_URL]: () => imageResponse(png, 'image/png') });
    await expectFailure(createImageFetcher({ ...net, maxBytes: 10 })(IMAGE_URL), 'too_large', IMAGE_URL);
  });
});

describe('redirects', () => {
  /** r0 -> r1 -> ... -> r<count>, which serves the image. */
  function chain(count: number): Record<string, () => Response> {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < count; i++) routes[`https://images.example.com/r${i}`] = () => redirect(`https://images.example.com/r${i + 1}`, i % 2 ? 301 : 307);
    routes[`https://images.example.com/r${count}`] = () => imageResponse(png, 'image/png');
    return routes;
  }
  const START = 'https://images.example.com/r0';

  it('refuses a redirect to a private address without following it', async () => {
    const net = network({ [IMAGE_URL]: () => redirect('http://127.0.0.1/admin') });
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'blocked_host', IMAGE_URL);
    expect(error.message).toContain('127.0.0.1');
    expect(error.message).toContain('redirect');
    expect(net.calls.map((call) => call.url)).toEqual([IMAGE_URL]);
  });

  it('refuses a redirect to the metadata address and to a host that resolves privately', async () => {
    const metadata = network({ [IMAGE_URL]: () => redirect('http://169.254.169.254/latest/meta-data/', 301) });
    await expectFailure(fetchRemoteImage(IMAGE_URL, metadata), 'blocked_host', IMAGE_URL);
    expect(metadata.calls).toHaveLength(1);

    const rebind = network({ [IMAGE_URL]: () => redirect('https://innocent.example.net/x.png') }, { 'innocent.example.net': ['10.9.8.7'] });
    await expectFailure(fetchRemoteImage(IMAGE_URL, rebind), 'blocked_host', IMAGE_URL);
    expect(rebind.lookups).toEqual(['images.example.com', 'innocent.example.net']);
    expect(rebind.calls).toHaveLength(1);
  });

  it('re-validates scheme and port on every hop', async () => {
    const scheme = network({ [IMAGE_URL]: () => redirect('ftp://images.example.com/a.png') });
    await expectFailure(fetchRemoteImage(IMAGE_URL, scheme), 'bad_scheme', IMAGE_URL);
    const port = network({ [IMAGE_URL]: () => redirect('https://images.example.com:8443/a.png') });
    await expectFailure(fetchRemoteImage(IMAGE_URL, port), 'bad_port', IMAGE_URL);
  });

  it(`follows up to ${LIMITS.imageMaxRedirects} redirects`, async () => {
    const net = network(chain(LIMITS.imageMaxRedirects));
    const image = await fetchRemoteImage(START, net);
    expect(image.dataUri).toBe(dataUri('image/png', png));
    expect(net.calls).toHaveLength(LIMITS.imageMaxRedirects + 1);
    expect(net.calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
  });

  it('refuses a longer chain', async () => {
    const net = network(chain(LIMITS.imageMaxRedirects + 1));
    await expectFailure(fetchRemoteImage(START, net), 'too_many_redirects', START);
    expect(net.calls).toHaveLength(LIMITS.imageMaxRedirects + 1);

    const none = network(chain(1));
    await expectFailure(fetchRemoteImage(START, { ...none, maxRedirects: 0 }), 'too_many_redirects', START);
    expect(none.calls).toHaveLength(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    const net = network({
      'https://images.example.com/a/start': () => redirect('../b/final.png'),
      'https://images.example.com/b/final.png': () => imageResponse(png, 'image/png'),
    });
    await expect(fetchRemoteImage('https://images.example.com/a/start', net)).resolves.toMatchObject({ width: 5, height: 3 });
  });

  it('refuses a redirect without a Location header', async () => {
    const net = network({ [IMAGE_URL]: () => new Response(null, { status: 302 }) });
    await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'http_error', IMAGE_URL);
  });
});

describe('response checks', () => {
  const serve = (response: () => Response): Harness => network({ [IMAGE_URL]: response });

  it('refuses an oversize body announced by Content-Length without reading it', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(png);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const net = serve(() => imageResponse(body, 'image/png', { 'content-length': String(LIMITS.maxImageBytes + 1) }));
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'too_large', IMAGE_URL);
    expect(error.message).toContain('2 MB');
    expect(pulled).toBe(false);
  });

  it('stops reading an oversize body that has no Content-Length', async () => {
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(sent === chunk.byteLength ? concatBytes(png, new Uint8Array(chunk.byteLength - png.byteLength)) : chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const net = serve(() => imageResponse(body, 'image/png'));
    await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'too_large', IMAGE_URL);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(LIMITS.maxImageBytes + 2 * chunk.byteLength);
  });

  it('honours a custom maxBytes', async () => {
    await expectFailure(fetchRemoteImage(IMAGE_URL, { ...serve(() => imageResponse(png, 'image/png')), maxBytes: png.byteLength - 1 }), 'too_large', IMAGE_URL);
    await expect(fetchRemoteImage(IMAGE_URL, { ...serve(() => imageResponse(png, 'image/png')), maxBytes: png.byteLength })).resolves.toMatchObject({ bytes: png.byteLength });
  });

  it.each([
    ['text/html', () => imageResponse(HTML, 'text/html; charset=utf-8')],
    ['SVG', () => imageResponse(SVG, 'image/svg+xml')],
    ['AVIF', () => imageResponse(png, 'image/avif')],
    ['BMP', () => imageResponse(png, 'image/bmp')],
    ['ICO', () => imageResponse(png, 'image/x-icon')],
    ['octet-stream', () => imageResponse(png, 'application/octet-stream')],
    ['no content-type', () => new Response(png)],
    ['image/png header with HTML bytes', () => imageResponse(HTML, 'image/png')],
    ['image/png header with SVG bytes', () => imageResponse(SVG, 'image/png')],
    ['image/webp header with a non-WebP RIFF file', () => imageResponse(concatBytes(Array.from('RIFF\x24\x00\x00\x00WAVEfmt ', (c) => c.charCodeAt(0))), 'image/webp')],
    ['empty body', () => imageResponse(new Uint8Array(0), 'image/jpeg')],
  ])('refuses %s', async (_label, response) => {
    await expectFailure(fetchRemoteImage(IMAGE_URL, serve(response)), 'bad_content_type', IMAGE_URL);
  });

  it('names the content-type it got and says SVG is unsupported', async () => {
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, serve(() => imageResponse(SVG, 'image/svg+xml'))), 'bad_content_type', IMAGE_URL);
    expect(error.message).toContain('image/svg+xml');
    expect(error.message).toContain('SVG is not supported');
  });

  it('refuses a PNG with too many pixels', async () => {
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, serve(() => imageResponse(pngHeader(4000, 3000), 'image/png'))), 'too_many_pixels', IMAGE_URL);
    expect(error.message).toContain('4000x3000');
    expect(error.message).toContain('4,000,000');
    await expectFailure(fetchRemoteImage(IMAGE_URL, { ...serve(() => imageResponse(png, 'image/png')), maxPixels: 14 }), 'too_many_pixels', IMAGE_URL);
    await expect(fetchRemoteImage(IMAGE_URL, { ...serve(() => imageResponse(png, 'image/png')), maxPixels: 15 })).resolves.toMatchObject({ width: 5, height: 3 });
  });

  it('counts a GIF frame that is larger than its declared screen', async () => {
    const huge = GIF.slice();
    // Image descriptor starts at byte 27: 0x2c, left(2), top(2), width(2), height(2).
    expect(huge[27]).toBe(0x2c);
    huge.set([0xb8, 0x0b, 0xb8, 0x0b], 32); // 3000 x 3000
    await expectFailure(fetchRemoteImage(IMAGE_URL, serve(() => imageResponse(huge, 'image/gif'))), 'too_many_pixels', IMAGE_URL);
  });

  it.each([
    ['a PNG cut off inside its header', () => imageResponse(png.subarray(0, 20), 'image/png')],
    ['a PNG whose first chunk is not IHDR', () => imageResponse(concatBytes(png.subarray(0, 12), [0x49, 0x44, 0x41, 0x54], png.subarray(16)), 'image/png')],
    ['a zero-width PNG', () => imageResponse(pngHeader(0, 10), 'image/png')],
    ['a JPEG without a frame header', () => imageResponse(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xd9), 'image/jpeg')],
    ['a GIF without a frame', () => imageResponse(GIF.subarray(0, 27), 'image/gif')],
    ['a truncated WebP', () => imageResponse(webp.subarray(0, 24), 'image/webp')],
    ['a WebP whose image data is cut off', () => imageResponse(webp.subarray(0, webp.byteLength - 20), 'image/webp')],
    [
      'an animated WebP',
      () => imageResponse(concatBytes(Array.from('RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00', (c) => c.charCodeAt(0)), [0x02, 0, 0, 0, 9, 0, 0, 9, 0, 0]), 'image/webp'),
    ],
  ])('reports %s as undecodable', async (_label, response) => {
    await expectFailure(fetchRemoteImage(IMAGE_URL, serve(response)), 'decode_failed', IMAGE_URL);
  });

  it.each([404, 403, 500, 304])('reports HTTP %i', async (status) => {
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, serve(() => new Response(null, { status }))), 'http_error', IMAGE_URL);
    expect(error.message).toContain(String(status));
  });

  it('reports a connection failure', async () => {
    const net = serve(() => {
      throw new TypeError('connection refused');
    });
    await expectFailure(fetchRemoteImage(IMAGE_URL, net), 'http_error', IMAGE_URL);
  });

  it('reports a body that breaks off mid-download', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    await expectFailure(fetchRemoteImage(IMAGE_URL, serve(() => imageResponse(body, 'image/png'))), 'http_error', IMAGE_URL);
  });
});

describe('timeout', () => {
  const untilAborted = (signal: AbortSignal | null | undefined): Promise<never> =>
    new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')));
    });

  it('aborts a host that never answers', async () => {
    let aborted = false;
    const net = network();
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return untilAborted(init?.signal);
    }) as typeof fetch;
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, { ...net, fetchImpl, timeoutMs: 30 }), 'timeout', IMAGE_URL);
    expect(error.message).toContain('0.03 s');
    expect(aborted).toBe(true);
  });

  it('covers a body that stalls', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.subarray(0, 10));
      },
    });
    const net = network({ [IMAGE_URL]: () => imageResponse(body, 'image/png') });
    await expectFailure(fetchRemoteImage(IMAGE_URL, { ...net, timeoutMs: 30 }), 'timeout', IMAGE_URL);
  });

  it('covers a DNS lookup that hangs', async () => {
    const net = network();
    const resolveHost = (): Promise<string[]> => new Promise(() => undefined);
    await expectFailure(fetchRemoteImage(IMAGE_URL, { ...net, resolveHost, timeoutMs: 30 }), 'timeout', IMAGE_URL);
    expect(net.calls).toEqual([]);
  });

  it(`defaults to ${LIMITS.imageFetchTimeoutMs} ms and does not fire for a prompt answer`, async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const net = network({ [IMAGE_URL]: () => imageResponse(png, 'image/png') });
    await fetchRemoteImage(IMAGE_URL, net);
    expect(timeouts.mock.calls.map((call) => call[1])).toContain(LIMITS.imageFetchTimeoutMs);
  });
});

describe('accepted images', () => {
  const serve = (bytes: Uint8Array, type: string): Harness => network({ [IMAGE_URL]: () => imageResponse(bytes, type) });

  it('returns a PNG unchanged as a data URI', async () => {
    expect(await fetchRemoteImage(IMAGE_URL, serve(png, 'image/png'))).toEqual({
      dataUri: dataUri('image/png', png),
      contentType: 'image/png',
      bytes: png.byteLength,
      width: 5,
      height: 3,
    });
  });

  it('returns a JPEG unchanged as a data URI', async () => {
    expect(await fetchRemoteImage(IMAGE_URL, serve(jpeg, 'image/jpeg'))).toEqual({
      dataUri: dataUri('image/jpeg', jpeg),
      contentType: 'image/jpeg',
      bytes: jpeg.byteLength,
      width: 6,
      height: 4,
    });
  });

  it('returns a GIF unchanged as a data URI', async () => {
    expect(await fetchRemoteImage(IMAGE_URL, serve(GIF, 'image/gif'))).toEqual({
      dataUri: dataUri('image/gif', GIF),
      contentType: 'image/gif',
      bytes: GIF.byteLength,
      width: 1,
      height: 1,
    });
  });

  it('tolerates content-type parameters and upper case', async () => {
    await expect(fetchRemoteImage(IMAGE_URL, serve(png, 'IMAGE/PNG; charset=binary'))).resolves.toMatchObject({ contentType: 'image/png' });
  });

  it('labels the data URI by what the bytes are, not by the header', async () => {
    const image = await fetchRemoteImage(IMAGE_URL, serve(png, 'image/jpeg'));
    expect(image.contentType).toBe('image/png');
    expect(image.dataUri.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('reads the size of a JPEG that has EXIF-style segments and fill bytes before its frame header', async () => {
    const app1 = [0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4];
    const padded = concatBytes(jpeg.subarray(0, 2), app1, [0xff], jpeg.subarray(2));
    await expect(fetchRemoteImage(IMAGE_URL, serve(padded, 'image/jpeg'))).resolves.toMatchObject({ width: 6, height: 4 });
  });

  it('accepts a public IP-literal URL without a DNS lookup', async () => {
    const url = 'http://8.8.8.8/logo.png';
    const net = network({ [url]: () => imageResponse(png, 'image/png') });
    await expect(fetchRemoteImage(url, net)).resolves.toMatchObject({ bytes: png.byteLength });
    expect(net.lookups).toEqual([]);
  });
});

describe('WebP is transcoded to PNG', () => {
  const serve = (bytes: Uint8Array): Harness => network({ [IMAGE_URL]: () => imageResponse(bytes, 'image/webp') });

  it('converts a lossy WebP into a PNG that resvg draws', async () => {
    expect(ascii(webp, 12, 16)).toBe('VP8 ');
    const image = await fetchRemoteImage(IMAGE_URL, serve(webp));
    expect(image).toMatchObject({ contentType: 'image/png', width: 8, height: 6 });
    expect(image.dataUri.startsWith('data:image/png;base64,')).toBe(true);
    expect(image.bytes).toBe(atob(image.dataUri.split(',')[1]!).length);
    const at = await draw(image.dataUri, 8, 6, '#0000ff');
    for (const [x, y] of [[0, 0], [7, 5], [4, 3]] as const) {
      const [r, g, b] = at(x, y);
      expect(r).toBeGreaterThan(235);
      expect(g).toBeLessThan(20);
      expect(b).toBeLessThan(20);
    }
  });

  it('keeps transparency (VP8X with alpha)', async () => {
    expect(ascii(webpAlpha, 12, 16)).toBe('VP8X');
    const image = await fetchRemoteImage(IMAGE_URL, serve(webpAlpha));
    expect(image).toMatchObject({ contentType: 'image/png', width: 8, height: 4 });
    const at = await draw(image.dataUri, 8, 4, '#0000ff');
    const [r, g, b] = at(1, 2);
    expect([r! < 20, g! > 235, b! < 20]).toEqual([true, true, true]);
    // The transparent half shows the blue background painted underneath.
    expect(at(6, 2)).toEqual([0, 0, 255, 255]);
  });

  it('converts a lossless WebP (VP8L)', async () => {
    expect(ascii(WEBP_LOSSLESS, 12, 16)).toBe('VP8L');
    await expect(fetchRemoteImage(IMAGE_URL, serve(WEBP_LOSSLESS))).resolves.toMatchObject({ contentType: 'image/png', width: 1, height: 1 });
  });

  it('refuses a WebP whose PNG form exceeds the byte limit', async () => {
    const noisy = await encodeRasterWebp({ width: 64, height: 64, pixels: noise(64, 64).data });
    const converted = await fetchRemoteImage(IMAGE_URL, serve(noisy));
    expect(converted.bytes).toBeGreaterThan(noisy.byteLength + 64);
    const error = await expectFailure(fetchRemoteImage(IMAGE_URL, { ...serve(noisy), maxBytes: noisy.byteLength + 64 }), 'too_large', IMAGE_URL);
    expect(error.message).toContain('PNG');
  });

  it('checks the pixel limit before decoding', async () => {
    await expectFailure(fetchRemoteImage(IMAGE_URL, { ...serve(webp), maxPixels: 47 }), 'too_many_pixels', IMAGE_URL);
  });
});

describe('png-writer', () => {
  const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  it('computes CRC-32', () => {
    const text = (value: string): Uint8Array => new TextEncoder().encode(value);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(text('IEND'))).toBe(0xae426082);
    expect(crc32(text('1234'), text('56789'))).toBe(0xcbf43926);
    expect(crc32()).toBe(0);
  });

  it('writes an RGBA PNG that resvg decodes to the same pixels', async () => {
    const colours: Rgba[][] = [
      [RED, GREEN, BLUE, WHITE],
      [BLACK, CLEAR, [255, 255, 0, 255], CLEAR],
    ];
    const file = await encodePng(pixels(4, 2, (x, y) => colours[y]![x]!));
    expect(Array.from(file.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(ascii(file, 12, 16)).toBe('IHDR');
    expect([view(file).getUint32(16), view(file).getUint32(20)]).toEqual([4, 2]);
    expect(Array.from(file.subarray(24, 29))).toEqual([8, 6, 0, 0, 0]);
    expect(view(file).getUint32(29)).toBe(crc32(file.subarray(12, 29)));
    expect(Array.from(file.subarray(-12))).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

    const at = await draw(dataUri('image/png', file), 4, 2, '#ff00ff');
    const magenta = [255, 0, 255, 255];
    expect([at(0, 0), at(1, 0), at(2, 0), at(3, 0)]).toEqual([[...RED], [...GREEN], [...BLUE], [...WHITE]]);
    expect([at(0, 1), at(1, 1), at(2, 1), at(3, 1)]).toEqual([[...BLACK], magenta, [255, 255, 0, 255], magenta]);
  });

  it('writes opaque images as RGB across several compressor batches, pixel for pixel', async () => {
    const source = pixels(300, 200, (x, y) => [(x * 7 + y) & 0xff, (y * 5) & 0xff, (x ^ y) & 0xff, 255]);
    const file = await encodePng(source);
    expect(file[25]).toBe(2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><image href="${dataUri('image/png', file)}" width="300" height="200"/></svg>`;
    const raster = await rasterize(svg, 300, '#000000');
    expect(raster.pixels.byteLength).toBe(source.data.byteLength);
    const firstDifference = raster.pixels.findIndex((value, i) => value !== source.data[i]);
    expect(firstDifference).toBe(-1);
  });

  it('stops with PngTooLargeError when the file would exceed maxBytes', async () => {
    const source = noise(128, 128);
    const full = await encodePng(source);
    expect(full.byteLength).toBeGreaterThan(40_000);
    await expect(encodePng(source, { maxBytes: 10_000 })).rejects.toBeInstanceOf(PngTooLargeError);
    await expect(encodePng(source, { maxBytes: full.byteLength - 1 })).rejects.toMatchObject({ maxBytes: full.byteLength - 1 });
    await expect(encodePng(source, { maxBytes: full.byteLength })).resolves.toHaveLength(full.byteLength);
  });

  it('rejects impossible dimensions', async () => {
    await expect(encodePng({ data: new Uint8Array(0), width: 0, height: 0 })).rejects.toThrow(RangeError);
    await expect(encodePng({ data: new Uint8Array(4), width: 1.5, height: 1 })).rejects.toThrow(RangeError);
    await expect(encodePng({ data: new Uint8Array(7), width: 2, height: 1 })).rejects.toThrow(RangeError);
  });
});
