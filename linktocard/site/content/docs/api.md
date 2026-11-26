---
title: API reference
description: Reference for POST /v1/images, GET /v1/usage, GET /v1/templates, GET /v1/inspect, signed card URLs and stored images - authentication, fields, real responses, every error code, rate limits and counting rules.
layout: doc
order: 6
nav: API reference
---

Base URL: `[[site.url]]`

| Endpoint | What it does |
| --- | --- |
| [`POST /v1/images`](#post-v1-images) | Renders one card, or returns it from cache. Needs an API key. |
| [`GET /v1/usage`](#get-v1-usage) | Your allowance for the current period. Needs an API key. |
| [`GET /v1/templates`](#get-v1-templates) | The starter templates and your own. Needs an API key. |
| [`GET /v1/inspect`](#get-v1-inspect) | Checks one page's link-preview tags and its `og:image`. Needs an API key. Counts no images. |
| [`GET /v1/og/...`](#get-v1-og) | A signed card URL, for `og:image`. The signature is the authentication. |
| [`GET /i/...`](#get-i) | A stored image, as returned by `POST /v1/images`. Public. |
<!-- feature:pdf -->

PDF documents have their own page: [`POST /v1/pdf`, signed PDF links and stored PDFs](/docs/pdf#api-reference).
<!-- /feature:pdf -->
<!-- feature:batch -->

Bulk documents have their own page: [`POST /v1/batches`, ZIP downloads and certificate verification](/docs/bulk#api-reference).
<!-- /feature:batch -->
<!-- feature:toolkit -->

The PDF toolkit has its own page: [`POST /v1/pdf-tools/{operation}`](/docs/pdf-tools#api-reference).
<!-- /feature:toolkit -->
<!-- feature:linkcards -->

Cards from links have their own page: [`POST /v1/cards/from-url` and signed `/v1/link/...` URLs](/docs/link-cards).
<!-- /feature:linkcards -->

## Conventions

- Request bodies are JSON in UTF-8, at most [[limit.maxRequestBodyKb]] KB.
- Field names are `snake_case`. Timestamps are ISO 8601 strings in UTC.
- Every response has an `X-Request-Id` header. Quote it when you write to [[site.supportEmail]].
- JSON responses and all error responses carry `Cache-Control: no-store`.
- The API sends no CORS headers. Call it from your server, not from browser JavaScript. Your API key must not be in a browser anyway.
- A path that exists with a different method answers 404 `not_found`, like an unknown path.

## Authentication

Create an API key under **API keys** in the dashboard. A key starts with `ltc_`, is shown once, and can be revoked at any time. An account can have [[limit.maxApiKeys]] keys.

Send it as a bearer token:

```bash
curl [[site.url]]/v1/usage -H "Authorization: Bearer $LTC_API_KEY"
```

Without a valid key the answer is 401 with a `WWW-Authenticate: Bearer` header:

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "Missing API key. Send the header \"Authorization: Bearer <your key>\".",
    "docs": "[[site.url]]/docs/api#errors"
  }
}
```

## POST /v1/images

Renders one card and stores it, or returns the stored one if the same card was rendered before.

### Request

| Field | Type | Description |
| --- | --- | --- |
| `template` | string | A starter template (`blog`, `dark`, `quote`, `launch`, `docs`) or the id of one of your own (`t_...`). Send exactly one of `template` and `html`. |
| `html` | string | An inline template: HTML, at most [[limit.maxHtmlKb]] KB. |
| `css` | string | CSS for the inline template, at most [[limit.maxCssKb]] KB. Only together with `html`. |
| `data` | object | Values for the template's placeholders: a flat object of strings. At most [[limit.maxDataKeys]] keys; each value at most [[limit.maxDataValueChars]] characters. Send numbers and booleans as text. |
| `size` | string | `og` (default), `square`, `portrait` or `email`. |
| `width`, `height` | number | Instead of `size`: both together, and equal to one of the four sizes ([[size.og.width]] and [[size.og.height]], [[size.square.width]] and [[size.square.height]], [[size.portrait.width]] and [[size.portrait.height]], [[size.email.width]] and [[size.email.height]]). |
| `format` | string | `png` (default), `jpeg` or `webp`. `jpg` is accepted for `jpeg`. |
| `response` | string | `json` (default) or `binary`. |

Any other field is refused with 400 `invalid_request`, so a typo such as `tempalte` is noticed.

### Example: a starter template

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "blog",
    "data": {
      "title": "How we cut our build time in half",
      "author": "Maya Chen"
    }
  }'
```

```json
{
  "id": "c4a798890d4bb8fc3b55088e31541dd208d6dd523bead67ba982484b98b89ceb",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/c4a798890d4bb8fc3b55088e31541dd208d6dd523bead67ba982484b98b89ceb.png",
  "width": 1200,
  "height": 630,
  "format": "png",
  "bytes": 34394,
  "cached": false,
  "template": "blog",
  "created_at": "2026-11-22T09:31:27.214Z",
  "expires_at": "2026-11-29T09:31:27.214Z",
  "warnings": [],
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": 100,
    "used": 2,
    "remaining": 98,
    "topup_remaining": 0,
    "total_remaining": 98,
    "cache_days": 7,
    "watermark": true
  }
}
```

### Example: your own HTML and CSS

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "html": "<div class=\"card\"><h1>{{title}}</h1><p>{{site}}</p></div>",
  "css": ".card { display: flex; flex-direction: column; justify-content: center; width: 100%; height: 100%; padding: 80px; background: #10162f; color: #fff } h1 { margin: 0; font-size: 80px } p { margin: 24px 0 0; font-size: 32px; color: #ffb454 }",
  "data": { "title": "Hello from my own template", "site": "example.com" },
  "format": "jpeg"
}'
```

```json
{
  "id": "8557c4ad59cf10e81daebc928f6777601e7e36a8a7f1d71ab4decdabecd7c497",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/8557c4ad59cf10e81daebc928f6777601e7e36a8a7f1d71ab4decdabecd7c497.jpg",
  "width": 1200,
  "height": 630,
  "format": "jpeg",
  "bytes": 29038,
  "cached": false,
  "template": "inline",
  "created_at": "2026-11-22T09:36:38.019Z",
  "expires_at": "2026-11-29T09:36:38.019Z",
  "warnings": [],
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": 100,
    "used": 11,
    "remaining": 89,
    "topup_remaining": 0,
    "total_remaining": 89,
    "cache_days": 7,
    "watermark": true
  }
}
```

[HTML and CSS templates](/docs/html-css-templates) describes what a template may contain.

### Response fields

| Field | Meaning |
| --- | --- |
| `id` | Identifier of this card: 64 hexadecimal characters. The same template, data, size and format on the same account always give the same `id`. |
| `url` | The image. Public, no key needed. It works until `expires_at`; after that it answers 404 and the same request renders a new image. |
| `width`, `height` | Pixel size. |
| `format` | `png`, `jpeg` or `webp`. |
| `bytes` | File size. |
| `cached` | `false` when this request rendered the image and counted it; `true` when it was already stored and nothing was counted. |
| `template` | The template id, or `inline` for an `html` request. |
| `created_at`, `expires_at` | When the image was rendered, and when it leaves the cache: [[plan.free.cacheDays]] days later on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]], [[plan.pro.cacheDays]] on [[plan.pro.name]]. |
| `warnings` | Things in the template that were removed or ignored; see [Warnings](/docs/html-css-templates#warnings). Empty when `cached` is `true`. |
| `usage` | Your allowance after this request; the same object as [`GET /v1/usage`](#get-v1-usage). |

### Binary response

With `"response": "binary"` the body is the image itself:

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template": "quote", "data": {"title": "Make it work, make it right, make it fast.", "author": "Kent Beck"}, "size": "square", "format": "webp", "response": "binary"}' \
  -o card.webp -D -
```

The response headers include:

```text
HTTP/1.1 200 OK
Content-Length: 32710
Content-Type: image/webp
Cache-Control: public, max-age=86400
ETag: "bc0902a239a085a63901afecb96d0a4d41cf84589348fc503c77e77733fd3ba9"
X-LTC-Cache: miss
X-LTC-Image-Url: [[site.url]]/i/u_hkr8wty4jftnyum3/bc0902a239a085a63901afecb96d0a4d41cf84589348fc503c77e77733fd3ba9.webp
X-LTC-Warnings: %5B%5D
```

| Header | Meaning |
| --- | --- |
| `X-LTC-Cache` | `miss`: rendered and counted by this request. `hit`: served from storage, not counted. |
| `X-LTC-Image-Url` | The same value as `url` in the JSON response. |
| `X-LTC-Warnings` | The warnings as a URI-encoded JSON array. `%5B%5D` is `[]`. |
| `ETag` | The card `id` in quotes. |

## GET /v1/usage

```bash
curl [[site.url]]/v1/usage -H "Authorization: Bearer $LTC_API_KEY"
```

```json
{
  "plan": "free",
  "period_start": "2026-11-01T00:00:00.000Z",
  "period_end": "2026-12-01T00:00:00.000Z",
  "limit": 100,
  "used": 2,
  "remaining": 98,
  "topup_remaining": 0,
  "total_remaining": 98,
  "cache_days": 7,
  "watermark": true
}
```

| Field | Meaning |
| --- | --- |
| `plan` | `free`, `starter` or `pro`. |
| `period_start`, `period_end` | The current period. On [[plan.free.name]] it is the calendar month in UTC; on a paid plan it is your billing period. `used` starts again at 0 at `period_end`. |
| `limit` | Images included per period. |
| `used` | Images counted in this period. |
| `remaining` | `limit` minus `used`, never below 0. |
| `topup_remaining` | Images left from top-ups you bought. |
| `total_remaining` | `remaining` plus `topup_remaining`. New renders stop when this reaches 0. |
| `cache_days` | How long a rendered image is kept on your plan. |
| `watermark` | `true` when your renders carry the corner mark. |

## GET /v1/templates

```bash
curl [[site.url]]/v1/templates -H "Authorization: Bearer $LTC_API_KEY"
```

The response, shortened here to the first of the five starter templates:

```json
{
  "starter": [
    {
      "id": "blog",
      "name": "Blog post",
      "description": "Title card for articles: a serif headline on warm paper, with a sun rising over the author line.",
      "fields": [
        { "name": "title", "description": "Headline of the article.", "example": "Design for the first glance", "required": true },
        { "name": "description", "description": "One or two lines under the headline.", "example": "What people notice before they read a single word.", "required": false },
        { "name": "author", "description": "Author name, shown in the bottom line.", "example": "Maya Lindqvist", "required": false },
        { "name": "image", "description": "Absolute URL of the author photo (square works best); drawn as a small circle.", "example": "https://example.com/maya.jpg", "required": false },
        { "name": "site", "description": "Domain or publication name, shown small in the bottom line.", "example": "fieldnotes.example", "required": false },
        { "name": "tag", "description": "Category shown above the headline in small capitals.", "example": "Design notes", "required": false },
        { "name": "theme", "description": "light (default) or dark.", "example": "light", "required": false }
      ]
    }
  ],
  "custom": [
    { "id": "t_mnd7x9sk3v8bwbmc", "name": "Release note", "version": 1, "updated_at": "2026-11-22T09:36:37.273Z" }
  ]
}
```

`starter` describes each starter template and its fields. `required` marks the field a design is built around; the API does not reject a request that leaves it out. `custom` lists your own templates, newest change first. `version` goes up each time you change a template's HTML or CSS.

## GET /v1/inspect

```bash
curl -G [[site.url]]/v1/inspect \
  -H "Authorization: Bearer $LTC_API_KEY" \
  --data-urlencode "url=https://example.com/blog/launch-week"
```

Checks one page the way the free [Open Graph checker](/tools/og-checker) does, and returns the same result as JSON: the page's `og:*` and `twitter:*` tags, measurements of its image, and a checklist with a fix for each problem. Use it in a script or in CI to catch a missing or broken card before you publish. It never renders an image and never counts against your monthly allowance.

### Request

| Parameter | Meaning |
| --- | --- |
| `url` | Required. The page to check: an absolute `https://` URL on the default port, without a username or password, at most 2048 characters. A `#fragment` is dropped. |

For each uncached check the service:

- fetches that one page as `LinkToCardBot/1.0 (+https://linktocard.com/bot)`, following at most 3 redirects. Every address on the way, including each redirect, is checked, and one that is not on the public internet is refused with 403 `forbidden`;
- allows 5 seconds for the page in total, and reads at most its first 2 MB. Only `text/html` and `application/xhtml+xml` responses are read;
- requests the `og:image` (or the `twitter:image` when there is no `og:image`) with a HEAD and then a GET, within its own 5 seconds, to measure its status, type, file size and pixel size. It reads PNG, JPEG, GIF and WebP headers;
- reads the site's `robots.txt` once. A rule that blocks the page is reported as a warning; the page is still checked, because a person asked for it.

It does not run JavaScript, follow links or crawl. Tags that your page adds in the browser are not seen. [LinkToCardBot](/bot) describes the fetcher.

### Caching and limits

A result is kept for 10 minutes. The same `url` checked again within that time returns the stored result with `"cached": true`: nothing is fetched and nothing is counted. The website's checker and this endpoint share these stored results.

Uncached checks count against a daily allowance per API key. The day is the UTC calendar day.

| Plan | Uncached checks per API key per day |
| --- | --- |
| [[plan.free.name]] | 100 |
| [[plan.starter.name]] | 1,000 |
| [[plan.pro.name]] | 5,000 |

Over the allowance the answer is 429 `rate_limited`, with `Retry-After` set to the seconds until 00:00 UTC:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "This API key has used its 100 inspections for today (UTC). Cached results do not count.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": { "limit": 100, "period_seconds": 86400 }
  }
}
```

The per-IP limit in [Rate limits](#rate-limits) applies too. The checker on the website has its own, separate limit of 20 uncached checks per hour per network and needs no key.

### Response

```json
{
  "id": "chk_k3v9x2m8q1w7p4zt",
  "url": "https://example.com/blog/launch-week",
  "final_url": "https://example.com/blog/launch-week",
  "status": 200,
  "fetched_at": "2026-11-25T10:14:03.512Z",
  "response_ms": 412,
  "cached": false,
  "expires_at": "2026-11-25T10:24:03.512Z",
  "page": {
    "title": "Launch week: what we shipped - Example Blog",
    "description": "Five days, five releases: a new editor, faster search and a public API.",
    "canonical": "https://example.com/blog/launch-week",
    "favicon": "https://example.com/favicon.ico",
    "theme_color": "#1d4ed8"
  },
  "og": {
    "title": "Launch week: what we shipped",
    "description": "Five days, five releases: a new editor, faster search and a public API.",
    "image": "https://example.com/images/launch-week.png",
    "image_alt": "Launch week, in white letters on a blue background",
    "image_width": "1200",
    "image_height": "630",
    "url": "https://example.com/blog/launch-week",
    "type": "article",
    "site_name": "Example Blog"
  },
  "twitter": { "card": null, "title": null, "description": null, "image": null, "site": null },
  "image": {
    "url": "https://example.com/images/launch-week.png",
    "status": 200,
    "content_type": "image/png",
    "bytes": 84213,
    "width": 1200,
    "height": 630,
    "aspect_ratio": 1.905,
    "response_ms": 188
  },
  "robots": { "checked": true, "allowed": true, "note": null },
  "checks": [
    { "id": "og_image", "status": "pass", "title": "og:image is set", "detail": "og:image is \"https://example.com/images/launch-week.png\".", "fix": null },
    { "id": "og_image_absolute", "status": "pass", "title": "Image URL is absolute", "detail": "The image URL is a full address.", "fix": null },
    { "id": "og_image_https", "status": "pass", "title": "Image URL uses https", "detail": "The image is served over https.", "fix": null },
    { "id": "og_image_reachable", "status": "pass", "title": "Image loads", "detail": "HTTP 200, image/png.", "fix": null },
    { "id": "og_image_size", "status": "pass", "title": "Image file size is fine", "detail": "The image is 0.1 MB.", "fix": null },
    { "id": "og_image_dimensions", "status": "pass", "title": "Image dimensions are fine", "detail": "The image is 1200x630 px.", "fix": null },
    { "id": "og_image_ratio", "status": "pass", "title": "Aspect ratio is 1.91:1", "detail": "1200x630 is 1.90:1.", "fix": null },
    { "id": "twitter_card", "status": "warn", "title": "twitter:card is missing", "detail": "The page has no twitter:card tag, which tells X which card layout to use.", "fix": "Add <meta name=\"twitter:card\" content=\"summary_large_image\"> for a large image card." },
    { "id": "og_title", "status": "pass", "title": "og:title is set", "detail": "og:title is 28 characters.", "fix": null },
    { "id": "og_description", "status": "pass", "title": "og:description is set", "detail": "og:description is 71 characters.", "fix": null },
    { "id": "robots", "status": "pass", "title": "robots.txt allows this page", "detail": "robots.txt does not block this page.", "fix": null },
    { "id": "response_time", "status": "pass", "title": "Page responds quickly", "detail": "The page took 0.4 s.", "fix": null }
  ],
  "preview": {
    "title": "Launch week: what we shipped",
    "description": "Five days, five releases: a new editor, faster search and a public API.",
    "domain": "example.com",
    "site_name": "Example Blog",
    "image": "/api/tools/og-check/chk_k3v9x2m8q1w7p4zt/image",
    "favicon": "/api/tools/og-check/chk_k3v9x2m8q1w7p4zt/favicon"
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | The result's id, `chk_` and 16 characters. |
| `url`, `final_url` | The address you sent, normalised, and the address after redirects. Relative URLs in the page are resolved against `final_url`. |
| `status`, `response_ms` | The page's HTTP status and how long it took to answer. |
| `fetched_at`, `expires_at`, `cached` | When the page was fetched, when the stored result expires, and whether this answer came from the store. |
| `page` | The `<title>`, meta description, canonical link, favicon (`/favicon.ico` when the page names none) and `theme-color`. |
| `og`, `twitter` | The tags exactly as the page states them, or `null` when a tag is missing. A relative `og:image` stays relative here; the `og_image_absolute` check reports it. |
| `image` | The measured `og:image` (or `twitter:image`), or `null` when the page has neither. Any measurement that could not be made is `null`. |
| `robots` | Whether `robots.txt` could be read (`checked`), whether it allows the page (`allowed`), and a `note` when it blocks the page or could not be read. |
| `checks` | The twelve checks below, always all of them and in this order. `status` is `pass`, `warn` or `fail`; `fix` says what to change and is `null` when the check passes. |
| `preview` | The text and image a link preview would most likely use: `og:` values first, then `twitter:`, then the page's own title and description. `image` and `favicon` are paths on [[site.host]] that show those images while the result is stored; they answer 404 after `expires_at`. |

The checks, by `id`:

| `id` | What it tests |
| --- | --- |
| `og_image` | The page has an `og:image`. |
| `og_image_absolute` | The image URL is a full address, not relative to the page. |
| `og_image_https` | The image URL uses `https://`. |
| `og_image_reachable` | The image loads without a login and is served as an image. |
| `og_image_size` | The file is not over 5 MB. |
| `og_image_dimensions` | Both sides are at least 200 pixels. |
| `og_image_ratio` | The shape is 1.91:1, within 3 %, like 1200 x 630. Other shapes are a warning. |
| `twitter_card` | The page has a `twitter:card` with a documented value. |
| `og_title` | The page has an `og:title` of at most 70 characters. |
| `og_description` | The page has an `og:description` of at most 200 characters. |
| `robots` | `robots.txt` does not block the page. Only ever a warning. |
| `response_time` | The page answered within 3 seconds. |

The thresholds are this checker's rules of thumb, not limits published by any one app.

### Errors from this endpoint

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | `url` is missing, too long, not an absolute URL, not `https://`, or not on the default port. `details.reason` is `invalid_url`, `insecure_url` or `bad_port` where one applies. |
| 401 | `invalid_api_key` | The key is missing, wrong or revoked. |
| 403 | `forbidden` | The address, or an address it redirects to, is not on the public internet: a private, local or reserved network. |
| 422 | `page_fetch_failed` | The page could not be read. `details.reason` is one of `dns_failed`, `connect_failed`, `timeout`, `too_many_redirects`, `insecure_redirect`, `bad_redirect`, `http_error` (with the site's status in `details.status`) or `not_html`. |
| 429 | `rate_limited` | The key's daily allowance is used up, or the per-IP rate limit was reached. |

A `url` that is refused with 400 is never counted. A check that fails once the page has been requested counts as one uncached check, and is not stored, so the next request tries the page again.

## GET /v1/og

```text
GET /v1/og/{site id}/{template}.{png|jpg|jpeg|webp}?{name}={value}&...&sig={signature}
```

The signed card URL. It takes no API key: the signature is the authentication. [Signed URLs](/docs/signed-urls) describes how to build one, what is cached and every error.

A successful response is the image, with these headers:

| Header | Meaning |
| --- | --- |
| `Content-Type` | `image/png`, `image/jpeg` or `image/webp`. |
| `Cache-Control` | `public, max-age=86400`, or fewer seconds when the stored image expires sooner. |
| `ETag` | The card `id` in quotes. `If-None-Match` with the same value answers 304. |
| `X-LTC-Cache` | `miss`: rendered and counted by this request. `hit`: not counted. |
| `Cross-Origin-Resource-Policy` | `cross-origin`, so any site may embed the image. |

## GET /i

```text
GET /i/{account id}/{id}.{png|jpg|webp}
```

The stored image behind the `url` that `POST /v1/images` returns. It is public and takes no key. The headers are the same as for a signed URL; `X-LTC-Cache` is always `hit`.

It answers 404 `not_found` when the image does not exist or its cache period has ended, and 403 `account_suspended` when the account that owns it is suspended. This endpoint never renders. To get a fresh image after expiry, send the `POST /v1/images` request again.

## HEAD requests

`HEAD` works on signed URLs and on `/i/` URLs. It never renders an image and never counts. For a card that is stored it returns the image headers with `Content-Length`. For a signed URL that is not stored yet it returns 200 with the `Content-Type`, `Cache-Control: no-store` and `X-LTC-Cache: miss`, or the error a `GET` would give.

## Errors

Every error has the same shape, with an HTTP status that matches the code:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Unknown field \"tempalte\". Allowed fields: template, html, css, data, size, width, height, format, response.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": { "unknown_fields": ["tempalte"] }
  }
}
```

- `code` is stable. Branch on it.
- `message` is written for a developer and says what to change. Its wording can change.
- `details` is present only for some errors.
<!-- feature:no-pdf -->
- Errors are never cached and a failed render is never counted.
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
- For card images, errors are never cached and a failed render is never counted.
- PDFs are different, because a render that fails in the browser has still used it: a failure caused by the document is remembered for [[pdf.failedRenderMemoryMinutes]] minutes (the identical request gets the same answer without being rendered again) and counts toward the daily cap on failed renders. See [PDF errors](/docs/pdf#errors) and [what counts](/docs/pdf#what-counts).
<!-- /feature:pdf -->

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The body or a parameter is malformed: not JSON, an unknown field, a bad data key, a value that is not a string or is too long. The message names the problem. |
| 400 | `unsupported_size` | The size is not `og`, `square`, `portrait` or `email` (or `width` and `height` do not equal one of them). |
| 400 | `unsupported_format` | The format is not `png`, `jpeg` or `webp`. |
| 401 | `unauthorized` | Not signed in. Returned by the dashboard's own endpoints, not by the endpoints on this page. |
| 401 | `invalid_api_key` | The `Authorization` header is missing, or the key is wrong or revoked. |
| 402 | `quota_exceeded` | The allowance for this period is used up and the card is not in the cache. `details.usage` is the usage object. See [Limits](/docs/limits#at-the-limit). |
| 403 | `invalid_signature` | A signed URL did not verify. `details.reason` says why; see [every 403 and its fix](/docs/signed-urls#every-403-and-its-fix). |
| 403 | `account_suspended` | The account is suspended. Contact [[site.supportEmail]]. |
<!-- feature:no-batch -->
| 403 | `plan_required` | The feature needs a paid plan. Returned by the dashboard for custom fonts on [[plan.free.name]]. |
<!-- /feature:no-batch -->
<!-- feature:batch -->
| 403 | `plan_required` | The feature needs a paid plan, or a higher one: the dashboard answers it for custom fonts on [[plan.free.name]], and `POST /v1/batches` for more rows than your plan takes in one batch. |
<!-- /feature:batch -->
<!-- feature:no-linkcards -->
| 403 | `forbidden` | A dashboard request was refused (for example one sent from another site), or `GET /v1/inspect` was given an address that is not on the public internet. |
<!-- /feature:no-linkcards -->
<!-- feature:linkcards -->
| 403 | `forbidden` | A dashboard request was refused (for example one sent from another site), or `GET /v1/inspect` or a card from a link was given an address that is not on the public internet. |
<!-- /feature:linkcards -->
| 403 | `verification_required` | A free tool on the website asks for a quick human check before more requests this hour. `details.site_key` names the widget. Not returned by the endpoints on this page. |
| 404 | `not_found` | Unknown path, site, template or image, or an image whose cache period has ended. |
<!-- feature:no-batch -->
| 409 | `conflict` | A per-account maximum is reached or the item already exists. Returned by the dashboard, for example for more than [[limit.maxSites]] sites or [[limit.maxApiKeys]] API keys. |
<!-- /feature:no-batch -->
<!-- feature:batch -->
| 409 | `conflict` | A per-account maximum is reached or the item already exists: in the dashboard, for example, more than [[limit.maxSites]] sites or [[limit.maxApiKeys]] API keys, and for `POST /v1/batches` [[batch.maxActive]] batches already waiting or running. |
<!-- /feature:batch -->
| 410 | `gone` | Reserved. No endpoint returns it today. |
| 413 | `payload_too_large` | The request body is over [[limit.maxRequestBodyKb]] KB, or the template HTML or CSS is over its limit. |
<!-- feature:no-toolkit -->
| 415 | `unsupported_media_type` | A font upload in the dashboard had the wrong `Content-Type`. |
<!-- /feature:no-toolkit -->
<!-- feature:toolkit -->
| 415 | `unsupported_media_type` | A font upload in the dashboard had the wrong `Content-Type`, or a file sent to the PDF toolkit is not a PDF, or not a PNG or JPEG image. |
<!-- /feature:toolkit -->
| 422 | `template_error` | The template cannot be rendered as written: too many elements, a relative image URL, a shadow over the limit, and so on. The message says what to change. |
| 422 | `image_fetch_failed` | An image the template refers to could not be loaded. `details.reason` and `details.url` say which and why. |
| 422 | `page_fetch_failed` | `GET /v1/inspect` could not read the page: DNS, connection, timeout, redirects, an HTTP error or a response that is not HTML. `details.reason` says which. |
| 429 | `rate_limited` | Too many requests. Wait for the number of seconds in the `Retry-After` header. |
| 500 | `render_failed` | The renderer failed on this card. Nothing was counted. If a template fails every time, send it to [[site.supportEmail]]. |
| 500 | `internal_error` | Something failed on our side. Retry; if it continues, write to [[site.supportEmail]] with the `X-Request-Id`. |
<!-- feature:no-pdf -->
| 503 | `not_configured` | A part of the service is not set up on this deployment. You should not see this on `[[site.host]]`. |
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
| 503 | `not_configured` | A part of the service is not set up on this deployment, for example PDF rendering while it is switched off there ("PDF rendering is not enabled yet."). |
<!-- /feature:pdf -->
<!-- feature:no-pdf -->
| 504 | `render_timeout` | The render took longer than [[limit.renderTimeoutSeconds]] seconds, usually because a remote image was slow. Nothing was counted. |
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
| 504 | `render_timeout` | A card image took longer than [[limit.renderTimeoutSeconds]] seconds, usually because a remote image was slow; nothing was counted. A PDF took longer than [[pdf.renderTimeoutSeconds]] seconds to load or to print; nothing was charged, but it counts toward the daily cap on failed renders and is remembered for [[pdf.failedRenderMemoryMinutes]] minutes (see [PDF errors](/docs/pdf#errors)). |
<!-- /feature:pdf -->

## Rate limits

[[> rate-limits-table]]

A request over a limit answers 429 with `Retry-After: 60`:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests. Limit: 120 per 60 seconds. Retry shortly.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": { "limit": 120, "period_seconds": 60 }
  }
}
```

Rate limits protect the service. They are separate from your monthly allowance, which is described next.

## Counting rules

[[> counting-rules]]

The same rules apply to signed URLs and to `POST /v1/images`. `GET /v1/inspect` never counts as an image. [Limits](/docs/limits) has the numbers for each plan.

## OpenAPI

An OpenAPI 3.1 description of these six endpoints is published at [/openapi.yaml](/openapi.yaml).
