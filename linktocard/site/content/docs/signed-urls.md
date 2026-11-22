---
title: Signed URLs
description: The exact signature format for card image URLs, signer code for Node.js, PHP and Python, the parameter rules, caching, secret rotation and every reason for a 403.
layout: doc
order: 3
nav: Signed URLs
---

A signed URL is an image URL that you build yourself and put in `<meta property="og:image">`. The signature proves that you built it, so nobody else can make images on your account by editing the text in the URL.

```text
[[site.url]]/v1/og/{site id}/{template}.{png|jpg|jpeg|webp}?{name}={value}&...&sig={signature}
```

- `{site id}` comes from **Sites & URLs** in the dashboard (`s_...`).
- `{template}` is a starter template (`blog`, `dark`, `quote`, `launch`, `docs`) or the id of one of your own templates (`t_...`).
- The file extension chooses the format: `.png`, `.jpg` or `.jpeg` (JPEG), `.webp`.
- The query parameters are the template's data, for example `title` and `author`.
- `sig` is an HMAC-SHA256 of the path and the parameters, made with your site secret (`ltcs_...`).

## The signed message

The message you sign is plain text, built from these lines and joined with a line feed (`\n`, no trailing line feed):

1. The path, exactly as it appears in the URL: `/v1/og/{site id}/{template}.{ext}`.
2. The parameter names, sorted, joined with `,`. Leave `sig` out. With no parameters this line is empty.
3. One line per parameter, in the same sorted order: `name=value`.

Three details matter:

- **Values are the plain text, not URL-encoded.** Sign `title=Ship it! 10 tips & tricks`, then URL-encode the value when you put it in the query string. This is why the order of parameters in the URL and the way they are percent-encoded do not matter.
- **Names are sorted in ascending byte order.** Names contain only `a-z`, `0-9` and `_`, so every language's default string sort gives the same order.
- **The signature is `HMAC-SHA256(site secret, message)` written as 64 lowercase hexadecimal characters.** The key is the whole secret string including `ltcs_`; the message is UTF-8.

## A worked example

This is the published test vector (`examples/signing/vector.json`). The secret is an example, not a real one.

```text
secret    ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab
site id   s_4k2j9x0q1m7c8d5e
template  blog, as .png

title     Ship it! 10 tips & tricks (part 1/2) 🚀
subtitle  a+b=c ~ it's *that* easy
author    Zoë Müller
size      og
v         3
```

The message to sign, seven lines:

```text
/v1/og/s_4k2j9x0q1m7c8d5e/blog.png
author,size,subtitle,title,v
author=Zoë Müller
size=og
subtitle=a+b=c ~ it's *that* easy
title=Ship it! 10 tips & tricks (part 1/2) 🚀
v=3
```

Its signature:

```text
5accda313d58b989dec00671442c31e43bf30a233a132c36562b8978005a573c
```

The finished URL (parameters in any order, each value URL-encoded, `sig` added):

```text
https://linktocard.com/v1/og/s_4k2j9x0q1m7c8d5e/blog.png?title=Ship+it%21+10+tips+%26+tricks+%28part+1%2F2%29+%F0%9F%9A%80&subtitle=a%2Bb%3Dc+%7E+it%27s+*that*+easy&author=Zo%C3%AB+M%C3%BCller&size=og&v=3&sig=5accda313d58b989dec00671442c31e43bf30a233a132c36562b8978005a573c
```

If your own signer produces this signature for these inputs, it is correct.

## Signer code

These are the reference signers. Each one produces the URL above for the test vector. Copy the function into your server-side code.

### Node.js

Node.js 18 or later, no dependencies.

```js
import { createHmac } from 'node:crypto';

function signedCardUrl({ secret, baseUrl, siteId, template, ext = 'png', params }) {
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

```js
const url = signedCardUrl({
  secret: process.env.LTC_SITE_SECRET,
  baseUrl: '[[site.url]]',
  siteId: 's_4k2j9x0q1m7c8d5e',
  template: 'blog',
  params: { title: 'Hello world', author: 'Zoë Müller' },
});
```

### PHP

PHP 7.4 or later, no extensions beyond the default `hash`.

```php
function signed_card_url(string $secret, string $baseUrl, string $siteId, string $template, string $ext, array $params): string
{
    // The signed message is line-based, so line breaks and other control
    // characters are not allowed in values. Replace them before signing.
    $clean = [];
    foreach ($params as $name => $value) {
        $clean[$name] = preg_replace('/[\x00-\x1F\x7F]/', ' ', (string) $value);
    }

    // Signed message, joined with "\n": the path, the sorted parameter names
    // joined with ",", then one "name=value" line per parameter in that order.
    // Values are the plain text, NOT URL-encoded.
    $path = "/v1/og/{$siteId}/{$template}.{$ext}";
    $sorted = $clean;
    ksort($sorted, SORT_STRING);
    $lines = [$path, implode(',', array_keys($sorted))];
    foreach ($sorted as $name => $value) {
        $lines[] = "{$name}={$value}";
    }
    $sig = hash_hmac('sha256', implode("\n", $lines), $secret);

    $query = http_build_query($clean + ['sig' => $sig], '', '&');
    // Optional: PHP writes "*" as %2A, JavaScript leaves it as "*". Both verify
    // (the server signs decoded values); this only makes the URL text identical
    // to the one the JavaScript and Python examples print.
    return $baseUrl . $path . '?' . str_replace('%2A', '*', $query);
}
```

```php
$url = signed_card_url(getenv('LTC_SITE_SECRET'), '[[site.url]]', 's_4k2j9x0q1m7c8d5e', 'blog', 'png', [
    'title' => 'Hello world',
    'author' => 'Zoë Müller',
]);
```

### Python

Python 3.7 or later, standard library only.

```python
import hashlib
import hmac
import re
from urllib.parse import urlencode


