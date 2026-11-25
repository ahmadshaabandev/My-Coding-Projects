import type { PdfStarterTemplate } from './types';

// A short written report: a strong title block, the summary set apart, then numbered sections
// (heading + body) from the {{#items}} list. The section numbers are CSS counters, so they follow
// the data and nobody has to pass them in; an item without a heading continues the section above.
const html = `<main class="report">
  <header class="cover">
    <div class="headline">
      <h1 class="title">{{title}}</h1>
      <p class="subtitle">{{subtitle}}</p>
    </div>
    <dl class="meta">
      <div class="pair"><dt>Author</dt><dd>{{author}}</dd></div>
      <div class="pair"><dt>Date</dt><dd>{{date}}</dd></div>
    </dl>
  </header>

  <section class="summary">
    <h2 class="label">Summary</h2>
    <p class="text">{{summary}}</p>
  </section>

  <div class="sections">
    {{#items}}
    <section class="section">
      <h2 class="heading">{{heading}}</h2>
      <p class="body">{{body}}</p>
    </section>
    {{/items}}
  </div>

  <footer class="end">
    <p class="note">{{footer_note}}</p>
  </footer>
</main>`;

const css = `/* Report: an editorial page. Serif for reading, sans for structure, and the accent only where the
   eye should land: the bar on the title, the summary rule and the section numbers. */
:root {
  --accent: #b4233c;
  --ink: #181a1f;
  --muted: #5f6570;
  --rule: #dfe1e6;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { font-family: 'Inter', sans-serif; font-size: 9.5pt; line-height: 1.45; color: var(--ink); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
h1, h2, p, dl, dd { margin: 0; }
.label { display: block; margin-bottom: 2mm; font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }

/* Optional values drop out with their labels. */
.subtitle:empty { display: none; }
.pair:has(> dd:empty), .summary:has(> .text:empty), .section:has(> .heading:empty):has(> .body:empty) { display: none; }
.meta:not(:has(dd:not(:empty))), .end:not(:has(.note:not(:empty))) { display: none; }
.heading:empty, .body:empty { display: none; }

/* Title block: a thick accent bar on top, the title large, author and date in a narrow column
   beside it (the title takes the whole width when both are empty). */
.cover { display: flex; align-items: flex-end; gap: 10mm; margin-bottom: 10mm; padding-top: 7mm; border-top: 3.5pt solid var(--accent); break-inside: avoid; }
.headline { flex: 1 1 auto; min-width: 0; }
.title { font-family: 'Source Serif 4', serif; font-size: 32pt; font-weight: 600; line-height: 1.08; letter-spacing: -0.025em; text-wrap: balance; overflow-wrap: anywhere; }
.subtitle { margin-top: 4mm; font-size: 12.5pt; line-height: 1.4; color: var(--muted); text-wrap: balance; }
.meta { display: flex; flex: 0 0 46mm; flex-direction: column; gap: 3.4mm; padding: 0.6mm 0 1mm 5mm; border-left: 0.75pt solid var(--rule); }
.pair dt { margin-bottom: 0.6mm; font-size: 6.8pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }
.pair dd { font-weight: 600; overflow-wrap: anywhere; }

/* The summary is the one paragraph most people read: larger, serif, on an accent rule. */
.summary { margin: 0 0 10mm; padding: 1mm 0 1mm 6mm; border-left: 2pt solid var(--accent); break-inside: avoid; }
.summary .text { max-width: 150mm; font-family: 'Source Serif 4', serif; font-size: 13pt; line-height: 1.5; white-space: pre-line; overflow-wrap: anywhere; }

/* Sections: the number hangs in the left gutter; a heading never ends a page on its own and a
   paragraph keeps at least three lines on each side of a page break. */
.sections { counter-reset: section; }
.section { position: relative; padding: 5.5mm 0 6mm 17mm; border-top: 0.75pt solid var(--rule); counter-increment: section; }
.section::before { content: counter(section, decimal-leading-zero); position: absolute; left: 0; top: 4.7mm; font-family: 'Source Serif 4', serif; font-size: 19pt; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums lining-nums; color: var(--accent); }
.heading { margin-bottom: 2.4mm; font-size: 12.5pt; font-weight: 700; line-height: 1.3; letter-spacing: -0.005em; break-after: avoid; overflow-wrap: anywhere; }
.body { max-width: 150mm; font-family: 'Source Serif 4', serif; font-size: 10.5pt; line-height: 1.6; white-space: pre-line; overflow-wrap: anywhere; orphans: 3; widows: 3; }
/* An item without a heading continues the section above it, unnumbered: item fields have a length
   limit, so a long section is sent as several items. */
.section:has(> .heading:empty) { padding-top: 0; border-top: 0; counter-increment: none; }
.section:has(> .heading:empty)::before { content: none; }

.end { margin-top: 2mm; padding-top: 4mm; border-top: 0.75pt solid var(--rule); break-inside: avoid; }
.note { font-size: 8pt; line-height: 1.5; color: var(--muted); white-space: pre-line; }`;

export const report: PdfStarterTemplate = {
  id: 'report',
  name: 'Report',
  description: 'A written report: title, summary and numbered sections that flow across as many pages as they need.',
  html,
  css,
  defaultPdf: { format: 'a4', landscape: false, margin: { top: '20mm', right: '22mm', bottom: '20mm', left: '22mm' } },
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true },
    { key: 'subtitle', label: 'Subtitle', kind: 'text', required: false },
    { key: 'author', label: 'Author', kind: 'text', required: false },
    { key: 'date', label: 'Date', kind: 'text', required: false },
    { key: 'summary', label: 'Summary', kind: 'text', required: false },
    { key: 'items', label: 'Sections', kind: 'items', required: false, itemFields: ['heading', 'body'] },
    { key: 'footer_note', label: 'Footer note', kind: 'text', required: false },
  ],
  sample: {
    title: 'Customer Support Review, Q3 2026',
    subtitle: 'Ticket volume, response times and what changes in the fourth quarter',
    author: 'Lena Fischer, Support Operations',
    date: 'October 6, 2026',
    summary:
      'Ticket volume rose 18% on the second quarter, and the median first response fell from 4 h 10 min to 2 h 35 min. Three changes follow.',
    items: [
      {
        heading: 'Ticket volume',
        body: 'The team handled 4,812 tickets between July 1 and September 30, up from 4,078 in the second quarter.\n\nSeptember alone brought 1,903, after the new pricing page went live. Weekend volume stayed flat at about 9% of the total.',
      },
      {
        heading: 'Response times',
        body: 'The median first response was 2 h 35 min, down from 4 h 10 min. The 90th percentile improved less, from 19 h to 14 h, because tickets that arrive overnight still wait for the morning shift.',
      },
      {
        heading: 'Top contact reasons',
        body: 'Billing and invoices (31%), account access (22%), data exports (14%) and integrations (11%) made up more than three quarters of all tickets. The remaining 22% covered more than forty smaller topics.',
      },
      {
        heading: 'What changes in the fourth quarter',
        body: 'A billing FAQ linked from every invoice email, an evening shift from 18:00 to 02:00 on weekdays, and a monthly review of the most used saved replies.',
      },
    ],
    footer_note: 'Internal report. Figures come from the help desk export of October 1, 2026.',
  },
};
