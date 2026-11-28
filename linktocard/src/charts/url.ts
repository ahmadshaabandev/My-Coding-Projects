// Signed chart URLs:
//
//   GET {APP_URL}/v1/chart/{siteId}.{png|jpg|jpeg|webp}?c=<chart JSON>&sig=<hex>
//
// Signed with the site's secret by the recipe of card URLs (src/lib/signed-url.ts): lowercase hex
// HMAC-SHA256 over these lines joined with "\n":
//
//   /v1/chart/s_abc123.png          the pathname, exactly as requested
//   c                               the parameter names, sorted, joined with ","
//   c={"type":"bar",...}            one "name=value" line per parameter, with the DECODED value
//
// so a customer's signing code for card URLs signs chart URLs unchanged. There is exactly one
// parameter, "c": the chart JSON as text, on one line. Nothing else is accepted in the query, and
// nothing in a chart URL is unsigned (there are no open fields).
import { CHARTS } from '../config'
import { timingSafeEqual } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { SIG_PARAM, canonicalString, describeSignedUrlFailure, signCanonical, type OgExtension, type SignedUrlFailure } from '../lib/signed-url'

/** The one parameter of a chart URL: the chart JSON. */
export const CHART_PARAM = 'c'

export interface ChartPath {
  siteId: string
  ext: OgExtension
}

export type ChartUrlFailure = Extract<SignedUrlFailure, 'missing_sig' | 'malformed_sig' | 'duplicate_param' | 'bad_value' | 'url_too_long' | 'signature_mismatch'> | 'unknown_param' | 'missing_chart'

export type ChartUrlResult = { ok: true; chartJson: string } | { ok: false; reason: ChartUrlFailure }

// The site id is restricted to characters no URL parser rewrites, as in a card URL's path.
const CHART_PATH = /^\/v1\/chart\/([A-Za-z0-9_-]{1,64})\.(png|jpg|jpeg|webp)$/
const SIG_HEX = /^[0-9a-fA-F]{64}$/
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]')

const OWN_MESSAGES: Partial<Record<ChartUrlFailure, string>> = {
  unknown_param: `A signed chart URL takes two parameters only: "${CHART_PARAM}" (the chart JSON) and "${SIG_PARAM}".`,
  missing_chart: `The URL has no "${CHART_PARAM}" parameter. It carries the chart JSON.`,
  bad_value: `The chart JSON in "${CHART_PARAM}" must be on one line: no line breaks, tabs or other control characters outside its strings (JSON.stringify writes it that way).`,
  url_too_long: `A signed chart URL (path and query) may be at most ${CHARTS.maxSignedUrlChars} characters long. For a larger chart use POST /v1/charts.`,
}

/** Plain-English explanation of a verification failure, with the enforced limits filled in. */
export function describeChartUrlFailure(reason: ChartUrlFailure): string {
  return OWN_MESSAGES[reason] ?? describeSignedUrlFailure(reason as SignedUrlFailure)
}

export function parseChartPath(pathname: string): ChartPath | null {
  const match = CHART_PATH.exec(pathname)
  return match ? { siteId: match[1]!, ext: match[2] as OgExtension } : null
}

/** Rules shared by the signer and the verifier, so we never sign a URL we would then refuse. */
function chartValueFailure(chartJson: string): Extract<ChartUrlFailure, 'bad_value'> | null {
  return CONTROL_CHARS.test(chartJson) ? 'bad_value' : null
}

export interface ChartUrlInput {
  /** Origin the URL is served from, e.g. env.APP_URL. */
  baseUrl: string
  siteId: string
  ext: OgExtension
  /** The chart JSON as text, on one line (JSON.stringify of the chart). */
  chartJson: string
  secret: string
}

/** Builds a signed chart URL. Throws 400 invalid_request for one the verifier would refuse. */
export async function buildChartUrl(input: ChartUrlInput): Promise<string> {
  const invalid = (message: string, reason: string): ApiError => new ApiError('invalid_request', message, { details: { reason } })
  const pathname = `/v1/chart/${input.siteId}.${input.ext}`
  if (!parseChartPath(pathname)) throw invalid('A site id may only contain letters, digits, "_" and "-".', 'bad_path')
  const failure = chartValueFailure(input.chartJson)
  if (failure) throw invalid(describeChartUrlFailure(failure), failure)

  const query = new URLSearchParams([[CHART_PARAM, input.chartJson]])
  query.append(SIG_PARAM, await signCanonical(input.secret, canonicalString(pathname, [[CHART_PARAM, input.chartJson]])))
  const pathAndQuery = `${pathname}?${query.toString()}`
  if (pathAndQuery.length > CHARTS.maxSignedUrlChars) throw invalid(describeChartUrlFailure('url_too_long'), 'url_too_long')
  return input.baseUrl.replace(/\/+$/, '') + pathAndQuery
}

/**
 * Verifies a requested chart URL against a site secret. Nothing of the chart is parsed here: on
 * success `chartJson` is the signed text, still unvalidated.
 */
export async function verifyChartUrl(url: URL, secret: string): Promise<ChartUrlResult> {
  if (url.pathname.length + url.search.length > CHARTS.maxSignedUrlChars) return { ok: false, reason: 'url_too_long' }

  const entries = [...url.searchParams]
  if (entries.some(([name]) => name !== SIG_PARAM && name !== CHART_PARAM)) return { ok: false, reason: 'unknown_param' }
  const signatures = url.searchParams.getAll(SIG_PARAM)
  if (signatures.length === 0) return { ok: false, reason: 'missing_sig' }
  const charts = url.searchParams.getAll(CHART_PARAM)
  if (signatures.length > 1 || charts.length > 1) return { ok: false, reason: 'duplicate_param' }
  const signature = signatures[0]!
  if (!SIG_HEX.test(signature)) return { ok: false, reason: 'malformed_sig' }
  if (charts.length === 0) return { ok: false, reason: 'missing_chart' }
  const chartJson = charts[0]!
  const failure = chartValueFailure(chartJson)
  if (failure) return { ok: false, reason: failure }

  const expected = await signCanonical(secret, canonicalString(url.pathname, [[CHART_PARAM, chartJson]]))
  if (!timingSafeEqual(expected, signature.toLowerCase())) return { ok: false, reason: 'signature_mismatch' }
  return { ok: true, chartJson }
}
