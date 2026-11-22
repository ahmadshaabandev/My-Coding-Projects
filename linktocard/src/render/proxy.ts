/**
 * SSRF-guarded image proxy: the only code path that downloads a customer-supplied URL.
 *
 * The renderer never fetches; it calls deps.fetchImage(url) for every remote image in a
 * template and gets a data: URI back. Nothing here relies on the platform refusing
 * private addresses (local workerd fetches 127.0.0.1 without complaint, and the Workers
 * docs make no promise about hostnames that resolve to private ranges), so every rule is
 * enforced in code: scheme, port, host name, resolved addresses, every redirect hop,
 * time, bytes, file type and pixel count.
 *
 * Known residual gap: the address check uses our own DNS lookup, and fetch() resolves the
 * name again. Workers offers no way to pin the connection to the vetted address, so a
 * DNS-rebinding host could answer differently the second time.
 */
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import webpDecoderWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';
import { LIMITS } from '../config';
import { base64Encode } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { encodePng, PngTooLargeError, type RgbaImage } from './png-writer';

export type ImageFetchFailure =
  | 'bad_url'
  | 'bad_scheme'
  | 'bad_port'
  | 'blocked_host'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'timeout'
  | 'http_error'
  | 'bad_content_type'
  | 'too_large'
  | 'too_many_pixels'
  | 'decode_failed';

/** What the renderer receives. WebP never appears: resvg cannot draw it, so it is transcoded. */
export type FetchedImageType = 'image/png' | 'image/jpeg' | 'image/gif';

export interface ImageFetchOptions {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to all of its A and AAAA addresses; reject when it cannot be resolved. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxPixels?: number;
  maxRedirects?: number;
}

export interface FetchedImage {
  dataUri: string;
  contentType: FetchedImageType;
  bytes: number;
  width: number;
  height: number;
}

type SniffedType = FetchedImageType | 'image/webp';

interface Settings {
  fetchImpl: typeof fetch;
  resolveHost: (hostname: string) => Promise<string[]>;
  timeoutMs: number;
  maxBytes: number;
  maxPixels: number;
  maxRedirects: number;
}

/** `requested` is what the template contained; `current` differs after a redirect. */
interface Hop {
  requested: string;
  current: string;
}

const ALLOWED_CONTENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
const REQUEST_HEADERS = {
  accept: 'image/png,image/jpeg,image/gif,image/webp;q=0.8',
  'user-agent': 'LinkToCard-ImageFetcher/1.0 (+https://linktocard.com/docs)',
} as const;

// ---------------------------------------------------------------------------
// Errors

