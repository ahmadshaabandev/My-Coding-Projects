/**
 * The demo card behind the temporary /spike.* endpoints and `npm run smoke`.
 * It goes through the whole template path on purpose: placeholders, state
 * classes, the three font families, an inline <svg>, a remote <img> and a
 * remote CSS url() (both served from memory by sampleDeps, so the smoke test
 * needs no network).
 */
import { ApiError } from '../lib/errors';
import type { RenderDeps, TemplateData } from '../types';

const svgDataUri = (svg: string): string => `data:image/svg+xml;base64,${btoa(svg)}`;

const SAMPLE_ASSETS: Record<string, string> = {
  'https://assets.linktocard.test/logo.svg': svgDataUri(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#38bdf8"/><path d="M20 16h9v23h16v9H20z" fill="#0f172a"/></svg>',
  ),
  'https://assets.linktocard.test/grid.svg': svgDataUri(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="M48 0H0v48" fill="none" stroke="#ffffff" stroke-opacity="0.08"/></svg>',
  ),
};

export const SAMPLE_HTML = `<div class="card">
  <header>
    <img class="logo" src="https://assets.linktocard.test/logo.svg" width="56" height="56" alt="">
    <span class="site">{{site}}</span>
  </header>
  <main>
    <h1>{{title}}</h1>
    <p class="subtitle">{{subtitle}}</p>
  </main>
  <footer>
    <span class="langs">Żółć, Привет, Γειά σου, Tiếng Việt</span>
    <span class="runtime">
      <svg viewBox="0 0 24 24" width="28" height="28"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>
      <code>workerd</code>
    </span>
  </footer>
</div>`;

export const SAMPLE_CSS = `body {
  background-color: #0f172a;
  background-image: url(https://assets.linktocard.test/grid.svg), linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%);
  color: #f8fafc;
}
.card { display: flex; flex-direction: column; justify-content: space-between; height: 100%; padding: 64px; }
header { display: flex; align-items: center; gap: 20px; font-size: 28px; font-weight: 600; }
h1 { margin: 0; font-size: 84px; font-weight: 800; letter-spacing: -2px; line-height: 1.05; }
.len-title-m h1 { font-size: 68px; }
.len-title-l h1, .len-title-xl h1 { font-size: 52px; }
.subtitle { margin: 24px 0 0; font-size: 36px; color: #cbd5e1; }
.no-subtitle .subtitle { display: none; }
footer { display: flex; align-items: center; justify-content: space-between; font-size: 28px; }
.langs { font-family: "Source Serif 4", serif; font-style: italic; }
.runtime { display: flex; align-items: center; gap: 10px; color: #93c5fd; }
code { font-weight: 700; }`;

export function sampleData(title = 'Link To Card', subtitle = 'HTML and CSS templates, rendered inside workerd'): TemplateData {
  return { site: 'linktocard.com', title, subtitle };
}

/** Resolves the sample card's two remote images from memory; everything else is refused. */
export const sampleDeps: RenderDeps = {
  fetchImage: async (url) => {
    const dataUri = SAMPLE_ASSETS[url];
    if (!dataUri) throw new ApiError('image_fetch_failed', 'Remote images are not available on the demo endpoint.');
    return { dataUri };
  },
};
