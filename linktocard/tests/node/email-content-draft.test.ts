// The personalized email image pages: /docs/email-images and /guides/personalized-email-images.
// They are drafts (site/content/docs/email-images.md.draft, site/content/guides/
// personalized-email-images.md.draft) until scripts/build-site.ts knows the "email" feature and
// the tokens of scripts/email-site-tokens.ts, so this test reads the files itself (the .md once
// renamed, the .md.draft before) and checks what the build would not:
//   - front matter: a docs page and a guide, both behind the "email" feature;
//   - every [[token]] exists or waits for a named config value, and no config number is typed;
//   - the platform merge-tag table lists only platforms checked in their vendor's own GitHub
//     organization, and every row carries its source in an HTML comment;
//   - every other vendor the pages name has a source comment on the same page;
//   - the worked example verifies with the server's own verifiers, and the reference signer of
//     /docs/signed-urls prints it;
//   - the value table, the rules, the reasons, the templates and the cache lifetime are what
//     src/lib/open-fields.ts, src/config.ts and the email starter templates really do;
//   - every link and anchor exists, and the Markdown renders as intended (tables keep their rows,
//     pipes inside merge tags stay in the code, source comments never show).
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER, TOPUP } from '../../src/billing/plans';
import { BATCH, DAY_MS, EMAIL_FIELDS, HTTP_CACHE, INSPECT, LIMITS, LINK_CARDS, PDF, PDF_TOOLKIT, RATE_LIMITS, SIZES } from '../../src/config';
import { canonicalString, verifySignedUrl } from '../../src/lib/signed-url';
import { emailBanner } from '../../src/render/templates/email-banner';
import { emailOffer } from '../../src/render/templates/email-offer';
import { listTokens, renderSite, type RenderedSite } from '../../scripts/build-site';
import { emailSiteTokens, pendingEmailConfigTokens } from '../../scripts/email-site-tokens';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-26T12:00:00Z');
const SECRET = 'ltcs_EXAMPLE_ONLY_not_a_real_secret_0123456789ab';
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/* ------------------------------------------------------------------ */
/* The drafts                                                          */
/* ------------------------------------------------------------------ */

interface Page {
  key: 'docs' | 'guide';
  /** Published path without extension, relative to site/content. */
  stem: string;
  url: string;
  keys: string[];
  layout: string;
}

const PAGES: Record<Page['key'], Page> = {
  docs: { key: 'docs', stem: 'docs/email-images', url: '/docs/email-images', keys: ['description', 'feature', 'layout', 'nav', 'order', 'title'], layout: 'doc' },
  guide: { key: 'guide', stem: 'guides/personalized-email-images', url: '/guides/personalized-email-images', keys: ['description', 'feature', 'layout', 'title'], layout: 'page' },
};

/** The site feature that publishes both pages (contract: SITE_FEATURES "email"). */
const FEATURE = 'email';

/** The page as published (.md) once renamed, the draft (.md.draft) before. */
function pageFile(page: Page): string {
  const published = `site/content/${page.stem}.md`;
  return existsSync(join(ROOT, published)) ? published : `${published}.draft`;
}

const source = (page: Page): string => read(pageFile(page));

function frontMatter(text: string, file: string): { data: Record<string, string>; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${file}: no front matter`);
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const value = line.slice(colon + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    data[line.slice(0, colon).trim()] = quoted ? (quoted[2] ?? '') : value;
  }
  return { data, body: text.slice(match[0].length) };
}

const body = (page: Page): string => frontMatter(source(page), page.stem).body;

/** Fenced code blocks with their language, in document order. */
const codeBlocks = (markdown: string, lang?: string): string[] =>
  [...markdown.matchAll(/^```([\w-]*)\n([\s\S]*?)^```$/gm)].filter((match) => lang === undefined || match[1] === lang).map((match) => match[2] ?? '');

const withoutCode = (markdown: string): string => markdown.replace(/^```[\w-]*\n[\s\S]*?^```$/gm, '');

/** Markdown section under a heading, up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const level = heading.indexOf(' ');
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line) && line.indexOf(' ') <= level);
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/**
 * Rows of the first Markdown table in `markdown`, as cells. Cells are split at unescaped pipes
 * only, and `\|` becomes `|` afterwards, as GFM does: merge tags such as *|FNAME|* need it.
 */
function tableRows(markdown: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^\|.*\|$/.test(line));
  if (start < 0) throw new Error('no table');
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!/^\|.*\|$/.test(line)) break;
    rows.push(line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|')));
  }
  return rows;
}

/** `code` spans of a table cell or a line. */
const codeSpans = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');

/** The heading ids the build gives the headings of a Markdown file (scripts/build-site.ts slugify). */
function headingIds(markdown: string): Set<string> {
  const used = new Map<string, number>();
  const ids = new Set<string>();
  for (const match of withoutCode(markdown).matchAll(/^#{1,6} (.+)$/gm)) {
    const text = (match[1] ?? '').replace(/`/g, '');
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    ids.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return ids;
}

