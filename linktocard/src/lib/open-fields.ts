/**
 * Open fields: signed card URLs that an email platform personalises for every recipient.
 *
 *   GET /v1/og/s_abc123/email-banner.png?title=Spring+picks&open=name&name_default=there&sig=<hex>&name=Maya
 *
 * `open` lists up to EMAIL_FIELDS.maxOpenFields template fields whose values are NOT signed, so
 * a merge tag can stand in for them and the platform fills in each recipient's value. The rest
 * of the URL is signed exactly as before (src/lib/signed-url.ts): `open` itself and every
 * `<field>_default` are ordinary signed parameters, and the open fields are simply left out of
 * the canonical string, name and value. So the signed message of an open-fields URL is the one of
 * the same URL without its open fields, and every existing signer (the dashboard, the examples in
 * examples/signing) works unchanged: sign without the open fields, then append them, last.
 *
 * What an unsigned value can do is kept small on purpose:
 *   - after NFKC it may only hold letters, combining marks, digits, spaces and . , ' - ! ? & @ #,
 *     at most EMAIL_FIELDS.maxValueChars characters, and at least one letter or digit. Anything
 *     else (a merge tag the platform did not fill in, markup, a URL, emoji, line breaks) is not
 *     an error: the field shows its signed `<field>_default`, or nothing. A broken image in an
 *     email that was already sent cannot be fixed, a default can be lived with.
 *   - by default its letters must also be ones the bundled fonts draw (Latin, Greek, Cyrillic,
 *     Vietnamese): the renderer draws any other script as empty boxes, and "Hi there," reads
 *     better than a row of boxes. OpenValueScripts 'any' lifts that for an account whose own
 *     fonts draw more.
 *   - with no ":" "/" ";" "(" or "<" it cannot become a URL, a CSS declaration or markup, wherever
 *     the template uses the field.
 *   - it cannot add, change or remove a signed parameter: every other name in the query is in
 *     the signed message, and `open` (which names the unsigned ones) is too.
 *   - it can vary the cache key, which is what costs units: the route caps the unique images it
 *     renders per site and UTC day (reserveOpenFieldRender, EMAIL_FIELDS.maxUniqueRendersPerDay;
 *     every request for one image shares its slot), and identical values are the same card and
 *     hit the cache. Each unique image is charged once ("Charge once" below): a copy rendered
 *     again after its stored period ended is free.
 *
 * A URL without `open` takes verifySignedUrl itself, untouched: it verifies exactly as before.
 */
import { effectivePlanId } from '../billing/plans';
import { DAY_MS, EMAIL_FIELDS, LIMITS } from '../config';
import { limitsDisabled } from '../inspect/limits';
import { parseTemplate } from '../render/template';
import type { Env, UserRow } from '../types';
import { ApiError } from './errors';
import { codePointLength } from './http';
import {
  SIG_PARAM,
  SIZE_PARAM,
  buildSignedUrl,
  canonicalString,
  describeSignedUrlFailure,
  verifySignedUrl,
  type SignedUrlFailure,
  type SignedUrlInput,
  type VerifyResult,
} from './signed-url';

/** Reserved: the comma list of fields an email platform fills in. Signed like any other parameter. */
export const OPEN_PARAM = 'open';
/** `<field>_default` holds the signed fallback of an open field. */
export const DEFAULT_SUFFIX = '_default';
/** Names that are never template data in a signed URL once open fields are on. */
export const OPEN_RESERVED_PARAMS: readonly string[] = [SIG_PARAM, SIZE_PARAM, OPEN_PARAM];

export type OpenFieldsFailure = SignedUrlFailure | 'bad_open_list' | 'too_many_open_fields' | 'reserved_open_field';

/**
 * verifySignedUrl's result, plus what the route needs to treat a personalised card differently.
 * For a URL without `open`, `ok`/`params`/`reason` are verifySignedUrl's own; `openFields` is
 * empty and `fallbackParams` equals `params`.
 */
