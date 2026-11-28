# Link To Card

Turn every link into a beautiful share card: an API and a signed-URL service that renders
Open Graph images (PNG, JPEG, WebP) from HTML/CSS templates or five starter templates.
It runs on Cloudflare Workers with Satori and resvg; card images never touch a browser.
PDF documents from HTML templates are built too, printed by Cloudflare Browser Run, and are
switched off in production until Ahmad approves them (see "PDF documents" below). Build v3 adds
bulk documents with certificate verification, a PDF toolkit, cards from links, personalized
email images, connectors for Zapier, Make and n8n, and free funnel pages: built, tested and on
staging since 2026-11-26, each behind its own switch (see "Build v3 tools" below). On 2026-11-27
Ahmad approved only the free pages for production; every v3 API stays off there.

## Status, stated plainly

- **Production runs on https://linktocard.com** (deployed 2026-11-23; `www` redirects there),
  with checkout off until live Paddle approves the domain: the paid plans say "Coming soon",
  the Free plan and sign-in work. `npm run check:deploy` passed there, including a signed
  image; a sign-in email to a real address was accepted by Resend with no error, and a
  browser sign-in worked. Zone settings still to change by hand are in
  GO-LIVE.md section 4a.
- **Live Paddle is configured** (2026-11-23): the same three products and prices as the sandbox, a
  live client token and webhook destination, live keys stored as Worker secrets. Checkout stays
  closed (`CHECKOUT_ENABLED = "false"`) until Paddle approves linktocard.com. GO-LIVE.md section 6.
- **Staging runs on Cloudflare** at https://linktocard-staging.names-on-base.workers.dev with
  the Paddle sandbox. Measured there: CPU time median 4 ms, 90th percentile 376 ms, maximum
  636 ms per request.
- **Paddle sandbox works end to end on staging** (2026-11-22): a checkout with Paddle's test
  card switched a dashboard account to Starter within 7 seconds; switching to Pro (prorated)
  and back (not billed), a top-up (1,000 images credited), the billing portal link and a
  period-end cancellation all worked, with every webhook verified and logged. The site's
  Content-Security-Policy let the checkout load. **Live Paddle has not been used**.
- Sign-in email works on staging: a magic link sent through Resend from `login@linktocard.com`
  arrived in a Gmail inbox (not spam) within a second and signed in.
