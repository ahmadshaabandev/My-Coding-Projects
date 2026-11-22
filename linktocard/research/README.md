# Research notes

Working notes gathered on 2026-11-21 while building Link To Card. They were written by
AI research agents (Claude) and are kept because the code, docs and legal pages rely on them.

Read them as notes, not as verified documentation:

- Each report tags what was read from a primary source (npm packages, GitHub repositories,
  Cloudflare's docs source) and what came only from search-engine summaries.
- Vendor websites (paddle.com, developer.paddle.com, bannerbear.com, vercel.com) could not be
  opened from the build environment. Anything quoted from those sites needs a human spot-check.
- Each report ends with an "Unverified" list. Nothing was deployed to Cloudflare and no Paddle
  account was used.

| File | What it covers |
| --- | --- |
| spike-render.md | Satori + resvg-wasm + jSquash inside workerd: what works, the shim, timings, limits |
| spike-platform.md | Static assets routing, D1, R2, rate limiting, test tooling - proven locally |
| cloudflare.md | Cloudflare pricing, limits, spending controls, config keys |
| paddle-tech.md | Paddle Billing webhooks, Paddle.js, REST API (from the OpenAPI spec and SDKs) |
| paddle-samples/ | Official example webhook payloads from Paddle's OpenAPI spec |
| paddle-compliance.md | Seller onboarding, Lebanon, domain review, refund policy, fees |
| competitors.md | Bannerbear and @vercel/og facts for the comparison pages |
