// The request body of POST /v1/pdf-tools/{op} (src/pdftools/request.ts): field checks, file
// references, the snake_case options of each operation, and running a parsed request.
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDF, PDF_TOOLKIT } from '../src/config';
import { isToolkitOp, parseToolkitRequest, runToolkitOp } from '../src/pdftools';
import { fixture, hexText, pageContent, reload } from './pdftools-helpers';

const b64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
const ID = 'a'.repeat(64);

function fails(op: Parameters<typeof parseToolkitRequest>[0], body: Record<string, unknown>, message: RegExp): void {
  expect(() => parseToolkitRequest(op, body)).toThrow(message);
}

describe('parseToolkitRequest', () => {
  it('knows the operations of PDF_TOOLKIT.ops', () => {
    for (const op of PDF_TOOLKIT.ops) expect(isToolkitOp(op)).toBe(true);
    expect(isToolkitOp('compress')).toBe(false);
  });

  it('reads the three kinds of file reference', () => {
    const request = parseToolkitRequest('merge', {
      files: [{ url: 'https://example.com/a.pdf' }, { base64: b64(fixture('multi-page.pdf')), pages: '2-3' }, { pdf_id: ID }, { base64: `data:application/pdf;base64,${b64(fixture('rotated.pdf'))}` }],
    });
    expect(request.files.map((f) => f.kind)).toEqual(['url', 'base64', 'pdf_id', 'base64']);
    expect(request.files[1]).toEqual({ kind: 'base64', bytes: fixture('multi-page.pdf') });
    expect(request.pages).toEqual([undefined, '2-3', undefined, undefined]);
    expect(request.response).toBe('url');
    expect(request.filename).toBe('merge.pdf');
  });

  it('refuses bad references before any fetch', () => {
    fails('merge', {}, /"files" must be a non-empty list/);
    fails('merge', { files: [] }, /non-empty list/);
    fails('merge', { files: ['x'] }, /files\[0\] must be an object/);
    fails('merge', { files: [{ url: 'https://a.example/x.pdf', base64: 'AAAA' }] }, /exactly one of "url", "base64" or "pdf_id"/);
    fails('merge', { files: [{ url: 'http://127.0.0.1/x.pdf' }] }, /^files\[0\]\.url: /);
    fails('merge', { files: [{ url: 'file:///etc/passwd' }] }, /^files\[0\]\.url: /);
    fails('merge', { files: [{ base64: 'not base64!' }] }, /files\[0\]\.base64 is not valid base64/);
    fails('merge', { files: [{ pdf_id: 'abc' }] }, /pdf_id must be the "id" of one of your stored PDFs/);
    fails('merge', { files: [{ pdf_id: ID, extra: 1 }] }, /unknown field "extra"/);
    fails('merge', { files: [{ pdf_id: ID, pages: 3 }] }, /files\[0\]\.pages must be a string/);
    fails('stamp', { files: [{ pdf_id: ID, pages: '1' }], text: 'x' }, /unknown field "pages"/);
    fails('from-images', { files: [{ pdf_id: ID }] }, /files\[0\] has unknown field "pdf_id"/);
    fails('stamp', { files: [{ pdf_id: ID }, { pdf_id: ID }], text: 'x' }, /"stamp" takes one file; 2 were given/);
    fails('merge', { files: Array.from({ length: 21 }, () => ({ pdf_id: ID })) }, /At most 20 files per request; 21/);
  });

  it('refuses base64 larger than the input cap before decoding it', () => {
    const big = 'A'.repeat(Math.ceil((PDF_TOOLKIT.maxInputBytes * 4) / 3) + 8);
    expect(() => parseToolkitRequest('merge', { files: [{ base64: big }] })).toThrow(expect.objectContaining({ code: 'payload_too_large' }));
  });

  it('rejects unknown fields per operation, and fields of the wrong type', () => {
    fails('merge', { files: [{ pdf_id: ID }], ranges: '1' }, /Unknown field "ranges"/);
    fails('split', { files: [{ pdf_id: ID }], every: '2' }, /"every" must be a number/);
    fails('fill', { files: [{ pdf_id: ID }] }, /"values" must be an object/);
    fails('fill', { files: [{ pdf_id: ID }], values: {}, flatten: 'yes' }, /"flatten" must be a boolean/);
    fails('protect', { files: [{ pdf_id: ID }], permissions: { print: false } }, /permissions has unknown field "print"/);
    fails('merge', { files: [{ pdf_id: ID }], response: 'zip' }, /"response" must be "url"/);
    fails('split', { files: [{ pdf_id: ID }], ranges: '1', response: 'binary' }, /"split" answers JSON/);
    fails('merge', { files: [{ pdf_id: ID }], filename: 7 }, /"filename" must be text/);
  });

  it('maps stamp options and keeps text and image apart', () => {
    const text = parseToolkitRequest('stamp', { files: [{ pdf_id: ID }], text: 'PAID', font_size: 30, color: '#f00', rotation: 45, pages: '1', filename: 'paid invoice.pdf' });
    expect(text.options).toEqual({ text: { text: 'PAID', font: undefined, fontSize: 30, color: '#f00', opacity: undefined, rotation: 45, position: undefined, margin: undefined, pages: '1' } });
    expect(text.filename).toBe('paid invoice.pdf');
    const image = parseToolkitRequest('stamp', { files: [{ pdf_id: ID }], image: { url: 'https://example.com/logo.png' }, width: 80, position: 'top-left' });
    expect(image.image).toEqual({ kind: 'url', url: 'https://example.com/logo.png' });
    expect(image.options).toEqual({ image: { width: 80, opacity: undefined, rotation: undefined, position: 'top-left', margin: undefined, pages: undefined } });
    fails('stamp', { files: [{ pdf_id: ID }] }, /either "text" or "image"/);
    fails('stamp', { files: [{ pdf_id: ID }], text: 'x', image: { url: 'https://example.com/a.png' } }, /not both/);
    fails('stamp', { files: [{ pdf_id: ID }], text: 'x', width: 3 }, /"width" goes with "image"/);
    fails('stamp', { files: [{ pdf_id: ID }], image: { url: 'https://example.com/a.png' }, font_size: 3 }, /"font_size" goes with "text"/);
    fails('stamp', { files: [{ pdf_id: ID }], image: { pdf_id: ID } }, /unknown field "pdf_id"/);
  });

  it('maps protect permissions to their option names', () => {
    const request = parseToolkitRequest('protect', { files: [{ pdf_id: ID }], user_password: 'a', owner_password: 'b', permissions: { printing: 'low', filling_forms: false } });
    expect(request.options).toEqual({ userPassword: 'a', ownerPassword: 'b', permissions: { printing: 'low', fillingForms: false } });
  });
});

