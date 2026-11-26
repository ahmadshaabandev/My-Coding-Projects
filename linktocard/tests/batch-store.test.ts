// D1 side of bulk documents (src/batch/store.ts, the batches migration): atomic create with
// the active-batch cap, claims, finishing rows, final statuses, cancel, listings, the daily
// cleanup helpers and account deletion. Storage is shared by the whole file: every account is new.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { getCertificate } from '../src/batch/certificates';
import { enqueueBatchRows, ENQUEUE_FAILED_ERROR, batchMessages } from '../src/batch/enqueue';
import {
  batchCounts,
  cancelBatch,
  cancelClaimedRow,
  claimRow,
  completeRow,
  doneRows,
  failQueuedRows,
  failRow,
  failStaleRows,
  getBatch,
  listBatchRows,
  listBatches,
  purgeExpiredBatches,
  releaseRow,
  STALE_ROW_ERROR,
  type RowClaim,
} from '../src/batch/store';
import type { BatchRecord, BatchRenderResult } from '../src/batch/types';
import { batchJson } from '../src/batch/view';
import { all, first, run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import type { BatchQueueMessage } from '../src/types';
import { createUser } from './app-helpers';
import { DAY, SETTINGS, certificateRows, recordingQueue, storeBatch } from './batch-helpers';

const MINUTE = 60_000;
const LEASE = SETTINGS.claimTimeoutMinutes * MINUTE;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

function result(index: number, now: number, overrides: Partial<BatchRenderResult> = {}): BatchRenderResult {
  return { cacheKey: index.toString(16).padStart(64, '0'), pages: 1, creditsUsed: 2, bytes: 1000, expiresAt: now + 30 * DAY, cached: false, ...overrides };
}

async function claimed(batchId: string, index: number, now = NOW): Promise<RowClaim> {
  const claim = await claimRow(env.DB, batchId, index, now, LEASE);
  if (claim.kind !== 'claimed') throw new Error(`row ${index} was not claimed: ${claim.kind}`);
  return { batchId, index, attempt: claim.row.attempts };
}

/** Completes a claimed row of a verified batch the way the consumer does: with its certificate record. */
async function completeVerified(user: { id: string }, batchId: string, index: number, now = NOW, expiresAt = now + 30 * DAY): Promise<void> {
  const claim = await claimRow(env.DB, batchId, index, now, LEASE);
  if (claim.kind !== 'claimed') throw new Error(`row ${index} was not claimed: ${claim.kind}`);
  const certificate = { id: claim.row.certificateId!, userId: user.id, data: claim.row.data };
  await completeRow(env.DB, { batchId, index, attempt: claim.row.attempts }, result(index, now, { expiresAt }), now, certificate);
}

const certificateCount = async (batchId: string) => (await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM certificates WHERE batch_id = ?1', batchId))!.n;

const statusOf = async (batchId: string) => (await first<{ status: string; finished_at: number | null }>(env.DB, 'SELECT status, finished_at FROM batches WHERE id = ?1', batchId))!;

describe('creating a batch', () => {
  it('stores the batch and its rows; certificate records only once a row is done', async () => {
    const { user, batch } = await storeBatch({ template: 'certificate', rows: certificateRows(3), pdf: { landscape: true } }, { now: NOW });
    expect(batch).toMatchObject({ userId: user.id, status: 'queued', template: 'certificate', total: 3, verify: true, pdf: { format: null, landscape: true } });
    expect(batch.id).toMatch(/^bat_[0-9a-z]{16}$/);
    expect(await getBatch(env.DB, user.id, batch.id)).toEqual(batch);

    const rows = await all<{ idx: number; status: string; data: string; filename: string; certificate_id: string; attempts: number }>(
      env.DB,
      'SELECT idx, status, data, filename, certificate_id, attempts FROM batch_rows WHERE batch_id = ?1 ORDER BY idx',
      batch.id,
    );
    expect(rows.map((row) => [row.idx, row.status, row.filename, row.attempts])).toEqual([
      [0, 'queued', 'certificate-1.pdf', 0],
      [1, 'queued', 'certificate-2.pdf', 0],
      [2, 'queued', 'certificate-3.pdf', 0],
    ]);
    expect(JSON.parse(rows[2]!.data)).toEqual(certificateRows(3)[2]);

    // Each row has its id from the start, but no record says "valid" before its PDF exists.
    for (const row of rows) expect(row.certificate_id).toMatch(/^crt_/);
    expect(await certificateCount(batch.id)).toBe(0);
    expect(await getCertificate(env.DB, rows[1]!.certificate_id, NOW)).toBeNull();

    // Done rows get their record, with the row's facts; a failed row never does.
    await completeVerified(user, batch.id, 1, NOW + 1);
    await completeVerified(user, batch.id, 0, NOW + 2);
    await failRow(env.DB, await claimed(batch.id, 2), { code: 'template_error', message: 'broken' }, NOW + 3);
    for (const index of [0, 1]) {
      const row = rows[index]!;
      const record = await getCertificate(env.DB, row.certificate_id, NOW + 10);
      expect(record).toMatchObject({ id: row.certificate_id, status: 'valid', recipientName: `Recipient ${index + 1}`, issuerName: 'Lanternworks Training' });
      const stored = await first<{ batch_id: string; row_index: number; created_at: number }>(
        env.DB,
        'SELECT batch_id, row_index, created_at FROM certificates WHERE id = ?1',
        row.certificate_id,
      );
      expect(stored).toEqual({ batch_id: batch.id, row_index: index, created_at: NOW + 2 - index });
    }
    expect(await getCertificate(env.DB, rows[2]!.certificate_id, NOW + 10)).toBeNull();
    expect(await certificateCount(batch.id)).toBe(2);
  });

  it('writes a certificate record once, even when a row is completed twice', async () => {
    const { user, batch } = await storeBatch({ template: 'certificate', rows: certificateRows(1) }, { now: NOW });
    const claim = await claimRow(env.DB, batch.id, 0, NOW, LEASE);
    if (claim.kind !== 'claimed') throw new Error('not claimed');
    const certificate = { id: claim.row.certificateId!, userId: user.id, data: claim.row.data };
    const key = { batchId: batch.id, index: 0, attempt: claim.row.attempts };
    expect(await completeRow(env.DB, key, result(0, NOW), NOW, certificate)).toBe(true);
    expect(await completeRow(env.DB, key, result(0, NOW), NOW + 5, certificate)).toBe(false);
    expect(await certificateCount(batch.id)).toBe(1);
    expect((await getCertificate(env.DB, certificate.id, NOW + 10))!.createdAt).toBe(NOW);
  });

  it('keeps data exactly: numbers, lists and text', async () => {
    const data = { invoice_number: 2026001, total: 12.5, client: 'Ünïcödé "quoted" \\ back', items: [{ description: 'Design', amount: '1,200.00' }] };
    const { batch } = await storeBatch({ template: 'invoice', rows: [data] });
    const row = await first<{ data: string; certificate_id: string | null }>(env.DB, 'SELECT data, certificate_id FROM batch_rows WHERE batch_id = ?1', batch.id);
    expect(JSON.parse(row!.data)).toEqual(data);
    expect(row!.certificate_id).toBeNull();
    expect(await first(env.DB, 'SELECT id FROM certificates WHERE batch_id = ?1', batch.id)).toBeNull();
  });

  it('stores thousands of large rows in several statements', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ recipient_name: `Person ${i}`, note: `${i}`.padEnd(1500, 'x') }));
    const { batch } = await storeBatch({ template: 'certificate', rows }, { plan: 'pro' });
    expect((await batchCounts(env.DB, batch.id)).queued).toBe(2000);
    expect(await certificateCount(batch.id)).toBe(0);
    const last = await first<{ data: string }>(env.DB, 'SELECT data FROM batch_rows WHERE batch_id = ?1 AND idx = 1999', batch.id);
    expect(JSON.parse(last!.data)).toEqual(rows[1999]);
  });

  it('refuses a batch over the active-batch cap as a whole: no rows, no certificates', async () => {
    const user = await createUser('pro');
    const first1 = await storeBatch({ template: 'invoice', rows: [{}] }, { user, maxActive: 2 });
    await storeBatch({ template: 'invoice', rows: [{}] }, { user, maxActive: 2 });
    const before = await all(env.DB, 'SELECT id FROM certificates WHERE user_id = ?1', user.id);

    const refused = await storeBatch({ template: 'certificate', rows: certificateRows(5) }, { user, maxActive: 2 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('conflict');
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).details).toEqual({ max_active_batches: 2 });
    expect((await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id))!.n).toBe(2);
    expect(await all(env.DB, 'SELECT id FROM certificates WHERE user_id = ?1', user.id)).toEqual(before);
    expect((await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM batch_rows r JOIN batches b ON b.id = r.batch_id WHERE b.user_id = ?1', user.id))!.n).toBe(2);

    // Another account is not affected, and a cancelled batch frees a place.
    await expect(storeBatch({ template: 'invoice', rows: [{}] }, { maxActive: 2 })).resolves.toBeDefined();
    await cancelBatch(env.DB, user.id, first1.batch.id, Date.now());
    await expect(storeBatch({ template: 'invoice', rows: [{}] }, { user, maxActive: 2 })).resolves.toBeDefined();
  });

  it('holds the cap under concurrent creates', async () => {
    const user = await createUser('pro');
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => storeBatch({ template: 'invoice', rows: [{}, {}] }, { user, maxActive: 2 })));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(2);
    expect((await first<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM batches WHERE user_id = ?1', user.id))!.n).toBe(2);
  });
});

