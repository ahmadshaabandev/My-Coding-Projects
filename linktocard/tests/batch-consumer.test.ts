// The bulk-documents queue consumer (src/batch/consumer.ts) with a fake render function:
// acks and retries, redelivery, claims held by another consumer, retries only for provider and
// busy causes, quota exhaustion, cancel, the kill switches, pacing, and never rendering a row
// twice. The queue is driven with createMessageBatch (tests/batch-helpers.ts deliver()).
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCertificate, verifyUrl } from '../src/batch/certificates';
import { BatchRowError, classifyRowError, isBatchQueueMessage, retryDecision, SWITCHED_OFF_ERROR } from '../src/batch/consumer';
import { batchCounts, cancelBatch, claimRow, getBatch, listBatchRows } from '../src/batch/store';
import { first, run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import {
  SETTINGS,
  batchEnv,
  busy,
  certificateRows,
  deliver,
  deliverOne,
  documentBroken,
  fakeRender,
  messageFor,
  providerDown,
  quotaGone,
  renderResult,
  storeBatch,
} from './batch-helpers';

const LEASE = SETTINGS.claimTimeoutMinutes * 60_000;

afterEach(() => {
  vi.restoreAllMocks();
});

const statusOf = async (batchId: string) => (await first<{ status: string }>(env.DB, 'SELECT status FROM batches WHERE id = ?1', batchId))!.status;
const rowsOf = (batchId: string) => listBatchRows(env.DB, batchId, { limit: 100 });

describe('rendering rows', () => {
  it('renders each row once, records its PDF, acks, and finishes the batch', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'A-1' }, { invoice_number: 'A-2' }, { invoice_number: 'A-3' }] });
    const render = fakeRender();
    const { result } = await deliver([0, 1, 2].map((i) => ({ id: `m${i}`, body: messageFor(batch.id, [i]) })), { render });
    expect(result.explicitAcks.sort()).toEqual(['m0', 'm1', 'm2']);
    expect(result.retryMessages).toEqual([]);
    expect(render.calls.map((call) => call.request.row.index)).toEqual([0, 1, 2]);
    const call = render.calls[1]!.request;
    expect(call.user.id).toBe(user.id);
    expect(call.batch.id).toBe(batch.id);
    expect(call.row).toEqual({ index: 1, filename: 'invoice-2.pdf', certificateId: null });
    expect(call.data).toEqual({ invoice_number: 'A-2' });
    expect(call.verification).toBeNull();
    expect(await statusOf(batch.id)).toBe('done');
    expect(await batchCounts(env.DB, batch.id)).toMatchObject({ done: 3, pages: 3, creditsUsed: 6 });
    expect((await rowsOf(batch.id))[2]).toMatchObject({ status: 'done', cacheKey: (2).toString(16).padStart(64, '0'), attempts: 1 });
  });

  it('gives a verified row its certificate id, verification URL and QR code', async () => {
    const { batch } = await storeBatch({ template: 'certificate', rows: certificateRows(1) });
    const render = fakeRender();
    await deliver([{ body: messageFor(batch.id, [0]) }], { render });
    const { data, row, verification } = render.calls[0]!.request;
    expect(row.certificateId).toMatch(/^crt_/);
    // Trusted values beside the row's data, never inside it (decision D13).
    expect(verification?.certificate_id).toBe(row.certificateId);
    expect(verification?.verify_url).toBe(verifyUrl(env.APP_URL, row.certificateId!));
    expect(String(verification?.verify_qr)).toMatch(/^data:image\/svg\+xml/);
    expect(Object.keys(verification!).sort()).toEqual(['certificate_id', 'verify_qr', 'verify_url']);
    for (const key of ['certificate_id', 'verify_url', 'verify_qr']) expect(data[key], key).toBeUndefined();
    expect(data.recipient_name).toBe('Recipient 1');
    // The record exists now that the PDF does, with the row's own facts (not the added fields).
    expect(await getCertificate(env.DB, row.certificateId!, Date.now())).toMatchObject({ status: 'valid', recipientName: 'Recipient 1' });
  });

  it('a verified row that fails gets no certificate record', async () => {
    const { batch } = await storeBatch({ template: 'certificate', rows: certificateRows(1) });
    const render = fakeRender(() => documentBroken());
    await deliver([{ body: messageFor(batch.id, [0]) }], { render });
    const id = render.calls[0]!.request.row.certificateId!;
    expect(await getCertificate(env.DB, id, Date.now())).toBeNull();
  });

  it('renders the rows of a multi-row message one after another', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}, {}] });
    let inFlight = 0;
    let most = 0;
    const render = fakeRender(async (request) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return renderResult(request);
    });
    const { result } = await deliver([{ id: 'all', body: messageFor(batch.id, [2, 0, 1]) }], { render });
    expect(result.explicitAcks).toEqual(['all']);
    expect(most).toBe(1);
    expect(render.calls.map((call) => call.request.row.index)).toEqual([2, 0, 1]);
  });
});

