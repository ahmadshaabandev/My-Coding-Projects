/**
 * Signed image URLs:
 *
 *   GET {APP_URL}/v1/og/{siteId}/{template}.{ext}?<params>&sig=<hex>
 *
 * sig = lowercase hex HMAC-SHA256(site secret, canonical string), where the
 * canonical string is these lines joined with "\n":
 *
 *   /v1/og/s_abc123/blog.png        <- line 1: the pathname, exactly as requested
 *   author,title                    <- line 2: the parameter names (sig excluded),
 *                                      sorted, joined with ","  (empty if none)
 *   author=Zoë                      <- then one "name=value" line per parameter,
 *   title=Hello world                  in the same order, with DECODED values
 *
 * Signing decoded values is the point of the design: a customer can build the
 * string by plain concatenation in any language, and a crawler that re-orders
 * or re-encodes the query cannot break the signature.
 *
 * Line 2 makes the message unambiguous. Control characters are refused on both
 * sides (buildSignedUrl will not sign them, verifySignedUrl will not accept
 * them), so a URL we accept always has exactly one line per name. A customer
 * whose own signer signs a raw line break inside a value therefore produces a
 * message that no acceptable URL can reproduce: text injected into one value
 * can never turn into an extra signed parameter.
 */
import { LIMITS, SITE_SECRET_PREFIX } from '../config';
import { base64UrlEncode, hmacSha256, hmacSha256Hex, timingSafeEqual } from './crypto';
import { ApiError } from './errors';

/** Carries the signature; never part of the signed message or the template data. */
export const SIG_PARAM = 'sig';
/** Reserved: output size preset (og | square | portrait | email). Signed like any other parameter. */
export const SIZE_PARAM = 'size';

export type OgExtension = 'png' | 'jpg' | 'jpeg' | 'webp';

export interface OgPath {
  siteId: string;
  template: string;
  ext: OgExtension;
}

export type SignedUrlFailure =
  | 'missing_sig'
  | 'malformed_sig'
  | 'bad_param_name'
  | 'duplicate_param'
  | 'bad_value'
  | 'too_many_params'
  | 'url_too_long'
  | 'signature_mismatch';

export type VerifyResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; reason: SignedUrlFailure };

export interface SignedUrlInput {
  /** Origin the URL is served from, e.g. env.APP_URL. */
  baseUrl: string;
  siteId: string;
  template: string;
  ext: OgExtension;
  /** Template data plus the optional reserved `size`. Query order follows insertion order. */
  params: Record<string, string>;
  secret: string;
}

type ParamFailure = Extract<SignedUrlFailure, 'bad_param_name' | 'duplicate_param' | 'bad_value' | 'too_many_params'>;
type Entry = readonly [name: string, value: string];

// Path segments are restricted to characters no URL parser rewrites, so the
// pathname line of the canonical string is identical on every client and server.
const OG_PATH = /^\/v1\/og\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.(png|jpg|jpeg|webp)$/;
const SIG_HEX = /^[0-9a-fA-F]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const FAILURE_MESSAGES: Record<SignedUrlFailure, string> = {
  missing_sig: 'The URL has no "sig" parameter. A signed URL ends with &sig=<64 hexadecimal characters>.',
  malformed_sig: 'The "sig" parameter must be exactly 64 hexadecimal characters (an HMAC-SHA256 digest).',
  bad_param_name: `Parameter names must match ${LIMITS.dataKeyPattern.source} (lowercase letters, digits and "_", starting with a letter).`,
  duplicate_param: 'Each parameter may appear only once in a signed URL.',
  bad_value: `Parameter values may not contain control characters (line breaks, tabs) and may be at most ${LIMITS.maxDataValueChars} characters long.`,
  too_many_params: `A signed URL may carry at most ${LIMITS.maxDataKeys} template parameters.`,
  url_too_long: `A signed URL (path and query) may be at most ${LIMITS.maxSignedUrlChars} characters long.`,
  signature_mismatch:
    'The signature does not match this URL. Check the site secret and that the path and every parameter are signed exactly as they are sent.',
};

/** Plain-English explanation of a verification failure, with the enforced limits filled in. */
export function describeSignedUrlFailure(reason: SignedUrlFailure): string {
  return FAILURE_MESSAGES[reason];
}

/**
 * The message that gets signed. Names are ASCII once validated, so comparing
 * UTF-16 code units here is the same as the documented ascending byte order.
 */
