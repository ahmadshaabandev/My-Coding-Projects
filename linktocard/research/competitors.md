# Competitor research for honest comparison pages: Bannerbear and @vercel/og

Researched 2026-11-21. Scope: (A) Bannerbear, (B) `@vercel/og` / `next/og` / `ImageResponse` (Satori + resvg).
Our product for reference (as given in the brief, not re-verified here): "Link To Card" = signed og:image URLs + REST endpoint, renders HTML/CSS via Satori (not a browser) or 5 starter templates to PNG/JPEG/WebP; no visual editor, no screenshots, no video/GIF, no AI generation; Free 100 images/mo, $9 and $29 plans.

## 0. Read this first: how far each fact can be trusted

The container could not open either vendor's website. `WebFetch` returned `getaddrinfo ENOTFOUND` for both `www.bannerbear.com` and `vercel.com` (two hosts, same failure, so I stopped trying sites). Those hosts have to be allowed in the session's network settings before anyone can read the vendor pages directly. What I could read directly: npm tarballs and `raw.githubusercontent.com` files, plus `git ls-remote` on github.com.

Every fact below carries one of these tags:

| Tag | Meaning | Use on a public page? |
| --- | --- | --- |
| **[P]** | Primary. A vendor-authored file I read myself today (npm tarball content, GitHub raw file, or a command I ran). | Yes, with the cited source. |
| **[S]** | Secondary. The WebSearch tool's summary of a page on the vendor's own domain. I did not see the page. | Only after someone opens the cited URL and confirms the wording. |
| **[J]** | My judgement or positioning, derived from the facts. Not a vendor statement. | As opinion, worded as ours. |

Quoted phrases under an [S] tag are the wording the search tool relayed. They have not been compared with the live page, so treat them as paraphrase until checked.

