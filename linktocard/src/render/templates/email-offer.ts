import type { StarterTemplate } from './index';

const html = `<div class="card">
  <div class="ticket">
    <div class="main">
      <div class="brand">
        <img class="logo" src="{{image}}" alt="">
        <span class="site">{{site}}</span>
        <span class="tag">{{tag}}</span>
      </div>
      <div class="hello"><span class="greeting">{{greeting}}</span><span class="name">{{name}},</span></div>
      <h1 class="title">{{title}}</h1>
      <p class="description">{{description}}</p>
    </div>
    <div class="cut">
      <span class="notch notch-a"></span>
      <span class="blade"><svg class="scissors" viewBox="0 0 48 48"><circle cx="11" cy="13" r="7" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="11" cy="35" r="7" fill="none" stroke="currentColor" stroke-width="4"/><path d="M17 17L45 38M17 31L45 10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg></span>
      <span class="notch notch-b"></span>
    </div>
    <div class="coupon">
      <span class="code">{{code}}</span>
      <span class="expires">{{expires}}</span>
    </div>
  </div>
</div>`;

const css = `/* Coupon: the offer on a paper slip, and a code below a dashed line to cut along.
   Laid out for the og preset (1200 x 630), the size a signed URL gets without size=. */
body { --outer: #e8492b; --paper: #fffaf1; --ink: #1c1a2e; --soft: #6a6474; --accent: #e8492b; --tint: #ffe9dc; --perf: #e3c3a8; background: var(--outer); color: var(--ink); }
.theme-dark { --outer: #0f1020; --paper: #1d1f35; --ink: #fbf3e6; --soft: #aaa3b8; --accent: #ff7a52; --tint: #2c2c4a; --perf: #4a4c70; }

.card { display: flex; height: 100%; padding: 36px; }
.ticket { display: flex; flex-direction: column; flex: 1; min-width: 0; border-radius: 28px; background: var(--paper); }

/* If the offer needs the whole text area, the description wraps into a second flex column,
   and the column gap puts that off the canvas: the offer wins. */
.main { display: flex; flex-direction: column; flex-wrap: wrap; column-gap: 600px; justify-content: center; flex: 1; min-height: 0; padding: 44px 56px 34px; }
.brand { display: flex; align-items: center; gap: 16px; width: 100%; height: 44px; margin-bottom: 18px; font-size: 25px; line-height: 1.2; }
.logo { flex: none; width: 44px; height: 44px; border-radius: 10px; object-fit: cover; }
.site { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 700; }
.tag { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 21px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
.no-site.no-tag.no-image .brand { display: none; }

/* The name is the part an email platform fills in: one line, cut with an ellipsis if it is long. */
.hello { display: flex; align-items: baseline; width: 100%; margin-bottom: 4px; font-size: 40px; font-weight: 700; line-height: 1.2; color: var(--accent); }
.greeting { flex: none; margin-right: 12px; }
/* The comma is part of the name's text, so it stays next to a name that had to be cut. */
.name { flex-shrink: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.no-greeting .greeting, .no-name .name { display: none; }
.no-greeting.no-name .hello { display: none; }

.title { width: 100%; margin: 0; padding-right: 6px; font-size: 92px; font-weight: 800; line-height: 1; letter-spacing: -0.04em; text-wrap: balance; word-break: break-word; }
.len-title-m .title { font-size: 64px; line-height: 1.04; letter-spacing: -0.035em; }
/* Clamping only in wrap mode: balanced lines and a line clamp together give a too narrow column. */
.len-title-l .title { font-size: 50px; line-height: 1.08; letter-spacing: -0.03em; text-wrap: wrap; line-clamp: 4; }
.len-title-xl .title { font-size: 44px; line-height: 1.1; letter-spacing: -0.02em; text-wrap: wrap; line-clamp: 4; }
.description { max-width: 900px; margin: 14px 0 0; font-size: 28px; line-height: 1.35; color: var(--soft); line-clamp: 2; }
.len-title-l .description, .len-title-xl .description { font-size: 25px; line-clamp: 1; }
.no-description .description { display: none; }

/* The cut: a dashed line with a notch punched out at each end and scissors on it. */
.cut { position: relative; display: flex; align-items: center; flex: none; height: 0; border-top: 4px dashed var(--perf); }
.notch { position: absolute; top: -28px; width: 52px; height: 52px; border-radius: 50%; background: var(--outer); }
.notch-a { left: -26px; }
.notch-b { right: -26px; }
.blade { position: absolute; top: -26px; left: 56px; display: flex; padding: 0 8px; background: var(--paper); color: var(--soft); }
.scissors { width: 48px; height: 48px; }

.coupon { display: flex; flex: none; align-items: center; gap: 28px; padding: 30px 56px 34px; }
.code { flex-shrink: 1; min-width: 0; padding: 10px 26px; border: 4px dashed var(--accent); border-radius: 14px; background: var(--tint); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-family: "JetBrains Mono", monospace; font-size: 46px; font-weight: 700; line-height: 1.25; letter-spacing: 0.04em; }
.expires { flex-shrink: 1; min-width: 0; margin-left: auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 27px; font-weight: 600; line-height: 1.3; color: var(--soft); }
.no-code .code { display: none; }
.no-code .expires { margin-left: 0; }
.no-expires .expires { display: none; }
.no-code.no-expires .cut, .no-code.no-expires .coupon { display: none; }

/* Square and portrait: the same slip, taller, with larger type. */
.size-square .card, .size-portrait .card { padding: 56px; }
.size-square .main, .size-portrait .main { padding: 56px 64px 40px; }
.size-square .hello, .size-portrait .hello { font-size: 52px; margin-bottom: 10px; }
.size-square .title, .size-portrait .title { font-size: 120px; }
.size-square.len-title-m .title, .size-portrait.len-title-m .title { font-size: 92px; }
.size-square.len-title-l .title, .size-portrait.len-title-l .title { font-size: 70px; line-clamp: 6; }
.size-square.len-title-xl .title, .size-portrait.len-title-xl .title { font-size: 58px; line-clamp: 6; }
.size-square .description, .size-portrait .description { margin-top: 24px; font-size: 34px; line-clamp: 3; }
.size-square .coupon, .size-portrait .coupon { flex-direction: column; align-items: flex-start; gap: 18px; padding: 40px 64px 48px; }
.size-square .code, .size-portrait .code { max-width: 100%; font-size: 56px; }
.size-square .expires, .size-portrait .expires { max-width: 100%; margin-left: 0; font-size: 32px; }
.size-square .blade, .size-portrait .blade { left: 64px; }

/* The email preset (1200 x 400): the same slip, flatter, with smaller type and one line of description. */
.size-email .card { padding: 24px; }
.size-email .ticket { border-radius: 22px; }
.size-email .main { padding: 18px 44px 12px; }
.size-email .brand { height: 34px; margin-bottom: 8px; font-size: 21px; }
.size-email .logo { width: 34px; height: 34px; border-radius: 8px; }
.size-email .tag { font-size: 18px; }
.size-email .hello { font-size: 30px; margin-bottom: 2px; }
.size-email .title { font-size: 60px; }
.size-email.len-title-m .title { font-size: 46px; }
.size-email.len-title-l .title { font-size: 36px; line-clamp: 2; }
.size-email.len-title-xl .title { font-size: 32px; line-clamp: 2; }
.size-email .description { margin-top: 8px; font-size: 22px; line-clamp: 1; }
.size-email.len-title-l .description, .size-email.len-title-xl .description { display: none; }
.size-email .coupon { gap: 22px; padding: 16px 44px 18px; }
.size-email .code { padding: 6px 20px; border-width: 3px; font-size: 32px; }
.size-email .expires { font-size: 21px; }
.size-email .notch { top: -22px; width: 40px; height: 40px; }
.size-email .notch-a { left: -20px; }
.size-email .notch-b { right: -20px; }
.size-email .blade { top: -22px; left: 44px; }
.size-email .scissors { width: 40px; height: 40px; }`;

