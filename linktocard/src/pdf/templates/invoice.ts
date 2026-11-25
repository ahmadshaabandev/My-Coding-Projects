import type { PdfStarterTemplate } from './types';
import { FERNHILL_LOGO } from './sample-logos';

// The {{#items}} markers sit in text between the <tr> elements; the engine expands them on the
// parsed tree, so the browser only ever sees finished rows. The totals live in the table's footer
// so the last item row can be kept on the same page as them (see the CSS).
const html = `<main class="invoice">
  <header class="top">
    <div class="brand">
      <img class="logo" src="{{logo_url}}" alt="">
      <p class="seller">{{seller_name}}</p>
    </div>
    <h1 class="kind">Invoice</h1>
  </header>

  <section class="facts">
    <div class="fact"><span class="label">Invoice no.</span><span class="value mono">{{invoice_number}}</span></div>
    <div class="fact"><span class="label">Issued</span><span class="value">{{issue_date}}</span></div>
    <div class="fact"><span class="label">Due</span><span class="value">{{due_date}}</span></div>
    <div class="fact due"><span class="label">Amount due <span class="currency">{{currency}}</span></span><span class="value">{{total}}</span></div>
  </section>

  <section class="parties">
    <div class="party">
      <h2 class="label">Billed to</h2>
      <p class="name">{{buyer_name}}</p>
      <p class="line">{{buyer_address}}</p>
      <p class="line">{{buyer_email}}</p>
    </div>
    <div class="party">
      <h2 class="label">From</h2>
      <p class="name">{{seller_name}}</p>
      <p class="line">{{seller_address}}</p>
      <p class="line">{{seller_email}}</p>
      <p class="line tax-id"><span class="tag">Tax ID</span><span class="value">{{seller_tax_id}}</span></p>
    </div>
  </section>

  <table class="items">
    <thead>
      <tr><th class="description">Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
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

  <footer class="notes">
    <section class="note"><h2 class="label">Payment terms</h2><p class="text">{{payment_terms}}</p></section>
    <section class="note"><h2 class="label">Notes</h2><p class="text">{{notes}}</p></section>
  </footer>
</main>`;

const css = `/* Invoice: a serif headline, one strip with the four facts a payer looks for (the amount due on
   the accent), then a plain ledger. Money is display text from the caller; nothing is computed here. */
:root {
  --accent: #2a44d4;
  --on-accent: #ffffff;
  --ink: #16181d;
  --muted: #646b78;
  --rule: #dde1e8;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { font-family: 'Inter', sans-serif; font-size: 9.5pt; line-height: 1.45; color: var(--ink); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
h1, h2, p { margin: 0; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.94em; }
.label { display: block; margin-bottom: 1.6mm; font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }

/* Optional values: an element holding only an empty placeholder is :empty, so its row or label goes with it.
   (The engine leaves out an <img> without a source; the logo rule covers other renderers.) */
.logo[src=""], .logo:not([src]) { display: none; }
.line:empty, .currency:empty { display: none; }
.tax-id:has(> .value:empty), .fact:has(> .value:empty), .totals .row:has(> .value:empty), .note:has(> .text:empty) { display: none; }
.notes:not(:has(.text:not(:empty))) { display: none; }
.tax-label:empty::before { content: 'Tax'; }

/* The seller's name and the headline share a baseline. */
.top { display: flex; align-items: last baseline; justify-content: space-between; gap: 10mm; padding-bottom: 7mm; }
.brand { display: flex; flex-direction: column; align-items: flex-start; gap: 3mm; min-width: 0; }
.logo { display: block; max-width: 48mm; max-height: 14mm; }
.seller { font-size: 12pt; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; }
.kind { flex: none; font-family: 'Source Serif 4', serif; font-size: 40pt; font-weight: 600; line-height: 0.9; letter-spacing: -0.03em; }

/* The facts strip: thick rule on top, hairlines between cells; empty cells drop out and the rest share the width. */
.facts { display: flex; margin-bottom: 9mm; border-top: 2pt solid var(--ink); border-bottom: 0.75pt solid var(--rule); break-inside: avoid; }
.fact { display: flex; flex: 1 1 0; flex-direction: column; justify-content: space-between; gap: 1.4mm; min-width: 0; padding: 3.2mm 4mm 3.4mm; }
.fact:first-child { padding-left: 0; }
.fact + .fact { border-left: 0.75pt solid var(--rule); }
.fact .label { margin: 0; }
.fact .value { font-size: 10.5pt; font-weight: 600; overflow-wrap: anywhere; }
/* The amount never wraps: this cell keeps its width and the others give way. */
.fact.due { flex: 1.5 1 0; min-width: max-content; align-items: flex-end; text-align: right; border-left: 0; background: var(--accent); color: var(--on-accent); }
.fact.due .label { color: var(--on-accent); opacity: 0.8; }
.fact.due .value { font-family: 'Source Serif 4', serif; font-size: 19pt; line-height: 1; white-space: nowrap; font-variant-numeric: tabular-nums; }

.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-bottom: 10mm; break-inside: avoid; }
.party { min-width: 0; }
.party .name { margin-bottom: 0.8mm; font-size: 10.5pt; font-weight: 600; }
/* Addresses keep the caller's line breaks. */
.line { white-space: pre-line; overflow-wrap: anywhere; }
.tax-id { display: flex; gap: 2mm; margin-top: 1.2mm; }
.tax-id .tag { color: var(--muted); }

/* Line items. The header row repeats on every page and a row never splits across two. */
.items { width: 100%; border-collapse: collapse; }
.items thead { display: table-header-group; }
.items tr { break-inside: avoid; }
.items th { padding: 0 0 2.2mm; border-bottom: 1.5pt solid var(--accent); font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.14em; text-align: left; text-transform: uppercase; color: var(--muted); }
.items tbody td { padding: 2.6mm 0; border-bottom: 0.75pt solid var(--rule); vertical-align: top; }
.items .description { overflow-wrap: anywhere; }
/* Number columns take only the width they need; the description gets the rest. Tabular figures
   only in the number cells: Inter's tabular forms also widen hyphens in descriptions. */
.items .num { width: 1%; padding-left: 7mm; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.items tbody td.num:last-child { font-weight: 600; }
.items .empty td { padding: 6mm 0; text-align: center; color: var(--muted); }

/* Totals: shown once after the last row (a real footer group would repeat on every page). They
   sit in the table because Chrome keeps the rows of one table together on request, but not a table
   and the block after it: when the table starts on this page, the last item row moves to the next
   page with the totals. On later pages Chrome does not honour that and the totals may start a page
   under the repeated header. The block is an inline-block, which Chrome never splits; as a plain
   block it was sometimes broken in two by the same requests. */
.items tfoot { display: table-row-group; }
.items tbody tr:last-child { break-after: avoid; }
.items tfoot tr { break-before: avoid; }
.items tfoot td { padding: 4mm 0 0; text-align: right; }
.totals { display: inline-block; width: 78mm; text-align: left; vertical-align: top; }
.totals .row { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; padding: 1.3mm 0; }
.totals .key { color: var(--muted); }
.totals .value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals .grand { margin-top: 2mm; padding-top: 3mm; border-top: 2pt solid var(--ink); }
.totals .grand .key { font-weight: 700; color: var(--ink); }
.totals .grand .currency { font-weight: 600; color: var(--muted); }
.totals .grand .value { font-family: 'Source Serif 4', serif; font-size: 18pt; font-weight: 600; line-height: 1.1; color: var(--accent); }

.notes { display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 12mm; padding-top: 4mm; border-top: 0.75pt solid var(--rule); break-inside: avoid; }
.note .text { white-space: pre-line; overflow-wrap: anywhere; }`;

