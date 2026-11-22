---
title: API reference
description: Reference for POST /v1/images, GET /v1/usage, GET /v1/templates, signed card URLs and stored images - authentication, fields, real responses, every error code, rate limits and counting rules.
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
| [`GET /v1/og/...`](#get-v1-og) | A signed card URL, for `og:image`. The signature is the authentication. |
| [`GET /i/...`](#get-i) | A stored image, as returned by `POST /v1/images`. Public. |

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
| `size` | string | `og` (default), `square` or `portrait`. |
| `width`, `height` | number | Instead of `size`: both together, and equal to one of the three sizes ([[size.og.width]] and [[size.og.height]], [[size.square.width]] and [[size.square.height]], [[size.portrait.width]] and [[size.portrait.height]]). |
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
- Errors are never cached and a failed render is never counted.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The body or a parameter is malformed: not JSON, an unknown field, a bad data key, a value that is not a string or is too long. The message names the problem. |
| 400 | `unsupported_size` | The size is not `og`, `square` or `portrait` (or `width` and `height` do not equal one of them). |
| 400 | `unsupported_format` | The format is not `png`, `jpeg` or `webp`. |
| 401 | `unauthorized` | Not signed in. Returned by the dashboard's own endpoints, not by the endpoints on this page. |
| 401 | `invalid_api_key` | The `Authorization` header is missing, or the key is wrong or revoked. |
| 402 | `quota_exceeded` | The allowance for this period is used up and the card is not in the cache. `details.usage` is the usage object. See [Limits](/docs/limits#at-the-limit). |
| 403 | `invalid_signature` | A signed URL did not verify. `details.reason` says why; see [every 403 and its fix](/docs/signed-urls#every-403-and-its-fix). |
| 403 | `account_suspended` | The account is suspended. Contact [[site.supportEmail]]. |
| 403 | `plan_required` | The feature needs a paid plan. Returned by the dashboard for custom fonts on [[plan.free.name]]. |
| 403 | `forbidden` | A dashboard request was refused (for example one sent from another site). Not returned by the endpoints on this page. |
| 404 | `not_found` | Unknown path, site, template or image, or an image whose cache period has ended. |
| 409 | `conflict` | A per-account maximum is reached or the item already exists. Returned by the dashboard, for example for more than [[limit.maxSites]] sites or [[limit.maxApiKeys]] API keys. |
| 410 | `gone` | Reserved. No endpoint returns it today. |
| 413 | `payload_too_large` | The request body is over [[limit.maxRequestBodyKb]] KB, or the template HTML or CSS is over its limit. |
| 415 | `unsupported_media_type` | A font upload in the dashboard had the wrong `Content-Type`. |
| 422 | `template_error` | The template cannot be rendered as written: too many elements, a relative image URL, a shadow over the limit, and so on. The message says what to change. |
| 422 | `image_fetch_failed` | An image the template refers to could not be loaded. `details.reason` and `details.url` say which and why. |
| 429 | `rate_limited` | Too many requests. Wait for the number of seconds in the `Retry-After` header. |
| 500 | `render_failed` | The renderer failed on this card. Nothing was counted. If a template fails every time, send it to [[site.supportEmail]]. |
| 500 | `internal_error` | Something failed on our side. Retry; if it continues, write to [[site.supportEmail]] with the `X-Request-Id`. |
| 503 | `not_configured` | A part of the service is not set up on this deployment. You should not see this on `[[site.host]]`. |
| 504 | `render_timeout` | The render took longer than [[limit.renderTimeoutSeconds]] seconds, usually because a remote image was slow. Nothing was counted. |

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

The same rules apply to signed URLs and to `POST /v1/images`. [Limits](/docs/limits) has the numbers for each plan.

## OpenAPI

An OpenAPI 3.1 description of these five endpoints is kept in the service's source repository as `openapi.yaml`. It is not published on this site yet.
