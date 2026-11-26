// The bulk-documents HTTP layer (src/routes/batches.ts): kill switches, auth, validation in the
// documented order (D1 403/400 rows, D3 404 template, 402 quota, D2 409 cap, 413 body), the
// batch JSON (D4 default names, D6 fields), listing, cancel, ZIP parts (D9), the dashboard twins,
// /api/config's batch block and account deletion of batches in bounded steps.
//
// Queues: every request here gets recordingQueue() as BATCH_QUEUE (tests/batch-helpers.ts says
// why); rendering through the real consumer is tests/batches-e2e.test.ts.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { BATCH, DAY_MS, PDF } from '../src/config';
import { first, run } from '../src/db/client';
import { CLEANUP_LIMITS, runCleanup } from '../src/lib/cleanup';
import { crc32, zipArchiveSize } from '../src/lib/zip';
import { batchZipParts, parsePart, type ZipPart } from '../src/routes/batches';
import type { BatchRowRecord } from '../src/batch/types';
import type { BatchQueueMessage, Env, UserRow } from '../src/types';
import { apiKeyFor, bearer, call, createTemplate, createUser, dashboard, errorOf, ORIGIN, sessionCookieFor, setUsed } from './app-helpers';
import { certificateRows, recordingQueue } from './batch-helpers';
import { allowAll, mockBrowser } from './pdf-helpers';

type Json = Record<string, any>;

function routeEnv(overrides: Partial<Env> = {}): Env & { BATCH_QUEUE: ReturnType<typeof recordingQueue<BatchQueueMessage>> } {
  return { ...env, PDF_ENABLED: 'true', BATCH_ENABLED: 'true', BROWSER: mockBrowser().binding, BATCH_QUEUE: recordingQueue<BatchQueueMessage>(), ...overrides } as never;
}

function api(secret: string | null, method: string, path: string, body?: unknown, bindings: Env = routeEnv()): Promise<Response> {
  const headers: Record<string, string> = secret ? bearer(secret) : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return call(path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }, bindings);
}

async function account(plan: 'free' | 'starter' | 'pro' = 'pro'): Promise<{ user: UserRow; secret: string; cookie: string }> {
  const user = await createUser(plan);
  return { user, secret: (await apiKeyFor(user.id)).secret, cookie: await sessionCookieFor(user.id) };
}

const count = async (sql: string, ...params: unknown[]): Promise<number> => (await first<{ n: number }>(env.DB, sql, ...params))?.n ?? 0;

/** Entry names and data of a ZIP, read from its central directory (CRC-32 checked). */
function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const total = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < total; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.slice(start, start + size);
    expect(crc32(data), name).toBe(crc);
    entries.push({ name, data });
    at += 46 + nameLength;
  }
  return entries;
}

const ALL_PATHS: Array<[string, string]> = [
  ['POST', '/v1/batches'],
  ['GET', '/v1/batches'],
  ['GET', '/v1/batches/bat_0000000000000000'],
  ['GET', '/v1/batches/bat_0000000000000000/zip'],
  ['POST', '/v1/batches/bat_0000000000000000/cancel'],
  ['POST', '/api/batches'],
  ['GET', '/api/batches'],
  ['GET', '/api/batches/templates'],
  ['GET', '/api/batches/bat_0000000000000000'],
  ['GET', '/api/batches/bat_0000000000000000/zip'],
  ['POST', '/api/batches/bat_0000000000000000/cancel'],
];

