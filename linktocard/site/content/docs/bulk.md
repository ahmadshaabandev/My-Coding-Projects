---
title: Bulk documents
description: "One PDF for every row of a spreadsheet with POST /v1/batches: the request, progress and results, ZIP downloads in parts, listing and cancelling batches, certificates with a public verification page, revoking them, limits and what counts."
layout: doc
order: 5.6
nav: Bulk documents
feature: batch
unlaunched: **Not switched on yet on [[site.host]].** Bulk documents have not launched here: until they do, every `/v1/batches` request and every certificate revocation answers 503 `not_configured`, and verification pages answer 503.<!-- feature:no-pdf --> Bulk documents are PDFs, and PDF documents are not switched on here yet either.<!-- /feature:no-pdf -->
---

A batch makes one PDF for every row of your data: the same template, a different row each time. Certificates for everyone who finished a course, an invoice for every customer of the month, a report for every location. You send the rows as JSON, the documents are made in the background, and you follow the progress, then download each PDF or all of them as ZIP files.

The dashboard does the same from a CSV file (**Bulk documents**). It reads the file in your browser and does not upload it: only the values you match to template fields are sent, row 1 for a preview made by the free PDF tool (with that tool's mark, not stored and not counted) and every row when you start the batch. It reads at most [[batch.maxCsvColumns]] columns.

## How a batch runs

1. `POST /v1/batches` checks the whole request before anything is made: the template, every row, the file name pattern, the number of rows your plan takes, and whether your allowance can pay for the batch (see [What counts](#what-counts)). Anything wrong answers with an error and nothing is started. A good request answers 202 with the batch `id`.
2. Each row then becomes one PDF, made and counted exactly like a [`POST /v1/pdf`](/docs/pdf#post-v1-pdf) request with that row as `data`.
3. `GET /v1/batches/{id}` shows the progress and every document's link while the batch runs. `GET /v1/batches/{id}/zip` downloads the documents made so far.

A batch keeps running when you close the dashboard or your script ends. Up to [[batch.maxActive]] batches per account can be waiting or running at the same time.

## Quickstart

You need an API key from the dashboard (**API keys**). This batch makes three certificates with the `certificate` starter template.

```bash
curl [[site.url]]/v1/batches \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "certificate",
    "rows": [
      { "title": "Certificate of Completion", "recipient_name": "Amara Nwosu", "achievement": "for completing the Advanced TypeScript workshop.", "issuer_name": "Lanternworks Training", "date": "November 25, 2026" },
      { "title": "Certificate of Completion", "recipient_name": "Jonas Berg", "achievement": "for completing the Advanced TypeScript workshop.", "issuer_name": "Lanternworks Training", "date": "November 25, 2026" },
      { "title": "Certificate of Completion", "recipient_name": "Lucía Ortega", "achievement": "for completing the Advanced TypeScript workshop.", "issuer_name": "Lanternworks Training", "date": "November 25, 2026" }
    ],
    "filename": "certificate-{{recipient_name}}.pdf"
  }'
```

The answer, HTTP 202 (the values are examples):

```json
{
  "id": "bat_m4q8x2k7v1c9d3e6",
  "status": "queued",
  "template": "certificate",
  "verify": true,
  "total": 3,
  "counts": { "queued": 3, "running": 0, "done": 0, "failed": 0, "cancelled": 0 },
  "pages": 0,
  "credits_used": 0,
  "created_at": "2026-11-26T09:12:44.031Z",
  "started_at": null,
  "finished_at": null,
  "cancelled_at": null,
  "zip_url": "[[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6/zip",
  "zip_parts": []
}
```

Ask for the progress with the `id`:

```bash
curl [[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6 -H "Authorization: Bearer $LTC_API_KEY"
```

When `status` is `done` (or `partial`, `failed`, `cancelled`), nothing changes any more. Download the PDFs, here the first (and usually only) part of the ZIP:

```bash
curl "[[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6/zip?part=1" -H "Authorization: Bearer $LTC_API_KEY" -o certificates.zip
```

Poll every few seconds, not in a tight loop: the status request counts against the [rate limits](/docs/limits#rate-limits) like any other.

## Templates and rows

`template` is a PDF starter template (`[[pdf.templateIds]]`) or the id of one of your own templates (`t_...`).<!-- feature:pdf --> [PDF documents](/docs/pdf#starter-templates) lists the keys of every starter template.<!-- /feature:pdf --> A template that does not exist on your account answers 404 `not_found`, like `POST /v1/pdf`.

Every row is a `data` object, with the same rules as `data` in `POST /v1/pdf`: at most [[pdf.maxDataKeys]] keys, values of at most [[pdf.maxDataValueChars]] characters, and an `items` list of at most [[pdf.maxItems]] entries for line items. A key the template does not use is ignored. A missing key prints as empty. The rows are checked before the batch starts; an error names the row, for example `rows[3]`, which is the fourth row (the list starts at 0).

`pdf` sets the page for every document, as in `POST /v1/pdf`: `format` (`[[pdf.formats]]`) and `landscape`. Leave it out to use the template's own page setup.

If you use one of your own templates, the batch is made with the template as it was when the batch started. When you change the template while the batch runs, the documents that have not been made yet fail with `conflict`; start a new batch for them.

## File names

`filename` is a pattern for each document's download name. `{{key}}` is replaced by that key's value in the row, and `{{n}}` by the row's number counted from 1. The result is cleaned like a `POST /v1/pdf` file name: letters, digits, spaces and `. _ - ( )` are kept, accents are dropped from letters, anything else becomes `-`, at most [[pdf.maxFilenameChars]] characters, always ending in `.pdf`. A `{` or `}` that is not part of a placeholder is refused.

| Pattern | Row | File name |
| --- | --- | --- |
| `certificate-{{recipient_name}}.pdf` | `"recipient_name": "Amara Nwosu"` | `certificate-Amara Nwosu.pdf` |
| `certificate-{{recipient_name}}.pdf` | `"recipient_name": "Lucía Ortega"` | `certificate-Lucia Ortega.pdf` |
| `invoice-{{invoice_number}}.pdf` | `"invoice_number": "INV-2026-0142"` | `invoice-INV-2026-0142.pdf` |
| `report-{{n}}.pdf` | the fourth row | `report-4.pdf` |

Without `filename`, the pattern is the starter template's id and the row number, like `certificate-1.pdf`, `certificate-2.pdf`, and `document-1.pdf`, `document-2.pdf` for one of your own templates.

The names of one batch are unique, ignoring upper and lower case, so the files can sit in one folder: a name that repeats gets a number, `certificate-Amara Nwosu.pdf`, then `certificate-Amara Nwosu (2).pdf`. Each row's `filename` in the answer is its final name.

## Progress and results

`GET /v1/batches/{id}` answers with the batch, one entry per row, and its ZIP parts:

```json
{
  "id": "bat_m4q8x2k7v1c9d3e6",
  "status": "partial",
  "template": "certificate",
  "verify": true,
  "total": 3,
  "counts": { "queued": 0, "running": 0, "done": 2, "failed": 1, "cancelled": 0 },
  "pages": 2,
  "credits_used": [[batch.exampleCredits]],
  "created_at": "2026-11-26T09:12:44.031Z",
  "started_at": "2026-11-26T09:12:45.118Z",
  "finished_at": "2026-11-26T09:12:52.964Z",
  "cancelled_at": null,
  "zip_url": "[[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6/zip",
  "rows": [
    {
      "index": 0,
      "status": "done",
      "filename": "certificate-Amara Nwosu.pdf",
      "pages": 1,
      "credits_used": [[pdf.baseUnits]],
      "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/0f6e2b9d4a1c8e3f7b5d2a9c6e1f4b8d3a7c0e5f2b9d6a1c4e8f3b7d0a2c5e9f.pdf",
      "error": null,
      "certificate_id": "crt_8w3k5q0m2r7t9v4x6z1b",
      "verify_url": "[[site.url]]/v/crt_8w3k5q0m2r7t9v4x6z1b"
    },
    {
      "index": 1,
      "status": "done",
      "filename": "certificate-Jonas Berg.pdf",
      "pages": 1,
      "credits_used": [[pdf.baseUnits]],
      "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/7c2a9e4f1b8d3c6a0e5f2b9d4a7c1e8f3b6d0a5c2e9f4b1d8a3c7e0f6b2d5a9c.pdf",
      "error": null,
      "certificate_id": "crt_3n7p1q9s5t2v8w4x0y6z",
      "verify_url": "[[site.url]]/v/crt_3n7p1q9s5t2v8w4x0y6z"
    },
    {
      "index": 2,
      "status": "failed",
      "filename": "certificate-Lucia Ortega.pdf",
      "pages": null,
      "credits_used": null,
      "url": null,
      "error": { "code": "quota_exceeded", "message": "Not enough images left for this document." },
      "certificate_id": null,
      "verify_url": null
    }
  ],
  "zip_parts": [
    { "part": 1, "entries": 2, "bytes": 96518, "url": "[[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6/zip?part=1" }
  ]
}
```

The batch `status`:

| `status` | Meaning |
| --- | --- |
| `queued` | Accepted; no document has started yet. |
| `running` | Documents are being made. |
| `done` | Every document was made. |
| `partial` | Finished; some documents were made and some failed. |
| `failed` | Finished; no document could be made. |
| `cancelled` | Cancelled; documents made before that are kept. |

Each row's `status` is `queued`, `running`, `done`, `failed` or `cancelled`. A `done` row has its PDF's `url`, its `pages` and the images it used in `credits_used` (0 when the same document was already stored). A `failed` row has an `error` with a `code` and a `message`, the same codes as the [API's errors](/docs/api#errors), and used no images: its `credits_used` is `null`, like that of a row that has not been made yet. The rare exception is a row whose PDF was made and counted but could not be recorded in the batch because of an error on our side: its `internal_error` message says so, and its `credits_used` shows what it counted, also while it waits as `queued` to be recorded again (that is not charged again). A row that is waiting to be tried again shows `queued` with the `error` of its last attempt.

The other fields:

| Field | Meaning |
| --- | --- |
| `total` | Rows in the batch. |
| `counts` | Rows per status. |
| `pages`, `credits_used` | The pages of every document made so far, and the images they used together. |
| `created_at`, `started_at`, `finished_at`, `cancelled_at` | When the batch was accepted, when its first document started, when it finished and when it was cancelled; `null` until then. |
| `zip_url` | The ZIP download (part 1). |
| `zip_parts` | The parts of the ZIP download, see [Download as ZIP files](#download-as-zip-files). |
| `rows` | One entry per row, in the order of the request: `index`, `status`, `filename`, `pages`, `credits_used`, `url`, `error`, `certificate_id` and `verify_url`. Only `GET /v1/batches/{id}` and the cancel answer have them. |

A row's `url` is `null` until it is done, and again once its PDF's storage time has ended. `certificate_id` and `verify_url` are `null` unless the row is done: a certificate record is written only when its document has been made, so a document that failed never has one.

The PDFs are stored like other PDFs: [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]]. Each `url` is public until then, so you can email it or put it on a page.

## List your batches

```bash
curl "[[site.url]]/v1/batches?limit=20" -H "Authorization: Bearer $LTC_API_KEY"
```

`GET /v1/batches` answers your batches, newest first, without their rows and ZIP parts: `{ "batches": [...], "next_before": "bat_..." }`. `limit` is how many, from 1 to [[batch.listMaxLimit]] ([[batch.listDefaultLimit]] when you leave it out). When there are more, `next_before` is the id to send as `before` for the next page, `?before=bat_...`; on the last page it is `null`.

A batch stays listed until it has finished and the storage time of its last PDF has ended; the daily clean-up then deletes it, and `GET /v1/batches/{id}` answers 404. Its certificate records stay (see [How long records are kept](#how-long-records-are-kept)).

## Download as ZIP files

`GET /v1/batches/{id}/zip?part=N` answers a ZIP of documents that are made and still stored, each under its file name. A batch's documents are packed into parts in row order, each part at most [[batch.zipPartMaxEntries]] files and [[batch.zipPartMaxGb]] GB, so most batches have one part. `zip_parts` in the batch lists them:

| Field | Meaning |
| --- | --- |
| `part` | The part's number, from 1. |
| `entries` | How many PDFs it holds. |
| `bytes` | The exact size of the download. |
| `url` | Its address, with `?part=N`. Without `part`, the download is part 1. |

- The parts follow the documents that are made: while a batch runs, or as its PDFs' storage time ends, they can change. Read `zip_parts` again before you download, and ask again after the batch has finished to get every document.
- File names are unique across all parts, so the parts can be extracted into one folder.
- The answer has `Content-Length`, `X-LTC-Zip-Part` and `X-LTC-Zip-Parts` (the part and how many there are), and `Content-Disposition` names the file `bat_....zip`, or `bat_...-part-2-of-3.zip` when there are several parts.
- A part that does not exist answers 404 `not_found`, with the number of parts in `details.parts`; a batch with no stored document has no part. A `part` that is not a whole number from 1 answers 400 `invalid_request`.

The PDFs are stored in the ZIP as they are, without compressing them again (a PDF is compressed already), so the download starts at once and is about as large as the PDFs together. The ZIP is tested with Info-ZIP's `unzip` and Python's `zipfile`, which read the list of files at the end of a ZIP. A reader that only reads the entries one after another, without that list, may not open it.

## Cancel a batch

```bash
curl -X POST [[site.url]]/v1/batches/bat_m4q8x2k7v1c9d3e6/cancel -H "Authorization: Bearer $LTC_API_KEY"
```

Documents that have not started are cancelled and use no images. A document that is being made at that moment is finished, counted and kept. Documents already made are kept, stay in the ZIP and keep their links. The answer is the batch, as `GET /v1/batches/{id}` returns it. Cancelling a batch that has finished changes nothing.

## What counts

Every document is counted like a PDF from `POST /v1/pdf`, by its own pages:

[[> pdf-units-table]]

- **Checked before it starts.** A batch is accepted only when your allowance and top-ups together have at least [[pdf.baseUnits]] images for every row. Otherwise the answer is 402 `quota_exceeded` and nothing is made.
- **Charged per document.** Each document is charged after it is made, with its real page count, from the monthly allowance or from one top-up, like any PDF.
- **Running out in the middle.** If the images run out while a batch runs, for example because its documents are longer than one block of pages or because other renders used the allowance, the documents that are left fail with `quota_exceeded`. The batch ends as `partial`, and the documents already made are kept. Add images, then start a new batch with the rows that failed.
- **Failures count nothing.** A document that fails uses no images. When the renderer was busy or had a problem of its own, the document is tried again, at most [[batch.maxRowAttempts]] times in all; a document that fails because of its own content (too many pages, an image that cannot be loaded) is not tried again. A failure of the document in the browser counts toward your account's [daily cap on failed PDF renders](/docs/pdf#what-counts), which `POST /v1/pdf` shares. When that cap is reached, or the renderer asks for a longer wait than the document's tries allow, the document fails with that message instead of waiting.
- **The same document twice counts once.** A row that gives exactly the same document as one that is still stored (same template, data, page setup and file name) is served from storage and uses no images, as with `POST /v1/pdf`. With verification on, every document has its own certificate ID, so none is the same as another.
- **The free mark.** On the [[plan.free.name]] plan, every page of every document carries the "[[pdf.freeMark]]" line<!-- feature:pdf -->, as described in [PDF documents](/docs/pdf#the-free-footer-mark)<!-- /feature:pdf -->. The per-minute limit of [[plan.free.name]]-plan PDF renders does not apply to the documents of a batch, which the queue paces itself.
- **Unfinished documents.** A document that has still not been made [[batch.staleAfterDays]] days after its batch was accepted is failed by the daily clean-up with `internal_error`, uncharged.

## Certificates and verification

Send `"verify": true` and every document of the batch gets its own certificate ID and a public page that confirms the record. For the `certificate` starter template it is on unless you send `"verify": false`; it works with any template.

Each row then gains three values that the template can print:

| Key | Value |
| --- | --- |
| `certificate_id` | The ID: `crt_` followed by letters and digits, for example `crt_8w3k5q0m2r7t9v4x6z1b`. The IDs are random, so nobody can guess another certificate's ID. |
| `verify_url` | The verification page: `[[site.url]]/v/{certificate_id}`. |
| `verify_qr` | A QR code of `verify_url`, as an image (`data:image/svg+xml,...`) for `<img src="{{verify_qr}}">`. |

The `certificate` starter template prints the link and the QR code small in a corner. In your own template, place them where you like:

```html
<p class="verify">Verify at {{verify_url}}</p>
<img class="verify-qr" src="{{verify_qr}}" alt="">
```

These three values are filled in by [[site.name]] after your row has been checked, so the [[pdf.maxDataValueChars]]-character limit of row values does not apply to them (a QR code is longer). A row may not bring its own `certificate_id`, `verify_url` or `verify_qr`: the batch is refused with 400 `invalid_request` naming the row. If your rows already have a number of your own in `certificate_id`, rename that column, or send `"verify": false`. With `"verify": true` a row may have three keys fewer, because the three are added to it.

[[site.name]] does not email the certificates or their links to anyone. Send them to the recipients yourself, with the PDF's `url` or the ZIP.

### The verification page

`GET /v/{certificate_id}` is a public page, with no login, that shows:

- **Valid** or **Revoked**, with the date of the revocation;
- the recipient, title, achievement, issuer name and date, as the issuer entered them in the row (`recipient_name`, `title`, `achievement`, `issuer_name`, `date`; a template that uses other keys shows fewer facts);
- the certificate ID and when the record was made;
- which account issued it: "Issued by a [[site.name]] account verified at @example.org", the domain of the email address that account signs in with. For an address at a public email provider, such as a webmail service, the page says "Issued by a [[site.name]] account with a personal email address" instead, because anyone can open an address there;
- a fixed notice: [[site.name]] confirms that the record was created by that account; it does not verify the issuer's identity, accreditation or the facts stated;
- a **Report this certificate** link, which writes to [[site.supportEmail]] with the ID filled in.

The page is not cached, so a revocation shows on the next visit. It asks search engines not to index it, and its title and link preview do not contain the recipient's name. Anyone who has the link, or the printed QR code, can open it.

`GET /v/{certificate_id}.json` gives the same record as JSON, for your own systems. It can be read from any website (`Access-Control-Allow-Origin: *`):

```json
{
  "id": "crt_8w3k5q0m2r7t9v4x6z1b",
  "status": "valid",
  "verify_url": "[[site.url]]/v/crt_8w3k5q0m2r7t9v4x6z1b",
  "recipient_name": "Amara Nwosu",
  "title": "Certificate of Completion",
  "achievement": "for completing the Advanced TypeScript workshop.",
  "issuer_name": "Lanternworks Training",
  "date": "November 25, 2026",
  "issued_at": "2026-11-26T09:12:51.208Z",
  "revoked_at": null,
  "issued_by": {
    "kind": "domain",
    "email_domain": "lanternworks.example",
    "statement": "Issued by a Link To Card account verified at @lanternworks.example"
  },
  "disclaimer": "Link To Card confirms that this record was created by that account. It does not verify the issuer's identity, accreditation or the facts stated."
}
```

`issued_by.kind` is `domain`, `personal` (a public email provider; `email_domain` is `null`) or `unknown`. An ID that does not exist answers 404 `not_found`, and so does a record whose account is suspended or being deleted, or that was revoked more than [[batch.revokedRetentionDays]] days ago.

### Revoke a certificate

```bash
curl -X POST [[site.url]]/v1/certificates/crt_8w3k5q0m2r7t9v4x6z1b/revoke -H "Authorization: Bearer $LTC_API_KEY"
```

From then on the page shows the certificate as revoked. A revocation cannot be undone; revoking again changes nothing. The answer is the record, as `/v/{certificate_id}.json` gives it, with `"status": "revoked"`. The dashboard has a **Revoke** button next to each certificate of a batch. An ID that belongs to another account answers 404, like one that does not exist.

### How long records are kept

A record is kept for as long as your account exists. A revoked record is kept for [[batch.revokedRetentionDays]] days after the revocation, so the page can say that it was revoked, and is then deleted. Deleting your account deletes all of its records, and their pages answer 404 from then on. A record does not depend on its PDF or its batch: the page keeps working after the PDF's storage time has ended and the batch is gone.

## Limits

| Limit | Value |
| --- | --- |
| Rows per batch | [[batch.maxRowsFree]] on [[plan.free.name]], [[batch.maxRowsStarter]] on [[plan.starter.name]], [[batch.maxRowsPro]] on [[plan.pro.name]] |
| Batches waiting or running at once | [[batch.maxActive]] per account |
| Request body | [[batch.maxRequestBodyMb]] MB |
| Data per row | The `data` limits of `POST /v1/pdf`: [[pdf.maxDataKeys]] keys, [[pdf.maxDataValueChars]] characters per value, [[pdf.maxItems]] `items` |
| Pages per document | [[pdf.maxPages]] |
| Attempts per document | [[batch.maxRowAttempts]], only when the renderer was busy or failed |
| One ZIP part | [[batch.zipPartMaxEntries]] files and [[batch.zipPartMaxGb]] GB |
| Batches per page of `GET /v1/batches` | [[batch.listMaxLimit]] |
| Revoked certificate records | Kept [[batch.revokedRetentionDays]] days after the revocation |

Every other limit of a PDF, such as its HTML size and its images, is the one<!-- feature:pdf --> in [PDF documents](/docs/pdf#limits)<!-- /feature:pdf --><!-- feature:no-pdf --> of a `POST /v1/pdf` request<!-- /feature:no-pdf -->. The requests count against the API's [rate limits](/docs/limits#rate-limits) per IP address and per API key.

## API reference

### POST /v1/batches

Needs an API key. The body is JSON, at most [[batch.maxRequestBodyMb]] MB. Answers 202 with the batch: every field of [Progress and results](#progress-and-results) except `rows`.

| Field | Type | Description |
| --- | --- | --- |
| `template` | string | Required. A PDF starter template (`[[pdf.templateIds]]`) or the id of one of your own templates (`t_...`). |
| `rows` | array | Required. One `data` object per document, at most [[batch.maxRowsFree]] on [[plan.free.name]], [[batch.maxRowsStarter]] on [[plan.starter.name]] and [[batch.maxRowsPro]] on [[plan.pro.name]]. |
| `pdf` | object | `format` and `landscape` for every document. Default: the template's own page setup. |
| `filename` | string | The [file name pattern](#file-names), with `{{key}}` and `{{n}}`. Default: `<template>-{{n}}.pdf` for a starter template, `document-{{n}}.pdf` for your own. |
| `verify` | boolean | Make a [verification record](#certificates-and-verification) for every document. Default: `true` for the `certificate` template, `false` for the others. |

Any other field is refused with 400 `invalid_request`.

### GET /v1/batches

Needs an API key. Your batches, newest first: `batches` (each as `POST /v1/batches` answers it, without `zip_parts`) and `next_before`. Query: `limit` (1 to [[batch.listMaxLimit]], default [[batch.listDefaultLimit]]) and `before` (a batch id, the `next_before` of the previous page). See [List your batches](#list-your-batches).

### GET /v1/batches/{id}

Needs the API key of the account that started the batch. Answers with the batch, its `rows` and its `zip_parts`. See [Progress and results](#progress-and-results).

### GET /v1/batches/{id}/zip

Needs the API key. `?part=N` (default 1). Answers `application/zip` with the documents of that part. See [Download as ZIP files](#download-as-zip-files).

### POST /v1/batches/{id}/cancel

Needs the API key. Cancels the documents that have not started, and answers with the batch.

### POST /v1/certificates/{id}/revoke

Needs the API key of the account that issued the certificate. Answers with the record, `"status": "revoked"`.

### GET /v/{id} and GET /v/{id}.json

Public. The [verification page](#the-verification-page) as HTML, and the same record as JSON. Neither is cached. While bulk documents are switched off on a deployment, the page says that verification is not available right now, and the JSON answers 503 `not_configured`. Both keep working while PDF rendering is switched off.

### Errors

The same error format and codes as the rest of the API ([Errors](/docs/api#errors)):

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | A malformed body, an unknown field, more rows than any plan takes in one batch, a row with bad data or with its own `certificate_id`, `verify_url` or `verify_qr`, a bad file name pattern, a bad `limit`, `before` or `part`. The message names the row. |
| 402 | `quota_exceeded` | Your allowance and top-ups do not have [[pdf.baseUnits]] images for every row. Nothing was started. |
| 403 | `plan_required` | More rows than your plan takes in one batch, while a higher plan takes that many. Upgrade, or split the rows into several batches. |
| 404 | `not_found` | The template, the batch, the ZIP part or the certificate does not exist on your account. |
| 409 | `conflict` | [[batch.maxActive]] batches are already waiting or running. Start this one when one of them has finished, or cancel one. |
| 413 | `payload_too_large` | The body is over [[batch.maxRequestBodyMb]] MB. Split the rows into several batches. |
| 429 | `rate_limited` | Over a [rate limit](/docs/limits#rate-limits). Retry after the seconds in `Retry-After`. |
| 503 | `not_configured` | Bulk documents are switched off on this deployment: "Bulk documents are not enabled yet." They also need PDF rendering, so while that is off, the answer is "PDF rendering is not enabled yet." |

The [OpenAPI description](/openapi.yaml) covers every endpoint on this page.