Consequence: the @vercel/og / Satori / Next.js section is almost entirely [P]. The Bannerbear API section is [P] (the vendor's SDK, MCP server and OpenAPI spec are on npm/GitHub). The Bannerbear marketing-side facts (visual editor, integrations list, free trial, plan gating) are [S] only.

### Sources actually read (primary)

| ID | What | Where | Version / pin |
| --- | --- | --- | --- |
| BB-SDK | Bannerbear official Node library: `README.md`, `src/v5.ts`, `src/bannerbear.ts`, `package.json` | `https://registry.npmjs.org/bannerbear/-/bannerbear-2.0.0.tgz` (author "Jon Yongfook <support@bannerbear.com>", MIT). README is byte-identical to `https://raw.githubusercontent.com/yongfook/bannerbear-node/master/README.md` | 2.0.0, npm modified 2026-08-17; repo HEAD `e567d04da3a7316349293867aa1cb879b3da7f30`; tgz sha256 `ce0568f7…342b4f` |
| BB-MCP | Bannerbear MCP server `README.md` | `https://registry.npmjs.org/@bannerbear/mcp/-/mcp-0.14.0.tgz` (maintainer `yongfook`, MIT) | 0.14.0, npm modified 2026-10-07 |
| BB-SPEC | Bannerbear V5 OpenAPI 3.1 spec (title "Bannerbear V5 API", version "5.0") | `https://raw.githubusercontent.com/yongfook/bannerbear-mcp/main/spec/openapi.json` | repo HEAD `b62c475af9c92bd71e45010a57670a7831f3b9fd`; file sha256 `5b32bace…a668ce`; 49 paths |
| BB-RUBY / BB-PHP | Ruby and PHP library READMEs (same V5 sections as BB-SDK) | `https://raw.githubusercontent.com/yongfook/bannerbear-ruby/master/README.md`, `https://raw.githubusercontent.com/yongfook/bannerbear-php/master/README.md` | fetched 2026-11-21 |
| OG-PKG | `@vercel/og`: `README.md`, `package.json`, `LICENSE`, `dist/types.d.ts`, `dist/index.node.d.ts`, `dist/index.edge.d.ts`, `dist/index.node.js`, `dist/index.edge.js`, source map | `https://registry.npmjs.org/@vercel/og/-/og-1.0.3.tgz` | 1.0.3, published 2026-09-22; tgz sha256 `2f82b56a…999fd3` |
| SAT-LATEST | Satori `README.md`, `package.json`, `LICENSE` | `https://registry.npmjs.org/satori/-/satori-0.63.2.tgz`; README byte-identical to `https://raw.githubusercontent.com/vercel/satori/main/README.md` | 0.63.2, published 2026-10-20; repo HEAD `074f0b38ed0f5d8fa768f709c0bb072b2d6c99e1` |
| SAT-PINNED | Satori `README.md`, `package.json` at the version `@vercel/og@1.0.3` depends on | `npm pack satori@0.33.5` | 0.33.5 |
| NEXT-PKG | Next.js package: `dist/compiled/@vercel/og/*` and the docs shipped inside the package under `dist/docs/` | `https://registry.npmjs.org/next/-/next-16.4.6.tgz` (latest dist-tag today, MIT) | 16.4.6; tgz sha256 `954cc114…da2806a` |
| NEXT-DOCS | Next.js docs, canary branch | `https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/04-functions/image-response.mdx`, `…/03-file-conventions/01-metadata/opengraph-image.mdx`, `…/03-file-conventions/02-route-segment-config/runtime.mdx`, `…/02-guides/static-exports.mdx`, `…/01-getting-started/14-metadata-and-og-images.mdx` | fetched 2026-11-21 |
| CF-DOC | Cloudflare docs page for the `@vercel/og` Pages Plugin | `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/pages/functions/plugins/vercel-og.mdx` | fetched 2026-11-21 |

---

## 1. Findings that change how we build or write

1. **Signed URLs are not a differentiator against Bannerbear.** Bannerbear V5 has "Instant URLs": template-bound URLs, `security: "signed" | "open"`, HMAC-SHA256 signature appended as `&s=`, two encodings (`encoded` base64url JSON, or `named_params`), per-IP rate limiting, `max_renders`, `expires_at`, template-version pinning, scale 1-4. [P: BB-SDK README "Instant URLs (V5)" and `src/v5.ts` `build_instant_url`; BB-SPEC `POST /instant_urls`.] The honest difference is what the URL renders (a designed layer template there, your HTML/CSS here), not that the URL is signed.
2. **WebP is not a differentiator against Bannerbear either.** V5 image `formats` enum is `jpg` (default), `png`, `pdf`, `webp`, `avif`. [P: BB-SPEC `ImageCreateRequest.formats`; BB-SDK `src/v5.ts`.]
3. **PNG-only is a real, verifiable limit of `@vercel/og`.** `ImageResponse` hard-codes `"content-type": "image/png"` and the render function only produces PNG (resvg `asPng()` or `sharp(...).png()`). [P: OG-PKG `dist/index.node.js`, `render()` and `ImageResponse` class.] Our JPEG/WebP output is a fair point of difference.
4. **"Satori = flexbox only" is now version-dependent.** Satori 0.63.2's README says it "uses Taffy to lay out Flexbox, Grid and block layouts", supports `<style>` stylesheets and "four font formats: TTF, OTF, WOFF and WOFF2". But `@vercel/og@1.0.3` pins `satori` 0.33.5 (Yoga; "TTF, OTF and WOFF… WOFF2 is not supported"), and Next.js's own docs for `next/og` say "Only flexbox… `display: grid` will not work". [P: SAT-LATEST, SAT-PINNED, OG-PKG `package.json`, NEXT-PKG docs.] Our pages must name versions and dates, and our own "flexbox subset" wording should be checked against the Satori version we actually ship (the sibling report `research/spike-render.md` in this scratchpad records 0.63.2).
5. **Do not write "@vercel/og needs Vercel Edge Functions".** The package README says it "supports both Node.js Runtime and Edge Runtime". Next.js 16.4.6's shipped docs list `'edge'` as "(deprecated)" for the route `runtime` option and say "The Edge Runtime is deprecated. Remove the `runtime` export". `opengraph-image` files are "statically optimized (generated at build time and cached)" by default. [P: OG-PKG README; NEXT-PKG `dist/docs/…/runtime.md`; NEXT-DOCS `opengraph-image.mdx`.]
6. **"No third-party dependency" needs a qualifier.** At render time `@vercel/og` fetches emoji SVGs from `cdn.jsdelivr.net` (twemoji, openmoji, blobmoji, noto, fluent, fluentFlat) and missing-glyph fallback fonts from `fonts.googleapis.com`. [P: OG-PKG `dist/index.node.js` lines 23360-23365 and `loadGoogleFont`.] True statement: no third-party rendering service and no API key.
7. **Licence is MPL-2.0, not MIT**, for `@vercel/og`, Satori and `@resvg/resvg-wasm`; Next.js itself is MIT. [P: `LICENSE` files and `package.json` in OG-PKG, SAT-LATEST, NEXT-PKG; `npm view @resvg/resvg-wasm license`.]
8. **No competitor price is recorded in this file.** The pricing pages could not be fetched. Search summaries surfaced Bannerbear plan numbers from the vendor's own blog posts; I deliberately left them out.

---

## A. Bannerbear

### A.1 What it is

- "A Node.js wrapper for the Bannerbear API - an image and video generation service." [P: BB-SDK README line 3.]
- Hosted HTTP API. V5 hosts: `https://api.bannerbear.com/v5` ("Async render host. All endpoints.") and `https://sync.api.bannerbear.com/v5` ("Synchronous render host. Only accepts POST /images"). Bearer API key, e.g. `bb_ak_v5_…`. [P: BB-SPEC `servers`, `securitySchemes`.]
- Two API generations coexist: "V5 API keys do not work with V2 endpoints, and V2 API keys do not work with V5 endpoints". The SDK calls V2 "the legacy V2 API". [P: BB-SDK README.]
- Homepage title "API for Automated Image and Video Generation - Bannerbear", headline "Automate & Scale Your Marketing". [S: search result title and summary for `https://www.bannerbear.com/`.]

### A.2 Core features (V5 unless marked)

| Feature | Detail | Source |
| --- | --- | --- |
| Template-based image rendering | `POST /images` with a `template` UID and `modifications` (`template` overrides + per-layer `objects`). | [P] BB-SPEC `ImageCreateRequest`; BB-SDK README "Images (V5)" |
| Image output formats | `jpg` (default), `png`, `pdf`, `webp`, `avif`; `scale` 1-4; `dpi`; `quality`; transparent background. | [P] BB-SPEC |
| Template model | Templates are a canvas of typed layers positioned with `left/top/width/height`. 14 layer types: `text`, `rectangle`, `rectangle_image_container`, `circle`, `circle_image_container`, `image`, `svg_shape`, `qr_code`, `bar_code`, `rating`, `lottie`, `animated_background`, `audio_wave`, `group`. | [P] BB-MCP README "Two layer shapes"; BB-SPEC `Layer*` schemas |
| Templates via API | "Templates can be created, updated, and deleted through the API — `config` holds the full canvas." Canvas 100-5000 px. | [P] BB-SDK README; BB-SPEC `POST /image_templates` |
| No HTML/CSS input | The V5 spec contains zero occurrences of "html"; `ImageCreateRequest` requires `template`. Some attributes take CSS-format strings (`box-shadow`, `background-gradient`). | [P] BB-SPEC (grep) |
| Text fitting | `text-fit`: `off`, `auto_fit`, `resize_overflow`; `text-ellipsis`. | [P] BB-SPEC |
| Fonts | `font-family`: "Font family name (Google Fonts or custom font)". Text `direction`: `ltr` / `rtl`. | [P] BB-SPEC |
| Responsive templates | Layer attributes `responsive-position`, `responsive-size`, `responsive-aspect-ratio`, `responsive-anchor-gap`; request-time `width`/`height` overrides. | [P] BB-SPEC |
| AI inside a render | `ai-detect`: `off`/`face`/`subject` ("AI detection mode for automatic image positioning"); `ai-background-remove`; `ai-background-generate` with `ai-prompt` and `ai-model`. | [P] BB-SPEC |
| Batches | "Generate multiple images in one request (up to 100)." | [P] BB-SDK README; BB-SPEC `POST /batches` |
| Animations (video) | Animation templates with `frame_rate` 24/30/60 and keyframes; output `mp4` or `mov` (transparent forces MOV). "Rendering an animation is **always asynchronous**". | [P] BB-SDK README; BB-SPEC `POST /animations` |
| Media tools | Async "tool jobs": `remove_bg`, `create_pdf`, `flatten_pdf`, `pdf_to_image`, `trim_video`, `concat_videos`, `resize_video`, `crop_video`, `overlay_video`, `overlay_image`, `subtitle_video`, `generate_voiceover`, `add_audio`, `add_cover_art`, `create_video_slideshow`, `apply_color_filter`, `soften_video`, `create_gif_preview`, `video_thumbnails`, `generate_ai_image`, `generate_ai_video`. | [P] BB-SPEC `/tools/*`; BB-SDK README table |
| GIF | V5: `create_gif_preview` ("Turn a video into an animated GIF preview"). V2: "Animated Gifs — Create a slideshow style gif". | [P] BB-SPEC; BB-SDK README (V2 section) |
| Workflows | "Workflows chain several steps into one named, re-runnable operation." Runs are async. | [P] BB-SDK README; BB-SPEC `/workflows`, `/workflow_runs` |
| Assets | Upload a file (max 5MB), get "a durable CDN URL"; SHA-256 dedupe. | [P] BB-SPEC `POST /assets` |
| Public template library | "Publications are templates published to the public library. Installing one clones it into your workspace". | [P] BB-SDK README |
| Screenshots (V2) | "Take screenshots of websites." Not present in the V5 spec. | [P] BB-SDK README (V2 section); BB-SPEC (absent) |
| Collections / template sets (V2) | "Create multiple images in one API request" from a template set. | [P] BB-SDK README (V2 section) |
| Movies (V2) | "Assemble video clips or still images into a single movie with transitions." | [P] BB-SDK README (V2 section) |
| MCP server | `@bannerbear/mcp`: "Lets Claude and other MCP clients generate images, and design and edit templates"; OAuth discovery at `mcp.bannerbear.com`. | [P] BB-MCP README |
| Scoped keys, template locks | Tools narrow to the key's scopes; `api_write_access`: `team` / `owner_only` / `nobody`. | [P] BB-MCP README |
| Visual template editor | "Sketch-like interface with drag and drop, layer re-ordering, full typographic controls". | [S] `https://www.bannerbear.com/product/template-editor/` |

### A.3 Rendering approach

Not stated in anything I could read. The data model is a positioned-layer canvas, not HTML. Whether the renderer is a headless browser or a custom engine is **unverified**. Do not describe it on our pages.

### A.4 Signed / "simple" / on-demand URLs

- **V5 "Instant URLs"** — "URLs bound to a template that can be manipulated with query strings — the V5 equivalent of V2's 'Signed URLs' feature." Options: `mode` `encoded` | `named_params`; `security` `signed` | `open`; `status`; `scale` 1-4; `rate_limit` ("enable per-IP rate limiting"); `template_version`; `max_renders`; `expires_at`. `signing_key` "is ONLY returned in the create response". The SDK helper signs with `crypto.createHmac("sha256", signingKey).update(url).digest("hex")` and appends `&s=`. [P: BB-SDK README and `src/v5.ts` lines 803-840; BB-SPEC `POST /instant_urls`.]
- **V2 "Signed URLs"** — `https://ondemand.bannerbear.com/signedurl/{base}/image.jpg?modifications=<base64url JSON>&s=<HMAC-SHA256 hex>`, with a second host `cdn.bannerbear.com` selected by the SDK's `synchronous` flag. In V2 the HMAC key is the API key. [P: BB-SDK `src/bannerbear.ts` lines 377-381.]
- **V2 "Simple URLs"** — unsigned, modifications in the query string as layer/attribute/value. [S: `https://www.bannerbear.com/help/articles/285-what-are-simple-urls/`.]
- "After the first request, the generated image is served by CDN." [S: `https://www.bannerbear.com/blog/a-basic-guide-to-simple-and-signed-urls-for-image-generation/`.]
- Plan gating of Instant URLs: a search summary of the vendor's own comparison posts says they are on higher plans only. [S, unconfirmed.] Do not state it; say "check which plan includes Instant URLs on the vendor's pricing page".

### A.5 API style

- Async by default: `POST /images` on `api.bannerbear.com` "returns 202 + pending record, poll via GET /images/{uid} or subscribe via webhook". [P: BB-SPEC.]
- Sync: same call on `sync.api.bannerbear.com` "returns 200 + completed image inline, or 408 if the render exceeds the sync timeout". SDK README: "(10s timeout)"; MCP README: "a 10-second ceiling". [P.]
- Animations, tool jobs, workflow runs and batches are async only. [P: BB-SDK README; BB-SPEC.]
- Webhooks are "a first-class resource in V5": `resource` `image` | `batch` | `tool_job` | `animation` | `workflow_run`; `event` `all_events` | `completed` | `failed`; HMAC `signing_key` returned once. [P: BB-SDK README; BB-SPEC `POST /webhooks`.]
- Quota errors: `402` "API quota exhausted — upgrade required"; "Trial cap hit — upgrade required"; "Trial accounts are limited to 20 uploaded assets". [P: BB-SPEC.]
- Rate limit: sources conflict. BB-MCP README says "30 requests / 10s and applies to `POST` only"; a search summary of `https://developers.bannerbear.com/v5/` says 60 POST requests per 10 seconds. Do not publish a number.
- Official libraries: Node (`bannerbear` on npm, "Node 14 or higher"), Ruby gem, PHP (`composer require yongfook/bannerbear`). All MIT. [P.]

### A.6 Integrations

All [S] — from search summaries of `https://www.bannerbear.com/v5/products/integrations/` and the vendor's comparison posts. Re-read before publishing.

- Zapier ("Official Zapier Partner"; "integrates with 9,000+ other apps on Zapier").
- Make (listed as "Integromat").
- Airtable (pull rows, optionally write image URLs back).
- WordPress (reads posts/pages/categories/tags/users via the REST API).
- n8n (built-in node).
- Direct integrations described as "50+" in one place and "around sixty services including Notion, Airtable, Shopify, HubSpot, GitHub, Stripe and Webflow" in another.
- Bring-your-own S3 / R2 bucket (plan tier conflicts between the help article and a comparison post).

Corroboration that is primary but third-party-authored: npm lists community connectors `@pipedream/bannerbear` and `@activepieces/piece-bannerbear` [P: `npm search bannerbear`, 2026-11-21]. That proves those connectors exist, nothing more.

### A.7 Hosting model and licence

- Hosted service only, as far as any source shows. A search for self-hosted / on-premise on the vendor's domain found nothing. [S, absence of evidence.]
- Client libraries and the MCP server are MIT. [P.] The service itself is governed by `https://www.bannerbear.com/terms/` [S: URL from search results, not read].

### A.8 Pricing (no numbers recorded)

- Pricing page URL: `https://www.bannerbear.com/pricing/` (a second listing `https://www.bannerbear.com/v5/pricing/` also appears). [S: both are search-result URLs titled "Pricing - Bannerbear"; neither was fetched.]
- Free trial: advertised. Search summaries of the homepage, pricing page and sign-up page all report "Free trial, no credit card required". [S.] The spec independently confirms trial accounts exist ("Trial cap hit", "Trial accounts are limited to 20 uploaded assets"). [P: BB-SPEC.]
- It is described as a one-time trial, not a recurring free tier. [S.] Confirm before writing "no free plan".
- Billing unit is "credits", with a separate "AI credits" balance. [S.] The spec's `402 API quota exhausted` is consistent. [P.]
- Page wording to use: "Bannerbear offers a free trial; see bannerbear.com/pricing for current plans."

### A.9 Where Bannerbear is clearly better than Link To Card

Be generous here. Everything in this list is [P] unless marked.

1. **Visual template editor** for non-developers [S], plus templates as JSON through the API [P]. We have neither.
2. **Video**: animation templates with keyframes to MP4/MOV, and a full set of video tools (trim, crop, resize, join, overlay, subtitles, voiceover, slideshow, cover art).
3. **GIF** previews, and V2 animated GIFs.
4. **PDF** output, multi-page PDF assembly, print flattening, PDF-to-image.
5. **AVIF** output, 1-4x scale, DPI metadata, transparent backgrounds.
6. **Batch** rendering (100 images per request) and V2 collections across a template set.
7. **Responsive templates**: one design, several sizes.
8. **Text auto-fit** as a named layer attribute.
9. **AI**: face/subject detection for cropping, background removal, prompt-generated backgrounds, AI image and video tools.
10. **Richer layer types**: QR codes, barcodes, star ratings, Lottie, audio waveforms.
11. **Google Fonts or custom fonts by name**, and RTL text direction as an attribute.
12. **Async + webhooks** with signed deliveries, for long jobs.
13. **Workflows** that chain steps.
14. **Many no-code integrations** (Zapier, Make, Airtable, WordPress, n8n and more) [S].
15. **Instant URL controls** we should compare ourselves against honestly: per-IP rate limiting, render caps, expiry, version pinning, open or signed.
16. **MCP server and official SDKs** in Node, Ruby and PHP.
17. **Website screenshots** (V2 API).
18. Asset storage with CDN URLs; bring-your-own bucket [S].

### A.10 Where a narrow signed-URL service is a reasonable fit instead [J]

State these as our view, not as defects of Bannerbear.

- You already write HTML/CSS and want the card to live in your codebase as markup, under version control, rather than as a design in someone else's editor. Bannerbear's V5 input is a layer template, not HTML. [fact part is P]
- You only need static social cards. You will not use video, PDF, AI or workflows, and would rather not learn or pay for a wider product. (Make no price comparison; link to their pricing page.)
- You want one concept to learn: a URL that returns an image.
- You want a small recurring free allowance for a personal site. Only say this once someone has confirmed on the pricing page that Bannerbear's free offer is a one-time trial. [S today]

Where we should say "choose Bannerbear": marketers who want to design visually, anyone needing video/GIF/PDF, bulk catalogue or e-commerce imagery, no-code automation, AI cropping or generation.

---

## B. @vercel/og (`next/og`, `ImageResponse`; Satori + resvg)

### B.1 What it is

- npm description: "Generate Open Graph Images dynamically from HTML/CSS without a browser". README: "Generate Open Graph images with Vercel's API route functions". [P: OG-PKG.]
- A library you run in your own app, not a hosted service. It exports an `ImageResponse` class that `extends Response`, and `unstable_createNodejsStream` for Node. [P: OG-PKG `dist/index.node.d.ts`.]
- Pipeline: React element -> Satori -> SVG -> PNG via `@resvg/resvg-wasm`, or via `sharp` when the optional dependency is installed (Node build only). [P: OG-PKG `dist/index.node.js` `render()`; `package.json` `optionalDependencies.sharp`.]
- Next.js: "`ImageResponse` uses @vercel/og, Satori, and Resvg to convert HTML and CSS into PNG." Import from `next/og` ("`v14.0.0` — `ImageResponse` moved from `next/server` to `next/og`"). [P: NEXT-PKG `dist/docs/01-app/03-api-reference/04-functions/image-response.md`.]
- Next.js ships its own compiled copy: `next/dist/compiled/@vercel/og/` with `package.json` version `1.0.1`, licence MPL-2.0, `yoga.wasm`, `resvg.wasm`, `Geist-Regular.ttf`. [P: NEXT-PKG.]
- Satori: "Enlightened library to convert HTML and CSS to SVG." Author Shu Ding; "Made by Vercel". [P: SAT-LATEST README.]

### B.2 Version matrix (all from the registry today)

| Package | Version | Date | Depends on | Layout engine |
| --- | --- | --- | --- | --- |
| `@vercel/og` (latest) | 1.0.3 | 2026-09-22 | `satori` 0.33.5, `@resvg/resvg-wasm` 2.4.1 | Yoga (`yoga.wasm` in dist) |
| `@vercel/og` inside `next@16.4.6` | 1.0.1 (compiled copy) | — | npm metadata for `@vercel/og@1.0.1`: `satori` 0.29.0, `@resvg/resvg-wasm` 2.4.1 | Yoga (`yoga.wasm` in the folder) |
| `satori` (latest) | 0.63.2 | 2026-10-20 | `harfbuzzjs` 0.10.0, `@shuding/opentype.js`, others; ships `layout.wasm` | Taffy |
| `next` (latest) | 16.4.6 | — | — | — |

Satori has 218 published versions; 0.40.0 to 0.63.2 all landed between 2026-10-08 and 2026-10-20. [P: `npm view satori time`.] `@vercel/og` has not picked those up. Expect this table to go stale quickly; re-run `npm view @vercel/og version dependencies` before each page update.

### B.3 Template authoring model

- JSX / React elements: `new ImageResponse(element: ReactElement, options)`. [P: OG-PKG types.]
- No HTML-string input. Satori accepts JSX or "React-elements-like objects that have `type`, `props.children` and `props.style`". [P: SAT-LATEST README "Use without JSX".]
- "Satori only accepts JSX elements that are pure and stateless… React APIs such as `useState` and `useEffect` are not supported". [P.]
- Experimental Tailwind via a `tw` prop: "This feature is currently experimental." [P: OG-PKG `dist/types.d.ts`.]
- No visual editor. A playground exists at `https://og-playground.vercel.app/` (linked from the READMEs; not opened).

### B.4 Options, output and caching

- Options: `width` (default 1200), `height` (default 630), `emoji` (`twemoji` default, `blobmoji`, `noto`, `openmoji`, `fluent`, `fluentFlat`), `fonts[]`, `debug`, plus `status`, `statusText`, `headers`. [P: OG-PKG README and `types.d.ts`.]
- **Output: PNG only.** No JPEG, WebP, GIF, video or PDF path in the code. [P: OG-PKG bundle.]
- Default headers in production: `content-type: image/png` and `cache-control: public, immutable, no-transform, max-age=31536000`; in development `no-cache, no-store`. [P: OG-PKG README and bundle.]
- No signing, no API key, no quota or metering option exists in `ImageOptions`. [P: `types.d.ts`.] The README lists an "Encrypted Token" example, i.e. protecting parameters is left to you. [P: OG-PKG README "Examples".]
- Default font: README and type comment say Noto Sans; the 1.0.3 package ships `Geist-Regular.ttf` and registers it as `geist`. The docs and the code disagree, so do not name the default font. [P.]

### B.5 CSS / HTML subset

What `next/og` and `@vercel/og@1.0.3` support (Yoga-era Satori):

- "Only flexbox and a subset of CSS properties are supported. Advanced layouts (e.g. `display: grid`) will not work." [P: NEXT-PKG docs.]
- `display`: "`flex`, `block`, `contents`, `none`, `-webkit-box`, default to `flex`". [P: SAT-PINNED README.]
- "Three-dimensional transforms are not supported." "There is no `z-index` support in SVG." "`calc` isn't supported." "you can't use `<style>` tags or external resources via `<link>` or `<script>`." [P: SAT-PINNED README.]
- "Full Unicode bidirectional layout is not yet supported". [P: SAT-PINNED README.]
- "Satori does not guarantee that the SVG will 100% match the browser-rendered HTML output". [P: both Satori READMEs.] **This applies to Link To Card too**, since we also render with Satori.

What Satori 0.63.2 itself now documents (not what `next/og` ships today):

- "Satori uses Taffy to lay out Flexbox, Grid and block layouts, and its own inline layout for text and inline elements. It's **not** a complete CSS implementation". `zIndex` "Supported". `<style>` stylesheets with selectors, `@media`, `::before`/`::after`. Unsupported examples: `display: table`, `ruby`; "`columns`, `writingMode` and `fontStretch`" are ignored. [P: SAT-LATEST README.]

### B.6 Fonts

- `next/og`: "Only `ttf`, `otf`, and `woff` font formats are supported. To maximize the font parsing speed, `ttf` or `otf` are preferred over `woff`." [P: NEXT-PKG docs.]
- Satori 0.33.5: "three font formats: TTF, OTF and WOFF. Note that WOFF2 is not supported at the moment." Satori 0.63.2: "four font formats: TTF, OTF, WOFF and WOFF2. Variable fonts are rendered as their default instance". [P.]
- You supply font files yourself: "You must specify the font if any text is rendered with Satori". [P: Satori README.] `@vercel/og` adds one bundled default font and a Google Fonts fallback for missing glyphs. [P: OG-PKG bundle.]

### B.7 Runtime requirements and platform limits

- `@vercel/og@1.0.3`: `"engines": { "node": ">=22" }`. Satori: Node >= 16, browsers, Web Workers. [P: `package.json` files; Satori README "Runtime Support".]
- Export conditions in `@vercel/og`: `edge`, `edge-light`, `browser`, `worker`, `workerd` map to `index.edge.js`; `import`/`node`/default map to `index.node.js`. The edge build uses `import … from "./resvg.wasm?module"`, which needs a bundler that understands that import. [P: OG-PKG `package.json`, `dist/index.edge.js`.]
- "Maximum bundle size of `500KB`. The bundle size includes your JSX, CSS, fonts, images, and any other assets." [P: NEXT-PKG docs.]
- Next.js: Node.js runtime is the default; `'edge'` is deprecated for route segments. [P: NEXT-PKG `dist/docs/…/runtime.md`.]
- `opengraph-image.tsx` / `twitter-image.tsx` file conventions: generated images are statically optimized at build time by default, and become request-time when they use request-time APIs or uncached data. [P: NEXT-DOCS.]
- Vercel docs runtime table: Pages Router + Node.js runtime does not support `return new Response(…)` with `@vercel/og`; other combinations are supported. Recommended OG size 1200x630. [S: `https://vercel.com/docs/og-image-generation`.]
- Outside Vercel: Cloudflare publishes `@cloudflare/pages-plugin-vercel-og` ("powered by `@vercel/og`"). [P: CF-DOC.] Its npm metadata (0.1.2) lists `@vercel/og` 0.4.1 as a dev dependency, so it tracks an old release. [P: `npm view`.] Whether `@vercel/og@1.0.3` runs unmodified on Workers, Netlify, Deno or Bun is **unverified**.

### B.8 Hosting model, licence, cost

- Self-hosted library. It runs wherever your function runs. [P.]
- Licence: MPL-2.0 for `@vercel/og` and Satori; MIT for Next.js. [P.]
- Source availability: Satori's repo is public (`github.com/vercel/satori`). `@vercel/og`'s `package.json` points at `github.com/vercel/og`, which is not publicly readable today (raw README 404; `git ls-remote` asks for credentials). The npm tarball does include source maps with full `sourcesContent`. [P: commands run 2026-11-21.] So "MPL-2.0 licensed and free" is safe; "developed in the open on GitHub" is true for Satori, not demonstrated for `@vercel/og` itself.
- Price: the library has no fee. You pay for whatever compute hosts it. Vercel's function pricing page was not fetched; record nothing. Pricing URL (presumed, not opened): `https://vercel.com/pricing`.
- Free tier: not applicable to the library. Vercel's own plan tiers are unverified here.

### B.9 Where @vercel/og is clearly better than Link To Card

1. **Free and MPL-2.0 licensed.** No subscription, no API key. [P]
2. **No per-image quota from a vendor.** Volume is bounded only by your own hosting. [P for the library; J for the consequence]
3. **Runs inside your own app.** No extra network hop to a third-party renderer, no third-party outage in your og:image path, and page data is not sent to another company's rendering API. Qualifier: emoji and fallback fonts are fetched from jsDelivr and Google Fonts. [P]
4. **First-class Next.js integration.** `opengraph-image.tsx` wires the meta tags for you, images can be generated at build time, and nothing needs installing in the App Router (Next bundles it). [P]
5. **JSX authoring with your own components, data fetching and auth**, type-checked in your repo, plus an experimental Tailwind `tw` prop. [P]
6. **No signed URL needed in the common case.** A file-convention image is keyed by route, not by user-supplied parameters, so there is nothing for an attacker to tamper with. [J, from P facts]
7. **Emoji in six styles and automatic fallback fonts for other scripts**, built in. [P]
8. **Long-lived immutable cache headers by default.** [P]
9. **You control the upgrade schedule**, and can call Satori directly for SVG output or newer features. [J]

Honest summary line for the page: "If your site is a Next.js app, `next/og` is the default choice and it is free. Use it."

### B.10 Where a narrow hosted signed-URL service is a reasonable fit instead

| Situation | Why | Basis |
| --- | --- | --- |
| Static site generators (Hugo, Jekyll, Eleventy), WordPress, Ghost, Shopify themes, Webflow, plain HTML | `ImageResponse` needs a JavaScript server or build step that renders React elements. These stacks have neither at request time; an `<meta property="og:image">` pointing at a URL works anywhere. | [J] from [P] (API takes `ReactElement`) |
| Back ends in Rails, Django, Laravel, Go, .NET | Same reason. A REST call or a signed URL is language-neutral. | [J] |
| You want to send HTML and CSS as strings | Satori and `@vercel/og` take JSX / element objects, not HTML text. | [P] |
| You need JPEG or WebP | `@vercel/og` returns PNG only. | [P] |
| Fonts and images push past 500KB | Next.js documents a 500KB bundle ceiling that includes fonts and images. | [P] |
| User-supplied parameters in the image URL | With `@vercel/og` you build signing or encryption yourself (the README offers an example). A service with signing built in removes that work. | [P] + [J] |
| You do not want to own font files, wasm, cold starts and Satori upgrades | Operational preference. | [J] |
| CSS Grid, `<style>` sheets, WOFF2 | Only if Link To Card really ships a Taffy-era Satori. Today `next/og` documents flexbox-only and no WOFF2. This gap closes the day `@vercel/og` bumps Satori, so date the claim. | [P] for their side; our side must be confirmed by the build |

Shared limitation to state plainly: both products render with Satori, not a browser. Neither will match Chrome pixel for pixel, and neither runs JavaScript or loads external stylesheets.

---

## C. Side-by-side (draft table for the pages; keep the caveats)

| | Link To Card (per brief) | Bannerbear | @vercel/og / next/og |
| --- | --- | --- | --- |
| Kind | Hosted API + signed URLs | Hosted API + editor + automations | Library in your own app |
| Template input | HTML/CSS, or 5 starter templates | Layer templates (visual editor [S]; JSON via API [P]) | JSX / React elements [P] |
| Renderer | Satori (not a browser) | Not disclosed (unverified) | Satori + resvg [P] |
| Image formats | PNG, JPEG, WebP | JPG, PNG, PDF, WebP, AVIF [P] | PNG [P] |
| Video / GIF / PDF | No | Yes [P] | No [P] |
| Signed URLs | Yes | Yes, "Instant URLs" (plan availability: check their pricing page) [P] | Not built in; do it yourself [P] |
| Sync / async | Image URL and REST endpoint (per brief; webhook support not stated) | Both; webhooks [P] | Synchronous response from your function [P] |
| No-code integrations | No | Zapier, Make, Airtable, WordPress, n8n and more [S] | No |
| AI features | No | Yes [P] | No |
| Self-hostable | No | No evidence of it [S] | Yes, that is the only mode [P] |
| Licence | Proprietary service | Proprietary service; MIT SDKs [P] | MPL-2.0 [P] |
| Free option | Free plan, 100 images/mo | Free trial advertised [S] | Library is free [P] |
| Pricing | $9 and $29 plans | See `https://www.bannerbear.com/pricing/` | No library fee; hosting costs are yours |

---

## D. Trademark and naming cautions

General practice, not legal advice. Have a lawyer review before the pages go live if there is any doubt.

1. **Use names nominatively, in plain text.** Name the product only as far as needed to identify it. No logos, wordmarks, bear mascots, triangle marks, brand colours or screenshots of their UI.
2. **Spell them the vendor's way.** "Bannerbear" (one word, capital B only) [P: BB-SDK README]. "Vercel", "Next.js", "Satori", and the package names `@vercel/og` and `next/og` in code formatting [P: READMEs]. Vercel's guidelines reportedly prefer "Next.js" on first mention [S].
3. **Do not put their names in our product name, domain, subdomain or social handle.** Vercel's brand guidelines reportedly prohibit using its marks in business, product or domain names, using confusingly similar marks, and implying sponsorship or endorsement. [S: `https://vercel.com/geist/brands`.] A URL path such as `/compare/bannerbear` or `/vs/vercel-og` is ordinary nominative use; a domain like `vercel-og-alternative.com` is not.
4. **No implied affiliation.** Avoid "official", "certified", "partner", "powered by Vercel". Saying "Link To Card renders with Satori, an open-source library by Vercel" is a factual statement of a dependency; keep it to that. Vercel's guidelines reportedly say an open-source licence does not license the trademark, and that uses beyond truthful description (including by software that uses Vercel's open-source code) need prior written permission. [S.] Read that page in full before publishing, because the search summary suggests its permitted-use list is narrow.
5. **Add an attribution line** in the page footer, for example: "Bannerbear is a trademark of its owner. Vercel and Next.js are trademarks of Vercel, Inc. Link To Card is not affiliated with, endorsed by or sponsored by either company." Vercel's guidelines reportedly require an attribution line for permitted uses. [S.]
6. **Keep our own brand more prominent than theirs** on the page (also reportedly a Vercel guideline [S]). Their name belongs in the H1 only as the comparison subject, e.g. "Link To Card vs Bannerbear".
7. **Every comparative claim must be true, specific, sourced and dated.** Put "Last checked: <date>" and a link to the vendor's own doc beside each row. Comparative advertising rules (US Lanham Act, EU/UK misleading and comparative advertising rules) turn on accuracy and on not denigrating the competitor.
8. **Never quote a competitor price.** Link to their pricing page.
9. **Do not copy their copy.** Short attributed quotations from docs are fine; do not lift marketing text, tables or template designs.
10. **Bannerbear**: I found no published brand or logo policy and no press kit. [S: search of bannerbear.com returned only `https://www.bannerbear.com/terms/`.] Absence of a policy is not permission; rules 1-9 still apply. Bannerbear publishes many "Bannerbear vs X" posts itself (search result titles, 2026), which shows the format is normal in this market but grants us nothing.
11. **MPL-2.0 housekeeping for our own product.** Because we ship Satori and resvg-wasm, MPL-2.0 file-level obligations apply to us regardless of the comparison pages. Flag for whoever owns licensing; outside this task's scope.

