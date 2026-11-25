---
title: "HTML to PDF with Zapier: make a PDF from a webhook step"
description: Make a PDF in a Zap with one webhook step that calls the Link To Card API, then use the PDF's public link in the steps that follow, with no code.
layout: page
feature: pdf
---

A Zap can call an API it has no integration for with a step that sends its own HTTP request; Zapier calls these webhook steps. One such step, sending a template and the data from your trigger to [[site.name]], is enough to make a PDF. The answer contains a public link to the PDF that every later step can use.

We could not open Zapier's help pages while writing this guide, so it does not name Zapier's fields or say which Zapier plans include webhook steps; it says what the request must contain. Check both in Zapier itself.

## What you need

- A [[site.name]] account and an API key from the dashboard (**API keys**). On the [[plan.free.name]] plan every page of a PDF carries a "[[pdf.freeMark]]" line.
- A template: a starter template by its id (`invoice`, `receipt`, `quote`, `certificate`, `report`) or one of your own. [PDF documents](/docs/pdf#starter-templates) lists the keys each starter template fills in.
- A trigger with the values to print, for example a new form entry or a new order.

## 1. Add a webhook step that sends a POST request

Choose the kind of webhook step that lets you set the method, the headers and a raw body. Then:

| Setting | Value |
| --- | --- |
| Method | `POST` |
| URL | `[[site.url]]/v1/pdf` |
| Header `Authorization` | `Bearer ltc_your_api_key` |
| Header `Content-Type` | `application/json` |
| Body | JSON, as below |

Anyone who can edit the Zap can read the key in this step. Use a key only for this Zap, so that you can revoke it on its own in the dashboard.

## 2. Write the body

A certificate of completion, with the values from the trigger in place of the examples:

```json
{
  "template": "certificate",
  "data": {
    "title": "Certificate of Completion",
    "recipient_name": "Amara Nwosu",
    "achievement": "for completing the Advanced TypeScript workshop",
    "issuer_name": "Lanternworks Training",
    "date": "November 25, 2026",
    "certificate_id": "LW-2026-0381"
  },
  "filename": "certificate-LW-2026-0381.pdf"
}
```

When you insert a value from the trigger into the JSON, it must stay valid JSON. A value that contains a double quote or a line break, such as a free-text answer from a form, breaks the body unless it is escaped, and the API then answers 400 `invalid_request`. Keep such fields out of the body, or clean them in an earlier step.

Line items (`items`) are a JSON list, which is awkward to build from a trigger that gives one row at a time. Two ways round it:

- Use a template without a list: `certificate` has none, and `report` also works with only a title and a summary.
- Build the list in the system that sends the trigger, and pass it through as one piece of JSON text.

## 3. Use the link in the next steps

The answer is JSON. The field to map into later steps is `url`, the public address of the PDF:

```json
{
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e.pdf",
  "pages": 1,
  "credits_used": [[pdf.baseUnits]],
  "cached": false,
  "filename": "certificate-LW-2026-0381.pdf"
}
```

(The full answer has a few more fields; see the [API reference](/docs/pdf#post-v1-pdf).)

- **In an email or a message**, put `url` in as a download link. It needs no login.
- **As an attachment**, a later step has to fetch the file from `url`. Whether a step can turn a link into an attachment depends on that step; check it in Zapier.
- **In a sheet or a database**, store `url` with the record, so the PDF can be found again.

The link works for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]]. After that it answers 404, and sending the same request again makes a new one.

## 4. When the step fails

The API answers with an error code and a message that says what to change:

| Status | Code | Usual cause in a Zap |
| --- | --- | --- |
| 400 | `invalid_request` | The body is not valid JSON after the values were inserted, or a key is not lowercase |
| 401 | `invalid_api_key` | The `Authorization` header is missing the word `Bearer`, or the key was revoked |
| 402 | `quota_exceeded` | The images of this period are used up |
| 422 | `template_error` or `image_fetch_failed` | The document cannot be printed, or an image address cannot be downloaded |
| 429 | `rate_limited` | Too many PDFs at once: wait for the seconds in `Retry-After` |

## A Zap that runs twice

If the trigger fires twice for the same record, the second request is answered from storage: the same `url`, `cached: true`, `credits_used: 0`. Nothing counts twice as long as the data and the file name are the same.

## FAQ

### Is there a Link To Card app in Zapier?

No. [[site.name]] offers an HTTP API and nothing else, so the webhook step is the way in.

### How many images does one PDF use?

[[pdf.baseUnits]] for 1 to [[pdf.basePages]] pages, then one more for each further [[pdf.extraPagesPerUnit]] pages started, up to [[pdf.maxUnits]] for [[pdf.maxPages]] pages. A failed request uses none. [What counts](/docs/pdf#what-counts)

### Can I see the PDF before I build the Zap?

Yes. The free [certificate generator](/tools/certificate-generator), [invoice generator](/tools/invoice-generator) and [HTML to PDF](/tools/html-to-pdf) pages make the same kind of PDF without an account.

### Can I use my own design?

Yes. Save your HTML and CSS as a template in the [[site.name]] dashboard and put its id (`t_...`) in `template`. The Zap stays the same.

## Start

[Start free with [[site.name]]](/login), create an API key, and paste the request above into a webhook step. [PDF documents](/docs/pdf) covers every field.

Related: [HTML to PDF in n8n](/guides/html-to-pdf-n8n) · [Invoice PDFs from a Stripe webhook](/guides/invoice-pdf-from-stripe-webhook)
