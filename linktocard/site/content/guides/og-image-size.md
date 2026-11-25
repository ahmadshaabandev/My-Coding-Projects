---
title: "OG image size: 1200 x 630, 1.91:1 and file size"
description: Which pixel size and shape to make an og:image, what common sizes score in our checker, how large the file can be, which formats are safe and where to keep text so crops do not cut it.
layout: page
---

**Short answer:** make it 1200 x 630 pixels, a PNG or JPEG well under 1 MB, at an absolute `https://` URL, with the text and faces in the middle. That one image works as the large preview on most apps, and survives being cropped to a smaller or squarer shape.

The rest of this page explains why, and what happens with other sizes.

## Why 1200 x 630

1200 x 630 is a 1.91:1 rectangle, the wide shape that large link previews commonly use. It is the size most sites settle on, and the one this checker tests for. Each app publishes, or does not publish, its own rules, and they change. We could not verify the current numbers for each platform from here, so the figures below are the thresholds of our own checker, not any platform's official limits.

## What common sizes score in the checker

The checker fails an image smaller than 200 px on either side, and warns when the shape is more than 3 % away from 1.91:1.

| Size (px) | Shape | Checker verdict |
| --- | --- | --- |
| 1200 x 630 | 1.90:1 | Pass |
| 1200 x 628 | 1.91:1 | Pass |
| 2400 x 1260 | 1.90:1 | Pass |
| 600 x 315 | 1.90:1 | Pass |
| 1200 x 600 | 2.00:1 | Warn |
| 1200 x 675 | 1.78:1 | Warn |
| 1080 x 1080 | 1.00:1 | Warn |
| 1000 x 1500 | 0.67:1 | Warn |
| 150 x 150 | 1.00:1 | Fail |

A warning is not an error. A 2:1 or 16:9 image still shows, but an app that wants 1.91:1 trims the edges or shows it smaller. A square or tall image is the most likely to be cut down or turned into a thumbnail.

**600 x 315 passes, but** it is soft on high-density screens in the large layout. **2400 x 1260 passes too**; it is sharper on those screens, at the cost of a larger file. 1200 x 630 is the usual middle ground.

## Keep the important part in the middle

Apps do not crop the same way, and some show the image as a small square next to the text. Design for that:

- Keep the headline, logo and any face inside the central area, roughly the middle 630 x 630 of a 1200 x 630 image.
- Leave a margin of about 60 px on every side, so rounded corners and slight crops do not touch the text.
- Make the headline large. The preview is often shown at a third of its real width or less on a phone, and small text turns to noise.

## File size

The checker warns when the image is over 5 MB, and stops reading at 8 MB. Those are generous limits for the checker to work with, not targets. Smaller files load faster for every app, and some apps may skip an image that is large or slow.

A 1200 x 630 card with text and flat colour is usually well under 200 KB as a PNG. A photo at that size is usually a few hundred KB as a JPEG at normal quality. If your file is several megabytes, it is almost always a photo saved as PNG, or an image far larger than 1200 x 630.

## Format

- **PNG** for cards with text, logos and flat colour. Sharp edges, no blur around letters.
- **JPEG** for photos. Much smaller than PNG for the same picture.
- **WebP** is smaller again, but we cannot vouch for every app that unfurls links reading it. Use PNG or JPEG unless you have tested WebP where your links are shared.
- **SVG** is not a safe choice for `og:image`: support among preview fetchers is unreliable, and this checker does not measure SVG.
- **GIF**: do not rely on animation in a link preview. Use a still PNG or JPEG.

## The tags that go with the image

```html
<meta property="og:image" content="https://example.com/images/my-post.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Chart showing build time falling from 14 to 6 minutes">
<meta name="twitter:card" content="summary_large_image">
```

`og:image:width` and `og:image:height` tell a crawler the size before it downloads the image; give the real pixel size. `og:image:alt` describes the image for people who cannot see it. `twitter:card` asks X for the large layout; X reads `og:image` when there is no `twitter:image`, as far as we know.

## Check an image

The checker downloads the image your page names and reports its status, type, file size, pixel size and shape, with a verdict for each:

<form class="card tool-form" action="/tools/og-checker" method="get">
<label class="label" for="guide-url">Measure a page's og:image</label>
<div class="tool-row">
<input class="input" id="guide-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" maxlength="2048" required placeholder="https://example.com/blog/my-post">
<button class="btn btn-primary" type="submit">Check</button>
</div>
<p class="hint">Enter the page's address, not the image's. Free, no account: the <a href="/tools/og-checker">Open Graph checker</a> finds the image through the page's tags.</p>
</form>

## FAQ

### 1200 x 630 or 1200 x 628?

Both are 1.91:1 within rounding, and both pass. 1200 x 630 is the more common choice.

### Do I need a separate square image?

Open Graph allows more than one `og:image`, but apps generally use the first one and crop it to the shape they need. One 1200 x 630 image with a centred design is simpler and usually enough.

### Should the image be the same for X and for everything else?

Usually yes. X's large card is also a wide shape, so the same 1200 x 630 file works there. Add a `twitter:image` only when you want a different picture on X.

### Is the checker's 5 MB warning a platform's limit?

No. It is this checker's own threshold for "too large to be safe anywhere". Platforms set their own limits, which we could not verify, and some are likely lower. Treat 5 MB as a ceiling and aim far below it.

### My image is the right size but still looks blurry.

The app scaled it down. Text that is too small for the preview size blurs first. Make the headline larger and the copy shorter rather than the image bigger.

## Fix it automatically

[[site.name]] renders every card at exactly [[size.og.width]] x [[size.og.height]], as PNG, JPEG or WebP, from one HTML and CSS template, and gives you the `og:image`, size and `twitter:card` tags to paste. You design the layout once; the size, shape and file are right for every page.

[Fix it automatically with [[site.name]]](/login)

Related: [Twitter card not showing](/guides/twitter-card-not-showing) · [Refresh Facebook's cached og:image](/guides/facebook-og-image-cache-refresh)