export type OpenFieldsVerifyResult =
  | {
      ok: true;
      /** Template data plus `size`, like verifySignedUrl; open fields hold their accepted value or default. */
      params: Record<string, string>;
      /** The open fields in the order `open` lists them. */
      openFields: string[];
      /** `params` with every open field at its default: the card to fall back to when the site's daily cap is used up. */
      fallbackParams: Record<string, string>;
    }
  | { ok: false; reason: OpenFieldsFailure };

export type OpenFieldsVerified = Extract<OpenFieldsVerifyResult, { ok: true }>;

const RESERVED = new Set(OPEN_RESERVED_PARAMS);

const OPEN_FAILURE_MESSAGES: Record<Exclude<OpenFieldsFailure, SignedUrlFailure>, string> = {
  bad_open_list: `"${OPEN_PARAM}" must be a comma-separated list of field names (lowercase letters, digits and "_", starting with a letter), each listed once and without spaces, for example open=name,city.`,
  too_many_open_fields: `"${OPEN_PARAM}" may list at most ${EMAIL_FIELDS.maxOpenFields} fields.`,
  reserved_open_field: `"${SIG_PARAM}", "${SIZE_PARAM}" and "${OPEN_PARAM}" cannot be open fields, and neither can a name ending in "${DEFAULT_SUFFIX}" (that suffix holds a field's default).`,
};

/** Plain-English explanation of a failure, for the invalid_signature error. */
export function describeOpenFieldsFailure(reason: OpenFieldsFailure): string {
  return reason in OPEN_FAILURE_MESSAGES
    ? OPEN_FAILURE_MESSAGES[reason as keyof typeof OPEN_FAILURE_MESSAGES]
    : describeSignedUrlFailure(reason as SignedUrlFailure);
}

/* ------------------------------------------------------------------ */
/* The open list and its values                                        */
/* ------------------------------------------------------------------ */

export type OpenListResult = { ok: true; fields: string[] } | { ok: false; reason: Exclude<OpenFieldsFailure, SignedUrlFailure> };

/** Parses the value of `open`. Strict on purpose: it is signed, so there is nothing to be lenient about. */
export function parseOpenList(value: string): OpenListResult {
  const names = value.split(',');
  // Counted first, so a 4 KB list of commas is refused before anything else is looked at.
  if (names.length > EMAIL_FIELDS.maxOpenFields) return { ok: false, reason: 'too_many_open_fields' };
  const seen = new Set<string>();
  for (const name of names) {
    if (!LIMITS.dataKeyPattern.test(name) || seen.has(name)) return { ok: false, reason: 'bad_open_list' };
    if (RESERVED.has(name) || name.endsWith(DEFAULT_SUFFIX)) return { ok: false, reason: 'reserved_open_field' };
    seen.add(name);
  }
  return { ok: true, fields: names };
}

/**
 * Every character an accepted value may hold, after NFKC: letters, combining marks, decimal digits,
 * space and . , ' - ! ? & @ #. None of them can start a URL scheme, a path, a CSS declaration or a tag.
 */
