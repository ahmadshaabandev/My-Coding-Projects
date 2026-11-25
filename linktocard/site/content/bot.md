---
title: LinkToCardBot
description: What LinkToCardBot/1.0 fetches from your site, when it does, its limits, and how to reach a person about it. It is not a crawler.
---

# LinkToCardBot

LinkToCardBot is the fetcher behind the free [Open Graph checker](/tools/og-checker) and the `GET /v1/inspect` API of [[site.name]]. If you see it in your logs, someone asked to check how one of your pages looks when it is shared. It is not a crawler.

Every request it makes carries this User-Agent:

```text
LinkToCardBot/1.0 (+[[site.url]]/bot)
```

## When it visits

Only when a person asks. Someone pastes one of your URLs into the checker, or calls the inspect API with their own API key. It never follows the links on your page, never discovers pages by itself, and keeps no list of sites to come back to.

The same URL checked again within 10 minutes is answered from our cache, without a new request to your site.

## What it fetches

For one check it requests, at most:

- **the page you were asked about**: one `GET`, following up to 3 redirects;
- **your `/robots.txt`**: one `GET`, read once for that check;
- **the image in `og:image`** (or `twitter:image` when there is no `og:image`): a `HEAD`, then a `GET`, to measure its type, file size and pixel size.

While someone looks at the result in the checker, the image and your favicon are requested again so they can be displayed. Those requests carry the same User-Agent and follow the same limits.

It reads the HTML your server sends. It does not run JavaScript, submit forms, log in, or send cookies, and it never stores or passes on your page's HTML: only the parsed tags and the check results are kept, for 10 minutes.

## Its limits

- `https://` only. Plain `http://` addresses are refused.
- Public addresses only. Every address, including each redirect, is checked first, and anything that resolves to a private, local, link-local, shared or reserved network is refused.
- 5 seconds per request. The page is read up to 2 MB and the rest is ignored; an image is read up to 8 MB.
- Only `text/html` and `application/xhtml+xml` pages are read. Anything else ends the check with an error for the person who asked.

## robots.txt

Because each request is a one-off made for a person, like a link preview, LinkToCardBot reads your `robots.txt` but does not treat it as a ban: it tells the person who asked when your rules disallow `LinkToCardBot` or all bots for that page, and still reads the page, so the person sees the tags and the warning together.

If you do not want it to fetch your site at all, block the User-Agent `LinkToCardBot` at your server or firewall. The person who asked will then see an HTTP error instead of a result.

## Contact

Email <[[site.supportEmail]]> with your domain and, if you can, the time and URL of the requests you saw. A person reads every message and answers.
