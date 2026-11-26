---
title: Personalized email images
description: "Put each reader's name into an image in your emails: signed card URLs with open fields that your email platform fills in, the value rules and defaults, caching, what counts, the daily limit per site and the two email starter templates."
layout: doc
order: 3.6
nav: Email images
feature: email
---

A personalized email image is a [signed card URL](/docs/signed-urls) with one or more **open fields**: fields whose values are not signed, so that your email platform can put a merge tag there and fill in each reader's own value when it sends. Everything else in the URL stays signed. The result is an ordinary static PNG or JPEG, one per distinct value.

```text
[[site.url]]/v1/og/{site id}/email-banner.png?title=...&open=name&name_default=there&size=email&sig={signature}&name={merge tag}
```

- `open` names the open fields: a comma-separated list of at most [[email.maxOpenFields]] field names, here `name`.
- `name_default` is what the image shows when a reader's value is missing or cannot be used.
- `sig` signs everything except the open fields' values.
- `name=` comes last, after `sig`. Your platform replaces the merge tag with each reader's value.

For a step-by-step walk through a first campaign, with the merge tags of several email platforms, see the guide [Personalized email images](/guides/personalized-email-images).

## Sign a URL with open fields

Sign exactly as described in [Signed URLs](/docs/signed-urls#the-signed-message), with two additions:

1. Put `open` among the parameters you sign, with the open fields' names as its value (`open=name`, or `open=name,code`). Sign each default as an ordinary parameter (`name_default=there`).
2. Leave the open fields out of the signed message, name and value. After `sig`, append each one with an empty value (`&name=`). The merge tag goes after the `=`.

So the signed message of a URL with open fields is the signed message of the same URL without them. Any signer from [Signed URLs](/docs/signed-urls#signer-code) works unchanged: sign without the open fields, then append them.

Why last: a platform that does not URL-encode its values can insert a `#` into the URL, and everything after a `#` never reaches the server. With the open fields at the end, a `#` can only cut short their own values, never the signature.

A URL without `open` verifies exactly as before.

### Rules for open

| Rule | Detail |
| --- | --- |
| Names | Each name follows the [parameter name rule](/docs/signed-urls#rules), appears once in the list and has no spaces around it: `open=name,code`. |
| How many | At most [[email.maxOpenFields]] open fields per URL. |
| Reserved | `sig`, `size` and `open` cannot be open fields, and neither can a name ending in `_default`: that suffix holds a field's default. |
| Signed once only | An open field's value is never signed. Signing `name` and also listing it in `open` cannot verify. |
| Fields of the template | An open field that the template does not have is ignored: its value changes nothing, not even the count. |
| Number of parameters | The template's data, open fields included, may have at most [[limit.maxDataKeys]] parameters. `open` and the defaults are signed parameters like any other. |
| URL length | The [[limit.maxSignedUrlChars]]-character limit applies to the URL without its open fields, so long values cannot push a URL over it. |

## A worked example

The secret is the example secret of [Signed URLs](/docs/signed-urls#a-worked-example), not a real one.

```text
secret        ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab
site id       s_4k2j9x0q1m7c8d5e
template      email-banner, as .png

title         Your spring picks are ready
greeting      Hi
cta           See the edit
name_default  there
size          email
open          name
```

The message to sign has no `name` line:

```text
/v1/og/s_4k2j9x0q1m7c8d5e/email-banner.png
cta,greeting,name_default,open,size,title
cta=See the edit
greeting=Hi
name_default=there
open=name
size=email
title=Your spring picks are ready
```

Its signature:

```text
1a3fcc944787e7c85170817cf7b71438d9e7dd1fa7df3b775c7545e041fadcf9
```

The URL to paste into your email, with the open field last and still empty:

```text
https://linktocard.com/v1/og/s_4k2j9x0q1m7c8d5e/email-banner.png?title=Your+spring+picks+are+ready&greeting=Hi&cta=See+the+edit&name_default=there&size=email&open=name&sig=1a3fcc944787e7c85170817cf7b71438d9e7dd1fa7df3b775c7545e041fadcf9&name=
```

Put your platform's merge tag after `name=`. For a reader called Maya, the platform sends `...&name=Maya` and the image says "Hi Maya,". For a reader with no first name it sends `...&name=` and the image says "Hi there,".

With the Node.js signer of [Signed URLs](/docs/signed-urls#node-js), the same URL is:

```js
const url = signedCardUrl({
  secret: process.env.LTC_SITE_SECRET,
  baseUrl: '[[site.url]]',
  siteId: 's_4k2j9x0q1m7c8d5e',
  template: 'email-banner',
  params: { title: 'Your spring picks are ready', greeting: 'Hi', cta: 'See the edit', name_default: 'there', size: 'email', open: 'name' },
}) + '&name=';
```

## What a value may contain

An open field's value is not signed, so what it can do is kept small. The value is read as URL-decoded text (`+` and `%20` are both a space), then normalized: compatibility characters become their plain forms (Unicode NFKC, so full-width `Ｍａｙａ` is `Maya`), curly apostrophes become `'`, runs of spaces become one and the ends are trimmed. The image uses the value only if it then:

- has at most [[email.maxValueChars]] characters;
- contains only letters, digits, spaces and `. , ' - ! ? & @ #`, with at least one letter or digit;
- uses only letters the built-in fonts draw: Latin (Vietnamese included), Greek and Cyrillic.

Anything else is not an error: the field shows its default instead. That covers a merge tag your platform did not fill in, markup, a web address, emoji, line breaks and letters of other scripts such as Arabic, Hebrew or Chinese. An email that was already sent cannot be fixed, so a default is better than a broken image.

| Sent in the URL | The image shows |
| --- | --- |
| `name=Maya` | `Maya` |
| `name=Zo%C3%AB` | `Zoë` |
| `name=Mary+Jo` | `Mary Jo` |
| `name=Mary%20Jo` | `Mary Jo` |
| `name=Tom%20%26%20Jerry` | `Tom & Jerry` |
| `name=O%E2%80%99Brien` | `O'Brien` |
| `name=%EF%BC%AD%EF%BD%81%EF%BD%99%EF%BD%81` | `Maya` |
| `name=` | the default |
| `name=*\|FNAME\|*` | the default (a merge tag that was not filled in) |
| `name=%3Cb%3EMaya%3C%2Fb%3E` | the default (markup) |
| `name=https%3A%2F%2Fexample.com` | the default (a web address) |
| `name=%F0%9F%8E%89` | the default (an emoji) |
| `name=%E6%9D%8E` | the default (a script the fonts do not draw) |
| `name=Tom & Jerry` | no image: 403 `invalid_signature` |

The last row is the one to watch. An `&` that reaches the URL unencoded starts a new parameter (` Jerry`), which is not signed, so the whole URL fails and the reader sees a broken image. Use your platform's URL-encoding filter when it has one, and send a test to a contact whose name contains `&` before the first campaign. The [guide](/guides/personalized-email-images#merge-tags-by-platform) lists the platforms whose documentation shows one.

The values travel in the image URL, so [[site.name]] receives each reader's value when their image loads, and stores the rendered image like any card. Use open fields for short display text such as a first name or a code, not for email addresses or other personal details.

## Defaults

`<field>_default` is the text an open field shows when the reader's value is missing, empty or not usable. It is signed, so it follows the ordinary [value rules](/docs/signed-urls#rules) of signed URLs rather than the ones above, and it never reaches the template under its own name.

Without a default, the field is empty. Both email starter templates then leave out the name and its comma, so "Hi Maya," becomes "Hi".

All readers whose values fall back see the same image, which is rendered and counted once, then served from storage.

## Caching and what counts

Each distinct set of values is its own card. The first request for "Maya" renders the image, stores it and takes one image from the site owner's monthly allowance, like any new card. Every later request for "Maya", from any reader, is served from storage and is not counted. `name=Maya` and `name=%20Maya%20` are the same card, because values are normalized first.

So a send costs at most one image per distinct value, not one per reader: a list in which many readers share a first name costs fewer images than it has readers. After the plan's storage period ([[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]], [[plan.pro.cacheDays]] on [[plan.pro.name]]), the next request for a value renders and counts it again.

- Personalized images are sent with `Cache-Control: public, max-age=...` of up to [[email.maxAgeDays]] days, and never longer than the image stays stored, so mail apps and their image proxies can keep it. They carry an `ETag`, and a request with a matching `If-None-Match` answers 304.
- A request that fails is not stored and not counted, and it does not count toward the daily limit below.
- `HEAD` never renders and never counts.
- When the monthly allowance is used up, a value that is not stored yet cannot be rendered: the request answers 402 `quota_exceeded` and the reader sees a broken image. Values that were already rendered keep working. See [Limits](/docs/limits#at-the-limit).

An email's images can load even when nobody reads it. Apple says of Mail Privacy Protection that "Mail content may be loaded automatically after delivery", and that senders will see emails "as being opened, regardless of if the user read it or not". So count on every distinct value of a send being rendered, whether or not it is read.

<!-- Source of the two quotes: Apple, WWDC21 session 10085 "Apple's privacy pillars in focus", transcript, https://developer.apple.com/videos/play/wwdc2021/10085/ (read 2026-11-26). -->

On the [[plan.free.name]] plan, personalized images carry the small `[[site.host]]` mark in one corner, like every [[plan.free.name]]-plan image, defaults included. Paid plans have none.

## The daily limit per site

Anyone who has one of your email URLs can change its open values, and every new value is a render that counts. So each site has a daily limit of **unique renders with open fields**, per UTC day:

| Plan | Unique renders per site per day |
| --- | --- |
| [[plan.free.name]] | [[email.dailyFree]] |
| [[plan.starter.name]] | [[email.dailyStarter]] |
| [[plan.pro.name]] | [[email.dailyPro]] |

Only renders count toward it: a value that is already stored is served without counting, however often it is loaded.

The limit is well below a month's images, so it slows such a drain, but it does not stop someone who has one of your URLs from using up the month's images over several days, and then your top-ups. Keep the URLs in your emails, and watch the usage in the dashboard.

Once a site has used its limit for the day, a value that is not stored yet gets the default image instead of an error: every open field at its default. That response has `Cache-Control: no-store` and `X-LTC-Open-Fields: daily-limit`, so that a mail app or proxy does not keep the default as this reader's image. Values that were already rendered keep working, and new values render again after 00:00 UTC.

If a list has more distinct values than the limit, send it in parts on different days, or from a plan with a higher limit.

## Email starter templates

Two starter templates are made for email. Like every starter, they can be used by name in a signed URL; they also work at the other sizes, but they are laid out for these:

| Template | Size to sign | Fields |
| --- | --- | --- |
| `email-banner` | `size=email` ([[size.email.width]] x [[size.email.height]]) | `title`, `name`, `greeting`, `cta`, `tag`, `site`, `image`, `theme` |
| `email-offer` | none, the default `og` ([[size.og.width]] x [[size.og.height]]) | `title`, `name`, `greeting`, `description`, `code`, `expires`, `tag`, `site`, `image`, `theme` |

- `name` is the usual open field. `email-offer` prints `code` in a dashed box, so it can be an open field too, for codes that differ per reader. Codes follow the same value rules.
- Fill in `title`, the one field both templates list as required. Every other field may be left empty.
- The button-shaped `cta` of `email-banner` is part of the picture, not a link: wrap the image in a link in your email.

Your own templates work too: any `{{placeholder}}` of the template can be an open field.

## In the email

Show the image at half its width, so it stays sharp on high-density screens, and give it alt text:

```html
<a href="https://example.com/spring">
  <img src="URL" width="600" alt="Your spring picks are ready" style="display: block; max-width: 100%; height: auto; border: 0;">
</a>
```

<!-- Source: Brevo's email generator rules give images an alt, inline display: block; max-width: 100%; height: auto; and width="600" on the hero, and say "No SVG or WEBP; use JPG, PNG or GIF": https://github.com/getbrevo/brevo-skills/blob/HEAD/skills/email-template-write/references/email-design-rules.md (read 2026-11-26). -->

- In HTML, write each `&` of the URL as `&amp;`, as in any attribute value. The mail app reads it back as `&`, and the signature still matches.
- Use `.png` or `.jpg`. Brevo's own email rules, for example, say to use JPG, PNG or GIF and not WebP.
- Keep the message in the email's text as well, for readers whose mail app does not load images.

## Errors

A URL with open fields can fail with every reason of [Signed URLs](/docs/signed-urls#every-403-and-its-fix), plus these, all as 403 `invalid_signature`:

| `details.reason` | What happened | Fix |
| --- | --- | --- |
| `bad_open_list` | `open` is not a comma-separated list of valid field names, each listed once, without spaces. | Write `open=name` or `open=name,code`. |
| `too_many_open_fields` | `open` lists more than [[email.maxOpenFields]] fields. | Make fewer fields open. |
| `reserved_open_field` | `open` lists `sig`, `size`, `open` or a name ending in `_default`. | Choose another field. |

A URL whose `open` is not a list of field names but whose whole query, `open` included, is signed as ordinary parameters (a URL your code signed before you used open fields) is not refused: it verifies like any [signed URL](/docs/signed-urls), with `open` as a plain parameter and no open fields.

An open field that appears twice in the URL answers `duplicate_param`. An unencoded `&` in a value usually answers `bad_param_name` or `signature_mismatch`: see [What a value may contain](#what-a-value-may-contain).