---

## E. Claims to avoid (each contradicts something verified above)

- "Bannerbear has no signed URLs" / "only we offer signed image URLs". False: Instant URLs.
- "Bannerbear can't output WebP". False for V5.
- "Bannerbear is browser-based / screenshot-based rendering". Unknown.
- "@vercel/og only works on Vercel" or "requires Edge Functions". Contradicted by its README, its export map and Cloudflare's plugin.
- "@vercel/og is MIT". It is MPL-2.0.
- "@vercel/og has zero external calls". It calls jsDelivr and Google Fonts for emoji and fallback glyphs.
- "Satori only supports flexbox" without a version. True for what `next/og` ships; false for Satori 0.63.2.
- "Unlike @vercel/og, we render real HTML/CSS". We use the same engine family; say "HTML/CSS subset".
- Any Bannerbear plan name, price, credit count or rate-limit number.

---

## F. Unverified

1. Everything tagged [S]: Bannerbear's visual editor description, integrations list and counts, free-trial terms, credit model, Simple URLs, bring-your-own bucket tiers, and CDN caching behaviour. Vendor pages were not fetched.
2. Bannerbear prices, plan names and trial allowance. Not recorded by design.
3. Which Bannerbear plans include Instant URLs.
4. Bannerbear's rendering engine.
5. Bannerbear's API rate limit (30 vs 60 POSTs per 10 s in two vendor sources).
6. Whether Bannerbear's V2 API (screenshots, collections, animated GIFs, movies, old Signed/Simple URLs) is open to new sign-ups, and whether any of it is scheduled for retirement. Search summaries also mention a "V3", inconsistently.
7. Whether Bannerbear offers self-hosting or custom delivery domains (none found).
8. Whether Bannerbear's free offer is strictly a one-time trial with no recurring free tier.
9. The Vercel docs page `https://vercel.com/docs/og-image-generation` and the API reference `https://vercel.com/docs/functions/og-image-generation/og-image-api`: runtime table, limits and "benefits" wording are [S] only.
10. Vercel's brand guidelines `https://vercel.com/geist/brands` and any Next.js logo policy linked from `https://nextjs.org/governance`: exact permitted and prohibited uses are [S] only.
11. Vercel pricing and what an OG image request costs there; the pricing URL itself was not opened.
12. Whether `@vercel/og@1.0.3` runs unmodified on Cloudflare Workers, Netlify, Deno Deploy, Bun or AWS Lambda. Only packaging evidence was inspected; nothing was executed.
13. The exact Satori version compiled into `next@16.4.6` (the folder is labelled `@vercel/og` 1.0.1 and contains `yoga.wasm`; 0.29.0 comes from npm metadata for that version, not from the compiled file).
14. Whether Next.js `output: 'export'` emits `opengraph-image` files as static PNGs. The static-export doc says GET Route Handlers render static responses at build, but does not mention metadata images.
15. Performance comparisons of any kind. Nothing was benchmarked against either competitor. Vercel's launch-post speed and cost claims are vendor claims seen only in a search summary.
16. Link To Card's own facts (plans, formats, Satori version, whether signed URLs are on the free plan). Taken from the brief and a sibling report, not checked here.

