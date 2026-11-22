# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dev Server

Serve files locally with Python's built-in HTTP server:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080/<filename>.html` in a browser.

## Structure

This is a plain static HTML workspace — no build system, no package manager, no framework. Files are vanilla HTML/CSS/JS served directly from the filesystem.

Top-level `.html` files are standalone pages. Sub-projects live in their own subdirectories with an `index.html` entry point.

## linktocard/ (the exception)

`linktocard/` is not a static page. It is a Cloudflare Workers service (TypeScript, Hono, D1, R2) with its own `package.json`, build and tests. Work on it from inside that directory:

```
cd linktocard
npm install
npm run dev          # site + API on http://localhost:8787
npm test             # builds the site, then the Workers-runtime and Node test suites
npm run typecheck
npm run smoke        # end-to-end check against a real `wrangler dev`
```

Read `linktocard/README.md` first; `linktocard/GO-LIVE.md` is the deployment checklist. Prices, quotas and limits are defined once in `src/billing/plans.ts` and `src/config.ts`: the pricing page, docs and tests are generated from or checked against them, so change numbers there and nowhere else. No headless browser and no payment processor other than Paddle may be added (a test enforces both).
