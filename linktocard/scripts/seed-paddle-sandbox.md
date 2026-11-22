# Paddle setup: sandbox first, then live

Manual steps for the account owner. Paddle accounts cannot be created or
configured by the code, so everything below is done by hand in the Paddle
dashboard and then copied into the Worker's configuration.

**This file holds no secrets and none may be added to it.** IDs that are safe
to commit (client-side token, price ids) go into `wrangler.toml`. The API key
and the webhook secret go in with `wrangler secret put` only.

**About the dashboard labels.** Nobody could open the Paddle dashboard while
this was written. Every menu path, button and field name below comes from
Paddle's published integration guides and API specification, not from the
screen, and each one is marked *(label may differ)*. If a label is not where
this file says, look for the same thing by its meaning; the API field name
is given where it helps.

The numbers and names in section 2 are the ones in `src/billing/plans.ts`.
`tests/node/paddle-catalog.test.ts` fails if the two drift apart, so change
`plans.ts` first and this file second.

## 1. Sandbox account

1. Sign up for a sandbox account at `https://sandbox-login.paddle.com/signup`.
   Sandbox and live are separate accounts with separate ids, tokens and keys.
2. The sandbox dashboard is `https://sandbox-vendors.paddle.com`.

## 2. Catalog: three products, one price each

For each row: **Catalog > Products > New product** *(label may differ)*, save
the product, then **New price** *(label may differ)* inside it.

| Product name (exact) | Tax category | Price type | Billing cycle | Amount | Tax |
| --- | --- | --- | --- | --- | --- |
| `Link To Card Starter` | SaaS | Recurring | Monthly | 9.00 USD | added on top |
| `Link To Card Pro` | SaaS | Recurring | Monthly | 29.00 USD | added on top |
| `Link To Card Top-up (1,000 images)` | SaaS | One-time | none | 8.00 USD | added on top |

Field by field:

- **Name** *(label may differ)*: copy the product name exactly, character for
  character. Customers see it at checkout and the pricing page prints the same
  string.
- **Tax category** *(label may differ)*: the SaaS option (API value `saas`).
- **Type** *(label may differ)*: Recurring for Starter and Pro, One-time for
  the top-up.
- **Billing cycle** *(label may differ)*: Monthly for Starter and Pro. A
  one-time price has no billing cycle.
- **Amount** *(label may differ)*: the amount in the table, currency USD.
- **Tax** *(label may differ)*: the option that makes the price *exclusive* of
  tax, so tax is added on top of the listed amount (API value
  `tax_mode: external`, "Prices are exclusive of tax"). Set it on each price
  rather than relying on the account default (**My account > Settings > Sales
  tax** *(label may differ)*), whose initial value could not be verified.
- **Trial period** *(label may differ)*: none.
- **Description** *(label may differ)*: an internal label of your choice, for
  example `Starter monthly USD`. Customers do not see it.
- Quantity limits (API fields `quantity.minimum` / `quantity.maximum`; the
  form field could not be confirmed): for Starter and Pro set both to 1 if the
  form offers it: the app grants the plan once however many units are paid
  for, so a quantity of 2 would charge the customer twice for one plan. For
  the top-up keep a maximum above 1 only if you want
  customers to buy several at once: each unit credits 1,000 images, valid
  for 365 days.

After saving each price, copy its id (`pri_...`) from the price details. You
need three ids: Starter, Pro, Top-up.

What the app does with them: Starter gives 2,000 images per billing period,
Pro gives 10,000, and a subscription to any other price is ignored.

## 3. Client-side token

**My account > Settings > Authentication**, tab **Client-side tokens**
*(label may differ)*. Create one and copy it. Sandbox tokens start with
`test_`. It is public by design (it ships in the page that opens checkout).

## 4. API key

Same page, tab **API keys** *(label may differ)*. Create a key with only the
permissions the app uses (names from Paddle's API specification; the dashboard
wording may differ):

- `customer_portal_session.write` (the "Manage billing" link)
- `subscription.write` (switching between Starter and Pro)

Sandbox keys start with `pdl_sdbx_apikey_`. Copy it once and keep it out of
every file; it goes straight into `wrangler secret put` in section 7.

## 5. Default payment link

**Checkout > Checkout configuration > Default payment link** *(label may
differ)*. Paddle requires one: without it checkout does not open. Set it to
the pricing page of the staging app, exactly:

