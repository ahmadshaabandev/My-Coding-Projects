// Bulk documents end to end: POST /v1/batches through the real route, the queue messages it
// sent delivered to the Worker's own queue() handler (src/index.ts: consumeBatchMessages with the
// production renderBatchRow, i.e. getPdf with source "batch" and the trusted verification fields
// of decision D13) with a mock Browser Run binding, then every row's PDF, its /v/{id} page, the
// ZIP, cancel, the quota running out mid-batch and account deletion.
//
// The producer is recordingQueue() (tests/batch-helpers.ts): the pool's real local queue would
// start the consumer in the background with the pool's env, which has no BROWSER binding. The
// last test uses that real queue on purpose to show the binding and the consumer are wired: its
// rows fail "switched off", uncharged, exactly because that env cannot render.
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { PDF } from '../src/config';
import { first, run } from '../src/db/client';
import worker from '../src/index';
import { runCleanup } from '../src/lib/cleanup';
import { crc32 } from '../src/lib/zip';
import type { BatchQueueMessage, Env, UserRow } from '../src/types';
import { apiKeyFor, bearer, call, createUser, errorOf, setUsed, usageOf } from './app-helpers';
import { certificateRows, QUEUE_NAME, recordingQueue } from './batch-helpers';
import { FIXTURES, mockBrowser, type MockBrowser } from './pdf-helpers';

type Json = Record<string, any>;

interface Setup {
  user: UserRow;
  secret: string;
  browser: MockBrowser;
  queue: ReturnType<typeof recordingQueue<BatchQueueMessage>>;
  bindings: Env;
}

async function setup(plan: 'free' | 'starter' | 'pro' = 'starter'): Promise<Setup> {
  const user = await createUser(plan);
  const secret = (await apiKeyFor(user.id)).secret;
  const browser = mockBrowser();
  const queue = recordingQueue<BatchQueueMessage>();
  const bindings = { ...env, PDF_ENABLED: 'true', BATCH_ENABLED: 'true', BROWSER: browser.binding, BATCH_QUEUE: queue } as Env;
  return { user, secret, browser, queue, bindings };
}

function api(s: Pick<Setup, 'secret' | 'bindings'>, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = bearer(s.secret);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, s.bindings);
}

const pathOf = (url: string): string => new URL(url).pathname + new URL(url).search;

/** One queue() invocation of the Worker with these message bodies, as the platform would deliver them. */
async function consume(bindings: Env, bodies: BatchQueueMessage[], attempts = 1) {
  const batch = createMessageBatch<BatchQueueMessage>(
    QUEUE_NAME,
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })),
  );
  const ctx = createExecutionContext();
  await worker.queue!(batch as MessageBatch<BatchQueueMessage>, bindings, ctx);
  return getQueueResult(batch, ctx);
}

async function startBatch(s: Setup, body: Json): Promise<Json> {
  const response = await api(s, 'POST', '/v1/batches', body);
  expect(response.status, await response.clone().text()).toBe(202);
  return (await response.json()) as Json;
}

const getBatch = async (s: Setup, id: string): Promise<Json> => (await (await api(s, 'GET', `/v1/batches/${id}`)).json()) as Json;

interface ZipFile {
  name: string;
  data: Uint8Array;
  crc: number;
}

/**
 * A ZIP read the strict way: end record, central directory, and for each entry its local header
 * (method 0, flags 0x0808), the data, and the data descriptor after it, which must repeat the
 * central record's CRC-32 and size. Offsets must chain exactly, with nothing left over.
 */
function readZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const total = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  expect(centralOffset + centralSize).toBe(end);
  const files: ZipFile[] = [];
  let at = centralOffset;
  let expectedOffset = 0;
  for (let i = 0; i < total; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(offset, name).toBe(expectedOffset);
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint16(offset + 6, true)).toBe(0x0808);
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.slice(start, start + size);
    expect(crc32(data), name).toBe(crc);
    const descriptor = start + size;
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
    expect(view.getUint32(descriptor + 4, true)).toBe(crc);
    expect(view.getUint32(descriptor + 12, true)).toBe(size);
    expectedOffset = descriptor + 16;
    files.push({ name, data, crc });
    at += 46 + nameLength;
  }
  expect(expectedOffset).toBe(centralOffset);
  return files;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
