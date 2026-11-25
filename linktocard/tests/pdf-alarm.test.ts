// The daily Browser Run budget alarm (src/pdf/alarm.ts), its place in the daily cron, and the
// cleanup of browser_usage rows.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, PDF } from '../src/config';
import { all, first, run } from '../src/db/client';
import worker from '../src/index';
import { runCleanup } from '../src/lib/cleanup';
import { PDF_BUDGET_ALARM_SUBJECT, dailyBudgetMs, runPdfBudgetAlarm } from '../src/pdf/alarm';
import type { Env } from '../src/types';

const RESEND_URL = 'https://api.resend.com/emails';
/** 25 Nov 2026 03:17 UTC, when the daily cron runs. */
const NOW = Date.UTC(2026, 10, 25, 3, 17);

interface Sent {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string | null;
}

function mockResend(status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== RESEND_URL) throw new Error(`unexpected outbound request: ${url}`);
    const body = JSON.parse(String(init?.body)) as { to: string; subject: string; text: string };
    sent.push({ to: body.to, subject: body.subject, text: body.text, idempotencyKey: new Headers(init?.headers).get('idempotency-key') });
    return status === 200 ? Response.json({ id: `em_${sent.length}` }) : Response.json({ name: 'validation_error', message: 'nope' }, { status });
  });
  return sent;
}

let rowSeq = 0;
async function usage(createdAt: number, browserMs: number | null, pages: number | null = 1): Promise<void> {
  await run(
    env.DB,
    'INSERT INTO browser_usage (id, user_id, source, status, browser_ms, pages, created_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)',
    `bu_test${++rowSeq}`,
    'tool',
    pages === null ? 500 : 200,
    browserMs,
    pages,
    createdAt,
  );
}

