# Go-live: checkout and the paid tools

For the day Ahmad says "Paddle approved my account" (his decision of 2026-11-28). Until then nothing below is done: production keeps checkout and every paid tool off. This page puts the steps of [GO-LIVE.md](GO-LIVE.md) sections 6, 9b, 10 and 11 in one order.
"Engineer" is the AI assistant; Wrangler takes the Cloudflare token from `CLOUDFLARE_API_TOKEN` (README.md, "Deploying"). Ahmad says OK before every production deploy. No secret is typed into the chat. Three commands below are not in GO-LIVE.md; they are in the installed Wrangler's `--help`: `secret list`, `deployments list` and `rollback`.

## 1. Before you start

| What | How to check | Who |
| --- | --- | --- |
| Paddle approval | Ahmad says "Paddle approved my account". In Paddle, the website approval of `linktocard.com` no longer reads `pending_review`; he also reads Apple Pay's status on the same page (GO-LIVE.md section 6) | Ahmad |
| What goes on | Ahmad confirms the list in his own words: checkout, PDF documents, bulk documents, PDF toolkit, email images. This stands for the "PDF approved, enable it" that GO-LIVE.md section 11 waits for, and it approves the terms and privacy text of these tools. Email account holders first (Terms section 12, Privacy section 11)? Ask Ahmad | Ahmad |
| Paddle settings | Checkout > Checkout settings: the default payment link is `https://linktocard.com/pricing`. Business account > Payouts > Payout settings: the bank details (GO-LIVE.md section 6) | Ahmad |
| Spending cap | Cloudflare, Billing: the Workers spending limit and the budget alert of GO-LIVE.md section 5. Whether that limit also stops Browser Run is not written in this repository: ask Ahmad | Ahmad |
| HTTPS | Always Use HTTPS on and Minimum TLS version 1.2 (GO-LIVE.md 4a, not ticked there): ask Ahmad | Ahmad |
| Turnstile | A widget for `linktocard.com` (GO-LIVE.md 9b). Ahmad gives the site key, which is public | Ahmad |
| Which commit | A production deploy publishes everything on the branch that no off switch holds back (GO-LIVE.md 11a). List what is new since the last production deploy; ask Ahmad | both |
| Live Paddle values | `wrangler.toml`, `[env.production.vars]`: `PADDLE_ENV = "production"`, and `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_STARTER`, `PADDLE_PRICE_PRO`, `PADDLE_PRICE_TOPUP` equal the live client-side token and the three live price ids written in GO-LIVE.md section 6 | Engineer |
| Secrets | `npx wrangler secret list --env production` names `SIGNING_MASTER_SECRET`, `RESEND_API_KEY`, `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`. It prints names, never values | Engineer |
| Webhook | An empty POST to `https://linktocard.com/webhooks/paddle` answers 403 "Webhooks are accepted only from Paddle." A 503 means the secret is missing or Paddle's address list could not be fetched. Ahmad sees in Paddle (Developer Tools, Notifications) that the destination still points there | both |
| Database, queue | `npx wrangler d1 migrations list DB --env production --remote` lists nothing; if it does, `npx wrangler d1 migrations apply DB --env production --remote` first. `npx wrangler queues list` shows `linktocard-batch-production` | Engineer |
| Browser Run | `wrangler.toml` has `[env.production.browser]` with `binding = "BROWSER"`. The proof is the check of step 2 | Engineer |
| Old `open` parameters | The query under "Before turning email images on in production" (GO-LIVE.md 11c) returns no row. If it returns one, Ahmad tells that owner first | Engineer |
| Suites, staging | `npm run typecheck`, `npm test` and `npm run smoke` pass. `npm run deploy:staging`, then `npm run check:deploy -- https://linktocard-staging.names-on-base.workers.dev` and one sandbox checkout with a Paddle test card (GO-LIVE.md section 3). Ahmad looks at staging and says OK | both |
| Way back | `npx wrangler deployments list --env production`, now and after each deploy: write down the version id (`65d05a46` on 2026-11-27) | Engineer |

## 2. Switch on

One step at a time, in this order: edit, `npm run typecheck` and `npm test`, Ahmad's OK, `npm run deploy:production`, the checks of section 3. The next step waits for them. The variables are in `wrangler.toml` under `[env.production.vars]`; the site build is the `deploy:production` line of `package.json`, where only the two settings shown change.

| Step | Variable, now to new | Site build |
| --- | --- | --- |
| 1. Checkout | `CHECKOUT_ENABLED = "false"` to `"true"` | unchanged: `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off` |
| 2. PDF documents | `PDF_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=on` |
| 3. Bulk documents | `BATCH_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch SITE_PDF=on` |
| 4. PDF toolkit | `PDF_TOOLKIT_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch,toolkit SITE_PDF=on` |
| 5. Email images | `EMAIL_FIELDS_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch,toolkit,email SITE_PDF=on` |

