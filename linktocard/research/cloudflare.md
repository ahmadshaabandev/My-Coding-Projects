# Cloudflare Workers platform facts (single Worker: TypeScript + Hono, Static Assets, D1, R2, Rate Limiting binding)

Researched 2026-11-21. Everything below is sourced from one of three places, and each claim says which:

- **[docs]** Cloudflare docs source, branch `production`, commit `180f559575b69038dc6c7709c9e576fca61d549b` (committed 2026-11-21T20:03:38Z).
  Base URL: `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/` — written below as `DOCS/…` (= `…/src/content/docs/…`), `PARTIALS/…` (= `…/src/content/partials/…`), `CHANGELOG/…` (= `…/src/content/changelog/…`), `FLAGS/…` (= `…/src/content/compatibility-flags/…`).
- **[npm]** Files inside npm tarballs I unpacked: `wrangler@4.166.0`, `@cloudflare/vitest-plugin@1.9.0`, `@cloudflare/vitest-pool-workers@0.23.0`, `@cloudflare/workers-types@5.20261121.1`.
- **[ran]** Commands I ran in this container against `wrangler@4.166.0`, `@cloudflare/vitest-plugin@1.9.0`, `miniflare@5.20261119.0-beta`, `workerd@1.20261119.1`, `vitest@4.1.12` (and once `vitest@5.1.1`), `hono@4.13.19`, Node 22.23.5, npm 10.9.9. Project: `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/empirical/`. These are **local-simulator** results, not production.

The live site `developers.cloudflare.com` and `www.cloudflare.com` were not reachable from this session (proxy / DNS), so nothing was checked against the rendered site or the dashboard.

A note on config syntax: the docs source shows every config snippet as JSONC inside a `<WranglerConfig>` component (the site renders a TOML tab from it). The TOML forms below are my conversion; the ones marked **[ran]** were accepted by `wrangler deploy --dry-run` 4.166.0. Docs now say: "Cloudflare recommends using `wrangler.jsonc` for new projects, and some newer Wrangler features will only be available to projects using a JSON config file." (`DOCS/workers/wrangler/configuration.mdx`). TOML is still supported.

---

## 0. Things that changed recently and would break a plan made from older knowledge

| # | Change | Source |
|---|---|---|
| A | **`@cloudflare/vitest-pool-workers` is deprecated and renamed `@cloudflare/vitest-plugin`** (v1). `defineWorkersConfig` / `defineWorkersProject` / `test.poolOptions.workers` are gone; the API is a Vite plugin `cloudflareTest({...})`. `fetchMock` is removed. `isolatedStorage` / `singleWorker` are removed. `SELF` and `env` from `cloudflare:test` are deprecated in favour of `exports` / `env` from `cloudflare:workers`. | [npm] README + `npm view … deprecated`; `CHANGELOG/workers/2026-08-19-vitest-plugin.mdx`; `DOCS/workers/testing/vitest-integration/migration-guides/*.mdx` |
| B | **A Workers spending limit now exists** (launched 2026-11-13). Covers Workers (requests + CPU) and, separately, Durable Objects. It does **not** cover R2, D1 or KV. It is explicitly "not an exact maximum bill". | `CHANGELOG/billing/2026-11-13-spend-management.mdx`; `DOCS/billing/manage/spend-management/index.mdx`; `DOCS/workers/platform/spend-management.mdx` |
| C | **Worker size limit is now 64 MiB uncompressed on both plans**; the old compressed limits (3 MB Free / 10 MB Paid) were removed 2026-09-04. | `CHANGELOG/workers/2026-09-04-increased-worker-size-limit.mdx`; `DOCS/workers/platform/limits.mdx` |
| D | **Startup time limit is 1 second** (limits page), subrequests are 50 (Free) / 10,000 default, up to 10M (Paid). | `DOCS/workers/platform/limits.mdx`; `CHANGELOG/workers/2026-02-11-subrequests-limit.mdx` |
| E | **D1 Free daily limits are now enforced with errors** (since 2026-09-01); **D1 max query result 50 MB** (since 2026-11-04). | `CHANGELOG/d1/2026-09-01-d1-free-tier-limit-enforcement.mdx`; `CHANGELOG/d1/2026-10-30-query-result-size-limit.mdx` |
| F | New product **"Workers Cache"** (`"cache": { "enabled": true }` in Wrangler config). Turning it on makes **static asset requests billable**. Do not enable it casually on a mostly-static site. | `DOCS/workers/cache/index.mdx` (Pricing section) |
| G | Compatibility-date defaults: `nodejs_compat` on by default for dates >= `2026-08-04`; new module registry and `request.signal` on by default for dates >= `2026-11-17`. | `CHANGELOG/workers/2026-08-04-nodejs-compat-default.mdx`; `CHANGELOG/workers/2026-11-02-module-registry-default.mdx`; `CHANGELOG/workers/2026-11-02-request-signal-default.mdx` |
| H | Rate Limiting binding gained an optional `delta` (weighted requests) on 2026-11-04. | `CHANGELOG/workers/2026-11-04-rate-limit-weighted-requests.mdx` |
| I | Workers Logs pricing moves to "Cloudflare Observability pricing" on 2026-12-01. | `PARTIALS/workers/workers_logs_pricing.mdx` |
| J | "Previews" (`wrangler preview`, Wrangler >= 4.135.0) are a new per-branch feature; what used to be called "preview URLs" are now "Version URLs". | `DOCS/workers/previews/index.mdx`; `DOCS/workers/versions-and-deployments/version-urls.mdx` |

---

## 1. Workers Static Assets

### Config keys

Source: `DOCS/workers/wrangler/configuration.mdx` (section "Assets"), `DOCS/workers/static-assets/binding.mdx`, [npm] `wrangler/config-schema.json` (`definitions.Assets`).

| Key | Type / values | Default | Notes (quoted) |
|---|---|---|---|
| `directory` | string | — | "Folder of static assets to be served." |
| `binding` | string | — | "The binding name used to refer to the assets. Optional, and only useful when a Worker script is set with `main`." |
| `base_path` | string | `"/"` | New (2026-11-11). "The URL path prefix where static assets are available." |
| `run_worker_first` | `boolean \| string[]` | `false` | "Can be a boolean (`true`/`false`) or an array of route pattern strings with support for glob patterns (`*`) and exception patterns (`!` prefix). Patterns must begin with `/` or `!/`. Supports at most 100 entries (duplicates count toward the limit)." |
| `html_handling` | `"auto-trailing-slash" \| "force-trailing-slash" \| "drop-trailing-slash" \| "none"` | `"auto-trailing-slash"` | "Determines the redirects and rewrites of requests for HTML content." |
| `not_found_handling` | `"single-page-application" \| "404-page" \| "none"` | `"none"` | "Determines the handling of requests that do not map to an asset." |

"Only one collection of static assets can be configured in each Worker." (`binding.mdx`). `assets` is an **inheritable** key (environments inherit it) — [docs] configuration.mdx lists it under "Inheritable keys"; [ran] an env with no `assets` block still showed `env.ASSETS`.