describe('queueing the rows', () => {
  it('sends one message per BatchQueueSettings.rowsPerMessage rows, in chunks of sendBatchChunk', async () => {
    expect(batchMessages('bat_x', [0, 1, 2, 3, 4], 2)).toEqual([
      { batchId: 'bat_x', rows: [0, 1], attempt: 1 },
      { batchId: 'bat_x', rows: [2, 3], attempt: 1 },
      { batchId: 'bat_x', rows: [4], attempt: 1 },
    ]);
    expect(() => batchMessages('bat_x', [0], 0)).toThrow(RangeError);

    const { batch, request } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 250 }, () => ({})) });
    const queue = recordingQueue<BatchQueueMessage>();
    const sent = await enqueueBatchRows(env.DB, queue, batch.id, request.rows.map((row) => row.index), { rowsPerMessage: 1, sendBatchChunk: 100 }, NOW);
    expect(sent).toEqual({ queued: 250, failed: 0 });
    expect(queue.calls).toBe(3);
    expect(queue.sent.map((message) => message.body.rows[0])).toEqual(request.rows.map((row) => row.index));
    expect((await batchCounts(env.DB, batch.id)).queued).toBe(250);
  });

  it('fails the rows it could not send, uncharged, and finalizes the batch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { batch } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 5 }, () => ({})) });
    const queue = recordingQueue<BatchQueueMessage>({ failOnCall: 2 });
    const sent = await enqueueBatchRows(env.DB, queue, batch.id, [0, 1, 2, 3, 4], { rowsPerMessage: 1, sendBatchChunk: 2 }, NOW);
    expect(sent).toEqual({ queued: 2, failed: 3 });
    const rows = await listBatchRows(env.DB, batch.id, { limit: 10 });
    expect(rows.map((row) => row.status)).toEqual(['queued', 'queued', 'failed', 'failed', 'failed']);
    expect(rows[4]!.error).toEqual(ENQUEUE_FAILED_ERROR);
    expect((await statusOf(batch.id)).finished_at).toBeNull();

    // Nothing sent at all: every row fails and the batch is failed at once.
    const none = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    expect(await enqueueBatchRows(env.DB, recordingQueue<BatchQueueMessage>({ failOnCall: 1 }), none.batch.id, [0, 1], { rowsPerMessage: 1, sendBatchChunk: 100 }, NOW)).toEqual({
      queued: 0,
      failed: 2,
    });
    expect(await statusOf(none.batch.id)).toEqual({ status: 'failed', finished_at: NOW });
    vi.restoreAllMocks();
  });
});

