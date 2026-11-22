# Paddle seller onboarding and compliance: solo seller in Lebanon, HTML-to-image (Open Graph card) API

Research date: 2026-11-21. Scope: Paddle Billing (not Paddle Classic).

## 0. Read this first: how each fact was verified

`www.paddle.com` and `developer.paddle.com` could NOT be fetched from this container (WebFetch returned
`getaddrinfo ENOTFOUND` for both hosts; curl to them is blocked by the proxy). I did not try to bypass that.
Paddle's pages were therefore read only through the WebSearch tool, which opens the pages and returns excerpts.

Every fact below carries one of these tags:

- **[D] Directly read.** I downloaded the file and read the text myself (npm tarball or GitHub raw file). Exact.
- **[S] Search-surfaced.** Text returned by the WebSearch tool as an excerpt of the named Paddle page. The wording is
  very likely verbatim but I could not byte-compare it against the live page. Spot-check before pasting into legal copy.
- **[T] Third party.** Not a Paddle source. Used only as a pointer or anecdote.
- **[I] Inference.** My reasoning from the tagged facts. Not a Paddle statement.

To upgrade [S] items to verified, someone with a browser (or with `www.paddle.com` and `developer.paddle.com`
allowed in the session's network settings) should open the URLs in section 9.

Directly read sources:

- `@paddle/paddle-node-sdk@3.12.0` (npm; `npm view` reported `time.modified = 2026-11-12`), extracted to
  `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/dl/node-sdk/package/`
- `PaddleHQ/paddle-agent-skills` (GitHub raw, branch `main`, fetched 2026-11-21), saved to
  `/tmp/claude-0/-home-user-My-Coding-Projects/70f133a4-117f-556d-9972-d1c5365e2e92/scratchpad/dl/skills/`
  - https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/onboarding/SKILL.md
  - https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/pricing-pages/SKILL.md
  - https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/catalog-setup/SKILL.md

---

## 1. Is Lebanon supported? (go / no-go)

### Verdict

**Conditional GO. Lebanon is not on any Paddle unsupported-country list I could find, and Paddle accepts
individuals without a registered company. It is not a confirmed "yes" until a real Lebanese account passes
identity verification and a real payout lands.** No Paddle page says "Lebanon is supported for sellers" in those
words; the support is by absence from the exclusion list. The payout rail into Lebanon is the real risk, not the
sign-up rule.

### Evidence that Lebanon is not excluded

1. **[S] Help Center, "Which countries are supported by Paddle?"**
   https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle
   (same content at https://www.paddle.com/help/legal/sanctions)
   - Paddle works with software businesses "anywhere in the world with the exception of the unsupported countries listed below".
   - Paddle is "unable to support suppliers operating from the below countries" (this sentence is about SELLERS, tied
     to sanctions rules and the policies of its banking and payments partners).
   - The list is "subject to change".
   - Unsupported list as surfaced across several searches: Afghanistan, Antarctica, Belarus, Burma (Myanmar),
     Central African Republic, Cuba, Democratic Republic of Congo, Haiti, Iran, Iraq, Libya, Mali, Netherlands
     Antilles, Nicaragua, North Korea, Russia, Somalia, South Sudan, Sudan, Syria, Venezuela, Yemen, Zimbabwe, plus
     the Crimea, Donetsk, Kherson, Luhansk and Zaporizhzhia regions of Ukraine.
   - **Lebanon does not appear in it.** (I could not view the whole page myself, so this is "not in any excerpt
     returned across six searches", not "I read the full list".)

2. **[D] Paddle Node SDK 3.12.0**, file `dist/types/enums/shared/country-code-non-supported.d.ts`:

   ```ts
   export type CountryCodeNonSupported = 'AF' | 'AQ' | 'AN' | 'BY' | 'CD' | 'CF' | 'CU' | 'CS' | 'HT' | 'IR' | 'KP' | 'LY' | 'ML' | 'MM' | 'NI' | 'RU' | 'SO' | 'SS' | 'SD' | 'SY' | 'VE' | 'YE' | 'ZW';
   ```

   `'LB'` is in `CountryCodeSupported` (`dist/types/enums/shared/country-code-supported.d.ts`), not in the
   non-supported type. Caveat: this enum describes countries Paddle sells INTO (the API field is `allow_sales` in
   `dist/types/types/country/country-definition-response.d.ts`), not where sellers may be based. It corroborates
   the sanctions list; it is not a seller-country allowlist.

3. **[S] Developer docs, "Supported countries"**
   https://developer.paddle.com/concepts/sell/supported-countries-locales
   Table row surfaced as `Lebanon | LB | USD | Exclusive` (transaction currency USD, tax shown exclusive). Again
   this is the customer-country table.

4. **[T]** A third-party directory states Lebanon is on Paddle's supported seller list, "last checked October 30, 2026":
   https://getpaidatlas.com/provider/paddle (not verified by me).

Discrepancy to know about: the Help Center list includes **Iraq**, while the SDK lists `IQ` as supported. The two
Paddle lists are not identical, so treat the Help Center page as the seller-facing authority.

### Individuals / sole proprietors

- **[S] Business Identification**, https://www.paddle.com/help/start/account-verification/what-is-business-verification :
  "this step is not required for individuals or sole traders."
- **[S] Identity Verification**, https://www.paddle.com/help/start/account-verification/what-is-identity-verification :
  - "If you signed up as an individual, we'll ask you to verify your own identity."
  - "In many cases, we can verify your identity in the background using the information you've already provided. If we
    need more information, you'll be asked to upload a government-issued ID and a proof of address via our partner
    Sumsub. In some cases Sumsub will also ask you to complete a quick liveness check"
  - "Identity verification is typically instant. However, if your submission requires a manual review, our team aims to
    complete this within an estimated 1-3 business days."
- **[S] Account Verification**, https://www.paddle.com/help/start/account-verification/what-is-account-verification :
  "You can sign up for a Paddle account and start your setup immediately. Remember that you need to verify your
  account before you can start selling."
- **[D] SDK** `dist/types/enums/verification/verification-step-key.d.ts`:
  `'account_setup' | 'domain_review' | 'business_identification' | 'identity_verification' | 'final_review' | 'automated_review'`.
  So onboarding has up to six steps; `business_identification` is the one individuals skip.

### Payouts

Source for most of this: **[S] "When and how do I get paid?"**
https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid

| Topic | What Paddle says | Tag |
| --- | --- | --- |
| Methods | "You can receive your payment either via wire transfer or Payoneer." | [S] |
| PayPal payouts | Not listed as a payout method on the current help page. PayPal appears only as a BUYER payment method. Treat PayPal payouts as unavailable. | [S] |
| Other services | "If the money transfer service you're using provides you with these details, you can receive payouts from Paddle by updating the transfer preferences page with these details." (i.e. any service that gives you real bank details) | [S] |
| Schedule | "Sellers cannot withdraw their balance on demand since there is a monthly payout schedule." On the 1st the balance above your threshold becomes a payout; Paddle will "send your payment by the 15th"; "It can then take up to 3 working days before it arrives in your account." | [S] |
| Schedule (dev docs) | "Paddle initiates payouts on the 1st of each month. They're usually completed some time between the 2nd-15th of the month." https://developer.paddle.com/changelog/2023/webhooks-payouts/ | [S] |
| Minimum | "the minimum being $100 adjustable all the way to $100,000". "If your balance falls below the minimum threshold amount, this will be carried over onto the following month" | [S] |
| Paddle payout fee | Paddle "will not add any fees beyond the Paddle fee" on payouts. https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts | [S] |
| SWIFT fee | When the payout currency is not the local currency of the bank's country, the transfer goes by SWIFT with "a wire fee of $/€/£15", deducted before the payout invoice. MSA: "a charge of $15 will be payable by you for each international bank transfer (€15 if your Payment Currency is EUR or £15 if your Payment Currency is GBP)". Intermediary and receiving bank fees are the seller's. | [S] |
| Conversion | Paddle "reserves the right to charge a conversion margin of up to 1.5% if you opt for a payout currency different from your Balance Currency". | [S] |
| Payoneer fees | Depend on your Payoneer account type (Payoneer's fees, not Paddle's). | [S] |
| Payout currencies | AUD, GBP, CAD, CNY, CZK, DKK, EUR, HUF, PLN, ZAR, SEK, CHF, USD. https://www.paddle.com/help/manage/get-paid/can-i-be-paid-in-my-local-currency . No LBP. | [S] |
| Balance currencies | USD, EUR, GBP, AUD, CAD. | [S] |
| Changing method | Must be changed "at least one week before the end of the month". | [S] |
| Where to set | "Paddle > Business account > Payouts > Payout settings" (not readable via API). | [D] onboarding SKILL.md |
| Compliance holds | Paddle "may from time to time request further information before processing an order or releasing a payment from any location or jurisdiction for risk and compliance purposes". | [S] |

What this means for Lebanon **[I]**:

- A USD wire to a Lebanese bank is not a local-rail payout, so expect the **$15 SWIFT fee on every payout** plus
  correspondent and receiving-bank charges. With a $100 minimum that is a 15%+ haircut on a small month; raise the
  threshold so payouts are less frequent.
- Paddle names no Lebanon-specific payout restriction. It also names no guarantee. Whether a USD SWIFT wire from
  Paddle's bank actually arrives in a Lebanese "fresh dollar" account, and whether Payoneer works for a Lebanese
  resident, is outside Paddle's documentation. See Unverified.
- Lebanon was added to the FATF grey list in October 2024 **[T]**
  (https://www.aljazeera.com/news/2024/10/25/lebanon-added-to-money-laundering-grey-list ); I could not confirm its
  status in the 30 October 2026 FATF update. A regulated UK/EU payments firm typically applies enhanced due diligence
  to such jurisdictions, so expect the "request further information" clause above to be exercised **[I]**.

### Recommended go/no-go test before building billing

1. Create the live Paddle account as an individual with country = Lebanon and complete identity verification (free).
2. Ask Paddle support in writing: "Do you onboard individual sellers resident in Lebanon, and can you pay out by USD
   wire to a Lebanese bank or to Payoneer?" Keep the answer.
3. Confirm with your bank (and Payoneer, if used) that inbound USD from a UK payments company is accepted.

---

## 2. Website / domain verification before live checkout

### The gate

- **[S]** Go-live checklist, https://developer.paddle.com/build/go-live-checklist : "Checkout won't run on live until a
  domain is approved (sandbox approves automatically; live does not)."
- **[D]** onboarding SKILL.md: "Skip the live-only checks in sandbox: sandbox approves every domain automatically, and
  verification only applies to live accounts."
- **[D]** onboarding SKILL.md: setting the live default payment link before the domain is approved "fails with
  `checkout_url_domain_not_approved`", and `localhost` is rejected in live.
- **[D]** SDK `checkout-domain-status.d.ts`: `'pending_review' | 'approved' | 'rejected' | 'in_review' | 'action_required'`.
  **[S]** API docs: `action_required` is a soft decline you can fix and resubmit; `rejected` cannot be used for checkout.
- **[D]** onboarding SKILL.md: "If the verification has an `automated_review` step, it stays `pending` until a domain is
  approved, so submit domains first."

### What must be on the site

**[S] Help Center "Domain Review"**, https://www.paddle.com/help/start/account-verification/what-is-domain-verification :

1. A clear product or service description.
2. Pricing or a pricing page (a screenshot is acceptable if pricing is not live yet).
3. The key features or deliverables included.
4. "Terms and Conditions, Refund Policy, and Privacy Policy (these must be clearly accessible via navigation on your
   website)". (This exact sentence is also quoted verbatim by a third party in
   https://github.com/benni1984/hivepulse/issues/498 [T].)
5. "Include the company name or sole proprietor's brand (legal name preferred for sole proprietors) in the Terms &
   Conditions".
6. The site must be live and secured with an SSL certificate (HTTPS).

Also from the same page **[S]**:

- "This information may be spread across your main domain and subdomains but must be easy to locate."
- "You should submit each domain and subdomain you plan to launch a checkout from, but only one approved domain is
  required to move forward with verification."
- "Only submit domains that are directly related to the product you're selling via Paddle."
- "Paddle automatically approves most domain submissions. If your submission requires a manual review by our team, this
  is typically completed within an estimated 5-7 business days."
- "failing to include the required information may result in delays to your domain review".
- Common rejection reasons: product conflicts with the Acceptable Use Policy; domain flagged as high risk; no reply to
  Paddle's request for more information.
- Paddle may ask for extra documents: proof of product ownership (or a reseller agreement) and a processing statement
  from a previous payment processor. New businesses without one are taken into account.

**[D] Paddle's own agent skill** (onboarding SKILL.md, "Step 4: Hand off dashboard-only steps"), exact text:

> **Submit domains for website approval** (live) — **Paddle > My account > Settings > Website approval**. Before
> submitting, check that the site has public terms of service, privacy policy, and refund policy pages, prices that
> match the Paddle catalog, and a contact email or form reachable from the homepage, and that what it sells meets the
> [Paddle Acceptable Use Policy](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle).
> Track progress with `GET /checkout-domains`.

**[S] Go-live checklist** audit items (worded as prompts for an AI agent):

- "Publicly accessible terms of service, privacy policy, and refund policy pages"
- "Live, publicly accessible Terms & Conditions, Privacy Policy, and Refund/Cancellation Policy. List the URLs; flag any
  that 404 or redirect to a generic page."
- "Site pricing matches my live Paddle catalog. List discrepancies."
- "Contact details reachable from the homepage in two clicks or fewer."
- "Every domain where I run Checkout resolves and serves my real product (not parked, 404, or placeholder)."
- Paddle's own caveat: "These are common verification checks — confirm exact current requirements against Paddle's
  verification guidance rather than treating any item as definitively required."

**[S] Seller handbook**, https://www.paddle.com/seller-guides/seller-handbook : sellers must show their terms and
conditions, refund policy and buyer support details (email and phone number) clearly on the website, make sure the
buyer accepts the T&Cs and refund policy before purchase, and tell Paddle about changes to the refund policy, product
T&Cs or contact details. (Paraphrase of the search excerpt; the phone-number item is from the handbook only, not from
the Domain Review page.)

### How review is requested

- Dashboard only: **Paddle > My account > Settings > Website approval** **[D]**. The API can list domains
  (`GET /checkout-domains`) but cannot add one **[S]**.
- Full account verification is completed by an account administrator under **Paddle > Get started** **[D]**.
- Legal name, display name and website on the account can only be changed by Paddle support **[D]**.

### Stated wording requirements

Only two were found: the legal/brand name in the Terms (item 5) and the Merchant of Record paragraph (section 4).
No word counts, templates or mandatory headings were found on any Paddle page.

---

## 3. Refund policy requirements

### What Paddle's own documents say

- **[S] Paddle Refund Policy** (standalone document since 31 March 2026), https://www.paddle.com/legal/refund-policy :
  - "Unless required by applicable law, all Transactions are non-refundable and non-exchangeable."
  - "Paddle may, at its sole discretion, issue a refund if a request is submitted within 14 days of your Transaction
    date. Submission of a request within this 14‑day period does not guarantee a refund."
  - Consumers in the EU/EEA, UK, Switzerland (and per the excerpt Turkey and Israel) have a 14-day statutory withdrawal right.
  - "refunds will be processed using the same payment method where possible and within 14 days of approval of the request."
  - For a defective product: "contact the Supplier first to attempt to resolve the issue or request a refund".
- **[S] Master Services Agreement**, https://www.paddle.com/legal/terms :
  - "As the seller, Paddle shall be entitled to cancel a Transaction and grant the Buyer a refund of the full price
    paid" when the buyer asks "within fourteen (14) days of the date of a one-off Transaction" (or of the last
    subscription renewal) and Paddle decides a refund is appropriate (clause 10.2 per the excerpt).
  - The seller cannot refund directly: "you shall not issue any invoice or make any demand for payment to any Buyer in a
    Transaction". If you agree a refund you inform Paddle "of what it has agreed and Paddle will make the relevant refund".
  - Paddle may also refund on its own initiative where it "reasonably believes the Transaction was made in error or fraudulently".
- **[S] Seller handbook**: "Sellers are asked to have at least a 30-day money-back guarantee as part of their refund
  policy." and "Buyers must accept the terms and conditions and refund policy before they make a purchase." The search
  tool noted the 30-day item appears once under requirements and once under best practices, so its force is ambiguous.

### What I could NOT find on any Paddle page

- A sentence that sets a hard minimum refund window for the seller's own policy.
- A sentence that bans "all sales final" / "no refunds" in those words.

### Anecdotal reviewer behaviour [T]

- https://dev.to/pavelbuild/paddle-rejected-my-saas-3-times-heres-what-they-check-that-isnt-in-their-docs-5dnn reports
  reviewer feedback: "Refund policy contains qualifiers. Please provide unconditional refund terms matching our
  standard policy." Same post: the legal entity on the site had to match the entity on the Paddle account.
- Several sellers passed with "full refund within 14 days, no conditions" wording (GitHub PRs returned by search).

### Safe policy to write [I]

- State one clear window, no conditions or carve-outs. **14 days is the floor implied by Paddle's own policy; 30 days
  also satisfies the handbook.** Pick 30 if you want zero ambiguity.
- Never write "all sales final", "no refunds", or "refunds at our sole discretion only".
- Say that refunds are processed by Paddle as Merchant of Record to the original payment method.
- Do not promise to refund the buyer yourself (the MSA forbids it); you approve, Paddle pays.
- Keep a `/refund` page linked in the site navigation/footer, plus the same link next to the buy button.

### How buyers request a refund

- **[S] Refund Policy**: "submit a request via the support link provided in your receipt or within your account's
  billing page; or visit Paddle.net and select "Request refund"."
- **[S] Refund Policy**: "An online withdrawal button is available in the Paddle Customer Portal for eligible
  transactions during the 14-day withdrawal period. You can access the Customer Portal using the "Manage subscription"
  or "Manage transaction" link in your Transaction confirmation email or by visiting Paddle.net."
- **[S] FAQ for Paddle Buyers**, https://www.paddle.com/help/manage/your-customers/buyers-refunds : "You can get help
  with your subscription as well as request a refund via our Order Support team on paddle.net."
- **[S]** https://www.paddle.com/about/why-has-paddle-charged-me : "If you're eligible for a refund, you can request it
  through our virtual assistant on paddle.net."
- Sellers issue refunds from the dashboard or API (adjustments):
  https://developer.paddle.com/build/transactions/create-transaction-adjustments/

### Chargebacks (related cost) [S]

https://www.paddle.com/help/manage/risk-prevention/understanding-chargebacks-with-paddle : "Chargebacks incur a fee of
20 USD/GBP/EUR or 40 CAD/AUD"; "the chargeback fee is not refunded" even if the dispute is won; a card chargeback can
arrive up to 120 days after delivery. A generous refund policy is cheaper than chargebacks.

---

## 4. Merchant of Record disclosure and the URLs to link

### Paddle's recommended text [S]

Seller handbook, https://www.paddle.com/seller-guides/seller-handbook ("Add this text on their website T&Cs"):

> Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our
> orders. Paddle provides all customer service inquiries and handles returns.

The same three sentences are used verbatim by many Paddle sellers **[T]**, e.g. https://imazing.com/terms-and-conditions
and https://www.tinymediamanager.org/purchase/ . I found no Paddle page that says the wording must be exact.

Supporting statements:

- **[S]** MSA: "Paddle is the reseller of the Product. This structure allows Paddle to handle Sales Tax collection,
  reporting and remittance in connection with Transactions and payments under this Agreement."
- **[S]** Help Center: Paddle "acts as a reseller of your product, and is, therefore, the "seller on record"".
  https://www.paddle.com/help/start/intro-to-paddle/how-paddle-is-able-to-take-on-your-vat-and-tax-responsibilities
- **[S]** Procurement FAQ: the developer remains "the product's licensor". https://www.paddle.com/about/procurement
  So our /terms still governs the licence and use of the API; Paddle's Buyer Terms govern the purchase.

### URLs seller pages should link to

| Document | URL | Note |
| --- | --- | --- |
| Paddle Buyer Terms (current) | https://www.paddle.com/legal/buyer-terms | Unified document covering Paddle Checkout and Paddle Invoicing; changes effective 31 March 2026 [S] |
| Old Checkout Buyer Terms | https://www.paddle.com/legal/checkout-buyer-terms-2022 | Superseded. Do not link. `https://www.paddle.com/legal/checkout-buyer-terms` also appeared in results titled "Paddle Buyer Terms"; I could not confirm whether it redirects [S] |
| Paddle Privacy Notice | https://www.paddle.com/legal/privacy | "last updated on 16 March 2026" per search excerpt [S] |
| Paddle Refund Policy | https://www.paddle.com/legal/refund-policy | Standalone since 31 March 2026 [S] |
| Buyer support / refunds | https://paddle.net | Order lookup, cancel, refund request [S] |
| Change log for the above | https://www.paddle.com/legal/buyer-terms-privacy-notice-log-of-changes-31-03-2026 | [S] |
| Seller agreement (MSA) | https://www.paddle.com/legal/terms | Change log: https://www.paddle.com/legal/terms-log-of-changes-05-10-2026 (effective 6 October 2026) [S] |
| Acceptable Use Policy | https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle | This is the URL Paddle's own agent skill links to [D] |

The handbook also says the receipt email should carry links to your T&Cs, refund policy, buyer support and a way to
contact Paddle directly **[S]**; Paddle sends that email.

---

## 5. Acceptable Use Policy

Source: **[S]** "Understanding Paddle's Acceptable Use Policy (AUP): What Am I Not Allowed To Sell?"
https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle , shown as
"Last Updated" 13 April 2026 in the search excerpt. I could NOT obtain the full verbatim text; the category list
below is assembled from several excerpts and is partly paraphrased.

### AI / deepfake / face / likeness

- "Content generation" is listed among the prohibited categories, with these sub-items (paraphrased from excerpts):
  - Human-like faces in realistic, stylized or animated forms: marked **Restricted Category** (enhanced due diligence,
    not an outright ban).
  - Face swaps, deepfake images or videos, voice impersonations.
  - Content generation using a person's likeness without that person's explicit consent.
  - Automated decision-making or categorization of people.
  - Anything that falls under the other prohibited categories.
- "Due to the increased risk on certain offerings, Paddle must do enhanced due diligence on certain product offerings."
  If an offering is restricted, "Paddle's team will reach out to you for additional information if it is needed."
- The list "is not an exhaustive list as the software landscape is continuously changing".
- **[S]** Paddle blog, https://www.paddle.com/blog/how-paddle-helps-you-buy-and-sell-safely-online : Paddle has put
  "more rules in place around generative AI products and services", but "it's not to say we won't work with software
  that allows image generation".
- **[S]** Buyer Terms: buyers must not use the Services "(including any AI-enabled features)" in a way that "infringes
  any third party rights (including Intellectual Property Rights, privacy or publicity rights)".

### Is an HTML/CSS-to-image API acceptable?

**[I] Yes, as far as the retrieved policy text goes, with moderate confidence.** Reasons:

- It is deterministic rendering of customer-supplied HTML/CSS templates. No generative model, no face synthesis, no
  likeness generation. None of the "Content generation" sub-items apply.
- It is plain SaaS. Paddle's own skill defines the default `saas` tax category as "Products that allow users to connect
  to and use online or cloud-based applications over the Internet." **[D]** and `saas` needs no approval **[D]**.
- No excerpt names rendering, screenshot, image-conversion or developer-API tools as prohibited or restricted.

Paddle has not said this about our product specifically, and the MSA lets Paddle decide "in its sole discretion" that a
product falls outside the AUP **[S]**. Two wording traps on the marketing site **[I]**:

- **"Automated social media marketing"** (including services that boost likes, views, reviews) is prohibited. We say
  "social card images", so the copy must make clear this is image rendering for link previews, not posting,
  scheduling or engagement automation.
- Do not use "AI", "generate faces", "avatars of real people" or similar in marketing copy. State plainly: "no AI
  generation; renders your HTML/CSS templates to PNG".

### Prohibited / restricted categories found (for mirroring in our /terms)

From the AUP help page excerpts **[S]** (paraphrased unless in quotes):

- Physical goods and anything needing physical delivery. "Paddle is built for software companies. If your company's
  primary offering is human services (such as consultation, support, or design services) or the sale of physical
  goods, Paddle is not a good fit for your needs."
- "Human services that are not related to a software offering" (consulting, legal advice, coaching, IT services;
  donations/crowdfunding).
- IP infringement: "Any product or service that infringes upon, or enables the infringement upon copyrights,
  trademarks, terms and conditions, or trade secrets" (pirated streaming, IPTV, reselling without a reseller certificate).
- Unauthorized access to another party's data (spyware, keyloggers, device unlocking).
- Digital marketplaces for non-Paddle sellers.
- Marketing: advertising services, pyramid/MLM schemes, telemarketing, mass marketing, political or social
  campaigning, automated social media marketing and engagement boosting.
- Adult and age-restricted content, dating services.
- Gambling: betting, lotteries, sweepstakes, games of chance.
- Regulated financial products, trading and crypto platforms.
- Government services, certain exam-prep/certification services, travel services, pseudo-science (horoscopes),
  medical advice.
- Content generation items listed above (deepfakes, face swaps, voice impersonation, likeness without consent).
- Technical/system products: device cleaners, antivirus, performance/security "repair" software, captcha solving
  (prohibited); VPNs and proxies (restricted).
- Reseller products such as Microsoft or Adobe licences.
- General: anything that "Violates any law or government regulation" or "Involves fraudulent, deceptive, unfair,
  abusive, or predatory practices"; businesses that violate card network rules.

### Suggested acceptable-use clauses for our own /terms [I]

Customers must not use the API to render or distribute:

1. Content that is illegal or violates any law or regulation.
2. Content that infringes copyright, trademark, trade secret or other IP, or that impersonates a brand.
3. Images of a real person's likeness without their consent; deepfakes, face swaps or impersonation.
4. Fraudulent, deceptive, phishing or scam material (fake login cards, fake invoices, fake receipts).
5. Adult/sexually explicit content; content sexualising minors (zero tolerance).
6. Gambling promotion, unlicensed financial/trading/crypto promotion, pyramid or MLM schemes.
7. Malware delivery, spyware, or attempts to access data without authorisation (including using the renderer to
   fetch internal or third-party resources without permission).
8. Hate, harassment, threats or incitement to violence.
9. Spam or automated engagement manipulation.

Plus: we may suspend accounts that put our payment provider relationship at risk.

---

## 6. Fees and who pays tax

Accessed (via search) 2026-11-21.

- **[S] Pricing page**, https://www.paddle.com/pricing ("All-in-One Pricing, No Hidden Costs"): pay-as-you-go
  **5% + 50¢ per checkout transaction**; no monthly fee, no migration fee; covers payments, global tax and regulatory
  compliance, fraud protection, chargeback handling and buyer support. Custom pricing is offered for high-volume or
  low-priced products. (The search index dated this page oddly, so re-check the live number.)
- **[S] MSA**, https://www.paddle.com/legal/terms (version with changes effective 6 October 2026):
  - Paddle Discount for Paddle Checkout: "5% of SRP plus $0.50".
  - Invoiced payments by bank transfer: 3.5% of SRP.
  - Add-on: "Checkout Recovery: 10% of each checkout successfully recovered". Retain has separate terms.
  - The seller receives the selling price less Sales Tax, less the Paddle Discount, less other charges.
  - Clause 3.5 (per excerpt): Paddle may apply an alternative discount structure to particular transactions or sellers
    and communicate it through the dashboard, email or a separate document.
  - The October 2026 change log lists clarified sales-tax handling, supplier invoicing, definitions and group
    operations; no rate change was surfaced.
- **Who pays sales tax / VAT: Paddle**, as reseller and Merchant of Record **[S]**: "Paddle is the reseller of the
  Product. This structure allows Paddle to handle Sales Tax collection, reporting and remittance in connection with
  Transactions and payments under this Agreement." The seller's exposure: tax is computed from the product information
  the seller supplies, and the seller indemnifies Paddle if that information is inaccurate. So set the tax category
  correctly (`saas` for us **[D]**).
- Other costs already cited: $15 per international wire payout; up to 1.5% payout-currency conversion margin;
  chargeback fee 20 USD/GBP/EUR.

Worked example **[I]**, $9.00 plan, buyer in a no-tax location: fee = 5% x 9.00 + 0.50 = $0.95 (10.6%); net $8.05.
On a $19 plan: $1.45 (7.6%). The fixed 50 cents hurts low price points.

---

## 7. Pricing page vs catalog, tax display, free plans

### Pricing must match the catalog

- **[D]** onboarding SKILL.md: before submitting a domain, check the site has "prices that match the Paddle catalog".
- **[S]** Go-live checklist: "Site pricing matches my live Paddle catalog. List discrepancies."
- **[D]** pricing-pages SKILL.md, on why not to hardcode: "You _could_ hardcode "$10/month" in your UI, but comes with
  very strong regional pricing built-in ... Hardcoding works only for one market."
- **[D]** pricing-pages SKILL.md: "`PricePreview()` returns the price for the location you give it (or the visitor's IP
  address, if you don't), with currency, formatting, and applicable tax already calculated — no client-side math."
- **[D]** pricing-pages SKILL.md: "Checkout detects the customer's country itself, from their IP address — it doesn't
  reuse the country your page passed to `PricePreview`. Usually they agree, but if the page used a different country
  ... checkout can show a different currency or tax."
- **[D]** pricing-pages SKILL.md pitfall: "Doing your own math on raw amounts. This is not recommended. Paddle
  automatically handles calculations for you, including global tax compliance."

Practical rule **[I]**: either render prices with `Paddle.PricePreview()` so the page can never drift from the
catalog, or, if prices are static USD text, keep one USD price per plan in the catalog with no country overrides and
add a line such as "Prices in USD, excluding applicable taxes. Tax is calculated at checkout."

### Tax inclusive vs exclusive

- **[D]** SDK `dist/types/enums/shared/tax-mode.d.ts`: `'account_setting' | 'external' | 'internal' | 'location'`
  (`external` = exclusive of tax, `internal` = inclusive).
- **[D]** onboarding SKILL.md: account default is `default_tax_mode`: "`exclusive`, `inclusive`, or `location`.
  Applies to prices with `tax_mode: account_setting`." Dashboard: "Paddle > My account > Settings > Sales tax".
- **[D]** onboarding SKILL.md: "Don't make business decisions for the user. Tax mode, balance currency, and payment
  methods change what customers pay or how the user gets paid".
- **[S]** Changelog https://developer.paddle.com/changelog/2025/automatic-tax-inclusive-exclusive-prices/ : `location`
  shows prices inclusive or exclusive depending on the customer's country (US typically exclusive, EU typically
  inclusive). https://developer.paddle.com/changelog/2025/default-automatic-tax-setting/ : it can be the account default.
- **[S]** Go-live guidance: use the same sales-tax setting in live as in sandbox so prices display consistently.

Paddle does not mandate one mode. The requirement is consistency between what the page says and what checkout
charges **[I]**. With `exclusive`, a $9 plan costs an EU buyer $9 + VAT and we net on $9. With `inclusive`, the buyer
pays $9 and VAT comes out of our $9.

### Free plans

- **[S]** https://developer.paddle.com/changelog/2023/zero-dollar-subscription-emails/ : "You can create recurring
  prices for zero dollars." Paddle sends a single email for zero-value subscriptions and no receipt for the $0
  transaction; cancelling takes effect immediately.
- **[D]** catalog-setup SKILL.md covers free, paid and cardless trials, not permanent free tiers.
- I found **no Paddle statement** that a free plan must exist in the catalog, or any domain-review rule about free tiers.

Recommendation **[I]**: keep the free tier entirely outside Paddle (no checkout, no $0 price). Show it on the pricing
page as "Free". Only paid plans live in the catalog, and only those must match.

---

## 8. Build checklist derived from the above

Site (before requesting Website approval):

- [ ] Live on HTTPS at the real domain, real content, no placeholder.
- [ ] Home page: clear description of the product (API that renders Open Graph / social card images from HTML/CSS
      templates; "no AI generation") and its key features/deliverables.
- [ ] `/pricing`: every paid plan, price, billing period and limits, matching the live Paddle catalog; tax note.
- [ ] `/terms`, `/privacy`, `/refund` linked from the navigation or footer on every page.
- [ ] `/terms` names the seller: brand plus **legal personal name** (sole proprietor), and contains the three-sentence
      Paddle reseller / Merchant of Record paragraph.
- [ ] `/terms` has an acceptable-use section (section 5 list).
- [ ] `/refund`: unconditional, one window (14 days minimum, 30 safest), processed by Paddle, link to https://paddle.net .
- [ ] Contact email (or form) reachable from the home page in two clicks or fewer.
- [ ] Legal name on the site exactly matches the name on the Paddle account.
- [ ] Links to Paddle Buyer Terms and Paddle Privacy Notice near the buy button / in the terms.

Paddle account:

- [ ] Sign up as individual, country Lebanon; complete identity verification (Sumsub: government ID, proof of address,
      possibly liveness).
- [ ] Submit the domain at Paddle > My account > Settings > Website approval; wait for `approved`.
- [ ] Product tax category `saas`. Choose and record the sales-tax mode; mirror sandbox to live.
- [ ] Payout settings: USD balance, wire or Payoneer; raise the payout threshold to dilute the $15 SWIFT fee.

---

## 9. Unverified (could not confirm; treat as open)

1. **Full verbatim text of every Paddle page cited [S].** paddle.com and developer.paddle.com were unreachable for
   direct fetch. All [S] quotes need a human spot-check.
2. **That Paddle actually onboards an individual resident in Lebanon.** Supported only by absence from the exclusion
   list. No Paddle sentence names Lebanon as a supported seller country; no first-hand seller report found.
3. **That a payout can actually reach Lebanon**: whether Paddle's bank will wire USD to a Lebanese bank, whether the
   Lebanese bank credits it, and whether Payoneer is usable by a Lebanese resident. A third-party page
   (https://www.skydo.com/people-ask/does-payoneer-work-in-lebanon) claims Payoneer is unreliable in Lebanon; unverified.
4. **Whether Sumsub accepts Lebanese ID and proof-of-address documents** for Paddle's identity verification.
5. **Lebanon's FATF status as of 30 October 2026**, and whether Paddle applies enhanced due diligence to Lebanese sellers.
6. **A hard minimum refund window or an explicit ban on "all sales final"** in Paddle's rules. Not found on any
   Paddle page. The "no qualifiers" rule is third-party anecdote; the 30-day figure is from the handbook with
   ambiguous force.
7. **Whether the Merchant of Record paragraph must be used verbatim**, and whether the seller handbook is current
   (the page was undated in results).
8. **Whether sellers are required to link Paddle's Buyer Terms / Privacy Notice from their own site.** Not found as a
   requirement; recommended only.
9. **The complete, verbatim AUP list**, including any category that might touch screenshot, rendering or
   URL-fetching tools. Also the MSA cites an AUP URL (paddle.com/support/aup) that I did not see.
10. **Explicit Paddle confirmation that an HTML-to-image API is acceptable.** Inference only.
11. **Exact current text of paddle.com/pricing** (the "5% + 50¢" figure is corroborated by the MSA's "5% of SRP plus
    $0.50", but page wording, the low-price custom-pricing threshold, and whether the 5% is computed on the
    tax-inclusive or tax-exclusive amount were not confirmed).
12. **PayPal as a payout method.** Not on the current help page; not confirmed as removed.
13. **Whether `https://www.paddle.com/legal/checkout-buyer-terms` redirects to `/legal/buyer-terms`.**
14. **Payout minimum in non-USD balance currencies**, and whether the $100 minimum is still current.
15. **Any Paddle rule about showing a free plan** on the pricing page or in the catalog.

---

## 10. Source list

Paddle (search-surfaced, not directly fetched):

- https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle
- https://www.paddle.com/help/legal/sanctions
- https://www.paddle.com/help/start/account-verification/what-is-account-verification
- https://www.paddle.com/help/start/account-verification/what-is-business-verification
- https://www.paddle.com/help/start/account-verification/what-is-identity-verification
- https://www.paddle.com/help/start/account-verification/what-is-domain-verification
- https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle
- https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid
- https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts
- https://www.paddle.com/help/manage/get-paid/can-i-be-paid-in-my-local-currency
- https://www.paddle.com/help/manage/your-customers/buyers-refunds
- https://www.paddle.com/help/manage/risk-prevention/understanding-chargebacks-with-paddle
- https://www.paddle.com/seller-guides/seller-handbook
- https://www.paddle.com/pricing
- https://www.paddle.com/legal/terms and https://www.paddle.com/legal/terms-log-of-changes-05-10-2026
- https://www.paddle.com/legal/buyer-terms
- https://www.paddle.com/legal/privacy
- https://www.paddle.com/legal/refund-policy
- https://www.paddle.com/legal/buyer-terms-privacy-notice-log-of-changes-31-03-2026
- https://www.paddle.com/about/why-has-paddle-charged-me
- https://www.paddle.com/about/procurement
- https://www.paddle.com/blog/how-paddle-helps-you-buy-and-sell-safely-online
- https://developer.paddle.com/concepts/sell/supported-countries-locales
- https://developer.paddle.com/api-reference/countries/list-countries
- https://developer.paddle.com/build/go-live-checklist
- https://developer.paddle.com/build/onboarding/set-up-checklist
- https://developer.paddle.com/api-reference/checkout-domains/
- https://developer.paddle.com/changelog/2023/webhooks-payouts/
- https://developer.paddle.com/changelog/2023/zero-dollar-subscription-emails/
- https://developer.paddle.com/changelog/2025/automatic-tax-inclusive-exclusive-prices/
- https://developer.paddle.com/changelog/2025/default-automatic-tax-setting/
- https://developer.paddle.com/build/transactions/create-transaction-adjustments/

Paddle (directly read):

- npm `@paddle/paddle-node-sdk@3.12.0`: `dist/types/enums/shared/country-code-supported.d.ts`,
  `country-code-non-supported.d.ts`, `tax-mode.d.ts`, `tax-category.d.ts`;
  `dist/types/enums/checkout-domain/checkout-domain-status.d.ts`; `dist/types/enums/verification/*.d.ts`;
  `dist/types/types/country/country-definition-response.d.ts`
- https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/README.md
- https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/onboarding/SKILL.md
- https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/pricing-pages/SKILL.md
- https://raw.githubusercontent.com/PaddleHQ/paddle-agent-skills/main/skills/catalog-setup/SKILL.md

Third party (pointers only):

- https://getpaidatlas.com/provider/paddle
- https://dev.to/pavelbuild/paddle-rejected-my-saas-3-times-heres-what-they-check-that-isnt-in-their-docs-5dnn
- https://github.com/benni1984/hivepulse/issues/498
- https://imazing.com/terms-and-conditions
- https://www.skydo.com/people-ask/does-payoneer-work-in-lebanon
- https://www.aljazeera.com/news/2024/10/25/lebanon-added-to-money-laundering-grey-list
