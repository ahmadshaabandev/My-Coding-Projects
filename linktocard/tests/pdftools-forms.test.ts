// fields and fill (src/pdftools/forms.ts) on the AcroForm fixture: listing, filling by name,
// flattening, and the errors a caller sees for a wrong name or value.
import { PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFRawStream, PDFTextField, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDF, pdfToolkitUnits } from '../src/config';
import { fields, fill } from '../src/pdftools';
import { expectApiError, fixture, hexText, latin1, pageContent, reload } from './pdftools-helpers';

const NAMES = ['full_name', 'email', 'zip', 'notes', 'subscribe', 'terms', 'plan', 'country', 'topics', 'reset'];

/** Every stream of the file decoded and joined: flattened values live in appearance XObjects. */
async function allStreams(bytes: Uint8Array): Promise<string> {
  const doc = await reload(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .map(([, object]) => (object instanceof PDFRawStream ? latin1(decodePDFRawStream(object).decode()) : ''))
    .join('\n');
}

describe('fields', () => {
  it('lists every field with its type, value, options and flags', async () => {
    const result = await fields(fixture('form.pdf'));
    expect(result.pages).toBe(1);
    expect(result.fields).toEqual([
      { name: 'full_name', type: 'text', value: '', required: false, read_only: false, pages: [1], multiline: false },
      { name: 'email', type: 'text', value: 'someone@example.com', required: false, read_only: false, pages: [1], multiline: false },
      { name: 'zip', type: 'text', value: '', required: false, read_only: false, pages: [1], max_length: 5, multiline: false },
      { name: 'notes', type: 'text', value: '', required: false, read_only: false, pages: [1], multiline: true },
      { name: 'subscribe', type: 'checkbox', value: false, required: false, read_only: false, pages: [1] },
      { name: 'terms', type: 'checkbox', value: true, required: false, read_only: false, pages: [1] },
      { name: 'plan', type: 'radio', value: 'free', options: ['free', 'starter', 'pro'], required: false, read_only: false, pages: [1] },
      { name: 'country', type: 'dropdown', value: null, options: ['Lebanon', 'France', 'Japan'], multiselect: false, editable: false, required: false, read_only: false, pages: [1] },
      { name: 'topics', type: 'option_list', value: [], options: ['cards', 'pdfs', 'email'], multiselect: true, required: false, read_only: false, pages: [1] },
      { name: 'reset', type: 'button', value: null, required: false, read_only: false, pages: [1] },
    ]);
    expect(pdfToolkitUnits('fields', result.pages)).toBe(0);
  });

  it('lists nothing for a PDF without a form, and refuses XFA', async () => {
    expect((await fields(fixture('multi-page.pdf'))).fields).toEqual([]);
    await expectApiError(fields(fixture('xfa.pdf')), 'invalid_request', /XFA form/);
  });
});

describe('fill', () => {
  it('fills text, checkbox, radio, dropdown and option list fields by name', async () => {
    const out = await fill(fixture('form.pdf'), {
      values: { full_name: 'Ahmad Example', zip: '12345', notes: 'line one\r\nline two', subscribe: 'yes', terms: false, plan: 'pro', country: 'France', topics: ['cards', 'email'] },
    });
    expect(out.pages).toBe(1);
    const form = (await reload(out.bytes)).getForm();
    expect(form.getField('full_name')).toBeInstanceOf(PDFTextField);
    expect(form.getTextField('full_name').getText()).toBe('Ahmad Example');
    expect(form.getTextField('zip').getText()).toBe('12345');
    expect(form.getTextField('notes').getText()).toBe('line one\nline two');
    expect(form.getTextField('email').getText()).toBe('someone@example.com');
    expect((form.getField('subscribe') as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField('terms') as PDFCheckBox).isChecked()).toBe(false);
    expect((form.getField('plan') as PDFRadioGroup).getSelected()).toBe('pro');
    expect((form.getField('country') as PDFDropdown).getSelected()).toEqual(['France']);
    expect((form.getField('topics') as PDFOptionList).getSelected()).toEqual(['cards', 'email']);
    // The filled value is drawn in the field's new appearance, so every reader shows it.
    expect(await allStreams(out.bytes)).toContain(hexText('Ahmad Example'));
  });

  it('accepts the words connectors send for checkboxes, and null to clear', async () => {
    const out = await fill(fixture('form.pdf'), { values: { subscribe: 'ON', terms: 'off', email: null, plan: null } });
    const form = (await reload(out.bytes)).getForm();
    expect((form.getField('subscribe') as PDFCheckBox).isChecked()).toBe(true);
    expect((form.getField('terms') as PDFCheckBox).isChecked()).toBe(false);
    expect(form.getTextField('email').getText()).toBeUndefined();
    expect((form.getField('plan') as PDFRadioGroup).getSelected()).toBeUndefined();
  });

  it('flattens: the values become page content and the fields are gone', async () => {
    const out = await fill(fixture('form.pdf'), { values: { full_name: 'Flat Name' }, flatten: true });
    const doc = await reload(out.bytes);
    expect(doc.getForm().getFields()).toHaveLength(0);
    expect(await allStreams(out.bytes)).toContain(hexText('Flat Name'));
    expect((await fields(out.bytes)).fields).toEqual([]);
  });

  it('flattens without new values', async () => {
    const out = await fill(fixture('form.pdf'), { values: {}, flatten: true });
    expect((await reload(out.bytes)).getForm().getFields()).toHaveLength(0);
  });

  it('adds the free mark when asked', async () => {
    const out = await fill(fixture('form.pdf'), { values: { full_name: 'A' }, freeMark: true });
    expect(pageContent(await reload(out.bytes), 0)).toContain(hexText(PDF.freeMark));
  });

  it('names the unknown field and lists the valid ones', async () => {
    const error = await expectApiError(fill(fixture('form.pdf'), { values: { full_name: 'ok', fullname: 'x' } }), 'invalid_request', /values\["fullname"\]: there is no field with that name\. The fields are: "full_name", "email"/);
    expect(error.details).toEqual({ field: 'fullname', valid_fields: NAMES });
    await expectApiError(fill(fixture('multi-page.pdf'), { values: { a: 'b' } }), 'invalid_request', /has no form fields/);
  });

  it('refuses a value of the wrong kind, naming the field', async () => {
    const pdf = fixture('form.pdf');
    const radio = await expectApiError(fill(pdf, { values: { plan: 'gold' } }), 'invalid_request', /values\["plan"\]: "gold" is not one of the options: "free", "starter", "pro"/);
    expect(radio.details).toEqual({ field: 'plan', options: ['free', 'starter', 'pro'] });
    await expectApiError(fill(pdf, { values: { country: 'Mars' } }), 'invalid_request', /"Mars" is not one of the options/);
    await expectApiError(fill(pdf, { values: { country: ['France', 'Japan'] } }), 'invalid_request', /allows one option, not a list/);
    await expectApiError(fill(pdf, { values: { topics: ['cards', 7 as never] } }), 'invalid_request', /must be one of the field's options/);
    await expectApiError(fill(pdf, { values: { subscribe: 'maybe' } }), 'invalid_request', /values\["subscribe"\] is a checkbox: use true or false/);
    await expectApiError(fill(pdf, { values: { full_name: 42 as never } }), 'invalid_request', /is a text field: use a string/);
    await expectApiError(fill(pdf, { values: { zip: '1234567' } }), 'invalid_request', /values\["zip"\] is 7 characters; this field takes at most 5/);
    await expectApiError(fill(pdf, { values: { full_name: 'two\nlines' } }), 'invalid_request', /single line/);
    await expectApiError(fill(pdf, { values: { full_name: 'x'.repeat(PDF.maxDataValueChars + 1) } }), 'invalid_request', /at most 2000 characters/);
    await expectApiError(fill(pdf, { values: { full_name: 'أحمد' } }), 'invalid_request', /U\+0623.*Windows-1252/);
    const button = await expectApiError(fill(pdf, { values: { reset: 'x' } }), 'invalid_request', /is a button field, which cannot be filled/);
    expect(button.details).toEqual({ field: 'reset', type: 'button' });
  });

  it('checks every entry before changing anything: one bad entry fails the request', async () => {
    await expectApiError(fill(fixture('form.pdf'), { values: { full_name: 'fine', subscribe: true, plan: 'gold' } }), 'invalid_request', /"gold"/);
  });

  it('refuses a missing or malformed values object, and XFA forms', async () => {
    await expectApiError(fill(fixture('form.pdf'), { values: {} }), 'invalid_request', /"values" is empty/);
    await expectApiError(fill(fixture('form.pdf'), { values: [] as never }), 'invalid_request', /must be an object/);
    await expectApiError(fill(fixture('form.pdf'), { values: null as never }), 'invalid_request', /must be an object/);
    await expectApiError(fill(fixture('xfa.pdf'), { values: { name: 'x' } }), 'invalid_request', /XFA form/);
  });
});
