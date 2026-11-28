# Go-live: checkout and the paid tools

For the day Ahmad says "Paddle approved my account" (his decision of 2026-11-28). Until then nothing below is done: production keeps checkout and every paid tool off. This page puts the steps of [GO-LIVE.md](GO-LIVE.md) sections 6, 9b, 10 and 11 in one order; the detail stays there.
"Engineer" is the AI assistant; Wrangler takes the Cloudflare token from `CLOUDFLARE_API_TOKEN` (README.md, "Deploying"). Staging first, and Ahmad says OK before every production deploy. No secret is typed into the chat. Four commands below are not in GO-LIVE.md; they are in the installed Wrangler's `--help`: `secret list`, `secret delete`, `deployments list` and `rollback`.

## Before you start

| What | How to check | Who |
| --- | --- | --- |
| Ahmad's words | "Paddle approved my account" opens step 1. His message of 2026-11-28 puts the paid tools (PDF documents, bulk documents, PDF toolkit, email images) at the same moment; his earlier rule asked for the words "PDF approved, enable it" before PDFs (GO-LIVE.md sections 10 and 11). So before step 2, ask him to confirm the four tools by name in the same message. Those words also approve the terms and privacy text of these tools (section 10). Email account holders first (Terms section 12, Privacy section 11)? Ask Ahmad | Ahmad |
| Paddle | The website approval of `linktocard.com` no longer reads `pending_review`; Apple Pay's status is on the same page. Checkout > Checkout settings: the default payment link is `https://linktocard.com/pricing`. Business account > Payouts > Payout settings: the bank details. Developer Tools > Notifications: the destination still points to `https://linktocard.com/webhooks/paddle`; he looks and changes nothing there (GO-LIVE.md section 6) | Ahmad |
| Cloudflare | Billing: the Workers spending limit and the budget alert (GO-LIVE.md section 5). Whether that limit also stops Browser Run is not written in this repository: ask Ahmad. Always Use HTTPS on and Minimum TLS version 1.2 (4a, not ticked there). For step 2, a Turnstile widget for `linktocard.com`, mode Managed (9b): he gives the site key, which is public | Ahmad |
| Which commit | A production deploy publishes everything on the branch that no off switch holds back (GO-LIVE.md 11a). List what is new since the last production deploy (Worker `65d05a46`, 2026-11-27). On 2026-11-28 that is the top-up without a subscription, the new homepage and the chart tool (held back by `CHARTS_ENABLED`). Each new thing is approved by Ahmad, held back by its own switch, or not on the deployed commit: ask Ahmad | both |
| Live Paddle values | Read only. `wrangler.toml`, `[env.production.vars]`: `PADDLE_ENV = "production"`, and `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_STARTER`, `PADDLE_PRICE_PRO`, `PADDLE_PRICE_TOPUP` equal the live client-side token and the three live price ids written in GO-LIVE.md section 6 | Engineer |
| Secrets | `npx wrangler secret list --env production` names `SIGNING_MASTER_SECRET`, `RESEND_API_KEY`, `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`. It prints names, never values | Engineer |
| Webhook | An empty POST to `https://linktocard.com/webhooks/paddle` answers 403 "Webhooks are accepted only from Paddle." A 503 means the secret is missing or Paddle's address list could not be fetched: stop and tell Ahmad. Nothing is set or recreated | Engineer |
| Database, queue, browser | `npx wrangler d1 migrations list DB --env production --remote` lists nothing; if it does, `npx wrangler d1 migrations apply DB --env production --remote` first. `npx wrangler queues list` shows `linktocard-batch-production`. `wrangler.toml` has `[env.production.browser]` with `binding = "BROWSER"`; the proof is the check of step 3 | Engineer |
| Old `open` parameters | The query under "Before turning email images on in production" (GO-LIVE.md 11c) returns no row. If it returns one, Ahmad tells that owner first | Engineer |
| Suites, staging | `npm run typecheck`, `npm test` and `npm run smoke` pass. `npm run deploy:staging`, then `npm run check:deploy -- https://linktocard-staging.names-on-base.workers.dev`, one sandbox checkout with a Paddle test card (GO-LIVE.md section 3) and the staging lists of sections 10 and 11b for the four tools. Ahmad looks at staging and says OK | both |
| Way back | `npx wrangler deployments list --env production` before step 1, and again after every deploy and every secret change: write down the full version id each time (GO-LIVE.md has only its first part, `65d05a46` on 2026-11-27) | Engineer |

