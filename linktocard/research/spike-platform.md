# Spike: Cloudflare platform behaviours proven locally (Hono Worker + Static Assets + D1 + R2 + Rate Limiting)

Date of run: 2026-11-21. Node v22.23.5, npm 10.9.9, Linux x64.
Everything below was executed in this container unless it is marked **DOC** (read from a primary source, not executed) or listed under **Unverified**.

- Spike project (requested stack, `@cloudflare/vitest-pool-workers`): `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/spike-platform`
- Variant project (successor package `@cloudflare/vitest-plugin` + vitest 5, same sources/tests): `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/spike-platform/variant-plugin`
- Raw `wrangler dev --port 8798` + curl transcript: `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/spike-platform/logs/curl-session.txt`
- Doc sources were read from GitHub (developers.cloudflare.com is blocked here). `DOCS` = `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs`. Cached copies: `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/research/docs-cache/`.

## 0. Headline findings (read these first)

1. **`@cloudflare/vitest-pool-workers` is deprecated.** npm prints `@cloudflare/vitest-pool-workers has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates.` on install and on every test run. Last release 0.23.0 (2026-10-07). It pins `wrangler 4.124.0` / `miniflare 5.20260815.0-alpha` / `workerd 1.20260815.1`, so **tests run on a 3-month-older runtime than `wrangler dev`** (wrangler 4.166.0 -> workerd 1.20261119.1). Concretely: with `compatibility_date = "2026-11-15"` the 0.23.0 pool refuses to start (`This Worker requires compatibility date "2026-11-15", but the newest date supported by this server binary is "2026-08-22"`). The spike therefore uses `compatibility_date = "2026-08-01"` in the pool-workers project.
2. **The successor works and is cleaner**: `@cloudflare/vitest-plugin@1.9.0` + `vitest@5.1.1` + `wrangler@4.166.0` share one workerd (1.20261119.1), install without npm workarounds, `npm audit` reports 0 vulnerabilities (the 0.23.0 tree reports 6 high, from its pinned old `sharp`/`undici`), and **the identical 49 tests pass unchanged** apart from the import in `vitest.config.ts`. Recommendation: build on `@cloudflare/vitest-plugin`.
3. **No per-test storage isolation any more.** Isolation is per test *file* (both packages). `isolatedStorage`/`singleWorker` options are gone. Use `reset()` from `cloudflare:test` (wipes data *and* the D1 schema) or unique keys per test.
4. **`fetchMock` no longer exists** in `cloudflare:test` (both packages). `vi.spyOn(globalThis, "fetch")` works; `msw@3` + `@msw/cloudflare` (the documented replacement) also works (run in the variant).
5. **`SELF.fetch()` / `exports.default.fetch()` do NOT go through the static-assets router.** In tests `/terms` hits the Worker (Hono 404), never `public/terms.html`. `env.ASSETS.fetch()` does work in tests. For true routing tests (asset-first, `run_worker_first`, `_headers`) use `createTestHarness()` from `wrangler` in a plain Node vitest project (proven, section 1) or `wrangler dev` + curl.
6. **With `not_found_handling = "404-page"`, any path outside `run_worker_first` never reaches the Worker**, including non-GET: `POST /anything-unlisted` -> `405 Method Not Allowed`, empty body. Every Worker endpoint must sit under a listed prefix.
7. **`"/api/*"` does not match bare `/api`.** Pattern = whole-pathname, case-sensitive, `*` -> `.*`.
8. `public/_headers` **is supported** for Workers static assets and applies to every asset-worker response (200/304/307/404/405) and to `env.ASSETS.fetch()` results, but **not** to Worker-generated responses.

## 1. Pinned versions

### 1a. Requested stack (what the main spike directory runs)

| Package | Version | Note / source |
|---|---|---|
| hono | 4.13.19 | `npm view hono version` (published 2026-11-16) |
| wrangler | 4.166.0 | `npm view wrangler version` (published 2026-11-20); engines `node >=22.12.0`; bundles miniflare 5.20261119.0-beta, workerd 1.20261119.1 |
| typescript | 7.0.2 | `latest` dist-tag; `tsc --noEmit` passes in ~0.8 s |
| vitest | **4.1.12** | NOT latest. `latest` is 5.1.1 but pool-workers 0.23.0 peers `vitest ^4.1.0`. 4.1.12 is the `V4` dist-tag |
| @cloudflare/vitest-pool-workers | 0.23.0 (**deprecated**) | peerDependencies: `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0`; dependencies: `wrangler 4.124.0`, `miniflare 5.20260815.0-alpha`, `esbuild 0.28.1`, `zod 4.4.3`, `cjs-module-lexer 1.2.3` (`npm view @cloudflare/vitest-pool-workers peerDependencies dependencies`) |
| @cloudflare/workers-types | 5.20261121.1 | installed as requested; `wrangler types` says it is superseded by generated runtime types (see 11) |
| resolved transitively | vite 8.3.8, @vitest/runner 4.1.12, @vitest/snapshot 4.1.12, workerd 1.20260815.1 (tests) and 1.20261119.1 (wrangler dev) | from `package-lock.json` |

Install that works (plain `npm install` crashes, see gotcha G1):

```sh
printf 'legacy-peer-deps=true\nsave-exact=true\n' > .npmrc
npm install hono@4.13.19
npm install -D vitest@4.1.12 wrangler@4.166.0 typescript@7.0.2 \
  @cloudflare/vitest-pool-workers@0.23.0 @cloudflare/workers-types@5.20261121.1
```

### 1b. Recommended stack (variant directory, all tests green)

| Package | Version |
|---|---|
| hono | 4.13.19 |
| wrangler | 4.166.0 (miniflare 5.20261119.0-beta, workerd 1.20261119.1) |
| typescript | 7.0.2 |
| vitest | 5.1.1 (`@cloudflare/vitest-plugin` peers `vitest ^4.1.0 \|\| ^5.0.0`) |
| @cloudflare/vitest-plugin | 1.9.0 (published 2026-11-20; depends on miniflare 5.20261119.0-beta = same as wrangler) |
| msw / @msw/cloudflare (optional) | 3.0.7 / 0.2.0 |

```sh
npm install hono@4.13.19
npm install -D vitest@5.1.1 wrangler@4.166.0 typescript@7.0.2 @cloudflare/vitest-plugin@1.9.0
# no .npmrc workaround needed; "found 0 vulnerabilities"
```

Only code difference vs 1a: `import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";` and tsconfig `types: ["@cloudflare/vitest-plugin/types"]`. Migration guide (DOC): `DOCS/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin.mdx`.

## 2. Exact working config files

### `wrangler.toml` (accepted by wrangler 4.166.0 with zero config warnings)

```toml
name = "spike-platform"
main = "src/index.ts"
compatibility_date = "2026-08-01"   # variant-plugin uses "2026-11-19"; see G2

[assets]
directory = "./public"
binding = "ASSETS"
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"
run_worker_first = ["/v1/*", "/api/*", "/auth/*", "/webhooks/*", "/i/*"]

[[d1_databases]]
binding = "DB"
database_name = "spike-db"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "spike-bucket"

[[ratelimits]]
name = "RL_API"
namespace_id = "1001"
simple = { limit = 5, period = 10 }

[[ratelimits]]
name = "RL_AUTH"
namespace_id = "1002"
simple = { limit = 3, period = 60 }

[vars]
APP_ENV = "dev"
PUBLIC_BASE_URL = "http://localhost:8798"
```

`wrangler dev` startup banner for it:

