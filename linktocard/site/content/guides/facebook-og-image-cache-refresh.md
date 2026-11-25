---
title: "Facebook og:image cache: how to refresh it"
description: You fixed the tags and Facebook still shows the old image or title. Why there are two caches, the order to clear them in, and why adding ?v=2 may not be enough on Facebook.
layout: page
---

Facebook fetches a page when its link is first shared and keeps what it found for a while. Change the page afterwards and Facebook can go on showing the old title or image until it fetches again. Getting it to do that is easy once you know there are two things cached, not one: the page's tags, and the image file.

## The procedure

### 1. Make sure the page is really fixed

Facebook can only pick up what your server sends now. Check the page from outside your browser first, because your own browser, CDN or page cache may be showing you something different:

<form class="card tool-form" action="/tools/og-checker" method="get">
<label class="label" for="guide-url">Check the page Facebook should read</label>
<div class="tool-row">
<input class="input" id="guide-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" maxlength="2048" required placeholder="https://example.com/blog/my-post">
<button class="btn btn-primary" type="submit">Check</button>
</div>
<p class="hint">Free, no account. The <a href="/tools/og-checker">Open Graph checker</a> fetches the page fresh and tests the image it names.</p>
</form>

If the checker still shows the old `og:image`, the problem is on your side, not Facebook's: see [What undoes a refresh](#what-undoes-a-refresh).

### 2. If you replaced the image file, give it a new URL

This is the step most people skip. If `card.png` was overwritten with a new picture at the same address, anything that cached the image by its URL can keep serving the old picture, even after it re-reads your tags. Change the address:

```html
<!-- before -->
<meta property="og:image" content="https://example.com/images/card.png">
<!-- after -->
<meta property="og:image" content="https://example.com/images/card-v2.png">
```

A query string (`card.png?v=2`) also works, as long as your server ignores it and serves the file.

### 3. Ask Facebook to fetch the page again

Open Facebook's [Sharing Debugger](https://developers.facebook.com/tools/debug/), paste the page's address and ask it to scrape the page again. It shows the tags Facebook read and warns about the ones it did not like. As far as we know you need to be logged in to Facebook to use it.

### 4. Share again

New shares use the fresh data. Whether posts that were already published pick up the new image is Facebook's decision, and we have not verified how it handles them. If an old post matters, check it after the re-scrape.

## Why ?v=2 on the page address may not help on Facebook

For WhatsApp or X, sharing `https://example.com/blog/my-post?v=2` is a common way to get a fresh preview, because the address is new to them. On Facebook it can fail: `og:url` is meant to name the page's canonical address, and if yours says `https://example.com/blog/my-post`, Facebook may treat the `?v=2` link as the same page and reuse what it already has. Use the Sharing Debugger for Facebook instead of changing the shared link.

## What undoes a refresh

If the debugger still reads the old tags, your server is still sending them to Facebook. Common reasons:

- **A page cache or CDN** still holds the old HTML. Purge the page in your caching plugin or CDN after you change the tags, then check again.
- **Different HTML for bots.** Some SEO plugins, prerendering services and A/B tools send crawlers a separate copy of the page. Fix the tags in that copy too.
- **Several og:image tags.** Open Graph allows more than one. Apps generally use the first, so a leftover default image from your theme can win. The checker shows the one it found first.
- **og:url points elsewhere.** If `og:url` names another page, for example the home page, Facebook may read that page instead. Make it the address of the page itself.

## FAQ

### How long does Facebook keep the old preview?

We could not verify a published cache time. Do not wait for it: fix the page, then ask the Sharing Debugger to scrape again.

### Do og:image:width and og:image:height help?

They tell a crawler the size of the image before it downloads it, which can help the preview to be laid out the first time a link is shared. Add them with the real pixel size:

```html
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
```

### Does Facebook use twitter: tags?

Do not count on it. The `og:` tags are the ones to get right for Facebook; add `twitter:` tags for X.

### Will adding ?v=2 to image URLs hurt SEO?

No. The image address is not your page's address. Keep the page's canonical link and `og:url` clean, and version only the image URL.

### The debugger says the image could not be downloaded.

Then it is not a cache problem. Facebook could not load the image: it is relative, plain http, behind a login, blocked by hotlink or bot protection, too large, or not an image. The checker's image checks test each of these.

## Fix it automatically

[[site.name]] puts the card's text in the image URL itself. Change the title and the `og:image` URL changes with it, so step 2 happens without you thinking about it: the new card has a new address, and a cached copy of the old image cannot stand in for it. Each card is a [[size.og.width]] x [[size.og.height]] image, rendered on the first request and then served from cache.

[Fix it automatically with [[site.name]]](/login)

Related: [LinkedIn not showing your og:image](/guides/og-image-not-showing-linkedin) · [OG image size](/guides/og-image-size)
