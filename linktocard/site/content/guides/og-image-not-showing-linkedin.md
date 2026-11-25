---
title: "LinkedIn not showing your og:image: find the cause"
description: A LinkedIn post shows no image, the wrong image or an old one. Find the cause from what you see, fix the page, then ask LinkedIn to read it again with Post Inspector.
layout: page
---

LinkedIn builds a link preview from the tags in your page, mainly the Open Graph ones: `og:title`, `og:description`, `og:image` and `og:url`. What goes wrong usually shows in the preview itself, so start from what you see.

<form class="card tool-form" action="/tools/og-checker" method="get">
<label class="label" for="guide-url">Check the page you are sharing</label>
<div class="tool-row">
<input class="input" id="guide-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" maxlength="2048" required placeholder="https://example.com/blog/my-post">
<button class="btn btn-primary" type="submit">Check</button>
</div>
<p class="hint">Free, no account. The <a href="/tools/og-checker">Open Graph checker</a> lists every tag it finds and tests the image.</p>
</form>

## What you see, and what it usually means

| What you see on LinkedIn | Usual cause | Where to look in the checker |
| --- | --- | --- |
| Title and text are right, no image | The image URL does not work for a crawler: it is relative, plain http, behind a login, refused by hotlink or bot protection, or not an image | `og_image_absolute`, `og_image_https`, `og_image_reachable` |
| The title or image of a different page | `og:url` or the canonical link points at another address, often the home page | The `og:url` row in "Tags found on the page" |
| A small thumbnail instead of a wide image | The image is small or not a wide shape | `og_image_dimensions`, `og_image_ratio` |
| The old image, after you changed it | LinkedIn is still using what it fetched before | Nothing: the checker reads the page fresh. See [Ask LinkedIn to read the page again](#ask-linkedin-to-read-the-page-again). |
| No preview at all, just the address | The page itself could not be read: slow, blocked, a redirect to a login, or an error status | The result banner, `response_time`, `robots` |

These are the usual causes, not LinkedIn's documented rules. LinkedIn does not publish the exact checks its crawler makes, as far as we could find.

## og:url: the cause people miss

`og:url` is meant to hold the page's own canonical address. Some themes print the same `og:url` on every page, often the home page. A crawler that trusts `og:url` can then fetch or show the other page's title and image, however correct the rest of your tags are.

Look at the `og:url` and canonical rows in the checker's tag table. Both should be the address of the page you are sharing, with `https://` and without tracking parameters:

```html
<link rel="canonical" href="https://example.com/blog/my-post">
<meta property="og:url" content="https://example.com/blog/my-post">
```

## An image that works for people but not for crawlers

If the image opens in your browser but LinkedIn shows none, the difference is usually that you are logged in, or that you are a browser. Test from a private window, then from the command line:

```bash
curl -sI https://example.com/images/my-post.png
```

A `200` and a `content-type` of `image/png` or `image/jpeg` is what you want. A `403` or a redirect means something on your side treats crawlers differently: a CDN bot rule, a security plugin, hotlink protection or an image link that expires. Allow the image path, or serve the image from a plain public URL.

## Ask LinkedIn to read the page again

LinkedIn keeps what it fetched for a URL for a while. Once the checker shows your page is right, use LinkedIn's [Post Inspector](https://www.linkedin.com/post-inspector/). It fetches the URL and shows what LinkedIn reads from it, which is the usual way to make LinkedIn pick up a change. We have not verified how long LinkedIn keeps an old preview without it.

If you replaced the image file but kept the same image URL, give it a new URL as well (`my-post-v2.png`, or `?v=2` on the image address). Anything that cached the image by its address then has to fetch the new one.

Whether a post that is already published picks up the new preview is up to LinkedIn. If it does not, the reliable fix is to share the link again after the inspector shows the right image.

## FAQ

### Does LinkedIn need og:image:width and og:image:height?

They are optional in the Open Graph protocol. They tell a crawler the image size before it downloads the image. They cost one line each, so add them:

```html
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
```

### What size should the image be for LinkedIn?

1200 x 630 pixels, the 1.91:1 shape most sites use, is a safe choice. We have not verified LinkedIn's current published minimum, so do not aim near it. [OG image size](/guides/og-image-size) explains the shape, the file size and the crop.

### My site is behind a login. Can LinkedIn show a preview?

Only of what a logged-out visitor gets. LinkedIn's crawler has no account on your site. Put the tags you want in the sign-in page or the public teaser.

### Does LinkedIn use twitter: tags?

Do not rely on it. Set the `og:` tags; they are what most apps other than X read first.

### How long until the new image shows?

We do not know LinkedIn's cache time. After you fix the page, the inspector is the way to ask for a fresh read instead of waiting.

## Fix it automatically

If the trouble is that each page needs its own image, [[site.name]] renders a [[size.og.width]] x [[size.og.height]] card for every page from one HTML and CSS template. The image URL is public and https, so a crawler can load it without a login, and a change of title gives a new image URL, so no cache serves the old card.

[Fix it automatically with [[site.name]]](/login)

Related: [Refresh Facebook's cached og:image](/guides/facebook-og-image-cache-refresh) · [OG image not showing on WhatsApp](/guides/og-image-not-showing-whatsapp)