- The seller is named on the site: Ahmad Shaaban, trading as Link To Card, Nahr Street, Shehim,
  Chouf, Lebanon (terms, privacy, refund policy, and a one-line notice in every page's footer).
  The legal pages are still drafts written with AI assistance; see "Assumptions to confirm".
  `npm run deploy:production` refuses to run if a placeholder ever returns to a page.
- Whether Paddle can pay out to an individual in Lebanon is unverified. Read
  [GO-LIVE.md](GO-LIVE.md) step 0 before spending money on anything.
- **The home page as a grid of every tool is in the code, not deployed** (owner decision of
  2026-11-28). Its first screen lists every tool the build publishes, from `site/tools.catalog.ts`.
  Checked in headless Chromium only. Changelog, 2026-11-28.
- **Chart images (API plus free chart maker) are in the code, not in production** (owner decision
  of 2026-11-28). The Worker routes are on staging (`CHARTS_ENABLED` `"true"` there, `"false"` in
  production). The site feature `charts` (four chart maker pages, `/docs/charts`, the home page tile)
  is in `deploy:staging` only and was checked against a local `wrangler dev` in headless Chromium;
  the site part is not deployed yet. Changelog, 2026-11-28.
- **The top-up without a subscription is in the code, not deployed** (owner decision of
  2026-11-28). A Free account can buy the $8 top-up; it stays on Free, with the corner mark.
  Production keeps checkout closed, so there nothing can be bought and the pages say top-ups are
  coming soon. Not run with a real sandbox checkout yet. Changelog, 2026-11-28.
- **Build v3 (2026-11-26) is on staging; production has only the approved free pages (2026-11-27).**
  Checked on staging with real renders
  the same day: a 3-row certificate batch ran through the queue (6 images charged, each PDF with its
  certificate ID, a verify link and a QR code that decodes to its `/v/{id}` page, which loads with no
  console errors), and its ZIP is a valid archive of the 3 PDFs; the toolkit's merge, fields, stamp
  (the Free line printed) and from-images answered; a card built from https://www.cloudflare.com/
  rendered; an email banner signed with `open=name` rendered for two names and a tampered signed
  value answered 403; the 13 new public pages answer 200. The connectors are not published.
  Its four Worker switches (`BATCH_ENABLED`,
  `PDF_TOOLKIT_ENABLED`, `LINK_CARDS_ENABLED`, `EMAIL_FIELDS_ENABLED`) are `"true"` locally and in the
  staging configuration and `"false"` in production. Production got its queue
  (`linktocard-batch-production`, idle while `BATCH_ENABLED` is off) and migrations `0006`-`0008`
  on 2026-11-27, before that day's deploy (GO-LIVE.md section 11a).
- **Production publishes only the approved free pages** (owner decision of 2026-11-27; deployed to
  staging and then production on 2026-11-27, production Worker version `f0eb445e`; the audit fixes the
  same day, production `bb46082a`, staging `909574bd`; analytics and Terms decisions the same day,
  production `65d05a46`, staging `eea07147`). Live checks
  that day: on staging, an email image counted 1 on its first open and 0 on four repeats (Free and
  Pro, 2 images for 7 opens), the five social starters answered 400 at the email size on
  `/v1/images`, `/api/sign` and `/api/preview` while inline HTML still rendered 1200 x 400, and a
  new certificate's `/v/{id}` page printed the home page's footer; on production, the 12 approved
  pages answer 200, the four docs pages carry their notice and `noindex`, `/docs/integrations` and
  the other unapproved pages answer 404, and `POST /v1/pdf`, `/v1/batches`, `/v1/pdf-tools/merge`
  and `/v1/cards/from-url` answer 503 `not_configured`. `npm run deploy:production` builds the site with
  `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off`: the tools hub `/tools`, the five one-app
  preview checkers, `/tools/merge-pdf` and `/tools/image-to-pdf` (they run in the browser and count
  nothing), and the docs pages `/docs/bulk`, `/docs/pdf-tools`, `/docs/link-cards` and
  `/docs/email-images`, each opening with a notice that its API is not switched on yet, `noindex`
  and out of the sitemap and the docs navigation. `/docs/integrations` is not published in
  production: the connectors stay unpublished (decision 6), and its "one HTTP request today" list
  names endpoints that are off there. `PDF_ENABLED`, `BATCH_ENABLED`, `PDF_TOOLKIT_ENABLED`, `EMAIL_FIELDS_ENABLED` and
  `LINK_CARDS_ENABLED` stay `"false"` there; PDFs, bulk documents, the toolkit and email images wait
  for "PDF approved, enable it", cards from links for their own approval. The connectors are not
  published. `CHECKOUT_ENABLED` and Paddle are unchanged. `tests/node/production-site.test.ts`
  checks the production build page by page against the build with every feature off.

## What it does

- `GET /v1/og/{siteId}/{template}.{png|jpg|webp}?...&sig=...`: a signed image URL for a
  page's `og:image` tag. Rendered on the first request, stored, then served from cache.
- `POST /v1/images`: render with an API key, returns a hosted image URL (or the bytes).
- `GET /v1/usage`, `GET /v1/templates`.
- PDF documents (built; switched on in the staging configuration but not deployed there yet;
  off in production): `POST /v1/pdf`, signed
  `GET /v1/pdf/{siteId}/{template}.pdf` links, stored PDFs under `/i/...pdf`, five PDF starter
  templates, and three free tools (`/tools/html-to-pdf`, `/tools/invoice-generator`,
  `/tools/certificate-generator`).
- Build v3 tools (built; on locally and in the staging configuration, off in production; GO-LIVE.md
  section 11):
  - **Bulk documents** (`BATCH_ENABLED`, needs PDFs): `POST /v1/batches` makes one PDF per row through
    a Cloudflare Queue, `GET /v1/batches[/{id}]`, ZIP downloads in parts (`/zip?part=N`, at most
    `BATCH.zipPartMaxEntries` files and `BATCH.zipPartMaxBytes` each), cancel, and a dashboard
    **Bulk documents** tab that reads a CSV in the browser. Optional certificate records with a
    public page `GET /v/{id}` (and `.json`), a QR code on the certificate template, and revoking.
  - **PDF toolkit** (`PDF_TOOLKIT_ENABLED`): `POST /v1/pdf-tools/{merge|split|stamp|fill|fields|from-images|protect}`
    with @cantoo/pdf-lib in the Worker, no browser; JSON or multipart uploads.
  - **Cards from links** (`LINK_CARDS_ENABLED`): `POST /v1/cards/from-url` and signed
    `GET /v1/link/{siteId}/{template}.{ext}?url=...` URLs, made from a page's own metadata.
  - **Personalized email images** (`EMAIL_FIELDS_ENABLED`): signed card URLs with `open` fields an
    email platform fills in, a daily cap per site, and two email starter templates.
  - **Connectors** in `integrations/` (Zapier, Make, n8n): not published; `integrations/README.md`.
  - **Free pages** (site features only): `/tools` (the tool hub), five one-app link preview
    checkers, and `/tools/merge-pdf` and `/tools/image-to-pdf`, which work entirely in the browser.
- A dashboard: sign in by email link, sites and signing secrets, signed-URL builder,
  template editor with live preview, API keys, custom fonts on paid plans, usage, billing.
- A marketing site with a live playground, pricing, docs, comparisons and legal pages.

Deliberately not built: website screenshots, video or GIF, a visual editor, AI image
generation, team accounts, automatic overage billing, any payment processor other than Paddle.
Also not built in build v3, by the owner's decision: a screenshot API, e-signatures, PDF
compression, Office conversion or OCR, dynamic QR codes, a public receipt generator and
monitoring.

## Stack

| Part | Choice |
| --- | --- |
| Runtime | One Cloudflare Worker (TypeScript, Hono) plus Workers Static Assets for the site |
| Rendering | Satori (HTML/CSS to SVG), resvg-wasm (SVG to pixels), jSquash (JPEG, WebP) |
| PDF documents | Cloudflare Browser Run quick action (`env.BROWSER.quickAction('pdf', ...)`), bound on staging and production only |
| Bulk documents | Cloudflare Queues (`BATCH_QUEUE`, producer and consumer in the same Worker), QR codes with uqr |
| PDF toolkit | @cantoo/pdf-lib in the Worker; pdf-lib in the browser for the two in-browser tools, bundled with esbuild |
| Data | D1 (accounts, keys, templates, usage, webhook log, PDF browser time, batches and certificate records), R2 (rendered images and PDFs, fonts) |
| Email | Resend (sign-in links, quota warnings, contact form) |
| Billing | Paddle Billing only: Paddle.js overlay checkout, customer portal, webhooks |
| Tooling | Wrangler, Vitest with the Cloudflare pool, plain Node for the site build |

The site is plain HTML, CSS and JavaScript generated by `scripts/build-site.ts`. There is no
front-end framework and no CSS bundler. One script is bundled: `npm run build:browser`
(`scripts/build-browser-bundles.mts`, run first by `npm run build:site`) packs pdf-lib with esbuild
into `site/public/assets/js/vendor/pdf-local.js` for `/tools/merge-pdf` and `/tools/image-to-pdf`.
That file is a build output and is git-ignored.

## Run it locally

Needs Node 22 or newer.

```sh
npm install
cp .dev.vars.example .dev.vars        # then set SIGNING_MASTER_SECRET to any long random string
npm run db:migrate:local
npm run dev                           # http://localhost:8787
```

Signing in locally: with no `RESEND_API_KEY`, no email is sent. The sign-in page shows the
link directly (and the terminal prints it). This shortcut exists only when `ENVIRONMENT` is
`development` or `test`.

Regenerate the starter-template sample images after changing a template: `npm run samples`.

`npm run dev` builds the site without the PDF pages. To see them locally, build with the switch
on and start Wrangler yourself: `SITE_PDF=on npm run build:site && npx wrangler dev`. Locally
every PDF endpoint answers 503 `not_configured`: Browser Run is bound only on staging and
production, so `wrangler dev` and the test pool start without a network connection. For the same
reason bulk documents answer 503 "PDF rendering is not enabled yet." under `wrangler dev`, which
runs a local queue all the same; the toolkit and email images work there, and cards from links
whenever the local Worker can reach the page. The
build v3 pages: `SITE_FEATURES=pdf,batch,toolkit,linkcards,email,previews,integrations,localpdf,apidocs SITE_PDF=on npm run build:site`; the production site: `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off npm run build:site`.

## Tests

```sh
npm test            # builds the site, then both suites
npm run typecheck   # both TypeScript projects
npm run smoke       # the whole product over HTTP against a real `wrangler dev`
```

- `tests/*.test.ts` run inside `workerd` with local D1, R2 and rate limiters
  (`npm run test:workers`).
- `tests/node/*.test.ts` run in Node: the site build, docs, signing examples in three
  languages, the Paddle catalog instructions, and the dependency guard (`npm run test:node`).
  The site build is tested with the PDF switch both off and on (`SITE_PDF`), and with each
  build v3 feature (`SITE_FEATURES`).
- `tests/pdf-*.test.ts` cover PDF documents against a mocked Browser Run binding
  (`tests/pdf-helpers.ts`); page counting is checked against real Chrome PDFs in
  `tests/fixtures/pdf/`. The real renderer cannot be reached from a test or from `wrangler dev`.
- Build v3: `tests/batch*.test.ts` and `tests/batches-*.test.ts` (rows, queue consumer, ZIP parts,
  routes, an end-to-end batch through the Worker's own `queue()` and one through the pool's real
  local queue), `tests/verify-page.test.ts`, `tests/zip.test.ts`, `tests/pdftools-*.test.ts`,
  `tests/cards-*.test.ts`, `tests/email-*.test.ts`; in Node, the v3 docs and site statements
  (`tests/node/v3-docs-draft.test.ts`, `tests/node/v3-site.test.ts`), the email pages, the preview
  pages, the dashboard Bulk tab, the in-browser PDF tools, the queue settings in `wrangler.toml` and
  the three connectors' copies of the service's choices (`tests/node/*-connector-sync.test.ts`).
- Chart images: `tests/charts-*.test.ts` in `workerd`; in Node, `tests/node/charts-site.test.ts` (the
  chart pages in each build, the documented Node signer against `src/charts/url.ts`, the field tables
  against `src/charts/spec.ts`, the chart maker's helpers, the OpenAPI numbers against `CHARTS`). The
  connectors' own suites run in their folders (`integrations/README.md`), not in `npm test`.
- `npm run smoke` starts `wrangler dev` on port 8799 with a throw-away database, signs in,
  creates a key and a site, renders, checks caching and counting, checks that every PDF
  endpoint answers 503 without Browser Run, checks the build v3 routes it can reach there (an
  email image with an open field, counted once and not on three repeat opens; the social starters'
  400 `size_not_supported` at the email size, also with every switch off; a 404 verification page with its own CSP, a link card's 403, the
  bulk documents' 503, toolkit merges and stamps of the test fixtures, a form's fields), and stops
  the server. It then starts `wrangler dev` twice more on the same data: once with `APP_URL` and
  `SITE_URL` on an unassigned IPv6 address, so cards from links are made from the Worker's own
  `/pricing` page (read from the static assets, nothing leaves the machine): `POST
  /v1/cards/from-url`, a signed `/v1/link/...` URL and `/playground/from-check/...`; and once with
  the four build v3 switches `"false"`, as in production, where every new route answers 503 and
  cards and signed URLs still work. It ends with the site built as configured.

The build request's acceptance list maps to `tests/acceptance.test.ts`, one test per item:

| # | Requirement | Test |
| --- | --- | --- |
| 1 | Playground render is a valid PNG, about 1200x630 | acceptance 1 |
| 2 | Signed URL without a valid signature is rejected | acceptance 2 |
| 3 | Valid signature returns the requested image type and is cacheable | acceptance 3 |
| 4 | An identical second request is served from cache and not counted | acceptance 4 |
| 5 | A failed render is not counted | acceptance 5 |
| 6 | After 100 Free renders the next unique render is HTTP 402 with a JSON error | acceptance 6 |
| 7 | API key works; a revoked key is rejected | acceptance 7 |
| 8 | Starter purchase flips the plan; cancellation returns to Free at period end | acceptance 8 (signed example events, not a real checkout) |
| 9 | Replaying a webhook event id does not double-credit a top-up | acceptance 9 |
| 10 | The image proxy refuses 127.0.0.1, 10.0.0.0/8, 169.254.169.254, oversize and non-image | acceptance 10, `tests/ssrf.test.ts` |
| 11 | /terms, /privacy, /refund, /pricing are public and carry the required wording | `tests/node/site.test.ts`, `npm run smoke` |
| 12 | No Stripe, Lemon Squeezy, Playwright or Puppeteer dependency | `tests/node/forbidden-deps.test.ts` |

Item 8 is the one that a test cannot fully prove. The real sandbox checkout is a manual
step in [GO-LIVE.md](GO-LIVE.md) section 3.

## Secrets and configuration

No secret is ever committed. Locally they live in `.dev.vars` (git-ignored). On Cloudflare
they are set with `npx wrangler secret put <NAME> --env staging|production`.

### Secrets (4)

| Name | What it is | Where it comes from |
| --- | --- | --- |
| `SIGNING_MASTER_SECRET` | Master key. Every site's signing secret is derived from it. Changing it breaks every signed URL of every customer. | You generate it: `openssl rand -base64 48`. Keep a copy in a password manager. Use a different one per environment. |
| `RESEND_API_KEY` | Sends sign-in links, quota warnings and contact-form mail. | Resend dashboard, API Keys |
| `PADDLE_API_KEY` | Server-side Paddle API: customer portal sessions and plan changes. | Paddle dashboard, Developer Tools, Authentication. Sandbox key on staging, live key on production. |
| `PADDLE_WEBHOOK_SECRET` | Verifies webhook signatures. Several values may be separated by commas while rotating. | Paddle dashboard, Developer Tools, Notifications, the destination's secret key |

### Variables (not secret, in `wrangler.toml` per environment)

| Name | Meaning |
| --- | --- |
| `ENVIRONMENT` | `development`, `staging` or `production` |
| `APP_URL` | Public origin of this deployment, no trailing slash. Sign-in links, image URLs and the same-origin check use it. |
| `SUPPORT_EMAIL` | Shown in error messages and emails; receives the contact form |
| `MAIL_FROM` | Sender of outgoing email. Its domain must be verified in Resend. |
| `PADDLE_ENV` | `sandbox` or `production` |
| `PADDLE_CLIENT_TOKEN` | Paddle.js client-side token. Public by design. |
| `PADDLE_PRICE_STARTER`, `PADDLE_PRICE_PRO`, `PADDLE_PRICE_TOPUP` | The three Paddle price ids (`pri_...`) |
| `PDF_ENABLED` | `"true"` turns the PDF endpoints on; they also need the `BROWSER` binding. Anything else: every PDF endpoint answers 503 and `/api/config` reports `pdf_enabled: false`. `"true"` locally and on staging, `"false"` on production |
| `PDF_DAILY_BROWSER_MS_BUDGET` | Optional. Browser Run milliseconds per 24 hours above which the daily cron emails `SUPPORT_EMAIL` (once per UTC day). Unset: `PDF.dailyBrowserMsBudget` in `src/config.ts` |
| `BATCH_ENABLED` | `"true"` turns bulk documents and the verification pages on (`/v1/batches`, `/api/batches`, `/v/...`, certificate revoking). Batches also need PDFs on and the `BATCH_QUEUE` binding; the verification pages and revoking do not. Off: 503 `not_configured` (also for the listings, status and ZIP downloads of finished batches; each document's `/i/...pdf` link keeps working), `/v/...` a 503 notice page, and queued rows fail uncharged. `wrangler queues pause-delivery` holds rows instead, for the queue's retention only (4 days by default): GO-LIVE.md 11c |
| `PDF_TOOLKIT_ENABLED` | `"true"` turns `/v1/pdf-tools/*` on. Its stored results are served under `/i/...pdf`, which needs `PDF_ENABLED` too |
| `LINK_CARDS_ENABLED` | `"true"` turns `POST /v1/cards/from-url` and `/v1/link/...` on. Off: every `/v1/link/...` URL answers 503, stored cards included, so pages that use one show no image |
| `EMAIL_FIELDS_ENABLED` | `"true"` makes signed card URLs read `open` as the list of open fields, `/api/sign` accept `open`, and the email starters `email-banner` and `email-offer` usable. Off: `open` is an ordinary signed parameter (though `/api/sign` never signs it as data), and the email starters answer 404. Turning it off breaks the open-field images of emails already sent (403) once caches let the request through |
| `CHARTS_ENABLED` | `"true"` turns the chart routes on: signed chart URLs (`GET /v1/chart/...`), `POST /v1/charts` and the free chart maker's endpoint (`POST /api/tools/chart`). Off: they answer 503 `not_configured`; a chart that is already stored keeps being served from `/i/...`. `"true"` locally and on staging, `"false"` on production |

While any Paddle variable is empty, the site still works: the pricing page and dashboard
show that checkout is not available yet instead of opening a broken overlay.

Also in `wrangler.toml`, to fill in once per environment: the D1 `database_id` and, for
staging, your workers.dev subdomain in `APP_URL`. Each is marked `TODO(Ahmad)`.

### Build-time settings for the site

`site/site.config.json` holds the site name, URL, support email, **legal name**, **legal
address**, the short **locality** shown in the footer, the legal pages' "last updated" date and
the governing law. The environment variables `SITE_URL`, `SITE_LEGAL_NAME`,
`SITE_LEGAL_ADDRESS` and `SITE_LEGAL_LOCALITY` override the file for one build. Change
`legalUpdated` whenever the wording of the terms, privacy policy or refund policy changes, or give
only the changed page a date of its own in its front matter: `updated: YYYY-MM-DD` for text every
build prints, `updated.<feature>: YYYY-MM-DD` (`updated.batch`, `updated.no-pdf`, ...) for text only
a build with that feature switch prints. A legal page shows the latest of `legalUpdated` and the
dates that apply to the build, so raising `legalUpdated` at a launch dates every legal page by
itself. A date that is not a real day, an unknown feature, or the key on a page that is not
`layout: legal` stops the build. Today `terms.md` has `updated: 2026-11-28` and `privacy.md` `updated: 2026-11-27` and
`updated.charts: 2026-11-28`, so the production build shows the terms 28 November, the privacy policy
27 November and the refund policy 25 November; the staging build shows the privacy policy 28 November.

`SITE_PDF` switches the PDF pages and blocks of the site (`feature: pdf` front matter,
`<!-- feature:pdf -->` blocks): `on` builds them, `off` or unset leaves them out. Any other value
stops the build. `npm run deploy:staging` builds with `on`, `npm run deploy:production` with
`off`, so a value left exported in the shell cannot publish PDF pages on production.

`SITE_FEATURES` is a comma list of the site features to publish, the same way: `pdf`, `batch`,
`toolkit`, `linkcards`, `email`, `previews`, `integrations`, `localpdf`, `apidocs`, `charts`
(`scripts/build-site.ts` `FEATURES`). An unknown name stops the build, and so do `batch` or
`toolkit` without `pdf` (their documents are PDFs and their terms build on the PDF terms; GO-LIVE.md
section 11c turns them on only after PDFs). `localpdf` publishes the
in-browser `/tools/merge-pdf` and `/tools/image-to-pdf` (their API sections need `toolkit`), and the
build refuses it unless `toolkit` or `apidocs` is on too, so its "Automate this with the API" link
has a page. `apidocs` publishes every docs page with an `unlaunched: <notice>` front-matter key
while that page's own feature is off: the notice opens the page under its heading, the page is
`noindex`, left out of `sitemap.xml` and of the docs navigation and pager, and its links to pages
the build does not publish are printed as text. Approving a tool later (its feature on) removes the
notice and puts the page back in the navigation and the sitemap by itself. `deploy:staging` builds
with all ten; `deploy:production` with `SITE_FEATURES=previews,localpdf,apidocs` (owner decision
of 2026-11-27). `charts` publishes the chart pages, the home page tile, the `/tools` block, the
counting rule, the chart rows of the rate-limit table, the two OpenAPI paths and the privacy
policy's chart maker line; it has no `unlaunched` page, so a build without it has no trace of charts.
A page can load a stylesheet of its own with `styles: <name>` in its front matter
(`/assets/css/<name>.css`, linked at the start of the page's body, because `site/layouts/base.html`
is copied by the verification page), as the chart pages load `chart-maker.css`. The terms and the privacy policy carry each feature's text in its own block, so a
feature's legal text goes live only with that feature (`tests/node/v3-site.test.ts`). The production
Terms are the owner-approved text of commit `89270a7` once the blocks are applied, plus the rule
against counterfeit or misleading documents, which the owner published in every build on
2026-11-27 (the "always urgent" suspension and "and other files" are still `pdf` text), and with
the Free and Top-up lines of section 6 rewritten on 2026-11-28 for the top-up without a
subscription (not deployed yet; the changelog quotes both lines). The refund
policy is unchanged from `89270a7` (`tests/node/legal-pages.test.ts`). The privacy policy has
wording that belongs to no feature and is true in production: Turnstile is shown "if a free tool on
the website shows it" (the one-app preview pages can), expired entries are "deleted by the daily
clean-up, normally within a day", and the website uses cookieless Cloudflare Web Analytics (owner
decision of 2026-11-27); hence its own date. The zone injects the Web Analytics script into every
HTML page for browsers, and `site/public/_headers` allows it: `https://static.cloudflareinsights.com`
in `script-src`, `https://cloudflareinsights.com` in `connect-src`. It reports to `/cdn-cgi/rum` on
the same origin. The verification pages' own policy (`VERIFY_PAGE_CSP`) still allows no script,
because the privacy policy says they load none, so the script is blocked there.

`RATE_LIMITS_DISABLED` exists only for the test suite and is ignored unless `ENVIRONMENT`
is `test`.

## Deploying

Follow [GO-LIVE.md](GO-LIVE.md) from the top. In short: accounts, legal name, staging on
workers.dev with the Paddle sandbox, production on the real domain, spending limit, Paddle
live. The Paddle catalog to create by hand is in
[scripts/seed-paddle-sandbox.md](scripts/seed-paddle-sandbox.md); a test keeps that file in
step with the prices in `src/billing/plans.ts`.

After each deploy, `npm run check:deploy -- <url>` checks the live site (see the script's header
for the optional full check with a test API key and site).

Deploying from a Claude cloud session: give Wrangler the Cloudflare token as the environment
variable `CLOUDFLARE_API_TOKEN`, not as a network secret. Uploading the static site uses a
short-lived upload key in the `Authorization` header, which a proxy-injected secret overwrites
(the upload then fails with 401).

Workers Paid ($5 a month) is required. On staging a render took up to about 400 ms of CPU
(636 ms for the first render in a fresh instance), and the free Workers plan allows 10 ms per
request. Workers Paid includes 30 million CPU milliseconds a month, about 75,000 renders at
400 ms, then $0.02 per million CPU milliseconds (research/cloudflare.md).

Bundle size (measured with `wrangler deploy --dry-run --env staging`): 6.8 MB, 2.7 MB gzipped on
2026-11-22; with build v3 on 2026-11-26, 8,577.17 KiB, 3,218.23 KiB gzipped (the PDF toolkit brings
@cantoo/pdf-lib into the bundle); on 2026-11-27, after the owner decisions and their review fixes,
8,587.90 KiB, 3,220.92 KiB gzipped (`--env production`: 3,217.08 KiB). Both under the 10 MB compressed limit of Workers Paid. Worker
startup time with pdf-lib and the toolkit's CPU per operation on Cloudflare are not measured. The static site adds about
3,800 asset files, most of them the Twemoji SVGs the renderer loads for emoji.

## PDF documents

Built and tested. Switched on in the staging configuration, which has not been deployed with
them yet; off in production (`PDF_ENABLED = "false"`, and production deploys build the site
with `SITE_PDF=off`) until Ahmad approves them. The staging rollout and turning them on in
production are GO-LIVE.md section 10.

- **Renderer.** One `env.BROWSER.quickAction('pdf', options)` call per PDF (`src/pdf/render.ts`).
  The browser only ever receives our own sanitised document as `html`, never a `url`, with
  JavaScript off, `allowRequestPattern: ['^data:']` (no network access), `cacheTTL: 0` and
  `tagged: false`. One deadline (`CALL_TIMEOUT_MS`, 2 x `PDF.renderTimeoutMs` + 15 s) covers
  the call, the PDF body and error bodies (read up to 64 KB). The PDF is refused (422) when its
  `Content-Length` is over `PDF.maxPdfBytes`, and is otherwise read with a running count and
  cancelled past it, so no more than that is ever kept (with chunks and no `Content-Length`,
  about twice that for a moment while they are joined). A body that stops, or does not arrive
  before the deadline, is 500 `render_failed` and counts as Browser Run's failure, not the
  document's. `browser_usage.wall_ms` is measured to the end of reading the body. No
  headless-browser package is a dependency; `tests/node/forbidden-deps.test.ts` enforces that.
- **Template language and sanitiser** (`src/pdf/template.ts`, `src/pdf/css.ts`): `{{key}}`
  placeholders and `{{#items}}` sections filled in on the parsed tree; scripts, event
  attributes, frames, `javascript:` links and the like removed; `@import`, remote `@font-face`
  and CSS strings broken by a line break refused; `@page` dropped (the page box comes from the
  request alone). Remote images are downloaded first through the guarded image fetcher
  and embedded (`src/pdf/assets.ts`); the bundled fonts are embedded when the CSS names them.
- **Counting.** A PDF counts as several images by its page count (`pdfUnits()` in
  `src/config.ts`; the table is on `/docs/pdf`), charged as one block from the allowance or one
  top-up, never split. Its ledger row is claimed as "pending" before anything is rendered
  (`claimPdf` in `src/lib/quota.ts`) and labelled paid when the block is taken
  (`chargeClaimedPdf`), so of several identical requests only one renders: the others wait for
  it (`PDF_DUPLICATE_WAIT_MS` in `src/pdf/service.ts`, 90 s) and are served its stored PDF free,
  or the same failure. A claim older than `PDF_PENDING_STALE_MS` (180 s) can be taken over. The
  page count is read from the PDF's cross-reference table and page tree (`src/pdf/count.ts`),
  never by searching its text, and only from windows of the file: the last 2 KB, each xref
  section (64 KB, doubling up to 8 MiB) and each object (1 KB, doubling up to 4 MiB); a larger
  structure makes the count unreadable (500, not charged). Free-plan and free-tool PDFs carry
  the "Made with Link To Card" footer line on a white background of its own; next to it the
  customer's header and footer are printed as plain text in our own style
  (`preparePdfFragment` with `mark` in `src/pdf/template.ts`, `headerFooter` in
  `src/pdf/page.ts`), so no customer element, attribute or style reaches the document Chrome
  renders them in with the mark.
- **Cost tracking.** Every browser call is a row in `browser_usage` (kept
  `PDF.browserUsageRetentionDays` days), with the time Browser Run reported and the measured
  length of the call (counted when Browser Run reports none: timeouts, 5xx). The daily cron emails
  `SUPPORT_EMAIL` when the last 24 hours used more browser time than
  `PDF_DAILY_BROWSER_MS_BUDGET`. Three automatic limits (`src/pdf/guard.ts`):
  - the failed-render cap: `PDF.maxFailedRendersPerDay` renders per UTC day, by the owner's
    plan, that reach the browser and fail because of the document (more than
    `PDF.maxPages` pages, over `PDF.maxPdfBytes`, a timeout, a browser 422, an unreadable page
    count) or need more images than are left (402 after rendering), then 429 until 00:00 UTC.
    It counts per account for `POST /v1/pdf`, and for signed links per site and for all sites
    of the account together (`PDF.maxFailedSignedRendersPerDay`, so a deleted and re-created
    site starts no new count). Before the browser runs, a render takes a place under every cap
    of its scope in one batch (a `tool_usage` row per render, alive for `PDF_PENDING_STALE_MS`),
    so concurrent requests cannot pass it; when renders still running hold the last places the
    answer is 429 with `Retry-After: 5`, not until midnight. A charged PDF and Browser Run's own
    failures (5xx without a timeout, 400, unreachable, busy, a body that stopped) free the place;
    a document failure or a 402 after rendering keeps it as a failure; a render cut off by the
    runtime (client gone, more than about 30 s left) keeps it too, because its browser time is
    neither known nor recorded;
  - the failure memory: such a failure is remembered for `PDF.failedRenderMemoryMs` by cache
    key (`tool_usage`, bucket `pdfm:<cache key>:<answer>`), and the identical request gets the
    same answer without rendering or counting (a remembered 402 is checked again against what
    is left now);
  - the free brake: while the browser time of Free-plan renders and the free tools in the last
    24 hours is over `PDF.freeBrakeBudgetMultiple` daily budgets, Free-plan renders and the free
    tools answer 429 (`Retry-After: 3600`); renders made on a paid plan never engage it, also
    after the account moved to Free (`browser_usage.plan`, migration `0007`). It lifts as that
    use ages out of the 24-hour window, at the latest 24 hours after it stopped.

  `HEAD` of a signed link runs the same checks a render runs first (402, the site's caps, the
  brake, a remembered failure) and never renders or counts. Identical requests that wait for
  one render look at the ledger read-only and pay the site's `RL_KEY` once, as any uncached
  signed request; a paid PDF whose R2 object is missing is rendered again by one of them only
  (lock `pdfr:<cache key>`). On 2026-11-25 Cloudflare's
  pricing page listed Browser Run on Workers Paid as 10 browser hours a month included, then
  $0.09 per hour.
- **Starter templates** (`src/pdf/templates/`): invoice, receipt, quote, certificate of
  completion, report. There are deliberately no templates for bank statements, utility bills,
  identity documents, diplomas or any government document, and the terms forbid counterfeit
  documents.
- **Not built:** fonts uploaded in the dashboard are used for card images only, not embedded in
  PDFs; the dashboard's signed-URL builder makes card URLs only (signed PDF links are built on the
  customer's server, as `/docs/pdf` shows).

## Build v3 tools

Owner decision of 2026-11-26 ("Paddle pays, build all"): the five ranked tools and the free pages of
the tool opportunities report. No new Paddle product: every tool spends the existing image units.
Every number is in `src/config.ts` (`BATCH`, `PDF_TOOLKIT`, `LINK_CARDS`, `EMAIL_FIELDS`, `LOCAL_PDF`)
and reaches the site through `[[tokens]]` (`scripts/v3-site-tokens.ts`, `scripts/email-site-tokens.ts`,
`scripts/previews-site-tokens.ts`). Free-plan outputs carry the card watermark or the PDF free mark.

| Tool | Worker switch | Site feature | Docs |
| --- | --- | --- | --- |
| Bulk documents and certificate verification | `BATCH_ENABLED` (and PDFs) | `batch` | `/docs/bulk` |
| PDF toolkit | `PDF_TOOLKIT_ENABLED` | `toolkit` | `/docs/pdf-tools` |
| Cards from links | `LINK_CARDS_ENABLED` | `linkcards` | `/docs/link-cards` |
| Personalized email images | `EMAIL_FIELDS_ENABLED` | `email` | `/docs/email-images`, `/guides/personalized-email-images` |
| One-app link preview pages and `/tools` (approved for production on 2026-11-27) | none (they use `/api/tools/og-check`) | `previews` | |
| Merge PDF and Image to PDF, in the browser (approved for production on 2026-11-27) | none (nothing reaches the Worker) | `localpdf` | |
| The four docs pages above (bulk, PDF toolkit, link cards, email images) while their tool is off, with a notice (approved for production on 2026-11-27) | none | `apidocs` | |
| Zapier, Make and n8n connectors | none | `integrations` (the page says "being prepared for listing") | `/docs/integrations`, `integrations/README.md` |
| Chart images: signed `/v1/chart/...` URLs, `POST /v1/charts`, and the free `/tools/chart-maker`, `/tools/pie-chart-maker`, `/tools/bar-graph-maker` and `/tools/line-graph-maker` (owner decision of 2026-11-28; staging only) | `CHARTS_ENABLED` | `charts` | `/docs/charts` |

- **Bulk documents.** Rows are checked with `validatePdfData` before anything is stored; each row is
  rendered and charged exactly like `POST /v1/pdf` (ledger source `batch`) by the queue consumer,
  one after another, at least `BATCH.minRowMs` each, `max_concurrency` 5. Only Browser Run's own
  failures and a busy browser are retried, at most `BATCH.maxRowAttempts` renders; running out of
  images fails the remaining rows and the batch ends `partial`. Batch rows are exempt from
  `RL_PDF_FREE` (decision D12). Too many rows answer 403 `plan_required` while a higher plan takes
  them, else 400 (D1); the active-batch cap is 409 `conflict` (D2); an unknown template 404 (D3);
  default names `certificate-1.pdf` / `document-1.pdf` (D4). ZIP downloads come in parts of at most
  `BATCH.zipPartMaxEntries` files and `BATCH.zipPartMaxBytes`, sized up front and streamed with a
  `FixedLengthStream` (D9; the ZIP writer is our own, `src/lib/zip.ts`, store method only).
  `certificate_id`, `verify_url` and `verify_qr` are added after the row's data was validated, as
  trusted fields outside `PDF.maxDataValueChars` (D13). The daily cleanup fails rows stranded for
  `BATCH.staleAfterDays`, deletes finished batches after their last PDF expired, deletes revoked
  certificate records after `BATCH.revokedRetentionDays`, and deletes a deleted account's batches
  and records. The verification page states the domain of the issuing account's sign-in email
  (`src/batch/issuer.ts`; a curated list of public mailbox domains says "personal email address"),
  a fixed disclaimer and a report link; it is `noindex`, never cached and has its own strict CSP.
  Its footer is the static site's own, with that build's tool links: the site build publishes it as
  `/assets/partials/footer.html`, and the Worker reads it through `env.ASSETS` once per isolate,
  checks that it is one plain `<footer class="site-footer">` and prints it; when the asset is missing
  or fails the check, a stand-in footer with only the links every build has is printed. The header
  stays a checked copy of the site's.
- **PDF toolkit.** `url` inputs are downloaded under the image fetcher's rules (public addresses,
  every redirect checked, `LIMITS.imageFetchTimeoutMs` per file) and never from Link To Card's own
  hosts; encrypted and XFA files are refused; a structure budget is checked before pdf-lib parses a
  file. Units: one per started `PDF_TOOLKIT.pagesPerUnit` output pages (split: per file), charged as
  one block; `fields` is free. Results are stored like PDFs and every successful request counts
  (no cache). Split answers `{ op, files, pages, credits_used, created_at, expires_at, usage }` (D10).
- **Cards from links.** The OG checker's inspector reads the page (same SSRF rules, cache and daily
  page checks per key or per site); its metadata fills the template; one image unit per new card. A
  signed link reads its page again after `LINK_CARDS.refreshAfterMs`.
