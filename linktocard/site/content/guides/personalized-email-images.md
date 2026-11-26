---
title: "Personalized email images: put each reader's name in the picture"
description: How to make an email header image that greets every reader by name, with one signed image URL and your email platform's merge tag, plus what to test before the first send and what a campaign costs.
layout: page
feature: email
---

Your email platform already puts each reader's first name into the text of an email. If it lets you put a merge tag into an image's URL too, it can personalize an image. With [[site.name]], that URL is a signed card URL with an **open field**: the platform fills in the name when it sends, and the image says "Hi Maya," to Maya and "Hi Sam," to Sam. One image is rendered per distinct name, then served from storage to everyone with that name.

We could not open the email platforms' help pages while writing this guide. The merge tags in the [table below](#merge-tags-by-platform) come from documentation and code that each platform publishes itself on GitHub; platforms we could not check that way are not listed. Whatever your platform, send yourself a test before the first campaign.

## What you need

- A [[site.name]] account with a site (**Sites & URLs** in the dashboard), and its site id and signing secret from there. The [[plan.free.name]] plan works; its images carry a small `[[site.host]]` mark in one corner.
- A place to run a few lines of code that sign the URL, such as Node.js on your computer or server. The dashboard's URL builder does not make URLs with open fields.
- An email platform with merge tags (some call them personalization tags) and an email in which you can set an image's URL, or edit its HTML.
- A template. This guide uses the `email-banner` starter template: a greeting with the reader's name, a short message and a button-shaped label, at [[size.email.width]] x [[size.email.height]] pixels.

## 1. Make the image URL with an open field

Sign a URL for the `email-banner` template with your site's secret, as [Signed URLs](/docs/signed-urls#signer-code) describes, with these parameters:

- what is the same for every reader: `title` (the message), `greeting` (for example `Hi`), `cta` (the label), and if you like `site`, `tag` and a logo in `image`;
- `size=email`;
- `open=name`, which makes `name` an open field, and `name_default` with a default such as `there`. The default is what readers without a usable name see: "Hi there,".

