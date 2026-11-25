---
title: "Invoice PDFs from a Stripe webhook: a PDF for every payment"
description: When your Stripe account tells your server about a payment, turn the event into invoice data and get a stored PDF invoice from the Link To Card API, with money formatting, retries and duplicate events handled.
layout: page
feature: pdf
---

You take payments with Stripe and want a PDF invoice in your own layout for each one: attached to the confirmation email, linked from the customer's account page, kept with the order. Stripe can notify your server about each payment with a webhook; your server then sends the invoice data to [[site.name]] and gets a PDF back.

In this guide Stripe is your own payment provider. [[site.name]] does not take part in the payment; it only makes the PDF. (Our own plans are billed through Paddle, which has nothing to do with this.)

We could not open Stripe's documentation while writing this guide. So the code below does not depend on the exact fields of a Stripe event: one function maps the event to a small invoice object of your own, and the rest works from that. Send yourself a test event, log it, and fill the mapping from the fields you see.

## How the pieces fit

1. Stripe sends an event to a webhook endpoint on your server when a payment succeeds or an invoice is paid.
2. Your server checks that the event really comes from Stripe, with the signature check that Stripe's documentation describes for your language, and answers at once.
3. Your server builds the invoice data from the event and your own records, and sends it to `POST /v1/pdf`.
4. It stores the PDF's `url` with the order, and emails the link or the file.

Do the third step after you have answered the webhook, for example in a queue or a background job. A PDF takes a few seconds to make, and the sender of a webhook should not have to wait for it.

## 1. Turn amounts into display text

The [[site.name]] templates print what you send and never calculate, so you send money as finished text, such as `"1,250.00"`. If your amounts are integers in the smallest unit of the currency (cents for USD), this turns them into text with the right number of decimals for each currency:

```js
/** 125000 USD -> "1,250.00"; 5000 JPY -> "5,000" (no minor unit). */
function money(minor, currency) {
  const { maximumFractionDigits: digits } = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions();
  return (minor / 10 ** digits).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
```

Check the result for the currencies you use: the number of decimals comes from the JavaScript runtime's currency data, which may not match your payment provider for every currency.

## 2. Map the payment to the invoice template

Your own invoice object, filled from the event, holds what the PDF needs. Its field names are yours; the template's keys are listed under [Starter templates](/docs/pdf#template-invoice).

```js
/**
 * invoice: your record of one paid invoice, for example
 * { number, issuedAt, currency, customerName, customerEmail, customerAddress,
 *   lines: [{ description, quantity, unitAmount, amount }], subtotal, tax, total }
 * with every amount in the smallest currency unit, taken from the event or your records.
 */
function invoiceData(invoice) {
  const m = (minor) => money(minor, invoice.currency);
  return {
    seller_name: 'Fernhill Studio',
    seller_address: '18 Lantern Street, Suite 4\nMarlow Bay, CA 94000',
    seller_email: 'billing@fernhill.example',
    buyer_name: invoice.customerName,
    buyer_email: invoice.customerEmail,
    buyer_address: invoice.customerAddress,
    invoice_number: invoice.number,
    issue_date: new Date(invoice.issuedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }),
    currency: invoice.currency.toUpperCase(),
    items: invoice.lines.map((line) => ({
      description: line.description,
      quantity: String(line.quantity),
      unit_price: m(line.unitAmount),
      amount: m(line.amount),
    })),
    subtotal: m(invoice.subtotal),
    tax_label: 'Tax',
    tax: m(invoice.tax),
    total: m(invoice.total),
    payment_terms: 'Paid in full. Thank you.',
  };
}
```

Take the tax and the totals from the payment, not from a new calculation: the PDF should show exactly what the customer was charged. A key you leave out, or set to an empty string, is left off the invoice.

## 3. Make the PDF

```js
async function invoicePdf(invoice) {
  const response = await fetch('[[site.url]]/v1/pdf', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LTC_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template: 'invoice',
      data: invoiceData(invoice),
      filename: `invoice-${invoice.number}.pdf`,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    // 429 and 5xx are worth retrying later; any other error needs a change in the data.
    const error = new Error(body.error?.message ?? `HTTP ${response.status}`);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  return body.url;
}
```

In your webhook job, after the signature check:

```js
async function onInvoicePaid(event) {
  const invoice = await invoiceFromEvent(event); // your mapping, and your own records
  if (invoice.pdfUrl) return; // already made for this invoice
  invoice.pdfUrl = await invoicePdf(invoice);
  await saveInvoice(invoice); // keep the link with the order
  await sendReceiptEmail(invoice); // with the link, or the file downloaded from it
}
```

## Duplicate events and retries

Webhooks can arrive more than once, and your job may retry after a failure. Both are harmless here:

- The same template, data and file name always give the same PDF. A repeat request is answered from storage with the same `url`, `cached: true` and `credits_used: 0`, so it counts nothing.
- Storing `pdfUrl` with the invoice, as above, skips the request altogether the second time.

Retry only 429 `rate_limited` (after the seconds in `Retry-After`) and 5xx answers. A 400 or 422 answer fails the same way every time: its `error.message` says which key or value to fix.

## Keep your own copy

The `url` is public but not forever: the stored PDF is kept for [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]] and [[plan.pro.cacheDays]] on [[plan.pro.name]], then the link answers 404. Many businesses must keep their invoices for years, so download the PDF from `url` and store it with your records. Sending the same request again later makes a new PDF, which counts again.

On the [[plan.free.name]] plan every page carries a "[[pdf.freeMark]]" line; [[plan.starter.name]] and [[plan.pro.name]] PDFs have none. An invoice of up to [[pdf.basePages]] pages counts as [[pdf.baseUnits]] images. [What counts](/docs/pdf#what-counts)

## A link instead of a stored file

If you would rather not call the API from the webhook at all, put a [signed PDF link](/docs/pdf#signed-pdf-links) in the confirmation email. The PDF is made the first time the customer opens it. A link carries its data in the address, so it suits short invoices: the `items` list, as JSON text, must fit in [[limit.maxDataValueChars]] characters.

## FAQ

### Does Stripe not make invoices itself?

Stripe has invoicing features of its own; we could not check them for this guide, so compare them yourself. This guide is for when you want your own layout, your own numbering, or the same PDFs for payments from several sources.

### Which Stripe event should I listen to?

The one that means "paid" in your setup, for example for one-off payments or for subscription invoices. Stripe's documentation lists the event types. Whichever you choose, handle each invoice once by storing the PDF's link with it.

### Can I make a receipt instead of an invoice?

Yes: send `"template": "receipt"` with its keys, such as `receipt_number`, `date` and `payment_method`. [Starter templates](/docs/pdf#template-receipt) lists them. A quote before the payment uses `quote`.

### What happens to my customers' data?

It is sent to [[site.name]] to make the PDF, and the PDF is stored for the cache period of your plan under an address that cannot be guessed. The [privacy policy](/privacy) says what is kept and for how long. Put only what belongs on the invoice into the data.

### Can I try the layout first?

Yes. The free [invoice generator](/tools/invoice-generator) fills in the same `invoice` template from a form, without an account.

## Start

[Start free with [[site.name]]](/login), create an API key, and call `invoicePdf()` from your webhook job. [PDF documents](/docs/pdf) covers every field and error.

Related: [HTML to PDF in n8n](/guides/html-to-pdf-n8n) · [HTML to PDF with Zapier](/guides/html-to-pdf-zapier-webhooks)
