/**
 * Signed link-card URLs:
 *
 *   GET {APP_URL}/v1/link/{siteId}/{template}.{png|jpg|jpeg|webp}?url=<page>&<params>&sig=<hex>
 *
 * Signed exactly like card URLs (src/lib/signed-url.ts: the pathname, the sorted parameter
 * names, then one name=value line per parameter with DECODED values), and verified by the
 * same verifySignedUrl, so a customer's existing signer works unchanged. The page address
 * is the `url` parameter and is signed like every other one: a visitor cannot point a
 * customer's link at another page, and adding, removing or changing any parameter breaks
 * the signature.
 *
 * Reserved parameters: `url` (required, the page), `size` (preset, as on /v1/og) and `sig`.
 * Every other parameter is template data that wins over what the page says (for example a
 * fixed tag or theme). `open` is refused: the "open fields" of email images exist for
 * merge tags, and a link card has no field a recipient should be able to change.
 *
 * Limits are the signed-URL ones: the url value, like any value, is at most
 * LIMITS.maxDataValueChars characters and the whole URL at most LIMITS.maxSignedUrlChars.
 */
import { DEFAULT_SIZE, LIMITS, SIZES, type SizeId } from '../config';
import { normaliseInputUrl } from '../inspect/check';
import { ApiError } from '../lib/errors';
import { assertTemplateSize } from '../lib/images';
import {
  SIG_PARAM,
  SIZE_PARAM,
  canonicalString,
  describeSignedUrlFailure,
  signCanonical,
  verifySignedUrl,
  type OgExtension,
  type SignedUrlFailure,
} from '../lib/signed-url';
import { getStarterTemplate } from '../render/templates';
import type { TemplateData } from '../types';

/** The page the card is made from. */
export const URL_PARAM = 'url';
/** Reserved by email images (open fields); never accepted on a link URL. */
export const OPEN_PARAM = 'open';
/** Names that are never template data on a link URL. */
export const LINK_RESERVED_PARAMS: readonly string[] = [URL_PARAM, SIZE_PARAM, SIG_PARAM, OPEN_PARAM];

export interface LinkPath {
  siteId: string;
  template: string;
  ext: OgExtension;
}

export type LinkUrlFailure = SignedUrlFailure | 'missing_url' | 'open_not_supported';

export type LinkVerifyResult =
  | {
      ok: true;
      /** The page, normalised by the OG checker's rules (it is also the inspector's cache key). */
      target: URL;
      /** The `size` parameter as sent, if any (parseSize decides whether it is valid). */
      size: string | undefined;
      /** Template data that overrides the page's values. */
      overrides: TemplateData;
    }
  | { ok: false; reason: LinkUrlFailure };

export interface LinkUrlInput {
  /** Origin the URL is served from, e.g. env.APP_URL. */
  baseUrl: string;
  siteId: string;
  template: string;
  ext: OgExtension;
  /** The page: any public https URL. It is normalised before it is signed. */
  url: string;
  /** Size preset id; "og" (the default) is left out of the URL. */
  size?: string;
  /** Fixed template data on top of the page's values. Query order follows insertion order. */
  data?: Record<string, string>;
  secret: string;
}

// The same segment rules as /v1/og: characters no URL parser rewrites, so line 1 of the
// canonical string is identical on every client and server.
const LINK_PATH = /^\/v1\/link\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.(png|jpg|jpeg|webp)$/;

const FAILURE_MESSAGES: Record<Exclude<LinkUrlFailure, SignedUrlFailure>, string> = {
  missing_url: `A link card URL needs a signed "${URL_PARAM}" parameter: the https:// address of the page.`,
  open_not_supported: `"${OPEN_PARAM}" (open fields) is not available on link card URLs; sign every parameter.`,
};

/** Plain-English explanation of a verification failure. */
export function describeLinkUrlFailure(reason: LinkUrlFailure): string {
  return reason === 'missing_url' || reason === 'open_not_supported' ? FAILURE_MESSAGES[reason] : describeSignedUrlFailure(reason);
}

