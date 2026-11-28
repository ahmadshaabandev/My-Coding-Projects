---
title: Privacy Policy
description: What personal data [[site.name]] collects, why, who processes it, how long it is kept and how to ask for it to be corrected or deleted.
layout: legal
updated: 2026-11-27
updated.charts: 2026-11-28
updated.ai: 2026-11-28
---

Last updated: [[legal.updated]]

This page explains what data [[site.name]] collects and what happens to it. The short version: we collect what is needed to run an image-rendering API and to bill for it, our only website analytics are cookieless Cloudflare Web Analytics, we do not use advertising trackers, and we do not sell data.

## 1. Who is responsible

[[site.name]] ([[site.url]]) is operated by [[legal.name]], trading as [[site.name]], a sole proprietor based in Lebanon. Address: [[legal.address]]. [[legal.name]] is responsible for the personal data described here.

Contact for anything on this page: <[[site.supportEmail]]>

## 2. What we collect

| Data | Where it comes from |
| --- | --- |
| **Email address** | You give it to us when you sign in. |
| **Usage data**: render counts, timestamps, and the IP address a request came from | Created when you or your visitors' platforms request images or use the dashboard and API. |
| **Templates and render data**: the HTML and CSS you save, and the values you send to be rendered | You send them through the dashboard, the API or a signed image URL. |
| **Fonts and images**: fonts you upload, and images your cards reference, which the service fetches in order to draw the card | You upload them or point the service at them. |
<!-- feature:pdf -->
| **PDF documents**: the HTML, CSS and data you send to be made into a PDF, the PDF itself, and for each PDF that reaches the renderer a record of the pages and the browser time it used | You send them through the API or a signed PDF link. |
| **Free PDF tools**: the HTML, CSS or form entries you send to be made into a PDF, and a count of PDFs per IP address (IPv6: per /64 network) for the current hour | You enter them on the [HTML to PDF](/tools/html-to-pdf), [invoice generator](/tools/invoice-generator) or [certificate generator](/tools/certificate-generator) page. |
<!-- /feature:pdf -->
<!-- feature:batch -->
| **Bulk documents and certificate records**: the rows you send, one per document, the documents made from them, and for each verified document a record of the recipient's name, the title, the achievement, the issuer name and the date as you entered them | You send them through the API, or through the dashboard's Bulk documents tab, which reads your CSV file in your browser and sends only the values you match to the template. |
| **Visits to verification pages**: the IP address of whoever opens a page or its JSON version, counted for rate limiting | Created when someone opens a verification link or scans its QR code. |
<!-- /feature:batch -->
<!-- feature:toolkit -->
| **PDF toolkit files**: the PDFs and images you send, upload or link to, and the files the toolkit makes from them | You send them through the API. The free [Merge PDF](/tools/merge-pdf) and [Image to PDF](/tools/image-to-pdf) pages do not send your files to us at all: they work in your browser. |
<!-- /feature:toolkit -->
<!-- feature:linkcards -->
| **Cards from links**: the page address you name, what that page says about itself (title, description, site name, icon and theme colour) and the card made from it | You send the address through the API or sign it into a link URL; anyone who opens that link URL makes the service read the page when it is due. |
<!-- /feature:linkcards -->
<!-- feature:email -->
| **Open-field values**: the short values, such as a first name, that an email platform puts into a personalized image's address for each reader, and the images made from them | They arrive when a reader's mail app, or its image proxy, loads the image, like any image request. |
<!-- /feature:email -->
<!-- feature:charts -->
| **Free chart maker**: the chart you enter (its type, labels, numbers and titles), which our server uses only to draw the image and send it straight back to your browser; neither the chart nor the image is stored, only a count of requests per IP address (IPv6: per /64 network) for the rate limit | You enter it on the [chart maker](/tools/chart-maker) pages. |
<!-- /feature:charts -->
<!-- feature:ai -->
| **AI images**: your choices (style, colours, motif, layout, size), the text set on an image (title, description, site name), the link of a QR code, the logos and reference images you upload, your brand presets, the items of a batch (from a feed, a CSV file or a list), and the previews, backgrounds and images made from them | You enter them on the AI tool pages, in the dashboard or through the API. A feed is read by our server from the address you give. |
| **Free AI previews**: a count of previews per IP address (IPv6: per /64 network) and per page or QR link, for the current day (UTC) | Created when you make a free preview on an AI tool page. |
| **Refused QR links and abuse reports**: a QR link the service refused and why, and what a report says, with the email address if you give one | Created when a link is refused, or when you send a report from an AI tool page or by email. |
<!-- /feature:ai -->
| **Open Graph checker**: the page address you enter, the tags and measurements read from that page, and a count of checks per IP address (IPv6: per /64 network) for the current hour | You enter the address on the [Open Graph checker](/tools/og-checker), or send it to `GET /v1/inspect` with an API key, which counts checks per key for the day instead. |
| **Website statistics**: which pages of this website are viewed, from which referring site, with which kind of browser and device, from which country, and how fast they load, counted by Cloudflare Web Analytics so we can see how the website is used and how fast it is. It is cookieless: it sets no cookie and stores nothing on your device, and Cloudflare says it does not fingerprint visitors. Cloudflare works out the country from the connection's IP address. We see only totals, not individual visitors. | Reported by Cloudflare's analytics script when a page of this website loads in your browser. |
| **Messages to us**: the email address and message you enter in the contact form, and emails you send to support | You send them to us. The contact form is not stored by the service; it is delivered to our support mailbox as an email. |
| **Billing status**: which plan you are on, whether a subscription is active, and identifiers Paddle gives us for your customer and subscription records | Sent to us by Paddle when you buy, renew, cancel or are refunded. |

