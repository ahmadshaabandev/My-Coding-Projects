/**
 * The pictograms of the home page's tool grid (site/tools.catalog.ts names one per tool).
 *
 * Each value is the inside of an <svg viewBox="0 0 24 24">. site.css (section 13, .tool-ico)
 * draws every shape with a 2px stroke in the text colour and no fill; three classes change that:
 *   a   the stroke is the tangerine accent
 *   af  filled with the accent, no stroke
 *   k   filled with the tile's surface, so the shape covers what lies under it
 *
 * They are our own drawings of neutral things (a card, a speech bubble, a page, a plug). No
 * icon here is, or may imitate, the logo or mark of another company or app.
 */
export const TOOL_ICONS = {
  /** A card under a magnifier: the Open Graph checker. */
  inspect:
    '<rect x="2" y="3" width="15" height="11" rx="2"/><path d="M5.5 7h7M5.5 10h4"/><circle class="k a" cx="17" cy="16" r="3.5"/><path class="a" d="m19.6 18.6 2.4 2.4"/>',
  /** A card with its picture on top and text below. */
  'card-top': '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path class="af" d="M6 6h12v5.5H6z"/><path d="M7 15h10M7 18h5"/>',
  /** A post: who wrote it, then a picture. */
  post: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="7.5" cy="7.5" r="1.5"/><path d="M11.5 7.5H17"/><rect class="af" x="6" y="11.5" width="12" height="6.5" rx="1"/>',
  /** A message with an attachment hanging from a bar. */
  unfurl: '<path d="M4 5h11"/><path class="a" d="M5 10v9"/><rect x="9" y="10" width="12" height="9" rx="2"/>',
  /** A box with a coloured edge and three lines. */
  embed: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path class="a" d="M7 8v8"/><path d="M11 9h6M11 12.5h6M11 16h3"/>',
  /** A speech bubble. */
  bubble: '<path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path class="a" d="M7.5 8.5h9M7.5 12h5"/>',
  /** A card with a text cursor in it: the builder. */
  'card-type': '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M6 10h5M6 14h3"/><path class="a" d="M16 9v6M14.5 9h3M14.5 15h3"/>',
  /** Two links of a chain. */
  link: '<rect x="2" y="8" width="12" height="8" rx="4"/><rect class="a" x="10" y="8" width="12" height="8" rx="4"/>',
  /** An envelope. */
  envelope: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path class="a" d="m4 8 8 6 8-6"/>',
  /** Two pages and a plus. */
  merge: '<rect x="3" y="3" width="11" height="14" rx="2"/><path d="M17.5 7H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-1.5"/><path class="a" d="M8.5 7.5v5M6 10h5"/>',
  /** A picture: sun and hills. */
  picture: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle class="af" cx="8.5" cy="9.5" r="1.8"/><path d="m4 17 5-5 4 4 2.5-2.5L20 18"/>',
  /** A page with a cut line across it. */
  split: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path class="k a" stroke-dasharray="2 2.6" d="M1.5 12h21"/>',
  /** A page of code. */
  code: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path class="a" d="m9.5 9.5-2.5 2.5 2.5 2.5M14.5 9.5l2.5 2.5-2.5 2.5"/>',
  /** A receipt with a torn edge and a total. */
  invoice: '<path d="M5 3h14v18l-2.5-1.8L14 21l-2-1.8L10 21l-2.5-1.8L5 21z"/><path d="M8.5 8h7M8.5 11.5h7"/><path class="a" d="M12.5 15h3"/>',
  /** A sheet with a seal and its ribbon. */
  certificate:
    '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M6 8.5h7M6 12h4"/><path class="a" d="m15 16-.8 5 2.3-1.4 2.3 1.4-.8-5"/><circle class="k a" cx="16.5" cy="13.5" r="2.8"/>',
  /** A table: one row per document. */
  rows: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M3 14.75h18"/><path class="a" d="M9 4.5v15"/>',
  /** A terminal prompt. */
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path class="a" d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15H17"/>',
  /** A key. */
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path class="a" d="M10.7 12.3 20 3M15.5 7.5l3 3M18.5 4.5l2 2"/>',
  /** A plug. */
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path class="a" d="M12 17v4"/>',
  /** A bar chart. */
  chart: '<path d="M3 3v18h18"/><path class="a" d="M8 17v-5M12.5 17V7M17 17v-8"/>',
} as const;

export type ToolIconId = keyof typeof TOOL_ICONS;