describe('claims', () => {
  it('take a queued row once; the batch starts running', async () => {
    const { batch } = await storeBatch({ template: 'certificate', rows: certificateRows(2) }, { now: NOW });
    const claim = await claimRow(env.DB, batch.id, 1, NOW + 5, LEASE);
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;
    expect(claim.row).toMatchObject({ index: 1, status: 'running', attempts: 1, claimedAt: NOW + 5, filename: 'certificate-2.pdf' });
    expect(claim.row.data.recipient_name).toBe('Recipient 2');
    expect(claim.row.certificateId).toMatch(/^crt_/);
    expect(claim.batch).toMatchObject({ id: batch.id, status: 'running', startedAt: NOW + 5 });

    // Held while the claim is fresh; taken over once it is older than the claim timeout.
    expect(await claimRow(env.DB, batch.id, 1, NOW + LEASE - 1, LEASE)).toEqual({ kind: 'held', claimedAt: NOW + 5 });
    const takeover = await claimRow(env.DB, batch.id, 1, NOW + 5 + LEASE, LEASE);
    expect(takeover.kind === 'claimed' && takeover.row.attempts).toBe(2);
    // The batch's start time stays the first claim's.
    expect((await getBatch(env.DB, (await first<{ user_id: string }>(env.DB, 'SELECT user_id FROM batches WHERE id = ?1', batch.id))!.user_id, batch.id))?.startedAt).toBe(NOW + 5);

    // The dead claim can no longer finish the row; the live one can.
    expect(await completeRow(env.DB, { batchId: batch.id, index: 1, attempt: 1 }, result(1, NOW), NOW)).toBe(false);
    expect(await failRow(env.DB, { batchId: batch.id, index: 1, attempt: 1 }, { code: 'render_failed', message: 'x' }, NOW)).toBe(false);
    expect(await releaseRow(env.DB, { batchId: batch.id, index: 1, attempt: 1 }, { code: 'render_failed', message: 'x' })).toBe(false);
    expect(await completeRow(env.DB, { batchId: batch.id, index: 1, attempt: 2 }, result(1, NOW), NOW)).toBe(true);
    expect(await claimRow(env.DB, batch.id, 1, NOW + 10 * LEASE, LEASE)).toEqual({ kind: 'finished', status: 'done' });
  });

  it('report a row or batch that does not exist', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    expect(await claimRow(env.DB, batch.id, 5, NOW, LEASE)).toEqual({ kind: 'missing' });
    expect(await claimRow(env.DB, 'bat_doesnotexist0000', 0, NOW, LEASE)).toEqual({ kind: 'missing' });
  });

  it('cannot be taken twice by concurrent consumers', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimRow(env.DB, batch.id, 0, NOW, LEASE)));
    expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'held')).toHaveLength(4);
  });
});