describe('kill switches', () => {
  it.each(ALL_PATHS)('%s %s answers 503 not_configured unless BATCH_ENABLED and PDFs are on, before any auth', async (method, path) => {
    const body = method === 'POST' ? {} : undefined;
    const cases: Array<[Partial<Env>, string]> = [
      [{ BATCH_ENABLED: 'false' }, 'Bulk documents are not enabled yet.'],
      [{ BATCH_ENABLED: undefined }, 'Bulk documents are not enabled yet.'],
      // The batch switch is named first, even when PDFs are off too.
      [{ BATCH_ENABLED: 'false', PDF_ENABLED: 'false' }, 'Bulk documents are not enabled yet.'],
      [{ PDF_ENABLED: 'false' }, 'PDF rendering is not enabled yet.'],
      [{ BROWSER: undefined }, 'PDF rendering is not enabled yet.'],
    ];
    for (const [overrides, message] of cases) {
      const response = await call(path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN }, body: body && JSON.stringify(body) }, routeEnv(overrides));
      expect(response.status, `${method} ${path} ${JSON.stringify(overrides)}`).toBe(503);
      expect(await errorOf(response)).toMatchObject({ code: 'not_configured', message });
    }
  });

  it('with both on, the routes ask for an API key or a session', async () => {
    expect((await api(null, 'GET', '/v1/batches')).status).toBe(401);
    expect((await errorOf(await api('ltc_not_a_key', 'POST', '/v1/batches', {}))).code).toBe('invalid_api_key');
    expect((await dashboard(null, 'GET', '/api/batches', undefined, routeEnv())).status).toBe(401);
    expect((await dashboard(null, 'GET', '/api/batches/templates', undefined, routeEnv())).status).toBe(401);
  });

  it('creating a batch needs the queue binding: 503, and nothing is stored', async () => {
    const { user, secret } = await account();
    const response = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) }, routeEnv({ BATCH_QUEUE: undefined }));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('not_configured');
    expect(await count('SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id)).toBe(0);
    // Reading needs no queue.
    expect((await api(secret, 'GET', '/v1/batches', undefined, routeEnv({ BATCH_QUEUE: undefined }))).status).toBe(200);
  });

  it('counts every /v1/batches request against RL_IP and RL_KEY', async () => {
    const { secret } = await account();
    const deny = { limit: () => Promise.resolve({ success: false }) };
    const limits = { RATE_LIMITS_DISABLED: '0', RL_IP: allowAll, RL_KEY: allowAll } as Partial<Env>;
    expect((await api(secret, 'GET', '/v1/batches', undefined, routeEnv(limits))).status).toBe(200);
    for (const name of ['RL_IP', 'RL_KEY'] as const) {
      const response = await api(secret, 'GET', '/v1/batches', undefined, routeEnv({ ...limits, ...(name === 'RL_IP' ? { RL_IP: deny } : { RL_KEY: deny }) } as Partial<Env>));
      expect(response.status, name).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
    }
  });
});

