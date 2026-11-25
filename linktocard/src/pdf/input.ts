/**
 * Request input of the PDF endpoints, validated into a PdfJob:
 *
 *   POST /v1/pdf          { template | html, css?, data?, pdf?: { format?, landscape?, margin?,
 *                           header?, footer? }, filename?, response? }
 *   GET /v1/pdf/{site}/{template}.pdf?<data>&format=&landscape=&filename=&items=<JSON>&sig=
 *   POST /api/tools/pdf   { tool, html?, css?, data?, pdf?: { format?, landscape? }, turnstile? }
 */
import { ApiError } from '../lib/errors';
import { assertKnownFields, isJsonObject, type JsonObject } from '../lib/http';
import { parseFilename, sanitizeFilename } from './page';
import {
  inlinePdfTemplate,
  pageSetupFor,
  pdfTemplateNotFound,
  planMark,
  resolvePdfTemplate,
  starterPdfTemplate,
  type PdfJob,
  type PdfTemplateSource,
} from './service';
import { validatePdfData } from './template';
import type { UserRow } from '../types';

export const PDF_FIELDS: readonly string[] = ['template', 'html', 'css', 'data', 'pdf', 'filename', 'response'];
const PAGE_FIELDS: readonly string[] = ['format', 'landscape', 'margin', 'header', 'footer'];
const RESPONSE_MODES = ['url', 'binary'] as const;
export type PdfResponseMode = (typeof RESPONSE_MODES)[number];

export const TOOLS = ['html-to-pdf', 'invoice', 'certificate'] as const;
export type PdfTool = (typeof TOOLS)[number];
export const TOOL_FIELDS: readonly string[] = ['tool', 'html', 'css', 'data', 'pdf', 'turnstile'];
const TOOL_PAGE_FIELDS: readonly string[] = ['format', 'landscape'];

/** Reserved query parameters of a signed PDF link; every other parameter is template data. */
export const SIGNED_PDF_PARAMS = ['format', 'landscape', 'filename', 'items'] as const;

/** Signed PDF links: /v1/pdf/{site id}/{template}.pdf with the same path characters as /v1/og. */
const PDF_PATH = /^\/v1\/pdf\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\.pdf$/;

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

export function parsePdfPath(pathname: string): { siteId: string; template: string } | null {
  const match = PDF_PATH.exec(pathname);
  return match ? { siteId: match[1]!, template: match[2]! } : null;
}

function pageObject(value: unknown, allowed: readonly string[]): JsonObject {
  if (value === undefined) return {};
  if (!isJsonObject(value)) throw invalid('"pdf" must be an object, for example {"format": "a4", "landscape": false}.');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`Unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((key) => `"pdf.${key}"`).join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }
  return value;
}

function optionalTemplate(value: unknown, what: 'header' | 'footer'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid(`"pdf.${what}" must be an HTML string.`);
  return value;
}

function optionalCss(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw invalid('"css" must be a string.');
  return value;
}

/** POST /v1/pdf body -> job and response mode, with the template resolved for this account. */
export async function parsePdfRequest(db: D1Database, user: UserRow, body: JsonObject): Promise<{ job: PdfJob; mode: PdfResponseMode }> {
  assertKnownFields(body, PDF_FIELDS);
  const { template: templateId, html, css } = body;
  if ((templateId === undefined) === (html === undefined)) {
    throw invalid('Send exactly one of "template" (a template id) or "html" (an inline template).');
  }
  if (templateId !== undefined && css !== undefined) throw invalid('"css" can only be sent together with "html".');
  if (templateId !== undefined && typeof templateId !== 'string') throw invalid('"template" must be a template id, for example "invoice".');
  if (html !== undefined && (typeof html !== 'string' || html.trim() === '')) throw invalid('"html" must be a non-empty string.');
  const mode = RESPONSE_MODES.find((candidate) => candidate === (body.response ?? 'url'));
  if (!mode) throw invalid('"response" must be "url" (default) or "binary".');

  const data = validatePdfData(body.data);
  const page = pageObject(body.pdf, PAGE_FIELDS);
  const template = typeof html === 'string' ? await inlinePdfTemplate(html, optionalCss(css)) : await resolvePdfTemplate(db, user.id, templateId);
  if (!template) throw pdfTemplateNotFound();
  const mark = planMark(user);
  return {
    mode,
    job: {
      template,
      data,
      setup: pageSetupFor(page, template.defaults, mark),
      header: optionalTemplate(page.header, 'header'),
      footer: optionalTemplate(page.footer, 'footer'),
      mark,
      filename: parseFilename(body.filename, `${template.label === 'inline' ? 'document' : template.label}.pdf`),
    },
  };
}

/** A signed link's verified parameters -> job. `items` is a JSON-encoded list. */
export async function signedPdfJob(db: D1Database, owner: UserRow, templateId: string, params: Record<string, string>): Promise<PdfJob> {
  const { format, landscape, filename, items, ...rest } = params;
  let list: unknown;
  if (items !== undefined) {
    try {
      list = JSON.parse(items);
    } catch {
      throw invalid('"items" must be a JSON-encoded list, for example items=[{"description":"Design","amount":"1,200.00"}].');
    }
  }
  const data = validatePdfData(list === undefined ? rest : { ...rest, items: list });
  const template = await resolvePdfTemplate(db, owner.id, templateId);
  if (!template) throw pdfTemplateNotFound();
  const mark = planMark(owner);
  return {
    template,
    data,
    setup: pageSetupFor({ format, landscape }, template.defaults, mark),
    header: null,
    footer: null,
    mark,
    filename: filename === undefined ? sanitizeFilename(`${template.label}.pdf`, 'document.pdf') : sanitizeFilename(filename, `${template.label}.pdf`),
  };
}

/** POST /api/tools/pdf body -> tool and job. Free tools always carry the mark. */
export async function parseToolRequest(body: JsonObject): Promise<{ tool: PdfTool; job: PdfJob; turnstile: string | null }> {
  assertKnownFields(body, TOOL_FIELDS);
  const tool = TOOLS.find((candidate) => candidate === body.tool);
  if (!tool) throw invalid(`"tool" must be one of ${TOOLS.map((name) => `"${name}"`).join(', ')}.`);
  const css = optionalCss(body.css);
  let template: PdfTemplateSource;
  if (tool === 'html-to-pdf') {
    if (typeof body.html !== 'string' || body.html.trim() === '') throw invalid('"html" is required for the html-to-pdf tool and must be a non-empty string.');
    template = await inlinePdfTemplate(body.html, css);
  } else {
    if (body.html !== undefined) throw invalid(`The ${tool} tool uses its own template; send "data", not "html".`);
    const starter = starterPdfTemplate(tool);
    template = css === '' ? starter : { ...starter, identity: `${starter.identity}+css`, css: `${starter.css}\n${css}` };
  }
  const turnstile = body.turnstile === undefined || body.turnstile === null ? null : typeof body.turnstile === 'string' ? body.turnstile : '';
  return {
    tool,
    turnstile,
    job: {
      template,
      data: validatePdfData(body.data),
      setup: pageSetupFor(pageObject(body.pdf, TOOL_PAGE_FIELDS), template.defaults, true),
      header: null,
      footer: null,
      mark: true,
      filename: `${tool}.pdf`,
    },
  };
}
