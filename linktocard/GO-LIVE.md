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

- [ ] Edit `site/site.config.json`: replace `LEGAL_NAME` with your full legal name exactly as
      on the Paddle account, and `LEGAL_ADDRESS` with your postal address.
- [ ] Run `npm run check:golive`. It fails while any placeholder is still on any page.
- [ ] Read `/terms`, `/privacy` and `/refund` in full. They are drafts written with AI
      assistance. The choices that are yours to confirm are listed in README.md under
      "Assumptions to confirm". Have a lawyer read them if you can.

## 3. Staging deploy (Paddle sandbox)

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

```sh
npx wrangler d1 create linktocard-production      # paste the id into wrangler.toml, [env.production]
npx wrangler r2 bucket create linktocard-production
npx wrangler d1 migrations apply DB --env production --remote
npm run deploy:production                          # runs the placeholder check first
```

- [ ] Set the same four secrets with `--env production`. Use a **different**
      `SIGNING_MASTER_SECRET` from staging, and the **live** Paddle key and webhook secret
      (step 6).
- [ ] Optional backstop for storage: expired images are deleted by a daily job; these rules
      remove anything it misses.

```sh
npx wrangler r2 bucket lifecycle add linktocard-production expire-renders r/ --expire-days 100
npx wrangler r2 bucket lifecycle add linktocard-production expire-playground p/ --expire-days 2
```

- [ ] Optional: a Cloudflare redirect rule from `link2card.com` to `https://linktocard.com`.

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
      rendered-image records, sessions, sign-in requests and its webhook log entries. An account
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