TOML accepted by wrangler 4.166.0 [ran]:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"
run_worker_first = ["/api/*"]
```

### `html_handling` — `/terms` behaviour

Source: `DOCS/workers/static-assets/routing/advanced/html-handling.mdx` (tables, quoted with `file`→`terms`, `folder`→`terms`), confirmed [ran] with `wrangler dev` and with `env.ASSETS.fetch()` in Vitest.

**`auto-trailing-slash` (default):**

| File on disk | `/terms` | `/terms/` | `/terms.html` | `/terms/index.html` |
|---|---|---|---|---|
| `terms.html` | **200** | 307 to `/terms` | 307 to `/terms` | 307 to `/terms` |
| `terms/index.html` | **307 to `/terms/`** | **200** | 307 to `/terms` (docs table: `/folder.html` → "307 to /folder") | 307 (docs table says "307 to /folder"; my local run returned `Location: /terms/`) |

So: with `terms.html`, `/terms` returns 200 and `/terms.html` + `/terms/` redirect. With `terms/index.html`, `/terms/` returns 200 and `/terms` redirects (307) to `/terms/`. The redirect status is **307**, not 301/308.

[ran] output (`wrangler dev`, files `public/terms.html` and `public/privacy/index.html`):

```
/terms       200           /privacy   307 -> /privacy/
/terms.html  307 -> /terms  /privacy/  200
/terms/      307 -> /terms
```

**`drop-trailing-slash`:** both layouts serve 200 at `/terms`; `/terms/` → "307 to /folder" (i.e. to `/terms`).
**`force-trailing-slash`:** both layouts serve 200 at `/terms/`; `/terms` → 307 to `/terms/`.
**`none`:** only exact paths (`/terms.html`, `/terms/index.html`) return 200; everything else "Depends on `not_found_handling`".

### `not_found_handling`

Source: `DOCS/workers/static-assets/index.mdx`, `…/routing/static-site-generation.mdx`, `…/routing/single-page-application.mdx`.

- `"404-page"`: "Sets your application to return a `404 Not Found` response with the nearest `404.html` for requests which don't match a static asset."
- `"single-page-application"`: "return a `200 OK` response with `index.html` for requests which don't match a static asset."
- default `"none"`: unmatched requests go to the Worker if there is one ("If no Worker script is present, a `404 Not Found` response is returned.").

### Navigation-request trap (important for an API on the same Worker)

Source: `PARTIALS/workers/navigation_requests.mdx`, `FLAGS/assets-navigation-prefers-asset-serving.md`.

> "If you have a Worker script (`main`), have configured `assets.not_found_handling`, and use the `assets_navigation_prefers_asset_serving` compatibility flag (or set a compatibility date of `2025-04-01` or greater), _navigation requests_ will not invoke the Worker script. A _navigation request_ is a request made with the `Sec-Fetch-Mode: navigate` header…"

> "if you navigate to `/api/date` in your browser, you will be served an HTML file."

[ran] with `not_found_handling = "404-page"` and **no** `run_worker_first`: `curl /api/hello` → 200 from Worker, but `curl -H 'Sec-Fetch-Mode: navigate' /api/hello` → **404 with the `404.html` body, Worker not invoked**. With `run_worker_first = ["/api/*"]` the Worker ran in both cases, and every non-`/api/*` miss (navigate or not) got `404.html` without invoking the Worker. This matches the docs: "This approach disables the automatic `Sec-Fetch-Mode: navigate` detection and gives you explicit control" (`single-page-application.mdx`).

Consequence: if image URLs under `/api/…` (or wherever the image API lives) may be opened directly in a browser tab, those paths **must** be listed in `run_worker_first` when `not_found_handling` is set.

### `run_worker_first`

Source: `DOCS/workers/static-assets/binding.mdx`, `…/routing/worker-script.mdx`, `CHANGELOG/workers/2025-06-17-advanced-routing.mdx`.

- Boolean: "`run_worker_first = false` (default) will serve any static asset matching a request, while `run_worker_first = true` will unconditionally invoke your Worker script".
- Array: `"run_worker_first": ["/api/*", "!/api/docs/*"]` — "The array supports glob patterns with `*` for deep matching and negative patterns with `!` prefix. Negative patterns have precedence over non-negative patterns… The order in which the patterns are listed is not significant." At most 100 entries.
- **Minimum versions for the array form:** "Wrangler v4.20.0 and above", "Cloudflare Vite plugin v1.7.0 and above" (changelog 2025-06-17 and `single-page-application.mdx`). No minimum version is stated in the docs I read for the boolean form.
- When the Worker does run, `env.ASSETS.fetch(request)` serves assets "using the configured HTML handling and missing-asset fallbacks"; "Only the URL pathname is used to match assets."

### Billing

Source: `DOCS/workers/static-assets/billing-and-limitations.mdx`, `DOCS/workers/platform/pricing.mdx`.

- "Requests to static assets are free and unlimited. Requests to the Worker script (for example, in the case of SSR content) are billed according to Workers pricing."
- "There is no additional cost for storing Assets."
- "**Important note for free tier users**: When using `run_worker_first`, requests matching the specified patterns will always invoke your Worker script. If you exceed your free tier request limits, these requests will receive a 429 (Too Many Requests) response instead of falling back to static asset serving."
- Exception: with **Workers Cache** enabled, "every request to your Worker is charged at the standard Workers request rate, including requests that are normally free: static asset requests" (`DOCS/workers/cache/index.mdx`).
- When a Workers spending limit blocks the account: "Static assets served without running your Worker continue to be available. Requests that need Worker code, such as requests routed through `run_worker_first`, can fail." (`DOCS/workers/platform/spend-management.mdx`).

### Limits

Source: `DOCS/workers/platform/limits.mdx` ("Static Assets").

| Limit | Workers Free | Workers Paid |
|---|---|---|
| Files per Worker version | 20,000 | 100,000 |
| Individual file size | 25 MiB | 25 MiB |
| `_headers` rules | 100 | 100 |
| `_redirects` static / dynamic / total | 2,000 / 100 / 2,100 | same |

"To use the increased file count limits in Wrangler, you must use version 4.34.0 or higher."

### Other behaviours worth knowing

- Default asset response headers: `Cache-Control: public, max-age=0, must-revalidate`, `ETag`, `Content-Type`, `CF-Cache-Status` (`DOCS/workers/static-assets/headers.mdx`; seen in [ran] output).
- "Custom headers defined in the `_headers` file are not applied to responses generated by your Worker code" (`headers.mdx`).
- Range requests: "Workers returns `200 OK` with the full file instead of `206 Partial Content`" (`billing-and-limitations.mdx`).
- `.assetsignore` (gitignore format) in the assets directory excludes files from upload (`binding.mdx`).

---

## 2. Rate Limiting binding

Source: `DOCS/workers/runtime-apis/bindings/rate-limit.mdx`, `CHANGELOG/workers/2025-09-19-ratelimit-workers-ga.mdx`, [npm] `wrangler/config-schema.json`, [npm] `@cloudflare/workers-types/index.d.ts`.

**GA: yes.** "Rate Limiting within Cloudflare Workers is now Generally Available (GA). The `ratelimit` binding is now stable and recommended for all production workloads. Existing deployments using the unsafe binding will continue to function to allow for a smooth transition." (2025-09-19).

**Config key today is `ratelimits`** (not `[[unsafe.bindings]]`). "You must use version 4.36.0 or later of the Wrangler CLI."

Docs form (JSONC):

```jsonc
"ratelimits": [
  { "name": "MY_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
]
```

TOML accepted by wrangler 4.166.0 [ran] (dry-run printed `env.RL (3 requests/10s)  Rate Limit`):

```toml
[[ratelimits]]
name = "RL"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 3
  period = 10
```

(Inline form `simple = { limit = 3, period = 10 }` also accepted [ran].)

Fields (schema marks `name`, `namespace_id`, `simple` required; `simple.limit` and `simple.period` required):

| Field | Type | Docs text |
|---|---|---|
| `name` | string | binding name (schema: "The binding name used to refer to the rate limiter in the Worker.") |
| `namespace_id` | **string** | "A string containing a positive integer that uniquely defines this rate limiting namespace within your Cloudflare account (for example, `"1001"`). Although the value must be a valid integer, it is specified as a string." |
| `simple` | object | "`simple` is the only supported type." |
| `simple.limit` | number | "The request threshold for calls to `limit()` within the given `period`, per Cloudflare location." |
| `simple.period` | number | "The duration of the rate limit window, in seconds. Must be either `10` or `60`." (schema enum `[10, 60]`) |

`ratelimits` is **not inherited** by named environments — schema: "This field is not automatically inherited from the top level environment, and so must be specified in every named environment." [ran] wrangler warned exactly that for an env without it.

**Runtime API** ([npm] workers-types):

```ts
interface RateLimitOptions { key: string; delta?: number }   // delta: positive integer, default 1
interface RateLimitOutcome { success: boolean }
interface RateLimit { limit(options: RateLimitOptions): Promise<RateLimitOutcome> }
// const { success } = await env.MY_RATE_LIMITER.limit({ key })
```

`delta` needs Wrangler >= 4.157.0 locally and workers-types >= 5.20261106.1. "A call succeeds while the count is below the limit, even if its `delta` takes the count past the limit. A call that returns `success: false` does not add to the count."

**Locality / accuracy caveats** (quote these in product docs; do not promise exact limits):

- "Rate limits are approximate and apply separately in each Cloudflare location. Requests can exceed your configured limit while counts update in the background."
- "Rate limits that you define and enforce in your Worker are local to the Cloudflare location that your Worker runs in… These counts do not combine into one worldwide limit."
- "The Rate Limiting API provides an approximate limit. Counts are eventually consistent: each check uses a local count, and updates reach other running instances in the background."
- "If you need one strict limit across all locations, implement a rate limiter with Durable Objects."
- Two bindings with the same `namespace_id` on the same account share counters per location, "including across different Workers".
- Key guidance: "It is not recommended to use IP addresses or locations (regions or countries), since these can be shared by many users".
- "Rate limiting bindings are not currently visible in the Cloudflare dashboard."

**Pricing:** the binding's docs page, the GA changelog, and the Workers pricing page contain **no price and no "free" statement** for the binding. See Unverified.

**Local dev / Miniflare / Vitest:**

- [docs] `PARTIALS/workers/bindings_per_env.mdx`: Rate Limiting — Local simulations ✅, Remote binding connections ❌, `wrangler dev --remote` ✅. "Rate limiting logic should be tested against local simulations." (`DOCS/workers/local-development/index.mdx`)
- [ran] `wrangler dev` 4.166.0 with `limit = 3, period = 10`: three `{"success":true}` then `{"success":false}` (HTTP 429 from my handler).
- [ran] `@cloudflare/vitest-plugin@1.9.0` reading `wrangler.toml`: `env.RL.limit({ key })` returned `true,true,true,false,false,false` for 6 calls with limit 3. A second test file saw a fresh counter for the same key.

---

## 3. Workers pricing and limits

Source: `DOCS/workers/platform/pricing.mdx`, `DOCS/workers/platform/limits.mdx`, `DOCS/workers/wrangler/configuration.mdx` ("Limits"), `PARTIALS/workers/isolate-cpu-flexibility.mdx`.

### Pricing

| | Requests | Duration | CPU time |
|---|---|---|---|
| **Free** | "100,000 per day" | "No charge for duration" | "10 milliseconds of CPU time per invocation" |
| **Standard (Paid, $5/mo minimum)** | "10 million included per month +$0.30 per additional million" | "No charge or limit for duration" | "30 million CPU milliseconds included per month +$0.02 per additional million CPU milliseconds. Max of 5 minutes of CPU time per invocation (default: 30 seconds)" |

- "The Workers Paid plan includes Workers, Pages Functions, Workers KV, Hyperdrive, and Durable Objects usage for a minimum charge of $5 USD per month for an account."
- "There are no additional charges for data transfer (egress) or throughput (bandwidth)."
- "Cloudflare does not bill for subrequests you make from your Worker." "Requests to static assets are free and unlimited."
- Workers Logs: Free 200,000 log events/day (3 days retention); Paid 20 million/month included, +$0.60 per additional million (7 days). Changes 2026-12-01 (see section 0-I).

### Limits

| Feature | Workers Free | Workers Paid |
|---|---|---|
| Requests | 100,000/day (resets midnight UTC; then Error 1027) | No limit |
| CPU time per HTTP request | **10 ms** | **5 min (default: 30 seconds)** |
| Memory | 128 MB per isolate | 128 MB per isolate |
| Subrequests per invocation | 50 | 10,000 (up to 10M via `limits.subrequests`) |
| Subrequests to internal services (R2/KV/D1…) | 1,000 | matches configured limit (default 10,000) |
| Simultaneous outgoing connections waiting for headers | 6 | 6 |
| Env variables | 64/Worker, 5 KB each | 128/Worker, 5 KB each |
| Worker size | **64 MiB uncompressed** — "There is no compressed size limit." | same |
| Startup time | **1 second** | 1 second |
| Workers per account | 100 | 500 |
| Cron Triggers per account | 5 | 1,000 |
| Cache API calls per request | 50 | 1,000 |
| Log data per request | 256 KB | 256 KB |

Request body size depends on the zone's Cloudflare plan: Free/Pro 100 MB. URL 16 KB; headers 128 KB total.

Exceeding CPU: "Cloudflare returns Error 1102 … `Worker exceeded resource limits`". Exceeding memory: also Error 1102.

### `limits.cpu_ms`

```toml
[limits]
cpu_ms = 500        # accepted by wrangler 4.166.0 dry-run [ran]
subrequests = 150
```

- "The maximum CPU time allowed per invocation, in milliseconds." "The CPU limit can be set to a maximum of 300,000 milliseconds (5 minutes)."
- "Limits are only supported for the Standard Usage Model. Limits are only enforced when deployed to Cloudflare's network, not in local development."
- Soft edge: "Each isolate has some built-in flexibility to allow for cases where your Worker infrequently runs over the configured limit. If your Worker starts hitting the limit consistently, its execution will be terminated according to the limit configured."
- Pricing page: "To prevent accidental runaway bills or denial-of-wallet attacks, configure the maximum amount of CPU time that can be used per invocation by defining limits in your Worker's Wrangler file, or via the Cloudflare dashboard (**Workers & Pages** > Select your Worker > **Settings** > **CPU Limits**)."
- `limits` is inheritable by environments ([docs] list; [npm] schema).

### Can a ~150–400 ms CPU image render run on the Free plan?

**No, not as a product.** The Free limit is 10 ms CPU per invocation. The only slack documented is the "built-in flexibility" for a Worker that "infrequently runs over the configured limit"; a Worker that hits it "consistently" is terminated (Error 1102). A render that needs 15–40x the limit on every uncached request is the "consistently" case. It needs Workers Paid.

On Paid, derived arithmetic from the published rates (my calculation, not a Cloudflare quote):

- Included CPU: 30,000,000 ms / 400 ms = 75,000 renders per month (200,000 at 150 ms) before CPU overage.
- Overage: 400 ms x $0.02 / 1,000,000 ms = $0.000008 per render = **$8.00 per million renders** in CPU ($3.00 at 150 ms), plus $0.30 per million requests.
- A `limits.cpu_ms` of, say, 1000–2000 bounds the per-request worst case; default without it is 30,000 ms.

---

## 4. R2

Source: `DOCS/r2/pricing.mdx`, `DOCS/r2/api/workers/workers-api-reference.mdx`, `DOCS/r2/buckets/object-lifecycles.mdx`, `DOCS/r2/platform/limits.mdx`, `DOCS/r2/get-started/index.mdx`, [npm] wrangler `cli.js`.

### Pricing

| | Free (per month) | Standard storage |
|---|---|---|
| Storage | 10 GB-month | $0.015 / GB-month |
| Class A operations | 1 million | $4.50 / million |
| Class B operations | 10 million | $0.36 / million |
| Egress | Free | Free |

- "The free tier only applies to Standard storage, and does not apply to Infrequent Access storage."
- Rounding: "If you have performed one million and one operations, you will be billed for two million operations." "If you have used 1.1 GB-month, you will be billed for 2 GB-month."
- Class A includes `PutObject`, `ListObjects`, `CopyObject`, multipart calls, `PutBucketLifecycleConfiguration`. Class B includes `HeadObject`, `GetObject`. "Free operations include `DeleteObject`, `DeleteBucket` and `AbortMultipartUpload`."
- Storage is "calculated by averaging the _peak_ storage per day over a billing period (30 days)".

### Binding API

Config (`r2_buckets` is not inherited by environments):

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "my-bucket"
```

`put(key, value, options?: R2PutOptions): Promise<R2Object | null>`:

- `value`: `ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob`. A `ReadableStream` "must have a known length"; otherwise `put()` throws `TypeError: Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)`.
- `httpMetadata?: R2HTTPMetadata | Headers` — fields `contentType`, `contentLanguage`, `contentDisposition`, `contentEncoding`, `cacheControl`, `cacheExpiry`.
- `customMetadata?: Record<string, string>`.
- `onlyIf?: R2Conditional | Headers` — `R2Conditional` = `{ etagMatches?, etagDoesNotMatch?, uploadedBefore?, uploadedAfter?, secondsGranularity? }`. "If the condition check for `put()` fails, `null` will be returned instead of the `R2Object`." "All conditional headers aside from `If-Range` are supported."
- Also `md5`/`sha1`/`sha256`/`sha384`/`sha512` (only one at a time), `storageClass`, `ssecKey`.
- "R2 writes are strongly consistent. Once the Promise resolves, all subsequent read operations will see this key value pair globally."
- `R2Object.writeHttpMetadata(headers)` copies stored HTTP metadata onto a `Headers`; use `httpEtag` (quoted) for the `ETag` header.
- `delete(key | key[])`: up to 1000 keys per call. `list()`: up to 1000 entries; use `truncated`, not length, to page.

[ran] in Miniflare (workerd 1.20261119.1):

```
put(k, v, { httpMetadata:{contentType,cacheControl}, customMetadata:{owner} })  -> R2Object with both echoed back
put(existingKey, v, { onlyIf: new Headers({ "If-None-Match": "*" }) })           -> null (not stored)
put(existingKey, v, { onlyIf: { etagDoesNotMatch: "*" } })                       -> null (not stored)
put(newKey,      v, { onlyIf: { etagDoesNotMatch: "*" } })                       -> R2Object (stored)
put(existingKey, v, { onlyIf: { etagMatches: currentEtag } })                    -> R2Object (stored)
```

Note from that run: a `put()` that omits `httpMetadata`/`customMetadata` **replaces** the object with empty metadata (the later `get()` returned `headers: {}`, `custom: {}`). Metadata must be re-sent on every overwrite. The "create only if absent" behaviour with `"*"` is observed in the local simulator only (see Unverified).

Limits: object key 1,024 bytes; object metadata 8,192 bytes; single-part upload 5 GiB (minus 5 MiB); "Maximum concurrent writes to the same object name (key): 1 per second" (higher returns HTTP 429).

### Lifecycle rules (expire by prefix after N days)

- Dashboard: R2 object storage > bucket > **Settings** > **Object Lifecycle Rules** > **Add rule**.
- Wrangler ([npm] wrangler 4.166.0 command definition; positional args `bucket`, `name`, `prefix`):

```sh
npx wrangler r2 bucket lifecycle add <BUCKET_NAME> <RULE_NAME> <PREFIX> --expire-days 30
npx wrangler r2 bucket lifecycle list <BUCKET_NAME>
npx wrangler r2 bucket lifecycle remove <BUCKET_NAME> --id <RULE_ID>
npx wrangler r2 bucket lifecycle set <BUCKET_NAME> --file <FILE_PATH>
```

  Other flags: `--expire-date YYYY-MM-DD`, `--ia-transition-days`, `--ia-transition-date`, `--abort-multipart-days`, `--jurisdiction/-J`, `--force/-y`. I did not run these against a real account.
- Behaviour: "Objects will typically be removed from a bucket within 24 hours of the `x-amz-expiration` value." Existing objects "may experience a delay" after a new rule. "An object is no longer billable once it has been deleted." 1000 rule maximum. "Buckets have a default lifecycle rule to expire multipart uploads seven days after initiation."
- Lifecycle rules are bucket configuration, not declared in the Wrangler config file; they must be applied once per bucket (per environment).

### Does R2 require a payment method?

What the docs say: "You need a Cloudflare account with an R2 subscription. If you do not have one: … Select **Storage & databases > R2 > Overview** … Complete the checkout flow to add an R2 subscription to your account." and "R2 is free to get started with included free monthly usage. You are billed for your usage on a monthly basis." (`DOCS/r2/get-started/index.mdx`). Billing docs: "A primary payment method is required to purchase Cloudflare products and services." and "If you currently subscribe to any add-on services, Cloudflare must always have a payment method on file." (`DOCS/billing/get-started/create-billing-profile.mdx`, `update-billing-info.mdx`).

So R2 is a separate subscription added through a checkout flow, independent of the Workers plan, and overage past the free tier is billed automatically. The docs do not contain the literal sentence "R2 requires a credit card", and a web search returned conflicting third-party claims. Treat "a payment method is needed to enable R2" as likely but **unverified**.

---

## 5. D1

Source: `PARTIALS/workers/d1-pricing.mdx`, `DOCS/d1/platform/limits.mdx`, `DOCS/d1/worker-api/d1-database.mdx`, `DOCS/d1/worker-api/return-object.mdx`, `DOCS/d1/reference/migrations.mdx`, `DOCS/d1/reference/time-travel.mdx`, `PARTIALS/d1/faq-pricing.mdx`.

### Pricing

| | Workers Free | Workers Paid |
|---|---|---|
| Rows read | 5 million / day | First 25 billion / month included + $0.001 / million rows |
| Rows written | 100,000 / day | First 50 million / month included + $1.00 / million rows |
| Storage | 5 GB (total) | First 5 GB included + $0.75 / GB-mo |
| Databases | 10 | First 100,000 included |

- "Rows read measure how many rows a query reads (scans), regardless of the size of each row." An unindexed filter scans the table.
- "Indexes will add an additional written row when writes include the indexed column".
- "Free daily usage limits reset at 00:00 UTC."
- Free plan over the limit (enforced since 2026-09-01): queries "will fail … return errors until the limit resets at midnight UTC", e.g. "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."
- Paid plan over the included amount: "You will be billed for the additional reads, writes and storage".

### Limits that matter

Max database size 10 GB (Paid) / 500 MB (Free). "Queries per Worker invocation: 1000 (Workers Paid) / 50 (Free)" — and "a `db.batch()` call counts as a single query against it". Max bound parameters per query 100. Max SQL statement 100 KB. Max row/string/BLOB 2 MB. Max query duration 30 seconds ("also applies to the entire batch call"). Max query result 50 MB.

### `batch()` semantics

> "Sends multiple SQL statements inside a single call to the database… D1 operates in auto-commit. Our implementation guarantees that each statement in the list will execute and commit, sequentially, non-concurrently."
> "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence."

Returns an array of `D1Result` in statement order. There is no interactive `BEGIN`/`COMMIT` in the Worker API; `batch()` is the transaction primitive, and a later statement cannot branch on an earlier one's result in JS.

[ran] (Miniflare D1): a batch of `[INSERT 'd', INSERT duplicate 'a']` threw `D1_ERROR: UNIQUE constraint failed: items.k: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)` and row `d` was **not** present afterwards (whole batch rolled back). `batch()` rejects (throws); it does not return a per-statement error array.

### `meta.changes`

Docs definition (`return-object.mdx`): `changes: number, // the number of changes made to the database`; `last_row_id` "only applies when the table is defined without the `WITHOUT ROWID` option"; `changed_db: boolean`; `rows_read`, `rows_written`. The docs make no statement about reliability either way.

[ran] (Miniflare D1, workerd 1.20261119.1):

| Statement | `meta.changes` | Notes |
|---|---|---|
| `INSERT … RETURNING id, k, n` (1 row) | 1 | `results` = the row |
| `UPDATE … WHERE k = ?` matching 1 row | 1 | |
| `UPDATE … WHERE k = ?` matching 0 rows | 0 | |
| `UPDATE … WHERE k = ? AND n >= 100` (guard false) | 0 | conditional-update "claim" pattern works |
| `INSERT … ON CONFLICT(k) DO NOTHING` (conflict) | 0 | but `last_row_id` kept the previous insert's id (stale) and `rows_written` was 1 |
| `SELECT` run right after an UPDATE | 0 | not stale; `changed_db: false` |
| `batch([UPDATE hit, SELECT, UPDATE miss])` | `[1, 0, 0]` | per-statement values |
| `UPDATE … RETURNING n` with no match | 0, `results: []` | |
| `DELETE` 1 row | 1 | |

So in the local simulator `meta.changes` is per-statement and accurate, including inside `batch()`. Do not use `last_row_id` to detect whether an `ON CONFLICT DO NOTHING` insert happened. Production behaviour is the same engine in principle but I could not test it (see Unverified).

### `RETURNING`

No docs page states "RETURNING is supported" in so many words; the only docs occurrence is an example in `DOCS/d1/best-practices/read-replication.mdx`: `INSERT INTO bills (…) VALUES (?, ?, ?, ?) RETURNING *`. [ran] `INSERT … RETURNING`, `UPDATE … RETURNING` both work with `.all()` and `.first()` locally.

### Migrations

```toml
[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "<UUID>"
migrations_dir = "migrations"      # optional; default folder is "migrations"
# migrations_table = "d1_migrations"  (default)   migrations_pattern = "<glob>" (optional)
```

- `npx wrangler d1 migrations create <DB> <message>`, `… migrations list <DB>`, `… migrations apply <DB> [--local | --remote] [--preview] [--persist-to <dir>]` ([npm] wrangler command definition: `local` = "Execute commands/files against a local DB for use with wrangler dev", `remote` = "Execute commands/files against a remote DB…").
- [ran] `wrangler d1 migrations apply emp --local` applied to `.wrangler/state/v3/d1` and printed "To execute on your remote database, add a --remote flag to your wrangler command." With neither flag, wrangler 4.166.0 targets local. In non-interactive mode the confirmation is auto-accepted.
- Command epilogue: "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied."
- "When running a migration script, you can use either the binding name or the database name… to avoid accidentally running migrations on the wrong binding, you may wish to use the database name".
- `d1_databases` is not inherited by environments; use `--env <name>` with the per-env database.

### Time Travel

"Time Travel is D1's approach to backups and point-in-time recovery. You can restore a database to any minute within the last 7 days on the Workers Free plan or 30 days on the Workers Paid plan." "You do not need to enable Time Travel. It is always on." "Database history and restoring a database incur no additional costs."

```sh
wrangler d1 time-travel info <DB> [--timestamp=<unix or RFC3339>]
wrangler d1 time-travel restore <DB> --timestamp=<…>   # or --bookmark=<…>
```

"Restoring a database to a specific point-in-time is a _destructive_ operation, and overwrites the database in place." "Queries in flight will be cancelled". Limit: 10 restores per 10 minutes per database.

Other: "D1 automatically retries read-only queries up to two more times when it encounters a retryable error"; writes should be retried by the application with backoff (`DOCS/d1/best-practices/retry-queries.mdx`).

---

## 6. Cache API (`caches.default`)

Source: `DOCS/workers/runtime-apis/cache.mdx`, `DOCS/workers/reference/how-the-cache-works.mdx`, `DOCS/workers/cache/limitations.mdx`.

**Where it works — exact current text:**

> "Workers deployed to custom domains have access to functional `cache` operations. So do Pages functions, whether attached to custom domains or `*.pages.dev` domains."
> "However, any Cache API operations in the Cloudflare Workers dashboard editor and Playground previews will have no impact. For Workers fronted by Cloudflare Access, the Cache API is not currently available."

Today's source does **not** contain a sentence saying `*.workers.dev` deployments have no functional cache. It only positively names custom domains and Pages. The same page has one incidental mention: "This restriction does not apply on `.workers.dev` domains, which include the query string in the cache key by default." So the status on `workers.dev` is not stated outright; plan for a custom domain and treat `workers.dev` cache behaviour as unverified.

**Semantics:**

- Data-centre local: "the contents of the cache do not replicate outside of the originating data center". `cache.delete` "only purges content of the cache in the data center that the Worker was invoked".
- Not tiered: "The `cache.put` method is not compatible with tiered caching."
- Headers honoured on the response passed to `put()`: `Cache-Control`, `Cache-Tag`, `ETag`, `Expires`, `Last-Modified`.
- "Responses with `Set-Cookie` headers are never cached".
- "The `stale-while-revalidate` and `stale-if-error` directives are not supported when using the `cache.put` or `cache.match` methods."
- `cache.put` throws for non-`GET` requests, `206` responses, or `Vary: *`. "`cache.put` returns a `413` error if `Cache-Control` instructs not to cache or if the response is too large." It "Returns a promise that resolves to `undefined` regardless of whether the cache successfully stored the response."
- `cache.match()` "never sends a subrequest to the origin"; a miss resolves to `undefined`. It honours `Range`, `If-Modified-Since`, `If-None-Match` on the request.
- Limits: object size 512 MB; 50 calls/request (Free), 1,000 (Paid), sharing the subrequest quota.
- The Worker still runs (and is billed for the request and its CPU) on every request when using the Cache API: "every request still executes your Worker on the way in" and "It does not collapse concurrent requests".
- Billing reminder: "Since Cloudflare Workers runs before the Cloudflare cache, the caching of a request still incurs costs." (pricing page)

**Alternative, new: Workers Cache** (`DOCS/workers/cache/*.mdx`): `"cache": { "enabled": true }` (Wrangler >= 4.69.0) puts a tiered, request-collapsing cache in front of the Worker, driven only by the response's `Cache-Control`; hits skip the Worker (no CPU billed, request still billed). It works on `workers.dev`, is keyed by path + entrypoint + `ctx.props` + Worker version (not hostname), bypasses on `Set-Cookie` / `Authorization` / `private` / `no-store`, only caches `GET`/`HEAD`, and "Local Vitest tests do not exercise Workers Caching." The cost is the static-assets billing change in section 0-F. I found no beta/GA label for it in the docs.

[ran] `caches.default.put()` then `.match()` round-trips inside `@cloudflare/vitest-plugin` tests (local simulator).

---

## 7. Spending controls — is there a hard cap?

Bluntly:

- **Workers Paid: there is now a spending limit that blocks invocations, but it is not a guaranteed maximum.**
- **R2: no hard cap. D1 (Paid): no hard cap. KV: no hard cap.** Only email alerts.
- The only truly hard stops are the **Free plan quotas** (Workers 100,000 requests/day → error; D1 Free daily rows → queries fail).

### 7a. Workers spending limit (new, 2026-11-13)

Source: `DOCS/billing/manage/spend-management/index.mdx`, `…/cli.mdx`, `DOCS/workers/platform/spend-management.mdx`, `CHANGELOG/billing/2026-11-13-spend-management.mdx`.

- Feature name: **"Spending limits"** (API name: "spend policy"). Dashboard path per the guide: **Billing > Spend Management** > Workers row > **Edit the spending limit** > **Monthly limit (USD)** > **Save limit**. The changelog post calls the page **Billing > Spend limits** and shows a **Block usage** toggle. The two docs disagree on the label; I could not open the dashboard.
- Scope: "The limit covers requests and CPU time across all Workers in your account, after included usage. It excludes the monthly subscription fee."
- Not per-Worker: "Workers and Durable Objects limits cannot target an individual Worker, Durable Object namespace, or billing metric." "a test Worker can reach the shared limit and interrupt a production Worker in the same account."
- Not other products: "A Workers limit does not include Durable Objects, Workers AI, Workers KV, R2, or other products used by your application." CLI `--product-id` accepts only `workers` or `durable_objects`. "Support for more products is coming soon."
- What happens: "Cloudflare rejects new invocations of your Workers" (HTTP, Cron, Queue consumers, Email, calls from other Workers/DOs). "HTTP visitors receive error `1103`." "Requests rejected by the spending limit are not billed as Worker invocations." Static assets served without the Worker keep working; `run_worker_first` paths can fail.
- **Not exact:** "A spending limit is not an exact maximum bill. Usage reporting and blocking take time, so usage can continue after the threshold is reached." "Metering delays, operations already in progress, and enforcement failures can allow spend to exceed a limit." "Your invoice is the final record of charges."
- Period: resets at the subscription billing period, not the calendar month. The block "expires at the start of the next subscription billing period"; raising/turning off/removing the limit lifts it ("Changes can take a few minutes to apply").
- Amount: "greater than zero, with up to two decimal places". One enabled limit per product per account.
- Notifications: policies with an email "send notifications at 80% and 100% of the threshold". "Spending limits created in the dashboard do not automatically have an email recipient."
- CLI (the new `cf` CLI, not Wrangler):

```sh
cf billing spend-policies create \
  --name 'Workers $50 spending limit' --product-id workers --enabled true \
  --threshold-cents 5000 --action usage_block --notification-email billing@example.com
# --action notification  => email alert only, no blocking
```

### 7b. Budget alerts (email only)

Source: `DOCS/billing/manage/budget-alerts.mdx`, `CHANGELOG/fundamentals/2026-04-13-billable-usage-dashboard-and-budget-alerts.mdx`, `CHANGELOG/billing/2026-06-15-budget-alerts-default-on.mdx`.

- Feature name: **"Budget alerts"**. Path: **Manage Account > Billing > Billable Usage > Create budget alert** (changelog: **Set Budget Alert**), or **Notifications > Add > Budget Alert**.
- Scope: account-wide, all usage-based products combined (this is the one that includes R2 and D1), dollar threshold.
- "Budget alerts are informational only. They do not pause or limit usage."
- Latency: "Usage is processed once per day for the prior day's activity, so budget alerts fire the day after the threshold is reached rather than in real time."
- Default: eligible Pay-as-you-go accounts get an automatic "$10 account-level threshold" alert.
- "Budget alerts only consider spend on usage-based products. Recurring subscription fees, such as the Workers Paid plan fee … are not included".
- Companion: **Billable Usage** dashboard (**Manage Account > Billing > Billable Usage**) shows daily cost per product.

### 7c. Usage notifications (per-product metric, email only)

Source: `DOCS/billing/understand/usage-based-billing.mdx`.

- Path: **Notifications > Add** > notification for **Billable Usage**. Threshold is a product metric (requests, bytes), not dollars.
- "If you are on a Professional plan or higher, you can monitor the usage of individual Cloudflare add-ons by turning on email notifications."
- "The email notifications are for informational purposes only."

### 7d. Threshold billing (not a cap — the opposite)

`DOCS/billing/threshold-billing.mdx`: when combined usage charges reach a threshold mid-cycle, "Cloudflare generates a mid-cycle invoice and charges your payment method on file."

### 7e. What actually bounds spend, in practice

| Mechanism | Bounds | Hard? |
|---|---|---|
| Workers spending limit (7a) | Workers requests + CPU, account-wide | Blocks, with lag; not exact |
| `limits.cpu_ms` (section 3) | CPU per invocation | Yes per request (with small isolate "flexibility") |
| `limits.subrequests` | subrequests per invocation | Yes per request |
| Rate Limiting binding (section 2) | calls per key per location | Approximate, per location, and the Worker has already been invoked (the request is already billed) |
| Per-account request rate limit | none — "There is no general limit on requests per second." Paid requests: "No limit" | — |
| WAF rate limiting rules on a custom domain zone | requests before the Worker runs | Not researched here |
| R2 / D1-Paid / KV | nothing but budget alerts | No |

An application-level budget (for example a D1 counter of renders per day that the Worker checks before doing R2 writes or expensive CPU) is the only way to cap R2 Class A operations and D1 writes.

---

## 8. Secrets, vars, environments

Source: `DOCS/workers/configuration/secrets.mdx`, `PARTIALS/workers/secrets-in-dev.mdx`, `DOCS/workers/configuration/environment-variables.mdx`, `DOCS/workers/wrangler/environments.mdx`, `DOCS/workers/wrangler/configuration.mdx`, [npm] config schema.

- **Secrets (deployed):** `npx wrangler secret put <KEY>` — "creates a new version of the Worker and deploys it immediately." Per environment: add `--env <name>`. `npx wrangler secret delete <KEY>`. Bulk: `wrangler secret bulk`, or `wrangler deploy --secrets-file .env.production`. "Wrangler will not delete your secrets … unless you run `wrangler secret delete <key>`."
- **Secrets (local):** "Put secrets for use in local development in either a `.dev.vars` file or a `.env` file, in the same directory as the Wrangler configuration file." dotenv syntax. "Choose to use either `.dev.vars` or `.env` but not both." Per-env files: `.dev.vars.<environment-name>` — "If `.dev.vars.<environment-name>` exists then only this will be loaded; the `.dev.vars` file will not be loaded." Add `.dev.vars*` and `.env*` to `.gitignore`.
- **Declaring required secrets:** `"secrets": { "required": ["API_KEY"] }` — validated on `wrangler deploy` / `versions upload`, drives `wrangler types`, and "only the keys listed in `secrets.required` are loaded from `.dev.vars` or `.env`".
- **Non-secret vars:** `[vars]` in the Wrangler file ("Text strings and JSON values are not encrypted"). "Do not use `vars` to store sensitive information". Dashboard-edited vars are overwritten on deploy unless `keep_vars = true`.
- A variable and a secret cannot share a name; "Deploying a variable with the same name as an existing secret does not fail. The variable replaces the secret, and the secret is deleted."
- Access: `env.X` in handlers, or `import { env } from "cloudflare:workers"`.
- Limits: 64 (Free) / 128 (Paid) variables+secrets per Worker, 5 KB each.

**Environments:** `[env.<name>]`, selected with `--env/-e` or `CLOUDFLARE_ENV`. "Cloudflare effectively creates a new Worker with the name `<top-level-name>-<environment-name>`." Bindings and `vars` "are not inheritable and need to be defined explicitly".

[ran] with wrangler 4.166.0 (`deploy --dry-run --env staging`): this TOML produced `env.DB (emp-staging)`, `env.BUCKET (emp-bucket-staging)`, `env.RL (5 requests/60s)`, `env.ASSETS`, `env.FOO ("staging")`:

```toml
[env.staging]
routes = [{ pattern = "staging.example.com", custom_domain = true }]

[env.staging.vars]
FOO = "staging"

[[env.staging.d1_databases]]
binding = "DB"
database_name = "emp-staging"
database_id = "11111111-1111-1111-1111-111111111111"

[[env.staging.r2_buckets]]
binding = "BUCKET"
bucket_name = "emp-bucket-staging"

[[env.staging.ratelimits]]
name = "RL"
namespace_id = "2001"
simple = { limit = 5, period = 60 }
```

An environment that omitted them got warnings of the form `"d1_databases" exists at the top level, but not on "env.bare". This is not what you probably want, since "d1_databases" is not inherited by environments.` — same for `vars`, `r2_buckets`, `ratelimits`. `assets` and `limits` were inherited.

---

## 9. Custom domains, workers.dev, preview URLs

Source: `DOCS/workers/configuration/routing/custom-domains.mdx`, `…/workers-dev.mdx`, `DOCS/workers/wrangler/configuration.mdx`, `DOCS/workers/previews/index.mdx`, `DOCS/workers/versions-and-deployments/version-urls.mdx`.

**Custom Domain:**

```toml
routes = [{ pattern = "shop.example.com", custom_domain = true }]
```

- Requires "An active Cloudflare zone". "Cloudflare will create DNS records and issue necessary certificates on your behalf." "Custom Domains point all paths of a domain or subdomain to your Worker."
- "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record or on a zone you do not own."
- Dashboard: Workers & Pages > Worker > **Settings > Domains & Routes > Add > Custom Domain**.
- Limit: 100 custom domains per zone.
- `workers_dev` "Defaults to `true` when the configuration has no `route` or `routes`, and `false` otherwise. To keep the `workers.dev` URL alongside routes, set `workers_dev` to `true`."
- Routes set in the dashboard are overwritten by the config on the next deploy.

**workers.dev:** "`<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev`". For an environment the Worker name is `<name>-<env>`. Worker name must be <= 63 characters for workers.dev.

- "It's recommended to run production Workers on a Workers route or custom domain… Your `workers.dev` subdomain is treated as a Free website and is intended for personal or hobby projects".
- **Browser Integrity Check cannot be turned off on workers.dev:** "Automated clients that send some default library `User-Agent` headers (for example, the default Python `urllib` user agent) receive error 1010 before your Worker runs. These requests do not appear in your Worker logs." This matters for an image API fetched by scripts and crawlers; a custom domain lets you skip BIC by rule.

**Version URLs** (formerly "preview URLs"): `<version-prefix>-<worker-name>.<subdomain>.workers.dev`; aliased: `<alias>-<worker-name>.<subdomain>.workers.dev` via `npx wrangler versions upload --preview-alias staging`. "A Version URL runs one uploaded version against your production resources". "If Version URLs are enabled, the URL is public". Config key: `preview_urls` (boolean) — "Enables Version URLs and `workers.dev` Preview URLs. If omitted, Wrangler does not change an existing setting. If no setting exists, its initial value depends on `workers_dev`."

**Previews** (new, Wrangler >= 4.135.0): `npx wrangler preview` creates a per-branch Preview. URLs: Preview URL `<preview-name>-<worker-name>.<subdomain>.workers.dev`, Deployment URL `<deployment-id>-<worker-name>.<subdomain>.workers.dev`. "Previews do not inherit production settings. Define them in the `previews` block". "KV, D1, R2, and other resources are isolated when you bind the Preview to a separate resource." "Preview URLs are public by default." workers.dev preview URLs send `X-Robots-Tag: noindex`. Limits: 100 Previews per Worker (Free) / 500 (Paid).

---

## 10. Vitest integration

### The package was renamed

- [npm] `@cloudflare/vitest-pool-workers@0.23.0` (latest, published 2026-10-07) README: "**Deprecated** — `@cloudflare/vitest-pool-workers` has been renamed to `@cloudflare/vitest-plugin`. This package will not receive future updates." Migration: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`. Its peer deps: `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0`; it depends on `wrangler 4.124.0` and `miniflare 5.20260815.0-alpha`.
- [npm] **`@cloudflare/vitest-plugin@1.9.0`** (latest, published 2026-11-20; releases are near-daily). Peer dep: **`vitest: "^4.1.0 || ^5.0.0"`**. Dependencies: `miniflare 5.20261119.0-beta`, `esbuild 0.28.2`, `zod 4.6.6`, `cjs-module-lexer 1.2.3` — it no longer depends on `wrangler`. Exports: `.` and `./types` only (no `/config` subpath).
- `vitest` dist-tags today: `latest` 5.1.1, `V4` 4.1.12. Docs install line: `vitest@^4.1.0 @cloudflare/vitest-plugin`; "requires Vitest 4.1 or later".
- [ran] the same test file passed under `vitest@4.1.12` and under `vitest@5.1.1` with plugin 1.9.0.

### Config shape (current)

Source: `DOCS/workers/testing/vitest-integration/configuration.mdx`, `…/write-your-first-test.mdx`, [npm] `dist/pool/index.d.mts`.

```ts
// vitest.config.ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.toml" /*, environment: "staging" */ },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },   // overrides / additions
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
```

- `cloudflareTest(options | (ctx) => options | Promise<options>)` returns a Vite plugin. Options ([npm] zod schema): `main?`, `wrangler?: { configPath?, environment? }`, `miniflare?` (loose Miniflare worker options, plus `workers?: []` for auxiliary Workers), `config?: boolean | string` (for `cloudflare.config.ts`; cannot be combined with `wrangler`), `remoteBindings` (default set), `additionalExports`, `verbose?`.
- "`configPath` accepts both `.toml` and `.json` files." "These options will be merged with the `miniflare` option above, with `miniflare` values taking precedence."
- "The Wrangler `alias` field is not read. Set the same aliases in Vite's `resolve.alias`".
- "Custom Vitest `environment`s or `runner`s are not supported".
- Old → new: "`defineWorkersProject` and `defineWorkersConfig` from `@cloudflare/vitest-pool-workers/config` have both been removed. They are replaced by a `cloudflareTest()` Vite plugin … with options previously nested under `test.poolOptions.workers` passed directly to `cloudflareTest()`." (That change landed in pool-workers 0.13.0; v0.12.x was the last Vitest 3 line.)
- Types: add `"@cloudflare/vitest-plugin/types"` to the test `tsconfig.json` `types`, plus the `wrangler types` output in `include`. Type `env` via `declare module "cloudflare:workers" { interface ProvidedEnv extends Env {} }`.

### Test APIs

Source: `…/test-apis.mdx`, [npm] `types/cloudflare-test.d.ts`.

- `import { env, exports } from "cloudflare:workers"` — `exports.default.fetch("https://example.com/path")` is the integration entry point. "The `main` Worker runs in the same isolate/context as tests so any global mocks will apply to it too."
- `import { createExecutionContext, waitOnExecutionContext, applyD1Migrations, reset, createScheduledController, … } from "cloudflare:test"`.
- `SELF` and `env` from `cloudflare:test` still exist but are `@deprecated` in the 1.9.0 types ("Instead, use `import { exports } from "cloudflare:workers"` and `exports.default.fetch()`").
- **D1 migrations:** `readD1Migrations(migrationsPath | { projectPath?, migrationsDir?, migrationsPattern? })` runs in Node (config file) and returns `{ name, queries[] }[]`; pass it in as a binding; then in a setup file `await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (third arg: migrations table name, default `d1_migrations`). The fixture comment: "Setup files run outside the per-test-file storage isolation, and may be run multiple times. `applyD1Migrations()` only applies migrations that haven't already been applied". [ran] calling it in `beforeAll` of each file also works.