```
Using secrets defined in .dev.vars
Binding                                            Resource                  Mode
env.DB (spike-db)                                  D1 Database               local
env.BUCKET (spike-bucket)                          R2 Bucket                 local
env.RL_API (5 requests/10s)                        Rate Limit                local
env.RL_AUTH (3 requests/60s)                       Rate Limit                local
env.ASSETS                                         Assets                    local
env.APP_ENV ("dev")                                Environment Variable      local
env.PUBLIC_BASE_URL ("http://localhost:8798")      Environment Variable      local
env.SECRET_KEY ("(hidden)")                        Environment Variable      local
env.RESEND_API_KEY ("(hidden)")                    Environment Variable      local
```

### `.dev.vars` (local secrets for `wrangler dev`)

```ini
SECRET_KEY="dev-secret-from-dev-vars"
RESEND_API_KEY="re_dev_dummy"
```

### `migrations/0001_init.sql`

```sql
-- Migration number: 0001
CREATE TABLE counters (
  key        TEXT PRIMARY KEY,
  used       INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  quota      INTEGER NOT NULL,
  note       TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_counters_updated_at ON counters (updated_at);
```

For `wrangler dev`: `npx wrangler d1 migrations apply DB --local` (ran: "3 commands executed successfully", state under `.wrangler/state/v3/d1`).

### `public/` layout and `public/_headers`

```
public/404.html  index.html  terms.html  privacy.html  refund.html  pricing.html
public/docs.html            public/docs/quickstart.html          (docs.html + docs/ dir, no docs/index.html)
public/guide.html           public/guide/index.html  guide/intro.html   (file + dir WITH index.html)
public/dashboard/index.html public/dashboard/public/logo.txt
public/assets/app.css  app.js  data.json
public/_headers
```

```
/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; frame-ancestors 'none'

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

### `vitest.config.ts` (Workers pool: bindings, D1 migrations, test secrets)

```ts
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"; // variant: "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			// Runs in Node.js: read ./migrations/*.sql and split into statements
			const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
			return {
				// main, compatibility_date, assets, D1, R2, ratelimits and [vars] come from here
				wrangler: { configPath: "./wrangler.toml" },
				miniflare: {
					// test-only bindings; these override/extend wrangler.toml [vars]. .dev.vars is NOT relied on.
					bindings: {
						TEST_MIGRATIONS: migrations,
						APP_ENV: "test",
						SECRET_KEY: "test-secret",
						RESEND_API_KEY: "re_test_123",
					},
				},
			};
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
```

### `test/apply-migrations.ts` (setup file, runs inside workerd once per test file)

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); // idempotent, tracks state in d1_migrations
```

### `test/env.d.ts`

```ts
declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
```

### `vitest.node.config.ts` (second, plain-Node project for router/asset integration tests)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { include: ["test-node/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
```

### `tsconfig.json` (TypeScript 7.0.2, `npx tsc --noEmit` exit 0)

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022"],
    "types": ["./worker-configuration.d.ts", "@cloudflare/vitest-pool-workers/types", "node"],
    "strict": true, "noEmit": true, "skipLibCheck": true, "isolatedModules": true
  },
  "include": ["src", "test", "test-node", "vitest.config.ts", "vitest.node.config.ts"]
}
```

`worker-configuration.d.ts` is generated by `npx wrangler types --strict-vars false` (runtime types + `Env`, `Cloudflare.Env`, `Cloudflare.GlobalProps.mainModule`). Alternative without the generated file also type-checks (`tsconfig.wt.json` + `types-wt/env.d.ts` in the spike dir): `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]` plus a hand-written `Cloudflare.Env` **and** `interface GlobalProps { mainModule: typeof import("../src/index") }` (without `GlobalProps`, `exports.default` is a type error: `Property 'default' does not exist on type 'Exports'`).

### `package.json` scripts

```json
{ "test": "vitest run", "test:node": "vitest run -c vitest.node.config.ts", "typecheck": "tsc --noEmit",
  "dev": "wrangler dev --port 8798", "types": "wrangler types --strict-vars false" }
```

### Test run results

| Command | pool-workers 0.23.0 + vitest 4.1.12 | vitest-plugin 1.9.0 + vitest 5.1.1 |
|---|---|---|
| `npx vitest run` (Workers pool, `test/*.test.ts`) | 11 files, **49 passed** (3 consecutive runs) | 11 files, **49 passed** (+1 msw file = 12 files / 50 tests) |
| `npx vitest run -c vitest.node.config.ts` (`createTestHarness`) | 1 file, **6 passed** | 1 file, **6 passed** |
| `npx tsc --noEmit` (TS 7.0.2) | exit 0 | exit 0 |

Test files (same in both dirs): `test/01-02-assets.test.ts`, `03-d1.test.ts`, `03-d1-isolation-a.test.ts`, `03-d1-isolation-b.test.ts`, `04-r2.test.ts`, `05-ratelimit.test.ts`, `06-cache.test.ts`, `07-outbound-and-time.test.ts`, `08-waituntil.test.ts`, `09-10-env-facts.test.ts`, `11-hono.test.ts`, `test-node/harness.test.ts`; variant only: `test/07b-msw.test.ts`. Throwaway exploration scripts that produced the raw observations: `explore/*.explore.test.ts`.

---

## Item 1 - Static assets URL handling

Proven three ways: `wrangler dev --port 8798` + `curl -i`; `env.ASSETS.fetch()` in the Workers pool; `createTestHarness().fetch()` in a Node vitest project. All three agree.

### 1.1 `html_handling = "auto-trailing-slash"` (default), `not_found_handling = "404-page"`

| Request | Expected (DOC table, `DOCS/workers/static-assets/routing/advanced/html-handling.mdx`) | Observed (curl) |
|---|---|---|
| `GET /terms` (public/terms.html) | 200 | **200**, `Content-Type: text/html; charset=utf-8`, Worker not invoked |
| `GET /terms/` | 307 -> /terms | **307**, `Location: /terms` |
| `GET /terms.html` | 307 -> /terms | **307**, `Location: /terms` |
| `GET /privacy`, `/refund`, `/pricing` | 200 | **200** each |
| `GET /docs/quickstart` (public/docs/quickstart.html) | 200 | **200** |
| `GET /docs/quickstart/`, `/docs/quickstart.html` | 307 | **307** -> `/docs/quickstart` |
| `GET /docs` (docs.html + docs/ dir without index.html) | not in doc table | **200** (docs.html) |
| `GET /docs/` (same) | not in doc table | **307** -> `/docs` |
| `GET /docs.html`, `/docs/index.html` (same) | - | **307** -> `/docs` |
| `GET /guide` (guide.html + guide/index.html both exist) | not in doc table | **200** guide.html |
| `GET /guide/` | - | **200** guide/index.html |
| `GET /guide.html` | - | **307** -> `/guide` |
| `GET /guide/index.html`, `/guide/index` | - | **307** -> `/guide/` |
| `GET /dashboard` (only dashboard/index.html) | 307 -> /folder/ | **307** -> `/dashboard/` |
| `GET /dashboard/` | 200 | **200** |
| `GET /` (public/index.html) | 200 | **200** |
| `GET /index.html`, `/index` | 307 | **307** -> `/` |
| `GET /nope`, `/nope/deeper.html`, `/nope.png` | 404 + nearest 404.html (DOC `.../static-site-generation.mdx`) | **404**, body = public/404.html, `Content-Type: text/html; charset=utf-8`, Worker not invoked |
| `GET /assets/`, `/assets` (dir without index) | - | **404** page |
| `GET /404` | - | **200** (the 404 page is itself addressable); `/404.html` -> 307 `/404` |
| `HEAD /terms` | - | **200**, same headers, no body |
| `POST /terms` | - | **405 Method Not Allowed**, `Content-Length: 0` |
| `POST /nope` | - | **405**, empty body, Worker not invoked |
| `GET //api/ping`, `/%61pi/ping`, `/api%2Fping` | - | **307** -> `/api/ping` (path normalisation redirect happens before routing) |

