---
title: HTML and CSS templates
description: The template language exactly as implemented - placeholders, state classes, the base stylesheet, fonts, emoji, images, limits, the five starter templates and a complete worked example.
layout: doc
order: 4
nav: HTML and CSS templates
---

A template is HTML plus CSS. A render takes a template, a flat map of text values (`data`), a size and a format, and returns one image.

Templates are drawn by Satori 0.63.2, a layout engine, and rasterised by resvg. It lays out HTML with real CSS, but **it is not a browser**: JavaScript never runs and some HTML is not supported. This page states what works. Everything on it was rendered through the service before it was written down.

You can use a template in three ways: save it under **Templates** in the dashboard and refer to it by id (`t_...`) in a signed URL or an API call; send it inline as `html` and `css` to [`POST /v1/images`](/docs/api#post-v1-images); or use one of the [starter templates](#starter-templates).

## How a card is built

The card is rendered as a document:

```text
html
├── style      the base stylesheet, then your <style> elements, then your css
└── body       state classes are added here
    └── your HTML
```

- Your HTML can be a fragment (`<div class="card">...</div>`) or a full document. `<html>`, `<head>` and `<body>` wrappers are unwrapped; `class`, `id`, `style`, `dir` and `lang` on your `<html>` and `<body>` are kept.
- `<style>` elements anywhere in your HTML are collected in document order and placed before the separate `css` text.
- The canvas is the output size: [[size.og.width]] x [[size.og.height]] (`og`), [[size.square.width]] x [[size.square.height]] (`square`) or [[size.portrait.width]] x [[size.portrait.height]] (`portrait`). `html` and `body` fill it. Content outside it is clipped.
- The output is always opaque. Anything you leave transparent is white.

## Placeholders

`{{key}}` is replaced by the value of `key` in your data. Spaces inside the braces are allowed: `{{ key }}`.

```html
<h1>{{title}}</h1>
<img src="{{logo}}" width="48" height="48">
<div class="badge" style="background: {{color}}">{{tag}}</div>
```

- Placeholders work in text and in attribute values, including `src`, `class` and `style`.
- Keys start with a lowercase letter and contain only lowercase letters, digits and `_`, at most 32 characters. This is the same rule as for data keys and URL parameters.
- A key with no value becomes an empty string.
- Values are inserted as text after the HTML has been parsed. A value can never add markup: `<b>hi</b>` in a value is drawn as that text, angle brackets included.
- **Placeholders are not replaced inside CSS**, neither in `<style>` nor in the `css` text. To let data change the design, use a `style` attribute as above, or the state classes below.
- An `<img>` whose `src` is empty after replacement is removed. A `style` declaration whose `url()` is empty after replacement is dropped. An optional image therefore needs no extra markup.

## State classes

Before rendering, classes are added to `<body>` so that plain CSS can adapt the design to the size and to the data.

### Size

One of `size-og`, `size-square`, `size-portrait`.

```css
.card { padding: 64px 72px; }
.size-square .card, .size-portrait .card { padding: 88px 72px; }
```

`@media` queries on the canvas width work too.

### Theme

`theme-<value>` when the data has a `theme` value made of lowercase letters, digits and `-` (at most 32 characters). `theme` does not have to appear as a placeholder.

```css
.theme-dark { background: #10162f; color: #f8fafc; }
```

Because the class is on `<body>`, `.theme-dark` styles the body itself and `.theme-dark h1` styles what is inside it.

### Present or missing

For every key that appears as a placeholder in the template: `has-<key>` when the value contains something other than white space, otherwise `no-<key>`.

```css
.no-summary .summary { display: none; }
.has-logo .site { margin-left: 16px; }
```

### Length

For every placeholder key, one of four classes, by the number of characters in the trimmed value:

| Class | Value length |
| --- | --- |
| `len-<key>-s` | 0 to 30 |
| `len-<key>-m` | 31 to 60 |
| `len-<key>-l` | 61 to 100 |
| `len-<key>-xl` | more than 100 |

```css
h1 { font-size: 88px; }
.len-title-m h1 { font-size: 72px; }
.len-title-l h1 { font-size: 58px; }
.len-title-xl h1 { font-size: 46px; }
```

There is no automatic text fitting. Step the font size down with these classes and test with your longest realistic title.

## The base stylesheet

This stylesheet is applied before yours. It is printed here verbatim.

```css
*, *::before, *::after { box-sizing: border-box }
html, body { width: 100%; height: 100%; margin: 0; padding: 0 }
body { font-family: Inter; overflow: hidden; background: #ffffff; color: #111827 }
code, kbd, samp, pre { font-family: "JetBrains Mono" }
```

Everything else follows the engine's browser-like defaults: a 16px font size, block and inline elements, default margins on headings, paragraphs and lists.

## What works

- Block and inline layout, flexbox and CSS grid.
- Stylesheets with element, class and child selectors, `:nth-child()`, `:first-child`, `:last-child`, specificity and source order as in a browser.
- `::before` and `::after` with `content`.
- Custom properties: `--accent: #ffb454` and `var(--accent)`.
- `@media` queries.
- `style` attributes.
- Inline `<svg>` with shapes and paths.
- Lists (`<ul>`, `<ol>`) with markers.

## What does not work

| You write | What happens |
| --- | --- |
| `<script>`, `on...` attributes | Removed. No JavaScript runs, ever. |
| `<link>`, `@import`, `@font-face` | Ignored. External stylesheets and web fonts are not loaded. |
| `@keyframes` and other at-rules except `@media` | Ignored. A card is a still image. |
| `<table>`, `<ruby>` | Laid out as plain boxes, not as a table. Use flex or grid. |
| `<button>`, `<form>`, `<input>`, `<select>`, `<textarea>` and other form controls | Removed together with their content. Style a `<div>` or `<span>` instead. |
| `<iframe>`, `<object>`, `<embed>`, `<video>`, `<audio>`, `<canvas>`, `<template>`, `<noscript>`, `<meta>`, `<title>`, `<base>` | Removed. |
| `<text>`, `<tspan>`, `<textPath>` inside inline `<svg>` | The render fails with 422 `template_error`. Convert the text to paths, or place an HTML element over the SVG. |
| `<image>`, `<foreignObject>` and animation elements inside inline `<svg>` | Removed. |
| `srcset`, `poster`, `src` on anything but `<img>` | Removed. Only `<img src>` and CSS `url()` load images. |

Each of the "removed", "ignored" and "plain boxes" cases adds a [warning](#warnings) to the render, so you can see what was dropped.

## Fonts

Three families are built in. Use these names in `font-family`.

| Family | Weights and styles | Covers |
| --- | --- | --- |
| `Inter` (the default) | 400, 600, 700, 800 | Latin, Latin Extended, Cyrillic, Greek, Vietnamese |
| `"Source Serif 4"` | 400, 600, 400 italic | Latin, Latin Extended |
| `"JetBrains Mono"` | 400, 700 | Latin, Latin Extended |

Other weights and styles of these families are not bundled, so stay with the ones listed.

Generic family names are mapped to the bundled fonts:

| You write | You get |
| --- | --- |
| `sans-serif`, `system-ui`, `ui-sans-serif` | Inter |
| `serif`, `ui-serif` | Source Serif 4 |
| `monospace`, `ui-monospace` | JetBrains Mono |

A family that is neither bundled nor uploaded is skipped, and the render reports it:

```text
Font families not available: Comic Sans MS, cursive. Text uses the next family in the list, or Inter.
```

### Your own fonts

On the [[plan.starter.name]] and [[plan.pro.name]] plans you can upload fonts under **Fonts** in the dashboard: [[plan.starter.fontFiles]] files of up to [[plan.starter.fontMb]] MB each on [[plan.starter.name]], [[plan.pro.fontFiles]] files of up to [[plan.pro.fontMb]] MB each on [[plan.pro.name]].

- Formats: TTF, OTF and WOFF. WOFF2 files and font collections (`.ttc`) are refused; convert them first.
- Each file is one family name, one weight (100 to 900) and one style (normal or italic). Upload one file per weight you use.
- The family name may contain letters, digits, spaces, `_` and `-`, and cannot be the name of a bundled or generic family.
- A font is test-rendered when you upload it. A file that cannot be used is refused and nothing is stored.
- Name the family in your CSS: `font-family: "Your Family", Inter`. An uploaded font is used only where your CSS asks for it; it is not a fallback for missing characters.
- Uploaded fonts are used only while the account is on a paid plan.

## Emoji

Emoji in any text are drawn as colour graphics (Twemoji), whatever the font, including flags and joined sequences such as 👩‍💻. An emoji that is not available is left blank and reported in the warnings.

## Images

Only `<img src>` and CSS `url()` can load an image, and only from:

- an absolute `http://` or `https://` URL, or
- a `data:` URI of type `image/png`, `image/jpeg`, `image/gif` or `image/svg+xml` (base64; SVG may also be URL-encoded).

Relative URLs, other schemes and `url(var(...))` fail with 422 `template_error`.

Remote images are fetched once per render, with these rules:

| Rule | Value |
| --- | --- |
| Different remote URLs per card | [[limit.maxImages]] |
| File size | [[limit.maxImageMb]] MB each |
| Pixel size | [[limit.maxImageMegapixels]] megapixels each (width x height) |
| File types | PNG, JPEG, GIF and WebP, decided by the `Content-Type` the server sends. Remote SVG is not accepted; use a `data:` URI for SVG. |
| Host | A public host name on the default port (443 for https, 80 for http) |
| Time and redirects | 4 seconds, at most 3 redirects |

WebP images are converted to PNG before drawing, which takes time and can push a large photo over the size limit. Prefer PNG or JPEG sources.

Give every `<img>` a `width` and a `height`, as attributes or in CSS.

When an image cannot be loaded, the render fails with 422 `image_fetch_failed`. Nothing is stored or counted. The body names the URL and the reason:

```json
{
  "error": {
    "code": "image_fetch_failed",
    "message": "Image URLs must use the default port (443 for https, 80 for http); port 8443 is not allowed.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": { "reason": "bad_port", "url": "https://img.example.org:8443/logo.png" }
  }
}
```

`details.reason` is one of `bad_url`, `bad_scheme`, `bad_port`, `blocked_host`, `dns_failed`, `too_many_redirects`, `timeout`, `http_error`, `bad_content_type`, `too_large`, `too_many_pixels`, `decode_failed`.

## Limits

| Limit | Value | Error when exceeded |
| --- | --- | --- |
| Template HTML | [[limit.maxHtmlKb]] KB | 413 `payload_too_large` |
| Template CSS | [[limit.maxCssKb]] KB | 413 `payload_too_large` |
| Elements | [[limit.maxNodes]] | 422 `template_error` |
| Nesting depth | [[limit.maxDepth]] levels | 422 `template_error` |
| Text on the card, after placeholders are filled | [[limit.maxTextChars]] characters | 422 `template_error` |
| Data | [[limit.maxDataKeys]] keys, [[limit.maxDataValueChars]] characters per value | 400 `invalid_request` |
| Shadow and blur size | see below | 422 `template_error` |
| Shadow and filter effects | [[limit.maxFilters]] per card | 422 `template_error` |
| Render time, image downloads included | [[limit.renderTimeoutSeconds]] seconds | 504 `render_timeout` |

### Shadows, blur and filters

Large blurs are expensive to draw, so they have hard limits:

- `box-shadow` and `text-shadow`: a blur radius of at most [[limit.maxBlurPx]]px.
- `filter: blur()`, `filter: drop-shadow()` and `backdrop-filter: blur()`: at most 12px.

The limit is checked on the finished drawing, so a value that comes from a custom property is measured like any other. A shadow whose blur is written with `calc()` is not drawn at all.

A card may use at most [[limit.maxFilters]] effects. They are counted like this:

- each `box-shadow` layer on each element is one;
- a `text-shadow` is one per run of text it applies to (a headline that contains one `<b>` is three runs);
- each `filter` and each `backdrop-filter` is one.

Nine paragraphs with one `box-shadow` each are therefore one too many:

```text
The card uses 9 shadow / filter effects; the limit is 8. Every box-shadow layer, text-shadow (once per text run), filter and backdrop-filter counts as one.
```

## Starter templates

Five templates are ready to use by id. All five take `title`, `description`, `author`, `image`, `site` and `tag`. All but `dark` also take `theme` (`light` or `dark`). Only `title` is marked as required: the designs are built around it. The service does not reject a request without it, and every other field can be left out.

`image` is always an absolute image URL and follows the [image rules](#images) above.

### blog

Blog post. A serif headline on warm paper, with a sun rising over the author line.

| Field | Meaning |
| --- | --- |
| `title` | Headline of the article. |
| `description` | One or two lines under the headline. |
| `author` | Author name, shown in the bottom line. |
| `image` | Author photo, drawn as a small circle. Square works best. |
| `site` | Domain or publication name, shown small in the bottom line. |
| `tag` | Category shown above the headline in small capitals. |
| `theme` | `light` (default) or `dark`. |

### dark

Dark. A high-contrast card for developer content, set like an open file in a code editor.

| Field | Meaning |
| --- | --- |
| `title` | Headline, set in monospace next to the line numbers. |
| `description` | One or two lines under the headline, shown as a code comment. |
| `author` | Author, team or project name, shown in the status bar. |
| `image` | Logo or avatar, drawn as a small rounded square in the status bar. |
| `site` | Domain or site name, shown in the status bar after the author. |
| `tag` | Short label shown as the open editor tab, for example a topic or a file name. |

### quote

Quote. A quotation as a poster: serif italic on a loud colour field, with the speaker on an ink band.

| Field | Meaning |
| --- | --- |
| `title` | The quotation, without quote marks (the template draws its own). |
| `author` | Who said it. |
| `description` | Their role, or the source of the quotation; one line under the name. |
| `image` | Portrait of the person, drawn as a circle next to the name. Square works best. |
| `site` | Domain or site name, shown small in the top right corner. |
| `tag` | Small label in the top right corner, in capitals. |
| `theme` | `light` (default, yellow field) or `dark` (ink field, yellow band). |

### launch

Launch. An announcement card for a launch, a release or a new feature, drawn as a ticket with a tear-off stub.

| Field | Meaning |
| --- | --- |
| `title` | The announcement. |
| `description` | One or two lines under the announcement. |
| `author` | Product, company or team name, shown in bold at the bottom of the ticket. |
| `image` | Product logo; replaces the spark on the stub. Square works best. |
| `site` | Domain or site name, printed under the bar code on the stub. |
| `tag` | Short label in the pill above the announcement, for example "New" or a version number. |
| `theme` | `light` (default) or `dark`. |

### docs

Documentation. A documentation page card drawn like a blueprint: a breadcrumb, the page title on a dimension line and a ruler.

| Field | Meaning |
| --- | --- |
| `title` | Title of the documentation page. |
| `description` | One or two lines that summarise the page. |
| `author` | Project, product or version name, shown in monospace next to the ruler. |
| `image` | Project logo, drawn small before the breadcrumb. Square works best. |
| `site` | Docs domain or site name: the first part of the breadcrumb. |
| `tag` | Section of the docs: the second part of the breadcrumb. |
| `theme` | `light` (default, drafting paper) or `dark` (blueprint blue). |

The same list, with an example value for each field, is returned by [`GET /v1/templates`](/docs/api#get-v1-templates).

## A complete example

A release-note card that uses most of this page: placeholders in text and in an attribute, an optional image, custom properties, a theme, and classes for size, missing values and title length.

HTML:

```html
<div class="card">
  <div class="top">
    <span class="tag">{{tag}}</span>
    <span class="version">{{version}}</span>
  </div>
  <h1>{{title}}</h1>
  <p class="summary">{{summary}}</p>
  <div class="foot">
    <img class="logo" src="{{logo}}" width="48" height="48">
    <span class="site">{{site}}</span>
  </div>
</div>
```

CSS:

```css
:root { --bg: #10162f; --ink: #f8fafc; --soft: #a5b4d4; --accent: #ffb454; }
.theme-light { --bg: #fff8ec; --ink: #1c1917; --soft: #6b6257; --accent: #c2410c; }

body { background: var(--bg); color: var(--ink); }
.card { display: flex; flex-direction: column; width: 100%; height: 100%; padding: 64px 72px; }

.top { display: flex; align-items: center; gap: 20px; font-family: "JetBrains Mono"; font-size: 26px; }
.tag { padding: 6px 16px; border: 2px solid var(--accent); border-radius: 999px; color: var(--accent); }
.version { color: var(--soft); }
.no-tag .tag, .no-version .version { display: none; }

h1 { margin: auto 0 0; font-family: "Source Serif 4"; font-weight: 600; font-size: 88px; line-height: 1.05; }
.len-title-m h1 { font-size: 72px; }
.len-title-l h1 { font-size: 58px; }
.len-title-xl h1 { font-size: 46px; }

.summary { margin: 24px 0 0; font-size: 32px; line-height: 1.35; color: var(--soft); }
.no-summary .summary { display: none; }

.foot { display: flex; align-items: center; gap: 16px; margin-top: 48px; font-size: 26px; font-weight: 600; }
.logo { border-radius: 12px; }
.no-site.no-logo .foot { display: none; }

.size-square .card, .size-portrait .card { padding: 88px 72px; }
.size-portrait h1 { font-size: 96px; }
```

Saved as a template in the dashboard, it got the id `t_mnd7x9sk3v8bwbmc`. This request renders it:

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "t_mnd7x9sk3v8bwbmc",
    "size": "og",
    "data": {
      "tag": "Release",
      "version": "v2.4.0",
      "title": "Dark mode is here",
      "summary": "Every screen, every chart, every email.",
      "site": "tidepool.example"
    }
  }'
```

```json
{
  "id": "70e28c62871fd5ab020d4443b495e14cb7f3b69499e6cae4fa7b375285b23ec1",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/70e28c62871fd5ab020d4443b495e14cb7f3b69499e6cae4fa7b375285b23ec1.png",
  "width": 1200,
  "height": 630,
  "format": "png",
  "bytes": 33807,
  "cached": false,
  "template": "t_mnd7x9sk3v8bwbmc",
  "created_at": "2026-11-22T09:36:37.368Z",
  "expires_at": "2026-11-29T09:36:37.368Z",
  "warnings": [],
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": 100,
    "used": 8,
    "remaining": 92,
    "topup_remaining": 0,
    "total_remaining": 92,
    "cache_days": 7,
    "watermark": true
  }
}
```

What the classes did in this render:

- No `logo` was sent, so the `<img>` was removed and `<body>` got `no-logo`. `site` was sent, so the footer stays.
- The title has 17 characters: `len-title-s`, the largest type size. An 82-character title gets `len-title-l` and 58px, and wraps to three lines.
- `"size": "square"` and `"size": "portrait"` render the same template at [[size.square.width]] x [[size.square.height]] and [[size.portrait.width]] x [[size.portrait.height]]; the two `size-` rules adjust padding and type. Each size is its own image.
- Adding `"theme": "light"` to the data switches the four custom properties.

The same template works in a signed URL: `/v1/og/{site id}/t_mnd7x9sk3v8bwbmc.png?title=...&version=...&sig=...`.

## Warnings

A render that succeeds can still report warnings: something in the template was removed, ignored or could not be drawn as written. You see them:

- in the `warnings` array of the `POST /v1/images` response;
- in the `X-LTC-Warnings` header when you ask for the bytes;
- next to the live preview in the dashboard's template editor.

Warnings are reported by the request that renders the image. A response served from cache has an empty list. Signed URLs return only the image, so check a new template in the dashboard or through the API first.

## Known limitations

- **Scripts outside the bundled fonts.** Arabic, Hebrew, Chinese, Japanese, Korean, Thai, Devanagari and other scripts that the three bundled families do not cover are drawn as empty boxes, with a warning such as `No bundled font covers Arabic characters`. To use them, upload a font that covers the script (paid plans) and name it in `font-family`. A complete font for Chinese, Japanese or Korean can be larger than the per-file upload limit ([[plan.starter.fontMb]] MB on [[plan.starter.name]], [[plan.pro.fontMb]] MB on [[plan.pro.name]]); a larger file is refused. Subset such a font first.
- **Some symbols.** A few symbols are not in the bundled fonts either. The arrow `→` is one. Use an inline SVG or an emoji.
- **Right-to-left text.** With an uploaded font, Arabic and Hebrew text is shaped and ordered correctly, and `dir="rtl"` or `direction: rtl` aligns text to the right, orders mixed text and flex rows from right to left and wraps lines correctly. List markers stay on the left. This was tested with one font (DejaVu Sans) and short texts; check your own design in the dashboard preview. Without `dir="rtl"` the base direction is left to right.
- **Lists.** `<ul>` and `<ol>` render correctly, but each render that contains one reports a warning that begins `Ignored style:` and mentions `fontFamily`. It does not affect the image.
- **Long words.** A single word wider than its box overflows it. Add `overflow-wrap: anywhere` or `word-break: break-word` to the element to let the word break.
- **No text in SVG.** See [What does not work](#what-does-not-work).
- **No automatic fitting.** Text that does not fit its box overflows or is clipped by the canvas. Use the [length classes](#length).
