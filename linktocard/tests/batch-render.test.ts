// Bulk documents through the REAL PDF service (src/pdf/service.ts getPdf) with a mock Browser Run
// binding: each row is rendered, charged and stored exactly like POST /v1/pdf, the consumer's
// retry rules match the errors getPdf really throws, and the row's PdfJob (src/batch/render.ts)
// follows the account's plan and the batch's pinned template.
//
// The wrapper below is the one src/index.ts wires into queue() (source 'batch').
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchPdfJob, batchRenderResult, customTemplateIdentity, pinnedTemplateVersion } from '../src/batch/render';
import { batchCounts, getBatch, listBatchRows } from '../src/batch/store';
import type { BatchRender } from '../src/batch/types';
import { PDF, pdfUnits } from '../src/config';
import { run } from '../src/db/client';
import { ApiError } from '../src/lib/errors';
import { getPdf, pdfR2Key, resolvePdfTemplate, starterPdfTemplate } from '../src/pdf/service';
import { createTemplate, createUser, renderCount, sessionCookieFor, setUsed, usageOf } from './app-helpers';
import { batchEnv, certificateRows, deliver, deliverOne, messageFor, SETTINGS, storeBatch } from './batch-helpers';
import { browserErrorResponse, mockBrowser, pdfResponse } from './pdf-helpers';

/** The production BatchRender, as the integrator wires it (source 'batch' there). */
const realRender: BatchRender = async (bindings, request) => {
  const job = await batchPdfJob(bindings.DB, request.user, request.batch, request.row, request.data, request.verification);
  const result = await getPdf(bindings, request.background, { user: request.user, job, source: 'batch', siteId: null }, { now: request.now, withBody: false });
  return batchRenderResult(result);
};

