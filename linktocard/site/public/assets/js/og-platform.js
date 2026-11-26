// The five one-app pages of the Open Graph checker: /tools/x-card-validator,
// /tools/linkedin-post-preview, /tools/slack-link-preview, /tools/discord-embed-preview and
// /tools/whatsapp-link-preview. Same check as /tools/og-checker (GET /api/tools/og-check, one
// cached CheckResult, no backend change), focused on the app the page names in
// <form id="platform-form" data-platform="...">: that app's approximate preview first, then the
// app's own checks where its rules were read in the vendor's own documents, then the general
// checklist, the image facts and the parsed tags.
//
// It extends og-checker.js without changing it: input handling, the request URL, the error
// messages, the verdict, the check order, text cleaning and the rule that images are shown only
// through our own proxy come from there. og-checker.js starts itself only on a page that has
// #check-form, which these pages do not have, so the two scripts never drive the same form.
//
// Platform facts, and where each was read (2026-11-26):
//   Discord: Discord's "Link Previews" page, https://docs.discord.com/developers/link-previews/overview
//     (read from its source: https://github.com/discord/discord-api-docs/blob/62ab2d5019782add4231a3fc6ee6c0fa2d8d62d1/developers/link-previews/overview.mdx).
//   X: X Developer Policy, section "X Cards", https://docs.x.com/developer-terms/policy
//     (read from its source: https://github.com/xdevplatform/docs/blob/ad1e5df92bbe6908acf98ac3973d8e17cc7d4f4f/developer-terms/policy.mdx).
//   LinkedIn, Slack, WhatsApp: none of their preview rules could be read in their own documents,
//     so their pages make no app-specific claim and run only the general checks.
// Everything else here (mockup layouts, text budgets outside Discord, which tag a mockup prefers)
// is our own approximation, and the pages say so.
//
// Everything that comes from the checked page is third-party text. It is set only with
// textContent (or as an attribute value), never parsed as HTML, exactly as in og-checker.js.

import {
  CTA_TEXT,
  PREVIEW_LIMITS,
  TURNSTILE_SRC,
  checkRequestUrl,
  cleanText,
  clockTime,
  ctaHref,
  ctaTitle,
  describeError,
  formatBytes,
  formatRatio,
  normaliseInput,
  previewText,
  proxySrc,
  retryAfterSeconds,
  tagRows,
  truncate,
  verdict,
} from './og-checker.js';

/** Our own stylesheet for the one-app mockups, loaded once by this script (the layout links only site.css). */
export const STYLESHEET = '/assets/css/og-platform.css';
export const CHECKER_PATH = '/tools/og-checker';
export const FIX_TEXT = 'Fix it: make the card';

/** The five pages: the app's display name and the page's own path (its share links point back to it). */
export const PLATFORMS = Object.freeze({
  x: { id: 'x', name: 'X', path: '/tools/x-card-validator' },
  linkedin: { id: 'linkedin', name: 'LinkedIn', path: '/tools/linkedin-post-preview' },
  slack: { id: 'slack', name: 'Slack', path: '/tools/slack-link-preview' },
  discord: { id: 'discord', name: 'Discord', path: '/tools/discord-embed-preview' },
  whatsapp: { id: 'whatsapp', name: 'WhatsApp', path: '/tools/whatsapp-link-preview' },
});
export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

/** Where each app's own checks come from; an app missing here has none (its page says so). */
export const SOURCES = Object.freeze({
  discord: 'https://docs.discord.com/developers/link-previews/overview',
  x: 'https://docs.x.com/developer-terms/policy',
});

// Source: https://docs.discord.com/developers/link-previews/overview (sections "How Discord Reads
// Your Page", "Tag Reference", "Images", "Accent Color and Publish Date", "Limits", "Caching and
// Testing"). These are Discord's published numbers, not ours, so they live here with their source
// and not in src/config.ts. Discord warns that "Link previews are subject to change."
export const DISCORD = Object.freeze({
  /** "Title | 70 bytes, 3 lines | Trimmed" */
  titleMaxBytes: 70,
  titleMaxLines: 3,
  /** "Description | 350 bytes, 20 lines | Trimmed" */
  descriptionMaxBytes: 350,
  descriptionMaxLines: 20,
  /** "og:site_name | 256 characters | No preview at all" */
  siteNameMaxChars: 256,
  /** "Image alt text | 4,096 characters | No preview at all" (not checkable: results carry at most 2,048 characters of a tag). */
  imageAltMaxChars: 4096,
  /** "Any URL | 2,048 characters | No preview at all" */
  urlMaxChars: 2048,
  /** "The whole fetch, including measuring your images and video, must finish within 10 seconds." */
  fetchBudgetMs: 10_000,
  /** "At most 5 redirects." */
  maxRedirects: 5,
  /** "Discord caches previews for about 30 minutes." */
  cacheMinutes: 30,
  /** "Two or more og:image tags produce a gallery. At most 4 images are shown." */
  galleryMaxImages: 4,
  /** "Supported formats are .png, .gif, .jpg, .jpeg, .webp, and .avif." As media types: */
  imageTypes: Object.freeze(['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/avif']),
  /** "it has to be a 6 or 8 digit hex value" ("#RRGGBB or #RRGGBBAA only"). */
  accentColour: /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /** "the Embed Debugger ... shows how Discord reads a URL, including which tags it picked up and which layout it chose." */
  embedDebugger: 'https://discord.com/developers/embeds',
});

