# Paddle Billing: implementation reference for a Cloudflare Worker (TypeScript, Web Crypto)

Researched 2026-11-21. Scope is Paddle **Billing** (API at `api.paddle.com`, Paddle.js v2). Nothing here applies to Paddle Classic.

## 0. Evidence and how to read the tags

`developer.paddle.com` could not be opened from this container: `curl` is blocked by the proxy and the WebFetch tool returned `getaddrinfo ENOTFOUND developer.paddle.com`. No docs page was read directly. Every claim below carries one of these tags.

| Tag | Source | How it was read | Trust |
| --- | --- | --- | --- |
| **[OAS]** | Official OpenAPI 3.1 spec, `github.com/PaddleHQ/paddle-openapi`, `v1/openapi.yaml`, commit `c8207382` (2026-10-26). 144,916 lines. Includes webhook definitions with full example payloads and `x-enum-descriptions`. | `git clone`, parsed with PyYAML, queried | High |
| **[NODE]** | `@paddle/paddle-node-sdk@3.12.0` (npm, modified 2026-11-12), `npm pack`ed to `scratchpad/pk-paddle-node/package` | Read `.d.ts` and `dist/esm/*.js` | High |
| **[JS]** | `@paddle/paddle-js@1.6.6` (npm, modified 2026-11-04), `npm pack`ed to `scratchpad/pk-paddle-js/package` | Read `types/**/*.d.ts`, `dist/index.esm.js`, README | High |
| **[SKILLS]** | `github.com/PaddleHQ/paddle-agent-skills`, commit `abeda63` (2026-11-19). Official Paddle-authored integration guides, `skills/<name>/SKILL.md` | `git clone`, read | High for "what Paddle currently tells integrators"; it is prose, not a spec |
| **[GO] [PHP] [PY]** | Official SDK sources: `paddle-go-sdk@c7d2707`, `paddle-php-sdk@10359e4`, `paddle-python-sdk@eef427d` (all 2026-11-17 to 11-20) | `git clone`, read verifier code | High |
| **[MCP]** | `github.com/PaddleHQ/paddle-mcp-server@693f83a`, `src/prompts.ts` | read | High |
| **[WS]** | WebSearch tool results restricted to `developer.paddle.com` / `paddle.com`. These are **model-written summaries of the official page**, not the page itself. The page URL is given each time. | search only | Medium. Quoted text under [WS] is as relayed by the search tool. Verify before relying on exact numbers. |
| **[TEST]** | Something executed in this container | command given | High for what was tested |
| **[INFER]** | My inference from the sources above. Not stated by Paddle. | n/a | Treat as a hypothesis |

Full official example payloads (verbatim from [OAS]) are saved next to this file in `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/research/paddle-samples/` (20 files, one per event).

---

## 1. Webhook signature verification

### Facts

| Item | Value | Source |
| --- | --- | --- |
| Header name | `Paddle-Signature` (HTTP headers are case-insensitive; SDKs read `paddle-signature` / `Paddle-Signature`) | [NODE] README `req.headers['paddle-signature']`; [GO] `req.Header.Get("Paddle-Signature")`; [PHP] `HEADER = 'Paddle-Signature'` |
| Header format | `ts=<unix seconds>;h1=<64 lowercase hex chars>`. Parts separated by `;`, key and value by `=`. | [GO] regexp `^ts=(\d+);h1=([a-f0-9]{64})$`; [NODE] `extractHeader` splits on `;` then `=` |
| Official example | `ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151` | [GO] `webhook_verifier.go` comment |
| Signed payload | `<ts>` + `:` + `<raw request body>` (the literal `ts` string from the header, a colon, then the body bytes exactly as received) | [NODE] `` `${headers.ts}:${requestBody}` ``; [GO] writes `tsStr`, `":"`, `body`; [PHP] `"{$this->timestamp}:{$data}"`; [PY] `f"{timestamp}:{raw_body}"` |
| Algorithm | HMAC-SHA256, output hex-encoded, compared to `h1` | [NODE] `edge-crypto.js` (`crypto.subtle` HMAC / SHA-256, hex); [GO] `hmac.New(sha256.New, …)` |
| HMAC key | The destination's secret key **string as-is**, UTF-8 encoded. Not base64-decoded, prefix not stripped. | [NODE] `encoder.encode(secret)`; [GO] `[]byte(secretKey)` |
| Secret format | API field `endpoint_secret_key`, pattern `^pdl_ntfset_[a-zA-Z0-9]{26}_[a-zA-Z0-9]{32}$`. Example in spec: `pdl_ntfset_01gkpjp8bkm3tm53kdgkx6sms7_6h3qd3uFSi9YCD3OLYAShQI90XTI5vEI`. One secret per notification destination; sandbox and live are separate. | [OAS] `NotificationSetting.endpoint_secret_key`; [SKILLS] webhooks |
| Timestamp tolerance | Official SDKs reject when `abs(now - ts) > 5 seconds` (both directions). Node: `MAX_VALID_TIME_DIFFERENCE = 5`. Go: `DefaultTimestampTolerance = 5 * time.Second`. PHP/Python: `maximumVariance = 5`. Docs say manual implementations should apply the same check. | [NODE] `webhooks-validator.js`; [GO]; [PHP] `Verifier.php`; [PY] `Verifier.py`; [WS] https://developer.paddle.com/webhooks/about/signature-verification/ |
| Raw body | Verify against the unparsed body. In a Worker: `const raw = await request.text()`, verify, then `JSON.parse(raw)`. Re-serialising parsed JSON changes bytes and breaks the match. | [SKILLS] webhooks ("Parsing the body before verification"); [WS] same page: "Don't transform or process the raw body of the request, including adding whitespace or applying other formatting." |
| Retries and `ts` | A retried delivery carries the identical payload with a fresh signature timestamp, so the 5 s window still works for retries. | [SKILLS] webhooks: "Paddle re-sends the identical payload (modulo a fresh signature timestamp)" |

### Multiple `h1` values / secret rotation

The official sources disagree in behaviour, so code defensively:

- [PHP] and [PY] collect **every** `h1=` value into a list and accept **one or more secrets**, returning true if any secret matches any `h1`. The Python docstring says: "Handling multiple Secrets is needed because of key rotation situations".
- [NODE] keeps only the **last** `h1` it sees and takes a single secret. [GO] uses a strict regexp that only matches exactly one `h1`.
- [WS] The search summary of the signature-verification page reported that the page says more than one `h1` can be present during secret rotation and also that rotation support may be added in future; a second search could not find the multi-`h1` text. **Treat "Paddle sends several h1 values during rotation" as unconfirmed.**
- [SKILLS] onboarding: "Recreating a notification destination rotates its signing secret and breaks webhook verification." Editing a destination's URL keeps its secret ([SKILLS] webhooks: "edit the existing destination's URL rather than creating a new destination, so the secret stays the same").

Recommended for the Worker [INFER]: parse all `h1` values, accept a comma-separated list of secrets from the environment, pass if any pair matches.

### Reference implementation (Web Crypto only)

This is my code, not Paddle's. [TEST] The JavaScript equivalent was run on Node v22.23.5 against `node:crypto` `createHmac` (`scratchpad/scripts/verify-test.mjs`): valid signature, two `h1` values, two secrets, tampered body, wrong secret, stale `ts` (6 s), malformed header all behaved as expected. It was not run inside workerd.

```ts
const enc = new TextEncoder();

function parsePaddleSignature(header: string): { ts: string; h1: string[] } | null {
  let ts: string | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === "ts") ts = value;
    else if (key === "h1") h1.push(value);
  }
  if (!ts || !/^\d+$/.test(ts) || h1.length === 0) return null;
  return { ts, h1 };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** rawBody must be `await request.text()`; secrets are full `pdl_ntfset_...` strings. */
export async function verifyPaddleWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secrets: string | string[],
  toleranceSeconds = 5,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parsed = parsePaddleSignature(signatureHeader);
  if (!parsed) return false;
  if (Math.abs(nowMs - Number(parsed.ts) * 1000) > toleranceSeconds * 1000) return false;
  const data = enc.encode(`${parsed.ts}:${rawBody}`);
  for (const secret of ([] as string[]).concat(secrets)) {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    for (const h of parsed.h1) {
      const sig = hexToBytes(h);
      if (sig && (await crypto.subtle.verify("HMAC", key, sig, data))) return true;
    }
  }
  return false;
}
```

Notes:

- `crypto.subtle.verify` does the comparison for you. If you compute the hex digest and compare strings instead, use a constant-time compare; Workers also expose the non-standard `crypto.subtle.timingSafeEqual(a, b)` (source: `cloudflare-docs` `src/content/docs/workers/runtime-apis/web-crypto.mdx`, fetched from raw.githubusercontent.com: "Compare two buffers in a way that is resistant to timing attacks. This is a non-standard extension to the Web Crypto API.").
- [NODE] ships an edge build that uses exactly this Web Crypto approach (`dist/esm/internal/providers/crypto/edge-crypto.js`) and its `package.json` `exports` map has `worker` and `workerd` conditions pointing at `index.esm.edge.js`, with zero runtime dependencies. So the SDK would also run in a Worker; this project chose not to use it at runtime.
- On verification failure return any non-2xx. [SKILLS] webhooks: only a 2xx marks the event delivered; `400/401/500` are all retried on the same budget, and "the only response that loses the event is a `2xx`".

---

## 2. Events and payload shapes

### 2.1 Envelope (every webhook)

```json
{
  "event_id": "evt_01hv8x2acma2gz7he8kg2s0hna",
  "event_type": "subscription.created",
  "occurred_at": "2024-04-12T10:18:49.621022Z",
  "notification_id": "ntf_01hv8x2af22vrrz7k67g06x1kq",
  "data": { }
}
```

| Field | Type | Notes | Source |
| --- | --- | --- | --- |
| `event_id` | string, `^evt_[a-z\d]{26}$` | Same value on every retry and replay of the event. Use as the dedup key. | [OAS]; [SKILLS] webhooks |
| `event_type` | string | `entity.event_type`, full enum in 2.2 | [OAS] |
| `occurred_at` | RFC 3339 datetime string (examples have microseconds) | When the event happened. Delivery order is not guaranteed; apply an event only if newer than the last applied for that entity. | [OAS]; [SKILLS] webhooks |
| `notification_id` | string, `^ntf_[a-z\d]{26}$` | Changes on replay (a replay creates a new notification for the same `event_id`). Typed `string \| null` in [NODE] `IEventsResponse`. | [OAS]; [NODE] `types/events/events-response.d.ts`; [OAS] replay-notification |
| `data` | object | The full entity. Subscription payloads omit `management_urls`. | [OAS] |

HTTP: `POST`, JSON body, header `Paddle-Signature` ([OAS] names the parameter `paddle_signature`, "Signature for this request. Use to verify that webhooks come from Paddle.").

### 2.2 All event type names (complete enum)

[NODE] `EventName` / `IEventName` and [OAS] agree (56 values):