Exact response for `/terms` (before `_headers` was added):

```
HTTP/1.1 200 OK
Transfer-Encoding: chunked
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=0, must-revalidate
ETag: "b3f5a65ec04cc4824e7b5d66fb4f7cc8"
CF-Cache-Status: HIT
```

### 1.2 Cache-Control / ETag

| Fact | Expected (DOC `DOCS/workers/static-assets/headers.mdx`) | Observed |
|---|---|---|
| Default Cache-Control | `public, max-age=0, must-revalidate` | identical, on 200, 304 and the 404 page |
| ETag | "hash of the static asset file" | strong ETag, 32 hex chars in quotes, e.g. `"b3f5a65ec04cc4824e7b5d66fb4f7cc8"` |
| `If-None-Match: <etag>` | revalidation | **304 Not Modified** (also for `W/<etag>`) |
| `CF-Cache-Status` | HIT or MISS | `HIT` locally on every request |
| `Accept-Encoding: gzip, br` | - | `Content-Encoding: gzip` on `/assets/app.css` locally |
| Content types | by extension | css `text/css; charset=utf-8`, js `text/javascript; charset=utf-8`, json `application/json`, txt `text/plain; charset=utf-8` |
| Override via `_headers` `/assets/*` Cache-Control | "override what Cloudflare ordinarily sends" | `Cache-Control: public, max-age=31536000, immutable` (default **replaced**, not appended) |

### 1.3 Other `html_handling` values (each run under `wrangler dev`)

| Request | drop-trailing-slash | force-trailing-slash | none |
|---|---|---|---|
| `/terms` | 200 | 307 -> `/terms/` | 404 page |
| `/terms/` | 307 -> `/terms` | 200 | 404 page |
| `/terms.html` | 307 -> `/terms` | 307 -> `/terms/` | 200 |
| `/pricing` | 200 | 307 -> `/pricing/` | 404 page |
| `/docs/quickstart` | 200 | 307 -> `/docs/quickstart/` | 404 page |
| `/docs` (docs.html + dir) | 200 | 307 -> `/docs/` | 404 page |
| `/docs/` | 307 -> `/docs` | 200 (docs.html) | 404 page |
| `/guide` (file + dir/index) | 200 guide.html | 307 -> `/guide/` | 404 page |
| `/guide/` | 307 -> `/guide` | 200 guide/index.html | 404 page |
| `/guide/index.html` | 200 (served directly; guide.html owns `/guide`) | 307 -> `/guide/` | 200 |
| `/guide.html` | 307 -> `/guide` | 200 (served directly) | 200 |
| `/dashboard` (dir/index only) | 200 | 307 -> `/dashboard/` | 404 page |
| `/dashboard/` | 307 -> `/dashboard` | 200 | 404 page |
| `/` | 200 | 200 | **404 page** (only `/index.html` is 200) |

### 1.4 Answer: `/terms`, `/privacy`, `/refund`, `/pricing` returning 200 with no redirect

- **File layout:** flat files `public/terms.html`, `public/privacy.html`, `public/refund.html`, `public/pricing.html`.
- **`html_handling`:** `"auto-trailing-slash"` (the default) **or** `"drop-trailing-slash"`. Both verified: 200, no redirect, Worker not invoked.
- Do **not** use `force-trailing-slash` (307 to `/terms/`) or `none` (404 at `/terms`).
- Do **not** use `public/terms/index.html` with `auto-trailing-slash`: `/terms` then 307s to `/terms/` (proven by `/dashboard`). If directory-style pages are ever wanted, `drop-trailing-slash` serves both layouts at the slash-less URL.
- A sibling directory with the same name (`public/docs.html` + `public/docs/`) does not break `/docs` (200).
- `/terms/` and `/terms.html` always 307 to `/terms` (temporary redirect, not 301/308).

### 1.5 Assets inside vitest

| Mechanism | Expected | Observed |
|---|---|---|
| `SELF.fetch("/terms")` / `exports.default.fetch("/terms")` in the Workers pool | old releases routed SELF through assets (changelog 0.5.15); changelog 0.13.0 + DOC `test-apis.mdx`: "`exports` does not expose Assets" | **404 from the Hono `notFound`** (`x-worker: 1`). True for both packages and for every config tried (no `run_worker_first`, `true`, array, `not_found_handling = none`). `SELF` still exists (deprecated) and behaves the same |
| `env.ASSETS.fetch(new Request(url, { redirect: "manual" }))` in the Workers pool | DOC `binding.mdx`: html_handling + not_found_handling applied | Works: same statuses/redirects/headers as curl, including `_headers` |
| `createTestHarness({ workers: [{ configPath: "./wrangler.toml" }] })` from `wrangler`, Node pool | DOC `DOCS/workers/testing/test-harness/*.mdx` | Works: full router + assets + Worker; `server.fetch("/terms", { redirect: "manual" })` -> 200; table in `test-node/harness.test.ts` passes |
| `unstable_startWorker()` | DOC `unstable_startworker.mdx`: "deprecated ... recommends createTestHarness()" | not run |

## Item 2 - `run_worker_first`, ASSETS binding, security headers

### 2.1 Pattern syntax (source read: `node_modules/wrangler/wrangler-dist/cli.js` `parseStaticRouting` and `node_modules/wrangler/node_modules/miniflare/dist/src/workers/assets/router.worker.js` `generateGlobOnlyRuleRegExp`; DOC `DOCS/workers/static-assets/binding.mdx`)

- Value is `true` / `false` or an array of strings. A bare string is rejected: `The field "assets.run_worker_first" should be an array of strings or a boolean, but got "/api/*".`
- Each rule must start with `/` (Worker first) or `!/` (negative: force assets). Negative rules win. Order is irrelevant.
- Matching code is literally `"^" + rule.split("*").map(escapeRegex).join(".*") + "$"` tested against `new URL(request.url).pathname`: `*` matches any characters **including `/`** (zero or more), everything else is literal, anchored both ends, **case-sensitive**, query string ignored. No `:param` syntax, no special `**` (accepted by validation but just two globs).
- Limits/validation (messages observed with `wrangler deploy --dry-run`):

| Input | Result |
|---|---|
| `["api/*"]` | ERROR `'api/*': rules must start with '/' or '!/'` |
| `["!api"]` | ERROR `'!api': negative rules must start with '!/'` |
| `["!/api/docs/*"]` | ERROR `Only negative run_worker_first rules were provided; must provide at least 1 non-negative rule` |
| `[]` | ERROR `No run_worker_first rules were provided; must provide at least 1 rule.` |
| `["/api/*", "/api/*"]` | ERROR `'/api/*': rule is a duplicate; rules must be unique` |
| `["/api/*", "/api/users"]` | ERROR `'/api/users': rule '/api/*' makes it redundant` |
| `["/api/:id"]`, `["/api/**", "/*.json"]` | accepted (but `:id` is a literal, not a parameter) |
| more than 100 rules / rule longer than 100 chars | rejected (read in source, not run) |

### 2.2 Matching behaviour (`run_worker_first = ["/v1/*", "/api/*", "/auth/*", "/webhooks/*", "/i/*"]`, curl)

