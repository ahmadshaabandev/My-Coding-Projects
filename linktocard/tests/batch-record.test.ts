// A D1 failure while a rendered row is marked done (review BQ-2). The PDF exists and was
// charged by then, so the row must neither say "Nothing was charged" nor lose its charge when a
// later delivery finds the PDF stored (and is charged 0).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { RECORD_FAILED_ERROR, RECORD_RETRY_ERROR } from '../src/batch/consumer';
import { batchCounts, listBatchRows } from '../src/batch/store';
import { run } from '../src/db/client';
import { batchEnv, deliver, fakeRender, messageFor, renderResult, SETTINGS, storeBatch } from './batch-helpers';

/** env.DB, except that the batch of statements marking a row done throws its first `failures` times. */
function flakyDoneDb(failures: number): D1Database & { failed: () => number } {
  let failed = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const text = statements.map((statement) => (statement as unknown as { statement?: string }).statement ?? '').join('\n');
          if (failed < failures && /status = 'done'/.test(text)) {
            failed++;
            throw new Error('D1_ERROR: simulated network blip');
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.assign(db, { failed: () => failed });
}

/** Charged 2 images the first time; found stored (charged 0) after that, as getPdf answers. */
const chargedOnce = () => fakeRender((request, call) => renderResult(request, call === 1 ? {} : { creditsUsed: 0, cached: true }));

async function onlyRow(batchId: string) {
  const [row] = await listBatchRows(env.DB, batchId, { limit: 1 });
  return row!;
}

describe('marking a rendered row done fails (BQ-2)', () => {
  it('one failure: completeRow is tried again at once and the row is done with its charge', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'A-1' }] });
    const db = flakyDoneDb(1);
    const render = chargedOnce();
    await deliver([{ body: messageFor(batch.id, [0]) }], { render }, { ...batchEnv(), DB: db });
    expect(db.failed()).toBe(1);
    expect(render.calls).toHaveLength(1);
    const row = await onlyRow(batch.id);
    expect(row.status).toBe('done');
    expect(row.creditsUsed).toBe(2);
  });

  it('two failures: the row goes back to the queue with its charge, and the delivery that finds the PDF stored reports it', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'B-1' }] });
    const db = flakyDoneDb(2);
    const render = chargedOnce();
    const first = await deliver([{ body: messageFor(batch.id, [0]) }], { render }, { ...batchEnv(), DB: db });
    expect(first.result.explicitAcks).toEqual([]);
    const waiting = await onlyRow(batch.id);
    expect(waiting.status).toBe('queued');
    expect(waiting.creditsUsed).toBe(2);
    expect(waiting.error).toEqual(RECORD_RETRY_ERROR);
    expect(waiting.error!.message).not.toMatch(/Nothing was charged/);

    await deliver([{ body: messageFor(batch.id, [0]), attempts: 2 }], { render }, { ...batchEnv(), DB: db });
    expect(render.calls).toHaveLength(2);
    const done = await onlyRow(batch.id);
    expect(done.status).toBe('done');
    expect(done.creditsUsed).toBe(2);
    expect((await batchCounts(env.DB, batch.id)).creditsUsed).toBe(2);
  });

  it('with no tries left the row fails saying it was counted, and keeps its charge', async () => {
    const { batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'C-1' }] });
    await run(env.DB, 'UPDATE batch_rows SET attempts = ?2 WHERE batch_id = ?1', batch.id, SETTINGS.maxRowAttempts - 1);
    const db = flakyDoneDb(2);
    await deliver([{ body: messageFor(batch.id, [0]) }], { render: chargedOnce() }, { ...batchEnv(), DB: db });
    const row = await onlyRow(batch.id);
    expect(row.status).toBe('failed');
    expect(row.error).toEqual(RECORD_FAILED_ERROR);
    expect(row.error!.message).not.toMatch(/Nothing was charged/);
    expect(row.creditsUsed).toBe(2);
    expect((await batchCounts(env.DB, batch.id)).creditsUsed).toBe(2);
  });
});
