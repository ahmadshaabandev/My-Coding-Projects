import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="rail"></div>
  <div class="tabs"><span class="tab">{{tag}}</span></div>
  <div class="main">
    <div class="code">
      <div class="gutter"><div class="numbers"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span></div></div>
      <h1 class="title">{{title}}<span class="caret"></span></h1>
    </div>
    <div class="comment">
      <span class="slashes">//</span>
      <p class="description">{{description}}</p>
    </div>
  </div>
  <div class="status">
    <div class="who">
      <img class="logo" src="{{image}}" alt="">
      <span class="author">{{author}}</span>
    </div>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* Editor: the title is the open file. Line numbers, a cursor, a comment and a status bar. Always dark. */
body { --bg: #0c0d10; --chrome: #131519; --line: #25282e; --text: #f3f5ee; --dim: #98a18a; --lime: #c6f135; background: var(--bg); color: var(--text); font-family: "JetBrains Mono", monospace; }
.card { position: relative; display: flex; flex-direction: column; height: 100%; --gutter: 84px; --inset: 36px; --size: 80px; --row: 90px; }
.len-title-m .card { --size: 64px; --row: 73px; }
.len-title-l .card { --size: 50px; --row: 58px; }
.len-title-xl .card { --size: 41px; --row: 49px; }

.rail { position: absolute; left: var(--gutter); top: 0; width: 2px; height: 100%; background: var(--line); }

.tabs { position: relative; display: flex; flex: none; height: 58px; padding-left: var(--gutter); background: var(--chrome); border-bottom: 2px solid var(--line); }
.tab { max-width: 640px; height: 58px; padding: 0 var(--inset); border-top: 4px solid var(--lime); border-right: 2px solid var(--line); background: var(--bg); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 22px; line-height: 50px; }
.no-tag .tabs { display: none; }

.main { display: flex; flex-direction: column; flex: 1; justify-content: center; padding: 24px 72px 24px 0; }
.code { display: flex; }
/* The numbers do not take part in layout: the gutter is as tall as the title and hides the rest. */
.gutter { position: relative; flex: none; width: var(--gutter); overflow: hidden; }
.numbers { position: absolute; top: 0; right: 24px; display: flex; flex-direction: column; color: #50574a; font-size: 20px; line-height: var(--row); text-align: right; }
.numbers span { display: block; }
.title { flex: 1; margin: 0; padding-left: var(--inset); font-size: var(--size); line-height: var(--row); font-weight: 700; letter-spacing: -0.04em; text-wrap: balance; word-break: break-word; }
.len-title-xl .title { text-wrap: wrap; line-clamp: 5; }
.caret { display: inline-block; width: 0.5em; height: 0.8em; margin-left: 0.18em; background: var(--lime); }
/* A clamped title ends in an ellipsis; a cursor after it would be wrong. */
.len-title-xl .caret { display: none; }

.comment { display: flex; gap: 16px; margin: 22px 0 0 calc(var(--gutter) + var(--inset)); color: var(--dim); font-size: 26px; line-height: 1.45; }
.slashes { flex: none; color: var(--lime); }
.description { margin: 0; max-width: 860px; text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-l .comment, .len-title-xl .comment { margin-top: 16px; font-size: 23px; }
.no-description .comment { display: none; }

.status { position: relative; display: flex; flex: none; align-items: center; height: 58px; background: var(--lime); color: #0c0d10; font-size: 22px; font-weight: 700; line-height: 1.3; }
.who { display: flex; flex-shrink: 1; align-items: center; gap: 14px; min-width: 0; height: 100%; padding: 0 28px; background: #a3cc1c; }
.logo { flex: none; width: 34px; height: 34px; border-radius: 6px; object-fit: cover; }
.author, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.site { flex-shrink: 0; max-width: 460px; padding: 0 28px; font-weight: 400; }
.no-author.no-image .who { display: none; }
.no-author.no-site .status { height: 14px; }
.no-author.no-site .who { display: none; }

.size-square .card, .size-portrait .card { --gutter: 92px; --inset: 40px; --size: 96px; --row: 108px; }
.size-square.len-title-m .card, .size-portrait.len-title-m .card { --size: 76px; --row: 87px; }
.size-square.len-title-l .card, .size-portrait.len-title-l .card { --size: 62px; --row: 72px; }
.size-square.len-title-xl .card, .size-portrait.len-title-xl .card { --size: 52px; --row: 62px; }
.size-square .tabs, .size-portrait .tabs { height: 72px; }
.size-square .tab, .size-portrait .tab { height: 72px; font-size: 27px; line-height: 64px; }
.size-square .main, .size-portrait .main { padding-right: 80px; }
.size-square .numbers, .size-portrait .numbers { font-size: 23px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { line-clamp: 7; }
.size-square .comment, .size-portrait .comment { margin-top: 32px; font-size: 31px; }
.size-square.len-title-l .comment, .size-square.len-title-xl .comment, .size-portrait.len-title-l .comment, .size-portrait.len-title-xl .comment { margin-top: 26px; font-size: 28px; }
.size-square.len-description-xl .description, .size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .status, .size-portrait .status { height: 72px; font-size: 27px; }
.size-square.no-author.no-site .status, .size-portrait.no-author.no-site .status { height: 18px; }
.size-square .logo, .size-portrait .logo { width: 42px; height: 42px; }`;

export const dark: StarterTemplate = {
  id: 'dark',
  name: 'Dark',
  description: 'High-contrast dark card for developer content, set like an open file in a code editor.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Headline, set in monospace next to the line numbers.', example: 'Zero-downtime schema migrations, step by step', required: true },
    { name: 'description', description: 'One or two lines under the headline, shown as a code comment.', example: 'Expand, backfill, contract: the pattern behind every safe change.' },
    { name: 'author', description: 'Author, team or project name, shown in the status bar.', example: 'Tomas Reyes' },
    { name: 'image', description: 'Absolute URL of a logo or avatar; drawn as a small rounded square in the status bar.', example: 'https://example.com/logo.png' },
    { name: 'site', description: 'Domain or site name, shown in the status bar after the author.', example: 'stackjournal.example' },
    { name: 'tag', description: 'Short label shown as the open editor tab, for example a topic or a file name.', example: 'migrations.sql' },
  ],
  sample: {
    tag: 'migrations.sql',
    title: 'Zero-downtime schema migrations, step by step',
    description: 'Expand, backfill, contract: the pattern behind every safe change.',
    author: 'Tomas Reyes',
    site: 'stackjournal.example',
  },
  // Not the 1200x400 email preset: these cards are not laid out for it (owner decision of 2026-11-27).
  sizes: ['og', 'square', 'portrait'],
};
