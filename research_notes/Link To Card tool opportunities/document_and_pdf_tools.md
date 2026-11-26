# Paid document and PDF tools/APIs: market survey for linktocard.com

How these notes were gathered: all research was done on 2026-11-26. Direct fetches of vendor pages were blocked by this session's network allowlist. The blocked hosts were docraptor.com, pdfshift.io, pdfmonkey.io, apitemplate.io, craftmypdf.com and www.useanvil.com, and the GitHub API was also refused. Every figure below therefore comes from web-search results, which return a page URL with an extracted passage, and was read on 2026-11-26. Where a source states its own date (for example "Toolradar check, Oct 2026" or "Star History, 21 Aug 2026"), that date is given. Figures dated before 2025 are marked **[pre-2025]**. Many prices come from aggregators (Toolradar, Capterra, SaaSworthy, G2, SpotSaaS), and these often disagree with each other. Conflicts are recorded, not resolved. Check vendor pages directly before quoting any number publicly.

## 1. PDF generation APIs: pricing, metering, revenue and integrations

### Takeaway
HTML/template-to-PDF APIs are a crowded, commoditised market. Entry plans cost $9–$29/month for roughly 1,000–3,000 documents, so the marginal price is about $0.005–$0.03 per document. Most vendors meter "documents" or "credits", where one credit is roughly one document under a size cap. Revenue signals for indie players are modest: about $9K–$15K MRR per founder-run product, and one Acquire.com listing at about $71K ARR. Form filling and e-sign packets are priced 10–100x higher per document ($0.10–$1.50) than plain HTML-to-PDF.

### Cited Findings

