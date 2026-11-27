/// <reference path="./fixtures/og/raw.d.ts" />
// The public certificate verification page and its JSON twin (src/batch/verify-page.ts,
// src/routes/verify.ts): escaping of hostile values, valid and revoked records, the JSON shape,
// no inline script or style, a Content-Security-Policy that the static site's own policy would
// also allow, the site's header and stand-in footer copied without drift, the static site's own
// footer read from env.ASSETS (/assets/partials/footer.html, cached, checked, with a stand-in),
// and the routes end to end.
import { env } from 'cloudflare:workers';
import { isTag, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCertificates, newCertificateId, type CertificateRecord } from '../src/batch/certificates';
import { issuerFromEmail } from '../src/batch/issuer';
import {
  isSiteFooter,
  loadSiteFooter,
  longDate,
  notFoundPageHtml,
  SITE_FOOTER_ASSET,
  siteFooter,
  siteHeader,
  unavailablePageHtml,
  VERIFY_DISCLAIMER,
  VERIFY_PAGE_CSP,
  verifyJson,
  verifyPageHtml,
  type VerifyContext,
} from '../src/batch/verify-page';
import { BATCH } from '../src/config';
import { ApiError, errorResponse } from '../src/lib/errors';
import { certificatesApiRouter, certificatesDashboardRouter, verifyRouter } from '../src/routes/verify';
import type { AppEnv, Env } from '../src/types';
import baseLayout from '../site/layouts/base.html?raw';
import footerPartial from '../site/partials/footer.html?raw';
import headerPartial from '../site/partials/header.html?raw';
import logoPartial from '../site/partials/logo.html?raw';
// @ts-expect-error -- Vite raw import; the suite has no vite/client types.
import staticHeaders from '../site/public/_headers?raw';
import siteConfig from '../site/site.config.json';
import { apiKeyFor, bearer, ORIGIN, sessionCookieFor } from './app-helpers';
import { createAccount, ensureCertificatesTable, SAMPLE_ROW } from './batch-certificate-helpers';

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const CTX: VerifyContext = { appUrl: 'https://linktocard.test', supportEmail: 'support@linktocard.test', now: NOW };
const ID = 'crt_0123456789abcdefghjk';

function record(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    id: ID,
    status: 'valid',
    recipientName: 'Amara Nwosu',
    title: 'Certificate of Completion',
    achievement: 'for completing the workshop',
    issuerName: 'Lanternworks Training',
    date: 'November 25, 2026',
    createdAt: NOW,
    revokedAt: null,
    issuer: issuerFromEmail('registrar@lanternworks.org'),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* HTML inspection                                                     */
/* ------------------------------------------------------------------ */

function elements(html: string): Element[] {
  const out: Element[] = [];
  const walk = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (isTag(node as Element)) {
        out.push(node as Element);
        walk((node as Element).children);
      }
    }
  };
  walk(parseDocument(html).children);
  return out;
}

const textOf = (element: Element): string =>
  element.children.map((child) => ('data' in child && child.type === 'text' ? (child.data as string) : isTag(child) ? textOf(child) : '')).join('');

/** dt label -> dd element of the record's facts list. */
function facts(html: string): Map<string, Element> {
  const map = new Map<string, Element>();
  const list = elements(html).find((element) => element.name === 'dl' && element.attribs.class === 'facts');
  expect(list).toBeDefined();
  const items = list!.children.filter(isTag);
  for (let index = 0; index < items.length; index += 2) map.set(textOf(items[index]!), items[index + 1]!);
  return map;
}

/** Everything a strict CSP without 'unsafe-inline' would block, or a page could run. */
function inlineCode(html: string): string[] {
  const found: string[] = [];
  for (const element of elements(html)) {
    if (element.name === 'script') found.push(`<script ${JSON.stringify(element.attribs)}>`);
    if (element.name === 'style') found.push('<style>');
    for (const [name, value] of Object.entries(element.attribs)) {
      if (name === 'style') found.push(`${element.name}[style]`);
      if (/^on/i.test(name)) found.push(`${element.name}[${name}]`);
      if (/^\s*(?:javascript|vbscript|data):/i.test(value) && name !== 'content') found.push(`${element.name}[${name}=${value}]`);
    }
  }
  return found;
}

/** URLs the page makes the browser load (stylesheet, icon, preloads, images, scripts). */
function loadedUrls(html: string): string[] {
  const urls: string[] = [];
  for (const element of elements(html)) {
    if (element.name === 'link' && /\b(?:stylesheet|icon|preload|modulepreload|manifest)\b/.test(element.attribs.rel ?? '')) urls.push(element.attribs.href ?? '');
    if (['img', 'script', 'iframe', 'source', 'video', 'audio', 'object', 'embed'].includes(element.name)) urls.push(element.attribs.src ?? element.attribs.data ?? '');
  }
  return urls;
}

