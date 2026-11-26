// The free mark next to a customer header and footer (src/pdf/template.ts preparePdfFragment
// with `mark`, src/pdf/page.ts headerFooter). Chrome renders the header, the footer and the mark
// in one document, so on the Free plan the header and footer are printed as plain text: no
// customer element, attribute, style or class reaches that document, and parser differences
// between the sanitiser and Chrome cannot reach the mark. Printing the attacks in a real
// Chromium is a scratch harness (no headless browser in this project); these tests pin the
// exact templates Chrome receives.
import { env } from 'cloudflare:workers';
import type { Element } from 'domhandler';
import { isTag, isText, type ChildNode } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { describe, expect, it } from 'vitest';
import { PDF } from '../src/config';
import { parsePdfRequest, parseToolRequest } from '../src/pdf/input';
import { EMPTY_TEMPLATE, FREE_MARK_HTML, PLAIN_TEXT_STYLE, headerFooter, plainTextOnly, type HeaderFooter } from '../src/pdf/page';
import { preparePdf } from '../src/pdf/service';
import { preparePdfFragment, type PdfData } from '../src/pdf/template';
import type { UserRow } from '../src/types';

const FREE = { id: 'u_mark_free', plan: 'free' } as UserRow;
const PAID = { id: 'u_mark_pro', plan: 'pro' } as UserRow;
const PLAIN_WARNING = (what: 'header' | 'footer'): string =>
  `On the Free plan the ${what} is printed as plain text next to the free mark: its markup and styles were not used, only its text, line breaks and the pageNumber, totalPages, date and title classes.`;
const PAGE_N_OF_M = 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>';
/** The footer example of /docs/pdf (site/content/docs/pdf.md, "Header and footer"). */
const DOCS_FOOTER = `<div style="width:100%;font-size:9px;text-align:center;color:#666">{{title}} &middot; ${PAGE_N_OF_M}</div>`;
const GAP = '  ';

/** Room in mm -> the box's height: the whole lines of 10.4 pt (8 pt x 1.3) that fit. */
const lines = (mm: number): string => `${Math.round(Math.floor((mm * 72) / 25.4 / 10.4) * 10.4 * 100) / 100}pt`;
const plainBox = (text: string, roomMm: number): string => `<div style="${PLAIN_TEXT_STYLE};max-height:${lines(roomMm)}">${text}</div>`;
const markedFooter = (text: string, roomMm: number): string => `<div style="width:100%">${plainBox(text, roomMm)}${FREE_MARK_HTML}</div>`;
/** Room for the footer's text: the bottom margin less Chrome's edge padding (4 mm) and the mark's line (5 mm). */
const footerRoom = (bottomMm: number): number => bottomMm - 9;
const DEFAULT_BOTTOM_MM = Math.max(PDF.defaultMarginMm, PDF.freeMarkMinBottomMm);
const plain = (source: string, data: PdfData = {}, what: 'header' | 'footer' = 'footer') => preparePdfFragment(source, data, what, { mark: true });
const plainOf = (source: string, data: PdfData = {}): string => plain(source, data).render(() => undefined);

/** What printPrepared (src/pdf/service.ts) hands to Chrome for a POST /v1/pdf body. */
async function templatesFor(user: UserRow, body: Record<string, unknown>): Promise<HeaderFooter & { warnings: string[]; remoteUrls: string[] }> {
  const prepared = preparePdf((await parsePdfRequest(env.DB, user, body)).job);
  const resolve = (): undefined => undefined;
  return {
    ...headerFooter(prepared.header?.render(resolve) ?? null, prepared.footer?.render(resolve) ?? null, prepared.job.mark, prepared.job.setup.margin),
    warnings: prepared.warnings,
    remoteUrls: [prepared.header, prepared.footer].flatMap((part) => part?.remoteUrls ?? []),
  };
}

/** Every element of a template, and the chain of styles above the mark's text. */
function inspect(template: string): { elements: string[]; markAncestors: string[] } {
  const elements: string[] = [];
  let markAncestors: string[] = [];
  const walk = (nodes: readonly ChildNode[], ancestors: string[]): void => {
    for (const node of nodes) {
      if (isText(node) && node.data === PDF.freeMark) markAncestors = ancestors;
      if (!isTag(node)) continue;
      const element = node as Element;
      const tag = `${element.name}${Object.entries(element.attribs).map(([name, value]) => `[${name}=${value}]`).join('')}`;
      elements.push(tag);
      walk(element.children, [element.attribs.style ?? element.name, ...ancestors]);
    }
  };
  walk(parseDocument(template).children, []);
  return { elements, markAncestors };
}