| Request | Expected | Observed |
|---|---|---|
| `GET /api/ping`, `/v1/ping`, `/auth/me`, `/api/ping?x=1` | Worker | 200 from Worker (`x-worker: 1`) |
| `GET /api/`, `/api/deep/er/path`, `/webhooks/x`, `/i/missing` | Worker | Worker (Hono JSON 404) |
| `POST /api/nothing`, `POST /webhooks/paddle` | Worker | Worker |
| **`GET /api`, `/v1`, `/auth`** (no trailing slash) | arguably Worker | **asset 404 page, Worker NOT invoked** |
| `GET /apix` | assets | asset 404 page |
| `GET /API/ping` | ? | asset 404 page (case-sensitive) |
| `/terms`, `/nope`, `/`, `/assets/app.css`, `/docs`, `/dashboard/`, `POST /nope` | assets only | assets only |

Proof that non-matching paths never invoke the Worker: the Worker increments a module-level counter on every request and returns it from `/api/ping`. Counter read 2 -> 15 non-matching requests (assets, 404s, `/api`, `/apix`, `/API/ping`, a POST) -> counter read 3 (only the read itself). Same assertion passes in `test-node/harness.test.ts`.

Negative rule + extra entries (`wrangler.gate.toml`: `[..., "/dashboard", "/dashboard/*", "!/dashboard/public/*"]`): `/dashboard`, `/dashboard/`, `/dashboard/index.html`, `/dashboard/nope` -> Worker; `/dashboard/public/logo.txt` -> asset directly (no `x-worker`).

Other modes: `run_worker_first = true` -> every request (even `/terms`) hits the Worker. `not_found_handling = "none"` (the default) -> existing assets are served directly, everything else (any method, including `/api`, `/apix`, `/nope`) falls through to the Worker; `POST /terms` is still 405.

### 2.3 Worker route calling `env.ASSETS.fetch()`

| Call | Observed |
|---|---|
| `c.env.ASSETS.fetch(new URL("/terms", c.req.url))` | 200 + asset headers |
| same with `/terms.html`, `/terms/`, `/dashboard`, `/404.html` | **200** - a URL/string input follows the html_handling 307 internally |
| `c.env.ASSETS.fetch(c.req.raw)` (incoming request has `redirect: "manual"`) | the 307 is passed through to the client (seen on gated `/dashboard`) |
| `ASSETS.fetch(new URL("/nope", ...))` | **404** with public/404.html body -> simplest custom 404 from a Worker |
| `ASSETS.fetch("/404.html")` re-wrapped with `status: 404` | works (`/api/custom-404`) |
| Cookie gate (`/dashboard*` added to run_worker_first) | no cookie: `302 Location: /auth/login?next=/dashboard/`; `Cookie: session=ok`: 200 dashboard/index.html with `x-worker: 1` |

### 2.4 Security headers: Worker or `_headers`?

| Question | Observed |
|---|---|
| Is `public/_headers` supported for Workers static assets? | **Yes.** wrangler dev logs `✨ Parsed 2 valid header rules.` and hot-reloads. `GET /_headers` -> 404 (file is not served). DOC `DOCS/workers/static-assets/headers.mdx` |
| `/*` rules on asset responses | `x-frame-options: DENY` and `content-security-policy: default-src 'self'; frame-ancestors 'none'` present on 200, 304, 307 redirects, the 404 page and 405 |
| On Worker-generated responses (`/api/ping`) | **Not applied** (matches DOC caution) |
| On `env.ASSETS.fetch()` results returned by the Worker | Applied (matched against the fetched asset path) |
| Can the Worker add/override headers on an asset response? | Yes, only for requests that reach the Worker: `new Response(res.body, res)` then `headers.set(...)` -> CSP became `default-src 'self'` (Worker value replaced the `_headers` value). Hono's `c.header()` after `await next()` also worked on a passthrough asset response |

Conclusion: because non-`run_worker_first` paths bypass the Worker entirely, **`public/_headers` is required** for X-Frame-Options/CSP on directly-served pages; set the same headers in a Hono middleware for Worker responses.

## Item 3 - D1 in the Workers pool (`test/03-d1*.test.ts`)