- **Email images.** `open` is signed; the open fields' values are left out of the signed message,
  normalised and restricted to short plain text the fonts draw, else the field's signed default.
  New renders per site and UTC day are capped by `EMAIL_FIELDS.maxUniqueRendersPerDay`, counting
  images, not requests: each image a site renders that day holds one `tool_usage` row
  `emailr:{site}:{day}:{cache key}` (taken in one atomic D1 statement, kept until the end of the next
  UTC day, removed by the daily clean-up), simultaneous requests for one image share it, and a
  request that rendered nothing (its render failed, or another request stored the image first)
  gives its hold back. Past the cap the default card is served with `no-store`. Charge once (owner decision of 2026-11-27): each unique
  email image (account, template and version, signed data, normalised open values, size, format,
  watermark) counts 1 image on its first render; repeat opens are served from the edge or R2 at no
  cost; when its stored copy expires it is rendered and stored again uncharged (a ledger row with
  `charged_to = 'none'`) for `EMAIL_FIELDS.chargeMemoryDays` from the charge, also with no images
  left. The record is a `tool_usage` row (`emailpaid:{user}:{cache key}`), written only inside the
  D1 batch that takes the image (guarded by the take's own condition, so it exists if and only if
  the image was charged; never from a ledger row, which says `plan` from its claim), deleted with
  the account and by the daily cleanup once expired. Such a re-render still
  takes one of the day's unique renders. Responses carry `x-ltc-credits-used` (1 only for the
  request that was charged).
