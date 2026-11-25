import type { PdfStarterTemplate } from './types';
import { KILN_LOGO } from './sample-logos';

// A till slip laid on the page: one centred column, facts on dotted leaders, the total paid at the
// foot. The {{#items}} markers sit in text between the <tr> elements and are expanded by the engine.

/**
 * clip-path polygon for a torn edge of `teeth` triangles pointing up (top edge) or down (bottom).
 * A polygon stays vector in Chrome's PDF output; the gradient version of the same edge is
 * rasterised and made the file twenty times larger.
 */
function tornEdge(teeth: number, pointing: 'up' | 'down'): string {
  const [base, tip] = pointing === 'up' ? ['100%', '0'] : ['0', '100%'];
  const points = [`0 ${base}`];
  for (let tooth = 0; tooth < teeth; tooth++) {
    const x = (fraction: number): string => `${Number((((tooth + fraction) / teeth) * 100).toFixed(3))}%`;
    points.push(`${x(0.5)} ${tip}`, `${x(1)} ${base}`);
  }
  return `polygon(${points.join(', ')})`;
}

const html = `<main class="receipt">
  <div class="slip">
    <header class="head">
      <img class="logo" src="{{logo_url}}" alt="">
      <p class="seller">{{seller_name}}</p>
      <p class="line">{{seller_address}}</p>
      <p class="line">{{seller_email}}</p>
    </header>

    <h1 class="kind">Receipt</h1>

    <dl class="facts">
      <div class="fact"><dt>Receipt no.</dt><dd class="mono">{{receipt_number}}</dd></div>
      <div class="fact"><dt>Date</dt><dd>{{date}}</dd></div>
      <div class="fact"><dt>Paid by</dt><dd>{{buyer_name}}</dd></div>
      <div class="fact"><dt>Payment method</dt><dd>{{payment_method}}</dd></div>
    </dl>

    <table class="items">
      <thead>
        <tr><th class="description">Item</th><th class="num">Qty</th><th class="num">Amount <span class="currency">{{currency}}</span></th></tr>
      </thead>
      <tbody>
        {{#items}}
        <tr><td class="description">{{description}}</td><td class="num">{{quantity}}</td><td class="num">{{amount}}</td></tr>
        {{/items}}
        {{^items}}
        <tr class="empty"><td colspan="3">No items.</td></tr>
        {{/items}}
      </tbody>
      <tfoot>
        <tr><td colspan="3">
          <div class="totals">
            <div class="row"><span class="key">Subtotal</span><span class="value">{{subtotal}}</span></div>
            <div class="row"><span class="key tax-label">{{tax_label}}</span><span class="value">{{tax}}</span></div>
            <div class="row paid"><span class="key">Total paid <span class="currency">{{currency}}</span></span><span class="value">{{total}}</span></div>
          </div>
        </td></tr>
      </tfoot>
    </table>

    <p class="notes">{{notes}}</p>
  </div>
</main>`;

