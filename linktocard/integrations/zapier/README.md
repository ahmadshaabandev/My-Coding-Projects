# Link To Card for Zapier

A Zapier integration built with the Zapier Platform CLI. Every action is one request to the public
API under `/v1` with the connection's API key, so a Zap gets the same results, limits and counting
as any other API client. It is a package of its own: it is not part of the Worker's bundle, its
`package.json` or its test run.

**Status: not registered, not pushed, not listed.** Nothing here has been uploaded to Zapier.

## What it offers

| Zapier step | Key | Request | Notes |
| --- | --- | --- | --- |
| Create Card Image (action) | `create_card_image` | `POST /v1/images` | Template dropdown from `GET /v1/templates`; a starter's fields appear as inputs, Data takes any key; size and format. |
| Create PDF (action) | `create_pdf` | `POST /v1/pdf` | A PDF starter (its fields and line items), one of your own templates, or HTML and CSS. |
| Create Card From Link (action) | `card_from_link` | `POST /v1/cards/from-url` | Page URL, optional template, overrides, size, format. |
| Start Bulk PDFs (action) | `start_bulk_pdfs` | `POST /v1/batches` | Rows as Zapier line items (a starter's fields) or as JSON; file name pattern; verification; page setup. |
| Find Batch (search) | `get_batch` | `GET /v1/batches/{id}`, and `GET /v1/batches/{id}/zip?part=N` when a later step uses a zip | Returns `finished` and, once finished, a zip file for every ZIP part (`zip_parts[].file`; `zip_file` is part 1). An unknown id is "nothing found". |
| Check Link Preview (search) | `check_link_preview` | `GET /v1/inspect` | Adds `ok`, counts of failed, warning and passed checks, and a list of problems with their fixes. |

The connection asks for an API key (a password field) and checks it with `GET /v1/usage`, which
counts nothing. Its label is the plan, for example "Starter plan", plus " at <host>" whenever the
app talks to something other than linktocard.com.

Card and PDF actions also return a `file` (Find Batch: `zip_file` and a `file` per ZIP part). That
is a pointer that Zapier turns into a real file only when a later step uses it, for example an
upload to cloud storage. The plain `url` of an image or PDF works as well: it is public until the
plan's storage time ends. A ZIP part's `url` needs the API key, so later steps use its `file`.

The API packs a batch's finished documents into ZIP parts of at most 500 files and 2 GiB each, in
row order, and lists them as `zip_parts`; most batches have one part, and then `zip_file` holds
every document. Zapier keeps files of up to 1 GB (`UPLOAD_MAX_SIZE` in zapier-platform-core 19.3.0,
"1GB, in zapier backend too"), so a part larger than that gets no `file`; its documents' own PDF
links in `rows` still work. A test compares the app's limit with the installed core's.

Start Bulk PDFs answers with the API's own error when it refuses a batch: 403 `plan_required` when
a higher plan takes that many rows (400 above every plan), 404 for an unknown template, 402 when
not enough images are left, 409 `conflict` while two batches are already queued or running.
Without a File Name Pattern, documents are named after the template and the row number
(`certificate-1.pdf`, ...; `document-1.pdf`, ... for your own templates).

Which actions work where depends on the API's switches, not on this app:

| Action | Needs on the server |
| --- | --- |
| Create Card Image, Check Link Preview | nothing: they work wherever the API runs |
| Create PDF | `PDF_ENABLED` and Browser Run (production has PDFs off today) |
| Create Card From Link | `LINK_CARDS_ENABLED` |
| Start Bulk PDFs, Find Batch | `BATCH_ENABLED` and PDFs |

While a switch is off, the step fails with the API's own message, for example "PDF rendering is not
enabled yet." Invite users or apply for the public listing only once every action you list works in
production.

## Files

```
index.js            the app definition Zapier runs (CommonJS, no build step)
lib/                authentication, middleware, request helpers, fields, hydrators, constants, samples
creates/            the four actions
searches/           the two searches
test/               Vitest + nock + Zapier's appTester, fully offline
CHANGELOG.md        one entry per version; `zapier-platform promote` reads it
.gitignore          also decides what `push` uploads as source.zip
```

`lib/constants.js` copies the choices no endpoint lists (sizes, formats, PDF page sizes, the PDF
starter templates and their fields). `tests/node/zapier-connector-sync.test.ts` in the Worker fails
when a copy drifts from `src/config.ts`, `src/pdf/templates` or `src/billing/plans.ts`, so change
the Worker first and then this file.

## Develop and test

Node 22 or newer (zapier-platform-cli 19.3.0 requires it). From this folder:

```bash
npm install          # this folder only; the Worker's package.json is not touched
npm test             # Vitest, offline: every request is answered by nock
npm run typecheck    # tsc over the JavaScript, with zapier-platform-core's own types
npm run validate     # zapier-platform validate --without-style: schema checks, no network
```

`npm run check` runs all three. The CLI is a dev dependency, so `npx zapier-platform <command>`
uses the pinned version. Version 19 names the command `zapier-platform`; older guides say
`zapier register` and `zapier push`, which is the same thing under the old name (the `zapier` binary
is gone in 19.x).

### Try it against a local or staging API

`LTC_BASE_URL` points the app at another origin (`https://` only; `http://` only for localhost).
Users never see it. For `zapier-platform invoke`, put it in a `.env` file in this folder together
with a key (the `.gitignore` keeps `.env` out of git and out of the upload):

```
LTC_BASE_URL=http://127.0.0.1:8787
authData_api_key=ltc_...
```

```bash
npx zapier-platform invoke auth test
npx zapier-platform invoke auth label
npx zapier-platform invoke create create_card_image -i '{"template": "blog", "data__title": "Hello"}'
npx zapier-platform invoke search get_batch -i '{"id": "bat_..."}'
```

Template fields are sent as `data__<key>`, line items of a PDF as `item__<key>`, batch rows as
`row__<key>`. Local `invoke` cannot produce files (the CLI lists "output hydration" and "file
upload" among its local limits), so `file` stays a pointer there.

## Publish it: what Ahmad does

Everything below needs a Zapier account and a connection to zapier.com, so none of it could be
run here. The command reference is the CLI's own (`packages/cli/docs/cli.md` in
github.com/zapier/zapier-platform, version 19.3.0).

### 1. Log in and register (once)

```bash
npx zapier-platform login            # add --sso if you sign in to Zapier with SSO
npx zapier-platform register "Link To Card"
```

`login` stores a deploy key in `~/.zapierrc`. That key is a secret: never commit or share it (in CI
it goes in the `ZAPIER_DEPLOY_KEY` environment variable instead).

`register` asks for what it is not given. The description must be 140 characters or less, for
example: "Card images, PDF documents and link preview checks from templates and your data." Answer
`private` for the audience. The choices for your role and the category come from Zapier's server
and could not be listed here; the CLI's own example uses `--role employee --category
marketing-automation`. The homepage is `https://linktocard.com`.

`register` writes `.zapierapprc`, which ties this folder to the integration. The CLI docs say to
check it into source control, so commit it.

### 2. Push

```bash
npm run check
npx zapier-platform push
```

`push` builds and uploads the version in `package.json` (`1.0.0`). Its build also runs Zapier's
server-side checks, so it needs the network. The upload includes `source.zip`, which is this folder
minus what `.gitignore` lists: here that was checked with the CLI's own zip code, and it holds the
source, tests and lock file, but no `node_modules` and no `.env`.

### 3. Test in the Zap editor

The pushed version is private: you and the people you invite can use it. In the Zap editor:

1. Create an API key for Zapier in the Link To Card dashboard (**API keys**), named "Zapier", so it
   can be revoked on its own.
2. Add a Link To Card step and connect with that key. The connection's label is your plan, for
   example "Starter plan".
3. Test each action with a real step: Create Card Image with the `blog` starter; Check Link Preview
   with a page of your own; Create PDF, Create Card From Link and Start Bulk PDFs once their switches
   are on; Find Batch with the id that Start Bulk PDFs returned, until `finished` is true.
4. Add a later step that uses `file` (or `zip_file`), for example an upload to cloud storage, to see
   that the file arrives.

To test against staging first, set the base URL on the pushed version and connect with a staging key:

```bash
npx zapier-platform env:set 1.0.0 LTC_BASE_URL=https://linktocard-staging.names-on-base.workers.dev
```

Be careful: the CLI copies a version's environment variables forward to every version created after
it. Remove it before you push another version or invite anyone, and check that it is gone:

```bash
npx zapier-platform env:unset 1.0.0 LTC_BASE_URL
npx zapier-platform env:get 1.0.0
```

A connection made while the override was set says " at <staging host>" in its name, so it cannot be
mistaken for a production one; make a new connection with a production key afterwards.

### 4. Invite users (still private)

```bash
npx zapier-platform users:add someone@example.com 1.0.0
npx zapier-platform users:links        # shareable invite links
```

Invited users see the integration's name, logo and description and can build Zaps with it.
`users:remove` turns that user's Zaps off at once.

### 5. Apply for the public listing

```bash
npx zapier-platform validate --fail-for-publishing   # server checks; non-zero on publishing tasks
npx zapier-platform promote 1.0.0
```

What the CLI source says: `promote` needs the version's entry in `CHANGELOG.md` and the
registration details, and runs Zapier's integration checks. For a private integration that passes
them, it answers with a link to a form for the extra information; the Zapier team then approves it
or declines with feedback. `validate --fail-for-publishing` is "not a complete substitute for the
checks `zapier-platform promote` runs".

Not verified here (docs.zapier.com did not load in this session; these come from search summaries
only): the publishing requirements (owning the API you integrate, public API documentation, a logo
in their format), the "Beta" label after approval, a minimum number of users with live Zaps before
you apply, how long the review takes, and whether there is a fee. Read these pages before applying:

- https://docs.zapier.com/platform/publish/integration-publishing-requirements
- https://docs.zapier.com/platform/publish/integration-checks-reference
- https://docs.zapier.com/platform/publish/branding-guidelines

### Later versions

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, `push`, then:

- non-breaking change: `npx zapier-platform migrate 1.0.0 1.0.1 10` (10 percent first), then 100.
  Users are not emailed.
- breaking change: `npx zapier-platform deprecate 1.0.0 <YYYY-MM-DD>`. The date must be at least 3
  weeks away; Zapier emails users 14 days before it and pauses Zaps that were not updated.

If Zapier itself releases a new version of the integration, you cannot push to the promoted
version, promote or migrate until you have run `npx zapier-platform pull`.

## How it behaves, and why

- **The API key goes only to the API's origin.** `beforeRequest` adds
  `Authorization: Bearer <key>` only when the request is for `LTC_BASE_URL` (default
  `https://linktocard.com`); the file hydrator only downloads from that origin.
- **Bodies are sent as JSON text.** Zapier core removes every `{{...}}` from the top-level strings of
  an object body before sending it (`normalizeEmptyBodyFields` in core's `tools/cleaner.js`; a test
  pins this down). That would empty inline HTML placeholders and the batch file name pattern, so
  the app serializes bodies itself, and core leaves a string body alone.
- **Query values are not protected.** Core also removes `{{...}}` from query values (the page URL of
  Check Link Preview), however they are encoded. A page address with double curly braces in its
  query cannot be checked through Zapier.
- **File name patterns take `[key]` and `[n]`** as well as `{{key}}` and `{{n}}`, so a pattern never
  needs double curly braces in a Zapier field. Square brackets cannot be part of a file name anyway:
  the API removes them when it cleans the name.
- **Errors are the API's.** The `{ "error": { "code", "message" } }` envelope becomes a Zapier error
  with that message and code; 401 becomes an authentication error with a hint about the key; 429 is
  left to Zapier core, which throws its ThrottledError with the `Retry-After` delay.
- **Find Batch reads 404 as "nothing found"**, because a search must answer with a list.
- **The ZIP download reads its own errors.** A streamed response's body cannot be read by the
  app's error middleware, so the ZIP hydrator asks to see every status itself and shows the API's
  message, for example "This batch's ZIP has 2 parts; ask for part=1 to part=2" when the parts
  changed between Find Batch and the download (PDFs expire with the plan's storage time).
- **Line items cannot nest**, so a batch row with its own list (an invoice's items) goes in Rows
  (JSON). With verification on, the batch form leaves out `certificate_id`, `verify_url` and
  `verify_qr`, which the API fills in and refuses from a row.
- **Free plan rules are the API's**: the card watermark and the PDF mark apply to everything the app
  makes, as for any other client.

## What was tested here, and what was not

Tested in this session (2026-11-26):

- `npm test`: Vitest 3.2.4 with nock 14.0.17 and zapier-platform-core 19.3.0's appTester, all
  offline: 156 tests. They cover the auth test and label, every action and search, the dropdowns
  and dynamic fields, error mapping, the hydrators (with a stand-in for `z.stashFile`), the ZIP
  parts and Zapier's file limit, the schema, and the package (exact core version, changelog,
  `.gitignore`, no forbidden packages).
- `npm run typecheck` and `npm run validate` ("This project is structurally sound!").
- `node integrations/e2e/zapier.mjs` (see `integrations/e2e/README.md`): the app against this
  repository's real Worker under `wrangler dev`, with a throwaway local account and key, over HTTP
  with appTester and no nock, and with a stand-in for Browser Run that answers with a fixture PDF.
  42 of 42 checks passed: the auth test and label, a wrong key, the template dropdown and fields,
  Create Card Image (real render, its URL served, the second request served from storage, the
  `email` size, an invalid data key), Create PDF from a starter with line items and from inline
  HTML with a `{{placeholder}}`, Create Card From Link and Check Link Preview reaching their routes,
  Start Bulk PDFs with line items, a `[key]`/`[n]` pattern and certificates, then Find Batch until
  done, every declared output field present in the real answers, Rows (JSON) with verification
  off, 409 for a batch over the active limit, 404 for an unknown template, 403 for 26 rows on Free,
  a row with its own `verify_url` refused, and an unknown batch id read as nothing found. The same
  with `zapier-platform invoke` in local mode: `auth test`, `auth label`, `create
  create_card_image`, `search get_batch`.
- The file hydrators ran through Zapier core's real lambda handler and `z.stashFile`, with the
  event's RPC address and `LOGGING_ENDPOINT` pointed at a local stand-in for Zapier's RPC, file
  upload and log endpoints, so nothing was sent to Zapier: the card's WebP, the PDF under its own
  name, and the batch's ZIP part 1 (named `<batch id>.zip`, exactly the bytes `zip_parts` promised,
  `unzip -t` clean, entries named from the pattern) were uploaded; part 2 of a one-part batch
  failed with the API's own 404 message.

Not tested, and why:

- **Anything on Zapier's side**: login, register, push, the server-side checks, the Zap editor,
  invites, promote. They need a Zapier account and zapier.com, which this session could not reach.
- **Zapier's real file storage**: the uploads went to a local stand-in that answers like the
  presigned upload core expects; Zapier's own storage, its limits in practice and how a file
  pointer inside line items (`zip_parts[].file`) shows in the Zap editor were not seen.
- **A batch with more than one ZIP part against the API**: that needs more than 500 rows (Starter
  or Pro plan); the e2e ran one part, and several parts are covered by the offline tests.
- **Create PDF and batches with real PDFs**: needs Browser Run (staging); locally a fixture PDF
  stood in for it.
- **Create Card From Link and Check Link Preview of a real page**: the local Worker could not
  resolve outside host names here ("Could not resolve the host name"), so only the API's refusals
  (a local address, `http://`) and its 422 `page_fetch_failed` were seen.
- **Zapier's timeouts and outgoing IP addresses.** If many Zapier users' requests reach the API from
  the same few addresses, the API's per-IP limit, which applies before the per-key limits, could
  slow them all down. Not checked; see the integration notes.
