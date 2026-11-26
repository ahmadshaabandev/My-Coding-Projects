// The dashboard's Bulk tab: its pure rules (site/public/assets/js/dashboard/bulk-helpers.js)
// and what can be checked about the screen statically (site/public/assets/js/dashboard/bulk.js).
// The screen itself is exercised in a real browser against `wrangler dev`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDF } from '../../src/config';
import { PDF_TEMPLATES } from '../../src/pdf/templates';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JS = join(ROOT, 'site/public/assets/js');
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(JS, name)).href)) as T;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

type Field = { key: string; label: string; kind: 'text' | 'items'; required: boolean; itemFields: string[] };
type Target = { id: string; key: string; kind: 'text' | 'items' | 'item'; label: string; required: boolean; item?: string };
type Mapping = Record<string, number>;
type Data = Record<string, unknown>;
type Parsed = { headers: string[]; rows: string[][]; rowNumbers: number[] };
type Row = { index?: number; status?: string; error?: unknown; certificate_id?: string };
type Batch = { status?: string; total?: number; counts?: Record<string, number>; rows?: Row[] };
type Progress = { total: number; done: number; failed: number; cancelled: number; pending: number; percent: number; finished: boolean };
type PreviewTemplate = { id: string; starter: boolean; html?: string; css?: string; default_pdf?: { format: string; landscape: boolean } | null };

interface Bulk {
  VERIFICATION_KEYS: string[];
  LIST_KEY: string;
  TOOL_STARTERS: string[];
  FINISHED_STATUSES: string[];
  starterFields(template: { fields: Array<Record<string, unknown>> }): Field[];
  pdfTemplateFields(html: string): Field[];
  printsVerification(fields: Array<{ key: string }>): boolean;
  mappingTargets(fields: Field[], options?: { verify?: boolean }): Target[];
  normaliseName(text: string): string;
  autoMatch(headers: string[], targets: Target[], keep?: Mapping): Mapping;
  columnName(headers: string[], index: number): string;
  mappingProblems(targets: Target[], mapping: Mapping): string[];
  rowData(cells: string[], mapping: Mapping, targets: Target[], options?: { maxValueChars?: number }): { data: Data; problems: string[] };
  buildRows(parsed: Parsed, mapping: Mapping, targets: Target[], options?: { maxValueChars?: number; maxProblems?: number }): { rows: Data[]; problems: string[]; problemCount: number };
  explainRowIndex(message: string, rowNumbers: number[]): string;
  batchRequest(input: { template: string; rows: Data[]; verify?: boolean; format?: string; landscape?: boolean; filename?: string }): Record<string, unknown>;
  previewRequest(template: PreviewTemplate, data: Data, options?: { format?: string; landscape?: boolean }): Record<string, unknown>;
  requestBytes(body: unknown): number;
  batchProgress(batch: Batch): Progress;
  progressText(progress: Progress): string;
  batchStatusView(status: string): { label: string; tone: string };
  rowStatusView(status: string): { label: string; tone: string };
  rowErrorText(row: Row): string;
  ranOutOfImages(batch: Batch): boolean;
  pollDelay(elapsedMs: number, total: number): number;
  minimumImages(documents: number, unitsPerDocument: number): number;
  rememberBatch(list: unknown, entry: { id: string }, max?: number): Array<{ id: string }>;
  fileSizeProblem(bytes: number, maxBytes: number): string | null;
  paperLabel(format: string): string;
}

const bulk = await load<Bulk>('dashboard/bulk-helpers.js');
// The PDF engine's own validator. Loaded by URL so the Node typecheck does not follow it into
// src/types.ts, whose Workers types this project does not load; Vitest runs it as it is.
const { validatePdfData } = (await import(pathToFileURL(join(ROOT, 'src/pdf/template.ts')).href)) as { validatePdfData(input: unknown): unknown };
const { parseCsv } = await load<{ parseCsv(text: string): Parsed & { problems: string[] } }>('dashboard/csv.js');