function shorten(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function failure(reason: ImageFetchFailure, hop: Hop, message: string): ApiError {
  const via = hop.current === hop.requested ? '' : ` (reached by a redirect from ${shorten(hop.requested)})`;
  return new ApiError('image_fetch_failed', `${message}${via}`, { details: { reason, url: hop.requested } });
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

// ---------------------------------------------------------------------------
// Address rules

type Cidr4 = readonly [base: number, bits: number];

function ipv4ToInt(octets: readonly number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function cidr4(base: string, bits: number): Cidr4 {
  return [ipv4ToInt(base.split('.').map(Number)), bits];
}

/** Everything that is not ordinary public unicast space (IANA special-purpose registry). */
const BLOCKED_IPV4: readonly Cidr4[] = [
  cidr4('0.0.0.0', 8), // "this network"
  cidr4('10.0.0.0', 8), // private
  cidr4('100.64.0.0', 10), // carrier-grade NAT
  cidr4('127.0.0.0', 8), // loopback
  cidr4('169.254.0.0', 16), // link-local, cloud metadata (169.254.169.254)
  cidr4('172.16.0.0', 12), // private
  cidr4('192.0.0.0', 24), // IETF protocol assignments
  cidr4('192.0.2.0', 24), // documentation
  cidr4('192.88.99.0', 24), // 6to4 relay anycast (deprecated)
  cidr4('192.168.0.0', 16), // private
  cidr4('198.18.0.0', 15), // benchmarking
  cidr4('198.51.100.0', 24), // documentation
  cidr4('203.0.113.0', 24), // documentation
  cidr4('224.0.0.0', 4), // multicast
  cidr4('240.0.0.0', 4), // reserved, broadcast
];

/** Strict dotted decimal only; a leading zero could be read as octal elsewhere, so it does not parse. */
function parseIpv4(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function parseHexGroups(text: string): number[] {
  if (text === '') return [];
  return text.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN));
}

/** Eight 16-bit groups, or undefined when the text is not an IPv6 address (zone ids are refused). */
function parseIpv6(text: string): number[] | undefined {
  let source = text;
  const lastColon = source.lastIndexOf(':');
  if (lastColon < 0) return undefined;
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    const high = ((v4[0]! << 8) | v4[1]!).toString(16);
    const low = ((v4[2]! << 8) | v4[3]!).toString(16);
    source = `${source.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return undefined;
  const head = parseHexGroups(halves[0]!);
  const rest = halves.length === 2 ? parseHexGroups(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  return groups.some(Number.isNaN) ? undefined : groups;
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const value = ipv4ToInt(octets);
  return BLOCKED_IPV4.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
}

/** The IPv4 address carried inside an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address. */
function embeddedIpv4(groups: readonly number[]): number[] | undefined {
  const zeros = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0);
  const mapped = zeros(0, 5) && groups[5] === 0xffff;
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6);
  if (!mapped && !nat64) return undefined;
  return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const embedded = embeddedIpv4(groups);
  if (embedded) return isBlockedIpv4(embedded);
  const [first, second] = [groups[0]!, groups[1]!];
  // Public unicast is 2000::/3. Outside it are ::, ::1, IPv4-compatible, fc00::/7 (unique
  // local), fe80::/10 (link-local), ff00::/8 (multicast) and unallocated space.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001 && second < 0x0200) return true; // 2001::/23: Teredo, ORCHID, benchmarking
  if (first === 0x2001 && second === 0x0db8) return true; // documentation
  if (first === 0x2002) return true; // 6to4: wraps an arbitrary IPv4 address
  if (first === 0x3fff && second < 0x1000) return true; // documentation (3fff::/20)
  return false;
}

/**
 * True for any address a customer-supplied URL must not reach: loopback, private,
 * link-local, CGNAT, multicast, reserved, documentation, and the IPv6 forms that wrap
 * such an IPv4 address. Text that is not a well-formed IP address is blocked too.
 */
export function isBlockedIp(ip: string): boolean {
  const text = ip.trim().replace(/^\[(.*)\]$/, '$1');
  const v4 = parseIpv4(text);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(text);
  return v6 ? isBlockedIpv6(v6) : true;
}

/** Special-use and conventional private-network suffixes; none of them is public DNS. */
const BLOCKED_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home.arpa',
  'localdomain',
  'intranet',
  'corp',
  'home',
  'test',
  'invalid',
  'example',
  'onion',
];

function bareHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

/** A host the URL parser treats as an address: bracketed/colon form, or a numeric last label. */
function isIpLiteral(host: string): boolean {
  return host.includes(':') || /(^|\.)(\d+|0x[0-9a-f]*)$/.test(host);
}

/**
 * True when the host must be refused without any network I/O: blocked IP literals,
 * localhost, internal-only suffixes and single-label names.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === '') return true;
  if (isIpLiteral(host)) return isBlockedIp(host);
  if (!host.includes('.')) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function checkUrl(hop: Hop): URL {
  let url: URL;
  try {
    url = new URL(hop.current);
  } catch {
    throw failure('bad_url', hop, `Image URL "${shorten(hop.current)}" is not a valid absolute URL. Use a full https:// address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw failure('bad_scheme', hop, `Image URLs must start with https:// or http:// (got "${url.protocol}").`);
  }
  if (url.username !== '' || url.password !== '') {
    throw failure('bad_url', hop, 'Image URLs must not contain a username or password.');
  }
  // The URL parser drops the scheme's default port, so anything left is non-default.
  if (url.port !== '') {
    throw failure('bad_port', hop, `Image URLs must use the default port (443 for https, 80 for http); port ${url.port} is not allowed.`);
  }
  if (isBlockedHostname(url.hostname)) {
    throw failure(
      'blocked_host',
      hop,
      `Image host "${shorten(url.hostname)}" is not on the public internet (loopback, private-network and internal names are blocked). Host the image at a public URL.`,
    );
  }
  return url;
}

/**
 * Parse and vet a URL without any network I/O: http(s) only, default port, no
 * credentials, and a host that is neither a blocked address nor an internal name.
 * The URL parser has already normalised exotic IPv4 spellings (2130706433, 0x7f.1,
 * 017700000001) to dotted form, so they are judged as the addresses they are.
 */
export function assertPublicHttpUrl(raw: string): URL {
  return checkUrl({ requested: raw, current: raw });
}

// ---------------------------------------------------------------------------
// DNS

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 1500;
const DNS_CACHE_MAX_TTL_MS = 60_000;
const DNS_CACHE_MAX_ENTRIES = 256;
const DNS_RECORD = { A: 1, AAAA: 28 } as const;
const DNS_STATUS = { ok: 0, nxdomain: 3 } as const;

interface DohResponse {
  Status?: number;
  Answer?: { type?: number; TTL?: number; data?: string }[];
}

interface DnsRecords {
  addresses: string[];
  /** Shortest TTL among the records; Infinity when there are none. */
  ttlSeconds: number;
}

const dnsCache = new Map<string, { addresses: string[]; expiresAt: number }>();

async function queryDoh(hostname: string, type: keyof typeof DNS_RECORD, fetchImpl: typeof fetch): Promise<DnsRecords> {
  const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DNS query for ${hostname} failed with HTTP ${response.status}`);
  const body: DohResponse = await response.json();
  if (body.Status === DNS_STATUS.nxdomain) return { addresses: [], ttlSeconds: Number.POSITIVE_INFINITY };
  // SERVFAIL, REFUSED and friends: we do not know the addresses, so do not guess.
  if (body.Status !== DNS_STATUS.ok) throw new Error(`DNS query for ${hostname} returned status ${String(body.Status)}`);
  const records = (body.Answer ?? []).filter((answer) => answer.type === DNS_RECORD[type] && typeof answer.data === 'string');
  return {
    addresses: records.map((answer) => answer.data as string),
    ttlSeconds: Math.min(...records.map((answer) => answer.TTL ?? 0)),
  };
}

/**
 * Resolve a hostname's A and AAAA records over DNS-over-HTTPS (Cloudflare's JSON API).
 * Rejects when either lookup fails or the name has no address, so callers fail closed.
 * Answers are cached in memory for at most a minute (never longer than their TTL).
 */
export async function resolveHostViaDoh(hostname: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const host = bareHost(hostname);
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > now) return cached.addresses;
  const [a, aaaa] = await Promise.all([queryDoh(host, 'A', fetchImpl), queryDoh(host, 'AAAA', fetchImpl)]);
  const addresses = [...a.addresses, ...aaaa.addresses];
  if (addresses.length === 0) throw new Error(`${host} has no A or AAAA record`);
  const ttlMs = Math.min(a.ttlSeconds, aaaa.ttlSeconds) * 1000;
  if (ttlMs > 0) {
    if (dnsCache.size >= DNS_CACHE_MAX_ENTRIES) dnsCache.delete(dnsCache.keys().next().value as string);
    dnsCache.delete(host);
    dnsCache.set(host, { addresses, expiresAt: now + Math.min(ttlMs, DNS_CACHE_MAX_TTL_MS) });
  }
  return addresses;
}

async function assertResolvesPublic(url: URL, hop: Hop, resolveHost: Settings['resolveHost']): Promise<void> {
  const host = bareHost(url.hostname);
  // An address literal has nothing to resolve and was already judged by checkUrl.
  if (isIpLiteral(host)) return;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    throw failure('dns_failed', hop, `Could not resolve image host "${shorten(host)}". Check the hostname in the image URL.`);
  }
  if (addresses.some(isBlockedIp)) {
    throw failure(
      'blocked_host',
      hop,
      `Image host "${shorten(host)}" resolves to a loopback, private-network or reserved address. Host the image at a public URL.`,
    );
  }
}

// ---------------------------------------------------------------------------
// File type and dimensions (header bytes only; nothing is decoded here)

interface ImageInfo {
  width: number;
  height: number;
  /** Only WebP reports this; the decoder handles still images only. */
  animated?: boolean;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + signature.length && signature.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function sniffType(bytes: Uint8Array): SniffedType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

function pngSize(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 24 || !startsWith(b, ascii('IHDR'), 12)) return undefined;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Start-of-frame markers carry the size; C4 (huffman tables), C8 and CC are not frames. */
function isJpegFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(b: Uint8Array): ImageInfo | undefined {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // markers without a payload
    } else if (marker === 0xd9 || marker === 0xda) {
      return undefined; // image data began without a frame header
    } else if (isJpegFrameMarker(marker)) {
      return i + 8 < b.length ? { height: u16be(b, i + 5), width: u16be(b, i + 7) } : undefined;
    } else {
      const length = u16be(b, i + 2);
      if (length < 2) return undefined;
      i += 2 + length;
    }
  }
  return undefined;
}

/**
 * resvg sizes its buffer from the first frame, not the logical screen, so a GIF that
 * declares a 1x1 screen and a huge frame must count as huge: take the larger of the two.
 */
function gifSize(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 13) return undefined;
  const flags = b[10]!;
  let i = 13 + (flags & 0x80 ? 3 * (2 << (flags & 0x07)) : 0);
  while (i < b.length) {
    if (b[i] === 0x2c) {
      if (i + 9 >= b.length) return undefined;
      return { width: Math.max(u16le(b, 6), u16le(b, i + 5)), height: Math.max(u16le(b, 8), u16le(b, i + 7)) };
    }
    if (b[i] !== 0x21) return undefined; // trailer or garbage before any frame
    i += 2; // extension introducer + label
    while (i < b.length && b[i] !== 0) i += b[i]! + 1; // data sub-blocks
    i += 1; // block terminator
  }
  return undefined;
}

function webpInfo(b: Uint8Array): ImageInfo | undefined {
  if (startsWith(b, ascii('VP8 '), 12)) {
    if (b.length < 30 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return undefined;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (startsWith(b, ascii('VP8L'), 12)) {
    if (b.length < 25 || b[20] !== 0x2f) return undefined;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(b, ascii('VP8X'), 12)) {
    if (b.length < 30) return undefined;
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, animated: (b[20]! & 0x02) !== 0 };
  }
  return undefined;
}

function readImageInfo(type: SniffedType, bytes: Uint8Array): ImageInfo | undefined {
  switch (type) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/gif':
      return gifSize(bytes);
    case 'image/webp':
      return webpInfo(bytes);
  }
}

// ---------------------------------------------------------------------------
// WebP -> PNG

// workerd cannot compile wasm from bytes, so the decoder is handed a precompiled module.
// The init promise is remembered per library instance on globalThis (same reasoning as
// src/render/engine.ts): under vitest this module can be evaluated again while the library
// is not, and a library that is evaluated again needs its own init.
const DECODER_INIT_KEY = Symbol.for('linktocard.proxy.webp-decoder-init');
const initHolder = globalThis as unknown as Record<symbol, WeakMap<object, Promise<void>> | undefined>;
const decoderInits = (initHolder[DECODER_INIT_KEY] ??= new WeakMap<object, Promise<void>>());

function ensureWebpDecoder(): Promise<void> {
  let ready = decoderInits.get(initWebpDecoder);
  if (!ready) {
    ready = initWebpDecoder(webpDecoderWasm as Parameters<typeof initWebpDecoder>[0]);
    decoderInits.set(initWebpDecoder, ready);
  }
  return ready;
}

async function webpToPng(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  await ensureWebpDecoder();
  // slice() gives the decoder a buffer that holds exactly the file, whatever view we were given.
  const decoded: RgbaImage = await decodeWebp(bytes.slice().buffer);
  return encodePng(decoded, { maxBytes });
}

// ---------------------------------------------------------------------------
// Download

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Reads the body, giving up (and cancelling the download) once it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (declared > maxBytes) {
    await discard(response);
    return undefined;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks, size);
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
}

/** Follows redirects by hand so that every hop passes the same URL and DNS checks. */
async function fetchFollowingRedirects(requested: string, settings: Settings, signal: AbortSignal): Promise<{ response: Response; hop: Hop }> {
  const { fetchImpl } = settings;
  let hop: Hop = { requested, current: requested };
  for (let redirects = 0; ; redirects++) {
    const url = checkUrl(hop);
    await assertResolvesPublic(url, hop, settings.resolveHost);
    let response: Response;
    try {
      response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', headers: REQUEST_HEADERS, signal });
    } catch {
      throw failure('http_error', hop, `Could not connect to image host "${shorten(url.hostname)}".`);
    }
    if (!REDIRECT_STATUSES.includes(response.status)) return { response, hop };
    await discard(response);
    if (redirects >= settings.maxRedirects) {
      throw failure(
        'too_many_redirects',
        { requested, current: requested },
        `Image URL redirected more than ${settings.maxRedirects} times. Link to the final image address directly.`,
      );
    }
    const location = response.headers.get('location');
    if (!location) throw failure('http_error', hop, `Image host answered HTTP ${response.status} without a Location header.`);
    let next: string;
    try {
      next = new URL(location, url).href;
    } catch {
      next = location;
    }
    hop = { requested, current: next };
  }
}

async function download(requested: string, settings: Settings, signal: AbortSignal): Promise<FetchedImage> {
  const { response, hop } = await fetchFollowingRedirects(requested, settings, signal);
  if (!response.ok) {
    await discard(response);
    throw failure('http_error', hop, `Image host answered HTTP ${response.status} for ${shorten(hop.current)}.`);
  }
  const declaredType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(declaredType)) {
    await discard(response);
    throw failure(
      'bad_content_type',
      hop,
      `Image URL returned content-type "${shorten(declaredType) || 'none'}". Only PNG, JPEG, GIF and WebP images can be used (SVG is not supported for remote images).`,
    );
  }
  const tooLarge = (): ApiError =>
    failure('too_large', hop, `Image is larger than the ${megabytes(settings.maxBytes)} limit. Compress or resize it.`);
  const bytes = await readCapped(response, settings.maxBytes);
  if (!bytes) throw tooLarge();

  // The header is only a claim; the bytes decide what the file is.
  const type = sniffType(bytes);
  if (!type) {
    throw failure(
      'bad_content_type',
      hop,
      `Image URL says it is ${declaredType}, but the file is not a PNG, JPEG, GIF or WebP image.`,
    );
  }
  const corrupt = (): ApiError =>
    failure('decode_failed', hop, `The ${type.slice(6).toUpperCase()} file is truncated or corrupt and cannot be read.`);
  const size = readImageInfo(type, bytes);
  if (!size || size.width < 1 || size.height < 1) throw corrupt();
  if (size.width * size.height > settings.maxPixels) {
    throw failure(
      'too_many_pixels',
      hop,
      `Image is ${size.width}x${size.height} pixels; the limit is ${settings.maxPixels.toLocaleString('en-US')} pixels in total. Resize it (a card is at most 1200x1350).`,
    );
  }
  if (type !== 'image/webp') return toFetchedImage(type, bytes, size);

  if (size.animated) {
    throw failure('decode_failed', hop, 'Animated WebP images are not supported. Use a still PNG, JPEG or WebP.');
  }
  let png: Uint8Array;
  try {
    png = await webpToPng(bytes, settings.maxBytes);
  } catch (error) {
    if (!(error instanceof PngTooLargeError)) throw corrupt();
    throw failure(
      'too_large',
      hop,
      `This WebP image has to be converted to PNG to be drawn, and as PNG it is larger than the ${megabytes(settings.maxBytes)} limit. Use a JPEG or PNG file, or a smaller image.`,
    );
  }
  return toFetchedImage('image/png', png, size);
}

function toFetchedImage(contentType: FetchedImageType, bytes: Uint8Array, size: ImageInfo): FetchedImage {
  return {
    dataUri: `data:${contentType};base64,${base64Encode(bytes)}`,
    contentType,
    bytes: bytes.byteLength,
    width: size.width,
    height: size.height,
  };
}

function resolveSettings(options: ImageFetchOptions): Settings {
  // Read the global at call time (not module load) and call it unbound: workerd's fetch
  // throws "Illegal invocation" when invoked as a method of another object.
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return {
    fetchImpl,
    resolveHost: options.resolveHost ?? ((hostname) => resolveHostViaDoh(hostname, fetchImpl)),
    timeoutMs: options.timeoutMs ?? LIMITS.imageFetchTimeoutMs,
    maxBytes: options.maxBytes ?? LIMITS.maxImageBytes,
    maxPixels: options.maxPixels ?? LIMITS.maxImagePixels,
    maxRedirects: options.maxRedirects ?? LIMITS.imageMaxRedirects,
  };
}

/**
 * Download a customer-supplied image URL and return it as a data: URI the renderer can
 * draw (PNG, JPEG or GIF; WebP is converted to PNG). Every failure is an
 * ApiError('image_fetch_failed') whose details carry { reason, url }.
 */
export async function fetchRemoteImage(url: string, options: ImageFetchOptions = {}): Promise<FetchedImage> {
  const settings = resolveSettings(options);
  const hop: Hop = { requested: url, current: url };
  const timeout = (): ApiError =>
    failure('timeout', hop, `Image did not finish downloading within ${settings.timeoutMs / 1000} s. Use a faster host or a smaller file.`);
  const controller = new AbortController();
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(timeout()));
  });
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    // The race covers steps that ignore the signal (a custom resolveHost); the signal stops the download itself.
    return await Promise.race([download(url, settings, controller.signal), expired]);
  } catch (error) {
    // An aborted fetch surfaces as a connection or stream error; report what really happened.
    if (controller.signal.aborted) throw timeout();
    if (error instanceof ApiError) throw error;
    throw failure('http_error', hop, 'The image download was interrupted before it completed.');
  } finally {
    clearTimeout(timer);
  }
}

/** The renderer's deps.fetchImage: same guard, only the data: URI is exposed. */
export function createImageFetcher(options: ImageFetchOptions = {}): (url: string) => Promise<{ dataUri: string }> {
  return async (url) => {
    const { dataUri } = await fetchRemoteImage(url, options);
    return { dataUri };
  };
}
