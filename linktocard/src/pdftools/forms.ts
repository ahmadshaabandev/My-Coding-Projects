/**
 * fields and fill: the AcroForm fields of a PDF, listed and filled by their full names
 * ("applicant.name": the name pdf-lib, Acrobat and the PDF's own field tree agree on).
 *
 * Values by field type:
 *   text          string (line breaks only in multi-line fields); null clears
 *   checkbox      true / false, or "true" "false" "yes" "no" "on" "off" (connectors send text)
 *   radio         one of the field's options; null clears
 *   dropdown      one of its options (any text if the dropdown is editable); a list when it is multi-select
 *   option_list   one option, or a list of options when it is multi-select
 *   button, signature   cannot be filled
 *
 * Every name and value is checked before anything changes, so a request with one bad entry
 * fails as a whole and names the entry. Filled fields get new appearances in Helvetica (a
 * standard font: Latin characters only, src/pdftools/text.ts); `flatten` then turns the form
 * into ordinary page content that can no longer be edited.
 */
import {
  type PDFDocument,
  type PDFField,
  type PDFFont,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFTextField,
} from '@cantoo/pdf-lib';
import { PDF } from '../config';
import { ApiError } from '../lib/errors';
import { codePointLength } from '../lib/http';
import { assertTotalBytes, fileLabel, loadPdf } from './document';
import { finish } from './mark';
import { assertDrawable } from './text';
import type { OutputOptions, PdfOutput } from './types';

export type FieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'option_list' | 'button' | 'signature' | 'unknown';

export interface FieldInfo {
  name: string;
  type: FieldType;
  /** text: string; checkbox: boolean; radio and single dropdown: string or null; multi-select and option list: string[]; others null. */
  value: string | boolean | string[] | null;
  /** Choices of radio, dropdown and option list fields. */
  options?: string[];
  required: boolean;
  read_only: boolean;
  /** 1-based pages the field's widgets are on. */
  pages: number[];
  max_length?: number;
  multiline?: boolean;
  multiselect?: boolean;
  editable?: boolean;
}

export type FillValue = string | boolean | string[] | null;

export interface FillOptions extends OutputOptions {
  values: Record<string, FillValue>;
  flatten?: boolean;
}

/** How many valid names an "unknown field" message spells out; the full list is in its details. */
const NAMES_IN_MESSAGE = 25;

function invalid(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError('invalid_request', message, details ? { details } : {});
}

function typeOf(field: PDFField): FieldType {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'option_list';
  if (field instanceof PDFButton) return 'button';
  if (field instanceof PDFSignature) return 'signature';
  return 'unknown';
}

/** Page numbers of a field's widgets: from each widget's /P, else by finding it in a page's /Annots. */
function fieldPages(doc: PDFDocument, field: PDFField, pageOf: Map<string, number>): number[] {
  const pages = new Set<number>();
  const docPages = doc.getPages();
  for (const widget of field.acroField.getWidgets()) {
    const parent = widget.P();
    const direct = parent instanceof PDFRef ? pageOf.get(parent.toString()) : undefined;
    if (direct !== undefined) {
      pages.add(direct);
      continue;
    }
    docPages.forEach((page, index) => {
      const annots = page.node.Annots();
      if (!annots) return;
      for (let i = 0; i < annots.size(); i++) {
        if (doc.context.lookup(annots.get(i)) === widget.dict) pages.add(index + 1);
      }
    });
  }
  return [...pages].sort((a, b) => a - b);
}

function describe(doc: PDFDocument, field: PDFField, pageOf: Map<string, number>): FieldInfo {
  const type = typeOf(field);
  const info: FieldInfo = { name: field.getName(), type, value: null, required: field.isRequired(), read_only: field.isReadOnly(), pages: fieldPages(doc, field, pageOf) };
  if (field instanceof PDFTextField) {
    try {
      info.value = field.getText() ?? '';
    } catch {
      info.value = null; // rich text pdf-lib cannot read
    }
    const max = field.getMaxLength();
    if (max !== undefined) info.max_length = max;
    info.multiline = field.isMultiline();
  } else if (field instanceof PDFCheckBox) {
    info.value = field.isChecked();
  } else if (field instanceof PDFRadioGroup) {
    info.options = field.getOptions();
    info.value = field.getSelected() ?? null;
  } else if (field instanceof PDFDropdown) {
    info.options = field.getOptions();
    info.multiselect = field.isMultiselect();
    info.editable = field.isEditable();
    const selected = field.getSelected();
    info.value = info.multiselect ? selected : (selected[0] ?? null);
  } else if (field instanceof PDFOptionList) {
    info.options = field.getOptions();
    info.multiselect = field.isMultiselect();
    info.value = field.getSelected();
  }
  return info;
}

function pageIndex(doc: PDFDocument): Map<string, number> {
  return new Map(doc.getPages().map((page, index) => [page.ref.toString(), index + 1]));
}

/** True when the document has an AcroForm with at least one field. */
function formFields(doc: PDFDocument): PDFField[] {
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) return [];
  return doc.getForm().getFields();
}