| Topic | Expected | Observed |
|---|---|---|
| Applying migrations | DOC `configuration.mdx` / `test-apis.mdx` | `readD1Migrations(dir)` in config (Node) -> `miniflare.bindings.TEST_MIGRATIONS` -> `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in a `setupFiles` entry. After setup: tables `counters`, `d1_migrations` (row `0001_init.sql`), index `idx_counters_updated_at`, plus internal `_cf_METADATA`, `sqlite_sequence` |
| Isolation between tests in one file | older pool: per-test | **None.** Row inserted in test 1 is still there in test 2 |
| Isolation between files | DOC `isolation-and-concurrency.mdx`: per file | Yes. Two files running concurrently both start with empty D1 + R2 and both insert the same primary key / R2 key without conflict |
| `reset()` from `cloudflare:test` | "Deletes all data from all attached bindings" | Wipes R2 objects **and the whole D1 schema** (`sqlite_master` tables = `[]`, including `d1_migrations`). Must call `applyD1Migrations` again; afterwards `counters` exists with 0 rows |
| `env.DB.batch()` atomicity | DOC `DOCS/d1/worker-api/d1-database.mdx`: batch is a transaction, failure rolls back the sequence | Batch `[INSERT ok, INSERT violating CHECK, INSERT ok]` rejects with `D1_ERROR: CHECK constraint failed: used >= 0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)`; afterwards **zero** rows from the batch exist. Control: the same statements run individually leave the first row committed |
| Successful batch result | array of D1Result | `[{changes:1,...}, {changes:1,...}, {results:[{key:"b1",used:1}], changes:0}]` |
| `meta.changes` after `UPDATE counters SET used = used + 1 WHERE key = ?1 AND used < ?2` (used 0, limit 2), 4 calls | 1,1,0,0 | **`[1, 1, 0, 0]`**; `success` stays `true` when 0 rows match; `meta.changed_db` true,true,false,false; unknown key -> changes 0 |
| same with `... AND used < quota RETURNING used` when exhausted | empty | `results: []`, `changes: 0` |
| `INSERT ... ON CONFLICT DO NOTHING RETURNING key, used` | row first time, nothing on duplicate | 1st: `results: [{key:"evt_1",used:0}]`, `changes: 1`. 2nd: `results: []`, `changes: 0`, no error. `.first()` -> row, then `null` |
| `INSERT ... ON CONFLICT(key) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at WHERE counters.used < counters.quota RETURNING used` (quota 3), 4 calls | 1,2,3, then nothing | `[[{used:1}],1]`, `[[{used:2}],1]`, `[[{used:3}],1]`, `[[],0]`; final row `used: 3, updated_at: 1003` (4th call changed nothing) |
| `changes()` in the 2nd statement of a batch | unknown | **Works.** Batch `[UPDATE ... WHERE used < quota, SELECT changes() AS c, INSERT ... SELECT ... WHERE changes() > 0]`: when the UPDATE hits -> `c = 1` and the conditional INSERT writes (`changes: 1`); when the UPDATE is a no-op -> `c = 0` and the INSERT writes nothing |
| `changes()` across two separate `prepare().run()` calls | unsafe | returned 1 locally (same connection), but nothing guarantees this under concurrency - only rely on it inside one `batch()` |
| Explicit `BEGIN TRANSACTION` | rejected | rejects with `D1_ERROR` |
| `sqlite_version()` | - | `D1_ERROR: not authorized to use function: sqlite_version` |
| Other `meta` fields seen | - | `last_row_id`, `rows_read`, `rows_written` (3 for an insert into the indexed table), `changed_db` |

Working per-test reset if wanted: `beforeEach(async () => { await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); })`.

## Item 4 - R2 in the Workers pool (`test/04-r2.test.ts`)

| Topic | Observed |
|---|---|
| `put(key, Uint8Array, { httpMetadata, customMetadata })` | returns R2Object: `size 4`, `etag` 32-hex md5, `httpEtag` = `"<etag>"`, `version` string, `uploaded` Date, checksums md5/sha1/sha256/sha384/sha512, `storageClass ""` locally |
| `get()` | body bytes round-trip; `httpMetadata` `{contentType, cacheControl, contentDisposition}` and `customMetadata` returned; `writeHttpMetadata(headers)` -> `content-type`, `cache-control`, `content-disposition` |
| `head()` | same metadata, no `body` property |
| missing key | `get` -> `null`, `head` -> `null` |
| `delete(key)` / `delete([keys])` | resolves `undefined`; deleting a missing key does not throw |
| `list({ prefix: "img/" })` | `["img/a.png","img/b.png","img/sub/c.png"]`, `truncated: false` |
| `list({ prefix: "img/", delimiter: "/" })` | objects `["img/a.png","img/b.png"]`, `delimitedPrefixes: ["img/sub/"]` |
| `list({ limit: 1 })` | `truncated: true`, string `cursor` |
| `list({ include: ["httpMetadata","customMetadata"] })` | metadata present on listed objects |
| **`put(k, v, { onlyIf: { etagDoesNotMatch: "*" } })`** | **Create-if-absent semantics locally**: absent -> object written; present -> returns `null`, existing value untouched, no throw. `onlyIf: new Headers({ "If-None-Match": "*" })` behaves identically |
| `onlyIf: { etagMatches: <current etag> }` | compare-and-swap works: current etag -> written; stale etag -> `null`; absent key -> `null` |
| `onlyIf: { uploadedBefore: new Date(0) }` | absent -> written, present -> `null` (accidental create-if-absent; not recommended) |
| conditional `get` with matching `etagDoesNotMatch` | returns an R2Object **without `body`** (not `null`) - matches DOC |
| Value types accepted | `string`, `Uint8Array`, `ArrayBuffer`, `DataView`, `Blob`, `null` (0 bytes), `Request.body`, `Response.body`, readable side of `FixedLengthStream` |
| Value types rejected | plain `new ReadableStream(...)` and `TransformStream` readable: `Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)` |
| Serving via Hono (`/i/:key`, `new Response(obj.body, { headers })`) | 200, `content-type`/`cache-control` from httpMetadata, `etag` = `obj.httpEtag`; also works under wrangler dev after `wrangler r2 object put spike-bucket/hello.txt --file ... --local` |

DOC (`DOCS/r2/api/workers/workers-api-reference.mdx`, "Conditional operations"): a failed `put()` precondition "returns `null`, and the object will not be stored"; `etagDoesNotMatch` = "Performs the operation if the object's etag does not match the given string". The doc does not spell out the `"*"` wildcard for the object form; see Unverified U2.

## Item 5 - Rate limiting binding

| Topic | Expected | Observed |
|---|---|---|
| Config syntax | DOC `DOCS/workers/runtime-apis/bindings/rate-limit.mdx`: `ratelimits` array, `name`, `namespace_id` (string integer), `simple.limit`, `simple.period` (10 or 60) | `[[ratelimits]]` exactly as in section 2: **no warnings** in `wrangler dev` or `wrangler deploy --dry-run`; listed as `env.RL_API (5 requests/10s)  Rate Limit` |
| Validation | - | `period = 30` -> `"ratelimits[0]" bindings "simple.period" must be either 10 or 60 but got 30.`; numeric `namespace_id` -> `bindings must have a string "namespace_id" field` |
| Older `[[unsafe.bindings]] type = "ratelimit"` | still accepted? | Accepted and functional under wrangler dev (trips after 5), **but warns** `"unsafe" fields are experimental and may change or break at any time.` and shows as `Unsafe Metadata`. Do not use |
| `env.RL.limit({ key })` under wrangler dev | works | `RL_API` (5 per 10 s), 8 rapid calls same key: `200,200,200,200,200,429,429,429`; other key: 200; after sleeping 11 s: 200 again. `RL_AUTH` (3 per 60 s): `200,200,200,429,429`, still 429 after 11 s |
| under the Workers pool | unknown | Works: object of class `Ratelimit`, `limit` is a function; 8 calls -> `[true,true,true,true,true,false,false,false]`; via `exports.default.fetch` on `/auth/rl`: `[200,200,200,429,429]` |
| under `createTestHarness` | - | `[200,200,200,429,429]` |
| State across tests | - | **Persists within a test file** (key tripped in test 1 is still tripped in test 2). `vi.setSystemTime(+61s)` does **not** reset the window |
| Detecting absence | - | The binding is simply `undefined` if not configured (e.g. forgotten in `[env.staging]`). Guard used and tested: `typeof env.RL?.limit === "function"`; route returns `{available:false}` when called with `{ ...env, RL_API: undefined }` |

Detection + fallback shape proven in `src/index.ts`:

```ts
function rateLimiterAvailable(rl: unknown): rl is RateLimit {
	return typeof rl === "object" && rl !== null && typeof (rl as RateLimit).limit === "function";
}
```

It was never *unavailable* in any local mode tried, so an in-memory fallback is only needed for a misconfigured environment. DOC caveat: production limits are "approximate", per Cloudflare location, "eventually consistent"; a strict limit needs a Durable Object.

## Item 6 - Cache API

| Topic | Observed |
|---|---|
| `caches.default.put` / `match` under wrangler dev | Works. `/api/cache?k=a` 1st: `{"hit":false,"storedNow":true,...}`; 2nd: `{"hit":true,"body":"cached@...","cfCacheStatus":"HIT"}`; different key: miss |
| Under the Workers pool | Works: `match` -> `undefined` before put, body + `cf-cache-status: HIT` after, `delete` -> `true`, then `undefined`. `caches.open("custom")` works |
| Responses without cacheable Cache-Control | `put` resolves but `match` returns `undefined` (no `Cache-Control`, or `max-age=0`) |
| Fake timers | DOC `known-issues.mdx`: fake timers "do not apply to KV, R2 and cache simulators" (not run) |
| workers.dev no-op | **Could not confirm from current docs.** `DOCS/workers/runtime-apis/cache.mdx` today says: "Workers deployed to custom domains have access to functional `cache` operations" and "any Cache API operations in the Cloudflare Workers dashboard editor and Playground previews will have no impact. For Workers fronted by Cloudflare Access, the Cache API is not currently available." It also mentions `.workers.dev` domains "include the query string in the cache key by default". No sentence says `*.workers.dev` is a no-op. Treat workers.dev behaviour as Unverified (U3) and do not rely on the Cache API for correctness |

## Item 7 - Mocking outbound fetch; fake timers (`test/07-outbound-and-time.test.ts`)

| Topic | Expected | Observed |
|---|---|---|
| `fetchMock` from `cloudflare:test` | task assumed it exists | **Removed.** Runtime export list (both packages): `SELF, abortAllDurableObjects, adminSecretsStore, applyD1Migrations, createExecutionContext, createMessageBatch, createPagesEventContext, createScheduledController, env, evictAllDurableObjects, evictDurableObject, getQueueResult, introspectWorkflow, introspectWorkflowInstance, listDurableObjectIds, reset, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext`. Changelog 0.13.0: "`import { fetchMock } from "cloudflare:test"`: This has been removed. Instead, mock `globalThis.fetch` or use ... MSW (recommended)" |
| `vi.spyOn(globalThis, "fetch")` | works because Worker and test share an isolate | **Works** through `exports.default.fetch` / `SELF.fetch`. Captured exactly one call: `POST https://api.resend.com/emails`, `authorization: Bearer re_test_123`, body `{"from":"noreply@example.com","to":"user@example.com","subject":"hi","text":"hello"}` |
| `mockResolvedValue(<Response built in the test>)` | works | **Fails**: handler gets `Cannot perform I/O on behalf of a different request ... (I/O type: ReadableStreamSource)` -> 500. Build the Response inside `mockImplementation(async () => Response.json(...))` |
| Unmocked outbound fetch | blocked? | **Real network call is attempted** (here: DNS failure, noisy workerd stack, handler 500). Nothing blocks un-mocked hosts; make the spy `throw` for unexpected URLs |
| msw | DOC `mock-outbound-requests.mdx` | `msw@3.0.7` + `@msw/cloudflare@0.2.0` `setupNetwork()` + `http.post("https://api.resend.com/emails", ...)` intercepts and asserts the body (variant only, `test/07b-msw.test.ts`) |
| From a `createTestHarness` Node test | DOC `prepare-test-state.mdx`: Worker fetches are proxied through Node's `globalThis.fetch` | `vi.spyOn(globalThis, "fetch")` in Node captured the same POST |
| `vi.useFakeTimers(); vi.setSystemTime(...)` seen by the handler | yes (same isolate) | `/api/now` via `exports.default.fetch` and via `app.request` both return `2027-01-31T23:59:59.000Z`; after `setSystemTime("2027-02-01T00:00:01Z")` -> `2027-02-01T00:00:01.000Z` ("next month" works) |
| D1's clock | - | **Not faked**: `SELECT datetime('now')` returned the real `2026-11-21 ...` while JS said 2027. Pass timestamps/period keys from JS as bound parameters |
| `vi.useFakeTimers({ toFake: ["Date"] })` | - | Date faked, real timers kept: a handler awaiting `stream.sleep(10)` still completes |