### Mocking outbound fetch

- "The `import { fetchMock } from "cloudflare:test"` import has been removed. Mock `globalThis.fetch` directly or use ecosystem libraries such as MSW." (`migrate-from-vitest-3-to-vitest-4.mdx`). [npm] 1.9.0 types have no `fetchMock` export.
- Documented way: `@msw/cloudflare` with MSW v3 — `setupNetwork()`, `network.enable()` / `resetHandlers()` / `disable()`, `network.use(http.get(url, () => HttpResponse.json(...)))` (`mock-outbound-requests.mdx`). npm today: `msw@3.0.7`, `@msw/cloudflare@0.2.0` (peer `msw >=3`). I did not run MSW.
- [ran] `vi.spyOn(globalThis, "fetch").mockImplementation(...)` intercepted the Worker's outbound `fetch` both via `exports.default.fetch()` and via a direct `worker.fetch(request, env, ctx)` call.

### Isolation

- `isolatedStorage` and `singleWorker` "have been removed. Storage isolation is now per test file" — not per test. "The test runner will undo any writes to storage at the end of each test file". To share storage across files: `--max-workers=1 --no-isolate`.
- [ran] a second test file saw 0 D1 rows and 0 R2 objects written by the first. Within a file, state persists across tests, so tests in one file must use distinct keys or clean up (`reset()` from `cloudflare:test` exists for this).
- Recommendations: await all storage operations; consume response bodies (including `R2.get()` bodies).