const ONE_PAGE = FIXTURES['1-page'].bytes;

beforeEach(() => {
  // Quota warning emails go out in the background: no network in tests.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'em_test' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bulk documents end to end', () => {
  it('a 5-row certificate batch: queued, rendered by the queue consumer, each PDF and /v/{id} page, the ZIP, a revoke', async () => {
    const s = await setup('starter');
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(5), filename: 'certificate-{{recipient_name}}.pdf' });
    expect(created).toMatchObject({ status: 'queued', verify: true, total: 5 });
    const messages = s.queue.sent.map((message) => message.body);
    expect(messages).toHaveLength(5);

    const result = await consume(s.bindings, messages);
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(result.retryMessages).toEqual([]);

    const batch = await getBatch(s, created.id);
    expect(batch).toMatchObject({
      status: 'done',
      counts: { queued: 0, running: 0, done: 5, failed: 0, cancelled: 0 },
      pages: 5,
      credits_used: 5 * PDF.baseUnits,
    });
    expect(batch.started_at).not.toBeNull();
    expect(batch.finished_at).not.toBeNull();
    // Charged exactly like five POST /v1/pdf requests, recorded as source "batch" in the ledger and the browser time.
    expect((await usageOf(s.user.id)).used).toBe(5 * PDF.baseUnits);
    expect(s.browser.calls).toHaveLength(5);
    const sources = async (table: 'renders' | 'browser_usage') =>
      (await env.DB.prepare(`SELECT source FROM ${table} WHERE user_id = ?1`).bind(s.user.id).all<{ source: string }>()).results.map((row) => row.source);
    expect(await sources('renders')).toEqual(Array(5).fill('batch'));
    expect(await sources('browser_usage')).toEqual(Array(5).fill('batch'));

    const rows = batch.rows as Json[];
    for (const [i, row] of rows.entries()) {
      const name = `Recipient ${i + 1}`;
      expect(row).toMatchObject({ index: i, status: 'done', filename: `certificate-${name}.pdf`, pages: 1, credits_used: PDF.baseUnits, error: null });
      expect(row.certificate_id).toMatch(/^crt_[0-9a-z]{20}$/);
      expect(row.verify_url).toBe(`${env.APP_URL}/v/${row.certificate_id}`);

      // The browser got this row's data and the trusted verification fields (D13): the link and its QR code.
      const html = s.browser.calls.map((call) => (call.options as { html?: string }).html ?? '').find((text) => text.includes(row.certificate_id))!;
      expect(html).toContain(name);
      expect(html).toContain(row.verify_url);
      expect(html).toMatch(/<img class="verify-qr" src="data:image\/svg\+xml,/);
      // Starter plan: no free mark.
      expect(html).not.toContain(PDF.freeMark);

      // The stored PDF behind the row's public URL.
      const pdf = await call(pathOf(row.url), {}, s.bindings);
      expect(pdf.status, row.url).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(sameBytes(new Uint8Array(await pdf.arrayBuffer()), ONE_PAGE)).toBe(true);

      // The public verification page and its JSON twin.
      const page = await call(`/v/${row.certificate_id}`, {}, s.bindings);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(page.headers.get('x-robots-tag')).toBe('noindex');
      const text = await page.text();
      expect(text).toContain(name);
      expect(text).toContain(row.certificate_id);
      const record = (await (await call(`/v/${row.certificate_id}.json`, {}, s.bindings)).json()) as Json;
      expect(record).toMatchObject({ id: row.certificate_id, status: 'valid', recipient_name: name, issuer_name: 'Lanternworks Training', verify_url: row.verify_url });
    }

    // The ZIP: one part, its exact length, entries in row order under the row names, CRC-32 and bytes intact.
    expect(batch.zip_parts).toEqual([{ part: 1, entries: 5, bytes: expect.any(Number), url: `${env.APP_URL}/v1/batches/${created.id}/zip?part=1` }]);
    const zip = await api(s, 'GET', pathOf(batch.zip_parts[0].url));
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-disposition')).toBe(`attachment; filename="${created.id}.zip"`);
    const archive = new Uint8Array(await zip.arrayBuffer());
    expect(archive.byteLength).toBe(batch.zip_parts[0].bytes);
    expect(Number(zip.headers.get('content-length'))).toBe(archive.byteLength);
    const files = readZip(archive);
    expect(files.map((file) => file.name)).toEqual(rows.map((row) => row.filename));
    expect(files.every((file) => sameBytes(file.data, ONE_PAGE) && file.crc === crc32(ONE_PAGE))).toBe(true);
    expect((await api(s, 'GET', `/v1/batches/${created.id}/zip?part=2`)).status).toBe(404);

    // A redelivered message renders and charges nothing again.
    await consume(s.bindings, messages, 2);
    expect(s.browser.calls).toHaveLength(5);
    expect((await usageOf(s.user.id)).used).toBe(5 * PDF.baseUnits);

    // Revoking one record shows on its page at once; the others stay valid.
    const revoked = await api(s, 'POST', `/v1/certificates/${rows[0]!.certificate_id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as Json).status).toBe('revoked');
    expect(((await (await call(`/v/${rows[0]!.certificate_id}.json`, {}, s.bindings)).json()) as Json).status).toBe('revoked');
    expect(((await (await call(`/v/${rows[1]!.certificate_id}.json`, {}, s.bindings)).json()) as Json).status).toBe('valid');
  });

  it('a Free batch carries the free mark on every document and is not held back by RL_PDF_FREE (D12)', async () => {
    const s = await setup('free');
    const deny = { limit: () => Promise.resolve({ success: false }) };
    const allow = { limit: () => Promise.resolve({ success: true }) };
    s.bindings = { ...s.bindings, RATE_LIMITS_DISABLED: '0', RL_IP: allow, RL_KEY: allow, RL_PDF_FREE: deny } as Env;
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(2), verify: false });
    await consume(s.bindings, s.queue.sent.map((message) => message.body));
    const batch = await getBatch(s, created.id);
    expect(batch).toMatchObject({ status: 'done', counts: { done: 2 } });
    expect(s.browser.calls).toHaveLength(2);
    for (const call of s.browser.calls) {
      const options = call.options as { html?: string; pdfOptions?: { footerTemplate?: string } };
      expect(`${options.html ?? ''}${options.pdfOptions?.footerTemplate ?? ''}`).toContain(PDF.freeMark);
    }
    // verify: false: no records, no links.
    expect((batch.rows as Json[]).every((row) => row.certificate_id === null && row.verify_url === null)).toBe(true);
  });

  it('cancel: the document already made is kept and zipped, the rest are never rendered or charged', async () => {
    const s = await setup('starter');
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(3) });
    const [firstMessage, ...rest] = s.queue.sent.map((message) => message.body);
    await consume(s.bindings, [firstMessage!]);

    const cancelled = (await (await api(s, 'POST', `/v1/batches/${created.id}/cancel`)).json()) as Json;
    expect(cancelled).toMatchObject({ status: 'cancelled', counts: { done: 1, cancelled: 2, queued: 0 } });
    expect(cancelled.zip_parts).toEqual([expect.objectContaining({ part: 1, entries: 1 })]);

    const result = await consume(s.bindings, rest);
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1']);
    expect(s.browser.calls).toHaveLength(1);
    expect((await usageOf(s.user.id)).used).toBe(PDF.baseUnits);

    const batch = await getBatch(s, created.id);
    expect(batch.status).toBe('cancelled');
    expect((batch.rows as Json[]).map((row) => row.status)).toEqual(['done', 'cancelled', 'cancelled']);
    // Cancelled rows never get a certificate record.
    expect((batch.rows as Json[]).map((row) => row.certificate_id === null)).toEqual([false, true, true]);
    const files = readZip(new Uint8Array(await (await api(s, 'GET', `/v1/batches/${created.id}/zip`)).arrayBuffer()));
    expect(files.map((file) => file.name)).toEqual([batch.rows[0].filename]);
  });

  it('images running out mid-batch: the rows made are kept, the rest fail with quota_exceeded, the batch ends partial', async () => {
    const s = await setup('starter');
    const monthly = PLANS.starter.monthlyImages;
    // Exactly enough for 5 rows when the batch is accepted ...
    await setUsed(s.user, monthly - 5 * PDF.baseUnits);
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(5) });
    // ... then other renders use most of it: room for two documents.
    await setUsed(s.user, monthly - 2 * PDF.baseUnits);

    const result = await consume(s.bindings, s.queue.sent.map((message) => message.body));
    expect(result.retryMessages).toEqual([]);
    const batch = await getBatch(s, created.id);
    expect(batch).toMatchObject({ status: 'partial', counts: { done: 2, failed: 3, queued: 0, running: 0 }, credits_used: 2 * PDF.baseUnits });
    const rows = batch.rows as Json[];
    expect(rows.map((row) => row.status)).toEqual(['done', 'done', 'failed', 'failed', 'failed']);
    for (const row of rows.slice(2)) {
      expect(row.error.code).toBe('quota_exceeded');
      // D5: a failed row has no record, no link and was never charged.
      expect(row).toMatchObject({ url: null, certificate_id: null, verify_url: null, credits_used: null });
    }
    // The browser was asked for the two that fit and no more.
    expect(s.browser.calls).toHaveLength(2);
    expect((await usageOf(s.user.id)).remaining).toBe(0);
    expect(batch.zip_parts).toEqual([expect.objectContaining({ entries: 2 })]);
    expect(readZip(new Uint8Array(await (await api(s, 'GET', `/v1/batches/${created.id}/zip`)).arrayBuffer())).map((file) => file.name)).toEqual(
      rows.slice(0, 2).map((row) => row.filename),
    );
  });

  it('account deletion removes the batches, their rows, the certificate records and the PDFs', async () => {
    const s = await setup('pro');
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(2) });
    await consume(s.bindings, s.queue.sent.map((message) => message.body));
    const rows = (await getBatch(s, created.id)).rows as Json[];
    expect(rows.every((row) => row.status === 'done')).toBe(true);
    const count = async (sql: string, ...params: unknown[]) => (await first<{ n: number }>(env.DB, sql, ...params))?.n ?? 0;
    expect(await count('SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?1', s.user.id)).toBe(2);
    expect((await env.BUCKET.list({ prefix: `r/${s.user.id}/` })).objects).toHaveLength(2);

    const now = Date.now();
    await run(env.DB, 'UPDATE users SET deletion_requested_at = ?2, suspended_at = ?2 WHERE id = ?1', s.user.id, now);
    // Suspended at once: the records stop being shown before the cleanup runs.
    expect((await call(`/v/${rows[0]!.certificate_id}.json`, {}, s.bindings)).status).toBe(404);
    expect((await runCleanup(env, now)).deletedAccounts).toBe(1);

    expect(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?1', s.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', s.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM batch_rows WHERE batch_id = ?1', created.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM certificates WHERE user_id = ?1', s.user.id)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM renders WHERE user_id = ?1', s.user.id)).toBe(0);
    expect((await env.BUCKET.list({ prefix: `r/${s.user.id}/` })).objects).toEqual([]);
    for (const row of rows) {
      expect((await call(`/v/${row.certificate_id}`, {}, s.bindings)).status).toBe(404);
      expect((await call(pathOf(row.url), {}, s.bindings)).status).toBe(404);
    }
    // The API key went with the account.
    expect((await errorOf(await api(s, 'GET', `/v1/batches/${created.id}`))).code).toBe('invalid_api_key');
  });

  it('through the pool\'s real local queue, the Worker\'s queue() picks the rows up (here without Browser Run: failed, uncharged)', async () => {
    const s = await setup('starter');
    // The real BATCH_QUEUE of the pool (wrangler.toml); the request itself can render, the background consumer cannot.
    s.bindings = { ...s.bindings, BATCH_QUEUE: env.BATCH_QUEUE };
    const created = await startBatch(s, { template: 'certificate', rows: certificateRows(2) });
    let batch: Json = created;
    for (let waited = 0; waited < 20_000 && !['done', 'partial', 'failed', 'cancelled'].includes(batch.status); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      batch = await getBatch(s, created.id);
    }
    expect(batch).toMatchObject({ status: 'failed', counts: { failed: 2, queued: 0, running: 0 } });
    expect((batch.rows as Json[]).every((row) => row.error?.code === 'not_configured' && /Nothing was charged/.test(row.error.message))).toBe(true);
    expect(s.browser.calls).toHaveLength(0);
    expect((await usageOf(s.user.id)).used).toBe(0);
  });
});