describe('at-least-once delivery', () => {
  it('a redelivered message for finished rows renders nothing and is acked', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    const render = fakeRender();
    await deliver([{ body: messageFor(batch.id, [0]) }, { body: messageFor(batch.id, [1]) }], { render });
    const again = await deliver([{ id: 'dup', attempts: 2, body: messageFor(batch.id, [0]) }, { id: 'dup2', body: messageFor(batch.id, [1]) }], { render });
    expect(again.result.explicitAcks.sort()).toEqual(['dup', 'dup2']);
    expect(render.calls).toHaveLength(2);
  });

  it('a row another consumer is rendering is not rendered: the message comes back once that claim times out', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const now = Date.now();
    await claimRow(env.DB, batch.id, 0, now, LEASE);
    const render = fakeRender();
    const { result } = await deliver([{ id: 'held', body: messageFor(batch.id, [0]) }], { render, now: () => now + 60_000 });
    expect(render.calls).toHaveLength(0);
    expect(result.retryMessages).toEqual([{ msgId: 'held' }]);
    // getQueueResult does not record delaySeconds; the message's own retry() call does.
    const { retry } = await deliverOne({ id: 'held2', body: messageFor(batch.id, [0]) }, { render, now: () => now + 60_000 });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: (LEASE - 60_000) / 1000 + 1 });
    expect(render.calls).toHaveLength(0);
  });

  it('on the last delivery a held row is left to its holder (acked, never retried into deletion)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    await claimRow(env.DB, batch.id, 0, Date.now(), LEASE);
    const { result } = await deliver([{ id: 'last', attempts: SETTINGS.queueMaxRetries + 1, body: messageFor(batch.id, [0]) }], { render: fakeRender() });
    expect(result.explicitAcks).toEqual(['last']);
    expect(result.retryMessages).toEqual([]);
  });

  it('a row whose consumer died is taken over after the claim timeout and rendered', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const then = Date.now() - LEASE - 1000;
    await claimRow(env.DB, batch.id, 0, then, LEASE);
    const render = fakeRender();
    const { result } = await deliver([{ id: 'redelivered', attempts: 2, body: messageFor(batch.id, [0]) }], { render });
    expect(result.explicitAcks).toEqual(['redelivered']);
    expect(render.calls).toHaveLength(1);
    expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('two consumers handed the same message at once render the row once', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const render = fakeRender(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return renderResult(request);
    });
    const [a, b] = await Promise.all([
      deliver([{ id: 'a', body: messageFor(batch.id, [0]) }], { render }),
      deliver([{ id: 'b', body: messageFor(batch.id, [0]) }], { render }),
    ]);
    expect(render.calls).toHaveLength(1);
    // One acked after rendering; the other was told to come back, and then finds it done.
    expect([...a.result.explicitAcks, ...b.result.explicitAcks]).toHaveLength(1);
    expect([...a.result.retryMessages, ...b.result.retryMessages]).toHaveLength(1);
    const later = await deliver([{ id: 'later', attempts: 2, body: messageFor(batch.id, [0]) }], { render });
    expect(later.result.explicitAcks).toEqual(['later']);
    expect(render.calls).toHaveLength(1);
  });
});

