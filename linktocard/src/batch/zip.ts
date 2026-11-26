/**
 * GET /v1/batches/{id}/zip: every finished row's PDF in one ZIP, in row order, streamed by the
 * in-house writer (src/lib/zip.ts: stored entries, CRC-32 in data descriptors, no dependency).
 *
 * The PDFs are read from R2 one at a time, only when the archive's reader asks for the next
 * entry, so a batch of thousands of PDFs never sits in memory. A PDF that has expired since (the
 * plan's cache days) or is missing from R2 is left out rather than failing the download: the
 * rest are still the customer's paid documents. Entry names are the rows' own file names, which
 * are unique ignoring case already (src/batch/rows.ts); they are deduplicated again here only so
 * that a bug elsewhere cannot make the writer refuse the archive half-way.
 */
import { zipStream } from '../lib/zip';
import { readStoredPdf } from '../pdf/service';
import { dedupeFilenames } from './rows';
import type { BatchRowRecord } from './types';

export interface BatchZipEntry {
  name: string;
  size: number;
  data: ReadableStream<Uint8Array> | Uint8Array;
}

/** The download name: the batch id, which is what the API and dashboard show. */
export function batchZipFilename(batchId: string): string {
  return `${batchId}.zip`;
}

/**
 * The archive's entries for these rows (doneRows() of src/batch/store.ts), each PDF fetched from
 * R2 only when the previous one has been written.
 */
export async function* batchZipEntries(bucket: R2Bucket, userId: string, rows: readonly BatchRowRecord[], now: number): AsyncGenerator<BatchZipEntry> {
  const withPdf = rows.filter((row): row is BatchRowRecord & { cacheKey: string } => row.status === 'done' && row.cacheKey !== null);
  const names = dedupeFilenames(withPdf.map((row) => row.filename));
  for (const [position, row] of withPdf.entries()) {
    const stored = await readStoredPdf(bucket, userId, row.cacheKey, now, true);
    if (!stored?.body) continue;
    yield { name: names[position]!, size: stored.pdf.bytes, data: stored.body as ReadableStream<Uint8Array> };
  }
}

/** The ZIP of a batch's finished rows as a stream (application/zip). */
export function batchZipStream(bucket: R2Bucket, userId: string, rows: readonly BatchRowRecord[], now: number): ReadableStream<Uint8Array> {
  return zipStream(batchZipEntries(bucket, userId, rows, now));
}

/** The download response: never cached (the archive grows while the batch runs). */
export function batchZipResponse(batchId: string, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${batchZipFilename(batchId)}"`,
      'cache-control': 'private, no-store',
    },
  });
}