## Switch on

One step at a time, in this order. Each step: the edit, `npm run typecheck` and `npm test`, Ahmad's OK, `npm run deploy:production`, then its check under "Check". The next step waits for it. The variables are in `wrangler.toml` under `[env.production.vars]`; the site build is the `deploy:production` line of `package.json`, where only the two settings shown change.

| Step | Variable, now to new | Site build |
| --- | --- | --- |
| 1. Checkout | `CHECKOUT_ENABLED = "false"` to `"true"` | unchanged: `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off` |
| 2. Turnstile | a new line `TURNSTILE_SITE_KEY = "..."` (there is none now), deployed. Only then Ahmad runs `npx wrangler secret put TURNSTILE_SECRET_KEY --env production` | unchanged |
| 3. PDF documents | `PDF_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=on` |
| 4. Bulk documents | `BATCH_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch SITE_PDF=on` |
| 5. PDF toolkit | `PDF_TOOLKIT_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch,toolkit SITE_PDF=on` |
| 6. Email images | `EMAIL_FIELDS_ENABLED = "false"` to `"true"` | `SITE_FEATURES=previews,localpdf,apidocs,batch,toolkit,email SITE_PDF=on` |

- Why this order: checkout changes no built page. Turnstile comes before PDFs (GO-LIVE.md section 10), and its secret only after the site key is deployed: the secret alone makes the free checker ask for a check it cannot show. How Ahmad enters the secret outside the chat (his own terminal, or the Cloudflare dashboard): ask Ahmad. PDFs come before steps 4 and 5: the build refuses `batch` or `toolkit` without `pdf`, a batch's documents are PDFs, and toolkit results are served under `/i/...pdf`, which answers 503 while `PDF_ENABLED` is off. Email images need nothing first.
- Steps 3 to 6 also, in the same change: set `legalUpdated` in `site/site.config.json` (now `2026-11-25`) to that day, and update on purpose the tests that pin production. They fail until then: the six files named in GO-LIVE.md 11c step 2, and `tests/node/wrangler-v3.test.ts`, which pins `PDF_ENABLED` and the four tool switches to `"false"`.
- `LINK_CARDS_ENABLED` stays `"false"`, and `linkcards` and `integrations` never enter `SITE_FEATURES`. Keep `apidocs`: it keeps `/docs/link-cards` published with its notice.

## Check

After every deploy: `npm run check:deploy -- https://linktocard.com` ends with `check:deploy OK (https://linktocard.com)`. It shows that the site still works, not that a switch is on: the numbered checks do that. Wait a minute or two and run it again before reading a failure as real. `https://linktocard.com/api/config` can be up to 5 minutes old. After every step `/docs/link-cards` still opens with "Not switched on yet" and `/docs/integrations` answers 404.

