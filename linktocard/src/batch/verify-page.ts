/**
 * The public certificate verification page, GET /v/{id}, and its JSON twin, GET /v/{id}.json.
 * The Worker renders them (the record lives in D1), in the static site's own markup and
 * stylesheet, so the page looks like the site's other simple pages (sign-in, 404).
 *
 * Why this shape:
 *   - Every value that came from a customer's row is escaped (text and attributes alike), has
 *     control characters removed, and sits in its own <bdi>, so a name with right-to-left
 *     override characters cannot reorder the page's own words around it ("Valid", the id).
 *   - No inline script or style at all, and no script file either: the page works without
 *     JavaScript, so its own Content-Security-Policy (VERIFY_PAGE_CSP) allows none and is stricter
 *     than the static site's (site/public/_headers, which does not apply to Worker responses).
 *     tests/verify-page.test.ts checks both, and that site.css loads nothing from elsewhere.
 *   - noindex twice (meta tag and X-Robots-Tag): a record is public to whoever holds its link,
 *     not to search engines. robots.txt must NOT disallow /v/, or crawlers could not read the
 *     noindex. Titles and link-preview tags carry no recipient name, so a shared link does not
 *     put one into a chat app's preview.
 *   - The header is a copy of site/partials (header.html, logo.html) and the <head> follows
 *     site/layouts/base.html, with site.config.json's values. The footer is the static site's own:
 *     the site build publishes the footer of its pages, with that build's feature links, as
 *     /assets/partials/footer.html (scripts/build-site.ts FOOTER_ASSET), and loadSiteFooter() reads
 *     it through env.ASSETS once per isolate. It is the build's own markup, so it is printed as it
 *     is, after a check that it is one <footer class="site-footer"> with nothing a strict CSP would
 *     block. When the asset is missing or fails the check, siteFooter() stands in: a copy of the
 *     partial with only what every site build has (all feature blocks dropped).
 *     tests/verify-page.test.ts fails when the partials change, so these copies cannot drift silently.
 *   - The status and the issuing account's domain are the only things Link To Card vouches for;
 *     the fixed disclaimer says so on every record.
 *   - Never cached (Cache-Control: no-store): a revocation shows on the next request.
 */
import siteConfig from '../../site/site.config.json';
import { BATCH } from '../config';
import type { IssuerKind } from './issuer';
import { verifyUrl, type CertificateRecord, type CertificateStatus } from './certificates';

/** The fixed disclaimer of every record (contract T1). */
export const VERIFY_DISCLAIMER =
  "Link To Card confirms that this record was created by that account. It does not verify the issuer's identity, accreditation or the facts stated.";

/**
 * The page's Content-Security-Policy: same-origin styles, images and fonts, nothing else (no
 * script, no form, no frame, no base). Every source here is also allowed by the static site's
 * policy, so nothing the site's stylesheet needs is blocked.
 */
export const VERIFY_PAGE_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface VerifyContext {
  /** Public origin, e.g. https://linktocard.com (env.APP_URL). */
  appUrl: string;
  /** env.SUPPORT_EMAIL: the report link and the stand-in footer. */
  supportEmail: string;
  now: number;
  /** The static site's footer (loadSiteFooter); null or absent: siteFooter() stands in. */
  footer?: string | null;
}

/** GET /v/{id}.json */
export interface VerifyJson {
  id: string;
  status: CertificateStatus;
  verify_url: string;
  recipient_name: string | null;
  title: string | null;
  achievement: string | null;
  issuer_name: string | null;
  date: string | null;
  issued_at: string;
  revoked_at: string | null;
  issued_by: { kind: IssuerKind; email_domain: string | null; statement: string };
  disclaimer: string;
}

/* ------------------------------------------------------------------ */
/* Escaping and small formatters                                       */
/* ------------------------------------------------------------------ */

/** C0 and C1 control characters except tab and line feed; DEL. They have no business on a certificate. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function escapeHtml(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A customer's value: escaped and isolated from the surrounding text's direction. */
const customer = (value: string): string => `<bdi>${escapeHtml(value)}</bdi>`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "26 November 2026" (UTC), the site's long date format, without depending on Intl data. */
export function longDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const timeElement = (ms: number): string => `<time datetime="${isoDay(ms)}">${longDate(ms)}</time>`;
const origin = (appUrl: string): string => appUrl.replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* The site's shell (copies of site/partials and site/layouts/base.html) */
/* ------------------------------------------------------------------ */

const SITE_NAME = siteConfig.name;

const LOGO = [
  '<svg class="brand-mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false">',
  '<rect class="brand-mark-shadow" x="7" y="9" width="23" height="18" rx="4.5"/>',
  '<rect class="brand-mark-card" x="2" y="4" width="23" height="18" rx="4.5"/>',
  '<rect class="brand-mark-image" x="6.5" y="8.5" width="14" height="5" rx="1.5"/>',
  '<path class="brand-mark-line" d="M7.5 17.5h8"/>',
  '</svg>',
].join('\n');