- **Not behind a switch** (live with the next deploy of any kind): the `email` size preset (1200 x
  400, decision D7), which the five social starter templates refuse with 400 `invalid_request`
  (`details.reason` `size_not_supported`) on every path that renders or signs a card (`POST /v1/images`,
  signed `/v1/og` and `/v1/link` URLs, `POST /v1/cards/from-url`, `/api/sign`, `/api/preview`), owner
  decision of 2026-11-27; your own templates and inline HTML take every size; the charge-once code of
  email images, which does nothing while `EMAIL_FIELDS_ENABLED` is off and needs no migration (its
  records are `tool_usage` rows, migration `0005`); `/v/*` reaching the Worker (a 503 notice page while `BATCH_ENABLED` is off); and
  `/api/sign` refusing `open` as a data name whatever `EMAIL_FIELDS_ENABLED` says, so that no URL
  signed while it is off changes meaning when it is turned on. The two email starter templates are
  part of the email images tool: while `EMAIL_FIELDS_ENABLED` is off, `POST /v1/images`, signed
  URLs, `/api/sign`, the studio preview and link cards answer 404 for their ids, as for any unknown
  template, and the free playground never offers them.
- **Not built from the contract:** the OG checker's "Make this card" button (only the
  `/playground/from-check/...` endpoint exists, and the docs do not mention it); the dashboard's
  open-fields option is written but stays hidden until `GET /api/config` sends an `email_fields`
  block; the email starters are not listed in `GET /v1/templates` or the dashboard; the connectors
  have no toolkit step.

## Cloudflare spending cap

Cloudflare has no exact hard cap, so use three layers (details in GO-LIVE.md section 5):

1. A **Workers spending limit** with blocking, set in the Cloudflare dashboard under
   Billing. It stops the Worker when reached. It reacts with a delay and does not cover
   R2 or D1.
2. A **budget alert** by email, which does include R2 and D1.
3. In the code: a CPU ceiling per request (`limits.cpu_ms` in `wrangler.toml`), rate limits
   per IP, per API key, per site and per account, a hard monthly quota per customer, and
   size limits on every input.