/** What a format is called in a sentence. */
const TYPE_NAMES = { 'image/png': 'PNG', 'image/gif': 'GIF', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/avif': 'AVIF' };
/** An HTML tag inside text, such as <b> or </p>: Discord shows them literally. */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i;
const STATUS_ORDER = { fail: 0, warn: 1, info: 2, pass: 3 };

const encoder = new TextEncoder();

/** Length of the text in UTF-8 bytes, the unit Discord counts in (é is 2 bytes, most emoji 4). */
export function utf8Bytes(text) {
  return encoder.encode(cleanText(text)).length;
}

/** The longest start of the text that fits in `max` UTF-8 bytes, cut between characters, with an ellipsis when it was cut. */
export function truncateBytes(text, max) {
  const clean = cleanText(text);
  if (!(max > 0)) return '';
  if (utf8Bytes(clean) <= max) return clean;
  let kept = '';
  let used = 0;
  for (const char of clean) {
    const size = encoder.encode(char).length;
    if (used + size > max) break;
    kept += char;
    used += size;
  }
  return `${kept.trimEnd()}…`;
}

/** Characters as people count them (code points, so an emoji is one). */
const charCount = (text) => Array.from(cleanText(text)).length;

/** The address-bar URL for a check on one of these pages. */
export function shareUrlFor(platform, url) {
  const page = PLATFORMS[platform];
  if (!page) throw new Error(`Unknown platform "${platform}"`);
  return `${page.path}?${new URLSearchParams({ url })}`;
}

/** The same check in the full checker, which draws all six approximate previews. */
export function checkerHref(url) {
  const clean = cleanText(url);
  return clean ? `${CHECKER_PATH}?${new URLSearchParams({ url: clean })}` : CHECKER_PATH;
}

function check(id, status, title, detail, fix = null) {
  return { id, status, title, detail, fix: status === 'pass' || status === 'info' ? null : fix };
}

/** Problems first, then notes, then passes; the order of the list is kept within each group. */
export function sortPlatformChecks(checks) {
  return (Array.isArray(checks) ? checks : [])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (STATUS_ORDER[a.item?.status] ?? 4) - (STATUS_ORDER[b.item?.status] ?? 4) || a.index - b.index)
    .map(({ item }) => item);
}

/* ------------------------------------------------------------------ Discord */

/**
 * The title and description Discord takes from the parsed tags.
 * Source: https://docs.discord.com/developers/link-previews/overview, "Tag Reference": og:title and
 * twitter:title give the title, og:description and twitter:description the description, "the first
 * non-empty one wins", and "<title> plus <meta name="description"> ... Used only as a pair, and only
 * when the page doesn't have a title or description for Open Graph or Twitter."
 * The result does not say which of og:title and twitter:title came first in the page, so og:title
 * is used and `tagsDiffer` reports when the two disagree.
 */
export function discordText(result) {
  const og = result?.og ?? {};
  const tw = result?.twitter ?? {};
  const page = result?.page ?? {};
  const ogTitle = cleanText(og.title);
  const twTitle = cleanText(tw.title);
  const tagTitle = ogTitle || twTitle;
  const tagDescription = cleanText(og.description) || cleanText(tw.description);
  const pageTitle = cleanText(page.title);
  const pageDescription = cleanText(page.description);
  const pair = !tagTitle && !tagDescription && pageTitle !== '' && pageDescription !== '';
  return {
    title: pair ? pageTitle : tagTitle,
    description: pair ? pageDescription : tagDescription,
    /** 'tags' (og:/twitter:), 'page' (<title> and meta description as a pair) or null (no text at all). */
    source: pair ? 'page' : tagTitle || tagDescription ? 'tags' : null,
    siteName: cleanText(og.site_name),
    tagsDiffer: ogTitle !== '' && twTitle !== '' && ogTitle !== twTitle,
    /** <title> exists but Discord will not use it, because an og:/twitter: description is set. */
    pageTitleUnused: !tagTitle && tagDescription !== '' && pageTitle !== '',
  };
}

/**
 * The layout Discord picks, from twitter:card and og:type.
 * Source: https://docs.discord.com/developers/link-previews/overview, "Preview Layouts": no layout
 * tags give "text with a small image"; twitter:card summary_large_image "text with a large image
 * below it"; twitter:card photo "the image on its own, with no description"; og:type rich "Discord
 * rendered markdown text with a small thumbnail"; og:type video.* or twitter:card player, "plus a
 * video file", an inline player (a video that cannot be measured falls back to a plain preview).
 * The page does not say which wins when twitter:card and og:type ask for different layouts; the
 * order below (twitter:card first) is our guess, and the mockup is labelled approximate.
 * @returns {{ layout: 'small'|'large'|'photo'|'rich', askedForVideo: boolean }}
 */
export function discordLayout(result) {
  const card = cleanText(result?.twitter?.card);
  const type = cleanText(result?.og?.type);
  const askedForVideo = card === 'player' || /^video(?:\.|$)/.test(type);
  if (card === 'photo') return { layout: 'photo', askedForVideo };
  if (card === 'summary_large_image') return { layout: 'large', askedForVideo };
  if (type === 'rich') return { layout: 'rich', askedForVideo };
  return { layout: 'small', askedForVideo };
}