const BRAND = [`<a class="brand" href="/" aria-label="${escapeHtml(SITE_NAME)} home">`, LOGO, `<span class="brand-name">${escapeHtml(SITE_NAME)}</span>`, '</a>'].join('\n');

/** site/partials/header.html */
export function siteHeader(): string {
  return [
    '<header class="site-header">',
    '<div class="container site-header-inner">',
    BRAND,
    '<nav class="site-nav" aria-label="Main">',
    '<a href="/docs">Docs</a>',
    '<a href="/pricing">Pricing</a>',
    '<a href="/login">Sign in</a>',
    '<a class="btn btn-primary btn-sm" href="/login">Start free</a>',
    '</nav>',
    '</div>',
    '</header>',
  ].join('\n');
}

/**
 * The stand-in footer: site/partials/footer.html without its feature blocks, only links every site
 * build has. Printed when the static site's own footer (loadSiteFooter) is not available.
 */
export function siteFooter(supportEmail: string, now: number): string {
  const email = escapeHtml(supportEmail);
  const year = new Date(now).getUTCFullYear();
  return [
    '<footer class="site-footer">',
    '<div class="container">',
    '<div class="footer-grid">',
    '<div class="footer-brand">',
    BRAND,
    '<p>Turn every link into a beautiful share card.</p>',
    '<a class="btn btn-primary btn-sm" href="/login">Start free</a>',
    '</div>',
    '<nav aria-label="Product">',
    '<h2>Product</h2>',
    '<ul>',
    '<li><a href="/pricing">Pricing</a></li>',
    '<li><a href="/docs">Docs</a></li>',
    '<li><a href="/login">Sign in</a></li>',
    '</ul>',
    '</nav>',
    '<nav aria-label="Compare">',
    '<h2>Compare</h2>',
    '<ul>',
    '<li><a href="/compare/bannerbear">vs Bannerbear</a></li>',
    '<li><a href="/compare/vercel-og">vs Vercel OG</a></li>',
    '</ul>',
    '</nav>',
    '<nav aria-label="Legal">',
    '<h2>Legal</h2>',
    '<ul>',
    '<li><a href="/terms">Terms of service</a></li>',
    '<li><a href="/privacy">Privacy policy</a></li>',
    '<li><a href="/refund">Refund policy</a></li>',
    '</ul>',
    '</nav>',
    '<nav aria-label="Support">',
    '<h2>Support</h2>',
    '<ul>',
    '<li><a href="/contact">Contact</a></li>',
    `<li><a href="mailto:${email}">${email}</a></li>`,
    '</ul>',
    '</nav>',
    '</div>',
    '<div class="footer-bottom">',
    `<p class="footer-seller">&copy; ${year} ${escapeHtml(SITE_NAME)} &middot; ${escapeHtml(siteConfig.legalName)} &middot; ${escapeHtml(siteConfig.legalLocality)} &middot; <a href="mailto:${email}">${email}</a></p>`,
    '<p class="footer-legal-links"><a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/refund">Refunds</a> &middot; <a href="/pricing">Pricing</a></p>',
    '<p>Payments secured by Paddle, our Merchant of Record.</p>',
    '<p>AI tools were used to help build this product. A human reviews every release.</p>',
    '<p>Emoji graphics by <a href="/_emoji/LICENSE.txt">Twemoji</a> (CC-BY 4.0).</p>',
    '</div>',
    '</div>',
    '</footer>',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* The site's own footer, from the static assets                        */
/* ------------------------------------------------------------------ */

/** Where the site build publishes the footer of its pages (scripts/build-site.ts FOOTER_ASSET). */
export const SITE_FOOTER_ASSET = '/assets/partials/footer.html';

/** env.ASSETS answers any host; this one only names the request. */
const ASSET_ORIGIN = 'https://assets.local';

/** Far more than the footer needs (about 2 KB); anything larger is not the footer. */
const MAX_FOOTER_CHARS = 32 * 1024;

/** The part of the Workers static-assets binding (env.ASSETS) the footer needs. */
export interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

/**
 * True for markup the page may print unescaped as its footer: exactly one <footer class="site-footer">
 * element, and nothing in it that runs, styles, frames, submits or loads from elsewhere. The page's
 * CSP would block such things anyway; the check keeps a wrong file from reaching the page at all.
 */
export function isSiteFooter(html: string): boolean {
  return (
    html.length <= MAX_FOOTER_CHARS &&
    /^<footer class="site-footer">[\s\S]*<\/footer>$/.test(html) &&
    (html.match(/<\/?footer\b/gi) ?? []).length === 2 &&
    !/<(?:script|style|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|base|meta|link|img|image|use|foreignobject|animate|set|audio|video|source|picture|portal)\b/i.test(html) &&
    !/\s(?:on[a-z]+|style|srcdoc|formaction)\s*=/i.test(html) &&
    !/\s(?:href|src|xlink:href|action)\s*=\s*["']?\s*(?:javascript|vbscript|data):/i.test(html)
  );
}

const footers = new WeakMap<AssetFetcher, Promise<string | null>>();

async function fetchSiteFooter(assets: AssetFetcher): Promise<string | null> {
  try {
    let response = await assets.fetch(new Request(`${ASSET_ORIGIN}${SITE_FOOTER_ASSET}`, { redirect: 'manual' }));
    // html_handling "auto-trailing-slash" may answer /x.html with a redirect to /x: follow it once, on the assets only.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      const next = location === null ? null : new URL(location, `${ASSET_ORIGIN}${SITE_FOOTER_ASSET}`);
      if (next === null || next.origin !== ASSET_ORIGIN) return null;
      response = await assets.fetch(new Request(next.href, { redirect: 'manual' }));
    }
    // A missing asset comes back as the site's 404 page (HTML, status 404): only a 200 counts.
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
      await response.body?.cancel();
      return null;
    }
    const html = (await response.text()).trim();
    return isSiteFooter(html) ? html : null;
  } catch {
    return null;
  }
}

/**
 * The footer of the static site as deployed with this Worker, or null when the asset is missing or
 * is not a footer (then the page prints siteFooter()). Loaded once per isolate and assets binding;
 * a miss is not kept, so the next request tries again.
 */
export function loadSiteFooter(assets: AssetFetcher | undefined): Promise<string | null> {
  if (!assets) return Promise.resolve(null);
  const cached = footers.get(assets);
  if (cached) return cached;
  const loading = fetchSiteFooter(assets).then((footer) => {
    if (footer === null) footers.delete(assets);
    return footer;
  });
  footers.set(assets, loading);
  return loading;
}

interface Shell {
  /** Page title without the site name. */
  title: string;
  description: string;
  /** Path of the canonical URL, e.g. /v/crt_... */
  path: string;
  main: string;
}

/** site/layouts/base.html: the same <head> (noindex), header and footer; no site.js (nothing on the page needs it). */
function documentHtml(shell: Shell, ctx: VerifyContext): string {
  const base = origin(ctx.appUrl);
  const title = escapeHtml(`${shell.title} - ${SITE_NAME}`);
  const description = escapeHtml(shell.description);
  const canonical = escapeHtml(`${base}${shell.path}`);
  const image = escapeHtml(`${base}/assets/img/og.png`);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    '<meta name="robots" content="noindex">',
    `<link rel="canonical" href="${canonical}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${image}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${image}">`,
    '<meta name="theme-color" content="#f6efe0" media="(prefers-color-scheme: light)">',
    '<meta name="theme-color" content="#171510" media="(prefers-color-scheme: dark)">',
    '<link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml">',
    '<link rel="preload" href="/assets/fonts/inter-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/assets/fonts/source-serif-4-latin-900-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/assets/css/site.css">',
    '</head>',
    '<body>',
    '<a class="skip-link" href="#content">Skip to content</a>',
    siteHeader(),
    '<div id="content" tabindex="-1">',
    shell.main,
    '</div>',
    ctx.footer ?? siteFooter(ctx.supportEmail, ctx.now),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

function reportHref(record: Pick<CertificateRecord, 'id'>, ctx: VerifyContext): string {
  const subject = `Report certificate ${record.id}`;
  const body = `Certificate: ${verifyUrl(ctx.appUrl, record.id)}\n\nWhat is wrong with it:\n`;
  return `mailto:${ctx.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function issuedByHtml(record: CertificateRecord): string {
  const { issuer } = record;
  if (issuer.kind === 'domain' && issuer.domain !== null) {
    return `<p class="alert alert-info">Issued by a Link To Card account verified at <strong>@${escapeHtml(issuer.domain)}</strong>, the domain of the email address the account signs in with.</p>`;
  }
  return `<p class="alert alert-info">${escapeHtml(issuer.statement)}.</p>`;
}

/** The record page: status, the facts as the issuer gave them, the issuing account, the disclaimer. */
export function verifyPageHtml(record: CertificateRecord, ctx: VerifyContext): string {
  const revoked = record.status === 'revoked' && record.revokedAt !== null;
  const facts: Array<[string, string]> = [];
  const add = (label: string, value: string | null): void => {
    if (value !== null && value !== '') facts.push([label, customer(value)]);
  };
  add('Recipient', record.recipientName);
  add('Title', record.title);
  add('Achievement', record.achievement);
  add('Issuer name', record.issuerName);
  add('Date', record.date);
  facts.push(['Certificate ID', `<code>${escapeHtml(record.id)}</code>`]);
  facts.push(['Recorded', timeElement(record.createdAt)]);
  facts.push(['Status', revoked ? `Revoked on ${timeElement(record.revokedAt!)}` : 'Valid']);

  const main = [
    '<main class="container auth">',
    '<div class="card card-pop auth-card">',
    revoked ? '<p><span class="badge badge-danger">Revoked</span></p>' : '<p><span class="badge badge-ok">Valid</span></p>',
    '<h1>Certificate record</h1>',
    revoked
      ? `<p class="alert alert-danger"><strong>This certificate was revoked on ${timeElement(record.revokedAt!)}.</strong> Do not treat it as valid.</p>`
      : '<p class="muted">This record exists on Link To Card and has not been revoked.</p>',
    '<dl class="facts">',
    ...facts.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`),
    '</dl>',
    '<p class="hint">The recipient, title, achievement, issuer name and date are shown as the issuer entered them.</p>',
    issuedByHtml(record),
    `<p class="hint">${escapeHtml(VERIFY_DISCLAIMER)}</p>`,
    '<div class="cluster">',
    `<a class="btn btn-sm" href="${escapeHtml(reportHref(record, ctx))}">Report this certificate</a>`,
    `<a href="/v/${escapeHtml(record.id)}.json">This record as JSON</a>`,
    '</div>',
    '</div>',
    '</main>',
  ].join('\n');

  return documentHtml(
    {
      title: revoked ? 'Revoked certificate' : 'Certificate record',
      description: `Verification record of a certificate issued through ${SITE_NAME}.`,
      path: `/v/${record.id}`,
      main,
    },
    ctx,
  );
}

