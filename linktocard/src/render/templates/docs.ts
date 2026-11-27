import type { StarterTemplate } from './index';

const html = `<div class="card">
  <svg class="target" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="32" cy="32" r="19"/><circle cx="32" cy="32" r="6"/><path d="M32 0v64M0 32h64"/></svg>
  <div class="crumbs">
    <img class="logo" src="{{image}}" alt="">
    <span class="site">{{site}}</span>
    <span class="slash">/</span>
    <span class="tag">{{tag}}</span>
  </div>
  <div class="main">
    <div class="spec">
      <div class="measure"><span class="cap"></span><span class="rod"></span><span class="cap"></span></div>
      <div class="text">
        <h1 class="title">{{title}}</h1>
        <p class="description">{{description}}</p>
      </div>
    </div>
  </div>
  <div class="foot">
    <span class="author">{{author}}</span>
    <div class="ruler"><span class="ticks"></span><span class="ticks ticks-major"></span></div>
  </div>
</div>`;

const css = `/* Blueprint: the page title on drafting paper, measured by a dimension line, with a ruler along the bottom. */
body {
  --paper: #f4f7fc; --grid: rgba(26, 77, 224, 0.1); --ink: #0d1936; --soft: #4a5879; --accent: #1a4de0;
  background-color: var(--paper);
  /* Drafting paper from one tile: the conic gradient leaves the lower right of each 30px cell
     clear and fills the 2px strips above and left of it. One layer renders faster than two. */
  background-image: conic-gradient(from 90deg at 2px 2px, transparent 0deg, transparent 90deg, var(--grid) 90deg, var(--grid) 360deg);
  background-size: 30px 30px;
  color: var(--ink);
}
.theme-dark { --paper: #0c2a7c; --grid: rgba(255, 255, 255, 0.09); --ink: #ffffff; --soft: #bccbf6; --accent: #a4bfff; }

.card { position: relative; display: flex; flex-direction: column; height: 100%; padding: 60px 72px; }
.target { position: absolute; right: 72px; top: 50px; width: 56px; height: 56px; color: var(--accent); }

.crumbs { display: flex; align-items: center; gap: 14px; height: 36px; max-width: 900px; font-family: "JetBrains Mono", monospace; font-size: 22px; line-height: 1.3; }
.logo { flex: none; width: 36px; height: 36px; border-radius: 8px; object-fit: cover; }
.site, .tag { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.site { flex-shrink: 0; max-width: 460px; font-weight: 700; color: var(--accent); }
.slash { flex: none; color: var(--soft); }
.no-site .site, .no-tag .tag, .no-site .slash, .no-tag .slash { display: none; }
.no-site.no-tag.no-image .crumbs { display: none; }

.main { display: flex; flex-direction: column; flex: 1; justify-content: center; padding: 22px 0; }
.spec { display: flex; }
/* The dimension line is exactly as tall as the text it measures. */
.measure { display: flex; flex: none; flex-direction: column; align-items: center; width: 22px; margin-right: 30px; }
.cap { flex: none; width: 22px; height: 3px; background: var(--accent); }
.rod { flex: 1; width: 3px; background: var(--accent); }
.text { display: flex; flex-direction: column; flex: 1; min-width: 0; padding: 4px 0 8px; }
.title { margin: 0; max-width: 1000px; font-size: 88px; font-weight: 700; line-height: 1.02; letter-spacing: -0.04em; text-wrap: balance; word-break: break-word; }
.len-title-m .title { max-width: 900px; font-size: 68px; line-height: 1.05; letter-spacing: -0.035em; }
.len-title-l .title { max-width: 900px; font-size: 54px; line-height: 1.08; letter-spacing: -0.03em; }
.len-title-xl .title { max-width: 950px; font-size: 44px; line-height: 1.12; letter-spacing: -0.025em; text-wrap: wrap; line-clamp: 4; }
.description { margin: 22px 0 0; max-width: 800px; font-size: 29px; line-height: 1.4; color: var(--soft); text-wrap: balance; }
.len-description-xl .description { max-width: 900px; text-wrap: wrap; line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { margin-top: 16px; font-size: 26px; }
.no-description .description { display: none; }

.foot { display: flex; align-items: flex-end; gap: 24px; height: 30px; }
.author { flex-shrink: 0; max-width: 560px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: "JetBrains Mono", monospace; font-size: 22px; line-height: 30px; }
.no-author .author { display: none; }
.ruler { position: relative; flex: 1; height: 22px; border-bottom: 3px solid var(--accent); color: var(--accent); }
.ticks { position: absolute; left: 0; bottom: 0; width: 100%; height: 9px; background-image: repeating-linear-gradient(90deg, currentColor 0px, currentColor 2px, transparent 2px, transparent 15px); }
.ticks-major { height: 19px; background-image: repeating-linear-gradient(90deg, currentColor 0px, currentColor 2px, transparent 2px, transparent 75px); }

.size-square .card, .size-portrait .card { padding: 90px; }
.size-square .target, .size-portrait .target { right: 90px; top: 78px; width: 68px; height: 68px; }
.size-square .crumbs, .size-portrait .crumbs { height: 44px; max-width: 780px; font-size: 26px; }
.size-square .logo, .size-portrait .logo { width: 44px; height: 44px; }
.size-square .site, .size-portrait .site { max-width: 400px; }
.size-square .measure, .size-portrait .measure { margin-right: 34px; }
.size-square .title, .size-portrait .title { font-size: 112px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 88px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 68px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 56px; line-clamp: 7; }
.size-square .description, .size-portrait .description { margin-top: 30px; font-size: 36px; }
.size-square.len-title-l .description, .size-square.len-title-xl .description, .size-portrait.len-title-l .description, .size-portrait.len-title-xl .description { margin-top: 24px; font-size: 32px; }
.size-square.len-description-xl .description { line-clamp: 4; }
.size-portrait.len-description-xl .description { line-clamp: 6; }
.size-square .foot, .size-portrait .foot { height: 36px; }
.size-square .author, .size-portrait .author { max-width: 520px; font-size: 26px; line-height: 36px; }
.size-square .ruler, .size-portrait .ruler { height: 26px; }`;

export const docs: StarterTemplate = {
  id: 'docs',
  name: 'Documentation',
  description: 'Documentation page card drawn like a blueprint: a breadcrumb, the page title on a dimension line and a ruler.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Title of the documentation page.', example: 'Authentication', required: true },
    { name: 'description', description: 'One or two lines that summarise the page.', example: 'Create API keys, sign requests and rotate secrets without downtime.' },
    { name: 'author', description: 'Project, product or version name, shown in monospace next to the ruler.', example: 'Tidepool API v2' },
    { name: 'image', description: 'Absolute URL of the project logo (square works best); drawn small before the breadcrumb.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Docs domain or site name: first part of the breadcrumb.', example: 'docs.tidepool.example' },
    { name: 'tag', description: 'Section of the docs: second part of the breadcrumb.', example: 'Guides' },
    { name: 'theme', description: 'light (default, drafting paper) or dark (blueprint blue).', example: 'light' },
  ],
  sample: {
    site: 'docs.tidepool.example',
    tag: 'Guides',
    title: 'Authentication',
    description: 'Create API keys, sign requests and rotate secrets without downtime.',
    author: 'Tidepool API v2',
    theme: 'dark',
  },
  // Not the 1200x400 email preset: these cards are not laid out for it (owner decision of 2026-11-27).
  sizes: ['og', 'square', 'portrait'],
};