export function canonicalString(pathname: string, params: Iterable<[string, string]>): string {
  const entries = [...params]
    .filter(([name]) => name !== SIG_PARAM)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const names = entries.map(([name]) => name).join(',');
  return [pathname, names, ...entries.map(([name, value]) => `${name}=${value}`)].join('\n');
}

/**
 * Site secrets are derived, never stored: rotating a secret is bumping
 * sites.secret_version, and a database leak exposes no signing keys.
 */
export async function deriveSiteSecret(masterSecret: string, siteId: string, version: number): Promise<string> {
  // Fail closed: with an empty master key every site secret would be publicly computable.
  if (!masterSecret) throw new ApiError('not_configured', 'Signed URLs are not configured on this deployment.');
  return SITE_SECRET_PREFIX + base64UrlEncode(await hmacSha256(masterSecret, `site:${siteId}:${version}`));
}

export function signCanonical(secret: string, canonical: string): Promise<string> {
  return hmacSha256Hex(secret, canonical);
}

export function parseOgPath(pathname: string): OgPath | null {
  const match = OG_PATH.exec(pathname);
  if (!match) return null;
  return { siteId: match[1]!, template: match[2]!, ext: match[3] as OgExtension };
}

function codePointCount(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

/** Length is counted in Unicode code points, which is what len()/mb_strlen() report in other languages. */
function isAcceptableValue(value: string): boolean {
  if (CONTROL_CHARS.test(value)) return false;
  return value.length <= LIMITS.maxDataValueChars || codePointCount(value) <= LIMITS.maxDataValueChars;
}

/** Rules shared by the signer and the verifier, so we never sign a URL we would then refuse. */
function checkParams(entries: readonly Entry[]): ParamFailure | null {
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!LIMITS.dataKeyPattern.test(name)) return 'bad_param_name';
    if (seen.has(name)) return 'duplicate_param';
    seen.add(name);
    if (!isAcceptableValue(value)) return 'bad_value';
  }
  // `size` is not template data, so it does not use up one of the data keys.
  const dataKeys = seen.size - (seen.has(SIZE_PARAM) ? 1 : 0);
  return dataKeys > LIMITS.maxDataKeys ? 'too_many_params' : null;
}

function invalidInput(message: string, reason: string): ApiError {
  return new ApiError('invalid_request', message, { details: { reason } });
}

/** Builds a signed URL. The query keeps the caller's parameter order and ends with sig. */
export async function buildSignedUrl(input: SignedUrlInput): Promise<string> {
  const pathname = `/v1/og/${input.siteId}/${input.template}.${input.ext}`;
  if (!parseOgPath(pathname)) {
    throw invalidInput('Site id and template name may only contain letters, digits, "_" and "-".', 'bad_path');
  }
  const entries = Object.entries(input.params);
  if (entries.some(([name]) => name === SIG_PARAM)) {
    throw invalidInput(`"${SIG_PARAM}" is reserved for the signature and cannot be used as a parameter.`, 'reserved_param');
  }
  const failure = checkParams(entries);
  if (failure) throw invalidInput(describeSignedUrlFailure(failure), failure);

  const query = new URLSearchParams(entries);
  query.append(SIG_PARAM, await signCanonical(input.secret, canonicalString(pathname, entries)));
  const pathAndQuery = `${pathname}?${query.toString()}`;
  if (pathAndQuery.length > LIMITS.maxSignedUrlChars) {
    throw invalidInput(describeSignedUrlFailure('url_too_long'), 'url_too_long');
  }
  return input.baseUrl.replace(/\/+$/, '') + pathAndQuery;
}

/**
 * Verifies a requested URL against a site secret. On success `params` holds
 * every decoded parameter except sig (template data plus `size`, if present).
 */
export async function verifySignedUrl(url: URL, secret: string): Promise<VerifyResult> {
  if (url.pathname.length + url.search.length > LIMITS.maxSignedUrlChars) return { ok: false, reason: 'url_too_long' };

  const signatures = url.searchParams.getAll(SIG_PARAM);
  if (signatures.length === 0) return { ok: false, reason: 'missing_sig' };
  if (signatures.length > 1) return { ok: false, reason: 'duplicate_param' };
  const signature = signatures[0]!;
  if (!SIG_HEX.test(signature)) return { ok: false, reason: 'malformed_sig' };

  const entries = [...url.searchParams].filter(([name]) => name !== SIG_PARAM);
  const failure = checkParams(entries);
  if (failure) return { ok: false, reason: failure };

  const expected = await signCanonical(secret, canonicalString(url.pathname, entries));
  if (!timingSafeEqual(expected, signature.toLowerCase())) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true, params: Object.fromEntries(entries) };
}
