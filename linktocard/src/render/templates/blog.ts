import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="main">
    <div class="kicker">
      <span class="rule"></span>
      <span class="tag">{{tag}}</span>
    </div>
    <h1 class="title">{{title}}</h1>
    <p class="description">{{description}}</p>
  </div>
  <div class="byline">
    <img class="avatar" src="{{image}}" alt="">
    <span class="author">{{author}}</span>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* Editorial: warm paper, a serif headline, one accent colour. */
body { background: #faf9f6; color: #1b1a17; }
.card { display: flex; flex-direction: column; height: 100%; padding: 64px 76px; }
.main { display: flex; flex-direction: column; flex: 1; justify-content: center; }

.kicker { display: flex; align-items: center; gap: 18px; height: 28px; margin-bottom: 28px; }
.rule { width: 56px; height: 6px; border-radius: 3px; background: #2f45d8; }
.tag { font-size: 22px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: #2f45d8; }

.title {
  margin: 0; max-width: 1000px;
  font-family: "Source Serif 4", serif; font-weight: 600; font-size: 84px; line-height: 1.08; letter-spacing: -0.02em;
  text-wrap: balance;
}
.len-title-m .title { font-size: 70px; }
.len-title-l .title { font-size: 58px; line-height: 1.12; }
.len-title-xl .title { font-size: 48px; line-height: 1.15; text-wrap: wrap; line-clamp: 4; }

.description { margin: 26px 0 0; max-width: 900px; font-size: 30px; line-height: 1.4; color: #5d5a52; text-wrap: balance; }
.len-description-xl .description { text-wrap: wrap; line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { margin-top: 20px; font-size: 27px; }
.no-description .description { display: none; }

.byline { display: flex; align-items: center; gap: 18px; padding-top: 26px; border-top: 2px solid #e4e1d8; font-size: 26px; line-height: 1.3; }
.avatar { flex: none; width: 52px; height: 52px; border-radius: 50%; object-fit: cover; }
.author, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { flex-shrink: 1; font-weight: 600; }
.site { flex-shrink: 0; max-width: 440px; margin-left: auto; color: #5d5a52; }
.no-author .site { margin-left: 0; }
.no-author.no-site .byline { display: none; }

/* Square and portrait: larger type and margins, same structure. */
.size-square .card, .size-portrait .card { padding: 88px; }
.size-square .title, .size-portrait .title { font-size: 116px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 98px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 78px; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 64px; line-clamp: 6; }
.size-square .description, .size-portrait .description { margin-top: 32px; font-size: 34px; }
.size-square.len-description-xl .description, .size-portrait.len-description-xl .description { line-clamp: 4; }
.size-square .byline, .size-portrait .byline { padding-top: 32px; font-size: 30px; }
.size-square .avatar, .size-portrait .avatar { width: 64px; height: 64px; }

.theme-dark { background: #15171c; color: #f3f1ea; }
.theme-dark .rule { background: #98a8ff; }
.theme-dark .tag { color: #98a8ff; }
.theme-dark .description, .theme-dark .site { color: #a8a59c; }
.theme-dark .byline { border-top-color: #2c2f38; }`;

export const blog: StarterTemplate = {
  id: 'blog',
  name: 'Blog post',
  description: 'Title card for articles and blog posts: a serif headline on warm paper with an author line.',
  html,
  css,
  fields: [
    { name: 'title', description: 'Headline of the article.', example: 'Designing for the first five seconds', required: true },
    { name: 'description', description: 'One or two lines under the headline.', example: 'What people notice before they read a single word.' },
    { name: 'author', description: 'Author name, shown in the bottom line.', example: 'Maya Lindqvist' },
    { name: 'image', description: 'Absolute URL of the author photo (square works best); drawn as a small circle.', example: 'https://example.com/maya.jpg' },
    { name: 'site', description: 'Domain or publication name, shown small in the bottom line.', example: 'fieldnotes.example' },
    { name: 'tag', description: 'Category shown above the headline in small capitals.', example: 'Design notes' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    tag: 'Design notes',
    title: 'Designing for the first five seconds',
    description: 'What people notice before they read a single word, and how to plan for it.',
    author: 'Maya Lindqvist',
    site: 'fieldnotes.example',
  },
};
