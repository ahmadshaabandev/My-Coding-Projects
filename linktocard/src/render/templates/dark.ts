import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="top">
    <svg class="prompt" viewBox="0 0 40 28" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l10 10L4 24"/><path d="M20 24h16"/></svg>
    <span class="tag">{{tag}}</span>
  </div>
  <div class="main">
    <h1 class="title">{{title}}</h1>
    <p class="description">{{description}}</p>
  </div>
  <div class="meta">
    <img class="logo" src="{{image}}" alt="">
    <span class="author">{{author}}</span>
    <span class="slash">/</span>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* Dark, high contrast, monospace details. Always dark: there is no light variant. */
body {
  background-color: #0a0d14;
  background-image:
    radial-gradient(circle at 100% 0%, rgba(56, 189, 248, 0.22) 0%, rgba(99, 102, 241, 0.12) 32%, rgba(10, 13, 20, 0) 62%),
    linear-gradient(rgba(255, 255, 255, 0.045) 1px, rgba(255, 255, 255, 0) 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, rgba(255, 255, 255, 0) 1px);
  background-size: 100% 100%, 48px 48px, 48px 48px;
  color: #f8fafc;
}
.card { display: flex; flex-direction: column; height: 100%; padding: 64px 72px; border-top: 6px solid #38bdf8; }

.top { display: flex; align-items: center; gap: 16px; height: 32px; color: #38bdf8; }
.prompt { flex: none; width: 40px; height: 28px; }
.tag { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: "JetBrains Mono", monospace; font-size: 24px; letter-spacing: 0.02em; }

.main { display: flex; flex-direction: column; flex: 1; justify-content: flex-end; }
.title { margin: 0; max-width: 1000px; font-size: 84px; font-weight: 800; line-height: 1.04; letter-spacing: -0.035em; text-wrap: balance; }
.len-title-m .title { font-size: 70px; }
.len-title-l .title { font-size: 56px; line-height: 1.08; letter-spacing: -0.03em; }
.len-title-xl .title { font-size: 46px; line-height: 1.12; letter-spacing: -0.025em; text-wrap: wrap; line-clamp: 4; }
.description { margin: 24px 0 0; max-width: 900px; font-size: 30px; line-height: 1.4; color: #94a3b8; text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { margin-top: 18px; font-size: 27px; }
.no-description .description { display: none; }

.meta { display: flex; align-items: center; gap: 14px; margin-top: 40px; font-family: "JetBrains Mono", monospace; font-size: 24px; line-height: 1.3; }
.logo { flex: none; width: 40px; height: 40px; border-radius: 8px; object-fit: cover; }
.author, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { flex-shrink: 1; color: #e2e8f0; }
.slash { color: #475569; }
.site { flex-shrink: 0; max-width: 440px; color: #94a3b8; }
.no-author .slash, .no-site .slash { display: none; }
.no-author.no-site .meta { display: none; }

.size-square .card, .size-portrait .card { padding: 84px 88px; }
.size-square .title, .size-portrait .title { font-size: 104px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 88px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 70px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 58px; line-clamp: 6; }
.size-square .description, .size-portrait .description { margin-top: 30px; font-size: 34px; }
.size-square.len-description-xl .description, .size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .meta, .size-portrait .meta { margin-top: 56px; font-size: 28px; }
.size-square .tag, .size-portrait .tag { font-size: 28px; }`;

export const dark: StarterTemplate = {
  id: 'dark',
  name: 'Dark',
  description: 'High-contrast dark card for developer and technical content, with monospace details.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Headline.', example: 'Zero-downtime schema migrations, step by step', required: true },
    { name: 'description', description: 'One or two lines under the headline.', example: 'Expand, backfill, contract: the pattern behind every safe change.' },
    { name: 'author', description: 'Author, team or project name, shown in monospace in the bottom line.', example: 'Tomas Reyes' },
    { name: 'image', description: 'Absolute URL of a logo or avatar; drawn as a small rounded square before the author.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Domain or site name, shown after the author.', example: 'stackjournal.example' },
    { name: 'tag', description: 'Short label next to the prompt mark at the top, in monospace.', example: 'postgres' },
  ],
  sample: {
    tag: 'postgres',
    title: 'Zero-downtime schema migrations, step by step',
    description: 'Expand, backfill, contract: the pattern behind every safe change.',
    author: 'Tomas Reyes',
    site: 'stackjournal.example',
  },
};
