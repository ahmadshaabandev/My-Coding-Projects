import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="main">
    <div class="brand">
      <img class="logo" src="{{image}}" alt="">
      <span class="site">{{site}}</span>
      <span class="tag">{{tag}}</span>
    </div>
    <div class="hello"><span class="greeting">{{greeting}}</span><span class="name">{{name}},</span></div>
    <h1 class="title">{{title}}</h1>
  </div>
  <div class="side">
    <div class="seal"><div class="ring"><div class="core"></div></div></div>
    <span class="cta">{{cta}}</span>
  </div>
</div>`;

const css = `/* Postmark: a greeting on cream paper, with a franking seal stamped half off the right edge. */
body { --paper: #fff6e8; --ink: #1c1a2e; --soft: #6a6474; --accent: #e8492b; --line: #e9c9a6; --core: #ffd9b8; background: var(--paper); color: var(--ink); }
.theme-dark { --paper: #17192a; --ink: #fbf3e6; --soft: #aaa3b8; --accent: #ff7a52; --line: #3b3d5c; --core: #2a2c48; }

.card { display: flex; height: 100%; padding: 44px 0 44px 64px; }

/* Text column. One line of brand, one line of greeting, then the message. */
.main { display: flex; flex-direction: column; justify-content: center; flex: 1; min-width: 0; padding-right: 24px; }
.brand { display: flex; align-items: center; gap: 16px; width: 100%; height: 44px; margin-bottom: 20px; font-size: 25px; line-height: 1.2; }
.logo { flex: none; width: 44px; height: 44px; border-radius: 10px; object-fit: cover; }
.site { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 700; }
.tag { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 21px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
.no-site.no-tag.no-image .brand { display: none; }

/* The name is the part an email platform fills in: one line, cut with an ellipsis if it is long. */
.hello { display: flex; align-items: baseline; width: 100%; margin-bottom: 6px; font-size: 42px; font-weight: 700; line-height: 1.2; color: var(--accent); }
.greeting { flex: none; margin-right: 12px; }
/* The comma is part of the name's text, so it stays next to a name that had to be cut. */
.name { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.no-greeting .greeting, .no-name .name { display: none; }
.no-greeting.no-name .hello { display: none; }

.title { width: 100%; margin: 0; padding-right: 6px; font-size: 64px; font-weight: 800; line-height: 1.05; letter-spacing: -0.03em; text-wrap: balance; word-break: break-word; }
.len-title-m .title { font-size: 52px; line-height: 1.07; }
/* Clamping only in wrap mode: balanced lines and a line clamp together give a too narrow column. */
.len-title-l .title { font-size: 42px; line-height: 1.1; letter-spacing: -0.02em; text-wrap: wrap; line-clamp: 4; }
.len-title-xl .title { font-size: 38px; line-height: 1.12; letter-spacing: -0.015em; text-wrap: wrap; line-clamp: 4; }

/* The seal: two printed rings around a soft disc, cut off by the right edge. The call to action sits on it. */
.side { position: relative; display: flex; flex: none; align-items: center; justify-content: center; width: 340px; }
.seal { position: absolute; top: 50%; right: -190px; display: flex; align-items: center; justify-content: center; width: 500px; height: 500px; margin-top: -250px; border-radius: 50%; border: 4px solid var(--line); }
.ring { display: flex; align-items: center; justify-content: center; width: 372px; height: 372px; border-radius: 50%; border: 4px solid var(--line); }
.core { width: 248px; height: 248px; border-radius: 50%; background: var(--core); }
.cta { position: relative; max-width: 292px; padding: 20px 34px; border-radius: 999px; background: var(--ink); color: var(--paper); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 32px; font-weight: 700; line-height: 1.2; }
.no-cta .cta { display: none; }

/* Taller canvases: the same banner with more air, and the seal below the text on square and portrait. */
.size-og .card { padding-top: 64px; padding-bottom: 64px; }
.size-og .brand { margin-bottom: 30px; }
.size-og .hello { font-size: 48px; margin-bottom: 10px; }
.size-og .title { font-size: 76px; }
.size-og.len-title-m .title { font-size: 62px; }
.size-og.len-title-l .title { font-size: 50px; line-clamp: 5; }
.size-og.len-title-xl .title { font-size: 44px; line-clamp: 6; }
.size-square .card, .size-portrait .card { flex-direction: column; padding: 80px 0 0 80px; }
.size-square .main, .size-portrait .main { padding-right: 80px; }
.size-square .brand, .size-portrait .brand { margin-bottom: 40px; }
.size-square .hello, .size-portrait .hello { font-size: 56px; margin-bottom: 12px; }
.size-square .title, .size-portrait .title { font-size: 92px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 76px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 62px; line-clamp: 5; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 52px; line-clamp: 6; }
.size-square .side, .size-portrait .side { width: auto; height: 380px; justify-content: flex-start; }
.size-portrait .side { height: 520px; }
.size-square .seal, .size-portrait .seal { top: auto; bottom: -260px; right: -140px; margin-top: 0; }
.size-square .cta, .size-portrait .cta { max-width: 640px; font-size: 38px; }`;

export const emailBanner: Omit<StarterTemplate, 'id'> & { id: 'email-banner' } = {
  id: 'email-banner',
  name: 'Email banner',
  description: 'Wide header image for an email: a greeting with the recipient\'s name, a short message and a button-shaped label.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The message, one or two short lines.', example: 'Your spring picks are ready', required: true },
    { name: 'name', description: 'Recipient name shown after the greeting; the usual open field, filled in by the email platform.', example: 'Maya' },
    { name: 'greeting', description: 'Word before the name, for example Hi or Hello. A comma follows the name.', example: 'Hi' },
    { name: 'cta', description: 'Text of the button-shaped label on the right. The image itself is not a link: wrap it in one in your email.', example: 'See the edit' },
    { name: 'tag', description: 'Short label in small capitals next to the brand, for example a campaign name.', example: 'Spring edit' },
    { name: 'site', description: 'Brand or domain, shown in bold at the top.', example: 'Northwind' },
    { name: 'image', description: 'Absolute URL of a logo (square works best), shown small before the brand.', example: 'https://example.com/logo.png' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    site: 'Northwind',
    tag: 'Spring edit',
    greeting: 'Hi',
    name: 'Maya',
    title: 'Your spring picks are ready',
    cta: 'See the edit',
  },
  // Laid out for the email preset (decision D7), with size-og, size-square and size-portrait rules for the others.
  sizes: ['og', 'square', 'portrait', 'email'],
};