/** theme-color as Discord accepts it (6 or 8 hex digits), else null. Source: DISCORD.accentColour. */
export function discordAccent(value) {
  const text = cleanText(value);
  return DISCORD.accentColour.test(text) ? text : null;
}

/** "1.2 s" */
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Discord's own checks for a result. Every rule cites https://docs.discord.com/developers/link-previews/overview
 * (see DISCORD); statuses: fail = Discord shows no preview or not this part, warn = shown but
 * worse (trimmed, ignored, slower), info = what Discord will do, pass = fine.
 */
export function discordChecks(result) {
  const out = [];
  const text = discordText(result);
  const { layout, askedForVideo } = discordLayout(result);
  const og = result?.og ?? {};
  const tw = result?.twitter ?? {};
  const image = result?.image ?? null;
  const imageRaw = cleanText(og.image) || cleanText(tw.image);
  const imageName = cleanText(og.image) ? 'og:image' : 'twitter:image';

  // "Preview Layouts"
  const LAYOUTS = {
    small: ['Layout: text with a small image', 'With no layout tag, Discord shows the title and description with a small image beside them. Add <meta name="twitter:card" content="summary_large_image"> for a large image below the text.'],
    large: ['Layout: large image below the text', 'twitter:card is summary_large_image, so Discord shows the title and description with a large image below them.'],
    photo: ['Layout: the image on its own', 'twitter:card is photo, so Discord shows the image alone, without the description.'],
    rich: ['Layout: markdown text with a small thumbnail', 'og:type is rich, so Discord renders the description as Discord markdown, with a small thumbnail.'],
  };
  const [layoutTitle, layoutDetail] = imageRaw ? LAYOUTS[layout] : ['Layout: text only', 'The page names no og:image or twitter:image, so the preview has no image.'];
  const videoNote = askedForVideo
    ? ' The page also asks for the video layout: Discord shows a player only when og:video points at a video file, which this checker does not read.'
    : '';
  out.push(check('discord_layout', 'info', layoutTitle, `${layoutDetail}${videoNote}`));

  // "Tag Reference" (title, pair rule) and "Limits" (70 bytes, 3 lines)
  if (!text.title) {
    out.push(
      check(
        'discord_title',
        'fail',
        'Discord has no title to show',
        text.pageTitleUnused
          ? 'The page has an og:description or twitter:description but no og:title or twitter:title. Discord uses <title> only together with the meta description, and only when the page has no Open Graph or Twitter title or description, so it will not use your <title> here.'
          : 'The page has no og:title or twitter:title, and no <title> and meta description pair for Discord to fall back on.',
        'Add <meta property="og:title" content="..."> with the title the preview should show.',
      ),
    );
  } else {
    const bytes = utf8Bytes(text.title);
    const from = text.source === 'page' ? ' It comes from <title>: the page has no Open Graph or Twitter title or description, so Discord uses <title> and the meta description as a pair.' : '';
    const differ = text.tagsDiffer ? ' og:title and twitter:title differ; Discord uses whichever comes first in the page.' : '';
    out.push(
      bytes > DISCORD.titleMaxBytes
        ? check(
            'discord_title',
            'warn',
            `Title is over ${DISCORD.titleMaxBytes} bytes, so Discord trims it`,
            `The title is ${bytes} bytes in UTF-8 (letters outside A to Z often take 2 to 4 bytes each). Discord shows at most ${DISCORD.titleMaxBytes} bytes and ${DISCORD.titleMaxLines} lines.${from}${differ}`,
            `Shorten the title to ${DISCORD.titleMaxBytes} bytes or fewer, or put the words that matter first.`,
          )
        : check('discord_title', 'pass', `Title fits: ${bytes} of ${DISCORD.titleMaxBytes} bytes`, `Discord shows titles of up to ${DISCORD.titleMaxBytes} bytes and ${DISCORD.titleMaxLines} lines.${from}${differ}`),
    );
  }

  // "Limits" (350 bytes, 20 lines; "HTML tags in it appear literally", except on og:type rich)
  if (layout === 'photo') {
    out.push(check('discord_description', 'info', 'No description in this layout', 'With twitter:card set to photo, Discord shows the image without the description.'));
  } else if (!text.description) {
    out.push(check('discord_description', 'info', 'No description', 'The page has no og:description or twitter:description, so the preview shows no description.'));
  } else {
    const bytes = utf8Bytes(text.description);
    out.push(
      bytes > DISCORD.descriptionMaxBytes
        ? check(
            'discord_description',
            'warn',
            `Description is over ${DISCORD.descriptionMaxBytes} bytes, so Discord trims it`,
            `The description is ${bytes} bytes in UTF-8. Discord shows at most ${DISCORD.descriptionMaxBytes} bytes and ${DISCORD.descriptionMaxLines} lines.`,
            `Shorten the description to ${DISCORD.descriptionMaxBytes} bytes or fewer.`,
          )
        : check('discord_description', 'pass', `Description fits: ${bytes} of ${DISCORD.descriptionMaxBytes} bytes`, `Discord shows descriptions of up to ${DISCORD.descriptionMaxBytes} bytes and ${DISCORD.descriptionMaxLines} lines.`),
    );
    if (layout !== 'rich' && HTML_TAG.test(text.description)) {
      out.push(
        check(
          'discord_description_html',
          'warn',
          'The description contains HTML tags',
          `Discord shows the description as plain text, so a tag such as "${truncate(HTML_TAG.exec(text.description)?.[0] ?? '', 40)}" appears literally.`,
          'Remove the markup from og:description and keep plain text.',
        ),
      );
    }
  }

  // "Tag Reference" (og:site_name "Shown above the title") and "Limits" (256 characters)
  const siteChars = charCount(og.site_name);
  if (siteChars === 0) {
    out.push(check('discord_site_name', 'info', 'No site name above the title', 'Discord shows og:site_name above the title. The page sets none.'));
  } else if (siteChars > DISCORD.siteNameMaxChars) {
    out.push(
      check(
        'discord_site_name',
        'fail',
        `og:site_name is over ${DISCORD.siteNameMaxChars} characters`,
        `og:site_name is ${siteChars} characters. Above ${DISCORD.siteNameMaxChars}, Discord shows no preview at all.`,
        'Use the short name of the site, such as "Example Blog".',
      ),
    );
  } else {
    out.push(check('discord_site_name', 'pass', 'Site name is set', `Discord shows "${truncate(og.site_name, 60)}" above the title.`));
  }

  // "Accent Color": "#RRGGBB or #RRGGBBAA only"
  const colour = cleanText(result?.page?.theme_color);
  if (colour === '') {
    out.push(check('discord_accent', 'info', 'No accent colour', 'Discord colours the edge of the preview with theme-color. The page sets none.'));
  } else if (discordAccent(colour)) {
    out.push(check('discord_accent', 'pass', `Accent colour ${colour}`, 'theme-color is a 6- or 8-digit hex colour, the form Discord accepts.'));
  } else {
    out.push(
      check(
        'discord_accent',
        'warn',
        'theme-color is not a form Discord accepts',
        `theme-color is "${truncate(colour, 40)}". Discord accepts only #RRGGBB or #RRGGBBAA (6 or 8 hex digits), so it will not use this colour.`,
        'Write the colour with 6 hex digits, for example <meta name="theme-color" content="#2f6feb">.',
      ),
    );
  }

  // "Limits": "Any URL | 2,048 characters | No preview at all"
  const urls = [
    ['The page address', result?.final_url],
    ['og:url', og.url],
    ['og:image', og.image],
    ['twitter:image', tw.image],
  ].filter(([, value]) => typeof value === 'string' && value.length > DISCORD.urlMaxChars);
  out.push(
    urls.length > 0
      ? check(
          'discord_url_length',
          'fail',
          `A URL is over ${formatNumber(DISCORD.urlMaxChars)} characters`,
          `${urls.map(([name]) => name).join(', ')} ${urls.length === 1 ? 'is' : 'are'} longer than ${formatNumber(DISCORD.urlMaxChars)} characters. With any URL that long, Discord shows no preview at all.`,
          'Shorten the URL: drop tracking parameters, or serve the image from a short path.',
        )
      : check('discord_url_length', 'pass', `Every URL is ${formatNumber(DISCORD.urlMaxChars)} characters or shorter`, `Discord shows no preview when any URL is longer than ${formatNumber(DISCORD.urlMaxChars)} characters.`),
  );

  if (imageRaw) {
    // "Images": "Relative URLs must start with /."
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(imageRaw) && !imageRaw.startsWith('/');
    if (relative) {
      out.push(
        check(
          'discord_image_relative',
          'fail',
          'The relative image URL does not start with /',
          `${imageName} is "${truncate(imageRaw, 80)}". Discord reads a relative image URL only when it starts with /.`,
          'Use the full https:// address of the image (or at least start the path with /).',
        ),
      );
    }

    // "Images": supported formats
    const type = cleanText(image?.content_type).toLowerCase().split(';')[0]?.trim() ?? '';
    if (type) {
      out.push(
        DISCORD.imageTypes.includes(type)
          ? check('discord_image_format', 'pass', `Image format: ${TYPE_NAMES[type]}`, 'Discord reads PNG, GIF, JPEG, WebP and AVIF images.')
          : check(
              'discord_image_format',
              'fail',
              'Discord does not list this image format',
              `The image is served as ${truncate(type, 60)}. Discord reads PNG, GIF, JPEG, WebP and AVIF images.`,
              'Serve the card image as a PNG or JPEG.',
            ),
      );
    }

    // "Images": "Without them, Discord fetches the image to measure it."
    const declared = cleanText(og.image_width) !== '' && cleanText(og.image_height) !== '';
    const real = Number.isFinite(image?.width) && Number.isFinite(image?.height) && image.width > 0 && image.height > 0;
    out.push(
      declared
        ? check('discord_image_size_tags', 'pass', 'og:image:width and og:image:height are set', 'Discord can size the image from the tags without downloading it to measure it.')
        : check(
            'discord_image_size_tags',
            'warn',
            'og:image:width and og:image:height are missing',
            `Without them, Discord downloads the image to measure it, and that counts against its ${DISCORD.fetchBudgetMs / 1000}-second budget for the whole fetch.`,
            `Add <meta property="og:image:width" content="${real ? image.width : 1200}"> and <meta property="og:image:height" content="${real ? image.height : 630}"> right after og:image${real ? ' (the size of this image)' : ', with your image\'s real size'}.`,
          ),
    );
  }

  // "How Discord Reads Your Page": "The whole fetch ... must finish within 10 seconds."
  const pageMs = Number.isFinite(result?.response_ms) ? result.response_ms : null;
  if (pageMs !== null) {
    const imageMs = Number.isFinite(image?.response_ms) ? image.response_ms : 0;
    const total = pageMs + imageMs;
    const what = imageMs > 0 ? 'The page and its image took' : 'The page took';
    out.push(
      total > DISCORD.fetchBudgetMs
        ? check(
            'discord_fetch_time',
            'fail',
            `Over Discord's ${DISCORD.fetchBudgetMs / 1000}-second budget`,
            `${what} ${seconds(total)} from our server. Discord allows ${DISCORD.fetchBudgetMs / 1000} seconds for the whole fetch, image measuring included.`,
            'Make the page and the image respond faster: cache them or serve them from a CDN.',
          )
        : check(
            'discord_fetch_time',
            'pass',
            `Fetch time: ${seconds(total)} of Discord's ${DISCORD.fetchBudgetMs / 1000}`,
            `${what} ${seconds(total)} from our server; Discord's own fetch may be faster or slower. Discord allows ${DISCORD.fetchBudgetMs / 1000} seconds for the whole fetch, image measuring included.`,
          ),
    );
  }
  return out;
}