describe('finishing rows and the batch status', () => {
  it('done rows keep their PDF and the batch is listed until its newest PDF expires', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] }, { now: NOW });
    await completeRow(env.DB, await claimed(batch.id, 0), result(0, NOW, { expiresAt: NOW + 30 * DAY, pages: 3, creditsUsed: 2 }), NOW + 1);
    expect(await statusOf(batch.id)).toEqual({ status: 'running', finished_at: null });
    await completeRow(env.DB, await claimed(batch.id, 1), result(1, NOW, { expiresAt: NOW + 31 * DAY, pages: 12, creditsUsed: 3 }), NOW + 2);
    expect(await statusOf(batch.id)).toEqual({ status: 'done', finished_at: NOW + 2 });
    expect((await getBatch(env.DB, user.id, batch.id))!.expiresAt).toBe(NOW + 31 * DAY);

    const [row0] = await listBatchRows(env.DB, batch.id, { limit: 1 });
    expect(row0).toMatchObject({ status: 'done', cacheKey: result(0, NOW).cacheKey, pages: 3, creditsUsed: 2, bytes: 1000, pdfExpiresAt: NOW + 30 * DAY, error: null, finishedAt: NOW + 1, claimedAt: null });
    expect(await batchCounts(env.DB, batch.id)).toEqual({ queued: 0, running: 0, done: 2, failed: 0, cancelled: 0, pages: 15, creditsUsed: 5 });
  });

  it('partial when some rows failed, failed when none was done', async () => {
    const mixed = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    await completeRow(env.DB, await claimed(mixed.batch.id, 0), result(0, NOW), NOW);
    await failRow(env.DB, await claimed(mixed.batch.id, 1), { code: 'template_error', message: 'broken' }, NOW);
    expect((await statusOf(mixed.batch.id)).status).toBe('partial');
    expect((await listBatchRows(env.DB, mixed.batch.id, { after: 0, limit: 5 }))[0]!.error).toEqual({ code: 'template_error', message: 'broken' });

    const none = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    await failRow(env.DB, await claimed(none.batch.id, 0), { code: 'template_error', message: 'broken' }, NOW);
    expect((await statusOf(none.batch.id)).status).toBe('running');
    await failRow(env.DB, await claimed(none.batch.id, 1), { code: 'render_timeout', message: 'slow' }, NOW);
    expect((await statusOf(none.batch.id)).status).toBe('failed');
  });

  it('a released row is queued again with its last error, and can be claimed again', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    const first1 = await claimed(batch.id, 0);
    expect(await releaseRow(env.DB, first1, { code: 'rate_limited', message: 'busy' })).toBe(true);
    const [row] = await listBatchRows(env.DB, batch.id, { limit: 1 });
    expect(row).toMatchObject({ status: 'queued', attempts: 1, claimedAt: null, error: { code: 'rate_limited', message: 'busy' } });
    const second = await claimed(batch.id, 0, NOW + 1);
    expect(second.attempt).toBe(2);
    await completeRow(env.DB, second, result(0, NOW), NOW + 2);
    expect((await listBatchRows(env.DB, batch.id, { limit: 1 }))[0]!.error).toBeNull();
  });

  it('failQueuedRows fails every queued row, or only the listed ones, never a running one', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 5 }, () => ({})) });
    const running = await claimed(batch.id, 0);
    expect(await failQueuedRows(env.DB, batch.id, { code: 'not_configured', message: 'off' }, NOW, [1, 2])).toBe(2);
    expect(await failQueuedRows(env.DB, batch.id, { code: 'quota_exceeded', message: 'gone' }, NOW)).toBe(2);
    const rows = await listBatchRows(env.DB, batch.id, { limit: 10 });
    expect(rows.map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['running', null],
      ['failed', 'not_configured'],
      ['failed', 'not_configured'],
      ['failed', 'quota_exceeded'],
      ['failed', 'quota_exceeded'],
    ]);
    expect((await statusOf(batch.id)).finished_at).toBeNull();
    await completeRow(env.DB, running, result(0, NOW), NOW + 3);
    expect(await statusOf(batch.id)).toEqual({ status: 'partial', finished_at: NOW + 3 });
  });
});

