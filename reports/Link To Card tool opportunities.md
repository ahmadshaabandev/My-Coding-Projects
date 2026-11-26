# Turn Link To Card's two engines into workflows

Link To Card should add tools that turn the two engines it already runs, Satori card images and Browser Run PDFs, into workflows people already pay for. New standalone utilities are the wrong bet. Four tools lead, in this order:

1. **Bulk generation from a spreadsheet.** Certificates come first, each with a public verification page. Invoices, quotes and reports follow on the same pipeline.
2. **Zapier, Make and n8n connectors.**
3. **"Link in, card out".** A branded card built from any URL with the inspector the OG checker already uses.
4. **A browser-free PDF toolkit API.** Merge, split, stamp, form fill, image to PDF and password protection.

Personalized email images are the fifth bet. The evidence is consistent: **template image and PDF APIs are the one category where solo founders repeatedly report real revenue**. Bannerbear reports about $50K MRR, APITemplate.io and CraftMyPDF together $15–30K MRR, and Orshot $12.7K MRR, payment-verified, within 20 months of launch. Buyers pay **$0.10–$0.20 to fill or mail-merge a single document** that costs Link To Card a small fraction of a cent to produce. Margin is therefore not the constraint; distribution is, which is why the connectors rank so high. A website screenshot API, e-signatures, PDF compression, conversion and OCR, standalone QR codes or link shorteners, a public receipt generator and uptime monitoring should all be skipped. Each is either crowded at a $7-per-1,000 price floor, legally heavy, dependent on AGPL native code, a documented fraud vector, or a separate business. Expect a realistic ceiling of $10–30K MRR after several years, not Bannerbear's. Two preconditions come before any of it: switching PDFs on in production, and confirming that Paddle pays out to an individual in Lebanon.

## Template image and PDF APIs hold nearly all the solo revenue evidence

Five research tracks covered screenshot, image, PDF, monitoring and free-tool products. Only one category shows repeated, multi-year revenue earned by one- or two-person teams: APIs that fill templates with data and return images or PDFs.

