// The PDF pages of the site (built with SITE_PDF=on): every number on them comes from
// PDF / pdfUnits() in src/config.ts, every template key from src/pdf/templates, every
// example parses and agrees with the API, the signers print the published link, and the
// tool script never turns what a visitor types into HTML.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANS, TOPUP, formatCount, formatUsd } from '../../src/billing/plans';
import { HTTP_CACHE, LIMITS, PDF, pdfUnits } from '../../src/config';
import { PDF_TEMPLATES, PDF_TEMPLATE_IDS } from '../../src/pdf/templates';
import { listTokens, pdfUnitRows, renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-25T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'ltc-pdf-site-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ENTITIES: Record<string, string> = { ldquo: '\u201c', rdquo: '\u201d', rsquo: '\u2019', ndash: '\u2013', middot: '\u00b7', times: '\u00d7', nbsp: ' ' };
const unescapeHtml = (html: string): string =>
  html
    .replace(/&(ldquo|rdquo|rsquo|ndash|middot|times|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
/** Visible text as a reader sees it: tags removed without adding spaces, so inline code stays inside its sentence. */
const visibleText = (html: string): string => unescapeHtml(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ');

const template = (id: string) => {
  const found = PDF_TEMPLATES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no PDF template ${id}`);
  return found;
};
const keysOf = (id: string): string[] => template(id).fields.map((field) => field.key);
const itemFieldsOf = (id: string): string[] => [...(template(id).fields.find((field) => field.kind === 'items')?.itemFields ?? [])];
const requiredOf = (id: string): string[] => template(id).fields.filter((field) => field.required).map((field) => field.key);

let site: RenderedSite;
beforeAll(() => {
  site = renderSite({ env: { SITE_PDF: 'on' }, now: NOW });
});

function built(outPath: string): string {
  const found = site.pages.find((candidate) => candidate.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
}

function article(outPath: string): string {
  const html = built(outPath);
  return html.slice(html.indexOf('<article'), html.indexOf('</article>'));
}

/** The text of the rendered code blocks of one language, in page order. */
function codeBlocks(html: string, lang: string): string[] {
  return [...html.matchAll(/<div class="code-block" data-lang="([\w-]+)">[\s\S]*?<code[^>]*>([\s\S]*?)<\/code><\/pre><\/div>/g)]
    .filter((match) => match[1] === lang)
    .map((match) => unescapeHtml(match[2] ?? ''));
}

/** The JSON body of a curl command (-d '...'). */
function curlBody(command: string): Record<string, unknown> {
  const body = /-d '([\s\S]*?)'/.exec(command)?.[1];
  if (!body) throw new Error(`no -d '...' body in: ${command.slice(0, 80)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Checks a request body against the PDF starter template it names: only its keys, all required ones, items with its fields. */
function expectValidStarterBody(body: Record<string, unknown>, where: string): void {
  const id = String(body.template);
  expect(PDF_TEMPLATE_IDS, where).toContain(id);
  const data = body.data as Record<string, unknown>;
  for (const key of Object.keys(data)) expect(keysOf(id), `${where}: ${id} has no key ${key}`).toContain(key);
  for (const key of requiredOf(id)) expect(Object.keys(data), `${where}: ${id} needs ${key}`).toContain(key);
  for (const item of (data.items as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const field of Object.keys(item)) expect(itemFieldsOf(id), `${where}: ${id} items have no ${field}`).toContain(field);
  }
}

describe('[[pdf.*]] tokens', () => {
  const { tokens, partials } = listTokens({ env: {}, now: NOW });

  it('print the numbers of PDF and pdfUnits() in src/config.ts', () => {
    expect(tokens).toMatchObject({
      'pdf.maxPages': String(PDF.maxPages),
      'pdf.basePages': String(PDF.basePages),
      'pdf.baseUnits': String(PDF.baseUnits),
      'pdf.extraPagesPerUnit': String(PDF.extraPagesPerUnit),
      'pdf.maxUnits': String(pdfUnits(PDF.maxPages)),
      'pdf.maxHtmlKb': formatCount(PDF.maxHtmlBytes / 1024),
      'pdf.maxHtmlMb': String(PDF.maxHtmlBytes / (1024 * 1024)),
      'pdf.maxCssKb': String(PDF.maxCssBytes / 1024),
      'pdf.maxAssetMb': String(PDF.maxAssetBytes / (1024 * 1024)),
      'pdf.maxRequestBodyMb': String(PDF.maxRequestBodyBytes / (1024 * 1024)),
      'pdf.maxPdfMb': String(PDF.maxPdfBytes / (1024 * 1024)),
      'pdf.failedRenderMemoryMinutes': String(PDF.failedRenderMemoryMs / 60_000),
      'pdf.duplicateWaitSeconds': String((2 * PDF.renderTimeoutMs + 15_000 + 15_000) / 1000),
      'pdf.maxHeaderFooterKb': String(PDF.maxHeaderFooterBytes / 1024),
      'pdf.renderTimeoutSeconds': String(PDF.renderTimeoutMs / 1000),
      'pdf.maxMarginMm': String(PDF.maxMarginMm),
      'pdf.defaultMarginMm': String(PDF.defaultMarginMm),
      'pdf.maxDataKeys': String(PDF.maxDataKeys),
      'pdf.maxDataValueChars': formatCount(PDF.maxDataValueChars),
      'pdf.maxItems': String(PDF.maxItems),
      'pdf.maxItemFields': String(PDF.maxItemFields),
      'pdf.maxItemValueChars': formatCount(PDF.maxItemValueChars),
      'pdf.maxElements': formatCount(PDF.maxElements),
      'pdf.maxDepth': String(PDF.maxDepth),
      'pdf.maxRemoteAssets': String(PDF.maxRemoteAssets),
      'pdf.maxFilenameChars': String(PDF.maxFilenameChars),
      'pdf.freeMark': PDF.freeMark,
      'pdf.freeMarkMinBottomMm': String(PDF.freeMarkMinBottomMm),
      'pdf.toolPdfsPerHour': String(PDF.toolPdfsPerHour),
      'pdf.toolTurnstileAfterPdfs': String(PDF.toolTurnstileAfterPdfs),
      'pdf.browserUsageRetentionDays': String(PDF.browserUsageRetentionDays),
      'pdf.formats': PDF.formats.join(', '),
      'pdf.defaultFormat': PDF.defaultFormat,
      'pdf.templateIds': PDF_TEMPLATE_IDS.join(', '),
      'pdf.templateCount': String(PDF_TEMPLATES.length),
      'pdf.raw.maxDataValueChars': String(PDF.maxDataValueChars),
      'pdf.raw.maxItems': String(PDF.maxItems),
      'pdf.raw.maxItemValueChars': String(PDF.maxItemValueChars),
    });
    expect(JSON.parse(tokens['pdf.sample.invoice'] ?? '')).toEqual(template('invoice').sample);
    expect(JSON.parse(tokens['pdf.sample.certificate'] ?? '')).toEqual(template('certificate').sample);
    expect(partials).toEqual(expect.arrayContaining(['pdf-units-table', 'pdf-limits-table', 'pdf-templates', 'pdf-format-options']));
  });

  it('print the wait for an identical request as the engine computes it: one browser call, plus 15 s', () => {
    // src/pdf/render.ts and src/pdf/service.ts do not load outside the Worker; the token repeats their formula.
    expect(read('src/pdf/render.ts')).toContain('export const CALL_TIMEOUT_MS = 2 * PDF.renderTimeoutMs + 15_000;');
    expect(read('src/pdf/service.ts')).toContain('export const PDF_DUPLICATE_WAIT_MS = CALL_TIMEOUT_MS + 15_000;');
    expect(tokens['pdf.duplicateWaitSeconds']).toBe(String((2 * PDF.renderTimeoutMs + 15_000 + 15_000) / 1000));
  });

  it('are the only way PDF numbers reach the pages: no PDF page types a limit itself', () => {
    const sources = [
      'site/content/docs/pdf.md',
      'site/pages/tools/html-to-pdf.html',
      'site/pages/tools/invoice-generator.html',
      'site/pages/tools/certificate-generator.html',
      'site/content/guides/html-to-pdf-n8n.md',
      'site/content/guides/html-to-pdf-zapier-webhooks.md',
      'site/content/guides/invoice-pdf-from-stripe-webhook.md',
      'site/partials/counting-rules.html',
    ];
    for (const file of sources) {
      const source = read(file).replace(/```[\s\S]*?```/g, '').replace(/<pre>[\s\S]*?<\/pre>/g, '').replace(/<textarea[\s\S]*?<\/textarea>/g, '');
      for (const [what, value] of [
        ['pages', PDF.maxPages],
        ['PDFs per hour', PDF.toolPdfsPerHour],
        ['MB', PDF.maxAssetBytes / (1024 * 1024)],
        ['KB', PDF.maxCssBytes / 1024],
        ['seconds', PDF.renderTimeoutMs / 1000],
      ] as const) {
        expect(source, `${file} types ${value} ${what}`).not.toMatch(new RegExp(`\\b${value}\\s*(?:${what.split(' ')[0]})`, 'i'));
      }
      expect(source, file).not.toContain(PDF.freeMark);
    }
  });
});

describe('/docs/pdf', () => {
  const markdown = read('site/content/docs/pdf.md');

  it('is a docs page with one <h1>, in the sitemap', () => {
    expect(built('docs/pdf.html').match(/<h1[\s>]/g)).toHaveLength(1);
    expect(site.sitemap).toContain(`<loc>${site.config.url}/docs/pdf</loc>`);
    expect(built('docs/pdf.html')).toContain('<title>PDF documents - Link To Card</title>');
  });

  it('prints the units table exactly as pdfUnits() counts, for every page count', () => {
    const rows = pdfUnitRows();
    for (let pages = 1; pages <= PDF.maxPages; pages++) {
      const row = rows.find((candidate) => candidate.from <= pages && pages <= candidate.to);
      expect(row?.units, `${pages} pages`).toBe(pdfUnits(pages));
    }
    expect(rows[0]).toEqual({ from: 1, to: PDF.basePages, units: PDF.baseUnits });
    expect(rows.at(-1)?.to).toBe(PDF.maxPages);
    const html = article('docs/pdf.html');
    const printed = [...html.matchAll(/<tr><th scope="row">(\d+)(?:-(\d+))? pages?<\/th><td>(\d+) images?<\/td><\/tr>/g)].map((match) => ({
      from: Number(match[1]),
      to: Number(match[2] ?? match[1]),
      units: Number(match[3]),
    }));
    expect(printed).toEqual(rows);
  });

  it('lists every PDF starter template with exactly its keys and its list fields', () => {
    const html = article('docs/pdf.html');
    const documented = [...html.matchAll(/<h3 id="template-([a-z]+)">/g)].map((match) => match[1]);
    expect(documented).toEqual([...PDF_TEMPLATE_IDS]);
    for (const starter of PDF_TEMPLATES) {
      const start = html.indexOf(`<h3 id="template-${starter.id}">`);
      const section = html.slice(start, html.indexOf('</table>', start));
      const keys = [...section.matchAll(/<tr><td><code>([a-z0-9_]+)<\/code>/g)].map((match) => match[1]);
      expect(keys, starter.id).toEqual(starter.fields.map((field) => field.key));
      for (const field of starter.fields.filter((candidate) => candidate.kind === 'items')) {
        for (const name of field.itemFields ?? []) expect(section, `${starter.id}.items.${name}`).toContain(`<code>${name}</code>`);
      }
      expect(visibleText(section), starter.id).toContain(starter.description);
      expect(visibleText(section), starter.id).toContain(`${starter.defaultPdf.format.toUpperCase()}, ${starter.defaultPdf.landscape ? 'landscape' : 'portrait'}.`);
    }
  });

  it('documents the section syntax the engine implements', () => {
    const engine = read('src/pdf/template.ts');
    for (const marker of ['{{#items}} ... {{/items}}', '{{^items}} ... {{/items}}', '{{#key}} ... {{/key}}', '{{^key}} ... {{/key}}']) {
      expect(engine, marker).toContain(marker);
      expect(markdown, marker).toContain(`\`${marker}\``);
    }
  });

  it('shows request bodies that the invoice and report templates accept', () => {
    const html = article('docs/pdf.html');
    const curl = codeBlocks(html, 'bash').find((block) => block.includes('/v1/pdf'));
    if (!curl) throw new Error('no curl example');
    expectValidStarterBody(curlBody(curl), 'curl');
    const header = codeBlocks(html, 'json').map((block) => JSON.parse(block) as Record<string, unknown>).find((body) => body.template === 'report');
    expect(header?.pdf).toMatchObject({ footer: expect.stringContaining('<span class="pageNumber"></span>') });
    expect(JSON.stringify(header?.pdf)).toContain('<span class=\\"totalPages\\"></span>');
    // The Node, PHP and Python quickstarts send the same invoice.
    for (const lang of ['js', 'php', 'python']) {
      const block = codeBlocks(html, lang).find((code) => code.includes('/v1/pdf') && code.includes("'invoice'") || code.includes('"invoice"'));
      expect(block, lang).toBeDefined();
      for (const key of requiredOf('invoice')) expect(block, `${lang} ${key}`).toContain(key);
    }
  });

  it('shows a response that agrees with the Free plan, pdfUnits() and the cache period', () => {
    const response = codeBlocks(article('docs/pdf.html'), 'json')
      .map((block) => JSON.parse(block) as Record<string, any>)
      .find((body) => 'credits_used' in body && 'usage' in body);
    if (!response) throw new Error('no response example');
    expect(response.credits_used).toBe(pdfUnits(response.pages));
    expect(response.usage).toMatchObject({ plan: 'free', limit: PLANS.free.monthlyImages, used: response.credits_used, cache_days: PLANS.free.cacheDays, watermark: true });
    expect(response.usage.remaining).toBe(response.usage.limit - response.usage.used);
    expect(response.usage.total_remaining).toBe(response.usage.remaining + response.usage.topup_remaining);
    expect(Date.parse(response.expires_at) - Date.parse(response.created_at)).toBe(PLANS.free.cacheDays * 86_400_000);
    expect(response.url).toBe(`${site.config.url}/i/u_hkr8wty4jftnyum3/${response.id}.pdf`);
    expect(Object.keys(response).sort()).toEqual(['bytes', 'cached', 'created_at', 'credits_used', 'expires_at', 'filename', 'id', 'pages', 'template', 'url', 'usage', 'warnings']);
  });

  it('states the cache lifetime the service sends, from HTTP_CACHE through a token', () => {
    expect(markdown).toContain('max-age=[[http.imageMaxAgeSeconds]]');
    expect(markdown).not.toMatch(/max-age=\d/);
    expect(visibleText(article('docs/pdf.html'))).toContain(`max-age=${HTTP_CACHE.imageMaxAgeSeconds}`);
  });

  it('states what bounds browser time, the page box, the free mark and saved templates, as the engine does', () => {
    const text = visibleText(article('docs/pdf.html'));
    expect(text).toContain(
      `needed more images than were left)${PDF.maxFailedRendersPerDay.free} per UTC day on ${PLANS.free.name}, ${PDF.maxFailedRendersPerDay.paid} on ${PLANS.starter.name} and ${PLANS.pro.name}, per account for POST /v1/pdf and per site for signed PDF links; then new PDFs there answer HTTP 429 until 00:00 UTC`,
    );
    expect(text).toContain(`so failures caused by the document are capped at ${PDF.maxFailedRendersPerDay.free} per UTC day on ${PLANS.free.name} and ${PDF.maxFailedRendersPerDay.paid} on ${PLANS.starter.name} and ${PLANS.pro.name}, by the plan of the account that owns the template or link`);
    expect(text).toContain(`${PLANS.starter.name} and ${PLANS.pro.name} are not affected, and stored PDFs keep working.`);
    // @page is dropped by src/pdf/css.ts, also after <!-- or -->; next to the mark the header and footer are plain text.
    expect(text).toContain('A CSS @page rule is removed, with a warning, wherever it is: also inside @media, and also after <!-- or -->');
    expect(text).not.toContain('@page { size: ... } rule does not change it');
    expect(text).not.toContain('<style> elements in them are removed');
    expect(text).toContain('in grey on a small white background of its own');
    // Saved templates go through the card validator (src/routes/studio.ts).
    expect(text).toContain(`A template saved in the dashboard is checked like a card template: at most ${LIMITS.maxHtmlBytes / 1024} KB of HTML and ${LIMITS.maxCssBytes / 1024} KB of CSS, ${formatCount(LIMITS.maxNodes)} elements, nested at most ${LIMITS.maxDepth} deep.`);
    expect(text).toContain(`Template saved in the dashboard${LIMITS.maxHtmlBytes / 1024} KB HTML`);
    // Only fonts recorded from Cloudflare's list.
    expect(text).not.toMatch(/Indic|colour emoji/);
    // The kill switch also stops stored and signed PDFs.
    expect(text).toContain('While it is off, stored PDF links (/i/...pdf) and signed PDF links answer it too.');
  });

  // Loaded through computed paths, as signed-url.ts below: they do not type-check under the Node project.
  const pagePath = fileURLToPath(new URL('../../src/pdf/page.ts', import.meta.url));
  const templatePath = fileURLToPath(new URL('../../src/pdf/template.ts', import.meta.url));
  type PageModule = {
    PLAIN_TEXT_STYLE: string;
    headerFooter(header: string | null, footer: string | null, mark: boolean, margin: { top: string; bottom: string }): { headerTemplate?: string; footerTemplate?: string };
  };
  type TemplateModule = {
    preparePdfFragment(source: string, data: Record<string, unknown>, what: 'header' | 'footer', options: { mark?: boolean }): { render(resolve: () => undefined): string; warnings: string[] };
  };

  it('says how a Free header and footer print: plain text with page numbers, in our style, cut to whole lines, as src/pdf/page.ts does', async () => {
    const text = visibleText(article('docs/pdf.html'));
    expect(text).toContain(
      `On the ${PLANS.free.name} plan they share Chrome's header and footer with the free mark, so they are printed as plain text, with page numbers, in a fixed style of ours: full width, centred, 8 pt sans-serif in dark grey.`,
    );
    expect(text).toContain('Markup, style="" attributes, classes, <style> elements, images, SVG and MathML are not used, and a warning says so.');
    expect(text).toContain(`the header in the top margin less 4 mm, the footer in the bottom margin less 9 mm, above the mark. At the ${PDF.freeMarkMinBottomMm} mm minimum bottom margin that is one line of footer, from about 16.4 mm two.`);
    expect(text).toContain(`On ${PLANS.starter.name} and ${PLANS.pro.name} they are printed as written.`);
    expect(text).toContain('The class names are case-sensitive: pagenumber prints nothing.');

    const page = (await import(pagePath)) as PageModule;
    expect(page.PLAIN_TEXT_STYLE).toMatch(/^width:100%;.*font-family:sans-serif;font-size:8pt;line-height:1\.3;color:#374151;.*text-align:center/);
    const heights = (top: string, bottom: string) => {
      const options = page.headerFooter('h', 'f', true, { top, bottom });
      return [options.headerTemplate, options.footerTemplate].map((template) => Number(/max-height:([\d.]+)pt/.exec(template ?? '')?.[1]));
    };
    const line = 8 * 1.3;
    expect(heights('4mm', `${PDF.freeMarkMinBottomMm}mm`)).toEqual([0, line]);
    expect(heights('7.7mm', '16.3mm')).toEqual([line, line]);
    expect(heights('15mm', '16.4mm')).toEqual([2 * line, 2 * line]);

    // The example footer of the docs, on Free: its text and Chrome's page numbers, nothing else, with the warning.
    const template = (await import(templatePath)) as TemplateModule;
    const body = codeBlocks(article('docs/pdf.html'), 'json').map((block) => JSON.parse(block) as Record<string, any>).find((candidate) => candidate.template === 'report');
    const footer = template.preparePdfFragment(body?.pdf.footer, body?.data, 'footer', { mark: true });
    expect(footer.render(() => undefined)).toBe(`${body?.data.title} \u00b7 Page <span class="pageNumber"></span> of <span class="totalPages"></span>`);
    expect(footer.warnings).toEqual([expect.stringContaining('On the Free plan the footer is printed as plain text next to the free mark')]);
    expect(text).toContain('"Customer Support Review, Q3 2026 · Page 2 of 7" on page 2 of a seven-page report');
  });

  it('states the size limit, the daily cap on failed renders, the failure memory, the wait for identical requests and the brake, as the engine does', () => {
    const text = visibleText(article('docs/pdf.html'));
    const mb = PDF.maxPdfBytes / (1024 * 1024);
    const minutes = PDF.failedRenderMemoryMs / 60_000;
    const waitSeconds = (2 * PDF.renderTimeoutMs + 30_000) / 1000;
    // Size limit (src/pdf/render.ts).
    expect(read('src/pdf/render.ts')).toContain('The PDF is larger than ${PDF.maxPdfBytes / (1024 * 1024)} MB');
    expect(text).toContain(`A document of more than ${PDF.maxPages} pages, or one that makes a PDF over ${mb} MB, is refused with 422 template_error and not charged.`);
    expect(text).toContain(`PDF size${mb} MB; a larger PDF is refused (HTTP 422) and not charged`);
    expect(text).not.toMatch(/Failures count nothing|A failed render is not counted/);
    // What counts toward the cap, and what never does (src/pdf/render.ts failureCause, src/pdf/guard.ts).
    expect(text).toContain(`What counts: a render that fails in the browser because of the document (more than ${PDF.maxPages} pages, a PDF over ${mb} MB, a timeout, a document the browser cannot render, or a PDF whose page count cannot be read), and a PDF that needs more images than are left (402 after rendering).`);
    expect(text).toContain('and failures of Browser Run itself: a server error that is not a timeout, a refused or unreachable call, a PDF that did not finish arriving, or the renderer being busy. Those never count.');
    expect(text).toContain(`POST /v1/pdf counts per account. Signed PDF links count per site, each site with its own ${PDF.maxFailedRendersPerDay.free} or ${PDF.maxFailedRendersPerDay.paid}: a link's render counts on its site whoever opens it, and reaching the cap stops only that site's new signed PDFs. POST /v1/pdf and your other sites are not affected.`);
    expect(text).toContain('a render takes its place under the cap before it starts, so requests sent at the same time cannot pass it together. Past it, new PDFs there answer 429 rate_limited until 00:00 UTC');
    const guard = read('src/pdf/guard.ts');
    expect(guard).toContain("`${scope.kind === 'site' ? 'pdffs' : 'pdff'}:${scope.id}:${day}`");
    expect(guard).toContain('details: { limit, scope: scope.kind, period_seconds: DAY_MS / 1000, retry_after_seconds: retryAfter }');
    expect(text).toContain('details { "limit", "scope": "account" or "site", "period_seconds", "retry_after_seconds" }');
    // The failure memory, with the message suffix guard.ts adds.
    expect(text).toContain(`For ${minutes} minutes after a render fails because of the document, or needs more images than are left, the identical request gets the same answer without being rendered and without counting again.`);
    expect(guard).toContain('(An identical request failed like this at ${clock(at)}; until ${clock(until)} it gets this answer without being rendered again.)');
    expect(text).toContain('(An identical request failed like this at HH:MM:SS UTC; until HH:MM:SS UTC it gets this answer without being rendered again.)');
    expect(text).toContain('A remembered 402 is checked again against what is left now: after a top-up or an upgrade the PDF is rendered normally');
    expect(text).toContain('Failures of Browser Run itself are never remembered');
    // Identical requests at the same time (src/pdf/service.ts).
    expect(text).toContain(`Only one of them renders. The others wait for it, up to ${waitSeconds} seconds, and get its result: the stored PDF with credits_used: 0, cached: true and X-LTC-Cache: hit, or, when it failed because of the document, the same answer.`);
    expect(read('src/pdf/service.ts')).toContain('has not finished; this request waited ${Math.round(waitedMs / 1000)} s for it and charged nothing.');
    expect(text).toContain('"An identical request started making this PDF ... s ago and has not finished; this request waited ... s for it and charged nothing."');
    // The brake: Free and tool time only, an hour's Retry-After, up to 24 hours.
    expect(guard).toContain("(b.source = 'tool' OR u.plan = 'free')");
    expect(guard).toContain('const BRAKE_RETRY_SECONDS = 3600;');
    expect(text).toContain(`When ${PLANS.free.name} accounts and the free tools together have used far more browser time than usual in the last 24 hours, new PDFs on the ${PLANS.free.name} plan and in the free tools answer 429 rate_limited, with a Retry-After of an hour. Only their own browser time counts toward this brake: PDFs made on ${PLANS.starter.name} and ${PLANS.pro.name} never engage it. It lifts by itself as that use ages out of the last 24 hours, so it can last up to 24 hours after the use stopped.`);
    expect(text).not.toContain('for a while');
    // HEAD of a signed link (src/pdf/service.ts assertPdfWouldRender).
    expect(text).toContain('HEAD never renders and never counts, but it answers what the GET would answer before rendering: 402 when not enough images are left, 429 when the site\'s daily cap on failed renders is reached');
  });

  it('says "not charged" in every error row, and which errors count toward the daily cap on failed renders', () => {
    const rows = new Map<string, string>();
    for (const match of article('docs/pdf.html').matchAll(/<tr>\n<td>(\d{3})<\/td>\n<td><code>([a-z_]+)<\/code><\/td>\n<td>([\s\S]*?)<\/td>\n<\/tr>/g)) {
      rows.set(`${match[1]} ${match[2]}`, visibleText(match[3] ?? ''));
    }
    const minutes = PDF.failedRenderMemoryMs / 60_000;
    for (const row of ['402 quota_exceeded', '422 template_error', '422 image_fetch_failed', '429 rate_limited', '500 render_failed', '504 render_timeout']) {
      expect(rows.get(row), row).toContain('Nothing was charged');
    }
    for (const [row, when] of rows) expect(when, row).not.toContain('Nothing was counted');
    expect(rows.get('402 quota_exceeded')).toContain(`A 402 after rendering counts toward the daily cap on failed renders and is remembered for ${minutes} minutes.`);
    expect(rows.get('422 template_error')).toContain(`a PDF over ${PDF.maxPdfBytes / (1024 * 1024)} MB (details.max_bytes)`);
    expect(rows.get('422 template_error')).toContain(`it counts toward the daily cap on failed renders and is remembered for ${minutes} minutes.`);
    expect(rows.get('429 rate_limited')).toContain('the daily cap on failed renders is reached, until 00:00 UTC, per account or per site');
    expect(rows.get('429 rate_limited')).toContain(`(Retry-After of an hour, see Limits); an identical request is still making this PDF after ${(2 * PDF.renderTimeoutMs + 30_000) / 1000} seconds`);
    expect(read('src/pdf/render.ts')).toContain("'The PDF renderer did not finish sending the PDF. Try again in a moment.'");
    expect(rows.get('500 render_failed')).toContain('did not finish sending the PDF ("The PDF renderer did not finish sending the PDF. Try again in a moment.")');
    expect(rows.get('500 render_failed')).toContain('A failure of Browser Run itself does not count toward the daily cap on failed renders and is not remembered; a PDF whose page count cannot be read counts.');
    expect(rows.get('504 render_timeout')).toContain(`Nothing was charged. It counts toward the daily cap on failed renders and is remembered for ${minutes} minutes.`);
  });

  it('follows the docs rules: no unresolved token, TODO or localhost, no other payment provider, prices only from the catalog', () => {
    const html = article('docs/pdf.html');
    expect(html).not.toMatch(/\[\[\s*>?\s*[a-zA-Z]/);
    for (const text of [markdown, html]) {
      expect(text).not.toMatch(/\bTODO\b|\bFIXME\b|localhost|127\.0\.0\.1/i);
      expect(text).not.toMatch(/stripe|lemon\s*squeezy/i);
    }
    expect(markdown).not.toMatch(/\$\d/);
    const catalog = new Set([...Object.values(PLANS).map((plan) => formatUsd(plan.priceUsd)), formatUsd(TOPUP.priceUsd)]);
    for (const match of visibleText(html).matchAll(/\$\d[\d,.]*/g)) expect(catalog.has(match[0].replace(/[.,]$/, ''))).toBe(true);
  });

  it('links only to pages and anchors that exist', () => {
    const urls = new Set([...site.pages.map((page) => page.url), '/openapi.yaml']);
    for (const [, href] of article('docs/pdf.html').matchAll(/<a [^>]*href="([^"]+)"/g)) {
      if (!href || /^(https?:|mailto:)/.test(href)) continue;
      const [path, anchor] = href.split('#');
      const target = path === '' ? '/docs/pdf' : (path ?? '');
      expect(urls.has(target), href).toBe(true);
      if (anchor) expect(built(target === '/' ? 'index.html' : `${target.slice(1)}.html`), href).toContain(` id="${anchor}"`);
    }
  });

  it('says how PDFs are rendered: Cloudflare Browser Run, JavaScript off, no network, cards still without a browser', () => {
    const text = visibleText(article('docs/pdf.html'));
    expect(text).toContain('Card images are still drawn without a browser');
    expect(text).toContain('which runs headless Chrome on Cloudflare\'s network');
    expect(text).toContain('Chrome prints the result with JavaScript turned off and no network access.');
    expect(text).toContain(`On the Free plan every page of a PDF carries one centred line in the bottom margin: "${PDF.freeMark}".`);
    expect(text).toContain(`at least ${PDF.freeMarkMinBottomMm} mm`);
  });
});

describe('signed PDF links', () => {
  const html = (): string => article('docs/pdf.html');
  const example = {
    secret: 'ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab',
    siteId: 's_4k2j9x0q1m7c8d5e',
    template: 'invoice',
    params: {
      invoice_number: 'INV-2026-0142',
      issue_date: 'Nov 25, 2026',
      seller_name: 'Fernhill Studio',
      buyer_name: 'Okafor & Lund Architects',
      total: '2,400.00',
      items: [{ description: 'Brand strategy workshop', quantity: '2', unit_price: '1,200.00', amount: '2,400.00' }],
      filename: 'invoice-INV-2026-0142.pdf',
    },
  };
  const printedUrl = (): string => {
    const url = codeBlocks(html(), 'text').find((block) => block.startsWith(`https://linktocard.com/v1/pdf/${example.siteId}/`));
    if (!url) throw new Error('no worked example link');
    return url.trim();
  };

  // Loaded through a computed path, as in signing-vectors.test.ts: the Worker's crypto module does not type-check under the Node project.
  const workerPath = fileURLToPath(new URL('../../src/lib/signed-url.ts', import.meta.url));
  type Worker = {
    canonicalString(pathname: string, params: Iterable<[string, string]>): string;
    signCanonical(secret: string, canonical: string): Promise<string>;
    verifySignedUrl(url: URL, secret: string): Promise<{ ok: boolean; params?: Record<string, string>; reason?: string }>;
  };

  it('prints a message and signature that the Worker computes and verifies', async () => {
    const worker = (await import(workerPath)) as Worker;
    const url = new URL(printedUrl());
    const entries = [...url.searchParams].filter(([name]) => name !== 'sig');
    const canonical = worker.canonicalString(url.pathname, entries);
    const blocks = codeBlocks(html(), 'text');
    expect(blocks).toContain(`${canonical}\n`.trimEnd());
    const signature = await worker.signCanonical(example.secret, canonical);
    expect(blocks.map((block) => block.trim())).toContain(signature);
    const verified = await worker.verifySignedUrl(url, example.secret);
    expect(verified.ok).toBe(true);
    expect(JSON.parse(verified.params?.items ?? '')).toEqual(example.params.items);
    expect(url.pathname).toBe(`/v1/pdf/${example.siteId}/${example.template}.pdf`);
    const { filename: _filename, ...data } = example.params;
    expectValidStarterBody({ template: example.template, data }, 'signed link');
  });

  it('prints a Node.js signer that produces the link when it is run', () => {
    const block = codeBlocks(html(), 'js').find((code) => code.includes('function signedPdfUrl('));
    if (!block) throw new Error('no Node.js PDF signer');
    const importLine = "import { createHmac } from 'node:crypto';\n";
    expect(block.startsWith(importLine)).toBe(true);
    // The reference card signer's message lines, with the PDF path: the two must not drift apart.
    expect(block).toContain("const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];");
    expect(read('examples/signing/sign.mjs')).toContain("const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];");
    const file = join(scratch, 'sign-pdf.mjs');
    writeFileSync(file, `${block}\nconsole.log(signedPdfUrl(${JSON.stringify({ ...example, baseUrl: 'https://linktocard.com' })}));\n`);
    const result = spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: scratch });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${printedUrl()}\n`);
  });

  const isInstalled = (command: string): boolean => {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  };

  it.skipIf(!isInstalled('php'))('prints a PHP signer that produces the same link', () => {
    const block = codeBlocks(html(), 'php').find((code) => code.includes('function signed_pdf_url('));
    if (!block) throw new Error('no PHP PDF signer');
    const params = Object.entries(example.params)
      .map(([name, value]) =>
        Array.isArray(value)
          ? `'${name}' => [${value.map((item) => `[${Object.entries(item).map(([k, v]) => `'${k}' => '${v}'`).join(', ')}]`).join(', ')}]`
          : `'${name}' => '${value}'`,
      )
      .join(', ');
    const file = join(scratch, 'sign-pdf.php');
    writeFileSync(file, `<?php\n${block}\necho signed_pdf_url('${example.secret}', 'https://linktocard.com', '${example.siteId}', '${example.template}', [${params}]), "\\n";\n`);
    const result = spawnSync('php', [file], { encoding: 'utf8', cwd: scratch });
    expect(result.stdout).toBe(`${printedUrl()}\n`);
  });

  it.skipIf(!isInstalled('python3'))('prints a Python signer that produces the same link', () => {
    const block = codeBlocks(html(), 'python').find((code) => code.includes('def signed_pdf_url('));
    if (!block) throw new Error('no Python PDF signer');
    const file = join(scratch, 'sign_pdf.py');
    writeFileSync(file, `${block}\nimport json\nprint(signed_pdf_url(${JSON.stringify(example.secret)}, "https://linktocard.com", ${JSON.stringify(example.siteId)}, ${JSON.stringify(example.template)}, json.loads(${JSON.stringify(JSON.stringify(example.params))})))\n`);
    const result = spawnSync('python3', ['-I', file], { encoding: 'utf8', cwd: scratch });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${printedUrl()}\n`);
  });

  it('states the parameter limits of signed card URLs, which the Worker applies to PDF links too', () => {
    const text = visibleText(html());
    expect(text).toContain(`at most ${LIMITS.maxDataKeys} parameters of at most ${formatCount(LIMITS.maxDataValueChars)} characters each (items included) and at most ${formatCount(LIMITS.maxSignedUrlChars)} characters in all`);
  });
});

describe('openapi.yaml (PDF paths)', () => {
  const openapi = read('openapi.yaml');
  const pdfPart = (): string => openapi.split('\n').filter((_line, i, lines) => {
    // Lines inside "# feature:pdf" blocks.
    const before = lines.slice(0, i + 1);
    return before.filter((line) => /^\s*# feature:pdf\s*$/.test(line)).length > before.filter((line) => /^\s*# \/feature:pdf\s*$/.test(line)).length;
  }).join('\n');

  it('states the PDF limits that src/config.ts enforces', () => {
    const text = pdfPart().replace(/\s+/g, ' ');
    expect(text).toContain(`A PDF of 1 to ${PDF.basePages} pages counts as ${PDF.baseUnits} images, plus 1 more for each further ${PDF.extraPagesPerUnit} pages started`);
    expect(text).toContain(`(${PDF.basePages + 1}-${PDF.basePages + PDF.extraPagesPerUnit} pages: ${pdfUnits(PDF.basePages + 1)}, ${PDF.maxPages - PDF.extraPagesPerUnit + 1}-${PDF.maxPages} pages: ${pdfUnits(PDF.maxPages)})`);
    expect(text).toContain(`A PDF may have at most ${PDF.maxPages} pages`);
    expect(text).toContain(`"${PDF.freeMark}"`);
    expect(text).toContain(`enum: [${PDF.formats.join(', ')}] default: ${PDF.defaultFormat}`);
    expect(text).toContain(`maxProperties: ${PDF.maxDataKeys}`);
    expect(text).toContain(`maxItems: ${PDF.maxItems}`);
    expect(text).toContain(`maxProperties: ${PDF.maxItemFields}`);
    expect(text).toContain(`maxLength: ${PDF.maxItemValueChars}`);
    expect(text).toContain(`maxLength: ${PDF.maxDataValueChars}`);
    expect(text).toContain(`At most ${PDF.maxDataKeys} keys`);
    expect(text).toContain(`at most ${PDF.maxDataValueChars} characters`);
    expect(text).toContain(`most ${PDF.maxItems} entries of at most ${PDF.maxItemFields} fields, each field at most ${PDF.maxItemValueChars} characters`);
    expect(text).toContain(`each at most ${PDF.maxMarginMm}mm`);
    expect(text).toContain(`or ${PDF.defaultMarginMm}mm`);
    expect(text).toContain(`at most ${PDF.maxHeaderFooterBytes / 1024} KB`);
    expect(text).toContain(`at most ${PDF.maxHtmlBytes / (1024 * 1024)} MB once placeholders are filled in`);
    expect(text).toContain(`at most ${PDF.maxCssBytes / 1024} KB`);
    expect(text).toContain(`at most ${PDF.maxFilenameChars} characters`);
    expect(text).toContain(`The request body is over ${PDF.maxRequestBodyBytes / (1024 * 1024)} MB`);
    expect(text).toContain(`more than ${PDF.maxPages} pages, HTML over ${PDF.maxHtmlBytes / (1024 * 1024)} MB, CSS over ${PDF.maxCssBytes / 1024} KB, images over ${PDF.maxAssetBytes / (1024 * 1024)} MB together`);
    expect(text).toContain(`longer than ${PDF.renderTimeoutMs / 1000} seconds`);
    expect(text).toContain(`a PDF needs at least ${PDF.baseUnits} images`);
    expect(text).toContain(`(${PDF_TEMPLATE_IDS.join(', ')})`);
    // A signed PDF link keeps the card URL rules.
    expect(text).toContain(`at most ${LIMITS.maxDataKeys} parameters, each value (items included) at most ${LIMITS.maxDataValueChars} characters`);
    expect(text).toContain(`at most ${LIMITS.maxSignedUrlChars} characters`);
  });

  it('states the size limit, the daily cap on failed renders, the failure memory, the wait and the brake, with the numbers of src/config.ts', () => {
    const text = pdfPart().replace(/\s+/g, ' ');
    const mb = PDF.maxPdfBytes / (1024 * 1024);
    const minutes = PDF.failedRenderMemoryMs / 60_000;
    const waitSeconds = (2 * PDF.renderTimeoutMs + 30_000) / 1000;
    const { free, paid } = PDF.maxFailedRendersPerDay;
    expect(text).toContain(`A PDF may have at most ${PDF.maxPages} pages and at most ${mb} MB; a longer or larger one answers 422 and is not charged.`);
    expect(text).toContain(`the header and footer are printed as plain text.`);
    expect(text).toContain(`a timeout, a document the browser cannot render, an unreadable page count), and PDFs that need more images than are left (402 after rendering), are capped at ${free} per UTC day on Free and ${paid} on Starter and Pro, per account for this endpoint and per site for signed PDF links; past the cap the answer is 429 until 00:00 UTC. Failures of Browser Run itself never count.`);
    expect(text).toContain(`Such a failure is remembered for ${minutes} minutes: the identical request gets the same answer without being rendered or counted again`);
    expect(text).toContain(`Of identical requests sent at the same time only one renders; the others wait up to ${waitSeconds} seconds for its result.`);
    expect(text).toContain('HEAD never renders and never counts. It answers what the GET would answer before rendering: 402 when not enough images are left, 429 when the site\'s daily cap on failed renders is reached or, for a Free account, the free brake is on, and the status of a remembered failure (for example 422).');
    expect(text).toContain(`images over ${PDF.maxAssetBytes / (1024 * 1024)} MB together, a PDF over ${mb} MB (details.max_bytes)`);
    expect(text).toContain(`Nothing is stored or charged. When the browser was reached (more than ${PDF.maxPages} pages, a PDF over ${mb} MB, a document it could not render), it counts toward the daily cap on failed renders, and the identical request gets the same answer for ${minutes} minutes without being rendered again.`);
    expect(text).toContain(`render_timeout. Loading or printing the document took longer than ${PDF.renderTimeoutMs / 1000} seconds. Nothing is charged; it counts toward the daily cap on failed renders, and the identical request gets the same answer for ${minutes} minutes`);
    expect(text).toContain(`A 402 after rendering counts toward the daily cap on failed renders and is remembered for ${minutes} minutes`);
    expect(text).toContain(`rate_limited. Nothing is charged. One of: a rate limit; the daily cap on failed renders (${free} per UTC day on Free, ${paid} on Starter and Pro, per account for POST /v1/pdf and per site for signed links; Retry-After is the time until 00:00 UTC`);
    expect(text).toContain('(Retry-After 3600; it lifts as that use ages out of the 24-hour window)');
    expect(text).toContain(`an identical request still making this PDF after ${waitSeconds} seconds`);
    expect(text).toContain('render_failed or internal_error. Nothing is charged. render_failed: the renderer failed, could not be reached or did not finish sending the PDF; these failures of Browser Run do not count toward the daily cap on failed renders and are not remembered.');
    expect(text).toContain('the header and footer are printed as plain text in a fixed style (their text, line breaks and the pageNumber, totalPages, date and title classes; no markup, styles or images, with a warning)');
    expect(text).not.toContain('Nothing is counted');
    expect(text).not.toContain('lose their <style> elements');
    // Both PDF paths answer with the PDF responses, which describe all of this.
    for (const name of ['PdfRateLimited', 'PdfServerError', 'PdfRenderTimeout', 'PdfUnprocessable', 'PdfQuotaExceeded']) {
      expect((pdfPart().match(new RegExp(`\\$ref: "#/components/responses/${name}"`, 'g')) ?? []).length, name).toBe(2);
    }
    expect(pdfPart()).not.toMatch(/\$ref: "#\/components\/responses\/(RateLimited|ServerError)"/);
    // Each of those responses has its own description and exactly one content block.
    for (const name of ['PdfRateLimited', 'PdfServerError', 'PdfRenderTimeout', 'PdfUnprocessable', 'PdfQuotaExceeded']) {
      const start = pdfPart().indexOf(`\n    ${name}:\n`);
      const block = pdfPart().slice(start + 1, start + 1 + (/\n {4}\S/.exec(pdfPart().slice(start + 1))?.index ?? Infinity));
      expect(block.match(/^ {6}description:/gm), name).toHaveLength(1);
      expect(block.match(/^ {6}content:/gm), name).toHaveLength(1);
    }
  });

  it('lists the request fields the API accepts', () => {
    const input = read('src/pdf/input.ts');
    const fields = [...(/export const PDF_FIELDS[^=]*= \[([^\]]*)\]/.exec(input)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    const page = [...(/const PAGE_FIELDS[^=]*= \[([^\]]*)\]/.exec(input)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(fields.length).toBeGreaterThan(5);
    const part = pdfPart();
    const schema = (name: string): string => {
      const start = part.indexOf(`\n    ${name}:\n`);
      return part.slice(start, part.indexOf('\n    ', start + name.length + 7) === -1 ? undefined : (/\n {4}\S/.exec(part.slice(start + 1))?.index ?? 0) + start + 1);
    };
    const properties = (text: string): string[] => [...text.matchAll(/^ {8}([a-z_]+):$/gm)].map((match) => match[1] ?? '');
    expect(properties(schema('PdfRequest'))).toEqual(fields);
    expect(properties(schema('PdfPage'))).toEqual(page);
  });

  it('refers only to components that each published copy defines', () => {
    for (const features of [{}, { SITE_PDF: 'on' }]) {
      const published = renderSite({ env: features, now: NOW }).openapi;
      const refs = [...published.matchAll(/\$ref: "#\/components\/([a-zA-Z]+)\/([\w-]+)"/g)];
      expect(refs.length).toBeGreaterThan(0);
      for (const [ref, kind, name] of refs) {
        const start = published.indexOf(`\n  ${kind}:\n`);
        const next = /\n {2}\S/.exec(published.slice(start + 1));
        expect(published.slice(start, next ? start + 1 + next.index : undefined), ref).toContain(`\n    ${name}:\n`);
      }
    }
  });
});

describe('the tool script (site/public/assets/js/pdf-tools.js)', () => {
  const source = read('site/public/assets/js/pdf-tools.js');
  type Tools = Record<string, any>;
  let tools: Tools;
  beforeAll(async () => {
    tools = (await import(pathToFileURL(join(ROOT, 'site/public/assets/js/pdf-tools.js')).href)) as Tools;
  });

  it('never turns what a visitor types, or what the server says, into HTML', () => {
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|eval\(|new Function/);
    const origins = new Set(source.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g));
    expect([...origins]).toEqual(['https://challenges.cloudflare.com']);
    // No frame and no window.open: the PDF is handed over as a download link.
    expect(source).not.toMatch(/<iframe|createElement\('iframe'\)|window\.open/);
    expect(source).toContain('URL.createObjectURL(blob)');
  });

  it('names the same tools and request fields as the API (src/pdf/input.ts)', () => {
    const input = read('src/pdf/input.ts');
    const list = (name: string): string[] => [...(new RegExp(`${name}[^=]*= \\[([^\\]]*)\\]`).exec(input)?.[1] ?? '').matchAll(/'([a-z_-]+)'/g)].map((match) => match[1] ?? '');
    expect(tools.TOOLS).toEqual(list('export const TOOLS'));
    const fields = list('export const TOOL_FIELDS');
    const page = list('const TOOL_PAGE_FIELDS');
    const bodies = [
      tools.toolRequest('html-to-pdf', { html: '<p>x</p>', css: 'p{}', format: 'letter', landscape: true, turnstile: 't' }),
      tools.toolRequest('invoice', { data: { seller_name: 'A' }, format: 'a4' }),
      tools.toolRequest('certificate', { data: { title: 'B' } }),
    ];
    for (const body of bodies) {
      for (const key of Object.keys(body)) expect(fields, key).toContain(key);
      for (const key of Object.keys(body.pdf ?? {})) expect(page, key).toContain(key);
    }
    expect(bodies[0]).toEqual({ tool: 'html-to-pdf', html: '<p>x</p>', css: 'p{}', pdf: { format: 'letter', landscape: true }, turnstile: 't' });
    expect(bodies[2]).toEqual({ tool: 'certificate', data: { title: 'B' } });
    expect(() => tools.toolRequest('screenshot', {})).toThrow();
    expect(tools.NOT_ENABLED).toBe('PDF rendering is not enabled yet.');
    expect(read('src/pdf/render.ts')).toContain(`'${tools.NOT_ENABLED}'`);
  });

  it('reads money in whole cents, with commas only between thousands', () => {
    expect(tools.parseMoney('1,250.00')).toBe(125000);
    expect(tools.parseMoney(' 1250.5 ')).toBe(125050);
    expect(tools.parseMoney('-40')).toBe(-4000);
    expect(tools.parseMoney('.5')).toBe(50);
    expect(tools.parseMoney('0.005')).toBe(1);
    expect(tools.parseMoney('1.0049')).toBe(100);
    expect(tools.parseMoney('1 000 000.10')).toBe(100000010);
    expect(tools.parseMoney('')).toBeNull();
    for (const bad of ['1,5', '12,34', 'abc', '1.2.3', '$5', '-', '.', '1,2345']) expect(tools.parseMoney(bad), bad).toBeNaN();
    expect(tools.formatMoney(125000)).toBe('1,250.00');
    expect(tools.formatMoney(5)).toBe('0.05');
    expect(tools.formatMoney(-123456789)).toBe('-1,234,567.89');
    expect(tools.formatMoney(0)).toBe('0.00');
    expect(tools.parseQuantity('1.5')).toBe(1.5);
    for (const bad of ['0', '-1', '1,5', 'two', '1.23456']) expect(tools.parseQuantity(bad), bad).toBeNaN();
    expect(tools.parseRate('8.5 %')).toBe(8.5);
    expect(tools.parseRate('8,5')).toBe(8.5);
    expect(tools.parseRate('101')).toBeNaN();
    expect(tools.parseRate('')).toBeNull();
  });

  it('adds up the invoice the way its FAQ says: lines, subtotal, one rate on the subtotal, each rounded to the cent once', () => {
    const sample = template('invoice').sample as Record<string, any>;
    const rows = (sample.items as Array<Record<string, string>>).map(({ description, quantity, unit_price }) => ({ description, quantity, unit_price }));
    const totals = tools.invoiceTotals(rows, '8.5');
    expect(totals.problems).toEqual([]);
    expect(totals.lines.map((line: any) => tools.formatMoney(line.amountCents))).toEqual(sample.items.map((item: any) => item.amount));
    // The starter template's own sample adds up, so "Fill in an example" reproduces it exactly.
    expect(tools.formatMoney(totals.subtotalCents)).toBe(sample.subtotal);
    expect(tools.formatMoney(totals.taxCents)).toBe(sample.tax);
    expect(tools.formatMoney(totals.totalCents)).toBe(sample.total);
    // Rounding: 1.5 x 33.33 = 49.995 -> 50.00; tax 7.25% of 50.00 = 3.625 -> 3.63.
    const rounded = tools.invoiceTotals([{ description: 'Hours', quantity: '1.5', unit_price: '33.33' }], '7.25');
    expect([rounded.lines[0].amountCents, rounded.taxCents, rounded.totalCents]).toEqual([5000, 363, 5363]);
    const empty = tools.invoiceTotals([{ description: 'A', quantity: '', unit_price: '10' }, { description: '', quantity: '', unit_price: '' }], '');
    expect(empty.lines).toHaveLength(1);
    expect(empty.lines[0].quantity).toBe('1');
    expect(empty.taxCents).toBeNull();
    const broken = tools.invoiceTotals([{ description: '', quantity: 'x', unit_price: '1,5' }], '200');
    expect(broken.problems).toEqual([
      'Line 1 needs a description.',
      'Line 1: the quantity must be a number above 0 with a dot for decimals, such as 2 or 1.5.',
      'Line 1: the unit price must be a number with a dot for decimals, such as 1250 or 1,250.00.',
      'The tax rate must be a percentage from 0 to 100, such as 8 or 8.5.',
    ]);
    expect(tools.invoiceTotals([], '').problems).toEqual(['Add at least one line with a description and a unit price.']);
  });

  it('sends the invoice template only its own keys, with display text the template prints as it is', () => {
    const values = {
      seller_name: ' Fernhill Studio ', seller_email: '', buyer_name: 'Okafor & Lund', invoice_number: 'INV-1', issue_date: '2026-11-25',
      due_date: '', currency: 'USD', tax_label: '', tax_rate: '8.5', notes: 'Thanks', unknown: 'x',
    };
    const { data, problems } = tools.invoiceData(values, [{ description: 'Design', quantity: '2', unit_price: '1200' }]);
    expect(problems).toEqual([]);
    expect(data).toEqual({
      seller_name: 'Fernhill Studio', buyer_name: 'Okafor & Lund', invoice_number: 'INV-1', currency: 'USD', notes: 'Thanks',
      issue_date: 'Nov 25, 2026', subtotal: '2,400.00', tax_label: 'Tax (8.5%)', tax: '204.00', total: '2,604.00',
      items: [{ description: 'Design', quantity: '2', unit_price: '1,200.00', amount: '2,400.00' }],
    });
    for (const key of Object.keys(data)) expect(keysOf('invoice'), key).toContain(key);
    for (const field of Object.keys(data.items[0])) expect(itemFieldsOf('invoice'), field).toContain(field);
    // Without a rate there is no subtotal and no tax line.
    const untaxed = tools.invoiceData({ ...values, tax_rate: '' }, [{ description: 'Design', quantity: '', unit_price: '50' }]).data;
    expect(untaxed).not.toHaveProperty('subtotal');
    expect(untaxed).not.toHaveProperty('tax');
    expect(untaxed.total).toBe('50.00');
    expect(tools.invoiceData({ ...values, seller_name: '', issue_date: '' }, [{ description: 'A', unit_price: '1' }]).problems).toEqual(['Fill in your business name.', 'Pick the issue date.']);
  });

  it('sends the certificate template only its own keys, with the date written out', () => {
    const { data } = tools.certificateData({
      title: 'Certificate of Completion', recipient_name: 'Amara Nwosu', achievement: 'for the workshop', issuer_name: 'Lanternworks', date: '2026-11-25', signer_name: '', format: 'a4',
    });
    expect(data).toEqual({ title: 'Certificate of Completion', recipient_name: 'Amara Nwosu', achievement: 'for the workshop', issuer_name: 'Lanternworks', date: 'November 25, 2026' });
    for (const key of Object.keys(data)) expect(keysOf('certificate'), key).toContain(key);
    for (const key of requiredOf('certificate')) expect(data, key).toHaveProperty(key);
    expect(tools.certificateData({}).problems).toHaveLength(5);
    expect([...tools.CERTIFICATE_TEXT_KEYS, 'date'].sort()).toEqual(keysOf('certificate').sort());
    expect([...tools.INVOICE_TEXT_KEYS, 'issue_date', 'due_date', 'items', 'subtotal', 'tax_label', 'tax', 'total'].sort()).toEqual(keysOf('invoice').sort());
  });

  it('names downloads, dates and sizes', () => {
    expect(tools.fileNameFor('invoice', { invoice_number: 'INV/2026 #142' })).toBe('invoice-INV-2026-142.pdf');
    expect(tools.fileNameFor('certificate', { recipient_name: 'Zoë Müller' })).toBe('certificate-Zoe-Muller.pdf');
    expect(tools.fileNameFor('certificate', { recipient_name: '***' })).toBe('certificate.pdf');
    expect(tools.fileNameFor('html-to-pdf')).toBe('document.pdf');
    expect(tools.displayDate('2026-11-25')).toBe('Nov 25, 2026');
    expect(tools.displayDate('2026-11-25', 'long')).toBe('November 25, 2026');
    expect(tools.displayDate('25/11/2026')).toBe('');
    expect(tools.isoDate(NOW, 30)).toBe('2026-12-25');
    expect(tools.readyText(2, 49_152)).toBe('Your PDF is ready: 2 pages, 48 KB.');
    expect(tools.readyText(null, 2_000_000)).toBe('Your PDF is ready: 1.9 MB.');
    expect(tools.compact({ a: ' x ', b: '', c: null, d: 0 })).toEqual({ a: 'x', d: 0 });
  });

  it('has a plain sentence for every error the tool API can send', () => {
    const body = (code: string, message = 'Server says no.', details?: Record<string, unknown>) => ({ error: { code, message, ...(details ? { details } : {}) } });
    for (const [code, status, title] of [
      ['invalid_request', 400, 'Check the form.'],
      ['template_error', 422, 'The PDF could not be made from this document.'],
      ['image_fetch_failed', 422, 'An image could not be loaded.'],
      ['payload_too_large', 413, 'That is too much for one PDF.'],
      ['render_timeout', 504, 'The PDF took too long to make.'],
      ['render_failed', 500, 'The PDF could not be made.'],
    ] as const) {
      expect(tools.describeError(status, body(code)), code).toMatchObject({ code, title, message: 'Server says no.' });
    }
    expect(tools.describeError(503, body('not_configured')).title).toBe('PDF rendering is not enabled yet.');
    expect(tools.describeError(403, body('verification_required', 'x', { site_key: '0x4AAA' }))).toMatchObject({ siteKey: '0x4AAA' });
    expect(tools.describeError(403, body('verification_required', 'x')).siteKey).toBeNull();
    const hourly = `You have made the ${PDF.toolPdfsPerHour} free PDFs for this hour. Try again in 25 minutes, or use POST /v1/pdf with an API key.`;
    const limited = tools.describeError(429, body('rate_limited', hourly), { retryAfter: 1500, now: NOW });
    expect(limited.retryAt.toISOString()).toBe('2026-11-25T12:25:00.000Z');
    expect(limited.message).toBe(hourly);
    // Without a readable Retry-After header, the busy renderer's details.retry_after_seconds still gives the time.
    const busy = tools.describeError(429, body('rate_limited', 'The PDF renderer is busy. Retry in a few seconds.', { retry_after_seconds: 10 }), { now: NOW });
    expect(busy.retryAt.toISOString()).toBe('2026-11-25T12:00:10.000Z');
    const unexplained = tools.describeError(429, body('rate_limited', ''), { retryAfter: 1500, now: NOW });
    expect(unexplained.message).toMatch(/^The free tools make a few PDFs per hour from one network\. Try again after .+ \(in about 25 minutes\)\.$/);
    expect(tools.describeError(0, null).code).toBe('network');
    expect(tools.describeError(502, '<html>').message).toMatch(/HTTP 502/);
    expect(tools.describeError(403, body('forbidden', 'Cross-site requests are not allowed.')).message).toBe('Reload the page and try again.');
    expect(tools.retryAfterSeconds('120')).toBe(120);
    expect(tools.retryAfterSeconds('Wed, 25 Nov 2026 12:10:00 GMT', NOW)).toBe(600);
    expect(tools.retryAfterSeconds('soon')).toBeNull();
  });
});

describe('the three tool pages', () => {
  const PAGES = {
    'html-to-pdf': 'tools/html-to-pdf.html',
    invoice: 'tools/invoice-generator.html',
    certificate: 'tools/certificate-generator.html',
  } as const;

  /** Names of the form's own fields (item rows are added by the script). */
  const fieldNames = (html: string): string[] => [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\sname="([a-z_]+)"/g)].map((match) => match[1] ?? '');

  it.each(Object.entries(PAGES))('%s: the form, its script, the limits, the footer mark and the switched-off state', (tool, outPath) => {
    const html = built(outPath);
    expect(html).toContain(`<form class="card card-pop pdf-form" id="pdf-form" data-tool="${tool}"`);
    expect(html).toContain('<script type="module" src="/assets/js/pdf-tools.js"></script>');
    for (const id of ['pdf-submit', 'pdf-status', 'pdf-error', 'pdf-verify', 'pdf-widget', 'pdf-verify-text', 'pdf-result', 'pdf-result-text', 'pdf-download', 'pdf-off']) {
      expect(html.match(new RegExp(` id="${id}"`, 'g')), id).toHaveLength(1);
    }
    expect(html).toContain('<p class="alert alert-warn pdf-off" id="pdf-off" role="note" hidden>PDF rendering is not enabled yet.');
    const text = visibleText(html);
    expect(text).toContain(`Up to ${PDF.toolPdfsPerHour} PDFs per hour`);
    expect(text).toContain(`\u201c${PDF.freeMark}\u201d`);
    // Paper sizes from PDF.formats, the default selected.
    const options = [...html.matchAll(/<option value="([a-z0-9]+)"( selected)?>/g)].map((match) => `${match[1]}${match[2] ? '*' : ''}`);
    expect(options).toEqual(PDF.formats.map((format) => (format === PDF.defaultFormat ? `${format}*` : format)));
    // An FAQ of its own and a "Do this via the API" section with a curl call of POST /v1/pdf that parses.
    expect((html.match(/<details class="faq-item">/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('<h3 id="api">Do this via the API</h3>');
    const curl = codeBlocks(html, 'shell').find((block) => block.includes('/v1/pdf'));
    if (!curl) throw new Error(`${outPath}: no curl example`);
    expect(curl).toContain(`curl ${site.config.url}/v1/pdf`);
    const body = curlBody(curl);
    if (tool === 'html-to-pdf') {
      expect(typeof body.html).toBe('string');
      expect(Object.keys(body).sort()).toEqual(['css', 'data', 'html', 'pdf', 'response']);
    } else {
      expect(body.template).toBe(tool);
      expectValidStarterBody(body, outPath);
    }
  });

  it('promise no way to change a starter template\'s design: its HTML and CSS are not published', () => {
    const text = visibleText(built('tools/certificate-generator.html'));
    expect(text).toContain('With an API key you can send your own HTML and CSS to POST /v1/pdf.');
    expect(text).not.toMatch(/start from the certificate template/i);
  });

  it('give each tool its own words', () => {
    const seen = new Map<string, string>();
    for (const outPath of Object.values(PAGES)) {
      const main = built(outPath).slice(built(outPath).indexOf('<main'), built(outPath).indexOf('</main>'));
      for (const match of main.matchAll(/<(?:p|li|summary)>([\s\S]*?)<\/(?:p|li|summary)>/g)) {
        const sentence = visibleText(match[1] ?? '').trim();
        if (sentence.length < 70) continue;
        expect(seen.get(sentence), `${outPath} repeats a sentence of ${seen.get(sentence)}: ${sentence}`).toBeUndefined();
        seen.set(sentence, outPath);
      }
    }
    expect(seen.size).toBeGreaterThan(40);
  });

  it('asks the invoice and certificate forms only for their template\'s keys, within the data limits', () => {
    const invoice = built(PAGES.invoice);
    const invoiceFields = fieldNames(invoice);
    const extra = ['issue_date', 'due_date', 'tax_label', 'tax_rate', 'format'];
    for (const name of invoiceFields) expect([...keysOf('invoice'), ...extra], name).toContain(name);
    for (const key of keysOf('invoice').filter((key) => !['items', 'subtotal', 'tax', 'total'].includes(key))) expect(invoiceFields, key).toContain(key);
    expect(invoice).toContain(`data-max-items="${PDF.maxItems}"`);
    expect(invoice).toContain(`data-max-item-chars="${PDF.maxItemValueChars}"`);
    const certificate = built(PAGES.certificate);
    const certificateFields = fieldNames(certificate);
    for (const key of keysOf('certificate')) expect(certificateFields, key).toContain(key);
    for (const name of certificateFields) expect([...keysOf('certificate'), 'format'], name).toContain(name);
    // A field that is sent as data may hold what the API accepts, and not more.
    for (const html of [invoice, certificate]) {
      for (const match of html.matchAll(/<(?:input|textarea)\b[^>]*\sname="([a-z_]+)"[^>]*>/g)) {
        const name = match[1] ?? '';
        const max = /\smaxlength="(\d+)"/.exec(match[0])?.[1];
        if (max) expect(Number(max), name).toBeLessThanOrEqual(PDF.maxDataValueChars);
      }
    }
    // "Fill in an example" uses the templates' own samples.
    const sample = (html: string): unknown => JSON.parse(unescapeHtml(/data-sample="([^"]*)"/.exec(html)?.[1] ?? ''));
    expect(sample(invoice)).toEqual(template('invoice').sample);
    expect(sample(certificate)).toEqual(template('certificate').sample);
  });

  it('starts the HTML to PDF form with an example that needs nothing from the network', () => {
    const html = built(PAGES['html-to-pdf']);
    const example = unescapeHtml(/<textarea class="textarea code-input pdf-html" name="html"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? '');
    const css = unescapeHtml(/<textarea class="textarea code-input pdf-css" name="css"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? '');
    expect(example).toContain('<main class="brief">');
    expect(example + css).not.toMatch(/https?:|<script|<link|@import|url\(|\son[a-z]+=/i);
    expect(css).toContain("font-family: 'Inter', sans-serif;");
  });

  it('keeps forbidden documents out of the generators, and says so', () => {
    expect(visibleText(built(PAGES.certificate))).toContain('Do not use it for diplomas, degrees, licences, official qualifications or any document of a school, university, company or government that did not issue it.');
    expect(visibleText(built(PAGES.invoice))).toContain('Making a fake invoice or receipt, or one in someone else\u2019s name, is fraud in most places and is forbidden by our Terms of service.');
    for (const outPath of Object.values(PAGES)) expect(visibleText(built(outPath)), outPath).not.toMatch(/bank statement template|utility bill template|ID card|passport/i);
  });
});

describe('privacy policy (PDF part)', () => {
  it('says when the per-IP counts are really deleted: by the daily clean-up, not shortly after the hour', () => {
    const text = visibleText(article('privacy.html'));
    expect(text).toContain('The count of PDFs per IP address or network is kept until the end of that hour; the daily clean-up then deletes it, normally within a day.');
    expect(text).not.toContain('shortly afterwards');
  });
});

describe('the three PDF guides', () => {
  const GUIDES = ['guides/html-to-pdf-n8n.html', 'guides/html-to-pdf-zapier-webhooks.html', 'guides/invoice-pdf-from-stripe-webhook.html'];

  it.each(GUIDES)('%s: an FAQ, a way to start, and only bodies the templates accept', (outPath) => {
    const html = built(outPath);
    expect(html).toContain('<main class="container page">');
    const faq = html.slice(html.indexOf('<h2 id="faq">'), html.indexOf('<h2 ', html.indexOf('<h2 id="faq">') + 1));
    expect(html.indexOf('<h2 id="faq">')).toBeGreaterThan(-1);
    expect((faq.match(/<h3 /g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/docs/pdf"');
    expect(html).not.toMatch(/localhost|127\.0\.0\.1|\bTODO\b/);
    for (const block of codeBlocks(article(outPath), 'json')) {
      const body = JSON.parse(block) as Record<string, unknown>;
      if ('template' in body) expectValidStarterBody(body, outPath);
    }
  });

  it('says plainly where the vendor\'s own documentation could not be checked', () => {
    expect(visibleText(article(GUIDES[0]!))).toContain("We could not open n8n's documentation while writing this guide");
    expect(visibleText(article(GUIDES[1]!))).toContain("We could not open Zapier's help pages while writing this guide");
    const stripe = visibleText(article(GUIDES[2]!));
    expect(stripe).toContain("We could not open Stripe's documentation while writing this guide");
    // Stripe is the customer's payment provider here, never ours.
    expect(stripe).toContain('[[site.name]]'.replace('[[site.name]]', 'Link To Card') + ' does not take part in the payment');
    expect(stripe).toContain('Our own plans are billed through Paddle');
  });

  it('prints a money formatter in the Stripe guide that works as described', () => {
    const block = codeBlocks(article(GUIDES[2]!), 'js').find((code) => code.startsWith('/** 125000 USD'));
    if (!block) throw new Error('no money() block');
    const money = new Function(`${block}\nreturn money;`)() as (minor: number, currency: string) => string;
    expect(money(125000, 'USD')).toBe('1,250.00');
    expect(money(5000, 'JPY')).toBe('5,000');
    expect(money(1999, 'eur')).toBe('19.99');
  });

  it('builds a request in the Stripe guide that the invoice template accepts', () => {
    const blocks = codeBlocks(article(GUIDES[2]!), 'js');
    const money = blocks.find((code) => code.startsWith('/** 125000 USD')) ?? '';
    const mapping = blocks.find((code) => code.includes('function invoiceData(')) ?? '';
    const invoiceData = new Function(`${money}\n${mapping}\nreturn invoiceData;`)() as (invoice: unknown) => Record<string, unknown>;
    const data = invoiceData({
      number: 'INV-7', issuedAt: '2026-11-25T10:00:00Z', currency: 'usd', customerName: 'Priya Raman', customerEmail: 'p@example.com', customerAddress: '9 Pottery Row',
      lines: [{ description: 'Mug', quantity: 2, unitAmount: 2800, amount: 5600 }], subtotal: 5600, tax: 476, total: 6076,
    });
    expectValidStarterBody({ template: 'invoice', data }, 'stripe guide');
    expect(data).toMatchObject({ issue_date: 'Nov 25, 2026', currency: 'USD', total: '60.76', tax: '4.76', items: [{ quantity: '2', unit_price: '28.00', amount: '56.00' }] });
  });
});
