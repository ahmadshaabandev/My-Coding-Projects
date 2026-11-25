import type { PdfStarterTemplate } from './types';
import { LANTERN_LOGO } from './sample-logos';

// A certificate of completion issued by the customer's own organisation (issuer_name). It is a
// modern, typographic page on purpose: no seal, no ribbon, no crest, nothing that imitates the
// marks of an official body or a school.
const html = `<main class="certificate">
  <aside class="panel">
    <div class="issuer">
      <span class="label">Issued by</span>
      <span class="issuer-name">{{issuer_name}}</span>
    </div>
    <h1 class="title">{{title}}</h1>
  </aside>

  <section class="body">
    <img class="logo" src="{{logo_url}}" alt="">

    <div class="award">
      <p class="label">Presented to</p>
      <p class="recipient">{{recipient_name}}</p>
      <p class="achievement">{{achievement}}</p>
    </div>

    <footer class="facts">
      <div class="fact"><span class="label">Date</span><span class="value">{{date}}</span></div>
      <div class="fact sign"><span class="value signer">{{signer_name}}</span><span class="role">{{signer_title}}</span></div>
      <div class="fact id"><span class="label">Certificate ID</span><span class="value mono">{{certificate_id}}</span></div>
    </footer>
  </section>
</main>`;

const css = `/* Certificate: landscape and full bleed. A solid accent panel carries the title and the issuer;
   the white side gives the recipient's name the room. One page, whatever the margins: the layout is
   exactly one page area tall (100vh is the page area when Chrome prints), and text too long for it
   is cut off rather than starting a second page. */
:root {
  --accent: #173a5e;
  --on-accent: #ffffff;
  --ink: #15191f;
  --muted: #5f6873;
  --rule: #d4d9df;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body { font-family: 'Inter', sans-serif; font-size: 10pt; line-height: 1.45; color: var(--ink); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
h1, p { margin: 0; }
.mono { font-family: 'JetBrains Mono', monospace; font-size: 0.94em; }
.label { display: block; font-size: 7pt; font-weight: 600; line-height: 1.3; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }

/* Optional values drop out with their labels. */
.logo[src=""], .logo:not([src]) { display: none; }
.role:empty { display: none; }
.fact:has(> .value:empty):not(.sign), .sign:has(> .signer:empty):has(> .role:empty) { display: none; }

.certificate { display: flex; height: 100vh; overflow: hidden; break-inside: avoid; }

/* The panel: issuer at the top, the title at the foot, and two thin rings off its edge in the
   empty middle, where they cross no text. */
.panel { position: relative; display: flex; flex: 0 0 36%; flex-direction: column; justify-content: space-between; padding: 16mm 13mm 17mm 16mm; overflow: hidden; background: var(--accent); color: var(--on-accent); }
.panel::before, .panel::after { content: ''; position: absolute; border-radius: 50%; border: 0.9pt solid var(--on-accent); opacity: 0.16; }
.panel::before { right: -58mm; top: calc(50% - 58mm); width: 116mm; height: 116mm; }
.panel::after { right: -40mm; top: calc(50% - 40mm); width: 80mm; height: 80mm; }
.issuer { position: relative; display: flex; flex-direction: column; gap: 1.6mm; max-width: 70mm; }
.issuer .label { color: var(--on-accent); opacity: 0.7; }
.issuer-name { font-size: 11pt; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.title { position: relative; font-family: 'Source Serif 4', serif; font-size: 32pt; font-weight: 600; line-height: 1.04; letter-spacing: -0.02em; text-wrap: balance; overflow-wrap: anywhere; }

.body { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; padding: 16mm 20mm 17mm 18mm; }
.logo { display: block; align-self: flex-start; max-width: 50mm; max-height: 16mm; }
/* The award sits in the free space between the logo and the facts, slightly above centre. */
.award { margin: auto 0; padding: 8mm 0 12mm; }
.recipient { margin: 3.5mm 0 6mm; font-family: 'Source Serif 4', serif; font-style: italic; font-weight: 400; font-size: 44pt; line-height: 1.08; letter-spacing: -0.015em; text-wrap: balance; overflow-wrap: anywhere; }
/* A short accent rule ties the name to what it was for. */
.recipient::after { content: ''; display: block; width: 26mm; height: 2pt; margin-top: 6mm; background: var(--accent); }
.achievement { max-width: 150mm; font-family: 'Source Serif 4', serif; font-size: 15pt; line-height: 1.4; color: var(--ink); text-wrap: pretty; overflow-wrap: anywhere; }

/* Date, signature and certificate ID along the foot. The signature line has room for a pen. */
.facts { display: flex; align-items: flex-end; justify-content: space-between; gap: 10mm; padding-top: 5mm; border-top: 0.75pt solid var(--rule); }
/* Date and ID keep their width; the signature line gives way. */
.fact { display: flex; flex: 0 0 auto; flex-direction: column; gap: 1.2mm; max-width: 32%; }
.fact .value { font-size: 10.5pt; font-weight: 600; overflow-wrap: anywhere; }
.sign { flex: 0 1 78mm; min-width: 36mm; max-width: none; padding-top: 11mm; text-align: center; }
.sign::before { content: ''; display: block; margin-bottom: 2.2mm; border-top: 0.9pt solid var(--ink); }
.sign .role { color: var(--muted); }
.id { text-align: right; }`;

export const certificate: PdfStarterTemplate = {
  id: 'certificate',
  name: 'Certificate of completion',
  description: 'A landscape certificate your own organisation issues for a course, workshop or programme someone completed.',
  html,
  css,
  defaultPdf: { format: 'a4', landscape: true, margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } },
  fields: [
    { key: 'title', label: 'Title', kind: 'text', required: true },
    { key: 'recipient_name', label: 'Recipient name', kind: 'text', required: true },
    { key: 'achievement', label: 'Achievement', kind: 'text', required: true },
    { key: 'issuer_name', label: 'Issuer name', kind: 'text', required: true },
    { key: 'date', label: 'Date', kind: 'text', required: true },
    { key: 'signer_name', label: 'Signer name', kind: 'text', required: false },
    { key: 'signer_title', label: 'Signer title', kind: 'text', required: false },
    { key: 'certificate_id', label: 'Certificate ID', kind: 'text', required: false },
    { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
  ],
  sample: {
    title: 'Certificate of Completion',
    recipient_name: 'Amara Nwosu',
    achievement: 'for completing the 12-hour Advanced TypeScript workshop, including the final project review.',
    issuer_name: 'Lanternworks Training',
    date: 'November 25, 2026',
    signer_name: 'Daniel Reyes',
    signer_title: 'Lead Instructor',
    certificate_id: 'LW-2026-0381',
    logo_url: LANTERN_LOGO,
  },
};