- Why this order: checkout changes no built page. PDFs come before steps 3 and 4: the build refuses `batch` or `toolkit` without `pdf`, a batch's documents are PDFs, and toolkit results are served under `/i/...pdf`, which answers 503 while `PDF_ENABLED` is off.
- Turnstile before step 2 (GO-LIVE.md section 10 requires it): add `TURNSTILE_SITE_KEY = "..."` to `[env.production.vars]` and deploy it; it can go with step 1. Only then Ahmad runs `npx wrangler secret put TURNSTILE_SECRET_KEY --env production`. The secret without the deployed site key makes the free checker ask for a check it cannot show.
- Steps 2 to 5 also: set `legalUpdated` in `site/site.config.json` to that day, and update on purpose the tests that pin production. They fail until then: `tests/node/wrangler-v3.test.ts`, `tests/node/site-features.test.ts`, `tests/node/v3-site.test.ts`, `tests/node/production-site.test.ts`, `tests/node/production-docs-claims.test.ts`, `tests/node/legal-pages.test.ts`, `tests/node/site.test.ts`.
- `LINK_CARDS_ENABLED` stays `"false"`, and `linkcards` and `integrations` stay out of `SITE_FEATURES`. Keep `apidocs`: it keeps `/docs/link-cards` published with its notice.

## 3. Check

After every deploy: `npm run check:deploy -- https://linktocard.com` ends with `check:deploy OK (https://linktocard.com)`. Wait a minute or two and run it again before reading a failure as real; with `LTC_API_KEY`, `LTC_SITE_ID` and `LTC_SITE_SECRET` of a test account it is the full check. `https://linktocard.com/api/config` can be up to 5 minutes old. After each of steps 2 to 5 the tool's docs page has lost its "Not switched on yet" notice; `/docs/link-cards` keeps it, and `/docs/integrations` answers 404.

1. Checkout: `/api/config` has a `"paddle"` block with `"environment": "production"` and the live token and price ids. On `/pricing` no button says "Coming soon"; signed in on a Free account, the Starter button opens Paddle's overlay. In the console only Paddle Retain's script is blocked (GO-LIVE.md section 6). After Turnstile, `"turnstile_site_key"` is set.
2. PDF documents: `/api/config` reports `"pdf_enabled": true`. One PDF each on `/tools/html-to-pdf`, `/tools/invoice-generator` and `/tools/certificate-generator`, one `POST /v1/pdf` (`/docs/pdf` has the request), one signed PDF link. The `browser_usage` query of GO-LIVE.md section 10, with `--env production`, shows them.
3. Bulk documents: `/api/config` has `"batch": {"enabled": true, ...}`. One small batch to Finished, its ZIP, one verification page.
4. PDF toolkit: one merge, and its `url` opens.
5. Email images: one open-field URL in a test email (the worked example of `/docs/email-images`).

A real purchase, only if Ahmad asks for it: he buys Starter with a real card, the dashboard shows Starter, and he refunds it in Paddle (GO-LIVE.md section 6). Then the `webhook_events` query of GO-LIVE.md section 7 shows no `error:` row.

## 4. If something is wrong

Each switch goes back alone: its variable to `"false"`, then `npm run deploy:production`. Read "Stopping a tool" in GO-LIVE.md 11c first. If a tool stays off, take its site feature out again too, so the site says nothing that is not true.

- `CHECKOUT_ENABLED`: the buttons say "Coming soon" again. Paying customers lose the dashboard's billing buttons, and the links in Paddle's own emails cannot open the checkout. Paddle keeps billing and the webhook keeps working.
- `PDF_ENABLED`: a full stop. Stored PDFs and signed PDF links answer 503, paid ones and toolkit results included, and batches cannot start. Softer, for free use only: a lower `PDF_DAILY_BROWSER_MS_BUDGET` (GO-LIVE.md section 10).
- `BATCH_ENABLED`: queued rows fail uncharged; ZIP downloads and verification pages stop. To hold rows instead: `npx wrangler queues pause-delivery linktocard-batch-production` (`resume-delivery` continues).
- `PDF_TOOLKIT_ENABLED`: new requests answer 503. `EMAIL_FIELDS_ENABLED`: images in emails already sent break (403).
- A bad deploy: `npx wrangler rollback <version-id> --env production`, with an id from "Way back". It does not undo a migration. Afterwards make `wrangler.toml` and `package.json` say what runs.

## 5. Not part of this

- Paddle: the catalog, the prices, the client token and the notification destination `ntfset_01m84q5ss0c74z9e6es9g2bpdx` with its secret are never deleted, recreated or edited. Ahmad does everything inside Paddle, the registrar and Cloudflare billing himself.
- Cards from links (`LINK_CARDS_ENABLED`, site feature `linkcards`) stay off unless Ahmad adds them.
- The Zapier, Make and n8n connectors are not published: site feature `integrations` and `/docs/integrations` stay out of production.
- No new tool and no new Paddle product on that day. Afterwards: update README.md ("Status, stated plainly") and GO-LIVE.md sections 6, 10 and 11 with the date and the Worker versions.
