/**
 * The pieces of the production BatchRender: the PdfJob of one row, built the way POST /v1/pdf
 * builds it (src/pdf/input.ts parsePdfRequest), and the BatchRenderResult of what getPdf
 * returned. The wrapper itself is a few lines in src/index.ts (renderBatchRow, source "batch").
 *
 * Per row, as for a single PDF: the template is resolved for the account now (a template deleted
 * meanwhile fails the row with not_found), the free mark follows the plan the account is on now,
 * and the page setup is the request's format and orientation over the template's defaults.
 * A custom template edited after the batch was accepted fails the remaining rows with conflict
 * rather than mixing two designs in one batch.
 */
import { ApiError } from '../lib/errors';
import { pageSetupFor, pdfTemplateNotFound, planMark, resolvePdfTemplate, type PdfJob, type PdfResult, type PdfTemplateSource } from '../pdf/service';
import type { UserRow } from '../types';
import type { BatchRecord, BatchRenderRequest, BatchRenderResult } from './types';

/** The identity resolvePdfTemplate gives a custom template at a version (src/pdf/service.ts). */
export function customTemplateIdentity(id: string, version: number): string {
  return `custom:${id}@${version}`;
}

/** The version to pin for a batch (batches.template_version): a custom template's, null for a starter. */
export function pinnedTemplateVersion(template: Pick<PdfTemplateSource, 'identity'>): number | null {
  const match = /^custom:[A-Za-z0-9_-]+@(\d+)$/.exec(template.identity);
  return match ? Number(match[1]) : null;
}

export function templateChangedError(): ApiError {
  return new ApiError(
    'conflict',
    'The template was changed after this batch was accepted, so this row was not rendered. Nothing was charged for it; send the remaining rows again in a new batch.',
  );
}

/** The PdfJob of one row: what getPdf renders, caches and charges. */
export async function batchPdfJob(
  db: D1Database,
  user: UserRow,
  batch: Pick<BatchRecord, 'template' | 'templateVersion' | 'pdf'>,
  row: BatchRenderRequest['row'],
  data: BatchRenderRequest['data'],
  verification: BatchRenderRequest['verification'] = null,
): Promise<PdfJob> {
  const template = await resolvePdfTemplate(db, user.id, batch.template);
  if (!template) throw pdfTemplateNotFound();
  if (batch.templateVersion !== null && template.identity !== customTemplateIdentity(batch.template, batch.templateVersion)) throw templateChangedError();
  const mark = planMark(user);
  const page: { format?: string; landscape?: boolean } = {};
  if (batch.pdf.format !== null) page.format = batch.pdf.format;
  if (batch.pdf.landscape !== null) page.landscape = batch.pdf.landscape;
  const job: PdfJob = { template, data, setup: pageSetupFor(page, template.defaults, mark), header: null, footer: null, mark, filename: row.filename };
  // Trusted values (decision D13): outside the data limits, part of the cache key.
  if (verification !== null) job.trusted = verification;
  return job;
}

/** getPdf's answer as the consumer records it. */
export function batchRenderResult(result: Pick<PdfResult, 'pdf' | 'cached' | 'creditsUsed'>): BatchRenderResult {
  return {
    cacheKey: result.pdf.cacheKey,
    pages: result.pdf.pages,
    creditsUsed: result.creditsUsed,
    bytes: result.pdf.bytes,
    expiresAt: result.pdf.expiresAt,
    cached: result.cached,
  };
}