/* ------------------------------------------------------------------ */
/* Content-Security-Policy                                             */
/* ------------------------------------------------------------------ */

type Policy = Map<string, string[]>;

function parseCsp(value: string): Policy {
  const policy: Policy = new Map();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) policy.set(name.toLowerCase(), sources);
  }
  return policy;
}

/** The static site's policy for every page ("/*" in site/public/_headers). */
function sitePolicy(): Policy {
  const lines = (staticHeaders as string).split('\n');
  let inAll = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inAll = line.trim() === '/*';
    const match = /^\s+Content-Security-Policy:\s*(.+)$/i.exec(line);
    if (inAll && match) return parseCsp(match[1]!);
  }
  throw new Error('site/public/_headers has no Content-Security-Policy for /*');
}

const FETCH_DIRECTIVES = ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'frame-src', 'media-src', 'object-src', 'manifest-src', 'worker-src', 'child-src'];
const effective = (policy: Policy, directive: string): string[] | undefined => policy.get(directive) ?? (FETCH_DIRECTIVES.includes(directive) ? policy.get('default-src') : undefined);

/* ------------------------------------------------------------------ */
/* The site's partials, rendered the way scripts/build-site.ts does    */
/* ------------------------------------------------------------------ */

const FEATURE_BLOCK = /<!--[ \t]*feature:([a-z][a-z0-9-]*)[ \t]*-->[\s\S]*?<!--[ \t]*\/feature:\1[ \t]*-->\n?/g;
const squeeze = (html: string): string => html.trim().replace(/\n\s*\n/g, '\n');

function expandTokens(source: string, tokens: Record<string, string>, partials: Record<string, string>): string {
  return source.replace(/\[\[(?:>\s*([a-z][a-z0-9-]*)\s*|([a-zA-Z][\w.]*))\]\]/g, (_match, partial?: string, name?: string) => {
    if (partial !== undefined) {
      const body = partials[partial];
      if (body === undefined) throw new Error(`the verify page does not copy partial [[> ${partial}]]: update src/batch/verify-page.ts`);
      return squeeze(expandTokens(body, tokens, partials));
    }
    const value = tokens[name!];
    if (value === undefined) throw new Error(`the verify page does not print token [[${name}]]: update src/batch/verify-page.ts`);
    return value;
  });
}

const SITE_TOKENS = {
  'site.name': siteConfig.name,
  'site.url': siteConfig.url,
  'site.supportEmail': siteConfig.supportEmail,
  'site.year': String(new Date(NOW).getUTCFullYear()),
  'legal.name': siteConfig.legalName,
  'legal.locality': siteConfig.legalLocality,
};
const SITE_CTX: VerifyContext = { appUrl: siteConfig.url, supportEmail: siteConfig.supportEmail, now: NOW };

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