We do **not** receive or store your card number or other payment details. Those go to Paddle only.

Please do not put sensitive personal information in card content. Text and images in a card end up in a public image by design.
<!-- feature:batch -->

**Verification pages are public.** Anyone who has the link or the printed QR code of a verified document can see its record: the recipient's name and the other facts as the issuer entered them, whether it is valid or revoked, and the domain of the email address the issuing account signs in with (for a public email provider, only that the account has a personal email address). The pages ask search engines not to index them, their titles and link previews do not contain the recipient's name, and the JSON version can be read from any website. The issuer decides what a record says and is responsible for being allowed to publish it.
<!-- /feature:batch -->
<!-- feature:email -->

**Open-field values travel in image addresses.** The account owner decides which values an email sends; use open fields for short display text, such as a first name, not for email addresses or other personal details. The rendered image shows the value and is stored like any card.
<!-- /feature:email -->

## 3. What we use it for

<!-- feature:no-pdf -->
- **To provide the service:** signing you in, rendering and caching images, counting usage against your plan, and running the Open Graph checks you ask for.
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
- **To provide the service:** signing you in, rendering and caching images and PDF documents, counting usage against your plan, and running the Open Graph checks you ask for.
- **To keep rendering affordable:** the pages and browser time of each PDF tell us what PDF rendering costs and warn us when it costs more than planned.
<!-- /feature:pdf -->
<!-- feature:batch -->
- **To run verification pages:** showing each verified record to whoever opens its link, and looking into reports about records.
<!-- /feature:batch -->
<!-- feature:ai -->
- **To keep AI images safe:** checking each picture and each QR link before you get it, and looking into refused links and reports.
<!-- /feature:ai -->
- **To keep it secure and fair:** rate limiting, spotting abuse and investigating problems. This is what IP addresses are used for, apart from the country in the website statistics (section 2).
- **To handle billing:** matching payments processed by Paddle to your account and plan.
- **To contact you about your account:** sign-in links, warnings when your monthly allowance is nearly or fully used, replies to your messages, and essential service messages, such as changes to these terms or to your plan. We do not send marketing email.
- **To meet legal obligations** where they apply.

We do not use your data for advertising, do not build profiles of you, and do not sell or rent data to anyone.

## 4. Who processes data for us

We use <!-- feature:no-webrisk -->three<!-- /feature:no-webrisk --><!-- feature:webrisk -->four<!-- /feature:webrisk --> outside companies. Each receives only what it needs for its job.