Working example:

```ts
const seen: unknown[] = [];
const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
	const req = new Request(input as RequestInfo, init);
	if (req.url !== "https://api.resend.com/emails") throw new Error(`unexpected outbound fetch: ${req.method} ${req.url}`);
	seen.push({ method: req.method, auth: req.headers.get("authorization"), body: await req.json() });
	return Response.json({ id: "email_123" });           // created INSIDE the mock
});
const res = await exports.default.fetch("https://example.com/api/send-email", { method: "POST", body: JSON.stringify({ to: "user@example.com" }) });
expect(spy).toHaveBeenCalledTimes(1);
// afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
```

## Item 8 - `ctx.waitUntil` (`test/08-waituntil.test.ts`)

Route: `c.executionCtx.waitUntil(async () => { await scheduler.wait(50); INSERT ... })`, returns 202.

| Approach | Observed |
|---|---|
| `const ctx = createExecutionContext(); await worker.fetch(req, env, ctx); await waitOnExecutionContext(ctx);` | Deterministic: row absent right after the response, present after `waitOnExecutionContext` |
| Hono: `app.request(path, init, env, ctx)` + `waitOnExecutionContext(ctx)` | Same; `ctx` is the 4th argument |
| `exports.default.fetch` / `SELF.fetch` | Response resolves **before** the background work; row absent immediately, present ~50 ms later. No handle to await it -> only `expect.poll(...)` works |
| `app.request(path, init, env)` without ctx | handler throws `This context has no ExecutionContext` -> 500 |
| `wrangler dev` | background work completes (two POSTs -> `used = 2` in local D1) |

## Item 9 - Vars / secrets; environments

| Topic | Observed |
|---|---|
| `[vars]` in tests | flow in via `wrangler.configPath` (`PUBLIC_BASE_URL` seen) |
| `miniflare.bindings` in vitest config | override `[vars]` and `.dev.vars` (`APP_ENV: "test"`, `SECRET_KEY: "test-secret"`) |
| `.dev.vars` and tests | **Tests load `.dev.vars` automatically** (`Using secrets defined in .dev.vars`). Without overrides tests saw `SECRET_KEY = "dev-secret-from-dev-vars"`. With no `.dev.vars` (typical CI) secrets are `undefined` -> always set test secrets in `miniflare.bindings` |
| `.env` | used when there is no `.dev.vars` (`Using secrets defined in .env`) |
| `wrangler.environment: "staging"` | picks `[env.staging.vars]`; if `.dev.vars.staging` exists it **replaces** `.dev.vars` entirely (not merged: `RESEND_API_KEY` became `null`). DOC `DOCS/workers/local-development/environment-variables.mdx` says the same |
| `wrangler dev` | `.dev.vars` values appear as `env.SECRET_KEY ("(hidden)")`; `/api/env` returned them |
| `createTestHarness` | `vars: {...}` / `secrets: {...}` per worker override config and `.dev.vars` (asserted) |
| `[secrets] required = [...]` | accepted; `wrangler dev` warns `Missing required secrets: PADDLE_WEBHOOK_SECRET. Add them to .dev.vars, .env, or set as environment variables.`; dry-run deploy prints no error. DOC `DOCS/workers/wrangler/configuration.mdx` ("`secrets` configuration property") |

### `[env.staging]` / `[env.production]` layout (file: `wrangler.envs.toml`)

Bindings (`vars`, `d1_databases`, `r2_buckets`, `ratelimits`, ...) are **not inherited**; `name`, `main`, `compatibility_date`, `assets` are (DOC `DOCS/workers/wrangler/configuration.mdx`, "Non-inheritable keys").

```toml
name = "spike-platform"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[assets]                       # inherited by every env
directory = "./public"
binding = "ASSETS"
html_handling = "auto-trailing-slash"
not_found_handling = "404-page"
run_worker_first = ["/v1/*", "/api/*", "/auth/*", "/webhooks/*", "/i/*"]

[vars]                         # top level = local dev
APP_ENV = "dev"
PUBLIC_BASE_URL = "http://localhost:8798"
[[d1_databases]]
binding = "DB"
database_name = "spike-db-dev"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "migrations"
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "spike-bucket-dev"
[[ratelimits]]
name = "RL_API"
namespace_id = "1001"
simple = { limit = 5, period = 10 }
[[ratelimits]]
name = "RL_AUTH"
namespace_id = "1002"
simple = { limit = 3, period = 60 }

[env.staging]
[env.staging.vars]
APP_ENV = "staging"
PUBLIC_BASE_URL = "https://staging.example.com"
[[env.staging.d1_databases]]
binding = "DB"
database_name = "spike-db-staging"
database_id = "11111111-1111-1111-1111-111111111111"
migrations_dir = "migrations"
[[env.staging.r2_buckets]]
binding = "BUCKET"
bucket_name = "spike-bucket-staging"
[[env.staging.ratelimits]]
name = "RL_API"
namespace_id = "2001"
simple = { limit = 100, period = 60 }
[[env.staging.ratelimits]]
name = "RL_AUTH"
namespace_id = "2002"
simple = { limit = 10, period = 60 }

[env.production]               # same four blocks again with production ids (see file)
```

`npx wrangler deploy --dry-run --env staging --config wrangler.envs.toml` printed:

```
 ⛅️ wrangler 4.166.0
────────────────────
✨ Read 22 files from the assets directory .../spike-platform/public
Total Upload: 76.78 KiB / gzip: 20.20 KiB
Your Worker has access to the following bindings:
Binding                                                  Resource
env.DB (spike-db-staging)                                D1 Database
env.BUCKET (spike-bucket-staging)                        R2 Bucket
env.RL_API (100 requests/60s)                            Rate Limit
env.RL_AUTH (10 requests/60s)                            Rate Limit
env.ASSETS                                               Assets
env.APP_ENV ("staging")                                  Environment Variable
env.PUBLIC_BASE_URL ("https://staging.example.com")      Environment Variable
--dry-run: exiting now.
```