**DocRaptor (Prince-based HTML to PDF)**
- Plans per Toolradar's pricing check (October 2026): Basic $15/mo for 125 docs, Professional $29 for 325, Premium $75 for 1,250, Max $149 for 5,000, Bronze $399 for 15,000, Silver $1,000 for 40,000. Free plan: 5 docs/month. A "Gold $2,250 / 100,000" tier appears in only one listing and is unconfirmed. — [Toolradar](https://toolradar.com/tools/docraptor/pricing); [fitgap](https://us.fitgap.com/products/docraptor)
- Overage: Capterra and Software Advice say all plans allow unlimited overage at the plan's per-document price. DocRaptor's help centre says Heroku plans do *not* include overage. Optional hosting of generated documents costs 1¢ per document per month. — [Capterra](https://www.capterra.com/p/94197/DocRaptor/); [DocRaptor help: how overage works](https://help.docraptor.com/en/articles/1273806-how-overage-works)
- Ownership: PitchBook says DocRaptor was acquired on 25 Aug 2025 by Artifex Software. CB Insights instead lists an "Acquired" round involving ePapyrus. No revenue or customer count was found (Latka: "we do not have information"). — [PitchBook](https://pitchbook.com/profiles/company/957372-04); [CB Insights](https://www.cbinsights.com/company/docraptor/financials); [Latka](https://getlatka.com/companies/docraptor.com)

**PDFShift (HTML to PDF, Chromium)**
- Aggregator figures, which conflict: Free 50 credits/mo; Startup $9/mo; Boost 2,500 credits at $24/mo ($20 billed yearly); Growth 5,000 credits at $39/mo ($32.50 billed yearly); Business $99/mo (credit allowance not found). — [Capterra](https://www.capterra.com/p/184246/PDFShift/pricing/); [SaaSworthy](https://www.saasworthy.com/product/pdfshift-io/pricing)
- Metering: PDFShift bills per credit, not per document, and large PDFs can use several credits. — [PDFShift help centre](https://help.pdfshift.io/how-does-pdfshift-counts-credits)
- Revenue: Superframeworks profile titled "PDFShift: $9K MRR", while its body text says $14K MRR, so the two conflict and neither is dated. The product launched on Indie Hackers in 2018 **[pre-2025]**. — [Superframeworks](https://superframeworks.com/blog/pdfshift); [Indie Hackers launch post](https://www.indiehackers.com/@cnicodeme/6c5eefcc1d)

**PDFMonkey (Liquid templates to PDF)**
- Official docs: Free 20 docs/mo with a 30 s generation limit (a tracker reports it was cut from 300 to 20 in 2026). Pro+ 5,000 docs/mo with a 3-min limit. Premium 60,000 docs/mo with a 5-min limit. Third-party listings: Starter €5/mo for 300 docs (added Feb 2025), Pro €15/mo for 3,000, Pro+ €60, Premium €300. — [PDFMonkey plan limits](https://pdfmonkey.io/docs/pricing-and-billing/our-plans/); [PDFMonkey Starter plan blog, 2025-02-24](https://pdfmonkey.io/blog/2025-02-24-starter-plan/); [agentdeals free-tier tracker](https://agentdeals.dev/vendor/pdfmonkey); [SaaSworthy](https://www.saasworthy.com/product/pdfmonkey-io/pricing)
- Overage: pay-as-you-go per document, or Boost Packs at €5 per 1,000 documents. Quota resets each billing cycle. — [PDFMonkey Boost Packs](https://pdfmonkey.io/docs/pricing-and-billing/boost-packs/); [PDFMonkey PAYG](https://pdfmonkey.io/docs/pricing-and-billing/pay-as-you-go/)
- Integrations: Zapier, Make, n8n, Workato, Bubble, Glide, plus Airtable via Zapier. — [PDFMonkey integrations docs](https://pdfmonkey.io/docs/integrations/); [Zapier PDFMonkey](https://zapier.com/apps/pdfmonkey/integrations)
- Revenue: not found.

**APITemplate.io and CraftMyPDF (same founder, Jacky Tan)**
- APITemplate: Free 50 PDFs/images per month with 3 templates (restructured April 2026). PDF Basic $19/mo (annual) for 3,000 PDFs and 20 templates. Higher tiers conflict ($24/3,000, $69/12,000, $89/12,000, $179/25,000). — [freetier.co](https://freetier.co/directory/products/apitemplateio); [agentdeals](https://agentdeals.dev/vendor/apitemplate-io); [apis.io](https://apis.io/plans/apitemplate/apitemplate-plans-pricing/)
- CraftMyPDF: free plan cut from 100 to 50 PDFs/images per month on 2026-04-12. Paid tiers conflict: Toolradar shows Lite $29/mo, while SaaSworthy shows $39 / $99 / $299 / $499. — [agentdeals](https://agentdeals.dev/vendor/craftmypdf); [Toolradar](https://toolradar.com/tools/craftmypdf/pricing); [SaaSworthy](https://www.saasworthy.com/product/craftmypdf/pricing)
- Revenue: Starter Story interview says the two products together make about **$15K MRR** and have generated more than 2 million documents and images (interview date not stated). An older Indie Hackers post had them at about $2K MRR combined. — [Starter Story](https://www.starterstory.com/stories/craftmypdf); [Indie Hackers](https://www.indiehackers.com/post/bootstrapping-2-micro-saas-products-in-10-months-and-crossed-2k-mrr-today-5ab2a847b8)
- Integrations: APITemplate lists Zapier, Make, n8n, Bubble and Airtable. CraftMyPDF's Zapier page shows Airtable, Bubble, Paperform, Shopify and Ninja Forms; Make and n8n were not confirmed. — [APITemplate integrations](https://apitemplate.io/docs/integrations/overview); [Zapier CraftMyPDF](https://zapier.com/apps/craftmypdfcom/integrations)

**Anvil (PDF filling, generation, e-sign, workflows)**
- Metered rates: **$0.10 per PDF fill or generation, $1.00 per Workflow submission, $1.50 per Etch e-sign packet**, charged only after included credits run out. Free tier: 500 PDF-fill API calls per month plus 2,500 PDF-generation credits. E-sign packets completed only through the Anvil dashboard are free. Platform plans start at $425/mo ($340/mo billed annually). — [Anvil pricing.md](https://www.useanvil.com/pricing.md); [Anvil homepage](https://useanvil.com/); [Anvil billing FAQ](https://www.useanvil.com/help/org-settings/billing-faq/); [Toolradar](https://toolradar.com/tools/anvil/pricing)

**DocSpring (PDF form filling)**
- Credit-based. A filled PDF form costs 20 credits; each signer adds 60 credits. Starter plan $49/mo for 10,000 credits, about 500 filled forms or **≈9.8¢ per filled form**. Trial: 200 credits. A batch endpoint takes up to 50 submissions per request, and US and EU endpoints are available. — [DocSpring FAQ](https://docspring.com/faq); [Capterra](https://www.capterra.com/p/203854/DocSpring/); [Toolradar](https://toolradar.com/tools/docspring)

**Carbone (DOCX/ODT templates to PDF)**
- Official: Free €0, Essential €29/mo (€26 billed annually), Advanced €159/mo (€149 billed annually), Fit €1,500/mo. Billed per document, not per page. Per-tier document caps were not captured. Capterra lists different tiers (Essential Plus €95, Advanced Ultra €595). — [carbone.io pricing.md](https://carbone.io/pricing.md); [Capterra](https://www.capterra.com/p/10002897/Carbone/pricing/)

**PDF Generator API (Actual Reports)**
- Metered in "merges", where merges = generation requests × unique datasets. Listings: $29/mo for 1,000 merges, Starter $59 for 2,500, Basic $99 for 10,000, Premium $399 for 100,000 (TrustRadius) or 50,000 (SpotSaaS). Enterprise $699 for 500,000 or custom. — [PDF Generator API support: merges](https://support.pdfgeneratorapi.com/en/article/what-are-merges-per-month-hadh6q/); [TrustRadius](https://www.trustradius.com/products/pdf-generator-api/pricing); [SpotSaaS](https://www.spotsaas.com/product/pdf-generator-api/pricing)

**Api2Pdf (wrapper over Chrome, wkhtmltopdf, LibreOffice)**
- $1/month base plus $0.001 per MB of bandwidth plus $0.00019551 per second of compute. No tiers and no per-conversion price. Vendor claims 1,000 PDFs cost $1.49 versus $30 on ConvertAPI. — [Api2Pdf pricing](https://api2pdf.com/pricing); [Api2Pdf FAQ](https://api2pdf.com/faq); [Api2Pdf vs ConvertAPI](https://www.api2pdf.com/ConvertApi-Alternative-Compare-ConvertApi-with-Api2Pdf-for-HTML-to-PDF-Conversion)
- Revenue: "Api2Pdf reportedly ~$10K/mo; PDFShift ~$7.2K/mo". This comes from a GitHub research-notes repo that marks its own data as unchecked, so it is unverified. — [GitHub alihucayn/miniature-octo-fiesta](https://github.com/alihucayn/miniature-octo-fiesta)

**Browserless (hosted headless Chrome)**
- Unit-based: 1 unit is up to 30 s of browser time. Free plan: 1k units/mo. Prototyping $25/mo (annual) for 20,000 units, Starter $140/mo (annual) for 180,000, Scale $350/mo (annual) for 500,000. Overage $0.0020 / $0.0017 / $0.0015 per unit. Other sources list $35 / $200 / $500, which are likely monthly-billed prices. — [Activepieces: Browserless pricing 2026](https://www.activepieces.com/blog/browserless-pricing-plans-and-overage-costs-2026); [Browserless unit consumption docs](https://docs.browserless.io/overview/unit-consumption)

**Gotenberg (open-source Docker PDF API)**
- No official hosted SaaS was found; only third-party hosting exists. xCloud VPS plans are $24.99 / $59.99 / $84.99 per month. A Railway deployment is estimated at about $10–20/mo with no per-document fees. Elest.io and Hostinger offer one-click installs (prices not captured). — [xCloud](https://xcloud.host/gotenberg-hosting/); [Railway](https://railway.com/deploy/gotenberg-pdf-api); [Elest.io](https://elest.io/open-source/gotenberg/resources/plans-and-pricing)
- Demand proxy: about **13.6k GitHub stars**, 919 forks and 78 contributors, with +505 stars in the 61 days to 19 Nov 2026 (Trendshift). Docker Hub shows "50M+" pulls on the org page, but the count is not tied to a named image. — [Trendshift](https://trendshift.io/repositories/2996); [Docker Hub gotenberg](https://hub.docker.com/u/gotenberg)

**Market-exit signals**
- Acquire.com listing f5to5nqgj6, "Highly profitable PDF Generation & Screenshot API SaaS": $70,798 ARR, TTM net profit $65,381, 91% net margin, no employees, German seller, asking $265k. The same listing ID was later retitled "$71K ARR, 138% Growth PDF & JavaScript SaaS for Make.com, n8n & Power Automate", asking $326.9k (5.0x profit, 4.5x revenue). It is one listing, not two. — [Acquire.com public valuation](https://app.acquire.com/public/f5to5nqgj6-highly-profitable-pdf-generation-screenshot-api-saas); [Acquire.com listing](https://app.acquire.com/startup/f5to5nqgj6-71k-arr-138-growth-pdf-javascript-saas-for-make-com-n8n-power-automate)
- Acquire.com says small SaaS businesses sold for a median 3.9x annual profit in 2024–2025. — [Acquire.com](https://acquire.com/saas-companies-for-sale/)
- A Flippa "turnkey PDF tools SaaS" (22 browser-side tools plus a premium domain) was marked sold with about $5/mo profit. — [Flippa 12940289](https://flippa.com/fr/12940289-turnkey-pdf-tools-saas-where-files-never-leave-the-browser-22-tools-premium-pdfdig-com-domain-near-zero-hosting-costs-ready-to-launch)

**Linktocard's own cost base (Cloudflare Browser Run)**
- Quick Actions (the pdf and screenshot endpoints) are billed on browser hours only. Workers Free includes 10 min/day; Workers Paid includes 10 h/month, then **$0.09 per browser hour**. Requests that fail with waitForTimeout are not charged. — [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/); [Cloudflare changelog 2025-07-28](https://developers.cloudflare.com/changelog/2025-07-28-br-pricing/)

### Inferences
- Rough cost per document if a PDF uses about 2 s of browser time: 1 browser hour ≈ 1,800 PDFs, so about $0.00005 per PDF beyond the free 10 h. That is two orders of magnitude below competitors' entry-plan per-document prices of $0.006 (APITemplate $19/3,000) to $0.12 (DocRaptor $15/125). Margin is not the constraint; distribution is. (This uses an assumed render time; check it against linktocard's measured browser_ms.)
- Every leading competitor lists Zapier, Make, n8n, Bubble and Airtable. For no-code buyers these integrations are table stakes, not differentiators.
- The two founder-reported figures (APITemplate+CraftMyPDF about $15K MRR; PDFShift $9K–$14K MRR) and the Acquire listing (about $71K ARR) suggest a solo PDF API realistically reaches about $100K–$200K ARR after several years. Free tiers were cut sharply in 2026 (PDFMonkey 300→20, CraftMyPDF 100→50), which may indicate free-tier abuse or cost pressure across the category.
- Per-document price rises steeply with the job: HTML-to-PDF costs about $0.005–$0.03, PDF form fill about $0.10 (Anvil, DocSpring), a signed document about $0.20 (DocuSeal), and an e-sign packet $1.50 (Anvil). The higher-priced jobs (form fill, sign) need no headless browser at all.

### Gaps
- Exact current vendor pricing pages could not be fetched, so all tier figures are aggregator or search-extracted and several conflict (CraftMyPDF, APITemplate mid tiers, PDFShift Business allowance, PDF Generator API Premium).
- Customer counts and revenue: not found for DocRaptor, PDFMonkey, DocSpring, Anvil, Carbone, PDF Generator API or Browserless.
- No official Gotenberg SaaS exists, and no hosted-Gotenberg revenue was found.

## 2. Paid workflows adjacent to PDF generation (form fill, manipulation, e-sign, mail merge, certificates, invoicing)

### Takeaway
The adjacent jobs people demonstrably pay for are:
- **Filling existing PDF forms** (Anvil, DocSpring at about $0.10 per fill).
- **PDF manipulation APIs** (merge, split, compress; metered per page or file by PDF.co and iLoveAPI).
- **Lightweight e-sign** (DocuSeal $0.20/doc; Documenso 340 paying customers).
- **Spreadsheet-to-PDF mail merge** (Documint $30–$150/mo; Mergram $19/1,000 PDFs).
- **Certificate issuing with verification pages**, priced per recipient per year (Certifier, Sertifier, Accredible with about 2,300 customers).

Freelancer invoicing is dominated by cheap or free tools that cap invoice counts ($0–$22/mo).

### Cited Findings

**PDF form filling and manipulation APIs**
- Anvil: $0.10 per fill; 500 free fill API calls per month. DocSpring: 20 credits per filled form (≈9.8¢ on Starter). See Q1. — [Anvil](https://www.useanvil.com/pricing.md); [DocSpring FAQ](https://docspring.com/faq)
- PDF.co credit costs: merge 2 credits/page, split by page numbers 2 credits/page, compress 35 credits/page, merge2 or split2 (mixed formats or text search) 35. — [PDF.co credits per API function](https://developer.pdf.co/api/credits-per-api-function.md)
- iLoveAPI (iLovePDF's developer API) bills credits per file, page or task. Per FitGap: Compress PDF 10 credits per file, Merge PDF 5 credits per task, and 2,500 free credits per month on registration. Dollar per-credit prices are not shown statically. — [iLoveAPI pricing](https://iloveapi.com/pricing); [FitGap iLoveAPI](https://us.fitgap.com/products/040645/iloveapi)
- CloudConvert: 25 free conversion minutes. Paid tiers conflict ($8 for 1,000 minutes vs $9 for 500 minutes). ConvertAPI plans are tiered by conversions (1k / 5k / 15k / 50k / 100k+). — [CloudConvert pricing](https://cloudconvert.com/pricing); [Capterra CloudConvert](https://www.capterra.com/p/157495/CloudConvert/pricing/); [ConvertAPI prices](https://www.convertapi.com/prices)
- Stirling-PDF (open-source PDF toolkit): **about 90k GitHub stars** on 21 Aug 2026 (global rank #153), up from 79,865 on 31 May 2026 and 75,609 in March 2026. Monetisation: free self-hosted up to 5 users; Enterprise from $12/user/mo (aimed at 250+ users, LDAP/SCIM); separate Stirling Cloud with credits and a Team tier. — [Star History](https://www.star-history.com/stirling-tools/stirling-pdf); [Gitpedia](https://gitpedia.pages.dev/wiki/Stirling-Tools/Stirling-PDF); [stirlingpdf.com pricing](https://stirlingpdf.com/pricing); [stirling.com pricing](https://www.stirling.com/pricing)

**Lightweight e-signature**
- DocuSeal: API and embedding cost **$0.20 per signed document** on Pro, and production API keys need at least one $20/month Pro seat. The free sandbox is unlimited. The same per-document fee applies to self-hosted Pro. — [DocuSeal pricing](https://www.docuseal.com/pricing); [DocuSeal signing API](https://www.docuseal.com/signing-api)
- DocuSeal is bootstrapped (three co-founders). Prospeo's revenue estimate of $171,110/yr is a low-reliability aggregator figure. About 18.2k GitHub stars (Star History, 1 Aug 2026), AGPL-3.0. — [DocuSeal blog: why we are bootstrapping](https://www.docuseal.com/blog/why-we-are-bootstrapping-an-open-source-docusign-alternative); [Prospeo](https://prospeo.io/c/docuseal-open-source-document-signing-revenue); [Star History DocuSeal](https://www.star-history.com/docusealco/docuseal)
- Documenso: Free 5 documents/month (up to 10 recipients); Individual $25/mo ($300/yr); Platform $250/mo flat; Enterprise custom; self-hosted AGPL. — [DEV: Documenso pricing teardown 2026](https://dev.to/beton/documenso-pricing-teardown-2026-3ic6); [Toolradar](https://toolradar.com/tools/documenso/pricing)
- Documenso traction: **crossed 340 paying customers in 2025** and reached about 400k signed documents by year-end 2025. Pre-seed $1.25M (total $1.54M). In 2024 it reported 15% MoM MRR growth **[pre-2025]**. About 13.7k GitHub stars (DEV.co, updated 2026-07-08). — [Documenso 2025 year in review](https://documenso.com/blog/2025-a-year-in-review); [Documenso pre-seed](https://documenso.com/blog/pre-seed); [Documenso 2024 review](https://documenso.com/blog/2024-review); [DEV.co](https://dev.co/devops/open-source/documenso)
- OpenSign: cloud Free (unlimited envelopes and guest signers, completion certificates), Professional $9.99/mo, Teams $19.99/user/mo, Enterprise custom. Self-hosted is free, but the free self-hosted version lacks API tokens. — [Gappsy](https://gappsy.com/tools/opensign/); [Verdocs OpenSign pricing](https://verdocs.com/blog/opensign-pricing); [SpotSaaS](https://www.spotsaas.com/product/opensign/pricing)
- Anvil Etch: $1.50 per API-sent signature packet; packets sent from the dashboard are free. — [Anvil billing FAQ](https://www.useanvil.com/help/org-settings/billing-faq/)
- Incumbent anchor: DocuSign Standard and Business Pro monthly plans allow up to 10 envelopes per user per month. — [DocuSign UK products & pricing](https://docusign.com/en-gb/products-and-pricing)

**Spreadsheet/CSV to PDF (mail merge)**
- Autocrat (Google Workspace add-on) merges sheet rows into PDFs or Docs and can email them. It requests full Drive access. — [Google Workspace Marketplace: Autocrat](https://workspace.google.com/marketplace/app/autocrat/539341275670)
- Documint: free plan with 10+ documents, then $0.20 per extra merge. Silver $30/mo (200+ docs), Gold $80 (800+), Platinum $150 (3,000+). Other listings show $49 / $149 / $299. Paid tiers include Airtable Automation. — [Capterra Documint](https://www.capterra.com/p/215492/Documint/pricing/); [GetApp](https://www.getapp.com/all-software/a/documint/)
- Mergram: Starter $19/mo for 1,000 PDF generations. — [Capterra Mergram](https://www.capterra.com/p/10040116/Mergram/)
- Airtable community thread asking for a PDF-invoice automation at more than 5k documents/month (May 2022) **[pre-2025]**. — [Airtable community](https://community.airtable.com/t5/other-questions/create-pdf-invoice-with-airtable-search-for-automation-for-more/m-p/121419)
- PDF Generator API meters "merges" as requests × datasets, which makes it a mail-merge model. — [PDF Generator API support](https://support.pdfgeneratorapi.com/en/article/what-are-merges-per-month-hadh6q/)
- Portant pricing: not found.

**Certificate issuing platforms**
- Certifier: free Individual plan for up to 250 credentials/year. Professional is $89/mo billed monthly, or $76/mo billed annually, for 1,000 credentials/year (per Certifier's blog). G2 lists Professional $67 for 1,000 and Advanced $339 for 3,000. API included on all plans per Certifier; white-label verification domain reportedly a $50/mo add-on (third-party). Certifier claims "2000+ organizations"; Trustpilot says "over 1,000". — [Certifier support: plans](https://support.certifier.io/en/articles/10806136-guide-to-certifier-plans); [Certifier blog](https://certifier.io/blog/affordable-digital-credentials); [G2 Certifier](https://www.g2.com/products/certifier/pricing); [Certifier customers](https://certifier.io/customers)
- Sertifier: $30/mo for 50 annual recipients with unlimited certificates and badges; annual plans get 2 months free; Advanced Support add-on $100/mo. Credentials stay valid after cancellation. Capterra says more than 8 million credentials issued. — [Sertifier pricing](https://info.sertifier.com/pricing); [Capterra Sertifier](https://www.capterra.com/p/229583/Sertifier/pricing/)
- Accredible: **42M+ credentials issued in 2025**, 170M+ in total; 36M in 2024, up 45% year on year. More than 2,300 customers (TIME EdTech 2025 listing). Series B led by Frontier Growth, Sep 2023 **[pre-2025]**, amount undisclosed (CB Insights: $15.74M; total $26.54M). Republic page cites $9.3M ARR (undated). — [Accredible 2025 year in review](https://www.accredible.com/blog/accredibles-2025-year-in-review); [Accredible 2024 year in review](https://www.accredible.com/blog/accredibles-2024-year-in-review); [Accredible TIME 2025](https://www.accredible.com/newsroom/time-names-accredible-to-worlds-top-edtech-companies-2025-list); [Accredible Series B](https://www.accredible.com/newsroom/accredible-secures-series-b-funding-led-by-frontier-growth); [CB Insights](https://www.cbinsights.com/company/accredible/financials); [Republic](https://republic.co/accredible)
- Certopus: G2 lists Free (250 credentials), Standard from $29.99/mo and Professional from $74.99/mo. SpotSaaS ties tiers to 250, 1,250 and 2,500 certificates. Other listings show $12.49–$39.99 entry prices. — [G2 Certopus](https://www.g2.com/products/certopus/pricing); [SpotSaaS](https://www.spotsaas.com/product/certopus/pricing); [TrustRadius](https://www.trustradius.com/products/certopus/pricing)
- Customer counts for Certopus and Sertifier: not found.

**Invoice and quote tools for freelancers**
- Invoice-Generator.com: Capterra says it is "trusted by over 4 million freelancers, contractors, and small businesses". Its API has one endpoint that returns a PDF from invoice JSON, stores no data, and uses a key from a free account. API quota and price: not found. — [Capterra Invoice Generator](https://www.capterra.com/p/10021234/Invoice-Generator/); [Invoice-Generator.com developers](https://invoice-generator.com/developers?locale=it)
- Invoice Simple: Essentials $6.99/mo (up to 3 invoices/month), Plus $14.99 (10 per month), Premium $21.99 (unlimited invoices, client signatures, deposits, premium templates), per Software Advice. Revenue and users: not found. — [Software Advice](https://www.softwareadvice.com/accounting/invoice-simple-profile/); [Invoice Simple pricing packages](https://www.invoicesimple.com/pricing-packages)
- Invoice Ninja: Free plan for up to 5 clients with unlimited invoicing. Enterprise $18/mo (1–2 users) up to $300/mo (51–100 users). Pro $140/yr. Open source and self-hostable. — [Invoice Ninja pricing](https://invoiceninja.com/pricing-plans/)
- Zoho Invoice free plan: 2 users, 500 invoices/year, 3 projects (checked Oct 2026 by one source). Other sources say unlimited invoices or 1,000 per year; Zoho changes limits yearly. — [SaaS CRM Review](https://saascrmreview.com/?p=17167); [Rework](https://resources.rework.com/tools/erp-finance/best-zoho-invoice-alternatives)
- Bonsai: no free plan, a 7-day trial (as of Nov 2026), $15–$59 per user per month; invoicing is not on the entry tier per one review. — [Costbench Bonsai vs Zoho Invoice](https://costbench.com/compare/bonsai-vs-zoho-invoice/); [Capterra Bonsai](https://www.capterra.com/p/238825/Bonsai/pricing/)
- Free-tier caps elsewhere: Invoicely 5 invoices/month; Bookipi 3/month. — [Invoicely pricing](https://invoicely.com/pricing); [Bookipi help](https://intercom.help/bookipi/en/articles/12087803-why-am-i-being-asked-to-upgrade-my-bookipi-plan-when-using-the-free-version)

### Inferences
- **PDF form filling** has the best price-to-compute ratio here: buyers pay about $0.10 per fill, and filling AcroForm fields needs no browser (see Q4). Anvil and DocSpring sell mainly to developers automating forms they already have. Many real-world fillable PDFs are government or tax forms, which sits close to the owner's "no government document templates" rule. A "fill your own uploaded form" API is a different thing from a template library, but the policy line should be drawn explicitly.
- **Certificates:** certificate platforms charge per recipient per year mainly for hosting, verification pages and delivery, not for the PDF itself (Sertifier: $30/mo for 50 recipients). Linktocard already has a certificate generator. The paid upsell is "CSV upload → bulk PDFs → emailed → public verification URL/QR". This matches the paid feature set and also reduces fraud risk (Q5).
- **Mail merge:** Documint's $0.20 per extra merge and Mergram's $19 for 1,000 PDFs show spreadsheet users pay 4–40x HTML-API rates for a no-code "sheet → PDFs" flow.
- **E-signature** is proven but crowded with well-starred open-source players (DocuSeal 18.2k stars, Documenso 13.7k, OpenSign). Documenso's 340 paying customers after about 2.5 years suggests slow conversion. A narrow "accept/sign this quote" step on linktocard's own quote template fits better than a general e-sign product.
- **Invoices:** the freelancer invoice market is saturated and price-anchored near free (Zoho, Invoice Ninja). The paid lever is caps on invoice counts, not PDF quality. The invoice generator works better as a funnel than as a product.

### Gaps
- Exact iLoveAPI and PDF.co dollar prices per credit; Portant pricing; Invoice-Generator.com API quota and pricing.
- Revenue figures for Certifier, Sertifier, Certopus, Invoice Simple and DocuSeal (only a low-quality estimate was found).
- G2 and Capterra review counts were not captured for most vendors.

## 3. Consumer PDF utility sites: traffic, revenue, free vs paid, top tools

### Takeaway
Consumer PDF utilities draw very large traffic:
- iLovePDF: about 200–260M visits a month.
- Smallpdf: about 35M visits a month on Semrush, against 13M monthly users in 2017.
- Sejda: about 17–19M visits a month.
- PDF24: about 15M visits a month.

They monetise with $5–$15/month subscriptions plus ads. Free tiers are capped by daily or hourly task limits and file size. Revenue figures are all third-party estimates (Smallpdf about $8–17M a year; iLovePDF estimates range widely). The highest-traffic tool pages are JPG-to-PDF, merge PDF, PDF-to-Word and compress PDF.

### Cited Findings

**iLovePDF**
- Traffic: Similarweb via ReviewBolt gives 216.8M visits (Dec 2025), 221.2M (Nov 2025) and 230.3M (Oct 2025). HypeStat cites 260.5M a month (Similarweb). LettersByDavey's headline says "188M visitors monthly". — [ReviewBolt](https://reviewbolt.com/r/ilovepdf.com); [HypeStat](https://hypestat.com/info/ilovepdf.com); [LettersByDavey](https://lettersbydavey.com/p/ilovepdf-seo-growth-story); [Similarweb ilovepdf vs smallpdf](https://www.similarweb.com/website/ilovepdf.com/vs/smallpdf.com/)
- Scale: an OVHcloud case study (June 2020) **[pre-2025]** calls iLovePDF "one of the 250 most visited websites globally". — [OVHcloud case study](https://www.ovhcloud.com/sites/default/files/casestudy/casestudy-ilovepdf-ovhcloud-en-062020.pdf)
- Revenue estimates, all unverified and wildly divergent: "$80K/month" (MarketingCrafted headline), "$1.4M–$5M annual" (ScaleMode headline), $1.8M as of Aug 2025 (Techlist), and ad-based calculators at $35.6M and $174M a year. The claim that 80–90% of revenue comes from subscriptions appeared in search extracts of these case studies, but could not be pinned to a single page. — [MarketingCrafted](https://marketingcrafted.com/case-studies/ilovepdf); [ScaleMode](https://scalemode.substack.com/p/how-a-bootstrapped-saas-quietly-reached); [Techlist](https://techlist.ai/ilovepdf.com); [WebsiteWorthTraffic](https://www.websiteworthtraffic.com/report/ilovepdf.com)
- Pricing: Basic free (limited processing); Premium $5/mo billed annually ($60/yr) or $9 billed monthly. The free tier limits file size, daily tasks, OCR and batch processing (Capterra summary). — [iLovePDF pricing](https://www.ilovepdf.com/pricing); [Capterra iLovePDF](https://www.capterra.com/p/173963/ilovepdf/)
- **Top pages by estimated organic traffic (Semdash, Jan 2026): JPG to PDF first, then Merge PDF, PDF to Word, Compress PDF.** Organic traffic about 127.5M. "compress pdf" keyword cluster about 1.83M monthly searches. — [Semdash ilovepdf.com](https://seo.semdash.com/website-overview/ilovepdf.com)
- SEO pattern: one page per high-intent keyword, and each tool links to its reverse tool (PDF to JPG ↔ JPG to PDF). — [LettersByDavey](https://lettersbydavey.com/p/ilovepdf-seo-growth-story); [Medium: rise of iLovePDF](https://medium.com/the-investors-handbook/the-most-underrated-case-study-the-rise-of-ilovepdf-926e369e355b)

**Smallpdf**
- Revenue estimates: $8.3M (Latka, July 2025, 75 employees); $11M (Growjo, 76 employees); about $17.5M by 2024 (Jia Wei Ng blog, no source given). — [Latka](https://getlatka.com/companies/smallpdf.com); [Growjo](https://growjo.com/company/Smallpdf); [Jia Wei Ng](https://jiaweing.com/blog/pdf-gold-mine)
- Users: "13 million people use Smallpdf every month", and subscription income had overtaken ads (Nov 2017) **[pre-2025]**. Company-reported 1.7B lifetime users and 40M+ current users (via Grokipedia). — [EU-Startups 2017](https://www.eu-startups.com/2017/11/zurich-based-startup-smallpdf-operates-one-of-the-900-most-visited-websites-worldwide/); [Grokipedia](https://grokipedia.com/page/Smallpdf.com)
- Traffic: Semrush about 35.18M visits in its latest month (month not clearly stated). ReviewBolt: 36.9M a month (March 2026 review). — [Semrush smallpdf.com](https://www.semrush.com/website/smallpdf.com/overview/); [ReviewBolt](https://reviewbolt.com/r/smallpdf.com)
- Acquired PDF Tools AG (Swiss) in 2022 for $30M cash **[pre-2025]** (secondary source). — [Grokipedia](https://grokipedia.com/page/Smallpdf.com)
- Pricing: Pro $12/mo billed annually with 2 free tasks/day (CodaOne comparison); Capterra lists Pro $15 and Teams $12/user/mo. Smallpdf's official page says only that Free has a "daily download limit". — [CodaOne](https://www.codaone.ai/compare/ilovepdf-vs-smallpdf); [Capterra Smallpdf](https://www.capterra.com/p/172606/Smallpdf/pricing/); [Smallpdf pricing](https://smallpdf.com/business/pricing)

**Sejda**
- Pricing: **Web Week Pass $5 one-off for 7 days (no auto-renew)**; Web Monthly $7.50/mo; Desktop+Web Annual $63/yr. Paid plans have no page or hourly limits, up to 500MB per file and up to 21 minutes of processing per task. Free plan has page, hourly, file and tool-specific limits (numbers not published; Capterra reviewers say 3 tasks/day). — [Sejda pricing](https://www.sejda.com/pricing); [Capterra Sejda](https://www.capterra.com/p/164130/Sejda-PDF/)
- Traffic: Semrush 17.12M visits (Aug 2025) and 18.98M (Jan 2026, unverified layout). Similarweb global rank #3,024 (May 2026), with smallpdf.com as top competitor. — [Semrush sejda.com](https://tr.semrush.com/website/sejda.com/overview); [Similarweb sejda.com competitors](https://www.similarweb.com/website/sejda.com/competitors)

**PDF24 (Geek Software GmbH, Berlin, founded 2006)**
- Free tools, likely ad-supported (third-party inference, not a company statement). Semrush 14.94M visits in "April" (year not stated); Ahrefs about 16.1M organic visits (July 2025). — [PDF24 about](https://pdf24.org/about); [Zoftwarehub](https://zoftwarehub.com/en-ae/products/pdf24-tools/product-details); [Semrush pdf24.org](https://sv.semrush.com/website/pdf24.org/overview); [Ahrefs pdf24.org](https://ahrefs.com/websites/pdf24.org)

**Adobe Acrobat online tools**
- Free use: one free transaction per rolling 30 days for premium tools (some pages: one transaction without sign-in). Files up to 100MB, or 200MB for PDF-to-Word and PDF-to-PPT. Unlimited and batch use need a paid plan. Adobe claims "over 8M files uploaded" over 18–24 months. Traffic: not found. — [Adobe FAQ: free online PDF](https://helpx.adobe.com/document-cloud/faq/free-online-pdf.html); [Adobe convert PDF](https://www.adobe.com/acrobat/online/convert-pdf.html?%24web_only=true)

### Inferences
- The largest single consumer tool, JPG/image → PDF, is technically trivial: pdf-lib can embed a JPG or PNG inside a Worker with no browser. Merge PDF is equally trivial. PDF-to-Word and Compress are the hard ones (Q4). A free "image to PDF" and "merge PDF" page is cheap SEO bait that fits linktocard's free-tools funnel. Outranking iLovePDF (127.5M organic visits) is unrealistic, but long-tail variants (for example "merge invoices into one PDF" or "combine certificates") could link into paid generation.
- Consumer subscriptions anchor at $5–$15/month, and Sejda's $5 one-off Week Pass shows that one-off passes sell for occasional jobs. That fits Paddle top-ups better than subscriptions.
- The Flippa sale (22 tools, about $5/mo profit) shows a PDF-utility site without traffic is nearly worthless. The value of iLovePDF and Smallpdf is traffic and brand built over about a decade.

### Gaps
- No first-party revenue for iLovePDF, Smallpdf, Sejda or PDF24. All figures are estimates.
- No verified per-tool traffic split for Smallpdf, Sejda, PDF24 or Adobe; only the Semdash ranking for iLovePDF.
- Similarweb's own 2026 visit numbers are behind a login. Semrush and Similarweb methods differ and should not be compared directly.
- Keyword volumes for "merge pdf", "pdf to word" and "jpg to pdf" were not found, apart from the 1.83M "compress pdf" cluster.

## 4. Feasibility on Cloudflare Workers + Browser Run vs. needing native tools

### Takeaway
Most paid adjacent features can run in a plain Worker with pure-JS libraries such as pdf-lib, with no browser and near-zero marginal cost:
- AcroForm fill and flatten
- merge, split, reorder and rotate
- text or image watermark and stamping
- image-to-PDF

Password encryption needs a pdf-lib fork or a helper library. PDF-to-image is possible through Browser Run (pdf.js plus screenshot) at about 1–3 s per page. Real compression (image downsampling), Office ↔ PDF and OCR need native tools: Ghostscript, MuPDF, LibreOffice or Tesseract. Those would run in Cloudflare Containers (GA 13 April 2026), at the cost of AGPL licensing and extra complexity.

### Cited Findings

**Platform limits and costs**
- Workers: 128 MB memory on Free and Paid (Error 1102 when exceeded). CPU time up to 5 min on Paid (default 30 s; 10 ms on Free). Script size 3 MB (Free) and 10 MB (Paid) compressed; another page says 64 MB uncompressed. — [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits)
- WASM in Workers must be pre-compiled and imported as a module binding; dynamic compilation is not allowed. — [modern-pdf-lib troubleshooting](https://abcrimson.github.io/modern-pdf-lib/guide/troubleshooting)
- Browser Run: $0.09 per browser hour after 10 h per month on Workers Paid; Quick Actions billed by browser hours. — [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)
- Cloudflare Containers and Sandboxes went GA on 13 Apr 2026. CPU has been billed on active usage since Nov 2025. Workers Paid includes 375 vCPU-minutes/month, then $0.000020 per vCPU-second. Memory and disk are billed on provisioned size. Egress in NA and EU is $0.025/GB after 1 TB. — [Cloudflare changelog: Containers GA](https://developers.cloudflare.com/changelog/2026-04-13-containers-sandbox-ga); [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/); [CPU pricing change 2025-11-21](https://developers.cloudflare.com/changelog/2025-11-21-new-cpu-pricing/)

**pdf-lib (pure JS)**
- Features: create and modify PDFs, fill and flatten forms, embed images. It "does not support creation, modification, or reading of XFA fields"; check `form.hasXFA()` first. — [pdf-lib PDFForm.d.ts](https://app.unpkg.com/pdf-lib@1.17.1/files/cjs/api/form/PDFForm.d.ts); [npm pdf-lib](https://npmjs.com/pdf-lib)
- Maintenance: Snyk rates it "Inactive", with no npm release in 12 months. About 7.5k–8.5k stars. Snyk's older snapshot shows 927,825 weekly downloads. — [Snyk advisor](https://snyk.io/advisor/npm-package/pdf-lib); [npm-compare](https://npm-compare.com/pdf-lib)
- Encryption: upstream pdf-lib cannot encrypt (open PR #917). Forks add it: @cantoo/pdf-lib, and @maxwbh/pdf-lib (encrypt, decrypt, and incremental save that preserves signatures). @pdfsmaller/pdf-encrypt-lite targets edge runtimes such as Workers but uses RC4 128-bit. — [freeCodeCamp](https://www.freecodecamp.org/news/build-pdf-password-protector-javascript/); [@cantoo/pdf-lib README](https://unpkg.com/@cantoo/pdf-lib@2.4.1/README.md); [Maxwbh/pdf-lib](https://github.com/Maxwbh/pdf-lib); [socket.dev pdf-encrypt-lite](https://socket.dev/npm/package/@pdfsmaller/pdf-encrypt-lite)
- modern-pdf-lib (an alternative library) lists Cloudflare Workers as a supported runtime, opens password-protected files and has `deleteXFA()`. — [modern-pdf-lib](https://cdn.jsdelivr.net/npm/modern-pdf-lib@0.26.0/README.md); [modern-pdf-lib PdfForm](https://abcrimson.github.io/modern-pdf-lib/api/classes/PdfForm)

**Compression**
- Real size reduction comes from image downsampling. Ghostscript `-dPDFSETTINGS` presets (/screen about 72 DPI, /ebook 150, print 300) and MuPDF-based optimisers do this. qpdf is a structural optimiser; its lossy Node wrapper is a native addon, not WASM. Ghostscript and MuPDF are AGPL or commercially licensed. Ghostscript-WASM exists but is slow on large files. — [Ghostscript blog](https://ghostscript.com/blog/optimizing-pdfs.html); [mattdesl/pdf-optimizer](https://github.com/mattdesl/pdf-optimizer); [qpdf-compress README](https://cdn.jsdelivr.net/npm/qpdf-compress@0.6.3/README.md); [DEV: Ghostscript in a browser tab](https://dev.to/pranav_mailarpawar_7039f2/i-ran-ghostscript-inside-a-browser-tab-to-build-a-free-pdf-compressor-2hd9)

**PDF to image**
- unpdf ships a serverless pdf.js build for Workers, but page rendering needs a canvas backend (@napi-rs/canvas is native). A documented Workers pattern launches Browser Rendering, draws the page with pdf.js on a canvas and screenshots it, taking about 1–3 s per page on a cold browser versus about 200 ms in Node. @hyzyla/pdfium (WASM) exports PNG in Node; Workers support is unverified. — [unpdf README](https://cdn.jsdelivr.net/npm/unpdf@1.6.2/README.md); [PDF page rendering doc](https://admin-docs-ai5.pages.dev/projects/pdf-converter/pdf-page-rendering); [@hyzyla/pdfium](https://www.npmjs.com/package/@hyzyla/pdfium)

**Digital (cryptographic) signatures**
- @signpdf/signpdf with node-forge produces PAdES-style signatures (SubFilter ETSI.CAdES.detached) and needs a placeholder, which can be added with the placeholder-pdf-lib helper. It is designed for Node; Workers compatibility (nodejs_compat, Buffer, crypto) is unverified. — [npm @signpdf/signpdf](https://npmjs.com/package/@signpdf/signpdf); [GitHub vbuch/node-signpdf](https://github.com/vbuch/node-signpdf)

### Inferences (feasibility matrix)
| Feature | Paid by whom / price signal | Worker (pure JS) | Browser Run | Needs native (Containers) |
|---|---|---|---|---|
| HTML/template → PDF | DocRaptor, PDFShift, APITemplate, etc. ($0.005–$0.12/doc) | – | Yes (already built) | – |
| Fill AcroForm PDF + flatten | Anvil $0.10/fill, DocSpring ≈$0.098 | Yes (pdf-lib); no XFA | – | XFA only |
| Merge / split / reorder / rotate / extract | PDF.co 2 credits/page; iLoveAPI merge 5 credits/task | Yes (pdf-lib; 128 MB memory caps file size) | – | – |
| Watermark / stamp / page numbers / "PAID" or "DRAFT" overlay | CraftMyPDF-type plan features; consumer tools | Yes (pdf-lib) | Or bake into HTML | – |
| Image (JPG/PNG) → PDF | iLovePDF's top page | Yes (pdf-lib embedJpg/embedPng) | – | – |
| Password protect | Consumer premium feature | Yes with a fork (@cantoo or @maxwbh) or helper (RC4 only in pdf-encrypt-lite; prefer AES) | – | qpdf if AES-256 required |
| PDF → PNG/JPG thumbnail | Consumer tools; linktocard OG cards of PDFs | Unverified (PDFium WASM) | Yes (pdf.js + screenshot, about 1–3 s/page) | – |
| Compress (image downsampling) | iLovePDF top-4 page; PDF.co 35 credits/page | Structural only (object streams) | – | Ghostscript or MuPDF (AGPL) |
| PDF ↔ Word/Office | iLovePDF top-3 page | No | No | LibreOffice |
| OCR | iLovePDF premium | No | No | Tesseract or OCR API |
| Simple e-sign (draw/type signature + audit trail + hash) | DocuSeal $0.20/doc, Anvil $1.50/packet | Yes (pdf-lib stamping + D1 audit log + R2 storage) | Optional for certificate-of-completion page | – |
| PAdES cryptographic signature | Advanced/qualified e-sign tiers | Unverified (@signpdf + node-forge under nodejs_compat) | – | – |
| CSV/Sheet → bulk PDFs (mail merge) | Documint $0.20/merge; Mergram $19/1,000 | Orchestration via Queues | Yes (one render per row) | – |

- The cheapest wins to build first are the features that need no browser and no native code: form fill, merge, watermark, image-to-PDF and password protection. Their per-document cost is just Worker CPU, while buyers pay up to $0.10 a document for form fill.
- Compression, PDF-to-Word and OCR would bring in Containers and AGPL code (Ghostscript, MuPDF), which is a poor fit for a one-person product whose code may need to stay proprietary.

### Gaps
- No primary test of pdf-lib or its forks on very large PDFs inside a 128 MB Worker; no verified PDFium-WASM or @signpdf run on Workers.
- Container cold-start and per-job cost for LibreOffice or Ghostscript were not measured.

## 5. Legal and abuse risks by product type

### Takeaway
- **Receipts** carry the highest abuse risk. AI-generated fake receipts became a measurable share of expense fraud in 2025–2026.
- **Invoices** come next, because business email compromise (BEC) losses are about $3B a year and fake invoices are its common vector.
- **Certificates** are vulnerable unless issuer verification is built in.
- **Simple e-signatures** are legally admissible in the US (ESIGN/UETA) and the EU (eIDAS Article 25(1)). Only qualified signatures get handwritten-equivalence, and wills and some UCC matters are excluded in the US.
- **Generic PDF utilities** mostly carry privacy and data-retention risk, not fraud risk.

### Cited Findings

**Receipts and expense fraud**
- AppZen: AI-generated fakes were about 14% of fraudulent documents in Sep 2025, versus 0% in 2024 (FT, via TechRadar and Computerworld). Accounting Today later reports AppZen's AI share of flagged receipts reached 70.8% by mid-May 2026; its timeline is internally inconsistent. — [TechRadar](https://www.techradar.com/pro/security/workers-are-scamming-their-employers-using-ai-generated-fake-expense-receipts); [Computerworld](https://computerworld.com/article/4079701/new-ai-scam-fake-expense-receipts.html); [Accounting Today](https://www.accountingtoday.com/news/use-of-ai-receipts-in-expense-fraud-soars)
- SAP Concur detects 18x more suspected AI receipts since launching its checker, and tells customers "do not trust your eyes". An Emburse survey of 2,000 US and UK workers found 34% admit using AI to fake a receipt. — [Skift, 2025-11-26](https://skift.com/2025/11/26/business-travel-faces-a-deluge-of-ai-generated-expense-fraud/); [Entrepreneur](https://www.entrepreneur.com/business-news/tech/how-ai-generated-receipt-fraud-can-affect-private-and-public-institutions)
- ICAEW (Nov 2025): metadata scanning helps but metadata "can be removed". — [ICAEW](https://www.icaew.com/insights/viewpoints-on-the-news/2025/nov-2025/expenses-fraud-how-to-spot-an-ai-generated-receipt); [Schneier](https://www.schneier.com/blog/archives/2025/11/faking-receipts-with-ai.html)

**Invoices and BEC**
- FBI IC3 2025 report, via a secondary source: $3.05B of reported BEC losses across 24,768 complaints, up from about $2.77B. Kroll says the true impact is likely higher. — [Keepnet Labs](https://keepnetlabs.com/blog/invoice-fraud); [Kroll](https://www.kroll.com/en/publications/cyber/industrialized-fraud-hidden-in-plain-sight)
- Microsoft (10 Sep 2026) on AI-assisted executive-impersonation invoice fraud. KnowBe4 reports a criminal group selling an AI tool that crafts fraudulent invoices for BEC (undated). — [Microsoft Security blog](https://microsoft.com/en-us/security/blog/2026/09/10/protecting-organizations-ai-assisted-executive-impersonation-invoice-fraud); [KnowBe4](https://blog.knowbe4.com/expose-gxc-team-architect-cybercrime)

**Certificates**
- Fake diplomas are described as a "billion dollar industry" (UTS paper). Most detection happens after issuance. Recommended mitigations are unique IDs, digital signatures, issuer verification and W3C verifiable credentials, which are mostly vendor claims. — [UTS paper](https://opus.lib.uts.edu.au/bitstream/10453/195162/2/From%20Black%20Box%20to%20Transparent%20Gate%20Explainable%20AI%20for%20Certificate%20Integrity.pdf); [TRUE guide](https://www.trueoriginal.com/insights/certificate-fraud-prevention-guide); [Dock](https://www.dock.io/post/certificate-fraud)

**E-signature legal validity**
- US: ESIGN (2000, federal) and UETA (state level) say a signature or record cannot be denied effect solely because it is electronic. ESIGN excludes wills, codicils and UCC-governed contracts. New York uses its own statute instead of UETA. — [Adobe: US e-signature regulations](https://helpx.adobe.com/es/legal/esignatures/regulations/united-states.html); [DocuSign ESIGN & UETA](https://docusign.com/esign-act-and-ueta); [Purdue Global Law School](https://www.purduegloballawschool.edu/blog/news/e-signatures-legal-requirements)
- EU: eIDAS Art. 25(1) says an electronic signature "shall not be denied legal effect and admissibility as evidence… solely on the grounds that it is in an electronic form or that it does not meet the requirements for qualified electronic signatures". Art. 25(2) gives qualified signatures the same effect as handwritten ones. Member States decide the effect of non-qualified signatures. Advanced signatures must be uniquely linked to the signer and make tampering detectable. In Scots law, simple and advanced signatures are not self-proving. — [legislation.gov.uk eIDAS Art. 25](https://www.legislation.gov.uk/eur/2014/910/article/25/data.html); [Adobe EU regulations](https://helpx.adobe.com/legal/esignatures/regulations/european-union.html); [Adobe Scotland](https://helpx.adobe.com/ee/sign/using/legality-scotland.html)

### Inferences (risk by candidate product)
- **Receipt templates:** highest abuse risk, given the AI fake-receipt surge. If kept, mitigations could include:
  - no merchant or brand logos and no real merchant names;
  - visible "generated with linktocard" footer text and metadata on free tiers;
  - only signed-in, paid generation for receipts;
  - rate limits.
- **Invoice and quote generator or API:** moderate risk, because it is a legitimate mass-market need (Invoice-Generator.com claims 4M+ users), but BEC uses fake vendor invoices. Mitigations: no impersonation of third-party company branding, abuse reporting, and payment details tied to the account owner.
- **Certificate bulk issuing:** risk falls sharply if each certificate carries a unique ID and a public verification URL or QR on linktocard.com. This is also the feature the paid platforms charge for. Keep the existing ban on diplomas of real institutions.
- **Simple e-sign / quote acceptance:** legally usable for ordinary commercial agreements in the US and EU. Do not market it for wills, real-estate deeds or anything else that needs a qualified e-signature (QES). Capture an audit trail (IP, timestamp, email confirmation and a document hash), which is what gives simple signatures evidential weight.
- **Form-filling API:** the main abuse concern is policy, not fraud. Many target forms are government or tax forms. Allowing users to fill their own uploaded PDFs is different from shipping government templates, but the owner should decide explicitly. "Remove a password you don't know" (unlock or crack) is a copyright and DRM-circumvention risk and should be excluded.
- **Generic utilities (merge, compress, convert):** low fraud risk. The main exposure is GDPR and privacy for uploaded files, so state retention clearly (for example, delete from R2 after N hours).

### Gaps
- The FBI IC3 2025 report itself was not read; the $3.05B figure is secondary.
- No case law was found specifically on liability of template or generator sites for fake receipts or invoices.
- Paddle's acceptable-use stance on receipt and invoice generators was not checked.
