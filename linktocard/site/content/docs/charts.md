---
title: Chart images
description: "Turn a chart described as JSON into a PNG, JPEG or WebP image for emails, PDF reports and chat messages: every field of the chart JSON with its default and limit, signed chart URLs with a Node.js signer, POST /v1/charts, what counts, errors and an email example."
layout: doc
order: 3.7
nav: Chart images
feature: charts
---

A chart image is a chart drawn as an ordinary picture. Emails, PDF reports and chat messages cannot run the JavaScript that draws charts on a web page, but they all show images. You describe the chart as a small JSON object, and [[site.name]] draws it.

There are three ways to get one, and the same chart JSON works in each:

- a **signed chart URL** (`GET /v1/chart/...`) that you put in an `<img>`: the image is drawn the first time someone opens it;
- **`POST /v1/charts`** with an API key, which draws and stores the chart and answers with its URL;
- the free **[chart maker](/tools/chart-maker)**, which needs no account: make a chart by hand and copy its JSON with "Copy chart JSON".

```json
{
  "type": "bar",
  "title": "Orders per quarter",
  "labels": ["Q1", "Q2", "Q3", "Q4"],
  "series": [
    { "name": "2025", "data": [120, 145, 160, 190] },
    { "name": "2026", "data": [135, 170, 182, 214] }
  ],
  "options": { "values": true },
  "width": 600,
  "height": 300,
  "scale": 2
}
```

## The chart JSON

Only the fields below are accepted. An unknown field, at any level, is refused with 400 `invalid_request`, so a typo is never silently ignored. Every message names the field, for example `series[0].data[2]: must be a finite number.`, and `details.field` holds its path.

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `type` | string | required | One of [[charts.types]]. |
| `labels` | list of strings or numbers | required | One per bar, point or slice. At least 1; at most [[charts.maxPoints]], or [[charts.maxSlices]] for `pie` and `doughnut`. Each up to [[charts.maxLabelChars]] characters. Numbers, such as years, are shown as written. |
| `series` | list of series (below) | required | At least 1, at most [[charts.maxSeries]]. A `pie` or `doughnut` chart takes exactly one. |
| `title` | string | none | Up to [[charts.maxTitleChars]] characters. |
| `subtitle` | string | none | Up to [[charts.maxSubtitleChars]] characters. |
| `options` | object (below) | all defaults | |
| `width` | whole number | [[charts.defaultWidth]] | [[charts.minWidth]] to [[charts.maxWidth]]. |
| `height` | whole number | [[charts.defaultHeight]] | [[charts.minHeight]] to [[charts.maxHeight]]. |
| `scale` | number | `1` | [[charts.scales]]. The image is `width` x `scale` by `height` x `scale` pixels, at most [[charts.maxPixels]] pixels in all. Use `2` for images that stay sharp on high-density screens. |

### Series

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `data` | list of numbers | required | One number per label, in the same order. Each is 0, or between [[charts.minAbsValue]] and [[charts.maxAbsValue]] in size; smaller values are refused, so use a smaller unit. Negative numbers are drawn on the other side of zero, except in `pie` and `doughnut` charts, which refuse them. |
| `name` | string | `Series 1`, `Series 2`, ... | Up to [[charts.maxSeriesNameChars]] characters. The legend shows it. |
| `color` | string | the next colour of the palette | `"#rgb"` or `"#rrggbb"`. |

Without `color`, series take the colours of the default palette in order: 8 colours in which neighbours stay apart for colour-blind readers, then a neutral grey, then lighter tints of the 8, which were not checked for colour-blind readers. In a `pie` or `doughnut` chart each slice takes the next colour.

### Options

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `horizontal` | true or false | `false` | Bars lying from left to right. Bar charts only; other types ignore it. |
| `stacked` | true or false | `false` | Series stacked on top of each other. Bar and area charts only; other types ignore it. |
| `legend` | true or false | `true` for `pie`, `doughnut` and charts with more than one series, else `false` | |
| `values` | true or false | `false` | Writes each value on its bar, point or slice. At most [[charts.maxValueLabels]] values are written on one chart; beyond that, some are left out. |
| `x_title`, `y_title` | string | none | Axis titles, up to [[charts.maxAxisTitleChars]] characters each. |
| `prefix`, `suffix` | string | none | Written before or after every number on the chart, such as `"$"`, `"%"` or `" kg"`. Up to [[charts.maxAffixChars]] characters each; spaces are kept. |
| `decimals` | whole number | chosen from the data | 0 to [[charts.maxDecimals]]. |
| `min`, `max` | number | from the data | The ends of the value axis. `max` must be greater than `min`. |
| `theme` | string | `"light"` | `"light"` or `"dark"`. |
| `background` | string | the theme's | `"#rgb"`, `"#rrggbb"`, or `"transparent"` for a PNG with a transparent background. JPEG and WebP have no transparency: with `"transparent"` they answer 400. |

Other rules:

- The JSON is data only. No field is ever read as an address, so a chart cannot make the service fetch anything, and colours are hexadecimal only.
- Text is one line: line breaks and other control characters become spaces.
- The chart JSON is at most [[charts.maxJsonKb]] KB.
- Letters of some scripts, such as Chinese, Japanese, Korean or Arabic, are not in the fonts the charts use and are drawn as empty boxes; the answer then has a warning.

## Signed chart URLs

```text
[[site.url]]/v1/chart/{site id}.png?c={chart JSON}&sig={signature}
```

- The extension chooses the format: `.png`, `.jpg` or `.jpeg` (both JPEG), or `.webp`.
- `c` is the chart JSON as text, on one line, as `JSON.stringify` writes it, URL-encoded.
- `sig` is the signature. The URL takes these two parameters and nothing else.

Sign it with your site's secret, the same way as a [signed card URL](/docs/signed-urls#the-signed-message): the lowercase hexadecimal HMAC-SHA256 of these three lines joined with `\n`:

```text
/v1/chart/s_4k2j9x0q1m7c8d5e.png
c
c={"type":"bar","labels":["Q1","Q2"],"series":[{"data":[120,145]}]}
```

The first line is the path, the second the parameter name, the third `c=` and the chart JSON exactly as it is in the URL, not URL-encoded. Code that signs card URLs signs chart URLs unchanged, with `c` as its only parameter. The signature is checked before the chart is read or drawn, so an altered URL answers 403 and costs nothing. Every part of the URL is signed: nobody can change a chart without your secret.

### Node.js

Node.js 18 or later, no dependencies. Save it as `sign-chart.mjs` and run `LTC_SITE_SECRET=... node sign-chart.mjs`.

```js
import { createHmac } from 'node:crypto';

function signedChartUrl({ secret, baseUrl, siteId, ext = 'png', chart }) {
  // The chart JSON on one line: JSON.stringify writes no line breaks.
  const c = JSON.stringify(chart);
  // Signed message, joined with "\n": the path, the parameter name, then
  // "c=" and the chart JSON as plain text, NOT URL-encoded.
  const path = `/v1/chart/${siteId}.${ext}`;
  const lines = [path, 'c', `c=${c}`];
  const sig = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');
  return `${baseUrl}${path}?${new URLSearchParams({ c, sig })}`;
}

const url = signedChartUrl({
  secret: process.env.LTC_SITE_SECRET,
  baseUrl: '[[site.url]]',
  siteId: 's_4k2j9x0q1m7c8d5e',
  chart: {
    type: 'bar',
    title: 'Orders per quarter',
    labels: ['Q1', 'Q2', 'Q3', 'Q4'],
    series: [{ name: '2026', data: [135, 170, 182, 214] }],
    width: 600,
    height: 300,
    scale: 2,
  },
});
console.log(url);
```

Your site id and its secret are in the dashboard, under **Sites & URLs**. Keep the secret on your server: anyone who has it can make charts on your account.