### Static assets in tests

- "`exports.default.fetch()` behaves the same as `SELF.fetch()`, except that it does not expose Assets. To test Assets, use the `env.ASSETS` binding or write an integration test using `startDevWorker()`." The fixture README says: "Neither integration nor unit tests should expose assets. However, you can mock them".
- [ran] `exports.default.fetch("https://example.com/terms")` hit my Hono catch-all (404), i.e. the asset router is not in front of the Worker in tests. But `env.ASSETS.fetch("https://assets.local/terms")` returned the real file (200), and `/terms.html` → 307, `/nope` → 404 with `404.html`. So html_handling can be asserted through `env.ASSETS`, while the full "asset first, then Worker, `run_worker_first`" routing can only be tested with `wrangler dev` / `createTestHarness()`.
- New, recommended for integration tests: **`createTestHarness()`** from `wrangler` (`DOCS/workers/testing/test-harness/*.mdx`): `createTestHarness({ workers: [{ configPath: "./wrangler.jsonc" }] })`, then `server.listen()`, `server.fetch("/")`, `server.reset()`, `server.close()`. It "Runs production build output from Wrangler" from any Node test runner. I did not run it.

### `.wasm` imports

- Fixture README (workers-sdk `fixtures/vitest-plugin-examples/web-assembly`): "Wrangler's default module rules are enabled by `@cloudflare/vitest-plugin` if you have a `wrangler.configPath` configured. This means `.wasm` files can be imported as `WebAssembly.Module`s." The fixture also imports `./add.wasm?module`.
- [ran] `import addWasm from "./add.wasm"` in the Worker → `new WebAssembly.Instance(addWasm)` worked in Vitest and in `wrangler dev`, with compatibility dates 2026-11-01 and 2026-11-19.
- [ran] wasm from a dependency also worked in Vitest: `import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm"` (v2.6.2) gave `[object WebAssembly.Module]`, `initWasm()` succeeded and a 1200x630 SVG rendered to an 11 KB PNG.
- Known issue that can bite wasm-loading libraries: "Dynamic `import()` statements do not work inside `export default { ... }` handlers when writing integration tests with `exports.default.fetch()`".