export const emailOffer: Omit<StarterTemplate, 'id'> & { id: 'email-offer' } = {
  id: 'email-offer',
  name: 'Email offer',
  description: 'Offer image for an email: a greeting with the recipient\'s name, the offer in large type and a code below a dashed cut line.',
  html,
  css,
  fields: [
    { name: 'title', description: 'The offer itself, in large type.', example: '20% off everything', required: true },
    { name: 'name', description: 'Recipient name shown after the greeting; the usual open field, filled in by the email platform.', example: 'Maya' },
    { name: 'greeting', description: 'Word before the name, for example Hi or Hello. A comma follows the name.', example: 'Hi' },
    { name: 'description', description: 'One or two lines under the offer.', example: 'Your member discount on the whole spring collection.' },
    { name: 'code', description: 'Code printed in a dashed box, in a monospace font. Can be an open field for codes that differ per recipient.', example: 'SPRING-20' },
    { name: 'expires', description: 'Short note next to the code, for example when the offer ends.', example: 'Valid until 30 November' },
    { name: 'tag', description: 'Short label in small capitals next to the brand.', example: 'Members only' },
    { name: 'site', description: 'Brand or domain, shown in bold at the top.', example: 'Northwind' },
    { name: 'image', description: 'Absolute URL of a logo (square works best), shown small before the brand.', example: 'https://example.com/logo.png' },
    { name: 'theme', description: 'light (default) or dark.', example: 'light' },
  ],
  sample: {
    site: 'Northwind',
    tag: 'Members only',
    greeting: 'Hi',
    name: 'Maya',
    title: '20% off everything',
    description: 'Your member discount on the whole spring collection.',
    code: 'SPRING-20',
    expires: 'Valid until 30 November',
  },
};