const css = `/* Receipt: a paper slip with torn edges in the middle of the page. Every value is display text
   from the caller; nothing is computed here. */
:root {
  --accent: #0d7a5c;
  --ink: #17191c;
  --muted: #646a72;
  --rule: #cfd3d8;
  --slip: #f5f4f0;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { font-family: 'Inter', sans-serif; font-size: 9.5pt; line-height: 1.45; color: var(--ink); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
h1, p, dl, dd { margin: 0; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.94em; }

/* Optional values: an element holding only an empty placeholder is :empty, so its row goes with it. */
.logo[src=""], .logo:not([src]) { display: none; }
.line:empty, .currency:empty, .notes:empty { display: none; }
.fact:has(> dd:empty), .totals .row:has(> .value:empty) { display: none; }
.tax-label:empty::before { content: 'Tax'; }

/* The slip. Its edges are teeth cut from the same colour, drawn just outside it (the padding
   around the slip keeps them on the page); a slip that runs over several pages keeps its padding
   on each one. */
.receipt { padding: 4mm 0; }
.slip { position: relative; width: 122mm; margin: 0 auto; padding: 11mm 11mm 12mm; background: var(--slip); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.slip::before, .slip::after { content: ''; position: absolute; left: 0; right: 0; height: 2.4mm; background: var(--slip); }
.slip::before { top: -2.4mm; clip-path: ${tornEdge(40, 'up')}; }
.slip::after { bottom: -2.4mm; clip-path: ${tornEdge(40, 'down')}; }

.head { display: flex; flex-direction: column; align-items: center; text-align: center; }
.logo { display: block; max-width: 40mm; max-height: 14mm; margin-bottom: 3.5mm; }
.seller { font-size: 12pt; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; }
.line { white-space: pre-line; overflow-wrap: anywhere; color: var(--muted); }
.seller + .line { margin-top: 1mm; }

/* The headline sits between two perforations: thick dotted borders, which stay vector in the PDF. */
.kind { margin: 7mm 0 6mm; padding: 3.6mm 0 4mm; border-top: 2.4pt dotted var(--rule); border-bottom: 2.4pt dotted var(--rule); font-family: 'Source Serif 4', serif; font-size: 24pt; font-weight: 600; line-height: 1; letter-spacing: -0.01em; text-align: center; color: var(--accent); }

/* Facts on dotted leaders, like a till print-out. */
.facts { display: flex; flex-direction: column; gap: 1.6mm; margin-bottom: 7mm; }
.fact { display: flex; align-items: baseline; gap: 2mm; }
.fact dt { flex: none; color: var(--muted); }
.fact::after { content: ''; order: 1; flex: 1 1 auto; min-width: 6mm; border-bottom: 0.9pt dotted var(--rule); transform: translateY(-0.8mm); }
.fact dd { order: 2; max-width: 70%; font-weight: 600; text-align: right; overflow-wrap: anywhere; }

/* Items. The header repeats on every page and a row never splits across two. */
.items { width: 100%; border-collapse: collapse; }
.items thead { display: table-header-group; }
.items tr { break-inside: avoid; }
.items th { padding: 0 0 2mm; border-bottom: 1.2pt solid var(--ink); font-size: 6.8pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.14em; text-align: left; text-transform: uppercase; color: var(--muted); }
.items th .currency { letter-spacing: 0.08em; }
.items tbody td { padding: 2.2mm 0; border-bottom: 0.75pt dashed var(--rule); vertical-align: top; }
.items .description { overflow-wrap: anywhere; }
/* Tabular figures only in the number cells: Inter's tabular forms also widen hyphens in descriptions. */
.items .num { width: 1%; padding-left: 6mm; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.items .empty td { padding: 5mm 0; text-align: center; color: var(--muted); }

/* Totals are shown once, inside the table and as an inline-block, so the last item row can stay
   with them and they are never split (the invoice template explains what Chrome honours here). */
.items tfoot { display: table-row-group; }
.items tbody tr:last-child { break-after: avoid; }
.items tfoot tr { break-before: avoid; }
.items tfoot td { padding: 3mm 0 0; }
.totals { display: inline-block; width: 100%; vertical-align: top; }
.totals .row { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; padding: 1.1mm 0; }
.totals .key { color: var(--muted); }
.totals .value { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.totals .paid { margin-top: 2.5mm; padding: 3.5mm 0 0; border-top: 2pt solid var(--ink); }
.totals .paid .key { font-weight: 700; color: var(--ink); }
.totals .paid .currency { font-weight: 600; color: var(--muted); }
.totals .paid .value { font-family: 'Source Serif 4', serif; font-size: 20pt; font-weight: 600; line-height: 1.05; color: var(--accent); }

.notes { margin-top: 8mm; padding-top: 4mm; border-top: 0.75pt dashed var(--rule); font-family: 'Source Serif 4', serif; font-style: italic; font-size: 10.5pt; line-height: 1.5; text-align: center; white-space: pre-line; overflow-wrap: anywhere; break-inside: avoid; }`;

export const receipt: PdfStarterTemplate = {
  id: 'receipt',
  name: 'Receipt',
  description: 'A proof of payment laid out like a till slip: what was bought, how it was paid and the total paid.',
  html,
  css,
  defaultPdf: { format: 'a4', landscape: false, margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' } },
  fields: [
    { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
    { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
    { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
    { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
    { key: 'receipt_number', label: 'Receipt number', kind: 'text', required: true },
    { key: 'date', label: 'Date', kind: 'text', required: true },
    { key: 'buyer_name', label: 'Paid by', kind: 'text', required: false },
    { key: 'payment_method', label: 'Payment method', kind: 'text', required: false },
    { key: 'currency', label: 'Currency', kind: 'text', required: false },
    { key: 'items', label: 'Items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'amount'] },
    { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
    { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
    { key: 'tax', label: 'Tax', kind: 'text', required: false },
    { key: 'total', label: 'Total paid', kind: 'text', required: true },
    { key: 'notes', label: 'Notes', kind: 'text', required: false },
  ],
  sample: {
    seller_name: 'Little Kiln Ceramics',
    seller_address: '9 Pottery Row\nAshford Hollow, VT 05000',
    seller_email: 'hello@littlekiln.example',
    logo_url: KILN_LOGO,
    receipt_number: 'R-10482',
    date: 'Nov 25, 2026, 3:42 PM',
    buyer_name: 'Priya Raman',
    payment_method: 'Card ending 4417',
    currency: 'USD',
    items: [
      { description: 'Stoneware mug, speckled oat glaze', quantity: '2', amount: '56.00' },
      { description: 'Serving bowl, large, celadon', quantity: '1', amount: '68.00' },
      { description: 'Saturday wheel-throwing class', quantity: '1', amount: '45.00' },
    ],
    subtotal: '169.00',
    tax_label: 'Sales tax (6%)',
    tax: '10.14',
    total: '179.14',
    notes: 'Thank you for shopping small. Pieces can be exchanged within 30 days with this receipt.',
  },
};