| Company | What it does | What it receives |
| --- | --- | --- |
| **Cloudflare** | Hosting, database (D1), object storage (R2) and network; Turnstile, the check that tells people from bots, if a free tool on the website shows it; Web Analytics, the cookieless statistics of this website | Everything stored in or passing through the service: account data, templates, uploaded fonts, rendered images, checker results, and request data such as IP addresses. When Turnstile is shown, the data its widget collects in your browser to tell a person from a bot. |
| **Resend** | Email delivery | Your email address and the content of the emails we send you, such as sign-in links and usage warnings. Messages sent with the contact form also pass through Resend on their way to our support mailbox. |
| **Paddle** | Payments, as our reseller and Merchant of Record | The details you enter at checkout, including payment details. Paddle decides how to handle payment data in its own right, as an independent controller; see [Paddle's privacy notice](https://www.paddle.com/legal/privacy). |
<!-- feature:webrisk -->
| **Google** | Google Web Risk, a list of unsafe web addresses that the AI QR code tool checks links against | The link of each QR code you ask for. |
<!-- /feature:webrisk -->

<!-- feature:pdf -->
To make a PDF, the service sends the document's HTML, with your data filled in and its images already embedded, to Cloudflare Browser Run, Cloudflare's browser service, which prints it and returns the PDF. Cloudflare is already our host, so no further company receives your document. We ask Browser Run not to cache the result. The free PDF tools work the same way.

<!-- /feature:pdf -->
<!-- feature:ai -->
To make an AI image, the service sends Cloudflare Workers AI the image prompt that our server writes from your choices (our own words and the colours you picked) and, if you use them, your reference images. It never sends the text you set on the image, the page you make it for or the link of a QR code. The picture that comes back, and each reference image, also go to a second model on Cloudflare Workers AI that checks them for text, faces, people, logos, documents and nudity. Cloudflare is already our host, so no further company receives them. In its Workers AI model catalogue, on the page of the FLUX.2 [klein] 4B model that draws the pictures, Cloudflare lists that model as zero data retention.

The uploads, previews, backgrounds and finished AI images are stored in Cloudflare R2, our object storage, for the times in section 5.

To check the link of a QR code, our server asks Cloudflare's security DNS resolver about its domain name; only the domain name is sent, not the rest of the link.

<!-- /feature:ai -->
<!-- feature:webrisk -->
The whole link of each QR code is also sent to Google Web Risk, which answers whether Google lists it as unsafe.

<!-- /feature:webrisk -->
When a card references an image hosted somewhere else, the service requests that image from that host, in the way any web client would.
<!-- feature:toolkit -->

When you give the PDF toolkit the address of a file, our server downloads that file from its host in the same way, identifying itself as `LinkToCard-FileFetcher/1.0`.
<!-- /feature:toolkit -->
<!-- feature:linkcards -->

When you make a card from a link, our server reads that page in the same way as the Open Graph checker described below.
<!-- /feature:linkcards -->

When you use the Open Graph checker, our server (a Cloudflare Worker) requests the page you entered, that site's `robots.txt` and the image the page names, identifying itself as `LinkToCardBot/1.0`; the [LinkToCardBot page](/bot) describes it. The request comes from our server, not from your browser, and carries none of your cookies. The site you check sees that request in the way it sees any visitor. We never store the page's HTML.

We may also disclose data if the law requires it, or if it is needed to protect the service or other people from harm.

## 5. How long we keep it

- **Account data** (email address, templates, uploaded fonts, settings, usage counts): for as long as your account exists. When you ask us to delete your account, we delete it.
<!-- feature:no-pdf -->
- **Rendered images:** for the cache period of your plan, which is [[plan.free.cacheDays]] days on Free, [[plan.starter.cacheDays]] days on Starter and [[plan.pro.cacheDays]] days on Pro.
<!-- /feature:no-pdf -->
<!-- feature:pdf -->
- **Rendered images and PDF documents:** for the cache period of your plan, which is [[plan.free.cacheDays]] days on Free, [[plan.starter.cacheDays]] days on Starter and [[plan.pro.cacheDays]] days on Pro.
- **PDFs from the free PDF tools:** not stored. The PDF goes straight back to your browser. The count of PDFs per IP address or network is kept until the end of that hour; the daily clean-up then deletes it, normally within a day.
- **Records of PDF renders** (when, which account if any and its plan at the time, whether it worked, the pages and the browser time; no document content): [[pdf.browserUsageRetentionDays]] days.
- **Failed PDF requests:** when a PDF fails because of the document, the error message we answered with is kept under the request's id for [[pdf.failedRenderMemoryMinutes]] minutes, so the same request gets the same answer without being printed again. The count of such failures (and of renders in progress) per account, per site and for all sites of an account is kept until the end of the next day (UTC). The daily clean-up then deletes both, normally within a day.
<!-- /feature:pdf -->
<!-- feature:batch -->
- **Bulk documents:** the rows you send and the status of each document are kept until the batch has finished and the storage time of its last document has ended; the daily clean-up then deletes them, normally within a day. The documents are kept for the cache period of your plan, like other PDFs.
- **Certificate records:** for as long as the issuing account exists. A revoked record is kept for [[batch.revokedRetentionDays]] days after the revocation, so its page can say that it was revoked, and is then deleted. Deleting the account deletes all of its records.
<!-- /feature:batch -->
<!-- feature:toolkit -->
- **Files sent to the PDF toolkit,** and files it downloads for you: not stored; they are read while the request runs. Its results: for the cache period of your plan.
<!-- /feature:toolkit -->
<!-- feature:linkcards -->
- **Cards from links:** the card, for the cache period of the plan; what was read from the page, for [[inspect.cacheMinutes]] minutes, like an Open Graph checker result.
<!-- /feature:linkcards -->
<!-- feature:email -->
- **Personalized email images:** each image, and so the value it shows, for the cache period of the site owner's plan, like any card. Which new personalized images each site rendered on each UTC day (the site id and a one-way hash of each image, no text from the image): until the end of the next day (UTC); the daily clean-up then deletes them. For each email image we count, we keep a record that it was counted: your account id and a one-way hash of the image's content, no text from the image. It is kept for [[email.chargeMemoryDays]] days from that count so the image is not counted again, and is deleted with your account.
<!-- /feature:email -->
<!-- feature:ai -->
- **AI previews,** and the full-size background behind each: [[ai.previewHours]] hours, then deleted.
- **Full-size AI images** (covers, newsletter headers, QR codes and their SVG files): until you delete them or your account is deleted, because an image named in a page's meta tags must not disappear.
- **Logos and reference images:** [[ai.uploadHours]] hours, for the images you make with them, unless you save them in a brand preset; then until you delete the preset or your account. **Brand presets:** until you delete them or your account.
- **Backgrounds drawn for your account** and not used in a full-size image: [[ai.backgroundHours]] hours.
- **AI batches:** the items of a batch are kept with the batch.
- **Counts of free AI previews** per IP address or network: until the end of that day (UTC).
- **Refused QR links and abuse reports:** [[ai.abuseRetentionDays]] days.
<!-- /feature:ai -->
- **Previews from the playground on the home page:** about one day.
- **Open Graph checker results** (the address checked and the tags and measurements read from it): 10 minutes. The count of checks per IP address or network: until the end of that hour; per API key: until the end of that day (UTC). Expired entries are deleted by the daily clean-up, normally within a day.
- **Sign-in links:** valid for a few minutes, and usable once.
- **Sessions:** 30 days, or until you sign out.
- **Logs and security data,** including IP addresses: kept only for a short time, as needed for rate limiting, troubleshooting and security.
- **Billing records:** Paddle keeps purchase records for as long as its own obligations and the law require. We keep the billing status linked to your account while the account exists, and afterwards only where the law requires it.

Deleted data may remain in backups and caches for a short time before it is overwritten.

## 6. Your choices and rights

You can ask us to:

- tell you what data we hold about you and give you a copy (**access** and **export**),
- fix data that is wrong (**correction**),
- delete your account and the data in it (**deletion**),
- stop a particular use of your data (**objection**).

Email <[[site.supportEmail]]> from the address on your account. We will reply within a reasonable time and will not charge for a reasonable request. We may need to confirm that the request really comes from you.

<!-- feature:batch -->
If you are named on a verification page, the issuer decides about that record: ask the issuer to correct or revoke it, or use the page's "Report this certificate" link to tell us.

<!-- /feature:batch -->
Depending on where you live, the law may give you further rights, including the right to complain to your local data protection authority. Nothing on this page limits those rights.

## 7. Cookies

[[site.name]] sets **one** cookie: a first-party session cookie that keeps you signed in. It is essential to the dashboard, so there is no consent banner for it.

We use no analytics cookies, no advertising cookies and no tracking pixels.

When you buy a plan, Paddle's checkout opens in an overlay on our site. Paddle may set its own cookies inside that checkout; they are covered by Paddle's privacy notice, not by this page.

<!-- feature:pdf -->
The free PDF tools set no cookie either, and may ask for the same Turnstile check described below.

<!-- /feature:pdf -->
<!-- feature:batch -->
Verification pages set no cookie and load no script.

<!-- /feature:batch -->
<!-- feature:ai -->
The AI image pages set no cookie either, and show the Turnstile check described below before each free preview.

<!-- /feature:ai -->
The Open Graph checker sets no cookie. If it asks you to confirm that you are a person, that check is Cloudflare Turnstile, which runs in a frame loaded from Cloudflare. What it stores in your browser is decided by Cloudflare and described in Cloudflare's own documentation, not by this page.

## 8. Where data is processed

The service runs on Cloudflare's global network, so data may be processed in countries other than the one you live in, and other than Lebanon, where the operator is based. Resend and Paddle also operate internationally. By using the service you understand that your data is handled in this way.

## 9. Security

We take reasonable care of your data:

- connections to the service are encrypted in transit (HTTPS);
- secrets such as API keys, sign-in tokens and session tokens are stored as hashes, not in readable form;
- access to the production systems is limited to the operator.

No system is perfectly secure, and we cannot promise that a breach will never happen. If we learn of a breach that affects your personal data, we will tell the affected users without undue delay and say what we know and what we are doing about it.

## 10. Children

The service is made for developers and businesses. It is not directed at children, and we do not knowingly collect personal data from children. If you believe a child has given us personal data, email us and we will delete it.

## 11. Changes to this policy

If we change this policy we will update the date at the top. If a change is significant, for example a new processor or a new use of data, we will email account holders before it takes effect.

## 12. Contact

<[[site.supportEmail]]>, or by post to [[legal.name]], [[legal.address]].
