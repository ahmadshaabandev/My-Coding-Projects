import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="top">
    <svg class="mark" viewBox="0 0 64 48"><path d="M0 48V30C0 12 9 2 26 0v9c-8 2-12 7-12 15h12v24zm36 0V30C36 12 45 2 62 0v9c-8 2-12 7-12 15h12v24z" fill="currentColor"/></svg>
    <span class="tag">{{tag}}</span>
  </div>
  <div class="main">
    <p class="quote">{{title}}</p>
  </div>
  <div class="by">
    <img class="avatar" src="{{image}}" alt="">
    <span class="dash"></span>
    <div class="who">
      <span class="author">{{author}}</span>
      <span class="role">{{description}}</span>
    </div>
    <span class="site">{{site}}</span>
  </div>
</div>`;

const css = `/* A quotation set in serif italic. title = the quotation, author = who said it, description = their role or the source. */
body { background: #f7f2e9; color: #26221c; }
.card { display: flex; flex-direction: column; height: 100%; padding: 64px 76px; }

.top { display: flex; align-items: flex-start; justify-content: space-between; height: 48px; color: #c2553a; }
.mark { width: 64px; height: 48px; }
.tag { max-width: 800px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 22px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; line-height: 1.2; }

.main { display: flex; flex-direction: column; flex: 1; justify-content: center; padding: 24px 0; }
.quote {
  margin: 0; max-width: 1000px;
  font-family: "Source Serif 4", serif; font-style: italic; font-size: 78px; line-height: 1.18; letter-spacing: -0.01em;
  text-wrap: balance;
}
.len-title-m .quote { font-size: 66px; }
.len-title-l .quote { font-size: 52px; line-height: 1.25; }
.len-title-xl .quote { font-size: 42px; line-height: 1.3; text-wrap: wrap; line-clamp: 5; }

.by { display: flex; align-items: center; gap: 20px; min-height: 64px; }
.avatar { flex: none; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; }
.dash { flex: none; align-self: flex-start; width: 36px; height: 3px; margin-top: 16px; background: #c2553a; }
.has-image .dash { display: none; }
.who { display: flex; flex-direction: column; flex-shrink: 1; min-width: 0; }
.author, .role, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { font-size: 28px; font-weight: 600; line-height: 1.25; }
.role { font-size: 24px; line-height: 1.35; color: #6f675b; }
.site { flex-shrink: 0; max-width: 400px; margin-left: auto; align-self: flex-end; font-size: 24px; line-height: 1.35; color: #6f675b; }
.no-author.no-description .dash, .no-author.no-description .who { display: none; }
.no-author.no-description.no-site .by { display: none; }

.size-square .card, .size-portrait .card { padding: 88px; }
.size-square .mark, .size-portrait .mark { width: 88px; height: 66px; }
.size-square .top, .size-portrait .top { height: 66px; }
.size-square .quote, .size-portrait .quote { font-size: 100px; }
.size-square.len-title-m .quote, .size-portrait.len-title-m .quote { font-size: 86px; }
.size-square.len-title-l .quote, .size-portrait.len-title-l .quote { font-size: 68px; }
.size-square.len-title-xl .quote, .size-portrait.len-title-xl .quote { font-size: 56px; line-clamp: 8; }
.size-square .author, .size-portrait .author { font-size: 32px; }
.size-square .role, .size-portrait .role, .size-square .site, .size-portrait .site { font-size: 27px; }
.size-square .avatar, .size-portrait .avatar { width: 76px; height: 76px; }

.theme-dark { background: #1b1815; color: #f5efe4; }
.theme-dark .top { color: #e58e73; }
.theme-dark .dash { background: #e58e73; }
.theme-dark .role, .theme-dark .site { color: #a59c8d; }`;

export const quote: StarterTemplate = {
  id: 'quote',
  name: 'Quote',
  description: 'A quotation in serif italic with the person who said it.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The quotation, without quote marks (the template draws its own).', example: 'We shipped faster once we agreed on what done looks like.', required: true },
    { name: 'author', description: 'Who said it.', example: 'Priya Raman' },
    { name: 'description', description: 'Their role, or the source of the quotation; one line under the name.', example: 'Engineering lead, Harbor Labs' },
    { name: 'image', description: 'Absolute URL of a portrait of the person (square works best); drawn as a circle.', example: 'https://example.com/priya.jpg' },
    { name: 'site', description: 'Domain or site name, shown small in the bottom right corner.', example: 'harborlabs.example' },
    { name: 'tag', description: 'Small label in the top right corner.', example: 'Team notes' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    title: 'We shipped faster once we agreed on what done looks like.',
    author: 'Priya Raman',
    description: 'Engineering lead, Harbor Labs',
    site: 'harborlabs.example',
  },
};