/** 2048 -> "2,048" */
function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ X */

/**
 * X's own check: card images over HTTPS.
 * Source: https://docs.x.com/developer-terms/policy, "X Cards": "You must use HTTPS for hosting all
 * assets within your Card." Relative image URLs are resolved against the page, which the checker
 * only fetches over https. Nothing else about X cards could be read in X's own documents.
 */
export function xChecks(result) {
  const base = (() => {
    try {
      return new URL(cleanText(result?.final_url) || cleanText(result?.url));
    } catch {
      return null;
    }
  })();
  const images = [
    ['twitter:image', result?.twitter?.image],
    ['og:image', result?.og?.image],
  ].filter(([, value]) => cleanText(value) !== '');
  if (images.length === 0) return [];
  const insecure = images.filter(([, value]) => {
    try {
      return new URL(cleanText(value), base ?? undefined).protocol !== 'https:';
    } catch {
      return true;
    }
  });
  return [
    insecure.length > 0
      ? check(
          'x_https_assets',
          'fail',
          'A card image is not on https',
          `${insecure.map(([name]) => name).join(' and ')} ${insecure.length === 1 ? 'does' : 'do'} not point at an https:// address. X's developer policy says all assets within a card must be hosted on HTTPS.`,
          'Serve the image over https and use the https:// address in the tag.',
        )
      : check('x_https_assets', 'pass', 'Card images are on https', "X's developer policy says all assets within a card must be hosted on HTTPS."),
  ];
}

