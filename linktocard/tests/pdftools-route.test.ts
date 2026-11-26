// POST /v1/pdf-tools/{op} through the real Worker (src/routes/pdf-toolkit.ts): the kill switch,
// every operation, the four ways of sending a file (base64, multipart upload, url, pdf_id),
// limits, refused files, what is charged (one block per request) and stored, the Free mark,
// the per-key rate limiter, and the guarded downloads (private addresses, our own hosts, also
// behind a redirect). Remote hosts are a fetch spy that also answers the DNS-over-HTTPS lookups.
import { PDFDocument } from '@cantoo/pdf-lib';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, LIMITS, PDF, PDF_TOOLKIT } from '../src/config';
import { all, first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import { toHex } from '../src/lib/crypto';
import { creditTopup } from '../src/lib/quota';
import { pdfR2Key } from '../src/pdf/service';
import type { Env, UserRow } from '../src/types';
import { apiKeyFor, bearer, bytesOf, call, createUser, dohAnswer, errorOf, renderCount, requestUrl, setUsed, usageOf } from './app-helpers';
import { allowAll, mockBrowser } from './pdf-helpers';
import { fixture, hexText, latin1, makePdf, pageContent, reload, type ToolkitFixture } from './pdftools-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const file = (name: ToolkitFixture): { base64: string } => ({ base64: b64(fixture(name)) });

interface Account {
  user: UserRow;
  secret: string;
  keyId: string;
}

async function account(plan: UserRow['plan'] = 'starter'): Promise<Account> {
  const user = await createUser(plan);
  const key = await apiKeyFor(user.id);
  return { user, secret: key.secret, keyId: key.id };
}

function postToolkit(secret: string | null, op: string, body: unknown, bindings: Env = env): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) Object.assign(headers, bearer(secret));
  return call(`/v1/pdf-tools/${op}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }, bindings);
}

function postForm(secret: string, op: string, form: FormData): Promise<Response> {
  return call(`/v1/pdf-tools/${op}`, { method: 'POST', headers: bearer(secret), body: form });
}

interface PdfResultJson {
  op: string;
  id: string;
  url: string;
  pages: number;
  bytes: number;
  credits_used: number;
  filename: string;
  created_at: string;
  expires_at: string;
  usage: { used: number; remaining: number; topup_remaining: number; plan: string };
}

async function ok<T = PdfResultJson>(response: Response): Promise<T> {
  if (response.status !== 200) throw new Error(`expected 200, got ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** GET /i/... needs PDF rendering switched on (src/routes/images.ts); the browser is never called. */
const servingEnv = (): Env => ({ ...env, BROWSER: mockBrowser().binding });

async function download(url: string): Promise<Response> {
  return call(new URL(url).pathname, {}, servingEnv());
}

async function storedBytes(url: string): Promise<Uint8Array> {
  const response = await download(url);
  expect(response.status, url).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/pdf');
  return bytesOf(response);
}

async function ledgerRow(id: string): Promise<Record<string, unknown> | null> {
  return first<Record<string, unknown>>(env.DB, 'SELECT * FROM renders WHERE cache_key = ?1', id);
}

async function storedKeys(userId: string): Promise<string[]> {
  return (await env.BUCKET.list({ prefix: `r/${userId}/` })).objects.map((object) => object.key);
}

/** A PDF stored on the account the way POST /v1/pdf stores one: an R2 object and its ledger row. */
async function storePdfLike(userId: string, bytes: Uint8Array, options: { chargedTo?: string; expiresAt?: number } = {}): Promise<string> {
  const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const expiresAt = options.expiresAt ?? now + DAY_MS;
  await env.BUCKET.put(pdfR2Key(userId, id), bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { expiresAt: String(expiresAt), createdAt: String(now), pages: '8', units: '2', filename: 'invoice.pdf', template: 'invoice' },
  });
  await run(
    env.DB,
    `INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
     VALUES (?1, ?2, NULL, 'api', 'invoice', 0, 0, 'pdf', ?3, ?4, ?5, 0, ?6, ?7)`,
    id,
    userId,
    bytes.byteLength,
    pdfR2Key(userId, id),
    options.chargedTo ?? 'plan',
    now,
    expiresAt,
  );
  return id;
}

type Served = Response | (() => Response | Promise<Response>);

/**
 * fetch() for remote hosts: `files` by exact URL (anything else 404), DNS answers from `dns` by
 * host name (others resolve to a public address). `seen` lists every non-DNS request.
 */
function mockWeb(files: Record<string, Served>, dns: Record<string, string[]> = {}): { seen: string[] } {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const addresses = dns[name];
      if (!addresses) return dohAnswer(url);
      const isA = url.searchParams.get('type') === 'A';
      const answer = addresses.filter((address) => isA === !address.includes(':')).map((data) => ({ name, type: isA ? 1 : 28, TTL: 60, data }));
      return Response.json({ Status: 0, Answer: answer });
    }
    seen.push(url.href);
    const served = files[url.href];
    if (!served) return new Response('not here', { status: 404 });
    return typeof served === 'function' ? served() : served.clone();
  });
  return { seen };
}

const pdfFile = (bytes: Uint8Array, headers: Record<string, string> = {}): (() => Response) => () =>
  new Response(bytes.slice(), { headers: { 'content-type': 'application/octet-stream', ...headers } });
const redirect = (location: string, status = 302): (() => Response) => () => new Response(null, { status, headers: { location } });

/** A host name of its own per test: DNS answers are cached for a minute (src/render/proxy.ts). */
let hosts = 0;
const host = (label: string): string => `${label}-${++hosts}.files.example.com`;

/** Every page carries the free mark (src/pdftools/mark.ts). */
async function marked(bytes: Uint8Array): Promise<boolean[]> {
  const doc = await reload(bytes);
  return doc.getPages().map((_, index) => pageContent(doc, index).includes(hexText(PDF.freeMark)));
}