def signed_card_url(secret, base_url, site_id, template, ext, params):
    # The signed message is line-based, so line breaks and other control
    # characters are not allowed in values. Replace them before signing.
    clean = {name: re.sub(r"[\x00-\x1f\x7f]", " ", str(value)) for name, value in params.items()}

    # Signed message, joined with "\n": the path, the sorted parameter names
    # joined with ",", then one "name=value" line per parameter in that order.
    # Values are the plain text, NOT URL-encoded.
    path = f"/v1/og/{site_id}/{template}.{ext}"
    names = sorted(clean)
    lines = [path, ",".join(names)] + [f"{name}={clean[name]}" for name in names]
    message = "\n".join(lines).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    # Optional: safe="*" and the "~" replacement only make the URL text identical
    # to the one the JavaScript and PHP examples print. A plain urlencode()
    # verifies just as well, because the server signs decoded values.
    query = urlencode({**clean, "sig": sig}, safe="*").replace("~", "%7E")
    return f"{base_url}{path}?{query}"
```

```python
import os

url = signed_card_url(
    os.environ["LTC_SITE_SECRET"], "[[site.url]]", "s_4k2j9x0q1m7c8d5e", "blog", "png",
    {"title": "Hello world", "author": "Zoë Müller"},
)
```

For any other language: build the message as described above, compute HMAC-SHA256, and check your result against the worked example.

## Rules

| Rule | Detail |
| --- | --- |
| Parameter names | Start with a lowercase letter, then lowercase letters, digits or `_`; at most 32 characters. `title`, `author_name` and `v2` are valid; `Title` and `og-title` are not. |
| One value per name | A name may appear once in the URL. |
| Number of parameters | At most [[limit.maxDataKeys]] template parameters, plus the optional `size`. |
| Value length | At most [[limit.maxDataValueChars]] characters per value, counted in Unicode code points. An empty value is allowed. |
| Control characters | Not allowed in values: no line breaks, no tabs, nothing in U+0000 to U+001F, and not U+007F. |
| URL length | Path and query together are at most [[limit.maxSignedUrlChars]] characters. |
| Reserved names | `sig` carries the signature. `size` chooses the output size. Neither reaches the template as data. |
| Path | Site id and template id contain only letters, digits, `_` and `-`. The path is signed, so the template and the format cannot be changed without re-signing. |

Parameters that the template does not use are accepted. They change nothing in the picture, but they are part of the signature and of the cache key.

### Strip control characters before you sign

The message is one line per parameter. If a value contained a line break, the text after it would look like another parameter line, and a visitor who controls that text (a comment title, a user name) could try to add parameters to your card. The server therefore refuses any URL whose values contain control characters, and a signature made over such a value can never match.

Replace control characters with a space before signing, and send the replaced value. The reference signers do exactly this in their first lines.

### The size parameter

`size` is `og` ([[size.og.width]] x [[size.og.height]], the default), `square` ([[size.square.width]] x [[size.square.height]]) or `portrait` ([[size.portrait.width]] x [[size.portrait.height]]). Sign it like any other parameter. Leave it out for `og`. Any other value answers 400 `unsupported_size`.

### Formats

| Extension | Format | Content-Type |
| --- | --- | --- |
| `.png` | PNG | `image/png` |
| `.jpg`, `.jpeg` | JPEG | `image/jpeg` |
| `.webp` | WebP | `image/webp` |

If you do not know whether every app that shows your links accepts WebP, use PNG or JPEG.

## What is cached and what is counted

The first `GET` of a new URL renders the image, stores it and takes one image from your monthly allowance. The response has `X-LTC-Cache: miss`.

Every later `GET` of the same card is served from storage with `X-LTC-Cache: hit` and is not counted, for as long as your plan keeps images: [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]], [[plan.pro.cacheDays]] on [[plan.pro.name]]. After that, the next request renders the card again and counts again.

- "The same card" means the same account, template, data, size and format. Parameter order and encoding do not matter.
- Successful responses carry `Cache-Control: public, max-age=86400` (one day, or less when the stored image expires sooner) and an `ETag`. A request with a matching `If-None-Match` answers 304.
- A failed render is not stored and not counted. Error responses carry `Cache-Control: no-store`, so the URL starts working as soon as the cause is fixed.
- `HEAD` never renders and never counts. For a card that is not stored yet it answers 200 with the image `Content-Type`, `Cache-Control: no-store` and `X-LTC-Cache: miss`, or the error that a `GET` would give.
- If you edit one of your own templates, every URL that uses it becomes a new card: each is rendered and counted again the next time it is requested. Updates to the starter templates do not do this.

## Force a new image

Change any parameter. The usual way is a version parameter that the template ignores:

```text
...&title=Dark+mode+is+here&v=2&sig=...
```

`v=2` makes a different card, so it is rendered and counted as a new image. Remember to sign the new parameter. Without such a change, an updated picture can take up to a day to appear, because browsers and caches may keep the old response for the `max-age` above.

## Rotate a site secret

Rotate the secret in the dashboard (**Sites & URLs**) if it may have leaked. Then:

- URLs signed with the old secret stop verifying. A request for one that reaches the service answers 403 `invalid_signature`.
- An old URL that was already served can still be answered from a cache (a browser's, or the service's own edge cache) until its `max-age` runs out, at most one day.
- Sign your URLs again with the new secret. A re-signed URL for a card that is still stored is served from storage and is not counted again.

Each site has its own secret, so rotating one site does not affect your other sites.

## Every 403 and its fix

A 403 from a signed URL has `"code": "invalid_signature"` and a `details.reason`:

```json
{
  "error": {
    "code": "invalid_signature",
    "message": "The signature does not match this URL. Check the site secret and that the path and every parameter are signed exactly as they are sent.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": { "reason": "signature_mismatch" }
  }
}
```

| `details.reason` | What happened | Fix |
| --- | --- | --- |
| `missing_sig` | The URL has no `sig` parameter. | Append `&sig=` and the signature. |
| `malformed_sig` | `sig` is not 64 hexadecimal characters. | Use the hex digest of HMAC-SHA256, not base64 and not a shortened value. |
| `bad_param_name` | A parameter name breaks the name rule. | Rename it: lowercase letters, digits and `_`, starting with a letter. |
| `duplicate_param` | A name appears twice. | Send each parameter once. |
| `bad_value` | A value contains a control character or is longer than [[limit.maxDataValueChars]] characters. | Replace control characters and shorten the text before signing. |
| `too_many_params` | More than [[limit.maxDataKeys]] template parameters. | Send fewer parameters. |
| `url_too_long` | Path and query exceed [[limit.maxSignedUrlChars]] characters. | Shorten the values. |
| `signature_mismatch` | The signature is well formed but wrong for this URL. | See the checklist below. |

Checklist for `signature_mismatch`:

1. The secret belongs to the site id in the path, and it is the current one (not from before a rotation).
2. Line 1 of the message is the path only: no scheme, no host, no query string.
3. The message uses the decoded values. `Ship it!` is signed, not `Ship+it%21`.
4. Names are sorted, and line 2 lists exactly the names that are in the URL, `size` included, `sig` excluded.
5. Lines are joined with `\n` only, with no trailing line feed and no `\r`.
6. The URL was not changed after signing. A parameter added later (a tracking parameter, for example) is not in the signed message, so the signature no longer matches. In HTML, `&amp;` is correct: the browser turns it back into `&`. A value that was HTML-escaped twice is not.
7. Your signer reproduces the [worked example](#a-worked-example).

A signed URL can also answer:

| Status | Code | When |
| --- | --- | --- |
| 400 | `unsupported_size` | `size` is not `og`, `square` or `portrait`. |
| 402 | `quota_exceeded` | The allowance is used up and this card is not stored. See [Limits](/docs/limits#at-the-limit). |
| 403 | `account_suspended` | The account that owns the site is suspended. |
| 404 | `not_found` | The path is not a card URL, the site id does not exist, or the template does not exist. |
| 422 | `template_error`, `image_fetch_failed` | The template or one of its images could not be used. The message says what to change. |
| 429 | `rate_limited` | Too many requests. See [rate limits](/docs/api#rate-limits). |

## Keep the secret on the server

Anyone who has a site secret can create images that count against your allowance. Sign on your server or in your build step. Never ship the secret in browser JavaScript, a mobile app or a public repository. The site id is not secret.

If you cannot run code where the page is built, see [Frameworks](/docs/frameworks) for the routes that work on hosted platforms.
