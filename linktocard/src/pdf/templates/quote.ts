import type { PdfStarterTemplate } from './types';
import { HALDEN_LOGO } from './sample-logos';

// A quote (estimate): the offer on the left, who makes it on the right, the dates that matter in a
// band, then the priced work and room to accept it. The {{#items}} markers sit in text between the
// <tr> elements and are expanded by the engine.
const html = `<main class="quote">
  <header class="top">
    <div class="title">
      <h1 class="kind">Quote</h1>
      <p class="number mono">{{quote_number}}</p>
    </div>
    <div class="seller">
      <img class="logo" src="{{logo_url}}" alt="">
      <p class="name">{{seller_name}}</p>
      <p class="line">{{seller_address}}</p>
      <p class="line">{{seller_email}}</p>
    </div>
  </header>

  <section class="band">
    <div class="for">
      <h2 class="label">Prepared for</h2>
      <p class="name">{{buyer_name}}</p>
      <p class="line">{{buyer_address}}</p>
    </div>
    <dl class="dates">
      <div class="date"><dt class="label">Issued</dt><dd>{{issue_date}}</dd></div>
      <div class="date valid"><dt class="label">Valid until</dt><dd>{{valid_until}}</dd></div>
    </dl>
  </section>

  <table class="items">
    <thead>
      <tr><th class="description">Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount <span class="currency">{{currency}}</span></th></tr>
    </thead>
    <tbody>
      {{#items}}
      <tr><td class="description">{{description}}</td><td class="num">{{quantity}}</td><td class="num">{{unit_price}}</td><td class="num">{{amount}}</td></tr>
      {{/items}}
      {{^items}}
      <tr class="empty"><td colspan="4">No line items.</td></tr>
      {{/items}}
    </tbody>
    <tfoot>
      <tr><td colspan="4">
        <div class="totals">
          <div class="row"><span class="key">Subtotal</span><span class="value">{{subtotal}}</span></div>
          <div class="row"><span class="key tax-label">{{tax_label}}</span><span class="value">{{tax}}</span></div>
          <div class="row grand"><span class="key">Total <span class="currency">{{currency}}</span></span><span class="value">{{total}}</span></div>
        </div>
      </td></tr>
    </tfoot>
  </table>

  <section class="fine">
    <div class="note"><h2 class="label">Terms</h2><p class="text">{{terms}}</p></div>
    <div class="note"><h2 class="label">Notes</h2><p class="text">{{notes}}</p></div>
  </section>

  <section class="accept">
    <div class="sign"><span class="label">Accepted by</span></div>
    <div class="sign"><span class="label">Signature</span></div>
    <div class="sign short"><span class="label">Date</span></div>
  </section>
</main>`;

const css = `/* Quote: the offer reads first (a big serif word and its number), the validity date is called out,
   and the priced work sits under a solid header row. Every amount is display text from the caller. */
:root {
  --accent: #b8430f;
  --on-accent: #ffffff;
  --ink: #1a1714;
  --muted: #6c655e;
  --rule: #e3ddd6;
  /* Alternate rows: a faint wash of the accent, so a new accent recolours them too. */
  --wash: color-mix(in srgb, var(--accent) 6%, #ffffff);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { font-family: 'Inter', sans-serif; font-size: 9.5pt; line-height: 1.45; color: var(--ink); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
h1, h2, p, dl, dd { margin: 0; }
.mono { font-family: 'JetBrains Mono', monospace; }
.label { display: block; margin-bottom: 1.6mm; font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }

/* Optional values: an element holding only an empty placeholder is :empty, so its label goes with it. */
.logo[src=""], .logo:not([src]) { display: none; }
.line:empty, .currency:empty { display: none; }
.date:has(> dd:empty), .totals .row:has(> .value:empty), .note:has(> .text:empty) { display: none; }
.fine:not(:has(.text:not(:empty))) { display: none; }
.tax-label:empty::before { content: 'Tax'; }

.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12mm; margin-bottom: 10mm; }
.title { flex: none; }
.kind { font-family: 'Source Serif 4', serif; font-size: 46pt; font-weight: 600; line-height: 0.88; letter-spacing: -0.035em; }
/* The number hangs under the word on a short accent rule. */
.number { display: inline-block; margin-top: 4mm; padding-top: 2mm; border-top: 2pt solid var(--accent); font-size: 10pt; font-weight: 700; letter-spacing: 0.02em; }
.seller { display: flex; flex-direction: column; align-items: flex-end; min-width: 0; max-width: 92mm; text-align: right; }
.logo { display: block; max-width: 44mm; max-height: 13mm; margin-bottom: 3mm; }
.seller .name { font-size: 11pt; font-weight: 700; line-height: 1.3; }
.line { white-space: pre-line; overflow-wrap: anywhere; color: var(--muted); }

/* Who it is for, and how long the offer stands. */
.band { display: flex; align-items: stretch; justify-content: space-between; gap: 10mm; margin-bottom: 9mm; padding: 5mm 0; border-top: 0.75pt solid var(--rule); border-bottom: 0.75pt solid var(--rule); break-inside: avoid; }
.for { min-width: 0; }
.for .name { margin-bottom: 0.6mm; font-size: 12pt; font-weight: 700; line-height: 1.3; }
.for .line { color: var(--ink); }
.dates { display: flex; flex: none; gap: 3mm; align-items: stretch; }
.date { display: flex; flex-direction: column; justify-content: center; padding: 2.6mm 4.5mm; border: 0.75pt solid var(--rule); border-radius: 2mm; }
.date .label { margin-bottom: 1mm; }
.date dd { font-size: 10.5pt; font-weight: 600; white-space: nowrap; }
.date.valid { border-color: var(--accent); background: var(--wash); }
.date.valid .label, .date.valid dd { color: var(--accent); }

/* Items: a solid header row that repeats on every page; rows never split. */
.items { width: 100%; border-collapse: collapse; }
.items thead { display: table-header-group; }
.items tr { break-inside: avoid; }
.items th { padding: 2.4mm 3mm; background: var(--accent); color: var(--on-accent); font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.14em; text-align: left; text-transform: uppercase; }
.items th .currency { letter-spacing: 0.08em; opacity: 0.8; }
.items tbody td { padding: 2.6mm 3mm; border-bottom: 0.75pt solid var(--rule); vertical-align: top; }
.items tbody tr:nth-child(even) td { background: var(--wash); }
.items .description { overflow-wrap: anywhere; }
/* Tabular figures only in the number cells: Inter's tabular forms also widen hyphens in descriptions. */
.items .num { width: 1%; padding-left: 6mm; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.items tbody td.num:last-child { font-weight: 600; }
.items .empty td { padding: 6mm 3mm; text-align: center; color: var(--muted); }

/* Totals: shown once, inside the table and as an inline-block, so the last item row can stay with
   them and they are never split (the invoice template explains what Chrome honours here). */
.items tfoot { display: table-row-group; }
.items tbody tr:last-child { break-after: avoid; }
.items tfoot tr { break-before: avoid; }
.items tfoot td { padding: 4mm 3mm 0 0; text-align: right; }
.totals { display: inline-block; width: 80mm; text-align: left; vertical-align: top; }
.totals .row { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; padding: 1.3mm 0; }
.totals .key { color: var(--muted); }
.totals .value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals .grand { margin-top: 2mm; padding-top: 3mm; border-top: 2pt solid var(--ink); }
.totals .grand .key { font-weight: 700; color: var(--ink); }
.totals .grand .currency { font-weight: 600; color: var(--muted); }
.totals .grand .value { font-family: 'Source Serif 4', serif; font-size: 18pt; font-weight: 600; line-height: 1.1; color: var(--accent); }

.fine { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 11mm; break-inside: avoid; }
.note .text { white-space: pre-line; overflow-wrap: anywhere; }

/* Room to accept the quote on paper: three lines to write on. */
.accept { display: flex; gap: 8mm; margin-top: 14mm; break-inside: avoid; }
.sign { flex: 2 1 0; }
.sign.short { flex: 1 1 0; }
.sign::before { content: ''; display: block; height: 11mm; margin-bottom: 1.6mm; border-bottom: 0.9pt solid var(--ink); }`;