1. Checkout: `/api/config` has a `"paddle"` block (`null` before) with `"environment": "production"`, the live client token and the three price ids. On `/pricing` no button says "Coming soon"; signed in on a Free account, the Starter button opens Paddle's overlay with the plan and the price that `/pricing` shows. Close it without paying. The top-up button opens the overlay for a Free account too, if the top-up without a subscription is on the deployed commit. In the console only Paddle Retain's script is blocked (GO-LIVE.md section 6).
2. Turnstile: `/api/config` has `"turnstile_site_key"` set, and `secret list` names `TURNSTILE_SECRET_KEY`. Turnstile has not run with real keys anywhere (staging has no site key). On `/tools/og-checker`, check new addresses until it asks (after `INSPECT.turnstileAfterChecks` checks in an hour, `src/config.ts`), pass it and get a result.
3. PDF documents: `/api/config` reports `"pdf_enabled": true`. `/docs/pdf`, `/tools/html-to-pdf`, `/tools/invoice-generator` and `/tools/certificate-generator` answer 200 (404 before). One PDF on each of the three tools, one `POST /v1/pdf` (`/docs/pdf` has the request), one signed PDF link. The `browser_usage` query of GO-LIVE.md section 10, with `--env production`, shows them. Three PDF guides are published too; two show n8n and Zapier calling the API over HTTP, and name no connector.
4. Bulk documents: `/api/config` has `"batch": {"enabled": true, ...}`, and `/docs/bulk` has lost its notice. One small batch to Finished, its ZIP, one verification page.
5. PDF toolkit: `/docs/pdf-tools` has lost its notice. One merge, and its `url` opens.
6. Email images: `/docs/email-images` has lost its notice. One open-field URL in a test email (the worked example of that page): the image shows the contact's name.

A real purchase, only if Ahmad asks for it: he buys Starter with a real card, the dashboard shows Starter, and he refunds it in Paddle (GO-LIVE.md section 6). Then the `webhook_events` query of GO-LIVE.md section 7 shows no `error:` row.

## If something is wrong

Stop and tell Ahmad. The fast way to switch one thing off: its variable back to `"false"`, then `npm run deploy:production`. If it stays off, also take its site feature out of `SITE_FEATURES` and put the pinned tests back, so the site says nothing that is not true. Read "Stopping a tool" in GO-LIVE.md 11c first.

- `CHECKOUT_ENABLED`: the buttons say "Coming soon" again. Paying customers lose the dashboard's billing buttons, and the links in Paddle's own emails cannot open the checkout. Paddle keeps billing and the webhook keeps working. Nothing is changed in Paddle.
- `PDF_ENABLED`: a full stop. Stored PDFs and signed PDF links answer 503, paid ones and toolkit results included, and batches cannot start. Its site feature does not come out alone: the build refuses `SITE_PDF=off` while `batch` or `toolkit` is listed, so both come out with it and `BATCH_ENABLED` and `PDF_TOOLKIT_ENABLED` go to `"false"` too. Softer, for free use only: a lower `PDF_DAILY_BROWSER_MS_BUDGET` (GO-LIVE.md section 10).
- `BATCH_ENABLED`: queued rows fail uncharged; ZIP downloads and verification pages stop. To hold rows instead: `npx wrangler queues pause-delivery linktocard-batch-production` (`resume-delivery` continues; GO-LIVE.md 11c has the time limit).
- `PDF_TOOLKIT_ENABLED`: new requests answer 503. `EMAIL_FIELDS_ENABLED`: images in emails already sent break (403).
- Turnstile cannot be passed: Ahmad runs `npx wrangler secret delete TURNSTILE_SECRET_KEY --env production`, and the checker asks for nothing again. PDFs stay off until it works.
- A bad deploy: `npx wrangler rollback <full-version-id> --env production -m "<why>"`, with an id from "Way back". It does not undo a migration. Afterwards `/api/config` must show the earlier state and `secret list` must still name every secret. Then make `wrangler.toml` and `package.json` say what runs, or the next deploy switches it on again.

## Not part of this

- Paddle: the catalog, the prices, the client token and the notification destination with its secret (GO-LIVE.md section 6) are never deleted, recreated or edited. Ahmad does everything inside Paddle, the registrar and Cloudflare billing himself.
- Cards from links (`LINK_CARDS_ENABLED`, site feature `linkcards`) stay off: they are not in Ahmad's list.
- The Zapier, Make and n8n connectors are not published: site feature `integrations` and `/docs/integrations` stay out of production.
- No new tool (the chart tool included) and no new Paddle product on that day. Afterwards: update README.md ("Status, stated plainly") and GO-LIVE.md sections 6, 10 and 11 with the date and the Worker versions.