Leave `name` itself out of what you sign, then append `&name=` to the signed URL. [Email images](/docs/email-images#a-worked-example) has the code for Node.js. The URL ends with `&name=`, with nothing after the `=`:

```text
[[site.url]]/v1/og/s_4k2j9x0q1m7c8d5e/email-banner.png?title=Your+spring+picks+are+ready&greeting=Hi&cta=See+the+edit&name_default=there&size=email&open=name&sig=1a3fcc944787e7c85170817cf7b71438d9e7dd1fa7df3b775c7545e041fadcf9&name=
```

(This one is the worked example of the docs, signed with an example secret. Yours has your own site id and signature.) [Email images](/docs/email-images#sign-a-url-with-open-fields) has the exact rules. Sign on your computer or server, never in a web page: the secret must stay private.

Do not change anything before `&name=`. Everything before it is signed, so an edit there breaks the image.

## 2. Put your platform's merge tag after name=

Paste the URL somewhere you can edit it, and add the merge tag for the first name after `name=`:

```text
...&sig=1a3fcc944787e7c85170817cf7b71438d9e7dd1fa7df3b775c7545e041fadcf9&name=YOUR_MERGE_TAG
```

Replace `YOUR_MERGE_TAG` with your platform's tag, exactly as it writes it in text. If the platform has a form of the tag that URL-encodes the value, use that form: a name with `&` in it, such as "Tom & Jerry", breaks the image when the `&` is not encoded. The [table below](#merge-tags-by-platform) shows both forms where we found them.

## 3. Add the image to the email

Put the URL into the image's source. In HTML, show it at half its width so it stays sharp on high-density screens, with alt text, and wrap it in a link if the label should be clickable:

```html
<a href="https://example.com/spring">
  <img src="YOUR_IMAGE_URL" width="600" alt="Your spring picks are ready" style="display: block; max-width: 100%; height: auto; border: 0;">
</a>
```

In HTML source, each `&` of the URL may be written `&amp;`; mail apps read it back as `&`. Keep the message in the email's text as well, for readers whose mail app does not load images.

## 4. Send a test

Send a test to yourself, and to a test contact whose first name has an accent and an `&`, for example `Zoë & Jo`. Then check:

- **The image shows the name.** It works.
- **The image shows the default ("Hi there,").** The tag was not filled in, or the value was not usable. Check that the tag is spelled as your platform writes it, and the [value rules](/docs/email-images#what-a-value-may-contain): at most [[email.maxValueChars]] characters of letters, digits, spaces and basic punctuation; emoji and some scripts fall back to the default.
- **The image is broken.** The URL was changed before `&name=`, or a value with an unencoded `&` split the URL. Use the URL-encoding form of the tag if your platform has one. If it has none, a name with an `&` may break the image.

## 5. Before you send to your list

Each distinct name is rendered once, takes one image from your monthly allowance and is then served from storage, so a send costs at most one image per distinct name, not one per reader. [Caching and what counts](/docs/email-images#caching-and-what-counts) has the details.

Each site also has a daily limit of new personalized images: [[email.dailyFree]] on [[plan.free.name]], [[email.dailyStarter]] on [[plan.starter.name]] and [[email.dailyPro]] on [[plan.pro.name]], per UTC day. Some mail apps load images after the email arrives, whether or not it is read (Apple says this of Mail Privacy Protection), so plan for every distinct name of a send to be rendered, not only those of readers who open it. Readers whose name is new after the limit is reached see the default image ("Hi there,") instead, not a broken one. If your list has more distinct names than the limit, send it in parts on different days. [The daily limit per site](/docs/email-images#the-daily-limit-per-site) explains why it exists.

<!-- Source: Apple, WWDC21 session 10085 "Apple's privacy pillars in focus", transcript: "Mail content may be loaded automatically after delivery", https://developer.apple.com/videos/play/wwdc2021/10085/ (read 2026-11-26). -->

## Merge tags by platform

These are the tags for a reader's name that each platform shows in its own documentation or code. A dash means the sources we read show no URL-encoding form: send the `Zoë & Jo` test before you rely on it.

| Platform | Name tag | URL-encoding form |
| --- | --- | --- |
| Mailchimp (campaigns) | `*\|FNAME\|*` | - <!-- source: https://github.com/mailchimp/fern-marketing-api-docs/blob/HEAD/fern/docs/pages/concepts/audiences/merge-fields.mdx (read 2026-11-26) --> |
| Mailchimp Transactional | `*\|FNAME\|*` | `*\|URL:FNAME\|*` <!-- source: https://github.com/mailchimp/fern-marketing-api-docs/blob/HEAD/fern/docs/pages/transactional/documentation/templates-dynamic-content.mdx (content-encoding merge tags, read 2026-11-26); https://github.com/mailchimp/fern-marketing-api-docs/blob/HEAD/fern/docs/pages/transactional/documentation/outbound-email.mdx (merge tag inside an image src) --> |
| HubSpot (coded email modules) | `{{ contact.firstname }}` | `{{ contact.firstname\|urlencode }}` <!-- source: https://github.com/HubSpot/jinjava/blob/HEAD/src/main/java/com/hubspot/jinjava/lib/tag/RawTag.java (first-name token); https://github.com/HubSpot/jinjava/blob/HEAD/src/main/java/com/hubspot/jinjava/lib/filter/UrlEncodeFilter.java (urlencode); https://github.com/HubSpot/Sample-Programmable-Email-Module-Code/blob/HEAD/samples/travel-example.html (a template value inside an email image src); read 2026-11-26 --> |
| Brevo | `{{ contact.FIRSTNAME }}` | - <!-- source: https://github.com/getbrevo/brevo-skills/blob/HEAD/skills/email-template-write/references/template-language.md (read 2026-11-26) --> |
| Kit | `{{ subscriber.first_name }}` | - <!-- source: https://github.com/Kit/convertkit-wordpress/blob/HEAD/includes/class-convertkit-settings-broadcasts.php (Kit's own plugin text, read 2026-11-26) --> |
| Customer.io | `{{customer.first_name}}` | - <!-- source: https://github.com/customerio/customerio-node/blob/HEAD/docs/app.md (read 2026-11-26) --> |
| MailerLite | `{$name}` | - <!-- source: https://github.com/mailerlite/mailerlite-nodejs/blob/HEAD/src/modules/automation-emails/README.md (read 2026-11-26) --> |

Notes on the table:

- **Mailchimp.** `FNAME` is the first-name field that a new audience starts with. Mailchimp says those fields can be edited, so use the tag your audience shows. The `URL:` form that encodes a value is documented for Mailchimp Transactional, where the tag names a merge variable that your messages send, `FNAME` in this example. The pages we read do not say whether campaigns accept it.
- **HubSpot.** The token and the `urlencode` filter come from Jinjava, the template engine HubSpot uses for the content of its CMS, and HubSpot's sample code for programmable email modules (a beta feature) puts template values into an image's `src`. We found nothing on putting a token into the image field of the drag-and-drop email editor.
- **Brevo.** Attribute names are exactly as defined in your account; `FIRSTNAME` is the example Brevo's reference uses. Brevo's template reference says that inside a double-quoted HTML attribute, such as `src="..."`, a filter uses single quotes: `{{ contact.FIRSTNAME | default:'there' }}`. It lists no URL-encoding filter.
- **Kit**, **Customer.io** and **MailerLite.** The tag is the one their own code and documentation show in the text of an email; MailerLite's own example greets with `Hello {$name}`.

Your platform is not listed? Use the tag it shows for the first name in an email's text, put it after `name=` and send the test above.

## FAQ

### Can a reader change the name in the image?

Yes, and so can anyone who has the URL: the open field is not signed, so another value after `name=` makes another image. Everything else in the URL is signed and cannot be changed. The [value rules](/docs/email-images#what-a-value-may-contain) keep an open value to a short line of plain text, and the daily limit caps how many new images a site can render in a day, so a stranger cannot use up your allowance faster than that.

### What does a campaign cost?

At most one image per distinct name, plus one for the default, from the site owner's monthly allowance; a reader whose name is already stored costs nothing. A stored name is rendered again only after your plan's storage period: [[plan.free.cacheDays]] days on [[plan.free.name]], [[plan.starter.cacheDays]] on [[plan.starter.name]], [[plan.pro.cacheDays]] on [[plan.pro.name]]. When the allowance is used up, new names cannot be rendered and those readers see a broken image, so check your remaining images on the dashboard before a large send.

### Why does the image say "Hi there," for some readers?

Their value was missing, empty or not usable, so the image fell back to the default. A first name that is blank in your list, an emoji, a web address or letters of a script the built-in fonts do not draw (for example Arabic or Chinese) all show the default. It is also what everyone with a new name sees once the site's daily limit is used up.

### Can I personalize more than the name?

Yes. A URL can have up to [[email.maxOpenFields]] open fields, each with its own default, for example `open=name,code` with the `email-offer` template to print a different discount code for each reader. Each distinct combination of values is one image, so more open fields usually means more images per send.

### Which image format should I use?

PNG, or JPEG for photos: end the URL's path with `.png` or `.jpg`. Brevo's own rules for the emails its generator writes, for example, say to use JPG, PNG or GIF and not WebP.

<!-- Source: "No SVG or WEBP; use JPG, PNG or GIF." https://github.com/getbrevo/brevo-skills/blob/HEAD/skills/email-template-write/references/email-design-rules.md (read 2026-11-26). -->

## Make it your own

The two email starter templates are a start: any of your own templates works the same way, and any of its fields can be open. [Start free with [[site.name]]](/login), or read [Email images](/docs/email-images) for the exact rules.

Related: [Signed URLs](/docs/signed-urls) · [OG image size](/guides/og-image-size)
