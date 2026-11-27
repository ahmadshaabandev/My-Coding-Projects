import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="field">
    <div class="mark">“</div>
    <div class="top">
      <span class="tag">{{tag}}</span>
      <span class="sep"></span>
      <span class="site">{{site}}</span>
    </div>
    <div class="main">
      <p class="quote">{{title}}</p>
    </div>
  </div>
  <div class="by">
    <img class="avatar" src="{{image}}" alt="">
    <div class="who">
      <span class="author">{{author}}</span>
      <span class="role">{{description}}</span>
    </div>
  </div>
</div>`;

const css = `/* Pull quote as a poster: one loud colour, serif italic, and the speaker on an ink band.
   title = the quotation, author = who said it, description = their role or the source. */
body { --field: #ffc533; --mark: #f2ae13; --ink: #1b1710; --text: #1b1710; --band: #1b1710; --name: #ffc533; --role: #d9d2c3; background: var(--field); color: var(--text); }
.theme-dark { --field: #1b1710; --mark: #30281a; --text: #f8f1e1; --band: #ffc533; --name: #1b1710; --role: #4d4023; }

.card { display: flex; flex-direction: column; height: 100%; }
/* The side margins belong to .top and .main, so an italic letter may lean out of its line box. */
.field { position: relative; display: flex; flex-direction: column; flex: 1; padding: 52px 0 36px; }

/* The opening mark is a real glyph, far larger than the text and one shade off the background. */
.mark { position: absolute; left: 44px; top: -76px; font-family: "Source Serif 4", serif; font-weight: 600; font-size: 640px; line-height: 1; color: var(--mark); }

.top { position: relative; display: flex; align-items: center; justify-content: flex-end; gap: 14px; height: 28px; margin: 0 76px; font-size: 21px; line-height: 1.3; }
.tag, .site { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 380px; }
.tag { max-width: 340px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.sep { flex: none; width: 8px; height: 8px; background: var(--text); }
.no-tag .tag, .no-site .site, .no-tag .sep, .no-site .sep { display: none; }
.no-tag.no-site .top { display: none; }

.main { position: relative; display: flex; flex-direction: column; flex: 1; justify-content: center; padding: 0 76px; }
.quote {
  margin: 0; max-width: 1000px;
  font-family: "Source Serif 4", serif; font-style: italic; font-size: 88px; line-height: 1.12; letter-spacing: -0.015em;
  text-wrap: balance; word-break: break-word;
}
.len-title-m .quote { font-size: 70px; line-height: 1.16; }
.len-title-l .quote { font-size: 50px; line-height: 1.24; letter-spacing: -0.01em; }
.len-title-xl .quote { font-size: 41px; line-height: 1.28; letter-spacing: -0.005em; text-wrap: wrap; line-clamp: 5; }

.by { display: flex; flex: none; align-items: center; gap: 22px; height: 116px; padding: 0 76px; background: var(--band); }
.avatar { flex: none; width: 68px; height: 68px; border-radius: 50%; object-fit: cover; }
.who { display: flex; flex-direction: column; min-width: 0; max-width: 820px; }
.author, .role { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.author { font-size: 29px; font-weight: 700; line-height: 1.25; color: var(--name); }
.role { font-size: 23px; line-height: 1.35; color: var(--role); }
/* Nobody to credit: the band stays as a thin base line. */
.no-author.no-description .by { height: 20px; }
.no-author.no-description .avatar, .no-author.no-description .who { display: none; }

.size-square .field, .size-portrait .field { padding: 76px 0 48px; }
.size-square .main, .size-portrait .main { padding: 0 88px; }
.size-square .mark, .size-portrait .mark { left: 48px; top: -60px; font-size: 900px; }
/* The mark is wider here, so the label and the site stack in the corner instead of sharing a line. */
.size-square .top, .size-portrait .top { flex-direction: column; align-items: flex-end; justify-content: flex-start; gap: 4px; height: 70px; margin: 0 88px; font-size: 25px; }
.size-square .sep, .size-portrait .sep { display: none; }
.size-square .quote, .size-portrait .quote { max-width: 904px; font-size: 104px; }
.size-square.len-title-m .quote { font-size: 86px; }
.size-square.len-title-l .quote { font-size: 68px; }
.size-square.len-title-xl .quote { font-size: 56px; line-clamp: 8; }
.size-portrait .quote { font-size: 116px; }
.size-portrait.len-title-m .quote { font-size: 96px; }
.size-portrait.len-title-l .quote { font-size: 76px; }
.size-portrait.len-title-xl .quote { font-size: 62px; line-clamp: 9; }
.size-square .by, .size-portrait .by { height: 148px; padding: 0 88px; gap: 26px; }
.size-square .avatar, .size-portrait .avatar { width: 84px; height: 84px; }
.size-square .who, .size-portrait .who { max-width: 800px; }
.size-square .author, .size-portrait .author { font-size: 34px; }
.size-square .role, .size-portrait .role { font-size: 27px; }
.size-square.no-author.no-description .by, .size-portrait.no-author.no-description .by { height: 24px; }`;

export const quote: StarterTemplate = {
  id: 'quote',
  name: 'Quote',
  description: 'A quotation as a poster: serif italic on a loud colour field, with the speaker on an ink band.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The quotation, without quote marks (the template draws its own).', example: 'We shipped faster once we agreed on what done looks like.', required: true },
    { name: 'author', description: 'Who said it.', example: 'Priya Raman' },
    { name: 'description', description: 'Their role, or the source of the quotation; one line under the name.', example: 'Engineering lead, Harbor Labs' },
    { name: 'image', description: 'Absolute URL of a portrait of the person (square works best); drawn as a circle next to the name.', example: 'https://example.com/priya.jpg' },
    { name: 'site', description: 'Domain or site name, shown small in the top right corner.', example: 'harborlabs.example' },
    { name: 'tag', description: 'Small label in the top right corner, in capitals.', example: 'Team notes' },
    { name: 'theme', description: 'light (default, yellow field) or dark (ink field, yellow band).', example: 'light' },
  ],
  sample: {
    title: 'We shipped faster once we agreed on what done looks like.',
    author: 'Priya Raman',
    description: 'Engineering lead, Harbor Labs',
    site: 'harborlabs.example',
  },
  // Not the 1200x400 email preset: these cards are not laid out for it (owner decision of 2026-11-27).
  sizes: ['og', 'square', 'portrait'],
};