### Other known issues (`known-issues.mdx`)

- "Native code coverage via V8 is not supported. You must use instrumented code coverage via Istanbul".
- "Vitest's fake timers do not apply to KV, R2 and cache simulators."
- Module-resolution errors (`Cannot use require() to import an ES Module`, `No such module`): add the package to `test.deps.optimizer.ssr.include`.
- The plugin injects `nodejs_compat` for the test runtime: "Using the Workers Vitest plugin may cause your Worker to behave differently when deployed" (less relevant for compatibility dates >= 2026-08-04, where it is on by default).
- `limits.cpu_ms` is not enforced locally, so tests cannot prove a render fits a CPU limit.
- "Miniflare is not a hardened sandbox" (`PARTIALS/workers/local-development-security.mdx`).

### Install gotcha seen here

[ran] `npm install -D wrangler@4.166.0 @cloudflare/vitest-plugin@1.9.0 vitest@^4.1.0 hono` crashed in npm 10.9.9 with `Cannot read properties of null (reading 'edgesOut')`. Installing `wrangler` first and the rest with `--legacy-peer-deps` worked; in a clean directory `npm install -D @cloudflare/vitest-plugin@1.9.0 vitest@5.1.1 hono` (no wrangler) worked without flags. I did not isolate the cause.

---