export const invoice: PdfStarterTemplate = {
  id: 'invoice',
  name: 'Invoice',
  description: 'A clean invoice: seller and buyer, line items, totals and payment terms, with the amount due on the accent colour.',
  html,
  css,
  defaultPdf: { format: 'a4', landscape: false, margin: { top: '16mm', right: '16mm', bottom: '18mm', left: '16mm' } },
  fields: [
    { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
    { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
    { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
    { key: 'seller_tax_id', label: 'Seller tax ID', kind: 'text', required: false },
    { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
    { key: 'buyer_name', label: 'Buyer name', kind: 'text', required: true },
    { key: 'buyer_address', label: 'Buyer address', kind: 'text', required: false },
    { key: 'buyer_email', label: 'Buyer email', kind: 'text', required: false },
    { key: 'invoice_number', label: 'Invoice number', kind: 'text', required: true },
    { key: 'issue_date', label: 'Issue date', kind: 'text', required: true },
    { key: 'due_date', label: 'Due date', kind: 'text', required: false },
    { key: 'currency', label: 'Currency', kind: 'text', required: false },
    { key: 'items', label: 'Line items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'unit_price', 'amount'] },
    { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
    { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
    { key: 'tax', label: 'Tax', kind: 'text', required: false },
    { key: 'total', label: 'Total', kind: 'text', required: true },
    { key: 'payment_terms', label: 'Payment terms', kind: 'text', required: false },
    { key: 'notes', label: 'Notes', kind: 'text', required: false },
  ],
  sample: {
    seller_name: 'Fernhill Studio',
    seller_address: '18 Lantern Street, Suite 4\nMarlow Bay, CA 94000',
    seller_email: 'billing@fernhill.example',
    seller_tax_id: '12-3456789',
    logo_url: FERNHILL_LOGO,
    buyer_name: 'Okafor & Lund Architects',
    buyer_address: '410 Harbour Road, Floor 3\nPort Ellis, WA 98000',
    buyer_email: 'accounts@okaforlund.example',
    invoice_number: 'INV-2026-0142',
    issue_date: 'Nov 25, 2026',
    due_date: 'Dec 25, 2026',
    currency: 'USD',
    items: [
      { description: 'Brand strategy workshop, two days on site', quantity: '2', unit_price: '1,200.00', amount: '2,400.00' },
      { description: 'Visual identity system: logo, colour and type', quantity: '1', unit_price: '3,800.00', amount: '3,800.00' },
      { description: 'Website design, page templates', quantity: '6', unit_price: '450.00', amount: '2,700.00' },
      { description: 'Business cards and letterhead, print-ready files', quantity: '1', unit_price: '650.00', amount: '650.00' },
    ],
    subtotal: '9,550.00',
    tax_label: 'Sales tax (8.5%)',
    tax: '811.75',
    total: '10,361.75',
    payment_terms: 'Due within 30 days of the issue date. Please quote the invoice number with your payment.',
    notes: 'Thank you for the work together this autumn. Questions about this invoice: billing@fernhill.example.',
  },
};
