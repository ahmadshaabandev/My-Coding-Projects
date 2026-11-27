import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="kicker">
    <span class="dot"></span>
    <span class="tag">{{tag}}</span>
  </div>
  <div class="main">
    <h1 class="title">{{title}}</h1>
    <p class="description">{{description}}</p>
  </div>
  <div class="horizon">
    <div class="sun"><span class="disc"></span><span class="echo"></span></div>
  </div>
  <div class="byline">
    <img class="avatar" src="{{image}}" alt="">
    <span class="author">{{author}}</span>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* Sunrise: a serif headline on warm paper, and a sun coming up over the byline. */
body { --paper: #f6f0e4; --ink: #1d1a16; --soft: #6d6658; --sun: #f4502a; background: var(--paper); color: var(--ink); }
.theme-dark { --paper: #15171e; --ink: #f5eee0; --soft: #a39d90; --sun: #ff6a3c; }

.card { display: flex; flex-direction: column; height: 100%; padding: 60px 76px 64px; --sun-size: 300px; }
/* Long headlines get a smaller sun and a wider column. */
.len-title-l .card, .len-title-xl .card { --sun-size: 220px; }

.kicker { display: flex; align-items: center; gap: 14px; height: 28px; }
.dot { flex: none; width: 14px; height: 14px; border-radius: 50%; background: var(--sun); }
.tag { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 640px; font-size: 21px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.no-tag .kicker { display: none; }

/* The text column stops short of the sun. If a headline needs the whole column, the description
   wraps into a second flex column, and the column gap puts that off the canvas: the headline wins. */
.main { display: flex; flex-direction: column; flex-wrap: wrap; column-gap: 500px; flex: 1; justify-content: center; width: 756px; margin-left: -16px; padding: 14px 0 20px 16px; }
.len-title-m .main { width: 776px; }
.len-title-l .main, .len-title-xl .main { width: 816px; }
.title {
  width: 100%; margin: 0; padding-right: 6px;
  font-family: "Source Serif 4", serif; font-weight: 600; font-size: 84px; line-height: 1.04; letter-spacing: -0.025em;
  text-wrap: balance; word-break: break-word;
}
.len-title-m .title { font-size: 66px; line-height: 1.05; }
.len-title-l .title { font-size: 50px; line-height: 1.1; letter-spacing: -0.02em; }
.len-title-xl .title { font-size: 44px; line-height: 1.14; letter-spacing: -0.015em; text-wrap: wrap; line-clamp: 5; }

.description { max-width: 660px; margin: 24px 0 0; font-size: 29px; line-height: 1.38; color: var(--soft); text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-m .description { margin-top: 20px; font-size: 26px; }
.len-title-l .description, .len-title-xl .description { margin-top: 18px; font-size: 25px; }
.len-title-xl .description { max-width: 740px; }
.no-description .description { display: none; }

/* The horizon is always drawn. The sun on it is a half disc with an outline printed slightly off register. */
.horizon { position: relative; flex: none; height: 3px; background: var(--ink); }
.sun { position: absolute; right: 0; bottom: 3px; width: calc(var(--sun-size) + 16px); height: calc(var(--sun-size) * 0.5 + 16px); }
.disc, .echo { position: absolute; bottom: 0; width: var(--sun-size); border-radius: calc(var(--sun-size) * 0.5) calc(var(--sun-size) * 0.5) 0 0; }
.disc { left: 0; height: calc(var(--sun-size) * 0.5); background: var(--sun); }
.echo { left: 16px; height: calc(var(--sun-size) * 0.5 + 16px); border: 3px solid var(--ink); border-bottom-width: 0; }

.byline { display: flex; align-items: center; gap: 16px; margin-top: 22px; font-size: 25px; line-height: 1.3; }
.avatar { flex: none; width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
.author, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { flex-shrink: 1; font-weight: 700; }
.site { flex-shrink: 0; max-width: 440px; margin-left: auto; color: var(--soft); }
.no-author .author { display: none; }
.no-author .site { margin-left: 0; }
.no-author.no-site .byline { display: none; }

/* Square and portrait: the same landscape under a taller sky. The text starts at the top and ends above the sun. */
.size-square .card, .size-portrait .card { padding: 84px 88px 88px; }
.size-square .card { --sun-size: 380px; }
.size-square.len-title-l .card, .size-square.len-title-xl .card { --sun-size: 300px; }
.size-portrait .card { --sun-size: 520px; }
.size-square .tag, .size-portrait .tag { max-width: 800px; font-size: 25px; }
.size-square .kicker, .size-portrait .kicker { height: 34px; }
.size-square .dot, .size-portrait .dot { width: 18px; height: 18px; }
.size-square .main, .size-portrait .main { justify-content: flex-start; width: 920px; margin-bottom: calc(var(--sun-size) * 0.5 + 32px); }
.size-square .main { padding: 56px 0 0 16px; }
.size-portrait .main { padding: 80px 0 0 16px; }
.size-square .title { font-size: 100px; }
.size-square.len-title-m .title { font-size: 76px; }
.size-square.len-title-l .title { font-size: 70px; }
.size-square.len-title-xl .title { font-size: 56px; line-clamp: 6; }
.size-portrait .title { font-size: 120px; }
.size-portrait.len-title-m .title { font-size: 84px; }
.size-portrait.len-title-l .title { font-size: 70px; }
.size-portrait.len-title-xl .title { font-size: 60px; line-clamp: 6; }
.size-square .description, .size-portrait .description { max-width: 820px; margin-top: 32px; font-size: 36px; }
.size-square.len-title-l .description, .size-square.len-title-xl .description { margin-top: 26px; font-size: 31px; }
.size-portrait.len-title-l .description, .size-portrait.len-title-xl .description { margin-top: 30px; font-size: 34px; }
.size-square.len-description-xl .description { line-clamp: 3; }
.size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .byline, .size-portrait .byline { margin-top: 28px; font-size: 30px; }
.size-square .avatar, .size-portrait .avatar { width: 60px; height: 60px; }`;

export const blog: StarterTemplate = {
  id: 'blog',
  name: 'Blog post',
  description: 'Title card for articles: a serif headline on warm paper, with a sun rising over the author line.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Headline of the article.', example: 'Design for the first glance', required: true },
    { name: 'description', description: 'One or two lines under the headline.', example: 'What people notice before they read a single word.' },
    { name: 'author', description: 'Author name, shown in the bottom line.', example: 'Maya Lindqvist' },
    { name: 'image', description: 'Absolute URL of the author photo (square works best); drawn as a small circle.', example: 'https://example.com/maya.jpg' },
    { name: 'site', description: 'Domain or publication name, shown small in the bottom line.', example: 'fieldnotes.example' },
    { name: 'tag', description: 'Category shown above the headline in small capitals.', example: 'Design notes' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    tag: 'Design notes',
    title: 'Design for the first glance',
    description: 'What people notice before they read a single word, and how to plan for it.',
    author: 'Maya Lindqvist',
    site: 'fieldnotes.example',
  },
  // Not the 1200x400 email preset: these cards are not laid out for it (owner decision of 2026-11-27).
  sizes: ['og', 'square', 'portrait'],
};