/* ------------------------------------------------------------------ */
/* Kill switch and routing                                             */
/* ------------------------------------------------------------------ */

describe('the kill switch and the routes', () => {
  it.each(['/v1/pdf-tools/merge', '/v1/pdf-tools/fields', '/v1/pdf-tools/compress', '/v1/pdf-tools', '/v1/pdf-tools/merge/extra'])(
    'switched off, %s answers 503 not_configured for every method before the API key is checked',
    async (path) => {
      for (const value of ['false', undefined]) {
        const bindings = { ...env, PDF_TOOLKIT_ENABLED: value } as Env;
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          const response = await call(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }, bindings);
          expect(response.status, `${method} ${path}`).toBe(503);
          expect(await errorOf(response)).toMatchObject({ code: 'not_configured', message: 'The PDF toolkit is not enabled yet.' });
        }
      }
    },
  );

  it('switched on: an API key is required, unknown operations and other methods are 404', async () => {
    const { secret } = await account();
    const anonymous = await postToolkit(null, 'merge', { files: [file('multi-page.pdf')] });
    expect(anonymous.status).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('invalid_api_key');

    const unknown = await postToolkit(secret, 'compress', { files: [file('multi-page.pdf')] });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toBe(`Unknown PDF toolkit operation "compress". Use one of: ${PDF_TOOLKIT.ops.join(', ')}.`);

    for (const [method, path] of [['GET', '/v1/pdf-tools/merge'], ['POST', '/v1/pdf-tools'], ['POST', '/v1/pdf-tools/merge/extra']] as const) {
      const response = await call(path, { method, headers: bearer(secret) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect((await errorOf(response)).message).toMatch(/POST \/v1\/pdf-tools\/\{operation\}/);
    }
    // The API-key routes beside it are untouched.
    expect((await call('/v1/usage', { headers: bearer(secret) })).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Every operation                                                     */
/* ------------------------------------------------------------------ */

describe('every operation', () => {
  it('merge: joins the files in order, stores the result at its /i/ URL and charges one block', async () => {
    const { user, secret } = await account();
    const before = (await usageOf(user.id)).used;
    const response = await postToolkit(secret, 'merge', {
      files: [{ ...file('multi-page.pdf'), pages: '8,1-2' }, file('rotated.pdf'), { base64: `data:application/pdf;base64,${b64(fixture('multi-page.pdf'))}` }],
      filename: 'Joined report.pdf',
    });
    const json = await ok(response);
    expect(Object.keys(json)).toEqual(['op', 'id', 'url', 'pages', 'bytes', 'credits_used', 'filename', 'created_at', 'expires_at', 'usage']);
    expect(json).toMatchObject({ op: 'merge', pages: 3 + 5 + 8, credits_used: 2, filename: 'Joined report.pdf' });
    expect(json.id).toMatch(/^[0-9a-f]{64}$/);
    expect(json.url).toBe(`${env.APP_URL}/i/${user.id}/${json.id}.pdf`);
    expect(Date.parse(json.expires_at) - Date.parse(json.created_at)).toBe(30 * DAY_MS); // Starter keeps files 30 days
    expect(json.usage.used).toBe(before + 2);
    expect((await usageOf(user.id)).used).toBe(before + 2);

    const bytes = await storedBytes(json.url);
    expect(bytes.byteLength).toBe(json.bytes);
    const doc = await reload(bytes);
    expect(doc.getPageCount()).toBe(16);
    expect(pageContent(doc, 0)).toContain(hexText('Page 8 of 8'));
    expect(pageContent(doc, 1)).toContain(hexText('Page 1 of 8'));
    expect(await ledgerRow(json.id)).toMatchObject({ user_id: user.id, source: 'toolkit', template: 'toolkit:merge', format: 'pdf', charged_to: 'plan', bytes: json.bytes, r2_key: pdfR2Key(user.id, json.id) });
    expect(await first(env.DB, 'SELECT pdfs, units FROM pdf_usage WHERE user_id = ?1', user.id)).toEqual({ pdfs: 1, units: 2 });
  });

  it('split: one stored, paid file per range, charged together as one block', async () => {
    const { user, secret } = await account();
    const before = (await usageOf(user.id)).used;
    const json = await ok<{ op: string; files: (Omit<PdfResultJson, 'op' | 'usage' | 'created_at' | 'expires_at'> & { range: string })[]; pages: number; credits_used: number; created_at: string; expires_at: string; usage: PdfResultJson['usage'] }>(
      await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], every: 3, filename: 'chapters.pdf' }),
    );
    expect(json).toMatchObject({ op: 'split', pages: 8, credits_used: 3 });
    expect(json.files.map((f) => [f.range, f.pages, f.credits_used, f.filename])).toEqual([
      ['1-3', 3, 1, 'chapters-1-3.pdf'],
      ['4-6', 3, 1, 'chapters-4-6.pdf'],
      ['7-8', 2, 1, 'chapters-7-8.pdf'],
    ]);
    expect(Object.keys(json.files[0]!)).toEqual(['range', 'id', 'url', 'pages', 'bytes', 'credits_used', 'filename']);
    expect(json.usage.used).toBe(before + 3);
    expect(await first(env.DB, 'SELECT pdfs, units FROM pdf_usage WHERE user_id = ?1', user.id)).toEqual({ pdfs: 1, units: 3 });
    for (const part of json.files) {
      const doc = await reload(await storedBytes(part.url));
      expect(doc.getPageCount()).toBe(part.pages);
      // Every file has a paid ledger row of its own (cleanup and pdf_id find it).
      expect(await ledgerRow(part.id)).toMatchObject({ user_id: user.id, source: 'toolkit', charged_to: 'plan', r2_key: pdfR2Key(user.id, part.id), bytes: part.bytes });
    }
    // A further file of a split is a stored PDF like any other.
    const again = await ok(await postToolkit(secret, 'merge', { files: [{ pdf_id: json.files[2]!.id }, { pdf_id: json.files[0]!.id }] }));
    expect(again.pages).toBe(5);

    const binary = await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], every: 3, response: 'binary' });
    expect(binary.status).toBe(400);
  });

  it('stamp: text, and an image fetched from a URL', async () => {
    const { user, secret } = await account();
    const text = await ok(await postToolkit(secret, 'stamp', { files: [file('multi-page.pdf')], text: 'PAID', pages: '1-2' }));
    expect(text).toMatchObject({ op: 'stamp', pages: 8, credits_used: 1, filename: 'stamp.pdf' });
    const doc = await reload(await storedBytes(text.url));
    expect(pageContent(doc, 0)).toContain(hexText('PAID'));
    expect(pageContent(doc, 2)).not.toContain(hexText('PAID'));

    const logoUrl = `https://${host('brand')}/logo.png`;
    const { seen } = mockWeb({ [logoUrl]: pdfFile(fixture('logo.png'), { 'content-type': 'image/png' }) });
    const image = await ok(await postToolkit(secret, 'stamp', { files: [file('rotated.pdf')], image: { url: logoUrl }, width: 120, position: 'top-right' }));
    expect(seen).toEqual([logoUrl]);
    const stamped = await reload(await storedBytes(image.url));
    expect(pageContent(stamped, 0)).toMatch(/\/Image-?\d+ Do/);
    expect((await usageOf(user.id)).used).toBe(2);
  });

  it('fill and fields: fields lists the form for free, fill writes the values', async () => {
    const { user, secret } = await account();
    const keys = await storedKeys(user.id);
    const listed = await ok<{ op: string; fields: { name: string; type: string; value: unknown }[]; pages: number; credits_used: number }>(
      await postToolkit(secret, 'fields', { files: [file('form.pdf')] }),
    );
    expect(Object.keys(listed)).toEqual(['op', 'pages', 'credits_used', 'fields']);
    expect(listed.op).toBe('fields');
    expect(listed.credits_used).toBe(0);
    expect(listed.fields.map((field) => field.name)).toEqual(expect.arrayContaining(['full_name', 'email', 'zip', 'subscribe', 'plan', 'country']));
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await storedKeys(user.id)).toEqual(keys);
    expect(await renderCount(user.id)).toBe(0);

    const filled = await ok(await postToolkit(secret, 'fill', { files: [file('form.pdf')], values: { full_name: 'Amara Nwosu', subscribe: true, plan: 'pro' } }));
    expect(filled).toMatchObject({ op: 'fill', credits_used: 1, filename: 'fill.pdf' });
    const after = await ok<{ fields: { name: string; value: unknown }[] }>(await postToolkit(secret, 'fields', { files: [{ pdf_id: filled.id }] }));
    const value = (name: string): unknown => after.fields.find((field) => field.name === name)?.value;
    expect([value('full_name'), value('subscribe'), value('plan')]).toEqual(['Amara Nwosu', true, 'pro']);

    const unknown = await postToolkit(secret, 'fill', { files: [file('form.pdf')], values: { nickname: 'x' } });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details?.valid_fields).toEqual(expect.arrayContaining(['full_name']));
    // A PDF without a form lists no fields, and costs nothing even with no images left.
    await setUsed(user, 2000);
    expect((await ok<{ fields: unknown[] }>(await postToolkit(secret, 'fields', { files: [file('multi-page.pdf')] }))).fields).toEqual([]);
  });

  it('from-images: one page per image, from base64 and from a URL', async () => {
    const { secret } = await account();
    const photoUrl = `https://${host('scans')}/photo.jpg`;
    mockWeb({ [photoUrl]: pdfFile(fixture('photo.jpg'), { 'content-type': 'image/jpeg' }) });
    const json = await ok(await postToolkit(secret, 'from-images', { files: [file('logo.png'), { url: photoUrl }, file('photo-exif-6.jpg')], page_size: 'a4', margin: 36, filename: 'scans.pdf' }));
    expect(json).toMatchObject({ op: 'from-images', pages: 3, credits_used: 1, filename: 'scans.pdf' });
    const doc = await reload(await storedBytes(json.url));
    expect(doc.getPageCount()).toBe(3);

    const pdfAsImage = await postToolkit(secret, 'from-images', { files: [file('multi-page.pdf')] });
    expect(pdfAsImage.status).toBe(415);
    expect((await errorOf(pdfAsImage)).details).toMatchObject({ reason: 'not_image' });
  });

  it('protect: the stored result is encrypted, and is refused as a later input', async () => {
    const { secret } = await account();
    const json = await ok(await postToolkit(secret, 'protect', { files: [file('multi-page.pdf')], user_password: 'open-sesame', owner_password: 'owner-secret', permissions: { copying: false } }));
    expect(json).toMatchObject({ op: 'protect', pages: 8, credits_used: 1 });
    const bytes = await storedBytes(json.url);
    expect(latin1(bytes)).toContain('/Encrypt');
    await expect(reload(bytes)).rejects.toThrow(/encrypted/i);

    const reuse = await postToolkit(secret, 'stamp', { files: [{ pdf_id: json.id }], text: 'x' });
    expect(reuse.status).toBe(400);
    expect((await errorOf(reuse)).details).toMatchObject({ reason: 'encrypted' });
  });

  it('"response": "binary" answers the PDF with the documented headers, and stores it too', async () => {
    const { user, secret } = await account();
    const response = await postToolkit(secret, 'merge', { files: [file('multi-page.pdf'), file('multi-page.pdf')], response: 'binary', filename: 'both.pdf' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="both.pdf"');
    expect(response.headers.get('x-ltc-pages')).toBe('16');
    expect(response.headers.get('x-ltc-credits-used')).toBe('2');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const url = response.headers.get('x-ltc-pdf-url')!;
    expect(url).toMatch(new RegExp(`^${env.APP_URL}/i/${user.id}/[0-9a-f]{64}\\.pdf$`));
    const body = await bytesOf(response);
    expect(response.headers.get('content-length')).toBe(String(body.byteLength));
    expect(await storedBytes(url)).toEqual(body);
  });
});

