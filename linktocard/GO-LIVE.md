# Go-live checklist

Everything here is done by Ahmad, in accounts that are in Ahmad's own name. Nothing in this
repository holds a secret; every key is typed into Cloudflare or Paddle directly.

Work top to bottom. Step 0 decides whether the rest is worth doing.

## 0. Go / no-go: can Paddle pay out to you? (do this first, it is free)

This is the one risk that can make the whole project pointless, and it could not be verified
from documentation.

What is known (from Paddle's published pages, read through search excerpts, not first-hand):

- Lebanon is **not on Paddle's list of unsupported seller countries**. No Paddle page says
  "Lebanon is supported" either. Support is by absence from the exclusion list.
- Paddle accepts individuals (no company needed) after identity verification.
- Payouts are monthly, by **wire transfer or Payoneer**, with a $100 minimum and a $15 fee
  on international (SWIFT) wires. No payout in LBP.

What is **not** known:

- Whether Paddle will actually approve an individual resident in Lebanon.
- Whether a USD wire from Paddle arrives in a Lebanese bank account, or whether Payoneer is
  usable for you.

Before buying the domain or paying for anything:

- [ ] Create the Paddle account as an individual, country Lebanon, and complete identity
      verification.
- [ ] Ask Paddle support in writing: "Do you onboard individual sellers resident in Lebanon,
      and can you pay out by USD wire to a Lebanese bank or to Payoneer?" Keep the answer.
- [ ] Ask your bank (and Payoneer, if you plan to use it) whether inbound USD from a UK
      payments company is accepted on your account.

If any answer is no, stop here. The product cannot collect money without Paddle (the build
request rules out every other processor).

## 1. Accounts to open

- [ ] **Cloudflare** account. Subscribe to **Workers Paid** ($5/month): rendering an image
      takes 100-400 ms of CPU and the free plan allows 10 ms per request, so the free plan
      cannot run this service, not even for staging renders.
- [ ] In Cloudflare, enable **R2** (free allowance: 10 GB storage; it asks for a payment
      method).
- [ ] **Domain** `linktocard.com` on your Cloudflare account (registered there or moved to
      Cloudflare nameservers). Optional: `link2card.com` as a redirect.
- [ ] **Resend** account. Add and verify the domain `linktocard.com` (DNS records Resend
      shows you). Sign-in emails are sent from `login@linktocard.com`.
- [ ] **Paddle**: a sandbox account (instant) and the live account from step 0.
- [ ] A working inbox for `support@linktocard.com`. Cloudflare Email Routing can forward it
      to your own mailbox for free.

## 2. Your legal name and address

Paddle's domain review checks that the seller named in the terms matches the Paddle account.

- [x] **Done 2026-11-23.** `site/site.config.json` names the seller as Ahmad Shaaban, trading
      as Link To Card, Nahr Street, Shehim, Chouf, Lebanon, contact support@linktocard.com. The
      terms, privacy policy and refund policy show all three; every page's footer reads
      "© 2026 Link To Card · Ahmad Shaaban · Shehim, Chouf, Lebanon · support@linktocard.com" with
      links to Terms, Privacy, Refunds and Pricing. Pricing, terms and refund policy state that
      Paddle is the Merchant of Record and handles payments and taxes. Verified live on staging.
- [ ] Check that the name matches your Paddle account exactly (Paddle compares them). If Paddle
      shows it differently, change `legalName` and redeploy.
- [x] `npm run check:golive` passes: no placeholder is left on any page.
- [ ] Read `/terms`, `/privacy` and `/refund` in full. They are drafts written with AI
      assistance. The choices that are yours to confirm are listed in README.md under
      "Assumptions to confirm". Have a lawyer read them if you can.

## 3. Staging deploy (Paddle sandbox)

**Done on 2026-11-22** in the Cloudflare account Names On Base: D1 `linktocard-staging`
(migrations 0001-0004 applied), R2 bucket `linktocard-staging`, the Worker at
https://linktocard-staging.names-on-base.workers.dev, and `SIGNING_MASTER_SECRET` set to a
random value that nobody has seen. That is fine: the dashboard shows each site's own secret,
and the master key is only ever needed by the Worker. Never change it while staging URLs
should keep working. A throwaway test account used for the live check is purged by the daily
cleanup. Also done on 2026-11-22: `RESEND_API_KEY` (sign-in mail verified in a real inbox), and
the Paddle sandbox catalog, client token, default payment link and webhook destination, created
through the Paddle API exactly as `scripts/seed-paddle-sandbox.md` describes, with both Paddle
secrets set. A sandbox checkout, plan switches, a top-up, the portal link and a period-end
cancellation were run on staging and worked. The commands are kept for reference:

```sh
npm install
npx wrangler login

npx wrangler d1 create linktocard-staging        # paste the printed id into wrangler.toml, [env.staging]
npx wrangler r2 bucket create linktocard-staging
npx wrangler d1 migrations apply DB --env staging --remote

npm run deploy:staging                            # prints https://linktocard-staging.<subdomain>.workers.dev
```

- [ ] Put the printed URL into `APP_URL` under `[env.staging.vars]` in `wrangler.toml`.
- [ ] Set the secrets (each command asks for the value; nothing is written to disk):

```sh
npx wrangler secret put SIGNING_MASTER_SECRET --env staging   # a long random string, e.g. `openssl rand -base64 48`
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put PADDLE_API_KEY --env staging          # sandbox key
npx wrangler secret put PADDLE_WEBHOOK_SECRET --env staging   # sandbox notification secret
```

- [ ] Follow `scripts/seed-paddle-sandbox.md` to create the sandbox catalog, then paste the
      client token and the three price ids into `[env.staging.vars]`.
- [ ] `npm run deploy:staging` again.
- [ ] Check the live deployment: `npm run check:deploy -- https://linktocard-staging.names-on-base.workers.dev`
      (for a minute or two after a deploy, Cloudflare may still serve some pages from its cache;
      re-run before reading a failure as real)
      (public pages, headers and five real renders). After you can sign in, create a test API key
      and site and run it again with `LTC_API_KEY`, `LTC_SITE_ID` and `LTC_SITE_SECRET` set for the
      full check.
- [ ] Sign in on staging, create a site, open a signed URL, see the image.
- [ ] Do one sandbox checkout for Starter with a Paddle test card and confirm the dashboard
      shows the Starter plan within a minute. **This has never been run**: the test suite
      only replays correctly signed copies of Paddle's published example events.
- [ ] Cancel the sandbox subscription from the billing portal and confirm the account stays
      on Starter until the period end, then returns to Free.
- [ ] Open the browser console during checkout. If Paddle's overlay is blocked, the
      Content-Security-Policy line in `site/public/_headers` needs the missing host added.

`SIGNING_MASTER_SECRET` must never change once customers have signed URLs: every site secret
is derived from it. Store it in a password manager.

Note: `*.workers.dev` blocks some automated clients (Cloudflare's Browser Integrity Check
cannot be turned off there). Staging is for your own testing. Production must use the real
domain.

## 4. Production deploy

> **Before the next production deploy, whatever it is for** (opening checkout in section 6,
> Turnstile in 9b, a copy fix): apply every pending migration first,
> `npx wrangler d1 migrations apply DB --env production --remote`. Production was set up at
> 0001-0004 and got `0005_og_checks.sql` with the OG checker; on 2026-11-26 `0006_pdf.sql`
> (`pdf_usage`, `browser_usage`) and `0007_browser_usage_plan.sql` (one nullable column,
> `browser_usage.plan`) are pending. The code reads the tables of `0006` even with PDFs switched
> off (and degrades to zero PDF usage without them); the column of `0007` is used only while
> PDFs render (without it the browser time is still recorded, without the plan, and the error log
> names the migration). They only create tables, indexes and that column. `npx wrangler d1 migrations list DB --env production --remote` shows what is pending.
>
> Since build v3 (2026-11-26), two more things come first, whatever the deploy is for: the
> migration `0008_batches.sql` (tables `batches`, `batch_rows`, `certificates`; the routes use them
> only while `BATCH_ENABLED` is `"true"`, and the daily cleanup skips them while they are missing), and
> the production queue, which `wrangler.toml` binds as `BATCH_QUEUE`:
> `npx wrangler queues create linktocard-batch-production`. Without the queue, `npm run deploy:production`
> fails. Section 11 has the details.

**Done on 2026-11-23**, with checkout off until live Paddle is approved:

- D1 `linktocard-production` (migrations 0001-0004), R2 bucket `linktocard-production` with
  the two expiry rules below, the Worker on https://linktocard.com, and a separate Worker
  `linktocard-www-redirect` (`redirect/`, `npm run deploy:www`) that answers every
  `www.linktocard.com` request with a 301 to the same path on `linktocard.com`.
- Secrets: `SIGNING_MASTER_SECRET` (a random value nobody has seen, different from staging;
  see the note in section 3) and `RESEND_API_KEY`. **No Paddle secret and no Paddle value is
  set**, so `/api/config` reports no Paddle configuration and the pricing buttons say
  "Coming soon". The Free plan and sign-in work normally.
- DNS: Cloudflare added one proxied `AAAA 100::` record each for `linktocard.com` and
  `www.linktocard.com` (Worker custom domains). The email records (Resend, Email Routing,
  DMARC) were not touched.
- Verified live: every page loads with the seller details and the Paddle wording;
  `npm run check:deploy` passed with a throwaway account (all templates, the API in three
  formats, a signed image, caching, counting); a sign-in email to a real address was
  accepted by Resend with no error; a browser sign-in, the dashboard and sign-out worked;
  `www` redirects. The throwaway account
  is removed by the next daily cleanup.

The commands, for reference or a rebuild:

```sh
npx wrangler d1 create linktocard-production      # paste the id into wrangler.toml, [env.production]
npx wrangler r2 bucket create linktocard-production
npx wrangler d1 migrations apply DB --env production --remote
npm run deploy:production                          # runs the placeholder check first
```

- [x] Secrets `SIGNING_MASTER_SECRET` and `RESEND_API_KEY` with `--env production`. The live
      Paddle key and webhook secret come in section 6.
- [x] Backstop for storage: expired images are deleted by a daily job; these rules remove
      anything it misses.

```sh
npx wrangler r2 bucket lifecycle add linktocard-production expire-renders r/ --expire-days 100
npx wrangler r2 bucket lifecycle add linktocard-production expire-playground p/ --expire-days 2
```

- [ ] Optional: a Cloudflare redirect rule from `link2card.com` to `https://linktocard.com`.

### 4a. Zone settings to change by hand (the deploy token cannot change zone settings)

- [ ] **Always Use HTTPS: on.** SSL/TLS > Edge Certificates. It was off at deploy time, so
      `http://linktocard.com` served pages without redirecting to HTTPS.
- [ ] **Minimum TLS version: 1.2.** Same page. It was 1.0.
- [x] **Web Analytics: on** for linktocard.com (owner decision of 2026-11-27; it had been on
      with automatic setup). Cloudflare injects its beacon script into the pages for browsers,
      `site/public/_headers` allows it, and the privacy policy names it. Checked in Chromium on
      2026-11-27: the beacon loads, reports to `/cdn-cgi/rum` (204), and sets no cookie or storage.
      Verification pages keep a policy without script, so it is blocked there. If you turn it off
      later, change the privacy policy's sentences that name it.
- [ ] Check the certificate: open https://linktocard.com and https://www.linktocard.com in a
      browser and look at the padlock. (The deploy session could not see the real certificate:
      its network proxy re-terminates TLS, and the token has no SSL read permission.)
- [ ] Optional later: HSTS (same page), once you are sure the site will stay on HTTPS.

## 5. Spending cap (do this on the day you deploy)

Cloudflare has no exact hard cap. Use all three layers:

- [ ] **Workers spending limit**: Cloudflare dashboard > Billing > Spend Management >
      Workers > set a monthly limit (for example $20) with blocking enabled. When reached,
      Cloudflare stops running the Worker (visitors see error 1103; static pages keep
      working). It reacts with a delay, so the bill can end slightly above the limit, and it
      does **not** cover R2 or D1.
- [ ] **Budget alert**: Billing > Billable Usage > create a budget alert (for example $10).
      Email only, arrives the next day, but it is the only alert that includes R2 and D1.
- [ ] Already in the code: a per-request CPU ceiling (`limits.cpu_ms` in `wrangler.toml`),
      rate limits per IP, per key and per account, and hard monthly quotas per customer.

Month-one cost with no customers: Workers Paid $5 plus the domain. R2 and D1 stay inside
their included allowances at this scale. Paddle has no monthly fee; it keeps a percentage of
each sale (check the current rate on Paddle's pricing page).

## 6. Paddle live

**State on 2026-11-23: live account and code ready; checkout closed until Paddle approves the domain.**

Done through the Paddle API with a temporary setup key (additive only, nothing edited or deleted):

| | Sandbox | Live |
| --- | --- | --- |
| Starter, $9/month | `pri_01m82bzchs8tna3fz949myr8fm` | `pri_01m84q5rxc7p4wemzgrmca6fg8` (product `pro_01m84q5rd785vnyj56k43d9dzb`) |
| Pro, $29/month | `pri_01m82bzcsrnsf4143bxmahcqpx` | `pri_01m84q5s5x5bwwdkj1rca0dc5d` (product `pro_01m84q5s1nzx5t7p3fzcmyrgkz`) |
| Top-up, $8 one-time | `pri_01m82bzd1t7wfsswxz18b9e81z` | `pri_01m84q5se0b8mmt14heam77enr` (product `pro_01m84q5s9m8n35sxnkv06bvcbk`) |

All prices: USD, tax added on top (`tax_mode: external`), quantity exactly 1. No discounts exist in
live. Client-side token `live_af7ed7091e4363c559f5abbf6fc` ("Link To Card production"). Notification
destination `ntfset_01m84q5ss0c74z9e6es9g2bpdx` -> `https://linktocard.com/webhooks/paddle`, the 11
events, traffic source "all"; its secret is the production `PADDLE_WEBHOOK_SECRET` (never recreate the
destination: that would rotate the secret). Payment methods: card, PayPal, Apple Pay (Bancontact
turned off). Live tax mode `location` and balance currency USD were read and left unchanged; every
price carries its own `external` tax mode, so the account default does not change what customers pay.

Production Worker: live token and price ids in `wrangler.toml`, `PADDLE_ENV = "production"`,
`PADDLE_API_KEY` (a live key with only `customer_portal_session.write` and `subscription.write`;
checked with a request that creates nothing) and `PADDLE_WEBHOOK_SECRET` as secrets,
`CHECKOUT_ENABLED = "false"`. Webhooks are accepted only from Paddle's live addresses (`GET
https://api.paddle.com/ips`, fetched by the Worker); a non-Paddle sender gets 403. Paddle Retain is
not used: Paddle.js tries to load Retain's script on live accounts and the CSP blocks it.

Left to do, in order:

- [ ] Wait for website approval of `linktocard.com` (submitted; `pending_review` on 2026-11-23). Then
      check Apple Pay's status for the domain on the same page (it read `unverified` while in review).
- [ ] After approval: set the default payment link to `https://linktocard.com/pricing`
      (`PATCH /settings/checkout-url`, or Checkout > Checkout settings).
- [ ] After approval: apply pending migrations (the note at the top of section 4), set
      `CHECKOUT_ENABLED = "true"` in `[env.production.vars]` and `npm run deploy:production`.
      The buttons stop saying "Coming soon".
- [ ] Bank details: Business account > Payouts > Payout settings.
- [ ] Delete the temporary setup key once nothing more is needed from it.


- [ ] Recreate the catalog in the **live** Paddle account with exactly the names and prices
      in `scripts/seed-paddle-sandbox.md` (the pricing page must match the catalog).
- [ ] Create the live notification destination pointing at
      `https://linktocard.com/webhooks/paddle` with the same events.
- [ ] Submit `linktocard.com` for **website approval** in Paddle. The site must already be
      live on the real domain with your legal name on it. Live checkout does not work until
      the domain is approved.
- [ ] After approval: set the default payment link to `https://linktocard.com/pricing`.
- [ ] Put the live client token and price ids into `[env.production.vars]`, set
      `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET` (live values) as secrets, deploy.
- [ ] Set your payout method and threshold in Paddle. A higher threshold means fewer $15
      wire fees.
- [ ] Buy your own Starter plan with a real card, check the plan flips, then refund it from
      Paddle. That proves checkout, webhook, entitlement and refund on live.

## 7. After launch

- [ ] Look at the `webhook_events` table weekly at first:
      `npx wrangler d1 execute DB --env production --remote --command "SELECT result, COUNT(*) FROM webhook_events GROUP BY result"`.
      `error:...` rows mean a webhook failed. `ignored:no_user` on a paid top-up means a
      customer paid and was not credited: fix it by hand and refund or credit them.
- [ ] Changing a price id later orphans existing subscribers on the old price. Add a new
      price only together with a code change.

## 8. Deleting an account on request

The terms and the privacy policy promise deletion when a customer emails support. Check that the
request comes from the account's own email address.

- [ ] If the account has a paid subscription, cancel it in the Paddle dashboard first (and refund
      it if the refund policy applies). Deleting the account does not stop Paddle from billing.
- [ ] Mark the account. This suspends it at once (API keys, signed URLs and the dashboard stop
      working) and queues it for the daily cleanup. Stored addresses are lower-case; the command
      lower-cases what you paste. It must print exactly one row (the account's id and email). No
      row means nothing was marked: retype the address in lower case and run it again.

```sh
npx wrangler d1 execute DB --env production --remote --command "UPDATE users SET suspended_at = CAST(strftime('%s','now') AS INTEGER) * 1000, suspended_reason = 'deletion requested', deletion_requested_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE email = lower(trim('customer@example.com')) RETURNING id, email"
```

- [ ] The next daily cleanup (03:17 UTC) deletes the account's rendered images and fonts from R2,
      then every database row of the account: sites, keys, templates, fonts, usage, top-ups,
      rendered-image and stored-PDF records, PDF counts, sessions, sign-in requests and its
      webhook log entries, and (since build v3) its batches, their rows and its certificate
      records, whose verification pages answer 404 from then on. Its rows of PDF browser time stay, without the account id, until they
      age out (`PDF.browserUsageRetentionDays`). An account
      with more than 6,000 stored images takes one more day per 6,000.
- [ ] Confirm the next day that the row is gone, then reply to the customer:
      `npx wrangler d1 execute DB --env production --remote --command "SELECT COUNT(*) FROM users WHERE email = lower(trim('customer@example.com'))"`
- [ ] Copies already cached at Cloudflare's edge or in browsers expire within 24 hours. Paddle
      keeps its own order records as Merchant of Record; deletion there is requested from Paddle.

## 9. Privacy policy upkeep

- [ ] The privacy policy names the outside companies that process personal data (Cloudflare,
      Resend, Paddle). Whoever hosts the `support@linktocard.com` mailbox also receives personal
      data (contact-form messages and support email). Once you have chosen it, add it to
      `site/content/privacy.md` and rebuild. If it is Cloudflare Email Routing forwarding to your
      own mailbox, name your mailbox provider too.

## 9b. Turnstile for the OG checker (optional, recommended)

Without it the checker allows 20 uncached checks per hour per IP and nothing else. With it,
visitors are asked to confirm they are human from the 6th check in an hour.

- [ ] Cloudflare dashboard > Turnstile > Add widget: hostname `linktocard.com`, mode Managed.
- [ ] Put the site key (public) in `wrangler.toml` under `[env.production.vars]` as
      `TURNSTILE_SITE_KEY = "..."`.
- [ ] Set the secret key: `npx wrangler secret put TURNSTILE_SECRET_KEY --env production`.
- [ ] Apply pending migrations (the note at the top of section 4), then
      `npm run deploy:production`. The site's Content-Security-Policy already allows
      `https://challenges.cloudflare.com`.

## 10. PDF documents (staging first; production only after Ahmad approves)

PDF documents are built and tested against a mocked Browser Run binding; Browser Run cannot be
reached from the build environment. Real renders were checked on staging on 2026-11-25 and 26
(README.md, "Not verified"). The fixes of 2026-11-26 (README changelog) have not been deployed
to staging yet, so run the staging list below again after the next staging deploy. Production
stays off (`PDF_ENABLED = "false"`, site built with `SITE_PDF=off`) until you decide otherwise.

Staging, for the first real renders:

- [ ] Apply the new migration (and any earlier one not applied yet):
      `npx wrangler d1 migrations apply DB --env staging --remote`. It adds `0006_pdf.sql` and
      `0007_browser_usage_plan.sql` (the plan each render was made on, read by the free brake).
- [ ] `npm run deploy:staging`. It builds the site with `SITE_PDF=on` and deploys the Worker with
      the `BROWSER` binding (`[env.staging.browser]` in `wrangler.toml`).
- [ ] `/api/config` on staging reports `"pdf_enabled": true`.
- [ ] Make a PDF on `/tools/html-to-pdf`, `/tools/invoice-generator` and
      `/tools/certificate-generator`, then one with `POST /v1/pdf` for each of the five starter
      templates (`/docs/pdf` has the request), and open one signed PDF link.
- [ ] Watch `npx wrangler tail --env staging` meanwhile, and work through the PDF list under
      "Not verified" in README.md. The two that would stop every PDF: the document itself
      must load with `allowRequestPattern: ['^data:']`, and the page count must be readable
      (a log line "page count cannot be read" means every PDF fails with 500).
- [ ] Browser time is recorded per attempt:
      `npx wrangler d1 execute DB --env staging --remote --command "SELECT source, status, browser_ms, pages FROM browser_usage ORDER BY created_at DESC LIMIT 10"`
- [ ] Remote images are fetched by the Worker only: put an image at an address whose requests
      you can see (a request-logging service, or a file on a server you control) in a
      document's `<img src>` and in a CSS `url()`, make the PDF, and check the log: each address
      was requested once, by the Worker's image fetcher (no Chrome User-Agent). This does not
      test `allowRequestPattern`: the sanitiser replaces every address it can see with a
      `data:` URI before the browser gets the document, so a browser request cannot happen here.
- [ ] `allowRequestPattern: ['^data:']` itself, the safety net for a gap in the sanitiser: call
      Browser Run directly, not through Link To Card, so that nothing rewrites the HTML. With an
      API token that has Browser Run - Edit (the deploy token does not), `POST
      https://api.cloudflare.com/client/v4/accounts/<account id>/browser-run/pdf` (Cloudflare's
      Browser Run docs, "PDF endpoint", have the curl form) with
      `{"html": "<link rel=stylesheet href=https://<logger>/a.css><img src=https://<logger>/b.png><style>p{background:url(https://<logger>/c.png)}</style><p>x</p>", "allowRequestPattern": ["^data:"], "setJavaScriptEnabled": false}`.
      Expect a PDF and no request at all in the logger. Any request means a sanitiser gap would
      reach the open web: keep PDFs off until it is understood.
- [ ] A Free account's PDF with a header and a footer (the `/docs/pdf` example footer): both
      print as plain text in the fixed style, with the page numbers, above the "Made with Link To
      Card" line on every page, and the response warns that their markup and styles were not
      used. The same request on a Starter account prints them as written, without the line.
- [ ] A PDF over the size limit (`PDF.maxPdfBytes`): print a document with one
      `data:image/png` made of identical noise rows, about 12000 x 1500 pixels (locally in
      Chromium that made a 54 MB PDF). Expect 422 `template_error` "The PDF is larger than 20 MB,
      ..." with `details.max_bytes`, nothing charged, and a `browser_usage` row with status 200,
      `pages` empty and `wall_ms` set. Whether Browser Run sends `Content-Length` on PDF answers
      is not known; it only decides whether the body is refused before or while it is read.
- [ ] The same failing request twice within `PDF.failedRenderMemoryMs` (10 minutes): the second
      answer is the same 422 with
      "(An identical request failed like this at ...)" at the end of the message, and no new
      `browser_usage` row.
- [ ] Optional, to see the budget alarm once: set `PDF_DAILY_BROWSER_MS_BUDGET = "1"` under
      `[env.staging.vars]`, deploy, make one PDF, and expect the email "Link To Card: PDF browser
      time over budget" at `SUPPORT_EMAIL` after the next daily cron (03:17 UTC). A budget that
      low engages the automatic brake (below) only once Free-account or free-tool PDFs have used
      that much browser time; a paid account's PDF does not. While it is on, Free-plan and
      free-tool PDFs on staging answer 429 with `Retry-After: 3600`. Remove the line and deploy
      again; the brake then lifts within a minute.
- [ ] Staging is public (workers.dev) with PDFs on as soon as it is deployed: the limits below
      apply there too, and its browser time is billed like production's.

Production, only when you approve PDFs:

- [ ] Migrations: already applied before an earlier deploy (the note at the top of section 4);
      `npx wrangler d1 migrations list DB --env production --remote` should list nothing.
- [ ] Turnstile first (section 9b): `TURNSTILE_SECRET_KEY` must be set on production before
      PDFs go on. Without it the free tools are limited only per IPv4 address or IPv6 /64, and
      one visitor with many IPv6 networks is not limited at all.
- [ ] `wrangler.toml`, `[env.production.vars]`: `PDF_ENABLED = "true"`.
- [ ] `package.json`: in `deploy:production`, change `SITE_PDF=off` to `SITE_PDF=on`. Together
      with `legalUpdated` below, update the tests that pin the production build and the legal dates on purpose, so that each launch is
      a deliberate change: `tests/node/site-features.test.ts` (the script), `tests/node/v3-site.test.ts`,
      `tests/node/production-site.test.ts`, `tests/node/production-docs-claims.test.ts` (what the
      production docs pages say while their tool is off), `tests/node/legal-pages.test.ts` (the
      production Terms equal to `89270a7` plus the counterfeit rule, the four features off, `legalUpdated` 2026-11-25 and each
      legal page's date) and the date pins in `tests/node/site.test.ts`. They fail until updated: that is
      their job.
- [ ] `site/site.config.json`: set `legalUpdated` to the launch date. The PDF parts of the terms
      and the privacy policy go live with the PDF pages: in the terms, the immediate suspension when
      a counterfeit document is reported ("always urgent") and "and other files" in section 5. The
      rule against counterfeit or misleading documents itself has been in force in every build since
      2026-11-27 (owner decision). Saying "PDF approved" approves that text too; decide whether section 12
      of the terms calls for an email to account holders. The pages' own `updated:` dates need no
      change: the later date wins.
- [ ] `npm test`, then `npm run deploy:production`, then `/api/config` reports
      `"pdf_enabled": true`.
- [ ] Turnstile (section 9b) also covers the free PDF tools: with `TURNSTILE_SECRET_KEY` set,
      they ask for it after `PDF.toolTurnstileAfterPdfs` PDFs per client and hour.
- [ ] Cost: Browser Run is billed by browser time beyond what Workers Paid includes (check
      Cloudflare's current Browser Run pricing). What bounds it, all in `src/config.ts` `PDF`:
      - The daily cron emails `SUPPORT_EMAIL` once per UTC day when the last 24 hours went over
        `PDF_DAILY_BROWSER_MS_BUDGET` (default `PDF.dailyBrowserMsBudget`). Attempts Browser Run
        reports no time for (timeouts, errors) count with their measured length.
      - Renders that reach the browser and fail because of the document (more than
        `PDF.maxPages` pages, a PDF over `PDF.maxPdfBytes`, a timeout, a document the browser
        cannot render, an unreadable page count), or need more images than are left (402 after
        rendering), are capped at `PDF.maxFailedRendersPerDay` per UTC day by the owner's plan:
        per account for `POST /v1/pdf`, and per site for signed PDF links, so visitors of a
        failing link can stop only that site's new signed PDFs. Signed links of all of an
        account's sites together have `PDF.maxFailedSignedRendersPerDay` (a re-created site
        starts no new count), so one account's failures stay below
        `maxFailedRendersPerDay + maxFailedSignedRendersPerDay` a day: on a paid plan, at the
        measured 61 s of a print that cannot finish, about 10 browser hours a day at worst.
        Then 429 until 00:00 UTC. A render cut off before it ends counts as a failure.
        Browser Run's own errors (5xx that is not a timeout, 400, unreachable, busy, a body that
        stopped) do not count, so an outage on Cloudflare's side locks nobody out.
      - A failed document is remembered for `PDF.failedRenderMemoryMs` and the identical
        request is answered without rendering, so a failing signed link opened again and again
        uses the browser once per 10 minutes. Identical requests at the same time render once.
      - The automatic brake: while the browser time of Free-plan renders (by the plan each was
        made on) and the free tools in the last 24 hours is over `PDF.freeBrakeBudgetMultiple` times the daily budget, Free-plan
        renders and the free tools answer 429; it lifts as that use ages out of the 24 hours.
        Starter and Pro keep rendering, their own browser time never engages it, and stored
        PDFs keep being served. Lowering `PDF_DAILY_BROWSER_MS_BUDGET` and deploying engages it
        on purpose once Free or tool PDFs have used that much browser time.
      - To stop PDFs completely, set `PDF_ENABLED = "false"` and deploy. That is a full stop:
        stored PDFs (`/i/...pdf`) and every signed `/v1/pdf` link, including PDFs customers
        have already paid for and invoice links already emailed, answer 503 until it is
        switched back.

## 11. Build v3 tools (staging first; production feature by feature)

Built and tested locally on 2026-11-26 and checked on staging the same day (README.md, "Build v3
tools" and "Not verified"). Each tool has a Worker switch in `wrangler.toml` and a site feature in
`SITE_FEATURES`. Turning a tool on in production is your approval, one tool at a time.

**What production has, by your decision of 2026-11-27** (deployed 2026-11-27, Worker version `f0eb445e`;
the audit fixes deployed the same day as `bb46082a`, to roll back to `f0eb445e` if needed):

- **On since the deploy of 2026-11-27 (`npm run deploy:production`):** the site build
  `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off`. It publishes the tools hub `/tools`, the
  five one-app preview checkers (`/tools/x-card-validator`, `/tools/linkedin-post-preview`,
  `/tools/slack-link-preview`, `/tools/discord-embed-preview`, `/tools/whatsapp-link-preview`),
  `/tools/merge-pdf` and `/tools/image-to-pdf` (in the browser, nothing uploaded or counted), and
  the docs pages `/docs/bulk`, `/docs/pdf-tools`, `/docs/link-cards` and `/docs/email-images`
  (`/docs/integrations` stays out until the connectors are published). Each docs page opens with a
  notice that its API is not switched on yet on linktocard.com, is `noindex` and is left out of
  `sitemap.xml` and the docs navigation. The footer of every page, the verification page's
  included, gains Merge PDF, Image to PDF and All free tools; the pricing page gains two lines that
  say the free tools count nothing. `tests/node/production-site.test.ts` proves that nothing else
  on the site changes.
- **Still off, waiting for your words "PDF approved, enable it":** PDF documents (`PDF_ENABLED`),
  bulk documents (`BATCH_ENABLED`), the PDF toolkit API (`PDF_TOOLKIT_ENABLED`) and email images
  (`EMAIL_FIELDS_ENABLED`), all `"false"` under `[env.production.vars]`, and their site features
  (`pdf`, `batch`, `toolkit`, `email`) left out of `deploy:production`.
- **Not approved:** cards from links (`LINK_CARDS_ENABLED = "false"`, site feature `linkcards`) and
  publishing the Zapier, Make and n8n connectors (site feature `integrations` off).
- **Unchanged:** Paddle, the webhook and `CHECKOUT_ENABLED`.

### 11a. Before the next deploy of each environment (whatever it is for)

- [x] Create the queue the environment's `wrangler.toml` section binds, once per environment, or
      `wrangler deploy` fails (staging 2026-11-26, production 2026-11-27):

```sh
npx wrangler queues create linktocard-batch-staging
npx wrangler queues create linktocard-batch-production
```

- [x] Apply the migrations before the code that uses them. Production had `0001`-`0005`;
      `0006_pdf.sql`, `0007_browser_usage_plan.sql` and `0008_batches.sql` were applied on 2026-11-27
      before that day's deploy (section 4); the D1 Time Travel bookmark taken just before was
      `00000010-00000000-00005130-f91334fbd3a021a4216f5f2af1d966f7`, and the Worker version before
      the deploy `69b021dd-7ff5-421a-9ce5-ac708078a28d`. There is no `0009`: the charge-once records of email images are rows of
      `tool_usage` (migration `0005`), and the free pages need no migration of their own.

```sh
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler d1 migrations apply DB --env production --remote
```

- [ ] The production queue must exist even with `BATCH_ENABLED = "false"`: `wrangler.toml` binds it in
      `[env.production]` whatever the switches say, and `wrangler deploy --env production` fails
      without it. Check with `npx wrangler queues list`.
- [ ] Know what goes live with any production deploy, switches or not: the approved free pages above;
      the `email` size (1200 x 400) in the API, the size lists of the docs and the dashboard's size
      picker, which the five social starter templates refuse with 400 `invalid_request`
      (`details.reason` `size_not_supported`; the dashboard's URL builder and preview answer it too,
      and its size picker offers a starter only the sizes it is laid out for, falling back to Link
      preview); the charge-once code of email images, which
      does nothing while `EMAIL_FIELDS_ENABLED` is `"false"`; the verification page's footer read
      from the static site (`/assets/partials/footer.html`); `/api/sign` refusing
      `open` as a data name; `/v/*` reaching the Worker, which answers a "not available" page (503)
      while `BATCH_ENABLED` is `"false"` (with no canonical URL), and the certificate revoke routes
      answering 503 `not_configured` before any key or session check; the Terms of `89270a7` plus the
      counterfeit rule, dated 27 November 2026, and the privacy policy of the same date, which names
      Cloudflare Web Analytics; the site's CSP that lets the Web Analytics script run. The two email starter templates do not: they answer 404
      everywhere while `EMAIL_FIELDS_ENABLED` is `"false"`, and the free playground never offers them. The bundle is about
      3.2 MB gzipped (README.md, "Deploying").

### 11b. Staging

- [ ] 11a for staging, then `npm run deploy:staging` (all nine site features, `localpdf` and `apidocs`
      included, and `SITE_PDF=on`; all four switches are `"true"` under `[env.staging.vars]`).
- [ ] `/api/config` on staging reports `"pdf_enabled": true` and a `batch` block with `"enabled": true`.
- [ ] **Bulk documents:** in the dashboard's **Bulk documents** tab, upload a CSV of a few
      certificates, preview row 1, start the batch, follow it to Finished, download the ZIP, open
      a verification page, revoke one and check `/v/{id}.json` says revoked. Repeat with the
      `POST /v1/batches` quickstart of `/docs/bulk`. Print one certificate and scan its QR code with
      a phone. Make one verified certificate on a Free account: the free mark and the QR code must
      both be readable. Watch `npx wrangler tail --env staging`, and
      `npx wrangler d1 execute DB --env staging --remote --command "SELECT source, status, wall_ms FROM browser_usage ORDER BY created_at DESC LIMIT 10"`
      should show `batch` rows.
- [ ] **PDF toolkit:** run each operation of `/docs/pdf-tools` once, with a `url`, a `pdf_id` and an
      upload; open a result's `url`; a Free account's result carries the mark on every page. Try a
      `url` file near the input limit: a download must finish within the image fetcher's timeout
      (`LIMITS.imageFetchTimeoutMs`); if large files time out, give the toolkit its own timeout in
      `src/config.ts`.
- [ ] **Cards from links:** `POST /v1/cards/from-url` for one of your own pages, and a signed
      `/v1/link/...` URL in a page's `og:image`, checked with the OG checker.
- [ ] **Email images:** sign the worked example of `/docs/email-images` with your staging site's
      secret, put it into a test email of your email platform with its merge tag, and send it to a
      contact named `Zoë & Jo`.
- [ ] **Free pages:** `/tools`, the five one-app preview pages, `/tools/merge-pdf` and
      `/tools/image-to-pdf` in Chrome, Firefox and Safari and on a phone.
- [ ] **Connectors:** test each one against staging with a staging API key, as
      `integrations/README.md` ("Before any of them") describes.
- [ ] Emergency brakes on staging, once: `BATCH_ENABLED = "false"` and a deploy makes rows that
      arrive fail with `not_configured`, uncharged; `npx wrangler queues pause-delivery linktocard-batch-staging`
      holds the queue's messages without failing them (`resume-delivery` continues). Both are
      listed by the installed Wrangler's `wrangler queues --help`.

### 11c. Production, one tool at a time

For each tool you approve, in one change:

1. `wrangler.toml`, `[env.production.vars]`: its switch to `"true"`.
2. `package.json`, `deploy:production`: add its site feature to `SITE_FEATURES=`, keeping
   `previews,localpdf,apidocs` (for example `SITE_FEATURES=previews,localpdf,apidocs,batch` with
   `SITE_PDF=on`: the build refuses `batch` or `toolkit` without `pdf`), and
   update the tests that pin the production build and the legal dates on purpose, so that each launch is
   a deliberate change: `tests/node/site-features.test.ts` (the script), `tests/node/v3-site.test.ts`,
   `tests/node/production-site.test.ts`, `tests/node/production-docs-claims.test.ts` (what the
   production docs pages say while their tool is off), `tests/node/legal-pages.test.ts` (the
   production Terms equal to `89270a7` plus the counterfeit rule, the four features off, `legalUpdated` 2026-11-25 and each
   legal page's date) and the date pins in `tests/node/site.test.ts` (with step 3). With its feature on, the tool's docs page loses its
   "Not switched on yet" notice and joins the docs navigation and the sitemap by itself.
3. `site/site.config.json`: set `legalUpdated` to the launch day when the tool has text in the terms
   or the privacy policy (bulk documents, the PDF toolkit, cards from links, email images). That text
   goes live with the tool's site feature, and the date tells readers that the pages changed.
4. 11a done for production; then `npm test` and `npm run deploy:production`.

| Tool | Needs first | Switch | Site feature | Then check |
| --- | --- | --- | --- | --- |
| Bulk documents | PDFs on in production (section 10), 11a | `BATCH_ENABLED` | `batch` | `/api/config` has `"batch": {"enabled": true, ...}`; one small batch |
| PDF toolkit | PDFs on as well: its results are served under `/i/...pdf`, which answers 503 while `PDF_ENABLED` is off | `PDF_TOOLKIT_ENABLED` | `toolkit` | one merge, and its `url` opens |
| Cards from links | nothing | `LINK_CARDS_ENABLED` | `linkcards` | one card from your own page |
| Email images | nothing | `EMAIL_FIELDS_ENABLED` | `email` | one open-field URL in a test email |
| One-app preview pages and `/tools` | nothing; approved for production on 2026-11-27 | none | `previews` | the six pages load |
| Merge PDF and Image to PDF (in the browser) | nothing; approved for production on 2026-11-27 | none | `localpdf` | both make a PDF from two files |
| The docs pages of tools that are off, with their notice | nothing; approved for production on 2026-11-27 | none | `apidocs` | each opens with its notice |
| Connectors page | the connectors published (below) or still "being prepared" | none | `integrations` | the page's status line matches reality |

- **Connectors.** Publishing them is your work in your own accounts; the steps, the accounts each
  platform needs and what could not be tested here are in `integrations/README.md` ("Publishing:
  what Ahmad does"). A step whose tool is off in production stops with "... is not enabled yet.", so
  switch the tool on first or leave the step out of that version. `/docs/integrations` says the
  connectors are being prepared for listing; when one is listed, change that text and the test in
  `tests/node/v3-docs-draft.test.ts` that forbids saying so.
- **Cost.** A batch's documents are PDFs: Browser Run time, the daily alarm and the free brake
  (section 10) cover them, the failed-render cap counts them per account like `POST /v1/pdf`, and
  each environment's queue consumer renders at most `BATCH.maxConsumerConcurrency` rows at a time,
  each at least `BATCH.minRowMs`. The toolkit runs in the Worker (CPU, no browser) behind `RL_PDF_TOOLS`
  per key; link cards behind the daily page checks per key or site; email images behind
  `EMAIL_FIELDS.maxUniqueRendersPerDay` per site.
- **Before turning email images on in production:** a URL that a customer's own code signed with a
  parameter named `open` (allowed while the switch is off, though `/api/sign` refuses it) is read
  differently once it is on. When its value is not a list of field names (`open=Mon-Fri 8-18`) it
  keeps working as before; when it is one (`open=daily`), the field it names becomes unsigned and
  `{{open}}` renders empty. Look for custom templates that use it:
  `npx wrangler d1 execute DB --env production --remote --command "SELECT id, user_id FROM templates WHERE deleted_at IS NULL AND (html LIKE '%{{open}}%' OR html LIKE '%{{ open }}%')"`,
  and tell their owners to rename the parameter first.
- **Stopping a tool:** its switch to `"false"` and a deploy. What that does to things customers
  already have, not only to new requests:
  - **Bulk documents** (`BATCH_ENABLED`): rows still queued fail with `not_configured`, uncharged.
    `GET /v1/batches`, a batch's status and its ZIP downloads answer 503, finished and paid batches
    included; each document's own `/i/...pdf` link keeps working while `PDF_ENABLED` is on.
    Verification pages answer a "not available" page; printed QR codes work again once it is back
    on. To hold rows instead, `npx wrangler queues pause-delivery linktocard-batch-production`
    keeps their messages, but only for the queue's message retention (4 days by default, up to 14
    when configured, per Cloudflare's Queues limits page; `src/config.ts` BATCH assumes 4): messages older than
    that are deleted, and the daily cleanup fails the rows of batches older than
    `BATCH.staleAfterDays` (5) days, uncharged. Resume within that time.
  - **PDF toolkit** (`PDF_TOOLKIT_ENABLED`): new requests answer 503; stored results stay under
    `/i/...pdf` while `PDF_ENABLED` is on.
  - **Cards from links** (`LINK_CARDS_ENABLED`): every `/v1/link/...` URL answers 503, stored cards
    included, so the `og:image` of every page that uses one breaks until it is back on.
  - **Email images** (`EMAIL_FIELDS_ENABLED`): every open-field image in emails already sent
    answers 403 `invalid_signature` (values already rendered and paid for included) once the edge
    and the mail providers' image caches let the request through, so readers see broken images. The
    email starters answer 404 for any URL that names them. Turn it off only when a broken image is
    better than what it stops. Charge records stay for up to 400 days
    (`EMAIL_FIELDS.chargeMemoryDays`). If the tool is switched back on, images that were already
    counted re-render without being counted again.