describe('cancelling', () => {
  it('cancels the batch and its queued rows; a row being rendered still finishes and counts', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}, {}] });
    await completeRow(env.DB, await claimed(batch.id, 0), result(0, NOW), NOW);
    const running = await claimed(batch.id, 1);

    const cancelled = await cancelBatch(env.DB, user.id, batch.id, NOW + 10);
    expect(cancelled?.changed).toBe(true);
    expect(cancelled?.batch).toMatchObject({ status: 'cancelled', cancelledAt: NOW + 10, finishedAt: null });
    expect((await listBatchRows(env.DB, batch.id, { limit: 5 })).map((row) => row.status)).toEqual(['done', 'running', 'cancelled']);

    await completeRow(env.DB, running, result(1, NOW), NOW + 20);
    expect(await statusOf(batch.id)).toEqual({ status: 'cancelled', finished_at: NOW + 20 });
    expect(await batchCounts(env.DB, batch.id)).toMatchObject({ done: 2, cancelled: 1 });

    // Again: no change. Another account's batch is "not found".
    expect((await cancelBatch(env.DB, user.id, batch.id, NOW + 30))?.changed).toBe(false);
    const other = await createUser('pro');
    expect(await cancelBatch(env.DB, other.id, batch.id, NOW)).toBeNull();
    expect(await getBatch(env.DB, other.id, batch.id)).toBeNull();
  });

  it('finishes at once when nothing is running, and leaves a finished batch alone', async () => {
    const queued = await storeBatch({ template: 'invoice', rows: [{}, {}] });
    expect((await cancelBatch(env.DB, queued.user.id, queued.batch.id, NOW))?.batch).toMatchObject({ status: 'cancelled', finishedAt: NOW });

    const done = await storeBatch({ template: 'invoice', rows: [{}] });
    await completeRow(env.DB, await claimed(done.batch.id, 0), result(0, NOW), NOW);
    const answer = await cancelBatch(env.DB, done.user.id, done.batch.id, NOW + 1);
    expect(answer).toMatchObject({ changed: false, batch: { status: 'done', cancelledAt: null } });
  });

  it('a row claimed after the cancel (a stale claim taken over) is cancelled, not rendered', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}] });
    await claimed(batch.id, 0, NOW);
    await cancelBatch(env.DB, user.id, batch.id, NOW + 1);
    const takeover = await claimRow(env.DB, batch.id, 0, NOW + LEASE, LEASE);
    expect(takeover.kind === 'claimed' && takeover.batch.status).toBe('cancelled');
    if (takeover.kind !== 'claimed') return;
    await cancelClaimedRow(env.DB, { batchId: batch.id, index: 0, attempt: takeover.row.attempts }, NOW + LEASE);
    expect(await statusOf(batch.id)).toEqual({ status: 'cancelled', finished_at: NOW + LEASE });
  });
});