**Long charts make long URLs.** The chart JSON travels in the URL, and URL-encoding makes it longer still. A signed chart URL may be at most [[charts.maxSignedUrlChars]] characters (path and query); a longer one answers 403 `invalid_signature` with `details.reason` `url_too_long`. Some email programs and image proxies may cut long URLs short before that. For a chart with many points, use [`POST /v1/charts`](#post-v1-charts) instead and put the URL it answers with in your email.

The image comes with:

- `Cache-Control: public, max-age=...` of up to [[charts.maxAgeDays]] days, and never longer than the image stays stored, so mail apps and their image proxies can keep it;
- an `ETag`, and a request with a matching `If-None-Match` answers 304;
- `X-LTC-Cache` (`hit` or `miss`) and `X-LTC-Credits-Used`: `1` for the request that was counted, `0` otherwise.

`HEAD` never draws and never counts.

## POST /v1/charts

Send the chart JSON with an API key from your dashboard. The body takes one field more, `format`: `"png"` (the default), `"jpeg"` (or `"jpg"`) or `"webp"`.

```shell
curl [[site.url]]/v1/charts \
  -H "Authorization: Bearer ltc_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "line",
    "title": "Visitors per month",
    "labels": ["Jan", "Feb", "Mar", "Apr"],
    "series": [{ "name": "Website", "data": [1200, 1350, 1280, 1610] }],
    "width": 600,
    "height": 300,
    "scale": 2,
    "format": "png"
  }'
```

The answer, for a first chart on the [[plan.free.name]] plan:

```json
{
  "id": "5d0c3f8e9a7b41c2d6e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/5d0c3f8e9a7b41c2d6e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6.png",
  "width": 1200,
  "height": 600,
  "format": "png",
  "bytes": 20791,
  "cached": false,
  "credits_used": 1,
  "created_at": "[[charts.example.createdAt]]",
  "expires_at": "[[charts.example.expiresAt]]",
  "warnings": [],
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": [[charts.example.limit]],
    "used": 1,
    "remaining": [[charts.example.remaining]],
    "topup_remaining": 0,
    "total_remaining": [[charts.example.remaining]],
    "cache_days": [[charts.example.cacheDays]],
    "watermark": true
  }
}
```

- `width` and `height` are the image's pixels: the chart's size times `scale`.
- `url` is public and works until `expires_at`. The same chart on the same account always has the same `id`.
- `cached` is `true` when the chart was already stored; `credits_used` is `1` for the request that counted it and `0` otherwise.

The endpoint has the rate limits of `POST /v1/images`: [[charts.apiRateLimit]] per API key. See [Limits](/docs/limits#rate-limits).

## What counts

**A chart is counted once: 1 image the first time it is drawn.** A chart is your account, the chart JSON and the output format. The JSON is compared by what it means, so the order of its keys, its white space, `1.0` against `1`, `"#ABC"` against `"#aabbcc"`, and a default written out or left out all make the same chart. `width`, `height` and `scale` are part of the JSON: another size is another chart.

- **Repeat views are free.** While the chart is stored, requests for it are answered from the cache: for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]].
- When the stored copy has expired, the next request draws and stores the chart again without counting it again, for [[charts.chargeMemoryDays]] days from the time it was counted. After those days, the next drawing counts once more.
- A signed URL and `POST /v1/charts` share the count: a chart counted through one is not counted again through the other.
- A chart counted on [[plan.free.name]] is not counted again after a change to a paid plan, or back: it is drawn again with or without the mark, for free.
- At the limit, a new chart answers 402 `quota_exceeded`, like any new image ([Limits](/docs/limits#at-the-limit)). A chart that was already counted keeps being served, also when it has to be drawn again.
- A refused or failed request is never counted. `HEAD` never counts.
- The free [chart maker](/tools/chart-maker) needs no account and counts nothing.

## The corner mark on the Free plan

On the [[plan.free.name]] plan, charts carry the small `[[site.host]]` mark in one corner, like every [[plan.free.name]]-plan image. The layout keeps a strip free for it, so it never covers the chart. Paid plans have no mark.

## In an email

Draw the chart at `"scale": 2` and show it at its `width`, so it stays sharp on high-density screens, and give it alt text that says what the chart shows:

```html
<img src="URL" width="600" alt="Orders per quarter: 135, 170, 182 and 214 in 2026" style="display: block; max-width: 100%; height: auto; border: 0;">
```

- In HTML, write each `&` of a signed URL as `&amp;`, as in any attribute value. The mail app reads it back as `&`, and the signature still matches.
- Use `.png` or `.jpg`: not every email program shows WebP.
- Keep the numbers that matter in the email's text as well, for readers whose mail app does not load images.

## Errors

Errors are JSON, like every error of the [API](/docs/api#errors): `{ "error": { "code": ..., "message": ..., "details": ... } }`.

| Status | `error.code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | The chart JSON is refused. The message names the field and `details.field` holds its path. |
| 400 | `unsupported_format` | `format` is not `png`, `jpeg`, `jpg` or `webp`. |
| 401 | `unauthorized`, `invalid_api_key` | `POST /v1/charts` without a valid API key. |
| 402 | `quota_exceeded` | A new chart, and no images are left this period. |
| 403 | `invalid_signature` | A signed chart URL that does not verify; `details.reason` says why (below). |
| 403 | `account_suspended` | The account is suspended. |
| 404 | `not_found` | The site id in a signed URL is unknown, or the path is not a chart path. |
| 413 | `payload_too_large` | The chart JSON is longer than [[charts.maxJsonKb]] KB; `details.max_bytes` holds the limit. |
| 422 | `template_error` | The chart is too complex to draw. Use fewer points or series. |
| 429 | `rate_limited` | Too many requests; wait as long as the `Retry-After` header says. |
| 500 | `render_failed` | Drawing failed on our side. Nothing was counted. |
| 503 | `not_configured` | Chart images are switched off on this deployment. |
| 504 | `render_timeout` | Drawing took too long. Nothing was counted. |

The reasons of a 403 `invalid_signature`:

| `details.reason` | What happened |
| --- | --- |
| `missing_sig`, `malformed_sig` | There is no `sig`, or it is not 64 hexadecimal characters. |
| `missing_chart` | There is no `c` parameter. |
| `unknown_param` | The URL has a parameter other than `c` and `sig`. |
| `duplicate_param` | `c` or `sig` appears twice. |
| `bad_value` | The chart JSON has a line break, a tab or another control character outside its strings. Write it with `JSON.stringify`. |
| `url_too_long` | The URL is longer than [[charts.maxSignedUrlChars]] characters. Use `POST /v1/charts`. |
| `signature_mismatch` | The signature does not match: a different secret, or a URL changed after signing. Sign the JSON exactly as it is in the URL. |

## Not supported

- Chart types other than [[charts.types]].
- Chart configurations of chart libraries, such as Chart.js or ECharts options. Write the chart JSON described here.
- Interactive charts: the image does not respond to hover or clicks.
- Dates as such: labels are text, drawn in the order you give them and evenly spaced.
<!-- feature:pdf -->
- A chart as a built-in block of PDF templates.
<!-- /feature:pdf -->
- Chart steps in Zapier, Make or n8n.
- A chart builder in the dashboard. Make charts by hand with the [chart maker](/tools/chart-maker).