beforeEach(async () => {
  await run(env.DB, 'DELETE FROM browser_usage');
  await run(env.DB, "DELETE FROM tool_usage WHERE bucket LIKE 'pdf-budget-alarm:%'");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPdfBudgetAlarm', () => {
  it('sends nothing while the last 24 hours stay within the budget', async () => {
    const sent = mockResend();
    await usage(NOW - 1000, PDF.dailyBrowserMsBudget);
    await usage(NOW - DAY_MS - 1, PDF.dailyBrowserMsBudget * 5); // older than 24 h: not counted
    const report = await runPdfBudgetAlarm(env, NOW);
    expect(report).toMatchObject({ browserMs: PDF.dailyBrowserMsBudget, budgetMs: PDF.dailyBrowserMsBudget, attempts: 1, over: false, sent: false });
    expect(sent).toEqual([]);
  });

  it('emails SUPPORT_EMAIL once per UTC day when over the budget, with minutes, budget and PDFs', async () => {
    const sent = mockResend();
    await usage(NOW - 60_000, 15 * 60_000, 3);
    await usage(NOW - 120_000, 6 * 60_000, 1);
    await usage(NOW - 180_000, 30_000, null); // an attempt without a PDF: its time counts, it is not a PDF
    const report = await runPdfBudgetAlarm(env, NOW);
    expect(report).toMatchObject({ browserMs: 21.5 * 60_000, attempts: 3, pdfs: 2, over: true, sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: env.SUPPORT_EMAIL, subject: PDF_BUDGET_ALARM_SUBJECT, idempotencyKey: `pdf-budget-${Math.floor(NOW / DAY_MS)}` });
    expect(sent[0]!.subject).toBe('Link To Card: PDF browser time over budget');
    expect(sent[0]!.text).toContain('used 21.5 minutes of Browser Run time');
    expect(sent[0]!.text).toContain(`The daily budget is ${(PDF.dailyBrowserMsBudget / 60_000).toFixed(1)} minutes`);
    expect(sent[0]!.text).toContain('PDFs: 2 (from 3 render attempts');

    // Later the same UTC day: no second email.
    expect(await runPdfBudgetAlarm(env, NOW + 6 * 3_600_000)).toMatchObject({ over: true, sent: false, alreadySent: true });
    expect(sent).toHaveLength(1);
  });

  it('sends again on the next UTC day if the usage is still over', async () => {
    const sent = mockResend();
    await usage(NOW - 60_000, PDF.dailyBrowserMsBudget + 1);
    await runPdfBudgetAlarm(env, NOW);
    await usage(NOW + DAY_MS - 60_000, PDF.dailyBrowserMsBudget + 1);
    expect(await runPdfBudgetAlarm(env, NOW + DAY_MS)).toMatchObject({ sent: true });
    expect(sent).toHaveLength(2);
  });

  it('two runs at the same moment send one email', async () => {
    const sent = mockResend();
    await usage(NOW - 60_000, PDF.dailyBrowserMsBudget * 2);
    const reports = await Promise.all([runPdfBudgetAlarm(env, NOW), runPdfBudgetAlarm(env, NOW)]);
    expect(reports.filter((report) => report.sent)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('lets a later run retry when the email could not be sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockResend(422);
    await usage(NOW - 60_000, PDF.dailyBrowserMsBudget * 2);
    expect(await runPdfBudgetAlarm(env, NOW)).toMatchObject({ over: true, sent: false, alreadySent: false });
    vi.restoreAllMocks();
    const sent = mockResend();
    expect(await runPdfBudgetAlarm(env, NOW + 1000)).toMatchObject({ sent: true });
    expect(sent).toHaveLength(1);
  });

  it('uses PDF_DAILY_BROWSER_MS_BUDGET when it is a positive whole number', async () => {
    expect(dailyBudgetMs({ PDF_DAILY_BROWSER_MS_BUDGET: '60000' })).toBe(60_000);
    for (const value of [undefined, '', '0', '-5', '1.5', 'lots']) expect(dailyBudgetMs({ PDF_DAILY_BROWSER_MS_BUDGET: value })).toBe(PDF.dailyBrowserMsBudget);
    const sent = mockResend();
    await usage(NOW - 60_000, 61_000);
    const bindings: Env = { ...env, PDF_DAILY_BROWSER_MS_BUDGET: '60000' };
    expect(await runPdfBudgetAlarm(bindings, NOW)).toMatchObject({ budgetMs: 60_000, over: true, sent: true });
    expect(sent[0]!.text).toContain('The daily budget is 1.0 minutes');
  });

  it('runs from the daily cron next to the cleanup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent = mockResend();
    await usage(Date.now() - 60_000, PDF.dailyBrowserMsBudget * 3);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(sent.map((message) => message.subject)).toEqual([PDF_BUDGET_ALARM_SUBJECT]);
  });
});

describe('cleanup of browser_usage', () => {
  it(`keeps ${PDF.browserUsageRetentionDays} days and deletes what is older`, async () => {
    const cutoff = NOW - PDF.browserUsageRetentionDays * DAY_MS;
    await usage(cutoff - 1, 100);
    await usage(cutoff, 100);
    await usage(cutoff + 1, 100);
    await usage(NOW - 1000, 100);
    const report = await runCleanup(env, NOW);
    expect(report.browserUsage).toBe(2);
    const left = await all<{ created_at: number }>(env.DB, 'SELECT created_at FROM browser_usage ORDER BY created_at');
    expect(left.map((row) => row.created_at)).toEqual([cutoff + 1, NOW - 1000]);
    // Nothing to delete: the report leaves the key out, like the other optional counts.
    expect(await runCleanup(env, NOW)).not.toHaveProperty('browserUsage');
  });

  it('removes an expired stored PDF and its ledger row like an image', async () => {
    const userId = `u_pdfclean${++rowSeq}`;
    await run(env.DB, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, 1, 'free')", userId, `${userId}@example.test`);
    const key = `r/${userId}/${'c'.repeat(64)}.pdf`;
    await env.BUCKET.put(key, new Uint8Array([37, 80, 68, 70]));
    await run(
      env.DB,
      "INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at) VALUES (?1, ?2, NULL, 'api', 'invoice', 0, 0, 'pdf', 4, ?3, 'plan', 0, 1, ?4)",
      'c'.repeat(64),
      userId,
      key,
      NOW - 1,
    );
    await runCleanup(env, NOW);
    expect(await env.BUCKET.head(key)).toBeNull();
    expect(await first(env.DB, 'SELECT cache_key FROM renders WHERE user_id = ?1', userId)).toBeNull();
  });

  it('purges an account marked for deletion with its PDF counts and stored PDFs; its browser time stays, without the id', async () => {
    const userId = `u_pdfpurge${++rowSeq}`;
    await run(env.DB, "INSERT INTO users (id, email, created_at, plan, deletion_requested_at) VALUES (?1, ?2, 1, 'free', 1)", userId, `${userId}@example.test`);
    await run(env.DB, 'INSERT INTO pdf_usage (user_id, period_start, pdfs, units) VALUES (?1, 0, 2, 5)', userId);
    await run(env.DB, "INSERT INTO browser_usage (id, user_id, source, status, browser_ms, pages, created_at) VALUES (?1, ?2, 'api', 200, 7, 3, ?3)", `bu_${userId}`, userId, NOW);
    const key = `r/${userId}/${'d'.repeat(64)}.pdf`;
    await env.BUCKET.put(key, new Uint8Array([37, 80, 68, 70]));

    expect((await runCleanup(env, NOW)).deletedAccounts).toBeGreaterThanOrEqual(1);
    expect(await first(env.DB, 'SELECT id FROM users WHERE id = ?1', userId)).toBeNull();
    expect(await first(env.DB, 'SELECT pdfs FROM pdf_usage WHERE user_id = ?1', userId)).toBeNull();
    expect(await first(env.DB, 'SELECT user_id, browser_ms FROM browser_usage WHERE id = ?1', `bu_${userId}`)).toEqual({ user_id: null, browser_ms: 7 });
    expect(await env.BUCKET.head(key)).toBeNull();
  });

  it('keeps the rows of a deleted account for the cost totals, without the account id', async () => {
    const userId = `u_pdfgone${++rowSeq}`;
    await run(env.DB, "INSERT INTO users (id, email, created_at, plan) VALUES (?1, ?2, 1, 'free')", userId, `${userId}@example.test`);
    await run(env.DB, "INSERT INTO browser_usage (id, user_id, source, status, browser_ms, pages, created_at) VALUES ('bu_gone', ?1, 'api', 200, 5, 1, ?2)", userId, NOW);
    await run(env.DB, 'DELETE FROM users WHERE id = ?1', userId);
    expect(await first(env.DB, "SELECT user_id, browser_ms FROM browser_usage WHERE id = 'bu_gone'")).toEqual({ user_id: null, browser_ms: 5 });
  });
});
