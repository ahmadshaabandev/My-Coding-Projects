import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="rings"><span class="ring ring-1"></span><span class="ring ring-2"></span><span class="ring ring-3"></span></div>
  <div class="main">
    <span class="tag">{{tag}}</span>
    <h1 class="title">{{title}}</h1>
    <p class="description">{{description}}</p>
  </div>
  <div class="brand">
    <img class="logo" src="{{image}}" alt="">
    <span class="author">{{author}}</span>
    <span class="dot"></span>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* Announcement: centred, bold, on a colour field with rings rising from the bottom edge. */
body { background: linear-gradient(180deg, #4338ca 0%, #6d28d9 100%); color: #ffffff; }
.card { position: relative; display: flex; flex-direction: column; align-items: center; height: 100%; padding: 64px 80px; text-align: center; }

.rings { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; }
.ring { position: absolute; left: 50%; top: 100%; border: 2px solid rgba(255, 255, 255, 0.2); border-radius: 50%; transform: translate(-50%, -50%); }
.ring-1 { width: 520px; height: 520px; }
.ring-2 { width: 920px; height: 920px; }
.ring-3 { width: 1320px; height: 1320px; }

.main { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; }
.tag { margin-bottom: 28px; padding: 8px 20px; border: 2px solid rgba(255, 255, 255, 0.45); border-radius: 999px; max-width: 720px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 21px; font-weight: 600; letter-spacing: 0.1em; line-height: 1.3; text-transform: uppercase; }
.no-tag .tag { display: none; }
.title { margin: 0; max-width: 980px; font-size: 88px; font-weight: 800; line-height: 1.04; letter-spacing: -0.035em; text-wrap: balance; }
.len-title-m .title { font-size: 72px; }
.len-title-l .title { font-size: 56px; line-height: 1.08; letter-spacing: -0.03em; }
.len-title-xl .title { font-size: 46px; line-height: 1.12; letter-spacing: -0.025em; text-wrap: wrap; line-clamp: 4; }
.description { margin: 26px 0 0; max-width: 820px; font-size: 31px; line-height: 1.4; color: #ddd6fe; text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { margin-top: 20px; font-size: 27px; }
.no-description .description { display: none; }

.brand { position: relative; display: flex; align-items: center; gap: 14px; margin-top: 24px; font-size: 26px; line-height: 1.3; }
.logo { flex: none; width: 44px; height: 44px; border-radius: 10px; object-fit: cover; }
.author, .site { max-width: 460px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { font-weight: 600; }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: rgba(255, 255, 255, 0.55); }
.site { color: #ddd6fe; }
.no-author .dot, .no-site .dot { display: none; }
.no-author.no-site .brand { display: none; }

.size-square .card, .size-portrait .card { padding: 88px 80px; }
.size-square .ring-1, .size-portrait .ring-1 { width: 640px; height: 640px; }
.size-square .ring-2, .size-portrait .ring-2 { width: 1120px; height: 1120px; }
.size-square .ring-3, .size-portrait .ring-3 { width: 1600px; height: 1600px; }
.size-square .tag, .size-portrait .tag { margin-bottom: 36px; font-size: 24px; }
.size-square .title, .size-portrait .title { font-size: 108px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 88px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 70px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 58px; line-clamp: 6; }
.size-square .description, .size-portrait .description { margin-top: 34px; font-size: 35px; }
.size-square.len-description-xl .description, .size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .brand, .size-portrait .brand { font-size: 30px; }

.theme-dark { background: linear-gradient(180deg, #0d0a1f 0%, #1c1440 100%); }
.theme-dark .ring { border-color: rgba(167, 139, 250, 0.22); }
.theme-dark .tag { border-color: rgba(167, 139, 250, 0.6); color: #c4b5fd; }
.theme-dark .description, .theme-dark .site { color: #b8b2d6; }`;

export const launch: StarterTemplate = {
  id: 'launch',
  name: 'Launch',
  description: 'Centred announcement card for a product launch, a release or a new feature.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The announcement.', example: 'Scheduled reports are here', required: true },
    { name: 'description', description: 'One or two lines under the announcement.', example: 'Send any dashboard to your team every Monday morning.' },
    { name: 'author', description: 'Product or company name, shown at the bottom.', example: 'Northwind' },
    { name: 'image', description: 'Absolute URL of the product logo (square); drawn small before the name.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Domain, shown after the name.', example: 'northwind.example' },
    { name: 'tag', description: 'Short label in a pill above the announcement.', example: 'New' },
    { name: 'theme', description: 'light (default, a violet colour field) or dark (near black).', example: 'light' },
  ],
  sample: {
    tag: 'New',
    title: 'Scheduled reports are here',
    description: 'Send any dashboard to your team every Monday morning.',
    author: 'Northwind',
    site: 'northwind.example',
  },
};
