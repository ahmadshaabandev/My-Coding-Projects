# Link To Card

[Link To Card](https://linktocard.com) makes social card images (for example Open Graph images)
and PDF documents from templates. Every module of this app is one request to the Link To Card API
with your API key, so a scenario gets the same results, limits and counting as any other API
client.

## Connect your account

1. In the Link To Card dashboard, open **API keys** and create a key for Make. It starts with `ltc_`.
   A key of its own lets you revoke Make's access without touching your other keys.
2. In Make, create a Link To Card connection and paste the key. The connection is checked with
   `GET /v1/usage`, which counts nothing, and is labelled with your plan.

Leave **API address** (advanced settings) as it is.

## Modules

| Module | What it does | API request |
| --- | --- | --- |
| Create a card image | Renders a card from a starter template or one of your own templates, with your data. Returns its link, and the file if you ask for it. | `POST /v1/images` |
| Create a card from a link | Makes a card from a web page's own title, description, site name and icon. | `POST /v1/cards/from-url` |
| Create a PDF | Makes a PDF from a PDF starter template (invoice, receipt, quote, certificate, report) or one of your own templates. Returns its link and, unless you switch it off, the file. | `POST /v1/pdf` |
| Start bulk PDFs | Starts a batch: one PDF for every row, for example every row of a sheet. The PDFs are made in the background. | `POST /v1/batches` |
| Get a batch | Gets a batch's status, each document's link and its zip parts, and on request one part of the zip as a file. | `GET /v1/batches/{id}`, `GET /v1/batches/{id}/zip?part=N` |
| Check a link preview | Checks a page's link-preview tags and its image, with a fix for each problem. | `GET /v1/inspect` |
| Make an API call | Sends any request to the API with your connection's key. | any |

The template fields of the starter card templates are listed at
https://linktocard.com/docs/html-css-templates#starter-templates. Your own templates use the
placeholders you gave them.

Start bulk PDFs answers at once with the batch ID and status `queued`. Use Get a batch until the
status is `done`, `partial`, `failed` or `cancelled`; ask every few seconds, not in a tight loop.

Link To Card packs the finished documents of a batch into zip files of up to 500 documents and
2 GiB each, in row order, so most batches have one part. Get a batch lists them under **Zip
parts**; with **Download the zip file** set to Yes it outputs the part given in **Zip part** (part
1 unless you set another) as **File name** and **Data**. Without a file name pattern, documents are
named after the template and the row number: `certificate-1.pdf`, `certificate-2.pdf`, ..., or
`document-1.pdf`, ... for your own templates.

## What counts

Exactly what the same request counts from your own code
([Counting rules](https://linktocard.com/docs/api#counting-rules)):

- a new card counts one image; the same card again is served from storage and counts nothing while
  it is stored;
- a PDF counts by its pages, and every document of a batch counts like a PDF;
- checking a link preview counts no images.

On the Free plan, cards and PDFs carry the Free plan's mark, as they do through the API.

## When a module stops with an error

The error shows the API's status, its message and its error code, for example
`[402] ... (error code: quota_exceeded)`. The message says what to change. Some features can be
switched off on the service; a module that uses one stops with the API's own message until it is
switched on. API errors are described at https://linktocard.com/docs/api#errors.
