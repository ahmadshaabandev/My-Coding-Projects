---
title: AI images
description: "Covers, newsletter headers and QR codes on backgrounds drawn by an AI model: POST /v1/ai/covers, POST /v1/ai/qr, brand presets, batches, signed cover URLs, what counts as a credit, the free preview, limits, errors, content rules and what is kept."
layout: doc
order: 3.8
nav: AI images
feature: ai
---

The AI image tools make three kinds of picture: an Open Graph cover for a page, a newsletter header, and a QR code for a link. In each, an AI model draws only the background. Your text, your logo and the QR code are drawn by the same renderer that draws every [[site.name]] card.

There are four ways to use them:

- the free pages, with a preview that needs no account: the [OG image generator](/tools/og-image-generator), [bulk blog covers](/tools/bulk-blog-covers) and [AI QR code art](/tools/ai-qr-code-art);
- **`POST /v1/ai/covers`** and **`POST /v1/ai/qr`** with an API key, one image per request;
- **`POST /v1/ai/batches`**, a cover for every item of a feed, a CSV file or a list;
- a **signed cover URL** (`GET /v1/ai/cover/...`) that you put in a meta tag: the cover is made the first time it is opened.

## What the AI does, and what it does not

- **The model never sees your text.** The image prompt is written by our server from your choices only, in our own words: a style, up to [[ai.maxPaletteColors]] colours, a motif and a layout. Titles, descriptions, site names, links and file names are never part of it. With the motif `auto`, our server picks a motif from a fixed list of keywords found in the title; the title itself is not sent.
- **It draws the background only.** It is asked for a calm, empty area where the text goes, and for no text, letters, numbers, logos, watermarks, people, faces, hands, bodies, documents, forms or screens.
- **Every background is checked before it is used.** A second AI model looks at it for readable text, documents or forms, human faces, people or bodies, brand logos and nudity. A background that fails is drawn once more with a new seed; if it fails again, the request answers 422 `unclean_output` and nothing is charged. Cloudflare Workers AI also refuses some pictures itself (422 `content_flagged`, not charged). These checks are good, not perfect.
- **The model:** Black Forest Labs&rsquo; FLUX.2 [klein] model, run by Cloudflare Workers AI. The check is a second model on Cloudflare Workers AI.
- **No free-text prompt.** There is no way to describe a picture in your own words, to ask for a person, a face swap, an avatar or a likeness, a brand&rsquo;s logo, or a document such as an ID card.

## Styles, motifs and colours

| Field | Values |
| --- | --- |
| `style` | [[ai.styles]] |
| `motif` | `auto` (the default), or one of [[ai.motifs]] |
| `layout` | `left` (the default: a calm left half for the text) or `center` (a calm centre) |
| `palette` | Up to [[ai.maxPaletteColors]] colours, each `#rrggbb`. They are sent to the model as colour words and hex codes. |

Reference images, which a model may follow for the look of a background, are experimental. In our trial they steered the style only weakly, and they are offered only while they are switched on for the service.

## Covers

`POST /v1/ai/covers` with an API key makes one cover or newsletter header, stores it and answers with its URL and the meta tags to paste. The dashboard and the free page use `POST /api/ai/covers` with your session, with the same fields.

```bash
curl [[site.url]]/v1/ai/covers \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "How we cut our build time in half", "site_name": "example.com", "style": "paper-cut", "palette": ["#1d3557", "#f1faee"], "layout": "left"}'
```

| Field | Required | What it is |
| --- | --- | --- |
| `title` | Yes | The text set on the cover by our renderer. |
| `description` | | A shorter line under the title. |
| `site_name` | | Shown at the bottom of the cover. |
| `style` | Yes, unless `preset_id` gives it | One of the styles above. |
| `palette`, `motif`, `layout` | | As above. |
| `preset_id` | | A brand preset: its style, colours, motif rule, layout, size and logo are used, and the fields of the request override them. |
| `logo_id` | | A logo uploaded in the dashboard, drawn on top by our renderer. It is never sent to the model. |
| `background_id` | | The background of a free preview made in the last [[ai.previewHours]] hours, or one drawn for your account in the last [[ai.backgroundHours]] hours, so the cover shows exactly that background. Without it a new background is drawn. |
| `size` | | `cover` ([[ai.coverWidth]] x [[ai.coverHeight]], the default) or `header` ([[ai.headerWidth]] x [[ai.headerHeight]], for newsletters). |

