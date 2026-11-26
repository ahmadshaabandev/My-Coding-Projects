/**
 * The producer side of the bulk-documents queue: after createBatch() has stored a batch, its
 * rows go to BATCH_QUEUE as messages of BatchQueueSettings.rowsPerMessage rows each, sent with
 * sendBatch in chunks of sendBatchChunk messages (Queues takes at most 100 messages and 256 KB
 * per call; these messages are a few dozen bytes), one chunk after another, because every send
 * counts toward the six connections an invocation may have waiting. (Limits from
 * https://developers.cloudflare.com/queues/platform/limits/ and
 * https://developers.cloudflare.com/workers/platform/limits/, read from the cloudflare-docs
 * source on GitHub on 2026-11-26 for the research notes; the rendered pages were not reachable.)
 *
 * A send that fails stops the loop: the rows of that chunk and every later one fail at once with
 * an error saying nothing was charged, and the batch is finalized (partial, or failed when no row
 * was queued). Queues reports every refusal as an opaque internal error (the research notes saw
 * "Unknown Internal Error (15000)" for each limit locally), so the error text is logged, never
 * parsed or shown.
 */
import type { BatchQueueMessage } from '../types';
import { failQueuedRows } from './store';
import type { BatchQueueSettings, RowError } from './types';

export const ENQUEUE_FAILED_ERROR: RowError = {
  code: 'internal_error',
  message: 'This row could not be queued for rendering. Nothing was charged for it; send it again in a new batch.',
};

/**
 * The messages for these rows, `rowsPerMessage` rows each, in row order. `attempt` is always 1:
 * a message body never changes on redelivery; the platform's Message.attempts counts deliveries
 * and batch_rows.attempts counts renders (src/batch/consumer.ts).
 */
export function batchMessages(batchId: string, indexes: readonly number[], rowsPerMessage: number): BatchQueueMessage[] {
  if (!Number.isInteger(rowsPerMessage) || rowsPerMessage < 1) throw new RangeError(`batchMessages: rowsPerMessage must be a positive integer, got ${rowsPerMessage}`);
  const messages: BatchQueueMessage[] = [];
  for (let start = 0; start < indexes.length; start += rowsPerMessage) {
    messages.push({ batchId, rows: indexes.slice(start, start + rowsPerMessage), attempt: 1 });
  }
  return messages;
}

export interface EnqueueResult {
  /** Rows whose message was accepted by the queue. */
  queued: number;
  /** Rows failed because their message could not be sent. */
  failed: number;
}

/** Sends every row of a stored batch to the queue; see the module comment for failures. */
export async function enqueueBatchRows(
  db: D1Database,
  queue: Queue<BatchQueueMessage>,
  batchId: string,
  indexes: readonly number[],
  settings: Pick<BatchQueueSettings, 'rowsPerMessage' | 'sendBatchChunk'>,
  now: number,
): Promise<EnqueueResult> {
  const messages = batchMessages(batchId, indexes, settings.rowsPerMessage);
  let queued = 0;
  for (let start = 0; start < messages.length; start += settings.sendBatchChunk) {
    const chunk = messages.slice(start, start + settings.sendBatchChunk);
    try {
      await queue.sendBatch(chunk.map((body) => ({ body })));
    } catch (error) {
      console.error(`queueing batch ${batchId} failed after ${queued} of ${indexes.length} rows:`, error);
      const unsent = messages.slice(start).flatMap((message) => message.rows);
      const failed = await failQueuedRows(db, batchId, ENQUEUE_FAILED_ERROR, now, unsent);
      return { queued, failed };
    }
    queued += chunk.reduce((sum, message) => sum + message.rows.length, 0);
  }
  return { queued, failed: 0 };
}
