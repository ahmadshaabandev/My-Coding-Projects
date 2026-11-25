// The free Open Graph checker (/tools/og-checker): one URL in; the verdict, six
// approximate link previews, the checklist, the parsed tags and the image facts out.
//
// API (see the feature contract): GET /api/tools/og-check?url=<url>[&turnstile=<token>]
// answers a CheckResult or the usual { error: { code, message, details } } body.
//
// Everything that comes from the checked page is third-party text. It is set only
// with textContent (or as an attribute value on alt/datetime), never parsed as HTML.
// Images are shown only through our own proxy paths, so the site CSP keeps img-src 'self'.

export const API_PATH = '/api/tools/og-check';
export const PAGE_PATH = '/tools/og-checker';
export const CTA_TEXT = 'Fix it automatically: generate a correct card with Link To Card';
export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const MAX_URL_CHARS = 2048;

/**
 * Character budgets used by the mockups. These are APPROXIMATE and our own choice:
 * the apps cut text by width and line count, and none of the numbers below is a
 * published limit. A budget of 0 means the mockup does not show that text.
 */
export const PREVIEW_LIMITS = {
  facebook: { title: 88, description: 110 },
  x: { title: 70, description: 0 },
  whatsapp: { title: 65, description: 90 },
  slack: { title: 80, description: 160 },
  discord: { title: 100, description: 220 },
  imessage: { title: 60, description: 0 },
};

export const PLATFORMS = [
  { id: 'facebook', name: 'Facebook / LinkedIn' },
  { id: 'x', name: 'X, large image card' },
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'slack', name: 'Slack' },
  { id: 'discord', name: 'Discord' },
  { id: 'imessage', name: 'iMessage' },
];

/** Most characters of the title carried into the sign-up link, once percent-encoded (safeNextPath allows 512 for the whole path). */
const MAX_PREFILL_ENCODED = 400;
const PROXY_PATH = /^\/api\/tools\/og-check\/chk_[0-9a-z]{1,64}\/(?:image|favicon)$/;
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Collapses whitespace and replaces broken surrogate halves, so the text is safe to count and to encode. */
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(LONE_SURROGATE, '�').replace(/\s+/g, ' ').trim();
}