beforeEach(() => {
  // Quota warning emails go out in the background: no network in tests.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'em_test' }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rows through getPdf', () => {
  it('are rendered, charged and stored like single PDFs', async () => {
    const browser = mockBrowser(() => pdfResponse('3-pages'));
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'B-1' }, { invoice_number: 'B-2' }] }, { plan: 'starter' });
    const before = await usageOf(user.id);
    const { result } = await deliver([0, 1].map((i) => ({ id: `r${i}`, body: messageFor(batch.id, [i]) })), { render: realRender }, batchEnv({ BROWSER: browser.binding }));
    expect(result.explicitAcks.sort()).toEqual(['r0', 'r1']);
    expect(browser.quickAction).toHaveBeenCalledTimes(2);

    const rows = await listBatchRows(env.DB, batch.id, { limit: 5 });
    expect(rows.map((row) => [row.status, row.pages, row.creditsUsed])).toEqual([
      ['done', 3, pdfUnits(3)],
      ['done', 3, pdfUnits(3)],
    ]);
    expect((await usageOf(user.id)).used).toBe(before.used + 2 * pdfUnits(3));
    expect(await renderCount(user.id)).toBe(2);
    const object = await env.BUCKET.head(pdfR2Key(user.id, rows[1]!.cacheKey!));
    expect(object?.customMetadata?.filename).toBe('invoice-2.pdf');
    expect(object?.size).toBe(rows[1]!.bytes);
    expect((await getBatch(env.DB, user.id, batch.id))!.status).toBe('done');
  });

  it('a row rendered again after a lost completion is served from storage and not charged twice', async () => {
    const browser = mockBrowser();
    const { user, batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'C-1' }] }, { plan: 'starter' });
    const bindings = batchEnv({ BROWSER: browser.binding });
    const [row] = await listBatchRows(env.DB, batch.id, { limit: 1 });
    const request = {
      user,
      batch,
      row: { index: 0, filename: row!.filename, certificateId: null },
      data: { invoice_number: 'C-1' },
      verification: null,
      now: Date.now(),
      background: () => undefined,
    };
    const firstRender = await realRender(bindings, request);
    const used = (await usageOf(user.id)).used;
    const again = await realRender(bindings, { ...request, now: request.now + 1000 });
    expect(again).toMatchObject({ cacheKey: firstRender.cacheKey, cached: true, creditsUsed: 0 });
    expect((await usageOf(user.id)).used).toBe(used);
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
  });

  it('a busy Browser Run is retried, a broken document is not', async () => {
    const busyBrowser = mockBrowser(() => browserErrorResponse(429, 'Rate limit exceeded'));
    const busy = await storeBatch({ template: 'invoice', rows: [{}] }, { plan: 'starter' });
    const { retry } = await deliverOne({ id: 'busy', body: messageFor(busy.batch.id, [0]) }, { render: realRender }, batchEnv({ BROWSER: busyBrowser.binding }));
    expect(retry).toHaveBeenCalledWith({ delaySeconds: Math.max(SETTINGS.retryDelaySeconds, 10) });
    expect((await listBatchRows(env.DB, busy.batch.id, { limit: 1 }))[0]).toMatchObject({ status: 'queued', error: { code: 'rate_limited' } });

    const downBrowser = mockBrowser(() => browserErrorResponse(503, 'Service unavailable'));
    const down = await storeBatch({ template: 'invoice', rows: [{}] }, { plan: 'starter' });
    const downResult = await deliver([{ id: 'down', body: messageFor(down.batch.id, [0]) }], { render: realRender }, batchEnv({ BROWSER: downBrowser.binding }));
    expect(downResult.result.retryMessages).toEqual([{ msgId: 'down' }]);

    const brokenBrowser = mockBrowser(() => browserErrorResponse(422, 'Unable to render'));
    const broken = await storeBatch({ template: 'invoice', rows: [{}] }, { plan: 'starter' });
    const brokenResult = await deliver([{ id: 'broken', body: messageFor(broken.batch.id, [0]) }], { render: realRender }, batchEnv({ BROWSER: brokenBrowser.binding }));
    expect(brokenResult.result.explicitAcks).toEqual(['broken']);
    expect((await listBatchRows(env.DB, broken.batch.id, { limit: 1 }))[0]).toMatchObject({ status: 'failed', error: { code: 'template_error' } });
    // Nothing was charged for any of them.
    for (const { user } of [busy, down, broken]) expect(await renderCount(user.id)).toBe(0);
  });

  it('when the quota runs out mid-batch the rest fail with quota_exceeded and the batch is partial', async () => {
    const browser = mockBrowser();
    const user = await createUser('free');
    const { batch } = await storeBatch({ template: 'invoice', rows: Array.from({ length: 4 }, (_, i) => ({ invoice_number: `Q-${i}` })) }, { user });
    // Room for exactly one more PDF.
    await setUsed(user, (await usageOf(user.id)).limit - PDF.baseUnits);
    const { result } = await deliver([0, 1, 2, 3].map((i) => ({ id: `q${i}`, body: messageFor(batch.id, [i]) })), { render: realRender }, batchEnv({ BROWSER: browser.binding }));
    expect(result.retryMessages).toEqual([]);
    expect((await listBatchRows(env.DB, batch.id, { limit: 5 })).map((row) => [row.status, row.error?.code ?? null])).toEqual([
      ['done', null],
      ['failed', 'quota_exceeded'],
      ['failed', 'quota_exceeded'],
      ['failed', 'quota_exceeded'],
    ]);
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
    expect((await getBatch(env.DB, user.id, batch.id))!.status).toBe('partial');
    expect(await batchCounts(env.DB, batch.id)).toMatchObject({ done: 1, failed: 3, creditsUsed: PDF.baseUnits });
  });

  it('Free rows skip RL_PDF_FREE (decision D12), and a Free POST /v1/pdf is still limited by it', async () => {
    const browser = mockBrowser();
    const keys: string[] = [];
    const deny = { limit: ({ key }: { key: string }) => (keys.push(key), Promise.resolve({ success: false })) };
    const user = await createUser('free');
    const { batch } = await storeBatch({ template: 'invoice', rows: [{ invoice_number: 'F-1' }, { invoice_number: 'F-2' }] }, { user });
    const bindings = batchEnv({ BROWSER: browser.binding, RATE_LIMITS_DISABLED: '0', RL_PDF_FREE: deny });
    const { result } = await deliver([0, 1].map((i) => ({ id: `f${i}`, body: messageFor(batch.id, [i]) })), { render: realRender }, bindings);
    expect(result.explicitAcks.sort()).toEqual(['f0', 'f1']);
    expect((await listBatchRows(env.DB, batch.id, { limit: 5 })).map((row) => row.status)).toEqual(['done', 'done']);
    expect(browser.quickAction).toHaveBeenCalledTimes(2);
    expect(keys).toEqual([]);
    // The same limiter still stops the account's own POST /v1/pdf path (source 'api').
    const job = await batchPdfJob(env.DB, user, batch, { index: 0, filename: 'x.pdf', certificateId: null }, { invoice_number: 'F-3' });
    const refused = await getPdf(bindings, () => undefined, { user, job, source: 'api', siteId: null }, { now: Date.now(), withBody: false }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('rate_limited');
    expect(keys).toEqual([user.id]);
    expect(browser.quickAction).toHaveBeenCalledTimes(2);
  });

  it('a verified row prints its QR code even when the URI is over PDF.maxDataValueChars (decision D13)', async () => {
    const browser = mockBrowser();
    const appUrl = 'https://linktocard-staging.names-on-base.workers.dev';
    const { batch } = await storeBatch({ template: 'certificate', rows: certificateRows(1) }, { plan: 'starter' });
    await deliver([{ body: messageFor(batch.id, [0]) }], { render: realRender }, batchEnv({ BROWSER: browser.binding, APP_URL: appUrl }));
    const [row] = await listBatchRows(env.DB, batch.id, { limit: 1 });
    expect(row).toMatchObject({ status: 'done' });
    const html = (browser.calls[0]!.options as { html?: string }).html ?? '';
    const qr = /<img class="verify-qr" src="(data:image\/svg\+xml,[^"]+)"/.exec(html)?.[1] ?? '';
    expect(qr.length).toBeGreaterThan(PDF.maxDataValueChars);
    expect(html).toContain(`${appUrl}/v/${row!.certificateId}`);
  });

  it('verified rows print their certificate fields through the template', async () => {
    const browser = mockBrowser();
    const { batch } = await storeBatch({ template: 'certificate', rows: certificateRows(1) }, { plan: 'starter' });
    await deliver([{ body: messageFor(batch.id, [0]) }], { render: realRender }, batchEnv({ BROWSER: browser.binding }));
    const [row] = await listBatchRows(env.DB, batch.id, { limit: 1 });
    expect(row).toMatchObject({ status: 'done' });
    const html = (browser.calls[0]!.options as { html?: string }).html ?? '';
    expect(html).toContain('Recipient 1');
    expect(row!.certificateId).toMatch(/^crt_/);
  });
});