## 11. Outbound `fetch()` to IPs / private addresses, and ports

What the docs actually say:

- **Bare IPs** (`DOCS/workers/platform/known-issues.mdx`, "Fetch to IP addresses"): "For Workers subrequests, requests can only be made to URLs, not to IP addresses directly. To overcome this limitation add an A or AAAA record to your zone and then fetch that resource." … "Do not use: `await fetch('http://192.0.2.1')`". The page does not state what error is returned.
- **Error codes** (`DOCS/workers/observability/errors.mdx`): `1021` "Worker has requested a host it cannot access." `1024` "Worker cannot make a subrequest to a Cloudflare-owned IP address." `1042` same-zone Worker-to-Worker fetch. `1019` loop limit ("A Worker cannot call itself or another Worker more than 16 times").
- **Own zone** (`FLAGS/global-fetch-strictly-public.md`): without `global_fetch_strictly_public`, a `fetch()` to the Worker's own zone is "routed to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings." The flag has no default-on date in its metadata.
- **Ports for `fetch()`** (`FLAGS/allow-custom-ports.md`, enabled by default from compatibility date 2024-09-02): "When you make a subrequest to a website that uses Cloudflare ("Orange Clouded") — only ports supported by Cloudflare's reverse proxy can be specified. If you attempt to specify an unsupported port, it will be ignored. When you make a subrequest to a website that does not use Cloudflare ("Grey Clouded") - any port can be specified." Cloudflare proxy ports: HTTP 80, 8080, 8880, 2052, 2082, 2086, 2095; HTTPS 443, 2053, 2083, 2087, 2096, 8443.
- **`connect()` TCP sockets** (`DOCS/workers/runtime-apis/tcp-sockets.mdx`): "Outbound TCP sockets to Cloudflare IP ranges are blocked." Error `proxy request failed, cannot connect to the specified address`: "Your socket is connecting to an address that was disallowed. Examples of a disallowed address include Cloudflare IPs, `localhost`, and private network IPs." "By default, Workers cannot create outbound TCP connections on port `25`" (`Connections to port 25 are prohibited`). `TCP Loop detected` when connecting back to itself.

