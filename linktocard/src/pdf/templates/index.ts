/**
 * PDF starter templates: plain data (HTML + CSS strings, page setup, field list and sample).
 *
 * This module must stay free of runtime-specific imports: the Worker renders from it, and the
 * site build (Node) lists it on the docs and tool pages.
 */

import { certificate } from './certificate';
import { invoice } from './invoice';
import { quote } from './quote';
import { receipt } from './receipt';
import { report } from './report';
import type { PdfStarterTemplate } from './types';

export type { PdfData, PdfItem, PdfMargin, PdfPageSetup, PdfStarterTemplate, PdfTemplateField } from './types';

export type PdfTemplateId = PdfStarterTemplate['id'];

export const PDF_TEMPLATES: readonly PdfStarterTemplate[] = [invoice, receipt, quote, certificate, report];

export const PDF_TEMPLATE_IDS: readonly PdfTemplateId[] = PDF_TEMPLATES.map((template) => template.id);

export function getPdfTemplate(id: string): PdfStarterTemplate | undefined {
  return PDF_TEMPLATES.find((template) => template.id === id);
}
