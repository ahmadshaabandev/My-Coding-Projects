# Platform feasibility and risk for linktocard.com candidate tools (Cloudflare + Paddle + libraries + legal), as of 2026-11-26

How these notes were gathered (read this before using any number):

- **Cloudflare docs were read directly** on 2026-11-26 as Markdown from `developers.cloudflare.com/<path>/index.md`. Where the page carried a `dateModified` value it is given as "(page modified YYYY-MM-DD)". These are primary sources.
- **npm package data was read directly** with `npm view` on 2026-11-26 (version, license, publish date of that version, unpacked size, dependencies, README text).
- **Paddle's own agent skill for usage-based billing was read directly** from `raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/usage-based-billing/SKILL.md` on 2026-11-26.
- **paddle.com, developer.paddle.com, eur-lex.europa.eu, law.cornell.edu and unit42.paloaltonetworks.com could NOT be fetched** from this session (DNS blocked by the session's network allowlist). Facts about those pages come from WebSearch excerpts (marked "[search excerpt]") or from the earlier in-repo research file `linktocard/research/paddle-compliance.md` (dated 2026-11-21, itself built from search excerpts). Those need a human spot-check before being quoted in legal copy or pricing.
- Some facts come from the project's own staging measurements in `/home/user/My-Coding-Projects/linktocard/README.md` (2026-11-25/26). They are marked "[staging]".

---

## 1. Cloudflare Browser Run (formerly Browser Rendering): actions, options, limits, pricing, and how Quick Actions are billed

### Takeaway
Browser Run Quick Actions (screenshot, pdf, content, markdown, snapshot, accessibilityTree, scrape, json, links, plus REST-only crawl) are billed only on browser time: on Workers Paid, 10 browser hours/month are included, then $0.09/hour, with no concurrency charge for Quick Actions (concurrency at $2.00/browser applies only to Browser Sessions). At the staging-measured 0.23 to 1.2 s per PDF, browser cost is a fraction of a cent per thousand renders, so the binding constraints are rate limits (30 Quick Action requests/second per account on Paid), the 60 s page-load cap, bot-blocking of Browser Run traffic, and the lack of hostname guardrails for Quick Actions (an SSRF concern for any "screenshot a URL" product). No Cloudflare document explains why `X-Browser-Ms-Used` reads 0 for binding PDF calls.

### Cited Findings

**Product naming and access paths**
- Browser Run is the new name of Browser Rendering; the changelog is "a detailed changelog of every update to Browser Run (formerly Browser Rendering)". — [Browser Run changelog](https://developers.cloudflare.com/browser-run/changelog/) (read 2026-11-26)
- Quick Actions can be used two ways: REST API, or "Workers Bindings: Call Quick Actions directly from a Cloudflare Worker using `env.BROWSER.quickAction()`"; no API token is needed for the binding. — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/) (page modified 2026-11-13)
- "The `.quickAction()` method requires a compatibility date of `2026-03-24` or later." — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/)
- The binding `quickAction()` launched 2026-05-28; supported actions named in that entry: screenshot, PDF, content, markdown, JSON, scrape, links, and snapshot. — [Browser Run changelog, 2026-05-28](https://developers.cloudflare.com/browser-run/changelog/)
- "`/crawl` is available via the REST API only." — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/)
- The docs show the REST endpoint as `https://api.cloudflare.com/client/v4/accounts/<accountId>/browser-run/screenshot`, while the API reference still lists paths under `/accounts/{account_id}/browser-rendering/...` (accessibilityTree, content, crawl, json, links, markdown, pdf, scrape, screenshot, script, snapshot, devtools/*). — [Screenshot endpoint](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/); [API reference: browser_rendering](https://developers.cloudflare.com/api/resources/browser_rendering/)
- Local dev: under `wrangler dev`, `.quickAction()` uses local Chrome and returns the same responses, except the `json` action returns placeholder data (Workers AI not available locally) and Kitesurf is unavailable; set `"remote": true` on the binding for real results. — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/)

**Full Quick Actions list (current)**
- `/content` (rendered HTML; returns page title since 2025-07-29), `/screenshot`, `/pdf`, `/markdown`, `/snapshot`, `/accessibilityTree` (added 2026-07-07), `/scrape` (elements by selector), `/json` (AI extraction), `/links`, `/crawl` (beta, added 2026-03-10), plus `/script` (run your own Playwright/Puppeteer/CDP script in one request). — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/); [changelog](https://developers.cloudflare.com/browser-run/changelog/); [Custom scripts](https://developers.cloudflare.com/browser-run/script/)
- `/snapshot` `formats` accepts `"content"`, `"screenshot"`, `"markdown"`, `"accessibilityTree"`, `"pdf"`, `"links"`, `"scrape"`, `"json"`; default `["content", "screenshot"]`. — [/snapshot](https://developers.cloudflare.com/browser-run/quick-actions/snapshot/)
- `/links`: `visibleLinksOnly` (default false) and `excludeExternalLinks` (default false); since 2026-10-30 it "now returns absolute URLs". — [/links](https://developers.cloudflare.com/browser-run/quick-actions/links-endpoint/); [changelog 2026-10-30](https://developers.cloudflare.com/browser-run/changelog/)
- `/json` "leverages Workers AI for data extraction using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Using this endpoint incurs usage on Workers AI"; a `custom_ai` array lets you bring your own model/key via AI Gateway providers, with fallbacks. — [/json](https://developers.cloudflare.com/browser-run/quick-actions/json-endpoint/)
- `/crawl`: `limit` "Maximum number of pages to crawl (default is 10, maximum is 100,000)"; `depth` max 100,000; `maxAge` cache default 86,400 s, max 604,800 s; jobs run max seven days; results kept 14 days; `render: false` "does a fast HTML fetch without executing JavaScript"; "During the beta, `render: false` crawls are not billed. After the beta, they will be billed under Workers pricing"; `render: true` crawls "are billed under typical Browser Run pricing". — [/crawl](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/) (page modified 2026-11-03)
- `/crawl` honours robots.txt (per-URL status `robots_disallowed`: "The site's `robots.txt` rules disallowed the URL") and Content Signals: `crawlPurposes` defaults to `["search", "ai-input", "ai-train"]`; if the site's robots.txt `Content-Signal` sets a declared purpose to `no`, "the crawl request will be rejected with a `400` error". — [/crawl](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)
- Free plan crawl limits: 5 crawl jobs/day, 100 pages max per crawl. — [Limits](https://developers.cloudflare.com/browser-run/limits/)

**Screenshot options (API reference)**
- Body takes `url` or `html`, plus: `actionTimeout` (max 120000 ms in the API schema), `addScriptTag`, `addStyleTag`, `allowRequestPattern`, `allowResourceTypes`, `authenticate` (HTTP basic), `bestAttempt`, `cookies`, `emulateMediaType`, `gotoOptions` {`referer`, `referrerPolicy`, `timeout` (max 60000), `waitUntil`}, `rejectRequestPattern`, `rejectResourceTypes`, `screenshotOptions` {`captureBeyondViewport`, `clip`, `encoding` binary/base64, `fromSurface`, `fullPage`, `omitBackground`, `optimizeForSpeed`, `quality`, `type` png/jpeg/webp}, `scrollPage`, `selector`, `setExtraHTTPHeaders`, `setJavaScriptEnabled`, `userAgent`, `viewport` {width, height, `deviceScaleFactor`, `hasTouch`, `isLandscape`, `isMobile`}, `waitForSelector`, `waitForTimeout`. Query params: `browser=kitesurf` (beta) and `cacheTTL` ("default is 5s. Set to 0 to disable", max 86400). — [API reference: screenshot create](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/)
- Default viewport 1920x1080; `quality` with the default PNG returns 400. — [/screenshot](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)
- "The `userAgent` parameter does not bypass bot protection. Requests from Browser Run will always be identified as a bot." — [/screenshot](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)

**PDF**
- "The PDF endpoint accepts request bodies up to 50 MB. Requests larger than this will fail with `Error: request entity too large`." — [/pdf](https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/)
- Supports `headerTemplate`/`footerTemplate` with `displayHeaderFooter` and placeholders `title`, `date`, `pageNumber`, `totalPages`. — [/pdf](https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/)
- [staging] Every option linktocard sends (incl. `cacheTTL: 0`, `tagged: false`, `outline: false`) was accepted; PDFs of 1 to 41 pages rendered; a request of 27 inlined images (just under 10 MB) worked; a print that cannot finish returned 422 after about 61 s. — [linktocard/README.md](/home/user/My-Coding-Projects/linktocard/README.md)

**Timeouts**
- `goToOptions.timeout` default 30 s, max 60 s; `waitForSelector` max 60 s; `waitForTimeout` max 60 s; `actionTimeout` max 5 min; `PDFOptions.timeout` default 30 s, max 5 min; `waitUntil` default `domcontentloaded`. — [Quick Actions timeouts](https://developers.cloudflare.com/browser-run/reference/timeouts/) (page modified 2026-04-21). **Conflict:** the API reference schema lists `actionTimeout` maximum 120000 ms (2 min). — [API reference: screenshot create](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/screenshot/methods/create/)
- 422 "Unprocessable entity" is "Most often ... caused by a timeout". — [FAQ](https://developers.cloudflare.com/browser-run/faq/)

**Limits (Workers Paid defaults)**
- Browser hours: no limit; concurrent browsers per account (Browser Sessions only): 200; new browser instances (Browser Sessions only): 3 per second; browser timeout 60 s of inactivity (extendable to 20 min with `keep_alive`); "Total requests per second (Quick Actions only)": 30 per second; 429 with `Retry-After` when exceeded; higher limits by request form. — [Limits](https://developers.cloudflare.com/browser-run/limits/) (page modified 2026-10-14)
- Workers Free: 10 minutes/day browser time; 3 concurrent browsers; 1 new browser per 20 s; Quick Actions 1 request every 10 seconds; over the daily limit returns `429 Browser time limit exceeded for today` until next UTC day. — [Limits](https://developers.cloudflare.com/browser-run/limits/)
- **Conflict / history:** the changelog's last limits entries say Paid concurrency rose to "120 per account" and new instances to "1 per second" (2026-04-15) and REST to "10 per second" (2026-03-04). The limits page (modified 2026-10-14) now says 200, 3/s and 30/s; no changelog entry records that later rise. Treat the limits page as current. — [changelog](https://developers.cloudflare.com/browser-run/changelog/); [Limits](https://developers.cloudflare.com/browser-run/limits/)

**Pricing**
- "Quick Actions: Charged for browser hours only. Browser Sessions (Puppeteer, Playwright, CDP, Custom scripts): Direct browser control, charged for both browser hours and concurrent browsers." "Browser hours are shared across all methods." — [Pricing](https://developers.cloudflare.com/browser-run/pricing/) (page modified 2026-11-20)
- Workers Free: 10 minutes/day browser hours; 3 concurrent browsers. Workers Paid: "10 hours per month, then $0.09 per additional hour"; concurrent browsers "10 browsers (averaged monthly), then $2.00 per additional browser". — [Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- Concurrency is "the monthly average of your daily peak usage". — [Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- Billing time: daily totals in seconds, summed per cycle and "rounded to the nearest whole hour" (1,800 s or more rounds up, 1,799 s or less rounds down). — [Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- "If a Quick Actions request fails with a `waitForTimeout` error, the browser session is not charged." — [Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- `/script`: "Browser hours are billed for the session's lifetime, not per script request"; its `X-Browser-Ms-Used` is cumulative since session start. — [Custom scripts](https://developers.cloudflare.com/browser-run/script/)
- Billing for Browser Rendering began 2025-08-20. — [changelog 2025-08-20](https://developers.cloudflare.com/browser-run/changelog/)
- Kitesurf (Cloudflare's lightweight Workers-based browser, `browser=kitesurf` on any Quick Action): "Kitesurf is in beta and available for free, behind per-account limits." It cannot yet play video or render WebGL, "Negotiate a bot-challenge handshake with real TLS fingerprints", or hold long authenticated sessions; Cloudflare's own benchmark shows screenshot CPU 380 ms vs 1,173 ms (Chromium), memory 57.8 MiB vs 271.0 MiB, wall time 1,148 ms vs 637 ms. — [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/) (page modified 2026-11-13)

**How Quick Actions report usage (the `X-Browser-Ms-Used: 0` question)**
- "The `X-Browser-Ms-Used` header is returned in all Quick Actions and `/script` responses, and reports browser time in milliseconds. For Quick Actions, it reports the time used by that request." — [Pricing](https://developers.cloudflare.com/browser-run/pricing/)
- The header was added 2025-09-02 for "Each REST API response". — [changelog 2025-09-02](https://developers.cloudflare.com/browser-run/changelog/)
- The dashboard **Browser Run** page shows "aggregate metrics, including total Quick Actions requests and total browser hours used". — [Quick Actions overview](https://developers.cloudflare.com/browser-run/quick-actions/)
- The binding exposes `limits()`, which "Returns the current session limits and usage values". — [Browser binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/)
- [staging] Binding PDF quick actions return `X-Browser-Ms-Used: 0`; measured call length was about 0.23 to 1.2 s per PDF. — [linktocard/README.md](/home/user/My-Coding-Projects/linktocard/README.md)
- A web search found no Cloudflare page, changelog entry, community thread or blog explaining a zero value. — [WebSearch 2026-11-26 results incl. Pricing page and third-party posts such as flaviocopes.com/cloudflare-browser-run](https://flaviocopes.com/cloudflare-browser-run/)

**Caching, data retention, bot identity, robots**
- Quick Actions output (except `/crawl`) "is cached by default for five seconds (configurable up to one day via the `cacheTTL` parameter, or set to `0` to disable caching)... Customer-submitted HTML content itself is not cached." — [FAQ](https://developers.cloudflare.com/browser-run/faq/)
- Cloudflare "processes content ephemerally and does not retain customer-submitted HTML or generated output (such as PDFs or screenshots)"; exceptions: crawl results stored 14 days (in R2), opt-in session recordings 30 days. — [FAQ](https://developers.cloudflare.com/browser-run/faq/)
- "Browser Run requests are always identified as bot traffic by Cloudflare"; allowlisting Browser Run on your own site needs Enterprise (Bot Management fields). No per-request IP rotation; traffic "comes from Cloudflare IP ranges". — [FAQ](https://developers.cloudflare.com/browser-run/faq/)
- Non-configurable headers on every request: `cf-brapi-request-id` (Quick Actions), `cf-brapi-devtools`, `cf-biso-devtools`, `Signature-agent`, `Signature`, `Signature-input` (Web Bot Auth). Bot detection ID `119853733` for Quick Actions/sessions, `128292352` for crawl. Quick Actions default UA now reports Chrome 152 (since 2026-10-30) and is customizable; crawl UA `CloudflareBrowserRenderingCrawler/1.0` is not. — [Automatic request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/); [changelog 2026-10-30](https://developers.cloudflare.com/browser-run/changelog/)
- Cloudflare's own robots page: "robots.txt is advisory, not enforceable". — [robots.txt and sitemaps](https://developers.cloudflare.com/browser-run/reference/robots-txt/)

**Isolation / SSRF controls**
- Guardrails (hostname allowlist, up to 50 `allowedDomains` and 4 `allowedDomainSets`) "apply to browser sessions created with Puppeteer, Playwright, or CDP. They are unavailable for Quick Actions." — [Guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/)
- Outbound Workers (`outboundByHost`) route selected hostnames of a launched/acquired session through another Worker. — [Outbound Workers](https://developers.cloudflare.com/browser-run/features/outbound-workers/)
- [staging] `allowRequestPattern: ['^data:']` "does not block the document itself". — [linktocard/README.md](/home/user/My-Coding-Projects/linktocard/README.md)

### Inferences
- **Cost per render is negligible.** $0.09/hour = $0.000025 per browser-second. A 2 s screenshot costs about $0.00005 (about $0.05 per 1,000); a 0.5 s PDF about $0.0000125. The 10 included hours equal 36,000 browser-seconds, roughly 18,000 two-second screenshots or 30,000 to 150,000 PDFs at the staging timings. Because monthly time is rounded to the nearest hour, small usage may bill as zero.
- **Throughput, not price, is the cap.** 30 Quick Action requests/second per account is about 2.6 million/day in theory, shared by every tool on the account (PDF, screenshots, link previews, monitoring). A screenshot API, monitor and link checker on one account compete for that rate. Plan a per-account token bucket and Queues to smooth bursts, and use the request form for higher limits.
- **Quick Actions avoid the $2/browser concurrency charge**, so all candidate tools should use Quick Actions, not Puppeteer sessions, unless they need multi-step interaction.
- **`X-Browser-Ms-Used: 0` is unexplained.** Possible explanations (none confirmed): the binding path does not populate the header, very short HTML-only renders are recorded as 0, or binding calls are metered differently. Since the docs say Quick Actions are "charged for browser hours only" and give no binding exemption, budget as if binding calls are billed at their wall-clock length (what linktocard already does). Verify by running a fixed batch (for example 2,000 PDFs) on a quiet day and comparing the dashboard's "total browser hours" against measured wall time; also call `env.BROWSER.limits()` before and after to see whether it exposes usage.
- **Screenshot API / link preview fidelity is limited by bot blocking.** Browser Run is always flagged as a bot, cannot rotate IPs, and Kitesurf cannot pass bot challenges. Sites behind Cloudflare Bot Management, Akamai or similar will often return challenges. A product that promises "screenshot any site" will get support tickets; position it for the customer's own pages, public marketing pages and OG previews.
- **SSRF for URL-input tools must be handled in the Worker,** because Quick Actions have no guardrails and `allowRequestPattern` does not stop the top-level navigation. The Worker should resolve and validate the target host before calling the binding, and should re-check redirects (Browser Run follows them inside the browser, out of the Worker's sight).
- **`/crawl` with `render: false` is a free (during beta) way to build broken-link checking, site audits and change monitoring**, and it already obeys robots.txt and Content Signals, which lowers legal risk for monitoring/scraping tools. It is REST-only, so it needs an API token secret rather than the binding.

### Gaps
- No documentation explains `X-Browser-Ms-Used: 0` for binding quick actions, or whether binding calls bill identically to REST calls. Needs a dashboard comparison or a Cloudflare support/Discord answer.
- Whether Browser Run can reach private (RFC 1918), loopback, link-local (169.254.169.254) or `file://` targets is not documented. Needs a direct test on a throwaway account.
- The exact maximum `actionTimeout` (5 min per timeouts page vs 120,000 ms per API schema) is unresolved.
- Kitesurf per-account limits are not stated as numbers; "beta and free" may change.
- When `/crawl` leaves beta and what `render: false` will then cost (Workers pricing) is not stated.
- Maximum screenshot dimensions (very tall `fullPage` captures) and maximum response size for screenshots are not documented.

---

## 2. Cloudflare Workers limits and adjacent products (CPU, memory, subrequests, bundle, Cron, Queues, Durable Objects, R2, D1, Images, Workers AI)

### Takeaway
Workers Paid ($5/month) gives up to 5 minutes CPU per request (default 30 s) at $0.02 per million CPU-ms after 30 million included, but memory is 128 MB per isolate (shared by concurrent requests), outbound connections are capped at 6 simultaneous per request, and the bundle limit is now 64 MiB uncompressed. Storage is cheap (R2 $0.015/GB-month, free egress; D1 25 billion row reads included). Cloudflare Images costs $0.50 per 1,000 unique transformations after 5,000 free and now includes background removal (`segment=foreground`) at that same price; Workers AI is $0.011 per 1,000 Neurons with 10,000 free Neurons/day. Spend limits cover only Workers requests/CPU, not R2, D1, Images or Workers AI.

### Cited Findings

**Workers limits** — all from [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (page modified 2026-11-25)
- CPU time per HTTP request: Free 10 ms; Paid "5 min (default: 30 seconds)". CPU per Cron Trigger (Paid): 5 min (default 30 s) for intervals under 1 hour, 15 min for intervals of 1 hour or more.
- Memory: "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations. This limit is per-isolate, not per-invocation. A single isolate can handle many concurrent requests." Exceeding it gives Error 1102; buffering a too-large body gives `Memory limit would be exceeded before EOF`.
- Subrequests: Free 50/request; Paid 10,000/request (up to 10M). Subrequests to internal services: Free 1,000; Paid matches configured limit (default 10,000).
- Simultaneous outgoing connections per request: 6 (both plans).
- Worker size (uncompressed): 64 MiB on both plans; "There is no compressed size limit." Startup time: 1 second.
- Duration (wall clock): HTTP request no limit; Cron Trigger, Durable Object Alarm, Queue consumer 15 min.
- Cron Triggers per account: Free 5, Paid 1,000. Workers per account: Free 100, Paid 500.
- Request body max by zone plan: Free/Pro 100 MB, Business 200 MB, Enterprise up to 5 GB. URL 16 KB; request/response headers 128 KB total; response body no enforced limit.
- Static assets: Paid 100,000 files per version; 25 MiB per file.
- Workers TCP sockets (`connect()`): outbound sockets to Cloudflare IP ranges blocked; disallowed addresses include "Cloudflare IPs, `localhost`, and private network IPs"; port 25 prohibited; options `secureTransport` off/on/starttls. No method to read the peer TLS certificate is listed. — [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) (page modified 2026-11-19)
- Workers `fetch()` subrequests "can only be made to URLs, not to IP addresses directly". — [Workers known issues, via linktocard/research/cloudflare.md](/home/user/My-Coding-Projects/linktocard/research/cloudflare.md) (read from Cloudflare docs source 2026-11-21)

**Workers pricing** — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (page modified 2026-11-18)
- Standard (Paid, $5.00 subscription): requests "10 million included per month +$0.30 per additional million"; CPU "30 million CPU milliseconds included per month +$0.02 per additional million CPU milliseconds"; no charge for duration. Requests to static assets are $0 in the pricing examples.
- Workers Logs: Paid 20 million events/month included, +$0.60/million, 7-day retention.
- Workers KV (Paid): reads 10M/month + $0.50/M; writes 1M/month + $5.00/M; storage 1 GB + $0.50/GB-month.
- Workflows (Paid): steps 500,000 included/month + $0.80 per additional 100,000; storage 1 GB-month + $0.20/GB-month.

**Spending control**
- Workers spending limit: "covers requests and CPU time across all Workers in your account, after included usage. It excludes the monthly subscription fee." On hitting it, Cloudflare rejects new invocations (HTTP visitors get `1103`). "A spending limit is not an exact maximum bill. Usage reporting and blocking take time". — [Workers spend management](https://developers.cloudflare.com/workers/platform/spend-management/) (page modified 2026-11-13)
- The Workers limit "does not include Durable Objects, Workers AI, Workers KV, R2, or other products". — [linktocard/research/cloudflare.md, citing Cloudflare billing docs](/home/user/My-Coding-Projects/linktocard/research/cloudflare.md)

**Queues** — [Queues limits](https://developers.cloudflare.com/queues/platform/limits/); [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- Message size 128 KB; retries 100; consumer batch max 100 messages; `sendBatch` max 100 messages or 256 KB; per-queue throughput 5,000 messages/second; retention up to 14 days; backlog 25 GB per queue; 250 concurrent push consumers; consumer wall time 15 min; consumer CPU configurable to 5 min; `delaySeconds` up to 24 hours.
- Paid: 1,000,000 operations/month included + $0.40/million. "An operation is counted for each 64 KB of data that is written, read, or deleted"; operations are per message (a processed message = write + read + delete).

**Cron Triggers** — [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- Cron Triggers execute on UTC; standard cron syntax down to the minute field; changes "may take several minutes (up to 15 minutes) to propagate".

**Durable Objects** — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (page modified 2026-11-13)
- Paid: requests 1 million/month + $0.15/million (includes HTTP, RPC sessions, WebSocket messages, alarm invocations); duration 400,000 GB-s/month + $12.50/million GB-s. SQLite-backed storage: rows read 25 billion/month included + $0.001/million; rows written 50 million/month + $1.00/million; stored data 5 GB-month + $0.20/GB-month.

**R2** — [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (page modified 2026-10-30)
- Standard: $0.015/GB-month; Class A $4.50/million; Class B $0.36/million; egress free. Infrequent Access: $0.01/GB-month; Class A $9.00/M; Class B $0.90/M; retrieval $0.01/GB; 30-day minimum storage duration.
- Free tier (Standard only): 10 GB-month, 1 million Class A, 10 million Class B per month.

**D1** — [Workers pricing, D1 section](https://developers.cloudflare.com/workers/platform/pricing/); [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- Paid: rows read first 25 billion/month + $0.001/million; rows written first 50 million/month + $1.00/million; storage first 5 GB + $0.75/GB-month.
- Limits: max database 10 GB (Paid) / 500 MB (Free); 1 TB per account (Paid); max row/string/BLOB 2 MB; SQL statement 100 KB; 100 bound parameters per query; 100 columns per table; query duration 30 s; query result 50 MB; 1,000 queries per invocation (Paid); Time Travel 30 days (Paid).

**Cloudflare Images (alternative to in-Worker resizing)** — [Images pricing](https://developers.cloudflare.com/images/pricing/) (page modified 2026-10-19); [Limits and formats](https://developers.cloudflare.com/images/get-started/limits/) (page modified 2026-11-17); [Features](https://developers.cloudflare.com/images/optimization/features/); [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
- Images Free: up to 5,000 unique transformations/month; beyond that new transformations return error `9422` (no charge). Images Paid: first 5,000 included + $0.50 per 1,000 unique transformations/month; storage $5 per 100,000 images/month; delivery $1 per 100,000 images.
- Uniqueness: each source + parameter combination counts once per calendar month; `format` and `quality` are excluded from uniqueness; `.info()` calls are free. Calls to the Images binding are billed as unique transformations.
- Limits: remote image file 100 MB; area 100 MP; dimension 12,000 px (AVIF 1,200 px); Images binding `.input()` max 20 MB.
- Input formats: PNG, JPEG, GIF (animated), WebP (animated), SVG, AVIF (Enterprise only), HEIC, TIFF (first page). Output formats: PNG, JPEG, GIF, WebP, SVG, AVIF. "Cloudflare does not resize SVG files"; SVGs are sanitized with `svg-hush`.
- Parameters include `anim`, `background`, `blur`, `border`, `brightness`, `compression`, `contrast`, `dpr`, `draw` (overlays/watermarks), `fit`, `flip`, `format` (auto/avif/webp/jpeg/baseline-jpeg/json), `gamma`, `gravity`, `height`, `metadata`, `onerror`, `quality`, `rotate`, `saturation`, `segment`, `sharpen`, `trim`, `width`, `zoom`.
- `segment=foreground` "isolates the subject of an image by replacing the background with transparent pixels", uses BiRefNet via Workers AI, and is "billed as standard Images transformations... There is no additional charge from Workers AI or separate Neuron billing".
- Binding `.text(content, options)` rasterizes text with a custom font from a URL (TTF/OTF/WOFF/WOFF2, up to 20 MB); `.draw()` overlays images or text.

**Workers AI** — [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (page modified 2026-11-18); [Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
- "$0.011 per 1,000 Neurons"; 10,000 Neurons/day free on both plans; above that requires Workers Paid; limits reset 00:00 UTC.
- Vision-capable model by name: `@cf/meta/llama-3.2-11b-vision-instruct` at $0.049/M input tokens and $0.676/M output tokens. Other listed LLMs: `@cf/mistralai/mistral-small-3.1-24b-instruct` ($0.351/M in, $0.555/M out), `@cf/meta/llama-4-scout-17b-16e-instruct` ($0.270/M in, $0.850/M out), `@cf/google/gemma-3-12b-it` ($0.345/M in, $0.556/M out).
- Image classification `@cf/microsoft/resnet-50`: $2.51 per million images. Image generation: e.g. `@cf/black-forest-labs/flux-1-schnell` $0.0000528 per 512x512 tile + $0.0001056 per step.
- `toMarkdown` "is free for most format conversions"; image conversion "can use Workers AI models for object detection and summarization, which may incur additional costs".

### Inferences
- **In-Worker image work is CPU-cheap but memory-bound.** At $0.02 per million CPU-ms, a 300 ms resize/encode costs $0.000006, about 80x cheaper than an Images transformation ($0.0005). But a decoded RGBA bitmap takes width x height x 4 bytes (a 4000x3000 photo is 48 MB), and the 128 MB limit is per isolate shared across concurrent requests, so large uploads (above roughly 10 to 12 MP) should go to the Images binding (up to 20 MB input, 100 MP) rather than WASM codecs.
- **Social image resizer / format converter:** the Images binding is the low-effort path (crop, fit, gravity, format, watermark via `draw`, background removal via `segment`), at $0.50 per 1,000 unique outputs. A resizer producing 10 platform sizes per upload costs about $0.005 per upload in Images fees, which sets a floor for free-tier generosity. Images does not output ICO, so a favicon tool must still assemble ICO bytes itself.
- **Background removal is newly cheap** ($0.0005 per unique image via `segment`, no Neurons). That makes a "remove background" or "product shot on brand background" tool feasible without GPU contracts, but it is generative-AI-adjacent for Paddle (see section 4).
- **Monitoring tools (uptime/SSL, change monitoring, broken links) fit Cron + Queues.** One per-minute Cron can enqueue checks; each queued check costs 3 Queue operations ($1.20 per million checks beyond 1M ops/month) plus a Worker request ($0.30/M) and CPU. One URL checked every minute is 43,200 checks/month, about $0.05/month in Queue ops if each check is its own message, less if batched. The 6-simultaneous-connections cap per invocation means fan-out must be spread across many consumer invocations.
- **SSL-expiry monitoring has no documented native path.** Neither `fetch()` nor `connect()` exposes the peer certificate, and in TLS 1.3 the certificate is sent encrypted, so it cannot be read from a raw socket without implementing the handshake. Options: Certificate Transparency log queries (third-party dependency) or treating TLS errors from `fetch()` as the signal. This is a feasibility risk for an "SSL monitor".
- **Uptime monitoring from Workers cannot target bare IPs, private hosts or port 25**, and the checking location is not chosen by the developer. "Multi-region checks" are not a documented Workers feature.
- **Hard caps exist only for Workers requests/CPU.** Any tool that leans on R2, D1 writes, Images or Workers AI needs app-level quotas (linktocard already uses a D1-based quota/ledger pattern).
- **Bundle size is no longer a blocker** for heavy WASM (64 MiB uncompressed), but the 1 s startup limit still punishes very large modules; lazy-load per-tool WASM and split heavy tools into separate Workers via service bindings.

### Gaps
- Token counts for an image input to `llama-3.2-11b-vision-instruct` (needed to price alt-text generation per image) were not found on the pricing page.
- No Workers AI upscaling or OCR-specific model appears on the pricing page; whether `toMarkdown` on an image performs real OCR (vs captioning) was not verified.
- Whether the other listed LLMs accept image input was not verified from model pages.
- Whether Images transformations on the Images Free plan are usable commercially at scale (5,000 cap) vs needing the Paid plan subscription price (if any base fee) was not stated beyond the per-transformation rate.
- Cron Trigger execution location and jitter were not researched.

---

## 3. JS/WASM libraries that run in Workers for these tasks

### Takeaway
PDF merge/split/forms/watermark is well covered by pdf-lib (MIT) or its maintained forks (`@cantoo/pdf-lib` adds encryption and SVG drawing). Real PDF compression has no mature MIT/Apache pure-JS option (qpdf-wasm is ISC but browser-oriented; MuPDF and Ghostscript WASM are AGPL). QR codes (uqr, lean-qr, qrcode-generator), image codecs (jSquash, Photon via `@cf-wasm/photon`), and SVG rasterization (resvg/Satori, already in production at linktocard) are available under permissive licenses. Favicon ICO encoding has no clearly Workers-native library; it is simple enough to write by hand. Native `sharp` is not an option in Workers.

### Cited Findings

All version, license, publish-date and size data from `npm view` on 2026-11-26 (registry: https://registry.npmjs.org).

**PDF**
- `pdf-lib@1.17.1`, MIT, published 2021-11-06 (no release since), unpacked 19.5 MB; deps `@pdf-lib/standard-fonts`, `@pdf-lib/upng`, `pako`, `tslib`. — [npm: pdf-lib](https://www.npmjs.com/package/pdf-lib)
- pdf-lib README: "Designed to work in any modern JavaScript runtime. Tested in Node, Browser, Deno, and React Native environments." Features: create/modify PDFs, create/fill/flatten forms, add/insert/remove pages, copy pages between PDFs, draw text/images/PDF pages/vector graphics/SVG paths, embed fonts (UTF-8/UTF-16), metadata, attachments. Limitations: cannot extract or edit page text outside form fields; no HTML/CSS. "`pdf-lib` does not currently support encrypted documents"; `ignoreEncryption: true` "does not decrypt the document". — [pdf-lib README on npm](https://www.npmjs.com/package/pdf-lib)
- `@cantoo/pdf-lib@2.11.1`, MIT, published 2026-09-15: "an actively maintained fork of Hopding/pdf-lib" adding full SVG drawing (`drawSvg`/`embedSvg`), `PDFPage.extractContents()`, and `PDFDocument.encrypt()` (AES-256 rev 6 by default). Unpacked 26.3 MB. — [npm: @cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib)
- `@pdfme/pdf-lib@6.2.8`, MIT, published 2026-10-21, unpacked 2.2 MB (another maintained fork). — [npm: @pdfme/pdf-lib](https://www.npmjs.com/package/@pdfme/pdf-lib)
- `@pdf-lib/fontkit@1.1.1`, MIT, published 2020-11-28 (needed for custom font embedding with pdf-lib). — [npm: @pdf-lib/fontkit](https://www.npmjs.com/package/@pdf-lib/fontkit)
- `pdfjs-dist@6.5.438`, Apache-2.0, published 2026-11-01, unpacked 37.6 MB. — [npm: pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist)
- `mupdf@1.28.6`, **AGPL-3.0-or-later**, published 2026-11-09, unpacked 14.3 MB. — [npm: mupdf](https://www.npmjs.com/package/mupdf)
- `@neslinesli93/qpdf-wasm@0.3.1`, ISC, published 2026-11-03, unpacked 1.4 MB; README: "QPDF compiled to WASM, ready for the browser", used through an Emscripten virtual file system. — [npm: @neslinesli93/qpdf-wasm](https://www.npmjs.com/package/@neslinesli93/qpdf-wasm)
- `@jspawn/ghostscript-wasm@0.0.2`, **AGPL-3.0**, published 2022. — [npm: @jspawn/ghostscript-wasm](https://www.npmjs.com/package/@jspawn/ghostscript-wasm)

**QR codes**
- `uqr@0.1.3`, MIT, published 2026-04-03, no dependencies, 79 KB. — [npm: uqr](https://www.npmjs.com/package/uqr)
- `lean-qr@2.7.4`, MIT, published 2026-09-07, no dependencies, 69 KB. — [npm: lean-qr](https://www.npmjs.com/package/lean-qr)
- `qrcode-generator@2.0.4`, MIT. — [npm: qrcode-generator](https://www.npmjs.com/package/qrcode-generator)
- `qrcode@1.5.4`, MIT, published 2024-08-05; depends on `pngjs`, `yargs`, `dijkstrajs`. — [npm: qrcode](https://www.npmjs.com/package/qrcode)
- `qr-code-styling@1.9.2`, MIT, published 2025-04-11 ("Add a style and an image to your QR code"). — [npm: qr-code-styling](https://www.npmjs.com/package/qr-code-styling)

**Image codecs and processing**
- jSquash (Squoosh codecs repackaged), Apache-2.0: `@jsquash/jpeg@1.6.0` (2025-05-12, 531 KB), `@jsquash/png@3.1.1`, `@jsquash/webp@1.5.0` (2025-05-12, 915 KB), `@jsquash/avif@2.1.1` (2025-05-20, 8.4 MB), `@jsquash/resize@2.1.1` (2026-01-05), `@jsquash/oxipng@2.3.0` (2024-06-18), `@jsquash/qoi@1.1.0`. — [npm: @jsquash/webp](https://www.npmjs.com/package/@jsquash/webp) and sibling packages
- `@cf-wasm/photon@0.4.0`, Apache-2.0, published 2026-08-01, 6.3 MB: "High-performance Rust image processing library (Photon) for Cloudflare workers, Next.js and Node.js"; ships a `workerd` export; README warns "Cloudflare Workers have strict memory caps (typically `128MB`)... validate input image size or reject oversized images before processing." — [npm: @cf-wasm/photon](https://www.npmjs.com/package/@cf-wasm/photon)
- `@cf-wasm/resvg@0.4.0` (MPL-2.0, wraps `@resvg/resvg-wasm@2.6.2`), `@cf-wasm/og@0.5.0` (MIT), `satori@0.63.2` (MPL-2.0, published 2026-10-20). — [npm: satori](https://www.npmjs.com/package/satori); [npm: @cf-wasm/resvg](https://www.npmjs.com/package/@cf-wasm/resvg)
- linktocard already renders card images with Satori + resvg-wasm inside a Worker. — [linktocard README](/home/user/My-Coding-Projects/linktocard/README.md)
- `wasm-vips@0.0.19`, MIT, 13 MB; `@imagemagick/magick-wasm@0.0.46`, Apache-2.0, published 2026-11-03, 32.5 MB unpacked. — [npm: wasm-vips](https://www.npmjs.com/package/wasm-vips); [npm: @imagemagick/magick-wasm](https://www.npmjs.com/package/@imagemagick/magick-wasm)

**ICO / GIF**
- `png-to-ico@3.0.2`, MIT, published 2026-07-06; depends on `pngjs`, `minimist`, `@types/node` (Node/CLI oriented). `icojs@1.0.1`, MIT, published 2026-08-22; deps include `decode-ico`, `pngjs`, `jpeg-js`, `file-type`. — [npm: png-to-ico](https://www.npmjs.com/package/png-to-ico); [npm: icojs](https://www.npmjs.com/package/icojs)
- GIF encoders: `gifenc@1.0.3` ("very fast JS GIF encoder", MIT, 2021-03-07) and `omggif@1.0.10` (GIF89a encoder/decoder, MIT, 2019-07-16). — [npm: gifenc](https://www.npmjs.com/package/gifenc); [npm: omggif](https://www.npmjs.com/package/omggif)

### Inferences
- **PDF merge/split/rotate/watermark/form-fill** is a pure-CPU Worker job with pdf-lib or a fork; no Browser Run time needed. Prefer `@cantoo/pdf-lib` or `@pdfme/pdf-lib` over the unmaintained original; `@cantoo/pdf-lib` is the only one shown here that can encrypt (password-protect) output. None of them decrypt protected inputs, so the tool must reject encrypted uploads.
- **"Compress PDF" is the weak spot.** pdf-lib can re-save with object streams but cannot downsample images; meaningful compression means decoding each embedded image and re-encoding it (jSquash) inside 128 MB, or using qpdf-wasm (structural only, Workers compatibility untested). MuPDF and Ghostscript WASM would do it properly but are AGPL, which would oblige releasing linktocard's source for a network service. Treat compress as "light" or skip it.
- **QR generator is the cheapest candidate technically**: zero-dependency, MIT SVG/matrix output (uqr, lean-qr) rendered to PNG via existing resvg. Styling/logo overlays can reuse Satori. `qr-code-styling` and `qrcode`'s PNG path assume DOM/canvas or Node `pngjs`, so they are poorer fits.
- **Favicon generator**: resize with jSquash/Photon or the Images binding, then write the ICO container by hand (a 6-byte header, 16-byte directory entries, PNG payloads); existing ICO packages are Node/CLI oriented.
- **Dynamic email images (countdown GIFs)**: GIF encoders exist but are old; per-open rendering of a 60-frame GIF is CPU-heavy, so cache per minute per timer (Workers Cache / R2).
- **`sharp` cannot be used** (native libvips binary, no native modules in Workers); wasm-vips and magick-wasm fit under 64 MiB but their 13 to 32 MB size risks the 1 s startup limit.

### Gaps
- None of these libraries was actually built and run in workerd for this note; Workers compatibility is confirmed only for `@cf-wasm/*` (by its README) and Satori/resvg (by linktocard's own production use).
- Actual bundled (minified) sizes, as opposed to npm unpacked sizes, were not measured.
- No pure-JS PDF digital-signature (PKCS#7/PAdES) library was checked for Workers compatibility (relevant to e-signature).
- `icojs` encode support and `qpdf-wasm` behaviour under workerd (no file system) were not verified.

---

## 4. Paddle: acceptable use, fees, payouts to Lebanon, usage-based billing

### Takeaway
Paddle charges 5% + $0.50 per checkout transaction, pays out monthly by wire or Payoneer (with a $15 SWIFT fee per international wire and a $100 minimum), and does not list Lebanon among excluded seller countries (support is by absence, not confirmation). None of the candidate tools appears on Paddle's prohibited list in any excerpt found, but several sit next to restricted or prohibited categories: VPN/proxy (restricted), captcha solving (prohibited), "unauthorized access to another party's data", "automated social media marketing", "mass marketing", fraudulent/deceptive products, and AI content generation of human likeness. Native usage-based billing is early-access only, never blocks or bills overage during beta, and has no top-ups, so metered extras still need one-time charges.

### Cited Findings

**Fees**
- Pricing page: pay-as-you-go **5% + 50¢ per checkout transaction**, no monthly fee, custom pricing for high-volume. [search excerpt, 2026-11-26] — [Paddle pricing](https://www.paddle.com/pricing); [Paddle get-billing](https://www.paddle.com/get-billing)
- MSA: Paddle Checkout fee "5% of SRP plus $0.50"; invoiced bank-transfer payments 3.5% of SRP; Checkout Recovery add-on 10% of recovered checkouts; MSA change log effective 6 October 2026 surfaced no rate change. [search excerpt via in-repo research 2026-11-21] — [Paddle MSA](https://www.paddle.com/legal/terms); [linktocard/research/paddle-compliance.md](/home/user/My-Coding-Projects/linktocard/research/paddle-compliance.md)
- Chargebacks "incur a fee of 20 USD/GBP/EUR or 40 CAD/AUD" and the fee is not refunded even if the dispute is won. [search excerpt] — [Paddle chargebacks help](https://www.paddle.com/help/manage/risk-prevention/understanding-chargebacks-with-paddle)
- A third-party site claims an extra 1.5% on non-US transactions; other sources do not mention it. [unverified] — [Rework: Paddle alternatives](https://resources.rework.com/tools/billing-revenue/best-paddle-alternatives)

**Payouts and Lebanon** (all [search excerpt], summarised in the in-repo research)
- Payout methods: "wire transfer or Payoneer"; monthly schedule, initiated on the 1st and sent by the 15th; minimum $100 (adjustable to $100,000); $15 SWIFT wire fee when payout currency is not local to the bank's country; up to 1.5% conversion margin if payout currency differs from balance currency; no LBP payout currency. — [When and how do I get paid?](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid); [Payout fees](https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts); [Local currency payouts](https://www.paddle.com/help/manage/get-paid/can-i-be-paid-in-my-local-currency)
- Unsupported seller countries list (sanctions) as surfaced: Afghanistan, Antarctica, Belarus, Burma, CAR, Cuba, DRC, Haiti, Iran, Iraq, Libya, Mali, Netherlands Antilles, Nicaragua, North Korea, Russia, Somalia, South Sudan, Sudan, Syria, Venezuela, Yemen, Zimbabwe, and occupied Ukrainian regions; Lebanon is not in it. — [Which countries are supported by Paddle?](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle)
- Individuals/sole traders skip business verification but must pass identity verification (Sumsub: ID, proof of address, possibly liveness). — [Identity verification](https://www.paddle.com/help/start/account-verification/what-is-identity-verification)
- Lebanon was added to the FATF grey list in October 2024 (status in late 2026 not confirmed). — [Al Jazeera, 2024-10-25](https://www.aljazeera.com/news/2024/10/25/lebanon-added-to-money-laundering-grey-list)

**Acceptable Use Policy (AUP)** — [Paddle AUP help page](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle) ("Last Updated" 13 April 2026 per excerpt). Full text could not be read; items below are from search excerpts (2026-11-21 and 2026-11-26).
- VPN and proxy services: **restricted**. Captcha solving: **prohibited**. Device cleaners/antivirus/"repair" software: prohibited. Technical support services for repairing devices: restricted. [search excerpt 2026-11-26]
- Prohibited: products enabling "unauthorized access to data belonging to another party" (spyware, keyloggers); IP infringement ("Any product or service that infringes upon, or enables the infringement upon copyrights, trademarks, terms and conditions, or trade secrets"); marketing services incl. mass marketing, telemarketing, "automated social media marketing" and engagement boosting; anything that "Involves fraudulent, deceptive, unfair, abusive, or predatory practices"; digital marketplaces for non-Paddle sellers; human services not tied to software. [search excerpts via in-repo research]
- "Content generation" (AI): human-like faces in realistic, stylized or animated form are a **Restricted Category**; face swaps, deepfakes, voice impersonation and likeness use without consent are prohibited. Paddle blog: "it's not to say we won't work with software that allows image generation". [search excerpts via in-repo research] — [Paddle blog: buy and sell safely](https://www.paddle.com/blog/how-paddle-helps-you-buy-and-sell-safely-online)
- "Many of these categories are imposed by Card Network rules or by our payment processors"; the list "is not an exhaustive list". [search excerpts]
- No Paddle source in any search mentioned web scraping, screenshots, website monitoring, QR codes, document generation or e-signatures specifically. The closest is the Retain and Metrics AUP banning email to addresses obtained "through scraping or harvesting" (applies to those Paddle products, not to sellers' products). — [Retain and Metrics AUP](https://www.paddle.com/legal/retain-and-metrics-acceptable-use-policy); [WebSearch 2026-11-26](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)
- The MSA lets Paddle decide "in its sole discretion" that a product falls outside the AUP. [search excerpt via in-repo research] — [Paddle MSA](https://www.paddle.com/legal/terms)

**Usage-based billing** (directly read: Paddle's official agent skill)
- "Usage-based billing is in early access (beta). Only accounts in the early access program can use it, and fields and behavior may change before general release. Accounts apply at Set up usage-based billing." — [PaddleHQ/paddle-agent-skills: usage-based-billing SKILL.md](https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/usage-based-billing/SKILL.md) (read 2026-11-26)
- "Paddle never blocks usage during early access (beta). When a balance runs out, Paddle keeps recording usage as overage and doesn't bill for it." At renewal unused usage expires and the full allowance is granted again; it does not roll over. — [same SKILL.md](https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/usage-based-billing/SKILL.md)
- Allowances "need a recurring price without a trial"; usage subscriptions "must be collected automatically. Manually-collected (invoiced) ones are rejected"; "Each event is its own request during early access (beta)", so aggregate usage per customer per short window; only `sum` aggregation. — [same SKILL.md](https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/usage-based-billing/SKILL.md)
- Developer docs (search excerpt): top-ups are not available during beta; prorated billing modes error for allowance subscriptions. A Paddle blog post on its AI Toolkit says native usage-based billing "enters private preview in early 2027" with a waitlist, which conflicts with the docs describing an existing early-access program. — [Set up usage-based billing](https://developer.paddle.com/build/usage-based-billing/); [Paddle AI Toolkit announcement](https://www.paddle.com/blog/paddle-launches-ai-toolkit-bringing-global-selling-into-ai-workflows)
- One-time charges (prices with `billing_cycle: null`) can be billed immediately or added to the next renewal, and are the documented route for metered extras outside the beta. [search excerpt] — [Bill a one-time charge](https://developer.paddle.com/build/subscriptions/bill-add-one-time-charge)
- Third-party caveat: if a subscription is scheduled to cancel at period end, Paddle discards one-time charges attached to the next billing period. [third party] — [Phare blog on Paddle metered billing](https://phare.io/blog/what-paddle-doesnt-tell-you-about-implementing-metered-billing/)

### Inferences
- **Fee impact by price point:** a $5 one-off top-up loses $0.75 (15%) to Paddle; $9 loses $0.95 (10.6%); $19 loses $1.45 (7.6%); $49 loses $2.95 (6.0%). Cheap one-off tools (a $2 favicon pack, a $3 QR export) are uneconomic as single Paddle transactions; bundle them into subscriptions or credit packs of $10 or more.
- **Usage pricing should stay app-side:** keep linktocard's model (quota in D1, prepaid top-ups as one-time Paddle transactions). Paddle UBB in beta neither bills overage nor blocks usage, so it adds nothing for enforcement.
- **AUP fit per candidate (inference, not Paddle statements):**
  - Low risk: QR generator, favicon generator, social image resizer, HTML/Markdown-to-image, email signature generator, PDF merge/split/compress/watermark/form-fill, link preview/metadata API, broken link checker, uptime/SSL monitor (plain SaaS/developer tools).
  - Medium, wording-dependent: website screenshot API and change monitoring (must not be marketed as scraping other people's data, evading bot protection, or proxying; never mention captcha solving or "bypass Cloudflare"); dynamic email images (sell as an image tool, not as a mass-email or marketing service); background removal / AI alt text (AI image processing, not face/likeness generation, but expect enhanced due diligence questions).
  - Higher: e-signature (not on any excerpt list, but legal-effect claims and identity verification create consumer-protection and fraud exposure; Paddle may ask questions); anything that produces receipts/invoices for arbitrary brands (falls under "fraudulent, deceptive" practices if misused).
- **Payout friction in Lebanon** is a business-wide risk, not tool-specific: set a high payout threshold to dilute the $15 wire fee, and confirm in writing with Paddle support before scaling.

### Gaps
- Full verbatim AUP text (and the MSA-referenced `paddle.com/support/aup`) could not be read; no Paddle statement found on screenshots, scraping, monitoring, QR codes, e-signatures or document generation.
- Live text of paddle.com/pricing not read directly; the 1.5% non-US surcharge claim is unverified.
- No first-hand confirmation that Paddle onboards Lebanese individuals and that wires or Payoneer payouts reach Lebanon.
- Whether Paddle UBB early access is open now or only from "early 2027" is contradictory between Paddle sources.

---

## 5. Legal and abuse risks (quishing, arbitrary-URL screenshots, monitoring/scraping and robots.txt, e-signatures, fake receipts/invoices, GDPR)

### Takeaway
The biggest abuse risks are dynamic QR redirects (a documented phishing vector), URL-fetching tools (SSRF and content liability), and document generators that can forge receipts or invoices. E-signatures are legally usable as "simple electronic signatures" in the EU and under ESIGN in the US, but only with consent, intent and record retention handled properly. Monitoring tools can lawfully check public pages, but robots.txt is not access control, and screenshots that capture personal data make linktocard a GDPR processor that needs a DPA. Most of these sources were reachable only as search excerpts; treat them as pointers, not legal advice.

### Cited Findings

**QR phishing (quishing)**
- Unit 42 reports "an average of over 11,000 detections of malicious QR codes each day"; QR code shorteners "convert a static image into a dynamic endpoint" so the attacker can change the redirect at will; one shortener, qrs[.]ly, appeared in 7.3% of malicious URLs observed. [search excerpt; page not fetchable] — [Unit 42: QR codes as attack vector](https://unit42.paloaltonetworks.com/qr-codes-as-attack-vector/)
- ESET H1 2026: malicious QR codes in "no fewer than 11 percent of all phishing emails" in the first half of 2026. [search excerpt] — [ESET / WeLiveSecurity on QR phishing](https://www.welivesecurity.com/en/business-security/qr-code-phishing-slip-past-corporate-security-measures/)
- A vendor press release claims quishing "surges 146% in Q1 2026". [vendor marketing] — [National Law Review press release](https://natlawreview.com/press-releases/quishing-surges-146-q1-2026-attackers-hide-behind-code)
- A takedown firm describes taking down a dynamic QR redirector to a phishing page within hours. [vendor] — [CybelAngel](https://cybelangel.com/ar/مدونة/how-we-took-down-a-qr-code-scam-in-24-hours/)

**Arbitrary-URL screenshots: SSRF and content**
- CVE-2026-44439 (PlaywrightCapture): an attacker page used browser-side redirects (`window.location.href`, meta refresh) to make the capture browser open `file://` URLs or private/loopback/link-local addresses, leaking content via screenshots/logs (CWE-918). [search excerpt] — [SentinelOne CVE-2026-44439](https://www.sentinelone.com/vulnerability-database/cve-2026-44439/); [CodeAnt CVE-2026-44439](https://codeant.ai/vulnerability-database/cve-2026-44439)
- Rendertron's screenshot endpoint could screenshot an iframe of the cloud metadata endpoint even when direct requests were blocked (patched in 3.1.0). [search excerpt] — [Semgrep: exploiting dynamic rendering engines](https://semgrep.dev/blog/2020/exploiting-dynamic-rendering-engines-to-take-control-of-web-apps)
- Cloudflare: Quick Actions have no hostname guardrails; Workers sockets block localhost/private/Cloudflare IPs; Workers `fetch()` cannot target bare IPs. — [Guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/); [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- Paddle AUP prohibits products that infringe "or enable the infringement upon copyrights, trademarks, terms and conditions". [search excerpt] — [Paddle AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)

**Monitoring, scraping and robots.txt**
- RFC 9309: the Robots Exclusion Protocol rules "are not a form of access authorization". [search excerpt] — [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)
- Cloudflare: "robots.txt is advisory, not enforceable". — [Browser Run robots.txt reference](https://developers.cloudflare.com/browser-run/reference/robots-txt/)
- Meta v. Bright Data (N.D. Cal., Jan 2024): Meta's terms "do not apply to and prohibit Bright Data's scraping of publicly available data while logged off"; the ruling is narrow (Meta's terms only; says nothing on logged-in scraping); Meta later dropped the case. [search excerpts] — [TechCrunch 2024-01-24](https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued); [Farella Braun + Martel analysis](https://www.fbm.com/alex-reese/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/); [Quinn Emanuel client alert](https://www.quinnemanuel.com/the-firm/news-events/client-alert-what-does-the-meta-v-bright-data-summary-judgment-ruling-mean-for-web-scraping/)
- After hiQ v. LinkedIn, scraping public data is generally not "unauthorized" access under the CFAA, but rulings are "narrow and fact-specific" and anti-bot circumvention is "the unsettled frontier, potentially actionable under DMCA 1201". [search excerpt] — [Eric Goldman blog guest post, 2023](https://blog.ericgoldman.org/archives/2023/03/after-hiq-labs-is-scraping-public-data-legal-guest-blog-post.htm)
- Browser Run `/crawl` enforces robots.txt and Content Signals by default. — [/crawl](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)

**E-signatures**
- eIDAS Article 25(1): an electronic signature cannot be denied legal effect and admissibility as evidence solely because it is electronic or does not meet qualified-signature requirements; a qualified electronic signature has the equivalent legal effect of a handwritten signature. [search excerpt; EUR-Lex not fetchable] — [eIDAS Art. 25 (legislation.gov.uk copy)](https://legislation.gov.uk/eur/2014/910/article/25/2014-07-23?view=plain); [Adobe: EU e-signature law](https://helpx.adobe.com/legal/esignatures/regulations/european-union.html)
- US ESIGN Act: no signature, contract or record "shall be denied legal effect... solely because it is in electronic form"; consumer transactions require affirmative electronic consent after disclosures; records must remain accessible and retainable, and a record whose printing/storage is deliberately inhibited does not satisfy legal requirements. [search excerpt; law.cornell.edu not fetchable] — [DocuSign: ESIGN and UETA](https://docusign.com/products/electronic-signature/learn/esign-act-ueta); [Baker McKenzie: e-signature laws (2021)](https://www.bakermckenzie.com/-/media/files/people/lothar-determann/esignature-laws-hlj-2021.pdf)
- Vendor framing: eIDAS emphasises signer identity; ESIGN/UETA emphasise intent, consent and retention. [vendor blog] — [signNow: eIDAS vs ESIGN](https://www.signnow.com/blog/how-eidas-differs-from-esign-act/)

**Fake receipts / invoices**
- Group-IB documents commercial "receipt generator" services (e.g. MaisonReceipts, a subscription generator for over 21 brands, with a Discord community over 30,000 members) used for fraud. [search excerpt] — [Group-IB: fake receipt generators](https://www.group-ib.com/blog/fake-receipts-generators/); [Infosecurity Magazine](https://www.infosecurity-magazine.com/news/fake-receipt-generators-fuel/)
- A lawyer quoted on a site selling fake bank statements/tax returns said that where a document's clear purpose is fraud, the seller could face criminal charges. [search excerpt] — [Insurance Journal, 2022-04-06](https://www.insurancejournal.com/news/national/2022/04/06/661503.htm)
- linktocard's PDF starter templates already exclude bank statements, utility bills, identity documents, diplomas and government documents, and its terms forbid counterfeit documents. — [linktocard README](/home/user/My-Coding-Projects/linktocard/README.md)

**GDPR for monitoring/screenshot tools**
- The EDPS Website Evidence Collector notes that running a screenshot tool on pages with personal data means the tool "will download, display, and store these personal data in the form of text files and screenshots, and you will therefore process personal data". [search excerpt] — [EDPS: Website Evidence Collector introduction](https://www.edps.europa.eu/system/files/2025-08/introduction_to_website_evidence_collector_wec_online_en.pdf)
- EDPB legitimate-interest guidelines (v2 PDF dated 2026-11 in the URL) frame Art. 6(1)(f) as a three-part test (legitimate interest, necessity, balancing). [search excerpt] — [EDPB Guidelines 1/2024 on legitimate interest v2](https://www.edpb.europa.eu/system/files/2026-11/edpb_guidelines_202401_legitimateinterest_v2_en.pdf)
- An EDPB document with "webscraping" in its file name appears dated 2026-07; not opened. — [EDPB file](https://www.edpb.europa.eu/system/files/2026-07/edpb_guidelines_2020603_webscraping_v1_en_0.pdf)
- Vendor guidance: organisations running website monitoring are usually controllers of the monitoring data; a vendor acting on instructions needs an Art. 28 DPA. [vendor blog] — [Odown: GDPR-compliant website monitoring](https://odown.com/blog/gdpr-compliant-website-monitoring/)
- Browser Run itself does not retain submitted HTML or outputs beyond the operation (except crawl results 14 days, recordings 30 days). — [Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)

**Dynamic email images (feasibility caveat)**
- Vendors report that Gmail proxies and may cache images (timers can lag up to about a minute), that classic Outlook desktop shows only the first GIF frame, and that Apple Mail caching cannot be prevented. [vendor sources] — [DynaPictures: Gmail countdown](https://dynapictures.com/data/solutions/email-countdown-timer/gmail-email); [Klaviyo: countdown timers](https://www.klaviyo.com/blog/countdown); [Sendtric help](https://www.sendtric.com/help/my-countdown-timer-is-not-showing-correctly-on-apple-mail/); [Campaign Monitor](https://www.campaignmonitor.com/blog/post/3998/how-to-add-a-countdown-timer-to-your-email-campaig)

### Inferences
- **QR generator:** static QR codes (encoding the customer's URL directly, no redirect through linktocard) carry far less abuse risk than dynamic QR codes. Dynamic/trackable QR codes make linktocard a redirector, the exact component used in quishing, and would need URL reputation checks (for example Google Safe Browsing or Cloudflare's own intel), destination-change logging, abuse reporting and fast takedown. Recommendation: launch static-only.
- **Screenshot / link preview / monitoring APIs:** validate scheme (http/https only), resolve DNS and refuse private, loopback, link-local and Cloudflare ranges before calling Browser Run, re-check the final URL reported by the browser, block `file:`/`data:` navigation, cap redirects, and keep a takedown/abuse address. Customer terms should make the customer responsible for having rights to capture the target page.
- **Monitoring and link checking:** obey robots.txt by default (cheap goodwill even though not legally binding), send an identifying User-Agent, rate-limit per target host, and never offer bot-protection bypass (also a Paddle AUP trap via "captcha solving").
- **GDPR:** uptime/SSL checks that store only status codes and timings involve little personal data; visual change monitoring stores screenshots that may contain personal data, so offer a DPA, short retention defaults (R2 lifecycle rules), and an EU-facing privacy notice.
- **E-signature:** a "simple electronic signature" product is legal in principle, but to be defensible it needs explicit consent to sign electronically, signer identification (at least email verification), an audit trail (timestamps, IPs, document hash), tamper evidence on the final PDF, and downloadable copies for all parties. Qualified signatures (QES) require a qualified trust service provider and are out of reach for a solo developer. This is the highest-effort, highest-liability candidate.
- **Receipts/invoices:** keep generators tied to the customer's own business identity (no third-party brand templates, no "replica receipt" marketing), keep the exclusion list, and watermark Free-plan output (already done for PDFs).
- **Email countdown images:** feasible on Workers, but deliver accuracy caveats (first-frame design for Outlook, minute-level caching) rather than promising real-time accuracy.

### Gaps
- Primary legal texts (EUR-Lex eIDAS as amended by Regulation (EU) 2024/1183, 15 U.S.C. 7001 and the ESIGN exclusions in 7003, RFC 9309 full text, EU DSM Directive Art. 4 TDM opt-out) could not be opened from this session; only search excerpts were seen.
- No source was found on copyright liability specific to screenshot APIs or on whether a disclaimer protects receipt-generator operators.
- No QR-generator vendor's published abuse/takedown policy was found.
- Lebanese law on e-signatures, data protection and online document services was not researched.
- Cloudflare's own service terms on abusive use of Browser Run (illegal content captured through it) were not researched.

### Consolidated per-candidate platform map (inference from sections 1 to 5)

| Candidate | Engine | Main platform constraint | Main policy/legal risk |
| --- | --- | --- | --- |
| Website screenshot API | Browser Run `/screenshot` (Quick Action) | 30 req/s per account; bot blocking; 60 s load cap | SSRF; capturing infringing/illegal content; Paddle wording (no "bypass") |
| Link preview / metadata API | Worker `fetch` + HTMLRewriter; Browser Run `/content`/`/scrape` for JS pages | 6 connections/request; bot blocking | SSRF; low otherwise |
| QR code generator | uqr/lean-qr + resvg (CPU only) | none material | Quishing if dynamic redirects are offered |
| Favicon generator | jSquash/Photon or Images binding + hand-written ICO | 128 MB isolate memory | low |
| Social image resizer | Images binding (or jSquash/Photon for small inputs) | $0.50 per 1,000 unique transforms after 5,000 | low; avoid "social media automation" wording |
| PDF merge/split/watermark/form-fill | pdf-lib fork (CPU only) | 128 MB memory for large PDFs; no decryption | low |
| PDF compress | pdf-lib + jSquash, or qpdf-wasm (untested) | weak compression without AGPL tools | AGPL licence if MuPDF/Ghostscript used |
| HTML/Markdown to image | Satori+resvg (existing) or Browser Run screenshot with `html` | CPU per render; browser time | low |
| Email signature generator | Satori/resvg images + HTML output | none material | low |
| Website change monitoring | Cron + Queues + Worker fetch or Browser Run `/snapshot`; `/crawl` | Quick Action rate shared across tools | GDPR (screenshots), scraping optics |
| Uptime / SSL monitoring | Cron + Queues + Worker fetch | no API to read TLS certificate details; no region choice | low |
| Broken link checker | Browser Run `/links` or `/crawl` (`render:false` free in beta) + Worker HEAD checks | 6 connections/request; crawl REST-only | low (robots respected by `/crawl`) |
| Dynamic email images | Worker-rendered PNG/GIF (gifenc/omggif), cached per minute | per-open CPU for GIFs | Paddle "mass marketing" wording; client caching limits accuracy |
| E-signature | pdf-lib + audit trail; no verified PKCS#7 library | signature cryptography in Workers unverified | ESIGN/eIDAS compliance, fraud, support load |