/* ------------------------------------------------------------------ */
/* Input files                                                         */
/* ------------------------------------------------------------------ */

describe('input files', () => {
  it('url: downloaded through the guarded fetcher, whatever content type the host claims', async () => {
    const { secret } = await account();
    const a = `https://${host('docs')}/a.pdf`;
    const b = `https://${host('docs')}/b`;
    const { seen } = mockWeb({ [a]: pdfFile(fixture('multi-page.pdf')), [b]: pdfFile(fixture('rotated.pdf'), { 'content-type': 'text/plain' }) });
    const json = await ok(await postToolkit(secret, 'merge', { files: [{ url: a }, { url: b, pages: '1' }] }));
    expect(json.pages).toBe(9);
    expect(seen).toEqual([a, b]);
    const request = (vi.mocked(fetch).mock.calls.find(([input]) => requestUrl(input).href === a)![1] ?? {}) as RequestInit;
    expect(request).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect((request.headers as Record<string, string>)['user-agent']).toMatch(/^LinkToCard-FileFetcher\//);
  });

  it('url: a host error, a redirect loop and a dead name are 422 image_fetch_failed naming the file', async () => {
    const { user, secret } = await account();
    const missing = `https://${host('gone')}/x.pdf`;
    mockWeb({});
    const notFound = await postToolkit(secret, 'merge', { files: [file('multi-page.pdf'), { url: missing }] });
    expect(notFound.status).toBe(422);
    expect(await errorOf(notFound)).toMatchObject({ code: 'image_fetch_failed', message: expect.stringMatching(/^files\[1\]\.url: the host answered HTTP 404/), details: { reason: 'http_error', url: missing } });

    vi.restoreAllMocks();
    const loop = `https://${host('loop')}/x.pdf`;
    mockWeb({ [loop]: redirect(loop) });
    const looped = await postToolkit(secret, 'merge', { files: [{ url: loop }] });
    expect(looped.status).toBe(422);
    expect((await errorOf(looped)).details).toMatchObject({ reason: 'too_many_redirects', url: loop });
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => requestUrl(input).href === loop)).toHaveLength(LIMITS.imageMaxRedirects + 1);

    vi.restoreAllMocks();
    const dead = host('dead');
    mockWeb({}, { [dead]: [] });
    const unresolved = await postToolkit(secret, 'merge', { files: [{ url: `https://${dead}/x.pdf` }] });
    expect(unresolved.status).toBe(422);
    expect((await errorOf(unresolved)).details).toMatchObject({ reason: 'dns_failed' });
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('pdf_id: one of the account\'s own stored PDFs, found through the ledger', async () => {
    const { user, secret } = await account();
    const own = await storePdfLike(user.id, fixture('multi-page.pdf'));
    const json = await ok(await postToolkit(secret, 'stamp', { files: [{ pdf_id: own }], text: 'COPY' }));
    expect(json.pages).toBe(8);

    const other = await account();
    const theirs = await storePdfLike(other.user.id, fixture('multi-page.pdf'));
    const pending = await storePdfLike(user.id, fixture('multi-page.pdf'), { chargedTo: 'pending' });
    const expired = await storePdfLike(user.id, fixture('multi-page.pdf'), { expiresAt: Date.now() - 1000 });
    const missing = 'f'.repeat(64);
    for (const id of [theirs, pending, expired, missing]) {
      const response = await postToolkit(secret, 'merge', { files: [file('rotated.pdf'), { pdf_id: id }] });
      expect(response.status, id).toBe(404);
      expect(await errorOf(response)).toMatchObject({ code: 'not_found', message: expect.stringMatching(/^files\[1\]\.pdf_id is not one of your stored PDFs/), details: { pdf_id: id } });
    }
    // A row without its R2 object answers the same.
    const lost = await storePdfLike(user.id, fixture('multi-page.pdf'));
    await env.BUCKET.delete(pdfR2Key(user.id, lost));
    expect((await postToolkit(secret, 'merge', { files: [{ pdf_id: lost }] })).status).toBe(404);
  });

  it('multipart/form-data: uploads in "files" (and "image"), the other fields as JSON in "options"', async () => {
    const { secret } = await account();
    const form = new FormData();
    form.append('files', new File([fixture('multi-page.pdf')], 'a.pdf', { type: 'application/pdf' }));
    form.append('files', new File([fixture('rotated.pdf')], 'b.pdf', { type: 'application/pdf' }));
    form.append('options', JSON.stringify({ filename: 'uploaded.pdf' }));
    const merged = await ok(await postForm(secret, 'merge', form));
    expect(merged).toMatchObject({ op: 'merge', pages: 13, filename: 'uploaded.pdf' });

    const stamp = new FormData();
    stamp.append('files', new File([fixture('multi-page.pdf')], 'a.pdf'));
    stamp.append('image', new File([fixture('logo.png')], 'logo.png', { type: 'image/png' }));
    stamp.append('options', JSON.stringify({ position: 'bottom-left', opacity: 0.5 }));
    expect((await ok(await postForm(secret, 'stamp', stamp))).pages).toBe(8);

    const images = new FormData();
    images.append('files', new File([fixture('photo.jpg')], 'photo.jpg'));
    images.append('files', new File([fixture('grey.png')], 'grey.png'));
    expect((await ok(await postForm(secret, 'from-images', images))).pages).toBe(2);

    // A multipart body can also carry only options (files by url or pdf_id).
    const byId = new FormData();
    byId.append('options', JSON.stringify({ files: [{ pdf_id: merged.id }], text: 'X' }));
    expect((await ok(await postForm(secret, 'stamp', byId))).pages).toBe(13);
  });

  it('multipart/form-data: wrong parts are 400 with what to send instead', async () => {
    const { user, secret } = await account();
    const cases: [string, (form: FormData) => void, RegExp][] = [
      ['an unknown part', (form) => form.append('ranges', '1-3'), /^Unknown form field "ranges"\. A multipart request has one file part "files"/],
      ['text in "files"', (form) => form.append('files', 'not a file'), /"files" must be a file upload, not text/],
      ['options that are not JSON', (form) => form.append('options', '{ranges: 1}'), /"options" is not valid JSON/],
      ['options that are a list', (form) => form.append('options', '[1]'), /"options" must be a JSON object/],
      ['two options parts', (form) => (form.append('options', '{}'), form.append('options', '{}')), /Send one "options" part, not 2/],
      ['files twice', (form) => (form.append('files', new File([fixture('multi-page.pdf')], 'a.pdf')), form.append('options', JSON.stringify({ files: [{ pdf_id: 'a'.repeat(64) }] }))), /either as "files" parts or as "files" in "options"/],
      ['an unknown option', (form) => (form.append('files', new File([fixture('multi-page.pdf')], 'a.pdf')), form.append('options', '{"every": 2}')), /Unknown field "every"/],
      ['no files', (form) => form.append('options', '{}'), /"files" must be a non-empty list/],
    ];
    for (const [what, build, message] of cases) {
      const form = new FormData();
      build(form);
      const response = await postForm(secret, 'merge', form);
      expect(response.status, what).toBe(400);
      expect((await errorOf(response)).message, what).toMatch(message);
    }
    const broken = await call('/v1/pdf-tools/merge', { method: 'POST', headers: { ...bearer(secret), 'content-type': 'multipart/form-data; boundary=nothing' }, body: 'not multipart' });
    expect(broken.status).toBe(400);
    expect((await errorOf(broken)).message).toMatch(/could not be read as multipart\/form-data/);
    expect((await usageOf(user.id)).used).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

describe('limits', () => {
  it('files per request, and one file for single-file operations', async () => {
    const { secret } = await account();
    const many = await postToolkit(secret, 'merge', { files: Array.from({ length: PDF_TOOLKIT.maxFiles + 1 }, () => ({ pdf_id: 'a'.repeat(64) })) });
    expect(many.status).toBe(400);
    expect((await errorOf(many)).message).toMatch(new RegExp(`At most ${PDF_TOOLKIT.maxFiles} files per request; ${PDF_TOOLKIT.maxFiles + 1}`));
    const two = await postToolkit(secret, 'protect', { files: [file('multi-page.pdf'), file('multi-page.pdf')], user_password: 'x' });
    expect(two.status).toBe(400);
  });

  it('the request body: PDF_TOOLKIT.maxRequestBodyBytes, for JSON and multipart alike', async () => {
    const { secret } = await account();
    for (const type of ['application/json', 'multipart/form-data; boundary=x']) {
      const response = await call('/v1/pdf-tools/merge', {
        method: 'POST',
        headers: { ...bearer(secret), 'content-type': type, 'content-length': String(PDF_TOOLKIT.maxRequestBodyBytes + 1) },
        body: '{}',
      });
      expect(response.status, type).toBe(413);
      expect((await errorOf(response)).details).toEqual({ max_bytes: PDF_TOOLKIT.maxRequestBodyBytes });
    }
  });

  it('a JSON body is counted before it is parsed: more than PDF_TOOLKIT.maxJsonTokens elements is 400 (SEC-5)', async () => {
    const { secret } = await account();
    // Before the count, JSON.parse built every element first: 9 million of these took 369 MB.
    const arrays = PDF_TOOLKIT.maxJsonTokens + 10;
    const response = await postToolkit(secret, 'merge', `{"files":[${'[],'.repeat(arrays)}[]]}`);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: 'invalid_request',
      message: expect.stringMatching(/^The request body has more than 50,000 JSON elements/),
      details: { reason: 'too_many_elements', max_json_elements: PDF_TOOLKIT.maxJsonTokens },
    });
    // Brackets and commas inside strings (and escaped quotes) are text, not elements.
    const text = '[,{:'.repeat(PDF_TOOLKIT.maxJsonTokens);
    const inString = await postToolkit(secret, 'stamp', { files: [file('multi-page.pdf')], text: `\\"${text}` });
    expect(inString.status).toBe(400);
    expect((await errorOf(inString)).details?.reason).not.toBe('too_many_elements');
  });

  it('a multipart body is counted before formData(): more parts than files, image and options is 400 (SEC-5)', async () => {
    const { secret } = await account();
    const form = new FormData();
    for (let i = 0; i < PDF_TOOLKIT.maxFiles + 3; i++) form.append('files', new File([new Uint8Array(0)], `${i}.pdf`));
    const response = await postForm(secret, 'merge', form);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(new RegExp(`^A multipart request may have at most ${PDF_TOOLKIT.maxFiles + 2} parts`));
    // The most a request can use still reaches the operation's own checks.
    const full = new FormData();
    for (let i = 0; i < PDF_TOOLKIT.maxFiles; i++) full.append('files', new File([fixture('multi-page.pdf')], `${i}.pdf`));
    full.append('options', '{}');
    const merged = await postForm(secret, 'merge', full);
    expect(merged.status).toBe(200);
  });

  it('all files of a request together: PDF_TOOLKIT.maxInputBytes, downloads included', async () => {
    const { user, secret } = await account();
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set(new TextEncoder().encode('%PDF-1.7\n'));
    const first = `https://${host('big')}/one.pdf`;
    const second = `https://${host('big')}/two.pdf`;
    const third = `https://${host('big')}/three.pdf`;
    // The second declares its size; the third does not, and is cut off once it passes what is left.
    const stream = (): Response => new Response(new Blob([big]).stream(), { headers: { 'content-type': 'application/pdf' } });
    mockWeb({ [first]: pdfFile(big), [second]: pdfFile(big, { 'content-length': String(big.byteLength) }), [third]: stream });
    for (const url of [second, third]) {
      const response = await postToolkit(secret, 'merge', { files: [{ url: first }, { url }] });
      expect(response.status, url).toBe(413);
      expect(await errorOf(response)).toMatchObject({
        code: 'payload_too_large',
        message: expect.stringMatching(/^files\[1\] does not fit: the files of one request may be 20 MB together, and 8 MB were left for it\.$/),
        details: { url, max_bytes: PDF_TOOLKIT.maxInputBytes },
      });
    }
    // A stored PDF counts the same way.
    const stored = await storePdfLike(user.id, big);
    const response = await postToolkit(secret, 'merge', { files: [{ url: first }, { pdf_id: stored }] });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).details).toMatchObject({ pdf_id: stored });
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('one image: PDF_TOOLKIT.maxImageBytes, also when it is downloaded', async () => {
    const { secret } = await account();
    const url = `https://${host('huge')}/photo.jpg`;
    mockWeb({ [url]: pdfFile(new Uint8Array(PDF_TOOLKIT.maxImageBytes + 1), { 'content-type': 'image/jpeg' }) });
    const response = await postToolkit(secret, 'from-images', { files: [{ url }] });
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({ message: 'files[0] is larger than 10 MB, the limit for one image.', details: { url, max_bytes: PDF_TOOLKIT.maxImageBytes } });
  });

  it('pages: PDF_TOOLKIT.maxPages per file and per result', async () => {
    const { user, secret } = await account();
    const long = await makePdf(PDF_TOOLKIT.maxPages + 1);
    const response = await postToolkit(secret, 'stamp', { files: [{ base64: b64(long) }], text: 'x' });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).details).toMatchObject({ pages: PDF_TOOLKIT.maxPages + 1, max_pages: PDF_TOOLKIT.maxPages });

    const half = await makePdf(260);
    const merged = await postToolkit(secret, 'merge', { files: [{ base64: b64(half) }, { base64: b64(half) }] });
    expect(merged.status).toBe(413);
    expect((await errorOf(merged)).message).toMatch(/The merged PDF would have 520 pages/);
    expect((await usageOf(user.id)).used).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Files the toolkit refuses                                           */
/* ------------------------------------------------------------------ */

describe('refused files: encrypted, XFA, damaged, not a PDF', () => {
  it.each([
    ['an encrypted PDF that needs a password', file('encrypted-user.pdf'), 400, 'invalid_request', 'encrypted'],
    ['an encrypted PDF that opens without one', file('encrypted-owner.pdf'), 400, 'invalid_request', 'encrypted'],
    ['an XFA form', file('xfa.pdf'), 400, 'invalid_request', 'xfa'],
    ['a damaged PDF', { base64: b64(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\n%%EOF')) }, 400, 'invalid_request', 'damaged'],
    ['a file that is not a PDF', file('photo.jpg'), 415, 'unsupported_media_type', 'not_pdf'],
  ])('%s: refused with details.reason, nothing charged or stored', async (_, input, status, code, reason) => {
    const { user, secret } = await account();
    for (const op of ['merge', 'fields', 'fill'] as const) {
      const body = op === 'fill' ? { files: [input], values: { full_name: 'x' } } : { files: [input] };
      const response = await postToolkit(secret, op, body);
      expect(response.status, op).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe(code);
      expect(error.details).toMatchObject({ reason });
      expect(error.message).toMatch(/^files\[0\] /);
    }
    expect((await usageOf(user.id)).used).toBe(0);
    expect(await renderCount(user.id)).toBe(0);
    expect(await storedKeys(user.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Units, quota and the Free mark                                      */
/* ------------------------------------------------------------------ */

describe('units and quota', () => {
  it('counts ceil(pages / PDF_TOOLKIT.pagesPerUnit), at least one', async () => {
    const { user, secret } = await account();
    const cases: [number, number][] = [[1, 1], [10, 1], [11, 2], [20, 2], [21, 3]];
    let used = 0;
    for (const [pages, units] of cases) {
      const json = await ok(await postToolkit(secret, 'merge', { files: [{ base64: b64(await makePdf(pages)) }] }));
      expect([json.pages, json.credits_used], `${pages} pages`).toEqual([pages, units]);
      used += units;
      expect(json.usage.used).toBe(used);
    }
    // Identical requests are not served from a cache: each one counts and has its own id.
    const body = { files: [file('multi-page.pdf')] };
    const a = await ok(await postToolkit(secret, 'merge', body));
    const b = await ok(await postToolkit(secret, 'merge', body));
    expect(a.id).not.toBe(b.id);
    expect((await usageOf(user.id)).used).toBe(used + 2);
  });

  it('402 before anything is downloaded when no image is left', async () => {
    const { user, secret } = await account('free');
    await setUsed(user, 100);
    const url = `https://${host('never')}/a.pdf`;
    const { seen } = mockWeb({ [url]: pdfFile(fixture('multi-page.pdf')) });
    const response = await postToolkit(secret, 'merge', { files: [{ url }] });
    expect(response.status).toBe(402);
    const error = await errorOf(response);
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toMatch(/^A PDF toolkit result counts as at least 1 image and is charged as one block, from the monthly allowance; not enough is left \(0 of the 100 images on the Free plan/);
    expect(error.details).toMatchObject({ units_needed: 1, usage: { remaining: 0 } });
    expect(seen).toEqual([]);
  });

  it('402 when the result needs more than is left in one place: nothing is stored or charged', async () => {
    const { user, secret } = await account('free');
    await setUsed(user, 99);
    const response = await postToolkit(secret, 'merge', { files: [file('multi-page.pdf'), file('multi-page.pdf')] });
    expect(response.status).toBe(402);
    const error = await errorOf(response);
    expect(error.message).toMatch(/^This result counts as 2 images and is charged as one block/);
    expect(error.details).toMatchObject({ units_needed: 2 });
    expect((await usageOf(user.id)).used).toBe(99);
    expect(await renderCount(user.id)).toBe(0);
    expect(await storedKeys(user.id)).toEqual([]);
    // What fits is still made, and the image that uses the allowance up sends the 100% notice once.
    const { seen } = mockWeb({ 'https://api.resend.com/emails': () => Response.json({ id: 'em_test' }) });
    const last = await ok(await postToolkit(secret, 'merge', { files: [file('multi-page.pdf')] }));
    expect([last.credits_used, last.usage.remaining]).toEqual([1, 0]);
    expect(seen).toEqual(['https://api.resend.com/emails']);
    const [, init] = vi.mocked(fetch).mock.calls.find(([input]) => requestUrl(input).hostname === 'api.resend.com')!;
    const period = (await usageOf(user.id)).period_start;
    expect((init!.headers as Record<string, string>)['Idempotency-Key']).toBe(`quota-100-${user.id}-${period}-100`);
  });

  it('images spent by another request between the check and the charge: 402, and the stored files are deleted again', async () => {
    const { user, secret } = await account('free');
    await setUsed(user, 98);
    // env.DB, except that the allowance is used up right before the charge's first batch runs.
    const sqlOf = new WeakMap<D1PreparedStatement, string>();
    let spent = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            const bind = statement.bind.bind(statement);
            return Object.assign(statement, {
              bind: (...values: unknown[]) => {
                const bound = bind(...values);
                sqlOf.set(bound, sql);
                return bound;
              },
            });
          };
        }
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!spent && statements.some((statement) => sqlOf.get(statement)?.includes('INSERT INTO pdf_usage'))) {
              spent = true;
              // Both files are claimed in the ledger and stored in R2 at this point.
              expect(await renderCount(user.id)).toBe(2);
              expect(await storedKeys(user.id)).toHaveLength(2);
              await setUsed(user, 100);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const response = await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], ranges: '1-4,5-8' }, { ...env, DB: db } as Env);
    expect(spent).toBe(true);
    expect(response.status).toBe(402);
    expect(await errorOf(response)).toMatchObject({ code: 'quota_exceeded', message: expect.stringMatching(/^This result counts as 2 images/), details: { units_needed: 2 } });
    expect(await renderCount(user.id)).toBe(0);
    expect(await storedKeys(user.id)).toEqual([]);
    expect(await first(env.DB, 'SELECT pdfs FROM pdf_usage WHERE user_id = ?1', user.id)).toBeNull();
  });

  it('a block that does not fit the allowance is taken whole from a top-up', async () => {
    const { user, secret } = await account('starter');
    await setUsed(user, 1999);
    await creditTopup(env.DB, { userId: user.id, transactionId: `txn_${crypto.randomUUID()}`, images: 5, now: Date.now() });
    const json = await ok(await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], ranges: '1-4,5-8' }));
    expect(json.credits_used).toBe(2);
    expect(json.usage).toMatchObject({ used: 1999, topup_remaining: 3 });
    const files = (json as unknown as { files: { id: string }[] }).files;
    for (const part of files) expect((await ledgerRow(part.id))?.charged_to).toBe('topup');
  });
});

describe('the Free plan mark', () => {
  it('Free results carry "Made with Link To Card" on every page; Starter results do not', async () => {
    const free = await account('free');
    const starter = await account('starter');
    for (const [who, expected] of [[free, true], [starter, false]] as const) {
      const merged = await ok(await postToolkit(who.secret, 'merge', { files: [file('multi-page.pdf'), file('rotated.pdf')] }));
      expect(await marked(await storedBytes(merged.url))).toEqual(Array.from({ length: 13 }, () => expected));
      const images = await ok(await postToolkit(who.secret, 'from-images', { files: [file('photo.jpg')], response: 'url' }));
      expect(await marked(await storedBytes(images.url))).toEqual([expected]);
    }
    // Free results are kept for the Free plan's 7 days.
    const json = await ok(await postToolkit(free.secret, 'stamp', { files: [file('multi-page.pdf')], text: 'x' }));
    expect(Date.parse(json.expires_at) - Date.parse(json.created_at)).toBe(7 * DAY_MS);
  });

  it('a Free split marks every file, and a Free protect marks the pages it encrypts', async () => {
    const { secret } = await account('free');
    const split = (await ok(await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], every: 4 }))) as unknown as { files: { url: string }[] };
    for (const part of split.files) expect(await marked(await storedBytes(part.url))).toEqual([true, true, true, true]);
    const response = await postToolkit(secret, 'protect', { files: [file('multi-page.pdf')], user_password: 'open-me', response: 'binary' });
    const opened = await PDFDocument.load(await bytesOf(response), { password: 'open-me' });
    expect(pageContent(opened, 0)).toContain(hexText(PDF.freeMark));
  });
});

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

describe('the RL_PDF_TOOLS rate limiter', () => {
  it('limits per API key, every operation, before the body is read', async () => {
    const { user, secret, keyId } = await account();
    const keys: string[] = [];
    const deny = { limit: ({ key }: { key: string }) => (keys.push(key), Promise.resolve({ success: false })) };
    const bindings = { ...env, RATE_LIMITS_DISABLED: '0', RL_IP: allowAll, RL_PDF_TOOLS: deny } as Env;
    for (const op of ['merge', 'fields']) {
      const response = await postToolkit(secret, op, 'not even json', bindings);
      expect(response.status, op).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(await errorOf(response)).toMatchObject({ code: 'rate_limited', details: { limit: 30, period_seconds: 60 } });
    }
    expect(keys).toEqual([keyId, keyId]);
    expect((await usageOf(user.id)).used).toBe(0);
    const allowed = await postToolkit(secret, 'merge', { files: [file('multi-page.pdf')] }, { ...bindings, RL_PDF_TOOLS: allowAll } as Env);
    expect(allowed.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Guarded downloads                                                   */
/* ------------------------------------------------------------------ */

describe('downloads cannot reach private networks or Link To Card itself', () => {
  it.each(['http://10.0.0.1/a.pdf', 'http://127.0.0.1/a.pdf', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.pdf', 'http://localhost/a.pdf', 'https://files.internal/a.pdf', 'https://example.com:8443/a.pdf'])(
    '%s is refused before any request (400)',
    async (url) => {
      const { secret } = await account();
      mockWeb({});
      const response = await postToolkit(secret, 'merge', { files: [{ url }] });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toMatch(/^files\[0\]\.url: /);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it('a public name that resolves to a private address is refused after the DNS lookup', async () => {
    const { secret } = await account();
    const sneaky = host('rebind');
    const v6 = host('rebind6');
    const { seen } = mockWeb({}, { [sneaky]: ['10.20.30.40'], [v6]: ['93.184.216.34', 'fd00::1'] });
    for (const name of [sneaky, v6]) {
      const url = `https://${name}/a.pdf`;
      const response = await postToolkit(secret, 'merge', { files: [{ url }] });
      expect(response.status, name).toBe(422);
      expect(await errorOf(response)).toMatchObject({ code: 'image_fetch_failed', message: expect.stringMatching(/resolves to a loopback, private-network or reserved address/), details: { reason: 'blocked_host', url } });
    }
    expect(seen).toEqual([]);
  });

  it.each(['https://linktocard.com/i/u_x/abc.pdf', 'https://www.linktocard.com/a.pdf', 'https://linktocard-staging.names-on-base.workers.dev/i/u_x/a.pdf'])(
    'our own host %s is refused without a request',
    async (url) => {
      const { secret } = await account();
      const { seen } = mockWeb({ [url]: pdfFile(fixture('multi-page.pdf')) });
      const response = await postToolkit(secret, 'merge', { files: [{ url }] });
      expect(response.status).toBe(422);
      expect(await errorOf(response)).toMatchObject({ code: 'image_fetch_failed', message: expect.stringMatching(/Link To Card's own addresses/), details: { reason: 'blocked_host', url } });
      expect(seen).toEqual([]);
    },
  );

  it('every redirect hop is checked: our own host, a private address, a private name, a bad port', async () => {
    const { user, secret } = await account();
    const privateName = host('inner');
    const targets: [string, string][] = [
      ['https://linktocard.com/i/u_x/abc.pdf', 'blocked_host'],
      [`https://cdn.${new URL(env.APP_URL).hostname}/a.pdf`, 'blocked_host'],
      ['http://127.0.0.1/admin', 'blocked_host'],
      ['http://[::ffff:10.0.0.1]/a.pdf', 'blocked_host'],
      [`https://${privateName}/a.pdf`, 'blocked_host'],
      ['https://example.com:8080/a.pdf', 'bad_port'],
      ['file:///etc/passwd', 'bad_scheme'],
    ];
    for (const [target, reason] of targets) {
      vi.restoreAllMocks();
      const start = `https://${host('hop')}/start.pdf`;
      const middle = `https://${host('hop')}/middle.pdf`;
      const { seen } = mockWeb({ [start]: redirect(middle, 301), [middle]: redirect(target, 307), [target]: pdfFile(fixture('multi-page.pdf')) }, { [privateName]: ['192.168.1.10'] });
      const response = await postToolkit(secret, 'merge', { files: [{ url: start }] });
      expect(response.status, target).toBe(422);
      const error = await errorOf(response);
      expect(error.details, target).toEqual({ reason, url: start });
      expect(error.message).toMatch(/\(reached by a redirect from https:\/\/hop-/);
      expect(seen, target).toEqual([start, middle]);
    }
    expect((await usageOf(user.id)).used).toBe(0);
  });

  it('a download that takes longer than LIMITS.imageFetchTimeoutMs is a 422 timeout', async () => {
    const { secret } = await account();
    const url = `https://${host('slow')}/a.pdf`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reached!: () => void;
      const requested = new Promise<void>((resolve) => (reached = resolve));
      mockWeb({
        [url]: () => {
          reached();
          return new Promise<Response>(() => undefined);
        },
      });
      const pending = postToolkit(secret, 'merge', { files: [{ url }] });
      // The timer is set before the first request goes out; move the clock once the host is waiting.
      await requested;
      await vi.advanceTimersByTimeAsync(LIMITS.imageFetchTimeoutMs + 10);
      const response = await pending;
      expect(response.status).toBe(422);
      expect((await errorOf(response)).details).toEqual({ reason: 'timeout', url });
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Storage lifetime                                                    */
/* ------------------------------------------------------------------ */

describe('stored results', () => {
  it('the daily cleanup removes expired results with their ledger rows, split files included', async () => {
    const { user, secret } = await account('free');
    const merged = await ok(await postToolkit(secret, 'merge', { files: [file('multi-page.pdf')] }));
    const split = (await ok(await postToolkit(secret, 'split', { files: [file('multi-page.pdf')], every: 4 }))) as unknown as { files: { id: string }[] };
    const ids = [merged.id, ...split.files.map((part) => part.id)];
    expect((await storedKeys(user.id)).sort()).toEqual(ids.map((id) => pdfR2Key(user.id, id)).sort());

    await runCleanup(env, Date.now() + 8 * DAY_MS);
    expect(await storedKeys(user.id)).toEqual([]);
    expect(await all(env.DB, 'SELECT cache_key FROM renders WHERE user_id = ?1', user.id)).toEqual([]);
    expect((await download(merged.url)).status).toBe(404);
  });
});