The public playground is the one endpoint that renders without an account. It accepts only
the five starter templates with short text, is limited per IP, and repeats are served from
storage.

## How images are counted

- One image is one rendered size. The same card in two sizes is two images.
- A failed render is not counted.
- A stored image is served again without counting until its cache period ends (7, 30 or 90
  days by plan). An identical request during that time is a cache hit.
- Unused monthly quota does not roll over.
- At the limit, new renders answer HTTP 402 with a JSON error. There is no overage billing.
  Stored images keep being served.
- A top-up is 1,000 images for $8, bought by hand on any plan, the Free plan included (owner
  decision of 2026-11-28), never automatically. It adds images and nothing else: a Free account
  that buys one stays on Free, with the corner mark, the 7 cache days and the Free limits.
  Which plans can buy one is `topUps` in `src/billing/plans.ts`; the site, the 402 messages and
  the quota emails read that flag. A 402 or an email offers a top-up only while checkout is open
  on the deployment (`src/billing/offers.ts`).
- Dashboard previews and the homepage playground are not counted.
- Emails go out once at 90% and once at 100% of the allowance in each period (once more after
  an upgrade inside the period, for the new allowance).
- Build v3 (where switched on): each document of a batch counts like a PDF of its pages; a
  toolkit result one image per started block of `PDF_TOOLKIT.pagesPerUnit` pages (split: per
  file; `fields`: nothing), every request; a card from a link one image like any card; an email
  image one image per distinct set of open values, counted once: after its stored copy expires it is
  rendered again without counting for `EMAIL_FIELDS.chargeMemoryDays` (400 days) from that count.

The numbers live in two files, `src/billing/plans.ts` and `src/config.ts`. The pricing
page, the docs limits page and the Paddle catalog instructions are generated from or
checked against them.

## Security notes

- Signed URLs: HMAC-SHA256 over the path, the sorted parameter names and each
  `name=value`. A site secret is derived from the master secret, shown in the dashboard and
  can be rotated per site. Reference signers in Node, PHP and Python are in
  `examples/signing/` with a shared test vector.
- API keys and sessions are stored as hashes. A key's secret is shown once.
- Remote images in templates go through a guarded fetcher: http and https only, public
  addresses only (checked by DNS-over-HTTPS before connecting, and again on every
  redirect), size, pixel and type limits, a timeout. The renderer itself can never fetch.
- Paddle webhooks: signature and timestamp verified, every event id recorded, replays ignored.
- Dashboard writes need a same-origin JSON request; the session cookie is `HttpOnly`,
  `Secure` and `SameSite=Lax`.
- The site sends a Content-Security-Policy that allows scripts only from itself and
  Paddle's CDN. No inline scripts.

Known gaps, accepted for the MVP:

- **DNS rebinding.** The proxy checks a hostname's addresses and then lets the platform
  connect by name. A hostile DNS server could answer differently the second time. On
  Cloudflare a Worker cannot reach private networks of the account by default, which
  limits what this can hit, but it is not proven closed.
- **Quota boundary race.** Two different renders racing for the last image of a period can
  both be served. The account is never charged more than it used.
- **Renderer crashes.** A few inputs make resvg trap (for example clipped content far
  outside the canvas). These end as a 500 `render_failed` and are not counted. WebAssembly
  cannot be interrupted mid-render; the input limits are what bound the cost.
- **Edge copies outlive changes.** A signed URL already cached at Cloudflare's edge or in a
  browser keeps working for up to 24 hours after the account is suspended, the site secret is
  rotated or the site is deleted. New URLs are checked at once.
- **Billing edge cases.** Only a full refund or a chargeback removes a top-up; partial
  refunds do not. A paid top-up whose event carries no known user id is recorded as
  `ignored:no_user` in `webhook_events` and needs handling by hand. A second subscription
  bought while one is running is recorded as `ignored:other_subscription` and must be
  cancelled and refunded by hand in Paddle. Changing a price id orphans subscribers on the
  old price.
- **Account ids are not secret.** They appear in hosted image URLs, so anyone can start a
  checkout that names someone else's account (a gift, in effect). It cannot replace or end a
  running subscription. A subscription that ends without a scheduled date still depends on
  Paddle's final event arriving; there is no periodic reconciliation with Paddle's API.
- **Sign-in mail.** Each client (an IPv4 address or an IPv6 /64) can have at most 20 sign-in
  emails sent per hour, and each address receives at most 5. Someone with many addresses
  can still send unwanted sign-in emails; a challenge such as Turnstile is not built.
- The `/v1` API sends no CORS headers on purpose: API keys must not be used in browsers.
  `GET /v/{id}.json`, outside `/v1`, is a public record read without a key and sends
  `Access-Control-Allow-Origin: *`.
- **Build v3 gaps:** the DNS-rebinding gap above applies to the toolkit's `url` downloads and to
  cards from links too. A toolkit result's `url` (`/i/...pdf`) answers 503 while `PDF_ENABLED` is off,
  even with the toolkit on (`src/routes/images.ts` gates every stored PDF). In the dashboard, a
  revoked certificate shows its Revoke button again after a reload (the batch row JSON has no
  certificate status; revoking twice changes nothing). The five social starter templates are not
  laid out for the `email` size and look broken there.

## Assumptions to confirm

The build request did not decide these. Each is a default chosen during the build; change
it if it is wrong.

| Topic | What was assumed | Where |
| --- | --- | --- |
| Top-up validity | Used only after the monthly allowance, valid 365 days from purchase. Any plan can buy one, Free included (decided by the owner on 2026-11-28; it was paid plans only before) | `src/billing/plans.ts` |
| Custom fonts | Starter: 3 files up to 2 MB. Pro: 20 files up to 5 MB. TTF, OTF, WOFF (not WOFF2) | `src/billing/plans.ts` |
| Per-account caps | 50 templates, 10 sites, 10 API keys | `src/config.ts` |
| Rate limits | 300/min per IP, 120/min per key or site, 30/min playground, 60/min preview, 5/min sign-in, 20 sign-in emails per hour per client | `src/config.ts`, `wrangler.toml` |
| Output sizes | All three sizes on every plan | `src/config.ts` |
| Plan changes | Both take effect at once. An upgrade is charged prorated and adds the larger allowance only for the time left in the period. A downgrade is not credited (`do_not_bill`), keeps the period's allowance, and the lower price applies from the next renewal. An upgrade never raises the allowance beyond what the time left pays for, so switching down and up cannot re-sell it | `src/billing/paddle.ts`, `src/lib/quota.ts` |
| Cancellation | The plan stays until the paid period ends, then the account returns to Free | `src/billing/paddle.ts` |
| Refunds | Any payment is refunded on request within 30 days, no reason needed, including a top-up that was already used | `site/content/refund.md` |
| Free month | A Free account's allowance resets at the start of each calendar month (UTC); a paid plan follows its Paddle billing period | `src/lib/quota.ts` |
| Governing law | Lebanon | `site/site.config.json`, `/terms` |
| Terms | Liability capped at 12 months of fees; price changes announced by email; pro-rata refund if the service is closed | `site/content/terms.md` |
| Privacy | Deletion on request by email to support, done by the operator with one command and completed by the daily cleanup (GO-LIVE.md section 8); the list of processors (Cloudflare, Resend, Paddle; add the support mailbox host) | `site/content/privacy.md` |
| Text coverage | Bundled fonts cover Latin, Latin Extended, Cyrillic and Greek. Arabic, Hebrew and CJK need an uploaded font, and right-to-left shaping is not tested | `src/render/fonts.ts` |
| Bulk documents | Rows per batch 25 / 500 / 2,000 by plan, 2 batches at once, 3 render attempts per row, revoked records kept 90 days, ZIP parts of 500 files and 2 GiB, public mailbox domains curated by hand | `src/config.ts` `BATCH`, `src/batch/issuer.ts` |
| PDF toolkit | One image per started 10 output pages; 20 files, 20 MB of input, 500 pages; every request counts | `src/config.ts` `PDF_TOOLKIT` |
| Email images | 3 open fields, 40 characters, 200 / 2,000 / 10,000 new renders per site per day, 30 days `max-age` | `src/config.ts` `EMAIL_FIELDS` |
| Cards from links | `blog` by default, a signed link reads its page again after 24 hours | `src/config.ts` `LINK_CARDS` |

## Not verified

- On Cloudflare: the edge cache (the Cache API does nothing on workers.dev, so it can only be
  seen on linktocard.com), the rate-limiting bindings under load, the daily cron (first run
  03:17 UTC after the deploy), DNS-over-HTTPS and remote image fetches from the edge, and
  sign-in email (staging has no Resend key yet).
- Live Paddle: checkout, payouts, refunds and chargebacks (the sandbox flows are verified),
  and the return to Free when a cancelled period actually ends (covered by tests, not yet
  observed on staging).
- Real email delivery through Resend.
- Statements about Paddle, Bannerbear and Vercel on the site and in `research/` come from
  search-engine excerpts and published API specifications; the vendors' own websites could
  not be opened from the build environment. Check the comparison pages against the live
  sites before launch.
- Browsers other than Chromium.
- **PDF documents on Cloudflare Browser Run.** Checked on staging on 2026-11-25 with real
  renders: `allowRequestPattern: ['^data:']` does not block the document itself; every option
  we send (including `cacheTTL: 0`, `tagged: false`, `outline: false`) is accepted and the answer
  is `application/pdf`; the page counter read every PDF (1, 4, 14, 15, 27 and 41 pages, each equal
  to `pdfinfo`); the bundled fonts are embedded with JavaScript off; the Free line appears on Free
  and tool PDFs only; a `<script>` and an `onerror` handler had no effect. Browser Run sends
  `X-Browser-Ms-Used: 0` for PDF quick actions, so the alarm and the brake count the measured
  length of each call (about 0.23-1.2 s per PDF on staging); what Cloudflare actually bills is
  only visible in the dashboard. Also checked on 2026-11-26: remote images are fetched by the
  Worker and inlined (27 images, just under the 10 MB image cap, printed as 15 pages, so Browser
  Run takes a request that large); a print that cannot finish comes back from Browser Run as 422
  after about 61 s, mentions "timeout" and answers 504 `render_timeout`, recorded at its measured
  length and counted as a failed render (since 2026-11-26 also remembered for
  `PDF.failedRenderMemoryMs`); the daily alarm finds an over-budget day and calls
  Resend (run locally; the send itself could not leave the build container). Still not checked:
  that `allowRequestPattern: ['^data:']` blocks a browser request of its own. A PDF made
  through Link To Card cannot show it, because the sanitiser turns every address it sees into a
  data: URL first; GO-LIVE section 10 has a direct Browser Run call for it. Also not checked: the
  alarm email arriving in the SUPPORT_EMAIL inbox. Table header rows repeat on every page (the 60-item
  invoice shows them on pages 2 and 3), and the docs' page-number footer prints "Page 1 of 7" to
  "Page 7 of 7", above the Free line on a Free account. Chrome writes one classic
  cross-reference section, which is what the page counter reads.
  The changes of 2026-11-26 (changelog), checked on staging the same day with real renders: a
  Free footer is printed as plain text ("Footer ... Page 7 of 7") above the free mark, with the
  warning, and markup that used to hide the mark has no effect; 10 identical requests sent at
  once give one render and one charge, the other nine are served the stored PDF; a 60-page
  document renders once (refused at 51 pages) and the next identical requests are answered from
  the failure memory without a render. Not reached on staging: the `PDF.maxPdfBytes` cap (an
  image that makes local Chromium write a 54 MB PDF came back from Browser Run as 1.25 MB, so
  its Chrome compresses images more; whether it sends `Content-Length` is not known, and the cap
  holds either way), the failed-render caps and the brake (tested against the mocked binding).
