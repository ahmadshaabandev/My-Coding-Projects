---
title: Terms of Service
description: The terms that apply when you use [[site.name]], a hosted API that renders social-card images from HTML and CSS.
layout: legal
---

Last updated: [[legal.updated]]

These terms are the agreement between you and the seller of [[site.name]]. They are written to be read. If something is unclear, email us and we will explain it.

## 1. Who we are

[[site.name]] ([[site.url]]) is operated by [[legal.name]], a sole developer based in Lebanon.

- Seller: [[legal.name]]
- Address: [[legal.address]]
- Contact: <[[site.supportEmail]]>

In these terms "we" and "us" mean [[legal.name]], and "the service" means the [[site.name]] website, dashboard and API.

## 2. What the service is

[[site.name]] is a hosted API that renders social-card (Open Graph) images from HTML and CSS that you write, or from one of five starter templates. You get an image either from a signed image URL or from a REST endpoint.

The service has deliberate limits, and you should rely only on what is described here and in the documentation:

- Output is PNG, JPEG or WebP, in three fixed sizes.
- Rendering uses the open-source Satori and resvg libraries on Cloudflare Workers. It is not a web browser. It supports a subset of HTML and CSS, does not run JavaScript, and will not always match a browser pixel for pixel.
- There is no visual editor, no website screenshots, no video or GIF output, and no AI or face generation.
- Technical limits (for example on template size and render time) are listed in the documentation and are part of these terms.

## 3. Your account

You sign in with a link sent to your email address; there is no password. You are responsible for:

- keeping access to that email address secure,
- keeping your API keys and signing secrets private, and replacing them if they leak,
- everything done through your account, keys and signed URLs.

You must be old enough to enter into a contract where you live. If you use the service for a company or another person, you confirm that you are allowed to accept these terms for them.

## 4. Acceptable use

You may not use the service to do any of the following, or help anyone else do so:

- break the law, or create content that is illegal where you or your audience are;
- commit fraud, phishing or impersonation, including cards that pretend to come from a person, brand or organisation that has not agreed to it;
- send or support spam;
- infringe someone else's copyright, trademark or other rights, including using fonts or images you do not have the right to use;
- distribute malware, or link to it;
- probe, scan or attack the service, bypass its security, or abuse the API (for example by overloading it or using it to reach systems you have no right to reach);
- get around quotas or rate limits, for example with multiple free accounts, or remove, hide or crop out the small mark on Free-plan images;
- create deepfakes, or use a real person's face, name or likeness without their consent;
- resell the service as your own competing image-rendering service.

We may remove content and suspend or close accounts that break these rules. Where the problem is not urgent we will contact you first and give you a chance to fix it. Where it is urgent (for example phishing or an attack on the service) we may act immediately and tell you afterwards.

## 5. Your content and ours

**Your content stays yours.** You own your templates, the fonts and images you upload or reference, the data you send to be rendered, and the images the service produces for you.

**You give us the permission we need to run the service.** That is a non-exclusive, worldwide licence to host, copy, process, render, cache and deliver your content, only for the purpose of providing the service to you. It ends when the content is deleted from the service, apart from copies that remain for a short time in caches and backups.

**You are responsible for your content.** You confirm that you have the rights needed to use every font, image, logo and piece of text in your cards, and that your content follows section 4.

**The service is ours.** The [[site.name]] site, software, documentation and starter templates belong to [[legal.name]]. You may use the starter templates, changed or unchanged, in your own cards, on any plan. You may not copy the rest of the service or present it as your own. The open-source libraries the service uses remain under their own licences.

## 6. Plans, quotas and what counts as an image

- **Free:** [[plan.free.images]] images per month. Free-plan images carry a small mark in one corner. When the monthly allowance is used up, new images are not rendered until the next month: it is a hard stop, and there are no charges.
- **Starter:** [[plan.starter.price]] per month, [[plan.starter.images]] images per month.
- **Pro:** [[plan.pro.price]] per month, [[plan.pro.images]] images per month.
- **Top-up (optional):** [[topup.price]] for [[topup.images]] extra images, available on paid plans. A top-up is only ever bought by you, by hand. It is never billed automatically. Top-up images are used after your monthly allowance runs out and stay valid for [[topup.validDays]] days from purchase.

