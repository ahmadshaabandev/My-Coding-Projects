---
title: "HTML to PDF in n8n: make a PDF in a workflow with one HTTP request"
description: How to turn data from an n8n workflow into a PDF with one HTTP request to the Link To Card API, and pass the PDF's URL or the file itself to the next step.
layout: page
feature: pdf
---

An n8n workflow can call any HTTP API from one of its steps. That is all you need to make a PDF: one `POST` request with a template and the data from earlier steps, and the answer is a link to the finished PDF, or the PDF itself.

We could not open n8n's documentation while writing this guide, so it does not name n8n's buttons and fields; it says what the request must contain. n8n's own documentation of its HTTP request step is the authority on where each setting lives.

## What you need

- A [[site.name]] account and an API key from the dashboard (**API keys**). The [[plan.free.name]] plan works; its PDFs carry a "[[pdf.freeMark]]" line on every page.
- A template. Start with a starter template by its id: `invoice`, `receipt`, `quote`, `certificate` or `report`. [PDF documents](/docs/pdf#starter-templates) lists the keys each one fills in.
- A workflow whose earlier steps produce the values, for example a form submission, a new row in a sheet or an order from a shop.

## 1. Keep the API key out of the workflow

Store the key as an n8n credential that adds a header to the request, rather than typing it into the step, so it is not shown to everyone who opens the workflow. The header is:

```text
Authorization: Bearer ltc_your_api_key
```

## 2. Send the request

Set up the HTTP request step with:

| Setting | Value |
| --- | --- |
| Method | `POST` |
| URL | `[[site.url]]/v1/pdf` |
| Headers | `Authorization` from the credential, and `Content-Type: application/json` |
| Body | JSON, as below |

The body names the template, the data and, if you like, the file name:

```json
{
  "template": "receipt",
  "data": {
    "seller_name": "Little Kiln Ceramics",
    "receipt_number": "R-10482",
    "date": "Nov 25, 2026",
    "buyer_name": "Priya Raman",
    "payment_method": "Card ending 4417",
    "currency": "USD",
    "items": [
      { "description": "Stoneware mug", "quantity": "2", "amount": "56.00" }
    ],
    "total": "56.00"
  },
  "filename": "receipt-R-10482.pdf"
}
```

Replace the example values with values from earlier steps, using n8n's expressions. Three rules decide whether the request is accepted:

- Keys are lowercase letters, digits and `_`, starting with a letter, such as `buyer_name`. A key the template does not use is ignored.
- Values are text or numbers. Send money as the text you want printed, such as `"1,250.00"`: the templates never calculate.
- `items` is a list of flat objects, one per line, with at most [[pdf.maxItems]] entries.

If you send your own HTML instead of a starter template, check that n8n leaves its `{{placeholders}}` alone: [[site.name]] placeholders use double curly braces, and automation tools often use a similar syntax for their own expressions. Saving the template in the [[site.name]] dashboard and sending only its id (`"template": "t_..."`) avoids the question.

## 3. Use the answer

**The default answer is JSON** with the PDF's public `url`:

```json
{
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e.pdf",
  "pages": 1,
  "credits_used": [[pdf.baseUnits]],
  "cached": false,
  "filename": "receipt-R-10482.pdf"
}
```

(The full answer has a few more fields; see the [API reference](/docs/pdf#post-v1-pdf).) Put `url` into the next step: an email with a download link, a cell in a sheet, a message to your team. The link needs no login and works for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]].

**To attach the PDF itself**, add `"response": "binary"` to the body and set the step to keep the response as a file rather than parse it as JSON. A later step, such as one that sends an email, can then attach that file.

## 4. Handle errors

The API answers with a status code and a JSON error that says what to change:

| Status | What it means | What to do |
| --- | --- | --- |
| 400 `invalid_request` | A key, a value or the body is not valid | Read `error.message`; fix the mapping |
| 401 `invalid_api_key` | The key is missing, wrong or revoked | Check the credential |
| 402 `quota_exceeded` | Not enough images left this period for this PDF | Wait for the next period, or upgrade |
| 422 `template_error` | The document cannot be printed, for example more than [[pdf.maxPages]] pages | Shorten it or fix the template |
| 429 `rate_limited` | Too many requests at once | Wait for the seconds in `Retry-After`, then retry |
| 5xx | A problem on our side | Retry after a minute |

If the workflow retries failed steps, retry only 429 and 5xx answers. A 4xx answer fails the same way every time until the data changes.

## Running the workflow again

The same template, data and file name give the same PDF. When a workflow runs twice for the same order, the second request is answered from storage: `cached` is `true`, `credits_used` is `0`, and the link is the same. So a retry never counts twice.

A PDF counts as [[pdf.baseUnits]] images for 1 to [[pdf.basePages]] pages, and one more for each further [[pdf.extraPagesPerUnit]] pages started. [What counts](/docs/pdf#what-counts) has the full rule.

## FAQ

### Do I need a paid n8n plan or a community node?

Not for [[site.name]]: the API is a plain HTTP endpoint, and the request above is all it needs. Which n8n plans and hosting options include what is decided by n8n; check their pricing and documentation.

### Can I try the template before building the workflow?

Yes. The free [invoice generator](/tools/invoice-generator), [certificate generator](/tools/certificate-generator) and [HTML to PDF](/tools/html-to-pdf) pages make the same PDFs without an account, so you can see a layout first.

### My PDF shows empty fields. Why?

A key that is missing or misspelled renders as empty, without an error, so a typo in a key name looks like a missing value. Compare your keys with the template's list in [PDF documents](/docs/pdf#starter-templates).

### Can the PDF include images from my workflow?

Yes, as public `https://` addresses in the data, such as `logo_url`. They are downloaded when the PDF is made, so they must load without a login. An image that cannot be downloaded fails the request with 422 `image_fetch_failed`, naming the address.

## Make it your own

Start with a starter template, then move to your own HTML and CSS when you want your own design: the request stays the same, only `template` changes. [Start free with [[site.name]]](/login), or read [PDF documents](/docs/pdf) first.

Related: [HTML to PDF with Zapier](/guides/html-to-pdf-zapier-webhooks) · [Invoice PDFs from a Stripe webhook](/guides/invoice-pdf-from-stripe-webhook)