The answer has `id`, `url` (the PNG), `width`, `height`, `credits_used` (always 1), `meta_tags` and `usage`. `meta_tags` holds `og:image`, `og:image:width`, `og:image:height`, `og:image:alt`, `twitter:card` and `twitter:image`, ready to paste into the page&rsquo;s `<head>`.

A new background for the same text is a new request: it costs [[ai.creditsPerImageText]] again.

## The free preview

The free pages make a preview without an account, after a Cloudflare Turnstile check that the visitor is a person. Previews are a feature of the website, not of the API.

- A cover preview is [[ai.previewWidth]] x [[ai.previewHeight]], a QR preview [[ai.qrPreviewPx]] x [[ai.qrPreviewPx]], both PNG with a small corner mark.
- From one network (an IPv4 address, or an IPv6 /64 network): [[ai.freePreviewsPerPageText]] per page or per QR link a day, and at most [[ai.freePreviewsPerDay]] free previews a day.
- A preview and the full-size background behind it are kept for [[ai.previewHours]] hours. Making the full-size cover from it, with its `background_id`, reuses that exact background.
- When the day&rsquo;s spending limit for free previews is reached, they answer 503 `ai_busy` until 00:00 UTC.

## Brand presets

A brand preset holds a name, a style, colours, a motif rule (`auto` or one motif), a layout, a size (`cover` or `header`), and optionally a logo and reference images. They are made and changed in the dashboard; `GET /v1/ai/presets` lists them, with their ids, for the API.

## Batches

`POST /v1/ai/batches` makes a cover for every item, one by one, in the background:

```json
{ "preset_id": "YOUR_PRESET_ID", "source": { "rss_url": "https://example.com/feed.xml" } }
```

`source` is one of:

- `{ "rss_url": "..." }`: an RSS or Atom feed, read once;
- `{ "csv": "..." }`: CSV text with the columns `title`, then optionally `description` and `url`;
- `{ "items": [ { "title": "...", "description": "...", "url": "..." } ] }`.

`GET /v1/ai/batches` lists your batches, `GET /v1/ai/batches/{id}` answers the progress of one, and `GET /v1/ai/batches/{id}/zip` downloads its finished covers in one ZIP file. The dashboard shows the same, and we email you when a batch has finished. The feed is fetched by our server in the same way as the Open Graph checker fetches a page.

Each finished cover costs [[ai.creditsPerImageText]], taken when it is stored. When the credits run out, the batch pauses and its status says so; no cover is made or charged without a credit.

## Signed cover URLs

A signed cover URL makes a cover from a preset the first time someone opens it, and serves the stored cover after that:

```text
[[site.url]]/v1/ai/cover/YOUR_SITE_ID.png?preset=YOUR_PRESET_ID&title=Hello+world&description=A+first+post&sig=...
```

