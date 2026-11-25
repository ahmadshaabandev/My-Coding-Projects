// Logo marks of the fictional companies in the template samples. They are data: URIs so a sample
// renders without reaching the network, and they are plain geometry drawn for these samples, not
// anyone's real mark.

const svg = (markup: string): string => `data:image/svg+xml;base64,${btoa(markup)}`;

/** Fernhill Studio (invoice): two hills. */
export const FERNHILL_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#16181d"/>' +
    '<path d="M7 47C13 33 19 26 26 26s12 8 16 15l-3 6z" fill="#5b74ff"/><path d="M20 47c6-9 13-14 21-14 7 0 12 5 16 14z" fill="#fff"/></svg>',
);

/** Little Kiln Ceramics (receipt): a bowl on a round tile. */
export const KILN_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#0d7a5c"/>' +
    '<rect x="12" y="25" width="40" height="5" rx="2.5" fill="#fff"/><path d="M15 32h34c-1 9-8 15-17 15s-16-6-17-15z" fill="#fff"/>' +
    '<rect x="25" y="46" width="14" height="4" rx="2" fill="#fff"/></svg>',
);

/** Halden Joinery (quote): a stack of boards. */
export const HALDEN_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#b8430f"/>' +
    '<rect x="12" y="15" width="34" height="9" rx="1.5" fill="#fff"/><rect x="18" y="27.5" width="34" height="9" rx="1.5" fill="#fff"/>' +
    '<rect x="12" y="40" width="40" height="9" rx="1.5" fill="#fff"/></svg>',
);

/** Lanternworks Training (certificate): a lantern frame. */
export const LANTERN_LOGO = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 3l25 14.5v29L32 61 7 46.5v-29z" fill="#173a5e"/>' +
    '<path d="M32 17l13 7.5v15L32 47l-13-7.5v-15z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>' +
    '<circle cx="32" cy="32" r="4.5" fill="#f2b84b"/></svg>',
);