describe('POST /v1/batches', () => {
  it('accepts a batch with 202, stores every row queued and sends one message per row', async () => {
    const { user, secret } = await account('starter');
    const bindings = routeEnv();
    const response = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(3) }, bindings);
    expect(response.status).toBe(202);
    const batch = (await response.json()) as Json;
    expect(batch).toMatchObject({
      status: 'queued',
      template: 'certificate',
      verify: true,
      total: 3,
      counts: { queued: 3, running: 0, done: 0, failed: 0, cancelled: 0 },
      pages: 0,
      credits_used: 0,
      started_at: null,
      finished_at: null,
      cancelled_at: null,
      zip_url: `${env.APP_URL}/v1/batches/${batch.id}/zip`,
      zip_parts: [],
    });
    expect(batch.id).toMatch(/^bat_[0-9a-z]{16}$/);
    expect(batch.rows).toBeUndefined();
    expect(bindings.BATCH_QUEUE.sent.map((message) => message.body)).toEqual([0, 1, 2].map((index) => ({ batchId: batch.id, rows: [index], attempt: 1 })));
    expect(await count("SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id = ?1 AND status = 'queued'", batch.id)).toBe(3);
    // The batch is listed for the plan's cache days if it never makes a PDF.
    const stored = await first<{ expires_at: number; created_at: number; user_id: string }>(env.DB, 'SELECT * FROM batches WHERE id = ?1', batch.id);
    expect(stored).toMatchObject({ user_id: user.id, expires_at: stored!.created_at + PLANS.starter.cacheDays * DAY_MS });
  });

  it('names the documents after the template by default (D4), and a custom template "document-n.pdf"', async () => {
    const { secret, cookie } = await account();
    const bindings = routeEnv();
    const starter = (await (await api(secret, 'POST', '/v1/batches', { template: 'invoice', rows: [{ invoice_number: 'A' }, { invoice_number: 'B' }] }, bindings)).json()) as Json;
    const starterRows = ((await (await api(secret, 'GET', `/v1/batches/${starter.id}`, undefined, bindings)).json()) as Json).rows as Json[];
    expect(starterRows.map((row) => row.filename)).toEqual(['invoice-1.pdf', 'invoice-2.pdf']);
    expect(starter.verify).toBe(false);

    const own = await createTemplate(cookie, '<h1>{{name}}</h1>', 'h1 { font-size: 20px; }');
    const custom = (await (await api(secret, 'POST', '/v1/batches', { template: own, rows: [{ name: 'x' }] }, bindings)).json()) as Json;
    const customRows = ((await (await api(secret, 'GET', `/v1/batches/${custom.id}`, undefined, bindings)).json()) as Json).rows as Json[];
    expect(customRows.map((row) => row.filename)).toEqual(['document-1.pdf']);
    // The custom template's version is pinned, so an edit fails the remaining rows instead of mixing designs.
    expect((await first<{ template_version: number | null }>(env.DB, 'SELECT template_version FROM batches WHERE id = ?1', custom.id))?.template_version).toBe(1);
  });

  it('refuses bad requests before storing anything, each with its documented status', async () => {
    const { user, secret } = await account('free');
    const post = (body: unknown) => api(secret, 'POST', '/v1/batches', body);
    const expectError = async (body: unknown, status: number, code: string, message?: RegExp) => {
      const response = await post(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe(code);
      if (message) expect(error.message).toMatch(message);
      return error;
    };
    await expectError('not json', 400, 'invalid_request');
    await expectError({ template: 'certificate', rows: certificateRows(1), tempalte: 'x' }, 400, 'invalid_request', /Unknown field "tempalte"/);
    await expectError({ template: 'certificate', rows: [] }, 400, 'invalid_request');
    await expectError({ template: 'bad id!', rows: certificateRows(1) }, 400, 'invalid_request');
    // D3: a well-formed id that is no starter and not the account's own template is 404, like POST /v1/pdf.
    await expectError({ template: 't_nosuchtemplate', rows: certificateRows(1) }, 404, 'not_found', /PDF template not found/);
    // D1: more rows than Free takes but what a higher plan takes: 403 plan_required naming that plan.
    const tooMany = await expectError({ template: 'certificate', rows: certificateRows(BATCH.maxRows.free + 1) }, 403, 'plan_required', /Starter plan takes/);
    expect(tooMany.details).toMatchObject({ rows: BATCH.maxRows.free + 1, max_rows: BATCH.maxRows.free, plan: 'free' });
    await expectError({ template: 'certificate', rows: [{ ...certificateRows(1)[0], certificate_id: 'mine' }] }, 400, 'invalid_request', /rows\[0\]/);
    await expectError({ template: 'certificate', rows: certificateRows(1), filename: '{{name}' }, 400, 'invalid_request');
    expect(await count('SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id)).toBe(0);
  });

  it('above every plan is 400 (split the rows), and a body over the limit is 413', async () => {
    const { secret } = await account('pro');
    const response = await api(secret, 'POST', '/v1/batches', { template: 'invoice', rows: Array.from({ length: BATCH.maxRows.pro + 1 }, () => ({})) });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/Split the rows/);
    const huge = JSON.stringify({ template: 'invoice', rows: [{ note: 'x'.repeat(BATCH.maxRequestBodyBytes) }] });
    const tooLarge = await api(secret, 'POST', '/v1/batches', huge);
    expect(tooLarge.status).toBe(413);
    expect((await errorOf(tooLarge)).code).toBe('payload_too_large');
  });

  it('402 when the allowance and top-ups cannot pay PDF.baseUnits per row; nothing stored or queued', async () => {
    const { user, secret } = await account('starter');
    await setUsed(user, PLANS.starter.monthlyImages - 3 * PDF.baseUnits + 1);
    const bindings = routeEnv();
    const response = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(3) }, bindings);
    expect(response.status).toBe(402);
    const error = await errorOf(response);
    expect(error.code).toBe('quota_exceeded');
    expect(error.details).toMatchObject({ units_needed: 3 * PDF.baseUnits });
    expect(bindings.BATCH_QUEUE.sent).toEqual([]);
    expect(await count('SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id)).toBe(0);
    // Exactly enough is accepted.
    await setUsed(user, PLANS.starter.monthlyImages - 3 * PDF.baseUnits);
    expect((await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(3) }, bindings)).status).toBe(202);
  });

  it(`409 conflict at ${BATCH.maxActivePerAccount} queued or running batches (D2); a finished one frees a place`, async () => {
    const { secret } = await account();
    const bindings = routeEnv();
    const ids: string[] = [];
    for (let i = 0; i < BATCH.maxActivePerAccount; i++) {
      const response = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) }, bindings);
      expect(response.status).toBe(202);
      ids.push(((await response.json()) as Json).id);
    }
    const refused = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) }, bindings);
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ code: 'conflict', details: { max_active_batches: BATCH.maxActivePerAccount } });
    expect((await api(secret, 'POST', `/v1/batches/${ids[0]}/cancel`, undefined, bindings)).status).toBe(200);
    expect((await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) }, bindings)).status).toBe(202);
  });

  it('a queue that refuses the messages fails the rows at once, uncharged, and the answer shows it', async () => {
    const { secret } = await account();
    const bindings = routeEnv({ BATCH_QUEUE: recordingQueue<BatchQueueMessage>({ failOnCall: 1 }) as never });
    const response = await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(2) }, bindings);
    expect(response.status).toBe(202);
    const batch = (await response.json()) as Json;
    expect(batch).toMatchObject({ status: 'failed', counts: { queued: 0, failed: 2 } });
    const rows = ((await (await api(secret, 'GET', `/v1/batches/${batch.id}`, undefined, bindings)).json()) as Json).rows as Json[];
    expect(rows.every((row) => row.error?.code === 'internal_error' && /Nothing was charged/.test(row.error.message))).toBe(true);
  });
});

