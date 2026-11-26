/**
 * Validation of a POST /v1/batches body (and its dashboard twin): everything that can be refused
 * before anything is stored, queued or rendered, so a batch that is accepted can only fail row by
 * row at render time (a template error, the browser, the quota running out).
 *
 *   template  a PDF starter id or a custom template id, checked for shape only here; the route
 *             resolves it for the account (resolvePdfTemplate) and answers 404 like POST /v1/pdf
 *   rows      1..BATCH.maxRows[plan] objects, each validated by validatePdfData, the one validator
 *             of PDF data, so a row is accepted exactly when POST /v1/pdf would accept it as data
 *   pdf       {format, landscape}; absent values keep the template's defaults
 *   filename  a pattern such as "{{recipient_name}}-{{n}}.pdf" giving each row's ASCII name
 *   verify    certificate records for every row; on by default for the certificate template
 *
 * Pure apart from the random certificate ids: no D1, no clock.
 */
import { formatCount, getPlan, PLAN_ORDER, type PlanId } from '../billing/plans';
import { BATCH, LIMITS, PDF } from '../config';
import { ApiError, isApiError } from '../lib/errors';
import { assertKnownFields, isJsonObject, usageJson, type JsonObject } from '../lib/http';
import { parseFormat, parseLandscape, sanitizeFilename } from '../pdf/page';
import { validatePdfData, type PdfData } from '../pdf/template';
import { getPdfTemplate, PDF_TEMPLATE_IDS } from '../pdf/templates';
import type { UsageSummary } from '../types';
import { newCertificateId, VERIFICATION_KEYS, verifyUrl, withVerificationFields } from './certificates';
import type { BatchPdfOptions, ParsedBatchRequest, ParsedBatchRow } from './types';

export const BATCH_FIELDS: readonly string[] = ['template', 'rows', 'pdf', 'filename', 'verify'];
const PDF_OPTION_FIELDS: readonly string[] = ['format', 'landscape'];
/** The same shape resolvePdfTemplate accepts. */
const TEMPLATE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The starter template whose documents are verified unless the request says otherwise. */
const VERIFIED_BY_DEFAULT = 'certificate';

function invalid(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('invalid_request', message, details ? { details } : {});
}

/* ------------------------------------------------------------------ */
/* Row counts and capacity                                             */
/* ------------------------------------------------------------------ */

export function maxRowsFor(plan: PlanId): number {
  return BATCH.maxRows[plan];
}

/**
 * Too many rows for the plan: 403 plan_required when a higher plan takes that many (the fix is
 * an upgrade), 400 otherwise (the fix is to split the spreadsheet).
 */
function tooManyRows(plan: PlanId, rows: number): ApiError {
  const max = maxRowsFor(plan);
  const higher = PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan) + 1).find((candidate) => maxRowsFor(candidate) >= rows);
  const details = { rows, max_rows: max, plan };
  const base = `A batch on the ${getPlan(plan).name} plan may have at most ${formatCount(max)} rows; this one has ${formatCount(rows)}.`;
  if (higher) return new ApiError('plan_required', `${base} The ${getPlan(higher).name} plan takes ${formatCount(maxRowsFor(higher))}, or split the rows into several batches.`, { details });
  return invalid(`${base} Split the rows into several batches.`, details);
}

/** Images a batch needs at the least: every row counts as at least one PDF of PDF.baseUnits images. */
export function batchUnitsNeeded(rows: number): number {
  return rows * PDF.baseUnits;
}

/**
 * The capacity check before a batch is accepted: at least PDF.baseUnits images per row must be
 * left, in the allowance and top-ups together. It cannot promise more: each PDF is charged as
 * one block when it is rendered, longer PDFs count for more, and other renders run at the same
 * time; a batch that runs out on the way ends "partial" (src/batch/consumer.ts).
 */
export function assertBatchFits(usage: UsageSummary, rows: number, appUrl: string): void {
  const needed = batchUnitsNeeded(rows);
  if (usage.total_remaining >= needed) return;
  const plan = getPlan(usage.plan);
  const pricing = `${appUrl.replace(/\/+$/, '')}/pricing`;
  throw new ApiError(
    'quota_exceeded',
    `This batch of ${formatCount(rows)} rows needs at least ${formatCount(needed)} images (a PDF counts as at least ${PDF.baseUnits}); ` +
      `${formatCount(usage.total_remaining)} are left on the ${plan.name} plan this period, top-ups included. ` +
      `Send fewer rows, or get more images at ${pricing}.`,
    { details: { usage: usageJson(usage), units_needed: needed } },
  );
}

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

