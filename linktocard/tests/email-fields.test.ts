// Open fields for email images (src/lib/open-fields.ts): a URL without "open" verifies exactly as
// before, open values are filled in without breaking the signature, every signed parameter still
// is signed, values are normalised or fall back to their default, and the daily cap counts in D1.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import vector from '../examples/signing/vector.json';
import { DAY_MS, EMAIL_FIELDS, LIMITS } from '../src/config';
import { first, run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import { cardCacheKey, type ResolvedTemplate } from '../src/lib/images';
import {
  DEFAULT_SUFFIX,
  OPEN_PARAM,
  OPEN_RESERVED_PARAMS,
  buildOpenFieldsUrl,
  describeOpenFieldsFailure,
  keepTemplateOpenFields,
  normaliseOpenValue,
  openFieldsCacheControl,
  openFieldsCapError,
  openRenderBucket,
  parseOpenList,
  reserveOpenFieldRender,
  templateFields,
  verifyWithOpenFields,
  type OpenFieldsFailure,
  type OpenFieldsVerifyResult,
} from '../src/lib/open-fields';
import {
  SIG_PARAM,
  SIZE_PARAM,
  buildSignedUrl,
  canonicalString,
  describeSignedUrlFailure,
  signCanonical,
  verifySignedUrl,
  type VerifyResult,
} from '../src/lib/signed-url';
import { emailBanner } from '../src/render/templates/email-banner';
import { emailOffer } from '../src/render/templates/email-offer';
import type { UserRow } from '../src/types';

const SECRET = 'ltcs_test_site_secret_for_open_field_tests_only';
const OTHER_SECRET = 'ltcs_some_other_site_secret_for_open_field_tests';
const BASE = 'https://linktocard.test';
const SITE = 's_open123';
const PATH = `/v1/og/${SITE}/email-banner.png`;

/** What a customer's own signer does: sign the decoded entries, then write any raw query. */
async function signedByHand(rawQuery: string, decoded: Record<string, string>, path = PATH, secret = SECRET): Promise<string> {
  const sig = await signCanonical(secret, canonicalString(path, Object.entries(decoded)));
  return `${BASE}${path}?${rawQuery}${rawQuery ? '&' : ''}sig=${sig}`;
}

async function verify(url: string | URL, secret = SECRET): Promise<OpenFieldsVerifyResult> {
  return verifyWithOpenFields(new URL(url), secret);
}

async function reasonFor(url: string | URL, secret = SECRET): Promise<string> {
  const result = await verify(url, secret);
  return result.ok ? 'ok' : result.reason;
}

async function paramsOf(url: string | URL, secret = SECRET): Promise<Record<string, string>> {
  const result = await verify(url, secret);
  if (!result.ok) throw new Error(`expected ${String(url)} to verify, got ${result.reason}`);
  return result.params;
}

/** verifyWithOpenFields' result in verifySignedUrl's shape. */
function asPlain(result: OpenFieldsVerifyResult): VerifyResult | { ok: false; reason: OpenFieldsFailure } {
  return result.ok ? { ok: true, params: result.params } : { ok: false, reason: result.reason };
}

function encodeEveryByte(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

/** A small deterministic generator, so the random corpus is the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const banner = (params: Record<string, string>, open: string[], secret = SECRET) =>
  buildOpenFieldsUrl({ baseUrl: BASE, siteId: SITE, template: 'email-banner', ext: 'png', params, secret, open });

describe('a URL without "open" verifies exactly as verifySignedUrl', () => {
  async function corpus(): Promise<string[]> {
    const plain = (params: Record<string, string>, template = 'blog') =>
      buildSignedUrl({ baseUrl: BASE, siteId: SITE, template, ext: 'png', params, secret: SECRET });
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys }, (_, index) => [`k${index}`, `v${index}`]));
    const signed = await Promise.all([
      plain({}),
      plain({ title: 'Hello world & more', author: 'Zoë', v: '1' }),
      plain({ title: 'Hi', size: 'square' }),
      plain({ title: 'Ship it! 10 tips & tricks (part 1/2) 🚀', subtitle: "a+b=c ~ it's *that* easy" }),
      // Names that only mean something once open fields exist are ordinary data without "open".
      plain({ name_default: 'there', opened: 'yes', open_at: 'noon', title: 'x' }),
      plain({ title: 'x'.repeat(LIMITS.maxDataValueChars) }),
      plain(many),
      plain({ title: 'Maya' }, 'email-banner'),
    ]);
    const hand = await Promise.all([
      signedByHand(`title=${encodeEveryByte('Zoë & co')}&v=1`, { title: 'Zoë & co', v: '1' }),
      signedByHand('v=1&title=Hello+world', { title: 'Hello world', v: '1' }),
      signedByHand('a=1&&b=2', { a: '1', b: '2' }),
      signedByHand('', {}),
    ]);
    const good = signed[1]!;
    const sig = new URL(good).searchParams.get(SIG_PARAM)!;
    const failures = [
      good.replace(/&sig=[0-9a-f]+$/, ''),
      `${good}&sig=${sig}`,
      good.replace(sig, sig.slice(0, 63)),
      good.replace(sig, sig.toUpperCase()),
      good.replace(sig, 'g'.repeat(64)),
      good.replace('title=', 'Title='),
      good.replace('title=', 'title=1&title='),
      good.replace('title=', 'title=line%0Abreak'),
      good.replace('v=1', 'v=2'),
      good.replace('v=1', 'v=1&extra=1'),
      good.replace('/blog.png', '/dark.png'),
      `${good}#fragment`,
      await signedByHand(`title=${'x'.repeat(LIMITS.maxDataValueChars + 1)}`, { title: 'x'.repeat(LIMITS.maxDataValueChars + 1) }),
      await signedByHand(
        Array.from({ length: LIMITS.maxDataKeys + 1 }, (_, index) => `k${index}=v`).join('&'),
        Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys + 1 }, (_, index) => [`k${index}`, 'v'])),
      ),
      await signedByHand(`title=${'x'.repeat(LIMITS.maxSignedUrlChars)}`, { title: 'x'.repeat(LIMITS.maxSignedUrlChars) }),
      `${BASE}${PATH}?title=x`,
    ];
    return [...signed, ...hand, ...failures, vector.url];
  }

  it('gives the same answer for every URL of a corpus of good and bad URLs', async () => {
    const urls = await corpus();
    const reasons = new Set<string>();
    for (const url of urls) {
      for (const secret of [SECRET, OTHER_SECRET, vector.secret]) {
        const expected = await verifySignedUrl(new URL(url), secret);
        const actual = await verifyWithOpenFields(new URL(url), secret);
        expect(asPlain(actual), url).toEqual(expected);
        if (actual.ok) {
          expect(actual.openFields).toEqual([]);
          expect(actual.fallbackParams).toEqual(actual.params);
        }
        reasons.add(expected.ok ? 'ok' : expected.reason);
      }
    }
    // The corpus reaches every outcome verifySignedUrl has.
    expect([...reasons].sort()).toEqual(
      ['bad_param_name', 'bad_value', 'duplicate_param', 'malformed_sig', 'missing_sig', 'ok', 'signature_mismatch', 'too_many_params', 'url_too_long'].sort(),
    );
  });

  it('accepts the cross-language signing vector with its documented parameters', async () => {
    const result = await verifyWithOpenFields(new URL(vector.url), vector.secret);
    expect(result).toEqual({ ok: true, params: vector.params, openFields: [], fallbackParams: vector.params });
  });

  it('gives the same answer for 400 random and randomly tampered URLs', async () => {
    const random = prng(20261126);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const NAMES = ['title', 'author', 'v', 'size', 'name', 'name_default', 'x1', 'Bad', 'a b', '_x'];
    const VALUES = ['', 'Hello', 'Zoë Müller', 'a+b=c', '50% & more', '🚀', 'line\nbreak', '#hash', '?q', 'x'.repeat(40)];
    const outcomes = new Set<string>();
    for (let round = 0; round < 400; round++) {
      const decoded: Record<string, string> = {};
      const count = Math.floor(random() * 5);
      for (let index = 0; index < count; index++) decoded[pick(NAMES)] = pick(VALUES);
      const entries = Object.entries(decoded);
      let query = entries.map(([name, value]) => (random() < 0.3 ? `${encodeEveryByte(name)}=${encodeEveryByte(value)}` : new URLSearchParams([[name, value]]).toString())).join('&');
      const mutation = Math.floor(random() * 6);
      if (mutation === 1) query += `${query ? '&' : ''}${pick(NAMES)}=${encodeURIComponent(pick(VALUES))}`;
      if (mutation === 2 && entries.length > 0) query = query.split('&').slice(1).join('&');
      if (mutation === 3) query = query.replace(/=/, '=x');
      let url = await signedByHand(query, decoded, PATH, random() < 0.9 ? SECRET : OTHER_SECRET);
      if (mutation === 4) url = url.replace(/sig=([0-9a-f])/, (_match, char: string) => `sig=${char === 'a' ? 'b' : 'a'}`);
      if (mutation === 5) url += `&sig=${'0'.repeat(64)}`;
      const expected = await verifySignedUrl(new URL(url), SECRET);
      const actual = await verifyWithOpenFields(new URL(url), SECRET);
      expect(asPlain(actual), url).toEqual(expected);
      outcomes.add(expected.ok ? 'ok' : expected.reason);
    }
    expect(outcomes.has('ok')).toBe(true);
    expect(outcomes.size).toBeGreaterThanOrEqual(5);
  });
});

describe('open fields keep the signature valid whatever the platform fills in', () => {
  const PARAMS = { title: 'Your spring picks are ready', greeting: 'Hi', name_default: 'there', cta: 'See the edit' };

  it('signs the URL without the open fields and appends them, empty, after sig', async () => {
    const { url, canonical } = await banner(PARAMS, ['name']);
    expect(url).toMatch(/&sig=[0-9a-f]{64}&name=$/);
    const signedPart = new URL(url.replace(/&name=$/, ''));
    // The canonical string is the one of the same URL without the open field: any signer can produce it.
    expect(canonical).toBe(canonicalString(PATH, Object.entries({ ...PARAMS, open: 'name' })));
    expect(signedPart.searchParams.get(SIG_PARAM)).toBe(await signCanonical(SECRET, canonical));
    expect(await verifySignedUrl(signedPart, SECRET)).toEqual({ ok: true, params: { ...PARAMS, open: 'name' } });
  });

  it.each([
    ['Maya', 'Maya'],
    ['Zoë', 'Zoë'],
    ['José María', 'José María'],
    ["O'Brien", "O'Brien"],
    ['Anne-Marie', 'Anne-Marie'],
    ['Nguyễn Thị Minh', 'Nguyễn Thị Minh'],
    ['Ελένη', 'Ελένη'],
    ['Мария', 'Мария'],
    ['Dr. Who, Jr.', 'Dr. Who, Jr.'],
  ])('renders %s for every recipient value written into the same signed URL', async (raw, shown) => {
    const { url } = await banner(PARAMS, ['name']);
    const expected = { title: PARAMS.title, greeting: 'Hi', cta: 'See the edit', name: shown };
    expect(await paramsOf(url + encodeURIComponent(raw))).toEqual(expected);
    // However the platform encodes it.
    expect(await paramsOf(url + encodeEveryByte(raw))).toEqual(expected);
    expect(await paramsOf(url + new URLSearchParams([['x', raw]]).toString().slice(2))).toEqual(expected);
  });

  it('accepts the open fields anywhere in the query, as a customer signer may put them', async () => {
    const decoded = { title: 'Spring', open: 'name,code', name_default: 'friend' };
    const signedQuery = new URLSearchParams(decoded).toString();
    const sig = await signCanonical(SECRET, canonicalString(PATH, Object.entries(decoded)));
    for (const query of [
      `name=Maya&${signedQuery}&code=AB-12&sig=${sig}`,
      `${signedQuery}&sig=${sig}&code=AB-12&name=Maya`,
      `code=AB-12&sig=${sig}&${signedQuery}&name=Maya`,
    ]) {
      const result = await verify(`${BASE}${PATH}?${query}`);
      expect(result).toEqual({
        ok: true,
        params: { title: 'Spring', name: 'Maya', code: 'AB-12' },
        openFields: ['name', 'code'],
        fallbackParams: { title: 'Spring', name: 'friend', code: '' },
      });
    }
  });

  it('keeps size, and up to the maximum number of open fields in the order "open" lists them', async () => {
    const fields = ['name', 'code', 'expires'].slice(0, EMAIL_FIELDS.maxOpenFields);
    const { url } = await banner({ title: 'x', [SIZE_PARAM]: 'square' }, fields);
    const filled = url.replace('&name=', '&name=Maya').replace('&code=', '&code=AB12');
    const result = await verify(filled);
    expect(result.ok && result.openFields).toEqual(fields);
    expect(result.ok && result.params).toEqual({ title: 'x', size: 'square', name: 'Maya', code: 'AB12', expires: '' });
  });

  it('does not count the open values against the URL length limit', async () => {
    // Four values of 950 characters: the signed part ends close to the limit.
    const filler = Object.fromEntries(['t1', 't2', 't3', 't4'].map((name) => [name, 't'.repeat(950)]));
    const { url } = await banner({ title: 'x', ...filler }, ['name']);
    const signedLength = new URL(url).pathname.length + new URL(url).search.length;
    expect(signedLength).toBeGreaterThan(LIMITS.maxSignedUrlChars - 300);
    expect(signedLength).toBeLessThanOrEqual(LIMITS.maxSignedUrlChars);
    const params = await paramsOf(url + 'M'.repeat(400));
    expect(params.name).toBe('');
    expect(await paramsOf(url + 'Maya')).toMatchObject({ ...filler, name: 'Maya' });
  });

  it('cuts nothing but the open value when a platform inserts "#" without encoding it', async () => {
    const { url } = await banner(PARAMS, ['name']);
    expect(await paramsOf(`${url}Maya#1`)).toMatchObject({ name: 'Maya' });
  });
});

describe('every signed parameter stays signed', () => {
  async function filled(): Promise<URL> {
    const { url } = await banner({ title: 'Spring', name_default: 'there', [SIZE_PARAM]: 'og' }, ['name', 'code']);
    return new URL(url.replace('&name=', '&name=Maya').replace('&code=', '&code=AB12'));
  }

  it('verifies untouched', async () => {
    expect(await reasonFor(await filled())).toBe('ok');
  });

  it.each([
    ['title', 'Winter'],
    [OPEN_PARAM, 'code,name'],
    [OPEN_PARAM, 'name'],
    [OPEN_PARAM, 'name,code,title'],
    ['name_default', 'friend'],
    [SIZE_PARAM, 'square'],
  ])('fails when %s is changed to %s', async (name, value) => {
    const url = await filled();
    url.searchParams.set(name, value);
    expect(await reasonFor(url)).not.toBe('ok');
    expect(['signature_mismatch', 'duplicate_param']).toContain(await reasonFor(url));
  });

  it.each(['title', OPEN_PARAM, 'name_default', SIZE_PARAM])('fails when %s is removed', async (name) => {
    const url = await filled();
    url.searchParams.delete(name);
    expect(await reasonFor(url)).toBe('signature_mismatch');
  });

  it('fails when a parameter is added, the path changes, the secret is wrong or sig is touched', async () => {
    const url = await filled();
    const added = new URL(url);
    added.searchParams.append('author', 'Mallory');
    expect(await reasonFor(added)).toBe('signature_mismatch');
    const defaulted = new URL(url);
    defaulted.searchParams.append('code_default', 'FREE');
    expect(await reasonFor(defaulted)).toBe('signature_mismatch');
    expect(await reasonFor(url.href.replace('/email-banner.png', '/email-offer.png'))).toBe('signature_mismatch');
    expect(await reasonFor(url.href.replace(`/${SITE}/`, '/s_other/'))).toBe('signature_mismatch');
    expect(await reasonFor(url, OTHER_SECRET)).toBe('signature_mismatch');
    const sig = url.searchParams.get(SIG_PARAM)!;
    expect(await reasonFor(url.href.replace(sig, `${sig.slice(0, 63)}${sig.endsWith('0') ? '1' : '0'}`))).toBe('signature_mismatch');
    expect(await reasonFor(url.href.replace(sig, sig.slice(1)))).toBe('malformed_sig');
    expect(await reasonFor(url.href.replace(`sig=${sig}`, ''))).toBe('missing_sig');
  });

  it('cannot be turned into an open-fields URL: adding "open" to a plain signed URL breaks it', async () => {
    const url = new URL(await buildSignedUrl({ baseUrl: BASE, siteId: SITE, template: 'email-banner', ext: 'png', params: { title: 'Spring', name: 'Maya' }, secret: SECRET }));
    expect(await reasonFor(url)).toBe('ok');
    url.searchParams.append(OPEN_PARAM, 'name');
    expect(await reasonFor(url)).toBe('signature_mismatch');
  });

  it('keeps an unsigned value from becoming a signed parameter', async () => {
    const { url } = await banner({ title: 'Spring', name_default: 'there' }, ['name']);
    // Encoded, the text stays inside the value and is refused there, so the default shows.
    expect(await paramsOf(url + encodeURIComponent('Maya&title=Evil'))).toEqual({ title: 'Spring', name: 'there' });
    // Unencoded, it is a second "title": the whole URL is refused rather than the title replaced.
    expect(await reasonFor(`${url}Maya&title=Evil`)).toBe('duplicate_param');
    // A second value for the open field itself is refused too, so no reader can pick another one.
    expect(await reasonFor(`${url}Maya&name=Eve`)).toBe('duplicate_param');
    expect(await reasonFor(`${url}Maya&${OPEN_PARAM}=title`)).toBe('duplicate_param');
  });

  it('still applies the parameter rules of verifySignedUrl to the signed part', async () => {
    const decoded = { title: 'x', open: 'name' };
    expect(await reasonFor(await signedByHand('title=x&open=name&Bad=1', decoded))).toBe('bad_param_name');
    expect(await reasonFor(await signedByHand('title=x&title=y&open=name', decoded))).toBe('duplicate_param');
    expect(await reasonFor(await signedByHand('title=a%0Ab&open=name', { ...decoded, title: 'a\nb' }))).toBe('bad_value');
    const many = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys }, (_, index) => [`k${index}`, 'v']));
    const tooMany = { ...many, open: 'name' };
    expect(await reasonFor(await signedByHand(new URLSearchParams(tooMany).toString(), tooMany))).toBe('too_many_params');
  });

  it('counts the open fields in the template data limit', async () => {
    const max = EMAIL_FIELDS.maxOpenFields;
    const fields = Array.from({ length: max }, (_, index) => `f${index}`);
    const data = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys - max + 1 }, (_, index) => [`k${index}`, 'v']));
    // The signed part (data + open) is within the limit, the template data with every open field is one key over it.
    const decoded = { ...data, open: fields.join(',') };
    expect(await reasonFor(await signedByHand(new URLSearchParams(decoded).toString(), decoded))).toBe('too_many_params');
    const fewer = { ...data, open: fields.slice(1).join(',') };
    expect(await reasonFor(await signedByHand(new URLSearchParams(fewer).toString(), fewer))).toBe('ok');
  });
});

describe('the "open" list', () => {
  it.each([
    ['name', ['name']],
    ['name,code', ['name', 'code']],
    ['code,name,expires', ['code', 'name', 'expires']],
    ['constructor', ['constructor']],
  ])('accepts %s', (value, fields) => {
    expect(parseOpenList(value)).toEqual({ ok: true, fields });
  });

  it.each([
    ['', 'bad_open_list'],
    ['name,', 'bad_open_list'],
    [',name', 'bad_open_list'],
    ['Name', 'bad_open_list'],
    ['name, code', 'bad_open_list'],
    ['name,name', 'bad_open_list'],
    ['first-name', 'bad_open_list'],
    ['x'.repeat(33), 'bad_open_list'],
    [Array.from({ length: EMAIL_FIELDS.maxOpenFields + 1 }, (_, index) => `f${index}`).join(','), 'too_many_open_fields'],
    [','.repeat(2000), 'too_many_open_fields'],
    [SIG_PARAM, 'reserved_open_field'],
    [SIZE_PARAM, 'reserved_open_field'],
    [OPEN_PARAM, 'reserved_open_field'],
    ['name,name_default', 'reserved_open_field'],
  ])('refuses %j (%s)', async (value, reason) => {
    expect(parseOpenList(value)).toEqual({ ok: false, reason });
    // Unsigned, or signed with open fields left out, the URL gets the list's own reason.
    expect(await reasonFor(`${BASE}${PATH}?title=x&open=${encodeURIComponent(value)}&sig=${'0'.repeat(64)}`)).toBe(reason);
    // Signed whole, "open" included, as ordinary data (a URL signed while the switch was off), it
    // keeps that meaning: "open" is a plain parameter, as before (security review SEC-6).
    const decoded = { title: 'x', open: value };
    const asData = await verify(await signedByHand(new URLSearchParams(decoded).toString(), decoded));
    if (value.length <= LIMITS.maxDataValueChars) expect(asData).toEqual({ ok: true, params: decoded, openFields: [], fallbackParams: decoded });
    else expect(asData).toEqual({ ok: false, reason }); // too long to be signed as data either
  });

  it('may appear only once', async () => {
    expect(await reasonFor(`${BASE}${PATH}?open=name&open=code&sig=${'0'.repeat(64)}`)).toBe('duplicate_param');
  });

  it('explains every failure in plain English, with the limits filled in', () => {
    const reasons: OpenFieldsFailure[] = ['bad_open_list', 'too_many_open_fields', 'reserved_open_field', 'signature_mismatch', 'url_too_long'];
    for (const reason of reasons) expect(describeOpenFieldsFailure(reason).length).toBeGreaterThan(30);
    expect(describeOpenFieldsFailure('too_many_open_fields')).toContain(String(EMAIL_FIELDS.maxOpenFields));
    expect(describeOpenFieldsFailure('signature_mismatch')).toBe(describeSignedUrlFailure('signature_mismatch'));
    expect(OPEN_RESERVED_PARAMS).toEqual([SIG_PARAM, SIZE_PARAM, OPEN_PARAM]);
  });
});

describe('value normalisation', () => {
  const max = EMAIL_FIELDS.maxValueChars;

  it.each([
    ['Maya', 'Maya'],
    ['  Maya  ', 'Maya'],
    ['Mary   Ann', 'Mary Ann'],
    ['Maya Lind', 'Maya Lind'],
    ['　Maya　', 'Maya'],
    ['Ｍａｙａ', 'Maya'],
    ['ﬁona', 'fiona'],
    ['Zoë', 'Zoë'],
    ['O’Brien', "O'Brien"],
    ['Anne‐Marie', 'Anne-Marie'],
    ['Anne‑Marie', 'Anne-Marie'],
    ['R&D team', 'R&D team'],
    ['@maya', '@maya'],
    ['#1 fan!', '#1 fan!'],
    ['Ready?', 'Ready?'],
    ['2026', '2026'],
    ['Łukasz Żółć', 'Łukasz Żółć'],
    ['Ⅻ', 'XII'],
    ['SPRING-20', 'SPRING-20'],
    ['a'.repeat(max), 'a'.repeat(max)],
    [`${'a'.repeat(max / 2)}     ${'b'.repeat(max / 2 - 1)}`, `${'a'.repeat(max / 2)} ${'b'.repeat(max / 2 - 1)}`],
  ])('shows %j as %j', (raw, shown) => {
    expect(normaliseOpenValue(raw)).toBe(shown);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only punctuation', '...'],
    ['an unfilled merge tag', '*|FNAME|*'],
    ['an unfilled template tag', '{{ first_name }}'],
    ['another merge tag style', '%%FirstName%%'],
    ['markup', '<b>Maya</b>'],
    ['a URL', 'https://evil.example/x.png'],
    ['a scheme', 'javascript:alert'],
    ['CSS', 'red;background:url(x)'],
    ['a path', 'a/b'],
    ['a line break', 'Maya\nLind'],
    ['a tab', 'Maya\tLind'],
    ['an emoji', 'Maya 😀'],
    ['a bidi override', '‮ayaM'],
    ['a zero-width joiner', 'Ma‍ya'],
    ['a fraction that NFKC turns into a slash', '½'],
    ['one character too many', 'a'.repeat(max + 1)],
    ['a long value', 'M'.repeat(4000)],
  ])('falls back for %s', (_label, raw) => {
    expect(normaliseOpenValue(raw)).toBeNull();
    expect(normaliseOpenValue(raw, 'any')).toBeNull();
  });

  it.each([
    ['Arabic', 'محمد'],
    ['Arabic-Indic digits', '٣ نجوم'],
    ['Hebrew', 'מאיה'],
    ['Devanagari', 'नमस्ते'],
    ['Chinese', '李小龙'],
    ['Japanese', 'さくら'],
    ['Thai', 'สมชาย'],
    ['Cyrillic outside the bundled subset', 'Қанат'],
    ['a combining mark NFKC cannot compose', 'Maya̱'],
  ])('falls back for %s, which no bundled font draws, unless every script is allowed', (_label, raw) => {
    expect(normaliseOpenValue(raw)).toBeNull();
    expect(normaliseOpenValue(raw, 'any')).toBe(raw.normalize('NFKC'));
  });

  it('passes the choice of scripts through verification', async () => {
    const { url } = await banner({ title: 'Spring', name_default: 'there' }, ['name']);
    const filled = url + encodeURIComponent('محمد');
    expect(await paramsOf(filled)).toMatchObject({ name: 'there' });
    const any = await verifyWithOpenFields(new URL(filled), SECRET, { scripts: 'any' });
    expect(any.ok && any.params.name).toBe('محمد');
  });
});

describe('defaults', () => {
  it('uses <field>_default for a value that is absent, empty or not acceptable, and empty without one', async () => {
    const { url } = await banner({ title: 'Spring', name_default: 'there' }, ['name', 'code']);
    const withoutValues = url.replace(/&name=&code=$/, '');
    expect(await paramsOf(withoutValues)).toEqual({ title: 'Spring', name: 'there', code: '' });
    expect(await paramsOf(url)).toEqual({ title: 'Spring', name: 'there', code: '' });
    expect(await paramsOf(url.replace('&name=', `&name=${encodeURIComponent('*|FNAME|*')}`))).toEqual({ title: 'Spring', name: 'there', code: '' });
    expect(await paramsOf(url.replace('&name=', '&name=Maya'))).toEqual({ title: 'Spring', name: 'Maya', code: '' });
  });

  it('shows a signed default as signed: it is the owner\'s own text', async () => {
    const { url } = await banner({ title: 'Spring', name_default: 'dear reader 🌷' }, ['name']);
    expect(await paramsOf(url)).toMatchObject({ name: 'dear reader 🌷' });
  });

  it('consumes the defaults of the open fields only; other _default names stay data', async () => {
    const { url } = await banner({ title: 'Spring', name_default: 'there', city_default: 'Beirut' }, ['name']);
    const result = await verify(`${url}Maya`);
    expect(result).toEqual({
      ok: true,
      params: { title: 'Spring', city_default: 'Beirut', name: 'Maya' },
      openFields: ['name'],
      fallbackParams: { title: 'Spring', city_default: 'Beirut', name: 'there' },
    });
    expect(DEFAULT_SUFFIX).toBe('_default');
  });

  it('gives identical values the same card cache key, so they are rendered and charged once', async () => {
    const { url } = await banner({ title: 'Spring' }, ['name']);
    const user = { id: 'u_cache', plan: 'free' } as UserRow;
    const template: ResolvedTemplate = { label: 'email-banner', identity: 'starter:email-banner', html: emailBanner.html, css: emailBanner.css };
    const keyFor = async (raw: string): Promise<string> => {
      const { [SIZE_PARAM]: _size, ...data } = await paramsOf(url + raw);
      return cardCacheKey({ user, template, data, size: { id: 'og', label: 'Open Graph', width: 1200, height: 630 }, format: 'png' });
    };
    const maya = await keyFor('Maya');
    expect(await keyFor('+Maya+')).toBe(maya);
    expect(await keyFor(encodeURIComponent('Ｍａｙａ'))).toBe(maya);
    expect(await keyFor('Eve')).not.toBe(maya);
    // Every value that is not acceptable is the default's card: one render, however many recipients.
    const fallback = await keyFor('');
    expect(await keyFor(encodeURIComponent('*|FNAME|*'))).toBe(fallback);
    expect(await keyFor(encodeURIComponent('<script>'))).toBe(fallback);
  });
});

describe('template fields', () => {
  const resolved = (template: { id: string; html: string; css: string }): ResolvedTemplate => ({
    label: template.id,
    identity: `starter:${template.id}`,
    html: template.html,
    css: template.css,
  });

  it('are the placeholders of the template', () => {
    expect([...templateFields(resolved(emailBanner))].sort()).toEqual(['cta', 'greeting', 'image', 'name', 'site', 'tag', 'title']);
    expect([...templateFields(resolved(emailOffer))].sort()).toEqual(['code', 'description', 'expires', 'greeting', 'image', 'name', 'site', 'tag', 'title']);
    expect(templateFields({ identity: 'custom:t_broken@1', html: 'x'.repeat(LIMITS.maxHtmlBytes + 1), css: '' }).size).toBe(0);
  });

  it('drops an open field the template does not have, with its value, so it cannot vary the cache key', async () => {
    const { url } = await banner({ title: 'Spring', color_default: 'red' }, ['name', 'color']);
    const result = await verify(url.replace('&name=', '&name=Maya').replace('&color=', '&color=blue'));
    if (!result.ok) throw new Error(result.reason);
    expect(keepTemplateOpenFields(result, templateFields(resolved(emailBanner)))).toEqual({
      ok: true,
      params: { title: 'Spring', name: 'Maya' },
      openFields: ['name'],
      fallbackParams: { title: 'Spring', name: '' },
    });
    const all = new Set(['title', 'name', 'color']);
    expect(keepTemplateOpenFields(result, all)).toBe(result);
  });
});

describe('buildOpenFieldsUrl', () => {
  async function errorOf(run: () => Promise<unknown>): Promise<{ code: string; reason: unknown }> {
    try {
      await run();
    } catch (error) {
      if (error instanceof ApiError) return { code: error.code, reason: error.details?.reason };
      throw error;
    }
    throw new Error('expected an ApiError');
  }

  it('refuses a value for an open field, "open" as a parameter, a bad list and a field the template lacks', async () => {
    expect(await errorOf(() => banner({ title: 'x', name: 'Maya' }, ['name']))).toEqual({ code: 'invalid_request', reason: 'open_field_value' });
    expect(await errorOf(() => banner({ title: 'x', open: 'name' }, ['name']))).toEqual({ code: 'invalid_request', reason: 'reserved_param' });
    expect(await errorOf(() => banner({ title: 'x' }, []))).toEqual({ code: 'invalid_request', reason: 'bad_open_list' });
    expect(await errorOf(() => banner({ title: 'x' }, ['name', 'name']))).toEqual({ code: 'invalid_request', reason: 'bad_open_list' });
    const tooMany = Array.from({ length: EMAIL_FIELDS.maxOpenFields + 1 }, (_, index) => `f${index}`);
    expect(await errorOf(() => banner({ title: 'x' }, tooMany))).toEqual({ code: 'invalid_request', reason: 'too_many_open_fields' });
    expect(await errorOf(() => banner({ title: 'x' }, ['size']))).toEqual({ code: 'invalid_request', reason: 'reserved_open_field' });
    const fields = templateFields({ identity: 'starter:email-banner', html: emailBanner.html, css: emailBanner.css });
    expect(
      await errorOf(() =>
        buildOpenFieldsUrl({ baseUrl: BASE, siteId: SITE, template: 'email-banner', ext: 'png', params: { title: 'x' }, secret: SECRET, open: ['colour'], templateFields: fields }),
      ),
    ).toEqual({ code: 'invalid_request', reason: 'unknown_open_field' });
  });

  it('refuses what verifySignedUrl would refuse, and more data keys than the verifier accepts', async () => {
    expect(await errorOf(() => banner({ title: 'x', [SIG_PARAM]: 'y' }, ['name']))).toEqual({ code: 'invalid_request', reason: 'reserved_param' });
    expect(await errorOf(() => banner({ Title: 'x' }, ['name']))).toEqual({ code: 'invalid_request', reason: 'bad_param_name' });
    const data = Object.fromEntries(Array.from({ length: LIMITS.maxDataKeys - 1 }, (_, index) => [`k${index}`, 'v']));
    expect(await errorOf(() => banner(data, ['name', 'code']))).toEqual({ code: 'invalid_request', reason: 'too_many_params' });
    const { url } = await banner(data, ['name']);
    expect(await reasonFor(url)).toBe('ok');
  });

  it('builds a URL that verifies and that the signer and verifier agree on for every field set', async () => {
    for (const open of [['name'], ['name', 'code'], ['code', 'name', 'expires']]) {
      const params = { title: 'Offer', name_default: 'friend', [SIZE_PARAM]: 'og' };
      const { url } = await buildOpenFieldsUrl({ baseUrl: BASE, siteId: SITE, template: 'email-offer', ext: 'webp', params, secret: SECRET, open });
      expect(new URL(url).pathname).toBe(`/v1/og/${SITE}/email-offer.webp`);
      const result = await verify(url);
      expect(result.ok && result.openFields).toEqual(open);
    }
  });
});

describe('email cache headers', () => {
  const now = Date.UTC(2026, 10, 26, 12);

  it('keep the image for EMAIL_FIELDS.maxAgeSeconds, never past the stored image\'s expiry', () => {
    expect(openFieldsCacheControl(now + 90 * DAY_MS, now)).toBe(`public, max-age=${EMAIL_FIELDS.maxAgeSeconds}`);
    expect(openFieldsCacheControl(now + 7 * DAY_MS, now)).toBe(`public, max-age=${7 * 86_400}`);
    expect(openFieldsCacheControl(now - 1000, now)).toBe('public, max-age=0');
  });
});

describe('the daily cap of unique renders', () => {
  // RATE_LIMITS_DISABLED is left out: this suite is about the limit.
  const limited = { DB: env.DB, ENVIRONMENT: 'test' } as const;
  const now = Date.UTC(2026, 10, 26, 15, 30);
  const free: Pick<UserRow, 'plan' | 'cancel_at'> = { plan: 'free', cancel_at: null };
  let counter = 0;
  const site = (): string => `s_cap${++counter}`;

  async function used(siteId: string, at = now): Promise<number> {
    return (await first<{ count: number }>(env.DB, 'SELECT count FROM tool_usage WHERE bucket = ?1', openRenderBucket(siteId, at)))?.count ?? 0;
  }

  async function preset(siteId: string, count: number): Promise<void> {
    await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', openRenderBucket(siteId, now), count, now + DAY_MS);
  }

  it('counts per site and UTC day, up to the plan\'s limit and not one more', async () => {
    const id = site();
    const limit = EMAIL_FIELDS.maxUniqueRendersPerDay.free;
    const firstOne = await reserveOpenFieldRender(limited, id, free, now);
    expect(firstOne).toMatchObject({ allowed: true, limit });
    expect(await used(id)).toBe(1);
    await run(env.DB, 'UPDATE tool_usage SET count = ?1 WHERE bucket = ?2', limit - 1, openRenderBucket(id, now));
    expect((await reserveOpenFieldRender(limited, id, free, now)).allowed).toBe(true);
    expect((await reserveOpenFieldRender(limited, id, free, now)).allowed).toBe(false);
    expect(await used(id)).toBe(limit);
    // Another site, and the next UTC day, have their own counts.
    expect((await reserveOpenFieldRender(limited, site(), free, now)).allowed).toBe(true);
    expect((await reserveOpenFieldRender(limited, id, free, now + DAY_MS)).allowed).toBe(true);
    const row = await first<{ expires_at: number }>(env.DB, 'SELECT expires_at FROM tool_usage WHERE bucket = ?1', openRenderBucket(id, now));
    expect(row?.expires_at).toBe((Math.floor(now / DAY_MS) + 2) * DAY_MS);
  });

  it('uses the plan in force: a cancelled subscription counts as Free', async () => {
    const starter = { plan: 'starter', cancel_at: null } as const;
    const cancelled = { plan: 'starter', cancel_at: now - 1 } as const;
    expect((await reserveOpenFieldRender(limited, site(), starter, now)).limit).toBe(EMAIL_FIELDS.maxUniqueRendersPerDay.starter);
    expect((await reserveOpenFieldRender(limited, site(), cancelled, now)).limit).toBe(EMAIL_FIELDS.maxUniqueRendersPerDay.free);
    expect((await reserveOpenFieldRender(limited, site(), { plan: 'pro', cancel_at: null }, now)).limit).toBe(EMAIL_FIELDS.maxUniqueRendersPerDay.pro);
  });

  it('cannot be overshot by concurrent requests', async () => {
    const id = site();
    await preset(id, EMAIL_FIELDS.maxUniqueRendersPerDay.free - 3);
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveOpenFieldRender(limited, id, free, now)));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(await used(id)).toBe(EMAIL_FIELDS.maxUniqueRendersPerDay.free);
  });

  it('gives a reservation back once when the render failed', async () => {
    const id = site();
    await preset(id, EMAIL_FIELDS.maxUniqueRendersPerDay.free - 1);
    const taken = await reserveOpenFieldRender(limited, id, free, now);
    expect(taken.allowed).toBe(true);
    expect((await reserveOpenFieldRender(limited, id, free, now)).allowed).toBe(false);
    await taken.release();
    await taken.release();
    expect(await used(id)).toBe(EMAIL_FIELDS.maxUniqueRendersPerDay.free - 1);
    expect((await reserveOpenFieldRender(limited, id, free, now)).allowed).toBe(true);
  });

  it('is off in tests that switch limits off, and counts nothing there', async () => {
    const id = site();
    const result = await reserveOpenFieldRender({ ...limited, RATE_LIMITS_DISABLED: '1' }, id, free, now);
    expect(result.allowed).toBe(true);
    await result.release();
    expect(await used(id)).toBe(0);
  });

  it('has a 429 that says when new values render again', () => {
    const error = openFieldsCapError(200, now);
    expect(error.status).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(error.headers?.['retry-after']).toBe(String(8.5 * 3600));
    expect(error.message).toContain('200');
    expect(error.message).toContain('00:00 UTC');
  });
});

describe('the daily open-field cap protects the month (review BQ-1)', () => {
  it('is a quarter of each plan\'s monthly images, well below the month', async () => {
    const { PLANS, PLAN_ORDER } = await import('../src/billing/plans');
    for (const plan of PLAN_ORDER) {
      const cap = EMAIL_FIELDS.maxUniqueRendersPerDay[plan];
      expect(cap, plan).toBe(Math.floor(PLANS[plan].monthlyImages / 4));
      expect(cap, plan).toBeLessThan(PLANS[plan].monthlyImages);
      expect(cap, plan).toBeGreaterThan(0);
    }
  });
});