It is signed with your site secret exactly like a card URL: see [the signed message](/docs/signed-urls#the-signed-message). The URL takes `preset`, `title`, `description` and `sig`. A signed cover is made and charged once; later views are served from storage and cost nothing.

## QR codes

`POST /v1/ai/qr` with an API key (or `POST /api/ai/qr` with your session) makes a QR code for one link on an AI background:

```json
{ "url": "https://example.com/menu", "style": "watercolor", "palette": ["#2a9d8f"] }
```

`background_id` may name the background of a free QR preview. The answer has `id`, `png_url` (a [[ai.qrFullPx]] x [[ai.qrFullPx]] PNG), `svg_url` (the QR code alone, as SVG), `verified` (always `true`) and `credits_used` (always 1).

- **The code is real and plain.** It is made by an ordinary QR library with error correction level [[ai.qrErrorCorrection]], and drawn on a solid light plate with a quiet border of [[ai.qrQuietZoneModules]] modules, its dark squares at a contrast of at least [[ai.qrMinContrast]]:1 against the plate, at least [[ai.qrMinWidthPercent]]% of the image width. The AI model draws only the picture around the plate, and never sees the link.
- **It is read back before you get it.** Our server draws the image and decodes it, at full size and at one third of the size; the decoded text must equal your link exactly. If it does not, the code is made larger, then plain black on white. A code that still does not read back is never returned or charged. No check covers every phone camera, printer and screen, so scan it with your own phones before you print.
- **It is static.** The link itself is in the code, with no redirect of ours in between.
- **Links that are refused** (422 `url_refused`, with `details.reason`): anything but http or https (`not_http`), more than [[ai.maxUrlChars]] characters, a user name or password in the address, an IP address as the host, a known link shortener (`shortener`), a domain that Cloudflare&rsquo;s security DNS resolver blocks as malware or phishing (`blocked_domain`), and our own blocklist. Refusals are recorded, so that we can look into abuse.

Anyone can report a QR code from the [tool page](/tools/ai-qr-code-art#report) or at [[site.supportEmail]].

## What counts

A credit here is one image of your allowance, the same unit as a card image.

- Each full-size AI image costs [[ai.creditsPerImageText]]: a cover, a newsletter header, a QR code, a new background for the same text, each finished cover of a batch, and the first view of a signed cover URL.
- [[ai.paidByText]]
- Previews are free. A refused, flagged or failed request, a timeout, and a QR code that does not read back are never charged.
- On the [[plan.free.name]] plan, a full-size AI image carries the corner mark, like every image made on that plan.

## Limits

| Limit | Value |
| --- | --- |
| Colours per image | [[ai.maxPaletteColors]] |
| Logo | PNG or JPEG, at most [[ai.maxLogoKb]] KB and [[ai.maxLogoPx]] x [[ai.maxLogoPx]] pixels |
| Reference images | Up to [[ai.maxReferences]], PNG or JPEG, at most [[ai.maxReferencePx]] x [[ai.maxReferencePx]] pixels and [[ai.maxReferenceKb]] KB each |
| AI images per account | [[ai.maxImagesPerAccountPerDay]] per UTC day |
| QR code link | [[ai.maxUrlChars]] characters |
| Free previews | [[ai.freePreviewsPerDay]] per network per UTC day, [[ai.freePreviewsPerPageText]] per page or QR link |
| Time to draw one background | [[ai.timeoutSeconds]] seconds; then 504, not charged |

Our side also has a daily spending limit for AI images. When it is reached, new AI images answer 503 `ai_busy` until 00:00 UTC, and nothing is charged.

## Errors

Every error has the usual body, `{ "error": { "code", "message", "docs", "details" } }`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | A field is missing or not allowed: an unknown style or motif, a colour that is not `#rrggbb`, too many colours. The message names the field. |
| 402 | `quota_exceeded` | No credits are left for this image. |
| 402 | `ai_credits_required` | Only the monthly images of the [[plan.free.name]] plan are left, and they do not pay for AI images. A top-up does. |
| 403 | `turnstile_failed` | The free page&rsquo;s check that you are a person did not pass. Website only. |
| 422 | `content_flagged` | Cloudflare Workers AI refused to make the picture. Not charged. |
| 422 | `unclean_output` | The background failed the check twice. Not charged; try another style or motif. |
| 422 | `upload_refused` | A logo or reference image is too large, not PNG or JPEG, or failed the check. |
| 422 | `url_refused` | The QR link is refused; `details.reason` says why. |
| 429 | `rate_limited` | Too many requests, or the free previews of the day are used up. |
| 502 | `ai_unavailable` | The AI model answered with an error. Not charged; try again. |
| 503 | `ai_busy` | The daily spending limit for AI images is reached. Not charged; try again after 00:00 UTC. |
| 503 | `not_configured` | The AI image tools are not switched on. |
| 504 | `ai_timeout` | The model took longer than [[ai.timeoutSeconds]] seconds. Not charged. |

## Content rules

The [terms](/terms#4b-ai-images) apply to every AI image. In short, it may not be used for nudity or sexual content, real people&rsquo;s faces, face swaps, avatars or likenesses, logos of brands that are not yours, documents, IDs or anything that looks like a verification document, impersonation, misleading QR codes, or QR codes that lead to phishing or malware. Upload only logos and reference images that are yours or that you may use. We may refuse or remove an image and suspend an account that breaks these rules.

## What is kept

- **Previews,** and the full-size background behind each: [[ai.previewHours]] hours, then deleted.
- **Full-size covers, headers and QR codes:** until you delete them or your account is deleted. A cover named in meta tags must not disappear.
- **Logos and reference images:** [[ai.uploadHours]] hours, for the images you make with them, unless saved in a brand preset; then until you delete the preset or your account.
- **Batches:** the titles and descriptions of a batch are kept with the batch.
- **Refused QR links and abuse reports:** [[ai.abuseRetentionDays]] days, so that we can look into abuse.

The [privacy policy](/privacy) says what is sent to Cloudflare Workers AI.