/** {{ name }} with optional spaces inside the braces. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** The row number placeholder; it wins over a data key that happens to be called "n". */
const ROW_NUMBER = 'n';

type FilenamePart = { text: string } | { field: string } | { rowNumber: true };

/** The default pattern: "<starter id>-{{n}}.pdf", or "document-{{n}}.pdf" for the account's own templates. */
export function defaultFilenamePattern(template: string): string {
  return `${getPdfTemplate(template) ? template : 'document'}-{{${ROW_NUMBER}}}.pdf`;
}

/**
 * Splits a pattern into text and placeholders. Refused: anything but text, a pattern longer than
 * PDF.maxFilenameChars, a placeholder that is neither {{n}} nor a valid data key, and braces that
 * are not a placeholder (a typo such as "{{name}" would otherwise silently become text).
 */
export function compileFilenamePattern(pattern: unknown): FilenamePart[] {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw invalid('"filename" must be a pattern such as "{{recipient_name}}-{{n}}.pdf": data fields in {{ }}, and {{n}} for the row number.');
  }
  if (pattern.length > PDF.maxFilenameChars) throw invalid(`"filename" may be at most ${PDF.maxFilenameChars} characters.`);
  const parts: FilenamePart[] = [];
  let last = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (name !== ROW_NUMBER && !LIMITS.dataKeyPattern.test(name)) {
      throw invalid(`"filename": "${match[0].slice(0, 40)}" is not a placeholder. Use {{field}} with a data key (a-z, 0-9 and "_"), or {{n}} for the row number.`);
    }
    parts.push({ text: pattern.slice(last, match.index) });
    parts.push(name === ROW_NUMBER ? { rowNumber: true } : { field: name });
    last = match.index + match[0].length;
  }
  parts.push({ text: pattern.slice(last) });
  if (parts.some((part) => 'text' in part && /[{}]/.test(part.text))) {
    throw invalid('"filename" has a "{" or "}" that is not part of a placeholder. Write placeholders as {{field}} or {{n}}.');
  }
  return parts.filter((part) => !('text' in part) || part.text !== '');
}

function fieldText(value: PdfData[string] | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return '';
}

/**
 * One row's download name: the pattern filled in ({{n}} is the row number counted from 1, a
 * missing or list field is empty) and made safe by sanitizeFilename (ASCII only, ".pdf",
 * PDF.maxFilenameChars). A name with nothing usable left is "<default stem>-<n>.pdf".
 */
export function rowFilename(parts: readonly FilenamePart[], data: PdfData, index: number, fallbackStem: string): string {
  const number = String(index + 1);
  const text = parts.map((part) => ('text' in part ? part.text : 'rowNumber' in part ? number : fieldText(data[part.field]))).join('');
  return sanitizeFilename(text, `${fallbackStem}-${number}.pdf`);
}

/**
 * Names unique within a batch, ignoring case (a ZIP extracted on macOS or Windows would
 * otherwise overwrite files): the first "a.pdf" stays, the next are "a (2).pdf", "a (3).pdf", the
 * ZIP writer's convention (src/lib/zip.ts), cut to stay within PDF.maxFilenameChars.
 */
export function dedupeFilenames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const stem = name.slice(0, -'.pdf'.length);
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n}).pdf`;
      candidate = `${stem.slice(0, PDF.maxFilenameChars - suffix.length).replace(/[\s.-]+$/, '')}${suffix}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/* ------------------------------------------------------------------ */
/* The request                                                         */
/* ------------------------------------------------------------------ */

export interface BatchRequestContext {
  /** The account's plan in force now (pdfCapacity's usage.plan): it decides BATCH.maxRows. */
  plan: PlanId;
  /** APP_URL, for the verification links checked here. */
  appUrl: string;
}

function parseTemplateId(value: unknown): string {
  if (typeof value !== 'string' || !TEMPLATE_ID_RE.test(value)) {
    throw invalid(`"template" is required: a PDF starter template (${PDF_TEMPLATE_IDS.join(', ')}) or the id of one of your own templates.`);
  }
  return value;
}