```
{APP_URL}/pricing
```

where `{APP_URL}` is the `APP_URL` of `[env.staging.vars]` in `wrangler.toml`.
It has to be this page and no other: Paddle sends customers here from its own
emails (pay an invoice, update the card after a failed renewal) and appends
`?_ptxn=<transaction id>`, and the pricing page is the one that starts
Paddle.js when it sees that parameter. The sandbox accepts any `https` URL; do
not use `localhost`.

## 6. Notification destination (webhook)

**Events > Notifications > New destination** *(label may differ; older Paddle
pages call the menu "Developer tools")*.

- **Notification type** *(label may differ)*: Webhook.
- **URL** *(label may differ)*: `{APP_URL}/webhooks/paddle`, where `{APP_URL}`
  is the `APP_URL` of `[env.staging.vars]` in `wrangler.toml`, for example
  `https://linktocard-staging.<your-subdomain>.workers.dev/webhooks/paddle`.
- **Usage type** *(label may differ)*: Both (platform and simulation), so the
  simulator in section 9 can reach it.
- **Events** *(label may differ)*: tick exactly these eleven and nothing else.
  They are the events the code acts on; anything else is acknowledged and
  ignored, so extra ticks only add noise.

<!-- events:start -->
- `subscription.created`
- `subscription.updated`
- `subscription.activated`
- `subscription.past_due`
- `subscription.paused`
- `subscription.resumed`
- `subscription.trialing`
- `subscription.canceled`
- `transaction.completed`
- `adjustment.created`
- `adjustment.updated`
<!-- events:end -->

Save, then copy the destination's **Secret key** *(label may differ)*. It
starts with `pdl_ntfset_`. Editing the destination later (for example its URL)
keeps the secret; deleting and recreating it creates a new one.

## 7. Put the values into the staging Worker

1. In `wrangler.toml`, section `[env.staging.vars]`, fill in the four public
   values (and check that `PADDLE_ENV = "sandbox"` is still there):

   ```toml
   PADDLE_CLIENT_TOKEN = "<client-side token from section 3>"
   PADDLE_PRICE_STARTER = "<pri_... of Link To Card Starter>"
   PADDLE_PRICE_PRO = "<pri_... of Link To Card Pro>"
   PADDLE_PRICE_TOPUP = "<pri_... of the top-up>"
   ```

2. Store the two secrets. Each command prompts for the value; paste it there,
   never on the command line and never into a file:

   ```sh
   npx wrangler secret put PADDLE_API_KEY --env staging
   npx wrangler secret put PADDLE_WEBHOOK_SECRET --env staging
   ```

3. Deploy: `npm run deploy:staging`.

Until `PADDLE_WEBHOOK_SECRET` is set the webhook answers `503` on purpose, so
Paddle keeps retrying instead of dropping events.

Replacing a destination later without losing events: put the old and the new
secret into `PADDLE_WEBHOOK_SECRET` separated by a comma, switch over, then
store the new one alone.

## 8. Test checkout in sandbox

1. Sign in to the staging app with an email address and start the Starter
   checkout from there. The checkout must be opened by the app (not from the
   Paddle dashboard), because the app attaches the account id to it.
2. Pay with Paddle's test card: number `4242 4242 4242 4242`, any future
   expiry date, CVC `100`, any name. Real cards are refused in sandbox.
3. Within a few seconds the account should show the Starter plan with
   2,000 images for the billing period.
4. Check what the webhook recorded:

   ```sh
   npx wrangler d1 execute DB --env staging --remote --command "SELECT event_type, result, user_id FROM webhook_events ORDER BY received_at DESC LIMIT 20"
   ```

   Expected: `subscription.created` (and usually `subscription.activated`)
   with result `ok` and your account id in `user_id`. One of the two may
   instead say `ignored:stale`; that only means the newer event was applied
   first.

   If the result is `ignored:no_user`, the account id did not arrive with the
   event: the checkout must pass `customData: { user_id: "<account id>" }`
   and Paddle must deliver it as `custom_data.user_id`. That hand-over could
   not be tested without an account, so this is the first thing to confirm.
   If it is `ignored:unknown_price`, a price id in `wrangler.toml` does not
   match the catalog. `ignored:other_subscription` means the account already
   has a subscription that is still running: a second one is never applied
   on top of it (cancel and refund the extra one in Paddle).

