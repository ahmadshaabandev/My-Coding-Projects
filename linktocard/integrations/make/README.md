# Link To Card for Make

A Make (make.com) custom app, kept as source files in the layout of Make's own VS Code extension,
**Make Apps Editor**. Every module is one request to the public API under `/v1` with the
connection's API key, so a scenario gets the same results, limits and counting as any other API
client. It is a package of its own: it is not part of the Worker's bundle, its `package.json` or
its test run.

**Status: not created in Make, not deployed, not tested in Make, not published.** Nothing here has
been uploaded to Make, and no Make account was used to build it.

## What it offers

| Make module | Id | Request(s) | Notes |
| --- | --- | --- | --- |
| Create a card image (action) | `createCardImage` | `POST /v1/images`, then optionally a `GET` of the stored image | Template dropdown from `GET /v1/templates` (starters and your own); fields as a key/value list; size; format. |
| Create a PDF (action) | `createPdf` | `POST /v1/pdf`, then by default a `GET` of the stored PDF | The five PDF starters, each with its own fields (an invoice's line items too), or one of your own templates with a key/value list. File name, page size, landscape. |
| Create a card from a link (action) | `cardFromLink` | `POST /v1/cards/from-url`, then optionally a `GET` of the stored image | Page URL, optional template (the API's default is `blog`), overrides, size, format. |
| Start bulk PDFs (action) | `startBulkPdfs` | `POST /v1/batches` | Rows as an array (a starter's fields, so an Array aggregator can target it), verification, file name pattern with `[key]` and `[n]`, page setup. |
| Get a batch (action, read) | `getBatch` | `GET /v1/batches/{id}`, then optionally `GET /v1/batches/{id}/zip?part=N` | Status, counts, each document's link and file name, the zip parts; on request one part of the zip (Zip part, 1 by default). |
| Check a link preview (action, read) | `checkLinkPreview` | `GET /v1/inspect?url=` | The whole check result plus `fail_count` and `warn_count` for filters. |
| Make an API call (universal) | `makeApiCall` | any path under the API | URL, method, headers, query string, body. |

The connection (`apiKey`, type basic) asks for the API key (a password field, must start with
`ltc_`) and checks it with `GET /v1/usage`, which counts nothing. An advanced field, **API address**,
defaults to `https://linktocard.com`; it exists so the app can be tested against staging (see
below). Two RPCs fill the template dropdowns: `listCardTemplates` (starters and your own, from
`GET /v1/templates`) and `listOwnTemplates` (your own only). No endpoint lists the PDF starter
templates, so the app lists them itself.

"Download the file" (a Yes/No setting of the card and PDF modules, off for cards and on for PDFs)
adds a second request: a `GET` of the URL the API just returned, so a later module (an upload, an
email attachment) gets the file itself as **File name** and **Data**. Without it the module outputs
the API's JSON answer unchanged. Get a batch does the same for the zip with "Download the zip file".
The API packs a batch's finished documents into zip parts of at most 500 files and 2 GiB each, in
row order (most batches have one part), and lists them as `zip_parts`; **Zip part** picks the part
the module downloads (`?part=N`). The file is named `<batch id>-part-<n>.zip`.

Which modules work where depends on the API's switches, not on this app:

| Module | Needs on the server |
| --- | --- |
| Create a card image, Check a link preview, Make an API call | nothing: they work wherever the API runs |
| Create a PDF | PDFs on (`PDF_ENABLED` and Browser Run) |
| Create a card from a link | `LINK_CARDS_ENABLED` |
| Start bulk PDFs, Get a batch | `BATCH_ENABLED` and PDFs |

Production has these switched off until each is approved; staging has them on. While a switch is
off, the module stops with the API's own message, for example "PDF rendering is not enabled yet."
Share the app with customers or ask Make for a review only once every module you list works in
production.

### Choices made because nothing could be tried in Make

- **No inline HTML.** Make evaluates `{{...}}` in mapped text (IML is "the expression language
  inside `{{…}}` in `mapper` values", @makehq/skills `mapping.md`/`iml-functions.md`), so a
  template's own `{{placeholders}}` would be taken as expressions before the API sees them. Modules
  take template ids only (the integrations docs draft gives HTTP-module users the same advice). For HTML of your own: save it as a
  template in the dashboard and pick it under "One of my own templates".
- **Optional fields are left out, never sent empty.** The API treats only a missing key as "use
  the default" and refuses `null` or `""` for `size`, `format`, `filename` and `pdf.format`. Every
  optional value is written as `{{ifempty(parameters.x, undefined)}}`, the pattern Make's custom-app
  docs give for leaving a key out (seen only in a search summary; test plan step 3).
- **Card data as a key/value list.** One list works for every template, starters and your own.
  Dynamic per-template fields would need an RPC that reads the chosen template; that is a later
  improvement once the basics are confirmed in Make.
- **Batch file names use `[key]` and `[n]`.** Make would read `{{key}}` as its own expression. The
  module turns `[` and `]` into the API's `{{` and `}}` with `replace` and `decodeURL('%7B%7B')`,
  so no braces appear inside an IML expression (the Zapier app uses the same `[key]` form).
- **No custom IML functions.** Make's editor says deploying them is "temporarily disabled for
  external users", so everything uses built-in functions only: `ifempty`, `toCollection`, `merge`,
  `replace`, `decodeURL`, `length`, `map`, and the keywords `undefined`, `emptyarray`,
  `emptystring`.

## Files

```
app/                          the Make app, in the editor's local-development layout
  makecomapp.json             project file: components, code file paths, origins (none yet)
  README.md                   the app's readme in Make (for people using the app)
  general/base.iml.json       base URL, Authorization header, error messages, log sanitizing
  connections/api-key/        the API-key connection: its fields and its check request
  rpcs/list-*-templates/      the two template dropdowns
  modules/groups.json         how Make groups the modules
  modules/<module-id>/        per module: communication, static-params, mappable-params,
                              interface, samples (*.iml.json)
assets/icon-512.png           the app icon (512 x 512 PNG, drawn from the site's favicon)
test/                         Vitest checks (below); test/vendor = Make's own JSON schemas (MIT)
```

Code files use the `.iml.json` names that the released editor (2.9.0) writes. Its unreleased next
version writes `.iml.jsonc` for new files but still reads `.iml.json`, because each path is stored
in `makecomapp.json`.

The PDF starter templates and their fields, the sizes, formats and page sizes are copies of the
Worker's own definitions. `tests/node/make-connector-sync.test.ts` in the Worker fails when a copy
drifts from `src/config.ts` or `src/pdf/templates`, when a request in `test/api-contract.json` no
longer matches `openapi.yaml` or the Worker's accepted fields, when a sample's numbers contradict
the plans, or when a docs link points at a page that is not published. Change the Worker first,
then this app.

## Develop and test

```
cd integrations/make
npm ci
npm test            # Vitest, offline: nothing here talks to Make or to Link To Card
npm run typecheck
```

What the tests check:

- `files.test.ts`: every file parses as strict JSON in the editor's formatting, `makecomapp.json`
  points at every file and every file exists, ids and file names follow the editor's rules, every
  module has its label, description, type and five code files, `groups.json` lists every module
  once, the icon is a 512 x 512 PNG.
- `schemas.test.ts`: every file against the JSON schemas the editor validates with (vendored from
  integromat/vscode-apps-sdk at commit `6ff5f3dd`, see `test/vendor/make-apps-editor/SOURCE.md`).
  One documented exception: the universal module's `headers` and `qs`, see below.
- `contract.test.ts`: every request against `test/api-contract.json`: method, path, query keys
  (`part` for the zip), only body keys the API accepts, the keys it needs, no `html`, no headers of its own; the base URL and
  Authorization header; the connection's check request; that optional values are left out when
  empty; how downloads are chained and what they output.
- `iml.test.ts`: every `{{...}}` expression: only the built-in functions and keywords above, every
  `parameters.x` is a parameter of that module, every `temp.x` is set by an earlier request,
  `body`/`headers`/`statusCode` only in responses, `item` only where a response iterates, one
  argument style (`, ` and single quotes), no stray braces in help texts.
- `forman.test.ts`: Make's own parameter validator (`@makehq/forman-schema`): every sample fits its
  interface, real scenario inputs fit each module's parameters, and wrong ones (a size the API does
  not have, a field name it would refuse, a batch row with a certificate ID, a missing template) are
  refused, each for the field it names.

## Set it up in Make

You need: a Make account, VS Code 1.109.5 or later, and the extension **Make Apps Editor**
(Marketplace id `Integromat.apps-sdk`, version 2.9.0 at the time of writing). The steps that come
from the extension's own source code are marked [ext]; steps marked [unverified] come from memory
or search summaries of Make's docs, which could not be opened here.

1. **Make API key.** In Make, create an API token for the extension. The Make API client lists the
   scopes `sdk-apps:read` and `sdk-apps:write` for custom apps (@makehq/sdk). Where the token page
   is in Make's menus: [unverified], see Make's help.
2. **Connect the extension.** In VS Code, open the **Make apps** view and add an environment with
   your zone's address (for example `https://eu1.make.com`; the zone is one of eu1, eu2, us1, us2
   [ext]) and the token. The exact dialog: [unverified].
3. **Create an empty app in Make**, from the extension's Make apps view or in Make's web interface
   ([unverified] where): name (id) `link-to-card` or similar (3 to 30 lower-case letters, digits and
   `-`, starting with a letter [ext]), label `Link To Card`, theme `#ff5a26` (the site's accent),
   language English, audience global. Make may add a suffix to the id: use the id Make shows. Upload
   `assets/icon-512.png` as the icon.
4. **Open `integrations/make` as the VS Code folder**, so the key file lands in
   `integrations/make/.secrets/`, which `.gitignore` keeps out of git.
5. **Right-click `app/makecomapp.json` > Deploy to Make.** With no origin yet the extension offers
   "> Deploy into another app", writes an origin with `-FILL-ME-` values into `makecomapp.json`
   and stops [ext]. Fill it in:

   ```json
   {
       "label": "Link To Card",
       "appId": "<the app id Make shows>",
       "baseUrl": "https://<your zone>.make.com/api",
       "appVersion": 1,
       "apikeyFile": "../.secrets/apikey"
   }
   ```

6. **Deploy to Make again.** The extension asks for the Make token if `.secrets/apikey` does not
   exist yet, tests it and saves it there [ext]. For each local component it asks how to pair it:
   choose "... as new remote ... (and Apply for all unmapped)" [ext]. It creates the connection
   first, then the modules and RPCs [ext], and records the pairing (`idMapping`) in
   `makecomapp.json`. Commit that change: it holds no secret, and `test/files.test.ts` checks it.
7. Without VS Code [unverified]: create the same components in Make's web editor and paste each
   file into its section: `*.communication` = Communication (API), `*.static-params` = Static
   parameters, `*.mappable-params` = Mappable parameters, `*.interface` = Interface, `*.samples` =
   Samples; `general/base.iml.json` = Base; `app/README.md` = Readme; the connection's
   `params` and `communication` = its Parameters and Communication. Module ids, labels, types and
   descriptions are in `makecomapp.json`.

A second origin (for example a private test app) can be added the same way; the extension then asks
which one to deploy to [ext].

## Test it in Make

Use staging first: production has PDFs, batches and link cards off. Create an API key on staging,
and in the Make connection set **API address** to
`https://linktocard-staging.names-on-base.workers.dev`. The steps are in the order of risk: the
first ones decide whether the definitions need a mechanical change everywhere.

1. **Connection.** A staging key saves the connection, labelled with the plan (for example
   "starter plan"). A wrong key stops with `[401] ... (error code: invalid_api_key)`.
2. **IML syntax.** Create a card image with only a template and one field. If Make reports an
   expression error at a `,` or a `'`, Make's app IML wants the scenario-mapper style (`;` and
   double quotes). Change the expressions by hand: `grep -rn "{{[A-Za-z]*(" app` lists every one
   with a function call, and a double quote inside a JSON string is written `\"`. Then change the
   argument rule in `test/iml.test.ts` to the new style and run `npm test`, which finds any
   expression left in the old one.
3. **Empty optional fields.** Leave Size and Image format empty: the card must come back as
   1200 x 630 PNG. Then map Size to an empty value from an earlier module: same result. If the API
   answers `unsupported_size`, `unsupported_format` or `"filename" must be text`, Make sent `null`
   or `""` instead of leaving the key out. Then ask the integrator to treat `null` and `""` as
   missing for optional fields (integration step in the build notes) or change the expressions.
4. **Template dropdowns.** Create a card image shows the five starters and your own templates;
   Create a PDF > One of my own templates shows your own only.
5. **Files.** Create a PDF (invoice, two line items, US Letter) with Download the file = Yes, then
   add a module that uploads or attaches a file and pick **File name** and **Data**: the PDF opens.
   Repeat for a card image. Then set Download the file = No: the module outputs the link only.
6. **Own template.** Create a PDF with one of your own templates and a key/value list, including
   a list mapped to `items`.
7. **Card from a link.** A blog post URL without a template gives the `blog` card; an override of
   `title` replaces the page's title.
8. **Bulk PDFs.** A sheet search > Array aggregator (target structure: Start bulk PDFs > Rows) >
   Start bulk PDFs (certificate, verification on, file name `certificate-[recipient_name].pdf`) >
   a delay > Get a batch, until the status is `done`. Each row has a PDF link and a verification
   page; Download the zip file = Yes gives part 1 of the zip, whose entries are named after the
   recipients (this confirms the `[key]` conversion). Set Zip part to 2: the module stops with
   `[404] This batch's ZIP has 1 part; ...`. For more than one part you need more than 500 rows
   (Starter or Pro); iterate over **Zip parts** and map each `part` into Zip part.
9. **Check a link preview.** For a page with known problems, `fail_count` and `warn_count` equal
   the numbers the free checker on linktocard.com shows for the same page.
10. **Make an API call.** `v1/usage` with GET answers 200 with the usage; `v1/images` with POST and
    a body collection makes a card.
11. **Errors and logs.** With a production key, Create a PDF stops with the API's "not enabled"
    message. In the scenario's execution log, the request's Authorization header is hidden.
12. **Universal module headers.** Add a header in Make an API call (for example `Accept`) and check
    the request in the log. Make's documentation shows `headers` built with `toCollection`; the
    editor's schema flags that form (it wants an object), so this confirms Make itself accepts it.

## Request publication

All of this comes from search summaries of Make's docs (developers.make.com could not be opened
here) and must be read on Make's site before relying on it [unverified]:

- A new app is **private**: only its author (or an organization it is installed in) can use it.
- Making it **public** gives an invite link that other Make users can install it from. Make's docs
  say a published app cannot be made private again, although the extension and the API have a
  "make private" action (verified: `POST /sdk/apps/{name}/{version}/private` in @makehq/sdk); read
  Make's page before publishing.
- **Approved** apps are listed for every Make user after Make's review. The review asks for error
  handling and sanitizing in base and connection (done here), a universal module (done here), and
  tested scenarios linked in the request. Community posts report reviews taking a long time.

Suggested order: test on staging (above), make the app public and share the invite link with
customers once every listed module works in production, then request the review. Before the review,
decide whether to keep the **API address** field: it is there for testing, and reviewers may ask
about it. Nothing about Make goes on linktocard.com until the relevant page has been read on Make's
site; the integrations docs page says the connectors are not published.

## Tested against the real Worker

`node integrations/e2e/make.mjs` (see `integrations/e2e/README.md`) runs the app's own JSON files
against this repository's Worker under `wrangler dev`, with a stand-in for Browser Run that answers
with a fixture PDF. There is no Make runtime outside Make, so the script is a small executor of
the files: base URL and Authorization header from base, the connection check, both RPCs, every
module's requests in order with `condition`, `temp`, `iterate`, `output` and the response `type`,
the base error mapping, and the `{{...}}` expressions with the semantics this README assumes (the
[unverified] items below). On 2026-11-26 it passed 32 of 32 checks: the connection (and a wrong
key: `InvalidAccessTokenError`, `[401] ... (error code: invalid_api_key)`), both template dropdowns
including an own template, card images (empty Size and Image format left out, the email size,
the download as File name and Data), PDFs from a starter and from an own template (download and
link only), Start bulk PDFs with `[key]`/`[n]` turned into `{{key}}`/`{{n}}` (the entry names in the
zip prove it), Get a batch with and without the zip download, a zip part that does not exist
(404), the default `document-1.pdf` names of an own template's batch, 403 for too many rows on
Free, 409 for a third active batch, Check a link preview, and Make an API call (GET, POST with a
body and a header, and `GET v1/batches?limit=2`). The connection's API address was set to the
local `http://` origin directly; in Make the field only accepts `https://`.

Not reached locally: a card from a real page and the check of a real page (the local Worker could
not resolve outside host names here; both modules reached the route and showed the API's refusal
of a local address and its 422 `page_fetch_failed`), and real Browser Run PDFs.

## What could not be tested here

- Nothing ran in Make: no Make account was used, and no Make module runtime exists outside Make
  (the `@integromat/iml` engine the editor depends on is not downloadable from the public npm
  registry). The requests and response mappings were run by the executor above, which follows
  this README's reading of IML, not Make's own engine.
- developers.make.com, help.make.com and community.make.com could not be opened in this session
  (the hosts do not resolve here); to read them, they must be allowed in the session's network
  settings.
- [unverified] that app IML uses `,` and single quotes (a search summary shows
  `{{ifempty(body.username, body.user)}}`; Make's scenario mapper uses `;` and double quotes).
- [unverified] that `{{ifempty(parameters.x, undefined)}}` drops the key from the JSON body, and
  that a nested `"pdf": {}` reaches the API as an empty object (the API accepts `{}`).
- [unverified] that `toCollection(emptyarray, 'key', 'value')` gives an empty collection.
- [unverified] that `replace` with a plain search string replaces every occurrence, and that
  `decodeURL('%7B%7B')` gives `{{` without Make reading it as an expression.
- [unverified] that `{"fileName": ..., "data": "{{body}}"}` with a binary response arrives as a file
  that later modules offer, and that the base Authorization header on the download of a stored file
  does no harm (the `/i/` links are public).
- [unverified] how Make treats each error type (`DataError`, `RateLimitError`,
  `InvalidAccessTokenError`) in a scenario, for example retries. 402 (`quota_exceeded`), 403
  (`plan_required` for too many batch rows), 409 (`conflict` for a third active batch) and 503
  (`not_configured`) have no type of their own in base: only the message, which the executor
  checked; which type Make gives them is [unverified].
- [unverified] that `length(map(body.checks, 'id', 'status', 'fail'))` counts the failed checks
  (the four-argument `map` is documented for the scenario mapper).
- [unverified] where Make's menus put API tokens and custom apps, the review rules and timing, and
  whether `public` can be undone.
- Not known yet: Ahmad's Make zone (for `origins[].baseUrl`) and the app id Make assigns.

## Sources

Read for this app (all on 2026-11-26):

- Make Apps Editor for VS Code, https://github.com/integromat/vscode-apps-sdk at commit
  `6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0` (MIT): `package.json` (version, VS Code version,
  schema mapping), `README-local-development-for-apps.md`, `src/local-development/*` (deploy,
  origins, component mapping, API key file, id rules), `src/providers/AppsProvider.js` (which
  components inherit base), `syntaxes/imljson/schemas/*.json` (directive shapes and descriptions:
  `temp`, `condition.default`, `response.type` by status code), `syntaxes/iml/iml.tmLanguage` (IML
  keywords and context variables), `syntaxes/imljson/snippets.json` (file fields).
- `@makehq/sdk` 1.19.0 (Make API client, custom-app endpoints, token scopes, 512 x 512 icon rule),
  `@makehq/forman-schema` 2.3.0 (parameter validator used in the tests), `@makehq/skills` 2.0.1
  (`skills/make-scenario-building/references/iml-functions.md`: the built-in function names), from
  https://registry.npmjs.org.
- Search summaries only (pages not readable here): developers.make.com custom-apps documentation on
  IML functions, processing of input parameters and of empty values, base error handling, basic
  connections, universal modules, app review and visibility.
