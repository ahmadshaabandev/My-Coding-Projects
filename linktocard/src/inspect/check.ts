/**
 * One OG check: fetch the page (https, guarded, 5 s, 2 MB, 3 redirects), parse its
 * preview tags, probe the image and read robots.txt (in parallel), build the checklist,
 * and keep the result 10 minutes in D1 (og_checks). Only parsed fields leave this module;
 * the HTML and every other body are dropped once read.
 */
import { INSPECT } from '../config';
import { all, first, run } from '../db/client';
import { randomId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { iso } from '../lib/http';
import type { OgCheckRow } from '../types';
import { buildChecks } from './checks';
import { type FetchDeps, type OwnSite, FetchFailure, defaultFetchDeps, discard, guardedFetch, mediaType, pageFetchError, readBody, vetUrl, withBudget } from './fetch';
import { type ImageOutcome, isImageType, probeImage } from './image';
import { decodeHtml, parseHead, pickFavicon, resolveUrl } from './parse';
import { checkRobots } from './robots';
import type { CheckResult } from './types';

export interface InspectDeps extends FetchDeps {
  now: () => number;
  pageTimeoutMs?: number;
  pageMaxBytes?: number;
  imageTimeoutMs?: number;
  robotsTimeoutMs?: number;
}

export function defaultInspectDeps(own?: OwnSite): InspectDeps {
  return { ...defaultFetchDeps(own), now: () => Date.now() };
}

const HTML_TYPES: readonly string[] = ['text/html', 'application/xhtml+xml'];
const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const CHECK_ID_RE = /^chk_[0-9a-z]{16}$/;

/**
 * The URL a visitor typed, vetted without I/O and normalised (host lower-cased, default
 * port and fragment dropped). It is also the cache key. 400 for anything that is not a
 * public https URL; 403 for blocked hosts.
 */
export function normaliseInputUrl(raw: string | undefined | null): URL {
  const text = (raw ?? '').trim();
  if (text === '') throw new ApiError('invalid_request', 'Enter the https:// address of a page to check ("url" parameter).');
  if (text.length > INSPECT.maxUrlChars) throw new ApiError('invalid_request', `The URL is longer than ${INSPECT.maxUrlChars} characters.`);
  let url: URL;
  try {
    url = vetUrl(text, true);
  } catch (error) {
    if (!(error instanceof FetchFailure)) throw error;
    if (error.reason === 'blocked') throw pageFetchError(error);
    throw new ApiError('invalid_request', error.message, { details: { reason: error.reason } });
  }
  url.hash = '';
  return url;
}

interface FetchedPage {
  finalUrl: URL;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
}

async function fetchPage(url: URL, deps: InspectDeps): Promise<FetchedPage> {
  const timeoutMs = deps.pageTimeoutMs ?? INSPECT.pageTimeoutMs;
  return withBudget(
    timeoutMs,
    async (signal) => {
      const { response, url: finalUrl } = await guardedFetch(
        url.href,
        { method: 'GET', accept: HTML_ACCEPT, httpsOnly: true, maxRedirects: INSPECT.maxRedirects, signal },
        deps,
      );
      if (!response.ok) {
        await discard(response);
        throw new FetchFailure('http_error', `The site answered HTTP ${response.status}.`, response.status);
      }
      const header = response.headers.get('content-type');
      const type = mediaType(header);
      if (!type || !HTML_TYPES.includes(type)) {
        await discard(response);
        throw new FetchFailure('not_html', `The address returned ${type ?? 'no content type'}, not an HTML page. Enter the address of a web page.`, response.status);
      }
      const { kept } = await readBody(response, { maxBytes: deps.pageMaxBytes ?? INSPECT.pageMaxBytes });
      return { finalUrl, status: response.status, contentType: header, bytes: kept };
    },
    () => new FetchFailure('timeout', `The page did not load within ${timeoutMs / 1000} s.`),
  );
}

/**
 * Longest text a result carries. The checked page can make any tag (and through it the
 * check details, the image URL and robots.txt rules) megabytes long; the checklist is
 * built from the full values first, so lengths it reports stay true.
 */
const MAX_TEXT_CHARS = 2048;

function bound(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  // Do not split a surrogate pair.
  const cut = /[\ud800-\udbff]$/.test(text.slice(0, MAX_TEXT_CHARS)) ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS;
  return `${text.slice(0, cut)}\u2026`;
}

function boundFields<T extends object>(fields: T): T {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? bound(value) : value])) as T;
}

export interface InspectionOutcome {
  result: CheckResult;
  imageUrl: string | null;
  faviconUrl: string | null;
}

