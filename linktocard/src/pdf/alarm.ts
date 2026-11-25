/**
 * Daily alarm on Browser Run time, run by the daily cron next to the cleanup: when the
 * browser time of all PDF renders of the last 24 hours is over the budget, SUPPORT_EMAIL gets
 * one email, at most once per UTC day. The time of each attempt is the larger of
 * browser_usage.browser_ms (X-Browser-Ms-Used) and wall_ms (the measured length of the call).
 * Browser Run answers PDF quick actions with X-Browser-Ms-Used: 0 (seen on staging, 2026-11-25),
 * and reports nothing for timeouts and 5xx answers, so the measured length is what counts in
 * practice; it is an upper bound of the browser time.
 *
 * The budget is PDF_DAILY_BROWSER_MS_BUDGET (milliseconds) when it is set to a positive whole
 * number, otherwise PDF.dailyBrowserMsBudget. "Once per day" is an atomic D1 row (tool_usage,
 * bucket "pdf-budget-alarm:<UTC day number>"): the first run that inserts it sends; a failed
 * send removes it again so a rerun can retry.
 */
import { DAY_MS, PDF } from '../config';
import { first, isMissingTableError, run } from '../db/client';
import { sendEmail, type EmailContent } from '../lib/email';
import type { Env } from '../types';

export const PDF_BUDGET_ALARM_SUBJECT = 'Link To Card: PDF browser time over budget';

/** Browser time of the browser_usage rows a query selects: per row the larger of reported and measured. */
export const BROWSER_MS_SQL = 'COALESCE(SUM(MAX(COALESCE(browser_ms, 0), COALESCE(wall_ms, 0))), 0)';
/** Rows whose browser time Browser Run did not report (no header, or 0). */
export const UNREPORTED_SQL = 'COUNT(*) - COUNT(NULLIF(browser_ms, 0))';

export interface PdfBudgetReport {
  browserMs: number;
  budgetMs: number;
  /** Render attempts that reached the browser in the last 24 hours, and how many returned a PDF. */
  attempts: number;
  pdfs: number;
  /** Attempts Browser Run reported no time for (no header, or 0); their measured length counts. */
  unreported: number;
  /** over the budget; sent = this run sent the email; alreadySent = an earlier run today did. */
  over: boolean;
  sent: boolean;
  alreadySent: boolean;
}

/** PDF_DAILY_BROWSER_MS_BUDGET when it is a positive whole number, else the default. */
export function dailyBudgetMs(env: Pick<Env, 'PDF_DAILY_BROWSER_MS_BUDGET'>): number {
  const raw = env.PDF_DAILY_BROWSER_MS_BUDGET?.trim() ?? '';
  const value = /^\d+$/.test(raw) ? Number(raw) : 0;
  return value > 0 ? value : PDF.dailyBrowserMsBudget;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} minutes`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function budgetAlarmEmail(
  report: Pick<PdfBudgetReport, 'browserMs' | 'budgetMs' | 'attempts' | 'pdfs'> & Partial<Pick<PdfBudgetReport, 'unreported'>>,
  now: number,
  environment = '',
): EmailContent {
  const where = environment ? ` on ${environment}` : '';
  const unreported = report.unreported
    ? ` For ${report.unreported} of the attempts Browser Run reported no browser time (it reports 0 for PDFs, and nothing for timeouts and errors); the measured length of the call is counted instead.`
    : '';
  const paragraphs = [
    `In the 24 hours up to ${new Date(now).toISOString()}, PDF rendering${where} used ${minutes(report.browserMs)} of Browser Run time. The daily budget is ${minutes(report.budgetMs)}.`,
    `PDFs: ${report.pdfs} (from ${report.attempts} render attempts that reached the browser).${unreported}`,
    'Per-account and per-source numbers are in the browser_usage table. The budget is the Worker variable PDF_DAILY_BROWSER_MS_BUDGET (milliseconds). This alert is sent at most once per UTC day.',
  ];
  return {
    subject: PDF_BUDGET_ALARM_SUBJECT,
    text: `${paragraphs.join('\n\n')}\n`,
    html:
      '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#111827">' +
      paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('') +
      '</body></html>',
  };
}

export async function runPdfBudgetAlarm(env: Env, now: number): Promise<PdfBudgetReport> {
  let totals: { ms: number; attempts: number; pdfs: number; unreported: number } | null;
  try {
    totals = await first<{ ms: number; attempts: number; pdfs: number; unreported: number }>(
      env.DB,
      `SELECT ${BROWSER_MS_SQL} AS ms, COUNT(*) AS attempts, COUNT(pages) AS pdfs, ${UNREPORTED_SQL} AS unreported
       FROM browser_usage WHERE created_at > ?1 AND created_at <= ?2`,
      now - DAY_MS,
      now,
    );
  } catch (error) {
    // Deployed before migration 0006: no PDF has been rendered, so there is nothing to report.
    if (!isMissingTableError(error)) throw error;
    console.error('browser_usage is missing: apply migration 0006_pdf.sql');
    totals = null;
  }
  const report: PdfBudgetReport = {
    browserMs: totals?.ms ?? 0,
    budgetMs: dailyBudgetMs(env),
    attempts: totals?.attempts ?? 0,
    pdfs: totals?.pdfs ?? 0,
    unreported: totals?.unreported ?? 0,
    over: false,
    sent: false,
    alreadySent: false,
  };
  report.over = report.browserMs > report.budgetMs;
  if (!report.over) return report;

  const day = Math.floor(now / DAY_MS);
  const bucket = `pdf-budget-alarm:${day}`;
  const claimed = await run(
    env.DB,
    'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (bucket) DO NOTHING',
    bucket,
    (day + 2) * DAY_MS,
  );
  if (claimed !== 1) return { ...report, alreadySent: true };

  // The environment is part of the key: staging and production may send through one Resend team.
  const environment = env.ENVIRONMENT || 'unknown';
  const result = await sendEmail(env, { to: env.SUPPORT_EMAIL, ...budgetAlarmEmail(report, now, environment), idempotencyKey: `pdf-budget-${environment}-${day}` });
  if (!result.ok) {
    console.error(`PDF budget alarm email was not sent: ${result.error}`);
    await run(env.DB, 'DELETE FROM tool_usage WHERE bucket = ?1', bucket);
    return report;
  }
  return { ...report, sent: true };
}