describe('the record page', () => {
  it('shows the facts, the issuing account, the disclaimer and the report link', () => {
    const html = verifyPageHtml(record(), CTX);
    const shown = facts(html);
    expect([...shown.keys()]).toEqual(['Recipient', 'Title', 'Achievement', 'Issuer name', 'Date', 'Certificate ID', 'Recorded', 'Status']);
    expect(textOf(shown.get('Recipient')!)).toBe('Amara Nwosu');
    expect(textOf(shown.get('Certificate ID')!)).toBe(ID);
    expect(textOf(shown.get('Recorded')!)).toBe('26 November 2026');
    expect(textOf(shown.get('Status')!)).toBe('Valid');
    expect(html).toContain('<span class="badge badge-ok">Valid</span>');
    expect(html).toContain('Issued by a Link To Card account verified at <strong>@lanternworks.org</strong>');
    expect(html).toContain(VERIFY_DISCLAIMER.replace("'", '&#39;'));
    expect(html).not.toMatch(/revoked on/i);

    const report = elements(html).find((element) => element.name === 'a' && textOf(element) === 'Report this certificate');
    const href = new URL(report!.attribs.href!);
    expect(href.protocol).toBe('mailto:');
    expect(href.pathname).toBe('support@linktocard.test');
    expect(href.searchParams.get('subject')).toBe(`Report certificate ${ID}`);
    expect(href.searchParams.get('body')).toContain(`https://linktocard.test/v/${ID}`);
    expect(elements(html).some((element) => element.name === 'a' && element.attribs.href === `/v/${ID}.json`)).toBe(true);
  });

  it('states the fixed disclaimer of the contract', () => {
    expect(VERIFY_DISCLAIMER).toBe("Link To Card confirms that this record was created by that account. It does not verify the issuer's identity, accreditation or the facts stated.");
  });

  it('is noindex, carries no recipient name in its title or preview tags, and points at its canonical URL', () => {
    const html = verifyPageHtml(record(), CTX);
    const meta = elements(html).filter((element) => element.name === 'meta' || element.name === 'title' || element.name === 'link');
    expect(meta.some((element) => element.attribs.name === 'robots' && element.attribs.content === 'noindex')).toBe(true);
    expect(meta.find((element) => element.attribs.rel === 'canonical')?.attribs.href).toBe(`https://linktocard.test/v/${ID}`);
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).not.toContain('Amara');
    expect(head).toContain('<title>Certificate record - Link To Card</title>');
  });

  it('leaves out facts the row did not have', () => {
    const shown = facts(verifyPageHtml(record({ title: null, achievement: null, issuerName: null, date: null }), CTX));
    expect([...shown.keys()]).toEqual(['Recipient', 'Certificate ID', 'Recorded', 'Status']);
  });

  it('marks a revoked record as revoked, with the date', () => {
    const revokedAt = Date.UTC(2026, 11, 3, 9, 30);
    const html = verifyPageHtml(record({ status: 'revoked', revokedAt }), CTX);
    expect(html).toContain('<span class="badge badge-danger">Revoked</span>');
    expect(html).not.toContain('badge-ok');
    expect(textOf(facts(html).get('Status')!)).toBe('Revoked on 3 December 2026');
    expect(html).toContain('<strong>This certificate was revoked on <time datetime="2026-12-03">3 December 2026</time>.</strong> Do not treat it as valid.');
    expect(html).toContain('<title>Revoked certificate - Link To Card</title>');
  });

  it('names a personal address without its provider, and an unusable one without any domain', () => {
    const personal = verifyPageHtml(record({ issuer: issuerFromEmail('someone@gmail.com') }), CTX);
    expect(personal).toContain('<p class="alert alert-info">Issued by a Link To Card account with a personal email address.</p>');
    expect(personal).not.toContain('gmail');
    const unknown = verifyPageHtml(record({ issuer: issuerFromEmail('broken') }), CTX);
    expect(unknown).toContain('<p class="alert alert-info">Issued by a Link To Card account.</p>');
  });

  it('formats dates in UTC, day month year', () => {
    expect(longDate(Date.UTC(2026, 0, 1, 23, 59))).toBe('1 January 2026');
    expect(longDate(Date.UTC(2027, 11, 31))).toBe('31 December 2027');
  });
});

describe('hostile values', () => {
  const HOSTILE = {
    recipientName: '<script>alert(1)</script>',
    title: '"><img src=x onerror=alert(1)>',
    achievement: "' onmouseover='alert(1)' data-x='",
    issuerName: '</dd></dl><a href="javascript:alert(1)">Valid</a>&amp;',
    date: '<style>body{display:none}</style>',
  };

  it('are escaped: the page has no element, attribute or script a value brought', () => {
    const html = verifyPageHtml(record(HOSTILE), CTX);
    expect(inlineCode(html)).toEqual([]);
    expect(elements(html).filter((element) => element.name === 'img')).toEqual([]);
    expect(elements(html).some((element) => element.name === 'a' && /javascript/i.test(element.attribs.href ?? ''))).toBe(false);
    const shown = facts(html);
    expect(textOf(shown.get('Recipient')!)).toBe('<script>alert(1)</script>');
    expect(textOf(shown.get('Title')!)).toBe('"><img src=x onerror=alert(1)>');
    expect(textOf(shown.get('Achievement')!)).toBe("' onmouseover='alert(1)' data-x='");
    expect(textOf(shown.get('Issuer name')!)).toBe('</dd></dl><a href="javascript:alert(1)">Valid</a>&amp;');
    expect(textOf(shown.get('Date')!)).toBe('<style>body{display:none}</style>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;amp;');
  });

  it('cannot reorder the page around them: every value is isolated in <bdi>, control characters are dropped', () => {
    const html = verifyPageHtml(record({ recipientName: 'Eve ‮diliv‬\u0000\u0007\u001b[31m\u009b', title: 'line\nbreak\ttab' }), CTX);
    const recipient = facts(html).get('Recipient')!;
    expect(recipient.children.filter(isTag).map((child) => child.name)).toEqual(['bdi']);
    expect(textOf(recipient)).toBe('Eve ‮diliv‬[31m');
    expect(textOf(facts(html).get('Title')!)).toBe('line\nbreak\ttab');
    for (const label of ['Recipient', 'Title', 'Achievement', 'Issuer name', 'Date']) {
      expect(facts(html).get(label)!.children.filter(isTag)[0]?.name, label).toBe('bdi');
    }
  });

  it('cannot break out of the report link or the canonical URL', () => {
    const html = verifyPageHtml(record(), { ...CTX, supportEmail: 'a"b@x.test', appUrl: 'https://x.test/"><script>' });
    expect(inlineCode(html)).toEqual([]);
    expect(elements(html).some((element) => element.name === 'script')).toBe(false);
  });

  it('are escaped on the not-found page too', () => {
    const html = notFoundPageHtml('<b>crt_x</b>', CTX);
    expect(html).toContain('<code>&lt;b&gt;crt_x&lt;/b&gt;</code>');
    expect(elements(html).some((element) => element.name === 'b')).toBe(false);
  });
});