export const quote: PdfStarterTemplate = {
  id: 'quote',
  name: 'Quote (estimate)',
  description: 'A priced offer before the work starts: line items, totals, how long the quote is valid, terms and lines to accept it.',
  html,
  css,
  defaultPdf: { format: 'a4', landscape: false, margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' } },
  fields: [
    { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
    { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
    { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
    { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
    { key: 'buyer_name', label: 'Prepared for', kind: 'text', required: true },
    { key: 'buyer_address', label: 'Buyer address', kind: 'text', required: false },
    { key: 'quote_number', label: 'Quote number', kind: 'text', required: true },
    { key: 'issue_date', label: 'Issue date', kind: 'text', required: true },
    { key: 'valid_until', label: 'Valid until', kind: 'text', required: false },
    { key: 'currency', label: 'Currency', kind: 'text', required: false },
    { key: 'items', label: 'Line items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'unit_price', 'amount'] },
    { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
    { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
    { key: 'tax', label: 'Tax', kind: 'text', required: false },
    { key: 'total', label: 'Total', kind: 'text', required: true },
    { key: 'terms', label: 'Terms', kind: 'text', required: false },
    { key: 'notes', label: 'Notes', kind: 'text', required: false },
  ],
  sample: {
    seller_name: 'Halden Joinery',
    seller_address: 'Unit 6, Millbrook Yard\nKestrel Falls, ME 04000',
    seller_email: 'quotes@haldenjoinery.example',
    logo_url: HALDEN_LOGO,
    buyer_name: 'Sam and Ivy Moreau',
    buyer_address: '22 Orchard Close\nKestrel Falls, ME 04000',
    quote_number: 'Q-2026-031',
    issue_date: 'Nov 25, 2026',
    valid_until: 'Dec 24, 2026',
    currency: 'USD',
    items: [
      { description: 'Oak kitchen cabinets, made to measure', quantity: '1', unit_price: '8,400.00', amount: '8,400.00' },
      { description: 'Solid walnut worktop, 3.2 m, oiled', quantity: '1', unit_price: '1,950.00', amount: '1,950.00' },
      { description: 'Fitting and installation, per day', quantity: '4', unit_price: '520.00', amount: '2,080.00' },
      { description: 'Removal and disposal of the old units', quantity: '1', unit_price: '380.00', amount: '380.00' },
    ],
    subtotal: '12,810.00',
    tax_label: 'Sales tax (5.5%)',
    tax: '704.55',
    total: '13,514.55',
    terms: 'A 50% deposit books the workshop dates; the balance is due on completion. Prices include materials and delivery.',
    notes: 'Measurements were taken on site on November 18. Final dimensions are confirmed with you before cutting.',
  },
};