`address.created`, `address.updated`, `address.imported`, `adjustment.created`, `adjustment.updated`, `api_key.created`, `api_key.updated`, `api_key.expiring`, `api_key.expired`, `api_key.revoked`, `api_key_exposure.created`, `business.created`, `business.updated`, `business.imported`, `client_token.created`, `client_token.updated`, `client_token.revoked`, `customer.created`, `customer.updated`, `customer.imported`, `discount.created`, `discount.updated`, `discount.imported`, `discount_group.created`, `discount_group.updated`, `payment_method.saved`, `payment_method.deleted`, `payout.created`, `payout.paid`, `price.created`, `price.updated`, `price.imported`, `product.created`, `product.updated`, `product.imported`, `report.created`, `report.updated`, `subscription.activated`, `subscription.canceled`, `subscription.created`, `subscription.imported`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.trialing`, `subscription.updated`, `transaction.billed`, `transaction.canceled`, `transaction.completed`, `transaction.created`, `transaction.paid`, `transaction.past_due`, `transaction.payment_failed`, `transaction.ready`, `transaction.revised`, `transaction.updated`.

The Python SDK changelog ([PY] `CHANGELOG.md`) also mentions `api_key_rotation.created` / `api_key_rotation.updated`, which are not in [NODE] 3.12.0 or in the [OAS] commit read here. Unknown `event_type` values must be ignored with a 2xx, not rejected.

### 2.3 Per-event behaviour

All descriptions are condensed from the [OAS] webhook definitions unless tagged otherwise.

| Event | Fires when | `data` | Key state in payload |
| --- | --- | --- | --- |
| `subscription.created` | A subscription is created. "Paddle automatically creates subscriptions for recurring items when automatically-collected transactions are `completed`". `subscription.trialing` or `subscription.activated` typically follow. | Subscription **plus `transaction_id`** (the checkout transaction). "Other subscription events don't include this field, and it is not returned by the API". | `status` `active` or `trialing` |
| `subscription.activated` | "a subscription becomes active. Its `status` field changes to `active`. This means any trial period has elapsed and Paddle has successfully billed the customer." | Subscription | `status: "active"` |
| `subscription.updated` | "a subscription is updated." Known triggers: a scheduled cancel or pause is created ([OAS] `subscription.canceled` / `subscription.paused` descriptions); a renewal (first event of the simulator's renewal scenario, [OAS]); a plan change ([SKILLS] subscription-update); recovery from `past_due` ([WS], section 3). | Subscription | any |
| `subscription.canceled` | "Its `status` field changes to `canceled`." Immediately if canceled immediately, otherwise on the next billing date. | Subscription | `status: "canceled"`, `canceled_at` set, `next_billed_at: null`, `current_billing_period: null`, `scheduled_change: null` (official example) |
| `subscription.past_due` | "a subscription has an unpaid transaction. Its `status` changes to `past_due`." | Subscription | `status: "past_due"`. In the official example `current_billing_period` has already rolled into the new, unpaid period and `next_billed_at` points one further period ahead. |
| `subscription.paused` | "Its `status` field changes to `paused`." Immediately, or on the next billing date after a scheduled pause. | Subscription | `status: "paused"`, `paused_at` set, `next_billed_at: null`, `current_billing_period: null` (official example) |
| `subscription.resumed` | "a subscription is resumed after being paused. Its status field changes to `active`. When resumed, Paddle bills for the subscription immediately." | Subscription | `status: "active"`, new `current_billing_period` |
| `subscription.trialing` | "a subscription enters trial period." | Subscription | `status: "trialing"`, `first_billed_at: null`, item `status: "trialing"` |
| `transaction.paid` | "Its status field changes to `paid`." Payment captured, not yet fully processed: "Payout totals may not be present", "Automatically-collected transactions for recurring items might not yet have a `subscription_id`", might not have `invoice_number`. | Transaction | `status: "paid"`; official example has `subscription_id: null` |
| `transaction.completed` | "Its status field changes to `completed`." Fully processed: payment logged in `payments[]`, fees and payout totals added, subscription created for recurring items and `subscription_id` added, `invoice_number` added. | Transaction | `status: "completed"`, `subscription_id` set when the transaction has recurring items |
| `transaction.payment_failed` | "a payment fails for a transaction. The `payments` array is updated with details of the payment attempt." If it is a subscription renewal: transaction goes `past_due` (`transaction.past_due`) and subscription goes `past_due` (`subscription.past_due`). | Transaction | Official example is a checkout decline: `status: "ready"`, `origin: "web"`, `payments[0].status: "error"`, `error_code: "declined"` |
| `transaction.past_due` | "Automatically-collected transactions for subscription renewals become past due when a payment attempt fails." | Transaction | `status: "past_due"`, `origin: "subscription_recurring"` in the official example |
| `adjustment.created` | "an adjustment is created." Refunds, credits, chargebacks. | Adjustment | Refunds start `pending_approval` in most live cases; credits start `approved` |
| `adjustment.updated` | "only occurs for `refund` adjustments, which must be approved by Paddle and are created as `pending_approval` initially. On review, they move to `approved` or `rejected`". | Adjustment | `status` `approved` or `rejected` |

Other transaction events you will receive if subscribed: `transaction.created` (checkout opened, `status: "draft"`), `transaction.ready`, `transaction.updated`, `transaction.billed`, `transaction.canceled`, `transaction.revised`.

### 2.4 Subscription `data` fields

Wire type: [NODE] `ISubscriptionNotificationResponse` (`dist/types/notifications/types/subscription/subscription-notification-response.d.ts`); descriptions from [OAS] `Subscription`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string `^sub_[a-z\d]{26}$` | |
| `status` | `"active" \| "canceled" \| "past_due" \| "paused" \| "trialing"` | Full enum. See 2.7. |
| `customer_id` | string `ctm_…` | |
| `address_id` | string `add_…` | |
| `business_id` | string \| null | |
| `currency_code` | string | |
| `created_at`, `updated_at` | RFC 3339 | |
| `started_at` | string \| null | "may be different from `first_billed_at` if the subscription started in trial" |
| `first_billed_at` | string \| null | null while trialing (official example) |
| `next_billed_at` | string \| null | null when canceled, paused, or a cancellation is scheduled (the last per [SKILLS] subscription-cancel) |
| `paused_at` | string \| null | |
| `canceled_at` | string \| null | "Set automatically by Paddle when the cancel subscription operation is used. `null` if not canceled." Set only once the cancellation has taken effect (official canceled example); null while only scheduled. |
| `discount` | `{ id, starts_at, ends_at, type }` \| null | |
| `collection_mode` | `"automatic" \| "manual"` | checkout subscriptions are `automatic` |
| `billing_details` | object \| null | invoices only |
| `current_billing_period` | `{ starts_at, ends_at }` \| null | "`null` for `paused` and `canceled` subscriptions." |
| `billing_cycle` | `{ interval: "day"\|"week"\|"month"\|"year", frequency: number }` | |
| `scheduled_change` | `{ action: "cancel"\|"pause"\|"resume", effective_at: string, resume_at: string \| null }` \| null | "`null` if no scheduled changes." `resume_at` "Only used for `pause` scheduled changes." |
| `items[]` | array | Only recurring items. See below. |
| `custom_data` | object \| null | "Your own structured key-value data." Copied from the checkout (5.5). |
| `consent_requirements` | array | |
| `import_meta` | object \| null | |
| `transaction_id` | string `txn_…` | **`subscription.created` only** |
| `management_urls` | n/a | **Not in webhooks.** API only (`GET /subscriptions/{id}`): `{ update_payment_method: string \| null, cancel: string, view_subscription: string }`. |

`items[]` element ([NODE] `ISubscriptionItemNotificationResponse`):

| Field | Type |
| --- | --- |
| `status` | `"active" \| "inactive" \| "trialing"` (`inactive` "Set when the related subscription is paused.") |
| `quantity` | number |
| `recurring` | boolean |
| `created_at`, `updated_at` | string |
| `previously_billed_at`, `next_billed_at` | string \| null |
| `trial_dates` | `{ starts_at, ends_at }` \| null |
| `price` | Price object: `id` (`pri_…`), `product_id`, `name`, `description`, `type`, `status`, `tax_mode`, `unit_price { amount, currency_code }`, `billing_cycle`, `trial_period`, `quantity { minimum, maximum }`, `unit_price_overrides`, `custom_data`, `import_meta`, `created_at`, `updated_at` |
| `product` | Product object: `id` (`pro_…`), `name`, `tax_category`, `description`, `image_url`, `custom_data`, `status`, … |

Plan lookup for the Worker: `data.items[i].price.id` and `data.items[i].quantity`.

### 2.5 Transaction `data` fields

Wire type: [NODE] `ITransactionNotificationResponse`; descriptions from [OAS] `Transaction`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string `^txn_[a-z\d]{26}$` | |
| `status` | `"draft" \| "ready" \| "billed" \| "paid" \| "completed" \| "canceled" \| "past_due"` | Full enum. See 2.7. |
| `origin` | `"api" \| "subscription_charge" \| "subscription_payment_method_change" \| "subscription_recurring" \| "subscription_update" \| "web"` | Full enum. See 2.7. |
| `subscription_id` | string \| null | Null on a one-off purchase. For a subscription checkout it may still be null at `transaction.paid` and is filled by `transaction.completed`. |
| `customer_id`, `address_id`, `business_id` | string \| null | `customer_id` is null on a fresh `draft` (official `transaction.created` example) |
| `custom_data` | object \| null | Copied from `Paddle.Checkout.open({ customData })` |
| `currency_code` | string | |
| `collection_mode` | `"automatic" \| "manual"` | |
| `discount_id` | string \| null | |
| `invoice_id` | string \| null | Deprecated in [OAS] |
| `invoice_number` | string \| null | |
| `billing_details` | object \| null | |
| `billing_period` | `{ starts_at, ends_at }` \| null | "Set automatically by Paddle for subscription renewals to describe the period that charges are for." Also set on the first subscription transaction at `completed` (official example). |
| `items[]` | `{ price: Price, quantity: number, proration: { rate, billing_period } \| null }` | Official examples carry the nested `price` object (read `items[i].price.id`). [NODE] also types an optional `price_id`; it is absent from the official examples. A one-time price has `price.billing_cycle: null`. |
| `details` | `{ tax_rates_used[], totals, adjusted_totals, payout_totals, adjusted_payout_totals, line_items[] }` | `details.line_items[i]` has `id` (`txnitm_…`), `price_id`, `quantity`, `tax_rate`, `unit_totals`, `totals`, `product`, `proration`. `details.totals`: `subtotal`, `discount`, `tax`, `total`, `credit`, `credit_to_balance`, `balance`, `grand_total`, `grand_total_tax`, `fee`, `earnings`, `currency_code`. All amounts are strings in the lowest denomination. |
| `payments[]` | `{ payment_attempt_id, stored_payment_method_id, payment_method_id, amount, status, error_code, method_details, created_at, captured_at }` | "Sorted by `created_at` in descending order, so most recent attempts are returned first." `status`: `authorized`, `authorized_flagged`, `canceled`, `captured`, `error`, `action_required`, `pending_no_action_required`, `created`, `unknown`, `dropped`. `error_code` e.g. `declined`, `declined_not_retryable`, `expired_card`, `not_enough_balance`, `authentication_failed`, `blocked_card`, `fraud` (21 values in [OAS] `ErrorCode`). |
| `checkout` | `{ url: string \| null }` \| null | "composed of the URL passed in the request or your default payment URL + `?_ptxn=` and the Paddle ID for this transaction" |
| `created_at`, `updated_at` | string | |
| `billed_at`, `revised_at` | string \| null | |

### 2.6 Adjustment `data` fields (refunds)

Wire type: [NODE] `IAdjustmentNotificationResponse`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string `^adj_[a-z\d]{26}$` | |
| `action` | `"credit" \| "credit_reverse" \| "refund" \| "chargeback" \| "chargeback_reverse" \| "chargeback_warning" \| "chargeback_warning_reverse"` | `refund`: "Refunds some or all the related transaction. Must be approved by Paddle in most cases." `chargeback`: "Automatically created by Paddle when a customer successfully disputes a charge." |
| `type` | `"full" \| "partial"` | `full`: "The grand total for the related transaction is adjusted." |
| `status` | `"pending_approval" \| "approved" \| "rejected" \| "reversed"` | "Most refunds for live accounts are created with the status of `pending_approval` until reviewed by Paddle, but some are automatically approved. For sandbox accounts, Paddle automatically approves refunds every ten minutes. Credit adjustments don't require approval from Paddle, so they're created as `approved`." |
| `transaction_id` | string `txn_…` | |
| `subscription_id` | string \| null | |
| `customer_id` | string | |
| `reason` | string | |
| `credit_applied_to_balance` | boolean \| null | |
| `currency_code` | string | |
| `items[]` | `{ id, item_id, type: "full"\|"partial"\|"tax"\|"proration", amount, proration, totals }` | `item_id` is the `txnitm_…` line item |
| `totals` | `{ subtotal, tax, total, fee, earnings, currency_code, retained_fee }` | |
| `payout_totals` | object \| null | |
| `tax_rates_used` | array \| null | |
| `created_at`, `updated_at` | string | |

Handling rule from [SKILLS] sandbox-testing: "Don't treat a refund as done on `adjustment.created` — handle `adjustment.updated` moving `status` from `pending_approval` to `approved` (or `rejected`)." A refund does not by itself cancel the subscription ([SKILLS] subscription-cancel: for "cancel and refund", cancel immediately and "also create a refund adjustment").

### 2.7 Enum meanings (verbatim from [OAS] `x-enum-descriptions`)

Subscription `status`:

- `active`: "Subscription is active. Paddle is billing for this subscription and related transactions aren't past due."
- `trialing`: "Subscription is in trial."
- `past_due`: "Subscription has an overdue payment. Automatically set by Paddle when payment fails for an automatically-collected transaction, or when a manually-collected transaction (an invoice) isn't paid 24 hours after its due date."
- `paused`: "Subscription is paused. Automatically set by Paddle when a subscription is paused. When a subscription is set to pause on the next billing period, a scheduled change for the pause is created. The subscription status moves to `paused` when the scheduled change takes effect."
- `canceled`: "Subscription is canceled. Automatically set by Paddle when a subscription is canceled. When a subscription is set to cancel on the next billing period, a scheduled change for the cancellation is created. The subscription status moves to canceled when the scheduled change takes effect."

Transaction `status`:

- `draft`: "Transaction is missing required fields. Typically the first stage of a checkout before customer details are captured."
- `ready`: "Transaction has all of the required fields to be marked as `billed` or `completed`."
- `billed`: "…Typically used as part of an invoice workflow."
- `paid`: "Transaction is fully paid, but has not yet been processed internally."
- `completed`: "Transaction is fully paid and processed."
- `canceled`: "Transaction has been updated to `canceled`. If an invoice, it's no longer due."
- `past_due`: "Transaction is past due. Occurs for automatically-collected transactions when the related subscription is in dunning, and for manually-collected transactions when no payment has been received 24 hours after the due date."

Transaction `origin`:

| `origin` | Official description | What it means for us |
| --- | --- | --- |
| `web` | "Transaction created automatically by Paddle.js for a checkout." | Any Paddle.js checkout opened with `items`: **both** a one-off purchase **and** the first payment of a new subscription. |
| `api` | "Transaction created via the Paddle API." | Includes a transaction you create server-side and then open with `Paddle.Checkout.open({ transactionId })`. |
| `subscription_recurring` | "Transaction created automatically by Paddle as a result of a subscription renewal." | Renewal. |
| `subscription_update` | "Transaction created automatically by Paddle as a result of an update to a subscription." | Proration charge after a plan change. |
| `subscription_charge` | "Transaction created automatically by Paddle as a result of a one-time charge for a subscription." | `POST /subscriptions/{id}/charge`. |
| `subscription_payment_method_change` | "Transaction created automatically as part of updating a payment method. May be a zero value transaction." | Ignore for entitlement. |

`origin` alone does not distinguish a one-off web checkout from a new subscription. [INFER] Distinguish by the items: a one-off purchase is `transaction.completed` with `origin` `web` (or `api`) where the matching `items[i].price.id` is your one-time price (its `price.billing_cycle` is `null`). `subscription_id` is null when the transaction has no recurring items; a mixed checkout (recurring plus one-time item, as in the official example) has `subscription_id` set, so match on price ID, not on `subscription_id` being null.

`scheduled_change.action`:

- `cancel`: "Subscription is scheduled to cancel. Its status changes to `canceled` on the `effective_at` date."
- `pause`: "Subscription is scheduled to pause. Its status changes to `paused` on the `effective_at` date."
- `resume`: "Subscription is scheduled to resume. Its status changes to `active` on the `effective_at` date."

### 2.8 Sample payloads

**A. `subscription.created`** — official [OAS] example, trimmed: the second item was removed and the nested `product` object reduced to four fields. Full original: `paddle-samples/subscription.created.json`.

```json
{
  "event_id": "evt_01hv8x2acma2gz7he8kg2s0hna",
  "event_type": "subscription.created",
  "occurred_at": "2024-04-12T10:18:49.621022Z",
  "notification_id": "ntf_01hv8x2af22vrrz7k67g06x1kq",
  "data": {
    "id": "sub_01hv8x29kz0t586xy6zn1a62ny",
    "items": [
      {
        "price": {
          "id": "pri_01gsz8x8sawmvhz1pv30nge1ke",
          "name": "Monthly (per seat)",
          "type": "standard",
          "status": "active",
          "quantity": {"maximum": 999, "minimum": 1},
          "tax_mode": "account_setting",
          "created_at": "2023-02-23T13:55:22.538367Z",
          "product_id": "pro_01gsz4t5hdjse780zja8vvr7jg",
          "unit_price": {"amount": "3000", "currency_code": "USD"},
          "updated_at": "2024-04-11T13:54:52.254748Z",
          "custom_data": null,
          "description": "Monthly",
          "import_meta": null,
          "trial_period": null,
          "billing_cycle": {"interval": "month", "frequency": 1},
          "unit_price_overrides": []
        },
        "product": {
          "id": "pro_01gsz4t5hdjse780zja8vvr7jg",
          "name": "AeroEdit Pro",
          "tax_category": "standard",
          "status": "active"
        },
        "status": "active",
        "quantity": 10,
        "recurring": true,
        "created_at": "2024-04-12T10:18:48.831Z",
        "updated_at": "2024-04-12T10:18:48.831Z",
        "trial_dates": null,
        "next_billed_at": "2024-05-12T10:18:47.635628Z",
        "previously_billed_at": "2024-04-12T10:18:47.635628Z"
      }
    ],
    "status": "active",
    "discount": null,
    "paused_at": null,
    "address_id": "add_01hv8gq3318ktkfengj2r75gfx",
    "created_at": "2024-04-12T10:18:48.831Z",
    "started_at": "2024-04-12T10:18:47.635628Z",
    "updated_at": "2024-04-12T10:18:48.831Z",
    "business_id": null,
    "canceled_at": null,
    "custom_data": null,
    "customer_id": "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    "import_meta": null,
    "billing_cycle": {"interval": "month", "frequency": 1},
    "currency_code": "USD",
    "next_billed_at": "2024-05-12T10:18:47.635628Z",
    "transaction_id": "txn_01hv8wptq8987qeep44cyrewp9",
    "billing_details": null,
    "collection_mode": "automatic",
    "first_billed_at": "2024-04-12T10:18:47.635628Z",
    "scheduled_change": null,
    "consent_requirements": [],
    "current_billing_period": {"ends_at": "2024-05-12T10:18:47.635628Z", "starts_at": "2024-04-12T10:18:47.635628Z"}
  }
}
```

**B. `subscription.updated` after "cancel at period end"** — **constructed, not copied.** Base is the official `subscription.updated` example (one item kept, product reduced, `consent_requirements` emptied); I then set `scheduled_change`, `next_billed_at: null`, item `next_billed_at: null` and a `custom_data` value to show the shape that [SKILLS] subscription-cancel describes ("sets `scheduledChange.action: 'cancel'` and `scheduledChange.effectiveAt: '<period-end-date>'`, and sets `nextBilledAt` to `null`"). The exact `effective_at` value and the item-level `next_billed_at` are my assumptions.

```json
{
  "event_id": "evt_01hv8ytwcg91n07pa4jmvsdcst",
  "event_type": "subscription.updated",
  "occurred_at": "2024-04-12T10:49:43.056742Z",
  "notification_id": "ntf_01hv8ytwevhn1sdtwzhf4rz548",
  "data": {
    "id": "sub_01hv8x29kz0t586xy6zn1a62ny",
    "items": [
      {
        "price": {
          "id": "pri_01gsz8x8sawmvhz1pv30nge1ke",
          "name": "Monthly (per seat)",
          "type": "standard",
          "status": "active",
          "quantity": {"maximum": 999, "minimum": 1},
          "tax_mode": "account_setting",
          "created_at": "2023-02-23T13:55:22.538367Z",
          "product_id": "pro_01gsz4t5hdjse780zja8vvr7jg",
          "unit_price": {"amount": "3000", "currency_code": "USD"},
          "updated_at": "2024-04-11T13:54:52.254748Z",
          "custom_data": null,
          "description": "Monthly",
          "import_meta": null,
          "trial_period": null,
          "billing_cycle": {"interval": "month", "frequency": 1},
          "unit_price_overrides": []
        },
        "product": {
          "id": "pro_01gsz4t5hdjse780zja8vvr7jg",
          "name": "AeroEdit Pro",
          "tax_category": "standard",
          "status": "active"
        },
        "status": "active",
        "quantity": 20,
        "recurring": true,
        "created_at": "2024-04-12T10:38:00.761Z",
        "updated_at": "2024-04-12T10:49:38.76Z",
        "trial_dates": null,
        "next_billed_at": null,
        "previously_billed_at": "2024-04-12T10:37:59.556997Z"
      }
    ],
    "status": "active",
    "discount": null,
    "paused_at": null,
    "address_id": "add_01hv8gq3318ktkfengj2r75gfx",
    "created_at": "2024-04-12T10:38:00.761Z",
    "started_at": "2024-04-12T10:37:59.556997Z",
    "updated_at": "2024-04-12T10:49:38.771Z",
    "business_id": null,
    "canceled_at": null,
    "custom_data": {"user_id": "usr_123"},
    "customer_id": "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    "import_meta": null,
    "billing_cycle": {"interval": "month", "frequency": 1},
    "currency_code": "USD",
    "next_billed_at": null,
    "billing_details": null,
    "collection_mode": "automatic",
    "first_billed_at": "2024-04-12T10:37:59.556997Z",
    "scheduled_change": {"action": "cancel", "effective_at": "2024-05-12T10:37:59.556997Z", "resume_at": null},
    "consent_requirements": [],
    "current_billing_period": {"ends_at": "2024-05-12T10:37:59.556997Z", "starts_at": "2024-04-12T10:37:59.556997Z"}
  }
}
```

**C. `transaction.completed`** — official [OAS] example (a checkout with two recurring items plus a one-time item), trimmed: the middle item and its line item removed, nested `price` reduced to 12 fields, line-item `product` reduced to four fields, and `details.payout_totals`, `details.adjusted_totals`, `details.adjusted_payout_totals` removed. Full original: `paddle-samples/transaction.completed.json`. `details.totals` and `tax_rates_used` are left as in the original, so they still reflect all three original items. Note `origin: "web"`, `subscription_id` set, the one-time item's `price.billing_cycle: null`, two entries in `payments` (newest first: one `captured`, one earlier `error` with `error_code: "declined"`), and tax added on top of the subtotal (`subtotal 59900`, `tax 5315`, `total 65215`).

```json
{
  "event_id": "evt_01hv8x2axb33yr5y238zfwcn5p",
  "event_type": "transaction.completed",
  "occurred_at": "2024-04-12T10:18:50.155553Z",
  "notification_id": "ntf_01hv8x2azy7scaan4s0eb0273x",
  "data": {
    "id": "txn_01hv8wptq8987qeep44cyrewp9",
    "items": [
      {
        "price": {
          "id": "pri_01gsz8x8sawmvhz1pv30nge1ke",
          "product_id": "pro_01gsz4t5hdjse780zja8vvr7jg",
          "name": "Monthly (per seat)",
          "description": "Monthly",
          "type": "standard",
          "status": "active",
          "tax_mode": "account_setting",
          "unit_price": {"amount": "3000", "currency_code": "USD"},
          "billing_cycle": {"interval": "month", "frequency": 1},
          "trial_period": null,
          "quantity": {"maximum": 999, "minimum": 1},
          "custom_data": null
        },
        "quantity": 10,
        "proration": null
      },
      {
        "price": {
          "id": "pri_01gsz98e27ak2tyhexptwc58yk",
          "product_id": "pro_01gsz97mq9pa4fkyy0wqenepkz",
          "name": "One-time addon",
          "description": "One-time addon",
          "type": "standard",
          "status": "active",
          "tax_mode": "account_setting",
          "unit_price": {"amount": "19900", "currency_code": "USD"},
          "billing_cycle": null,
          "trial_period": null,
          "quantity": {"maximum": 1, "minimum": 1},
          "custom_data": null
        },
        "quantity": 1,
        "proration": null
      }
    ],
    "origin": "web",
    "status": "completed",
    "details": {
      "totals": {
        "fee": "3311",
        "tax": "5315",
        "total": "65215",
        "credit": "0",
        "balance": "0",
        "discount": "0",
        "earnings": "56589",
        "subtotal": "59900",
        "grand_total": "65215",
        "grand_total_tax": "5315",
        "currency_code": "USD",
        "credit_to_balance": "0"
      },
      "line_items": [
        {
          "id": "txnitm_01hv8wt98jahpbm1t1tzr06z6n",
          "totals": {"tax": "2662", "total": "32662", "discount": "0", "subtotal": "30000"},
          "product": {
            "id": "pro_01gsz4t5hdjse780zja8vvr7jg",
            "name": "AeroEdit Pro",
            "tax_category": "standard",
            "status": "active"
          },
          "price_id": "pri_01gsz8x8sawmvhz1pv30nge1ke",
          "quantity": 10,
          "tax_rate": "0.08875",
          "unit_totals": {"tax": "266", "total": "3266", "discount": "0", "subtotal": "3000"},
          "proration": null
        },
        {
          "id": "txnitm_01hv8wt98jahpbm1t1v67vqnb6",
          "totals": {"tax": "1766", "total": "21666", "discount": "0", "subtotal": "19900"},
          "product": {
            "id": "pro_01gsz97mq9pa4fkyy0wqenepkz",
            "name": "Custom domains",
            "tax_category": "standard",
            "status": "active"
          },
          "price_id": "pri_01gsz98e27ak2tyhexptwc58yk",
          "quantity": 1,
          "tax_rate": "0.08875",
          "unit_totals": {"tax": "1766", "total": "21666", "discount": "0", "subtotal": "19900"},
          "proration": null
        }
      ],
      "tax_rates_used": [
        {
          "totals": {"tax": "5315", "total": "65215", "discount": "0", "subtotal": "59900"},
          "tax_rate": "0.08875"
        }
      ]
    },
    "checkout": {"url": "https://aeroedit.com/pay?_ptxn=txn_01hv8wptq8987qeep44cyrewp9"},
    "payments": [
      {
        "amount": "65215",
        "status": "captured",
        "created_at": "2024-04-12T10:18:33.579142Z",
        "error_code": null,
        "captured_at": "2024-04-12T10:18:47.635628Z",
        "method_details": {
          "type": "card",
          "underlying_details": null,
          "south_korea_local_card": null,
          "card": {
            "type": "visa",
            "last4": "3184",
            "expiry_year": 2025,
            "expiry_month": 1,
            "cardholder_name": "Sam Miller"
          },
          "paypal": null
        },
        "payment_method_id": "paymtd_01hv8x1tpjfnttxddw73xnqx6s",
        "payment_attempt_id": "937640dd-e3dc-40df-a16c-bb75aafd8f71",
        "stored_payment_method_id": "281ff2ca-8550-42b9-bf39-15948e7de62d"
      },
      {
        "amount": "65215",
        "status": "error",
        "created_at": "2024-04-12T10:15:57.888183Z",
        "error_code": "declined",
        "captured_at": null,
        "method_details": {
          "type": "card",
          "underlying_details": null,
          "south_korea_local_card": null,
          "card": {
            "type": "visa",
            "last4": "0002",
            "expiry_year": 2025,
            "expiry_month": 1,
            "cardholder_name": "Sam Miller"
          },
          "paypal": null
        },
        "payment_method_id": "paymtd_01hv8wx2mka7dfsqjjsxh1ne7z",
        "payment_attempt_id": "8f72cfa6-26b4-4a57-91dc-8f2708f7822d",
        "stored_payment_method_id": "a78ece50-356f-4e0c-b72d-ad5368b0a0d9"
      }
    ],
    "billed_at": "2024-04-12T10:18:48.294633Z",
    "address_id": "add_01hv8gq3318ktkfengj2r75gfx",
    "created_at": "2024-04-12T10:12:33.2014Z",
    "invoice_id": "inv_01hv8x29nsh54c2pgt0hnq0zkx",
    "updated_at": "2024-04-12T10:18:49.738971238Z",
    "revised_at": null,
    "business_id": null,
    "custom_data": null,
    "customer_id": "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    "discount_id": null,
    "currency_code": "USD",
    "billing_period": {"ends_at": "2024-05-12T10:18:47.635628Z", "starts_at": "2024-04-12T10:18:47.635628Z"},
    "invoice_number": "325-10566",
    "billing_details": null,
    "collection_mode": "automatic",
    "subscription_id": "sub_01hv8x29kz0t586xy6zn1a62ny"
  }
}
```

**D. `adjustment.created`** — official [OAS] example, verbatim. (`adjustment.updated` has the same shape; the official `adjustment.updated` example also shows `status: "pending_approval"`.)

```json
{
  "event_id": "evt_01hvgf2skkg8dsk5dczemw2bx1",
  "event_type": "adjustment.created",
  "occurred_at": "2024-04-15T08:48:20.595926Z",
  "notification_id": "ntf_01hvgf2spk3bvewnw8t2zrnbmb",
  "data": {
    "id": "adj_01hvgf2s84dr6reszzg29zbvcm",
    "items": [
      {
        "id": "adjitm_01hvgf2s84dr6reszzg2gx70gj",
        "type": "partial",
        "amount": "100",
        "totals": {"tax": "8", "total": "100", "subtotal": "92"},
        "item_id": "txnitm_01hvcc94b7qgz60qmrqmbm19zw",
        "proration": null
      }
    ],
    "action": "refund",
    "type": "partial",
    "reason": "error",
    "status": "pending_approval",
    "totals": {
      "fee": "5",
      "tax": "8",
      "total": "100",
      "earnings": "87",
      "subtotal": "92",
      "currency_code": "USD",
      "retained_fee": "5"
    },
    "created_at": "2024-04-15T08:48:20.239695Z",
    "updated_at": "2024-04-15T08:48:20.239695Z",
    "customer_id": "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    "currency_code": "USD",
    "payout_totals": {
      "fee": "5",
      "tax": "8",
      "total": "100",
      "earnings": "87",
      "subtotal": "92",
      "currency_code": "USD",
      "retained_fee": "5",
      "chargeback_fee": {"amount": "0", "original": null}
    },
    "transaction_id": "txn_01hvcc93znj3mpqt1tenkjb04y",
    "subscription_id": "sub_01hvccbx32q2gb40sqx7n42430",
    "credit_applied_to_balance": null,
    "tax_rates_used": null
  }
}
```

Other official examples worth opening in `paddle-samples/`: `subscription.past_due.json`, `subscription.canceled.json`, `subscription.paused.json`, `transaction.past_due.json` (`origin: "subscription_recurring"`, `payments[0].error_code: "authentication_failed"`), `transaction.payment_failed.json`, `transaction.paid.json`.

### 2.9 Typing raw payloads without the SDK at runtime

[TEST] `import type { IEvents, IEventsResponse, IEventName, ISubscriptionNotificationResponse, ISubscriptionCreatedNotificationResponse, ITransactionNotificationResponse, IAdjustmentNotificationResponse, SubscriptionStatus, TransactionOrigin, TransactionStatus } from "@paddle/paddle-node-sdk"` type-checks with TypeScript 5.6.3 (`strict`, `moduleResolution: "bundler"`, `skipLibCheck`), and the `IEvents` union narrows `data` when you compare `event_type` to a string literal. These `I…NotificationResponse` interfaces are the snake_case wire shapes. A type-only import emits no runtime code. (`scratchpad/tscheck/check.ts`.)

---

## 3. "Payment recovered" and the end of dunning

### 3.1 Renewal payment fails

[OAS] `transaction.payment_failed`: "If related to a subscription renewal: The transaction status changes to `past_due` and `transaction.past_due` occurs. The related subscription status changes to `past_due` and `subscription.past_due` occurs."

So one failed renewal produces: `transaction.payment_failed` (renewal transaction, `origin: "subscription_recurring"`, a new entry in `payments[]` with `status: "error"` and an `error_code`), `transaction.past_due`, `subscription.past_due`. The simulator's failed-renewal option sends exactly these three ([SKILLS] sandbox-testing: "`"failed"` swaps the payment events for `transaction.payment_failed`, `transaction.past_due` and `subscription.past_due`").

While `past_due`: [OAS] update-subscription, "You can't update a subscription that's `past_due`, except to remove a scheduled change by setting `scheduled_change` to `null`." It can still be canceled (section 4).

### 3.2 Retries (dunning)

- [WS] https://developer.paddle.com/changelog/2025/default-dunning-payment-recovery/ : "Failed payments for automatically-collected subscriptions are now automatically retried up to seven times over 30 days." and "If customers don't update their payment method, the subscription is automatically canceled after 30 days." Also: "No payment retries occur on sandbox accounts."
- [SKILLS] sandbox-testing table: "Dunning (Retain): Sandbox: Not available. Live: Available. Retain handles canceling or pausing past due subscriptions."
- [WS] https://developer.paddle.com/build/retain/configure-payment-recovery-dunning/ : with Paddle Retain Payment Recovery you can choose whether past due subscriptions pause or cancel after all recovery attempts are exhausted, and configure the recovery window.

### 3.3 Payment recovered

- [WS] https://developer.paddle.com/webhooks/subscriptions/subscription-past-due/ : "Paddle retries payment according to your payment recovery settings. If payment succeeds, the subscription returns to active and `subscription.updated` occurs. If recovery attempts are exhausted, the subscription is canceled and `subscription.canceled` occurs."
- [OAS] simulator options name two recovery paths: `recovered_existing_payment_method` ("fails initially and the payment is recovered when retrying the existing payment method") and `recovered_updated_payment_method` ("fails initially and the customer updates their payment method to successfully pay").

So there is **no dedicated "recovered" event**. Recovery is a `subscription.updated` whose `data.status` is `active` when your stored status was `past_due`.

[INFER] The past-due renewal transaction should also move to `paid` then `completed`, emitting `transaction.paid` and `transaction.completed` for the same `txn_…` with `origin: "subscription_recurring"`. This follows from the definitions of those events but I found no official event-by-event listing of the recovery sequence, and no statement on whether `subscription.activated` fires on `past_due → active`. Do not depend on `subscription.activated` for recovery; drive state from `data.status` on every `subscription.*` event.

### 3.4 End of dunning

- Default: subscription is canceled, `subscription.canceled` fires with `status: "canceled"` ([WS] pages above).
- If Retain is configured to pause instead: `subscription.paused` ([OAS] simulator `dunning_exhausted_action`: `subscription_paused` or `subscription_canceled`).
- [INFER] The unpaid renewal transaction is canceled at that point (`transaction.canceled`). Basis: [OAS] cancellation simulation option `has_past_due_transaction`, "determines whether events occur for canceling past due transactions", and [SKILLS] subscription-cancel on immediate cancel, "it cancels any unpaid transactions on automatically-collected subscriptions".

### 3.5 Testing this in sandbox

Sandbox does not retry. Options: card `4000 0027 6000 3184` (first charge succeeds, renewals decline) to get a real `past_due`; simulator scenario `subscription_renewal` with `config.subscription_renewal.options.payment_outcome` set to `failed`, `recovered_existing_payment_method` or `recovered_updated_payment_method`, and `dunning_exhausted_action` (`subscription_paused` | `subscription_canceled`, only with `failed`) ([OAS] `SimulationConfigOptionsPayment`). Running the two `recovered_*` simulations is the fastest way to settle the [INFER] items in 3.3.

---

## 4. Cancellation semantics

`POST /subscriptions/{subscription_id}/cancel`, body `{ "effective_from": "next_billing_period" | "immediately" }`. `effective_from` defaults to `next_billing_period` ([OAS] `SubscriptionCancel`, `EffectiveFrom`: "Defaults to `next_billing_period`, which creates a `scheduled_change` to apply the subscription change at the end of the billing period.").

[OAS] cancel-subscription description, verbatim:

> By default, active subscriptions are canceled at the end of the billing period. When you send a request to cancel, Paddle creates a `scheduled_change` against the subscription entity to say that it should cancel at the end of the current billing period. Its `status` remains `active` until after the effective date of the scheduled change, at which point it changes to `canceled`.
>
> You can cancel a subscription right away by including `effective_from` in your request, setting the value to `immediately`. If successful, your response includes a copy of the updated subscription entity with the `status` of `canceled`. Paused subscriptions can only be canceled immediately, so you must set `effective_from` to `immediately` to cancel them.
>
> You can cancel subscriptions that are `past_due`. If you cancel at the end of the billing period, the `status` remains `past_due` until the end of the current billing period. Cancel immediately to stop the subscription right away.
>
> You can't reinstate a canceled subscription.

| | `next_billing_period` (default) | `immediately` |
| --- | --- | --- |
| At request time | `subscription.updated`. `status` unchanged (`active`, `trialing` or `past_due`). `scheduled_change = { action: "cancel", effective_at: <period end>, resume_at: null }`. `next_billed_at` becomes `null`. `canceled_at` stays `null`. | `subscription.canceled` with `status: "canceled"`, `canceled_at` set, `current_billing_period: null`, `next_billed_at: null`. The simulator's default cancellation scenario lists `subscription.updated` then `subscription.canceled`. |
| Between request and effect | Subscription keeps its status; customer keeps access. | n/a |
| At `effective_at` | "Paddle fires both `subscription.updated` and `subscription.canceled`, each carrying `status: 'canceled'`. Don't depend on which arrives first." `scheduled_change` clears. | n/a |
| Money | No refund, period already paid. | "Paddle doesn't refund or credit anything; it cancels any unpaid transactions on automatically-collected subscriptions." |

Sources: [OAS] `subscription.canceled` description and examples; [SKILLS] subscription-cancel ("What the user sees vs what the database stores") and sandbox-testing.

Other rules:

- Undo a scheduled cancel: `PATCH /subscriptions/{id}` with `{ "scheduled_change": null }` ([OAS] `SubscriptionUpdate.scheduled_change`: "When updating, you may only set to `null` to remove a scheduled change."). This is also the only update allowed while `past_due`.
- Renewal lock: "within 30 minutes of the next renewal, both [cancel and undo] return 409 `subscription_locked_renewal`" ([SKILLS] subscription-cancel). A second scheduled change returns `subscription_locked_pending_changes` (same file).
- Paused subscription with `next_billing_period`: 400 `bad_request` with an error on `effective_from` ([SKILLS]).
- A canceled subscription cannot be reinstated; the customer needs a new checkout ([OAS]; [SKILLS] subscription-update: `subscription_update_when_canceled`).
- Customer-initiated cancel through the customer portal produces the same events. [INFER] Which `effective_from` the portal uses was not verified.

**"Back to Free at period end" rule** [INFER from the above]: treat the user as Pro while `status ∈ {active, trialing, past_due}` regardless of `scheduled_change`; show "Pro until `scheduled_change.effective_at`" when `scheduled_change?.action === "cancel"`; downgrade to Free only when `status` becomes `canceled` (or `paused`, if you ever pause). Paddle's own access gate in [SKILLS] subscription-sync is `["active", "trialing", "past_due"].includes(status)`, with "During `past_due`, keep access but show a banner asking the user to update their payment method".

---

## 5. Paddle.js v2

### 5.1 Loading

- Script URL: `https://cdn.paddle.com/paddle/v2/paddle.js`. [JS] `dist/index.esm.js`: `var PaddleBillingCDNUrl = 'https://cdn.paddle.com/paddle/v2/paddle.js';` (the Classic URL is `https://cdn.paddle.com/paddle/paddle.js`, do not use it).
- [JS] README: "For security and compliance, you must only load Paddle.js directly from `https://cdn.paddle.com/`." Do not self-host or bundle it.
- The script defines the global `Paddle` ([JS] `types/index.d.ts`, `interface Window { Paddle?: Paddle }`).
- For a plain static HTML site (this repo), a `<script src>` tag is enough; `@paddle/paddle-js` is only a loader plus types (`initializePaddle({ environment, token, … })` injects the same script, calls `Paddle.Environment.set(environment)` if given, then `Paddle.Initialize(rest)`, or `Paddle.Update(rest)` if already initialised).