/** The layout the X mockup draws: the large image card only when twitter:card asks for it. Our approximation. */
export function xLayout(result) {
  return cleanText(result?.twitter?.card) === 'summary_large_image' ? 'large' : 'small';
}

/**
 * The sentence under the X mockup about twitter:card, or '' for summary_large_image. Worded as our
 * understanding of the card types, not as X's rule: X's current documentation does not describe them.
 */
export function xCardNote(result) {
  const card = cleanText(result?.twitter?.card);
  if (card === 'summary_large_image') return '';
  const large = 'The value in common use for a large image is summary_large_image: <meta name="twitter:card" content="summary_large_image">.';
  if (card === '') return `The page has no twitter:card tag, the tag that names the card type, so the mockup shows the small card. ${large}`;
  if (card === 'summary') return `twitter:card is "summary", the small card, so the mockup shows it small. ${large}`;
  return `twitter:card is "${truncate(card, 40)}". The mockup shows the small card as a stand-in. ${large}`;
}

/**
 * Title and description for the X mockup. Our approximation, not an X rule we could verify: the
 * twitter: tags exist for X's cards, so they are preferred, with og: and then <title> as fallbacks.
 */
export function xText(result) {
  const tw = result?.twitter ?? {};
  const og = result?.og ?? {};
  const page = result?.page ?? {};
  return {
    title: cleanText(tw.title) || cleanText(og.title) || cleanText(page.title),
    description: cleanText(tw.description) || cleanText(og.description) || cleanText(page.description),
  };
}

/* ------------------------------------------------------------------ every page */

/** The app's own checks: Discord and X have some; LinkedIn, Slack and WhatsApp none (nothing verified). */
export function platformChecks(platform, result) {
  if (platform === 'discord') return discordChecks(result);
  if (platform === 'x') return xChecks(result);
  return [];
}

/** The page's headline: og-checker's verdict over the general checks plus the app's own (notes do not count). */
export function platformVerdict(platform, result) {
  const own = platformChecks(platform, result).filter((item) => item.status !== 'info');
  return verdict([...(Array.isArray(result?.checks) ? result.checks : []), ...own]);
}

/**
 * Everything one mockup draws, as plain data (the DOM code only lays it out). Text is cut to
 * Discord's published byte limits on the Discord page and to og-checker's approximate budgets
 * elsewhere (LinkedIn shares the "facebook" budget, as in the six-app checker).
 */