describe('the JSON twin', () => {
  it('has exactly these fields', () => {
    expect(verifyJson(record(), CTX)).toEqual({
      id: ID,
      status: 'valid',
      verify_url: `https://linktocard.test/v/${ID}`,
      recipient_name: 'Amara Nwosu',
      title: 'Certificate of Completion',
      achievement: 'for completing the workshop',
      issuer_name: 'Lanternworks Training',
      date: 'November 25, 2026',
      issued_at: '2026-11-26T12:00:00.000Z',
      revoked_at: null,
      issued_by: { kind: 'domain', email_domain: 'lanternworks.org', statement: 'Issued by a Link To Card account verified at @lanternworks.org' },
      disclaimer: VERIFY_DISCLAIMER,
    });
  });

  it('reports a revocation and keeps values unescaped (JSON consumers escape for their own output)', () => {
    const json = verifyJson(record({ status: 'revoked', revokedAt: Date.UTC(2026, 11, 3), recipientName: '<b>&', issuer: issuerFromEmail('x@icloud.com') }), CTX);
    expect(json).toMatchObject({ status: 'revoked', revoked_at: '2026-12-03T00:00:00.000Z', recipient_name: '<b>&' });
    expect(json.issued_by).toEqual({ kind: 'personal', email_domain: null, statement: 'Issued by a Link To Card account with a personal email address' });
  });
});

