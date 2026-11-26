# n8n-nodes-linktocard

This is an n8n community node. It lets you use [Link To Card](https://linktocard.com) in your n8n
workflows.

Link To Card is an API that makes social-card images (the picture a link shows when it is shared)
and PDF documents from HTML templates.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow
automation platform.

**Status: version 0.1.0, not published to npm yet.** It has been run through n8n's routing engine
and n8n's HTTP client against a local copy of the Link To Card service, but not yet inside a
running n8n, and not against the live API. See
[What was tested and what was not](#what-was-tested-and-what-was-not).

[Installation](#installation) ·
[Operations](#operations) ·
[Credentials](#credentials) ·
[Compatibility](#compatibility) ·
[Usage](#usage) ·
[Resources](#resources) ·
[Version history](#version-history) ·
[Development](#development) ·
[Publishing and verification](#publishing-and-verification-maintainers)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in
the n8n community nodes documentation. The npm package name is `n8n-nodes-linktocard`.

## Operations

| Resource | Operation | What it does | Link To Card endpoint |
| --- | --- | --- | --- |
| Image | Create | Renders a card image from a starter template, one of your saved templates, or your own HTML and CSS. A card that was made before is returned from storage. | `POST /v1/images` |
| PDF | Create | Renders a PDF document from a PDF starter template (such as invoice or certificate), a saved template, or your own HTML and CSS. | `POST /v1/pdf` |
| Link Card | Create From URL | Makes a card image from a web page's own title, description and logo. Fields you set win over the page's. | `POST /v1/cards/from-url` |
| Bulk PDF | Start | Queues one PDF per row of data; Link To Card renders them in the background. | `POST /v1/batches` |
| Bulk PDF | Get | Returns a batch's progress, the link to each finished PDF and the batch's ZIP parts. | `GET /v1/batches/{id}` |
| Bulk PDF | Download ZIP | Returns one part of the batch's ZIP of finished PDFs as n8n binary data. | `GET /v1/batches/{id}/zip?part=N` |
| Link Preview | Check | Checks one page's Open Graph and Twitter tags and its og:image, with what to change for each check that does not pass. | `GET /v1/inspect` |

Image, PDF and Link Card can return the file itself as n8n binary data ('Download File'), or a
link to the stored file (the default). Operations spend your plan's images exactly as the same API
call does; [the API documentation](https://linktocard.com/docs/api) has the counting rules.
`GET /v1/inspect` never counts as an image.

## Credentials

1. Sign in at [linktocard.com/dashboard](https://linktocard.com/dashboard) and create a key under
   **API keys**. A key starts with `ltc_` and is shown once.
2. In n8n, create a **Link To Card API** credential and paste the key.
3. Leave **Base URL** as `https://linktocard.com`. It exists for testing against another
   Link To Card deployment.

n8n tests the credential with `GET /v1/usage`, which renders nothing. The key is sent as
`Authorization: Bearer ltc_...` ([Authentication](https://linktocard.com/docs/api#authentication)).

## Compatibility

- A declarative node (n8n's routing engine sends the requests; there is no `execute()` method),
  n8n nodes API version 1.
- Built and type-checked against `n8n-workflow` 2.49.5 with `@n8n/node-cli` 0.58.7, and it passes
  `n8n-node lint` and a local run of `@n8n/scan-community-package` 0.45.0.
- It has not been run in a running n8n yet, so no minimum n8n version is claimed. Bulk PDF > Get
  builds its URL itself instead of with n8n's `toPathSegment()` expression function, which n8n
  documents as needing n8n 2.46.1 or later.

## Usage

### Template data

Fill a template's `{{field}}` placeholders with **Template Fields** (one name and value per entry),
or with **Additional Fields > Data (JSON)** for lists and numbers, such as the `items` of an
invoice. When both name the same field, the Template Fields entry wins.

Keep fields that contain `{{...}}` for Link To Card (inline HTML, a header or footer, a file name
pattern) in **Fixed** mode. In Expression mode n8n reads `{{...}}` as its own expression.

### Files instead of links

By default an operation returns the API's JSON, including `url`, a public link to the stored file
that works until `expires_at`. Turn on **Download File** to get the image or PDF as binary data
instead (in the field named by **Put Output File in Field**, `data` by default), for example to
attach it to an email or upload it somewhere. The JSON part of that item then holds what the
response headers say: `id`, `url`, `cached`, `warnings`, and for PDFs `filename`, `pages` and
`credits_used`.

**Simplify** returns at most ten of the most used fields instead of the full response.

### Bulk PDFs from a sheet

**Bulk PDF > Start** sends one request per input item, so one batch per item. To make one PDF per
spreadsheet row, combine the rows into one item first (for example with n8n's Aggregate node) and
set **Rows** to an expression that returns that list. Each row is one object of template data.

The PDFs are rendered in the background. Keep the `id` from Start, wait, then call
**Bulk PDF > Get** with it to read the status and each finished row's link. Ask every few
seconds, not in a tight loop, until `status` is `done`, `partial`, `failed` or `cancelled`.

**Bulk PDF > Download ZIP** returns the finished PDFs as one ZIP file in the binary field named by
**Put Output File in Field**. Link To Card packs them into ZIP parts of at most 500 PDFs and 2 GiB
each, in row order, so most batches have one part; Get lists them under `zip_parts`, and **ZIP
Part** (1 by default) picks one. The JSON part of the item holds `filename`, `part`, `parts` and
`bytes`. Asking for a part the batch does not have stops with the API's message, which says how
many parts there are.

Without a **File Name Pattern**, the PDFs are named after the template and the row number:
`certificate-1.pdf`, `certificate-2.pdf`, ... for a starter template, `document-1.pdf`, ... for one of
your saved templates. **Certificate Verification**, when not added, is on for the certificate
template and off for the others.

### When an operation answers 503

Link To Card switches some features on separately (PDFs, bulk PDFs, link cards). While a feature is
off, its endpoint answers `503` with the code `not_configured`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Link To Card API documentation](https://linktocard.com/docs/api)

## Version history

- 0.1.0: first version (not published yet).

## Development

Node.js 22 or later (the n8n starter's prerequisite).

```bash
npm install --ignore-scripts
npm test            # vitest: descriptions, simulated routing, hooks, package rules
npm run typecheck   # the node and credential, then the tests
npm run lint        # n8n-node lint (n8n's community-node rules, Cloud rules included)
npm run build       # n8n-node build: tsc, then copies the icons and codex into dist/
```

- `--ignore-scripts`: `n8n-workflow` (a development dependency here; n8n provides it at run time)
  depends on `isolated-vm`, which declares Node.js 24 or later and compiles itself in an install
  script. Nothing in this package needs it.
- `.npmrc` sets `legacy-peer-deps=true`. `@n8n/node-cli` reaches a LangChain package whose required
  peer is a browser-automation test runner; with automatic peer installs off it is not installed,
  and `n8n-workflow` is listed as a development dependency instead.
- Tests live in `test/`, outside `nodes/` and `credentials/`, so they are never built into `dist/`.
  `n8n-node lint` lints them too, so they avoid `process`, timers and `console`.
- `test/helpers.ts` re-implements the part of n8n's routing engine this node uses (read from
  `n8n-core` 2.49.7, `execution-engine/routing-node.js`), using `n8n-workflow`'s own
  `NodeHelpers` for which parameters are displayed. The routing uses no n8n expressions except
  the credential's base URL, and a test checks that, so the simulated requests match what n8n
  sends without evaluating expressions.
- `npm run check:engine -- <folder>` runs the built node through n8n-core's real `RoutingNode`
  (HTTP replaced by a recorder). n8n-core is not a dependency of this package; the script's header
  says how to install it in a separate folder.
- In the Link To Card repository, `tests/node/n8n-connector-sync.test.ts` checks that the sizes and
  formats listed in `nodes/LinkToCard/shared/options.ts` match the service's `src/config.ts`.

## Publishing and verification (maintainers)

Ahmad's steps to publish this package to npm and ask n8n to verify it. Sources are listed at the
end; facts marked *(unverified)* could not be checked from the vendor's own pages.

### Why a separate public repository

- n8n requires every community node to be published from a GitHub action with an npm provenance
  statement from May 1st 2026, the repository must be public, and its URL must match npm's.
- npm does not generate provenance for private repositories, and `package.json` `repository` must
  match the publishing repository exactly (case-sensitive).
- n8n's scanner downloads the attested commit from public GitHub.
- `n8n-node release` requires the branch `main` and a clean working tree, and tags bare versions
  (`0.1.0`).

Publishing from the Link To Card monorepo would make the whole repository, including the service,
public. Use a dedicated repository instead: `package.json` names
`https://github.com/ahmadshaabandev/n8n-nodes-linktocard`, which does not exist yet. If you use
another name, change `repository.url` to match it exactly.

### Accounts you need

- GitHub: the public repository above.
- npm: an account with two-factor authentication.
- n8n Creator Portal ([creators.n8n.io/nodes](https://creators.n8n.io/nodes)) for the submission.
  How you sign in there is *(unverified)*.
- For a test in n8n before submitting: a self-hosted n8n where you can install community nodes, and
  a Link To Card API key (staging or production).

### Steps

1. **Check `package.json`.** `author` is "Ahmad Shaaban <support@linktocard.com>": change the email
   if your npm account uses another one. n8n checks that the author matches between npm and the
   repository.
2. **Create the repository.** Make the public repository and copy the contents of
   `integrations/n8n` to its root, including `.github/`, `.npmrc`, `.gitignore`,
   `package-lock.json` and `LICENSE.md`, but not `node_modules/` or `dist/`. Push to `main`. The CI
   workflow (`.github/workflows/ci.yml`) then runs lint, typecheck, tests and build. These workflow
   files do nothing inside the monorepo, because GitHub only runs workflows from the repository
   root.
3. **Give the publish workflow npm access (first release).** Create a granular npm access token
   with read and write access and save it in the repository as the Actions secret `NPM_TOKEN`.
   Whether npm lets you set up trusted publishing before the package's first version exists is
   *(unverified)*, which is why the first release uses a token.
4. **Release.** In the new repository run `npm install --ignore-scripts`, `npm test`, then
   `npm run release`. Locally, `n8n-node release` bumps the version, writes the changelog, commits,
   tags, pushes and creates a GitHub release; it does not publish to npm. The pushed tag starts
   `.github/workflows/publish.yml`, which runs the tests, then `n8n-node release` in CI: lint,
   build, and `npm publish` with provenance.
5. **Check the result.** The version's npm page should show provenance. Then run
   `npx @n8n/scan-community-package n8n-nodes-linktocard`; it must pass (exit code 0).
6. **Switch to trusted publishing.** In the package settings on npmjs.com, add a trusted publisher:
   GitHub Actions, this repository, workflow `publish.yml`, and allow `npm publish`
   (`n8n-node release` runs `npm publish`; configurations created after Sep 03, 2026 only allow
   `npm stage publish` unless you choose it). It needs npm 11.5.1 or later, which the workflow
   installs. A new configuration must complete a publish within 2 days or it expires. After that
   publish, delete the `NPM_TOKEN` secret and revoke the token.
7. **Test in n8n.** Install the published package in a self-hosted n8n
   ([installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)), create the
   credential and run each operation once, with Download File on and off (see the list below).
8. **Submit for verification** at [creators.n8n.io/nodes](https://creators.n8n.io/nodes). The form,
   the review time and what happens after approval are *(unverified)*. Verified nodes can be
   installed from the nodes panel by users with verified community nodes enabled, on self-hosted
   n8n and n8n Cloud.

Later releases: `npm run release` in the repository; the tag publishes the new version.

What n8n's verification guidelines ask for, and where this package stands: one third-party
service per package (yes); MIT license (yes); no runtime dependencies (yes); no environment
variable or file system access in the node (yes); English only (yes); the linter and scanner pass
(yes, locally); published from GitHub Actions with provenance (after step 4); public repository
matching npm (after step 2).

## What was tested and what was not

Tested here (Node.js 22.23.5, 2026-11-26):

- `npm test`: 73 unit tests of the node and credential descriptions, every operation's method,
  path, body and query through the simulated routing engine, the preSend and postReceive hooks
  (binary output for images, PDFs and ZIP parts, error handling, Simplify), and the package and
  codex rules.
- `npm run check:engine`: the built node run through n8n's own routing engine
  (`n8n-core` 2.49.7 `RoutingNode`, `n8n-workflow` 2.49.5) with only the HTTP call replaced by a
  recorder: 17 cases covering every operation, n8n evaluating the credential's base URL and an
  expression in 'Rows', file and ZIP downloads stored as n8n binary data, and HTTP errors during a
  download. All passed.
- `node integrations/e2e/n8n.cjs <n8n-core folder>` in the Link To Card repository (see
  `integrations/e2e/README.md`): the built node, run by n8n-core's `RoutingNode`, with its
  requests sent by n8n-core's own HTTP client to the real Link To Card Worker under `wrangler dev`
  (a local account and key; a stand-in for the PDF renderer that answers with a fixture PDF).
  Only n8n's credential helper was replaced, by one that applies this credential's
  `authenticate` header. 24 of 24 checks passed: the credential test and a wrong key (401), Image
  > Create as JSON and as a downloaded PNG, the `email` size with Simplify, an invalid field name,
  PDF > Create as JSON and as a downloaded PDF under its own name, Link Card > Create From URL
  reaching its route, Bulk PDF > Start with Rows from an n8n expression, Get once done (file names
  from the pattern, links, certificates, one ZIP part), Download ZIP of part 1 (a valid ZIP of the
  three PDFs) and of part 2 (404 with the API's message), an unknown batch (404), 26 rows on Free
  (403 `plan_required`), an unknown template (404), verification off with page setup, and Link
  Preview > Check reaching its route.
- `npm run typecheck`, `n8n-node lint` (0 errors, 0 warnings), `n8n-node build`, and
  `@n8n/scan-community-package` 0.45.0 on the local folder after that build ("has passed the
  security checks that run before publishing"; the provenance and source checks only run on a
  published version).

Not tested, because it needs an account, a running service or a running n8n:

- **Inside a running n8n**: the editor UI, the credential test button, n8n's real credential
  helper and binary data storage modes. `n8n-node dev` needs a local n8n (from n8n 3.0, in Docker
  or Podman) and was not run.
- **Against the live Link To Card API and real PDFs**: the requests went to a local copy of the
  service; real PDF rendering (Browser Run) only exists on staging and production.
- **A card from a real page and the check of a real page**: the local service could not resolve
  outside host names here, so only its refusal of a local address and its 422
  `page_fetch_failed` were seen.
- **A batch with more than one ZIP part**: that needs more than 500 rows (Starter or Pro); only
  the unit tests and the engine check cover a later part.
- **Publishing**: the GitHub repository, npm publish, provenance, trusted publishing and the
  Creator Portal were not used. Which npm version GitHub's `lts/*` Node.js ships was not checked;
  the publish workflow installs npm 11 for that reason.
- Node.js 24 (which `isolated-vm` declares) was not used; installs here used `--ignore-scripts`.

## Sources

Read for this package (n8n's and npm's documentation was read from the source files they are
published from, on raw.githubusercontent.com, because docs.n8n.io and docs.npmjs.com could not be
opened from the build environment):

- n8n-nodes-starter: README, package.json, `.github/workflows/publish.yml` and `ci.yml`,
  https://github.com/n8n-io/n8n-nodes-starter
- Verification guidelines:
  https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines
- UX guidelines: https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines
- Codex files: https://docs.n8n.io/connect/create-nodes/build-your-node/reference/codex-files
- Choosing a node building style:
  https://docs.n8n.io/connect/create-nodes/plan-your-node/choose-a-node-building-style
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- Package sources from registry.npmjs.org: `@n8n/node-cli` 0.58.7 (release, build, lint commands
  and the ESLint config), `@n8n/eslint-plugin-community-nodes` 0.42.0,
  `@n8n/scan-community-package` 0.45.0, `n8n-workflow` 2.49.5, `n8n-core` 2.49.7
  (`execution-engine/routing-node.js`), `@n8n/backend-network` 1.23.7 (how `encoding` reaches the
  HTTP client).