- **Bannerbear:** its solo founder bootstrapped it to **about $50K MRR in three years** ([Starter Story](https://www.starterstory.com/stories/bannerbear-breakdown)).
- **APITemplate.io and CraftMyPDF:** one founder's pair of image and PDF APIs reported **$15K MRR combined** in an interview ([Starter Story](https://www.starterstory.com/stories/craftmypdf)). A later revenue page dated April 2025 shows $30K a month ([Starter Story](https://www.starterstory.com/businesses/apitemplate-io/revenue)).
- **PDFShift:** a founder and one employee, at about **$8.5K–9K MRR** ([ProvenStartups](https://provenstartups.com/projects/pdfshift-html-to-pdf-api)).
- **Orshot:** the closest comparable, a solo product launched in March 2025 that bundles images, PDFs and video. TrustMRR, which reads revenue straight from the payment provider, shows **$12,735 MRR from 222 subscriptions** in November 2026 ([TrustMRR](https://trustmrr.com/startup/orshot-com)). The founder got there by pricing below incumbents and publishing "alternative to" pages ([Orshot blog](https://orshot.com/blog/orshot-10k-mrr)).

The exit market says the same. An Acquire.com listing for a PDF and screenshot API with no employees shows **$70,798 ARR, $65,381 net profit and a 91% margin**. Its seller later retitled the listing to lead with its Make, n8n and Power Automate integrations ([Acquire.com](https://app.acquire.com/startup/f5to5nqgj6-71k-arr-138-growth-pdf-javascript-saas-for-make-com-n8n-power-automate)). Small SaaS businesses sell for a median **3.9x annual profit** ([Acquire.com](https://blog.acquire.com/acquire-com-biannual-acquisition-multiples-report-jan-2026/)).

The failures are just as instructive:

- **OG-only tools stall.** Bannerbear itself began as Previewmojo, an OG-image-only tool that stalled at **about $400 MRR** until its founder broadened it into a general image API ([Bannerbear](https://www.bannerbear.com/journey-to-10k-mrr/)). Vercel meanwhile ships a free open-source library that renders OG images from HTML and CSS ([Vercel docs](https://vercel.com/docs/og-image-generation)).
- **QR tools earn little.** The best standalone QR tool with payment-verified revenue makes **$881 MRR** ([TrustMRR](https://trustmrr.com/startup/izoukhai)).
- **Free shorteners lose money.** One operator says his free URL shortener "costs me about $27/month and makes $0" ([Indie Hackers](https://www.indiehackers.com/post/i-run-a-free-url-shortener-on-the-side-someone-did-90k-scam-clicks-in-48-hours-d050aa2bd1)).
- **Ad-funded generator sites are worth little.** One such invoice generator site is listed for $1,999 ([Flippa](https://flippa.com/12098023-free-invoice-generator-site-with-fully-customizable-templates-live-preview-adsense-ready-low-maintenance-high-rpm-niche-built-for-growth-and-scalability)).

One caveat runs through all of this. The large figures are reported by founders or repeated by secondary sources. Outside Orshot, every payment-verified number in these categories is under about $1.1K MRR. The ladder shows what is possible, not what is typical.

What buyers pay for explains the pattern. Template image APIs charge **$29–$49 per 1,000 renders at their entry tier**: Templated $39 for 1,000, Bannerbear $49 for 1,000, Placid $19 for 500 ([Templated pricing](https://templated.io/pricing.md); [Templated comparison](https://templated.io/blog/best-image-apis-for-automation/); [TrustRadius](https://www.trustradius.com/products/placid.app/pricing)). Screenshot APIs charge $7–$10 ([SnapRender](https://snap-render.com/blog/screenshot-api-pricing-compared)). The gap exists because template buyers are marketers. They pay for templates and no-code connectors, not for raw rendering.

Link To Card already sells the template engine, but its plans are priced below even the screenshot APIs' entry tiers ([plans.ts](../linktocard/src/billing/plans.ts)):

| Plan | Price | Images | Per 1,000 images |
|---|---|---|---|
| Starter | $9 a month | 2,000 | $4.50 |
| Pro | $29 a month | 10,000 | $2.90 |
| Top-up | $8 | 1,000 | $8.00 |

Its most direct rival, opengraph.xyz, starts paid OG-image plans at $29 a month ([opengraph.xyz pricing](https://www.opengraph.xyz/pricing)). The headroom is therefore not in cheaper renders. It is in tools that carry their own price per document or per recipient, which is where the next two sections point.

## Documents built from a spreadsheet sell at up to 25 times a render

### Bulk certificates with verification pages earn per recipient, not per PDF

Certificate platforms charge for issuing, hosting and verifying credentials, not for drawing them:

| Platform | Free allowance | Price | Works out to |
|---|---|---|---|
| Certifier | 250 credentials a year | **$89 a month for 1,000 credentials a year** ([Certifier blog](https://certifier.io/blog/affordable-digital-credentials)) | About **$1 per recipient per year** |
| Sertifier | Not found | **$30 a month for 50 annual recipients** ([Sertifier pricing](https://info.sertifier.com/pricing)) | About **$7 per recipient per year** |

At the top of the market, Accredible issued **42M+ credentials in 2025** ([Accredible 2025 review](https://www.accredible.com/blog/accredibles-2025-year-in-review)) for more than 2,300 customers ([Accredible TIME listing](https://www.accredible.com/newsroom/time-names-accredible-to-worlds-top-edtech-companies-2025-list)).

Link To Card already has a certificate-of-completion template and a free certificate generator ([README](../linktocard/README.md)). The paid step is the workflow around them:

1. Upload a CSV of names.
2. Render one certificate per row through a Cloudflare Queue.
3. Store each one in R2 and email it through Resend, which already sends sign-in mail.
4. Print a unique ID on each certificate, plus a static QR code that opens a public verification page on linktocard.com. Zero-dependency, MIT-licensed QR libraries such as uqr drop straight into the existing SVG pipeline ([npm: uqr](https://www.npmjs.com/package/uqr)).

That verification page does two jobs. It is the feature incumbents charge for. It is also the main defence against certificate fraud, which one academic paper describes as a "billion dollar industry" in fake diplomas ([UTS paper](https://opus.lib.uts.edu.au/bitstream/10453/195162/2/From%20Black%20Box%20to%20Transparent%20Gate%20Explainable%20AI%20for%20Certificate%20Integrity.pdf)). The existing ban on diplomas from real institutions should stay.

### Mail merge turns the invoice and quote templates into a product

Spreadsheet users already pay for the same row-by-row flow for invoices, quotes and reports:

- **Documint** charges $30–$150 a month plus **$0.20 per extra merge** ([Capterra](https://www.capterra.com/p/215492/Documint/pricing/)).
- **Mergram** sells **1,000 PDF generations for $19** ([Capterra](https://www.capterra.com/p/10040116/Mergram/)).
- **PDF Generator API** meters "merges" as requests multiplied by datasets ([PDF Generator API](https://support.pdfgeneratorapi.com/en/article/what-are-merges-per-month-hadh6q/)).

Against Link To Card's $8 top-up for 1,000 image units, those prices run from about 2.4 times higher (Mergram) to 25 times higher (Documint), for work the same engine already does. Bulk certificates and mail merge share the same machinery: a CSV or sheet in, a Queue fan-out, one render per row, and a zip or emailed links out. One build serves both.

Raw cost is not the bottleneck. Staging measured 0.23–1.2 s per PDF ([README](../linktocard/README.md)), and Browser Run charges $0.09 per browser hour ([Cloudflare pricing](https://developers.cloudflare.com/browser-run/pricing/)). That makes each PDF about $0.000006–$0.00003 in browser time. The real ceiling is **30 Quick Action requests per second per account**, shared by every tool ([Cloudflare limits](https://developers.cloudflare.com/browser-run/limits/)). A Queue consumer smooths this naturally.

Two cautions apply.

- **Browser time is not reported.** Binding PDF calls report `X-Browser-Ms-Used: 0`, and no Cloudflare document explains why. A fixed batch should be checked against the dashboard's browser-hour total before 10,000-row jobs are sold.
- **Invoices feed fraud.** Fake invoices are a common route into business email compromise, which a secondary summary of FBI data puts at **$3.05B in reported losses in 2025** ([Keepnet Labs](https://keepnetlabs.com/blog/invoice-fraud)). Invoice generation should be tied to the account owner's own business identity, with no third-party branding.

### A PDF toolkit can run without a browser at ten cents a form

The third document tool needs no browser at all. Developers automating their own forms already pay about **$0.10 per filled PDF**. Anvil includes 500 free fills a month, then charges $0.10 each ([Anvil pricing](https://www.useanvil.com/pricing.md)). DocSpring works out to about 9.8¢ per form ([DocSpring FAQ](https://docspring.com/faq)). Manipulation APIs meter merge and split per page ([PDF.co](https://developer.pdf.co/api/credits-per-api-function.md)).

pdf-lib (MIT) already covers most of this inside a plain Worker ([npm: pdf-lib](https://www.npmjs.com/package/pdf-lib)):

- merge, split, reorder and rotate pages;
- text or image watermarks, including "PAID" or "DRAFT" stamps on invoices;
- AcroForm fill and flatten;
- embedding JPG or PNG images.

The maintained fork `@cantoo/pdf-lib`, published September 2026, adds AES-256 password protection ([npm: @cantoo/pdf-lib](https://www.npmjs.com/package/@cantoo/pdf-lib)). A 300 ms job costs about $0.000006 in Worker CPU at $0.02 per million CPU-milliseconds ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).

Consumer demand points to the matching free pages. iLovePDF drew **216.8M visits in December 2025** ([ReviewBolt](https://reviewbolt.com/r/ilovepdf.com)). Its top organic pages are JPG to PDF, Merge PDF, PDF to Word and Compress PDF, in that order ([Semdash](https://seo.semdash.com/website-overview/ilovepdf.com)). Stirling-PDF, an open-source toolkit, reached **about 90K GitHub stars** by August 2026 ([Star History](https://www.star-history.com/stirling-tools/stirling-pdf)). Outranking iLovePDF on the head terms is unrealistic. But free "image to PDF" and "merge PDFs" pages aimed at long-tail variants, such as combining certificates or invoices, are cheap funnels into paid generation.

The limits are firm. The 128 MB memory cap per isolate limits file size ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). pdf-lib cannot decrypt input, so encrypted uploads must be refused, and XFA forms are unsupported. Real compression needs image downsampling through Ghostscript or MuPDF ([Ghostscript](https://ghostscript.com/blog/optimizing-pdfs.html)), and MuPDF is AGPL-licensed ([npm: mupdf](https://www.npmjs.com/package/mupdf)), which would force releasing source for a network service. Office conversion and OCR need native tools in Containers. All three should stay out.

The owner also needs to settle two policies explicitly:

- **Uploaded government forms.** Whether filling a customer's own uploaded government or tax form is allowed under the "no government documents" rule.
- **Unlocking.** No tool should ever unlock a password the user does not know.

## Connectors and "link in, card out" multiply the engines already built

The most often repeated distribution channel for render APIs is a no-code marketplace listing. Bannerbear's founder said his Zapier launch "brought unexpected word-of-mouth marketing from the no-code community" ([Indie Hackers](https://www.indiehackers.com/post/living-the-indie-hacker-dream-jon-yongfook-ef84ee6e2e)). Bannerbear now lists about sixty direct integrations ([Bannerbear](https://www.bannerbear.com/v5/products/integrations/)). ScreenshotOne writes that its n8n integration "brings new customers" ([ScreenshotOne](https://screenshotone.com/blog/n8n-integration/)). PDFMonkey lists Zapier, Make, n8n, Bubble and Glide ([PDFMonkey](https://pdfmonkey.io/docs/integrations/)).

No vendor publishes how much revenue these channels bring. Still, every revenue-proven rival has them, and the Acquire seller above put them in the headline, so they are the entry ticket for marketers who do not write code. Bannerbear's typical Zapier recipes turn a new WordPress post or Airtable row into an image ([Zapier](https://zapier.com/apps/bannerbear/integrations)). These map directly onto Link To Card's signed URLs and `/v1/pdf`. Connectors also give mail merge a second entry point for people whose data already lives in Airtable or Google Sheets.

"Link in, card out" is the smallest build, and it is what the product's name already promises. The OG checker already fetches a public page within tight limits:

- https only;
- a 5-second timeout, a 2 MB cap and at most 3 redirects;
- private and metadata addresses refused.

It then parses the share tags and probes the image ([README](../linktocard/README.md)). Extending that so a URL alone produces a branded card serves two kinds of customer: sites with no `og:image`, and anyone sharing links they do not control. It also turns the checker's "no og:image found" verdict into a one-click "make this card".

Metadata alone is a cheap commodity. OpenGraph.io sells 50,000 credits for $25 ([OpenGraph.io](https://www.opengraph.io/pricing)), and iframely charges $49 for 25,000 hits ([iframely](https://iframely.com/pricing)). The only revenue signal, Microlink at **$491.8K in 2024**, is a low-confidence Latka estimate ([Latka](https://getlatka.com/companies/microlink)). So metadata belongs inside the existing credits, not in a plan of its own. Microlink and OpenGraph.io both now pitch MCP access for AI agents ([OpenGraph.io MCP](https://www.opengraph.io/mcp/comparison)). That is vendor positioning, not demand data, but it is cheap to match.

Free checker pages should grow in the same direction. X removed the preview from its Card Validator and did not replace it ([Medium](https://onurdan.medium.com/how-to-validate-twitter-cards-after-x-removed-card-validator-ffcbbe65a409)), and small third-party "X card validator" pages are now filling the gap. Platform-specific preview pages for X, LinkedIn, Slack, Discord and WhatsApp, plus "OG image not showing" troubleshooting pages, reuse the existing inspector. No public search volumes exist for this keyword family, so they should come from Keyword Planner before heavy investment.

The case for free tools as a channel is real but unquantified:

- Ahrefs calls its free tools "consistently among our highest-traffic pages" ([Ahrefs](https://ahrefs.com/blog/the-free-tools-seo-strategy/)).
- One indie founder with $62K in revenue says "a good share of my customers first showed up for a free tool" ([Indie Hackers](https://www.indiehackers.com/post/i-built-claude-but-for-reddit-marketing-and-made-62k-without-a-single-ad-subtitle-it-finds-the-subreddits-where-your-customers-are-checks-3jgnd8b8rAh557tGXAAg)).
- One anecdote puts visitor-to-signup conversion at about 3% ([Indie Hackers](https://www.indiehackers.com/post/10-days-after-launching-my-side-project-what-each-channel-actually-brought-in-2065963871)).

No company publishes a free-tool-to-paid conversion rate. Plan on traffic volume and keep the pages ungated.

Personalized email images are the fifth bet. The evidence here is customer counts rather than revenue. Sendtric claims more than 200,000 customers and charges from $149 a month for API access ([Sendtric](https://www.sendtric.com/); [Sendtric API pricing](https://www.sendtric.com/api-pricing/)). CountdownMail claims 150,000+ companies ([CountdownMail](https://countdownmail.com/)). Hyperise charges about $69 per user per month for personalized sales images ([Hyperise](https://hyperise.com/pricing)).

Link To Card's signed URLs already do the core job. With an email platform's merge tags in the URL, every recipient gets their own name or deadline rendered into a template. The product should start with static PNGs:

- **Animated countdowns.** These need GIF encoding on every open, and GIF is on the README's "deliberately not built" list.
- **Email client caching.** Gmail proxies and caches images, and classic Outlook shows only the first frame of a GIF ([DynaPictures](https://dynapictures.com/data/solutions/email-countdown-timer/gmail-email)).
- **Paddle wording.** It should be marketed as an image tool rather than a marketing service, because Paddle prohibits "mass marketing" offerings ([Paddle AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)).

## Screenshots, e-signatures and monitoring fail on fit, risk or focus

The website screenshot API is the hardest one to turn down, because the market is proven. ScreenshotOne's solo founder reports **about $36K MRR** ([X](https://x.com/DmytroKrasun/status/2104570564006277204)), and Urlbox claims 1,700+ customers ([Urlbox](https://urlbox.com/products/screenshot-api)). But the market is crowded and leaky:

- Entry plans cost $7–$10 per 1,000, and an Apify actor sells screenshots from $0.80 per 1,000 ([Apify](https://apify.com/fourwake/screenshot-api)).
- A teardown of ScreenshotOne finds **9% monthly revenue churn** and a mathematical ceiling near $33K MRR ([Superframeworks](https://superframeworks.com/case-study/screenshotone)).
- Small newcomers with payment-verified revenue earn $64–$185 a month ([HeyFake](https://trustmrr.com/startup/heyfake); [Screenshot Bro](https://trustmrr.com/startup/screenshot-bro)).

It also fits Link To Card badly. The design rule is that the browser only ever receives Link To Card's own sanitised HTML, never a URL, and screenshots sit on the README's "deliberately not built" list. Browser Run traffic "will always be identified as a bot" ([Cloudflare](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)), so a promise to "screenshot any site" produces support tickets. Quick Actions have no hostname guardrails ([Cloudflare](https://developers.cloudflare.com/browser-run/features/guardrails/)). CVE-2026-44439 shows browser-side redirects steering a capture browser to `file://` and private addresses ([SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2026-44439/)).

E-signatures are legal but heavy. ESIGN and UETA in the US and eIDAS Article 25 in the EU accept simple electronic signatures ([legislation.gov.uk](https://www.legislation.gov.uk/eur/2014/910/article/25/data.html); [DocuSign](https://docusign.com/esign-act-and-ueta)). That acceptance comes with conditions: consent, signer identification, an audit trail and records that can be retained. The market is crowded with well-starred open-source players. DocuSeal charges **$0.20 per signed document** ([DocuSeal](https://www.docuseal.com/pricing)). Documenso raised a $1.25M pre-seed and still reported **340 paying customers in 2025** ([Documenso](https://documenso.com/blog/2025-a-year-in-review)). No cryptographic PDF-signing library has been verified on Workers. At most, a narrow "accept this quote" button on the quote template could come later.

Uptime and status monitoring is the strongest argument against this report's focus, and it deserves a fair hearing. Oh Dear reports **$1M ARR** with two founders ([Indie Hackers](https://www.indiehackers.com/post/tech/growing-a-web-monitoring-tool-to-1m-arr-by-building-in-public-X876kKI7Olsf4YBI8FWb)). Instatus shows **$50,105 MRR** on its open metrics page ([Instatus Open](https://instatus.com/open)). StatusGator reports $17K MRR ([Indie Hackers](https://www.indiehackers.com/post/show-ih-statusgator-a-monitoring-tool-making-17k-mrr-after-7-years-8b61e0f064)).

A recurring "peace of mind" product may churn less than render APIs. Cron plus Queues also makes per-minute checks cost about $0.05 per URL per month. Even so, monitoring is a second company with a different buyer:

- **No certificate access.** Neither `fetch()` nor `connect()` exposes the peer TLS certificate ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)), so SSL-expiry alerts have no native path.
- **No region choice.** Workers cannot choose where a check runs from.

If the owner later wants a second product, this is the one with the highest ceiling. It is not a Link To Card tool.

The rest fail for simpler reasons:

- **QR codes.** Bitly owns the category leader, rebranded "QRCG by Bitly" in April 2026 ([QRBench](https://www.qrbench.com/reviews/qrcg-by-bitly/)). Dynamic QR redirects are a phishing vector: malicious QR codes appeared in **at least 11% of phishing emails in the first half of 2026** ([ESET](https://www.welivesecurity.com/en/business-security/qr-code-phishing-slip-past-corporate-security-measures/)). QR codes belong only as a static element inside invoice and certificate templates.
- **Receipts.** These carry the worst fraud profile. AI-generated fakes reached about 14% of fraudulent expense documents by September 2025 ([TechRadar](https://www.techradar.com/pro/security/workers-are-scamming-their-employers-using-ai-generated-fake-expense-receipts)), and one commercial receipt-generator service has a Discord community of over 30,000 members ([Group-IB](https://www.group-ib.com/blog/fake-receipts-generators/)). The existing receipt template should stay behind sign-in, with no public receipt-generator page built for search traffic.
- **Email signature generator.** It has real revenue: MySignature makes "almost $700K" a year, mostly from SEO ([Starter Story](https://www.starterstory.com/stories/mysignature-84b72d95-8f5a-474d-aeb0-f295e20dddcf)). But its output is HTML for email clients, and HubSpot gives one away free ([HubSpot](https://www.hubspot.com/email-signature-generator)). It is an optional SEO experiment at most.
- **Background removal.** Cloudflare Images now does it at standard transformation prices ([Cloudflare Images](https://developers.cloudflare.com/images/pricing/)). But it sits next to the AI image features the README deliberately leaves out, and it invites Paddle due-diligence questions.
- **Favicon generator.** This is a reasonable free funnel. RealFaviconGenerator drew about 257K visits in August 2025 ([Semrush](https://cw.semrush.com/website/realfavicongenerator.net/overview)), but no revenue evidence exists.

## A ranked build order sized for one person and Paddle's fee floor

The effort labels below are judgements based on what the codebase already contains, not measured estimates. "Small" means days, "medium" one to three weeks, and "large" a month or more plus ongoing support.

| Rank | Tool | Best evidence people pay | Engine on Link To Card | Effort | Main risk | Verdict |
|---|---|---|---|---|---|---|
| 1 | Bulk certificates with verification pages, then CSV mail merge for invoices, quotes and reports | Certifier $89/mo for 1,000 credentials a year; Sertifier $30/mo for 50; Documint $0.20 per merge | Existing PDF and card engines, a new Queue, R2, Resend, a QR library | Medium | Invoice misuse; unexplained browser-time reporting | Build first |
| 2 | Zapier, Make and n8n connectors | Credited by Bannerbear and ScreenshotOne; listed by every proven rival | Existing `/v1` API | Medium per platform | Upkeep across platforms | Build second |
| 3 | "Link in, card out" plus a metadata response | Microlink ~$0.5M a year (estimate); fits the brand | Existing inspector plus Satori | Small | SSRF, already handled by the inspector | Ship early; needs no PDFs |
| 4 | PDF toolkit API: merge, split, stamp, fill, image to PDF, encrypt | Anvil $0.10 per fill; DocSpring ~9.8¢ | `@cantoo/pdf-lib` in the Worker, no browser | Medium | 128 MB memory; government-form policy | Build fourth |
| 5 | Personalized email images (static) | Sendtric 200K+ customers claimed, API $149/mo | Signed URLs and templates | Small–medium | Paddle "mass marketing" wording; client caching | Build fifth |
| Free | X/LinkedIn/Slack preview checkers; image-to-PDF and merge pages | X validator gap; iLovePDF's top pages | Inspector; pdf-lib | Small | Unknown conversion rate | Ship alongside |
| Skip | Screenshot API, e-sign, compress/convert/OCR, dynamic QR, public receipts, monitoring | Proven markets, but crowded or risky | Conflicts with the "never a URL" rule, or needs AGPL native code | Large | SSRF, legal, fraud, focus | Do not build |

Sequencing matters because PDFs are still off in production, and checkout waits for Paddle to approve the domain ([README](../linktocard/README.md)). Rank 3, the free checker pages and the image half of the connectors do not depend on PDFs, so they can ship while the PDF decision is pending.

Paddle's fee sets the floor for pricing. Paddle charges **5% plus $0.50 per checkout transaction** ([Paddle pricing](https://www.paddle.com/pricing)):

| Purchase | Paddle's cut | Share |
|---|---|---|
| $5 one-off | $0.75 | 15% |
| Current $8 top-up | $0.90 | 11% |
| $49 purchase | $2.95 | 6% |

Sejda's $5 one-week pass shows that one-off passes do sell for occasional PDF jobs ([Sejda](https://www.sejda.com/pricing)). Even so, new tools should be sold as credits inside existing plans or as add-ons of $10 or more, never as $2–$5 single purchases.

Paddle's native usage-based billing is still in early access. During the beta it "never blocks usage" and does not bill overage ([Paddle agent skill](https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/usage-based-billing/SKILL.md)), so quotas should stay in Link To Card's own D1 ledger.

Tool descriptions should avoid words like "bypass", "scrape", "automated social media marketing" or "mass marketing", which sit next to Paddle's prohibited categories ([Paddle AUP](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)). Lebanon is absent from Paddle's list of unsupported seller countries ([Paddle](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle)). That is support by omission only, and no payout to Lebanon has been confirmed, so written confirmation from Paddle should come before any of this is built.

Three gaps remain open:

- **Vendor prices.** Nearly all of them came from aggregators, because vendor pages could not be fetched. They need checking before they are quoted on comparison pages.
- **Revenue figures.** Most are self-reported.
- **Conversion rates.** None of the research found a free-tool-to-paid conversion rate.

## Conclusion

Link To Card's real advantage is cost structure, not features. Its images never touch a browser, and its PDFs cost hundreds to thousands of times less per document than competitors' entry prices. That advantage is worth the most where rivals charge for the workflow rather than the render: per recipient for certificates, per merge for spreadsheet documents, and per fill for forms. Rivals cut their free tiers sharply in 2026: PDFMonkey went from 300 documents a month to 20 ([agentdeals](https://agentdeals.dev/vendor/pdfmonkey)), and CraftMyPDF from 100 to 50 ([agentdeals](https://agentdeals.dev/vendor/craftmypdf)). The same cost base lets Link To Card keep a generous free tier where competitors retreated, provided its existing abuse limits hold.

The category's history also argues against staying an OG-card company. Bannerbear's OG-only first version stalled at $400 MRR. Its real business arrived only once it rendered images and documents from whatever data customers already had, wherever that data lived. Link To Card's renders are already priced below the screenshot APIs. Its next revenue will come from tools priced by the job they finish, sold through the no-code platforms its buyers already use, not from cheaper or more numerous renders.
