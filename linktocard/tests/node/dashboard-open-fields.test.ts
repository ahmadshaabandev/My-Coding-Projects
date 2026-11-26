// The card builder's "open fields" option (personalised email images): the pure rules in
// site/public/assets/js/dashboard/helpers.js (openFieldsSettings, openFieldCandidates,
// signRequest, emailImageTag) and how builder.js uses them. The option exists only while
// GET /api/config switches open fields on, so a production dashboard shows nothing new.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMAIL_FIELDS, LIMITS } from '../../src/config';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JS = join(ROOT, 'site/public/assets/js');
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(JS, name)).href)) as T;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');

type Settings = { maxOpenFields: number | null; maxValueChars: number | null; maxUniqueRendersPerDay: Record<string, number> | null };
interface Helpers {
  OPEN_DEFAULT_SUFFIX: string;
  openFieldsSettings(config: unknown): Settings | null;
  openFieldCandidates(specs: Array<{ name: string }>): string[];
  signRequest(input: { siteId: string; template: string; format: string; size: string; values?: Record<string, string>; open?: string[] }): Record<string, unknown>;
  emailImageTag(url: string, size: { width: number; height: number }, alt?: string): string;
}

const helpers = await load<Helpers>('dashboard/helpers.js');
const specs = (...names: string[]): Array<{ name: string }> => names.map((name) => ({ name }));

describe('the open-fields switch', () => {
  const block = { enabled: true, max_open_fields: EMAIL_FIELDS.maxOpenFields, max_value_chars: EMAIL_FIELDS.maxValueChars, max_unique_renders_per_day: { ...EMAIL_FIELDS.maxUniqueRendersPerDay } };

  it('is off unless /api/config says it is on', () => {
    for (const config of [{}, null, undefined, { email_fields: { enabled: false } }, { email_fields: { enabled: 'true' } }, { email_fields: true }, { email_fields_enabled: 'true' }, { batch: { enabled: true } }]) {
      expect(helpers.openFieldsSettings(config), JSON.stringify(config)).toBeNull();
    }
  });

  it('reads the limits the server sends', () => {
    expect(helpers.openFieldsSettings({ email_fields: block })).toEqual({
      maxOpenFields: EMAIL_FIELDS.maxOpenFields,
      maxValueChars: EMAIL_FIELDS.maxValueChars,
      maxUniqueRendersPerDay: EMAIL_FIELDS.maxUniqueRendersPerDay,
    });
  });

  it('works with a bare switch too, leaving the limits to the server', () => {
    expect(helpers.openFieldsSettings({ email_fields_enabled: true })).toEqual({ maxOpenFields: null, maxValueChars: null, maxUniqueRendersPerDay: null });
    expect(helpers.openFieldsSettings({ email_fields: { enabled: true, max_open_fields: 0, max_value_chars: 'x' } })).toEqual({ maxOpenFields: null, maxValueChars: null, maxUniqueRendersPerDay: null });
  });
});

describe('which fields can be open', () => {
  it('offers the text fields, not the theme switch, image or link fields, or reserved names', () => {
    expect(helpers.openFieldCandidates(specs('title', 'name', 'greeting', 'code', 'theme', 'image', 'logo_url', 'avatar', 'site', 'cta'))).toEqual(['title', 'name', 'greeting', 'code', 'site', 'cta']);
    expect(helpers.openFieldCandidates(specs('open', 'size', 'sig', 'name_default'))).toEqual([]);
    expect(helpers.openFieldCandidates([])).toEqual([]);
  });
});

describe('the body of POST /api/sign', () => {
  const base = { siteId: 's_1', template: 'email-banner', format: 'png', size: 'email' };

  it('without open fields is the ordinary signing request', () => {
    expect(helpers.signRequest({ ...base, values: { title: 'Spring picks', name: '', theme: 'dark' } })).toEqual({
      site_id: 's_1',
      template: 'email-banner',
      format: 'png',
      size: 'email',
      data: { title: 'Spring picks', theme: 'dark' },
    });
  });

  it('sends an open field\'s typed value as its signed default, never as the field', () => {
    const body = helpers.signRequest({ ...base, values: { title: 'Spring picks', name: 'there', code: '' }, open: ['name', 'code'] });
    expect(body).toEqual({ ...{ site_id: 's_1', template: 'email-banner', format: 'png', size: 'email' }, data: { title: 'Spring picks', name_default: 'there' }, open: ['name', 'code'] });
    expect(body.data).not.toHaveProperty('name');
    expect(body.data).not.toHaveProperty('code_default');
  });

  it('keeps the caller\'s lists as they were', () => {
    const open = ['name'];
    const values = { name: 'there' };
    helpers.signRequest({ ...base, values, open });
    expect(open).toEqual(['name']);
    expect(values).toEqual({ name: 'there' });
  });

  it('uses the server\'s own suffix and reserved names', () => {
    const source = read('src/lib/open-fields.ts');
    expect(source).toContain(`export const DEFAULT_SUFFIX = '${helpers.OPEN_DEFAULT_SUFFIX}';`);
    expect(source).toContain("export const OPEN_PARAM = 'open';");
    // `name_default` is a data key the server accepts.
    expect(LIMITS.dataKeyPattern.test(`name${helpers.OPEN_DEFAULT_SUFFIX}`)).toBe(true);
    // /api/sign takes `open` as a list of names and answers { url, canonical, open }.
    const route = read('src/routes/dashboard.ts');
    expect(route).toContain('if (body.open !== undefined) {');
    expect(route).toContain('return c.json({ url, canonical, open: body.open });');
  });
});

describe('the tag for an email', () => {
  it('shows the image at half its pixel size and escapes what it quotes', () => {
    expect(helpers.emailImageTag('https://linktocard.example/v1/og/s_1/email-banner.png?title=A&open=name&sig=ab&name=', { width: 1200, height: 400 }, 'Spring "picks" <now>')).toBe(
      '<img src="https://linktocard.example/v1/og/s_1/email-banner.png?title=A&amp;open=name&amp;sig=ab&amp;name=" width="600" height="200" alt="Spring &quot;picks&quot; &lt;now&gt;">',
    );
    expect(helpers.emailImageTag('u', { width: 1080, height: 1350 })).toBe('<img src="u" width="540" height="675" alt="">');
  });
});

describe('builder.js', () => {
  const source = code('site/public/assets/js/dashboard/builder.js');

  it('offers open fields only in the full builder and only while the switch is on', () => {
    expect(source).toContain('const openSettings = compact ? null : openFieldsSettings(ctx.config);');
    expect(source).toMatch(/const openBox = openSettings\s*\?/);
    expect(source).toMatch(/const emailResult = openSettings\s*\?/);
    expect(source).toContain('const openFields = openSettings ? openNow() : [];');
  });

  it('signs through signRequest, so the open values are never signed', () => {
    expect(source).toContain("api.post('/api/sign', signRequest({");
    expect(source).not.toMatch(/api\.post\('\/api\/sign', \{/);
  });
});
