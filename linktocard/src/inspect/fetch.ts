/**
 * The OG checker's guarded fetcher: every outbound request of src/inspect/* (page,
 * image probe, robots.txt, image proxy) goes through guardedFetch.
 *
 * The address rules are the image proxy's (src/render/proxy.ts): default port only, no
 * credentials, no blocked host names or IP literals, and every name resolved over DoH
 * (failing closed) with every address checked, on every redirect hop. Redirects are
 * followed by hand (redirect: 'manual') so that each hop passes the same checks.
 *
 * The same residual gap as the image proxy applies: fetch() resolves the name again
 * after our own lookup, so a DNS-rebinding host could answer differently the second time.
 */
import { INSPECT, WORKER_PATHS } from '../config';
import { ApiError } from '../lib/errors';
import { assertPublicHttpUrl, isBlockedIp, resolveHostViaDoh } from '../render/proxy';

export type FetchFailureReason =
  | 'invalid_url'
  | 'insecure_url'
  | 'bad_port'
  | 'blocked'
  | 'dns_failed'
  | 'connect_failed'
  | 'too_many_redirects'
  | 'insecure_redirect'
  | 'bad_redirect'
  | 'timeout'
  | 'http_error'
  | 'not_html'
  | 'not_image'
  | 'too_large';

/** Internal failure; routes turn it into an ApiError (see pageFetchError). */
export class FetchFailure extends Error {
  readonly reason: FetchFailureReason;
  readonly status?: number;

  constructor(reason: FetchFailureReason, message: string, status?: number) {
    super(message);
    this.name = 'FetchFailure';
    this.reason = reason;
    this.status = status;
  }
}

export interface FetchDeps {
  fetchImpl: typeof fetch;
  /** All A and AAAA addresses of a name; rejects (or returns []) when it cannot be resolved. */
  resolveHost: (hostname: string) => Promise<string[]>;
}

export function defaultFetchDeps(): FetchDeps {
  // Read the global at call time and call it unbound (workerd's fetch throws "Illegal
  // invocation" as a method of another object); tests replace it with vi.spyOn.
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  return { fetchImpl, resolveHost: (hostname) => resolveHostViaDoh(hostname, fetchImpl) };
}

/** Shown for every blocked address: says what is wrong without revealing what we resolved. */
export const BLOCKED_MESSAGE = 'This address is not on the public internet, so it cannot be checked. Enter the public https:// address of the page.';

function shorten(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/**
 * Parse and vet a URL without network I/O. httpsOnly is the page rule; images may be
 * http (the checklist reports it).
 */
export function vetUrl(raw: string, httpsOnly: boolean): URL {
  let url: URL;
  try {
    url = assertPublicHttpUrl(raw);
  } catch (error) {
    const reason = error instanceof ApiError ? error.details?.reason : undefined;
    if (reason === 'blocked_host') throw new FetchFailure('blocked', BLOCKED_MESSAGE);
    if (reason === 'bad_scheme') throw new FetchFailure('insecure_url', 'Only https:// addresses can be checked.');
    if (reason === 'bad_port') throw new FetchFailure('bad_port', 'Only the default port can be used (443 for https).');
    throw new FetchFailure('invalid_url', `"${shorten(raw)}" is not a valid absolute URL without a username or password.`);
  }
  if (httpsOnly && url.protocol !== 'https:') throw new FetchFailure('insecure_url', 'Only https:// addresses can be checked.');
  if (isOwnWorkerPath(url)) throw new FetchFailure('blocked', OWN_PATH_MESSAGE);
  return url;
}

/** Our production hosts and the linktocard-* Workers on workers.dev (staging). */
const OWN_HOST = /^(www\.)?linktocard\.com$|^linktocard[a-z0-9-]*\.[a-z0-9-]+\.workers\.dev$/;
const OWN_PATH_MESSAGE = "This is one of Link To Card's own API addresses. Check a page instead.";

/**
 * A check of our own API (/api/tools/og-check?url=..., /v1/..., /i/...) would make the
 * Worker call itself, possibly in a chain. Our ordinary pages stay checkable.
 */
function isOwnWorkerPath(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!OWN_HOST.test(host)) return false;
  const path = url.pathname.toLowerCase();
  return WORKER_PATHS.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) || path === prefix.slice(0, -1) : path === prefix));
}

/** After URL parsing a numeric last label means an IPv4 literal; a colon means IPv6. */
const IP_LITERAL = /(^|\.)(\d+|0x[0-9a-f]*)$/;

async function assertResolvesPublic(url: URL, deps: FetchDeps): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // A literal was already judged by vetUrl and has nothing to resolve.
  if (host.includes(':') || IP_LITERAL.test(host)) return;
  let addresses: string[];
  try {
    addresses = await deps.resolveHost(host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) throw new FetchFailure('dns_failed', `Could not resolve the host name "${shorten(host)}".`);
  if (addresses.some(isBlockedIp)) throw new FetchFailure('blocked', BLOCKED_MESSAGE);
}