const certificate = PDF_TEMPLATES.find((template) => template.id === 'certificate')!;
const invoice = PDF_TEMPLATES.find((template) => template.id === 'invoice')!;
/** A starter as GET /api/batches/templates sends it (see the integration notes). */
const asJson = (template: (typeof PDF_TEMPLATES)[number]) => ({
  id: template.id,
  name: template.name,
  fields: template.fields.map((field) => ({ key: field.key, label: field.label, kind: field.kind, required: field.required, ...(field.itemFields ? { item_fields: field.itemFields } : {}) })),
});
const certificateFields = bulk.starterFields(asJson(certificate));
const invoiceFields = bulk.starterFields(asJson(invoice));

describe('template fields', () => {
  it('takes a starter\'s fields as the API sends them', () => {
    expect(certificateFields[0]).toEqual({ key: 'title', label: 'Title', kind: 'text', required: true, itemFields: [] });
    expect(invoiceFields.find((field) => field.key === 'items')).toEqual({
      key: 'items',
      label: 'Line items',
      kind: 'items',
      required: true,
      itemFields: ['description', 'quantity', 'unit_price', 'amount'],
    });
    expect(bulk.starterFields({ fields: [{ key: 'po_number', kind: 'text' }] })).toEqual([{ key: 'po_number', label: 'Po number', kind: 'text', required: false, itemFields: [] }]);
  });

  it('reads an own template\'s fields from its HTML: placeholders, sections and the items loop', () => {
    const html = [
      '<h1>{{ title }}</h1>{{#logo_url}}<img src="{{logo_url}}">{{/logo_url}}',
      '<table>{{#items}}<tr><td>{{description}}</td><td>{{amount}} {{currency}}</td></tr>{{/items}}{{^items}}<p>None</p>{{/items}}</table>',
      '<p>{{currency}} {{^notes}}No notes{{/notes}} {{Bad}} {{ 9x }}</p>',
    ].join('');
    expect(bulk.pdfTemplateFields(html)).toEqual([
      { key: 'title', label: 'Title', kind: 'text', required: false, itemFields: [] },
      { key: 'logo_url', label: 'Logo url', kind: 'text', required: false, itemFields: [] },
      { key: 'currency', label: 'Currency', kind: 'text', required: false, itemFields: [] },
      { key: 'notes', label: 'Notes', kind: 'text', required: false, itemFields: [] },
      // currency is used outside the loop too, so it is a document field, not a line-item field.
      { key: 'items', label: 'Line items', kind: 'items', required: false, itemFields: ['description', 'amount'] },
    ]);
    expect(bulk.pdfTemplateFields('<p>No placeholders</p>')).toEqual([]);
    expect(bulk.pdfTemplateFields('{{^items}}Nothing yet{{/items}}')).toEqual([{ key: 'items', label: 'Line items', kind: 'items', required: false, itemFields: [] }]);
  });

  it('finds exactly the fields each PDF starter declares in its own HTML (the same syntax as the engine)', () => {
    for (const template of PDF_TEMPLATES) {
      const detected = bulk.pdfTemplateFields(template.html);
      expect(detected.map((field) => field.key).sort(), template.id).toEqual(template.fields.map((field) => field.key).sort());
      const list = template.fields.find((field) => field.kind === 'items');
      if (list) expect(detected.find((field) => field.kind === 'items')?.itemFields, template.id).toEqual(list.itemFields);
    }
  });

  it('knows whether a template prints the verification details', () => {
    expect(bulk.printsVerification(certificateFields)).toBe(true);
    expect(bulk.printsVerification(invoiceFields)).toBe(false);
    expect(bulk.printsVerification(bulk.pdfTemplateFields('<img src="{{verify_qr}}">'))).toBe(true);
  });
});

