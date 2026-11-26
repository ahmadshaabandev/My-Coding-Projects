# Paid image-generation, screenshot and link-preview APIs adjacent to dynamic OG cards (market survey for linktocard.com)

Method note (read first). Researched 2026-11-26. Direct page fetches (WebFetch) were refused by this session's network policy for every vendor host tried (screenshotone.com, urlbox.com, apiflash.com, screenshotapi.net, microlink.io, browshot.com all failed with "host not allowed"), so no vendor page was opened directly. Every figure below comes from web-search result summaries of the cited URL (search index, accessed 2026-11-26). Where the search summary attributed a figure to an aggregator (toolradar, itechguides, xpay.sh, saasworthy, spotsaas, Capterra etc.) the aggregator is cited, not the vendor. Treat all prices as "reported, not re-verified on the live page". Revenue figures are self-reported by founders unless marked as estimates. "Date" = the date the source states; "undated" where none was given. Nothing older than 2025 is used without its date being stated.

## 1. Website screenshot APIs: pricing, price per 1,000, limits, revenue/customer signals, use cases

### Takeaway
Screenshot APIs are a proven, crowded, low-price category: entry plans are $7 to $19/month for 1,000 to 2,000 shots, and volume prices fall to about $1.75 to $5 per 1,000. The clearest solo-founder proof point is ScreenshotOne at roughly $32K to $36K MRR with 1,000+ paying customers in 2026, which has plateaued around $33K because of churn; Urlbox claims 1,700+ customers. All of them need a real headless browser.

### Cited Findings