What the docs do **not** say (see Unverified): the exact status/exception for `fetch()` to an IP literal; whether `fetch()` to a hostname that resolves to an RFC 1918 / loopback / link-local address is blocked; and how redirects to such targets are treated.

[ran] local `workerd` happily fetched `http://127.0.0.1:8791/x.txt` (200) from inside a Vitest test. Local dev therefore gives **no** SSRF protection signal. If the image API fetches user-supplied URLs, validate in code (scheme allow-list, reject IP-literal and internal hostnames, cap redirects with `redirect: "manual"`, cap response size and time) and do not rely on the platform.

---

## Empirical run log (what I executed)

Project at `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/empirical/` (`wrangler.toml`, `wrangler.env.toml`, `vitest.config.ts`, `src/index.ts`, `test/emp*.test.ts`).

1. `vitest run` (plugin 1.9.0, vitest 4.1.12): 10 tests in 5 files passed — rate limiter, D1 RETURNING/changes/batch rollback, R2 put/onlyIf/metadata, `env.ASSETS` html handling, `exports.default.fetch`, `caches.default`, per-file storage isolation, `vi.spyOn(fetch)`, resvg wasm from node_modules, loopback fetch.
2. Same `emp.test.ts` under vitest 5.1.1 in `…/scratchpad/empirical5/`: 6 passed.
3. `wrangler deploy --dry-run` for the base config and `--env staging` / `--env bare`: config accepted; binding table and inheritance warnings as quoted. Bundle for Hono + tiny wasm: "Total Upload: 62.14 KiB / gzip: 16.07 KiB".
4. `wrangler d1 migrations apply emp --local`: applied.
5. `wrangler dev` with and without `run_worker_first`: routing table in section 1; rate limiter 3x200 then 429.

