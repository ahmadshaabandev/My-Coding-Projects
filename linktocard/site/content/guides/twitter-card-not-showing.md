---
title: "Twitter card not showing on X: what to check"
description: Why a link on X shows as plain text or a small card instead of a large image, what each twitter:card value asks for, which tags X falls back to, and how to test.
layout: page
---

X (formerly Twitter) draws a card for a link only when the page asks for one. Most sites get the `og:` tags right and still see plain text or a small card on X, because the one tag that has no Open Graph equivalent is missing: `twitter:card`.

<form class="card tool-form" action="/tools/og-checker" method="get">
<label class="label" for="guide-url">Check a page's twitter: tags</label>
<div class="tool-row">
<input class="input" id="guide-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" maxlength="2048" required placeholder="https://example.com/blog/my-post">
<button class="btn btn-primary" type="submit">Check</button>
</div>
<p class="hint">Free, no account. The <a href="/tools/og-checker">Open Graph checker</a> shows the twitter: tags next to the og: ones and draws an approximate X card.</p>
</form>

## The smallest markup that asks for a large card

```html
<meta name="twitter:card" content="summary_large_image">
<meta property="og:title" content="How we cut our build time in half">
<meta property="og:description" content="Three changes that took our CI from 14 minutes to 6.">
<meta property="og:image" content="https://example.com/images/build-time.png">
```

`twitter:card` picks the layout. The title, description and image come from the `og:` tags here. You can add `twitter:title`, `twitter:description` and `twitter:image` when you want different text or a different image on X; leave them out otherwise. Our understanding is that X falls back to the `og:` tags when its own are missing, but we have not been able to re-check X's current documentation, so if the card shows the wrong text, setting the `twitter:` versions explicitly is the quick test.

## What each twitter:card value asks for

The checker treats four values as valid, the ones in X's card documentation as we last knew it:

| Value | What it asks for |
| --- | --- |
| `summary_large_image` | A large image above the title. What most articles, products and launch pages want. |
| `summary` | A small square-ish image beside the title. Fine for profiles and short pages. |
| `app` | A card for a mobile app listing. |
| `player` | A card that plays video or audio. |

Anything else, a typo such as `summary-large-image` or a value copied from another platform, is not a card type. The checker reports it as "twitter:card has an unknown value", and X will most likely ignore it.

## Still no card? Check these next

- **`name` or `property`.** X's examples use `name="twitter:card"`. The checker accepts either attribute, but use `name` so you do not depend on a crawler being lenient.
- **The tag is added by JavaScript.** If a script inserts the tags after the page loads, a crawler that does not run scripts never sees them. `curl -s https://example.com/blog/my-post | grep -i twitter:card` must print the tag.
- **The image does not load for a crawler.** Relative URLs, plain `http://`, a login, hotlink protection or a bot challenge all leave the card without an image. The checker's `og_image_reachable` check fetches it the way a crawler would.
- **The image is too small for the large layout.** A small image may be shown in the small layout instead, or not at all. Use 1200 x 630; see [OG image size](/guides/og-image-size).
- **robots.txt blocks crawlers.** If rules for all bots (`User-agent: *`) disallow the page, a crawler that follows `robots.txt` stays away. If you allow only named crawlers, look up the crawler name X currently documents and allow it too.

## The card was fixed, but X shows the old one

X keeps what it fetched for a URL for a while, and we do not know of a published cache time. As far as we know, a post that is already out keeps its card. For a new post, a link X has not seen yet gets a fresh fetch: add `?v=2` to the end. If you replaced the image file, give the image a new URL as well, so a cached copy of the old image cannot be reused.

## How to test

We could not confirm whether X currently offers a public tool that previews a card, so do not plan around one. Check the tags with the checker, which shows an approximate X layout drawn from the tags it found. Then look at a real post, for example from a test account.

## FAQ

### Should I use summary or summary_large_image?

`summary_large_image` for anything where the picture sells the click: articles, products, launches. `summary` when you only have a logo or a small square image, because a small image stretched into the large layout looks worse than a neat thumbnail.

### Do I need twitter:site?

It is optional: it names the site's account on X. The checker reads it and shows it, but it does not decide whether a card appears.

### Do I need twitter:image if I have og:image?

Not if you want the same image on X and elsewhere. Add it only to show a different image on X, and make it an absolute `https://` URL like `og:image`.

### The card shows, but the image is cropped.

The large layout is a wide shape, so an image of another shape is likely to be cropped. Make the image 1200 x 630 and keep text and faces away from the edges.

### Does the checker see what X sees?

It reads the same HTML and tags, but it is not X. It cannot see X's cache, and X can change its layout at any time. The mockups are labelled approximate for that reason.

## Fix it automatically

[[site.name]] gives you the `twitter:card`, `twitter:image` and `og:image` tags together, pointing at a [[size.og.width]] x [[size.og.height]] card rendered for each page from one template. A different title is a different image URL, so once X reads the page again it cannot fall back on a cached copy of the old image.

[Fix it automatically with [[site.name]]](/login)

Related: [OG image size](/guides/og-image-size) · [LinkedIn not showing your og:image](/guides/og-image-not-showing-linkedin)