describe('listings', () => {
  it('rows page in row order; done rows are the ZIP entries', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 7 }, () => ({})) });
    await completeRow(env.DB, await claimed(batch.id, 5), result(5, NOW), NOW);
    await completeRow(env.DB, await claimed(batch.id, 2), result(2, NOW), NOW);
    expect((await listBatchRows(env.DB, batch.id, { limit: 3 })).map((row) => row.index)).toEqual([0, 1, 2]);
    expect((await listBatchRows(env.DB, batch.id, { after: 2, limit: 3 })).map((row) => row.index)).toEqual([3, 4, 5]);
    expect((await listBatchRows(env.DB, batch.id, { after: 5, limit: 3 })).map((row) => row.index)).toEqual([6]);
    expect((await doneRows(env.DB, batch.id)).map((row) => row.index)).toEqual([2, 5]);
  });

  it("an account's batches, newest first, with counts, page by page", async () => {
    const user = await createUser('pro');
    const made: BatchRecord[] = [];
    for (let i = 0; i < 5; i++) made.push((await storeBatch({ template: 'invoice', rows: Array.from({ length: i + 1 }, () => ({})) }, { user, now: NOW + (i < 4 ? i : 3) })).batch);
    await completeRow(env.DB, await claimed(made[0]!.id, 0), result(0, NOW, { pages: 4, creditsUsed: 2 }), NOW);
    await storeBatch({ template: 'invoice', rows: [{}] }); // another account's

    const firstPage = await listBatches(env.DB, user.id, { limit: 3 });
    expect(firstPage).toHaveLength(3);
    const last = firstPage[2]!.batch;
    const secondPage = await listBatches(env.DB, user.id, { limit: 3, before: { createdAt: last.createdAt, id: last.id } });
    const listed = [...firstPage, ...secondPage];
    expect(listed.map((item) => item.batch.id).sort()).toEqual(made.map((batch) => batch.id).sort());
    expect(listed.map((item) => item.batch.createdAt)).toEqual([...listed.map((item) => item.batch.createdAt)].sort((a, b) => b - a));
    const oldest = listed.find((item) => item.batch.id === made[0]!.id)!;
    expect(oldest.counts).toEqual({ queued: 0, running: 0, done: 1, failed: 0, cancelled: 0, pages: 4, creditsUsed: 2 });
    expect(listed.find((item) => item.batch.id === made[4]!.id)!.counts.queued).toBe(5);
  });

  it('the JSON shows URLs only for live PDFs and a verify URL per certificate', async () => {
    const { user, batch } = await storeBatch({ template: 'certificate', rows: certificateRows(3) }, { now: NOW });
    await completeVerified(user, batch.id, 0, NOW, NOW + DAY);
    await completeVerified(user, batch.id, 1, NOW, NOW + 2 * DAY);
    await failRow(env.DB, await claimed(batch.id, 2), { code: 'template_error', message: 'broken' }, NOW);
    const rows = await listBatchRows(env.DB, batch.id, { limit: 5 });
    const json = batchJson(env, (await getBatch(env.DB, user.id, batch.id))!, await batchCounts(env.DB, batch.id), NOW + 1.5 * DAY, rows);
    expect(json).toMatchObject({ id: batch.id, status: 'partial', total: 3, verify: true, counts: { done: 2, failed: 1 }, credits_used: 4, pages: 2 });
    expect(json.zip_url).toBe(`${env.APP_URL}/v1/batches/${batch.id}/zip`);
    expect(json.rows![0]!.url).toBeNull(); // expired
    expect(json.rows![1]!.url).toBe(`${env.APP_URL}/i/${user.id}/${result(1, NOW).cacheKey}.pdf`);
    // A failed row has no certificate record, so no id or link is shown for it.
    expect(json.rows![2]).toMatchObject({ status: 'failed', url: null, error: { code: 'template_error', message: 'broken' }, certificate_id: null, verify_url: null });
    for (const row of json.rows!.slice(0, 2)) expect(row.verify_url).toBe(`${env.APP_URL}/v/${row.certificate_id}`);
    expect(json.rows![0]!.certificate_id).toBe(rows[0]!.certificateId);
    expect(json.finished_at).toBe(new Date(NOW).toISOString());
  });
});