---

## Unverified

1. **Rate Limiting binding price.** No docs page I read gives a price or says it is free, and none says whether it is available on the Workers Free plan.
2. **R2 needs a payment method.** Docs say a "checkout flow" adds an "R2 subscription"; they do not literally say a card is required. Third-party sources conflict. Not checked in the dashboard.
3. **Cache API on `*.workers.dev`.** Current docs positively list only custom domains and Pages; the explicit "no impact on workers.dev" wording is absent from today's source. Actual behaviour not tested.
4. **Production behaviour of everything marked [ran].** All runs used the local simulator (Miniflare/workerd). In particular not verified against real Cloudflare: R2 `onlyIf: { etagDoesNotMatch: "*" }` as create-if-absent; D1 `meta.changes` / `rows_written` values; rate limiter counts; asset redirect details for `terms/index.html` + `/terms/index.html` (docs table says "307 to /folder", local run returned `/privacy/`).
5. **`fetch()` to IP literals and to hostnames resolving to private/reserved IPs.** Docs say IP-literal fetches are not possible but give no error code for `fetch()`; nothing found on DNS-resolved private targets or on redirects to them.
6. **Spending-limit dashboard labels.** Guide says "Billing > Spend Management"; changelog says "Billing > Spend limits" with a "Block usage" toggle. Also not stated: how long enforcement lag typically is, and whether the feature is available on every account type.
7. **Workers Cache maturity.** No beta/GA label found; "At launch…" wording suggests it is new. Not tested.
8. **Wrangler commands against a real account** (`r2 bucket lifecycle add`, `secret put`, `d1 … --remote`, `deploy`, `preview`, `cf billing spend-policies`): flags taken from docs and from the wrangler 4.166.0 bundle, not executed. The `cf` CLI was not installed or inspected.
9. **MSW (`@msw/cloudflare`) and `createTestHarness()`**: documented, not run.
10. **Minimum Wrangler version for boolean `run_worker_first`**: not stated in the pages read (only the array form: v4.20.0).
11. **Real CPU time of an image render.** Local wall time for a trivial resvg render was ~64 ms on this container; that says nothing reliable about production CPU ms. `limits.cpu_ms` is not enforced locally.
12. **WAF rate limiting rules / zone-level protections** in front of a custom domain were not researched.
13. **Live site parity.** I read the docs repository source, not the rendered site; `developers.cloudflare.com` and `www.cloudflare.com` must be allowed in the session's network settings to check the rendered pages and marketing pricing.
