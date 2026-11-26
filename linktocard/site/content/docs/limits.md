---
title: Limits
description: What each plan includes, the technical limits that apply to every plan, how long images are cached, and exactly what happens when you reach a limit.
layout: doc
order: 7
nav: Limits
---

Two kinds of limits apply: what your plan includes each month, and technical limits that are the same for everyone. Every number on this page is generated from the values the service enforces.

## Plans and technical limits

[[> limits-table]]

[Pricing](/pricing) has the same plan numbers with the buttons to change plan.

## What counts as an image

[[> counting-rules]]

In practice:

- Ten thousand visitors sharing the same page use one image, not ten thousand.
- The same card as PNG and as WebP is two images. So is the same card in `og` and in `square`.
- A different title is a different card, and a new image.
- Changing the HTML or CSS of one of your own templates makes every card that uses it a new image the next time it is requested.
- Changing plan between [[plan.free.name]] and a paid plan does the same once, because the watermark is part of the image.
- Previews in the dashboard and the playground on the home page are never counted.

## How long images are kept

A rendered image is stored for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] days on [[plan.starter.name]] and [[plan.pro.cacheDays]] days on [[plan.pro.name]], counted from the render and fixed at that moment. While it is stored, requests for it are free.

When the period ends:

- a **signed URL** keeps working: the next request renders the card again and counts one image;
- a stored image **`url`** from `POST /v1/images` answers 404. Send the request again to get a new one.

Separately from this storage, successful image responses tell browsers and caches to keep their copy for up to one day (`Cache-Control: public, max-age=86400`).

## At the limit

When the monthly allowance and any top-ups are used up, new renders stop. There is no overage billing on any plan.

- A card that is already stored keeps being served until its cache period ends.
- A card that needs rendering answers HTTP 402, from signed URLs and from `POST /v1/images` alike:

```json
{
  "error": {
    "code": "quota_exceeded",
    "message": "The monthly allowance of 100 images on the Free plan is used up. It resets on 2026-12-01T00:00:00.000Z. Images that are already cached keep working; to render new ones now, upgrade at [[site.url]]/pricing.",
    "docs": "[[site.url]]/docs/api#errors",
    "details": {
      "usage": {
        "plan": "free",
        "period_start": "2026-11-01T00:00:00.000Z",
        "period_end": "2026-12-01T00:00:00.000Z",
        "limit": 100,
        "used": 100,
        "remaining": 0,
        "topup_remaining": 0,
        "total_remaining": 0,
        "cache_days": 7,
        "watermark": true
      }
    }
  }
}
```

Your page itself is not affected. A link that is shared while its card answers 402 gets no picture.

You are warned before this happens: an email goes to the account address when 90% of the monthly allowance is used, and another at 100%. [`GET /v1/usage`](/docs/api#get-v1-usage) and the dashboard show the current numbers at any time.

The allowance starts again at `period_end`: the first day of the next calendar month (UTC) on [[plan.free.name]], the next billing date on a paid plan. Unused images do not carry over.

## Top-ups

On [[plan.starter.name]] and [[plan.pro.name]] you can buy a top-up of [[topup.images]] images for [[topup.price]] in the dashboard.

- A top-up is a one-time purchase that you make yourself. Nothing is ever bought or charged automatically when you reach the limit.
- Top-up images are used only after the monthly allowance of the period is used up.
- They are valid for [[topup.validDays]] days from the purchase and do carry over from month to month within that time.
- Top-ups are not available on [[plan.free.name]]. There the limit is a hard stop until the next month, or until you upgrade.

<!-- feature:pdf -->
## PDF documents

A PDF counts as [[pdf.baseUnits]] to [[pdf.maxUnits]] images, depending on its pages, and is taken from the allowance as one block. Its own limits (up to [[pdf.maxPages]] pages, [[pdf.maxHtmlMb]] MB of HTML, [[pdf.renderTimeoutSeconds]] seconds to render) are listed on [PDF documents](/docs/pdf#limits), with [what counts](/docs/pdf#what-counts).

<!-- /feature:pdf -->
<!-- feature:batch -->
## Bulk documents

Every document of a batch counts like a PDF of its own pages. A batch has at most [[batch.maxRowsFree]] rows on [[plan.free.name]], [[batch.maxRowsStarter]] on [[plan.starter.name]] and [[batch.maxRowsPro]] on [[plan.pro.name]], and an account can have [[batch.maxActive]] batches waiting or running at once. [Bulk documents](/docs/bulk#limits) lists every limit, with [what counts](/docs/bulk#what-counts).

<!-- /feature:batch -->
<!-- feature:toolkit -->
## PDF toolkit

A toolkit result counts one image for each started block of [[toolkit.pagesPerUnit]] pages, at least one; reading a form's fields counts nothing. One request takes up to [[toolkit.maxFiles]] files of [[toolkit.maxInputMb]] MB together and [[toolkit.maxPages]] pages. [PDF toolkit](/docs/pdf-tools#limits) lists every limit, with [what counts](/docs/pdf-tools#what-counts).

<!-- /feature:toolkit -->
<!-- feature:linkcards -->
## Cards from links

A card made from a page counts one image, like any card. Reading the page counts against a daily allowance of page checks, per API key or per site: [[inspect.dailyFree]] on [[plan.free.name]], [[inspect.dailyStarter]] on [[plan.starter.name]] and [[inspect.dailyPro]] on [[plan.pro.name]]. See [Cards from links](/docs/link-cards#what-counts).

<!-- /feature:linkcards -->
<!-- feature:email -->
## Personalized email images

Each distinct set of open-field values is one card. Each site can render at most [[email.dailyFree]] new ones a day on [[plan.free.name]], [[email.dailyStarter]] on [[plan.starter.name]] and [[email.dailyPro]] on [[plan.pro.name]]; past that, new values get the default image. See [Email images](/docs/email-images#the-daily-limit-per-site).

<!-- /feature:email -->
## Rate limits

Rate limits are short-term request limits that protect the service. They are not part of your allowance.

[[> rate-limits-table]]

A request over a limit answers 429 `rate_limited` with a `Retry-After` header. See the [API reference](/docs/api#rate-limits).

## Fair use

The [Terms](/terms) describe what the service may not be used for and what happens to an account that abuses it. Payment, cancellation and refunds are covered by the [Terms](/terms) and the [Refund policy](/refund).
