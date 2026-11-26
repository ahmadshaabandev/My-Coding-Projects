# Connectors: Zapier, Make and n8n

Three connectors that let a workflow tool call the Link To Card API with a customer's API key.
Each is a package of its own with its own `package.json`, lock file and tests. None of them is part
of the Worker's bundle, the root `package.json` or `npm test`, and nothing here is deployed with
the Worker.

**Status of all three: not published.** Nothing in this folder has been registered, uploaded,
deployed, submitted or listed anywhere, and no Zapier, Make, n8n, npm or GitHub account was used
to build or test it.

| Folder | What it is | Status |
| --- | --- | --- |
| [`zapier/`](zapier/README.md) | A Zapier Platform CLI app (`linktocard-zapier` 1.0.0, CommonJS on zapier-platform-core 19.3.0, no build step): four actions and two searches. | Not registered with Zapier, not pushed, no users invited, not submitted for the public listing. |
| [`make/`](make/README.md) | A Make custom app as source files in the layout of Make's VS Code extension, Make Apps Editor: base, an API-key connection, six modules, a universal module and two RPCs. | Not created in Make, not deployed, not made public, not submitted for review. |
| [`n8n/`](n8n/README.md) | An n8n community node package (`n8n-nodes-linktocard` 0.1.0, TypeScript, declarative routing) with a credential type. | No public repository yet, not published to npm, not submitted for verification. |
| [`e2e/`](e2e/README.md) | End-to-end checks of the three against this repository's Worker under `wrangler dev`. | Local only. |

The site's `/docs/integrations` page (site feature `integrations`: on for staging, off in
production) says the connectors are being prepared for listing; it never says they are published.

## What they offer

Every step is one request to the public API under `/v1` with the connection's API key
(`Authorization: Bearer ltc_...`), so a workflow gets the same results, limits, counting and Free
plan marks as any other API client. Each connection is checked with `GET /v1/usage`, which counts
nothing.

| Operation | API request | Zapier | Make | n8n | Needs on the server |
| --- | --- | --- | --- | --- | --- |
| Create a card image | `POST /v1/images` | Create Card Image (action) | Create a card image | Image > Create | nothing |
| Create a PDF | `POST /v1/pdf` | Create PDF (action) | Create a PDF | PDF > Create | `PDF_ENABLED` and Browser Run |
| Card from a link | `POST /v1/cards/from-url` | Create Card From Link (action) | Create a card from a link | Link Card > Create From URL | `LINK_CARDS_ENABLED` |
| Check a link preview | `GET /v1/inspect` | Check Link Preview (search) | Check a link preview | Link Preview > Check | nothing |
| Start bulk PDFs | `POST /v1/batches` | Start Bulk PDFs (action) | Start bulk PDFs | Bulk PDF > Start | `BATCH_ENABLED` and PDFs |
| Get a batch | `GET /v1/batches/{id}` | Find Batch (search) | Get a batch | Bulk PDF > Get | `BATCH_ENABLED` and PDFs |
| A part of a batch's ZIP | `GET /v1/batches/{id}/zip?part=N` | Find Batch's zip files, downloaded when a later step uses one | Get a batch with "Download the zip file" and "Zip part" | Bulk PDF > Download ZIP | `BATCH_ENABLED` and PDFs |
| Any other request | any path under `/v1` | not offered | Make an API call (universal) | not offered | depends on the path |