- **Build v3, on Cloudflare: nothing.** It was built and tested locally (the Workers pool with a
  mocked Browser Run, `wrangler dev`, offline `wrangler deploy --dry-run`) and has not been deployed
  to staging. Not checked: Queues on Cloudflare (delivery, retries, `max_concurrency`, the real
  pacing against Browser Run's 30 quick actions per second, the send-error text), batch PDFs from
  the real Browser Run, the toolkit's memory and CPU inside a real isolate (its memory budget was
  calibrated in Node; the pool does not enforce the 128 MB limit), Worker startup time with
  pdf-lib, link cards from real pages (the local Worker could not resolve outside host names, so
  only refusals and 422 `page_fetch_failed` were seen), and the edge cache of email images.
- **Build v3, by hand:** a printed certificate's QR code scanned with a phone; a Free-plan verified
  certificate with the free mark and the QR code together; the in-browser Merge PDF and Image to PDF
  in Firefox, Safari or on phones (checked in Chromium only); Turnstile on the Bulk tab's preview;
  the 409 active-batch cap, the 403 for too many rows and a real multi-part ZIP in the dashboard
  (unit and route tests only); ZIPs in Windows Explorer and macOS Archive Utility (checked with
  Info-ZIP `unzip`, Python `zipfile` and Java `ZipFile`).
- **Build v3, vendor facts:** the connectors on Zapier, Make and n8n (nothing registered or
  published; `integrations/README.md` lists what each platform's runtime may do differently); the
  email platforms' merge tags (taken from documentation and code each vendor publishes on GitHub,
  not from their help pages; mail clients' image caching not checked); the link-preview platform
  facts on the one-app preview pages beyond the sources their code comments cite.

## Changelog

- **2026-11-28: Chart images on the site** (owner decision: "Chart images (API plus free chart
  maker): 1 credit per new chart, repeat views free"; staging build only, not deployed to
  production). The Worker side (renderer, charging, signed URL, API, free endpoint) is in
  `src/charts/` and `src/routes/charts.ts` behind `CHARTS_ENABLED`. This entry is the site.
  - **Site feature `charts`**, added to `deploy:staging`; `deploy:production` is unchanged, so
    production publishes no chart page, link, sentence, script or OpenAPI path
    (`tests/node/production-site.test.ts`).
  - **Four free pages, one script, one endpoint.** `/tools/chart-maker` (opens on a bar chart),
    `/tools/pie-chart-maker`, `/tools/bar-graph-maker` and `/tools/line-graph-maker` share
    `site/partials/chart-maker.html`, `site/public/assets/js/chart-maker.js` and
    `site/public/assets/css/chart-maker.css`, and post to `POST /api/tools/chart`. A table with add
    and remove for rows and series, pasting a tab- or comma-separated block, title, options, size
    presets (one for 600 pixel wide emails), a preview drawn by the server, "Download PNG" from the
    image already shown and "Copy chart JSON". The preview sends at most one request every two
    seconds, the newest input only; a 429 says when it tries again, a refused chart shows the
    server's message and marks the cell, and the last good image stays. Each page has its own text
    on its chart type, how to enter the data, and what the tool does not do. The image is shown from
    a `blob:` URL, which `img-src` already allowed: no change to the Content-Security-Policy.
  - **`/docs/charts`**: the chart JSON with every field, default and limit (tokens from `CHARTS`,
    `scripts/charts-site-tokens.ts`), signed chart URLs with a Node.js signer, `POST /v1/charts`,
    what counts, the Free mark, an email example, errors and what is not supported.
  - **Elsewhere, with the feature:** the "Chart images" tile (Images, "Free + credits"; the catalogue
    has a new `pages` field so the pie, bar and line pages need no tiles of their own), a "Charts"
    block on `/tools`, a counting rule, a section of `/docs/limits`, the chart scopes of the
    rate-limit table (`CHARTS.rateLimitScopes`), a line on `/pricing` and `/docs/api`, the two
    paths in `openapi.yaml`, and one line of the privacy policy, dated 28 November 2026 with
    `updated.charts`, so production's date does not move.
  - **Checked** in headless Chromium against a local `wrangler dev` at 1366 x 768 and 390 x 844:
    typing, editing a cell, pasting a block, switching type, a refused chart, the download (no second
    request), no horizontal scroll on the phone. Not looked at in Safari or Firefox, or on a real
    phone.
  - **Tests:** `tests/node/charts-site.test.ts` (new); `home-tools`, `production-site` and
    `site-features` follow the new feature.
  Where AI was used: written and checked with AI tools (Claude Code). Ahmad decided the feature and
  reviews the published wording before anything goes to production.