/** Runs one uncached check. Page failures throw ApiError (403 forbidden or 422 page_fetch_failed). */
export async function runInspection(input: URL, deps: InspectDeps): Promise<InspectionOutcome> {
  const started = deps.now();
  let page: FetchedPage;
  try {
    page = await fetchPage(input, deps);
  } catch (error) {
    if (error instanceof FetchFailure) throw pageFetchError(error);
    throw error;
  }
  const responseMs = Math.max(0, deps.now() - started);
  const head = parseHead(decodeHtml(page.bytes, page.contentType));
  const { finalUrl } = page;

  const imageSource = head.og.image ? 'og' : head.twitter.image ? 'twitter' : null;
  const imageRaw = head.og.image ?? head.twitter.image;
  const imageUrl = imageRaw ? resolveUrl(imageRaw, finalUrl) : null;
  const probeable = imageUrl && (imageUrl.protocol === 'https:' || imageUrl.protocol === 'http:') ? imageUrl : null;

  const [image, robots] = await Promise.all([
    imageRaw
      ? probeable
        ? probeImage(probeable.href, { ...deps, timeoutMs: deps.imageTimeoutMs })
        : Promise.resolve<ImageOutcome>({
            probe: { url: imageUrl?.href ?? imageRaw, status: null, content_type: null, bytes: null, width: null, height: null, aspect_ratio: null, response_ms: null },
            error: 'The image URL is not an http(s) address.',
            overReadCap: false,
            format: null,
          })
      : Promise.resolve(null),
    checkRobots(finalUrl, { ...deps, timeoutMs: deps.robotsTimeoutMs }),
  ]);

  const favicon = pickFavicon(head.icons, finalUrl);
  const id = randomId('chk');
  const now = deps.now();
  const imageLoads = image !== null && image.error === null && image.probe.status !== null && image.probe.status < 300 && isImageType(image.probe.content_type);
  const result: CheckResult = {
    id,
    url: input.href,
    final_url: finalUrl.href,
    status: page.status,
    fetched_at: iso(now),
    response_ms: responseMs,
    cached: false,
    expires_at: iso(now + INSPECT.cacheTtlMs),
    page: boundFields({ title: head.title, description: head.description, canonical: head.canonical, favicon: favicon.href, theme_color: head.themeColor }),
    og: boundFields(head.og),
    twitter: boundFields(head.twitter),
    image: image ? boundFields(image.probe) : null,
    robots: boundFields(robots),
    checks: buildChecks({ og: head.og, twitter: head.twitter, imageSource, imageRaw, imageUrl, image, robots, responseMs }).map(boundFields),
    preview: {
      ...boundFields({
        title: head.og.title ?? head.twitter.title ?? head.title,
        description: head.og.description ?? head.twitter.description ?? head.description,
      }),
      domain: finalUrl.hostname,
      site_name: head.og.site_name === null ? null : bound(head.og.site_name),
      image: imageLoads ? `/api/tools/og-check/${id}/image` : null,
      favicon: `/api/tools/og-check/${id}/favicon`,
    },
  };
  return { result, imageUrl: imageLoads && probeable ? probeable.href : null, faviconUrl: favicon.href };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export async function findCachedResult(db: D1Database, urlKey: string, now: number): Promise<CheckResult | null> {
  const row = await first<Pick<OgCheckRow, 'result'>>(
    db,
    'SELECT result FROM og_checks WHERE url_key = ?1 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1',
    urlKey,
    now,
  );
  if (!row) return null;
  return { ...(JSON.parse(row.result) as CheckResult), cached: true };
}

export async function storeResult(db: D1Database, outcome: InspectionOutcome, now: number): Promise<void> {
  const { result } = outcome;
  await run(
    db,
    'INSERT INTO og_checks (id, url_key, result, image_url, favicon_url, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    result.id,
    result.url,
    JSON.stringify(result),
    outcome.imageUrl,
    outcome.faviconUrl,
    now,
    Date.parse(result.expires_at),
  );
}

/** The live (unexpired) row for an id, or null. Malformed ids never reach the database. */
export async function liveCheck(db: D1Database, id: string, now: number): Promise<OgCheckRow | null> {
  if (!CHECK_ID_RE.test(id)) return null;
  const rows = await all<OgCheckRow>(db, 'SELECT * FROM og_checks WHERE id = ?1 AND expires_at > ?2', id, now);
  return rows[0] ?? null;
}

/**
 * The whole flow of both entry points: cache first (free), then `beforeFetch` (the
 * caller's limit, which counts the check), then the check itself, stored for 10 minutes.
 */
export async function inspectUrl(
  db: D1Database,
  input: URL,
  beforeFetch: () => Promise<void>,
  deps: InspectDeps = defaultInspectDeps(),
): Promise<CheckResult> {
  const cached = await findCachedResult(db, input.href, deps.now());
  if (cached) return cached;
  await beforeFetch();
  const outcome = await runInspection(input, deps);
  await storeResult(db, outcome, Date.parse(outcome.result.fetched_at));
  return outcome.result;
}
