---
title: Zapier, Make and n8n
description: "Connectors for Zapier, Make and n8n are being prepared for listing: what they will offer, how they sign in with an API key, what counts, and how to call the API from a workflow today with one HTTP request."
layout: doc
order: 6.5
nav: Zapier, Make and n8n
feature: integrations
---

<p class="alert alert-info"><strong>Status: being prepared for listing.</strong> Connectors for Zapier, Make and n8n are being prepared. They are not published yet and not listed on any of the three platforms, so you cannot install them there today. Everything they will do is a plain API request that a workflow can send now: see <a href="#today-one-http-request">Today: one HTTP request</a>.</p>

The connectors are a convenience on top of the [API](/docs/api): each operation is one request with your API key, so a workflow gets the same results, limits and counting as your own code.

## What the connectors offer

The three connectors are meant to offer the same operations:

| Operation | What it does | API request |
| --- | --- | --- |
| Create card image | Renders a card from a starter template or one of your own, with data from earlier steps, and returns its link or the file. | [`POST /v1/images`](/docs/api#post-v1-images) |
<!-- feature:pdf -->
| Create PDF | Makes a PDF from a PDF template and data: an invoice, a receipt, a certificate. | [`POST /v1/pdf`](/docs/pdf#post-v1-pdf) |
<!-- /feature:pdf -->
<!-- feature:linkcards -->
| Card from link | Makes a card from a page's own title, description and icon. | [`POST /v1/cards/from-url`](/docs/link-cards#post-v1-cards-from-url) |
<!-- /feature:linkcards -->
| Check link preview | Checks a page's link-preview tags and its image, with a fix for each problem. Counts no images. | [`GET /v1/inspect`](/docs/api#get-v1-inspect) |
<!-- feature:batch -->
| Start bulk PDFs | Starts a batch: one PDF for every row, for example every row of a sheet. | [`POST /v1/batches`](/docs/bulk#post-v1-batches) |
| Get batch | Looks up a batch's progress, the links of its documents and its ZIP parts. | [`GET /v1/batches/{id}`](/docs/bulk#get-v1-batches-id) |
| Download a batch's ZIP | Fetches one part of a finished batch's ZIP as a file for later steps. | [`GET /v1/batches/{id}/zip`](/docs/bulk#get-v1-batches-id-zip) |
<!-- /feature:batch -->

How each one comes:

- **Zapier:** an app with these operations. Get batch looks a batch up by its id, so a workflow can wait for it to finish, and offers its ZIP parts as files.
- **Make:** an app with these operations, one per step; Get batch downloads a ZIP part when asked to. A universal module sends any other API request with the connection's key.
- **n8n:** a node package, `n8n-nodes-linktocard`, with these operations and a credential type for the API key.

## Signing in

Every connector asks for an API key from the dashboard (**API keys**) and sends it as `Authorization: Bearer ltc_...`, like any API client. The connection is checked with [`GET /v1/usage`](/docs/api#get-v1-usage), which counts nothing.

Create one key per platform. A key can be revoked in the dashboard at any time, so you can cut off one platform without touching your other keys. An account can have [[limit.maxApiKeys]] keys.

## What counts

Exactly what the same request counts from your own code:

- a new card counts one image, and the same card again is served from storage and counts nothing, so a workflow that runs twice for the same data does not count twice while the card is stored ([Counting rules](/docs/api#counting-rules));
<!-- feature:pdf -->
- a PDF counts by its pages ([What counts](/docs/pdf#what-counts)), and the same PDF request again is served from storage;
<!-- /feature:pdf -->
<!-- feature:batch -->
- every document of a batch counts like a PDF ([What counts](/docs/bulk#what-counts));
<!-- /feature:batch -->
- checking a link preview never counts as an image.

## Today: one HTTP request

Until then, use any automation tool that can send an HTTP request with your own headers and a JSON body:

| Setting | Value |
| --- | --- |
| Method | `POST` (`GET` for `/v1/inspect`, `/v1/usage`, and the status and ZIP of a batch) |
| URL | `[[site.url]]` and the path of the operation, such as `[[site.url]]/v1/images` |
| Headers | `Authorization: Bearer ltc_...` and `Content-Type: application/json` |
| Body | The JSON of the operation, as in the [API reference](/docs/api) |

Keep the API key in the tool's own place for secrets, where it has one, rather than in the step itself, so it is not shown to everyone who opens the workflow.

<!-- feature:pdf -->
Two guides go through it step by step for PDFs: [HTML to PDF in n8n](/guides/html-to-pdf-n8n) and [HTML to PDF with Zapier](/guides/html-to-pdf-zapier-webhooks).

<!-- /feature:pdf -->
If you send your own HTML in the request, check that the tool leaves `{{placeholders}}` alone: automation tools often use double curly braces for their own expressions. Saving the template in the dashboard and sending only its id (`"template": "t_..."`) avoids the question.

### Errors and retries

The API answers with a status code and a JSON error whose `message` says what to change ([Errors](/docs/api#errors)). If the workflow retries failed steps, retry only 429 and 5xx answers, after the seconds in `Retry-After` where there is one. A 4xx answer fails the same way every time until the data changes.

<!-- feature:batch -->
### Waiting for a batch

A batch is made in the background. Start it, then ask for its status every few seconds, not in a tight loop, until `status` is `done`, `partial`, `failed` or `cancelled`. Each row then has its PDF's `url`, or an `error` that says why it failed, and `zip_parts` lists the ZIP downloads, one request each. [Bulk documents](/docs/bulk#progress-and-results) describes the answer.
<!-- /feature:batch -->