describe('matching columns to fields', () => {
  it('offers the list as a JSON column and as one column per line-item field', () => {
    const targets = bulk.mappingTargets(invoiceFields);
    expect(targets.filter((target) => target.key === 'items').map((target) => [target.id, target.kind, target.label])).toEqual([
      ['items', 'items', 'Line items (a JSON list)'],
      ['items.description', 'item', 'Line items: description'],
      ['items.quantity', 'item', 'Line items: quantity'],
      ['items.unit_price', 'item', 'Line items: unit price'],
      ['items.amount', 'item', 'Line items: amount'],
    ]);
  });

  it('leaves the verification keys out when Link To Card fills them in', () => {
    const fields = [...certificateFields, { key: 'verify_url', label: 'Verify url', kind: 'text' as const, required: false, itemFields: [] }];
    expect(bulk.mappingTargets(fields).map((target) => target.id)).toContain('certificate_id');
    const verified = bulk.mappingTargets(fields, { verify: true }).map((target) => target.id);
    for (const key of bulk.VERIFICATION_KEYS) expect(verified).not.toContain(key);
    expect(verified).toContain('recipient_name');
  });

  it('normalises names: case, spaces, punctuation and accents', () => {
    expect(bulk.normaliseName('  Recipient Name ')).toBe('recipient_name');
    expect(bulk.normaliseName('Prénom / Nom')).toBe('prenom_nom');
    expect(bulk.normaliseName('E-mail')).toBe('e_mail');
    expect(bulk.normaliseName('Unit price (USD)')).toBe('unit_price_usd');
    expect(bulk.normaliseName('')).toBe('');
  });

  it('matches columns by key, by label and ignoring underscores, each column once', () => {
    const targets = bulk.mappingTargets(certificateFields);
    const headers = ['RecipientName', 'Issuer Name', 'achievement', 'title', 'Date', 'Email', 'TITLE'];
    expect(bulk.autoMatch(headers, targets)).toEqual({ recipient_name: 0, issuer_name: 1, achievement: 2, title: 3, date: 4 });
  });

  it('fills document fields before line-item fields, and reads common line-item column names', () => {
    const fields: Field[] = [
      { key: 'description', label: 'Description', kind: 'text', required: false, itemFields: [] },
      { key: 'items', label: 'Line items', kind: 'items', required: true, itemFields: ['description', 'amount'] },
    ];
    expect(bulk.autoMatch(['Description', 'Item description', 'Line amount', 'Items'], bulk.mappingTargets(fields))).toEqual({
      description: 0,
      'items.description': 1,
      'items.amount': 2,
      items: 3,
    });
  });

  it('keeps choices already made and matches only what they leave open', () => {
    const targets = bulk.mappingTargets(certificateFields);
    const headers = ['name', 'recipient_name', 'date'];
    expect(bulk.autoMatch(headers, targets, { recipient_name: 0 })).toEqual({ recipient_name: 0, date: 2 });
    // A choice for a target that no longer exists, or a column that is not there, is dropped.
    expect(bulk.autoMatch(headers, targets, { gone: 1, title: 9 })).toEqual({ recipient_name: 1, date: 2 });
  });

  it('names columns with their spreadsheet letter', () => {
    expect(bulk.columnName(['Name', '', 'City'], 0)).toBe('Name (column A)');
    expect(bulk.columnName(['Name', '', 'City'], 1)).toBe('Column B (no name)');
  });

  it('says what the mapping still lacks', () => {
    const targets = bulk.mappingTargets(certificateFields);
    const all = { title: 0, recipient_name: 1, achievement: 2, issuer_name: 3, date: 4 };
    expect(bulk.mappingProblems(targets, all)).toEqual([]);
    expect(bulk.mappingProblems(targets, { ...all, date: undefined as unknown as number })).toEqual(['Choose the column for Date: the template needs it.']);
    const invoiceTargets = bulk.mappingTargets(invoiceFields);
    const invoiceAll = { seller_name: 0, buyer_name: 1, invoice_number: 2, issue_date: 3, total: 4 };
    expect(bulk.mappingProblems(invoiceTargets, invoiceAll)).toEqual([
      'Choose a column for the line items: the template needs at least one line. Use a column with a JSON list, or one column per line-item field.',
    ]);
    expect(bulk.mappingProblems(invoiceTargets, { ...invoiceAll, 'items.amount': 5 })).toEqual([]);
    const own = bulk.mappingTargets(bulk.pdfTemplateFields('{{a}}'));
    expect(bulk.mappingProblems(own, {})).toEqual(['Match at least one column to a template field.']);
    expect(bulk.mappingProblems([], {})).toEqual(['This template has no {{placeholders}}, so every document would be the same. Choose another template.']);
  });
});