Other observed outputs:
- An env that forgets blocks: `"vars" exists at the top level, but not on "env.staging". This is not what you probably want, since "vars" is not inherited by environments.` (same for `r2_buckets`, `ratelimits`); it is only a **warning**, the dry run then lists just `env.DB` and `env.ASSETS` - i.e. the Worker would deploy with missing bindings.
- No `--env` with environments defined: warning `Multiple environments are defined ... no target environment was specified for the deploy command.` and the top-level (dev) bindings are used.
- `--env nope`: ERROR `No environment found in configuration with name "nope" ... available configured environment names are: ["staging","production"]`.

## Item 10 - Request facts

| Context | `cf-connecting-ip` | `request.cf` | Other |
|---|---|---|---|
| `wrangler dev` + curl to 127.0.0.1 or localhost | **`127.0.0.1`** | present; here a **placeholder** (`country "US"`, `colo "DFW"`, keys asOrganization, asn, botManagement, city, ... tlsVersion) because fetching the real cf object was blocked: `[wrangler:warn] Unable to fetch the Request.cf object! Falling back to a default placeholder...` | `x-forwarded-for`/`x-real-ip` absent; header names: accept, accept-encoding, cf-connecting-ip, host, user-agent |
| `wrangler dev` with `-H "CF-Connecting-IP: 9.9.9.9"` | **`9.9.9.9`** (client value passes through locally) | same | - |
| `createTestHarness().fetch()` | `127.0.0.1` | present (same placeholder) | url `http://127.0.0.1:<random port>/...` |
| `exports.default.fetch` / `SELF.fetch` in the Workers pool | **`null`** | **`undefined`** | no headers at all unless the test adds them |
| `app.request("/path", {}, env)` | `null` | `undefined` | url base is `http://localhost` |
| Tests injecting values | `{ headers: { "cf-connecting-ip": "203.0.113.7" } }` -> seen | `new Request(url, { cf: { country: "DE" } })` -> seen | - |

Code must tolerate a missing `cf-connecting-ip` and a missing `request.cf` (tests) and must not treat the local value as trustworthy.

## Item 11 - Hono (4.13.19)

| Topic | Observed |
|---|---|
| Latest version | 4.13.19 (`npm view hono version`, 2026-11-21) |
| `app.request` signature | `request(input: Request \| string \| URL, requestInit?, Env?, executionCtx?)` (`node_modules/hono/dist/types/hono-base.d.ts`). Relative paths resolve against `http://localhost`. Omitting `Env` -> `c.env` is `undefined` (500 `Cannot read properties of undefined (reading 'APP_ENV')`) |
| `app.request` vs `exports.default.fetch` vs `worker.fetch(req, env, ctx)` | all 200 and all hit the **same module instance** (module counter went n, n+1, n+2). `app.request`/`worker.fetch` are plain in-isolate calls (can pass `ctx`, see item 8); `exports.default.fetch` is a real dispatch (separate request context, see item 7 gotcha) |
| HEAD on GET routes | 200, same headers (`content-type: application/json`), **`body === null`**, length 0; no `Content-Length` sent. HEAD on an unknown path: 404 empty body |
| Other methods on a GET-only route | **404** (Hono `notFound`), not 405: `POST /api/ping`, `OPTIONS /api/ping`, `DELETE /api/ping` |
| Streaming | `stream(c, async (s) => { await s.write(...); await s.sleep(10) })` from `hono/streaming`: chunks `chunk-0\n`, `chunk-1\n`, `chunk-2\n` arrive separately, `Transfer-Encoding: chunked`, no content-length |
| Binary | `c.body(new Uint8Array([...]), 200, { "content-type": "image/png", "cache-control": "public, max-age=60" })` -> exact bytes, `Content-Length: 6` |
| R2 stream | `new Response(obj.body, { headers })` returned from a Hono handler works |
| Raw body for webhook signatures | `const raw = await c.req.text()` is byte-exact (odd spacing and `10.50` preserved; HMAC-SHA256 over it verified against `openssl dgst -sha256 -hmac`), and `await c.req.json()` still works afterwards (body cached). A re-serialised body (`10.5`) fails verification -> 401 |
| `hono/cookie` | `setCookie(c, "session", "ok", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 2592000 })` -> `session=ok; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`. `setCookie(c, "csrf", "tok123", { ..., sameSite: "Strict", prefix: "host" })` -> `__Host-csrf=tok123; Path=/; HttpOnly; Secure; SameSite=Strict`; read with `getCookie(c, "csrf", "host")`. `getCookie(c)` returns all (URL-decoded). `deleteCookie(c, "session", { path: "/", secure: true })` -> `session=; Max-Age=0; Path=/; Secure`. Option type: `domain, expires, httpOnly, maxAge, path, secure, sameSite ('Strict'\|'Lax'\|'None' any case), partitioned, priority, prefix ('host'\|'secure')` (`node_modules/hono/dist/types/utils/cookie.d.ts`) |
| `onError` / `notFound` JSON | thrown `Error` -> `500 {"error":"internal_error","message":"kaboom"}`; `HTTPException(418)` -> `418 {"error":"http_exception",...}`; unknown path -> `404 {"error":"not_found","path":"/api/unknown"}`; all `content-type: application/json` |
| Bindings/Variables type pattern | below; type-checks with TS 7.0.2 against both generated and `@cloudflare/workers-types` types |

```ts
export type Bindings = {
	ASSETS: Fetcher; DB: D1Database; BUCKET: R2Bucket; RL_API: RateLimit; RL_AUTH: RateLimit;
	APP_ENV: string; PUBLIC_BASE_URL: string; SECRET_KEY: string; RESEND_API_KEY: string;
};
export type Variables = { requestId: string };
export type AppEnv = { Bindings: Bindings; Variables: Variables };
export const app = new Hono<AppEnv>();   // c.env.DB, c.get("requestId"), c.executionCtx.waitUntil(...)
export default app;                       // export `app` too so tests can call app.request()
```

(With `wrangler types` you can instead write `new Hono<{ Bindings: Env; Variables: Variables }>()`; default generation makes vars literal types such as `APP_ENV: "dev"`, hence `--strict-vars false`.)

---

## Gotchas