describe('retries', () => {
  it('a provider failure is retried with a growing delay, then the row fails at maxRowAttempts', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const render = fakeRender(() => providerDown());
    const body = messageFor(batch.id, [0]);
    for (let attempt = 1; attempt < SETTINGS.maxRowAttempts; attempt++) {
      const { retry, ack } = await deliverOne({ id: `p${attempt}`, attempts: attempt, body }, { render });
      expect(retry).toHaveBeenCalledWith({ delaySeconds: SETTINGS.retryDelaySeconds * attempt });
      expect(ack).not.toHaveBeenCalled();
      expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'queued', attempts: attempt, error: { code: 'render_failed' } });
    }
    const { retry, ack } = await deliverOne({ id: 'final', attempts: SETTINGS.maxRowAttempts, body }, { render });
    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
    expect(render.calls).toHaveLength(SETTINGS.maxRowAttempts);
    expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'failed', attempts: SETTINGS.maxRowAttempts, error: { code: 'render_failed' } });
    expect(await statusOf(batch.id)).toBe('failed');
  });

  it('busy waits at least as long as the renderer asked', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const { retry } = await deliverOne({ id: 'busy', body: messageFor(batch.id, [0]) }, { render: fakeRender(() => busy()), settings: { ...SETTINGS, retryDelaySeconds: 4 } });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect((await rowsOf(batch.id))[0]!.error?.code).toBe('rate_limited');
  });

  it('then succeeds on a later delivery and clears the error', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const render = fakeRender((request, call) => (call === 1 ? busy() : renderResult(request)));
    await deliver([{ body: messageFor(batch.id, [0]) }], { render });
    const { result } = await deliver([{ id: 'second', attempts: 2, body: messageFor(batch.id, [0]) }], { render });
    expect(result.explicitAcks).toEqual(['second']);
    expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'done', attempts: 2, error: null });
    expect(await statusOf(batch.id)).toBe('done');
  });

  it('never retries on the message\'s last delivery, even below maxRowAttempts', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const { result } = await deliver([{ id: 'last', attempts: SETTINGS.queueMaxRetries + 1, body: messageFor(batch.id, [0]) }], { render: fakeRender(() => providerDown()) });
    expect(result.explicitAcks).toEqual(['last']);
    expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('a document failure fails the row at once', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    const render = fakeRender((request) => (request.row.index === 0 ? documentBroken() : renderResult(request)));
    const { result } = await deliver([{ id: 'a', body: messageFor(batch.id, [0]) }, { id: 'b', body: messageFor(batch.id, [1]) }], { render });
    expect(result.explicitAcks.sort()).toEqual(['a', 'b']);
    expect(result.retryMessages).toEqual([]);
    expect((await rowsOf(batch.id)).map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['failed', 'template_error'],
      ['done', null],
    ]);
    expect(await statusOf(batch.id)).toBe('partial');
  });

  it('an unexpected error is retried like a provider failure, with a generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const { result } = await deliver([{ id: 'oops', body: messageFor(batch.id, [0]) }], { render: fakeRender(() => new TypeError('x is undefined')) });
    expect(result.retryMessages).toEqual([{ msgId: 'oops' }]);
    expect((await rowsOf(batch.id))[0]!.error).toEqual({ code: 'internal_error', message: expect.stringContaining('Nothing was charged') });
    expect(JSON.stringify(await rowsOf(batch.id))).not.toContain('x is undefined');
  });

  it('a multi-row message is retried for its failed row only; finished rows are skipped next time', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    const render = fakeRender((request, call) => (request.row.index === 0 && call === 1 ? providerDown() : renderResult(request)));
    const first1 = await deliver([{ id: 'pair', body: messageFor(batch.id, [0, 1]) }], { render });
    expect(first1.result.retryMessages).toEqual([{ msgId: 'pair' }]);
    await deliver([{ id: 'pair', attempts: 2, body: messageFor(batch.id, [0, 1]) }], { render });
    expect(render.calls.map((call) => call.request.row.index)).toEqual([0, 1, 0]);
    expect(await statusOf(batch.id)).toBe('done');
  });
});