describe('runToolkitOp', () => {
  it('runs a parsed stamp with the free mark, then a parsed fields request', async () => {
    const pdf = fixture('form.pdf');
    const request = parseToolkitRequest('stamp', { files: [{ base64: b64(pdf) }], text: 'PAID' });
    const result = await runToolkitOp(request, { files: [pdf] }, true);
    expect(result.kind).toBe('pdf');
    if (result.kind !== 'pdf') return;
    const content = pageContent(await reload(result.outputs[0]!.bytes), 0);
    expect(content).toContain(hexText('PAID'));
    expect(content).toContain(hexText(PDF.freeMark));

    const listed = await runToolkitOp(parseToolkitRequest('fields', { files: [{ pdf_id: ID }] }), { files: [pdf] }, false);
    expect(listed).toMatchObject({ kind: 'fields', pages: 1 });
  });

  it('runs every other operation from its parsed form', async () => {
    const multi = fixture('multi-page.pdf');
    const run = (op: Parameters<typeof parseToolkitRequest>[0], body: Record<string, unknown>, files: Uint8Array[], image?: Uint8Array) =>
      runToolkitOp(parseToolkitRequest(op, { files: files.map(() => ({ pdf_id: ID })), ...body }), { files, ...(image ? { image } : {}) }, false);
    const pages = (r: Awaited<ReturnType<typeof runToolkitOp>>): number[] => (r.kind === 'pdf' ? r.outputs.map((o) => o.pages) : []);
    expect(pages(await run('merge', {}, [multi, fixture('rotated.pdf')]))).toEqual([13]);
    expect(pages(await run('split', { every: 4 }, [multi]))).toEqual([4, 4]);
    expect(pages(await run('stamp', { image: { url: 'https://example.com/logo.png' }, width: 50 }, [multi], fixture('logo.png')))).toEqual([8]);
    expect(pages(await run('fill', { values: { plan: 'pro' }, flatten: true }, [fixture('form.pdf')]))).toEqual([1]);
    expect(pages(await run('protect', { user_password: 'pw' }, [multi]))).toEqual([8]);
    const images = await runToolkitOp(parseToolkitRequest('from-images', { files: [{ url: 'https://example.com/a.jpg' }], page_size: 'auto' }), { files: [fixture('photo.jpg')] }, false);
    expect(pages(images)).toEqual([1]);
    if (images.kind === 'pdf') expect((await PDFDocument.load(images.outputs[0]!.bytes)).getPage(0).getSize()).toEqual({ width: 300, height: 200 });
  });
});
