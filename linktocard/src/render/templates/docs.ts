import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="page">
    <div class="crumbs">
      <svg class="icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h12l6 6v20H7z"/><path d="M19 3v6h6"/><path d="M12 17h8M12 22h8"/></svg>
      <span class="site">{{site}}</span>
      <span class="sep">/</span>
      <span class="tag">{{tag}}</span>
    </div>
    <div class="main">
      <h1 class="title">{{title}}</h1>
      <p class="description">{{description}}</p>
    </div>
    <div class="foot">
      <img class="logo" src="{{image}}" alt="">
      <span class="author">{{author}}</span>
    </div>
  </div>
</div>`;

const css = `/* Documentation: a white page on a grey desk, a breadcrumb in monospace, one blue accent. */
body { background: #e9eef5; color: #0f172a; }
.card { height: 100%; padding: 28px; }
.page { display: flex; flex-direction: column; height: 100%; padding: 40px 52px 44px; background: #ffffff; border: 2px solid #d5deea; border-radius: 24px; }

.crumbs { display: flex; align-items: center; gap: 14px; height: 36px; font-family: "JetBrains Mono", monospace; font-size: 24px; color: #475569; }
.icon { flex: none; width: 32px; height: 32px; color: #2563eb; }
.site, .tag { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.site { flex-shrink: 0; max-width: 520px; }
.sep { color: #94a3b8; }
.tag { flex-shrink: 1; color: #2563eb; }
.no-site .sep, .no-tag .sep { display: none; }

.main { display: flex; flex-direction: column; flex: 1; justify-content: center; }
.title { margin: 0; max-width: 980px; font-size: 84px; font-weight: 700; line-height: 1.06; letter-spacing: -0.03em; text-wrap: balance; }
.len-title-m .title { font-size: 68px; }
.len-title-l .title { font-size: 54px; line-height: 1.1; letter-spacing: -0.025em; }
.len-title-xl .title { font-size: 44px; line-height: 1.14; letter-spacing: -0.02em; text-wrap: wrap; line-clamp: 4; }
.description { margin: 24px 0 0; max-width: 880px; font-size: 30px; line-height: 1.4; color: #475569; text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { margin-top: 18px; font-size: 27px; }
.no-description .description { display: none; }

.foot { display: flex; align-items: center; gap: 14px; font-size: 25px; font-weight: 600; line-height: 1.3; color: #334155; }
.logo { flex: none; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }
.author { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.no-author .foot { display: none; }

.size-square .card, .size-portrait .card { padding: 32px; }
.size-square .page, .size-portrait .page { padding: 56px 60px 60px; border-radius: 28px; }
.size-square .crumbs, .size-portrait .crumbs { font-size: 27px; }
.size-square .title, .size-portrait .title { font-size: 100px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 84px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 68px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 56px; line-clamp: 6; }
.size-square .description, .size-portrait .description { margin-top: 30px; font-size: 34px; }
.size-square.len-description-xl .description, .size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .foot, .size-portrait .foot { font-size: 29px; }

.theme-dark { background: #070b14; color: #e8eef7; }
.theme-dark .page { background: #0f1727; border-color: #223049; }
.theme-dark .crumbs, .theme-dark .description { color: #94a3b8; }
.theme-dark .icon, .theme-dark .tag { color: #60a5fa; }
.theme-dark .sep { color: #55637a; }
.theme-dark .foot { color: #cbd5e1; }`;

export const docs: StarterTemplate = {
  id: 'docs',
  name: 'Documentation',
  description: 'Documentation page card: a breadcrumb, the page title and a short summary.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Title of the documentation page.', example: 'Authentication', required: true },
    { name: 'description', description: 'One or two lines that summarise the page.', example: 'Create API keys, sign requests and rotate secrets without downtime.' },
    { name: 'author', description: 'Project or product name, shown at the bottom.', example: 'Northwind API' },
    { name: 'image', description: 'Absolute URL of the project logo (square); drawn small before the name.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Docs domain or site name: first part of the breadcrumb.', example: 'docs.northwind.example' },
    { name: 'tag', description: 'Section of the docs: second part of the breadcrumb.', example: 'Guides' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    site: 'docs.northwind.example',
    tag: 'Guides',
    title: 'Authentication',
    description: 'Create API keys, sign requests and rotate secrets without downtime.',
    author: 'Northwind API',
  },
};