export function mockupModel(platform, result) {
  const preview = result?.preview && typeof result.preview === 'object' ? result.preview : {};
  const base = {
    platform,
    domain: cleanText(preview.domain),
    image: proxySrc(preview.image),
    favicon: proxySrc(preview.favicon),
  };
  switch (platform) {
    case 'discord': {
      const text = discordText(result);
      const { layout } = discordLayout(result);
      const hasImageTag = cleanText(result?.og?.image) !== '' || cleanText(result?.twitter?.image) !== '';
      return {
        ...base,
        layout: hasImageTag ? layout : 'text',
        siteName: truncate(text.siteName, DISCORD.siteNameMaxChars),
        title: truncateBytes(text.title, DISCORD.titleMaxBytes),
        description: layout === 'photo' ? '' : truncateBytes(text.description, DISCORD.descriptionMaxBytes),
        accent: discordAccent(result?.page?.theme_color),
        notes: [],
      };
    }
    case 'x': {
      const text = xText(result);
      const note = xCardNote(result);
      return { ...base, layout: xLayout(result), title: truncate(text.title, PREVIEW_LIMITS.x.title), description: '', notes: note ? [note] : [] };
    }
    case 'linkedin': {
      const text = previewText('facebook', preview);
      return { ...base, layout: 'large', title: text.title, description: '', notes: [] };
    }
    case 'slack': {
      const text = previewText('slack', preview);
      return { ...base, layout: 'large', siteName: text.siteName, title: text.title, description: text.description, notes: [] };
    }
    case 'whatsapp': {
      const text = previewText('whatsapp', preview);
      return { ...base, layout: 'large', title: text.title, description: text.description, url: truncate(result?.url, 70), notes: [] };
    }
    default:
      throw new Error(`Unknown platform "${platform}"`);
  }
}

/* ------------------------------------------------------------------ DOM */

/** createElement with attributes and children. Strings become text nodes; nothing is parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === '') continue;
    node.append(child);
  }
  return node;
}

function imageBox(src, className) {
  const safe = proxySrc(src);
  if (!safe) return el('div', { class: `${className} pv-noimg` }, el('span', {}, 'No image'));
  const img = el('img', { class: className, src: safe, alt: '', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: `${className} pv-noimg` }, el('span', {}, 'Image did not load'))), { once: true });
  return img;
}

function faviconImg(src) {
  const safe = proxySrc(src);
  if (!safe) return null;
  const img = el('img', { class: 'pv-favicon', src: safe, alt: '', width: 16, height: 16, decoding: 'async' });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

function titleNode(text, domain, tag = 'strong') {
  return text ? el(tag, { class: 'pv-title' }, text) : el(tag, { class: 'pv-title is-missing' }, domain || 'No title');
}

const desc = (text) => (text ? el('span', { class: 'pv-desc' }, text) : null);

/** One mockup per app, laid out from mockupModel(). Class names follow og-checker's .pv-* styles. */
const MOCKUPS = {
  x(m) {
    if (m.layout === 'large') {
      return el(
        'div',
        { class: 'pv-card' },
        el('div', { class: 'pv-media' }, imageBox(m.image, 'pv-img'), el('span', { class: 'pv-overlay' }, m.title || m.domain)),
        el('span', { class: 'pv-domain' }, `From ${m.domain}`),
      );
    }
    return el(
      'div',
      { class: 'pv-card pv-small' },
      imageBox(m.image, 'pv-img pv-thumb'),
      el('div', { class: 'pv-text' }, el('span', { class: 'pv-domain' }, m.domain), titleNode(m.title, m.domain, 'span')),
    );
  },
  linkedin(m) {
    return el('div', { class: 'pv-card' }, imageBox(m.image, 'pv-img'), el('div', { class: 'pv-text' }, titleNode(m.title, m.domain), el('span', { class: 'pv-domain' }, m.domain)));
  },
  slack(m) {
    return el(
      'div',
      { class: 'pv-card' },
      el('span', { class: 'pv-site' }, faviconImg(m.favicon), m.siteName || m.domain),
      titleNode(m.title, m.domain, 'span'),
      desc(m.description),
      m.image ? imageBox(m.image, 'pv-img') : null,
    );
  },
  whatsapp(m) {
    return el(
      'div',
      { class: 'pv-bubble' },
      el('div', { class: 'pv-card' }, imageBox(m.image, 'pv-img'), el('div', { class: 'pv-text' }, titleNode(m.title, m.domain), desc(m.description), el('span', { class: 'pv-domain' }, m.domain))),
      el('span', { class: 'pv-url' }, m.url),
    );
  },
  discord(m) {
    const site = m.siteName ? el('span', { class: 'pv-site' }, m.siteName) : null;
    let card;
    if (m.layout === 'photo') {
      card = el('div', { class: 'pv-card pv-layout-photo' }, imageBox(m.image, 'pv-img'));
    } else if (m.layout === 'large') {
      card = el('div', { class: 'pv-card pv-layout-large' }, site, titleNode(m.title, m.domain, 'span'), desc(m.description), imageBox(m.image, 'pv-img'));
    } else if (m.layout === 'text') {
      card = el('div', { class: 'pv-card pv-layout-text' }, site, titleNode(m.title, m.domain, 'span'), desc(m.description));
    } else {
      // small and rich: the text with a small image beside it.
      card = el('div', { class: `pv-card pv-layout-${m.layout}` }, el('div', { class: 'pv-body' }, site, titleNode(m.title, m.domain, 'span'), desc(m.description)), imageBox(m.image, 'pv-img pv-thumb'));
    }
    if (m.accent) card.style.setProperty('--pv-accent', m.accent);
    return card;
  },
};