describe('quota exhausted mid-batch', () => {
  it('fails that row and every queued row with quota_exceeded; the batch ends partial', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 5 }, () => ({})) });
    const render = fakeRender((request) => (request.row.index >= 2 ? quotaGone() : renderResult(request)));
    const { result } = await deliver([0, 1, 2, 3, 4].map((i) => ({ id: `q${i}`, body: messageFor(batch.id, [i]) })), { render });
    expect(result.explicitAcks.sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    expect(result.retryMessages).toEqual([]);
    // Rows 3 and 4 were failed with row 2 and never reached the renderer.
    expect(render.calls.map((call) => call.request.row.index)).toEqual([0, 1, 2]);
    expect((await rowsOf(batch.id)).map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['done', null],
      ['done', null],
      ['failed', 'quota_exceeded'],
      ['failed', 'quota_exceeded'],
      ['failed', 'quota_exceeded'],
    ]);
    expect(await statusOf(batch.id)).toBe('partial');
  });
});

describe('cancel', () => {
  it('rows of a cancelled batch are acked without rendering', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}, {}] });
    const render = fakeRender();
    await deliver([{ body: messageFor(batch.id, [0]) }], { render });
    await cancelBatch(env.DB, user.id, batch.id, Date.now());
    const { result } = await deliver([{ id: 'c1', body: messageFor(batch.id, [1]) }, { id: 'c2', body: messageFor(batch.id, [2]) }], { render });
    expect(result.explicitAcks.sort()).toEqual(['c1', 'c2']);
    expect(render.calls).toHaveLength(1);
    expect((await rowsOf(batch.id)).map((row) => row.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect((await getBatch(env.DB, user.id, batch.id))!.status).toBe('cancelled');
  });

  it('a row being rendered when the batch is cancelled finishes, and the batch stays cancelled', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    const render = fakeRender(async (request) => {
      if (request.row.index === 0) await cancelBatch(env.DB, user.id, batch.id, Date.now());
      return renderResult(request);
    });
    await deliver([{ body: messageFor(batch.id, [0]) }, { body: messageFor(batch.id, [1]) }], { render });
    expect(render.calls).toHaveLength(1);
    expect((await rowsOf(batch.id)).map((row) => row.status)).toEqual(['done', 'cancelled']);
    const finished = (await getBatch(env.DB, user.id, batch.id))!;
    expect(finished.status).toBe('cancelled');
    expect(finished.finishedAt).not.toBeNull();
  });
});