const ALLOWED_VALUE = /^[\p{L}\p{M}\p{Nd} .,'!?&@#-]+$/u;
/**
 * The code points the bundled fonts really draw, measured with the renderer: the unicode-range of
 * each subset in src/render/fonts (Inter latin, latin-ext, cyrillic, greek, vietnamese; Source
 * Serif 4 and JetBrains Mono cover less, and fall back to Inter) minus the 349 characters of those
 * ranges that Inter has no glyph for (some IPA letters, archaic Greek, Latin Extended-C and -D,
 * the phonetic extensions, U+1E9C). Only letters, marks and digits matter here: ALLOWED_VALUE
 * already limits the rest to ASCII. tests/email-templates.test.ts renders every letter this admits
 * and fails if the renderer reports one missing.
 */
const BUNDLED_FONT_CHARS = new RegExp(
  '^[' +
    [
      '\\u0000-\\u0254\\u0256-\\u027b\\u027e-\\u0284\\u0286-\\u0290\\u0292-\\u02a4\\u02a6-\\u02cc\\u02ce-\\u02d7\\u02da\\u02dc-\\u02ff', // Latin, Latin-1, Latin Extended-A/B, IPA, modifiers
      '\\u0300\\u0301\\u0303\\u0304\\u0308\\u0309\\u0323\\u0329', // the combining marks Inter draws; NFKC composes most accents into the letters above
      '\\u0374-\\u0376\\u037a-\\u037f\\u0384-\\u038a\\u038c\\u038e-\\u03a1\\u03a3-\\u03d7\\u03dc\\u03dd\\u03f0-\\u03f6\\u03f9\\u03fa\\u03fc-\\u03ff', // Greek
      '\\u0400-\\u045f\\u0490\\u0491\\u04b0\\u04b1', // Cyrillic
      '\\u1e00-\\u1e9b\\u1e9d-\\u1eff', // Latin Extended Additional (Vietnamese)
    ].join('') +
    ']*$',
  'u',
);

/**
 * Which letters an open value may use. 'bundled': only what the bundled fonts draw, anything else
 * falls back to the default. 'any': every script, for an account whose own fonts cover more.
 */
export type OpenValueScripts = 'bundled' | 'any';
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
/** Typographic apostrophes and the Unicode hyphen, which phone keyboards insert and NFKC keeps. */
const CURLY_APOSTROPHES = /[\u2018\u2019]/g;
const UNICODE_HYPHEN = /\u2010/g;

/**
 * The value an open field shows, or null when the raw value is not acceptable and the default
 * applies. NFKC first, so full-width letters, ligatures and no-break spaces become their plain
 * forms; then runs of spaces collapse and the ends are trimmed, so " Maya " and "Maya" are the
 * same card (and the same cache entry).
 */
export function normaliseOpenValue(raw: string, scripts: OpenValueScripts = 'bundled'): string | null {
  const value = raw
    .normalize('NFKC')
    .replace(CURLY_APOSTROPHES, "'")
    .replace(UNICODE_HYPHEN, '-')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (value === '' || codePointLength(value) > EMAIL_FIELDS.maxValueChars) return null;
  if (!ALLOWED_VALUE.test(value) || !LETTER_OR_DIGIT.test(value)) return null;
  return scripts === 'any' || BUNDLED_FONT_CHARS.test(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/**
 * Splits the raw query into the signed part and the open fields' raw values. Segments are kept
 * byte for byte, so the signed part verifies against the very pathname and parameters that were
 * requested; each one is decoded exactly as URLSearchParams decodes it inside the full query
 * (the leading "&" stops URLSearchParams from dropping a "?" that starts a segment).
 */
function splitQuery(search: string, open: ReadonlySet<string>): { signedSearch: string; values: Map<string, string> } | null {
  const kept: string[] = [];
  const values = new Map<string, string>();
  const query = search.startsWith('?') ? search.slice(1) : search;
  for (const segment of query === '' ? [] : query.split('&')) {
    const entry = new URLSearchParams(`&${segment}`).entries().next();
    if (!entry.done && open.has(entry.value[0])) {
      if (values.has(entry.value[0])) return null;
      values.set(entry.value[0], entry.value[1]);
    } else {
      kept.push(segment);
    }
  }
  return { signedSearch: kept.join('&'), values };
}

const own = (params: Record<string, string>, key: string): string | undefined => (Object.hasOwn(params, key) ? params[key] : undefined);

/** verifySignedUrl's result in this module's shape: no open fields, and the defaults are the params. */
export function asOpenFieldsResult(plain: VerifyResult): OpenFieldsVerifyResult {
  return plain.ok ? { ok: true, params: plain.params, openFields: [], fallbackParams: plain.params } : plain;
}

/**
 * Verifies a requested card URL that may carry open fields. Without `open`, or with an `open`
 * that is not a list of field names but is signed as ordinary data, this is
 * verifySignedUrl(url, secret). With a list, the URL minus its open fields must verify with
 * verifySignedUrl, every limit included: the 4096-character cap applies to that signed part,
 * and the open values, which never fail verification, only have to pass normaliseOpenValue.
 */
export async function verifyWithOpenFields(url: URL, secret: string, options: { scripts?: OpenValueScripts } = {}): Promise<OpenFieldsVerifyResult> {
  const lists = url.searchParams.getAll(OPEN_PARAM);
  if (lists.length === 0) return asOpenFieldsResult(await verifySignedUrl(url, secret));
  if (lists.length > 1) return { ok: false, reason: 'duplicate_param' };
  const list = parseOpenList(lists[0]!);
  if (!list.ok) {
    // Not a list of fields: a URL whose whole query, "open" included, is signed as ordinary data
    // (signed while EMAIL_FIELDS_ENABLED was off, when "open" was a plain parameter) keeps that
    // meaning, so turning the switch on does not break it (security review SEC-6). Any other URL
    // gets the reason its list is wrong.
    const plain = await verifySignedUrl(url, secret);
    return plain.ok ? asOpenFieldsResult(plain) : list;
  }

  const split = splitQuery(url.search, new Set(list.fields));
  if (!split) return { ok: false, reason: 'duplicate_param' };
  const signedUrl = new URL(url.href);
  // The setter drops exactly one leading "?"; the one added here keeps a "?" the query itself starts with.
  signedUrl.search = `?${split.signedSearch}`;
  const verified = await verifySignedUrl(signedUrl, secret);
  if (!verified.ok) return verified;

  const defaults = new Set(list.fields.map((field) => field + DEFAULT_SUFFIX));
  const params: Record<string, string> = {};
  const fallbackParams: Record<string, string> = {};
  for (const [name, value] of Object.entries(verified.params)) {
    if (name === OPEN_PARAM || defaults.has(name)) continue;
    params[name] = value;
    fallbackParams[name] = value;
  }
  for (const field of list.fields) {
    const fallback = own(verified.params, field + DEFAULT_SUFFIX) ?? '';
    const raw = split.values.get(field);
    params[field] = (raw === undefined ? null : normaliseOpenValue(raw, options.scripts)) ?? fallback;
    fallbackParams[field] = fallback;
  }
  // The template data, open fields included, stays within the documented number of keys.
  if (Object.keys(params).filter((name) => name !== SIZE_PARAM).length > LIMITS.maxDataKeys) return { ok: false, reason: 'too_many_params' };
  return { ok: true, params, openFields: list.fields, fallbackParams };
}

/* ------------------------------------------------------------------ */
/* Template fields                                                     */
/* ------------------------------------------------------------------ */

/** Isolate-wide memo of placeholder names by template identity (a starter id, or a custom id and version). */
const fieldMemo = new Map<string, ReadonlySet<string>>();
const FIELD_MEMO_ENTRIES = 256;

/**
 * The data fields of a template: the {{placeholders}} of its HTML, exactly as the renderer finds
 * them. A template that does not parse has none (its render fails on its own, with the real error).
 */
export function templateFields(template: { identity: string; html: string; css: string }): ReadonlySet<string> {
  const cached = fieldMemo.get(template.identity);
  if (cached) return cached;
  let fields: ReadonlySet<string>;
  try {
    fields = new Set(parseTemplate(template.html, template.css).placeholders);
  } catch {
    return new Set();
  }
  if (fieldMemo.size >= FIELD_MEMO_ENTRIES) fieldMemo.clear();
  fieldMemo.set(template.identity, fields);
  return fields;
}

/**
 * Drops open fields that are not fields of the template: they would draw nothing, and their
 * per-recipient values would still make every recipient a new cache key, a new render and a
 * unit. Dropped rather than refused, so that editing a template cannot break emails that were
 * already sent; the signer (buildOpenFieldsUrl) refuses them up front.
 */
export function keepTemplateOpenFields(verified: OpenFieldsVerified, fields: ReadonlySet<string>): OpenFieldsVerified {
  const unknown = verified.openFields.filter((field) => !fields.has(field));
  if (unknown.length === 0) return verified;
  const drop = (params: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(params).filter(([name]) => !unknown.includes(name)));
  return {
    ok: true,
    params: drop(verified.params),
    openFields: verified.openFields.filter((field) => fields.has(field)),
    fallbackParams: drop(verified.fallbackParams),
  };
}

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

export interface OpenFieldsUrlInput extends SignedUrlInput {
  /** Fields the email platform fills in. Their values must not be in `params`; `<field>_default` may be. */
  open: readonly string[];
  /** When given, every open field must be one of these (templateFields of the template signed for). */
  templateFields?: ReadonlySet<string>;
}

function invalidInput(message: string, reason: string): ApiError {
  return new ApiError('invalid_request', message, { details: { reason } });
}

/**
 * Builds a signed URL with open fields: signed with buildSignedUrl exactly like any other card
 * URL, with `open` among its parameters, then each open field appended with an empty value, last,
 * after sig. The empty value is where the platform's merge tag goes; left empty, the default shows.
 * Last, because a value an email platform inserts without encoding it can contain "#", which ends
 * the query: with the open fields at the end, it can only cut short their own values.
 */
export async function buildOpenFieldsUrl(input: OpenFieldsUrlInput): Promise<{ url: string; canonical: string }> {
  const { open, templateFields: fields, ...signed } = input;
  const list = parseOpenList(open.join(','));
  if (!list.ok) throw invalidInput(describeOpenFieldsFailure(list.reason), list.reason);
  if (Object.hasOwn(signed.params, OPEN_PARAM)) {
    throw invalidInput(`"${OPEN_PARAM}" is set from the list of open fields; do not send it as a parameter as well.`, 'reserved_param');
  }
  for (const field of list.fields) {
    if (Object.hasOwn(signed.params, field)) {
      throw invalidInput(
        `"${field}" is an open field: its value comes from the email platform and is not signed. Put a fallback in "${field}${DEFAULT_SUFFIX}" instead.`,
        'open_field_value',
      );
    }
    if (fields && !fields.has(field)) {
      throw invalidInput(`"${field}" is not a field of template "${signed.template}", so it cannot be an open field.`, 'unknown_open_field');
    }
  }
  // The same count verifyWithOpenFields makes: the template data once the defaults are consumed.
  const defaults = new Set(list.fields.map((field) => field + DEFAULT_SUFFIX));
  const dataKeys = Object.keys(signed.params).filter((name) => name !== SIZE_PARAM && !defaults.has(name)).length;
  if (dataKeys + list.fields.length > LIMITS.maxDataKeys) throw invalidInput(describeSignedUrlFailure('too_many_params'), 'too_many_params');

  const params = { ...signed.params, [OPEN_PARAM]: list.fields.join(',') };
  const url = await buildSignedUrl({ ...signed, params });
  return {
    url: url + list.fields.map((field) => `&${field}=`).join(''),
    canonical: canonicalString(new URL(url).pathname, Object.entries(params)),
  };
}

/* ------------------------------------------------------------------ */
/* Caching and the daily cap                                           */
/* ------------------------------------------------------------------ */

/**
 * Cache-Control of a card served from a URL with open fields. Email clients and their image
 * proxies may fetch the same image again on every open; a long lifetime lets them reuse it. It is
 * never longer than the stored image's own expiry, the period the plan's render was paid for.
 */
export function openFieldsCacheControl(expiresAt: number, now: number): string {
  return `public, max-age=${Math.max(0, Math.min(EMAIL_FIELDS.maxAgeSeconds, Math.floor((expiresAt - now) / 1000)))}`;
}

/*
 * The daily cap counts unique images, not requests (audit CHG-1). Every image (its card cache key)
 * that a site renders with open fields on a UTC day holds one slot: a tool_usage row
 * "emailr:{site id}:{day}:{cache key}", kept until the end of the next UTC day and then removed by
 * the daily cleanup of expired tool_usage rows (src/lib/cleanup.ts). The site's usage of the day
 * is the number of those rows, and the cap is EMAIL_FIELDS.maxUniqueRendersPerDay of them.
 *
 * Every request for an image that is not stored takes or shares that image's slot in one D1
 * statement (TAKE_SLOT_SQL), which is atomic: requests for different images can never pass the
 * cap together, and every request for an image that already holds a slot of the day is let
 * through, however many arrive at once, so simultaneous first opens of one value hold one slot.
 * The row's count is the number of requests holding the slot. A request that rendered nothing
 * (its render failed, or another request stored the image first) gives its hold back, and the
 * slot is freed with the last hold (RELEASE_SLOT_SQL), so a slot stays taken exactly when a
 * request for that image rendered it, or is still rendering it.
 */
const RENDER_PREFIX = 'emailr:';

/**
 * The slots of a site's unique open-field renders on the UTC day of `now` lie strictly between
 * these two buckets: ";" follows ":", and site ids and day numbers hold neither, so no other
 * site's or day's row (and no other kind of tool_usage row) falls in between.
 */
export function openRenderRange(siteId: string, now: number): { from: string; to: string } {
  const day = `${RENDER_PREFIX}${siteId}:${Math.floor(now / DAY_MS)}`;
  return { from: `${day}:`, to: `${day};` };
}

/** tool_usage bucket of one image's slot among a site's unique open-field renders of the UTC day of `now`. */
export function openRenderBucket(siteId: string, now: number, cacheKey: string): string {
  return `${openRenderRange(siteId, now).from}${cacheKey}`;
}

/** The unique open-field renders a site has used on the UTC day of `now`: images rendered, or being rendered. */
export async function openRendersUsed(db: D1Database, siteId: string, now: number): Promise<number> {
  const { from, to } = openRenderRange(siteId, now);
  const row = await db.prepare('SELECT COUNT(*) AS used FROM tool_usage WHERE bucket > ?1 AND bucket < ?2').bind(from, to).first<{ used: number }>();
  return row?.used ?? 0;
}

// ?1 the image's slot, ?2 its expiry, ?3 and ?4 the site's slots of the day (openRenderRange), ?5 the limit.
// The SELECT yields the row when the image holds a slot already, or when the day has a free one;
// the image's own row then conflicts (shared: one more hold) or is new (taken). No row: refused.
const TAKE_SLOT_SQL = `INSERT INTO tool_usage (bucket, count, expires_at)
  SELECT ?1, 1, ?2
  WHERE EXISTS (SELECT 1 FROM tool_usage WHERE bucket = ?1)
    OR (SELECT COUNT(*) FROM tool_usage WHERE bucket > ?3 AND bucket < ?4) < ?5
  ON CONFLICT (bucket) DO UPDATE SET count = tool_usage.count + 1
  RETURNING count`;
// Gives one hold back; the last one frees the slot. Run as one batch, which D1 runs as one transaction.
const RELEASE_SLOT_SQL = ['DELETE FROM tool_usage WHERE bucket = ?1 AND count <= 1', 'UPDATE tool_usage SET count = count - 1 WHERE bucket = ?1'] as const;

export interface OpenRenderReservation {
  /** False when the site already used its unique renders for the day on other images: nothing was taken. */
  allowed: boolean;
  limit: number;
  /**
   * Gives this request's hold on the image's slot back: call it when the request rendered nothing
   * (the render failed, or the image was found stored after all). The slot is freed only when no
   * other request for the image holds it. Safe to call twice; never throws.
   */
  release: () => Promise<void>;
}

const nothingToRelease = async (): Promise<void> => {};

/**
 * Takes the slot of one image (`cacheKey`) among the site's unique open-field renders of this UTC
 * day, or shares it when the image holds one already, before a render of an image that is not in
 * the cache. Cached cards are never counted (call this only on a cache miss), which is what makes
 * it a cap on unique renders rather than on opens; requests are not counted either, images are.
 */
export async function reserveOpenFieldRender(
  env: Pick<Env, 'DB' | 'ENVIRONMENT' | 'RATE_LIMITS_DISABLED'>,
  siteId: string,
  cacheKey: string,
  owner: Pick<UserRow, 'plan' | 'cancel_at'>,
  now: number,
): Promise<OpenRenderReservation> {
  const limit = EMAIL_FIELDS.maxUniqueRendersPerDay[effectivePlanId(owner, now)];
  if (limitsDisabled(env)) return { allowed: true, limit, release: nothingToRelease };
  if (limit <= 0) return { allowed: false, limit, release: nothingToRelease };
  const { from, to } = openRenderRange(siteId, now);
  const bucket = openRenderBucket(siteId, now, cacheKey);
  // The window ends at the next UTC midnight; the row outlives it by a day, like the PDF guard's.
  const expiresAt = (Math.floor(now / DAY_MS) + 2) * DAY_MS;
  const row = await env.DB.prepare(TAKE_SLOT_SQL).bind(bucket, expiresAt, from, to, limit).first<{ count: number }>();
  if (!row) return { allowed: false, limit, release: nothingToRelease };

  let released = false;
  return {
    allowed: true,
    limit,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await env.DB.batch(RELEASE_SLOT_SQL.map((sql) => env.DB.prepare(sql).bind(bucket)));
      } catch (error) {
        console.error('releasing an open-field render failed:', error);
      }
    },
  };
}

/** 429 for a route that prefers an error to the default card once the daily cap is used up. */
export function openFieldsCapError(limit: number, now: number): ApiError {
  const retryAfter = Math.max(1, Math.ceil(((Math.floor(now / DAY_MS) + 1) * DAY_MS - now) / 1000));
  return new ApiError(
    'rate_limited',
    `This site has rendered ${limit} personalised images with open fields today, the daily limit of its plan. ` +
      'Images that were already rendered keep working; new values render again after 00:00 UTC.',
    { headers: { 'retry-after': String(retryAfter) }, details: { limit, period_seconds: DAY_MS / 1000 } },
  );
}

/* ------------------------------------------------------------------ */
/* Charge once                                                         */
/* ------------------------------------------------------------------ */

/*
 * An email image (a card served from a URL with open fields) is charged once. The first render of
 * a unique image (its card cache key: account, template identity, signed data, open-field values
 * after normaliseOpenValue, size, format and watermark) is charged 1 image and stored for the
 * plan's cache days; every later request is served from the edge cache or R2 at no charge. Once
 * that stored copy has expired, the next request renders and stores it again WITHOUT a new charge,
 * as long as the charge is remembered here: one tool_usage row per charged image, kept
 * EMAIL_FIELDS.chargeMemoryDays from the charge (the bucket holds the account id and the cache
 * key, a one-way hash; no text of the card). The row is written only inside the D1 batch that
 * takes the image (src/lib/quota.ts CHARGE_RECORD_*, from RenderCharge.chargeRecord), so it exists
 * if and only if the image was taken; never from a ledger row, which says 'plan' from its claim,
 * before anything is taken. Expired rows go with the daily cleanup of tool_usage,
 * an account's rows with the account (src/lib/cleanup.ts). Re-renders still take one of the site's
 * unique renders of the day (reserveOpenFieldRender), so the CPU they cost stays capped.
 */
const CHARGE_PREFIX = 'emailpaid:';

/** tool_usage bucket that remembers one charged email image of an account. */
export function emailChargeBucket(userId: string, cacheKey: string): string {
  return `${CHARGE_PREFIX}${userId}:${cacheKey}`;
}

/** Every bucket of one account lies strictly between these two (";" follows ":"; ids hold neither). */
export function emailChargeRange(userId: string): { from: string; to: string } {
  return { from: `${CHARGE_PREFIX}${userId}:`, to: `${CHARGE_PREFIX}${userId};` };
}

/** True while the account's charge for this image is remembered: a render of it now is free. */
export async function hasEmailCharge(db: D1Database, userId: string, cacheKey: string, now: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS paid FROM tool_usage WHERE bucket = ?1 AND expires_at > ?2').bind(emailChargeBucket(userId, cacheKey), now).first<{ paid: number }>();
  return row !== null;
}