export interface GuardedRequest {
  method: 'GET' | 'HEAD';
  accept: string;
  httpsOnly: boolean;
  maxRedirects: number;
  signal: AbortSignal;
}

const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

export async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Follows at most maxRedirects redirects; every hop is vetted and resolved first. */
export async function guardedFetch(start: string, request: GuardedRequest, deps: FetchDeps): Promise<{ response: Response; url: URL }> {
  let current = start;
  for (let redirects = 0; ; redirects++) {
    let url: URL;
    try {
      url = vetUrl(current, request.httpsOnly);
    } catch (error) {
      if (redirects === 0 || !(error instanceof FetchFailure) || error.reason === 'blocked') throw error;
      if (error.reason === 'insecure_url') throw new FetchFailure('insecure_redirect', `It redirects to a non-https address (${shorten(current)}).`);
      throw new FetchFailure('bad_redirect', `It redirects to an address that cannot be fetched (${shorten(current)}).`);
    }
    await assertResolvesPublic(url, deps);
    let response: Response;
    try {
      response = await deps.fetchImpl(url.href, {
        method: request.method,
        redirect: 'manual',
        headers: { 'user-agent': INSPECT.userAgent, accept: request.accept },
        signal: request.signal,
      });
    } catch {
      throw new FetchFailure('connect_failed', `Could not connect to ${shorten(url.hostname)} (connection or TLS error).`);
    }
    if (!REDIRECT_STATUSES.includes(response.status)) return { response, url };
    await discard(response);
    if (redirects >= request.maxRedirects) {
      throw new FetchFailure('too_many_redirects', `It redirects more than ${request.maxRedirects} times. Link to the final address directly.`);
    }
    const location = response.headers.get('location');
    if (!location) throw new FetchFailure('bad_redirect', `It answered HTTP ${response.status} without a Location header.`, response.status);
    try {
      current = new URL(location, url).href;
    } catch {
      throw new FetchFailure('bad_redirect', `It redirects to an invalid address (${shorten(location)}).`);
    }
  }
}

/**
 * Runs work under one wall-clock budget. The signal aborts the fetches; the race also
 * covers steps that ignore it (a resolver, a stalled stream).
 */
export async function withBudget<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, onTimeout: () => FetchFailure): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } catch (error) {
    // An aborted fetch surfaces as a connection or stream error; report what really happened.
    if (controller.signal.aborted) throw onTimeout();
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Lower-cased media type without parameters, or null. */
export function mediaType(header: string | null): string | null {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return type === '' ? null : type;
}

export interface ReadOptions {
  /** Stop reading (and cancel the download) once this many bytes have arrived. */
  maxBytes: number;
  /** Bytes kept in memory from the start of the body (default: maxBytes). The rest is only counted. */
  keepBytes?: number;
  /** Checked as data arrives (while bytes are still being kept): true stops the download. */
  enough?: (kept: Uint8Array) => boolean;
}

export interface ReadResult {
  kept: Uint8Array;
  bytesRead: number;
  /** The body was read to its end. */
  complete: boolean;
  /** Reading stopped because more than maxBytes arrived. */
  overCap: boolean;
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

/** Reads at most maxBytes of a body; never more than one chunk past it is pulled from the network. */
export async function readBody(response: Response, options: ReadOptions): Promise<ReadResult> {
  const keepBytes = Math.min(options.keepBytes ?? options.maxBytes, options.maxBytes);
  if (!response.body) return { kept: new Uint8Array(0), bytesRead: 0, complete: true, overCap: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let bytesRead = 0;
  const stop = async (overCap: boolean): Promise<ReadResult> => {
    await reader.cancel().catch(() => undefined);
    return { kept: concat(chunks, kept), bytesRead, complete: false, overCap };
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { kept: concat(chunks, kept), bytesRead, complete: true, overCap: false };
    const room = keepBytes - kept;
    if (room > 0) {
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(part);
      kept += part.byteLength;
      if (options.enough?.(concat(chunks, kept))) {
        bytesRead += value.byteLength;
        return stop(false);
      }
    }
    if (bytesRead + value.byteLength > options.maxBytes) {
      bytesRead = options.maxBytes;
      return stop(true);
    }
    bytesRead += value.byteLength;
  }
}

/** The ApiError a failed page fetch becomes: 403 for blocked addresses, 422 with details.reason otherwise. */
export function pageFetchError(failure: FetchFailure, what: 'page' | 'image' = 'page'): ApiError {
  if (failure.reason === 'blocked') return new ApiError('forbidden', BLOCKED_MESSAGE);
  return new ApiError('page_fetch_failed', `The ${what} could not be fetched. ${failure.message}`, {
    details: { reason: failure.reason, ...(failure.status !== undefined ? { status: failure.status } : {}) },
  });
}