- **G1. npm 10.9.9 crashes installing vitest 4.x**: `npm error Cannot read properties of null (reading 'edgesOut')`, even for `npm install -D vitest@4.1.12` alone (the resolver walks vite 8's optional peer `@vitejs/devtools` -> `@vitejs/devtools-vitest` -> `vitest@*` = 5.1.1 and dies). Workaround used: `.npmrc` with `legacy-peer-deps=true`. Not needed with vitest 5.1.1 + `@cloudflare/vitest-plugin`.
- **G2. pool-workers 0.23.0 caps `compatibility_date` at 2026-08-22** (its workerd is 1.20260815.1). A newer date makes the whole test run fail at startup. wrangler 4.166.0 itself accepted 2026-11-15 and rejects only future dates (`Compatibility date "2027-06-01" is in the future and unsupported`).
- **G3. Two runtimes in one project** with pool-workers: tests on workerd 1.20260815.1, `wrangler dev`/deploy bundling on 1.20261119.1.
- **G4. Storage is per test file, not per test** (D1, R2 and rate-limit counters all leak between tests in a file).
- **G5. `reset()` drops the D1 schema too** - re-run `applyD1Migrations` after it.
- **G6. `SELF`/`exports.default` bypass assets and `run_worker_first`** - a route test can pass while production would serve an asset or a 405 instead.
- **G7. `"/api/*"` does not cover `/api`**; add `"/api"` separately if the bare path matters. Patterns are case-sensitive.
- **G8. With `not_found_handling = "404-page"` (or SPA mode) unknown paths never reach the Worker**; non-GET/HEAD on any non-`run_worker_first` path is 405 with an empty body. Hono's `notFound` only ever sees listed prefixes.
- **G9. `_headers` does not touch Worker responses**; Worker middleware does not touch directly-served assets. You need both.
- **G10. `env.ASSETS.fetch(url)` follows html_handling redirects; `env.ASSETS.fetch(c.req.raw)` returns the 307** to the client.
- **G11. Mock Responses must be created inside `mockImplementation`**; a pre-built Response passed to `mockResolvedValue` throws "Cannot perform I/O on behalf of a different request" in the handler.
- **G12. Un-mocked outbound fetches really go to the network** in tests.
- **G13. Fake timers do not affect D1's `datetime('now')`, the rate limiter window, or (DOC) KV/R2/cache simulators.**
- **G14. `exports.default.fetch` does not wait for `waitUntil`**; use `createExecutionContext` + `waitOnExecutionContext`. `app.request` without a ctx makes `c.executionCtx` throw.
- **G15. `.dev.vars` silently feeds tests**; green locally, `undefined` secrets on CI unless `miniflare.bindings` sets them. `.dev.vars.<env>` replaces rather than merges.
- **G16. Bindings are not inherited by `[env.*]`**; forgetting one is only a warning and yields a Worker without that binding (rate limiter would be `undefined` at runtime).
- **G17. Hono cookie `prefix: "host"` adds `__Host-` itself**; passing the name `"__Host-csrf"` together with `prefix: "host"` emitted `__Host-__Host-csrf` (observed during the spike).
- **G18. Hono returns 404, not 405, for a wrong method**, and does not answer OPTIONS unless CORS middleware is added.
- **G19. Locally `CF-Connecting-IP` is spoofable and `request.cf` may be a US/DFW placeholder** when the machine cannot reach Cloudflare; in the Workers pool both are absent.
- **G20. R2 `put` rejects streams of unknown length**; use the request body directly, `FixedLengthStream`, or buffer.
- **G21. Cache API silently skips responses without a cacheable `Cache-Control`.**
- **G22. vitest 5.1.1 + vitest-plugin 1.9.0 prints noisy `"node:inspector" ... is not available at this Worker's compatibility date and flags` lines** when `compatibility_date = "2026-08-01"` and no `nodejs_compat`; tests still pass. Gone with `compatibility_date = "2026-11-19"` or with `compatibility_flags = ["nodejs_compat"]` (both tried).
- **G23. Type mixing**: Node-side files (`vitest.config.ts`, `test-node/*`) and Worker files share one tsconfig here; the Workers `RequestInit` clashed with the harness's fetch type (fixed with `Parameters<typeof server.fetch>[1]`). A real project should use a separate tsconfig for Node-side files. `import.meta.dirname` was not typed in this setup; `fileURLToPath(new URL("./migrations", import.meta.url))` is.
- **G24. `wrangler types` infers secret names from `.dev.vars`** unless `[secrets] required` is declared; default output uses literal types for vars.

## Does not work locally (blunt list)

- `fetchMock` from `cloudflare:test`: gone.
- Per-test isolated storage: gone.
- Asset routing through `SELF.fetch`/`exports.default.fetch`: not simulated.
- `@cloudflare/vitest-pool-workers@0.23.0` with a current `compatibility_date` (> 2026-08-22): fails to start.
- Plain `npm install` of vitest 4.1.12 on npm 10.9.9: crashes.
- Real `request.cf` data in this container: blocked, placeholder used.
- Faking time for D1 SQL functions and for the rate limiter.

## Unverified

- **U1.** Anything about deployed behaviour. No Cloudflare account was used: nothing was deployed, only `wrangler deploy --dry-run`. All D1/R2/rate-limit/cache results are from the local workerd/miniflare simulators.
- **U2.** That production R2 gives create-if-absent for `onlyIf: { etagDoesNotMatch: "*" }` (or `If-None-Match: *`). Proven locally only; the fetched Workers API reference does not document the `*` wildcard for the object form.
- **U3.** Cache API on `*.workers.dev`. The "no-op on workers.dev" statement in the task was **not found** in the current docs source (`workers/runtime-apis/cache.mdx`, `workers/reference/how-the-cache-works.mdx`); not testable without deploying.
- **U4.** That `changes()` inside a `batch()` behaves the same on production D1 (locally it does).
- **U5.** Production rate-limit accuracy; docs say approximate, per location, eventually consistent.
- **U6.** That production overwrites a client-supplied `CF-Connecting-IP` (locally it passes through).
- **U7.** `--max-workers=1 --no-isolate` for shared storage across files (DOC claim, not run).
- **U8.** `vitest@4.1.12` with `@cloudflare/vitest-plugin@1.9.0` (peer range allows it; only vitest 5.1.1 was run with the plugin). `unstable_startWorker()` (deprecated per docs; not run).
- **U9.** The limits "max 100 rules" / "rule under 100 characters" for `run_worker_first` and "up to 100 header rules, 2,000 chars per line" for `_headers` were read in source/docs, not triggered.
- **U10.** The rendered developers.cloudflare.com pages were unreachable; doc statements come from the `production` branch of `cloudflare/cloudflare-docs` on GitHub and could differ from the published site.
- **U11.** `npm audit` details (6 high in the pool-workers tree, 0 in the variant) are reported as printed by npm; advisories were not checked individually.

## Sources

- npm registry: `npm view <pkg> version dist-tags peerDependencies dependencies time` for hono, wrangler, typescript, vitest, vite, miniflare, @cloudflare/vitest-pool-workers, @cloudflare/vitest-plugin, @cloudflare/workers-types, msw, @msw/cloudflare (run 2026-11-21).
- Package files read: `node_modules/@cloudflare/vitest-pool-workers/README.md`, `.../types/cloudflare-test.d.ts`, `.../dist/pool/index.d.mts`, `.../dist/pool/index.mjs`; `node_modules/wrangler/config-schema.json`, `node_modules/wrangler/wrangler-dist/cli.js` (`parseStaticRouting`), `node_modules/wrangler/wrangler-dist/cli.d.ts` (`createTestHarness`); `node_modules/wrangler/node_modules/miniflare/dist/src/workers/assets/router.worker.js`; `node_modules/hono/dist/types/hono-base.d.ts`, `node_modules/hono/dist/types/utils/cookie.d.ts`, `node_modules/hono/dist/types/helper/cookie/index.d.ts`.
- Changelog: `https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md` (0.13.0 breaking changes: isolatedStorage/singleWorker, SELF/env, fetchMock; 1.0.0 rename).
- Docs (prefix `DOCS` = `https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs`):
  `/workers/static-assets/binding.mdx`, `/workers/static-assets/headers.mdx`, `/workers/static-assets/index.mdx`, `/workers/static-assets/routing/worker-script.mdx`, `/workers/static-assets/routing/advanced/html-handling.mdx`, `/workers/static-assets/routing/static-site-generation.mdx`,
  `/workers/testing/vitest-integration/index.mdx`, `/configuration.mdx`, `/test-apis.mdx`, `/isolation-and-concurrency.mdx`, `/known-issues.mdx`, `/mock-outbound-requests.mdx`, `/migration-guides/migrate-to-vitest-plugin.mdx`,
  `/workers/testing/unstable_startworker.mdx`, `/workers/testing/test-harness/index.mdx`, `/get-started.mdx`, `/configure.mdx`, `/prepare-test-state.mdx`,
  `/workers/runtime-apis/bindings/rate-limit.mdx`, `/workers/runtime-apis/cache.mdx`, `/workers/reference/how-the-cache-works.mdx`,
  `/workers/wrangler/configuration.mdx`, `/workers/wrangler/environments.mdx`, `/workers/local-development/environment-variables.mdx`,
  `/d1/worker-api/d1-database.mdx`, `/r2/api/workers/workers-api-reference.mdx`.
