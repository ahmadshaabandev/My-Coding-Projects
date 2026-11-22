---
title: Privacy Policy
description: What personal data [[site.name]] collects, why, who processes it, how long it is kept and how to ask for it to be corrected or deleted.
layout: legal
---

Last updated: [[legal.updated]]

This page explains what data [[site.name]] collects and what happens to it. The short version: we collect what is needed to run an image-rendering API and to bill for it, we do not use analytics or advertising trackers, and we do not sell data.

## 1. Who is responsible

[[site.name]] ([[site.url]]) is operated by [[legal.name]], [[legal.address]], a sole developer based in Lebanon. [[legal.name]] is responsible for the personal data described here.

Contact for anything on this page: <[[site.supportEmail]]>

## 2. What we collect

| Data | Where it comes from |
| --- | --- |
| **Email address** | You give it to us when you sign in. |
| **Usage data**: render counts, timestamps, and the IP address a request came from | Created when you or your visitors' platforms request images or use the dashboard and API. |
| **Templates and render data**: the HTML and CSS you save, and the values you send to be rendered | You send them through the dashboard, the API or a signed image URL. |
| **Fonts and images**: fonts you upload, and images your cards reference, which the service fetches in order to draw the card | You upload them or point the service at them. |
| **Messages to us**: the email address and message you enter in the contact form, and emails you send to support | You send them to us. The contact form is not stored by the service; it is delivered to our support mailbox as an email. |
| **Billing status**: which plan you are on, whether a subscription is active, and identifiers Paddle gives us for your customer and subscription records | Sent to us by Paddle when you buy, renew, cancel or are refunded. |

We do **not** receive or store your card number or other payment details. Those go to Paddle only.

Please do not put sensitive personal information in card content. Text and images in a card end up in a public image by design.

## 3. What we use it for

- **To provide the service:** signing you in, rendering and caching images, counting usage against your plan.
- **To keep it secure and fair:** rate limiting, spotting abuse and investigating problems. This is what IP addresses are used for.
- **To handle billing:** matching payments processed by Paddle to your account and plan.
- **To contact you about your account:** sign-in links, warnings when your monthly allowance is nearly or fully used, replies to your messages, and essential service messages, such as changes to these terms or to your plan. We do not send marketing email.
- **To meet legal obligations** where they apply.

We do not use your data for advertising, do not build profiles of you, and do not sell or rent data to anyone.

## 4. Who processes data for us

We use three outside companies. Each receives only what it needs for its job.

| Company | What it does | What it receives |
| --- | --- | --- |
| **Cloudflare** | Hosting, database (D1), object storage (R2) and network | Everything stored in or passing through the service: account data, templates, uploaded fonts, rendered images, and request data such as IP addresses. |
| **Resend** | Email delivery | Your email address and the content of the emails we send you, such as sign-in links and usage warnings. Messages sent with the contact form also pass through Resend on their way to our support mailbox. |
| **Paddle** | Payments, as our reseller and Merchant of Record | The details you enter at checkout, including payment details. Paddle decides how to handle payment data in its own right, as an independent controller; see [Paddle's privacy notice](https://www.paddle.com/legal/privacy). |

When a card references an image hosted somewhere else, the service requests that image from that host, in the way any web client would.

We may also disclose data if the law requires it, or if it is needed to protect the service or other people from harm.

## 5. How long we keep it

- **Account data** (email address, templates, uploaded fonts, settings, usage counts): for as long as your account exists. When you ask us to delete your account, we delete it.
- **Rendered images:** for the cache period of your plan, which is [[plan.free.cacheDays]] days on Free, [[plan.starter.cacheDays]] days on Starter and [[plan.pro.cacheDays]] days on Pro.
- **Previews from the playground on the home page:** about one day.
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

Depending on where you live, the law may give you further rights, including the right to complain to your local data protection authority. Nothing on this page limits those rights.

## 7. Cookies

[[site.name]] sets **one** cookie: a first-party session cookie that keeps you signed in. It is essential to the dashboard, so there is no consent banner for it.

We use no analytics cookies, no advertising cookies and no tracking pixels.

When you buy a plan, Paddle's checkout opens in an overlay on our site. Paddle may set its own cookies inside that checkout; they are covered by Paddle's privacy notice, not by this page.

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
