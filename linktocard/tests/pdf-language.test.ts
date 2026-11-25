// The PDF template language (src/pdf/template.ts): placeholders, sections, data limits and the
// document wrapper. Sanitising has its own file (pdf-sanitize.test.ts).
import { describe, expect, it } from 'vitest';
import { PDF } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { buildPdfDocument, preparePdfDocument, validatePdfData, type PdfData } from '../src/pdf/template';

const build = (html: string, data: PdfData = {}, css = ''): string => buildPdfDocument({ html, css, data });
/** The body of a built document. */
const body = (html: string, data: PdfData = {}, css = ''): string => /<body[^>]*>([\s\S]*)<\/body><\/html>$/.exec(build(html, data, css))![1]!;

function errorOf(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('document wrapper', () => {
  it('is a full document: doctype, utf-8, one <style> with the CSS, then the body', () => {
    const html = build('<p>Hi</p>', {}, 'p { color: red }');
    expect(html).toBe('<!doctype html><html><head><meta charset="utf-8"><style>p{color:red;}</style></head><body><p>Hi</p></body></html>');
  });

  it('keeps class, id, style, dir and lang of the template\'s own <html> and <body>, and its <title>', () => {
    const html = build('<html lang="de" data-x="1"><head><title>Rechnung {{n}}</title></head><body class="a4" onload="x()"><p>Hallo</p></body></html>', { n: '7' });
    expect(html).toBe(
      '<!doctype html><html lang="de"><head><meta charset="utf-8"><style></style><title>Rechnung 7</title></head><body class="a4"><p>Hallo</p></body></html>',
    );
  });

  it('moves every <style> element into the head, in order, before the request CSS', () => {
    const html = build('<style>a { color: red }</style><p>x</p><svg><style>rect { fill: blue }</style></svg>', {}, 'p { margin: 0 }');
    expect(html).toContain('<style>a{color:red;}\nrect{fill:blue;}\np{margin:0;}</style>');
    expect(body('<style>a{}</style><p>x</p>')).toBe('<p>x</p>');
  });

  it('embeds bundled fonts only through the fontFaces dependency, with the families the CSS names', () => {
    const seen: Array<{ families: string[]; text: string }> = [];
    const html = buildPdfDocument(
      { html: '<p>Zoë</p>', css: "body { font-family: 'Inter', sans-serif } code { font: 12px/1 \"JetBrains Mono\" }", data: {} },
      { fontFaces: (families, text) => (seen.push({ families: [...families].sort(), text }), '@font-face{font-family:x}') },
    );
    expect(seen).toEqual([{ families: ['inter', 'jetbrains mono'], text: expect.stringContaining('Zoë') }]);
    expect(html).toContain('<style>@font-face{font-family:x}body{');
  });
});

describe('placeholders', () => {
  it('fill text and attribute values; a missing key is empty', () => {
    expect(body('<p class="{{kind}}">{{ title }} by {{author}}</p>', { kind: 'big', title: 'Report' })).toBe('<p class="big">Report by </p>');
  });

  it('write numbers as text', () => {
    expect(body('<td>{{qty}}</td>', { qty: 3 })).toBe('<td>3</td>');
  });

  it('can never create markup, in text or in attributes', () => {
    const data = { evil: '<script>alert(1)</script><img src=x onerror=alert(1)>', quote: '" onmouseover="alert(1)' };
    const out = body('<p title="{{quote}}">{{evil}}</p>', data);
    expect(out).toBe('<p title="&quot; onmouseover=&quot;alert(1)">&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
  });

  it('are filled once: a value that looks like a placeholder or a section stays text', () => {
    expect(body('<p>{{a}}</p>', { a: '{{b}}{{#items}}x{{/items}}', b: 'B' })).toBe('<p>{{b}}{{#items}}x{{/items}}</p>');
  });

  it('never read keys off the object prototype', () => {
    expect(body('<p>{{constructor}}{{tostring}}</p>')).toBe('<p></p>');
  });

  it('leave an element empty when its value is missing, so CSS :empty can hide it', () => {
    expect(body('<p class="line">{{address}}</p>')).toBe('<p class="line"></p>');
  });
});

describe('sections', () => {
  const items = [
    { description: 'Design', amount: '1,200.00' },
    { description: 'Build', amount: '800.00' },
  ];

  it('repeat the rows between the markers once per item, markers in text between <tr> elements', () => {
    const html = '<table><tbody>{{#items}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/items}}</tbody></table>';
    expect(body(html, { items })).toBe(
      '<table><tbody><tr><td>Design</td><td>1,200.00</td></tr><tr><td>Build</td><td>800.00</td></tr></tbody></table>',
    );
  });

  it('render the inverted branch only for an empty or missing list', () => {
    const html = '<ul>{{#items}}<li>{{description}}</li>{{/items}}{{^items}}<li class="none">No items</li>{{/items}}</ul>';
    expect(body(html, { items: [] })).toBe('<ul><li class="none">No items</li></ul>');
    expect(body(html, {})).toBe('<ul><li class="none">No items</li></ul>');
    expect(body(html, { items })).toBe('<ul><li>Design</li><li>Build</li></ul>');
  });

  it('look item fields up first, then the top-level data (an item field shadows a top-level key)', () => {
    const html = '<ul>{{#items}}<li>{{description}} ({{currency}}) {{amount}}</li>{{/items}}</ul>';
    const data: PdfData = { currency: 'EUR', description: 'top level', items: [{ description: 'Item', amount: '5' }, { amount: '6' }] };
    expect(body(html, data)).toBe('<ul><li>Item (EUR) 5</li><li>top level (EUR) 6</li></ul>');
  });

  it('work inside a single text node and with spaces inside the markers', () => {
    expect(body('<p>{{ #items }}{{description}}; {{ /items }}</p>', { items })).toBe('<p>Design; Build; </p>');
  });

  it('nest: a conditional on an item field inside the list, an inverted conditional outside it', () => {
    const html =
      '<div>{{#items}}<p>{{description}}{{#note}} - <em>{{note}}</em>{{/note}}</p>{{/items}}{{^due_date}}<p class="no-due">No due date</p>{{/due_date}}</div>';
    const data: PdfData = { items: [{ description: 'A', note: 'rush' }, { description: 'B' }] };
    expect(body(html, data)).toBe('<div><p>A - <em>rush</em></p><p>B</p><p class="no-due">No due date</p></div>');
    expect(body(html, { ...data, due_date: '1 Dec' })).not.toContain('no-due');
  });

  it('treat a flat value as a condition: non-empty shows {{#key}}, empty or missing shows {{^key}}', () => {
    const html = '<p>{{#paid}}PAID{{/paid}}{{^paid}}DUE{{/paid}}</p>';
    expect(body(html, { paid: 'yes' })).toBe('<p>PAID</p>');
    expect(body(html, { paid: '  ' })).toBe('<p>DUE</p>');
    expect(body(html, {})).toBe('<p>DUE</p>');
    expect(body(html, { paid: 0 })).toBe('<p>PAID</p>');
  });

  it('refuse a list inside the same list', () => {
    const error = errorOf(() => build('<div>{{#items}}<p>{{#items}}x{{/items}}</p>{{/items}}</div>', { items: [{ a: '1' }] }));
    expect(error.code).toBe('template_error');
    expect(error.message).toContain('cannot be used inside another');
  });

  it('must open and close inside one element, in order', () => {
    expect(errorOf(() => build('<div>{{#items}}</div><div>{{/items}}</div>')).message).toContain('is not closed');
    expect(errorOf(() => build('<p>{{/items}}</p>')).message).toContain('has no matching');
    expect(errorOf(() => build('<p>{{#a}}{{#b}}{{/a}}{{/b}}</p>')).message).toContain('close the inner section first');
  });

  it('may not be used inside attribute values', () => {
    expect(errorOf(() => build('<p class="{{#paid}}paid{{/paid}}">x</p>')).message).toContain('can only be used in text');
  });

  it('count against the element and size limits once expanded', () => {
    const many = Array.from({ length: PDF.maxItems }, () => ({ a: 'x' }));
    const cells = '<i></i>'.repeat(Math.ceil(PDF.maxElements / PDF.maxItems) + 1);
    const error = errorOf(() => build(`<div>{{#items}}<p>${cells}</p>{{/items}}</div>`, { items: many }));
    expect(error.code).toBe('template_error');
    expect(error.message).toContain(`more than ${PDF.maxElements} elements`);

    const long = 'x'.repeat(PDF.maxItemValueChars);
    const repeated = '{{a}}'.repeat(Math.ceil(PDF.maxHtmlBytes / long.length / PDF.maxItems) + 1);
    const big = errorOf(() => build(`<div>{{#items}}<p>${repeated}</p>{{/items}}</div>`, { items: Array.from({ length: PDF.maxItems }, () => ({ a: long })) }));
    expect(big.code).toBe('template_error');
    expect(big.message).toContain('once placeholders');
  });
});

describe('input limits', () => {
  it('refuse HTML and CSS over their caps with template_error', () => {
    const html = errorOf(() => build(`<p>${'x'.repeat(PDF.maxHtmlBytes)}</p>`));
    expect(html.code).toBe('template_error');
    expect(html.details).toMatchObject({ limit: PDF.maxHtmlBytes });
    const css = errorOf(() => build('<p>x</p>', {}, `/*${'x'.repeat(PDF.maxCssBytes)}*/`));
    expect(css.code).toBe('template_error');
    expect(css.details).toMatchObject({ limit: PDF.maxCssBytes });
  });

  it('refuse elements nested deeper than PDF.maxDepth', () => {
    const deep = '<div>'.repeat(PDF.maxDepth + 2) + 'x' + '</div>'.repeat(PDF.maxDepth + 2);
    expect(errorOf(() => build(deep)).message).toContain(`more than ${PDF.maxDepth} levels`);
  });
});

describe('validatePdfData', () => {
  it('accepts text, numbers and one list of flat items; null counts as missing', () => {
    expect(validatePdfData({ a: 'x', n: 2, gone: null, items: [{ q: 1, d: 'y', none: null }] })).toEqual({ a: 'x', n: 2, items: [{ q: 1, d: 'y' }] });
    expect(validatePdfData(undefined)).toEqual({});
  });

  it.each([
    ['a non-object', 'text', '"data" must be an object'],
    ['a bad key', { 'Bad-Key': 'x' }, 'is not valid'],
    ['a boolean', { paid: true }, 'Send true/false as text'],
    ['a list under another key', { rows: [] }, 'Only "items" may be a list'],
    ['an object value', { seller: { name: 'x' } }, 'Only "items" may be a list'],
    ['items that is not a list', { items: { a: 1 } }, '"items" must be a list'],
    ['an item that is not an object', { items: ['x'] }, 'items[0] must be an object'],
    ['a nested list in an item', { items: [{ sub: [] }] }, 'items[0].sub must be text or a number'],
    ['a bad item key', { items: [{ Bad: 'x' }] }, 'items[0] key "Bad" is not valid'],
  ])('refuses %s', (_label, data, message) => {
    const error = errorOf(() => validatePdfData(data));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain(message);
  });

  it('enforces the counts and lengths from src/config.ts PDF', () => {
    const keys = Object.fromEntries(Array.from({ length: PDF.maxDataKeys + 1 }, (_, i) => [`k${i}`, 'x']));
    expect(errorOf(() => validatePdfData(keys)).message).toContain(`at most ${PDF.maxDataKeys} keys`);
    expect(errorOf(() => validatePdfData({ a: 'x'.repeat(PDF.maxDataValueChars + 1) })).message).toContain(`longer than ${PDF.maxDataValueChars}`);
    expect(validatePdfData({ a: '\u{1F600}'.repeat(PDF.maxDataValueChars) }).a).toHaveLength(PDF.maxDataValueChars * 2);
    const items = Array.from({ length: PDF.maxItems + 1 }, () => ({ a: 'x' }));
    expect(errorOf(() => validatePdfData({ items })).message).toContain(`at most ${PDF.maxItems} entries`);
    const fields = Object.fromEntries(Array.from({ length: PDF.maxItemFields + 1 }, (_, i) => [`f${i}`, 'x']));
    expect(errorOf(() => validatePdfData({ items: [fields] })).message).toContain(`at most ${PDF.maxItemFields} fields`);
    expect(errorOf(() => validatePdfData({ items: [{ a: 'x'.repeat(PDF.maxItemValueChars + 1) }] })).message).toContain(`longer than ${PDF.maxItemValueChars}`);
  });

  it('is applied by buildPdfDocument too (invalid_request for bad data)', () => {
    expect(errorOf(() => buildPdfDocument({ html: '<p>x</p>', css: '', data: { paid: true } as unknown as PdfData })).code).toBe('invalid_request');
  });
});

describe('preparePdfDocument', () => {
  it('lists the remote image URLs and writes the resolved values in their place', () => {
    const prepared = preparePdfDocument({
      html: '<img src="https://img.example.com/logo.png?a=1&b=2"><div style="background:url(https://img.example.com/bg.png)"></div>',
      css: '.x { background-image: url("https://img.example.com/bg.png") }',
      data: {},
    });
    // Each distinct URL once (the stylesheets are read before the body).
    expect(prepared.remoteUrls).toEqual(['https://img.example.com/bg.png', 'https://img.example.com/logo.png?a=1&b=2']);
    const inlined = prepared.render((url) => (url.endsWith('bg.png') ? 'data:image/png;base64,QkFDSw==' : 'data:image/png;base64,TE9HTw=='));
    expect(inlined).toContain('<img src="data:image/png;base64,TE9HTw==">');
    expect(inlined).toContain('style="background:url(&quot;data:image/png;base64,QkFDSw==&quot;)"');
    expect(inlined).toContain('.x{background-image:url("data:image/png;base64,QkFDSw==");}');
    // Without a resolver (buildPdfDocument) the URLs stay, escaped for where they stand.
    expect(prepared.render(() => undefined)).toContain('<img src="https://img.example.com/logo.png?a=1&amp;b=2">');
  });
});