/** HTML comments of a text, without their delimiters. */
const comments = (text: string): string[] => [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((match) => (match[1] ?? '').trim());

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const TOKEN_RE = /(\\?)\[\[(?:>\s*([a-z][a-z0-9-]*)\s*|([a-zA-Z][\w.]*))\]\]/g;
/** What a pending token prints in this test: never a number, so the number checks still see the prose. */
const PENDING_VALUE = 'PENDING';

let tokens: Record<string, string>;
let pending: Readonly<Record<string, string>>;
let partials: string[];
beforeAll(() => {
  const listing = listTokens({ env: {}, now: NOW });
  tokens = { ...listing.tokens, ...emailSiteTokens() };
  pending = pendingEmailConfigTokens();
  partials = listing.partials;
});

/** The text with every token replaced by its value, as a reader would see it. */
function expandTokens(text: string): string {
  return text.replace(TOKEN_RE, (match: string, escaped: string, partial?: string, name?: string) => {
    if (escaped) return match.slice(1);
    if (partial !== undefined) return '';
    return tokens[name ?? ''] ?? (Object.hasOwn(pending, name ?? '') ? PENDING_VALUE : match);
  });
}

/* ------------------------------------------------------------------ */
/* src/lib/open-fields.ts, loaded at run time                          */
/* ------------------------------------------------------------------ */

type OpenVerifyResult = { ok: true; params: Record<string, string>; openFields: string[]; fallbackParams: Record<string, string> } | { ok: false; reason: string };

/** The part of src/lib/open-fields.ts this test calls. */
interface OpenFieldsModule {
  OPEN_PARAM: string;
  DEFAULT_SUFFIX: string;
  OPEN_RESERVED_PARAMS: readonly string[];
  normaliseOpenValue(raw: string): string | null;
  verifyWithOpenFields(url: URL, secret: string): Promise<OpenVerifyResult>;
  describeOpenFieldsFailure(reason: string): string;
  openFieldsCacheControl(expiresAt: number, now: number): string;
}

const OPEN_FIELDS_FILE = 'src/lib/open-fields.ts';
let openFields: OpenFieldsModule;
beforeAll(async () => {
  // open-fields.ts imports types that only the Worker build knows (src/types.ts: D1, R2), which
  // tsconfig.node.json cannot check. At run time it is plain TypeScript, so it is loaded by path:
  // the claims below are checked against the code itself, not a copy of its rules.
  const path = join(ROOT, OPEN_FIELDS_FILE);
  openFields = (await import(/* @vite-ignore */ path)) as OpenFieldsModule;
});

/* ------------------------------------------------------------------ */
/* Config numbers                                                      */
/* ------------------------------------------------------------------ */

const MB = 1024 * 1024;

/** Every number of the configuration, in each unit a page could print it in (KB, MB, seconds, minutes, hours, days). */
function configNumbers(): Set<number> {
  const numbers = new Set<number>();
  const add = (value: number): void => {
    numbers.add(value);
    for (const unit of [1024, MB]) if (value % (unit / 2) === 0 && value >= unit) numbers.add(value / unit);
    for (const unit of [1000, 60_000, 3_600_000, DAY_MS]) if (value % unit === 0 && value >= unit) numbers.add(value / unit);
    if (value % 86_400 === 0 && value >= 86_400) numbers.add(value / 86_400);
  };
  const walk = (value: unknown): void => {
    if (typeof value === 'number') add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk([EMAIL_FIELDS, SIZES, LIMITS, HTTP_CACHE, RATE_LIMITS, PLANS, TOPUP, INSPECT, PDF, BATCH, PDF_TOOLKIT, LINK_CARDS]);
  // 0 and 1 are words of every sentence ("1 image", "at least one"), not limits.
  for (const trivial of [0, 1]) numbers.delete(trivial);
  return numbers;
}

/**
 * HTTP statuses, printed as statuses ("answers 402 `quota_exceeded`", "403 `invalid_signature`",
 * "answers 304"), are not config numbers. Unlike the other docs tests, a number in a table cell is
 * not taken for a status: these pages have no status column, and a limit typed into a table
 * ("| 200 |") must fail.
 */
const STATUS_AS_STATUS = /\b([1-5]\d\d)(?=\s*`)|\banswers ([1-5]\d\d)\b/g;

/**
 * The prose of a page as the numbers check sees it: the description and the body, without code,
 * tokens, HTML tags and comments, link targets and the numbers of ordered lists.
 */
function prose(page: Page): string {
  const { data, body: markdown } = frontMatter(source(page), page.stem);
  return `${data.description ?? ''}\n${withoutCode(markdown)}`
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*\d+\. /gm, ' ')
    .replace(/^#{1,6} \d+\. /gm, ' ')
    .replace(STATUS_AS_STATUS, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(TOKEN_RE, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ');
}

/* ------------------------------------------------------------------ */
/* Vendors                                                             */
/* ------------------------------------------------------------------ */

/**
 * The platforms of the merge-tag table, each with the GitHub organization whose own documentation
 * or code the row was checked in. A platform whose syntax was not verified there is not listed.
 */
const TABLE_PLATFORMS: Readonly<Record<string, string>> = {
  Mailchimp: 'mailchimp',
  'Mailchimp Transactional': 'mailchimp',
  HubSpot: 'HubSpot',
  Brevo: 'getbrevo',
  Kit: 'Kit',
  'Customer.io': 'customerio',
  MailerLite: 'mailerlite',
};

/**
 * Vendors the pages may name outside the table, each with where its source must point. A page
 * that names one must carry a source comment with that address on the same page.
 */
const CITED_VENDORS: Readonly<Record<string, string>> = {
  Apple: 'https://developer.apple.com/videos/play/wwdc2021/10085/',
  Brevo: 'https://github.com/getbrevo/brevo-skills/',
};

/** Vendors whose behaviour or syntax could not be checked in their own documentation: never named. */
const UNVERIFIED_VENDORS = ['Klaviyo', 'ActiveCampaign', 'beehiiv', 'Gmail', 'Google', 'Outlook', 'Microsoft', 'Yahoo', 'SendGrid', 'Constant Contact', 'Litmus'];

/* ------------------------------------------------------------------ */
/* Pages and front matter                                              */
/* ------------------------------------------------------------------ */

describe('the email image pages', () => {
  it('are a docs page and a guide behind the email feature, the docs page in a free place of the docs order', () => {
    for (const page of Object.values(PAGES)) {
      const { data } = frontMatter(source(page), page.stem);
      expect(Object.keys(data).sort(), page.stem).toEqual(page.keys);
      expect(data.layout, page.stem).toBe(page.layout);
      expect(data.feature, page.stem).toBe(FEATURE);
      expect(data.title, page.stem).not.toBe('');
      expect(data.description?.length, page.stem).toBeGreaterThan(80);
      expect(data.description, page.stem).not.toMatch(TOKEN_RE);
    }
    const { data } = frontMatter(source(PAGES.docs), 'docs');
    expect(data.nav).toBe('Email images');
    const taken = readdirSync(join(ROOT, 'site/content/docs'))
      .filter((file) => /\.md(?:\.draft)?$/.test(file) && !file.startsWith('email-images.'))
      .map((file) => `site/content/docs/${file}`)
      .concat('site/content/docs.md')
      .map((file) => Number(frontMatter(read(file), file).data.order));
    const order = Number(data.order);
    expect(Number.isFinite(order)).toBe(true);
    expect(taken, `order ${order} is taken`).not.toContain(order);
  });

  it('use only tokens and partials that exist, or that wait for a named config value', () => {
    const used = new Set<string>();
    for (const page of Object.values(PAGES)) {
      for (const match of source(page).matchAll(TOKEN_RE)) {
        if (match[1]) continue;
        if (match[2] !== undefined) {
          expect(partials, `${page.stem}: [[> ${match[2]}]]`).toContain(match[2]);
          continue;
        }
        const name = match[3] ?? '';
        used.add(name);
        expect(Object.hasOwn(tokens, name) || Object.hasOwn(pending, name), `${page.stem}: unknown token [[${name}]]`).toBe(true);
      }
    }
    for (const name of Object.keys(emailSiteTokens())) expect(used.has(name), `[[${name}]] is defined but unused`).toBe(true);
    for (const name of Object.keys(pending)) expect(used.has(name), `${name} is pending but unused`).toBe(true);
  });

  it('wait for the email size preset only while src/config.ts lacks it', () => {
    const preset = (SIZES as Record<string, { width: number; height: number } | undefined>).email;
    if (preset === undefined) {
      expect(Object.keys(pending).sort()).toEqual(['size.email.height', 'size.email.width']);
    } else {
      expect(pending).toEqual({});
      expect(tokens['size.email.width']).toBe(String(preset.width));
      expect(tokens['size.email.height']).toBe(String(preset.height));
    }
  });

  it('have no feature blocks, and no comment that the build would read as one', () => {
    for (const page of Object.values(PAGES)) expect(source(page), page.stem).not.toMatch(/<!--[^>]*?\bfeature\s*:/);
  });

  it('type no number of the configuration: every limit and duration is a token', () => {
    const numbers = configNumbers();
    for (const page of Object.values(PAGES)) {
      const typed = [...prose(page).matchAll(/(?<![\w#.\-/:@%])(\d+(?:[.,]\d+)*)(?![\w%])/g)]
        .map((match) => ({ raw: match[1] ?? '', value: Number((match[1] ?? '').replace(/,/g, '')) }))
        .filter(({ value }) => numbers.has(value));
      expect(typed.map(({ raw }) => raw), `${page.stem} types config numbers; use a token`).toEqual([]);
    }
  });

  it('print no price, no other payment provider, no placeholder and no local address', () => {
    for (const page of Object.values(PAGES)) {
      const text = source(page);
      expect(text, page.stem).not.toMatch(/\$\d/);
      expect(text, page.stem).not.toMatch(/stripe|lemon\s*squeezy/i);
      expect(text, page.stem).not.toMatch(/\bTODO\b|\bFIXME\b|\bTBD\b/i);
      expect(text, page.stem).not.toMatch(/localhost|127\.0\.0\.1/);
    }
  });

  it('render as intended: tables keep their rows, merge tags keep their pipes, source comments stay hidden', () => {
    const marked = new Marked({ gfm: true });
    for (const page of Object.values(PAGES)) {
      const markdown = expandTokens(body(page));
      const html = marked.parse(markdown, { async: false });
      const tableLines = withoutCode(markdown).split('\n').filter((line) => /^\|.*\|$/.test(line) && !/^\|(?:\s*-+\s*\|)+$/.test(line));
      expect((html.match(/<tr>/g) ?? []).length, page.stem).toBe(tableLines.length);
      // Every source comment survives as a comment, never as text a reader sees.
      const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
      expect(visible, page.stem).not.toMatch(/source:|read 2026-/i);
      expect(comments(html).length, page.stem).toBe(comments(markdown).length);
    }
    const guideHtml = marked.parse(body(PAGES.guide), { async: false });
    expect(guideHtml).toContain('<code>*|FNAME|*</code>');
    expect(guideHtml).toContain('<code>*|URL:FNAME|*</code>');
    expect(guideHtml).toContain('<code>{{ contact.firstname|urlencode }}</code>');
  });
});

/* ------------------------------------------------------------------ */
/* Vendor facts                                                        */
/* ------------------------------------------------------------------ */

describe('vendor facts of the email image pages', () => {
  const table = (): string[][] => tableRows(section(body(PAGES.guide), '## Merge tags by platform'));

  it('list only platforms checked in their own GitHub organization, each row with its sources in a comment', () => {
    const rows = table();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row, row.join(' | ')).toHaveLength(3);
      const platform = (row[0] ?? '').replace(/\s*\(.*\)$/, '');
      const org = TABLE_PLATFORMS[platform];
      expect(org, `${platform} is not a platform whose syntax was verified`).toBeDefined();
      expect(codeSpans(row[1] ?? '').length, `${platform}: the tag is a code span`).toBe(1);
      const last = row[2] ?? '';
      const notes = comments(last);
      expect(notes, `${platform}: one source comment, at the end of the row`).toHaveLength(1);
      expect(last.trimEnd().endsWith('-->'), platform).toBe(true);
      expect(notes[0], platform).toMatch(/^source: /);
      const urls = [...(notes[0] ?? '').matchAll(/https:\/\/[^\s;)]+/g)].map((match) => match[0]);
      expect(urls.length, `${platform}: a source URL`).toBeGreaterThan(0);
      for (const url of urls) expect(url, platform).toMatch(new RegExp(`^https://github\\.com/${org}/[^/]+/blob/`));
      expect(notes[0], platform).toMatch(/read \d{4}-\d{2}-\d{2}/);
      // The encoding column is either a code span or a dash: nothing in between.
      const encoding = last.replace(/<!--[\s\S]*?-->/, '').trim();
      expect(encoding === '-' || /^`[^`]+`$/.test(encoding), `${platform}: "${encoding}"`).toBe(true);
    }
    // Every table platform has its note under the table.
    const notes = section(body(PAGES.guide), '## Merge tags by platform');
    for (const row of rows) expect(notes, row[0]).toContain(`**${(row[0] ?? '').replace(/\s*\(.*\)$/, '').replace(/ Transactional$/, '')}`);
  });

  it('name no vendor whose syntax or behaviour could not be checked', () => {
    for (const page of Object.values(PAGES)) {
      const text = source(page);
      for (const vendor of UNVERIFIED_VENDORS) expect(text, `${page.stem} names ${vendor}`).not.toMatch(new RegExp(`\\b${vendor}\\b`, 'i'));
    }
  });

  it('cite every vendor they name outside the table on the same page', () => {
    for (const page of Object.values(PAGES)) {
      const text = source(page);
      const outsideTable = page.key === 'guide' ? text.replace(section(body(page), '## Merge tags by platform'), '') : text;
      const sources = comments(text).join('\n');
      for (const [vendor, url] of Object.entries(CITED_VENDORS)) {
        if (!new RegExp(`\\b${vendor}\\b`).test(withoutCode(outsideTable.replace(/<!--[\s\S]*?-->/g, '')))) continue;
        expect(sources, `${page.stem} names ${vendor} without a source comment`).toContain(url);
      }
    }
  });

  it('quote Apple word for word from the cited transcript', () => {
    // The two quotes of the WWDC21 transcript, as read on 2026-11-26.
    const transcript = [
      'Since Mail content may be loaded automatically after delivery, the time of Mail viewing will no longer be correct.',
      "And you'll see your emails as being opened, regardless of if the user read it or not.",
    ].join(' ');
    let quoted = 0;
    for (const page of Object.values(PAGES)) {
      // A quote follows "Apple says" within the same sentence.
      for (const match of withoutCode(body(page)).matchAll(/Apple says[^".\n]*"([^"]+)"(?:[^".\n]*"([^"]+)")?/g)) {
        for (const quote of [match[1], match[2]].filter((text): text is string => text !== undefined)) {
          expect(transcript, `${page.stem}: "${quote}"`).toContain(quote);
          quoted += 1;
        }
      }
    }
    expect(quoted).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* What the pages say against what the code does                       */
/* ------------------------------------------------------------------ */

describe('/docs/email-images against the code', () => {
  const markdown = (): string => body(PAGES.docs);
  const published = (): string => codeBlocks(markdown(), 'text').find((block) => block.startsWith('https://linktocard.com/v1/og/'))?.trim() ?? '';

  it('prints a worked example that the server verifies, with the open field last and empty', async () => {
    const blocks = codeBlocks(markdown(), 'text');
    const canonical = blocks.find((block) => block.startsWith('/v1/og/'))?.trimEnd() ?? '';
    const signature = blocks.find((block) => /^[0-9a-f]{64}\n$/.test(block))?.trim() ?? '';
    const link = published();
    expect(markdown()).toContain(SECRET);
    expect(createHmac('sha256', SECRET).update(canonical, 'utf8').digest('hex')).toBe(signature);
    expect(link.endsWith(`&sig=${signature}&name=`)).toBe(true);

    // The signed message is the one of the URL without its open fields.
    const url = new URL(link);
    expect(url.searchParams.get(openFields.OPEN_PARAM)).toBe('name');
    const signedOnly = new URL(link.slice(0, -'&name='.length));
    const params = [...signedOnly.searchParams].filter(([name]) => name !== 'sig');
    expect(canonicalString(signedOnly.pathname, params)).toBe(canonical);
    expect(canonical.split('\n').some((line) => line.startsWith('name='))).toBe(false);
    expect((await verifySignedUrl(signedOnly, SECRET)).ok).toBe(true);

    // What the reader sees: the value, or the default when nothing was filled in.
    const maya = await openFields.verifyWithOpenFields(new URL(`${link}Maya`), SECRET);
    const empty = await openFields.verifyWithOpenFields(url, SECRET);
    expect(maya.ok && maya.params.name).toBe('Maya');
    expect(empty.ok && empty.params.name).toBe('there');
    expect(markdown()).toContain('"Hi Maya,"');
    expect(markdown()).toContain('"Hi there,"');
    // The table of inputs lists exactly what was signed.
    const inputs = Object.fromEntries(
      (blocks.find((block) => block.startsWith('secret '))?.split('\n') ?? [])
        .map((line) => /^(\w+)\s{2,}(.+)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1], match[2]]),
    );
    expect(Object.fromEntries(params)).toEqual(Object.fromEntries(Object.entries(inputs).filter(([name]) => !['secret', 'site', 'template'].includes(name))));
  });

  it('prints a Node.js call that makes the published URL with the reference signer of /docs/signed-urls', () => {
    type Signer = (input: { secret: string; baseUrl: string; siteId: string; template: string; ext?: string; params: Record<string, string> }) => string;
    const signerBlock = codeBlocks(frontMatter(read('site/content/docs/signed-urls.md'), 'signed-urls').body, 'js').find((code) => code.includes('function signedCardUrl('));
    if (!signerBlock) throw new Error('/docs/signed-urls has no Node.js signer');
    const importLine = "import { createHmac } from 'node:crypto';\n";
    expect(signerBlock.startsWith(importLine)).toBe(true);
    const call = codeBlocks(markdown(), 'js').find((code) => code.includes('signedCardUrl('));
    if (!call) throw new Error('/docs/email-images has no signer call');
    const script = `${signerBlock.slice(importLine.length)}\nconst process = { env: { LTC_SITE_SECRET: ${JSON.stringify(SECRET)} } };\n${expandTokens(call)}\nreturn url;`;
    const made = new Function('createHmac', script)(createHmac) as ReturnType<Signer>;
    expect(made).toBe(published());
  });

  it('says what an open value turns into, row by row, as normaliseOpenValue and the verifier do', async () => {
    const rows = tableRows(section(markdown(), '## What a value may contain'));
    expect(rows.length).toBeGreaterThan(10);
    const base = published();
    for (const [sent = '', shown = ''] of rows) {
      const query = codeSpans(sent)[0] ?? '';
      expect(query.startsWith('name='), sent).toBe(true);
      const result = await openFields.verifyWithOpenFields(new URL(base + query.slice('name='.length)), SECRET);
      if (shown.startsWith('no image')) {
        expect(result.ok, sent).toBe(false);
        expect(shown).toContain('403 `invalid_signature`');
      } else if (shown.startsWith('the default')) {
        expect(result.ok && result.params.name, sent).toBe('there');
      } else {
        expect(result.ok && result.params.name, sent).toBe(codeSpans(shown)[0]);
      }
    }
    // The length rule, at the limit and one past it.
    const max = EMAIL_FIELDS.maxValueChars;
    expect(openFields.normaliseOpenValue('W'.repeat(max))).toBe('W'.repeat(max));
    expect(openFields.normaliseOpenValue('W'.repeat(max + 1))).toBeNull();
    // The punctuation the page lists is exactly what a value may hold.
    const listed = /contains only letters, digits, spaces and ([^,\n]+(?:, [^,\n]+)*?), with at least/.exec(markdown())?.[1] ?? '';
    const marks = codeSpans(listed)[0]?.split(' ') ?? [];
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(openFields.normaliseOpenValue(`a${mark}b`), mark).toBe(`a${mark}b`);
    for (const other of ['/', ':', ';', '(', ')', '<', '>', '"', '=', '+', '*', '_', '%', '$', '~']) expect(openFields.normaliseOpenValue(`a${other}b`), other).toBeNull();
    // Letters of the scripts the page names, and of one it says falls back.
    for (const word of ['Zoë', 'Nguyễn', 'Σοφία', 'Мария']) expect(openFields.normaliseOpenValue(word), word).toBe(word);
    for (const word of ['مريم', 'מרים', '李']) expect(openFields.normaliseOpenValue(word), word).toBeNull();
    expect(openFields.normaliseOpenValue('---')).toBeNull();
  });

  it('lists the rules of open as the module enforces them', async () => {
    const rows = tableRows(section(markdown(), '### Rules for open'));
    const rule = (name: string): string => rows.find((row) => row[0] === name)?.[1] ?? '';
    expect(rule('How many')).toContain('[[email.maxOpenFields]]');
    expect(codeSpans(rule('Reserved'))).toEqual([...openFields.OPEN_RESERVED_PARAMS, openFields.DEFAULT_SUFFIX]);
    expect(rule('Number of parameters')).toContain('[[limit.maxDataKeys]]');
    expect(rule('URL length')).toContain('[[limit.maxSignedUrlChars]]');

    const base = 'https://linktocard.com/v1/og/s_1/email-banner.png?title=Hi&sig=' + '0'.repeat(64);
    const reason = async (query: string): Promise<string> => {
      const result = await openFields.verifyWithOpenFields(new URL(`${base}&${query}`), SECRET);
      return result.ok ? 'ok' : result.reason;
    };
    const tooMany = Array.from({ length: EMAIL_FIELDS.maxOpenFields + 1 }, (_, index) => `f${index}`).join(',');
    expect(await reason(`open=${tooMany}`)).toBe('too_many_open_fields');
    expect(await reason('open=name, code')).toBe('bad_open_list');
    expect(await reason('open=name,name')).toBe('bad_open_list');
    for (const name of [...openFields.OPEN_RESERVED_PARAMS, `name${openFields.DEFAULT_SUFFIX}`]) expect(await reason(`open=${name}`), name).toBe('reserved_open_field');
    expect(await reason('open=name&open=code')).toBe('duplicate_param');
    expect(await reason('open=name&name=A&name=B')).toBe('duplicate_param');
  });

  it('lists the failure reasons that only open fields have, with the duplicate rule the page names', () => {
    const union = /export type OpenFieldsFailure = SignedUrlFailure((?: \| '[a-z_]+')+);/.exec(read(OPEN_FIELDS_FILE))?.[1];
    if (!union) throw new Error(`${OPEN_FIELDS_FILE} no longer declares OpenFieldsFailure`);
    const own = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    const rows = tableRows(section(markdown(), '## Errors'));
    expect(rows.map((row) => codeSpans(row[0] ?? '')[0])).toEqual(own);
    for (const reason of own) expect(openFields.describeOpenFieldsFailure(reason ?? '')).not.toBe('');
    expect(section(markdown(), '## Errors')).toContain('`duplicate_param`');
  });

  it('gives the cache lifetime the module sends: up to the configured days, never past the stored image', () => {
    const now = Date.UTC(2026, 10, 26);
    expect(openFields.openFieldsCacheControl(now + 400 * DAY_MS, now)).toBe(`public, max-age=${EMAIL_FIELDS.maxAgeSeconds}`);
    expect(openFields.openFieldsCacheControl(now + 2 * DAY_MS, now)).toBe(`public, max-age=${(2 * DAY_MS) / 1000}`);
    expect(tokens['email.maxAgeDays']).toBe(String((EMAIL_FIELDS.maxAgeSeconds * 1000) / DAY_MS));
    expect(section(markdown(), '## Caching and what counts')).toContain('`Cache-Control: public, max-age=...` of up to [[email.maxAgeDays]] days');
  });

  it('prints the daily limit of every plan, in plan order, and says Free images carry the mark', () => {
    const rows = tableRows(section(markdown(), '## The daily limit per site'));
    expect(rows.map((row) => row[0])).toEqual(PLAN_ORDER.map((id) => `[[plan.${id}.name]]`));
    expect(rows.map((row) => row[1])).toEqual(PLAN_ORDER.map((id) => `[[email.daily${id[0]?.toUpperCase()}${id.slice(1)}]]`));
    expect(rows.map((row) => expandTokens(row[1] ?? ''))).toEqual(PLAN_ORDER.map((id) => EMAIL_FIELDS.maxUniqueRendersPerDay[id].toLocaleString('en-US')));
    expect(PLANS.free.watermark).toBe(true);
    expect(PLAN_ORDER.filter((id) => id !== 'free').every((id) => !PLANS[id].watermark)).toBe(true);
    expect(markdown()).toContain('On the [[plan.free.name]] plan, personalized images carry the small `[[site.host]]` mark');
  });

  it('names the headers of the default image past the daily limit as the og route sends them, once it has open fields', () => {
    const og = read('src/routes/og.ts');
    const text = section(markdown(), '## The daily limit per site');
    expect(text).toContain('`Cache-Control: no-store` and `X-LTC-Open-Fields: daily-limit`');
    // The route is wired by the integrator (contract O3: src/routes/og.ts); until then there is nothing to compare.
    if (!og.includes('verifyWithOpenFields')) return;
    expect(og).toContain("'x-ltc-open-fields', 'daily-limit'");
    expect(og).toMatch(/'no-store\b/);
  });

  it('lists the email starter templates with their own fields, in order', () => {
    const rows = tableRows(section(markdown(), '## Email starter templates'));
    expect(rows.map((row) => codeSpans(row[0] ?? '')[0])).toEqual([emailBanner.id, emailOffer.id]);
    for (const [row, template] of [[rows[0], emailBanner], [rows[1], emailOffer]] as const) {
      expect(codeSpans(row?.[2] ?? ''), template.id).toEqual(template.fields.map((field) => field.name));
      expect(template.fields.filter((field) => field.required).map((field) => field.name), template.id).toEqual(['title']);
      expect(template.fields.some((field) => field.name === 'name'), template.id).toBe(true);
    }
    expect(rows[0]?.[1]).toContain('`size=email`');
    expect(emailOffer.fields.some((field) => field.name === 'code')).toBe(true);
    // "they also work at the other sizes": the Workers suite renders both at every preset of SIZES.
    expect(read('tests/email-templates.test.ts')).toContain('const PRESETS: readonly Size[] = Object.values(SIZES)');
  });
});

describe('/guides/personalized-email-images against the docs', () => {
  it('uses the worked example of the docs, character for character', () => {
    const docsUrl = codeBlocks(body(PAGES.docs), 'text').find((block) => block.startsWith('https://linktocard.com/v1/og/'))?.trim() ?? '';
    const guideUrl = codeBlocks(expandTokens(body(PAGES.guide)), 'text').find((block) => block.startsWith('https://linktocard.com/v1/og/'))?.trim();
    expect(guideUrl).toBe(docsUrl);
    const sig = new URL(docsUrl).searchParams.get('sig') ?? '';
    expect(codeBlocks(body(PAGES.guide), 'text').some((block) => block.includes(`&sig=${sig}&name=YOUR_MERGE_TAG`))).toBe(true);
  });

  it('has an FAQ, a way to start and a link to the exact rules', () => {
    const markdown = body(PAGES.guide);
    expect((section(markdown, '## FAQ').match(/^### /gm) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(markdown).toContain('](/login)');
    expect(markdown).toContain('](/docs/email-images)');
    expect(markdown).toContain('We could not open the email platforms\' help pages while writing this guide.');
  });
});

describe('links of the email image pages', () => {
  let site: RenderedSite;
  beforeAll(() => {
    site = renderSite({ env: { SITE_PDF: 'on' }, now: NOW });
  });

  it('point only to pages and anchors that exist', () => {
    const own = new Map(Object.values(PAGES).map((page) => [page.url, headingIds(body(page))]));
    const built = new Map(site.pages.map((page) => [page.url, page.html]));
    for (const page of Object.values(PAGES)) {
      const markdown = withoutCode(body(page)).replace(/<!--[\s\S]*?-->/g, '');
      const hrefs = [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
      expect(hrefs.length, page.stem).toBeGreaterThan(0);
      for (const href of hrefs) {
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split('#');
        const target = path === '' ? page.url : (path ?? '');
        expect(own.has(target) || built.has(target), `${page.stem} links to ${href}`).toBe(true);
        if (!anchor) continue;
        if (own.has(target)) expect([...(own.get(target) ?? [])], `${page.stem} links to ${href}`).toContain(anchor);
        else expect(built.get(target), `${page.stem} links to ${href}`).toContain(` id="${anchor}"`);
      }
    }
  });
});