describe('GET /v1/batches/{id}, the listing and cancel', () => {
  it('answers one batch with every documented field (D6) and its rows; another account sees 404', async () => {
    const { secret } = await account();
    const bindings = routeEnv();
    const created = (await (await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(2), filename: '{{recipient_name}}.pdf' }, bindings)).json()) as Json;
    const response = await api(secret, 'GET', `/v1/batches/${created.id}`, undefined, bindings);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const batch = (await response.json()) as Json;
    expect(Object.keys(batch).sort()).toEqual(
      ['id', 'status', 'template', 'verify', 'total', 'counts', 'pages', 'credits_used', 'created_at', 'started_at', 'finished_at', 'cancelled_at', 'zip_url', 'zip_parts', 'rows'].sort(),
    );
    expect(batch.rows).toEqual([
      { index: 0, status: 'queued', filename: 'Recipient 1.pdf', pages: null, credits_used: null, url: null, error: null, certificate_id: null, verify_url: null },
      { index: 1, status: 'queued', filename: 'Recipient 2.pdf', pages: null, credits_used: null, url: null, error: null, certificate_id: null, verify_url: null },
    ]);

    const other = await account();
    for (const path of [`/v1/batches/${created.id}`, `/v1/batches/${created.id}/zip`, `/v1/batches/${created.id}/cancel`]) {
      const answer = await api(other.secret, path.endsWith('cancel') ? 'POST' : 'GET', path, undefined, bindings);
      expect(answer.status, path).toBe(404);
      expect((await errorOf(answer)).code).toBe('not_found');
    }
    expect((await api(secret, 'GET', '/v1/batches/not-a-batch-id', undefined, bindings)).status).toBe(404);
    expect((await api(secret, 'GET', '/v1/batches/bat_UPPER', undefined, bindings)).status).toBe(404);
  });

  it('lists the account\'s batches newest first, in pages that continue with next_before', async () => {
    const { user, secret } = await account();
    const base = Date.now() - 10_000;
    const ids = ['bat_list00000000000a', 'bat_list00000000000b', 'bat_list00000000000c'];
    for (const [i, id] of ids.entries()) {
      await run(
        env.DB,
        "INSERT INTO batches (id, user_id, status, template, total, created_at, finished_at, expires_at) VALUES (?1, ?2, 'done', 'invoice', 0, ?3, ?3, ?4)",
        id,
        user.id,
        base + i,
        base + 30 * DAY_MS,
      );
    }
    const page = async (query: string) => (await (await api(secret, 'GET', `/v1/batches${query}`)).json()) as { batches: Json[]; next_before: string | null };
    const all = await page('');
    expect(all.batches.map((batch) => batch.id)).toEqual([...ids].reverse());
    expect(all.next_before).toBeNull();
    expect(all.batches[0]).toMatchObject({ status: 'done', total: 0, zip_url: `${env.APP_URL}/v1/batches/${ids[2]}/zip` });
    expect(all.batches[0]!.rows).toBeUndefined();

    const first = await page('?limit=2');
    expect(first.batches.map((batch) => batch.id)).toEqual([ids[2], ids[1]]);
    expect(first.next_before).toBe(ids[1]);
    const second = await page(`?limit=2&before=${first.next_before}`);
    expect(second.batches.map((batch) => batch.id)).toEqual([ids[0]]);
    expect(second.next_before).toBeNull();

    for (const query of ['?limit=0', `?limit=${BATCH.listMaxLimit + 1}`, '?limit=two', '?before=bat_nosuchbatch0000', '?before=x']) {
      const response = await api(secret, 'GET', `/v1/batches${query}`);
      expect(response.status, query).toBe(400);
    }
    // Another account's list is its own.
    expect((await page('')).batches.length).toBe(3);
    const other = await account();
    expect(((await (await api(other.secret, 'GET', '/v1/batches')).json()) as Json).batches).toEqual([]);
    expect((await api(other.secret, 'GET', `/v1/batches?before=${ids[0]}`)).status).toBe(400);
  });

  it('cancel stops the queued rows and answers the batch with its rows; again changes nothing', async () => {
    const { secret } = await account();
    const bindings = routeEnv();
    const created = (await (await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(2) }, bindings)).json()) as Json;
    const response = await api(secret, 'POST', `/v1/batches/${created.id}/cancel`, undefined, bindings);
    expect(response.status).toBe(200);
    const cancelled = (await response.json()) as Json;
    expect(cancelled).toMatchObject({ status: 'cancelled', counts: { queued: 0, cancelled: 2 }, zip_parts: [] });
    expect(cancelled.cancelled_at).not.toBeNull();
    expect((cancelled.rows as Json[]).map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
    const again = (await (await api(secret, 'POST', `/v1/batches/${created.id}/cancel`, undefined, bindings)).json()) as Json;
    expect(again.cancelled_at).toBe(cancelled.cancelled_at);
  });
});