function parsePdfOptions(value: unknown): BatchPdfOptions {
  if (value === undefined || value === null) return { format: null, landscape: null };
  if (!isJsonObject(value)) throw invalid('"pdf" must be an object, for example {"format": "a4", "landscape": true}.');
  const unknown = Object.keys(value).filter((key) => !PDF_OPTION_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw invalid(`Unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"pdf.${key}"`).join(', ')}. A batch takes "pdf.format" and "pdf.landscape".`);
  }
  return {
    format: value.format === undefined || value.format === null ? null : parseFormat(value.format, PDF.defaultFormat),
    landscape: value.landscape === undefined || value.landscape === null ? null : parseLandscape(value.landscape, false),
  };
}

function parseVerify(value: unknown, template: string): boolean {
  if (value === undefined || value === null) return template === VERIFIED_BY_DEFAULT;
  if (typeof value !== 'boolean') throw invalid('"verify" must be true or false.');
  return value;
}

/** validatePdfData for one row, with its errors naming the row ("rows[3] may contain at most 40 keys"). */
function validateRow(value: unknown, index: number): PdfData {
  const where = `rows[${index}]`;
  if (!isJsonObject(value)) throw invalid(`${where} must be an object of fields, for example {"recipient_name": "Amara Nwosu"}.`, { row: index });
  try {
    return validatePdfData(value);
  } catch (error) {
    if (!isApiError(error)) throw error;
    const message = error.message.startsWith('"data"') ? `${where}${error.message.slice('"data"'.length)}` : `${where}: ${error.message}`;
    throw new ApiError(error.code, message, { details: { ...error.details, row: index } });
  }
}

/**
 * The data of a verified row must leave room for the three fields Link To Card adds, and must
 * not fill them itself (withVerificationFields says why). The QR code is made at render time;
 * here an empty stand-in is enough, since only the keys are checked.
 */
function checkVerifiable(data: PdfData, index: number, certificateId: string, appUrl: string): void {
  const where = `rows[${index}]`;
  withVerificationFields(data, { certificate_id: certificateId, verify_url: verifyUrl(appUrl, certificateId), verify_qr: '' }, where);
  const keys = Object.keys(data).length;
  if (keys + VERIFICATION_KEYS.length > PDF.maxDataKeys) {
    throw invalid(
      `${where} has ${keys} fields. With "verify" on, Link To Card adds ${VERIFICATION_KEYS.length} (${VERIFICATION_KEYS.join(', ')}), and a row may have at most ${PDF.maxDataKeys} in all.`,
      { row: index },
    );
  }
}

/** The whole body; throws ApiError (invalid_request, plan_required) at the first problem. */
export function parseBatchRequest(body: JsonObject, ctx: BatchRequestContext): ParsedBatchRequest {
  assertKnownFields(body, BATCH_FIELDS);
  const template = parseTemplateId(body.template);
  const { rows } = body;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw invalid('"rows" must be a list of at least one row, each an object of fields, for example [{"recipient_name": "Amara Nwosu"}].');
  }
  if (rows.length > maxRowsFor(ctx.plan)) throw tooManyRows(ctx.plan, rows.length);
  const pdf = parsePdfOptions(body.pdf);
  const verify = parseVerify(body.verify, template);
  const filenamePattern = body.filename === undefined || body.filename === null ? defaultFilenamePattern(template) : body.filename;
  const parts = compileFilenamePattern(filenamePattern);
  const fallbackStem = getPdfTemplate(template) ? template : 'document';

  const parsed: ParsedBatchRow[] = [];
  const names: string[] = [];
  rows.forEach((value: unknown, index) => {
    const data = validateRow(value, index);
    const certificateId = verify ? newCertificateId() : null;
    if (certificateId !== null) checkVerifiable(data, index, certificateId, ctx.appUrl);
    names.push(rowFilename(parts, data, index, fallbackStem));
    parsed.push({ index, data, filename: '', certificateId });
  });
  const unique = dedupeFilenames(names);
  for (const row of parsed) row.filename = unique[row.index]!;
  return { template, rows: parsed, pdf, verify, filenamePattern: filenamePattern as string };
}