/** fields: every field of the form with its type, options and current value. Charged 0 units. */
export async function fields(pdf: Uint8Array): Promise<{ fields: FieldInfo[]; pages: number }> {
  assertTotalBytes([pdf]);
  const doc = await loadPdf(pdf, fileLabel(0));
  const pageOf = pageIndex(doc);
  return { fields: formFields(doc).map((field) => describe(doc, field, pageOf)), pages: doc.getPageCount() };
}

const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

function asBoolean(name: string, value: FillValue): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null) return false;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  throw invalid(`values["${name}"] is a checkbox: use true or false.`);
}

function asText(name: string, value: FillValue, font: PDFFont, field: PDFTextField): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw invalid(`values["${name}"] is a text field: use a string.`);
  if (codePointLength(value) > PDF.maxDataValueChars) throw invalid(`values["${name}"] may be at most ${PDF.maxDataValueChars} characters.`);
  const max = field.getMaxLength();
  if (max !== undefined && codePointLength(value) > max) throw invalid(`values["${name}"] is ${codePointLength(value)} characters; this field takes at most ${max}.`);
  const multiline = field.isMultiline();
  const lines = multiline ? value.split(/\r\n|\r|\n/) : [value];
  for (const line of lines) assertDrawable(font, line, `values["${name}"]`);
  return multiline ? lines.join('\n') : value;
}

function asChoices(name: string, value: FillValue, options: string[], multi: boolean, editable: boolean): string[] {
  if (value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((item) => typeof item === 'string')) throw invalid(`values["${name}"] must be one of the field's options${multi ? ', or a list of them' : ''}.`);
  if (list.length > 1 && !multi) throw invalid(`values["${name}"] allows one option, not a list.`);
  if (!editable) {
    const unknown = list.find((item) => !options.includes(item));
    if (unknown !== undefined) {
      throw invalid(`values["${name}"]: "${unknown}" is not one of the options: ${options.map((o) => `"${o}"`).join(', ')}.`, { field: name, options });
    }
  }
  return list;
}

function unknownField(name: string, names: string[]): ApiError {
  const shown = names.slice(0, NAMES_IN_MESSAGE).map((n) => `"${n}"`).join(', ');
  const more = names.length > NAMES_IN_MESSAGE ? ` and ${names.length - NAMES_IN_MESSAGE} more (POST /v1/pdf-tools/fields lists them all)` : '';
  return invalid(
    names.length === 0 ? `values["${name}"]: this PDF has no form fields.` : `values["${name}"]: there is no field with that name. The fields are: ${shown}${more}.`,
    { field: name, valid_fields: names },
  );
}

type Apply = () => void;

/** Checks one entry and returns the change to make; nothing is changed until every entry passed. */
function plan(name: string, value: FillValue, field: PDFField, font: PDFFont): Apply {
  if (field instanceof PDFTextField) {
    const text = asText(name, value, font, field);
    return () => field.setText(text === '' ? undefined : text);
  }
  if (field instanceof PDFCheckBox) {
    const on = asBoolean(name, value);
    return () => (on ? field.check() : field.uncheck());
  }
  if (field instanceof PDFRadioGroup) {
    const [choice] = asChoices(name, value, field.getOptions(), false, false);
    return () => (choice === undefined ? field.clear() : field.select(choice));
  }
  if (field instanceof PDFDropdown) {
    const editable = field.isEditable();
    const choices = asChoices(name, value, field.getOptions(), field.isMultiselect(), editable);
    if (editable) for (const choice of choices) assertDrawable(font, choice, `values["${name}"]`);
    return () => (choices.length === 0 ? field.clear() : field.select(choices.length === 1 ? choices[0]! : choices));
  }
  if (field instanceof PDFOptionList) {
    const choices = asChoices(name, value, field.getOptions(), field.isMultiselect(), false);
    return () => (choices.length === 0 ? field.clear() : field.select(choices));
  }
  throw invalid(`values["${name}"] is a ${typeOf(field).replace('_', ' ')} field, which cannot be filled.`, { field: name, type: typeOf(field) });
}

/** fill: sets fields by name (and flattens the form when asked). */
export async function fill(pdf: Uint8Array, options: FillOptions): Promise<PdfOutput> {
  const values = options.values;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw invalid('"values" must be an object of field names and values.');
  const entries = Object.entries(values);
  if (entries.length === 0 && options.flatten !== true) throw invalid('"values" is empty: name at least one field to fill (or set "flatten" to true).');

  assertTotalBytes([pdf]);
  const doc = await loadPdf(pdf, fileLabel(0));
  const all = formFields(doc);
  if (all.length === 0) throw invalid(`${fileLabel(0)} has no form fields to fill.`, { valid_fields: [] });
  const byName = new Map(all.map((field) => [field.getName(), field]));
  const names = [...byName.keys()];
  const form = doc.getForm();
  const font = form.getDefaultFont();

  const changes = entries.map(([name, value]) => {
    const field = byName.get(name);
    if (!field) throw unknownField(name, names);
    return plan(name, value, field, font);
  });
  for (const apply of changes) apply();

  if (options.flatten === true) form.flatten({ updateFieldAppearances: true });
  return finish(doc, options, { forms: true });
}