- **2026-11-28: The home page leads with every tool** (owner decision: "compact rows in category
  columns", in the look of the old page; not deployed). The first screen of `/` is a grid of tool
  tiles under the one h1, "Every tool, one click away.": a search box, filter chips with counts, a
  legend, and one column per category (Link previews, Images, PDF files, PDF documents,
  Automation). Under it the page is what it was, in the same order and with the same section ids;
  the old headline is now an h2.
  - **One catalogue.** `site/tools.catalog.ts` lists each tool once (name, phone name, one-line
    description, link, column, label, site features, search words, icon); its header documents the
    format. `scripts/tools-site.ts` prints the chips, the grid and the labels from it at build
    time, as the partials `tool-chips`, `tool-grid` and `tool-label-*`. Adding a tool is one new
    entry. The pictograms are our own drawings in `site/tool-icons.ts`; none is another company's
    mark.
  - **A tile follows the build.** It is printed only when every feature of its entry is on and the
    page it links to is published as launched: a docs page that `apidocs` publishes under its "not
    switched on yet" notice gets no tile. A column or chip without tiles is not printed, and the
    counts are counted. Production (`previews,localpdf,apidocs`) lists 11 tools in four columns,
    the staging list 19 in five.
  - **Labels.** "Free": a page that works without an account, at no cost. "Credits": needs an
    account and uses the plan's images, of which the Free plan has a monthly allowance. "Free +
    credits": a free page, plus an API that uses credits. There is no "Paid" label, because every
    tool listed can be used on the Free plan. The "Free only" chip keeps the tools with a free page
    (the first and the third label), the same tools `/tools` calls free.
  - **Zapier, Make and n8n are one tile**, "The API in a workflow step", linking to
    `/docs/integrations`, because the connectors are not published: three tiles named after the
    platforms would have presented three products that cannot be installed yet.
  - **Script and styles.** `site/public/assets/js/tool-finder.js` (about 3 KB) filters the static
    tiles: typing, the chips (`aria-pressed`), "/" to focus, Escape to clear, a polite live region
    and an empty state. The controls are printed disabled and switched on by the script; where
    scripts cannot run they are hidden (`@media (scripting: none)`) and every tile stays. The CSS
    is section 13 of `site.css`, built from the existing tokens, so the dark scheme follows.
  - **Measured in Chromium** at 1366 x 768, 1440 x 900 and 1280 x 720: every tile of the staging
    list is fully on the first screen and no name or description is cut. At 390 x 844, 16 of 19
    are; every chip is on the first screen. Not looked at in Safari or Firefox, or on a real phone.
  - **Tests:** `tests/node/home-tools.test.ts` (new); `site.test.ts`, `production-site.test.ts` and
    `coming-soon.test.ts` follow the new first screen.
- **2026-11-28: The top-up without a subscription** (owner decision: "$8 top-up without a
  subscription: yes, allow it"; not deployed). A Free account can buy the same one-time top-up as
  Starter and Pro: `topUps` is `true` on the Free plan in `src/billing/plans.ts`. Nothing about the
  top-up changed (price, size, validity, used only after the monthly allowance, never billed
  automatically), nothing in Paddle changed (the same `PADDLE_PRICE_TOPUP`, no catalog or webhook
  change), and nothing else about Free changed: an account that buys a top-up stays on Free, with
  the corner mark, 7 cache days, no custom fonts and the Free limits. Whether images paid by a
  top-up should lose the mark is an open question for the owner; it is not built.
  - **What already worked.** The quota engine and the webhook never looked at the plan: a
    completed top-up transaction credited any account, and a Free account with top-up images
    rendered from them. Only the site and the browser refused the purchase.
  - **Browser.** `checkoutAction` (`site/public/assets/js/checkout.js`) and the dashboard's buttons
    (`billingActions`) read `top_ups` of the account's plan from `/api/config` instead of testing
    for the Free plan. A Free account gets "Upgrade to Starter", "Upgrade to Pro" and "Buy top-up".
    The pricing page now stores what a checkout was for, as the dashboard did: before, a top-up
    started on `/pricing` by an account that stays on its plan would have left the return page
    waiting for a plan change.
  - **Messages.** `src/billing/offers.ts` decides what a 402 `quota_exceeded` message and a quota
    email may offer: an upgrade below the highest plan, and a top-up on a plan with `topUps` only
    while checkout is open on the deployment. While checkout is closed, as in production, the 402
    and the emails of a Free account read word for word as before.
  - **Site.** The pages say who can buy a top-up through the tokens `[[topup.plans]]`,
    `[[topup.keepsPlan]]` and `[[topup.keepsPlanShort]]`, computed from `topUps` and `watermark`
    of each plan, so no page names the plans by hand. Checkout is a switch of the Worker, not of
    the build, so each sentence that says a top-up can be bought ends with a hidden note
    (`data-checkout-closed`: "Top-ups are not on sale yet.", and "(coming soon)" right after the
    price on the plan cards) that `site.js` shows while `/api/config` reports no Paddle
    configuration. The pricing page's notice for that state now reads "Paid plans and top-ups are
    coming soon." Like the "Coming soon" buttons, the notes need JavaScript: without it a page
    reads as if checkout were open.
  - **Terms.** Two lines of section 6, in every build, dated 28 November 2026. Free, before:
    "When the monthly allowance is used up, new images are not rendered until the next month: it
    is a hard stop, and there are no charges." Now: "When the monthly allowance and any top-up you
    bought are used up, new images are not rendered until the next month: it is a hard stop, and
    nothing is charged automatically." Top-up, before: "... extra images, available on paid
    plans. ..." Now: "... extra images, available on every plan, Free included. ..." with one
    sentence added at the end: "A top-up adds images only: it does not change your plan, and
    Free-plan images keep their mark." The privacy policy and the refund policy are unchanged.
  - **Tests.** New: `tests/topup-free.test.ts` (through the Worker: a completed transaction
    credits a Free account; at its limit it renders from the top-up, charged to it, with the same
    bytes as a Free image from the allowance; a PDF paid from it as one block, with the Free
    footer line; the 402 and the emails with checkout open and closed; a refund) and
    `tests/node/topup-site.test.ts` (the built pages of the production, staging and all-off
    builds, the hidden notes and `site.js`, the checkout rule and its memo).
    Changed because the rule changed: `tests/email.test.ts`, `tests/api.test.ts`,
    `tests/pdftools-route.test.ts`, `tests/node/site.test.ts`, `tests/node/dashboard.test.ts`,
    `tests/node/coming-soon.test.ts`, `tests/node/legal-pages.test.ts`.
  - **Not verified.** A real sandbox checkout of the top-up by a Free account. The two halves are
    each proven on staging with other accounts (a Free account's first checkout carries its
    account id; a top-up's `transaction.completed` credits), and the tests replay Paddle's
    example event for a Free account. `scripts/seed-paddle-sandbox.md` section 8, step 5 has the
    check ("Buy a top-up without a subscription"), and GO-LIVE.md section 6 the same check for
    live Paddle.
- **2026-11-27: Owner decisions on analytics and the Terms** (deployed to staging, Worker
  `eea07147`, and production, Worker `65d05a46`, the same day; rollback `bb46082a`). Checked live on
  production: in Chromium the beacon loads and reports on every page tried, with no CSP violation,
  no cookie and no storage. Every built page is served byte for byte. The Terms show the
  counterfeit rule and 27 November 2026, and the privacy policy names Web Analytics. The earlier
  production checks still pass, and every switch, `CHECKOUT_ENABLED` included, is still `"false"`.
  - **Web Analytics.** The site's CSP allows Cloudflare Web Analytics, which the zone injects:
    `script-src https://static.cloudflareinsights.com`, `connect-src https://cloudflareinsights.com`.
    It reports to `/cdn-cgi/rum` on the same origin. The privacy policy names it as cookieless
    website statistics in section 2, in Cloudflare's row in section 4 and in the summary, which no
    longer says "we do not use analytics". Section 3 adds the statistics' country as the one use of
    IP addresses beyond security. Its date stays 27 November 2026. Checked in Chromium before the
    deploy, on the pages under `site/public/_headers`: the beacon loads and reports (204) with no
    CSP violation, no console error, no `Set-Cookie` and nothing in local or session storage. It
    reports page addresses and referrers without their query string. On `/v/` pages their own
    no-script policy blocks it, and the browser logs one CSP violation there (`/v/` is left as is).
  - **Terms.** The rule against counterfeit or misleading documents is in every build, dated 27
    November 2026. The suspension on report and "and other files" still wait for PDFs. The four
    `updated.<feature>` dates of the terms are gone: the page's own date is later in every build.
  - **Tests changed because the decisions changed behaviour:** `tests/node/legal-pages.test.ts`
    (production Terms are `89270a7` plus that one line, every legal date, the privacy lines that
    differ from `89270a7`, and new cases for the CSP and the analytics wording),
    `tests/node/site-features.test.ts` (the counterfeit rule is in every build) and
    `tests/node/site.test.ts` (the pinned `script-src`).
  - **Staging.** The two throwaway test accounts of the launch checks were marked for deletion.
    The daily clean-up deletes them with their files and records.

  Where AI was used: written and checked with AI tools (Claude Code) and independent AI
  reviewers. Ahmad decided both changes and reviews the published wording.
- **2026-11-27: Fixes from the live audit of that day's deploy** (deployed to staging, Worker
  `909574bd`, and production, Worker `bb46082a`, the same day; checked live: on both sites every built
  page is served byte for byte, and the legal, docs, `/v/` and revoke answers are the ones above; on
  staging, 10 simultaneous first opens of one value at 24 of 25 slots all got that value, 1 image
  counted, 1 slot taken, and the next value got the default card). An independent audit of the live sites confirmed six issues, and
  each fix was reviewed adversarially:
  - **Terms (F4).** Production had published the counterfeit-documents rule, the "always
    urgent" suspension and "and other files" under the old 25 November date. They are now `pdf`
    text that goes live with PDFs. The production Terms are again the `89270a7` text, and the
    test pins its git blob.
  - **Privacy (F4).** It keeps its two wording changes, which are true in production, and shows
    27 November through a new `updated:` front-matter key. Legal pages show the latest of
    `legalUpdated` and their own dates, so the staging Terms show 26 November for their v3 text.
  - **Docs (F1, F2, F3).** The production `/docs/bulk` and `/docs/pdf-tools` no longer point to an
    OpenAPI description that does not cover them. They state their real rate limits, and the toolkit
    limit comes from `RATE_LIMITS` through `[[toolkit.rateLimit]]`. The bulk preview no longer names
    a free PDF tool that production does not publish.
  - **Verification pages (F5).** The `/v/` "Verification unavailable" page and the not-found page
    without an ID no longer declare a canonical URL or `og:url`.
  - **Revoke routes (F6).** `POST /v1/certificates/{id}/revoke` and `/api/certificates/{id}/revoke`
    check `BATCH_ENABLED` before the rate limiter, key or session, so they answer 503
    `not_configured` while it is off, as `/v1/batches` does.
  - **Daily cap of email images (CHG-1, staging only, since `EMAIL_FIELDS_ENABLED` is off in
    production).** The cap now counts images, not requests. Before, simultaneous first opens of one
    value each held a slot while they rendered, so near the cap some readers of that value got the
    default card. The
    privacy text on staging now says what is kept: one-way hashes per site and day, not a count.
  - **Build.** It refuses `batch` or `toolkit` without `pdf`.

  Tests changed because a decision changed behaviour:
  - `tests/node/site-features.test.ts`: the counterfeit clause is expected in the PDF build only.
    Builds of `batch` or `toolkit` alone now add `pdf`, here and in `v3-site.test.ts` and
    `client-pdf-pages.test.ts`.
  - `tests/node/dashboard-bulk.test.ts`: the pinned revoke route line.
  - `tests/node/v3-site.test.ts`: the email privacy sentence.
  - `tests/email-fields.test.ts`, `email-charge-once.test.ts` and `email-fields-route.test.ts`: the
    storage of the daily cap. No assertion was weakened.

  New tests: `tests/email-daily-cap.test.ts`, `tests/node/legal-pages.test.ts`,
  `tests/node/production-docs-claims.test.ts` and `tests/node/email-daily-cap-privacy.test.ts`, plus
  new cases in `tests/verify-page.test.ts` and `tests/email-fields.test.ts`. Each new file fails
  against the code before the fix. A few cases are regression guards that pass before and after:
  production stays without the email sentence, a raised `legalUpdated` wins, and revocation is
  unchanged with `BATCH_ENABLED` on.

  Where AI was used: the audit, fixes and reviews were written with AI tools (Claude Code); Ahmad
  reviews before release.
- **2026-11-27: Owner decisions after build v3** (deployed to staging and production the same day). Production
  publishes only the approved free pages: `deploy:production` now builds the site with
  `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off` (the tools hub, the five one-app preview
  checkers, Merge PDF and Image to PDF in the browser, and the docs pages of bulk documents, the PDF
  toolkit, cards from links and email images, each with a "Not switched on yet" notice, `noindex`;
  the connectors page `/docs/integrations` stays out of production). Two new site features, `localpdf` and `apidocs`, and the
  `unlaunched` front-matter key. Every v3 Worker switch and `PDF_ENABLED` stay `"false"` in
  production; Paddle, the webhook and `CHECKOUT_ENABLED` are unchanged; the connectors are not
  published. Email images are counted once per unique image: repeat opens cost nothing and a copy
  that expired is rendered again uncharged for `EMAIL_FIELDS.chargeMemoryDays` (400 days), recorded
  in `tool_usage` (no migration). The five social starter templates refuse the `email` size
  (1200 x 400) on the server with 400 `invalid_request` / `size_not_supported`, in the API, signed
  URLs, link cards and the dashboard's signing and preview; the dashboard's size picker offers a
  starter only the sizes it is laid out for (`GET /api/templates` sends each starter's `sizes`). The
  verification page's footer is the
  static site's own, with the new tool links. Every other number is unchanged (bulk limits, 1 image
  per started 10 toolkit pages, toolkit limits, certificate price). After review: an email image's
  charge record is written only inside the D1 batch that takes the image, so it exists if and only
  if the image was charged (before, a twin open of a claim that then failed for want of images
  remembered an unpaid image for 400 days, and a failed record write let one image be charged
  twice); the dashboard lists a free re-render as "Not counted (paid before)"; Merge PDF and Image
  to PDF no longer offer "Automate this with the API" where the toolkit is off; and the docs pages
  production publishes no longer send readers to pages it does not publish without saying so (the
  bulk and toolkit pages leave those sentences out; the email page's notice says that its guide is
  not published yet). Tests changed because a
  decision changed behaviour: `tests/email-fields-route.test.ts` (`POST /v1/images` with `blog` at the `email`
  size now expects 400, and inline HTML at that size still 200) and the deploy-script, feature-list
  and front-matter pins of the Node suite; after review, `tests/email-charge-once.test.ts` ("the
  record is written from a paid ledger row only, and restored from one charged before it existed"
  now asserts that a duplicate render writes no record, so an image charged before charge-once is
  charged once more after its row expires), `tests/node/client-pdf-pages.test.ts` (the no-toolkit
  page asserts that the API link is absent instead of present), `tests/node/production-site.test.ts`
  (no exemption for that link) and `tests/dashboard-api.test.ts` (starters carry `sizes`); none was
  weakened. Where AI was used: written with AI
  tools (Claude Code) by two parallel builders (site and cards) and an integration pass that wrote
  the docs and ran every suite, the dry runs and browser screenshots of the production site build;
  Ahmad reviews before release.

- **2026-11-26: Build v3 tools** (not deployed; every new Worker switch is `"false"` in production and
  production deploys build the site with no new feature). Bulk documents from rows through a
  Cloudflare Queue with ZIP downloads in parts and optional certificate verification pages
  (`/v1/batches`, `/v/{id}`, `/v1/certificates/{id}/revoke`, the dashboard's **Bulk documents** tab);
  a PDF toolkit without a browser (`/v1/pdf-tools/{op}`: merge, split, stamp, fill, fields,
  from-images, protect); cards from links (`/v1/cards/from-url`, `/v1/link/...`); personalized email
  images (open fields in signed card URLs, two email starters, the `email` size); connectors for
  Zapier, Make and n8n in `integrations/` (not published); and free pages (`/tools`, five one-app link
  preview checkers, in-browser Merge PDF and Image to PDF). New: migration `0008_batches.sql`, a
  queue per environment (`linktocard-batch-dev`, `-staging`, `-production`, which must be created
  before the next deploy of each), the `RL_PDF_TOOLS` limiter, four switches (`BATCH_ENABLED`,
  `PDF_TOOLKIT_ENABLED`, `LINK_CARDS_ENABLED`, `EMAIL_FIELDS_ENABLED`), the `SITE_FEATURES` build
  list, and dependencies `@cantoo/pdf-lib` 2.11.1 and `uqr` 0.1.3 (dev: `pdf-lib` 1.17.1, `esbuild`
  0.28.2), all exact. The docs, OpenAPI description, counting rules, limits, terms and privacy policy
  describe each tool behind its own site feature; built with every feature off, as production
  builds it, the site differs from the last release only by the `email` size in the size lists
  (also in the dashboard's size picker) and one sentence of the published OpenAPI description, and
  the terms and the privacy policy are unchanged. Decisions D1-D13 of the merge
  plan are in the code and the docs. Where AI was used: written with AI tools (Claude Code) by
  parallel builders, an integration pass, separate route, dashboard and connector passes and a
  docs alignment pass, each checked by its own tests; Ahmad reviews before release.

- **2026-11-26: PDF fixes after checking the round-3 fixes** (not deployed; PDFs are still off
  in production). CSS: an unquoted `url(` with `(` or a quote in it is removed with its
  declaration, and a rule with `url(` in its selector or at-rule prelude is removed: Chrome ends
  such a `url(` at its first `)`, so an `@page`, `@import` or remote `@font-face` behind it
  reached the browser unseen (a gap since the first PDF release). Failed renders of signed links
  also count for all sites of an account together (`PDF.maxFailedSignedRendersPerDay`), so a
  deleted and re-created site no longer starts a new count. Renders still running are told
  apart from failures: when they hold the last places the answer is a 429 of a few seconds that
  says so, and `HEAD` ignores them. A request that claims a PDF after waiting is dated at its
  claim; a paid PDF whose stored file is missing is rendered again by one request only; waiting
  requests of signed links pay the site's rate limit and read the ledger read-only. The free
  brake counts each render by the plan it was made on: migration
  `0007_browser_usage_plan.sql` (one nullable column; apply it before the next deploy, see
  GO-LIVE.md). The API reference's error list and the PDF guides now say how PDF failures are
  remembered and counted. Where AI was used: written with AI tools (Claude Code) after a
  separate AI verification pass; Ahmad reviews before release.
- **2026-11-26: PDF fixes after the second review** (not deployed; PDFs are still off in
  production). Free-plan headers and footers are printed as plain text with page numbers in a
  fixed style next to the mark, so no customer markup shares Chrome's footer with it; `@page`
  after `<!--` or `-->` is dropped like any other `@page`. A PDF over `PDF.maxPdfBytes` (20 MB)
  is refused with 422 and never buffered past that size; the page counter reads only windows of the file. One
  deadline covers the whole browser call. Identical requests wait for one render instead of
  rendering again. The daily failed-render cap counts only the document's own failures and
  402s after rendering, per account for `POST /v1/pdf` and per site for signed links, reserved
  before the browser runs; Browser Run's own failures never count. A failed document is
  remembered for `PDF.failedRenderMemoryMs` (10 minutes) and answered without rendering. The
  free brake counts the browser time of Free accounts and the free tools only. `HEAD` of a
  signed link answers what the `GET` would answer before rendering. No migration. Where AI was
  used: written with AI tools (Claude Code) by three parallel owners and an integration pass,
  after a second round of separate AI reviews; Ahmad reviews before release.
- **2026-11-25: PDF documents from HTML templates** (on staging; off in production until Ahmad approves).
  `POST /v1/pdf`, signed `/v1/pdf/...` links, stored PDFs under `/i/`, five PDF starter templates,
  `/docs/pdf`, three free tools and three guides, all behind `PDF_ENABLED` and the `SITE_PDF`
  site switch. Printed by Cloudflare Browser Run with JavaScript off and no network access;
  card images are still drawn without a browser. A PDF counts as images by its pages, charged as
  one block. New: migration `0006_pdf.sql` (production already has `0005`; apply `0006` before the next production
  deploy of any kind: `/api/me` and the daily cron read its tables even with PDFs off), three rate limiters
  (`RL_PDF_KEY`, `RL_PDF_FREE`, `RL_TOOLS_PDF`), the `BROWSER` binding on staging and production,
  `PDF_DAILY_BROWSER_MS_BUDGET` and a daily alarm email. The terms now forbid counterfeit or
  misleading documents (first in both site builds; since the owner decision of 2026-11-27 this rule,
  with the suspension on report, is `pdf` text that goes live with PDFs, and production keeps the
  Terms of `89270a7`). Where AI was used: the code, tests,
  templates, docs and copy were written with AI tools (Claude Code), in three parts with an
  integration pass, then reviewed by separate AI reviewers (security, billing, operations, content)
  whose confirmed findings were fixed, and checked with real renders on staging. Ahmad reviews
  before release.
- **2026-11-25: Free OG checker** (`/tools/og-checker`, `/v1/inspect`, five guides, `/bot`). The
  Worker fetches one public page on request (https only, 5 s, 2 MB, 3 redirects, private and
  metadata addresses refused, User-Agent `LinkToCardBot/1.0`), parses its share tags, probes the
  image and returns a checklist; images are shown through a proxy keyed by the check id, never by
  URL. 20 uncached checks per hour per IP; Turnstile after 5 once `TURNSTILE_SECRET_KEY` is set
  (GO-LIVE.md section 9b). Where AI was used: the code, tests, guides and copy were written with
  AI tools (Claude Code); a separate AI review attacked the fetch path and its fixes are tested.
  Ahmad reviews before release.

## Where AI was used

All of it. The code, tests, site design, documentation, legal page drafts and research
notes in this repository were written with AI coding tools (Claude Code), working from
Ahmad Shaaban's written build request. Ahmad reviews every deliverable before it ships and
submits every account application himself.

What that means in practice:

- The legal pages are drafts, not legal advice. Have them read before relying on them.
- `research/` holds the AI-written working notes behind the factual claims, each with its
  own "unverified" list.
- The site footer says that AI tools were used.

## Licences and attribution

- Bundled fonts: Inter, Source Serif 4 and JetBrains Mono, each under the SIL Open Font
  License 1.1 (from the `@fontsource` packages).
- Build v3: @cantoo/pdf-lib (MIT; with culori, fflate and node-html-better-parser, MIT), uqr (MIT);
  in the browser bundle pdf-lib with @pdf-lib/standard-fonts, @pdf-lib/upng and pako (MIT) and tslib
  (0BSD), whose licence texts travel in `pdf-local.js`; esbuild (MIT) builds it.
- Emoji graphics: [Twemoji](https://github.com/jdecked/twemoji), CC-BY 4.0. The site
  footer carries the attribution.
- Satori and resvg-wasm are MPL-2.0. jSquash is Apache-2.0. Hono, htmlparser2, harfbuzzjs
  and marked are MIT. domhandler and domutils are BSD-2-Clause.

This project's own licence is not set. Until Ahmad adds one, all rights are reserved.

## Maintenance notes

- **Satori is pinned to 0.63.2 on purpose.** `src/render/satori-workerd-shim.ts` makes it
  start inside `workerd` by answering two specific WebAssembly compilations with
  precompiled copies. An upgrade of `satori` or `harfbuzzjs` must be followed by
  `npm test` and `npm run smoke`; the shim fails loudly if the bytes no longer match.
- All dependency versions are exact. Upgrade one at a time.
- Prices and quotas change in `src/billing/plans.ts` only, and then in the Paddle catalog.
- The daily cron (`src/lib/cleanup.ts`) removes expired sessions, sign-in tokens and
  stored images, and purges accounts marked for deletion. Since build v3 it also fails batch rows
  stranded for `BATCH.staleAfterDays`, deletes finished batches whose last PDF has expired, deletes
  revoked certificate records after `BATCH.revokedRetentionDays`, and deletes a deleted account's
  batches and certificate records before its users row.
- The connectors keep copies of the service's sizes, formats and PDF templates; change the Worker
  first, then `integrations/*`, and let the three `tests/node/*-connector-sync.test.ts` say what drifted.
- Database changes are numbered files in `src/db/migrations/`. Apply new ones with
  `npx wrangler d1 migrations apply DB --env <env> --remote` before deploying the code that
  needs them.

## Layout

```
src/index.ts            Worker entry: routes, error handling, cron
src/routes/             HTTP routes (og, pdf, api, images, playground, dashboard, studio, auth, tools, webhooks; batches, verify, pdf-toolkit, link)
src/render/             template language, CSS handling, Satori/resvg engine, image proxy, fonts
src/render/templates/   the five starter templates, and the two email starters
src/pdf/                PDF documents: template language, sanitiser, fonts, images, Browser Run call
src/pdf/templates/      the five PDF starter templates
src/batch/              bulk documents: rows, store, queue consumer, ZIP parts, certificates, verification page
src/pdftools/           the PDF toolkit operations (@cantoo/pdf-lib)
src/cards/              cards from links
src/lib/                signing, quota, images service, email, rate limits, cleanup
src/auth/               magic links, sessions, API keys, middleware
src/billing/            plans and Paddle
src/db/migrations/      D1 schema
site/                   pages, layouts, partials, Markdown content, static assets
site/tools.catalog.ts   every tool the home page lists, one entry each (icons: site/tool-icons.ts)
site/partials/chart-maker*.html  the free chart maker, shared by the four chart pages (script: assets/js/chart-maker.js)
src/charts/             chart images: validation, renderer, signed URLs, charging (routes: src/routes/charts.ts)
site/src-browser/       the in-browser PDF engine, bundled by scripts/build-browser-bundles.mts
scripts/                site build, sample renders, smoke test, Paddle catalog instructions
integrations/           Zapier, Make and n8n connectors, each its own package (not published)
examples/signing/       signed-URL examples in Node, PHP and Python
tests/                  Workers-runtime tests; tests/node/ for Node tests
research/               working notes behind the factual claims
openapi.yaml            API reference
GO-LIVE.md              the checklist for going live
```
