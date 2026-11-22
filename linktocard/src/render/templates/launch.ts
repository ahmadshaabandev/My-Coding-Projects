import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="ticket">
    <div class="body">
      <span class="tag">{{tag}}</span>
      <div class="main">
        <h1 class="title">{{title}}</h1>
        <p class="description">{{description}}</p>
      </div>
      <span class="author">{{author}}</span>
    </div>
    <div class="stub">
      <img class="logo" src="{{image}}" alt="">
      <svg class="spark" viewBox="0 0 96 96"><path d="M48 0c3 28 20 45 48 48-28 3-45 20-48 48-3-28-20-45-48-48 28-3 45-20 48-48z" fill="currentColor"/></svg>
      <div class="code">
        <div class="bars"></div>
        <span class="site">{{site}}</span>
      </div>
    </div>
    <span class="notch notch-a"></span>
    <span class="notch notch-b"></span>
  </div>
</div>`;

const css = `/* Launch ticket: the announcement is a pass with a tear-off stub, a bar code and a spark. */
body { --outer: #5a31f4; --paper: #fffcf4; --ink: #17122e; --soft: #5f5a78; --accent: #5a31f4; --on-accent: #ffffff; --perf: #cfc8e6; background: var(--outer); color: var(--ink); }
.theme-dark { --outer: #0f0a24; --paper: #1d1546; --ink: #ffffff; --soft: #b9b1de; --accent: #b9a5ff; --on-accent: #150f33; --perf: #4a3f86; }

.card { display: flex; height: 100%; padding: 48px 52px; }
.ticket { position: relative; display: flex; flex: 1; border-radius: 30px; background: var(--paper); }

.body { display: flex; flex-direction: column; flex: 1; min-width: 0; padding: 42px 48px 38px 56px; }
.tag { align-self: flex-start; max-width: 100%; padding: 7px 18px; border-radius: 999px; background: var(--accent); color: var(--on-accent); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 20px; font-weight: 700; letter-spacing: 0.1em; line-height: 1.3; text-transform: uppercase; }
.no-tag .tag { display: none; }

/* If the announcement needs the whole text area, the description wraps into a second flex
   column, and the column gap puts that off the canvas: the announcement wins. */
.main { display: flex; flex-direction: column; flex-wrap: wrap; column-gap: 500px; flex: 1; justify-content: center; padding: 16px 0; }
.title { width: 100%; margin: 0; padding-right: 6px; font-size: 80px; font-weight: 800; line-height: 1; letter-spacing: -0.045em; text-wrap: balance; word-break: break-word; }
.len-title-m .title { font-size: 62px; line-height: 1.03; letter-spacing: -0.04em; }
.len-title-l .title { font-size: 50px; line-height: 1.07; letter-spacing: -0.035em; }
.len-title-xl .title { font-size: 41px; line-height: 1.12; letter-spacing: -0.03em; text-wrap: wrap; line-clamp: 5; }
.description { margin: 22px 0 0; font-size: 28px; line-height: 1.38; color: var(--soft); text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-m .description { margin-top: 18px; font-size: 26px; }
.len-title-l .description, .len-title-xl .description { margin-top: 14px; font-size: 24px; }
.no-description .description { display: none; }

.author { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 25px; font-weight: 700; line-height: 1.3; }
.no-author .author { display: none; }

/* The stub: a dashed tear line, with a notch punched out of the ticket at each end. */
.stub { display: flex; flex: none; flex-direction: column; align-items: center; justify-content: space-between; width: 252px; padding: 46px 0 38px; border-left: 4px dashed var(--perf); }
.logo { width: 92px; height: 92px; border-radius: 22px; object-fit: cover; }
.spark { width: 92px; height: 92px; color: var(--accent); }
.has-image .spark { display: none; }
.code { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.bars {
  width: 172px; height: 62px; color: var(--ink);
  background-image:
    repeating-linear-gradient(90deg, currentColor 0px, currentColor 3px, transparent 3px, transparent 8px),
    repeating-linear-gradient(90deg, currentColor 0px, currentColor 2px, transparent 2px, transparent 13px),
    repeating-linear-gradient(90deg, currentColor 0px, currentColor 6px, transparent 6px, transparent 29px);
}
.site { max-width: 196px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: "JetBrains Mono", monospace; font-size: 17px; line-height: 1.3; color: var(--soft); }
.no-site .site { display: none; }
.notch { position: absolute; right: 228px; width: 52px; height: 52px; border-radius: 50%; background: var(--outer); }
.notch-a { top: -26px; }
.notch-b { bottom: -26px; }

/* Square and portrait: the ticket stands upright and the stub tears off at the bottom. */
.size-square .card, .size-portrait .card { padding: 56px; }
.size-square .ticket, .size-portrait .ticket { flex-direction: column; border-radius: 36px; }
.size-square .body, .size-portrait .body { padding: 56px 64px 40px; }
.size-square .tag, .size-portrait .tag { padding: 9px 22px; font-size: 24px; }
.size-square .title { font-size: 100px; }
.size-square.len-title-m .title { font-size: 76px; }
.size-square.len-title-l .title { font-size: 64px; }
.size-square.len-title-xl .title { font-size: 54px; line-clamp: 6; }
.size-portrait .title { font-size: 112px; }
.size-portrait.len-title-m .title { font-size: 88px; }
.size-portrait.len-title-l .title { font-size: 72px; }
.size-portrait.len-title-xl .title { font-size: 58px; line-clamp: 7; }
.size-square .description, .size-portrait .description, .size-square.len-title-m .description, .size-portrait.len-title-m .description { margin-top: 30px; font-size: 35px; }
.size-square.len-title-l .description, .size-square.len-title-xl .description, .size-portrait.len-title-l .description, .size-portrait.len-title-xl .description { margin-top: 24px; font-size: 31px; }
.size-square.len-description-xl .description { line-clamp: 3; }
.size-portrait.len-description-xl .description { line-clamp: 5; }
.size-square .author, .size-portrait .author { font-size: 30px; }
.size-square .stub, .size-portrait .stub { flex-direction: row; width: auto; height: 180px; padding: 0 64px; border-left: 0; border-top: 4px dashed var(--perf); }
.size-square .logo, .size-portrait .logo, .size-square .spark, .size-portrait .spark { width: 96px; height: 96px; }
.size-square .code, .size-portrait .code { align-items: flex-end; }
.size-square .bars, .size-portrait .bars { width: 260px; height: 68px; }
.size-square .site, .size-portrait .site { max-width: 420px; font-size: 21px; }
.size-square .notch, .size-portrait .notch { top: auto; bottom: 156px; }
.size-square .notch-a, .size-portrait .notch-a { left: -26px; right: auto; }
.size-square .notch-b, .size-portrait .notch-b { right: -26px; }`;

export const launch: StarterTemplate = {
  id: 'launch',
  name: 'Launch',
  description: 'Announcement card for a launch, a release or a new feature, drawn as a ticket with a tear-off stub.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The announcement.', example: 'Scheduled reports are here', required: true },
    { name: 'description', description: 'One or two lines under the announcement.', example: 'Send any dashboard to your team every Monday morning.' },
    { name: 'author', description: 'Product, company or team name, shown in bold at the bottom of the ticket.', example: 'Northwind' },
    { name: 'image', description: 'Absolute URL of the product logo (square works best); replaces the spark on the stub.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Domain or site name, printed under the bar code on the stub.', example: 'northwind.example' },
    { name: 'tag', description: 'Short label in the pill above the announcement, for example New or a version number.', example: 'New in 3.0' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    tag: 'New in 3.0',
    title: 'Scheduled reports are here',
    description: 'Send any dashboard to your team every Monday morning.',
    author: 'Northwind',
    site: 'northwind.example',
  },
};