describe('rows', () => {
  const targets = bulk.mappingTargets(certificateFields);
  const mapping = { recipient_name: 0, achievement: 1, title: 2, issuer_name: 3, date: 4 };

  it('sends only matched columns, trimmed, and leaves empty values out', () => {
    const cells = ['  Amara Nwosu ', 'for the workshop', 'Certificate', 'Lanternworks', '2026-11-25', 'amara@example.com', 'secret note'];
    expect(bulk.rowData(cells, { ...mapping, signer_name: 7 }, targets)).toEqual({
      data: { recipient_name: 'Amara Nwosu', achievement: 'for the workshop', title: 'Certificate', issuer_name: 'Lanternworks', date: '2026-11-25' },
      problems: [],
    });
    const { data } = bulk.rowData(cells, mapping, targets);
    expect(JSON.stringify(data)).not.toContain('example.com');
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('flags required fields that are empty, values that are too long, and rows with nothing in them', () => {
    expect(bulk.rowData(['Amara', '', 'T', 'I', 'D'], mapping, targets).problems).toEqual(['Achievement is empty.']);
    expect(bulk.rowData(['Zoë', 'x', 'T', 'I', 'D'], mapping, targets, { maxValueChars: 3 }).problems).toEqual([]);
    expect(bulk.rowData(['Amara', 'four', 'T', 'I', 'D'], mapping, targets, { maxValueChars: 3 }).problems).toEqual(['Recipient name is longer than 3 characters.', 'Achievement is longer than 3 characters.']);
    const own = bulk.mappingTargets(bulk.pdfTemplateFields('{{a}}{{b}}'));
    expect(bulk.rowData(['', ' '], { a: 0, b: 1 }, own).problems).toEqual(['Every matched column is empty.']);
  });

  it('counts characters, not UTF-16 units, as the server does', () => {
    const own = bulk.mappingTargets(bulk.pdfTemplateFields('{{a}}'));
    expect(bulk.rowData(['😀😀😀'], { a: 0 }, own, { maxValueChars: 3 }).problems).toEqual([]);
    expect(bulk.rowData(['😀😀😀😀'], { a: 0 }, own, { maxValueChars: 3 }).problems).toHaveLength(1);
  });

  it('reads the list from a JSON column, or makes one line from line-item columns', () => {
    const invoiceTargets = bulk.mappingTargets(invoiceFields);
    const json = '[{"description":"Design","amount":"1,200.00"},{"description":"Hosting","quantity":2,"amount":"40.00"}]';
    expect(bulk.rowData([json], { items: 0 }, invoiceTargets).data).toEqual({
      items: [
        { description: 'Design', amount: '1,200.00' },
        { description: 'Hosting', quantity: 2, amount: '40.00' },
      ],
    });
    expect(bulk.rowData(['Retainer', '', '900.00'], { 'items.description': 0, 'items.quantity': 1, 'items.amount': 2 }, invoiceTargets).data).toEqual({
      items: [{ description: 'Retainer', amount: '900.00' }],
    });
    // A JSON list in its own column wins over the line-item columns.
    expect(bulk.rowData([json, 'Ignored'], { items: 0, 'items.description': 1 }, invoiceTargets).data.items).toHaveLength(2);
  });

  it('explains a list that is not valid, and a required list that is empty', () => {
    const invoiceTargets = bulk.mappingTargets(invoiceFields);
    expect(bulk.rowData(['[{"description": "Design",}]'], { items: 0 }, invoiceTargets).problems).toEqual([
      'Line items (a JSON list) is not valid JSON. Write it as [{"description": "Design", "amount": "1,200.00"}].',
    ]);
    expect(bulk.rowData(['{"description":"Design"}'], { items: 0 }, invoiceTargets).problems).toEqual(['Line items (a JSON list) must be a JSON list of objects with text or number values.']);
    expect(bulk.rowData(['[{"description":{"nested":true}}]'], { items: 0 }, invoiceTargets).problems).toHaveLength(1);
    expect(bulk.rowData([''], { items: 0 }, invoiceTargets).problems).toEqual(['The line items are empty.']);
    expect(bulk.rowData(['[]'], { items: 0 }, invoiceTargets).problems).toEqual(['The line items are empty.']);
  });

  it('builds every row and names problems by spreadsheet row, the first few only', () => {
    const parsed = parseCsv('recipient_name,achievement,title,issuer_name,date\nAmara,x,T,I,D\n\nBo,,T,I,D\nCy,,T,I,D\nDi,,T,I,D\n');
    const built = bulk.buildRows(parsed, bulk.autoMatch(parsed.headers, targets), targets, { maxProblems: 2 });
    expect(built.rows).toHaveLength(4);
    expect(built.rows[0]).toEqual({ recipient_name: 'Amara', achievement: 'x', title: 'T', issuer_name: 'I', date: 'D' });
    expect(built.problems).toEqual(['Row 4: Achievement is empty.', 'Row 5: Achievement is empty.']);
    expect(built.problemCount).toBe(3);
  });

  it('builds rows the PDF engine accepts as they are', () => {
    const parsed = parseCsv(
      [
        'Seller name,Buyer name,Invoice number,Issue date,Total,Item description,Item quantity,Item amount,Notes',
        'Fernhill Studio,"Okafor & Lund",INV-1,2026-11-25,"1,200.00",Design,1,"1,200.00","Two lines:\r\nthanks"',
      ].join('\r\n'),
    );
    const targets = bulk.mappingTargets(invoiceFields);
    const built = bulk.buildRows(parsed, bulk.autoMatch(parsed.headers, targets), targets, { maxValueChars: PDF.maxDataValueChars });
    expect(built.problems).toEqual([]);
    expect(validatePdfData(built.rows[0])).toEqual({
      seller_name: 'Fernhill Studio',
      buyer_name: 'Okafor & Lund',
      invoice_number: 'INV-1',
      issue_date: '2026-11-25',
      total: '1,200.00',
      notes: 'Two lines:\nthanks',
      items: [{ description: 'Design', quantity: '1', amount: '1,200.00' }],
    });
  });

  it('points an API error about rows[n] at the spreadsheet row', () => {
    expect(bulk.explainRowIndex('rows[1]: "items" may have at most 200 entries.', [2, 4])).toBe('rows[1] (row 4 of the file): "items" may have at most 200 entries.');
    expect(bulk.explainRowIndex('rows[7] is bad', [2])).toBe('rows[7] is bad');
    expect(bulk.explainRowIndex('Nothing to say', [2])).toBe('Nothing to say');
  });
});

describe('requests', () => {
  it('builds POST /api/batches: rows as data, verify always, page and file name only when chosen', () => {
    const rows = [{ recipient_name: 'Amara' }];
    expect(bulk.batchRequest({ template: 'certificate', rows, verify: true })).toEqual({ template: 'certificate', rows, verify: true });
    expect(bulk.batchRequest({ template: 't_1', rows, format: 'letter', landscape: false, filename: '  {{recipient_name}}-{{n}}.pdf ' })).toEqual({
      template: 't_1',
      rows,
      verify: false,
      pdf: { format: 'letter', landscape: false },
      filename: '{{recipient_name}}-{{n}}.pdf',
    });
    expect(bulk.batchRequest({ template: 'invoice', rows, format: '', filename: '' })).toEqual({ template: 'invoice', rows, verify: false });
  });

  it('previews the invoice and certificate starters by id, without verification fields', () => {
    const data = { recipient_name: 'Amara', certificate_id: 'crt_x', verify_url: 'https://x', verify_qr: 'data:image/svg+xml,x' };
    expect(bulk.previewRequest({ id: 'certificate', starter: true, html: '<p>ignored</p>' }, data)).toEqual({ tool: 'certificate', data: { recipient_name: 'Amara' } });
    expect(bulk.previewRequest({ id: 'invoice', starter: true }, { total: '5' }, { format: 'letter' })).toEqual({ tool: 'invoice', data: { total: '5' }, pdf: { format: 'letter' } });
  });

  it('previews other starters and own templates through html-to-pdf, on the template\'s own paper unless another is chosen', () => {
    const receipt = { id: 'receipt', starter: true, html: '<h1>{{seller_name}}</h1>', css: 'h1{color:red}', default_pdf: { format: 'a4', landscape: false } };
    expect(bulk.previewRequest(receipt, { seller_name: 'Fernhill' })).toEqual({
      tool: 'html-to-pdf',
      html: '<h1>{{seller_name}}</h1>',
      css: 'h1{color:red}',
      data: { seller_name: 'Fernhill' },
      pdf: { format: 'a4', landscape: false },
    });
    expect(bulk.previewRequest(receipt, {}, { format: 'a5', landscape: true }).pdf).toEqual({ format: 'a5', landscape: true });
    expect(bulk.previewRequest({ id: 't_9', starter: false, html: '<p>{{a}}</p>', css: '  ', default_pdf: null }, { a: '1' })).toEqual({ tool: 'html-to-pdf', html: '<p>{{a}}</p>', data: { a: '1' } });
  });

  it('only sends what the free tool accepts (src/pdf/input.ts)', () => {
    const source = read('src/pdf/input.ts');
    const list = (name: string): string[] => [...(new RegExp(`export const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(source)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const pageList = (name: string): string[] => [...(new RegExp(`const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(source)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const tools = list('TOOLS');
    const fields = list('TOOL_FIELDS');
    const page = pageList('TOOL_PAGE_FIELDS');
    expect(tools).toEqual(expect.arrayContaining([...bulk.TOOL_STARTERS, 'html-to-pdf']));
    const bodies = [
      bulk.previewRequest({ id: 'certificate', starter: true }, { a: '1' }, { format: 'a4', landscape: true }),
      bulk.previewRequest({ id: 'report', starter: true, html: '<p></p>', css: 'p{}', default_pdf: { format: 'a4', landscape: false } }, { a: '1' }),
    ];
    for (const body of bodies) {
      for (const key of Object.keys(body)) expect(fields).toContain(key);
      for (const key of Object.keys((body.pdf as object) ?? {})) expect(page).toContain(key);
    }
  });

  it('measures a body in UTF-8 bytes', () => {
    expect(bulk.requestBytes({ a: 'é' })).toBe(JSON.stringify({ a: 'é' }).length + 1);
  });

  it('refuses a file larger than one batch can send, before reading it', () => {
    expect(bulk.fileSizeProblem(1024, 4 * 1024 * 1024)).toBeNull();
    expect(bulk.fileSizeProblem(5 * 1024 * 1024, 4 * 1024 * 1024)).toBe('This file is 5 MB. One batch can send at most 4 MB: split the spreadsheet into smaller files.');
    expect(bulk.fileSizeProblem(5 * 1024 * 1024, 0)).toBeNull();
  });
});

describe('progress', () => {
  it('counts from the server\'s counts, or from the rows', () => {
    const rows = [{ status: 'done' }, { status: 'done' }, { status: 'failed' }, { status: 'queued' }, { status: 'running' }];
    expect(bulk.batchProgress({ status: 'running', total: 5, rows })).toEqual({ total: 5, done: 2, failed: 1, cancelled: 0, pending: 2, percent: 60, finished: false });
    expect(bulk.batchProgress({ status: 'running', total: 120, counts: { done: 37, failed: 2, cancelled: 0 }, rows: [] })).toMatchObject({ done: 37, failed: 2, pending: 81, percent: 32 });
    expect(bulk.batchProgress({ status: 'partial', total: 3, rows: [{ status: 'done' }, { status: 'failed' }, { status: 'failed' }] })).toMatchObject({ percent: 100, finished: true });
    // 999 of 1,000 is not "100%".
    expect(bulk.batchProgress({ status: 'running', total: 1000, counts: { done: 999 } }).percent).toBe(99);
    expect(bulk.batchProgress({ status: 'done', total: 0, rows: [] }).percent).toBe(100);
    expect(bulk.batchProgress({}).finished).toBe(false);
  });

  it('reads the progress in words', () => {
    expect(bulk.progressText(bulk.batchProgress({ status: 'running', total: 120, counts: { done: 37, failed: 2 } }))).toBe('37 of 120 documents made, 2 failed, 81 waiting.');
    expect(bulk.progressText(bulk.batchProgress({ status: 'done', total: 1, counts: { done: 1 } }))).toBe('1 of 1 document made.');
    expect(bulk.progressText(bulk.batchProgress({ status: 'cancelled', total: 4, counts: { done: 1, cancelled: 2 } }))).toBe('1 of 4 documents made, 2 cancelled, 1 not made.');
  });

  it('labels every status, and passes an unknown one through', () => {
    for (const status of ['queued', 'running', ...bulk.FINISHED_STATUSES]) expect(bulk.batchStatusView(status).label).not.toBe(status);
    expect(bulk.batchStatusView('partial')).toEqual({ label: 'Finished, some failed', tone: 'warn' });
    expect(bulk.rowStatusView('failed')).toEqual({ label: 'Failed', tone: 'danger' });
    expect(bulk.rowStatusView('paused')).toEqual({ label: 'paused', tone: '' });
    expect(bulk.FINISHED_STATUSES).toEqual(['done', 'partial', 'failed', 'cancelled']);
  });

  it('reads a row\'s error as a string or as { code, message }', () => {
    expect(bulk.rowErrorText({})).toBe('');
    expect(bulk.rowErrorText({ error: 'Too many pages.' })).toBe('Too many pages.');
    expect(bulk.rowErrorText({ error: { code: 'quota_exceeded', message: 'No images left.' } })).toBe('No images left.');
    expect(bulk.rowErrorText({ error: { code: 'render_failed' } })).toBe('render_failed');
    expect(bulk.ranOutOfImages({ rows: [{ error: { code: 'quota_exceeded' } }] })).toBe(true);
    expect(bulk.ranOutOfImages({ rows: [{ error: 'quota_exceeded' }] })).toBe(false);
  });

  it('polls small batches every 2 s and large ones every 4 s, half as often after two minutes', () => {
    expect(bulk.pollDelay(0, 20)).toBe(2000);
    expect(bulk.pollDelay(0, 2000)).toBe(4000);
    expect(bulk.pollDelay(180_000, 20)).toBe(4000);
    expect(bulk.pollDelay(180_000, 2000)).toBe(8000);
  });

  it('estimates the images a batch counts at least', () => {
    expect(bulk.minimumImages(120, PDF.baseUnits)).toBe(120 * PDF.baseUnits);
  });

  it('remembers batches newest first, once each, at most ten', () => {
    let list: Array<{ id: string }> = [];
    for (let n = 1; n <= 12; n++) list = bulk.rememberBatch(list, { id: `bat_${n}` });
    expect(list.map((entry) => entry.id)).toEqual(['bat_12', 'bat_11', 'bat_10', 'bat_9', 'bat_8', 'bat_7', 'bat_6', 'bat_5', 'bat_4', 'bat_3']);
    expect(bulk.rememberBatch(list, { id: 'bat_5' }).map((entry) => entry.id).slice(0, 3)).toEqual(['bat_5', 'bat_12', 'bat_11']);
    expect(bulk.rememberBatch('garbage', { id: 'bat_1' })).toEqual([{ id: 'bat_1' }]);
  });

  it('names paper sizes', () => {
    expect(PDF.formats.map(bulk.paperLabel)).toEqual(['A4', 'Letter', 'A5']);
  });
});

describe('agreement with the server', () => {
  it('fills in the same verification keys as src/batch/certificates.ts', () => {
    const path = 'src/batch/certificates.ts';
    if (!existsSync(join(ROOT, path))) return;
    const keys = /VERIFICATION_KEYS = \[([^\]]*)\]/.exec(read(path))?.[1] ?? '';
    expect([...keys.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual(bulk.VERIFICATION_KEYS);
  });

  it('loops over the same list key as the PDF engine', () => {
    expect(read('src/pdf/template.ts')).toContain(`const LIST_KEY = '${bulk.LIST_KEY}';`);
  });
});

describe('Bulk tab source rules', () => {
  const files = ['dashboard/bulk.js', 'dashboard/bulk-helpers.js', 'dashboard/csv.js'];
  const code = (name: string): string =>
    readFileSync(join(JS, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');

  it('builds the page from DOM nodes: no HTML strings, no eval, no inline handlers', () => {
    const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\('on/;
    for (const name of files) expect(code(name), name).not.toMatch(banned);
  });

  it('never hands replaceChildren a skipped child, which it would print as "null"', () => {
    const source = code('dashboard/bulk.js');
    const calls = [...source.matchAll(/\.replaceChildren\(([^)]?)/g)].map((match) => match[1]);
    // Every call is either empty or the one inside fill(), which filters its children first.
    expect(calls.filter((next) => next !== '')).toEqual(['.']);
    expect(source).toContain('node.replaceChildren(...children.filter(');
  });

  it('keeps the rules pure: the parser and the helpers touch no DOM, storage or network', () => {
    for (const name of ['dashboard/bulk-helpers.js', 'dashboard/csv.js']) {
      // The words "document" and "window" appear in sentences; only their use as globals counts.
      expect(code(name), name).not.toMatch(/\b(?:document|window|navigator)\.|\b(?:localStorage|sessionStorage|XMLHttpRequest)\b|\bfetch\(/);
    }
  });

  it('never uploads the file: it is only read as text and parsed, and nothing is sent as a form or a file', () => {
    const source = code('dashboard/bulk.js');
    expect(source).not.toMatch(/FormData|readAsDataURL|readAsArrayBuffer|sendBeacon|XMLHttpRequest/);
    expect([...source.matchAll(/file\.text\(\)/g)]).toHaveLength(1);
    expect(source).toContain('parseCsv(await file.text(),');
    // One direct fetch: the preview, whose body is built by previewRequest from row 1's matched values.
    expect([...source.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(source).toMatch(/fetch\(PREVIEW_PATH,[\s\S]{0,200}body: JSON\.stringify\(body\)/);
    expect(source).toMatch(/const body = previewRequest\(state\.template, data,/);
    expect(source).toContain("api.post('/api/batches', body)");
  });

  it('calls only the API routes listed in the integration notes', () => {
    const source = code('dashboard/bulk.js');
    const calls = [...source.matchAll(/api\.(?:get|post)\(([^,)]+)/g)].map((match) => match[1]!.trim());
    const allowed = ["'/api/batches'", "'/api/batches/templates'", "'/api/templates'", '`/api/templates/${encodeURIComponent(id', '`/api/certificates/${encodeURIComponent(row.certificate_id', '`${path}/cancel`', 'path'];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(allowed, call).toContain(call);
    expect(source).toContain("const PREVIEW_PATH = '/api/tools/pdf';");
    expect(source).toContain('const batchPath = (id) => `/api/batches/${encodeURIComponent(id)}`;');
  });

  it('every relative import exists, and every bulk-* class is styled in dashboard-bulk.css', () => {
    for (const name of files) {
      for (const match of readFileSync(join(JS, name), 'utf8').matchAll(/from '(\.[^']+)'/g)) {
        expect(existsSync(join(JS, 'dashboard', match[1]!)), `${name} imports ${match[1]}`).toBe(true);
      }
    }
    const css = read('site/public/assets/css/dashboard-bulk.css');
    expect(code('dashboard/bulk.js')).toContain("const STYLESHEET = '/assets/css/dashboard-bulk.css';");
    const classes = [...code('dashboard/bulk.js').matchAll(/class: '([^']+)'/g)].flatMap((match) => match[1]!.split(/\s+/));
    const used = new Set(classes.filter((name) => name.startsWith('bulk-')));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(css, name).toMatch(new RegExp(`\\.${name}\\b`));
  });

  it('dashboard-bulk.css uses only tokens that site.css defines, and no remote resources', () => {
    const css = read('site/public/assets/css/dashboard-bulk.css');
    const site = read('site/public/assets/css/site.css');
    for (const [, token] of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(site, token).toContain(`${token}:`);
    expect(css).not.toMatch(/@import|url\(/);
  });
});
