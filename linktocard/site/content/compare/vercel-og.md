---
title: "[[site.name]] vs @vercel/og"
description: An honest comparison of [[site.name]] and the free, open-source @vercel/og library (next/og) for Open Graph images, and when each one makes sense.
layout: page
---

**In short:** if your site is a Next.js app, use `next/og`. It is free, it is built in, and it is the better choice. Consider [[site.name]] when your site is not a JavaScript app, when you want to send HTML and CSS instead of JSX, or when you need JPEG or WebP.

These are different kinds of thing. `@vercel/og` is a library that you run inside your own application. [[site.name]] is a hosted service that you call. Both render with the same open-source engine, Satori.

## What each product is

**`@vercel/og`** is an open-source library (MPL-2.0 licence) that, in its own words, generates "Open Graph Images dynamically from HTML/CSS without a browser". You write a card as a JSX element and return an `ImageResponse` from a function in your own app. It supports both the Node.js runtime and the Edge runtime. Next.js bundles it as `next/og`, with an `opengraph-image` file convention that adds the meta tags for you.

**[[site.name]]** is a hosted API that renders social-card images from HTML and CSS that you write, or from five starter templates. You get the image from a signed URL that you paste into `<meta property="og:image">`, or from a REST endpoint.

## Side by side

| | [[site.name]] | `@vercel/og` / `next/og` |
| --- | --- | --- |
| Template model | HTML and CSS as text, or five starter templates | JSX / React elements in your own code; experimental Tailwind support |
| Rendering approach | Satori and resvg, not a browser | Satori and resvg, not a browser |
| Satori version | 0.63.2 at the time of writing | `@vercel/og` 1.0.3 depends on Satori 0.33.5 |
| Output formats | PNG, JPEG, WebP | PNG only |
| Sizes | Three fixed sizes | Any width and height |
| Signed, on-demand URLs | Built in | Not built in. A route-based image often does not need one; for user-supplied parameters you add signing or encryption yourself, and the README links an example. |
| Hosting model | Hosted service you call over HTTPS | A library inside your own app, on your own hosting |
| Licence and cost | Proprietary service with free and paid plans | MPL-2.0, no fee; you pay only for your own hosting |
| Scope | Static social cards, from any stack that can print a URL | Static social cards, from a JavaScript app |

### A note on CSS support

Because both products use Satori, both support a **subset** of CSS, neither runs JavaScript, and neither will match a browser pixel for pixel. Satori's own README says it does not guarantee a 100% match with browser output. That applies to us as much as to `@vercel/og`.

The subset differs by Satori version. The Next.js documentation for `next/og` says that only flexbox and a subset of CSS properties are supported and that `display: grid` will not work, and that fonts must be TTF, OTF or WOFF. The newer Satori release that [[site.name]] uses documents Flexbox, Grid and block layout, and adds WOFF2 to the font formats it can read. This is a difference of versions, not of engines: it will narrow or disappear when `@vercel/og` moves to a newer Satori, and you can also call Satori directly today. Our documentation lists exactly what [[site.name]] supports.

## Where @vercel/og is better

- **It is free and open source.** No subscription, no API key and no vendor quota. Your volume is limited only by your own hosting.
- **It runs inside your app.** There is no extra request to an outside rendering service, no third-party outage between your page and its image, and your page data is not sent to another company's rendering API. (The library does fetch emoji graphics and fallback fonts from public CDNs when a card needs them.)
- **It is the natural choice for Next.js.** `next/og` ships with Next.js, so there is nothing to install in the App Router. An `opengraph-image.tsx` file sets the meta tags for you, and images can be generated at build time.
- **JSX with your own components.** Cards are type-checked in your repository and can use your own data fetching and authentication.
- **Often no signed URL is needed.** An image tied to a route, with no user-supplied parameters, leaves nothing for anyone to tamper with.
- **Emoji and fallback fonts are built in:** six emoji styles, and automatic fallback fonts for scripts your own font does not cover.
- **Long-lived cache headers by default.**
- **Any image size,** and you decide when to upgrade.

If you are building with Next.js, `next/og` is the default choice. Use it.

## Where [[site.name]] fits

This is our view of where a hosted service is a reasonable choice.

- **Your site is not a JavaScript app.** `ImageResponse` takes React elements, so it needs JavaScript code running at request time or at build time. For a static site generator, a CMS theme, or a back end written in another language, a URL in a meta tag or a REST call works without adding a JavaScript service.
- **You want to send HTML and CSS as text.** Satori and `@vercel/og` take JSX or element objects, not HTML strings.
- **You need JPEG or WebP.** `@vercel/og` returns PNG.
- **Your image URLs carry user-supplied values** and you would prefer signing to be built in.
- **You would prefer not to maintain it yourself:** font files, the rendering code and Satori upgrades.

Be aware of what you give up. [[site.name]] is a paid service above its free allowance, it is an outside dependency in your `og:image` path, it offers no uptime guarantee, and it has three fixed sizes.

## Pricing

`@vercel/og` has no fee. You pay only for the hosting that runs it. We do not quote other companies' prices; if you host on Vercel, check [Vercel's pricing page](https://vercel.com/pricing) for current prices.

[[site.name]] has a Free plan with [[plan.free.images]] images a month (with a small corner mark), Starter at [[plan.starter.price]] a month for [[plan.starter.images]] images, and Pro at [[plan.pro.price]] a month for [[plan.pro.images]] images. See [our pricing](/pricing).

We have not benchmarked the two against each other and make no claims about speed or cost.

## Sources and corrections

Information about @vercel/og was last checked in November 2026 against the sources below. Version numbers go out of date quickly; treat the packages' own documentation as the authority.

- [`@vercel/og` on npm](https://www.npmjs.com/package/@vercel/og), version 1.0.3: README, licence, type definitions and package metadata
- [Satori README](https://raw.githubusercontent.com/vercel/satori/main/README.md) (version 0.63.2), and the README published with Satori 0.33.5
- Next.js documentation: [ImageResponse](https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/04-functions/image-response.mdx) and [opengraph-image](https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.mdx), and the documentation shipped inside the `next` 16.4.6 package

**Found a mistake?** Email <[[site.supportEmail]]> and we will correct it.

<small>Vercel and Next.js are trademarks of Vercel, Inc. Other product names mentioned here are trademarks of their respective owners. [[site.name]] uses the open-source Satori library but is not affiliated with, endorsed by or sponsored by Vercel.</small>