export function linkPathname(siteId: string, template: string, ext: OgExtension): string {
  return `/v1/link/${siteId}/${template}.${ext}`;
}

export function parseLinkPath(pathname: string): LinkPath | null {
  const match = LINK_PATH.exec(pathname);
  if (!match) return null;
  return { siteId: match[1]!, template: match[2]!, ext: match[3] as OgExtension };
}

function invalidInput(message: string, reason: string): ApiError {
  return new ApiError('invalid_request', message, { details: { reason } });
}

/**
 * Builds a signed link URL and returns it with the exact string that was signed. The page
 * is normalised first (normaliseInputUrl: 400 for anything but a public https URL, 403 for
 * blocked hosts), so equal pages give equal URLs and share one cached card. The result is
 * run through the verifier before it is returned, so a URL we sign is always one we accept.
 */
export async function buildLinkUrl(input: LinkUrlInput): Promise<{ url: string; canonical: string }> {
  const pathname = linkPathname(input.siteId, input.template, input.ext);
  if (!parseLinkPath(pathname)) {
    throw invalidInput('Site id and template name may only contain letters, digits, "_" and "-".', 'bad_path');
  }
  const data = Object.entries(input.data ?? {});
  const reserved = data.find(([name]) => LINK_RESERVED_PARAMS.includes(name));
  if (reserved) throw invalidInput(`"${reserved[0]}" is reserved on link card URLs and cannot be used as a data parameter.`, 'reserved_param');

  if (input.size !== undefined && !Object.values(SIZES).some((preset) => preset.id === input.size)) {
    throw new ApiError('unsupported_size', `Unsupported size. Supported sizes: ${Object.values(SIZES).map((preset) => preset.id).join(', ')}.`);
  }
  // A starter is signed only for the sizes it is laid out for, as the route renders it (custom ids are not known here).
  const starter = getStarterTemplate(input.template, { email: true });
  if (starter) assertTemplateSize({ label: starter.id, sizes: starter.sizes }, SIZES[(input.size ?? DEFAULT_SIZE) as SizeId], { emailTemplates: true });
  const target = normaliseInputUrl(input.url).href;
  const entries: [string, string][] = [[URL_PARAM, target], ...data];
  if (input.size !== undefined && input.size !== 'og') entries.push([SIZE_PARAM, input.size]);

  const canonical = canonicalString(pathname, entries);
  const query = new URLSearchParams(entries);
  query.append(SIG_PARAM, await signCanonical(input.secret, canonical));
  const url = `${input.baseUrl.replace(/\/+$/, '')}${pathname}?${query.toString()}`;

  const check = await verifySignedUrl(new URL(url), input.secret);
  if (!check.ok) throw invalidInput(describeSignedUrlFailure(check.reason), check.reason);
  return { url, canonical };
}

/**
 * Verifies a requested link URL against the site secret. The signature is checked first,
 * over the values exactly as sent; only a correctly signed page address is then normalised,
 * which throws ApiError (400 invalid_request, 403 forbidden) when it is not a public https URL.
 */
export async function verifyLinkUrl(url: URL, secret: string): Promise<LinkVerifyResult> {
  const verified = await verifySignedUrl(url, secret);
  if (!verified.ok) return verified;
  const { [URL_PARAM]: page, [SIZE_PARAM]: size, ...overrides } = verified.params;
  if (Object.hasOwn(overrides, OPEN_PARAM)) return { ok: false, reason: 'open_not_supported' };
  if (page === undefined || page.trim() === '') return { ok: false, reason: 'missing_url' };
  return { ok: true, target: normaliseInputUrl(page), size, overrides };
}

/** The canonical string of a verified request: identifies one link card for one site, whatever the query order. */
export function linkCanonical(url: URL): string {
  return canonicalString(
    url.pathname,
    [...url.searchParams].filter(([name]) => name !== SIG_PARAM),
  );
}

/** Longest page address a link URL can carry (one signed value). */
export const MAX_LINK_TARGET_CHARS = LIMITS.maxDataValueChars;