---

## G. Commands run (for reproduction)

```
npm view @vercel/og version license dist.tarball engines dependencies time --json
npm view satori version license engines dependencies time --json
npm view next@16.4.6 dist.tarball license ; npm view @resvg/resvg-wasm version license
npm view @vercel/og@1.0.1 dependencies license ; npm view @cloudflare/pages-plugin-vercel-og --json
npm pack @vercel/og ; npm pack satori ; npm pack satori@0.33.5 ; npm pack next@16.4.6
npm pack bannerbear ; npm pack @bannerbear/mcp ; npm search bannerbear --json
curl -sSL https://raw.githubusercontent.com/yongfook/bannerbear-mcp/main/spec/openapi.json
curl -sSL https://raw.githubusercontent.com/yongfook/bannerbear-node/master/README.md   (and -ruby, -php)
curl -sSL https://raw.githubusercontent.com/vercel/satori/main/README.md
curl -sSL https://raw.githubusercontent.com/vercel/next.js/canary/docs/01-app/03-api-reference/04-functions/image-response.mdx   (and the other Next docs listed in section 0)
curl -sSL https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/pages/functions/plugins/vercel-og.mdx
git ls-remote https://github.com/yongfook/bannerbear-mcp HEAD   (and bannerbear-node, vercel/satori, vercel/og)
```

Extracted copies are under `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/dl/` (`vercel-og/`, `satori-pkg/`, `satori-0335/`, `next-pkg/`, `bannerbear-npm/`, `bannerbear-mcp/`, `ghraw/`).

WebSearch queries were restricted to `bannerbear.com`, `developers.bannerbear.com`, `vercel.com` and `nextjs.org`. WebFetch failed for `www.bannerbear.com` and `vercel.com` with `ENOTFOUND`.
