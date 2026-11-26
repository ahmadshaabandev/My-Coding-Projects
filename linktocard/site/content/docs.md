---
title: Documentation
description: What [[site.name]] does, what it does not do, and the two ways to use it - a signed image URL in a meta tag, or a REST call.
layout: doc
order: 1
nav: Overview
---

[[site.name]] renders social-card images (the picture a chat app or a social network shows when someone shares your link) from an HTML and CSS template plus a few text values.

You can use it in two ways.

## 1. A signed URL in a meta tag

You build a URL on your server, sign it with your site secret, and put it in the page:

```html
<meta property="og:image" content="[[site.url]]/v1/og/s_4k2j9x0q1m7c8d5e/blog.png?title=Hello+world&amp;sig=...">
```

The image is rendered the first time someone requests the URL and is then served from cache. Nothing runs on your side at request time. Start with the [Quickstart](/docs/quickstart), then read [Signed URLs](/docs/signed-urls).

## 2. A REST call

You send a template and data, and get back a URL or the image bytes:

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template": "blog", "data": {"title": "Hello world"}}'
```

See the [API reference](/docs/api).

<!-- feature:pdf -->
## PDF documents

The same idea, a template plus data, also makes PDF documents: invoices, receipts, quotes, certificates of completion, reports, or anything you write in HTML and CSS. Send it to `POST /v1/pdf` with an API key, or sign a link to `/v1/pdf/...` like a card URL. [PDF documents](/docs/pdf) has the details, and the free [HTML to PDF](/tools/html-to-pdf) tool lets you try it without an account.

<!-- /feature:pdf -->
To see what a page sends today, before or after you add a card, paste its address into the free [Open Graph checker](/tools/og-checker); [`GET /v1/inspect`](/docs/api#get-v1-inspect) returns the same check as JSON.

## What you get

- **Sizes:** [[size.og.width]] x [[size.og.height]] (`og`), [[size.square.width]] x [[size.square.height]] (`square`), [[size.portrait.width]] x [[size.portrait.height]] (`portrait`) and [[size.email.width]] x [[size.email.height]] (`email`).
- **Formats:** PNG, JPEG and WebP.
- **Templates:** five starter templates (`blog`, `dark`, `quote`, `launch`, `docs`), or your own HTML and CSS.
- **Text:** `{{placeholders}}` filled from your data. Classes on `<body>` let plain CSS react to missing or long values.
- **Fonts:** Inter, Source Serif 4 and JetBrains Mono are built in. You can upload your own on paid plans.
- **Emoji:** colour emoji in any text.
<!-- feature:pdf -->
- **PDFs:** up to [[pdf.maxPages]] pages from your own HTML or one of [[pdf.templateCount]] PDF starter templates (`[[pdf.templateIds]]`), as a stored URL or the file itself.
<!-- /feature:pdf -->

## What it does not do

- No visual editor. Templates are HTML and CSS that you write, or one of the five starter templates.
<!-- feature:no-pdf -->
- No screenshots. The renderer does not load web pages and cannot capture an existing page. (The checker reads a page's tags; it does not draw the page.)
- No video, GIF or PDF output. One request gives one still image.
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
- No screenshots. Nothing here opens a web page by its address to capture it: cards are drawn from your template, PDFs are printed from the HTML you send, and the checker reads a page's tags without drawing the page.
- No video or GIF. A card request gives one still image; a PDF request gives one document.
<!-- /feature:pdf -->
- No AI. Nothing is generated; the card shows exactly the text and images you send.
<!-- feature:no-pdf -->
- No browser. Templates are drawn by a layout engine that understands a large part of CSS, but JavaScript never runs and some HTML is not supported. [HTML and CSS templates](/docs/html-css-templates) lists exactly what works.
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
- No browser for cards. Card templates are drawn by a layout engine that understands a large part of CSS, but JavaScript never runs and some HTML is not supported. [HTML and CSS templates](/docs/html-css-templates) lists exactly what works. PDFs are the one exception: Cloudflare Browser Run prints them in headless Chrome, with JavaScript turned off and no network access.
<!-- /feature:pdf -->

## Pages

- [Quickstart](/docs/quickstart): a working `og:image` in about five minutes, then the same card through the API.
- [Signed URLs](/docs/signed-urls): the signature format, signer code for Node.js, PHP and Python, caching, rotation, and every reason for a 403.
- [HTML and CSS templates](/docs/html-css-templates): placeholders, state classes, fonts, emoji, images, the starter templates and a complete example.
- [Frameworks](/docs/frameworks): plain HTML, WordPress, Ghost, Webflow, Hugo, Astro and Next.js.
<!-- feature:pdf -->
- [PDF documents](/docs/pdf): `POST /v1/pdf` and signed PDF links, the PDF starter templates, sections for line items, limits and how a PDF is counted.
<!-- /feature:pdf -->
<!-- feature:email -->
- [Email images](/docs/email-images): signed card URLs with open fields that an email platform fills in for each reader.
<!-- /feature:email -->
<!-- feature:linkcards -->
- [Cards from links](/docs/link-cards): a card made from a page's own title, description and icon, through the API or a signed link URL.
<!-- /feature:linkcards -->
<!-- feature:batch -->
- [Bulk documents](/docs/bulk): one PDF for every row of your data, ZIP downloads, and certificates with a public verification page.
<!-- /feature:batch -->
<!-- feature:toolkit -->
- [PDF toolkit](/docs/pdf-tools): merge, split, stamp, fill, read form fields, images to PDF and password protection, without a browser.
<!-- /feature:toolkit -->
- [API reference](/docs/api): every endpoint, field, header and error code, including `GET /v1/inspect`.
- [Limits](/docs/limits): what each plan includes, the technical limits, and what happens when you reach one.
<!-- feature:integrations -->
- [Zapier, Make and n8n](/docs/integrations): the connectors being prepared for listing, and how to call the API from a workflow today.
<!-- /feature:integrations -->

Questions that these pages do not answer: [[site.supportEmail]].