const MARK_OUTER_STYLE = /^<div style="([^"]+)">/.exec(FREE_MARK_HTML)![1]!;
const MARK_INNER_STYLE = /<div style="([^"]+)">[^<]+<\/div><\/div>$/.exec(FREE_MARK_HTML)![1]!;
const OUR_ELEMENT = new RegExp(
  `^(?:br|span\\[class=(?:pageNumber|totalPages|date|title)\\]|div\\[style=width:100%\\]|div\\[style=${PLAIN_TEXT_STYLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};max-height:[\\d.]+pt\\]|div\\[style=${MARK_OUTER_STYLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]|div\\[style=${MARK_INNER_STYLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\])$`,
);

describe('Free header and footer: plain text next to the mark', () => {
  it('print the /docs/pdf example footer as its text, with Chrome\'s page numbers, on its own line above the mark', async () => {
    const body = { template: 'report', data: { title: 'Customer Support Review, Q3 2026' }, pdf: { margin: { top: '22mm', bottom: '22mm' }, footer: DOCS_FOOTER } };
    const free = await templatesFor(FREE, body);
    expect(free.footerTemplate).toBe(markedFooter(`Customer Support Review, Q3 2026 · ${PAGE_N_OF_M}`, footerRoom(22)));
    expect(free.headerTemplate).toBe(EMPTY_TEMPLATE);
    expect(free.warnings).toEqual([PLAIN_WARNING('footer')]);
    // Paid plans print it exactly as written, without the mark.
    const paid = await templatesFor(PAID, body);
    expect(paid.footerTemplate).toBe(`<div style="width:100%;font-size:9px;text-align:center;color:#666">Customer Support Review, Q3 2026 · ${PAGE_N_OF_M}</div>`);
    expect(paid.warnings).toEqual([]);
  });

  it('keep a paid width:100% + padding flex header as written, both sides included', async () => {
    const header = `<div style="width:100%;padding:0 15mm;font-size:9px;display:flex;justify-content:space-between;color:#333"><span>ACME Ltd</span><span>${PAGE_N_OF_M}</span></div>`;
    const paid = await templatesFor(PAID, { html: '<p>x</p>', pdf: { margin: { top: '20mm' }, header } });
    expect(paid.headerTemplate).toBe(header);
    // On Free both sides are kept as text, with a gap where the flex items were.
    const free = await templatesFor(FREE, { html: '<p>x</p>', pdf: { margin: { top: '20mm' }, header } });
    expect(free.headerTemplate).toBe(plainBox(`ACME Ltd${GAP}${PAGE_N_OF_M}`, 20 - 4));
    expect(free.footerTemplate).toBe(FREE_MARK_HTML);
  });

  it.each([
    // mark-1: an HTML element inside <svg>/<math> that Chrome moves out of foreign content
    ['svg + <b> (formatting element rebuilt around the mark)', '<span>F</span><svg><b style="opacity:0"></b></svg>', 'F'],
    ['svg + <font color>', '<span>F</span><svg><font color="#ffffff"></font></svg>', 'F'],
    ['svg + <i> font-size 0', '<span>F</span><svg><i style="font-size:0"></i></svg>', 'F'],
    ['svg + <div> display:none (mark inside the customer\'s div)', '<span>F</span><svg><div style="display:none"></div><div></div></svg>', 'F'],
    ['math + <u> in white', '<math><u style="color:#fff;text-decoration:none"></u></math>', ''],
    ['svg + <s> transform', '<svg><s style="display:inline-block;transform:translateY(40mm);text-decoration:none"></s></svg>', ''],
    ['svg + <div> pushing the mark into the clipped box', '<div style="height:60mm"></div><svg><div></div></svg>', ''],
    // mark-2: li/dd implicit closing, a stray </div> closing our box
    ['li/div/div/li + wide flex item', '<li><div><div><li>x</li></div></div></li><div style="flex:none;width:400mm;height:1px"></div>', 'x'],
    ['li/div/li + full-width float', '<li><div><li>x</li></div></li><div style="float:left;width:400mm;height:30mm"></div>', 'x'],
    ['dd/div/div/dd + wide flex item', '<dd><div><div><dd>x</dd></div></div></dd><div style="flex:none;width:400mm;height:1px"></div>', 'x'],
    // the earlier rounds: stylesheets and inline covers
    ['<style> that hides the mark', '<style>div[style*="6b7280"]{display:none!important}</style><span>my footer</span>', 'my footer'],
    ['fixed white box at the highest z-index', '<div style="position:fixed;inset:0;background:#fff;z-index:2147483647">F</div>', 'F'],
    ['class names of Chrome\'s own template', '<div class="text left grow">F</div>', 'F'],
  ])('leave no customer element, attribute, style or class next to the mark: %s', async (_label, footer, text) => {
    const { footerTemplate, headerTemplate, warnings } = await templatesFor(FREE, { html: '<p>x</p>', pdf: { margin: { bottom: '22mm' }, footer, header: footer } });
    expect(footerTemplate).toBe(text === '' ? FREE_MARK_HTML : markedFooter(text, footerRoom(22)));
    expect(headerTemplate).toBe(text === '' ? EMPTY_TEMPLATE : plainBox(text, PDF.defaultMarginMm - 4));
    for (const template of [footerTemplate!, headerTemplate!].filter((template) => template !== EMPTY_TEMPLATE)) {
      for (const element of inspect(template).elements) expect(element).toMatch(OUR_ELEMENT);
    }
    // The mark's text sits in FREE_MARK_HTML's own two divs (and our wrapper), and comes last.
    expect(inspect(footerTemplate!).markAncestors).toEqual(text === '' ? [MARK_INNER_STYLE, MARK_OUTER_STYLE] : [MARK_INNER_STYLE, MARK_OUTER_STYLE, 'width:100%']);
    expect(footerTemplate!.endsWith(text === '' ? FREE_MARK_HTML : `${FREE_MARK_HTML}</div>`)).toBe(true);
    expect(warnings).toEqual([PLAIN_WARNING('header'), PLAIN_WARNING('footer')]);
  });

  it('escape data values, so a value never becomes markup', () => {
    const value = '</div><div style="position:fixed;inset:0;background:#fff">x</div><svg><b>';
    const text = plainOf('{{v}} &amp; {{w}}', { v: value, w: 'Fernhill <Studio>' });
    expect(text).toBe('&lt;/div&gt;&lt;div style="position:fixed;inset:0;background:#fff"&gt;x&lt;/div&gt;&lt;svg&gt;&lt;b&gt; &amp; Fernhill &lt;Studio&gt;');
    expect(headerFooter(null, text, true).footerTemplate).toBe(markedFooter(text, footerRoom(PDF.freeMarkMinBottomMm)));
  });

  it.each([
    ['text and page values', PAGE_N_OF_M, PAGE_N_OF_M],
    ['<div> and <p> lines', '<div>ACME Ltd</div><p>1 Road, Town</p>', 'ACME Ltd<br>1 Road, Town'],
    ['<br>, an empty line kept, none at the ends', '<br>a<br><br>b<br>', 'a<br><br>b'],
    ['white space collapsed', '<p>  lots   of\n  space </p>', 'lots of space'],
    ['entities', 'A &middot; B &amp; C&nbsp;D', 'A · B &amp; C D'],
    ['flex row: a gap between the items', `<div style="display:flex;justify-content:space-between"><span>ACME Ltd</span> <div>${PAGE_N_OF_M}</div></div>`, `ACME Ltd${GAP}${PAGE_N_OF_M}`],
    ['flex column: one item per line', '<div style="display: flex; flex-direction: column"><span>one</span><span>two</span></div>', 'one<br>two'],
    ['grid: a gap between the items', '<div style="display:grid;grid-template-columns:1fr 1fr"><span>L</span><span>R</span></div>', `L${GAP}R`],
    ['table: rows on lines, a gap between cells', '<table><tr><td>A</td><td>B</td></tr><tr><th>C</th><td>D</td></tr></table>', `A${GAP}B<br>C${GAP}D`],
    ['display:none prints nothing', '<span style="display:none">secret</span>shown<div style="display: none !important">x</div>', 'shown'],
    ['hidden content prints nothing', '<span hidden>a</span><span style="visibility:hidden">b</span><dialog>c</dialog><ruby>d<rp>(</rp><rt>e</rt><rp>)</rp></ruby>', 'de'],
    ['a block shown inline stays on the line', 'a <div style="display:inline">b</div> c', 'a b c'],
    ['images, SVG and MathML print nothing', '<img src="data:image/png;base64,iVBORw0KGgo="><svg><text>logo</text></svg><math><mi>x</mi></math>Acme', 'Acme'],
    ['Chrome replaces the content of a page-value element', '<b class="pageNumber">9</b>', '<span class="pageNumber"></span>'],
    ['the last class in Chrome\'s order wins', '<span class="totalPages date pageNumber"></span> <span class="title date"></span>', '<span class="totalPages"></span> <span class="title"></span>'],
    ['class names are case-sensitive, and "url" is not offered', '<span class="pagenumber">x</span><span class="url">u</span>', 'xu'],
    ['sections and placeholders', '{{#items}}<div>{{description}}: {{amount}}</div>{{/items}}{{^notes}}no notes{{/notes}}', 'Design: 1<br>Build: 2<br>no notes'],
  ])('keep %s', (_label, source, expected) => {
    expect(plainOf(source, { items: [{ description: 'Design', amount: '1' }, { description: 'Build', amount: '2' }] })).toBe(expected);
  });

  it('warn only when markup or styles were left out', () => {
    for (const source of [PAGE_N_OF_M, '<div>ACME Ltd</div><br><p>1 Road</p>', '<span class="date"></span> {{v}}']) {
      expect(plain(source, { v: '<b>x</b>' }).warnings, source).toEqual([]);
    }
    for (const source of ['<b>ACME</b>', '<span style="color:red">x</span>', '<div class="footer">x</div>', '<style>p{}</style>x', '<img src="data:image/png;base64,iVBORw0KGgo=">x', '<p dir="rtl">x</p>']) {
      expect(plain(source).warnings, source).toEqual([PLAIN_WARNING('footer')]);
    }
    expect(plain('<i>x</i>', {}, 'header').warnings).toEqual([PLAIN_WARNING('header')]);
  });

  it('download nothing for a Free header or footer; paid plans still inline their images', async () => {
    const footer = '<img src="https://cdn.example.com/logo.png"><span style="background:url(https://cdn.example.com/bg.png)">Acme</span>';
    const free = await templatesFor(FREE, { html: '<p>x</p>', pdf: { footer } });
    expect(free.remoteUrls).toEqual([]);
    expect(free.footerTemplate).toBe(markedFooter('Acme', footerRoom(DEFAULT_BOTTOM_MM)));
    expect((await templatesFor(PAID, { html: '<p>x</p>', pdf: { footer } })).remoteUrls).toEqual(['https://cdn.example.com/logo.png', 'https://cdn.example.com/bg.png']);
  });

  it('still refuse what the paid sanitiser refuses, so a template does not break on upgrade', () => {
    expect(() => plain('<p style="x: \'a\n; y: \'">x</p>')).toThrow(/line break before its closing quote/);
    expect(() => plain(`<p>${'x'.repeat(PDF.maxHeaderFooterBytes)}</p>`)).toThrow(/The footer template is/);
  });

  it('`styles: false` is the older name of `mark: true`', () => {
    const source = `<style>*{display:none}</style><div style="color:red">ACME</div>${PAGE_N_OF_M}`;
    const old = preparePdfFragment(source, {}, 'footer', { styles: false });
    expect(old.render(() => undefined)).toBe(plainOf(source));
    expect(old.render(() => undefined)).toBe(`ACME<br>${PAGE_N_OF_M}`);
    expect(old.warnings).toEqual([PLAIN_WARNING('footer')]);
  });
});