/** Cuts text to at most `max` characters (code points), ending with an ellipsis when it was cut. */
export function truncate(text, max) {
  const clean = cleanText(text);
  if (!(max > 0)) return '';
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** The text one mockup shows: title and description cut to that platform's approximate budget. */
export function previewText(platform, preview) {
  const limits = PREVIEW_LIMITS[platform];
  if (!limits) throw new Error(`Unknown platform "${platform}"`);
  const source = preview && typeof preview === 'object' ? preview : {};
  return {
    title: truncate(source.title, limits.title),
    description: truncate(source.description, limits.description),
    domain: cleanText(source.domain),
    siteName: cleanText(source.site_name),
  };
}

/** The sign-up link that opens the dashboard's first-run guide with the page title filled in. */
export function ctaHref(title) {
  let chars = Array.from(cleanText(title)).slice(0, MAX_PREFILL_ENCODED);
  while (chars.length > 0 && encodeURIComponent(chars.join('')).length > MAX_PREFILL_ENCODED) chars = chars.slice(0, -1);
  const kept = chars.join('').trim();
  const next = kept ? `/dashboard?title=${encodeURIComponent(kept)}` : '/dashboard';
  return `/login?next=${encodeURIComponent(next)}`;
}

/** The title the call-to-action carries: what the previews show, else the page's own tags. */
export function ctaTitle(result) {
  return cleanText(result?.preview?.title) || cleanText(result?.og?.title) || cleanText(result?.page?.title);
}

/** What the visitor typed, as the URL to check: trimmed, with https:// added when no scheme was given. */
export function normaliseInput(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return { error: 'Paste a page URL first, for example https://example.com/blog/my-post.' };
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  if (url.length > MAX_URL_CHARS) return { error: `That URL is longer than ${MAX_URL_CHARS.toLocaleString('en-US')} characters. Paste the page address without extra tracking parameters.` };
  if (/^http:\/\//i.test(url)) return { error: 'Only https:// pages can be checked. Try the same address with https://.' };
  if (!/^https:\/\//i.test(url)) return { error: 'That is not a web page address. Paste a URL that starts with https://.' };
  return { url };
}

/** The address-bar URL for a check, so a result can be shared. */
export function shareUrl(url) {
  return `${PAGE_PATH}?${new URLSearchParams({ url })}`;
}

/** The API request for a check; the Turnstile token rides along only on the retry after a challenge. */
export function checkRequestUrl(url, token) {
  const query = new URLSearchParams({ url });
  if (token) query.set('turnstile', token);
  return `${API_PATH}?${query}`;
}

/** Our own image proxy path, or null for anything else (the page never shows an image from another origin). */
export function proxySrc(path) {
  return typeof path === 'string' && PROXY_PATH.test(path) ? path : null;
}

/** A theme-color usable as a CSS value, or null. Only plain hex colours are accepted. */
export function safeColour(value) {
  const text = cleanText(value);
  return HEX_COLOUR.test(text) ? text : null;
}

const PAGE_FETCH_REASONS = [
  [/timeout|timed_out/, 'The page did not answer in time. The checker waits 5 seconds for the whole page.'],
  [/dns|resolve|nxdomain/, 'The domain name could not be found. Check the spelling, and that the site is online.'],
  [/tls|ssl|cert/, 'The secure connection failed. The site\'s certificate may be expired, self-signed or issued for another name.'],
  [/html|content_type|not_page|mime/, 'The address answered with something that is not an HTML page, such as an image or a PDF. Paste the URL of the page that is shared, not of its image.'],
  [/insecure_redirect/, 'The address redirected to a plain http:// address. The checker only follows https:// redirects.'],
  [/bad_redirect/, 'The address answered with a redirect that does not point to a valid URL.'],
  [/redirect/, 'The address redirected more than 3 times, so the checker stopped following it.'],
  [/too_large/, 'The answer was larger than the checker reads, so it stopped. Check that the URL is a normal web page.'],
  [/http|status/, null],
  [/connect|network|refused|reset/, 'The site did not accept the connection. It may be down, or blocking automated requests.'],
];

/** The plain sentence for a page_fetch_failed reason; unknown reasons fall back to the server's own message. */
export function fetchFailureText(details, serverMessage) {
  const reason = String(details?.reason ?? '').toLowerCase();
  for (const [pattern, text] of PAGE_FETCH_REASONS) {
    if (!pattern.test(reason)) continue;
    if (text) return text;
    const status = Number(details?.status);
    if (Number.isInteger(status) && status > 0) return `The site answered with HTTP ${status}, not with the page. Open the URL in a private window: it should load without a login.`;
    break;
  }
  return serverMessage || 'The page could not be fetched. Open it in a private browser window to check that it loads for everyone.';
}

/** Seconds from a Retry-After header (seconds or HTTP date), or null. */
export function retryAfterSeconds(header, now = new Date()) {
  if (header === null || header === undefined || header === '') return null;
  const text = String(header).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/**
 * The friendly message for a failed check.
 * @param status  HTTP status (0 when the request never reached us)
 * @param body    the parsed JSON body, if any
 * @returns { code, title, message, retryAt: Date|null, siteKey: string|null }
 */
export function describeError(status, body, { retryAfter = null, now = new Date() } = {}) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const code = typeof error.code === 'string' ? error.code : null;
  const details = error.details && typeof error.details === 'object' ? error.details : {};
  const serverMessage = cleanText(error.message);
  const base = { code, retryAt: null, siteKey: null };

  if (status === 0) {
    return { ...base, code: 'network', title: 'Link To Card could not be reached.', message: 'Check your internet connection, then try again.' };
  }
  switch (code) {
    case 'invalid_request':
      return { ...base, title: 'That address cannot be checked.', message: serverMessage || 'Paste the full address of a public page. It must start with https:// and be at most 2,048 characters long.' };
    case 'forbidden':
      return { ...base, title: 'That address is not on the public internet.', message: 'It points to a private, local or reserved network address, so the checker will not fetch it. Only public websites can be checked.' };
    case 'page_fetch_failed':
      return { ...base, title: 'We could not fetch that page.', message: fetchFailureText(details, serverMessage) };
    case 'verification_required': {
      const siteKey = typeof details.site_key === 'string' && details.site_key ? details.site_key : null;
      return {
        ...base,
        siteKey,
        title: 'Please confirm you are a person.',
        message: siteKey
          ? 'You have run several checks this hour. Complete the quick check below and your result loads straight away.'
          : 'A verification step is needed, but it could not be shown. Wait a few minutes, then try again.',
      };
    }
    case 'rate_limited': {
      const fromDetails = Number(details.retry_after);
      const seconds = retryAfter ?? (Number.isFinite(fromDetails) && fromDetails >= 0 ? fromDetails : null);
      const retryAt = seconds === null ? null : new Date(now.getTime() + seconds * 1000);
      const minutes = seconds === null ? null : Math.max(1, Math.ceil(seconds / 60));
      return {
        ...base,
        retryAt,
        title: 'That is the free limit for this hour.',
        message:
          retryAt === null
            ? 'Too many fresh checks came from your network this hour. Try again at the start of the next hour.'
            : `Too many fresh checks came from your network this hour. Try again after ${clockTime(retryAt)} (in about ${minutes} minute${minutes === 1 ? '' : 's'}).`,
      };
    }
    default:
      break;
  }
  if (status === 429) return { ...base, code: 'rate_limited', title: 'Too many requests.', message: 'Wait a minute, then try again.' };
  if (status >= 500) return { ...base, title: 'The checker had a problem.', message: `The server answered HTTP ${status}. Wait a minute, then try again.` };
  return { ...base, title: 'The check failed.', message: serverMessage || `The server answered HTTP ${status}. Reload the page and try again.` };
}

/** "14:05" in the visitor's own clock format. */
export function clockTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The headline for a result: ok when nothing failed or warned. */
export function verdict(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const fails = list.filter((check) => check?.status === 'fail').length;
  const warns = list.filter((check) => check?.status === 'warn').length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (fails > 0) {
    return {
      tone: 'fail',
      title: `${plural(fails, 'problem')} to fix${warns ? `, ${plural(warns, 'warning')}` : ''}.`,
      text: 'Some apps will show this link without a proper card, or with the wrong image. The checklist below says what to change.',
    };
  }
  if (warns > 0) {
    return { tone: 'warn', title: `Good to share, with ${plural(warns, 'warning')}.`, text: 'The basics are in place. The warnings below can make the card look worse in some apps.' };
  }
  return { tone: 'ok', title: 'Ready to share.', text: 'Every check passed. Apps have what they need to show a card for this link.' };
}

const STATUS_ORDER = { fail: 0, warn: 1, pass: 2 };
/** Failures first, then warnings, then passes; the API's order is kept within each group. */
export function sortChecks(checks) {
  return (Array.isArray(checks) ? checks : [])
    .map((check, index) => ({ check, index }))
    .sort((a, b) => (STATUS_ORDER[a.check?.status] ?? 3) - (STATUS_ORDER[b.check?.status] ?? 3) || a.index - b.index)
    .map(({ check }) => check);
}

/** "1.2 MB (1,234,567 bytes)" */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const exact = `${Math.round(bytes).toLocaleString('en-US')} bytes`;
  if (bytes < 1024) return exact;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit} (${exact})`;
}

/** "1.91:1" */
export function formatRatio(ratio) {
  return Number.isFinite(ratio) && ratio > 0 ? `${ratio.toFixed(2)}:1` : null;
}

/** The rows of the parsed-tags table, in the order people look for them. */
export function tagRows(result) {
  const og = result?.og ?? {};
  const tw = result?.twitter ?? {};
  const page = result?.page ?? {};
  return [
    ['og:title', og.title],
    ['og:description', og.description],
    ['og:image', og.image],
    ['og:image:alt', og.image_alt],
    ['og:image:width', og.image_width],
    ['og:image:height', og.image_height],
    ['og:url', og.url],
    ['og:type', og.type],
    ['og:site_name', og.site_name],
    ['twitter:card', tw.card],
    ['twitter:title', tw.title],
    ['twitter:description', tw.description],
    ['twitter:image', tw.image],
    ['twitter:site', tw.site],
    ['<title>', page.title],
    ['meta description', page.description],
    ['canonical', page.canonical],
    ['theme-color', page.theme_color],
    ['favicon', page.favicon],
  ].map(([name, value]) => [name, typeof value === 'string' || typeof value === 'number' ? String(value) : null]);
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

function favicon(src) {
  const safe = proxySrc(src);
  if (!safe) return null;
  const img = el('img', { class: 'pv-favicon', src: safe, alt: '', width: 16, height: 16, decoding: 'async' });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

function titleNode(text, domain, tag = 'strong') {
  return text ? el(tag, { class: 'pv-title' }, text) : el(tag, { class: 'pv-title is-missing' }, domain || 'No title');
}

const MOCKUPS = {
  facebook(text, preview) {
    return el(
      'div',
      { class: 'pv-card' },
      imageBox(preview.image, 'pv-img'),
      el('div', { class: 'pv-text' }, el('span', { class: 'pv-domain' }, text.domain), titleNode(text.title, text.domain), text.description ? el('span', { class: 'pv-desc' }, text.description) : null),
    );
  },
  x(text, preview) {
    return el(
      'div',
      { class: 'pv-card' },
      el('div', { class: 'pv-media' }, imageBox(preview.image, 'pv-img'), el('span', { class: 'pv-overlay' }, text.title || text.domain)),
      el('span', { class: 'pv-domain' }, `From ${text.domain}`),
    );
  },
  whatsapp(text, preview, result) {
    return el(
      'div',
      { class: 'pv-bubble' },
      el(
        'div',
        { class: 'pv-card' },
        imageBox(preview.image, 'pv-img'),
        el('div', { class: 'pv-text' }, titleNode(text.title, text.domain), text.description ? el('span', { class: 'pv-desc' }, text.description) : null, el('span', { class: 'pv-domain' }, text.domain)),
      ),
      el('span', { class: 'pv-url' }, truncate(result.url, 70)),
    );
  },
  slack(text, preview) {
    return el(
      'div',
      { class: 'pv-card' },
      el('span', { class: 'pv-site' }, favicon(preview.favicon), text.siteName || text.domain),
      titleNode(text.title, text.domain, 'span'),
      text.description ? el('span', { class: 'pv-desc' }, text.description) : null,
      proxySrc(preview.image) ? imageBox(preview.image, 'pv-img') : null,
    );
  },
  discord(text, preview, result) {
    const card = el(
      'div',
      { class: 'pv-card' },
      text.siteName ? el('span', { class: 'pv-site' }, text.siteName) : null,
      titleNode(text.title, text.domain, 'span'),
      text.description ? el('span', { class: 'pv-desc' }, text.description) : null,
      proxySrc(preview.image) ? imageBox(preview.image, 'pv-img') : null,
    );
    const colour = safeColour(result.page?.theme_color);
    if (colour) card.style.setProperty('--pv-accent', colour);
    return card;
  },
  imessage(text, preview) {
    return el('div', { class: 'pv-card' }, imageBox(preview.image, 'pv-img'), el('div', { class: 'pv-text' }, titleNode(text.title, text.domain), el('span', { class: 'pv-domain' }, text.domain)));
  },
};

function previewFigure(platform, result) {
  const preview = result.preview ?? {};
  const text = previewText(platform.id, preview);
  return el(
    'figure',
    { class: `pv pv-${platform.id}` },
    el('figcaption', { class: 'pv-head' }, el('span', { class: 'pv-name' }, platform.name), el('span', { class: 'pv-approx' }, 'Approximate preview')),
    el('div', { class: 'pv-screen' }, MOCKUPS[platform.id](text, preview, result)),
  );
}

const ICONS = { pass: ['✓', 'Pass'], warn: ['!', 'Warning'], fail: ['✕', 'Fail'] };

function checkItem(check, cta) {
  const status = ICONS[check?.status] ? check.status : 'warn';
  const [icon, label] = ICONS[status];
  return el(
    'li',
    { class: `cl-item cl-${status}` },
    el('span', { class: 'cl-icon', 'aria-hidden': 'true' }, icon),
    el(
      'div',
      { class: 'cl-body' },
      el('p', { class: 'cl-title' }, el('span', { class: 'visually-hidden' }, `${label}: `), cleanText(check?.title) || 'Check'),
      cleanText(check?.detail) ? el('p', { class: 'cl-detail' }, cleanText(check.detail)) : null,
      status !== 'pass' && cleanText(check?.fix) ? el('p', { class: 'cl-fix' }, el('strong', {}, 'How to fix: '), cleanText(check.fix)) : null,
      status !== 'pass' ? el('p', { class: 'cl-cta' }, el('a', { class: 'link-arrow', href: cta }, CTA_TEXT)) : null,
    ),
  );
}

function factRows(image) {
  if (!image) return [['Image', 'No og:image or twitter:image tag was found, so there was no image to test.']];
  const dims = Number.isFinite(image.width) && Number.isFinite(image.height) ? `${image.width} × ${image.height} px` : null;
  const ratio = formatRatio(image.aspect_ratio);
  return [
    ['URL', cleanText(image.url) || null],
    ['HTTP status', Number.isInteger(image.status) ? String(image.status) : null],
    ['Type', cleanText(image.content_type) || null],
    ['Size', formatBytes(image.bytes)],
    ['Dimensions', dims],
    ['Aspect ratio', ratio ? `${ratio} (the usual target is 1.91:1)` : null],
    ['Response time', Number.isFinite(image.response_ms) ? `${image.response_ms} ms` : null],
  ];
}

function valueCell(value, tag = 'td') {
  return value === null ? el(tag, {}, el('span', { class: 'muted' }, 'Not set')) : el(tag, {}, value);
}

function isResult(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.checks) && value.preview && typeof value.preview === 'object');
}

function init() {
  const form = document.getElementById('check-form');
  if (!form) return;
  const input = document.getElementById('check-url');
  const submit = document.getElementById('check-submit');
  const status = document.getElementById('check-status');
  const errorBox = document.getElementById('check-error');
  const verifyBox = document.getElementById('check-verify');
  const widgetSlot = document.getElementById('check-widget');
  const results = document.getElementById('results');
  const $ = (id) => document.getElementById(id);

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
        // The flexible widget needs about 300 px; a phone-width form gets the compact one.
        size: widgetSlot.clientWidth < 300 ? 'compact' : 'flexible',
        callback: (token) => run(url, { token, byUser: true }),
        'error-callback': () => {
          showError({ title: 'The verification did not work.', message: 'Reload the page and try again. Browser extensions that block scripts can stop it.' });
        },
        'expired-callback': () => {
          if (widgetId !== null) turnstile.reset(widgetId);
        },
      });
    } catch {
      verifyBox.hidden = true;
      showError({ title: 'The verification could not load.', message: 'A browser extension or network filter may be blocking challenges.cloudflare.com. Allow it, or try again later.' });
    }
  }

  function render(result) {
    const v = verdict(result.checks);
    const card = $('verdict');
    card.dataset.tone = v.tone;
    $('verdict-title').textContent = v.title;
    $('verdict-text').textContent = v.text;

    const meta = [];
    const finalUrl = cleanText(result.final_url);
    meta.push(['Checked', cleanText(result.url)]);
    if (finalUrl && finalUrl !== cleanText(result.url)) meta.push(['Redirected to', finalUrl]);
    if (Number.isInteger(result.status)) meta.push(['HTTP status', String(result.status)]);
    if (Number.isFinite(result.response_ms)) meta.push(['Page response', `${result.response_ms} ms`]);
    const fetched = new Date(result.fetched_at);
    const expires = new Date(result.expires_at);
    if (!Number.isNaN(fetched.getTime())) {
      meta.push([
        result.cached ? 'Cached result from' : 'Fetched at',
        result.cached && !Number.isNaN(expires.getTime()) ? `${clockTime(fetched)}; a fresh fetch is possible after ${clockTime(expires)}` : clockTime(fetched),
      ]);
    }
    $('verdict-meta').replaceChildren(...meta.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]));

    $('previews').replaceChildren(...PLATFORMS.map((platform) => previewFigure(platform, result)));
    const twitterCard = cleanText(result.twitter?.card);
    const xNote = $('previews-note');
    xNote.textContent =
      twitterCard && twitterCard !== 'summary_large_image'
        ? `This page sets twitter:card to "${truncate(twitterCard, 40)}", not summary_large_image, so X may show a smaller layout than the mockup.`
        : '';
    xNote.hidden = xNote.textContent === '';

    const cta = ctaHref(ctaTitle(result));
    $('checklist').replaceChildren(...sortChecks(result.checks).map((check) => checkItem(check, cta)));

    $('facts').replaceChildren(...factRows(result.image).flatMap(([term, value]) => [el('dt', {}, term), value === null ? el('dd', { class: 'muted' }, 'Unknown') : el('dd', {}, value)]));
    const factsImage = $('facts-image');
    factsImage.replaceChildren();
    if (proxySrc(result.preview.image)) factsImage.append(imageBox(result.preview.image, 'facts-img'));
    factsImage.hidden = factsImage.childElementCount === 0;

    $('tags').replaceChildren(...tagRows(result).map(([name, value]) => el('tr', {}, el('th', { scope: 'row' }, el('code', {}, name)), valueCell(value))));

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
        history.replaceState(null, '', shareUrl(url));
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
      render(body);
      status.textContent = `Check finished. ${verdict(body.checks).title}`;
      // Only a check the visitor started moves focus; a shared ?url= link leaves them at the form.
      if (byUser) $('results-title').focus();
      return;
    }
    const problem = response?.ok
      ? { code: null, title: 'The checker sent an answer this page could not read.', message: 'Reload the page and try again.', retryAt: null, siteKey: null }
      : describeError(response ? response.status : 0, body, { retryAfter: response ? retryAfterSeconds(response.headers.get('retry-after')) : null });
    results.hidden = true;
    status.textContent = problem.title;
    if (problem.code === 'verification_required' && problem.siteKey) {
      $('check-verify-text').textContent = problem.message;
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
