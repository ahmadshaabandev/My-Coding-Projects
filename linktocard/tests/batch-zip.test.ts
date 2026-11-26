// The ZIP of a batch (src/batch/zip.ts over src/lib/zip.ts): every finished row's stored PDF, in
// row order, read from R2 one at a time; expired or missing PDFs are left out. The archive is read
// back with a small central-directory reader (the writer's own tests check it with real unzip tools).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { claimRow, completeRow, doneRows, failRow } from '../src/batch/store';
import { batchZipEntries, batchZipFilename, batchZipResponse, batchZipStream } from '../src/batch/zip';
import { pdfR2Key } from '../src/pdf/service';
import { DAY, SETTINGS, storeBatch } from './batch-helpers';
import { FIXTURES } from './pdf-helpers';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const LEASE = SETTINGS.claimTimeoutMinutes * 60_000;

/** Stores a PDF the way src/pdf/service.ts does (metadata included) and returns its cache key. */
async function putPdf(userId: string, index: number, bytes: Uint8Array, expiresAt: number): Promise<string> {
  const cacheKey = (0xabc000 + index).toString(16).padStart(64, '0');
  await env.BUCKET.put(pdfR2Key(userId, cacheKey), bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { expiresAt: String(expiresAt), createdAt: String(NOW), pages: '1', units: '2', filename: `row-${index}.pdf`, template: 'invoice' },
  });
  return cacheKey;
}

async function finish(batchId: string, index: number, cacheKey: string, bytes: number, expiresAt: number): Promise<void> {
  const claim = await claimRow(env.DB, batchId, index, NOW, LEASE);
  if (claim.kind !== 'claimed') throw new Error('not claimed');
  await completeRow(env.DB, { batchId, index, attempt: claim.row.attempts }, { cacheKey, pages: 1, creditsUsed: 2, bytes, expiresAt, cached: false }, NOW);
}

/** name -> bytes of every entry, from the central directory (stored entries only). */
function readZip(zip: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    expect(view.getUint16(offset + 10, true)).toBe(0); // stored
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, data: zip.subarray(dataStart, dataStart + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('the ZIP of a batch', () => {
  it("holds every finished row's PDF in row order, without expired or missing ones", async () => {
    const { user, batch } = await storeBatch(
      { template: 'invoice', filename: '{{client}}.pdf', rows: [{ client: 'Acme' }, { client: 'Beta' }, { client: 'Gamma' }, { client: 'Delta' }, { client: 'Eta' }] },
      { now: NOW },
    );
    const one = FIXTURES['1-page'].bytes;
    const three = FIXTURES['3-pages'].bytes;
    // Finished out of order on purpose: the archive follows the rows, not the queue.
    await finish(batch.id, 3, await putPdf(user.id, 3, one, NOW + DAY), one.byteLength, NOW + DAY);
    await finish(batch.id, 0, await putPdf(user.id, 0, three, NOW + DAY), three.byteLength, NOW + DAY);
    await finish(batch.id, 1, await putPdf(user.id, 1, one, NOW - 1), one.byteLength, NOW - 1); // expired
    await finish(batch.id, 4, (0xdead).toString(16).padStart(64, '0'), 10, NOW + DAY); // missing from R2
    const failed = await claimRow(env.DB, batch.id, 2, NOW, LEASE);
    if (failed.kind === 'claimed') await failRow(env.DB, { batchId: batch.id, index: 2, attempt: failed.row.attempts }, { code: 'template_error', message: 'x' }, NOW);

    const rows = await doneRows(env.DB, batch.id);
    const zip = new Uint8Array(await new Response(batchZipStream(env.BUCKET, user.id, rows, NOW)).arrayBuffer());
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['Acme.pdf', 'Delta.pdf']);
    expect(entries[0]!.data).toEqual(three);
    expect(entries[1]!.data).toEqual(one);
  });

  it('is empty (but valid) before any row is done, and pulls one PDF at a time', async () => {
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{}, {}] }, { now: NOW });
    const empty = new Uint8Array(await new Response(batchZipStream(env.BUCKET, user.id, await doneRows(env.DB, batch.id), NOW)).arrayBuffer());
    expect(readZip(empty)).toEqual([]);

    for (const index of [0, 1]) await finish(batch.id, index, await putPdf(user.id, 10 + index, FIXTURES['1-page'].bytes, NOW + DAY), FIXTURES['1-page'].bytes.byteLength, NOW + DAY);
    const reads: string[] = [];
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === 'get') return (key: string, ...rest: unknown[]) => (reads.push(key), (target.get as (...args: unknown[]) => unknown)(key, ...rest));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const iterator = batchZipEntries(bucket, user.id, await doneRows(env.DB, batch.id), NOW)[Symbol.asyncIterator]();
    const firstEntry = await iterator.next();
    expect(reads).toHaveLength(1);
    expect(firstEntry.value).toMatchObject({ name: 'invoice-1.pdf', size: FIXTURES['1-page'].bytes.byteLength });
    await new Response((firstEntry.value as { data: ReadableStream }).data).arrayBuffer();
    await iterator.next();
    expect(reads).toHaveLength(2);
    expect((await iterator.next()).done).toBe(true);
  });

  it('is downloaded as an attachment named after the batch, never cached', async () => {
    const response = batchZipResponse('bat_abc', new ReadableStream({ start: (controller) => controller.close() }));
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="bat_abc.zip"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(batchZipFilename('bat_abc')).toBe('bat_abc.zip');
    await response.body?.cancel();
  });
});
