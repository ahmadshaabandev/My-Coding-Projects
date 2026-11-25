import type { PdfFormat } from '../../config';

/** One row of a `{{#items}} ... {{/items}}` section: flat fields only. */
export type PdfItem = Record<string, string | number>;

/** Data for a PDF template: flat values, plus at most one list, `items`. */
export type PdfData = Record<string, string | number | PdfItem[]>;

export interface PdfMargin {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export interface PdfPageSetup {
  format: PdfFormat;
  landscape: boolean;
  margin: PdfMargin;
}

export interface PdfTemplateField {
  /** Data key, /^[a-z][a-z0-9_]{0,31}$/. For the list this is "items". */
  key: string;
  label: string;
  /** "text" for a flat value, "items" for the list; `itemFields` then names its fields. */
  kind: 'text' | 'items';
  required: boolean;
  itemFields?: readonly string[];
}

export interface PdfStarterTemplate {
  id: 'invoice' | 'receipt' | 'quote' | 'certificate' | 'report';
  name: string;
  description: string;
  html: string;
  css: string;
  defaultPdf: PdfPageSetup;
  fields: readonly PdfTemplateField[];
  /** Realistic sample data with fictional names; renders every field. */
  sample: PdfData;
}