**ScreenshotOne (solo founder Dmytro Krasun, launched 29 May 2022)**
- Pricing reported: Free 100 screenshots/month (no card); Basic $17/month for 2,000 (40 req/min, $0.009 per extra); Growth $79/month for 10,000 (80 req/min, $0.006 per extra); Scale $259/month for 50,000 (150 req/min, $0.004 per extra); billed only for successful requests; annual billing reportedly 2 months free — [toolradar](https://toolradar.com/tools/screenshotone/pricing), [aisotools](https://aisotools.com/pricing/screenshotone), [itechguides](https://www.itechguides.com/?p=866089), [ScreenshotOne pricing page](https://screenshotone.com/pricing). SaaSworthy lists different, apparently outdated tiers ($12/$40/$124) — [saasworthy](https://www.saasworthy.com/product/screenshotone/pricing).
- Implied price per 1,000 (calculated from the above): Basic $8.50, Growth $7.90, Scale $5.18.
- Revenue: "~$36K MRR and still growing"; says he launched a hosted MCP server aimed at AI agents (undated X post; status ID suggests 2026) — [Krasun on X](https://x.com/DmytroKrasun/status/2104570564006277204).
- Revenue: founder's four-year post (May 2026) reports $33K MRR and 1,000+ paying customers — [dmytrokrasun.com "4 Years of Running ScreenshotOne"](https://dmytrokrasun.com/posts/screenshotone-4-years/) (as summarised by search; a second search could not surface the exact title, so treat with caution).
- Revenue: third-party teardown: "One founder. Four years. $32K MRR, 1,000+ paying customers, 100 million API requests served"; 9% monthly revenue churn; at ~$3K new MRR/month and 9% churn the business "mathematically caps out around $33K" (2026) — [Superframeworks case study](https://superframeworks.com/case-study/screenshotone), [Superframeworks newsletter](https://superframeworks.beehiiv.com/p/32k-mrr-1-000-customers-and-a-hard-ceiling-at-33k).
- Earlier milestones: 800+ paying customers and $25K+ MRR (Indie Hackers, undated, probably 2025-2026) — [Indie Hackers](https://www.indiehackers.com/post/tech/hitting-25k-mrr-by-making-his-goals-less-ambitious-jQRZDnzwm8DFAaS4Xrq0); $200K ARR with 400+ paying customers (founder blog, undated, earlier) — [ScreenshotOne blog](https://screenshotone.com/blog/200000-arr-and-400-paying-customers/); $20K MRR (June 2025), $21,609 MRR (Aug 2025), $300K ARR with 650 paying customers (aggregator) — [startupfounderstories](https://startupfounderstories.com/stories/dmytro-krasun-screenshotone-20k-mrr); $2.2K MRR at an early stage (dated pre-2025) — [Starter Story](https://www.starterstory.com/stories/screenshotone); Feb 2023: $982 total revenue; Mar 2023: 38 paying customers (pre-2025) — [Indie Hackers Feb 2023 report](https://www.indiehackers.com/product/screenshotone-the-best-screenshot-api/february-2023-report--NPmGQtRwjaNUFNv-8ow).
- Use cases ScreenshotOne markets: Open Graph image generation and link-share previews, marketing content, competitor analysis, website monitoring and change tracking, error-page capture, user-generated-content capture, invoice/receipt PDFs, AI agents that "see" a page, scrolling screenshots as GIF/MP4, cookie-banner blocking — [ScreenshotOne use cases](https://screenshotone.com/use-cases), [AI agents use case](https://screenshotone.com/use-cases/ai-agents/), [website monitoring](https://screenshotone.com/use-cases/website-monitoring/), [what is a screenshot API](https://screenshotone.com/blog/what-is-a-screenshot-or-html-rendering-api). ScreenshotOne is listed as built on Cloudflare — [Cloudflare Built With](https://workers.cloudflare.com/built-with/projects/ScreenshotOne).

**Urlbox (London, founder Chris Roebuck, bootstrapped, since 2013)**
- Pricing reported: Lo-Fi $19/month for 2,000 renders; Hi-Fi $49/month for 5,000; Ultra $99/month for 15,000; Business $495 base + $3 per 1,000 renders (shown as $498/month); >1,000,000 renders/month = contact sales; Enterprise "from $3,000/month" (toolradar). The vendor's markdown pricing page says it was generated from live Stripe pricing on 2026-07-09 — [urlbox.com/pricing.md](https://urlbox.com/pricing.md), [macmyths (checked Oct 2026)](https://macmyths.com/how-to-choose-a-screenshot-api-plan-for-a-saas-app/), [toolradar](https://toolradar.com/tools/urlbox/pricing).
- Implied price per 1,000: Lo-Fi $9.50, Hi-Fi $9.80, Ultra $6.60, Business marginal $3.00.
- Scale: "800M+ screenshots rendered for over 1,700 customers" (product page, undated) — [Urlbox screenshot API page](https://urlbox.com/products/screenshot-api); "shot past 100 million successful renders per year" without outside funding (31 May 2024) — [Urlbox "Why we changed our pricing"](https://urlbox.com/why-we-changed-our-pricing).
- Revenue: only old figures: ~$6,000/month subscription revenue, $3,750 net profit (2016 interview) — [Anyway](https://anyway.sh/blog/urlbox-bootstrapped-screenshot-api); $3.5K/month disclosed in 2017 — [BoringCashCow](https://boringcashcow.com/showcase/the-lucrative-world-of-boring-screenshot-api-businesses). Current revenue: not found.

**ApiFlash**
- Pricing reported: Free 100/month; Lite $7/month for 1,000; Medium $35/month for 10,000; Large $180/month for 100,000; Enterprise custom ("millions of screenshots per month") — [spotsaas](https://www.spotsaas.com/product/apiflash/pricing), [toolradar](https://toolradar.com/tools/apiflash/pricing), [xpay.sh](https://www.xpay.sh/saas-pricing/api-flash/), [apiflash.com](https://apiflash.com/). One competitor blog says Medium is $49 for 10,000 (likely outdated) — [screenshotapi-app blog](https://screenshotapi-app.vercel.app/blog/screenshot-api-pricing-comparison).
- Implied price per 1,000: $7.00 / $3.50 / $1.80.
- Revenue or customer count: not found.

**ScreenshotAPI.net**
- Pricing reported: 7-day trial with 100 screenshots; Essential $9 for 1,000; Startup $29 for 10,000; Business $175 for 100,000 (reported as an October 2026 check) — [screenshotapi.net/pricing](https://www.screenshotapi.net/pricing), [positioniseverything](https://www.positioniseverything.net/screenshotapi-to-cost-per-1000-website-screenshots/). Conflicting aggregator values: Essentials $5 (saasworthy), Startup $25 (spotsaas), Business $99 for 50,000 (a blog) — [saasworthy](https://www.saasworthy.com/product/screenshotapi/pricing), [spotsaas](https://www.spotsaas.com/product/screenshotapi/pricing).
- Implied price per 1,000: $9.00 / $2.90 / $1.75.
- Revenue: not found.

**Browshot**
- Prepaid credits, not subscriptions: 100 free screenshots/month; 1,000 credits $10; 20,000 $100; 125,000 $500; 300,000 $1,000 (one-time) — [xpay.sh](https://www.xpay.sh/saas-pricing/browshot/). Spotsaas instead says "custom pricing" — [spotsaas](https://www.spotsaas.com/product/browshot/pricing).
- Implied price per 1,000: $10.00 / $5.00 / $4.00 / $3.33. Revenue: not found.

**Microlink (metadata/link-preview API that also sells screenshots; founder Kiko Beats)**
- Pro $49/month for 46,000 requests/month (~$1.07 per 1,000); free 25 requests/day "forever free"; selector also offers 84,000 / 140,000 / 280,000 / 420,000 requests/month; at 100% quota requests pause, no overage fees — [microlink.io/pricing](https://microlink.io/pricing), [macmyths review](https://macmyths.com/microlink-screenshot-api-pricing-what-each-plan-includes/).
- Revenue estimate (third-party, not self-reported): ~$491.8K (2024), up from $226.8K (2023), team of about four — [Latka](https://getlatka.com/companies/microlink). Latka also claims "78M customers", which is implausible. Treat as low-confidence estimates.

**Market-level signals**
- Acquire.com listing "Highly profitable PDF Generation & Screenshot API SaaS": asking $265K, $71.9K TTM revenue, $65.4K TTM net profit (3.7x revenue, 4.1x profit); undated; sale status not found — [Acquire.com listing](https://app.acquire.com/public/f5to5nqgj6-highly-profitable-pdf-generation-screenshot-api-saas).
- TrustMRR lists "ScreenshotDEV (for Sale)" (figures not captured) — [TrustMRR](https://trustmrr.com/startup/screenshotdev-for-sale).
- A small-founder data point: a screenshot API built from Tbilisi with "50 users, 9 paying" (undated dev.to post) — [dev.to](https://dev.to/sleywill_45/i-built-a-screenshot-api-from-tbilisi-50-users-9-paying-heres-everything-i-learned-jf4).
- Commodity floor: Apify actors sell screenshots from $0.80 per 1,000 — [Apify screenshot actor](https://apify.com/fourwake/screenshot-api).
- Cost basis on linktocard's own stack: Cloudflare Browser Run on Workers Paid includes 10 browser hours/month, then $0.09 per browser hour; 10 concurrent browsers (monthly average) included, then $2.00 per extra concurrent browser; Free plan 10 minutes/day; no cap on browser hours on paid plans — [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/), [limits](https://developers.cloudflare.com/browser-run/limits/), [pricing changelog 2025-07-28](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/).

### Inferences
- Retail price per 1,000 shots clusters at $7 to $10 for entry plans and $1.75 to $5 at volume; Microlink at ~$1.07 is the low-price anchor among branded APIs.
- If one screenshot costs about 3 to 5 seconds of Browser Run time (an assumption, not measured here), 1 browser hour yields roughly 700 to 1,200 shots, i.e. about $0.08 to $0.13 per 1,000 in browser-hour charges at $0.09/hour, before concurrency charges. Gross margin at $5 to $9 per 1,000 would be very high; the real constraint is concurrency ($2 per extra concurrent browser) and reliability (cookie banners, lazy-loading, blocked sites), which is what ScreenshotOne and Urlbox actually sell.
- ScreenshotOne's plateau (~$33K MRR, 9% revenue churn) suggests the category supports one strong solo business but churns heavily; a new entrant would be competing on price against several established players with years of rendering edge-case fixes.
- linktocard already runs Browser Run for PDFs, so a URL-screenshot endpoint is technically adjacent, but it would be a "me-too" product in a crowded market; its most defensible angle is bundling ("OG card + screenshot fallback + PDF in one plan") rather than a standalone screenshot API.

### Gaps
- Live vendor pricing pages could not be opened (network policy), so no figure was verified on the vendor's own page.
- Revenue for Urlbox (post-2017), ApiFlash, ScreenshotAPI.net, Browshot: not found.
- No public keyword search-volume figure for "screenshot API" was found.
- Whether the Acquire.com screenshot/PDF listing sold, and its date: not found.

## 2. Image templating/automation APIs (Bannerbear, Placid, Abyssale, Templated.io, RenderForm, APITemplate.io, Orshot, Creatomate): pricing, positioning, revenue, integrations

### Takeaway
This is the strongest revenue evidence in the space and the closest fit to linktocard's Satori engine: Bannerbear (solo founder) reportedly at ~$81K MRR (2026, unverified primary), APITemplate.io + CraftMyPDF reportedly $30K to $75K MRR combined, and Orshot (solo, launched March 2025) at $10.3K to $12.7K MRR by late 2026. Customers pay for monthly render credits, templates, and especially no-code integrations (Zapier, Make, Airtable, WordPress, n8n). Entry prices are $19 to $49/month for 500 to 3,000 renders.

### Cited Findings

**Bannerbear (solo founder Jon Yongfook)**
- Pricing reported (checked 29 Sep 2026): Automate $49/month for 1,000 API credits; Scale $149/month for 10,000; Enterprise $299/month for 50,000; trial 30 credits, no card; quotas reset on the 1st, no rollover; extra API credits reportedly cannot be bought — [itechguides](https://www.itechguides.com/?p=866109), [Pulse Signal](https://getpulsesignal.com/compare/bannerbear-vs-visme). Credits charged per output format and scale (2 formats at scale 2 = 4 credits); animation 2 credits/second, 60 fps doubles — [UMA Technology](https://umatechnology.org/bannerbear-pricing-in-2026-plans-api-limits-and-cheaper-options/). Toolradar describes only two paid tiers ($49/1,000 and $149/10,000) — [toolradar](https://toolradar.com/tools/bannerbear/pricing).
- Implied price per 1,000: $49.00 / $14.90 / $5.98.
- Revenue: $81K MRR / $972K ARR "publicly reported" (2026, aggregator, primary post not located) — [Indie Maker List](https://indiemakerlist.com/p/jon-yongfook/), [arrfounder](https://arrfounder.com/@yongfook); ~$50K MRR (estimate citing TrustMRR, not confirmed) — [WhoEarns](https://www.whoearns.com/jon-yongfook), [5to9 newsletter](https://5to9.beehiiv.com/p/bannerbear-grew-50k-mrr-business); $10,455 MRR in January 2021 and $20,018 MRR in July 2021 (pre-2025) — [Small Start (note.com)](https://note.com/small_start/n/na3b576f0601a?hl=en), [Indie Maker List](https://indiemakerlist.com/p/jon-yongfook/).
- Integrations: Zapier (e.g. "generate Bannerbear images from new WordPress posts", Airtable, Google Sheets), Make (Airtable to Pinterest pins), native Airtable integration, WordPress via REST API, n8n node; about sixty direct app integrations — [Zapier](https://zapier.com/apps/bannerbear/integrations), [Zapier + Airtable](https://zapier.com/apps/bannerbear/integrations/airtable), [Make](https://www.make.com/en/integrations/bannerbear/airtable), [Bannerbear integrations](https://www.bannerbear.com/v5/products/integrations/), [n8n](https://n8n.io/integrations/bannerbear), [Bannerbear help: integrations](https://www.bannerbear.com/help/integrations/).
- Review-site footprint is tiny: G2 shows 0 reviews; TrustRadius 1 review (7/10); Product Hunt 4.6/5 with 32 reviews — [G2](https://www.g2.com/products/bannerbear/reviews_and_filters), [TrustRadius](https://www.trustradius.com/products/bannerbear), [Product Hunt](https://www.producthunt.com/posts/bannerbear/reviews).

**Placid (Austria; founders Armin Ulrich and Melanie Massinger; since 2018)**
- Pricing reported (TrustRadius, not confirmed on vendor page): Basic $19/month for 500 credits; Pro $39 for 2,500; Business $89 for 25,000; VIP $249 for 100,000; free trial — [TrustRadius pricing](https://www.trustradius.com/products/placid.app/pricing), [TrustRadius listing](https://www.trustradius.com/products/placid.app). Credit rules from vendor help: 1 image = 1 credit; 10 s video = 10 credits; 1 PDF page = 2 credits; watermarked test previews are free — [Placid help](https://placid.app/help/how-do-placid-credits-work). Rollover up to 2x monthly allowance and no overage fees (secondary source) — [itechguides](https://www.itechguides.com/?p=866152).
- Implied price per 1,000 (TrustRadius figures): $38.00 / $15.60 / $3.56 / $2.49.
- Customers: Starter Story (Pat Walls) uses it for social images — [Placid customer story](https://placid.app/customers/starter-story). Investors listed: Precursor Ventures, Northside Ventures — [CB Insights](https://www.cbinsights.com/company/placid). Revenue: not found. G2: 1 review (possibly mismatched) — [G2](https://www.g2.com/products/placid-app/reviews).

**Abyssale (seat-based, marketing-team positioning)**
- Pricing reported: Start $12, Pro $36, Suite $60 per seat/month billed annually; Enterprise by sales; the same page's FAQ says Start $15 and Suite $75 per seat/month (unresolved conflict); basic plan 150 generation credits/month; free trial, no free plan — [Abyssale pricing](https://abyssale.com/pricing/), [Capterra](https://www.capterra.com/p/213983/Abyssale/pricing). Revenue: not found.

**Templated.io (founder Pedro Campos)**
- Pricing reported: Starter 1,000 credits/month at $39 monthly or $29/month annual (15 templates, 2 team members); Scale 5,000/month; Enterprise 25,000/month at $179/month annual (xpay) or $229/month (Orshot, a competitor); images 1 credit, PDFs 1 credit/page, no rollover; free trial 50 credits — [Templated pricing](https://templated.io/pricing.md), [Templated help](https://templated.helpscoutdocs.com/article/25-understand-plans-and-usage-limits), [xpay.sh](https://www.xpay.sh/saas-pricing/templated-io/), [Orshot comparison](https://orshot.com/blog/templated-io-alternative).
- Implied price per 1,000: Starter $29 to $39; Enterprise ~$7.16 to $9.16.
- Revenue: just under $100 MRR at launch (Starter Story interview, roughly 2025) — [Starter Story](https://www.starterstory.com/stories/templated). Current revenue: not found. Running a Black Friday 2026 promotion (20% off) — [Templated vs Orshot page](https://templated.io/alternative-to/orshot/).

**APITemplate.io (+ sister product CraftMyPDF; founder Jacky Tan, founded Dec 2020)**
- Revenue: latest sourced run-rate $30K/month (April 2025); $15K/month (April 2023, both products combined) — [Starter Story revenue page](https://www.starterstory.com/businesses/apitemplate-io/revenue), [Starter Story CraftMyPDF interview](https://starterstory.com/stories/craftmypdf); press release: APITemplate.io and CraftMyPDF "surpass $75K MRR" combined (undated) — [PRLog](https://www.prlog.org/13136222-apitemplateio-and-craftmypdf-surpass-75k-mrr-expand-integrations-for-automated-content-workflows.html); Latka estimates $360K annual revenue (Sept 2023) — [Latka](https://getlatka.com/companies/apitemplateio).
- APITemplate.io image-side pricing: not found.

**Orshot (solo founder Rishi Mohan, Berlin, started March 2025)**
- Revenue: $10,259 MRR, 28,500+ users, 1.3M+ renders, team of 1 (29 Oct 2026) — [Orshot blog](https://orshot.com/blog/orshot-10k-mrr), [Orshot about](https://orshot.com/about); TrustMRR (Stripe-verified): $12,735 MRR, 222 active subscriptions, $81,960 all-time revenue, $12,184 in last 30 days (Nov 2026) — [TrustMRR](https://trustmrr.com/startup/orshot-com); ~$6.2K MRR, ~5,000 users, 760K+ renders (mid-2026) — [FakeMayo](https://www.fakemayo.com/p/from-side-hustles-to-6-2k-mrr-how-rishi-mohan-built-orshot).
- Pricing reported: $30/month for 3,000 renders (2 workspaces, 2 members); Startup $160/month for 50,000; Agency $480/month for 400,000; overage $18 / $15 / $12 per 1,000; free 60 one-time renders; annual 20% off; recently moved from "renders" to "credits" — [Orshot pricing](https://orshot.com/pricing), [Orshot "Renders are now credits"](https://orshot.com/blog/renders-to-credits.md). Capterra lists Startup as 200,000 renders (conflict) — [Capterra](https://www.capterra.com/p/10041867/Orshot/pricing/). Also sells automated social posting at $12/month per social account — [Orshot blog](https://orshot.com/blog/orshot-10k-mrr).
- Implied price per 1,000: $10.00 / $3.20 / $1.20.
- Go-to-market: publishes "alternative to" pages against Placid, Creatomate and Templated.io — [vs Placid](https://orshot.com/blog/placid-api-alternative.md), [vs Creatomate](https://orshot.com/blog/creatomate-api-alternative), [vs Templated](https://orshot.com/blog/templated-io-alternative.md). Same founder's earlier product Pika.style (screenshot beautifier) was ~$3.8K/month in April 2024 — [Starter Story](https://starterstory.com/stories/pika).

**RenderForm**
- Pricing reported: Pro from $14/month or $169/year, 250 credits/month, no watermark; 1 credit = 1 image or PDF; pay-as-you-go credits also offered; free-tier status disputed — [xpay.sh](https://www.xpay.sh/saas-pricing/renderform-io/), [saasworthy](https://www.saasworthy.com/product/renderform-io/pricing). Implied ~$56 per 1,000 on Pro. Revenue: not found.

**Creatomate (video-first, images 1 credit each)**
- Pricing conflicting: Essential $29/month for 2,000 credits (one listing) vs $54/month ($45 annual) for 2,000 credits (another); Growth $99/month; free plan renders previews up to 480 px; 50-credit trial — [Creatomate pricing](https://creatomate.com/pricing), [toolradar](https://toolradar.com/tools/creatomate/pricing), [Capterra](https://www.capterra.com/p/268283/Creatomate/pricing/), [credits doc](https://creatomate.com/docs/account/how-are-credits-calculated). Revenue: not found.

### Inferences
- Template-image APIs command much higher price per 1,000 at entry ($29 to $49 per 1,000) than screenshot APIs ($7 to $10), because buyers are marketers paying for templates, a visual editor and Zapier/Make/Airtable connectors, not raw rendering.
- Orshot is the most relevant comparable: a solo founder reached ~$10K to $12.7K MRR in about 18 months from March 2025 in an already crowded market by bundling images + PDFs + video, undercutting incumbents on price per render, and publishing competitor-alternative pages. linktocard already has images (Satori) and PDFs, so it is structurally close to Orshot minus video and minus a visual template editor.
- The integrations are the product for no-code buyers: Bannerbear's top use cases on Zapier/Make are WordPress-post-to-image and Airtable-row-to-image. A Zapier/Make/n8n app plus an Airtable recipe is probably worth more than another template.
- G2/Capterra review counts are near zero for these vendors, so they are not a useful demand proxy here; founder MRR disclosures and TrustMRR are better signals.

### Gaps
- Bannerbear's $81K MRR could not be traced to a primary founder post; current verified figure not found.
- Revenue for Placid, Abyssale, Templated.io (post-launch), RenderForm, Creatomate: not found.
- APITemplate.io image-generation pricing: not found.
- Placid's prices were not confirmed on placid.app itself.

## 3. Link preview / unfurl / metadata APIs (Microlink, LinkPreview.net, OpenGraph.io, iframely)

### Takeaway
Metadata/unfurl APIs are cheap per call ($0.50 to $2 per 1,000) with $8 to $49 entry plans; demand evidence is thin apart from Microlink's estimated ~$0.5M/year revenue. Most of this work needs only an HTTP fetch and HTML parse, not a browser, so it is a natural, low-cost add-on to an OG-card product.

### Cited Findings
- **Microlink**: Pro $49/month for 46,000 requests (~$1.07 per 1,000), free 25 requests/day (whether one quota covers metadata, screenshots and PDFs was not confirmed) — [microlink.io/pricing](https://microlink.io/pricing), [macmyths](https://macmyths.com/microlink-screenshot-api-pricing-what-each-plan-includes/). Revenue estimate $491.8K (2024) / $226.8K (2023), Latka estimate, not self-reported — [Latka](https://getlatka.com/companies/microlink). Launched on Product Hunt as "turns any website into structured data", free daily quota + pay-as-you-go — [Product Hunt](https://www.producthunt.com/@kikobeats).
- **LinkPreview.net**: Free $0, personal use only, 60 requests/hour; Basic $8/month, personal use, 200/hour; Pro $25/month, commercial use, 1,000/hour; Enterprise $119/month, commercial, 100/minute (Spotsaas says $199) — [linkpreview.net](https://www.linkpreview.net), [spotsaas](https://www.spotsaas.com/product/linkpreview-api/pricing). Paid-for lever is commercial-use licence plus rate limit, not volume. Revenue: not found.
- **OpenGraph.io**: Developer $25/month for 50,000 API credits (~$0.50 per 1,000 credits); free tier 100 requests/month; concurrency capped by plan; now also markets an MCP server for AI agents — [OpenGraph.io pricing](https://www.opengraph.io/pricing), [rate limits](https://www.opengraph.io/docs/concepts/rate-limits), [MCP comparison](https://www.opengraph.io/mcp/comparison). Revenue: not found.
- **iframely**: Starter free with 2,000 hits/month then $0.40 per 100 hits; Business $49/month for 25,000 hits (overage $3 per 1,000, $2 after 100K); Editorial $149/month for 100,000 hits; Enterprise $399/month for 500,000 hits ($1 per 1,000 overage); a "hit" is one hour of activity for one URL (max 24 hits per URL per day) — [iframely pricing](https://iframely.com/pricing), [iframely plans](https://iframely.com/plans), [iframely billing help](https://iframely.com/help/021438-how-iframely-billing-works). Implied $1.96 / $1.49 / $0.80 per 1,000 hits. Revenue: not found. Embedly also sells plans — [Embedly pricing](https://embed.ly/pricing).

### Inferences
- Unfurl/metadata alone is a commodity with low prices, but it pairs naturally with linktocard: "give us a URL, we read its title/description/image and render a branded card" is a link-to-card feature that competitors sell separately (Microlink for metadata, Bannerbear for the image).
- Both Microlink and OpenGraph.io are now pitching AI-agent/MCP access, suggesting agent tooling is where these vendors see new demand (vendor positioning, not demand data).

### Gaps
- Usage or customer counts for LinkPreview.net, OpenGraph.io, iframely: not found.
- OpenGraph.io tiers above Developer: not found.
- No search-volume data for "link preview API" found.

## 4. Smaller image utilities people pay for

### Takeaway
The smaller utilities with real, documented revenue are: dynamic email countdown timers (Sendtric claims 200,000+ customers, CountdownMail 150,000+ companies; plans $8 to $49/month, API from $149/month), personalized sales images (Hyperise at $69/user/month), QR codes (Bitly bought QR Code Generator / Egoditor, 10M+ users, in Dec 2021; QR Tiger from $7/month), and social-content beautifiers/carousels (Pika.style ~$3.8K/month in 2024, aiCarousels ~$5K MRR in 2023, PostNitro ~$4K MRR). YouTube-thumbnail and tweet-image tools show mostly tiny or unverified revenue. Code-screenshot tools are cheap ($5 to $9/month) with small revenue.

### Cited Findings

**Dynamic email images: countdown timers**
- Sendtric: free plan 10,000 views/month; views beyond the limit get a watermark (paid plans never watermarked); paid from $8.25/month billed annually (1.8M views/year); business tier $35/month; API access from $149/month; claims 200,000+ customers including Google, HP, Walmart — [Sendtric pricing](https://www.sendtric.com/pricing/), [Sendtric vs CountdownMail](https://www.sendtric.com/sendtric-vs-countdownmail/), [Sendtric API pricing](https://www.sendtric.com/api-pricing/), [Sendtric homepage](https://www.sendtric.com/). Older tiers: Micro $9 (150K views), Standard $29 (1M), Power $49 (5M) (December 2022, pre-2025) — [SendPulse review](https://sendpulse.com/blog/test-drive-3-countdown-timer-providers).
- CountdownMail: "Trusted by 150,000+ companies"; business $39/month, enterprise $199/month (per Sendtric's comparison); free plan with unlimited views (per a reviewer); vendor case study claims 6.4% vs 3.1% conversion ($508,000 extra revenue for one client) — [CountdownMail](https://countdownmail.com/), [CountdownMail pricing](https://countdownmail.com/pricing), [Sendtric comparison](https://www.sendtric.com/sendtric-vs-countdownmail/), [EmailToolTester](https://www.emailtooltester.com/en/blog/email-countdown-timers/).
- MotionMail: free plan; Bootstrap $10, Startup $60, Enterprise $200/month (SendPulse, date unclear, likely 2022); paid plans bill overage per credit (view) at period end; some plans roll credits over — [SendPulse](https://sendpulse.com/blog/test-drive-3-countdown-timer-providers), [MotionMail support: credits](https://motionmail.freshdesk.com/support/solutions/articles/14000003404--what-is-a-credit-and-how-many-do-i-get-), [MotionMail support: overage](https://motionmail.freshdesk.com/support/solutions/articles/14000003401-what-happens-when-i-run-out-of-credits-); Mailchimp integration — [Mailchimp](https://mailchimp.com/integrations/motionmail-countdown-timers).
- NiftyImages: personalized images and countdown timers (fixed deadline, per-subscriber date, or evergreen from open); integrates with Klaviyo, Mailchimp, Braze, Iterable; price conflicting ($20/user/month or $12/month starting, Software Advice) — [NiftyImages timers](https://publicpreview.niftyimages.com/CountdownTimers), [Software Advice](https://www.softwareadvice.com/product/460990-NiftyImages/), [Capterra](https://www.capterra.com/p/146842/NiftyImages/), [Iterable partner page](https://partnerships.iterable.com/partners/technology/niftyimages). Revenue: not found.

**Personalized images**
- Hyperise: Images plan ~$69/user/month ($57.50 annual), includes 5,000 image views and up to 5 active images, unlimited templates; Websites $99, Videos $149/user/month; Agency $495/month; White Label ~$1.6K/month — [Hyperise pricing](https://hyperise.com/pricing), [Costbench](https://costbench.com/software/ai-sales-tools/hyperise/), [Capterra](https://www.capterra.com/p/187081/Hyperise/pricing/), [spotsaas](https://www.spotsaas.com/product/hyperise/pricing). GetApp lists $49/user (conflict) — [GetApp](https://www.getapp.com/marketing-software/a/hyperise/). Revenue: not found.

**QR code generators**
- Bitly acquired Egoditor (QR Code Generator PRO, Bielefeld) announced 1 Dec 2021 (pre-2025); Egoditor had 10M+ users in 190+ countries; Bitly said it was profitable with over $75M ARR (company-wide, not Egoditor alone) — [Bitly press release](https://bitly.com/pages/resources/press/bitly-emerges-as-global-saas-leader-with-acquisition-of-egoditor), [TechCrunch](https://techcrunch.com/2021/12/01/bitly-makes-first-acquisition-with-qr-code-leader-egoditor/). CB Insights lists Egoditor 2021 revenue as $34.12M (third-party, unverified) — [CB Insights](https://www.cbinsights.com/company/qr-code-generator/financials). Deal price: not found from a reliable source.
- QR Tiger: free 3 dynamic codes x 500 scans with QR Tiger branding/ads; Regular $7/month ($65/year) for 12 dynamic codes, unlimited scans; higher tiers Advanced, Premium, Professional, Enterprise; codes stop working when the plan expires; claims 850,000 brands — [QR Tiger pricing](https://qrcode-tiger.com/payment), [G2](https://www.g2.com/products/qr-tiger/pricing), [QR Tiger help](https://qrtiger.helpscoutdocs.com/article/201-is-using-qr-tiger-free). Revenue: not found.

**Screenshot beautifiers / social images**
- Pika.style (Rishi Mohan): $3,799/month (April 2024, pre-2025), running cost $200 to $300/month, ads shown to free users "worked surprisingly well" — [Starter Story](https://starterstory.com/stories/pika); $2,000 MRR and 190 paid users (2023) — [Indie Hackers](https://www.indiehackers.com/post/founder-story-how-buildinpublic-helped-to-reach-2000-mrr-with-a-screenshot-tool-98a946db55).
- aiCarousels (Fernando Pessagno, LinkedIn/Instagram carousels): $2,500 MRR three months after launch (2023); $5K MRR in body of Nov 2023 interview (header says $10K, conflict) — [Starter Story](https://www.starterstory.com/stories/aicarousels), [Outseta](https://outseta.com/posts/10-days-to-5k-with-ai); Latka estimate $15.2K/year (Oct 2024) — [Latka](https://getlatka.com/companies/aicarousels).
- PostNitro (AI carousel maker): founder says MRR "stuck at $4K for 4 months" (undated) — [Indie Hackers](https://www.indiehackers.com/product/postnitro).
- LinkedSlide (carousel): Free / Pro $19/month; MRR not shown — [TrustMRR](https://trustmrr.com/startup/linkedslide). SlideFast: 6 active subscriptions, $256 30-day revenue — [TrustMRR](https://trustmrr.com/startup/slidefast).

**Tweet-to-image**
- TwitterShots reached $500 MRR (undated founder blog) — [TwitterShots](https://twittershots.com/blog/500-mrr). poet.so: no revenue found (Product Hunt 5.0 from 5 reviews) — [Product Hunt](https://www.producthunt.com/products/poet-so). A TrustMRR listing titled "Transforms tweets into images" shows $13K MRR / $80K 30-day revenue / $3.1M total, but the product is unnamed and the numbers look internally inconsistent; do not rely on it — [TrustMRR](https://trustmrr.com/startup/twitter-screenshot). TweetPik: not found.

**Code screenshots**
- Snappify: Free; Starter $5/month ($60/year); Professional $9/month ($108/year); Team tier — [Snappify pricing](https://snappify.com/pricing). Revenue: $1,000 MRR in Nov 2022 (founders, pre-2025) — [Indie Hackers](https://www.indiehackers.com/product/snappify); ~$3K/month (Starter Story, undated) — [Starter Story](https://www.starterstory.com/snappify-breakdown); Latka estimate $24K for 2023 — [Latka](https://getlatka.com/companies/snappify). Carbon and ray.so pricing: not found in this session (both are generally free tools; not verified).

**YouTube thumbnails**
- TrustMRR listings are tiny: VidCover $13 MRR, 1 subscription, ~$212 all-time; Thumblr ~$279 all-time; SuperPictureAI ~$32 all-time — [VidCover](https://trustmrr.com/startup/vidcover-ai-thumbnail-creator), [Thumblr](https://trustmrr.com/startup/thumblr), [SuperPictureAI](https://trustmrr.com/startup/superpictureai). Most are AI-image products, not template renderers.

**Favicon / app-icon generators**
- RealFaviconGenerator: ~256.67K visits in August (2025) per Semrush; revenue and business model not found; a paid API tier exists per a RapidAPI collection — [Semrush](https://cw.semrush.com/website/realfavicongenerator.net/overview), [RapidAPI](https://rapidapi.com/zh/collection/favicon).

### Inferences
- The strongest small-utility opportunity for linktocard's stack is the dynamic email image (countdown timer and "personalized image via URL params"): it is served from a URL on every email open, so it is metered by views, which fits signed-URL rendering and Workers edge caching; vendors charge watermark removal + view quotas + API access ($149/month at Sendtric).
- QR codes are proven at very large scale, but the money is in dynamic (redirecting, analytics) codes and subscription lock-in ("codes stop working when the plan expires"), which is a link-management product, not an image product. A static QR image endpoint is trivial and probably only worth offering as a template element.
- Carousel and beautifier tools reach $2K to $5K MRR as solo products; these are consumer/creator web apps sold on UX, not APIs. They could be built on Satori (one image per slide, PDF for LinkedIn documents), but they are a different go-to-market from linktocard's developer API.
- Tweet-to-image and thumbnail generators show weak verified revenue; low priority.

### Gaps
- Revenue for Sendtric, CountdownMail, MotionMail, NiftyImages, Hyperise, QR Tiger: not found (only customer-count claims).
- Carbon and ray.so pricing: not found in this session.
- Email banner generators and social-media image resizers: no paid product with pricing or revenue was found in the searches run.
- LinkedIn post-image / quote-image generators with revenue: not found.

## 5. What exactly is paid for, typical price points, and evidence of revenue or scale (cross-cutting)

### Takeaway
Across the space, customers pay for (a) monthly volume quotas with overage, (b) watermark removal and commercial-use rights on free tiers, (c) templates/editor seats, (d) no-code integrations, and (e) API access as a premium tier. Revenue proof exists at $10K to $80K MRR for solo or tiny teams in template APIs and screenshot APIs; the small utilities mostly sit at $0.5K to $5K MRR.

### Cited Findings
Price per 1,000 renders, calculated from the reported prices cited in sections 1 to 3 (same sources):

| Product | Entry plan | Entry $/1,000 | Volume $/1,000 |
|---|---|---|---|
| ScreenshotOne | $17 / 2,000 | $8.50 | $5.18 (50K) |
| Urlbox | $19 / 2,000 | $9.50 | $3.00 marginal (Business) |
| ApiFlash | $7 / 1,000 | $7.00 | $1.80 (100K) |
| ScreenshotAPI.net | $9 / 1,000 | $9.00 | $1.75 (100K) |
| Browshot (prepaid) | $10 / 1,000 | $10.00 | $3.33 (300K) |
| Microlink | $49 / 46,000 | $1.07 | not found |
| Bannerbear | $49 / 1,000 | $49.00 | $5.98 (50K) |
| Placid | $19 / 500 | $38.00 | $2.49 (100K) |
| Templated.io | $39 / 1,000 (monthly) | $39.00 | ~$7.16 (25K, annual) |
| Orshot | $30 / 3,000 | $10.00 | $1.20 (400K) |
| RenderForm | $14 / 250 | $56.00 | not found |
| iframely | $49 / 25,000 hits | $1.96 | $0.80 (500K) |
| OpenGraph.io | $25 / 50,000 credits | $0.50 | not found |

- What is paid for, by vendor: per-success billing (ScreenshotOne) — [ScreenshotOne pricing](https://screenshotone.com/pricing); watermark removal past view limits (Sendtric) — [Sendtric pricing](https://www.sendtric.com/pricing/); commercial-use licence and rate limits (LinkPreview.net) — [linkpreview.net](https://www.linkpreview.net); per-seat pricing (Abyssale, Hyperise) — [Abyssale](https://abyssale.com/pricing/), [Hyperise](https://hyperise.com/pricing); API as a premium tier (Sendtric API from $149/month) — [Sendtric API pricing](https://www.sendtric.com/api-pricing/); no-code integrations (Bannerbear ~60 direct integrations) — [Bannerbear integrations](https://www.bannerbear.com/v5/products/integrations/); white label / agency tiers (Hyperise $495 to $1.6K/month) — [Costbench](https://costbench.com/software/ai-sales-tools/hyperise/).
- Revenue/scale ladder (latest figure, date, source): Bannerbear ~$81K MRR (2026, unverified) — [Indie Maker List](https://indiemakerlist.com/p/jon-yongfook/); APITemplate.io + CraftMyPDF $75K MRR combined (undated) — [PRLog](https://www.prlog.org/13136222-apitemplateio-and-craftmypdf-surpass-75k-mrr-expand-integrations-for-automated-content-workflows.html) or $30K/month (Apr 2025) — [Starter Story](https://www.starterstory.com/businesses/apitemplate-io/revenue); ScreenshotOne $32K to $36K MRR, 1,000+ customers (2026) — [Superframeworks](https://superframeworks.com/case-study/screenshotone), [X](https://x.com/DmytroKrasun/status/2104570564006277204); Orshot $10.3K to $12.7K MRR (Oct to Nov 2026) — [Orshot](https://orshot.com/blog/orshot-10k-mrr), [TrustMRR](https://trustmrr.com/startup/orshot-com); Microlink ~$0.49M/year (2024 estimate) — [Latka](https://getlatka.com/companies/microlink); Urlbox 1,700+ customers (undated) — [Urlbox](https://urlbox.com/products/screenshot-api); aiCarousels ~$5K MRR (Nov 2023) — [Starter Story](https://www.starterstory.com/stories/aicarousels); PostNitro ~$4K MRR (undated) — [Indie Hackers](https://www.indiehackers.com/product/postnitro); Pika.style ~$3.8K/month (Apr 2024) — [Starter Story](https://starterstory.com/stories/pika); Snappify ~$3K/month (undated) — [Starter Story](https://www.starterstory.com/snappify-breakdown); TwitterShots $500 MRR (undated) — [TwitterShots](https://twittershots.com/blog/500-mrr).
- Acquisition-market valuation point: screenshot + PDF API listed at 3.7x TTM revenue ($71.9K TTM, asking $265K) — [Acquire.com](https://app.acquire.com/public/f5to5nqgj6-highly-profitable-pdf-generation-screenshot-api-saas).

### Inferences
- The highest-revenue businesses (Bannerbear, APITemplate.io, ScreenshotOne, Orshot) are all developer/no-code APIs with credits-per-month pricing, which is linktocard's existing model. The small consumer utilities earn an order of magnitude less.
- linktocard's prices should be benchmarked against Orshot ($10 per 1,000 entry, $1.20 at volume) and Placid/Bannerbear; Orshot shows that undercutting incumbents works in this niche.
- Paddle fit: all of these are global self-serve subscriptions with top-ups or overage, which Paddle supports; none needs a payment model Paddle cannot do (inference; Paddle capabilities not researched here).

### Gaps
- No public keyword search-volume data was found for any category (not found; none invented).
- Churn data exists only for ScreenshotOne (9% monthly revenue churn).
- Conversion rates from free to paid: only ScreenshotOne's 2023 landing-page conversion (6.32%) — [Indie Hackers](https://www.indiehackers.com/product/screenshotone-the-best-screenshot-api); not found for others.

## 6. Which can be produced without a headless browser (Satori-style SVG/PNG) vs which need a real browser

### Takeaway
Everything in the template-image, dynamic-email-image, QR, code-image, carousel, thumbnail and link-metadata categories can be produced without a browser; only screenshots of arbitrary URLs (and metadata from JavaScript-rendered pages) truly need one. linktocard's Satori+resvg engine already covers the highest-revenue category (template image APIs); Browser Run, which it already uses for PDFs, would cover screenshots at low marginal cost.

### Cited Findings
- Screenshot APIs render arbitrary web pages, HTML and Markdown in a browser and handle cookie banners, scrolling captures and video, i.e. real-browser work — [ScreenshotOne: what is a screenshot API](https://screenshotone.com/blog/what-is-a-screenshot-or-html-rendering-api), [ScreenshotOne scrolling screenshots](https://screenshotone.com/scrolling-screenshots/).
- Cloudflare's own browser product bills browser time ($0.09/hour after 10 included hours) and concurrency ($2 per extra concurrent browser), the main cost of the browser-needing category on linktocard's platform — [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/).
- Template image APIs bill a fixed credit per image regardless of browser use, and the leading vendors also offer PDFs (Placid 2 credits/page; Templated 1 credit/page) — [Placid credits](https://placid.app/help/how-do-placid-credits-work), [Templated pricing](https://templated.io/pricing.md).
- Countdown timers are per-recipient images regenerated on open; NiftyImages offers fixed, per-subscriber and evergreen timers — [NiftyImages timers](https://publicpreview.niftyimages.com/CountdownTimers).

### Inferences
Classification (engineering judgement, not sourced; based on Satori's known CSS subset (flexbox layout, no full browser CSS), which was not re-checked in this session):
- **No browser needed (Satori/resvg or plain code):** template images for social/OG/blog/YouTube/email banners (Bannerbear/Placid/Orshot-style); quote images; LinkedIn/Instagram carousels (one Satori render per slide, plus the existing PDF path for LinkedIn document posts); code screenshots (syntax highlighting to SVG via a tokenizer such as Shiki, then resvg); tweet-to-image (if tweet text/author come from an API or oEmbed, the render is a template); personalized email images (URL parameters into a template; linktocard's signed URLs already do this); QR codes (pure SVG generation); favicon/app-icon packs from an SVG (resvg at several sizes, plus ICO packaging); link metadata/unfurl (HTTP fetch + HTML parse, e.g. with Workers HTMLRewriter) for most pages.
- **No browser, but CPU-heavy on Workers:** animated countdown GIFs (one frame per second for up to 60 frames, then GIF encoding per request; needs aggressive caching per timer/minute); resizing user-uploaded raster images (needs a WASM image library or Cloudflare Images rather than Satori).
- **Needs a real browser:** screenshots of arbitrary URLs (full page, mobile emulation, cookie-banner removal, scrolling GIF/MP4); metadata/preview images for pages that render only with JavaScript; templates that need CSS outside Satori's subset (grid, complex filters), which linktocard already routes to Browser Run for PDFs.
- Strategic fit: the no-browser list is where linktocard's cost advantage is largest (no browser hours), and it overlaps with the categories that have the best revenue evidence (template image APIs at $10K to $80K MRR). Screenshots are a proven market too, but crowded and browser-cost bound.

### Gaps
- No measured per-screenshot Browser Run time; the cost per 1,000 in section 1 is an assumption-based estimate.
- Satori's current CSS support and Workers CPU limits for GIF encoding were not re-verified in this session.