describe('daily cleanup', () => {
  it('fails rows of old unfinished batches whose messages cannot arrive any more', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const old = await storeBatch({ template: 'invoice', rows: [{}, {}, {}] }, { now: NOW - 10 * DAY });
    await completeRow(env.DB, await claimed(old.batch.id, 0, NOW - 10 * DAY), result(0, NOW - 10 * DAY), NOW - 10 * DAY);
    await claimed(old.batch.id, 1, NOW - 10 * DAY);
    const recent = await storeBatch({ template: 'invoice', rows: [{}] }, { now: NOW - DAY });

    expect(await failStaleRows(env.DB, NOW - 5 * DAY, NOW, 50)).toBeGreaterThanOrEqual(2);
    expect((await listBatchRows(env.DB, old.batch.id, { limit: 5 })).map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['done', null],
      ['failed', STALE_ROW_ERROR.code],
      ['failed', STALE_ROW_ERROR.code],
    ]);
    expect(await statusOf(old.batch.id)).toEqual({ status: 'partial', finished_at: NOW });
    expect(await statusOf(recent.batch.id)).toEqual({ status: 'queued', finished_at: null });
    vi.restoreAllMocks();
  });

  it('deletes finished batches after their newest PDF expired; certificates stay', async () => {
    const expired = await storeBatch({ template: 'certificate', rows: certificateRows(2) }, { now: NOW - 40 * DAY });
    await completeVerified(expired.user, expired.batch.id, 0, NOW - 40 * DAY, NOW - DAY);
    await failRow(env.DB, await claimed(expired.batch.id, 1, NOW - 40 * DAY), { code: 'template_error', message: 'x' }, NOW - 40 * DAY);
    const live = await storeBatch({ template: 'invoice', rows: [{}] }, { now: NOW - 40 * DAY });
    await completeRow(env.DB, await claimed(live.batch.id, 0, NOW - 40 * DAY), result(0, NOW - 40 * DAY, { expiresAt: NOW + DAY }), NOW - 40 * DAY);
    // Unfinished batches are never purged, whatever their expiry says.
    const running = await storeBatch({ template: 'invoice', rows: [{}] }, { now: NOW - 40 * DAY });

    expect(await purgeExpiredBatches(env.DB, NOW, 500, 1000)).toBeGreaterThanOrEqual(1);
    expect(await getBatch(env.DB, expired.user.id, expired.batch.id)).toBeNull();
    expect(await first(env.DB, 'SELECT idx FROM batch_rows WHERE batch_id = ?1', expired.batch.id)).toBeNull();
    expect(await certificateCount(expired.batch.id)).toBe(1);
    expect(await getBatch(env.DB, live.user.id, live.batch.id)).not.toBeNull();
    expect(await getBatch(env.DB, running.user.id, running.batch.id)).not.toBeNull();
  });

  it('deleting an account removes its batches, rows and certificates', async () => {
    const { user, batch } = await storeBatch({ template: 'certificate', rows: certificateRows(3) });
    await completeVerified(user, batch.id, 0);
    expect(await certificateCount(batch.id)).toBe(1);
    await run(env.DB, 'DELETE FROM users WHERE id = ?1', user.id);
    expect(await first(env.DB, 'SELECT id FROM batches WHERE id = ?1', batch.id)).toBeNull();
    expect(await first(env.DB, 'SELECT idx FROM batch_rows WHERE batch_id = ?1', batch.id)).toBeNull();
    expect(await first(env.DB, 'SELECT id FROM certificates WHERE user_id = ?1', user.id)).toBeNull();
  });
});
