---
title: PDF toolkit
description: "Merge, split, stamp, fill, read form fields, turn images into a PDF and password-protect PDFs with POST /v1/pdf-tools/{op}: every operation with a request and an answer, page ranges, limits, what counts, and the errors for encrypted and XFA files."
layout: doc
order: 5.7
nav: PDF toolkit
feature: toolkit
unlaunched: **Not switched on yet on [[site.host]].** The PDF toolkit has not launched here: until it does, every `/v1/pdf-tools` request answers 503 `not_configured`.<!-- feature:no-pdf --> Its result links (`/i/...pdf`) need PDF documents too, which are not switched on here yet either.<!-- /feature:no-pdf --><!-- feature:localpdf --> The free [Merge PDF](/tools/merge-pdf) and [Image to PDF](/tools/image-to-pdf) tools work today, in your browser.<!-- /feature:localpdf -->
---

The PDF toolkit works on PDFs that already exist: yours, ones that [`POST /v1/pdf`](/docs/pdf) made, or files from anywhere on the web. One endpoint per operation:

| Operation | What it does |
| --- | --- |
| [`merge`](#merge) | Several PDFs, or chosen pages of each, into one. |
| [`split`](#split) | One PDF into several, by page ranges or every so many pages. |
| [`stamp`](#stamp) | A text or image watermark, such as "PAID", "DRAFT" or a logo, on chosen pages. |
| [`fill`](#fill) | Fills in the fields of a PDF form by name, and can flatten the form. |
| [`fields`](#fields) | Lists a form's fields, their types, options and values. Counts nothing. |
| [`from-images`](#from-images) | PNG and JPEG images to a PDF, one image per page. |
| [`protect`](#protect) | A password to open the file, and limits on printing, copying and changes. |

Every operation is `POST [[site.url]]/v1/pdf-tools/{operation}` with an API key and a JSON body, or with the files as uploads ([multipart](#upload-the-files)). No browser is involved: the files are read and written as PDF documents, so pages keep their text, fonts and images as they are, and nothing is printed again.

## Quickstart

Merge two PDFs from the web into one:

```bash
curl [[site.url]]/v1/pdf-tools/merge \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      { "url": "https://example.com/files/cover-letter.pdf" },
      { "url": "https://example.com/files/proposal.pdf" }
    ],
    "filename": "proposal-with-cover.pdf"
  }'
```

The answer (the values are examples):

```json
{
  "op": "merge",
  "id": "9e1c4a7f2b8d5e0c3a6f9b2d7e4c1a8f5b0d3e6c9a2f7b4d1e8c5a0f3b6d9e2c",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/9e1c4a7f2b8d5e0c3a6f9b2d7e4c1a8f5b0d3e6c9a2f7b4d1e8c5a0f3b6d9e2c.pdf",
  "pages": [[toolkit.examplePages]],
  "bytes": 418236,
  "credits_used": [[toolkit.exampleUnits]],
  "filename": "proposal-with-cover.pdf",
  "created_at": "2026-11-26T10:02:17.554Z",
  "expires_at": "2026-12-03T10:02:17.554Z",
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": 100,
    "used": 7,
    "remaining": 93,
    "topup_remaining": 0,
    "total_remaining": 93,
    "cache_days": 7,
    "watermark": true
  }
}
```

`url` is public until `expires_at` ([[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]]), like a PDF from `POST /v1/pdf`, and `id` can be sent as a `pdf_id` in a later request until then. Add `"response": "binary"` to get the file itself instead.

Stored results are served at the same addresses as PDFs from `POST /v1/pdf` (`/i/...pdf`). While PDF documents are switched off on a deployment, those addresses answer 503 `not_configured` there, results of the toolkit included; `"response": "binary"` still delivers the file in the answer.

## Files

`files` is a list. Each entry is one of:

| Entry | What it is |
| --- | --- |
| `{ "url": "https://..." }` | A file on a public `http` or `https` address, downloaded under the rules of the guarded fetcher of card images: addresses on private or local networks are refused, also after a redirect, and so are [[site.name]]'s own addresses (send a `pdf_id` for a PDF made here). At most [[toolkit.fetchMaxRedirects]] redirects, and each file must arrive within [[toolkit.fetchTimeoutSeconds]] seconds. The request says `User-Agent: LinkToCard-FileFetcher/1.0`. |
| `{ "base64": "JVBERi0x..." }` | The file itself, base64-encoded. A `data:...;base64,` prefix is allowed. |
| `{ "pdf_id": "5d2b0f7e..." }` | A PDF stored on your account: the `id` that `POST /v1/pdf` or an earlier toolkit request answered with, while that PDF is stored. |

`merge` and `from-images` take up to [[toolkit.maxFiles]] files; the other operations take one. `from-images` takes PNG and JPEG images, not `pdf_id`. All files of one request together may be [[toolkit.maxInputMb]] MB, one image [[toolkit.maxImageMb]] MB, and a PNG [[limit.maxImageMegapixels]] megapixels. Base64 makes a file about a third larger, and the whole body may be at most [[toolkit.maxRequestBodyMb]] MB, so send large files as `url`, `pdf_id` or an upload.

Every operation can also take:

| Field | Description |
| --- | --- |
| `filename` | The download name of the result, cleaned like the `filename` of `POST /v1/pdf`. Default: the operation's name, like `merge.pdf`. |
| `response` | `url` (default): JSON with the stored result. `binary`: the PDF itself. `split` and `fields` always answer JSON. |

### Upload the files

Instead of JSON, a request can be `multipart/form-data`, the way an HTML form or `curl -F` uploads files:

```bash
curl [[site.url]]/v1/pdf-tools/split \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -F "files=@contracts.pdf" \
  -F 'options={"ranges": "1-4,5-"}'
```

- `files`: one file part per input file, in order.
- `image`: the image of a [`stamp`](#stamp), one file part.
- `options`: one text part, a JSON object with the operation's other fields, such as `{"ranges": "1-4,5-"}` or `{"text": "PAID"}`. Without uploads, `options` may hold `files` as `url` or `pdf_id` entries itself.

The same limits apply as to a JSON body. Pages per file for [`merge`](#merge) need a JSON `files` list, in the body or in `options`: an upload part cannot carry them. Any other part name, text in a file part or a file given twice is refused with 400 `invalid_request`.

## Page ranges

Several operations take pages, written the way print dialogs take them:

| Written | Means |
| --- | --- |
| `"5"` | One page. |
| `"1-3"` | A range, first and last page included. |
| `"8-"` | From that page to the last one. |
| `"1-3,5,8-"` | Several pages and ranges, in the order written. |
| `"all"` | Every page (also when the field is left out). |

Pages are numbered from 1. A range that names a page the document does not have is refused with 400 `invalid_request`: a range that is silently cut short is more often a mistake than what was meant.

## Operations

### merge

```json
{
  "files": [
    { "pdf_id": "5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e" },
    { "url": "https://example.com/files/terms.pdf", "pages": "2-" }
  ],
  "filename": "invoice-and-terms.pdf"
}
```

The files are joined in the order of the list. `pages` on a file takes only those pages, in the order written, so `"3,1-2"` puts its third page first, and a page may be named twice. A single file with `pages` reorders that file.

Pages are copied with everything they show. What belongs to a document rather than to its pages is not carried over: bookmarks, attachments, metadata and the list of form fields. A filled form's values stay visible on the page, but the fields can no longer be edited.

### split

```json
{
  "files": [{ "url": "https://example.com/files/contracts.pdf" }],
  "ranges": "1-4,5-9,10-"
}
```

Send `ranges` (one new file per range; ranges may overlap) or `every` (a new file every so many pages: `"every": 1` makes one file per page), not both. A split makes at most [[toolkit.maxFiles]] files. The answer lists them:

```json
{
  "op": "split",
  "files": [
    { "range": "1-4", "id": "1b4e7a0d3c6f9b2e5a8d1c4f7b0e3a6d9c2f5b8e1a4d7c0f3b6e9a2d5c8f1b4e", "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/1b4e7a0d3c6f9b2e5a8d1c4f7b0e3a6d9c2f5b8e1a4d7c0f3b6e9a2d5c8f1b4e.pdf", "pages": 4, "bytes": 96410, "credits_used": 1, "filename": "split-1-4.pdf" },
    { "range": "5-9", "id": "6c9f2b5e8a1d4c7f0b3e6a9d2c5f8b1e4a7d0c3f6b9e2a5d8c1f4b7e0a3d6c9f", "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/6c9f2b5e8a1d4c7f0b3e6a9d2c5f8b1e4a7d0c3f6b9e2a5d8c1f4b7e0a3d6c9f.pdf", "pages": 5, "bytes": 120877, "credits_used": 1, "filename": "split-5-9.pdf" },
    { "range": "10-12", "id": "3a6d9c2f5b8e1a4d7c0f3b6e9a2d5c8f1b4e7a0d3c6f9b2e5a8d1c4f7b0e3a6d", "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/3a6d9c2f5b8e1a4d7c0f3b6e9a2d5c8f1b4e7a0d3c6f9b2e5a8d1c4f7b0e3a6d.pdf", "pages": 3, "bytes": 70215, "credits_used": 1, "filename": "split-10-12.pdf" }
  ],
  "pages": 12,
  "credits_used": 3,
  "created_at": "2026-11-26T10:05:41.903Z",
  "expires_at": "2026-12-26T10:05:41.903Z",
  "usage": {
    "plan": "starter",
    "period_start": "2026-11-14T08:00:00.000Z",
    "period_end": "2026-12-14T08:00:00.000Z",
    "limit": 2000,
    "used": 318,
    "remaining": 1682,
    "topup_remaining": 0,
    "total_remaining": 1682,
    "cache_days": 30,
    "watermark": false
  }
}
```

Each file is counted on its own pages, so the example counts one image per file. The files are named after `filename` (default `split.pdf`) and their range, like `split-1-4.pdf`.

### stamp

Text:

```json
{
  "files": [{ "pdf_id": "5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e" }],
  "text": "PAID",
  "font": "helvetica-bold",
  "font_size": 96,
  "color": "#15803d",
  "opacity": 0.25,
  "rotation": 30,
  "position": "center",
  "pages": "1"
}
```

An image (a PNG or JPEG file, given like an entry of `files`, but not as `pdf_id`):

```json
{
  "files": [{ "url": "https://example.com/files/report.pdf" }],
  "image": { "url": "https://example.com/brand/logo.png" },
  "width": 120,
  "position": "top-right",
  "margin": 24,
  "opacity": 1
}
```

Send `text` or `image`, not both.

| Field | With | Values | Default |
| --- | --- | --- | --- |
| `text` | text | One line of text, at most [[pdf.maxDataValueChars]] characters. | |
| `font` | text | `helvetica`, `helvetica-bold`, `times`, `times-bold`, `courier`, `courier-bold` | `helvetica-bold` |
| `font_size` | text | Points | `48` |
| `color` | text | A hex colour such as `"#dc2626"` or `"#f00"` | `"#6b7280"` |
| `image` | image | `{ "url": ... }` or `{ "base64": ... }`, a PNG or JPEG | |
| `width` | image | Points; the height follows the image. | The image at one point per pixel, made smaller to fit inside the margins |
| `opacity` | both | From `0` (invisible) to `1` (solid) | `0.35` |
| `rotation` | both | Degrees, counter-clockwise, from `-360` to `360` | `0` |
| `position` | both | `center`, `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right` | `center` |
| `margin` | both | Points from the page edges | `36` |
| `pages` | both | A [page range](#page-ranges) | Every page |

A point is 1/72 inch. Positions are on the page as it is shown, so a page that is turned in the file still gets its stamp the right way up. A turned stamp is kept inside the margins as a whole, so a turned "DRAFT" in a corner stays on the page. Text, or an image with a `width`, that is larger than the page is not made smaller: it is centred on its position and may run off the edges.

Text is drawn in one of the standard PDF fonts, which every PDF reader has, so nothing is embedded. They have Latin letters only (the Windows-1252 set): text with other characters, such as Arabic, Cyrillic, Chinese or emoji, is refused with 400 `invalid_request`, and `details.code_point` names the first such character. To stamp other scripts, stamp an image of the text.

### fill

```json
{
  "files": [{ "url": "https://example.com/forms/application.pdf" }],
  "values": {
    "applicant.name": "Amara Nwosu",
    "applicant.email": "amara@example.com",
    "plan": "Plus",
    "newsletter": true
  },
  "flatten": true
}
```

`values` names each field by its full name, as [`fields`](#fields) lists it. What a field takes depends on its type:

| Type | Value |
| --- | --- |
| `text` | Text. Line breaks only in multi-line fields. `null` empties the field. |
| `checkbox` | `true` or `false`; the text `"true"`, `"false"`, `"yes"`, `"no"`, `"on"` and `"off"` is understood too. |
| `radio` | One of the field's `options`. `null` clears it. |
| `dropdown` | One of its `options` (any text when the dropdown lets readers type), or a list of them when it allows several. |
| `option_list` | One option, or a list of options when it allows several. |
| `button`, `signature` | Cannot be filled. |

Every name and value is checked before anything is changed, so a request with one wrong entry fails as a whole and names it; for a name that does not exist, `details.valid_fields` lists the names that do. A value may be at most [[pdf.maxDataValueChars]] characters, and no longer than the field's own maximum. Filled fields are drawn in Helvetica, a standard PDF font, so values have the same Latin-only rule as `stamp` text.

`"flatten": true` turns the form into ordinary page content: the values stay where they are and can no longer be changed. Without it, the fields stay editable.

### fields

```json
{ "files": [{ "url": "https://example.com/forms/application.pdf" }] }
```

The answer lists every field of the form with its type, its current value and, for choices, its options:

```json
{
  "op": "fields",
  "pages": 2,
  "credits_used": 0,
  "fields": [
    { "name": "applicant.name", "type": "text", "value": "", "required": true, "read_only": false, "pages": [1], "multiline": false },
    { "name": "applicant.email", "type": "text", "value": "", "required": true, "read_only": false, "pages": [1], "multiline": false },
    { "name": "plan", "type": "radio", "value": null, "options": ["Basic", "Plus"], "required": false, "read_only": false, "pages": [1] },
    { "name": "country", "type": "dropdown", "value": null, "options": ["Germany", "Lebanon", "Nigeria"], "required": false, "read_only": false, "pages": [2], "multiselect": false, "editable": false },
    { "name": "newsletter", "type": "checkbox", "value": false, "required": false, "read_only": false, "pages": [2] }
  ]
}
```

`pages` of a field are the pages it appears on. A text field with a maximum length has `max_length`. A PDF without a form answers an empty `fields` list. `fields` never writes a file and counts nothing; the toolkit's rate limit applies to it like to the other operations.

### from-images

```json
{
  "files": [
    { "url": "https://example.com/scans/receipt-front.jpg" },
    { "url": "https://example.com/scans/receipt-back.jpg" }
  ],
  "page_size": "a4",
  "fit": "fit",
  "margin": 36,
  "filename": "receipt-scans.pdf"
}
```

One image per page, in the order of the list. Photos are drawn the right way up, following the turn a phone camera records in the file.

| Field | Values | Default |
| --- | --- | --- |
| `page_size` | `[[pdf.formats]]`, or `auto`: the page is the size of the image, one point per pixel | `a4` |
| `fit` | `fit`: the whole image, as large as the margins allow, centred. `fill`: the page covered edge to edge, the image cut to it. | `fit` |
| `orientation` | `auto` (portrait or landscape, whichever suits each image), `portrait`, `landscape` | `auto` |
| `margin` | Points around a `fit` image | `0` |

### protect

```json
{
  "files": [{ "pdf_id": "5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e" }],
  "user_password": "open-sesame",
  "owner_password": "a-longer-owner-secret",
  "permissions": { "printing": "low", "copying": false, "modifying": false }
}
```

The file is encrypted with AES-256.

| Field | Description |
| --- | --- |
| `user_password` | Needed to open the file. Without one, the file opens for everyone and only the permissions apply. |
| `owner_password` | Lifts the permissions. Required whenever a permission is restricted, and must differ from `user_password`. |
| `permissions` | `printing`: `high` (default), `low` or `none`. `modifying`, `copying`, `annotating`, `filling_forms`, `content_accessibility` and `document_assembly`: `true` (default) or `false`. |

Passwords are 1 to 127 printable ASCII characters: letters, digits, spaces and punctuation, without accents. A request must set a `user_password` or restrict a permission, or the file would work as before.

The password to open the file is real encryption. The permissions are not: PDF readers are asked to honour them, but a reader that ignores them can print or copy from a file it can open. Use them as a clear statement of intent, not as protection of a secret.

## Encrypted files and XFA forms

Two kinds of PDF are refused, with a message that says what to do:

- **Encrypted files** (password-protected), including files that open without a password but limit printing or changes. The toolkit does not remove protection that someone else set: open the file with its password, save it without protection, then send it. The answer is 400 `invalid_request` with `details.reason` `encrypted`.
- **XFA forms**, a kind of form that some form designers make instead of standard PDF forms. The toolkit cannot read or write XFA, and would silently lose the form's data. The answer is 400 `invalid_request` with `details.reason` `xfa`. Print or export the form to a new PDF first. Standard PDF forms (AcroForm) work with `fill` and `fields`.

A file that is not a PDF answers 415 `unsupported_media_type` (`details.reason` `not_pdf`), and a damaged one 400 `invalid_request` (`details.reason` `damaged`). A very complex file, whose structure would need more memory than one request may use, answers 413 `payload_too_large` with `details.reason` `too_complex`: split it into smaller files, or save it again with a PDF program, which often simplifies it.

## What counts

The result is counted by its pages: one image for each started block of [[toolkit.pagesPerUnit]] pages, at least one. A result of [[toolkit.examplePages]] pages counts [[toolkit.exampleUnits]] images, the largest result of [[toolkit.maxPages]] pages counts [[toolkit.maxUnits]].

- **split** counts each new file on its own pages, and the answer's `credits_used` is their sum.
- **fields** counts nothing.
- The images come from the same monthly allowance and top-ups as cards and PDFs, as one block per request, like a PDF. When too few are left for the result, the answer is 402 `quota_exceeded` and no file is delivered. Nothing is downloaded while not even one image is left.
- **Every request counts.** Results are not served from storage again: the same request sent twice makes two results and counts twice. A result that `protect` encrypts differs each time anyway.
- A request that fails counts nothing.
- In the dashboard's usage, each request that counts shows as one PDF.

On the [[plan.free.name]] plan, every page of a result carries one small grey line at the bottom, "[[pdf.freeMark]]", on a white background of its own<!-- feature:pdf -->, like the mark of [PDF documents](/docs/pdf#the-free-footer-mark)<!-- /feature:pdf -->. It is part of the page, also inside a file that `protect` encrypts. Results made on [[plan.starter.name]] and [[plan.pro.name]] have no mark.

## Limits

| Limit | Value |
| --- | --- |
| Files per request | [[toolkit.maxFiles]] for `merge` and `from-images`, one for the others |
| Files of one request together | [[toolkit.maxInputMb]] MB |
| One image | [[toolkit.maxImageMb]] MB; a PNG at most [[limit.maxImageMegapixels]] megapixels |
| Pages | [[toolkit.maxPages]] per file, and per result (all files of a `split` together) |
| Files made by one `split` | [[toolkit.maxFiles]] |
| What one request makes | [[toolkit.maxOutputMb]] MB, all files of a `split` together (a split copies the images and fonts its pages share into every file) |
| Form fields | [[toolkit.maxFormFields]] fields and widgets per file |
| Stamp text and form values | [[pdf.maxDataValueChars]] characters |
| Request body | [[toolkit.maxRequestBodyMb]] MB; as JSON at most [[toolkit.maxJsonElements]] elements (the files' base64 text does not count), as multipart one part per file plus `image` and `options` |

The toolkit has its own rate limit per API key, listed with the others under [Rate limits](/docs/limits#rate-limits).

## API reference

### POST /v1/pdf-tools/{operation}

`{operation}` is one of `[[toolkit.ops]]`; any other answers 404 `not_found`. Needs an API key. The body is JSON with `files` and the fields of the operation, described above, or the same as [multipart](#upload-the-files). Any other field is refused with 400 `invalid_request`.

**JSON answer:** `op`, then for one result `id` (use it as `pdf_id` in a later request), `url`, `pages`, `bytes`, `credits_used`, `filename`, `created_at`, `expires_at` and `usage` (the same object as [`GET /v1/usage`](/docs/api#get-v1-usage)). `split` answers `files` (each with `range`, `id`, `url`, `pages`, `bytes`, `credits_used` and `filename`), `pages`, `credits_used`, `created_at`, `expires_at` and `usage`. `fields` answers `fields`, `pages` and `credits_used`.

**Binary answer** (`"response": "binary"`): `Content-Type: application/pdf`, `Content-Disposition: inline; filename="..."`, `X-LTC-Pages`, `X-LTC-Credits-Used` and `X-LTC-Pdf-Url` (the stored result's URL).

### Errors

The same error format and codes as the rest of the API ([Errors](/docs/api#errors)):

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | A malformed body, an unknown field, a wrong page range, an encrypted file, an XFA form, a damaged file, a form field that does not exist, text the standard fonts cannot show. The message says what to change. |
| 402 | `quota_exceeded` | Not enough images left for the result; see [What counts](#what-counts). |
| 404 | `not_found` | A `pdf_id` that is not one of your stored PDFs, or whose storage time has ended, or an operation that does not exist. |
| 413 | `payload_too_large` | The body, the files together (also a `url` file that turns out larger than what is left: `details.url`), one image, a PNG's pixels, the pages, a form's fields or what the request would make are over their limit, or a file is too complex. `details` names the limit. |
| 415 | `unsupported_media_type` | A file is not a PDF, or an image is not a PNG or JPEG. |
| 422 | `image_fetch_failed` | A `url` file could not be downloaded. `details.url` and `details.reason` say which and why. |
| 429 | `rate_limited` | Over a [rate limit](/docs/limits#rate-limits). Retry after the seconds in `Retry-After`. |
| 503 | `not_configured` | The toolkit is switched off on this deployment: "The PDF toolkit is not enabled yet." |

The [OpenAPI description](/openapi.yaml) has a schema for every operation.

## In your browser, without an account

[Merge PDF](/tools/merge-pdf) and [Image to PDF](/tools/image-to-pdf) do the same as `merge` and `from-images` on this site, in your browser: the files are not uploaded, nothing is counted and nothing is marked. Use the API when the files come from your own system, or for the other operations.
