---
title: "OG image not showing on WhatsApp? Six things to check"
description: Why a WhatsApp link preview has no image or an old one, how to test each cause yourself with a browser and curl, and how to get the new image to show.
layout: page
---

When you paste a link into WhatsApp, the title, description and image of the preview come from tags in your page's HTML, mostly `og:title`, `og:description` and `og:image`. If the image is missing, the cause is nearly always on the page or the image server, not in WhatsApp.

WhatsApp does not offer a public debugging tool, and we have not found a published list of its preview rules. So this guide sticks to what you can test from the outside. Start by putting your page through the checker: it reads the same tags and tests the image.

<form class="card tool-form" action="/tools/og-checker" method="get">
<label class="label" for="guide-url">Check your page</label>
<div class="tool-row">
<input class="input" id="guide-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" maxlength="2048" required placeholder="https://example.com/blog/my-post">
<button class="btn btn-primary" type="submit">Check</button>
</div>
<p class="hint">Free, no account. Opens the <a href="/tools/og-checker">Open Graph checker</a> with your address.</p>
</form>

## Work through it in this order

Each step rules out one cause. Stop at the first one that fails.

### 1. The tag is in the HTML your server sends

Link-preview fetchers generally read the HTML as it arrives and do not run JavaScript. If your framework adds the tags in the browser after the page loads, the preview never sees them. Fetch the page the way a bot does and look for the tag:

```bash
curl -s https://example.com/blog/my-post | grep -i 'og:image'
```

No output means the tag is not in the server's HTML. Render it on the server, or at build time for a static site.

### 2. The image URL is absolute and uses https

`content="/images/card.jpg"` is relative. A browser would resolve it, but a preview fetcher is not obliged to. Write the full address, `https://example.com/images/card.jpg`. A plain `http://` image is a second, separate problem: serve it over https.

### 3. The image loads for a stranger

Open the image URL in a private browser window. It must load without a login, a cookie banner or a redirect to a page. Then check it the way a server would see it:

```bash
curl -sI https://example.com/images/card.jpg
```

You want a `200` status and a `content-type` that starts with `image/`. Three things on your own side often break this:

- **Hotlink protection** that refuses image requests without a `Referer` from your own site.
- **Bot protection or a firewall rule** that challenges visitors that are not browsers. Preview fetchers cannot solve a challenge, so they get no image.
- **Signed or expiring image URLs** from a storage bucket that have expired by the time someone shares the link.

### 4. The image file is small

WhatsApp does not publish a file size limit that we could find, and developers report different numbers. We do not know the real limit, so aim low rather than near any number you read, ours included. A 1200 x 630 JPEG at normal quality is usually a few hundred KB. A multi-megabyte PNG photo is the kind of file to replace first. The checker warns from 5 MB, which is generous for a chat app.

### 5. The page answers quickly

A preview fetcher waits only so long for your page; WhatsApp does not say how long. If the page takes several seconds to answer, the preview can come out without an image, or not at all. The checker warns when the page takes more than 3 seconds. Cache the page, or at least make sure the `<head>` is sent quickly.

### 6. The link does not end somewhere else

The preview is built from the page the fetcher ends up on. Look out for redirects to a cookie consent page, a country selector, a login page, or a shortener chain. The checker follows up to 3 redirects and shows the final address; if that is not your article, fix the redirect.

## The image is fixed, but WhatsApp still shows the old one

Two separate things keep an old preview around:

- **Messages already sent keep their preview.** As far as we know, the preview is stored with the message, so fixing your page does not change what is already in a chat. Only new messages can pick up the new image.
- **WhatsApp can reuse what it fetched before** for the same address. It does not say for how long. To force a fresh fetch, share a slightly different URL, for example with `?v=2` on the end, which WhatsApp has not seen yet.

If you replaced the image file but kept its URL, change the image URL too (`card-v2.jpg`, or `card.jpg?v=2`), so nothing that cached the old image by its address can serve it again.

## Small thumbnail or large image

WhatsApp shows link previews in more than one layout, from a small image beside the text to a wider image above it. We have not been able to confirm which rule decides the layout, and it may change between app versions. A 1200 x 630 image with the important part in the middle is the safe choice: it fills the wide layout and still reads when it is cropped to a square.

## FAQ

### Does WhatsApp read twitter: tags?

We have not seen WhatsApp documentation that says so. Get the `og:` tags right for WhatsApp, and treat `twitter:` tags as being for X.

### The preview worked yesterday and now it does not. What changed?

Usually something on the site: a new theme or plugin that dropped the tags, a firewall or bot rule that now blocks unknown visitors, an image moved to a new path, or a page that became slow. Run the checker and compare the image URL it reports with the one you expect.

### Can I test without sending a message to someone?

Use the checker first. It reads the same tags and draws an approximate WhatsApp-style mockup, with no message sent. To see WhatsApp's own result you have to paste the link into a real chat, for example with a colleague who knows you are testing.

### My page is only for logged-in users. Can it have a preview?

Only with tags that are in the page a logged-out visitor gets. A preview fetcher has no login, so give the logged-out response (a sign-in page or a paywall teaser) its own `og:title`, `og:description` and `og:image`.

### Does robots.txt matter for WhatsApp?

We do not know whether WhatsApp's fetcher follows `robots.txt`. A rule that blocks all bots (`User-agent: *` with `Disallow: /`) is worth a second look on pages you want shared. The checker reads your `robots.txt` and warns when it blocks the page.

## Fix it automatically

If your pages have no image at all, or the same one for every page, [[site.name]] makes a [[size.og.width]] x [[size.og.height]] card for each page from one HTML and CSS template, served over https from a URL that needs no login, and gives you the tags to paste. The [[plan.free.name]] plan has [[plan.free.images]] images a month and needs no card.

[Fix it automatically with [[site.name]]](/login)

Related: [OG image size](/guides/og-image-size) · [Twitter card not showing](/guides/twitter-card-not-showing)
