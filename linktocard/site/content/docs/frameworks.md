---
title: Frameworks
description: Copy-paste integration for plain HTML, WordPress, Ghost, Webflow, Hugo, Astro and Next.js, with the honest route for platforms that cannot sign a URL themselves.
layout: doc
order: 5
nav: Frameworks
---

Every integration does the same two things: build a [signed URL](/docs/signed-urls) for each page, and print it in the page's `og:image` and `twitter:image` tags.

**Sign on the server or at build time, never in the browser.** The site secret must not reach visitors. Where a platform cannot run your code at all, this page says so and gives the route that works.

| Platform | Where the URL is signed |
| --- | --- |
| [Plain HTML](#plain-html) | A script you run before you upload |
| [WordPress](#wordpress) | PHP, when the page is rendered |
| [Ghost](#ghost) | Not in the theme. In the dashboard, or in a script |
| [Webflow](#webflow) | Not in Webflow. In the dashboard, or in a script |
| [Hugo](#hugo) | A partial template, at build time |
| [Astro](#astro) | Component frontmatter, at build time or on the server |
| [Next.js](#next-js) | `generateMetadata`, on the server |

The JavaScript examples import `signedCardUrl()` from `card-url.mjs`, the file from the [Quickstart](/docs/quickstart#3-sign-a-url). The PHP and Hugo examples contain their own signer.

## Plain HTML

Sign when you build or deploy. This script prints the five tags for each page; paste them into each page's `<head>`, or have your build step insert them.

```js
// build-cards.mjs
import { signedCardUrl } from './card-url.mjs';

const pages = [
  { file: 'index.html', title: 'Tidepool', description: 'Tide tables for small boats.' },
  { file: 'pricing.html', title: 'Pricing' },
];

const attr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

for (const page of pages) {
  const params = { title: page.title };
  if (page.description) params.description = page.description;
  const url = attr(
    signedCardUrl({
      secret: process.env.LTC_SITE_SECRET,
      baseUrl: '[[site.url]]',
      siteId: process.env.LTC_SITE_ID,
      template: 'blog',
      params,
    }),
  );
  console.log(`<!-- ${page.file} -->
<meta property="og:image" content="${url}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${url}">
`);
}
```

```bash
LTC_SITE_ID="s_..." LTC_SITE_SECRET="ltcs_..." node build-cards.mjs
```

For a handful of pages you do not need a script: the builder under **Sites & URLs** in the dashboard gives you the same five tags for the values you type.

## WordPress

Save this as `wp-content/plugins/linktocard-images.php` and activate it. It signs with the reference PHP signer and takes the title and author from the current post or page.

Put your site id and secret in `wp-config.php`, not in the plugin file:

```php
define('LTC_SITE_ID', 's_your_site_id');
define('LTC_SITE_SECRET', 'ltcs_your_site_secret');
```

```php
<?php
/**
 * Plugin Name: Link To Card images
 * Description: Uses a signed Link To Card URL as the social image of posts and pages.
 */

function ltc_signed_card_url(string $secret, string $baseUrl, string $siteId, string $template, string $ext, array $params): string
{
    $clean = [];
    foreach ($params as $name => $value) {
        $clean[$name] = preg_replace('/[\x00-\x1F\x7F]/', ' ', (string) $value);
    }

    $path = "/v1/og/{$siteId}/{$template}.{$ext}";
    $sorted = $clean;
    ksort($sorted, SORT_STRING);
    $lines = [$path, implode(',', array_keys($sorted))];
    foreach ($sorted as $name => $value) {
        $lines[] = "{$name}={$value}";
    }
    $sig = hash_hmac('sha256', implode("\n", $lines), $secret);

    return $baseUrl . $path . '?' . http_build_query($clean + ['sig' => $sig], '', '&');
}

function ltc_card_url(): string
{
    if (!is_singular() || !defined('LTC_SITE_SECRET') || !defined('LTC_SITE_ID')) {
        return '';
    }
    $post = get_post();
    // get_the_title() returns HTML; the card needs plain text.
    $title = html_entity_decode(wp_strip_all_tags(get_the_title($post)), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return ltc_signed_card_url(LTC_SITE_SECRET, '[[site.url]]', LTC_SITE_ID, 'blog', 'png', [
        'title' => $title,
        'author' => get_the_author_meta('display_name', (int) $post->post_author),
    ]);
}

// Without an SEO plugin: print the tags yourself.
function ltc_print_card_tags(): void
{
    $url = ltc_card_url();
    if ($url === '') {
        return;
    }
    printf('<meta property="og:image" content="%s">' . "\n", esc_url($url));
    echo '<meta property="og:image:width" content="1200">' . "\n";
    echo '<meta property="og:image:height" content="630">' . "\n";
    echo '<meta name="twitter:card" content="summary_large_image">' . "\n";
    printf('<meta name="twitter:image" content="%s">' . "\n", esc_url($url));
}

// With Yoast SEO or Rank Math: replace the image they print.
function ltc_filter_card_image($image)
{
    $url = ltc_card_url();
    return $url !== '' ? $url : $image;
}
```

Then add **one** of these three blocks at the end of the file.

No SEO plugin:

```php
add_action('wp_head', 'ltc_print_card_tags');
```

Yoast SEO:

```php
add_filter('wpseo_opengraph_image', 'ltc_filter_card_image');
add_filter('wpseo_twitter_image', 'ltc_filter_card_image');
```

Rank Math:

```php
add_filter('rank_math/opengraph/facebook/image', 'ltc_filter_card_image');
add_filter('rank_math/opengraph/twitter/image', 'ltc_filter_card_image');
```

Check the result: open a post, view the page source and look for `og:image`. There must be exactly one, and it must be the `[[site.host]]` URL.

- If an SEO plugin is active and you also use the `wp_head` block, the page gets two `og:image` tags. Use the plugin's filters instead.
- The filters change an image that the SEO plugin is already printing. If a post without a featured image shows no `og:image` at all, set a default social image in the plugin's settings so that there is something to replace.
- An SEO plugin may print `og:image:width` and `og:image:height` for the image it had chosen itself. If the page source shows other numbers than 1200 and 630 next to your URL, look in the plugin's documentation for the filters of those two tags.
- Posts cached by a page-cache plugin keep their old tags until that cache is cleared.
- The plugin code on this page was run with stand-ins for the WordPress functions it calls, not inside a WordPress installation. Check the page source on your own site.

## Ghost

A Ghost theme cannot sign a URL: themes are Handlebars templates, and we know of no theme helper that computes an HMAC. Hosted Ghost does not run server code of yours. Two routes work.

**By hand, per post.** Make the card in the dashboard builder (**Sites & URLs**), or with one API call, and download the image:

```bash
curl [[site.url]]/v1/images \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template": "blog", "data": {"title": "My post title", "author": "Maya Chen"}, "response": "binary"}' \
  -o card.png
```

Then, in the Ghost editor, open the post settings and upload `card.png` in the **Facebook card** and **X card** (formerly Twitter card) sections. Ghost hosts the uploaded file and prints it as `og:image` and `twitter:image`. An uploaded file does not change when you edit the title; make a new one.

**With a script.** Ghost's Admin API lists `og_image` and `twitter_image` among a post's fields. A script that runs after you publish can sign a URL for each post and write it to those two fields. We have not run this against a Ghost site: read the Admin API documentation for updating a post before you rely on it.

In both routes, do not store the `url` that `POST /v1/images` returns in JSON mode. It stops working when the image's cache period ends. A signed URL does not: it is rendered again on demand.

## Webflow

Webflow cannot sign a URL: it runs no server code of yours when a page is published.

**Static pages.** Make the card in the dashboard builder (**Sites & URLs**). In Webflow, open the page's settings, go to the Open Graph settings and set the Open Graph image to the signed URL. If your workspace only offers an image picker there, download the PNG (see the `curl` command under [Ghost](#ghost)) and upload it instead.

**Collection pages.** Webflow's own Open Graph image setting for a Collection template must be bound to an Image field of the Collection, and a plain text field with a URL cannot be used there. So:

- add an Image field, and upload a downloaded card for each item; or
- add a plain text field that holds the signed URL for each item, and print it yourself in the template's custom code (inside the head tag), inserting the field with **Add Field**:

```html
<meta property="og:image" content="SIGNED URL FIELD GOES HERE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="SIGNED URL FIELD GOES HERE">
```

With the second route, remove the image from the template's built-in Open Graph settings so the page does not get two `og:image` tags, publish, and view the source of the live page to confirm that the tags are inside `<head>` with the URL filled in. Custom code needs a Webflow plan that allows it. We have not run either route on a Webflow site.

To fill many items, generate the signed URLs with a script (the signers on [Signed URLs](/docs/signed-urls#signer-code) need only the item's title) and import them into the text field.

## Hugo

Hugo can sign at build time: it has an `hmac` template function that returns a hexadecimal digest. Tested with Hugo 0.170.1.

By default, Hugo's security policy lets templates read only environment variables whose names start with `HUGO_` (and the variable `CI`), so name the secret accordingly:

```bash
export HUGO_LTC_SITE_SECRET="ltcs_..."
hugo
```

Put the site id in your site configuration (`hugo.toml`):

```toml
[params]
  cardSiteId = "s_your_site_id"
```

Save this as `layouts/partials/card-image.html`:

```go-html-template
{{- /* Signed Link To Card URL for the current page. */ -}}
{{- $secret := getenv "HUGO_LTC_SITE_SECRET" -}}
{{- if not $secret -}}
  {{- errorf "HUGO_LTC_SITE_SECRET is not set: card image URLs cannot be signed." -}}
{{- end -}}
{{- $path := printf "/v1/og/%s/blog.png" site.Params.cardSiteId -}}
{{- $params := dict "title" .Title "author" (.Params.author | default "") -}}

{{- /* range walks a map in sorted key order, which is the order the signature needs. */ -}}
{{- $names := slice -}}
{{- $lines := slice -}}
{{- $query := slice -}}
{{- range $name, $value := $params -}}
  {{- $value = replaceRE `[\x00-\x1f\x7f]` " " (string $value) -}}
  {{- if $value -}}
    {{- $names = $names | append $name -}}
    {{- $lines = $lines | append (printf "%s=%s" $name $value) -}}
    {{- $query = $query | append (printf "%s=%s" $name (replace (urlquery $value) "+" "%20")) -}}
  {{- end -}}
{{- end -}}

{{- $message := delimit (slice $path (delimit $names ",") | append $lines) "\n" -}}
{{- $sig := hmac "sha256" $secret $message -}}
{{- $url := printf "[[site.url]]%s?%s&sig=%s" $path (delimit $query "&") $sig -}}
<meta property="og:image" content="{{ $url }}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{{ $url }}">
```

Call it inside `<head>` in your base or single-page template:

```go-html-template
{{ partial "card-image.html" . }}
```

The partial takes `author` from the page's front matter and leaves empty values out. If the secret is not set, the build stops with an error instead of publishing URLs that answer 403. To send more fields, add them to the `dict`. If your theme already prints an `og:image` tag, remove that one so the page has exactly one.

## Astro

Component frontmatter runs at build time, or on the server for on-demand pages, and is never sent to the browser. Tested with Astro 7.4.13.

Put the secret in `.env` or in your build environment. Do not give it a `PUBLIC_` prefix: only variables with that prefix are exposed to client-side code.

```text
LTC_SITE_ID=s_your_site_id
LTC_SITE_SECRET=ltcs_your_site_secret
```

Copy `card-url.mjs` to `src/lib/` and sign in your layout:

```astro
---
// src/layouts/Post.astro
import { signedCardUrl } from '../lib/card-url.mjs';

const { title, author } = Astro.props;
const image = signedCardUrl({
  secret: import.meta.env.LTC_SITE_SECRET,
  baseUrl: '[[site.url]]',
  siteId: import.meta.env.LTC_SITE_ID,
  template: 'blog',
  params: { title, author },
});
---
<html lang="en">
  <head>
    <title>{title}</title>
    <meta property="og:image" content={image} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content={image} />
  </head>
  <body><slot /></body>
</html>
```

```astro
---
// src/pages/posts/hello.astro
import Post from '../../layouts/Post.astro';
---
<Post title="Astro says hello" author="Zoë Müller"><p>Body</p></Post>
```

Astro escapes the attribute value for you.

## Next.js

**If your site is already a Next.js app, look at `next/og` first.** It ships with Next.js and runs in your own app: no account, no secret, nothing to sign. You write the card as JSX and return an `ImageResponse`. For many Next.js sites it is the right choice.

The differences, as documented by Next.js 16.4.6:

| | `next/og` | [[site.name]] |
| --- | --- | --- |
| Where it runs | In your Next.js app | Hosted; your app only prints a URL |
| Card is written as | JSX elements | HTML and CSS text |
| Layout | "Only flexbox and a subset of CSS properties are supported. Advanced layouts (e.g. `display: grid`) will not work." | Block, flexbox and grid, with stylesheets |
| Output | PNG | PNG, JPEG, WebP |
| Size of the image route | "Maximum bundle size of `500KB`", fonts and images included | Not applicable; see [Limits](/docs/limits) |
| Sites that are not Next.js apps | `next/og` is part of Next.js | The same template serves any site |

The two quotations are from the Next.js documentation for `ImageResponse`. [[[site.name]] vs @vercel/og](/compare/vercel-og) has the longer comparison.

To use [[site.name]] from the App Router, sign in `generateMetadata`. It runs on the server; the secret stays there as long as its name does not start with `NEXT_PUBLIC_`. Tested with Next.js 16.4.6.

Copy `card-url.mjs` to `lib/` and add this to the page:

```js
// app/posts/[slug]/page.js
import { signedCardUrl } from '../../../lib/card-url.mjs';
import { getPost } from '../../../lib/posts';

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const post = await getPost(slug);
  const image = signedCardUrl({
    secret: process.env.LTC_SITE_SECRET,
    baseUrl: '[[site.url]]',
    siteId: process.env.LTC_SITE_ID,
    template: 'blog',
    params: { title: post.title, author: post.author },
  });
  return {
    title: post.title,
    openGraph: { images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', images: [image] },
  };
}
```

`getPost()` stands for however your app loads a post. Next.js prints `og:image`, `og:image:width`, `og:image:height`, `twitter:card` and `twitter:image` from this object.

## Any other stack

Whatever renders your HTML on a server can sign: take the PHP, Python or Node.js function from [Signed URLs](/docs/signed-urls#signer-code), or write the 20 lines in your language and check them against the [worked example](/docs/signed-urls#a-worked-example).