### 5.2 Environment and initialisation

```html
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  Paddle.Environment.set("sandbox");          // sandbox only; remove for live
  Paddle.Initialize({
    token: "test_xxxxxxxxxxxxxxxxxxxxxxxxxxx", // client-side token
    eventCallback: function (event) { /* event.name, event.data */ }
  });
</script>
```

(Snippet is mine, assembled from the types and loader below.)

- `Paddle.Environment.set(environment: "production" | "sandbox")` ([JS] `Environments`). Call it before `Paddle.Initialize()` ([JS] loader order; [WS] https://developer.paddle.com/paddlejs/include-paddlejs). For live: "Remove `Paddle.Environment.set("sandbox")` from your frontend. Without it, Paddle.js uses your live account." ([WS] go-live checklist).
- `Paddle.Initialize(options: PaddleSetupOptions)` ([JS] `types/checkout/checkout.d.ts`):

| Option | Type | Notes |
| --- | --- | --- |
| `token` | string | Client-side token. Mutually exclusive with `seller`. |
| `seller` | number | Legacy alternative to `token` (`token?: never` when set). |
| `eventCallback` | `(event: PaddleEventData) => void` | All checkout events. |
| `checkout` | `{ settings: CheckoutSettings }` | Default settings for every checkout opened. |
| `pwCustomer` | `{ id?: string; email?: string }` | Paddle Retain customer. |
| `pwAuth` | string | Retain. |
| `debug` | boolean | |

- `Paddle.Initialized: boolean`; `Paddle.Update(options)` changes options after initialisation. "Calling `initializePaddle` twice — the second call doesn't initialize again; it calls `Paddle.Update()` with the new options" ([SKILLS] checkout-web).
- `Paddle.Setup()` is deprecated: "Use `Paddle.Initialize` instead." ([JS]).

### 5.3 Client-side token

- Prefix `test_` (sandbox) or `live_` (live). [OAS] `ClientTokenToken`: "A client-side token, prefixed with `test` or `live` depending on the environment of your account. Pass as the `token` parameter when initializing Paddle.js to authenticate." Example in spec: `live_7d279f61a3499fed520f7cd8c08`. [SKILLS]: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...`.
- Safe to expose in frontend code. Never put an API key in Paddle.js ([WS] https://developer.paddle.com/paddlejs/client-side-tokens).
- Create in the dashboard: **Paddle > My account > Settings > Authentication**, **Client-side tokens** tab ([SKILLS] checkout-web), or `POST /client-tokens` (permission `client_token.write`).
- A sandbox token with the live environment (or the reverse) makes checkout fail to load ([SKILLS] checkout-web).

### 5.4 `Paddle.Checkout.open(options)`

Exact option names from [JS] `CheckoutOpenOptions`:

| Option | Type | Notes |
| --- | --- | --- |
| `items` | `{ priceId: string; quantity?: number }[]` | Mutually exclusive with `transactionId`. |
| `transactionId` | string | Open a checkout for an existing transaction (`txn_…`). |
| `customer` | `{ email: string } \| { id: string }`, plus optional `address` and `business` | `id` and `email` are mutually exclusive. `address`: `{ id }` or `{ countryCode?, postalCode?, region?, city?, firstLine? }`. `business`: `{ id }` or `{ name, taxIdentifier }`. Mutually exclusive with `customerAuthToken`. |
| `customerAuthToken` | string | With optional `savedPaymentMethodId`. |
| `customData` | `Record<string, unknown>` | See 5.5. |
| `discountCode` | string \| null | Mutually exclusive with `discountId`. |
| `discountId` | string \| null | |
| `settings` | `CheckoutSettings` | Per-checkout settings, below. |
| `upsell` | `{ transactionId: string; settings?: { showSkipButton?: boolean } }` | |

`CheckoutSettings` ([JS]):

| Setting | Type | Notes |
| --- | --- | --- |
| `displayMode` | `"overlay" \| "inline"` | Default `overlay` ([SKILLS] checkout-web: "no `displayMode` setting needed (overlay is the default)"; [WS] Paddle.Checkout.open reference). |
| `variant` | `"multi-page" \| "one-page" \| "express"` | "Multi-page is the default. One-page is recommended for most use cases." `express` is inline only. ([SKILLS]) |
| `theme` | `"light" \| "dark"` | |
| `locale` | string | |
| `successUrl` | string | Must be an absolute `http(s)://` URL. "`Checkout.open()` throws on a relative URL" ([SKILLS]). |
| `allowLogout` | boolean | Default true ([WS]). Set false when you prefill an authenticated user. |
| `showAddDiscounts` | boolean | |
| `showAddTaxId` | boolean | |
| `allowDiscountRemoval` | boolean | |
| `allowedPaymentMethods` | array of `alipay`, `apple_pay`, `bancontact`, `blik`, `card`, `google_pay`, `ideal`, `kakao_pay`, `south_korea_local_card`, `mb_way`, `naver_pay`, `payco`, `paypal`, `pix`, `samsung_pay`, `saved_payment_methods`, `upi`, `wechat_pay` | |
| `showNonExpressPaymentMethods` | boolean | express only |
| `frameTarget` | string | Inline only: class name of the container element (no leading dot). |
| `frameInitialHeight` | number | Inline only. |
| `frameStyle` | string | Inline only. |

Other methods ([JS] `interface Paddle`): `Paddle.Checkout.updateCheckout(input)`, `Paddle.Checkout.updateItems(items)`, `Paddle.Checkout.close()`, `Paddle.PricePreview(params)`, `Paddle.TransactionPreview(params)`, `Paddle.Retain.demo()`, `Paddle.Retain.initCancellationFlow()`, `Paddle.Spinner.show()/hide()`, `Paddle.Status.libraryVersion`.

Example for this project (mine, built from the types):

```js
Paddle.Checkout.open({
  items: [{ priceId: "pri_01...", quantity: 1 }],
  customer: { email: "user@example.com" },   // or { id: "ctm_01..." }
  customData: { user_id: "usr_123" },
  settings: {
    displayMode: "overlay",
    variant: "one-page",
    successUrl: "https://example.com/billing/success",
    allowLogout: false
  }
});
```

### 5.5 `customData` to `custom_data`

- [SKILLS] subscription-sync: "Open checkout with `customData: { userId: user.id }`… Paddle copies the checkout's custom data onto the transaction, and onto the subscription created from it. `subscription.created` arrives with `data.customData.userId`." (That is the SDK's camelCased view; on the wire the field is `data.custom_data`.)
- [WS] https://developer.paddle.com/build/transactions/custom-data/ : "Custom data added to a checkout via Paddle.js is stored against the related transaction, and also against the subscription if the checkout includes recurring items."
- So read the user mapping from `data.custom_data` on `transaction.*` and `subscription.*` events. Renewal transactions: [INFER] not verified whether `custom_data` is repeated on `subscription_recurring` transactions; for renewals look the user up by `subscription_id` or `customer_id`.
- Not verified: whether keys inside `customData` are passed through byte-for-byte to the raw webhook JSON. A single-word lowercase key (for example `uid`) avoids any camelCase/snake_case doubt.
- Fallback mapping: by `customer_id` (store it from the first event) or by customer email ([SKILLS] subscription-sync keeps email as a fallback).
- `customData` is set by the browser and so is user-controllable. [INFER] If the user ID must not be forgeable, sign it or create the transaction server-side.

### 5.6 Checkout events (`eventCallback`)

`event.name` values ([JS] `CheckoutEventNames`): `checkout.loaded`, `checkout.closed`, `checkout.updated`, `checkout.completed`, `checkout.error`, `checkout.failed`, `checkout.items.updated`, `checkout.items.removed`, `checkout.customer.created`, `checkout.customer.updated`, `checkout.customer.removed`, `checkout.payment.selected`, `checkout.payment.initiated`, `checkout.payment.failed`, `checkout.payment.error`, `checkout.discount.applied`, `checkout.discount.removed`, `checkout.upsell.canceled`.

`event.data` ([JS] `CheckoutEventsData`, snake_case): `id`, `transaction_id`, `status` (`draft|ready|completed|billed|paid|canceled|past_due`), `custom_data`, `currency_code`, `customer { id, email, address, business }`, `items[] { price_id, price_name, product { id, name, … }, quantity, billing_cycle, trial_period, totals, recurring_totals }`, `totals { subtotal, tax, total, discount, credit, balance }` (numbers), `recurring_totals`, `payment.method_details`, `settings { display_mode, theme }`, `discount`, `upsell`.

Error events (`checkout.error`, `checkout.payment.error`) have no `data`; `name`, `type`, `code`, `detail`, `documentation_url` are top-level ([JS] `CheckoutEventError`, CHANGELOG 1.6.1). `checkout.warning` has no `name`; match `event.type === "checkout.warning"` ([SKILLS]).

"**Provisioning belongs in the webhook**, not the redirect or `checkout.completed`" — `checkout.completed` can fire while payment is still processing ([SKILLS] checkout-web).

---

## 6. REST API

### 6.1 Basics

| Item | Value | Source |
| --- | --- | --- |
| Sandbox base URL | `https://sandbox-api.paddle.com` | [OAS] `servers`; [NODE] `internal/api/constants.js` |
| Live base URL | `https://api.paddle.com` | same |
| Auth | `Authorization: Bearer <API key>` | [OAS] `securitySchemes.BearerAuth`: "Provide your API key as a Bearer token in the Authorization header." |
| Other headers | `Content-Type: application/json`. Optional `Paddle-Version: 1` to pin the API version ([PY] `Client.py` sends `"Paddle-Version": str(self.use_api_version)`, default 1; [WS] versioning page). | |
| API key format | Sandbox `pdl_sdbx_apikey_…`, live `pdl_live_apikey_…` ([SKILLS] sandbox-testing). [WS] https://developer.paddle.com/api-reference/about/authentication/ : regex `^pdl_(live\|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$`, 69 characters, case-sensitive. Keys created before 2025-05-06 are legacy 50-character lowercase alphanumeric strings without permissions. | |
| Environment mismatch | A sandbox key against the live API (or reverse) returns a `forbidden` error ([WS] same page). | |
| Where to create | **Paddle > My account > Settings > Authentication**, **API keys** tab ([SKILLS]; [OAS] links `https://vendors.paddle.com/settings/authentication`). Sandbox dashboard is `sandbox-vendors.paddle.com`. ([NODE] README still says "Paddle > Developer tools > Authentication"; the dashboard navigation appears to have been renamed.) | |
| Success body | `{ "data": …, "meta": { "request_id": "…" } }`; list endpoints add `meta.pagination { per_page, next, has_more, estimated_total }`. Page with `?after=<last id>`; `per_page` default 50, max 200. | [OAS] `Meta`, `Pagination` |
| Error body | `{ "error": { "type": "request_error" \| "api_error", "code": "snake_case", "detail": "…", "documentation_url": "…", "errors": [{ "field", "message" }]? }, "meta": { "request_id" } }` | [OAS] `ErrorResponse`, `ApiError` |
| ID patterns | `^(sub\|txn\|ctm\|pri\|pro\|adj\|add\|evt\|ntf\|ntfset\|ctkn\|cpls\|paymtd)_[a-z\d]{26}$` | [OAS] |

Permissions this Worker's key needs ([OAS] `x-permissions`): `customer_portal_session.write`, `subscription.read`, `subscription.write`, `customer.read`, `price.read`. Verifying webhooks needs no API permission.

### 6.2 Create a customer portal session

```
POST /customers/{customer_id}/portal-sessions        permission: customer_portal_session.write
{ "subscription_ids": ["sub_01h04vsc0qhwtsbsxh3422wjs4"] }
→ 201
```

- Request body is required by the spec; `subscription_ids` is optional. [NODE] sends `{}` when none are given. "`subscriptionIds` can hold up to 25 unique IDs, and each must belong to the customer — otherwise the API returns a 400." ([SKILLS] customer-portal)
- Response `data` ([OAS] example, tokens shortened here):

```json
{
  "data": {
    "id": "cpls_01h4ge9r64c22exjsx0fy8b48b",
    "customer_id": "ctm_01gysfvfy7vqhpzkq8rjmrq7an",
    "urls": {
      "general": {
        "overview": "https://customer-portal.paddle.com/cpl_01j7zbyqs3vah3aafp4jf62qaw?action=overview&token=pga_…"
      },
      "subscriptions": [
        {
          "id": "sub_01h04vsc0qhwtsbsxh3422wjs4",
          "cancel_subscription": "https://customer-portal.paddle.com/cpl_…?action=cancel_subscription&subscription_id=sub_…&token=pga_…",
          "update_subscription_payment_method": "https://customer-portal.paddle.com/cpl_…?action=update_subscription_payment_method&subscription_id=sub_…&token=pga_…",
          "view_subscription": "https://customer-portal.paddle.com/cpl_…?action=view_subscription&subscription_id=sub_…&token=pga_…"
        }
      ]
    },
    "created_at": "2024-10-25T06:53:58Z"
  },
  "meta": { "request_id": "fa176777-4bca-49ec-aa1e-f53885333cb7" }
}
```

- URL fields: `data.urls.general.overview`, and per subscription `cancel_subscription`, `update_subscription_payment_method`, `view_subscription`. (`view_subscription` is in [OAS] and in [NODE] 3.12.0's `ICustomerPortalSubscriptionUrl`.)
- "Customer portal sessions are temporary and shouldn't be cached." "don't embed the customer portal in an iframe." ([OAS]) Mint one per click and redirect.
- Resolve `customer_id` server-side from the authenticated user, never from client input ([SKILLS] customer-portal).

### 6.3 Change plan: update subscription items

```
PATCH /subscriptions/{subscription_id}               permission: subscription.write
{
  "items": [{ "price_id": "pri_NEW", "quantity": 1 }],
  "proration_billing_mode": "prorated_immediately",
  "on_payment_failure": "prevent_change"
}
→ 200 { "data": <Subscription>, "meta": … }
```

[OAS] update-subscription: "When making changes to items or the next billing date for a subscription, you must include the `proration_billing_mode` field"; "Send the complete list of items that you'd like to be on a subscription — including existing items. If you omit items, they're removed from the subscription."; "When an update results in an immediate charge, responses may take longer than usual while a payment attempt is processed."

`proration_billing_mode` ([OAS] `SubscriptionUpdateProrationBillingMode`, verbatim). There is no default.

| Value | Official description |
| --- | --- |
| `prorated_immediately` | "Paddle calculates the prorated amount for the subscription changes based on the current billing cycle, then creates a transaction to collect immediately." |
| `prorated_next_billing_period` | "Paddle calculates the prorated amount for the subscription changes based on the current billing cycle, then schedules them to be billed on the next renewal." |
| `full_immediately` | "Paddle does not calculate proration for the subscription changes, creating a transaction to collect for the full amount immediately." |
| `full_next_billing_period` | "Paddle does not calculate proration for the subscription changes, scheduling for the full amount for the changes to be billed on the next renewal." |
| `do_not_bill` | "Paddle does not bill for the subscription changes." |

In every mode the items switch immediately; "the mode only decides what's billed and when" ([SKILLS] subscription-update). Proration is calculated to the minute ([WS] proration page).

What Paddle recommends ([SKILLS] subscription-update, "Upgrade, downgrade, or term change?"):

| Flow | Mode |
| --- | --- |
| Tier upgrade, same term | `prorated_immediately` ("user expects the better plan now and pays the difference now") |
| Tier downgrade, same term | `prorated_immediately` or `prorated_next_billing_period`. "Unused Pro time becomes a **credit, never a card refund**" |
| Monthly to annual, annual to monthly | `prorated_immediately`. "interval changes don't accept `*_next_billing_period`"; every item must be replaced. |
| Change while `trialing` (or `paused`) | `do_not_bill` only |

A phrase-level "we recommend" statement on the docs pages was not found by search; the table above is from Paddle's skills repo.

`on_payment_failure` ([OAS], default `prevent_change`): `prevent_change` "In case of payment failure, prevent the change to the subscription from applying." (API returns `subscription_payment_declined`, [SKILLS]); `apply_change` "apply the change and update the subscription." (subscription stays `active`, the proration transaction is left `past_due`, [SKILLS]).

Status constraints ([SKILLS] subscription-update): `active` all; `trialing` items with `do_not_bill` only (`subscription_trialing_items_update_invalid_options`); `past_due` only `{ scheduled_change: null }` (`subscription_update_when_past_due`); `paused` items with `do_not_bill`; `canceled` nothing (`subscription_update_when_canceled`). Within 30 minutes of renewal: 409 `subscription_locked_renewal`. With a scheduled change present, `*_next_billing_period` modes fail with `subscription_invalid_billing_mode_for_scheduled_change`.

Preview first: `PATCH /subscriptions/{subscription_id}/preview` with the same body returns `immediate_transaction`, `recurring_transaction_details`, `next_billed_at`, `update_summary` without applying ([OAS] path; [SKILLS]).

Events after a `prorated_immediately` upgrade ([SKILLS]): `transaction.created`, then `transaction.completed` or `transaction.payment_failed` (the transaction has `origin: "subscription_update"`), and `subscription.updated` with the new items.

For this project: Pro to Free is not a plan change in Paddle; it is a cancel at period end (section 4).

### 6.4 Cancel

```
POST /subscriptions/{subscription_id}/cancel         permission: subscription.write
{ "effective_from": "next_billing_period" }          // or "immediately"; body required, field optional
→ 200 { "data": <Subscription>, "meta": … }
```

### 6.5 Get customer, list and get prices

```
GET /customers/{customer_id}                         permission: customer.read
GET /customers?email=a@example.com                   exact match, comma-separated, max 100 values
GET /prices?product_id=pro_…&status=active&include=product&recurring=true     permission: price.read
GET /prices/{price_id}?include=product
GET /subscriptions/{subscription_id}?include=next_transaction,recurring_transaction_details
GET /subscriptions?customer_id=ctm_…&status=active,past_due,trialing
```

- Customer: `{ id, name, email, marketing_consent, status: "active"|"archived", custom_data, locale, created_at, updated_at, import_meta }` ([OAS]).
- List prices query parameters ([OAS]): `id`, `after`, `per_page`, `include` (`product`), `order_by`, `product_id`, `status`, `recurring` (true = recurring, false = one-time), `billing_cycle.interval`, `billing_cycle.frequency`, `type`. Default returns `active` only.
- List customers: `email` is "Recommended for precise matching"; `search` matches `id`, `name`, `email`.
- Updating a payment method without the portal: `GET /subscriptions/{subscription_id}/update-payment-method-transaction` returns a transaction to pass to `Paddle.Checkout.open({ transactionId })` ([OAS] path; [NODE] `getPaymentMethodChangeTransaction`).

### 6.6 Rate limits

All [WS] https://developer.paddle.com/api-reference/about/rate-limiting/ and linked changelogs. Not present in [OAS].

- 240 requests per minute **per IP address**. Over the limit: HTTP 429, error code `too_many_requests`, with a `Retry-After` header in seconds; one page says the IP cannot make another request for 60 seconds. ([GO] parses `Retry-After` as integer seconds or an RFC 1123 date.)
- Pricing-preview endpoints: 1,000 requests per minute per IP.
- Subscription updates that charge immediately: 20 per subscription per hour, 100 per 24 hours (errors `subscription_immediate_charge_hour_limit_exceeded`, `subscription_immediate_charge_24_hour_limit_exceeded`).

[INFER] A Worker's outbound requests leave from Cloudflare egress addresses, so a per-IP limit is not a per-account limit. I found nothing from Paddle on this. Keep API calls off the hot path (mirror state from webhooks) and honour `Retry-After`.

---

## 7. Catalog

### 7.1 Model

A product is what is sold; a price is how it is charged; one product has many prices ([SKILLS] catalog-setup). IDs: `pro_…`, `pri_…`. Sandbox and live catalogs are completely separate; IDs do not carry over.

### 7.2 Creating in the sandbox dashboard

[SKILLS] catalog-setup, "Method 4: Dashboard (manual)":

1. Sign in at `https://sandbox-vendors.paddle.com/products` (sandbox signup: `https://sandbox-login.paddle.com/signup`).
2. **Paddle > Catalog > Products**, **New product**. Fields: **Name** ("this is what users see in checkout"), **Tax category**, optional description and icon. Save.
3. Inside the product, **New price**. Fields: **Description** (internal label), **Type** (Recurring or One-time), **Billing cycle** (recurring only: Monthly, Yearly, Weekly, Daily, Custom), **Trial period** (optional, recurring only), **Amount** (amount and currency, e.g. `10.00 USD`), **Regional prices** (optional). Save.
4. Copy the `pri_…` ID from the price details panel.

The skill's dashboard steps do not mention the tax field. [WS] Paddle help centre (`paddle.com/help/sell/tax/do-you-support-tax-inclusiveexclusive-pricing`): a price has a "Tax" dropdown that overrides the account default for that price only.

Tax categories ([SKILLS]; enum in [NODE]): `saas` and `standard` need no approval; `digital-goods`, `ebooks`, `implementation-services`, `professional-services`, `software-programming-services`, `training-services`, `website-hosting` need approval (otherwise `product_tax_category_not_approved`).

### 7.3 Price fields ([OAS] `Price` / `PriceCreate`)

| Field | Type | Notes |
| --- | --- | --- |
| `product_id` | string | required |
| `description` | string, 2 to 500 chars | required. "Internal description for this price, not shown to customers." |
| `name` | string \| null | Shown to customers at checkout and on invoices, 1 to 150 chars ([SKILLS]) |
| `unit_price` | `{ amount: string, currency_code }` | required. "Amount in the lowest denomination for the currency, e.g. 10 USD = 1000 (cents). Although represented as a string, this value must be a valid integer." $9.00 is `"900"`. |
| `billing_cycle` | `{ interval: "day"\|"week"\|"month"\|"year", frequency: integer ≥ 1 }` \| null | "`null` if price is non-recurring (one-time). If omitted, defaults to `null`." |
| `trial_period` | `{ interval, frequency, requires_payment_method?, unit_price? }` \| null | Requires `billing_cycle`. |
| `tax_mode` | `"account_setting" \| "external" \| "internal" \| "location"` | Default `account_setting`. |
| `unit_price_overrides` | `[{ country_codes: string[], unit_price }]` | Per-country prices. |
| `quantity` | `{ minimum: integer, maximum: integer }` | Each 1 to 999,999,999; `maximum ≥ minimum`. "If omitted, defaults to 1-100." |
| `type` | `"standard" \| "custom"` | `standard` = catalog item shown in dashboard. |
| `status` | `"active" \| "archived"` | |
| `custom_data` | object \| null | |

### 7.4 `tax_mode` and "$9 plus tax"

[OAS] `TaxMode`, verbatim: `account_setting` "Prices use the setting from your account."; `external` "Prices are exclusive of tax."; `internal` "Prices are inclusive of tax."; `location` "Prices are inclusive or exclusive of tax, depending on the country of the transaction."

So `external` = tax-exclusive (tax is added on top of `unit_price`), `internal` = tax-inclusive (tax is carved out of `unit_price`), `account_setting` = defer to the account default.

Account default: `GET` / `PATCH /settings/tax`, field `default_tax_mode` ∈ `exclusive` | `inclusive` | `location` ([OAS] `DefaultTaxMode`: "Used when prices have a `tax_mode` of `account_setting`."; permissions `tax_settings.read` / `tax_settings.write`). Dashboard location per [WS] setup checklist: **Paddle > My account > Settings > Sales tax**.

To charge $9 with tax on top: `unit_price: { "amount": "900", "currency_code": "USD" }` and `tax_mode: "external"` on the price (independent of the account default), or leave `account_setting` and set `default_tax_mode` to `exclusive`. [WS] changelog `2025/automatic-tax-inclusive-exclusive-prices`: if the account default is `location`, a price created with `tax_mode` omitted or `account_setting` is "automatically set to `location`". The default value of `default_tax_mode` on a new account was not verified, so set `external` explicitly.

Create via API:

```
POST /prices                                         permission: price.write
{
  "product_id": "pro_…",
  "description": "Pro monthly USD",
  "name": "Monthly",
  "unit_price": { "amount": "900", "currency_code": "USD" },
  "billing_cycle": { "interval": "month", "frequency": 1 },
  "tax_mode": "external",
  "quantity": { "minimum": 1, "maximum": 1 }
}
```

(Body is mine, built from [OAS] `PriceCreate`. The official example payloads contain prices with `quantity { "minimum": 1, "maximum": 1 }`.)

### 7.5 One-time price

Omit `billing_cycle` (and `trial_period`). "Without `billing_cycle`… the price is created as one-time." "Trial period on a one-time price. Not allowed" ([SKILLS] catalog-setup). A purchase of only one-time prices creates a transaction and no subscription ([OAS]: subscriptions are created "for recurring items").

### 7.6 Quantity limits

Default `{ minimum: 1, maximum: 100 }`: "the most units that a customer can buy is 100" ([OAS] create-price). Set `{ "minimum": 1, "maximum": 1 }` to stop quantity changes on a single-seat plan. In a subscription all recurring items must share the same billing interval ([SKILLS] subscription-update).

---

## 8. Notification destinations, simulator, retries, IPs

### 8.1 Create a destination (dashboard)

[SKILLS] webhooks, Step 1:

1. **Paddle > Events > Notifications**. ([WS] notification-destinations page: current docs use this path; one older docs page says "Paddle > Developer Tools > Notifications".)
2. **New destination**.
3. **Notification type**: `Webhook`. **URL**: the Worker endpoint. **Description**. **Usage type**: `Platform` (real events only, right for production), `Simulation`, or `Both` (needed for a destination the simulator should reach). **Events**: tick the events.
4. Save, then copy the **Secret key** (`pdl_ntfset_…`). It can be copied again from the destination's edit view or read as `endpoint_secret_key` from `GET /notification-settings/{id}`.

API equivalent ([OAS]): `POST /notification-settings` with `{ description, type: "url", destination, subscribed_events: [names], traffic_source: "platform" | "simulation" | "all", api_version?, include_sensitive_fields? }`; `traffic_source` defaults to `platform`. Permission `notification_setting.write`. Duplicate URL returns 409 `notification_setting_cannot_be_duplicate` ([SKILLS]). Only 10 destinations can be active at once ([WS] notification-destinations page).

"A destination only sends what you've ticked in the dashboard." ([SKILLS])

Events to tick for this integration [INFER, from the handler list in the task]: `subscription.created`, `subscription.updated`, `subscription.activated`, `subscription.canceled`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.trialing` (only if you use trials), `transaction.completed`, `transaction.paid`, `transaction.payment_failed`, `transaction.past_due`, `adjustment.created`, `adjustment.updated`, and optionally `customer.created`, `customer.updated`. Paddle's own minimum set in [SKILLS] is `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`, `customer.created`, `customer.updated`.

### 8.2 Response contract and retries

| Item | Value | Source |
| --- | --- | --- |
| Expected response | HTTP 200 (any 2xx counts as delivered) | [OAS] every webhook: "Respond with an HTTP 200 status code within 5 seconds to let Paddle know that you successfully received the message."; [SKILLS]: "Only `2xx` within 5 seconds is 'delivered.'" |
| Time limit | 5 seconds. Slower counts as a timeout and a failed attempt. | [OAS]; [SKILLS] |
| Redirects | Not followed; `301`/`302` is a failed delivery. | [SKILLS] |
| Retry policy, live | "up to 60 attempts in total over about two days", exponential backoff | [SKILLS]; [WS] https://developer.paddle.com/webhooks/about/respond-to-webhooks/ adds: about 10 attempts in the first hour, about 45 in the first day, wait before next attempt `60 × n^1.1` seconds where `n` is attempts so far |
| Retry policy, sandbox | "3 attempts in total, all within about two minutes" | [SKILLS]; [WS] same page |
| After retries | Notification status becomes `failed`; no more automatic attempts. | [OAS] `NotificationStatus`: `not_attempted`, `needs_retry`, `delivered`, `failed` |
| Replay | `POST /notifications/{notification_id}/replay` (permission `notification.write`) or **Retry** in the dashboard. Creates a new notification for the same `event_id`; gets one attempt. "Notifications older than 90 days aren't retained." Only `origin: "event"` notifications can be replayed. | [OAS]; [SKILLS] |
| Delivery semantics | At least once, no ordering guarantee. Dedupe on `event_id`; guard writes with `occurred_at`. | [SKILLS]; [WS] |
| Catch-up | `GET /events` (events kept 90 days), or re-read current state from the API. | [SKILLS] |


### 8.3 Simulator

- Dashboard: **Paddle > Events > Simulations** ([SKILLS]).
- Sends correctly signed fake events (signed with the destination's secret) to an existing destination whose Usage type is `Simulation` or `Both`, that is active and subscribed to each simulated event; otherwise the event is marked `aborted`. Webhook (URL) destinations only.
- One delivery attempt per simulated event, no retries; results are on the simulation run, not in notification logs. Simulated events change no real data.
- Single events: any event type. Scenarios ([OAS] `SimulationScenarioEventsType` and the `GET /simulation-types` example):

| Scenario | Events sent (default options) |
| --- | --- |
| `subscription_creation` | `transaction.created`, `customer.created`, `address.created`, `transaction.updated`, `transaction.ready`, `transaction.updated`, `transaction.paid`, `subscription.created`, `subscription.activated`, `transaction.updated`, `transaction.updated`, `transaction.completed` |
| `subscription_renewal` | `subscription.updated`, `transaction.created`, `transaction.billed`, `transaction.updated`, `transaction.paid`, `transaction.updated`, `transaction.completed` |
| `subscription_pause` | `subscription.updated`, `subscription.paused` |
| `subscription_resume` | `subscription.updated`, `subscription.resumed`, `transaction.created`, `transaction.billed`, `transaction.updated`, `transaction.paid`, `transaction.updated`, `transaction.completed` |
| `subscription_cancellation` | `subscription.updated`, `subscription.canceled` |

These lists are also the best available evidence for real-world event order: on a new subscription `transaction.paid` precedes `subscription.created` / `subscription.activated`, and `transaction.completed` comes last.

- Options: cancellation and pause take `effective_from` (default `immediately`; `next_billing_period` adds a first `subscription.updated` carrying `scheduled_change`) and `has_past_due_transaction`; renewal and resume take `payment_outcome` (`success` | `recovered_existing_payment_method` | `recovered_updated_payment_method` | `failed`) and `dunning_exhausted_action` ([OAS]).
- API: `POST /simulations` `{ name, type, notification_setting_id, config? }`, then `POST /simulations/{simulation_id}/runs`; results at `GET /simulations/{id}/runs/{run_id}/events`. Permissions `notification_simulation.write` / `.read`.
- A locally running Worker (`wrangler dev`) needs a public tunnel for both real sandbox events and the simulator.

### 8.4 IP allowlist

- `GET /ips` (declared with `security: []` and empty `x-permissions` in [OAS], so no API key is needed) returns `{ "data": { "ipv4_cidrs": ["34.194.127.46/32", "54.234.237.108/32", "3.208.120.145/32"] } }` in the [OAS] example. "IP addresses returned are for the environment that you're making the request in."
- [WS] https://developer.paddle.com/webhooks/about/respond-to-webhooks/ lists sandbox `34.194.127.46`, `54.234.237.108`, `3.208.120.145`, `44.226.236.210`, `44.241.183.62`, `100.20.172.113` and live `34.232.58.13`, `34.195.105.136`, `34.237.3.244`, `35.155.119.135`, `52.11.166.252`, `34.212.5.7`. The first three sandbox addresses match the [OAS] example. Fetch `/ips` rather than hardcoding.
- Allowlisting is optional and does not replace signature verification ([SKILLS]: "Still verify signatures.").

---

## 9. Sandbox test cards

[SKILLS] sandbox-testing; the same five numbers were confirmed by [WS] https://developer.paddle.com/sdks/sandbox/ .

| Card number | Result |
| --- | --- |
| `4242 4242 4242 4242` | Valid card without 3DS |
| `4000 0038 0000 0446` | Valid card with 3DS |
| `4000 0566 5566 5556` | Valid Visa debit card |
| `4000 0000 0000 0002` | Declined card |
| `4000 0027 6000 3184` | Initial success, subsequent renewals decline |

Expiry: any future date. Name: any. CVC: [SKILLS] says any 3 digits; the docs quickstart and go-live checklist use `100` ([WS]). Use `100`.

Sandbox accepts only test cards; real cards are rejected, and test cards do not work in live. Sandbox emails only go to addresses on your account email's domain; others are redirected to the account email ([SKILLS]).

---

## 10. Default payment link and domain approval

| | Sandbox | Live |
| --- | --- | --- |
| Where checkout can open | "Checkout opens on any page, including `localhost`" | Only on approved domains |
| Domain approval | Not required; domains you add are approved immediately | Submit each domain under **Paddle > My account > Settings > Website approval**. No API to submit; check status with `GET /checkout-domains` (`status`: `pending_review`, `approved`, `rejected`, `in_review`, `action_required`; only `approved` can run checkout). A subdomain needs its own approval. |
| Default payment link | Must be set: "checkout won't open without one." Any `https` URL is accepted; use a page on your own domain, not `localhost`. | Must be set and its host must be an approved domain (or that domain with `www.`), else `checkout_url_domain_not_approved`. |

Sources: [SKILLS] checkout-web, sandbox-testing, onboarding; [OAS] `CheckoutUrl`, update-checkout-url ("Sandbox accounts accept any `https` URL."), `CheckoutDomainApprovalStatus`.

- Dashboard: **Paddle > Checkout > Checkout configuration > Default payment link** ([SKILLS]).
- API: `GET` / `PATCH /settings/checkout-url`, body `{ "default_url": "https://…" }`, pattern `^https://[^\s]+$`, max 1000 chars, `null` until set; permissions `checkout_settings.read` / `.write` ([OAS]).
- What it is ([OAS]): "URL that Paddle opens when a checkout is created without a URL of its own… Paddle appends `?_ptxn=` and the transaction ID to this URL. The page must have Paddle.js set up to read it and open the checkout." It appears as `transaction.checkout.url`. It is where links in Paddle emails and payment-method-update links send customers, so that page must load and initialise Paddle.js.
- Symptom of a missing link or unapproved domain: checkout shows a "Something went wrong" message ([SKILLS] checkout-web).

---

## 11. What this means for the Worker (derived, [INFER])

- Handler order: read `request.text()`, verify, `JSON.parse`, dedupe on `event_id`, apply only if `occurred_at` is newer than the stored `last_event_at` for that entity, return 200 within 5 s. Return non-2xx on verification failure or handler error.
- Drive entitlement from `data.status` on **every** `subscription.*` event rather than from the event name; the state arrives in full each time.
- Pro = `status ∈ {active, trialing, past_due}`. Free = `canceled` or `paused`, or no subscription.
- "Cancels on" date = `scheduled_change.effective_at` when `scheduled_change.action === "cancel"`. Renewal date = `next_billed_at` (null when a cancel is scheduled) or `current_billing_period.ends_at`.
- Do not use `current_billing_period.ends_at` as an access cutoff while `past_due`: in the official `subscription.past_due` example the period has already advanced.
- Payment recovered = `subscription.updated` with `status: "active"` after a stored `past_due`.
- One-off purchases: `transaction.completed`, match on `items[].price.id`; dedupe on the transaction `id` so a replay cannot grant twice.
- Renewal-driven grants (if any): `transaction.completed` with `origin: "subscription_recurring"`.
- Refunds: act on `adjustment.updated` (or `adjustment.created`) only when `action === "refund"` and `status === "approved"`.
- Plan identity: map `items[].price.id` to your plan via environment variables per environment (sandbox and live IDs differ).

---

## 12. Unverified

1. Whether Paddle really sends more than one `h1` in `Paddle-Signature` during secret rotation, and how destination secrets are rotated. Search results conflicted; SDKs differ (PHP/Python accept many, Node takes the last, Go accepts exactly one).
2. The exact webhook sequence when a past-due payment is recovered: whether `transaction.paid` / `transaction.completed` fire for the past-due transaction, their order relative to `subscription.updated`, and whether `subscription.activated` fires. Only "the subscription returns to active and `subscription.updated` occurs" is documented (via search summary).
3. Whether each failed dunning retry emits another `transaction.payment_failed`.
4. Whether the unpaid transaction emits `transaction.canceled` when dunning ends in cancellation.
5. Dunning numbers (7 retries, 30 days, cancel after 30 days) come from a search summary of a January 2025 changelog; current defaults and the Retain setting names were not read directly.
6. Rate-limit numbers (240/min per IP, 1,000/min pricing preview, 20/hour and 100/24h immediate charges, 60 s lockout) come from search summaries only.
7. Webhook retry detail (`60 × n^1.1`, about 10 attempts in the first hour, about 45 in the first day) comes from a search summary; "60 attempts over about two days" and "3 attempts in about two minutes" are also in [SKILLS].
8. API key regex and the legacy-key cutoff date (2025-05-06) come from a search summary. The `pdl_sdbx_apikey_` / `pdl_live_apikey_` prefixes are in [SKILLS].
9. Full IP lists come from a search summary; only the first three sandbox addresses are corroborated by [OAS].
10. Whether keys inside `customData` reach the raw webhook JSON unchanged, and whether `custom_data` is repeated on renewal (`subscription_recurring`) transactions.
11. Default value of `default_tax_mode` for a new account, and the exact dashboard label and location of the per-price tax control. "Paddle > My account > Settings > Sales tax" is from a search summary.
12. A docs-page statement of Paddle's recommended proration mode for upgrade versus downgrade. The recommendation table here is from Paddle's agent-skills repo.
13. Which `effective_from` the hosted customer portal uses when a customer cancels there.
14. The customer portal hostname in sandbox (the spec example shows `customer-portal.paddle.com`; management URL examples show `buyer-portal.paddle.com`).
15. Dashboard navigation labels in general: sources disagree between "Developer tools" (older) and "Events" / "My account > Settings" (current skills repo). I could not look at the dashboard.
16. Exact character length of client-side tokens (one spec example has 27 hex characters after `live_`).
17. The reference verifier was tested on Node 22, not inside workerd.
18. How Paddle's per-IP rate limit interacts with Cloudflare Workers' shared egress IPs.
19. `Paddle-Version` header behaviour beyond "send `1`"; current API version number was not checked on the versioning page.

---

## 13. Source index and commands

Primary files (all under `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/`):

- `gh/paddle-openapi/v1/openapi.yaml` — https://github.com/PaddleHQ/paddle-openapi/blob/main/v1/openapi.yaml (commit c8207382fa0fa660620a02a23a6a2806ae8894fb)
- `pk-paddle-node/package/` — https://registry.npmjs.org/@paddle/paddle-node-sdk/-/paddle-node-sdk-3.12.0.tgz
  - `dist/esm/notifications/helpers/webhooks-validator.js`, `dist/esm/internal/providers/crypto/edge-crypto.js`, `dist/esm/internal/api/constants.js`, `dist/esm/internal/api/client.js`
  - `dist/types/notifications/types/{subscription,transaction,adjustment,shared}/*.d.ts`, `dist/types/notifications/helpers/types.d.ts`, `dist/types/enums/**`, `dist/types/types/events/events-response.d.ts`, `dist/esm/resources/{subscriptions,customer-portal-sessions,customers,prices}/index.js`
- `pk-paddle-js/package/` — https://registry.npmjs.org/@paddle/paddle-js/-/paddle-js-1.6.6.tgz (`types/index.d.ts`, `types/checkout/{checkout,customer,events}.d.ts`, `types/shared/shared.d.ts`, `dist/index.esm.js`, `README.md`, `CHANGELOG.md`)
- `gh/paddle-agent-skills/skills/{webhooks,subscription-cancel,subscription-update,subscription-sync,checkout-web,sandbox-testing,catalog-setup,customer-portal,onboarding}/SKILL.md` — https://github.com/PaddleHQ/paddle-agent-skills
- `gh/paddle-go-sdk/webhook_verifier.go`, `gh/paddle-php-sdk/src/Notifications/{PaddleSignature,Verifier}.php`, `gh/paddle-python-sdk/paddle_billing/Notifications/{PaddleSignature,Verifier}.py`, `gh/paddle-python-sdk/paddle_billing/Client.py`, `gh/paddle-mcp-server/src/prompts.ts`
- `gh/cf-web-crypto.mdx` — https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/runtime-apis/web-crypto.mdx

Docs pages referenced through WebSearch summaries only (not opened):

- https://developer.paddle.com/webhooks/about/signature-verification/
- https://developer.paddle.com/webhooks/about/respond-to-webhooks/
- https://developer.paddle.com/webhooks/about/notification-destinations/
- https://developer.paddle.com/webhooks/subscriptions/subscription-past-due/
- https://developer.paddle.com/changelog/2025/default-dunning-payment-recovery/
- https://developer.paddle.com/build/retain/configure-payment-recovery-dunning/
- https://developer.paddle.com/api-reference/about/rate-limiting/
- https://developer.paddle.com/api-reference/about/authentication/
- https://developer.paddle.com/api-reference/about/versioning/
- https://developer.paddle.com/paddlejs/include-paddlejs , https://developer.paddle.com/paddlejs/client-side-tokens , https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/
- https://developer.paddle.com/build/transactions/custom-data/
- https://developer.paddle.com/concepts/subscriptions/proration/
- https://developer.paddle.com/sdks/sandbox/
- https://developer.paddle.com/build/onboarding/set-up-checklist , https://developer.paddle.com/build/onboarding/go-live-checklist
- https://developer.paddle.com/changelog/2025/automatic-tax-inclusive-exclusive-prices/
- https://www.paddle.com/help/sell/tax/do-you-support-tax-inclusiveexclusive-pricing

Commands run:

```
npm view @paddle/paddle-node-sdk version dist.tarball time.modified     # 3.12.0, 2026-11-12
npm view @paddle/paddle-js version dist.tarball time.modified           # 1.6.6, 2026-11-04
npm pack @paddle/paddle-node-sdk@3.12.0 && tar xzf …                    # scratchpad/pk-paddle-node
npm pack @paddle/paddle-js@1.6.6 && tar xzf …                           # scratchpad/pk-paddle-js
git clone --depth 1 https://github.com/PaddleHQ/{paddle-openapi,paddle-agent-skills,paddle-go-sdk,paddle-php-sdk,paddle-python-sdk,paddle-node-sdk,paddle-mcp-server,paddle-nextjs-starter-kit}.git
python3 -I scripts/load.py …openapi.yaml …                             # parse spec; scripts/{q,sch,pth,dump,facts}.py query it
node scripts/verify-test.mjs                                            # verifier self-test, Node v22.23.5
npx -y -p typescript@5.6.3 tsc -p tscheck/tsconfig.json                 # type-only import check
```