describe('the other pages', () => {
  it('not found: says only what is true for every reason a record cannot be shown', () => {
    const html = notFoundPageHtml(ID, CTX);
    expect(html).toContain(`Link To Card has no certificate record it can show for <code>${ID}</code>.`);
    expect(html).toContain(`Revoked records are kept for ${BATCH.revokedRetentionDays} days`);
    expect(notFoundPageHtml(null, CTX)).toContain('This link does not hold a certificate ID.');
    expect(inlineCode(html)).toEqual([]);
  });

  it('unavailable: no script, no style', () => {
    const html = unavailablePageHtml(CTX);
    expect(html).toContain('Certificate verification is not available right now.');
    expect(inlineCode(html)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* CSP compatibility with the static site                              */
/* ------------------------------------------------------------------ */

describe('Content-Security-Policy', () => {
  const pages = (): Array<[string, string]> => [
    ['record', verifyPageHtml(record(), CTX)],
    ['revoked', verifyPageHtml(record({ status: 'revoked', revokedAt: NOW }), CTX)],
    ['not found', notFoundPageHtml(ID, CTX)],
    ['unavailable', unavailablePageHtml(CTX)],
  ];

  it("allows nothing the static site's policy (site/public/_headers) does not", () => {
    const site = sitePolicy();
    const page = parseCsp(VERIFY_PAGE_CSP);
    for (const directive of [...FETCH_DIRECTIVES, 'base-uri', 'form-action', 'frame-ancestors']) {
      const ours = effective(page, directive);
      const theirs = effective(site, directive);
      if (!ours || ours.join(' ') === "'none'") continue;
      expect(theirs, directive).toBeDefined();
      for (const source of ours) expect(theirs, `${directive} ${source}`).toContain(source);
    }
    // Stricter where it matters: no script at all, no inline style, no frames.
    expect(effective(page, 'script-src')).toEqual(["'none'"]);
    expect(page.get('style-src')).toEqual(["'self'"]);
    expect(page.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it.each([0, 1, 2, 3])('page %#: inline code none, and everything it loads is same-origin', (index) => {
    const [name, html] = pages()[index]!;
    expect(inlineCode(html), name).toEqual([]);
    const urls = loadedUrls(html);
    expect(urls).toContain('/assets/css/site.css');
    for (const url of urls) expect(url, `${name}: ${url}`).toMatch(/^\/(?!\/)/);
  });
  // site.css itself loads only same-origin files: tests/node/verify-page-css.test.ts (the Workers
  // pool turns CSS imports into empty strings, even with ?raw).
});

/* ------------------------------------------------------------------ */
/* The site's markup, copied without drift                              */
/* ------------------------------------------------------------------ */

describe("the site's header, footer and layout", () => {
  const partials = { logo: logoPartial, header: headerPartial, footer: footerPartial };

  it('header: site/partials/header.html as the site build renders it', () => {
    expect(siteHeader()).toBe(squeeze(expandTokens(headerPartial.replace(FEATURE_BLOCK, ''), SITE_TOKENS, partials)));
  });

  it('footer: site/partials/footer.html without its feature blocks (the links every build has)', () => {
    expect(footerPartial.replace(FEATURE_BLOCK, '')).not.toBe(footerPartial);
    expect(siteFooter(siteConfig.supportEmail, NOW)).toBe(squeeze(expandTokens(footerPartial.replace(FEATURE_BLOCK, ''), SITE_TOKENS, partials)));
  });

  it('document: site/layouts/base.html with the page in place of {{body}} and no site.js', () => {
    const html = verifyPageHtml(record(), SITE_CTX);
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>') + '</main>'.length);
    const title = 'Certificate record - Link To Card';
    const expected = expandTokens(
      baseLayout
        .replace('<script type="module" src="/assets/js/site.js"></script>\n', '')
        .replace('{{scripts}}\n', '')
        .replace(/\{\{title\}\}/g, title)
        .replace(/\{\{description\}\}/g, 'Verification record of a certificate issued through Link To Card.')
        .replace('{{robots}}', '<meta name="robots" content="noindex">\n')
        .replace(/\{\{canonical\}\}/g, `${siteConfig.url}/v/${ID}`)
        .replace('{{body}}', main),
      SITE_TOKENS,
      { ...partials, header: headerPartial.replace(FEATURE_BLOCK, ''), footer: footerPartial.replace(FEATURE_BLOCK, '') },
    );
    expect(expected).not.toMatch(/\{\{/);
    expect(html).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* The static site's own footer (env.ASSETS)                          */
/* ------------------------------------------------------------------ */

/** footer.html as scripts/build-site.ts renders it for a build with `on` features: their blocks kept, the others dropped. */
function builtFooter(on: readonly string[]): string {
  const kept = footerPartial.replace(
    /<!--[ \t]*feature:(no-)?([a-z][a-z0-9-]*)[ \t]*-->\n?([\s\S]*?)<!--[ \t]*\/feature:(?:no-)?\2[ \t]*-->\n?/g,
    (_match: string, negated: string | undefined, feature: string, inner: string) => ((negated ? !on.includes(feature) : on.includes(feature)) ? inner : ''),
  );
  return squeeze(expandTokens(kept, SITE_TOKENS, { logo: logoPartial }));
}

/** The production site's footer (SITE_FEATURES=previews,localpdf,apidocs SITE_PDF=off), with the tools links. */
const PRODUCTION_FOOTER = builtFooter(['previews', 'localpdf', 'apidocs']);

type AssetAnswer = Response | ((url: URL) => Response) | Error;

/** A fake env.ASSETS: records every requested URL and answers from `answers` in turn (the last one repeats). */
function fakeAssets(...answers: AssetAnswer[]): { assets: Fetcher; requested: string[] } {
  const requested: string[] = [];
  const assets = {
    fetch: async (input: Request): Promise<Response> => {
      requested.push(input.url);
      const answer = answers[Math.min(requested.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(new URL(input.url)) : answer.clone();
    },
  } as unknown as Fetcher;
  return { assets, requested };
}

const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const FOOTER_URL = `https://assets.local${SITE_FOOTER_ASSET}`;

describe("the static site's own footer", () => {
  it('is the footer the site build publishes, with the tools links of the production build', () => {
    expect(SITE_FOOTER_ASSET).toBe('/assets/partials/footer.html');
    for (const href of ['/tools', '/tools/merge-pdf', '/tools/image-to-pdf']) expect(PRODUCTION_FOOTER).toContain(`<a href="${href}">`);
    expect(siteFooter(siteConfig.supportEmail, NOW)).not.toContain('href="/tools');
    expect(isSiteFooter(PRODUCTION_FOOTER)).toBe(true);
    expect(isSiteFooter(builtFooter(['pdf', 'batch', 'toolkit', 'linkcards', 'email', 'previews', 'integrations', 'localpdf', 'apidocs']))).toBe(true);
    expect(isSiteFooter(siteFooter(siteConfig.supportEmail, NOW))).toBe(true);
  });

  it.each([
    ['an empty file', ''],
    ['the 404 page', '<!doctype html><html><body><footer class="site-footer"></footer></body></html>'],
    ['a script', PRODUCTION_FOOTER.replace('</footer>', '<script src="/x.js"></script></footer>')],
    ['an inline handler', PRODUCTION_FOOTER.replace('<a href="/tools">', '<a href="/tools" onclick="alert(1)">')],
    ['an inline style', PRODUCTION_FOOTER.replace('<a href="/tools">', '<a href="/tools" style="color:red">')],
    ['a javascript: link', PRODUCTION_FOOTER.replace('<a href="/tools">', '<a href="javascript:alert(1)">')],
    ['an image', PRODUCTION_FOOTER.replace('</footer>', '<img src="https://evil.example/x.png"></footer>')],
    ['a frame', PRODUCTION_FOOTER.replace('</footer>', '<iframe src="/"></iframe></footer>')],
    ['a second footer', `${PRODUCTION_FOOTER}<footer class="site-footer"></footer>`],
    ['another element', '<div class="site-footer"></div>'],
    ['something huge', PRODUCTION_FOOTER.replace('</footer>', `<p>${'x'.repeat(40_000)}</p></footer>`)],
  ])('is refused when it is %s', (_case, candidate) => {
    expect(isSiteFooter(candidate)).toBe(false);
  });

  it('is read once per assets binding, then served from memory', async () => {
    const { assets, requested } = fakeAssets(html(`${PRODUCTION_FOOTER}\n`));
    expect(await loadSiteFooter(assets)).toBe(PRODUCTION_FOOTER);
    expect(await loadSiteFooter(assets)).toBe(PRODUCTION_FOOTER);
    expect(await Promise.all([loadSiteFooter(assets), loadSiteFooter(assets)])).toEqual([PRODUCTION_FOOTER, PRODUCTION_FOOTER]);
    expect(requested).toEqual([FOOTER_URL]);
    // Another binding (another deployment's assets) has its own copy.
    const other = fakeAssets(html(builtFooter([])));
    expect(await loadSiteFooter(other.assets)).toBe(builtFooter([]));
    expect(other.requested).toEqual([FOOTER_URL]);
  });

  it('follows one redirect of the assets to the extensionless path, and no other', async () => {
    const redirected = fakeAssets(new Response(null, { status: 307, headers: { location: '/assets/partials/footer' } }), html(PRODUCTION_FOOTER));
    expect(await loadSiteFooter(redirected.assets)).toBe(PRODUCTION_FOOTER);
    expect(redirected.requested).toEqual([FOOTER_URL, 'https://assets.local/assets/partials/footer']);
    const elsewhere = fakeAssets(new Response(null, { status: 302, headers: { location: 'https://evil.example/footer.html' } }), html(PRODUCTION_FOOTER));
    expect(await loadSiteFooter(elsewhere.assets)).toBeNull();
    expect(elsewhere.requested).toEqual([FOOTER_URL]);
    const loop = fakeAssets(new Response(null, { status: 307, headers: { location: '/assets/partials/footer' } }));
    expect(await loadSiteFooter(loop.assets)).toBeNull();
    expect(loop.requested).toHaveLength(2);
  });

  it('is null when the asset is missing, broken or not a footer, and is asked for again next time', async () => {
    const cases: AssetAnswer[] = [
      html('<!doctype html><h1>Not found</h1>', 404),
      html('<p>Service unavailable</p>', 503),
      new Response(PRODUCTION_FOOTER, { headers: { 'content-type': 'text/plain' } }),
      html(PRODUCTION_FOOTER.replace('</footer>', '<script>alert(1)</script></footer>')),
      new Error('assets down'),
    ];
    for (const answer of cases) {
      const { assets, requested } = fakeAssets(answer);
      expect(await loadSiteFooter(assets)).toBeNull();
      expect(await loadSiteFooter(assets)).toBeNull();
      expect(requested).toHaveLength(2);
    }
    // Once the asset is there, it is used.
    const { assets } = fakeAssets(html('', 404), html(PRODUCTION_FOOTER));
    expect(await loadSiteFooter(assets)).toBeNull();
    expect(await loadSiteFooter(assets)).toBe(PRODUCTION_FOOTER);
    expect(await loadSiteFooter(undefined)).toBeNull();
  });

  it('is printed as it is, in place of the stand-in, on every page; without it the stand-in is', () => {
    const fallback = siteFooter(CTX.supportEmail, CTX.now);
    const pages = (ctx: VerifyContext): string[] => [verifyPageHtml(record(), ctx), notFoundPageHtml(ID, ctx), unavailablePageHtml(ctx)];
    for (const page of pages({ ...CTX, footer: PRODUCTION_FOOTER })) {
      expect(page.split(PRODUCTION_FOOTER)).toHaveLength(2);
      expect(page).not.toContain(fallback);
      expect(page.match(/<footer\b/g)).toHaveLength(1);
      expect(page.indexOf(PRODUCTION_FOOTER)).toBe(page.indexOf('</div>\n<footer') + '</div>\n'.length);
      expect(inlineCode(page)).toEqual([]);
      for (const url of loadedUrls(page)) expect(url).toMatch(/^\/(?!\/)/);
    }
    for (const page of [...pages(CTX), ...pages({ ...CTX, footer: null })]) expect(page).toContain(fallback);
  });
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const app = new Hono<AppEnv>();
app.route('/v', verifyRouter);
app.route('/v1/certificates', certificatesApiRouter);
app.route('/api/certificates', certificatesDashboardRouter);
app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(error, c.env.APP_URL);
  throw error;
});

const ON: Env = { ...env, BATCH_ENABLED: 'true' };
const OFF: Env = { ...env, BATCH_ENABLED: undefined };
const get = (path: string, bindings: Env = ON, init: RequestInit = {}): Promise<Response> => Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init), bindings));
const post = (path: string, headers: Record<string, string>, bindings: Env = ON): Promise<Response> =>
  Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers }), bindings));

describe('GET /v/{id} and /v/{id}.json', () => {
  let owner: { id: string; email: string };
  let id: string;

  beforeAll(async () => {
    await ensureCertificatesTable();
    owner = await createAccount('registrar@lanternworks.org');
    id = newCertificateId();
    await createCertificates(env.DB, { userId: owner.id, batchId: null, rows: [{ id, rowIndex: 0, data: { ...SAMPLE_ROW, recipient_name: '<i>Amara</i>' } }] }, NOW);
  });

  it('serves the record with its own strict headers', async () => {
    const response = await get(`/v/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(VERIFY_PAGE_CSP);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(textOf(facts(html).get('Recipient')!)).toBe('<i>Amara</i>');
    expect(html).toContain('@lanternworks.org');
    expect(inlineCode(html)).toEqual([]);
  });

  it('serves the JSON twin, readable from any site', async () => {
    const response = await get(`/v/${id}.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id, status: 'valid', recipient_name: '<i>Amara</i>', issued_at: new Date(NOW).toISOString() });
  });

  it('reads an id typed in capitals, and points the page at the canonical URL', async () => {
    const response = await get(`/v/${id.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<link rel="canonical" href="https://linktocard.test/v/${id}">`);
  });

  it('answers 404 for an unknown or malformed id, in HTML and in JSON', async () => {
    const unknown = await get(`/v/${newCertificateId()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-security-policy')).toBe(VERIFY_PAGE_CSP);
    expect(await unknown.text()).toContain('No certificate record found.');
    const malformed = await get('/v/%3Cscript%3E');
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toContain('This link does not hold a certificate ID.');
    const json = await get(`/v/${newCertificateId()}.json`);
    expect(json.status).toBe(404);
    expect(((await json.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('answers 503 while BATCH_ENABLED is off: an HTML notice, and not_configured in JSON', async () => {
    const page = await get(`/v/${id}`, OFF);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('Certificate verification is not available right now.');
    const json = await get(`/v/${id}.json`, OFF);
    expect(json.status).toBe(503);
    expect(((await json.json()) as { error: { code: string } }).error.code).toBe('not_configured');
  });

  it("prints the static site's footer from env.ASSETS on the record, not-found and unavailable pages, and not for JSON", async () => {
    const { assets, requested } = fakeAssets(html(PRODUCTION_FOOTER));
    const withAssets = { ...ON, ASSETS: assets };
    for (const path of [`/v/${id}`, `/v/${newCertificateId()}`, '/v/not-an-id']) {
      const page = await (await get(path, withAssets)).text();
      expect(page, path).toContain(PRODUCTION_FOOTER);
      expect(page, path).toContain('<li><a href="/tools">All free tools</a></li>');
      expect(inlineCode(page), path).toEqual([]);
    }
    const unavailable = await get(`/v/${id}`, { ...OFF, ASSETS: assets });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain(PRODUCTION_FOOTER);
    expect(requested).toEqual([FOOTER_URL]);
    // The JSON twin needs no footer: a binding that fails every request is never asked.
    const failing = fakeAssets(new Error('must not be asked'));
    expect((await get(`/v/${id}.json`, { ...ON, ASSETS: failing.assets })).status).toBe(200);
    expect(failing.requested).toEqual([]);
  });

  it('falls back to the stand-in footer while the asset is missing', async () => {
    const { assets } = fakeAssets(html('<!doctype html><h1>Not found</h1>', 404));
    const response = await get(`/v/${id}`, { ...ON, ASSETS: assets });
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(siteFooter('support@linktocard.test', Date.now()));
  });

  it('prints the same footer as the static pages of the deployed site (site/dist, as npm test builds it)', async () => {
    const home = await env.ASSETS.fetch(new Request('https://linktocard.test/'));
    expect(home.status, 'site/dist has no home page: run npm run build:site').toBe(200);
    const homeHtml = await home.text();
    const footer = homeHtml.slice(homeHtml.indexOf('<footer'), homeHtml.indexOf('</footer>') + '</footer>'.length);
    expect(footer).toMatch(/^<footer class="site-footer">/);
    const page = await (await get(`/v/${id}`)).text();
    expect(page, 'the verification page footer differs from the site footer: rebuild site/dist (npm run build:site)').toContain(`</div>\n${footer}\n</body>`);
  });

  it('does not need PDF rendering: no BROWSER binding, PDF_ENABLED off, the page still works', async () => {
    const response = await get(`/v/${id}`, { ...ON, PDF_ENABLED: 'false', BROWSER: undefined });
    expect(response.status).toBe(200);
  });
});

describe('revoking', () => {
  beforeAll(ensureCertificatesTable);

  it('POST /v1/certificates/{id}/revoke: the owner revokes, the page then says so', async () => {
    const owner = await createAccount();
    const key = await apiKeyFor(owner.id);
    const id = newCertificateId();
    await createCertificates(env.DB, { userId: owner.id, batchId: null, rows: [{ id, rowIndex: 0, data: SAMPLE_ROW }] }, NOW);

    const response = await post(`/v1/certificates/${id}/revoke`, bearer(key.secret));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; revoked_at: string | null; id: string };
    expect(body).toMatchObject({ id, status: 'revoked' });
    expect(body.revoked_at).not.toBeNull();

    const again = (await (await post(`/v1/certificates/${id}/revoke`, bearer(key.secret))).json()) as { revoked_at: string };
    expect(again.revoked_at).toBe(body.revoked_at);

    const page = await (await get(`/v/${id}`)).text();
    expect(page).toContain('<span class="badge badge-danger">Revoked</span>');
  });

  it("another account's key gets 404, and no key gets 401", async () => {
    const owner = await createAccount();
    const stranger = await createAccount();
    const key = await apiKeyFor(stranger.id);
    const id = newCertificateId();
    await createCertificates(env.DB, { userId: owner.id, batchId: null, rows: [{ id, rowIndex: 0, data: SAMPLE_ROW }] }, NOW);
    expect((await post(`/v1/certificates/${id}/revoke`, bearer(key.secret))).status).toBe(404);
    expect((await post('/v1/certificates/not-an-id/revoke', bearer(key.secret))).status).toBe(404);
    expect((await post(`/v1/certificates/${id}/revoke`, {})).status).toBe(401);
    expect(((await (await get(`/v/${id}.json`)).json()) as { status: string }).status).toBe('valid');
  });

  it('POST /api/certificates/{id}/revoke: the dashboard twin, same origin only', async () => {
    const owner = await createAccount();
    const cookie = await sessionCookieFor(owner.id);
    const id = newCertificateId();
    await createCertificates(env.DB, { userId: owner.id, batchId: null, rows: [{ id, rowIndex: 0, data: SAMPLE_ROW }] }, NOW);
    expect((await post(`/api/certificates/${id}/revoke`, { cookie, origin: 'https://evil.example' })).status).toBe(403);
    const response = await post(`/api/certificates/${id}/revoke`, { cookie, origin: ORIGIN });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('revoked');
  });

  it('answers 503 not_configured while BATCH_ENABLED is off', async () => {
    const owner = await createAccount();
    const key = await apiKeyFor(owner.id);
    const response = await post(`/v1/certificates/${newCertificateId()}/revoke`, bearer(key.secret), OFF);
    expect(response.status).toBe(503);
  });
});
