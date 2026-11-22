---
title: Quickstart
description: From zero to a working og:image in about five minutes with a signed URL, then the same card through the REST API with curl.
layout: doc
order: 2
nav: Quickstart
---

You need Node.js 18 or later for the signing step and `curl` for the API step. The [[plan.free.name]] plan is enough: [[plan.free.images]] images per month, no card required.

## Part 1: a signed URL in your page

### 1. Sign in

Open [the sign-in page](/login), enter your email address and follow the link in the email. The link works once and for [[auth.magicLinkMinutes]] minutes. There is no password.

### 2. Create a site

In the [dashboard](/dashboard), open **Sites & URLs** and create a site. A site is one website that will show your cards. You get two values:

- a site id, which looks like `s_pik1omqapoq5h5bt` and is public (it is part of every image URL);
- a site secret, which starts with `ltcs_` and must stay on your server.

### 3. Sign a URL

Save this as `card-url.mjs`. It has no dependencies.

```js
// card-url.mjs
import { createHmac } from 'node:crypto';

export function signedCardUrl({ secret, baseUrl, siteId, template, ext = 'png', params }) {
  // The signed message is line-based, so line breaks and other control
  // characters are not allowed in values. Replace them before signing.
  const clean = {};
  for (const [name, value] of Object.entries(params)) {
    clean[name] = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  }

  // Signed message, joined with "\n": the path, the sorted parameter names
  // joined with ",", then one "name=value" line per parameter in that order.
  // Values are the plain text, NOT URL-encoded.
  const path = `/v1/og/${siteId}/${template}.${ext}`;
  const names = Object.keys(clean).sort();
  const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];
  const sig = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');

  return `${baseUrl}${path}?${new URLSearchParams({ ...clean, sig })}`;
}
```

Save this next to it as `quickstart.mjs`:

```js
// quickstart.mjs
import { signedCardUrl } from './card-url.mjs';

console.log(
  signedCardUrl({
    secret: process.env.LTC_SITE_SECRET,
    baseUrl: '[[site.url]]',
    siteId: process.env.LTC_SITE_ID,
    template: 'blog',
    params: {
      title: 'How we cut our build time in half',
      description: 'Three changes that took our CI from 14 minutes to 6.',
      author: 'Maya Chen',
    },
  }),
);
```

Run it with your own values:

```bash
export LTC_SITE_ID="s_pik1omqapoq5h5bt"
export LTC_SITE_SECRET="ltcs_..."
node quickstart.mjs
```

It prints one URL. With the site id above it looks like this (your signature will differ, because your secret does):

```text
[[site.url]]/v1/og/s_pik1omqapoq5h5bt/blog.png?title=How+we+cut+our+build+time+in+half&description=Three+changes+that+took+our+CI+from+14+minutes+to+6.&author=Maya+Chen&sig=8048d75397759fa075f9f7cd2d290feebcdc6c42d25bbbbac53d8b086419d118
```

`blog` is one of five starter templates. Each takes the same handful of fields (`title`, `description`, `author`, and more); [HTML and CSS templates](/docs/html-css-templates#starter-templates) lists them.

### 4. Paste the meta tags

Put these five tags in the `<head>` of the page, with your URL in both places. Inside an HTML attribute, write each `&` of the URL as `&amp;`.

```html
<meta property="og:image" content="[[site.url]]/v1/og/s_pik1omqapoq5h5bt/blog.png?title=How+we+cut+our+build+time+in+half&amp;description=Three+changes+that+took+our+CI+from+14+minutes+to+6.&amp;author=Maya+Chen&amp;sig=8048d75397759fa075f9f7cd2d290feebcdc6c42d25bbbbac53d8b086419d118">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="[[site.url]]/v1/og/s_pik1omqapoq5h5bt/blog.png?title=How+we+cut+our+build+time+in+half&amp;description=Three+changes+that+took+our+CI+from+14+minutes+to+6.&amp;author=Maya+Chen&amp;sig=8048d75397759fa075f9f7cd2d290feebcdc6c42d25bbbbac53d8b086419d118">
```

In a real site you call `signedCardUrl()` in the code that renders the page, once per page. [Frameworks](/docs/frameworks) shows how for WordPress, Hugo, Astro, Next.js and others. If you would rather not write code yet, the builder under **Sites & URLs** in the dashboard produces the same five tags for values you type in.

### 5. Check the result

Fetch the URL and print the response headers:

```bash
curl -s -o card.png -D - "$(node quickstart.mjs)"
```

The headers include:

```text
HTTP/1.1 200 OK
Content-Length: 42008
Content-Type: image/png
Cache-Control: public, max-age=86400
ETag: "3bd946f14034a14824f9fe382c56f99384ca33a2472f3261e913ebaea5143079"
X-LTC-Cache: miss
```

`card.png` is a [[size.og.width]] x [[size.og.height]] PNG. `X-LTC-Cache: miss` means this request rendered the image and used one image of your monthly allowance. Run the command again: the header says `hit`, and nothing is counted.

If you get a 403 instead, the response body says why. [Signed URLs](/docs/signed-urls#every-403-and-its-fix) lists every reason and its fix.

## Part 2: the same card through the API

Use the API when you want the image URL or the bytes in a script, instead of a URL that renders on demand.

### 1. Create an API key

In the dashboard, open **API keys** and create a key. It starts with `ltc_` and is shown once: copy it now.

```bash
export LTC_API_KEY="ltc_..."
```

### 2. Request an image

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

### 3. Read the JSON

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

- `url` is the image. It needs no key and works until `expires_at`.
- `cached` is `false` because this request rendered the image. Send the same request again and it is `true`, with the same `url`, and `usage.used` does not change.
- `usage` is your allowance after this request. Here `used` is 2: one image from Part 1 and one from this call.
- On the [[plan.free.name]] plan the image carries a small `[[site.host]]` mark in the bottom right corner (`"watermark": true`). Paid plans have none.

To get the bytes instead of JSON, add `"response": "binary"`. To send your own HTML and CSS instead of a starter template, see the [API reference](/docs/api#post-v1-images).

## Next

- [Signed URLs](/docs/signed-urls): the rules for parameters, PHP and Python signers, caching and secret rotation.
- [HTML and CSS templates](/docs/html-css-templates): write your own card.
- [Limits](/docs/limits): what counts as an image and what happens at the limit.