/* ------------------------------------------------------------------ */
/* ZIP parts                                                           */
/* ------------------------------------------------------------------ */

function doneRow(index: number, bytes: number, overrides: Partial<BatchRowRecord> = {}): BatchRowRecord {
  return {
    batchId: 'bat_x',
    index,
    status: 'done',
    filename: `doc-${index + 1}.pdf`,
    certificateId: null,
    attempts: 1,
    claimedAt: null,
    cacheKey: index.toString(16).padStart(64, '0'),
    pages: 1,
    creditsUsed: 2,
    bytes,
    pdfExpiresAt: Date.now() + DAY_MS,
    error: null,
    finishedAt: Date.now(),
    ...overrides,
  };
}

const shape = (parts: ZipPart[]) => parts.map((part) => part.entries.map((entry) => entry.index));

describe('batchZipParts (D9)', () => {
  const now = Date.now();

  it('packs live done rows greedily in row order, at most maxEntries per part', () => {
    const rows = Array.from({ length: 7 }, (_, i) => doneRow(i, 100));
    expect(shape(batchZipParts(rows, now, { maxEntries: 3, maxBytes: 1e9 }))).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    // Every part's bytes are the exact archive length of its entries.
    for (const part of batchZipParts(rows, now, { maxEntries: 3, maxBytes: 1e9 })) expect(part.bytes).toBe(zipArchiveSize(part.entries));
    expect(batchZipParts([], now)).toEqual([]);
  });

  it('starts a new part when one more file would pass maxBytes; a file larger than that gets its own part', () => {
    const rows = [doneRow(0, 400), doneRow(1, 400), doneRow(2, 5000), doneRow(3, 100)];
    const two = zipArchiveSize([{ name: 'doc-1.pdf', size: 400 }, { name: 'doc-2.pdf', size: 400 }]);
    expect(shape(batchZipParts(rows, now, { maxEntries: 100, maxBytes: two }))).toEqual([[0, 1], [2], [3]]);
    expect(shape(batchZipParts(rows, now, { maxEntries: 100, maxBytes: two - 1 }))).toEqual([[0], [1], [2], [3]]);
    // The default limits: three 900 MB PDFs are two parts under 2 GiB each.
    const big = batchZipParts([doneRow(0, 900e6), doneRow(1, 900e6), doneRow(2, 900e6)], now);
    expect(shape(big)).toEqual([[0, 1], [2]]);
    expect(big.every((part) => part.bytes <= BATCH.zipPartMaxBytes)).toBe(true);
    expect(shape(batchZipParts(Array.from({ length: BATCH.zipPartMaxEntries + 1 }, (_, i) => doneRow(i, 10)), now)).map((part) => part.length)).toEqual([BATCH.zipPartMaxEntries, 1]);
  });

  it('leaves out rows without a stored PDF, and names stay unique across parts', () => {
    const rows = [
      doneRow(0, 10, { filename: 'a.pdf' }),
      doneRow(1, 10, { status: 'failed', cacheKey: null, bytes: null }),
      doneRow(2, 10, { pdfExpiresAt: now }),
      doneRow(3, 10, { filename: 'A.pdf' }),
      doneRow(4, 10, { filename: 'a.pdf' }),
    ];
    const parts = batchZipParts(rows, now, { maxEntries: 1, maxBytes: 1e9 });
    expect(parts.flatMap((part) => part.entries.map((entry) => `${entry.index}:${entry.name}`))).toEqual(['0:a.pdf', '3:A (2).pdf', '4:a (3).pdf']);
    expect(parts.map((part) => part.part)).toEqual([1, 2, 3]);
  });

  it('reads ?part: absent is 1, anything but a whole number from 1 is 400', () => {
    expect(parsePart(undefined)).toBe(1);
    expect(parsePart('')).toBe(1);
    expect(parsePart('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'one', '01', '9999999']) expect(() => parsePart(bad), bad).toThrow(/"part"/);
  });
});

/** A finished batch of `n` done rows whose PDFs are small stored objects (the route only reads them). */
async function storedBatch(user: UserRow, n: number, id: string): Promise<{ bodies: Uint8Array[] }> {
  const now = Date.now();
  const expires = now + 7 * DAY_MS;
  await run(
    env.DB,
    "INSERT INTO batches (id, user_id, status, template, total, created_at, finished_at, expires_at) VALUES (?1, ?2, 'done', 'invoice', ?3, ?4, ?4, ?5)",
    id,
    user.id,
    n,
    now,
    expires,
  );
  await run(
    env.DB,
    `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ?2 - 1)
     INSERT INTO batch_rows (batch_id, idx, status, data, filename, cache_key, pages, credits_used, bytes, pdf_expires_at, finished_at)
     SELECT ?1, i, 'done', '{}', 'doc-' || (i + 1) || '.pdf', printf('%064x', i + 1), 1, 2, 16, ?3, ?4 FROM seq`,
    id,
    n,
    expires,
    now,
  );
  const bodies = Array.from({ length: n }, (_, i) => new TextEncoder().encode(`%PDF-${String(i + 1).padStart(11, '0')}`));
  for (let start = 0; start < n; start += 50) {
    await Promise.all(
      bodies.slice(start, start + 50).map((body, offset) =>
        env.BUCKET.put(`r/${user.id}/${(start + offset + 1).toString(16).padStart(64, '0')}.pdf`, body, {
          customMetadata: { expiresAt: String(expires), createdAt: String(now), pages: '1', units: '2', filename: 'x.pdf', template: 'invoice' },
        }),
      ),
    );
  }
  return { bodies };
}

describe('GET /v1/batches/{id}/zip?part=N', () => {
  it(`splits ${BATCH.zipPartMaxEntries + 1} documents into two parts, each streamed with its exact Content-Length`, async () => {
    const { user, secret, cookie } = await account();
    const id = 'bat_zipparts00000001';
    const { bodies } = await storedBatch(user, BATCH.zipPartMaxEntries + 1, id);
    const batch = (await (await api(secret, 'GET', `/v1/batches/${id}`)).json()) as Json;
    const parts = batch.zip_parts as Json[];
    expect(parts.map((part) => [part.part, part.entries])).toEqual([
      [1, BATCH.zipPartMaxEntries],
      [2, 1],
    ]);
    expect(parts[1]).toMatchObject({ bytes: zipArchiveSize([{ name: `doc-${BATCH.zipPartMaxEntries + 1}.pdf`, size: 16 }]), url: `${env.APP_URL}/v1/batches/${id}/zip?part=2` });

    const second = await api(secret, 'GET', `/v1/batches/${id}/zip?part=2`);
    expect(second.status).toBe(200);
    expect(second.headers.get('content-type')).toBe('application/zip');
    expect(second.headers.get('content-disposition')).toBe(`attachment; filename="${id}-part-2-of-2.zip"`);
    expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('x-ltc-zip-part')).toBe('2');
    expect(second.headers.get('x-ltc-zip-parts')).toBe('2');
    expect(second.headers.get('content-length')).toBe(String(parts[1]!.bytes));
    const bytes = new Uint8Array(await second.arrayBuffer());
    expect(bytes.byteLength).toBe(parts[1]!.bytes);
    expect(readZip(bytes)).toEqual([{ name: `doc-${BATCH.zipPartMaxEntries + 1}.pdf`, data: bodies[BATCH.zipPartMaxEntries] }]);

    // No part is part 1: the first 500 in row order.
    const firstPart = await api(secret, 'GET', `/v1/batches/${id}/zip`);
    expect(firstPart.headers.get('content-length')).toBe(String(parts[0]!.bytes));
    const entries = readZip(new Uint8Array(await firstPart.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual(Array.from({ length: BATCH.zipPartMaxEntries }, (_, i) => `doc-${i + 1}.pdf`));
    expect(entries.every((entry, i) => entry.data.join() === bodies[i]!.join())).toBe(true);

    // A part that does not exist is 404; a malformed one 400.
    const missing = await api(secret, 'GET', `/v1/batches/${id}/zip?part=3`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: 'not_found', details: { parts: 2 } });
    expect((await api(secret, 'GET', `/v1/batches/${id}/zip?part=0`)).status).toBe(400);

    // The dashboard twin lists the same parts under /api, and downloads them with the session cookie.
    const viaDashboard = (await (await dashboard(cookie, 'GET', `/api/batches/${id}`, undefined, routeEnv())).json()) as Json;
    expect(viaDashboard.zip_url).toBe(`${env.APP_URL}/api/batches/${id}/zip`);
    expect((viaDashboard.zip_parts as Json[]).map((part) => part.url)).toEqual([1, 2].map((part) => `${env.APP_URL}/api/batches/${id}/zip?part=${part}`));
    const dashboardZip = await dashboard(cookie, 'GET', `/api/batches/${id}/zip?part=2`, undefined, routeEnv());
    expect(dashboardZip.status).toBe(200);
    expect(readZip(new Uint8Array(await dashboardZip.arrayBuffer())).map((entry) => entry.name)).toEqual([`doc-${BATCH.zipPartMaxEntries + 1}.pdf`]);
  });

  it('a batch without stored documents has no parts: 404', async () => {
    const { secret } = await account();
    const created = (await (await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) })).json()) as Json;
    const response = await api(secret, 'GET', `/v1/batches/${created.id}/zip`);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({ code: 'not_found', details: { parts: 0 } });
  });

  it('a PDF missing from R2 stops the download short instead of sending a wrong archive', async () => {
    const { user, secret } = await account();
    const id = 'bat_zipmissing000001';
    await storedBatch(user, 3, id);
    await env.BUCKET.delete(`r/${user.id}/${(2).toString(16).padStart(64, '0')}.pdf`);
    const response = await api(secret, 'GET', `/v1/batches/${id}/zip`);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});

describe('dashboard twins under /api/batches', () => {
  it('starts, reads, lists and cancels a batch with the session cookie; writes must be same-origin JSON', async () => {
    const { cookie } = await account();
    const bindings = routeEnv();
    const response = await dashboard(cookie, 'POST', '/api/batches', { template: 'certificate', rows: certificateRows(2), verify: false }, bindings);
    expect(response.status).toBe(202);
    const created = (await response.json()) as Json;
    expect(created).toMatchObject({ status: 'queued', verify: false, total: 2, zip_url: `${env.APP_URL}/api/batches/${created.id}/zip` });
    expect(bindings.BATCH_QUEUE.sent).toHaveLength(2);
    expect(((await (await dashboard(cookie, 'GET', `/api/batches/${created.id}`, undefined, bindings)).json()) as Json).rows).toHaveLength(2);
    expect(((await (await dashboard(cookie, 'GET', '/api/batches', undefined, bindings)).json()) as Json).batches.map((batch: Json) => batch.id)).toEqual([created.id]);

    const crossSite = await call('/api/batches', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }, bindings);
    expect(crossSite.status).toBe(403);
    const form = await call('/api/batches', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' }, body: '{}' }, bindings);
    expect(form.status).toBe(403);

    const cancelled = await dashboard(cookie, 'POST', `/api/batches/${created.id}/cancel`, undefined, bindings);
    expect(((await cancelled.json()) as Json).status).toBe('cancelled');
  });

  it('GET /api/batches/templates lists the PDF starters with their fields, preview source and verify default', async () => {
    const { cookie } = await account();
    const response = await dashboard(cookie, 'GET', '/api/batches/templates', undefined, routeEnv());
    expect(response.status).toBe(200);
    const { starter } = (await response.json()) as { starter: Json[] };
    expect(starter.map((template) => template.id)).toEqual(['invoice', 'receipt', 'quote', 'certificate', 'report']);
    const certificate = starter.find((template) => template.id === 'certificate')!;
    expect(certificate).toMatchObject({ verify_default: true, default_pdf: { format: expect.any(String), landscape: expect.any(Boolean) } });
    expect(certificate.html).toContain('{{recipient_name}}');
    expect(certificate.fields).toContainEqual({ key: 'recipient_name', label: expect.any(String), kind: 'text', required: expect.any(Boolean) });
    const invoice = starter.find((template) => template.id === 'invoice')!;
    expect(invoice.verify_default).toBe(false);
    expect(invoice.fields.find((field: Json) => field.key === 'items')).toMatchObject({ kind: 'items', item_fields: expect.arrayContaining(['description']) });
  });

  it('a suspended account is refused', async () => {
    const { user, cookie, secret } = await account();
    await run(env.DB, 'UPDATE users SET suspended_at = ?2 WHERE id = ?1', user.id, Date.now());
    expect((await errorOf(await dashboard(cookie, 'GET', '/api/batches', undefined, routeEnv()))).code).toBe('account_suspended');
    expect((await errorOf(await api(secret, 'POST', '/v1/batches', { template: 'certificate', rows: certificateRows(1) }))).code).toBe('account_suspended');
  });
});

describe('GET /api/config batch', () => {
  it('publishes the Bulk tab\'s limits only while a batch can start', async () => {
    const config = async (bindings: Env) => ((await (await call('/api/config', {}, bindings)).json()) as { batch: Json }).batch;
    expect(await config(routeEnv())).toEqual({
      enabled: true,
      max_rows: { free: BATCH.maxRows.free, starter: BATCH.maxRows.starter, pro: BATCH.maxRows.pro },
      max_active: BATCH.maxActivePerAccount,
      max_request_bytes: BATCH.maxRequestBodyBytes,
      max_value_chars: PDF.maxDataValueChars,
      max_columns: BATCH.maxCsvColumns,
      units_per_document: PDF.baseUnits,
      base_pages: PDF.basePages,
      pdf_formats: [...PDF.formats],
    });
    for (const off of [{ BATCH_ENABLED: 'false' }, { PDF_ENABLED: 'false' }, { BROWSER: undefined }, { BATCH_QUEUE: undefined }] as Partial<Env>[]) {
      expect(await config(routeEnv(off)), JSON.stringify(off)).toEqual({ enabled: false });
    }
  });
});

describe('account deletion', () => {
  it('removes more batches than one statement takes, their rows and the certificate records, then the account', async () => {
    const user = await createUser('pro');
    const now = Date.now();
    // More than one statement deletes at once (src/lib/cleanup.ts deleteAccountBatches).
    const batches = CLEANUP_LIMITS.batchesPerStatement + 5;
    for (let i = 0; i < batches; i++) {
      const id = `bat_del${user.id.slice(2, 10)}${String(i).padStart(4, '0')}`;
      await run(
        env.DB,
        "INSERT INTO batches (id, user_id, status, template, total, created_at, finished_at, expires_at) VALUES (?1, ?2, 'done', 'certificate', 1, ?3, ?3, ?4)",
        id,
        user.id,
        now,
        now + 30 * DAY_MS,
      );
      await run(env.DB, "INSERT INTO batch_rows (batch_id, idx, status, data, filename, certificate_id) VALUES (?1, 0, 'done', '{}', 'c.pdf', ?2)", id, `crt_${id}`);
      await run(env.DB, 'INSERT INTO certificates (id, user_id, batch_id, row_index, created_at) VALUES (?1, ?2, ?3, 0, ?4)', `crt_${id}`, user.id, id, now);
    }
    // A batch of another account is left alone.
    const keeper = await createUser('pro');
    await run(env.DB, "INSERT INTO batches (id, user_id, status, template, total, created_at, expires_at) VALUES ('bat_keep0000000000001', ?1, 'queued', 'certificate', 0, ?2, ?3)", keeper.id, now, now + DAY_MS);
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?2, suspended_at = ?2 WHERE id = ?1', user.id, now);

    expect((await runCleanup(env, now)).deletedAccounts).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?1', user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id LIKE 'bat_del' || ?1 || '%'", user.id.slice(2, 10))).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?1', user.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM batches WHERE id = 'bat_keep0000000000001'")).toBe(1);
  });
});
