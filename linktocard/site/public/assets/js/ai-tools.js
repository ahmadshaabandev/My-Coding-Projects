// The three AI image tools: /tools/og-image-generator, /tools/bulk-blog-covers and /tools/ai-qr-code-art
// (site feature "ai"). Each page's <main data-ai-tool="cover|bulk|qr"> says which tool it is.
//
// SKELETON (2026-11-28): the request builders below follow the interface contract (AI-SPEC section 9),
// and the page asks GET /api/config whether the AI routes are on. Sending previews, showing results,
// Turnstile, uploads, presets and batches are wired in the next step, against the live routes.
//
// API (every JSON error is { error: { code, message, details? } }; every route answers 503
// not_configured while AI_ENABLED is off):
//   POST /api/tools/ai/cover-preview  public  { check_id?, url?, title, description?, site_name?, style,
//                                               palette?, motif?, layout?, turnstile_token }
//                                     -> { preview_id, image_url, expires_at, background_id }
//   POST /api/ai/covers               session { background_id?, title, ..., preset_id?, logo_id?, size? }
//                                     -> { id, url, width, height, credits_used, meta_tags, usage }
//   POST /api/tools/ai/qr-preview     public  { url, style, palette?, turnstile_token }
//                                     -> { preview_id, image_url, verified, attempt }
//   POST /api/ai/qr                   session { url, style, palette?, background_id? }
//                                     -> { id, png_url, svg_url, verified, credits_used }
//   POST /api/ai/uploads              session multipart: file, purpose ('logo' | 'reference') -> { id, width, height }
//   GET/POST /api/ai/presets, PATCH/DELETE /api/ai/presets/{id}   session
//   POST /api/ai/batches              session { preset_id, source: { rss_url } | { csv } | { items } }
//   GET /api/ai/batches, GET /api/ai/batches/{id}, GET /api/ai/batches/{id}/zip
//   POST /api/tools/ai/report         public  { url_or_id, reason, email? } -> 202
//   GET /api/config                   { ai: { enabled, turnstile_site_key, styles, motifs, free_previews_per_day } } when on
//
// What the visitor types is only ever set as a form value or with textContent, never parsed as HTML.

export const API = {
  coverPreview: '/api/tools/ai/cover-preview',
  covers: '/api/ai/covers',
  qrPreview: '/api/tools/ai/qr-preview',
  qr: '/api/ai/qr',
  uploads: '/api/ai/uploads',
  presets: '/api/ai/presets',
  batches: '/api/ai/batches',
  report: '/api/tools/ai/report',
  config: '/api/config',
};

const HEX = /^#[0-9a-f]{6}$/;

/** Up to `max` colours as #rrggbb in lower case, without repeats; anything else is dropped. */
export function paletteOf(values, max) {
  const out = [];
  for (const value of values) {
    const hex = String(value ?? '').trim().toLowerCase();
    if (HEX.test(hex) && !out.includes(hex)) out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

/** A text field's value, trimmed; undefined when empty, so an optional field is left out of the request. */
function optional(value) {
  const text = String(value ?? '').trim();
  return text === '' ? undefined : text;
}

/** Drops undefined entries, so the JSON carries only what the visitor filled in. */
function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** The body of POST /api/tools/ai/cover-preview from the cover form's values. */
export function coverPreviewRequest(values, turnstileToken, maxPalette) {
  const palette = paletteOf(values.palette ?? [], maxPalette);
  return compact({
    check_id: optional(values.check_id),
    url: optional(values.url),
    title: String(values.title ?? '').trim(),
    description: optional(values.description),
    site_name: optional(values.site_name),
    style: values.style,
    palette: palette.length > 0 ? palette : undefined,
    motif: optional(values.motif),
    layout: values.layout === 'center' ? 'center' : 'left',
    turnstile_token: turnstileToken,
  });
}

/** The body of POST /api/tools/ai/qr-preview from the QR form's values. */
export function qrPreviewRequest(values, turnstileToken, maxPalette) {
  const palette = paletteOf(values.palette ?? [], maxPalette);
  return compact({
    url: String(values.url ?? '').trim(),
    style: values.style,
    palette: palette.length > 0 ? palette : undefined,
    turnstile_token: turnstileToken,
  });
}

/** The body of POST /api/tools/ai/report. */
export function reportRequest(values) {
  return compact({ url_or_id: String(values.url_or_id ?? '').trim(), reason: String(values.reason ?? '').trim(), email: optional(values.email) });
}

/* ------------------------------------------------------------------ page start (skeleton) */

async function start(main) {
  const off = document.getElementById('ai-off');
  const form = document.getElementById('ai-form');
  let ai = null;
  try {
    const response = await fetch(API.config, { credentials: 'same-origin' });
    if (response.ok) ai = (await response.json())?.ai ?? null;
  } catch {
    ai = null;
  }
  if (!ai || ai.enabled !== true) {
    if (off) off.hidden = false;
    if (form) for (const control of form.elements) control.disabled = true;
    return;
  }
  main.dataset.aiReady = 'true';
}

const aiMain = typeof document === 'undefined' ? null : document.querySelector('main[data-ai-tool]');
if (aiMain) start(aiMain);