describe('kill switches and accounts', () => {
  it('with bulk documents or PDFs switched off, queued rows fail uncharged with not_configured', async () => {
    for (const bindings of [batchEnv({ BATCH_ENABLED: 'false' }), batchEnv({ BATCH_ENABLED: undefined }), batchEnv({ PDF_ENABLED: 'false' }), batchEnv({ BROWSER: undefined })]) {
      const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
      const render = fakeRender();
      const { result } = await deliver([{ id: 'off', body: messageFor(batch.id, [0, 1]) }], { render }, bindings);
      expect(result.explicitAcks).toEqual(['off']);
      expect(render.calls).toHaveLength(0);
      expect((await rowsOf(batch.id)).map((row) => row.error)).toEqual([SWITCHED_OFF_ERROR, SWITCHED_OFF_ERROR]);
      expect(await statusOf(batch.id)).toBe('failed');
    }
  });

  it('switched off, a row whose consumer died is failed too; one being rendered is left to its consumer', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    const now = Date.now();
    await claimRow(env.DB, batch.id, 0, now - LEASE - 1, LEASE); // dead claim
    await claimRow(env.DB, batch.id, 1, now, LEASE); // live claim
    const { result } = await deliver([{ id: 'off', body: messageFor(batch.id, [0, 1]) }], { render: fakeRender() }, batchEnv({ BATCH_ENABLED: 'false' }));
    expect(result.explicitAcks).toEqual(['off']);
    expect((await rowsOf(batch.id)).map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['failed', 'not_configured'],
      ['running', null],
    ]);
  });

  it('a wait longer than the retry budget (the Free brake, the failed-render cap) fails the row with that message', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const paused = new ApiError('rate_limited', 'PDF rendering on the Free plan is paused for a while.', { details: { retry_after_seconds: 3600 } });
    const { result } = await deliver([{ id: 'paused', body: messageFor(batch.id, [0]) }], { render: fakeRender(() => paused) });
    expect(result.explicitAcks).toEqual(['paused']);
    expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'failed', error: { code: 'rate_limited', message: paused.message } });
  });

  it('a suspended account, or one being deleted, renders nothing', async () => {
    for (const column of ['suspended_at', 'deletion_requested_at']) {
      const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}] });
      await run(env.DB, `UPDATE users SET ${column} = ?1 WHERE id = ?2`, Date.now(), user.id);
      const render = fakeRender();
      await deliver([{ body: messageFor(batch.id, [0]) }], { render });
      expect(render.calls).toHaveLength(0);
      expect((await rowsOf(batch.id))[0]).toMatchObject({ status: 'failed', error: { code: 'account_suspended' } });
    }
  });

  it('the render sees the account as it is now (an upgrade mid-batch counts)', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] }, { plan: 'free' });
    const render = fakeRender();
    await deliver([{ body: messageFor(batch.id, [0]) }], { render });
    await run(env.DB, "UPDATE users SET plan = 'pro' WHERE id = ?1", user.id);
    await deliver([{ body: messageFor(batch.id, [1]) }], { render });
    expect(render.calls.map((call) => call.request.user.plan)).toEqual(['free', 'pro']);
  });
});

describe('messages and failures around the rows', () => {
  it('a malformed message is dropped (acked), never retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bodies = [null, 'text', {}, { batchId: 'bat_x', rows: [] }, { batchId: 'nope', rows: [0] }, { batchId: 'bat_x', rows: [-1] }, { batchId: 'bat_x', rows: [1.5] }];
    const { result } = await deliver(bodies.map((body, i) => ({ id: `bad${i}`, body })), { render: fakeRender() });
    expect(result.explicitAcks).toHaveLength(bodies.length);
    expect(result.retryMessages).toEqual([]);
    expect(isBatchQueueMessage(messageFor('bat_abc', [0, 1]))).toBe(true);
  });

  it('a message for a batch that no longer exists is acked', async () => {
    const { result } = await deliver([{ id: 'gone', body: messageFor('bat_0000000000000000', [0]) }], { render: fakeRender() });
    expect(result.explicitAcks).toEqual(['gone']);
  });

  it('when D1 itself fails the message is retried, and acked on its last delivery; nothing is thrown', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const brokenDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === 'batch') return () => Promise.reject(new Error('D1_ERROR: database is unavailable'));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bindings = batchEnv({ DB: brokenDb });
    const { retry } = await deliverOne({ id: 'db', attempts: 2, body: messageFor(batch.id, [0]) }, { render: fakeRender() }, bindings);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: SETTINGS.retryDelaySeconds * 2 });
    const last = await deliverOne({ id: 'db', attempts: SETTINGS.queueMaxRetries + 1, body: messageFor(batch.id, [0]) }, { render: fakeRender() }, bindings);
    expect(last.retry).not.toHaveBeenCalled();
    expect(last.ack).toHaveBeenCalled();
  });

  it('background work that fails is logged, so it cannot make the platform retry the batch', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args));
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const render = fakeRender((request) => {
      request.background(Promise.reject(new Error('email failed')));
      return renderResult(request);
    });
    const { result } = await deliver([{ id: 'bg', body: messageFor(batch.id, [0]) }], { render });
    expect(result.outcome).toBe('ok');
    expect(result.explicitAcks).toEqual(['bg']);
    expect(JSON.stringify(errors.map(String))).toContain('batch background work failed');
  });
});

