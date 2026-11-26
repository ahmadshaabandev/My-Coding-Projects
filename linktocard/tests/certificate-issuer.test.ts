// How a certificate's verification page names the issuing account (src/batch/issuer.ts): the
// sign-in email's domain in ASCII, "a personal email address" for public mailbox providers, and
// no domain at all for anything that is not a plain host name. Runs in workerd, whose URL parser
// does the IDNA conversion in production.
import { describe, expect, it } from 'vitest';
import { asciiDomain, emailDomain, isPublicMailboxDomain, issuerFromEmail, PUBLIC_MAILBOX_DOMAINS } from '../src/batch/issuer';

const PERSONAL = 'Issued by a Link To Card account with a personal email address';
const NO_DOMAIN = 'Issued by a Link To Card account';

describe('issuerFromEmail', () => {
  it('names an organisation by its domain, never by the address', () => {
    const issuer = issuerFromEmail('jane.doe@lanternworks.org');
    expect(issuer).toEqual({ kind: 'domain', domain: 'lanternworks.org', statement: 'Issued by a Link To Card account verified at @lanternworks.org' });
    expect(JSON.stringify(issuer)).not.toContain('jane');
  });

  it.each(['someone@gmail.com', 'someone@googlemail.com', 'a@outlook.com', 'a@hotmail.co.uk', 'a@yahoo.co.jp', 'a@icloud.com', 'a@proton.me', 'a@qq.com', 'a@mailinator.com', 'a@duck.com'])(
    '%s is a personal address: the provider says nothing about the issuer',
    (email) => {
      expect(issuerFromEmail(email)).toEqual({ kind: 'personal', domain: null, statement: PERSONAL });
    },
  );

  it('treats subdomains of a provider as the provider (the weaker statement)', () => {
    expect(issuerFromEmail('a@user.anything.gmail.com').kind).toBe('personal');
    expect(isPublicMailboxDomain('mail.yahoo.co.uk')).toBe(true);
  });

  it('does not treat a domain that merely ends in the same letters as the provider', () => {
    expect(issuerFromEmail('a@notgmail.com')).toMatchObject({ kind: 'domain', domain: 'notgmail.com' });
    expect(issuerFromEmail('a@gmail.com.example.org')).toMatchObject({ kind: 'domain', domain: 'gmail.com.example.org' });
  });

  it('ignores case, surrounding space and a trailing dot', () => {
    expect(issuerFromEmail('Jane@LanternWorks.ORG.')).toMatchObject({ kind: 'domain', domain: 'lanternworks.org' });
    expect(issuerFromEmail('Jane@GMAIL.COM').kind).toBe('personal');
    expect(emailDomain('a@ example.org ')).toBe('example.org');
  });

  it('uses the last "@" (a quoted local part may contain one)', () => {
    expect(emailDomain('"a@b"@example.org')).toBe('example.org');
  });

  it('says no domain for anything that is not a plain host name', () => {
    for (const email of [null, undefined, '', 'no-at-sign', '@example.org', 'a@', 'a@localhost', 'a@[127.0.0.1]', 'a@127.0.0.1', 'a@0x7f.1', 'a@exa mple.org', 'a@example.org/path', 'a@example.org:8080', 'a@-bad.org', 'a@bad-.org', 'a@a..org', `a@${'a'.repeat(64)}.org`]) {
      expect(issuerFromEmail(email), String(email)).toEqual({ kind: 'unknown', domain: null, statement: NO_DOMAIN });
    }
  });

  it('accepts the longest valid labels and domains, and nothing longer', () => {
    const label = 'a'.repeat(63);
    expect(asciiDomain(`${label}.org`)).toBe(`${label}.org`);
    const longest = `${[label, label, label].join('.')}.${'b'.repeat(57)}.org`;
    expect(longest).toHaveLength(253);
    expect(asciiDomain(longest)).toBe(longest);
    expect(asciiDomain(`c${longest}`)).toBeNull();
  });
});

describe('internationalised domains', () => {
  it('shows a Unicode domain in its ASCII (punycode) form', () => {
    expect(issuerFromEmail('anna@bücher.de')).toEqual({ kind: 'domain', domain: 'xn--bcher-kva.de', statement: 'Issued by a Link To Card account verified at @xn--bcher-kva.de' });
    expect(asciiDomain('xn--bcher-kva.de')).toBe('xn--bcher-kva.de');
  });

  it('never lets a look-alike in another script pass for the real domain', () => {
    // "gmaіl.com" with CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I (U+0456).
    const issuer = issuerFromEmail('a@gmaіl.com');
    expect(issuer.kind).toBe('domain');
    expect(issuer.domain).toMatch(/^xn--/);
    expect(issuer.statement).not.toContain('gmail.com');
    expect(issuer.statement).not.toMatch(/[^\x20-\x7e]/);
  });

  it('folds full-width letters the way browsers do, so a provider is still recognised', () => {
    expect(asciiDomain('ｇｍａｉｌ.com')).toBe('gmail.com');
    expect(issuerFromEmail('a@ｇｍａｉｌ.com').kind).toBe('personal');
  });

  it('turns away Unicode that is not a host name', () => {
    expect(asciiDomain('exa‮mple.org')).toBeNull();
    expect(asciiDomain('example。org')).toBeNull();
    expect(asciiDomain('😀.org')).toBeNull();
  });
});

describe('PUBLIC_MAILBOX_DOMAINS', () => {
  it('holds only lower-case ASCII host names', () => {
    for (const domain of PUBLIC_MAILBOX_DOMAINS) expect(asciiDomain(domain), domain).toBe(domain);
  });
});
