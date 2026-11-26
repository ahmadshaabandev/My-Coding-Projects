---
title: Cards from links
description: "Make a card from a page's own title, description, icon and theme colour: POST /v1/cards/from-url with an API key, or a signed /v1/link/... URL to use as og:image, with a worked signing example and signer code for Node.js."
layout: doc
order: 3.5
nav: Cards from links
feature: linkcards
---

Give [[site.name]] the address of a page, and it makes the card from what the page says about itself: its title, description, site name, icon and theme colour, put into a card template. You do not write the card's text anywhere: when the page changes, the card follows.

There are two ways:

- [`POST /v1/cards/from-url`](#post-v1-cards-from-url) with an API key, from your server or an automation. It answers like [`POST /v1/images`](/docs/api#post-v1-images).
- A [signed link URL](#signed-link-urls), `/v1/link/...`, that you put in `<meta property="og:image">` like a [signed card URL](/docs/signed-urls). The card is made the first time someone asks for it.

## How the page is read

The page is read by the same checker as the free [Open Graph checker](/tools/og-checker) and [`GET /v1/inspect`](/docs/api#get-v1-inspect), with the same rules:

- the address must be a public `https://` URL of at most [[inspect.maxUrlChars]] characters; addresses on private or local networks are refused, also when a redirect leads there;
- one page is fetched, with at most [[inspect.maxRedirects]] redirects, [[inspect.pageTimeoutSeconds]] seconds and the first [[inspect.pageMaxMb]] MB of HTML. JavaScript is not run, links are not followed, and nothing is crawled;
- a result is kept for [[inspect.cacheMinutes]] minutes, so the same page asked for again within that time is not fetched again.

[LinkToCardBot](/bot) describes the fetcher.

## What goes on the card

The page's values are put under these data keys. A template gets only the keys it uses: the `blog` starter template, for example, shows `title`, `description`, `author`, `image`, `site` and `theme`, and ignores the rest.

| Key | Where the value comes from |
| --- | --- |
| `title` | `og:title`, else `twitter:title`, else the page `<title>`; else the site name or the domain |
| `description` | `og:description`, else `twitter:description`, else the meta description |
| `site` | the domain of the final URL, without "www." |
| `author` | `og:site_name`, unless it only repeats the domain |
| `image` | the page icon, when it is a PNG, JPEG, GIF or WebP file |
| `logo` | the same icon as image |
| `page_image` | the page's `og:image` (else `twitter:image`), when the checker could load it as a PNG, JPEG, GIF or WebP image |
| `site_name` | `og:site_name` |
| `domain` | the domain of the final URL, without "www." |
| `url` | the final URL of the page, after redirects |
| `theme_color` | `theme-color` as `#rrggbb` (or `#rrggbbaa`); left out unless it is a hex, rgb() or basic named colour |
| `theme` | dark when white text reads better than black on the theme colour, else light; left out without a theme colour |

- A value the page does not have is left out, so the template's rules for a missing value apply (see [HTML and CSS templates](/docs/html-css-templates)).
- Text is cleaned: line breaks become spaces, invisible characters are removed, and text too long for a card is shortened, at the end of a word where one is close, with "…".
- Your own `data` wins over the page, key by key, even when your value is empty. Use it for what the page does not say, such as a fixed `tag`.
- Images are loaded through the same image proxy as every card image. When an image that came from the page cannot be loaded (a broken icon, an address on a private network, a type the renderer cannot draw), the card is made again without the page's images, and only the card that is delivered counts.

## POST /v1/cards/from-url

Needs an API key.

```bash
curl [[site.url]]/v1/cards/from-url \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/blog/launch-week",
    "template": "blog",
    "data": { "tag": "Launch week" }
  }'
```

The answer is the one of `POST /v1/images`, plus `link`, which says which page was read and which data the card was made from (the values are examples):

```json
{
  "id": "4f8b2d6a0c3e7f1b5d9a2c6e0f4b8d1a5c9e3f7b0d4a8c2e6f1b5d9a3c7e0f4b",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/4f8b2d6a0c3e7f1b5d9a2c6e0f4b8d1a5c9e3f7b0d4a8c2e6f1b5d9a3c7e0f4b.png",
  "width": [[size.og.width]],
  "height": [[size.og.height]],
  "format": "png",
  "bytes": 41207,
  "cached": false,
  "template": "blog",
  "created_at": "2026-11-26T10:31:08.442Z",
  "expires_at": "2026-12-03T10:31:08.442Z",
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
  },
  "link": {
    "url": "https://example.com/blog/launch-week",
    "final_url": "https://example.com/blog/launch-week",
    "check_id": "chk_k3v9x2m8q1w7p4zt",
    "check_cached": false,
    "data": {
      "title": "Launch week: what we shipped",
      "description": "Five days, five releases: a new editor, faster search and a public API.",
      "site": "example.com",
      "author": "Example Blog",
      "theme": "dark",
      "tag": "Launch week"
    }
  }
}
```

### Request

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | Required. The page: a public `https://` URL. |
| `template` | string | A starter template (`blog`, `dark`, `quote`, `launch`, `docs`) or the id of one of your own (`t_...`). Default: `[[linkCards.defaultTemplate]]`. |
| `data` | object | Values that win over the page's, with the rules of `data` in [`POST /v1/images`](/docs/api#request). |
| `size`, `width`, `height` | | As in `POST /v1/images`. |
| `format` | string | `png` (default), `jpeg` or `webp`. |
| `response` | string | `json` (default) or `binary`. A binary answer has the headers of `POST /v1/images`. |

`html` and `css` are not accepted: a link card uses a starter template or one of your own. Any other field is refused with 400 `invalid_request`.

### What counts

- A new card counts one image, like any card. The same card again (same template, data, size and format, so the page has not changed) is served from storage with `"cached": true` and counts nothing.
- Reading the page counts against the API key's daily page checks, the same allowance as `GET /v1/inspect`: [[inspect.dailyFree]] on [[plan.free.name]], [[inspect.dailyStarter]] on [[plan.starter.name]], [[inspect.dailyPro]] on [[plan.pro.name]], per UTC day. A page read within the last [[inspect.cacheMinutes]] minutes is not read again and not counted; `link.check_cached` says which happened.
- Page checks are never counted as images.

## Signed link URLs

```text
[[site.url]]/v1/link/{site id}/{template}.{png|jpg|jpeg|webp}?url={page}&{name}={value}&...&sig={signature}
```

A signed link URL is a card URL whose text comes from a page. Put it in the page's own `<meta property="og:image">`, and the card shows the page's own title and description without your writing them into the URL:

```html
<meta property="og:image" content="[[site.url]]/v1/link/s_4k2j9x0q1m7c8d5e/blog.png?url=https%3A%2F%2Fexample.com%2Fblog%2Flaunch-week&amp;sig=...">
```

- `{site id}` and the site secret come from **Sites & URLs** in the dashboard, as for card URLs.
- `url` is the page, any public `https://` address. It is signed like every other parameter, so nobody can point your link at another page.
- `size` chooses the size, as for card URLs.
- Every other parameter is template data that wins over the page, for example `tag` or `theme`.
- `open` (the open fields of email images) is not accepted on link URLs: sign every parameter.

### The signed message

Exactly as for [card URLs](/docs/signed-urls#the-signed-message), with the `/v1/link/...` path on the first line: HMAC-SHA256 with your site secret over the path, the sorted parameter names joined with `,`, and one `name=value` line per parameter with the plain (not URL-encoded) value, joined with `\n`. The page address is signed as you send it: sign `url=https://example.com/blog/launch-week`, then URL-encode it in the query string.

The [parameter rules](/docs/signed-urls#rules) of card URLs apply: the page address is a value like any other, so it may be at most [[limit.maxDataValueChars]] characters, and the whole URL at most [[limit.maxSignedUrlChars]].

### A worked example

The secret is the example secret of the [Signed URLs](/docs/signed-urls#a-worked-example) page, not a real one.

```text
secret    ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab
site id   s_4k2j9x0q1m7c8d5e
template  blog, as .png

url       https://example.com/blog/launch-week
tag       Launch week
theme     dark
```

The message to sign:

```text
/v1/link/s_4k2j9x0q1m7c8d5e/blog.png
tag,theme,url
tag=Launch week
theme=dark
url=https://example.com/blog/launch-week
```

Its signature:

```text
3df016cf82e1ca879f94ffb2afbddaaed1f3687da3a378269f94ad516b1e1eb5
```

The finished URL:

```text
https://linktocard.com/v1/link/s_4k2j9x0q1m7c8d5e/blog.png?tag=Launch+week&theme=dark&url=https%3A%2F%2Fexample.com%2Fblog%2Flaunch-week&sig=3df016cf82e1ca879f94ffb2afbddaaed1f3687da3a378269f94ad516b1e1eb5
```

### Signer code

Node.js 18 or later, no dependencies. It prints the URL above for the example.

```js
import { createHmac } from 'node:crypto';

function signedLinkUrl({ secret, baseUrl, siteId, template, ext = 'png', page, params = {} }) {
  // The page is the "url" parameter, signed like every other one. The signed
  // message is line-based, so control characters are not allowed in values.
  const clean = {};
  for (const [name, value] of Object.entries({ ...params, url: page })) {
    clean[name] = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  }

  // Signed message, joined with "\n": the path, the sorted parameter names
  // joined with ",", then one "name=value" line per parameter in that order.
  // Values are the plain text, NOT URL-encoded.
  const path = `/v1/link/${siteId}/${template}.${ext}`;
  const names = Object.keys(clean).sort();
  const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];
  const sig = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');

  return `${baseUrl}${path}?${new URLSearchParams({ ...clean, sig })}`;
}
```

```js
const url = signedLinkUrl({
  secret: process.env.LTC_SITE_SECRET,
  baseUrl: '[[site.url]]',
  siteId: 's_4k2j9x0q1m7c8d5e',
  template: 'blog',
  page: 'https://example.com/blog/launch-week',
  params: { tag: 'Launch week', theme: 'dark' },
});
```

The PHP and Python signers of [Signed URLs](/docs/signed-urls#signer-code) work too: build the path as `/v1/link/{site id}/{template}.{ext}` and add the page as the `url` parameter. Sign on your server; never put the site secret in browser code.

### When the page is read again

The first request for a link reads the page and makes the card. After that, the link is answered from storage, without reading the page, until the card is [[linkCards.refreshHours]] hours old; the next request then reads the page again. When the page has changed, that request makes a new card, which counts one image; when it has not, the stored card is used again and nothing is counted.

- If the page cannot be read when it is due, the last card keeps being served, with `X-LTC-Cache: stale`, and the page is tried again after [[inspect.cacheMinutes]] minutes.
- `Cache-Control` tells browsers and apps to keep the image until the next refresh at the latest. Apps that show link previews may keep their own copy longer; that is up to each app.
- `HEAD` never reads the page, never renders and never counts.

The other headers are those of a [card URL](/docs/api#get-v1-og): `ETag`, `If-None-Match` for 304, and `X-LTC-Cache` (`miss`, `hit` or `stale`).

### Limits of link URLs

A link URL can name any public page, so each site's links have limits that protect your allowance:

- the page reads behind one site's links count against a daily allowance per site, the same numbers as the daily page checks of an API key: [[inspect.dailyFree]] on [[plan.free.name]], [[inspect.dailyStarter]] on [[plan.starter.name]], [[inspect.dailyPro]] on [[plan.pro.name]], per UTC day. Over it, links whose card is stored keep being served; new pages answer 429 `rate_limited` until 00:00 UTC;
- new cards of a site share one rate limit with the site's card URLs, and every client has the limit per IP address of all `/v1` requests ([rate limits](/docs/limits#rate-limits));
- each new card counts one image, exactly like a card URL.

### Errors

A link that does not verify answers 403 `invalid_signature` before the page is read, with the `details.reason` values of card URLs ([every 403 and its fix](/docs/signed-urls#every-403-and-its-fix)) and two of its own:

| `details.reason` | What happened | Fix |
| --- | --- | --- |
| `missing_url` | The URL has no `url` parameter, or it is empty. | Add the page as `url` and sign it. |
| `open_not_supported` | The URL has an `open` parameter. | Remove it and sign every parameter. |

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | The page address is not an absolute `https://` URL on the default port. |
| 400 | `unsupported_size` | `size` is not one of the sizes. |
| 402 | `quota_exceeded` | The allowance is used up and the card is not stored. |
| 403 | `forbidden` | The page, or an address it redirects to, is not on the public internet. |
| 403 | `account_suspended` | The account that owns the site is suspended. |
| 404 | `not_found` | The site or the template does not exist. |
| 422 | `page_fetch_failed` | The page could not be read, and no earlier card of this link is stored. `details.reason` says why, as for [`GET /v1/inspect`](/docs/api#errors-from-this-endpoint). |
| 429 | `rate_limited` | The site's page reads for today are used up, or a rate limit was reached. |
| 503 | `not_configured` | Cards from links are switched off on this deployment: "Cards from links are not enabled yet." |

`POST /v1/cards/from-url` answers the same codes, except `invalid_signature`, and also 401 `invalid_api_key` for a missing or wrong key. Its 429 means that the API key's page checks for today are used up, or that a rate limit was reached.
