---
title: PDF documents
description: "Turn an HTML template and JSON data into a PDF with POST /v1/pdf or a signed link: quickstart in curl, Node.js, PHP and Python, the five PDF starter templates and their keys, line-item sections, limits and how a PDF is counted."
layout: doc
order: 5.5
nav: PDF documents
feature: pdf
---

[[site.name]] turns an HTML and CSS template plus a little data into a PDF: an invoice, a receipt, a quote, a certificate of completion, a report, or any document you write yourself. Send it with an API key and get back the URL of the stored PDF or the file itself, or sign a link that renders the PDF the first time someone opens it.

## How PDFs are made

Card images and PDFs are made in different ways.

- **Card images** are still drawn without a browser, by Satori and resvg, as described in [HTML and CSS templates](/docs/html-css-templates).
- **PDFs** are printed by [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/), which runs headless Chrome on Cloudflare's network. CSS works as it does when Chrome prints a page, including grid, flexbox and print rules such as `break-inside: avoid` and `break-before: page`.

What the browser gets is always a document that [[site.name]] built from your template, never a web address to open:

1. Your HTML is parsed, cleaned of everything that could run or load something (see [What is removed](#what-is-removed)), and your data is filled in.
2. Every remote image the document uses is downloaded first, through the same guarded fetcher as card images (public `http` and `https` addresses only), and embedded in the document.
3. Chrome prints the result with JavaScript turned off and no network access.

So nothing in a PDF depends on a script, a tracking pixel or a web font loaded at print time.

## Quickstart

You need an API key from the dashboard (**API keys**). Every example sends the same invoice, made with the `invoice` starter template.

### curl

```bash
curl [[site.url]]/v1/pdf \
  -H "Authorization: Bearer $LTC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "invoice",
    "data": {
      "seller_name": "Fernhill Studio",
      "seller_email": "billing@fernhill.example",
      "buyer_name": "Okafor & Lund Architects",
      "invoice_number": "INV-2026-0142",
      "issue_date": "Nov 25, 2026",
      "due_date": "Dec 25, 2026",
      "currency": "USD",
      "items": [
        { "description": "Brand strategy workshop", "quantity": "2", "unit_price": "1,200.00", "amount": "2,400.00" },
        { "description": "Visual identity system", "quantity": "1", "unit_price": "3,800.00", "amount": "3,800.00" }
      ],
      "subtotal": "6,200.00",
      "tax_label": "Sales tax (8%)",
      "tax": "496.00",
      "total": "6,696.00",
      "payment_terms": "Due within 30 days."
    },
    "filename": "invoice-INV-2026-0142.pdf"
  }'
```

The answer, on a [[plan.free.name]] account (the values are examples):

```json
{
  "id": "5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e",
  "url": "[[site.url]]/i/u_hkr8wty4jftnyum3/5d2b0f7e9c4a1e8b3f6d0c2a7b9e4f1d8c3a6b0e5f2d9c4a7b1e8f3d6c0a2b5e.pdf",
  "pages": 1,
  "bytes": 61873,
  "credits_used": [[pdf.baseUnits]],
  "cached": false,
  "template": "invoice",
  "filename": "invoice-INV-2026-0142.pdf",
  "created_at": "2026-11-25T10:14:03.512Z",
  "expires_at": "2026-12-02T10:14:03.512Z",
  "warnings": [],
  "usage": {
    "plan": "free",
    "period_start": "2026-11-01T00:00:00.000Z",
    "period_end": "2026-12-01T00:00:00.000Z",
    "limit": 100,
    "used": [[pdf.baseUnits]],
    "remaining": 98,
    "topup_remaining": 0,
    "total_remaining": 98,
    "cache_days": 7,
    "watermark": true
  }
}
```

`url` is public: link to it, email it or download it. Add `"response": "binary"` to get the PDF itself instead.

### Node.js

Node.js 18 or later, no dependencies.

```js
import { writeFile } from 'node:fs/promises';

const response = await fetch('[[site.url]]/v1/pdf', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.LTC_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    template: 'invoice',
    data: {
      seller_name: 'Fernhill Studio',
      buyer_name: 'Okafor & Lund Architects',
      invoice_number: 'INV-2026-0142',
      issue_date: 'Nov 25, 2026',
      currency: 'USD',
      items: [{ description: 'Brand strategy workshop', quantity: '2', unit_price: '1,200.00', amount: '2,400.00' }],
      total: '2,400.00',
    },
    filename: 'invoice-INV-2026-0142.pdf',
    response: 'binary',
  }),
});
if (!response.ok) throw new Error((await response.json()).error.message);
await writeFile('invoice-INV-2026-0142.pdf', Buffer.from(await response.arrayBuffer()));
```

### PHP

PHP 7.4 or later with the `curl` extension.

```php
$body = json_encode([
    'template' => 'invoice',
    'data' => [
        'seller_name' => 'Fernhill Studio',
        'buyer_name' => 'Okafor & Lund Architects',
        'invoice_number' => 'INV-2026-0142',
        'issue_date' => 'Nov 25, 2026',
        'currency' => 'USD',
        'items' => [
            ['description' => 'Brand strategy workshop', 'quantity' => '2', 'unit_price' => '1,200.00', 'amount' => '2,400.00'],
        ],
        'total' => '2,400.00',
    ],
    'filename' => 'invoice-INV-2026-0142.pdf',
    'response' => 'binary',
]);

$ch = curl_init('[[site.url]]/v1/pdf');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('LTC_API_KEY'), 'Content-Type: application/json'],
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_RETURNTRANSFER => true,
]);
$result = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($result === false || $status !== 200) {
    throw new RuntimeException($result === false ? curl_error($ch) : json_decode($result, true)['error']['message']);
}
file_put_contents('invoice-INV-2026-0142.pdf', $result);
```

### Python

Python 3.7 or later, standard library only.

```python
import json
import os
import urllib.error
import urllib.request

body = {
    "template": "invoice",
    "data": {
        "seller_name": "Fernhill Studio",
        "buyer_name": "Okafor & Lund Architects",
        "invoice_number": "INV-2026-0142",
        "issue_date": "Nov 25, 2026",
        "currency": "USD",
        "items": [
            {"description": "Brand strategy workshop", "quantity": "2", "unit_price": "1,200.00", "amount": "2,400.00"},
        ],
        "total": "2,400.00",
    },
    "filename": "invoice-INV-2026-0142.pdf",
    "response": "binary",
}
request = urllib.request.Request(
    "[[site.url]]/v1/pdf",
    data=json.dumps(body).encode("utf-8"),
    headers={"Authorization": f"Bearer {os.environ['LTC_API_KEY']}", "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(request) as response:
        pdf = response.read()
except urllib.error.HTTPError as error:
    raise SystemExit(json.load(error)["error"]["message"])

with open("invoice-INV-2026-0142.pdf", "wb") as file:
    file.write(pdf)
```

## Starter templates

Send one of these ids as `template`. Each brings its own paper format, orientation and margins, which `pdf` in the request can change. The samples use fictional people and companies; the [free invoice generator](/tools/invoice-generator) and [certificate generator](/tools/certificate-generator) fill two of them in from a form.

Every key is optional. The ones marked as required are what the document needs to make sense, but the API does not check them: a missing key, required or not, renders as empty, and its row or label is left out so the page still looks intended.

[[> pdf-templates]]

In the `report` template, an `items` entry with an empty `heading` continues the section above it, without a new number, so a section longer than [[pdf.maxItemValueChars]] characters can be sent as several entries.

Numbers and money are display text that you send, for example `"1,250.00"`. The templates never calculate a line amount, a tax or a total: compute them in your own system, which already knows its tax rules, and send the results.

These templates are for documents your own business issues. The [Terms](/terms) forbid counterfeit or misleading documents, such as fake invoices or receipts, bank statements, utility bills, identity documents and certificates that claim to come from someone else.

## Your own HTML and CSS

Send `html` (and optionally `css`) instead of `template`, or save the template in the dashboard and send its id (`t_...`). The dashboard previews templates as card images, so check a PDF template by rendering it as a PDF. A template saved in the dashboard is checked like a card template: at most [[limit.maxHtmlKb]] KB of HTML and [[limit.maxCssKb]] KB of CSS, [[limit.maxNodes]] elements, nested at most [[limit.maxDepth]] deep. Send a larger document inline as `html`. You can send a fragment, such as a `<main>` element, or a whole document; `<style>` elements in it are kept and joined with `css`.

### Placeholders

`{{key}}` is replaced by `data.key`, in text and in attribute values. A missing key is empty. Values are always text: `<b>` in a value prints as `<b>`, it never becomes markup.

An element whose only content is an empty placeholder is empty in CSS terms, so `.line:empty { display: none; }` hides it. The starter templates use this for optional lines.

### Sections and line items

`items` is the one list in `data`: an array of flat objects. A section repeats once per entry:

```html
<table>
  <thead><tr><th>Description</th><th>Amount</th></tr></thead>
  <tbody>
    {{#items}}
    <tr><td>{{description}}</td><td>{{amount}}</td></tr>
    {{/items}}
    {{^items}}
    <tr><td colspan="2">No line items.</td></tr>
    {{/items}}
  </tbody>
</table>
```

- `{{#items}} ... {{/items}}` repeats what is in between once per entry. Inside it, `{{description}}` is the entry's own field first, then `data.description`.
- `{{^items}} ... {{/items}}` is printed only when `items` is empty or missing.
- `{{#key}} ... {{/key}}` is printed only when `data.key` has a value, and `{{^key}} ... {{/key}}` only when it is empty or missing.
- The markers may sit between elements, as around the `<tr>` rows above. A section must open and close inside the same parent element.

### What is removed

Before your data is filled in, the HTML is parsed and cleaned. The `warnings` in the response list what was removed.

- `<script>`, `<noscript>`, `<template>`, `<iframe>`, `<frame>`, `<object>`, `<embed>`, `<applet>`, `<base>`, `<meta>`, `<link>`, `<video>`, `<audio>` and similar elements, with their content.
- Every `on...` event attribute, and `javascript:` or `vbscript:` links. Links may point to `http:`, `https:`, `mailto:`, `tel:` or `#` anchors.
- Form controls are printed, but forms do nothing: `action` and `formaction` are removed.
- `<img src>` must be an `http` or `https` address, or a `data:image/...` URI. An `<img>` whose `src` is empty after the data is filled in is left out, like an optional logo.

CSS `@import` and an `@font-face` that loads a font from another address are refused with 422 `template_error` instead of being dropped, because the document would print differently from what you wrote.

In CSS, write an address that contains `(`, `)`, a quote or a space in quotes: `url("...")`. Chrome ends an unquoted `url(` at its first `)`, so a declaration whose unquoted `url(` holds `(` or a quote is removed, with a warning, and so is a rule or statement with `url(` in its selector or at-rule prelude, where `url()` has no meaning.

## Page setup

`pdf` in the request sets the page. A starter template brings its own setup; anything you send overrides it.

| Field | Values | Default |
| --- | --- | --- |
| `format` | `[[pdf.formats]]` | The template's, else `[[pdf.defaultFormat]]` |
| `landscape` | `true` or `false` | The template's, else `false` |
| `margin` | `top`, `right`, `bottom`, `left`: a length such as `"20mm"`, `"2cm"`, `"0.75in"` or `"48px"`, at most [[pdf.maxMarginMm]] mm each | The template's, else [[pdf.defaultMarginMm]] mm on every side |
| `header`, `footer` | HTML printed at the top or bottom of every page, inside the margin | None |

The paper size, orientation and margins come from `format`, `landscape` and `margin` only. A CSS `@page` rule is removed, with a warning, wherever it is: also inside `@media`, and also after `<!--` or `-->`, which Chrome skips at the top level of a stylesheet. Inside a block, a rule that starts with `<!--` or `-->` is dropped, because Chrome ignores it too. An `@page` behind an unquoted `url(` is removed with that `url(` (above).

### Header and footer

`header` and `footer` are small HTML templates, at most [[pdf.maxHeaderFooterKb]] KB each, cleaned and filled in with your data like the document. Chrome prints them in the top and bottom margin, so give the margin room for them. Chrome fills in elements with these classes on every page: `pageNumber`, `totalPages`, `date` and `title` (the document's `<title>`). The class names are case-sensitive: `pagenumber` prints nothing.

On [[plan.starter.name]] and [[plan.pro.name]] they are printed as written. They do not use the document's CSS: style them inline, font size included, or with a `<style>` element of their own.

On the [[plan.free.name]] plan they share Chrome's header and footer with the free mark, so they are printed as plain text, with page numbers, in a fixed style of ours: full width, centred, 8 pt sans-serif in dark grey.

- After your data is filled in, only the text is kept: a line break at each `<br>` and at the start and end of blocks (such as `div`, `p`, `li`, headings and table rows), a gap between table cells and between the items of an element with an inline `style="display:flex"` or `display:grid`, and the four classes above.
- Markup, `style=""` attributes, classes, `<style>` elements, images, SVG and MathML are not used, and a warning says so. Hidden content (`hidden`, `display:none`, `visibility:hidden`) is not printed, and nothing in a Free header or footer is downloaded.
- Each is cut off after the last whole line that fits: the header in the top margin less 4 mm, the footer in the bottom margin less 9 mm, above the mark. At the [[pdf.freeMarkMinBottomMm]] mm minimum bottom margin that is one line of footer, from about 16.4 mm two.

On both plans the footer of the example below prints its title and the page numbers on every page, for example "Customer Support Review, Q3 2026 · Page 2 of 7" on page 2 of a seven-page report. On [[plan.free.name]] it is printed in the fixed style, above the mark, with a warning that its markup and style were not used.

```json
{
  "template": "report",
  "data": { "title": "Customer Support Review, Q3 2026" },
  "pdf": {
    "margin": { "top": "22mm", "bottom": "22mm" },
    "footer": "<div style=\"width:100%;font-size:9px;text-align:center;color:#666\">{{title}} &middot; Page <span class=\"pageNumber\"></span> of <span class=\"totalPages\"></span></div>"
  }
}
```

## Images and fonts

**Images.** `<img src>` and CSS `url()` may name `http` or `https` images on public hosts. They are downloaded before printing, at most [[pdf.maxRemoteAssets]] different addresses and [[pdf.maxAssetMb]] MB together per PDF, and embedded in the document. Addresses on [[site.host]] itself are refused. Each image must be a PNG, JPEG, GIF or WebP file of at most [[limit.maxImageMegapixels]] megapixels, as for card images; an SVG works only as a `data:` URI. An image that cannot be downloaded fails the request with 422 `image_fetch_failed`, naming the address and the reason. A `data:image/...` URI needs no download.

**Fonts.** The three bundled families, Inter, Source Serif 4 and JetBrains Mono, are embedded when your CSS names them, as in `font-family: 'Inter', sans-serif;`. Anything else uses the fonts of Cloudflare's browser, which according to [Cloudflare's list of supported fonts](https://developers.cloudflare.com/browser-run/reference/supported-fonts/) include DejaVu, Liberation, Open Sans and Roboto, and fonts for Arabic, Chinese, Japanese and Korean. For any other script, check that list, or embed a font as a `data:` URI in `@font-face`. Fonts you uploaded in the dashboard are used for card images, not for PDFs.

## Signed PDF links

A signed PDF link works like a [signed card URL](/docs/signed-urls): you build it on your server, and the PDF is rendered and stored the first time someone opens it. Use it in an email or on a page, for example as a "Download your invoice" link.

```text
[[site.url]]/v1/pdf/{site id}/{template}.pdf?{name}={value}&...&sig={signature}
```

- `{template}` is a PDF starter template or the id of one of your own templates.
- `format`, `landscape` and `filename` set the page and the download name.
- `items` is the list for `{{#items}}` sections, as JSON text: `items=[{"description":"Design","amount":"1,200.00"}]`.
- Every other parameter is template data.

The signature is made exactly as for card URLs: HMAC-SHA256 with your site secret over the path, the sorted parameter names joined with `,`, and one `name=value` line per parameter with the plain (not URL-encoded) value, joined with `\n`. Only the path is different. The [parameter rules](/docs/signed-urls#rules) of card URLs apply too, so a link carries at most [[limit.maxDataKeys]] parameters of at most [[limit.maxDataValueChars]] characters each (`items` included) and at most [[limit.maxSignedUrlChars]] characters in all. A longer document needs `POST /v1/pdf`.

### A worked example

The secret is the example secret of the [Signed URLs](/docs/signed-urls#a-worked-example) page, not a real one.

```text
secret    ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab
site id   s_4k2j9x0q1m7c8d5e
template  invoice

invoice_number  INV-2026-0142
issue_date      Nov 25, 2026
seller_name     Fernhill Studio
buyer_name      Okafor & Lund Architects
total           2,400.00
items           [{"description":"Brand strategy workshop","quantity":"2","unit_price":"1,200.00","amount":"2,400.00"}]
filename        invoice-INV-2026-0142.pdf
```

The message to sign:

```text
/v1/pdf/s_4k2j9x0q1m7c8d5e/invoice.pdf
buyer_name,filename,invoice_number,issue_date,items,seller_name,total
buyer_name=Okafor & Lund Architects
filename=invoice-INV-2026-0142.pdf
invoice_number=INV-2026-0142
issue_date=Nov 25, 2026
items=[{"description":"Brand strategy workshop","quantity":"2","unit_price":"1,200.00","amount":"2,400.00"}]
seller_name=Fernhill Studio
total=2,400.00
```

Its signature:

```text
d69ebe2611db20876a21ad2f886fb41ca86bd6a4e3ce6066a336b7451c2fad9e
```

The finished link:

```text
https://linktocard.com/v1/pdf/s_4k2j9x0q1m7c8d5e/invoice.pdf?invoice_number=INV-2026-0142&issue_date=Nov+25%2C+2026&seller_name=Fernhill+Studio&buyer_name=Okafor+%26+Lund+Architects&total=2%2C400.00&items=%5B%7B%22description%22%3A%22Brand+strategy+workshop%22%2C%22quantity%22%3A%222%22%2C%22unit_price%22%3A%221%2C200.00%22%2C%22amount%22%3A%222%2C400.00%22%7D%5D&filename=invoice-INV-2026-0142.pdf&sig=d69ebe2611db20876a21ad2f886fb41ca86bd6a4e3ce6066a336b7451c2fad9e
```

### Signer code

The reference signers of [Signed URLs](/docs/signed-urls#signer-code) with the PDF path, and `items` turned into JSON text before it is signed. Each one prints the link above for the example. The JSON text can differ between languages (spacing, escaping); that is fine, because each signer signs exactly the text it sends.

```js
import { createHmac } from 'node:crypto';

function signedPdfUrl({ secret, baseUrl, siteId, template, params }) {
  // "items" travels as JSON text and is signed as that text. Control
  // characters are not allowed in values: replace them before signing.
  const clean = {};
  for (const [name, value] of Object.entries(params)) {
    const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
    clean[name] = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  }

  // Signed message, joined with "\n": the path, the sorted parameter names
  // joined with ",", then one "name=value" line per parameter in that order.
  const path = `/v1/pdf/${siteId}/${template}.pdf`;
  const names = Object.keys(clean).sort();
  const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];
  const sig = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');

  return `${baseUrl}${path}?${new URLSearchParams({ ...clean, sig })}`;
}
```

```php
function signed_pdf_url(string $secret, string $baseUrl, string $siteId, string $template, array $params): string
{
    // "items" travels as JSON text and is signed as that text. Control
    // characters are not allowed in values: replace them before signing.
    $clean = [];
    foreach ($params as $name => $value) {
        $text = is_array($value) ? json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : (string) $value;
        $clean[$name] = preg_replace('/[\x00-\x1F\x7F]/', ' ', $text);
    }

    // Signed message, joined with "\n": the path, the sorted parameter names
    // joined with ",", then one "name=value" line per parameter in that order.
    $path = "/v1/pdf/{$siteId}/{$template}.pdf";
    $sorted = $clean;
    ksort($sorted, SORT_STRING);
    $lines = [$path, implode(',', array_keys($sorted))];
    foreach ($sorted as $name => $value) {
        $lines[] = "{$name}={$value}";
    }
    $sig = hash_hmac('sha256', implode("\n", $lines), $secret);

    $query = http_build_query($clean + ['sig' => $sig], '', '&');
    return $baseUrl . $path . '?' . str_replace('%2A', '*', $query);
}
```

```python
import hashlib
import hmac
import json
import re
from urllib.parse import urlencode


def signed_pdf_url(secret, base_url, site_id, template, params):
    # "items" travels as JSON text and is signed as that text. Control
    # characters are not allowed in values: replace them before signing.
    clean = {}
    for name, value in params.items():
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, list) else str(value)
        clean[name] = re.sub(r"[\x00-\x1f\x7f]", " ", text)

    # Signed message, joined with "\n": the path, the sorted parameter names
    # joined with ",", then one "name=value" line per parameter in that order.
    path = f"/v1/pdf/{site_id}/{template}.pdf"
    names = sorted(clean)
    lines = [path, ",".join(names)] + [f"{name}={clean[name]}" for name in names]
    message = "\n".join(lines).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    query = urlencode({**clean, "sig": sig}, safe="*").replace("~", "%7E")
    return f"{base_url}{path}?{query}"
```

A link that does not verify answers 403 `invalid_signature` before anything is rendered, with the same `details.reason` values as card URLs ([every 403 and its fix](/docs/signed-urls#every-403-and-its-fix)).

## The free footer mark

On the [[plan.free.name]] plan every page of a PDF carries one centred line in the bottom margin: "[[pdf.freeMark]]". It is printed in grey on a small white background of its own, below your own footer if you send one, and the bottom margin is raised to at least [[pdf.freeMarkMinBottomMm]] mm to make room. On [[plan.free.name]] your header and footer are printed as plain text next to it (see [Header and footer](#header-and-footer)), so nothing in them can cover or move the mark. PDFs made on [[plan.starter.name]] and [[plan.pro.name]] have no mark. The PDFs of the free tools on this site always have it.

The mark is part of what makes a PDF unique, so after an upgrade the first request for a PDF renders it again, without the mark, and counts it.

## What counts

A PDF is taken from the same monthly allowance as card images, by its number of pages:

[[> pdf-units-table]]

- **One block.** A PDF is taken whole from the monthly allowance when it fits there, otherwise whole from one top-up that has enough left. It is never split between the two, so a period never goes below zero. When neither has enough, the answer is HTTP 402 `quota_exceeded`, with the usage in `details.usage` and the images the PDF needs in `details.units_needed`.
- **Checked twice.** Before rendering, at least [[pdf.baseUnits]] images must be left in one place, or the answer is 402 without rendering. After rendering, the real number for its pages is charged. If a long document needs more than is left, the PDF is not delivered and nothing is charged.
- **Failures are not charged.** A render that fails charges nothing. A document of more than [[pdf.maxPages]] pages, or one that makes a PDF over [[pdf.maxPdfMb]] MB, is refused with 422 `template_error` and not charged.
- **Failed renders per day.** A render that fails in the browser has still used it, so failures caused by the document are capped at [[pdf.maxFailedRendersPerDayFree]] per UTC day on [[plan.free.name]] and [[pdf.maxFailedRendersPerDayPaid]] on [[plan.starter.name]] and [[plan.pro.name]], by the plan of the account that owns the template or link:
  - **What counts:** a render that fails in the browser because of the document (more than [[pdf.maxPages]] pages, a PDF over [[pdf.maxPdfMb]] MB, a timeout, a document the browser cannot render, or a PDF whose page count cannot be read), and a PDF that needs more images than are left (402 after rendering). A render that is cut off before it ends counts too: Cloudflare stops a request about half a minute after its client went away, so a render that needs longer than that after the connection closed never reports its result, and its browser time is unknown.
  - **What does not count:** anything refused before the browser (a bad request, a template error found while cleaning it, an image that cannot be downloaded, a 402 before rendering, a rate limit), stored PDFs, answers from memory (below), and failures of Browser Run itself: a server error that is not a timeout, a refused or unreachable call, a PDF that did not finish arriving, or the renderer being busy. Those never count.
  - **Per account and per site:** `POST /v1/pdf` counts per account. Signed PDF links count per site, each site with its own [[pdf.maxFailedRendersPerDayFree]] or [[pdf.maxFailedRendersPerDayPaid]]: a link's render counts on its site whoever opens it, and reaching the cap stops only that site's new signed PDFs. `POST /v1/pdf` and your other sites are not affected.
  - **All sites together:** the signed PDF links of all your sites also share one cap of [[pdf.maxFailedSignedRendersPerDayFree]] per UTC day on [[plan.free.name]] and [[pdf.maxFailedSignedRendersPerDayPaid]] on [[plan.starter.name]] and [[plan.pro.name]], at least twice a site's, so one site never uses it up alone. A deleted site's failures stay in it, so deleting a site and creating a new one does not start a new count. Reaching it stops new signed PDFs of all your sites; `POST /v1/pdf` is still not affected.
  - **At the cap:** a render takes its place under the cap before it starts, so requests sent at the same time cannot pass it together. Past it, new PDFs there answer 429 `rate_limited` until 00:00 UTC, with `Retry-After` in seconds and `details` `{ "limit", "scope": "account", "site" or "sites", "period_seconds", "retry_after_seconds" }`. The message names the causes and how long it is until 00:00 UTC. Stored PDFs keep working.
  - **Renders still running:** a render holds its place until it ends, because it could still fail, and a successful render gives it back. When renders that are still running hold the last places under a cap (with the failures of the day), a new render answers 429 `rate_limited` with a `Retry-After` of a few seconds and the message "N PDF renders are still running for ...", `details` `{ "limit", "scope", "running", "retry_after_seconds" }`, instead of waiting for 00:00 UTC. `HEAD` and the checks before a render count only the failures.
- **Failed documents are remembered.** For [[pdf.failedRenderMemoryMinutes]] minutes after a render fails because of the document, or needs more images than are left, the identical request gets the same answer without being rendered and without counting again. Identical means the same `id`: the same account, template, data, page setup, header, footer and file name. Any change makes a new `id`, which renders at once.
  - The message then ends with "(An identical request failed like this at HH:MM:SS UTC; until HH:MM:SS UTC it gets this answer without being rendered again.)", and `details` are kept, for example `max_pages` and `pages_rendered`.
  - A remembered 402 is checked again against what is left now: after a top-up or an upgrade the PDF is rendered normally; otherwise the answer is 402 with the current usage and `units_needed`.
  - Failures of Browser Run itself are never remembered: the next request tries again.
- **Identical requests at the same time.** Only one of them renders. The others wait for it, up to [[pdf.duplicateWaitSeconds]] seconds, and get its result: the stored PDF with `credits_used: 0`, `cached: true` and `X-LTC-Cache: hit`, or, when it failed because of the document, the same answer. After any other failure, one of the waiting requests renders the PDF itself.
  - If the first request has still not finished after [[pdf.duplicateWaitSeconds]] seconds, the answer is 429 `rate_limited`: "An identical request started making this PDF ... s ago and has not finished; this request waited ... s for it and charged nothing.", with `Retry-After` set to when that request's place can be taken over. When fewer than [[pdf.baseUnits]] images are left, it is 402 instead.
  - Rarely, a render that takes unusually long is taken over by an identical request; it then answers 429 with a short `Retry-After`, or the PDF free of charge when the other request already paid for it.
- **Stored PDFs count once.** A PDF is stored for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]]. The same request in that time (same template, data, page setup, header, footer and file name) is served from storage with `credits_used: 0`. A different file name is a different PDF.
- **The dashboard shows PDFs separately**: how many were made this period, and how many images they counted as. Those images are not counted a second time: they are already in the images used from the allowance, or from the top-up they were taken from.
- **The free tools count nothing** against any account.

## Limits

[[> pdf-limits-table]]

PDF requests have their own rate limits, listed with the others under [Rate limits](/docs/limits#rate-limits). A request over a limit answers 429 `rate_limited` with a `Retry-After` header.

When [[plan.free.name]] accounts and the free tools together have used far more browser time than usual in the last 24 hours, new PDFs on the [[plan.free.name]] plan and in the free tools answer 429 `rate_limited`, with a `Retry-After` of an hour. Only their own browser time counts toward this brake: PDFs made on [[plan.starter.name]] and [[plan.pro.name]] never engage it. It lifts by itself as that use ages out of the last 24 hours, so it can last up to 24 hours after the use stopped. [[plan.starter.name]] and [[plan.pro.name]] are not affected, and stored PDFs keep working.

## API reference

### POST /v1/pdf

Needs an API key. The body is JSON, at most [[pdf.maxRequestBodyMb]] MB.

| Field | Type | Description |
| --- | --- | --- |
| `template` | string | A PDF starter template (`[[pdf.templateIds]]`) or the id of one of your own templates (`t_...`). Send exactly one of `template` and `html`. |
| `html` | string | An inline template: HTML, at most [[pdf.maxHtmlMb]] MB once the data is filled in. |
| `css` | string | CSS for an inline template, at most [[pdf.maxCssKb]] KB. Only together with `html`. |
| `data` | object | Values for the placeholders: at most [[pdf.maxDataKeys]] keys matching `^[a-z][a-z0-9_]{0,31}$`, strings or numbers of at most [[pdf.maxDataValueChars]] characters. `items` is a list of at most [[pdf.maxItems]] flat objects with at most [[pdf.maxItemFields]] fields of at most [[pdf.maxItemValueChars]] characters. |
| `pdf` | object | `format`, `landscape`, `margin`, `header`, `footer`: see [Page setup](#page-setup). |
| `filename` | string | Download name. Letters, digits, spaces and `. _ - ( )` are kept, at most [[pdf.maxFilenameChars]] characters, always ending in `.pdf`. Default: the template id, or `document.pdf` for inline HTML. |
| `response` | string | `url` (default): JSON with the stored PDF's URL. `binary`: the PDF itself. |

Any other field is refused with 400 `invalid_request`.

**JSON response fields:** `id` (64 hexadecimal characters; the same request on the same account always gives the same `id`), `url` (public until `expires_at`), `pages`, `bytes`, `credits_used` (images this request charged, 0 when the PDF was already stored), `cached`, `template`, `filename`, `created_at`, `expires_at`, `warnings` and `usage` (the same object as [`GET /v1/usage`](/docs/api#get-v1-usage)).

**Binary response headers:** `Content-Type: application/pdf`, `Content-Disposition: inline; filename="..."`, `X-LTC-Pages`, `X-LTC-Credits-Used`, `X-LTC-Cache` (`miss` or `hit`), `X-LTC-Pdf-Url` (the stored PDF's URL), `X-LTC-Warnings` (URI-encoded JSON) and `ETag`.

### GET /v1/pdf

```text
GET /v1/pdf/{site id}/{template}.pdf?...&sig={signature}
```

A [signed PDF link](#signed-pdf-links). The answer is the PDF, shown inline in the browser under its file name (default: `{template}.pdf`), with `X-LTC-Pages`, `X-LTC-Cache`, `ETag` and `Cache-Control: public, max-age=[[http.imageMaxAgeSeconds]]` (or less when the stored PDF expires sooner). `If-None-Match` with the `ETag` answers 304. `HEAD` never renders and never counts, but it answers what the `GET` would answer before rendering: 402 when not enough images are left, 429 when the site's daily cap on failed renders is reached (or that of all your sites together) or, for a [[plan.free.name]] account, the brake is on, and the status of a remembered failure, for example 422.

### GET /i/... .pdf

```text
GET /i/{account id}/{id}.pdf
```

The stored PDF behind `url`. Public, never renders, shown inline under the file name it was made with. It answers 404 once the cache period has ended; send the request again for a new one.

### Errors

The same error format and codes as the rest of the API ([Errors](/docs/api#errors)). The ones you will meet most with PDFs:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | A malformed body, an unknown field, both or neither of `template` and `html`, data over its limits, a bad margin or format. |
| 402 | `quota_exceeded` | Not enough images left in one place for this PDF; see [What counts](#what-counts). Nothing was charged. A 402 after rendering counts toward the [daily cap on failed renders](#what-counts) and is remembered for [[pdf.failedRenderMemoryMinutes]] minutes. |
| 413 | `payload_too_large` | The body is over [[pdf.maxRequestBodyMb]] MB. |
| 422 | `template_error` | The document cannot be printed as written: more than [[pdf.maxPages]] pages, a PDF over [[pdf.maxPdfMb]] MB (`details.max_bytes`), HTML or CSS over its limit, `@import`, a remote `@font-face`, too many images, or a document the browser could not render. The message says what to change. Nothing was charged. When the browser was reached (too many pages, a PDF too large, a document it could not render), it counts toward the daily cap on failed renders and is remembered for [[pdf.failedRenderMemoryMinutes]] minutes. |
| 422 | `image_fetch_failed` | A remote image could not be downloaded. `details.url` and `details.reason` say which and why. Nothing was charged or counted. |
| 429 | `rate_limited` | Over a [rate limit](/docs/limits#rate-limits); the [daily cap on failed renders](#what-counts) is reached, until 00:00 UTC, per account or per site, or for all your sites together, or renders still running hold its last places (a `Retry-After` of a few seconds); the brake on the [[plan.free.name]] plan and the free tools is on (`Retry-After` of an hour, see [Limits](#limits)); an identical request is still making this PDF after [[pdf.duplicateWaitSeconds]] seconds; or the renderer is busy for a moment. Retry after the seconds in `Retry-After`. Nothing was charged. |
| 500 | `render_failed` | The renderer failed, could not be reached, or did not finish sending the PDF ("The PDF renderer did not finish sending the PDF. Try again in a moment."), or it returned a PDF whose page count cannot be read. Nothing was charged. A failure of Browser Run itself does not count toward the daily cap on failed renders and is not remembered; a PDF whose page count cannot be read counts. |
| 503 | `not_configured` | PDF rendering is switched off on this deployment: "PDF rendering is not enabled yet." While it is off, stored PDF links (`/i/...pdf`) and signed PDF links answer it too. |
| 504 | `render_timeout` | Loading or printing took longer than [[pdf.renderTimeoutSeconds]] seconds. Nothing was charged. It counts toward the daily cap on failed renders and is remembered for [[pdf.failedRenderMemoryMinutes]] minutes. |

The [OpenAPI description](/openapi.yaml) covers `POST /v1/pdf`, signed PDF links and stored PDFs.

## Free PDF tools

Three pages on this site make PDFs without an account: [HTML to PDF](/tools/html-to-pdf), the [invoice generator](/tools/invoice-generator) and the [certificate generator](/tools/certificate-generator). They use the same renderer, make up to [[pdf.toolPdfsPerHour]] PDFs per hour from one network, always print the "[[pdf.freeMark]]" line and never store the PDF. Use the API when you need more, your own branding without the mark, or PDFs made by your own system.
