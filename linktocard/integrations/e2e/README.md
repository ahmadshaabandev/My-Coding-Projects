# End-to-end checks of the connectors

Each script runs one connector against this repository's real Worker under `wrangler dev`, over
HTTP, on this machine only. Nothing is deployed, nothing is sent to Zapier, Make or n8n, and no
real account or key is used: every run makes a throwaway local account and API key in a temporary
local D1 database and deletes it at the end.

| Script | Connector | What runs it |
| --- | --- | --- |
| `zapier.mjs` | `integrations/zapier` | zapier-platform-core's appTester and lambda handler, and `zapier-platform invoke` |
| `n8n.cjs` | `integrations/n8n` (built) | n8n-core's `RoutingNode` and its HTTP client |
| `make.mjs` | `integrations/make` | a small executor of the app's JSON files (no Make runtime exists outside Make) |
| `harness.mjs` | shared | starts the Worker, makes the account and key, waits for batches |

## What the harness changes, and what it does not

`harness.mjs` writes a copy of the top-level (development) section of `../../wrangler.toml` into a
temporary folder, with its relative paths made absolute, and adds one binding: `BROWSER` is a
service binding to a stand-in for Cloudflare Browser Run, a small Worker in the same temporary
folder whose `quickAction('pdf')` answers with `tests/fixtures/pdf/1-page.pdf` (a real Chrome PDF).
Everything else is the repository's own code and development configuration: the local D1 with
every migration, local R2, the rate limiters, every v3 switch "true", and the real local queue,
so `POST /v1/batches` really goes through the queue consumer, charging, R2 storage and the ZIP
route. The PDFs are the fixture, not a rendering of the template.

Run the scripts one after the other: two `wrangler dev` sessions started at the same time
register the same Worker names and the second one does not start.

## Run them

From the repository folder (`linktocard/`), after `npm install` there:

```bash
# Zapier: needs `npm install` in integrations/zapier
node integrations/e2e/zapier.mjs            # optional port, default 8813

# Make: needs nothing else
node integrations/e2e/make.mjs              # default port 8817

# n8n: needs `npm install --ignore-scripts && npm run build` in integrations/n8n, and n8n-core
# installed in a folder outside the repository, as the header of
# integrations/n8n/scripts/engine-check.cjs says
node integrations/e2e/n8n.cjs <folder where n8n-core is installed>   # default port 8815
```

Each prints one line per check (`ok` or `FAIL`) and a total, and exits non-zero if a check failed.

## Stand-ins, and why

- **Browser Run**: only exists on Cloudflare (staging and production). The fixture PDF lets PDF and
  batch requests run their real code paths locally; real rendering is not checked here.
- **Zapier's file storage** (`zapier.mjs`): `z.stashFile` asks Zapier's RPC for an upload address
  and uploads the file there. The script runs the hydrators through zapier-platform-core's real
  lambda handler with the event's `rpc_base` and `LOGGING_ENDPOINT` pointing at a local server that
  answers like that RPC and accepts the upload, so the uploaded bytes can be checked. Zapier's own
  storage is not used.
- **n8n's credential helper** (`n8n.cjs`): inside n8n it resolves the credential's `authenticate`
  expression. The script applies the credential's own definition (an `Authorization: Bearer`
  header filled from the credential's API key); n8n-core's routing engine and HTTP client are real.
- **Make's runtime** (`make.mjs`): Make's IML engine is not available outside Make. The script
  evaluates the app's `{{...}}` expressions with the built-in functions the app uses, as
  `integrations/make/README.md` describes them (those semantics are marked unverified there). It
  proves the requests the definitions produce are accepted by the API and that the responses map
  into the declared outputs; it does not prove that Make evaluates them the same way.

## Results on 2026-11-26

Against the Worker of this working tree (all v3 routes mounted):

- `zapier.mjs`: 42 ok, 0 failed
- `n8n.cjs`: 24 ok, 0 failed
- `make.mjs`: 32 ok, 0 failed

Not reachable locally: pages on the internet. The local Worker could not resolve outside host
names here, so Create card from link and Check link preview were only seen refusing a local address
and answering 422 `page_fetch_failed` for `https://example.com/`; the scripts record that result
without failing on it. A batch with more than one ZIP part needs more than 500 rows (Starter or Pro
plan, while the local account is Free) and was not run; the connectors' unit tests cover later parts.