function previewFigure(platform, result) {
  const model = mockupModel(platform, result);
  return el(
    'figure',
    { class: `pv pv-${platform}` },
    el('figcaption', { class: 'pv-head' }, el('span', { class: 'pv-name' }, PLATFORMS[platform].name), el('span', { class: 'pv-approx' }, 'Approximate preview')),
    el('div', { class: 'pv-screen' }, MOCKUPS[platform](model)),
  );
}

const ICONS = { pass: ['✓', 'Pass'], warn: ['!', 'Warning'], fail: ['✕', 'Fail'], info: ['i', 'Note'] };

function checkItem(item, cta) {
  const status = ICONS[item?.status] ? item.status : 'warn';
  const [icon, label] = ICONS[status];
  const problem = status === 'warn' || status === 'fail';
  return el(
    'li',
    { class: `cl-item cl-${status}` },
    el('span', { class: 'cl-icon', 'aria-hidden': 'true' }, icon),
    el(
      'div',
      { class: 'cl-body' },
      el('p', { class: 'cl-title' }, el('span', { class: 'visually-hidden' }, `${label}: `), cleanText(item?.title) || 'Check'),
      cleanText(item?.detail) ? el('p', { class: 'cl-detail' }, cleanText(item.detail)) : null,
      problem && cleanText(item?.fix) ? el('p', { class: 'cl-fix' }, el('strong', {}, 'How to fix: '), cleanText(item.fix)) : null,
      problem ? el('p', { class: 'cl-cta' }, el('a', { class: 'link-arrow', href: cta }, CTA_TEXT)) : null,
    ),
  );
}

function factRows(image) {
  if (!image) return [['Image', 'No og:image or twitter:image tag was found, so there was no image to test.']];
  const dims = Number.isFinite(image.width) && Number.isFinite(image.height) ? `${image.width} × ${image.height} px` : null;
  return [
    ['URL', cleanText(image.url) || null],
    ['HTTP status', Number.isInteger(image.status) ? String(image.status) : null],
    ['Type', cleanText(image.content_type) || null],
    ['Size', formatBytes(image.bytes)],
    ['Dimensions', dims],
    ['Aspect ratio', formatRatio(image.aspect_ratio)],
    ['Response time', Number.isFinite(image.response_ms) ? `${image.response_ms} ms` : null],
  ];
}

function isResult(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.checks) && value.preview && typeof value.preview === 'object');
}

let stylesheet = null;
/** Adds og-platform.css once; resolves when it loaded (or failed, or after 1.5 s), so results never wait long for it. */
function loadStylesheet() {
  if (stylesheet) return stylesheet;
  if (document.querySelector(`link[rel="stylesheet"][href="${STYLESHEET}"]`)) return (stylesheet = Promise.resolve());
  stylesheet = new Promise((resolve) => {
    const link = el('link', { rel: 'stylesheet', href: STYLESHEET });
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1500);
    document.head.append(link);
  });
  return stylesheet;
}