describe('the PdfJob of a row', () => {
  it('uses the batch page options over the starter defaults, and the free mark by the plan now', async () => {
    const free = await createUser('free');
    const pro = await createUser('pro');
    const batch = { template: 'invoice', templateVersion: null, pdf: { format: 'letter' as const, landscape: true } };
    const row = { index: 0, filename: 'invoice-1.pdf', certificateId: null };
    const freeJob = await batchPdfJob(env.DB, free, batch, row, { invoice_number: '1' });
    const proJob = await batchPdfJob(env.DB, pro, batch, row, { invoice_number: '1' });
    expect(freeJob.mark).toBe(true);
    expect(proJob.mark).toBe(false);
    expect(proJob.setup).toMatchObject({ format: 'letter', landscape: true });
    expect(freeJob.filename).toBe('invoice-1.pdf');
    expect(freeJob.header).toBeNull();
    // Without options the template's own defaults apply.
    const plain = await batchPdfJob(env.DB, pro, { ...batch, pdf: { format: null, landscape: null } }, row, {});
    expect(plain.setup).toEqual(starterPdfTemplate('invoice').defaults);
  });

  it("pins the account's own template: a later edit fails the row with conflict, a deletion with not_found", async () => {
    const user = await createUser('pro');
    const id = await createTemplate(await sessionCookieFor(user.id), '<main>{{name}}</main>', 'main { color: #000; }');
    const source = await resolvePdfTemplate(env.DB, user.id, id);
    expect(pinnedTemplateVersion(source!)).toBe(1);
    expect(pinnedTemplateVersion(starterPdfTemplate('invoice'))).toBeNull();
    expect(source!.identity).toBe(customTemplateIdentity(id, 1));

    const batch = { template: id, templateVersion: 1, pdf: { format: null, landscape: null } };
    const row = { index: 0, filename: 'document-1.pdf', certificateId: null };
    await expect(batchPdfJob(env.DB, user, batch, row, { name: 'x' })).resolves.toMatchObject({ template: { identity: customTemplateIdentity(id, 1) } });

    await run(env.DB, 'UPDATE templates SET version = version + 1 WHERE id = ?1', id);
    const changed = await batchPdfJob(env.DB, user, batch, row, {}).catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(ApiError);
    expect((changed as ApiError).code).toBe('conflict');

    await run(env.DB, 'UPDATE templates SET deleted_at = ?1 WHERE id = ?2', Date.now(), id);
    expect(((await batchPdfJob(env.DB, user, batch, row, {}).catch((error: unknown) => error)) as ApiError).code).toBe('not_found');

    // Another account's template is "not found" too.
    const other = await createUser('pro');
    const otherId = await createTemplate(await sessionCookieFor(other.id), '<main>x</main>', '');
    expect(((await batchPdfJob(env.DB, user, { ...batch, template: otherId }, row, {}).catch((error: unknown) => error)) as ApiError).code).toBe('not_found');
  });
});