describe('pacing', () => {
  it('a rendered row takes at least minRowMs; a stored one does not wait', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    let clock = 1_000_000;
    const waits: number[] = [];
    const render = fakeRender((request) => {
      clock += 230; // a fast Browser Run render
      return renderResult(request, { cached: request.row.index === 1 });
    });
    await deliver([{ body: messageFor(batch.id, [0, 1]) }], {
      render,
      settings: { ...SETTINGS, minRowMs: 1000 },
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect(waits).toEqual([770]);
  });
});

describe('decisions', () => {
  it('classifyRowError maps causes by error code; BatchRowError names its own', () => {
    expect(classifyRowError(quotaGone()).failure).toBe('quota');
    expect(classifyRowError(busy())).toMatchObject({ failure: 'busy', retryAfterSeconds: 10 });
    expect(classifyRowError(providerDown()).failure).toBe('provider');
    expect(classifyRowError(new ApiError('internal_error', 'x')).failure).toBe('provider');
    expect(classifyRowError(new ApiError('not_configured', 'x')).failure).toBe('stop');
    for (const code of ['template_error', 'render_timeout', 'image_fetch_failed', 'invalid_request', 'not_found', 'conflict', 'payload_too_large'] as const) {
      expect(classifyRowError(new ApiError(code, 'x')).failure, code).toBe('document');
    }
    // A render_failed that the renderer knows is the document's (an unreadable page count).
    expect(classifyRowError(new BatchRowError('document', providerDown()))).toMatchObject({ failure: 'document', error: { code: 'render_failed' } });
  });

  it('retryDecision retries provider and busy only, below maxRowAttempts and before the last delivery', () => {
    const s = { maxRowAttempts: 3, queueMaxRetries: 5, retryDelaySeconds: 30 };
    expect(retryDecision('provider', 1, 1, s)).toEqual({ retry: true, delaySeconds: 30 });
    expect(retryDecision('busy', 2, 2, s, 10)).toEqual({ retry: true, delaySeconds: 60 });
    expect(retryDecision('busy', 1, 1, { ...s, retryDelaySeconds: 4 }, 10)).toEqual({ retry: true, delaySeconds: 10 });
    expect(retryDecision('provider', 3, 3, s)).toEqual({ retry: false });
    expect(retryDecision('provider', 1, 6, s)).toEqual({ retry: false });
    for (const failure of ['document', 'quota', 'stop'] as const) expect(retryDecision(failure, 1, 1, s)).toEqual({ retry: false });
    // A wait longer than the row's whole retry budget (3 x 30 s here) fails the row now.
    expect(retryDecision('busy', 1, 1, s, 90)).toEqual({ retry: true, delaySeconds: 90 });
    expect(retryDecision('busy', 1, 1, s, 91)).toEqual({ retry: false });
    expect(retryDecision('busy', 1, 1, s, 3600)).toEqual({ retry: false });
    // Never past Queues' 24-hour delay limit.
    expect(retryDecision('provider', 1, 1, { ...s, retryDelaySeconds: 10 ** 6 })).toEqual({ retry: true, delaySeconds: 86_400 });
  });

  it('a rate limiter\'s Retry-After header counts as its wait', () => {
    const limited = new ApiError('rate_limited', 'Too many requests. Limit: 10 per 60 seconds. Retry shortly.', {
      headers: { 'retry-after': '60' },
      details: { limit: 10, period_seconds: 60 },
    });
    expect(classifyRowError(limited)).toMatchObject({ failure: 'busy', retryAfterSeconds: 60 });
    expect(classifyRowError(new ApiError('rate_limited', 'x'))).toMatchObject({ failure: 'busy', retryAfterSeconds: null });
  });
});