function init() {
  const form = document.getElementById('platform-form');
  if (!form) return;
  const platform = form.dataset.platform;
  if (!PLATFORMS[platform]) return;
  const $ = (id) => document.getElementById(id);
  const input = $('platform-url');
  const submit = $('platform-submit');
  const status = $('platform-status');
  const errorBox = $('platform-error');
  const verifyBox = $('platform-verify');
  const widgetSlot = $('platform-widget');
  const results = $('platform-results');
  if (!input || !submit || !status || !errorBox || !verifyBox || !widgetSlot || !results) return;
  loadStylesheet();

  let controller = null;
  let currentUrl = null;
  let widgetId = null;
  let turnstileLoad = null;

  function setBusy(busy) {
    submit.disabled = busy;
    submit.setAttribute('aria-busy', String(busy));
    submit.textContent = busy ? 'Checking…' : 'Check';
    results.setAttribute('aria-busy', String(busy));
  }

  function clearVerify() {
    if (widgetId !== null && window.turnstile) {
      try {
        window.turnstile.remove(widgetId);
      } catch {
        // Already gone.
      }
    }
    widgetId = null;
    widgetSlot.replaceChildren();
    verifyBox.hidden = true;
  }

  function showError(problem) {
    errorBox.replaceChildren(el('strong', {}, `${problem.title} `), problem.message);
    errorBox.hidden = false;
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    turnstileLoad ??= new Promise((resolve, reject) => {
      const script = el('script', { src: TURNSTILE_SRC, async: true });
      script.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'))));
      script.addEventListener('error', () => {
        turnstileLoad = null;
        script.remove();
        reject(new Error('script failed'));
      });
      document.head.append(script);
    });
    return turnstileLoad;
  }

  async function showVerify(siteKey, url) {
    clearVerify();
    verifyBox.hidden = false;
    try {
      const turnstile = await loadTurnstile();
      if (currentUrl !== url) return;
      widgetId = turnstile.render(widgetSlot, {
        sitekey: siteKey,
        theme: 'auto',
        size: widgetSlot.clientWidth < 300 ? 'compact' : 'flexible',
        callback: (token) => run(url, { token, byUser: true }),
        'error-callback': () => showError({ title: 'The verification did not work.', message: 'Reload the page and try again. Browser extensions that block scripts can stop it.' }),
        'expired-callback': () => {
          if (widgetId !== null) turnstile.reset(widgetId);
        },
      });
    } catch {
      verifyBox.hidden = true;
      showError({ title: 'The verification could not load.', message: 'A browser extension or network filter may be blocking challenges.cloudflare.com. Allow it, or try again later.' });
    }
  }

  function fill(id, nodes) {
    const node = $(id);
    if (node) node.replaceChildren(...nodes);
    return node;
  }

  function render(result) {
    const cta = ctaHref(ctaTitle(result));

    // 1. The app's approximate preview, first.
    fill('platform-preview', [previewFigure(platform, result)]);
    const notes = mockupModel(platform, result).notes;
    const notesBox = fill('platform-preview-notes', notes.map((note) => el('p', {}, note)));
    if (notesBox) notesBox.hidden = notes.length === 0;
    for (const link of document.querySelectorAll('[data-fix-link]')) link.setAttribute('href', cta);
    const compare = $('platform-compare');
    if (compare) compare.setAttribute('href', checkerHref(result.url));

    // 2. The verdict: general checks plus the app's own.
    const v = platformVerdict(platform, result);
    const card = $('platform-verdict');
    if (card) card.dataset.tone = v.tone;
    fill('platform-verdict-title', [v.title]);
    fill('platform-verdict-text', [v.text]);
    const meta = [['Checked', cleanText(result.url)]];
    const finalUrl = cleanText(result.final_url);
    if (finalUrl && finalUrl !== cleanText(result.url)) meta.push(['Redirected to', finalUrl]);
    if (Number.isInteger(result.status)) meta.push(['HTTP status', String(result.status)]);
    const fetched = new Date(result.fetched_at);
    const expires = new Date(result.expires_at);
    if (!Number.isNaN(fetched.getTime())) {
      meta.push([
        result.cached ? 'Cached result from' : 'Fetched at',
        result.cached && !Number.isNaN(expires.getTime()) ? `${clockTime(fetched)}; a fresh fetch is possible after ${clockTime(expires)}` : clockTime(fetched),
      ]);
    }
    fill('platform-verdict-meta', meta.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]));

    // 3. The app's own checks (Discord, X), then the general checklist.
    fill('platform-checks', sortPlatformChecks(platformChecks(platform, result)).map((item) => checkItem(item, cta)));
    fill('platform-checklist', sortPlatformChecks(result.checks).map((item) => checkItem(item, cta)));

    // 4. The image and the tags.
    fill('platform-facts', factRows(result.image).flatMap(([term, value]) => [el('dt', {}, term), value === null ? el('dd', { class: 'muted' }, 'Unknown') : el('dd', {}, value)]));
    const factsImage = fill('platform-facts-image', proxySrc(result.preview.image) ? [imageBox(result.preview.image, 'facts-img')] : []);
    if (factsImage) factsImage.hidden = factsImage.childElementCount === 0;
    fill(
      'platform-tags',
      tagRows(result).map(([name, value]) => el('tr', {}, el('th', { scope: 'row' }, el('code', {}, name)), value === null ? el('td', {}, el('span', { class: 'muted' }, 'Not set')) : el('td', {}, value))),
    );

    results.hidden = false;
  }

  async function run(url, { token = null, byUser = false } = {}) {
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    currentUrl = url;
    errorBox.hidden = true;
    if (!token) clearVerify();
    if (byUser) {
      try {
        history.replaceState(null, '', shareUrlFor(platform, url));
      } catch {
        // Some embedded browsers refuse; the check still runs.
      }
    }
    setBusy(true);
    status.textContent = 'Fetching the page and its image…';

    let response;
    let body = null;
    try {
      response = await fetch(checkRequestUrl(url, token), { headers: { accept: 'application/json' }, credentials: 'same-origin', signal });
      body = await response.json().catch(() => null);
    } catch {
      if (signal.aborted) return;
      response = null;
    }
    if (signal.aborted) return;
    setBusy(false);
    if (token) clearVerify();

    if (response?.ok && isResult(body)) {
      await loadStylesheet();
      if (signal.aborted) return;
      render(body);
      status.textContent = `Check finished. ${platformVerdict(platform, body).title}`;
      // Only a check the visitor started moves focus; a shared ?url= link leaves them at the form.
      if (byUser) $('platform-results-title')?.focus();
      return;
    }
    const problem = response?.ok
      ? { code: null, title: 'The checker sent an answer this page could not read.', message: 'Reload the page and try again.', retryAt: null, siteKey: null }
      : describeError(response ? response.status : 0, body, { retryAfter: response ? retryAfterSeconds(response.headers.get('retry-after')) : null });
    results.hidden = true;
    status.textContent = problem.title;
    if (problem.code === 'verification_required' && problem.siteKey) {
      const verifyText = $('platform-verify-text');
      if (verifyText) verifyText.textContent = problem.message;
      if (byUser) input.focus();
      showVerify(problem.siteKey, url);
      return;
    }
    showError(problem);
    if (byUser) input.focus();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = normaliseInput(input.value);
    if (parsed.error) {
      input.setAttribute('aria-invalid', 'true');
      showError({ title: 'Check the address.', message: parsed.error });
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    input.value = parsed.url;
    run(parsed.url, { byUser: true });
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));

  const shared = new URLSearchParams(location.search).get('url');
  if (shared) {
    input.value = shared;
    const parsed = normaliseInput(shared);
    if (parsed.error) showError({ title: 'Check the address.', message: parsed.error });
    else run(parsed.url);
  }
}

if (typeof document !== 'undefined') init();