describe('the mark\'s margin: @page after <!-- or --> is dropped everywhere a Free PDF takes CSS', () => {
  const smuggled = ['<!-- @page { margin: 0 }', '--> @page{size:30mm 30mm}', '<!--@media print{@page{margin:0}}', '<!-- --> <!----> @page { margin: 0 } .x { color: #111 }'];
  const invoice = { seller_name: 'S', buyer_name: 'B', invoice_number: '1', issue_date: 'x', total: '1' };

  it.each(smuggled)('in the css of POST /v1/pdf and of the three free tools: %s', async (css) => {
    const jobs = [
      (await parsePdfRequest(env.DB, FREE, { html: '<p>x</p>', css })).job,
      (await parsePdfRequest(env.DB, FREE, { html: `<style>${css}</style><p>x</p>` })).job,
      (await parseToolRequest({ tool: 'html-to-pdf', html: '<p>x</p>', css })).job,
      (await parseToolRequest({ tool: 'invoice', data: invoice, css })).job,
      (await parseToolRequest({ tool: 'certificate', data: { recipient_name: 'Ada' }, css })).job,
    ];
    for (const job of jobs) {
      expect(job.mark).toBe(true);
      const prepared = preparePdf(job);
      const style = /<style>([\s\S]*)<\/style>/.exec(prepared.document.render(() => undefined))![1]!;
      expect(style).not.toMatch(/@page|<!--|-->/);
      expect(prepared.warnings).toContain('Page size, orientation and margins come from "pdf" (format, landscape, margin); the CSS @page rule was ignored.');
      expect(Number.parseFloat(job.setup.margin.bottom)).toBeGreaterThanOrEqual(PDF.freeMarkMinBottomMm);
    }
  });
});

describe('plainTextOnly (src/pdf/page.ts)', () => {
  it('keeps our line breaks and page values, and escapes every other tag', () => {
    expect(plainTextOnly('a<br><span class="pageNumber"></span><span class="x"></span><b>b</b><span class="date">d</span>')).toBe(
      'a<br><span class="pageNumber"></span>&lt;span class="x"&gt;&lt;/span&gt;&lt;b&gt;b&lt;/b&gt;&lt;span class="date"&gt;d&lt;/span&gt;',
    );
    expect(plainTextOnly('<BR><br/><span class=pageNumber></span>')).toBe('&lt;BR&gt;&lt;br/&gt;&lt;span class=pageNumber&gt;&lt;/span&gt;');
  });
});