5. Then try, in this order, and re-run the query after each:
   - **Upgrade to Pro** from the app: the plan becomes Pro (10,000 images)
     when `subscription.updated` arrives.
   - **Buy a top-up** from the app: `transaction.completed` with result `ok`,
     and 1,000 extra images on the account.
   - **Cancel** through the billing portal. Paddle's default is to cancel at
     the end of the paid period: the plan stays, `cancel_at` in the `users`
     table holds the end date, and on that date the account returns to Free
     by itself, whether or not `subscription.canceled` has arrived by then.
     A cancellation that takes effect immediately returns it to Free at
     once. Which of the two the portal offers could not be verified; note
     what you see.
   - **Default payment link**: in the Paddle dashboard open the top-up
     transaction you just paid, or create a draft transaction, and copy its
     checkout link. It must read `{APP_URL}/pricing?_ptxn=txn_...`. Open it
     in a private window (not signed in): Paddle's checkout should open on
     top of the pricing page. This could not be tested without an account;
     if nothing opens, links in Paddle's payment emails will not work, so
     report it before going live.
   - **Failed renewal**: subscribe with card `4000 0027 6000 3184` (first
     payment succeeds, renewals are declined). After the renewal fails the
     subscription becomes `past_due` and the account keeps its plan. The
     sandbox does not retry payments, so recovery can only be seen through
     the simulator.
   - **Refund a top-up** from the Paddle dashboard. The sandbox approves
     refunds automatically after about ten minutes; when `adjustment.updated`
     arrives with result `ok`, the top-up images are gone. Only a full refund
     (or a chargeback) removes them; a partial refund is recorded as
     `ignored:partial_refund` and changes nothing.
   - **Refunding a subscription payment** does not end the subscription in
     Paddle, and the app does not act on it (`ignored:not_topup`): the plan
     stays and the next renewal is charged. When you refund a subscriber,
     also cancel the subscription in the Paddle dashboard, effective
     immediately; the account then returns to Free through
     `subscription.canceled`.

## 9. Webhook simulator

**Events > Simulations** *(label may differ)*. Choose the destination from
section 6 and run a single event or a scenario (subscription creation,
renewal, pause, resume, cancellation).

What it proves: the URL is reachable, the secret matches (every delivery is
answered `200`; a `401` means the secret in the Worker is not this
destination's) and each event lands in `webhook_events`.

What it does not prove: simulated events are expected to carry Paddle's
example ids rather than your accounts and prices, so their results should read
`ignored:no_user` or `ignored:not_topup`. That is the correct outcome, not an
error. (Whether the simulator lets you edit the payload could not be checked.)
Plan changes can only be tested with a real sandbox checkout (section 8).

The simulator sends each event once. Real sandbox events are retried only
about three times within two minutes, so fix a failing endpoint and then use
**Retry** *(label may differ)* on the notification, or repeat the purchase.

## 10. Live

Repeat the whole file in the live account (`https://vendors.paddle.com`).
Nothing carries over from sandbox.

1. **Website approval**: submit `linktocard.com` under **My account > Settings
   > Website approval** *(label may differ)* and wait for approval. Live
   checkout only opens on approved domains.
2. **Catalog**: create the same three products and prices as in section 2,
   with the same names, amounts, cycle and tax setting. The live `pri_...` ids
   are different from the sandbox ones.
3. **Client-side token** (starts with `live_`) and **API key** (starts with
   `pdl_live_apikey_`), as in sections 3 and 4.
4. **Default payment link**: `https://linktocard.com/pricing` (the approved
   domain; see section 5 for why it must be the pricing page).
5. **Notification destination**: URL `https://linktocard.com/webhooks/paddle`,
   usage type Platform *(label may differ)*, the same eleven events.
6. Fill `[env.production.vars]` in `wrangler.toml` (the same four values;
   `PADDLE_ENV = "production"` is already set there) and store the secrets:

   ```sh
   npx wrangler secret put PADDLE_API_KEY --env production
   npx wrangler secret put PADDLE_WEBHOOK_SECRET --env production
   ```

7. Deploy with `npm run deploy:production`. Test cards do not work in live;
   the first live check is a real purchase that you then refund.

If a price ever has to change, do not swap the id in `wrangler.toml` while
customers are still subscribed to the old price: their renewals would be
recorded as `ignored:unknown_price`. Ask for the code to accept both ids first.
