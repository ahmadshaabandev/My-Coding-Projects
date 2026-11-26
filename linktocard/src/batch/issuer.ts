/**
 * Who issued a certificate, as its public verification page (GET /v/{id}) states it: the domain of
 * the issuing account's sign-in email address, never the address itself.
 *
 * Why the domain, and why not for every domain:
 *   - A Link To Card account signs in only through links emailed to its address, so the account
 *     has received mail at that domain. For an organisation's own domain ("@lanternworks.org")
 *     that tells a reader something about the issuer, and the page claims no more than that.
 *   - At a public mailbox provider anyone can open an address, so "@gmail.com" would lend the
 *     certificate the provider's name and prove nothing about the issuer. Those domains, and
 *     every subdomain of them, are stated as "an account with a personal email address". The list
 *     is curated, not complete: a provider missing from it shows as "@provider.example", which is
 *     still literally true, and the page's fixed disclaimer says the issuer's identity is not
 *     verified. Matching subdomains too errs the same safe way (the weaker statement).
 *   - The domain is shown in its ASCII form (punycode, "xn--..."), never decoded to Unicode: a
 *     look-alike written in another script ("gmaіl.com" with a Cyrillic "і") must not read as the
 *     real domain. Unicode input is converted with the URL parser's IDNA mapping, which also folds
 *     full-width letters, so "ｇｍａｉｌ.com" is recognised as gmail.com.
 *   - Anything that is not a plain host name (an IP address, a bracketed literal, stray
 *     characters) gets the statement that names no domain at all. Stored addresses never look like
 *     that (src/db/client.ts normalizeEmail), so this is a guard, not a case the page expects.
 */

export type IssuerKind = 'domain' | 'personal' | 'unknown';

export interface Issuer {
  /** 'domain': an organisation's own domain is shown; 'personal': a public mailbox provider; 'unknown': no usable domain. */
  kind: IssuerKind;
  /** The ASCII (punycode) domain for kind 'domain', otherwise null: a provider's name says nothing about the issuer. */
  domain: string | null;
  /** The sentence the page prints, without a full stop. */
  statement: string;
}

/**
 * Public mailbox providers: anyone can open an address there, so the domain says nothing about the
 * issuer. Also mail forwarding and alias services that hand out addresses to anyone, and the best
 * known public inboxes (where anyone can read the mail). Lower-case ASCII; subdomains match too.
 * Curated from general knowledge, not from each provider's documentation: a missing provider only
 * means its domain is printed as it is.
 */
export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
  'outlook.co.uk', 'outlook.fr', 'outlook.de', 'outlook.es', 'outlook.it', 'outlook.com.br',
  'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it', 'hotmail.ca', 'hotmail.com.br',
  'live.co.uk', 'live.fr', 'live.de', 'live.it', 'live.ca', 'live.com.au',
  // Yahoo and AOL
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it',
  'yahoo.ca', 'yahoo.com.au', 'yahoo.co.in', 'yahoo.in', 'yahoo.co.jp', 'yahoo.com.br', 'yahoo.com.mx',
  'aol.com', 'aim.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com', 'privaterelay.appleid.com',
  // Privacy-focused and independent providers
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tutamail.com', 'tuta.io', 'tuta.com', 'keemail.me',
  'fastmail.com', 'fastmail.fm', 'hey.com', 'duck.com', 'zoho.com', 'zohomail.com', 'mailbox.org', 'posteo.de', 'posteo.net',
  // GMX, WEB.DE and mail.com
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.fr', 'gmx.co.uk', 'web.de', 'mail.com', 'email.com',
  // Russia and neighbours
  'yandex.ru', 'yandex.com', 'yandex.ua', 'yandex.by', 'yandex.kz', 'ya.ru', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru', 'rambler.ru',
  // China, Korea, India
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com',
  'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
  // Europe
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net',
  't-online.de', 'freenet.de', 'seznam.cz', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'abv.bg',
  // Internet service providers (US, UK, Brazil)
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'optonline.net',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'ntlworld.com', 'talktalk.net', 'uol.com.br', 'bol.com.br', 'terra.com.br',
  // Public and throw-away inboxes
  'mailinator.com', 'yopmail.com', 'guerrillamail.com', 'sharklasers.com', 'maildrop.cc', '10minutemail.com', 'trashmail.com',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Letters, digits, combining marks, dots and hyphens: nothing the URL parser would read as a port, path or credentials. */
const HOST_CHARACTERS = /^[\p{L}\p{N}\p{M}.-]+$/u;
const MAX_DOMAIN_CHARS = 253;

const ACCOUNT = 'Issued by a Link To Card account';

/**
 * The ASCII form of a host name, lower case, without a trailing dot, or null when it is not a
 * plain DNS name of at least two labels whose last label (the top-level domain) has a letter.
 * That last rule also turns away IPv4 addresses, which the URL parser would otherwise normalise.
 */
export function asciiDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '' || !HOST_CHARACTERS.test(host)) return null;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return null;
    }
    if (host.endsWith('.')) host = host.slice(0, -1);
  }
  if (host.length > MAX_DOMAIN_CHARS) return null;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  if (!/[a-z]/.test(labels[labels.length - 1]!)) return null;
  return host;
}

/** The ASCII domain of an email address (the part after the last "@"), or null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return asciiDomain(email.slice(at + 1));
}

/** True for a listed public mailbox provider or any subdomain of one. `domain` is an asciiDomain() result. */
export function isPublicMailboxDomain(domain: string): boolean {
  const labels = domain.split('.');
  // Every suffix of two labels or more: "mail.yahoo.co.uk", "yahoo.co.uk", "co.uk".
  for (let start = 0; start < labels.length - 1; start++) {
    if (PUBLIC_MAILBOX_DOMAINS.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}

/** How the verification page names the issuing account, from its sign-in email address. */
export function issuerFromEmail(email: string | null | undefined): Issuer {
  const domain = typeof email === 'string' ? emailDomain(email) : null;
  if (domain === null) return { kind: 'unknown', domain: null, statement: ACCOUNT };
  if (isPublicMailboxDomain(domain)) return { kind: 'personal', domain: null, statement: `${ACCOUNT} with a personal email address` };
  return { kind: 'domain', domain, statement: `${ACCOUNT} verified at @${domain}` };
}