Batches follow the final API: the answer of `POST /v1/batches` and `GET /v1/batches/{id}` with
`pages`, `credits_used`, `started_at`, `finished_at`, `cancelled_at`, each row's `filename`, and
`zip_parts`. The API packs a batch's finished PDFs into ZIP parts of at most 500 files and 2 GiB
each, in row order (decision D9), so most batches have one part; every connector downloads one
part at a time. Zapier keeps files of up to 1 GB (zapier-platform-core's own upload limit), so
Find Batch offers no file for a part larger than that. Without a file name pattern the documents
are named `certificate-1.pdf`, ... after a starter template and `document-1.pdf`, ... for an own
template. Errors are shown with the API's own message: 403 `plan_required` for more rows than the
plan takes (400 above every plan), 404 for an unknown template, 409 `conflict` while two batches
are queued or running.

In production today `PDF_ENABLED`, `BATCH_ENABLED` and `LINK_CARDS_ENABLED` are "false"
(`[env.production.vars]` in `../wrangler.toml`), so only Create a card image and Check a link
preview would work there; the other steps stop with the API's 503 message, for example "PDF
rendering is not enabled yet." Staging has every switch on. The `email` size (1200 x 400), which
all three size lists offer, is not behind a switch but exists only once this release is deployed.

Not in the connectors:

- **The PDF toolkit** (`/v1/pdf-tools/*`): contract T2 names no toolkit step, and its file inputs
  (a URL, base64 or a stored PDF id) and file outputs would need each platform's own file handling,
  which could not be tried here. Make's universal module reaches it with the connection's key.
- **Cancelling or listing batches and revoking certificates** (`POST /v1/batches/{id}/cancel`,
  `GET /v1/batches`, `POST /v1/certificates/{id}/revoke`): in the API, not as steps; Make's
  universal module reaches them (the e2e check lists batches that way).
- **Triggers**: the API sends no webhooks, so a workflow waits for a batch by asking Get a batch
  every few seconds until its status is `done`, `partial`, `failed` or `cancelled`.

## Kept in step with the service

The platforms run these files as they are, so they cannot import `src/config.ts` or the PDF
templates and keep copies of the fixed choices (sizes, formats, PDF page sizes, the PDF starter
templates and their fields). `tests/node/zapier-connector-sync.test.ts`,
`tests/node/make-connector-sync.test.ts` and `tests/node/n8n-connector-sync.test.ts` in the Worker's
Node suite fail when a copy drifts, when a Make request no longer matches `openapi.yaml` or the
Worker's accepted fields, when a sample contradicts the plans, or when a lock file names a
forbidden package. Change the Worker first, then the connectors.

## How they were checked (2026-11-26)

| Package | Its own checks | Against the real Worker (`e2e/`) |
| --- | --- | --- |
| `zapier/` | `npm test` 156 passed (12 files, offline with nock and appTester); `npm run typecheck` exit 0; `npm run validate` "structurally sound" | 42 of 42, including the file hydrators through zapier-platform-core's real `z.stashFile` with a local stand-in for Zapier's file storage, and `zapier-platform invoke` |
| `n8n/` | `npm test` 73 passed (4 files); typecheck, `n8n-node lint` and `n8n-node build` exit 0; `@n8n/scan-community-package` 0.45.0 passed on the local folder; `npm run check:engine` 17 of 17 through n8n-core's `RoutingNode` | 24 of 24 through n8n-core's `RoutingNode` and its own HTTP client |
| `make/` | `npm test` 168 passed (5 files: file layout, Make's JSON schemas, the API contract, IML rules, Make's parameter validator); `npm run typecheck` exit 0 | 32 of 32 through a small executor of the app's JSON files |
| Worker | the three sync tests: 34 passed (3 files) | |

The end-to-end runs used a throwaway local account and key, and a stand-in for Browser Run that
answers with a fixture PDF, so batches went through the Worker's real queue consumer, charging,
storage and ZIP route. `e2e/README.md` lists every stand-in.

## Publishing: what Ahmad does

The detailed steps, with their sources, are in each package's README. In short:

### Before any of them

1. Decide which steps the first version lists. A step whose feature is off in production stops
   with "... is not enabled yet." Switch those features on in production first (each is your
   approval: `PDF_ENABLED` with Browser Run, `BATCH_ENABLED`, `LINK_CARDS_ENABLED`), or remove the
   step from that version.
2. Test each connector against staging with a staging API key first. Each one can point at
   another address for that (Zapier: the `LTC_BASE_URL` version environment variable; Make: the
   connection's advanced "API address"; n8n: the credential's Base URL).
3. Create one API key per platform in the dashboard, so each can be revoked on its own.

### Zapier (`zapier/README.md`, "Publish it")

- **Accounts:** a Zapier account. `login` stores a deploy key in `~/.zapierrc`: a secret, never
  commit or share it.
- **Commands**, in `integrations/zapier`: `npm ci`, `npm run check`, `npx zapier-platform login`,
  `npx zapier-platform register "Link To Card"` (commit the `.zapierapprc` it writes),
  `npx zapier-platform push`; test every step in the Zap editor, first against staging with
  `env:set 1.0.0 LTC_BASE_URL=...` and then `env:unset` before anyone else uses that version;
  `users:add` for private testers; `npx zapier-platform validate --fail-for-publishing`, then
  `npx zapier-platform promote 1.0.0`.
- **Review:** `promote` runs Zapier's integration checks and, for an app that passes, links to a
  form; Zapier's team then approves or declines. The publishing requirements, any minimum number of
  users, the review time and fees could not be read on docs.zapier.com here: read the pages the
  README links before applying.

### Make (`make/README.md`, "Set it up in Make" and "Request publication")

- **Accounts and tools:** a Make account (note its zone, for example eu1), a Make API token with
  the custom-app scopes (`sdk-apps:read`, `sdk-apps:write`), VS Code 1.109.5 or later with the
  extension Make Apps Editor (`Integromat.apps-sdk`).
- **Steps:** create an empty app in Make (label "Link To Card", icon `make/assets/icon-512.png`);
  open `integrations/make` in VS Code; right-click `app/makecomapp.json` > Deploy to Make; fill in
  the origin the extension writes (app id, zone address, `../.secrets/apikey`, which `.gitignore`
  keeps out of git); deploy again and commit the `idMapping` it records. Then run the README's
  twelve-step test plan on staging. Its first steps decide whether the expressions need a mechanical
  change (argument separators and quotes, how empty values are left out).
- **Review:** a new app is private. Making it public gives an invite link (Make's docs, read only
  in search summaries, say this cannot be undone); approval for everyone follows Make's review,
  which asks for tested scenarios. Decide before the review whether to keep the "API address"
  field, which exists for testing.

### n8n (`n8n/README.md`, "Publishing and verification")

- **Accounts:** a public GitHub repository for the package alone (`package.json` names
  `github.com/ahmadshaabandev/n8n-nodes-linktocard`, which does not exist yet: publishing from this
  repository would make the whole service public), an npm account with two-factor authentication,
  an account on n8n's Creator Portal (creators.n8n.io/nodes), and a self-hosted n8n for a test.
- **Steps:** copy `integrations/n8n` (with `.github/`, `.npmrc`, `.gitignore`, `package-lock.json`,
  `LICENSE.md`; without `node_modules/` and `dist/`) to the new repository and push `main`; save a
  granular npm token as the Actions secret `NPM_TOKEN` for the first release; `npm run release`
  (the pushed tag runs the publish workflow, which publishes with provenance); check
  `npx @n8n/scan-community-package n8n-nodes-linktocard`; switch npm to trusted publishing and
  revoke the token; install it in n8n and run every operation; submit it on the Creator Portal.
- **Review:** n8n's verification; its form, timing and the steps after approval could not be
  read here.

## What could not be tested here

- **Anything on the platforms:** accounts, `register`/`push`/`promote`, the Zap editor, deploying
  to Make, Make's scenario editor, npm publishing, provenance, the Creator Portal, reviews. Several
  vendor documentation sites could not be opened in these sessions; each README marks what it
  took from search summaries or source code instead ([unverified] or "not verified").
- **The platforms' runtimes:** Zapier's real file storage and how file pointers inside line items
  show in the Zap editor; Make's own IML engine (the e2e executor follows the Make README's reading
  of the built-in functions, which is unverified); a running n8n (editor, credential test button,
  n8n's real credential helper, binary storage modes).
- **The live service:** the end-to-end runs used a local Worker, not staging or production.
  Browser Run exists only on Cloudflare, so the PDFs were a fixture. The local Worker could not
  resolve outside host names, so cards from real pages and checks of real pages were only seen
  refused (a local address) or failing with 422 `page_fetch_failed`. A batch with more than one
  ZIP part needs more than 500 rows on Starter or Pro and was covered by unit tests only.
- **Shared outgoing addresses:** if a platform sends many users' requests from a few IP addresses,
  the API's per-IP limit (`RL_IP`), which applies before the per-key limits, could slow them all
  down. How many addresses each platform uses was not checked.