**What counts as one image:** one image is one newly rendered output, in one size and format. Once rendered, an image is cached and served again without counting for the cache period of your plan: [[plan.free.cacheDays]] days on Free, [[plan.starter.cacheDays]] days on Starter and [[plan.pro.cacheDays]] days on Pro. After that period, or if the content of the card changes, it is rendered and counted again.

Unused monthly images do not carry over to the next month. We do not charge overage fees: when a paid plan's allowance and any top-ups are used up, new images are not rendered until the next billing period, a top-up or an upgrade. Prices are in US dollars and exclude tax, which Paddle adds at checkout where it applies.

## 7. Payment

Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.

This means that your purchase is made from Paddle, under [Paddle's buyer terms](https://www.paddle.com/legal/buyer-terms), and Paddle charges your payment method, collects any tax and sends your receipt. These terms cover your use of the service itself. Paddle answers questions about orders, payments and receipts; questions about how the service works go to us at <[[site.supportEmail]]>. Refunds are described in our [refund policy](/refund).

## 8. Renewal and cancellation

Starter and Pro are monthly subscriptions. They renew automatically each month, at the price shown when you subscribed, until you cancel.

You can cancel at any time from your dashboard or from the link in your Paddle receipt email. When you cancel:

- you keep your paid plan until the end of the period you have already paid for;
- you are not charged again;
- after that, your account returns to the Free plan. It is not deleted.

**Changing plan.** You can switch between Starter and Pro from your dashboard, and the change takes effect at once. For an upgrade, Paddle charges the price difference for the rest of the current billing period, and that period's image allowance grows in proportion to the time left. A downgrade is not charged or credited: you keep the images of the current period, and the lower price applies from your next renewal. Switching back up within the same period adds images only where the time left pays for more than the period already has; otherwise it is not charged.

If we change the price of a plan you are subscribed to, we will tell you by email before the new price applies to you, and you can cancel before it does.

## 9. No uptime guarantee; provided as is

We work to keep the service fast and available, but we do not offer an uptime guarantee or a service-level agreement. The service is provided "as is" and "as available". It may be interrupted, slow or unavailable at times, including because of the providers it depends on.

We do not promise that the service will be free of errors, that every piece of HTML and CSS will render the way a browser would render it, or that it will be suitable for a particular purpose that we have not described. If a social-card image is critical to you, keep a static fallback image.

## 10. Limits on our liability

In plain terms:

- We are not liable for indirect or consequential losses, such as lost profit, lost revenue, lost data or lost business, arising from your use of the service or from not being able to use it.
- Our total liability to you for everything connected with the service is limited to the amount you paid for the service in the 12 months before the event that caused the claim.
- You are responsible for claims that arise from your content or from your breach of these terms.

Nothing in these terms limits liability that cannot legally be limited, such as liability for fraud or for deliberate wrongdoing, and nothing here removes rights that the law gives you and that cannot be waived by contract.

## 11. Suspension and termination

You can stop using the service and ask us to delete your account at any time by emailing <[[site.supportEmail]]>.

We may suspend or close an account that breaks these terms, that puts the service or other customers at risk, or where the law requires it. Unless the matter is urgent or we are legally prevented from doing so, we will tell you why and give you a chance to respond. If we close a paid account for a reason other than a breach of these terms, the unused part of the current paid period will be refunded through Paddle.

When an account is closed, its signed URLs and API keys stop working and its content is deleted as described in the [privacy policy](/privacy).

## 12. Changes to the service and to these terms

We may change, add or remove features. If we plan to remove something that paying customers rely on, or to shut the service down, we will give reasonable notice by email.

We may also update these terms. The date at the top shows the latest version. If a change is significant, we will email account holders before it takes effect. If you do not agree with a change, you can cancel; continuing to use the service after the change takes effect means you accept the new terms.

## 13. Governing law

These terms are governed by the laws of [[legal.governingLaw]]. If you use the service as a consumer, this choice does not take away any protection given to you by the mandatory laws of the country where you live, and you keep any right you have to bring a claim in the courts of that country.

If one part of these terms turns out to be unenforceable, the rest still applies.

## 14. Contact

Questions about these terms: <[[site.supportEmail]]>, or by post to [[legal.name]], [[legal.address]].