/**
 * No record to show: an unknown id, one revoked longer ago than the retention period, or an
 * account that is suspended or being deleted. The page says only what is true in every case.
 * `id` is the canonical id when the link held a well-formed one, otherwise null.
 */
export function notFoundPageHtml(id: string | null, ctx: VerifyContext): string {
  const what =
    id === null
      ? '<p class="muted">This link does not hold a certificate ID. IDs start with <code>crt_</code> followed by 20 letters and digits.</p>'
      : `<p class="muted">${escapeHtml(SITE_NAME)} has no certificate record it can show for <code>${escapeHtml(id)}</code>. Check the ID against the certificate.</p>`;
  const main = [
    '<main class="container auth lost">',
    '<h1>No certificate record found.</h1>',
    what,
    `<p class="muted">Revoked records are kept for ${BATCH.revokedRetentionDays} days, and all records of an account are deleted with the account.</p>`,
    '<div class="cluster">',
    '<a class="btn btn-secondary" href="/">Back to the home page</a>',
    '</div>',
    '</main>',
  ].join('\n');
  return documentHtml(
    { title: 'Certificate not found', description: `No certificate record with this ID on ${SITE_NAME}.`, path: id === null ? '/v/' : `/v/${id}`, main },
    ctx,
  );
}

/** Verification switched off (BATCH_ENABLED is not "true"). */
export function unavailablePageHtml(ctx: VerifyContext): string {
  const main = [
    '<main class="container auth lost">',
    '<h1>Certificate verification is not available right now.</h1>',
    '<p class="muted">Try the link again later.</p>',
    '<div class="cluster">',
    '<a class="btn btn-secondary" href="/">Back to the home page</a>',
    '</div>',
    '</main>',
  ].join('\n');
  return documentHtml({ title: 'Verification unavailable', description: `Certificate verification on ${SITE_NAME}.`, path: '/v/', main }, ctx);
}

/** GET /v/{id}.json: the same facts as the page, values unescaped (JSON consumers escape for their own output). */
export function verifyJson(record: CertificateRecord, ctx: VerifyContext): VerifyJson {
  return {
    id: record.id,
    status: record.status,
    verify_url: verifyUrl(ctx.appUrl, record.id),
    recipient_name: record.recipientName,
    title: record.title,
    achievement: record.achievement,
    issuer_name: record.issuerName,
    date: record.date,
    issued_at: new Date(record.createdAt).toISOString(),
    revoked_at: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
    issued_by: { kind: record.issuer.kind, email_domain: record.issuer.domain, statement: record.issuer.statement },
    disclaimer: VERIFY_DISCLAIMER,
  };
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export function verifyHtmlResponse(html: string, status: 200 | 404 | 503): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': VERIFY_PAGE_CSP,
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex',
    },
  });
}

/** Public JSON: any site may read it from a browser (no credentials, nothing beyond the page). */
export function verifyJsonResponse(body: VerifyJson): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-robots-tag': 'noindex',
    },
  });
}
