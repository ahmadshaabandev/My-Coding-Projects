// The dashboard's pure rules (site/public/assets/js/dashboard/helpers.js) and the
// checkout helper it shares with the pricing page. The screens themselves are
// exercised in a real browser against `wrangler dev`, not here; what can be
// checked about them statically (no HTML strings, imports that resolve) is at the end.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP } from '../../src/billing/plans';
import { FORMATS, LIMITS, SIZES } from '../../src/config';
import { STARTER_TEMPLATES } from '../../src/render/templates/index';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(ROOT, 'site/public/assets/js', name)).href)) as T;

type Field = { name: string; description: string; example: string; required: boolean };
type Usage = { limit: number; used: number; remaining: number; topup_remaining: number; total_remaining: number };
type User = { id: string; email: string; plan: string; has_billing: boolean; subscription: { status: string } | null };
type Me = { user: { plan: string }; usage: { topup_remaining: number } };
type Snapshot = { item: string; plan: string; topup_remaining: number };
type BillingAction = { type: string; item?: string; plan?: string };
type Render = { template: string; source: string; width: number; height: number; format: string; bytes: number; charged_to: string };

interface Helpers {
  TABS: Array<{ id: string; label: string }>;
  KEY_PLACEHOLDER: string;
  BLANK_TEMPLATE: { name: string; html: string; css: string };
  routeFromHash(hash: string): { tab: string; param: string };
  detectPlaceholders(html: string): string[];
  customTemplateFields(html: string, css: string): Field[];
  fieldLabel(name: string): string;
  sampleValue(name: string): string;
  initialValues(fields: Array<{ name: string }>, known?: Record<string, unknown>, fallback?: (name: string) => string): Record<string, string>;
  cardData(values: Record<string, unknown>): Record<string, string>;
  starterValues(fields: Field[], sample?: Record<string, string>): Record<string, string>;
  templateSaveProblem(html: string): string | null;
  parseWarnings(header: string | null): string[];
  insertIndent(value: string, start: number, end: number): { value: string; caret: number };
  formatCount(count: number): string;
  formatBytes(bytes: number): string;
  formatDate(iso: string, timeZone?: string): string;
  formatDateTime(iso: string, timeZone?: string): string;
  sizeOption(size: { id: string; width: number; height: number }): { value: string; label: string; detail: string };
  renderSummary(render: Render, names?: Record<string, string>): Record<'template' | 'via' | 'size' | 'format' | 'bytes' | 'counted', string>;
  usageView(usage: Usage): { percent: number; level: string; exhausted: boolean };
  pdfUsageLine(usage: Usage & { pdf?: unknown }, config: { pdf_enabled?: boolean } | null): string | null;
  billingActions(user: User, config: { paddle: unknown; plans?: Array<{ id: string; top_ups: boolean }> } | null): BillingAction[];
  moreImagesHint(actions: BillingAction[]): string;
  checkoutSnapshot(item: string, me: Me): Snapshot;
  checkoutSettled(before: Snapshot, me: Me): boolean;
  pollUntil<T>(
    loadValue: () => Promise<T>,
    done: (value: T) => boolean,
    options?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<{ value: T; settled: boolean }>;
  guideStage(input: { siteCount: number; finished: boolean }): string;
  curlExample(origin: string, secret?: string): string;
  fontCssExample(family: string, weight?: number, style?: string): string;
  fontUploadUrl(descriptor: { family: string; weight: number; style: string }): string;
  fontSizeProblem(fileBytes: number, maxBytes: number): string | null;
}

type CheckoutResult = { type: string; url?: string; message?: string; environment?: string; token?: string; options?: Record<string, unknown> };
interface Checkout {
  checkoutAction(input: { item: string; user: unknown; config: unknown; origin: string }): CheckoutResult;
  openCheckout(action: CheckoutResult): Promise<void>;
}

const helpers = await load<Helpers>('dashboard/helpers.js');
const usage = (used: number, limit: number, topup = 0): Usage => {
  const remaining = Math.max(0, limit - used);
  return { limit, used, remaining, topup_remaining: topup, total_remaining: remaining + topup };
};

describe('dashboard routing', () => {
  it('has one tab per screen, in the order the brief lists them', () => {
    expect(helpers.TABS.map((tab) => tab.id)).toEqual(['overview', 'sites', 'templates', 'keys', 'fonts', 'renders']);
    for (const tab of helpers.TABS) expect(tab.label.length).toBeGreaterThan(0);
  });

  it('reads the tab and its parameter from the hash', () => {
    expect(helpers.routeFromHash('#sites')).toEqual({ tab: 'sites', param: '' });
    expect(helpers.routeFromHash('#templates/t_abc123')).toEqual({ tab: 'templates', param: 't_abc123' });
    expect(helpers.routeFromHash('#/keys')).toEqual({ tab: 'keys', param: '' });
  });

  it('opens the overview for an empty or unknown hash, and for #billing (where /pricing sends paid accounts)', () => {
    expect(helpers.routeFromHash('')).toEqual({ tab: 'overview', param: '' });
    expect(helpers.routeFromHash('#nonsense/x')).toEqual({ tab: 'overview', param: '' });
    expect(helpers.routeFromHash('#billing')).toEqual({ tab: 'overview', param: 'billing' });
  });
});

describe('template fields', () => {
  it('finds placeholders in order of first use, once each, with the renderer syntax', () => {
    expect(helpers.detectPlaceholders('<h1>{{title}}</h1><p>{{ description }}</p><img src="{{image}}"><b>{{title}}</b>')).toEqual(['title', 'description', 'image']);
    // Not placeholders for the renderer either: upper case, a leading digit, a dash, single braces.
    expect(helpers.detectPlaceholders('{{Title}} {{1st}} {{my-key}} {title} {{}}')).toEqual([]);
    expect(helpers.detectPlaceholders(`{{${'a'.repeat(32)}}} {{${'b'.repeat(33)}}}`)).toEqual(['a'.repeat(32)]);
  });

  it('agrees with the fields every starter template declares', () => {
    for (const starter of STARTER_TEMPLATES) {
      const detected = helpers.customTemplateFields(starter.html, starter.css).map((field) => field.name);
      expect([...detected].sort(), starter.id).toEqual(starter.fields.map((field) => field.name).sort());
    }
  });

  it('puts title and description first and adds theme only when the template styles it', () => {
    const fields = helpers.customTemplateFields('<i>{{tag}}</i><p>{{description}}</p><h1>{{title}}</h1>', '.theme-dark { color: #fff; }');
    expect(fields.map((field) => field.name)).toEqual(['title', 'description', 'tag', 'theme']);
    expect(fields[0]).toEqual({ name: 'title', description: '', example: '', required: false });
    expect(helpers.customTemplateFields('<h1>{{title}}</h1>', '.card { color: red; }').map((field) => field.name)).toEqual(['title']);
    expect(helpers.customTemplateFields('<h1 class="t">{{theme}}</h1>', '.theme-dark .t { color: #fff; }').map((field) => field.name)).toEqual(['theme']);
  });

  it('labels fields in words and invents believable sample text, but never an image URL', () => {
    expect(helpers.fieldLabel('author_name')).toBe('Author name');
    expect(helpers.sampleValue('title')).toBe('Your title goes here');
    expect(helpers.sampleValue('theme')).toBe('light');
    expect(helpers.sampleValue('price')).toBe('Price');
    for (const name of ['image', 'logo', 'avatar_url', 'photo']) expect(helpers.sampleValue(name), name).toBe('');
  });

  it('starts a form from known values and fills the rest from the fallback', () => {
    const fields = [{ name: 'title' }, { name: 'author' }, { name: 'image' }];
    expect(helpers.initialValues(fields, { title: 'Known', image: 7 })).toEqual({ title: 'Known', author: '', image: '' });
    expect(helpers.initialValues(fields, { title: 'Known' }, helpers.sampleValue)).toEqual({ title: 'Known', author: 'Your name', image: '' });
  });

  it('starts a starter template with only its title and theme, never the sample persona', () => {
    // A customer who types a title and copies the meta tags must not ship "Maya Lindqvist, fieldnotes.example" on their card.
    for (const starter of STARTER_TEMPLATES) {
      const values = helpers.starterValues(starter.fields as Field[], starter.sample as Record<string, string>);
      const data = helpers.cardData(values);
      expect(data.title, starter.id).toBe(starter.sample.title);
      for (const name of ['author', 'site', 'tag', 'description', 'image']) expect(data[name], `${starter.id}.${name}`).toBeUndefined();
      expect(data.theme, starter.id).toBe((starter.sample as Record<string, string>).theme);
      expect(Object.keys(values).sort(), starter.id).toEqual(starter.fields.map((field) => field.name).sort());
    }
  });

  it('refuses to save a template whose HTML is empty', () => {
    expect(helpers.templateSaveProblem('')).toMatch(/HTML is empty/);
    expect(helpers.templateSaveProblem('  \n\t ')).toMatch(/HTML is empty/);
    expect(helpers.templateSaveProblem('<h1>{{title}}</h1>')).toBeNull();
  });

  it('leaves empty inputs out of the data sent to the API', () => {
    expect(helpers.cardData({ title: 'Hello', description: '', image: undefined, tag: ' ' })).toEqual({ title: 'Hello', tag: ' ' });
  });

  it('decodes X-LTC-Warnings and treats anything malformed as no warnings', () => {
    const header = encodeURIComponent(JSON.stringify(['<script> was removed.', 'Unknown property "float".']));
    expect(helpers.parseWarnings(header)).toEqual(['<script> was removed.', 'Unknown property "float".']);
    expect(helpers.parseWarnings(null)).toEqual([]);
    expect(helpers.parseWarnings('')).toEqual([]);
    expect(helpers.parseWarnings('%E0%A4%A')).toEqual([]);
    expect(helpers.parseWarnings(encodeURIComponent('{"not":"a list"}'))).toEqual([]);
    expect(helpers.parseWarnings(encodeURIComponent('["kept", 3, null]'))).toEqual(['kept']);
  });

  it('indents with two spaces at the caret and replaces a selection', () => {
    expect(helpers.insertIndent('ab', 1, 1)).toEqual({ value: 'a  b', caret: 3 });
    expect(helpers.insertIndent('hello world', 0, 5)).toEqual({ value: '   world', caret: 2 });
  });

  it('ships a blank template that fits the limits and has a title to fill in', () => {
    const { name, html, css } = helpers.BLANK_TEMPLATE;
    expect(name.length).toBeLessThanOrEqual(LIMITS.maxNameChars);
    expect(Buffer.byteLength(html)).toBeLessThan(LIMITS.maxHtmlBytes);
    expect(Buffer.byteLength(css)).toBeLessThan(LIMITS.maxCssBytes);
    expect(helpers.detectPlaceholders(html)).toEqual(['title', 'description']);
  });
});

describe('formatting', () => {
  it('formats counts, bytes and dates', () => {
    expect(helpers.formatCount(10000)).toBe('10,000');
    expect(helpers.formatBytes(512)).toBe('512 B');
    expect(helpers.formatBytes(1536)).toBe('1.5 KB');
    expect(helpers.formatBytes(48211)).toBe('47 KB');
    expect(helpers.formatBytes(PLANS.starter.fonts.maxBytesPerFile)).toBe('2 MB');
    expect(helpers.formatBytes(3.25 * 1024 * 1024)).toBe('3.3 MB');
    expect(helpers.formatDate('2026-12-01T00:00:00.000Z', 'UTC')).toBe('Dec 1, 2026');
    expect(helpers.formatDate('2026-12-01T00:00:00.000Z', 'America/Los_Angeles')).toBe('Nov 30, 2026');
    expect(helpers.formatDateTime('2026-11-22T09:14:00.000Z', 'UTC')).toMatch(/^Nov 22, 2026, 9:14\sAM$/);
  });

  it('names every size the API offers', () => {
    const options = Object.values(SIZES).map(({ id, width, height }) => helpers.sizeOption({ id, width, height }));
    expect(options).toEqual([
      { value: 'og', label: 'Link preview', detail: '1200 × 630' },
      { value: 'square', label: 'Square', detail: '1080 × 1080' },
      { value: 'portrait', label: 'Portrait', detail: '1080 × 1350' },
      { value: 'email', label: 'Email', detail: '1200 × 400' },
    ]);
    expect(helpers.sizeOption({ id: 'banner', width: 1500, height: 500 }).label).toBe('banner');
  });

  it('describes a render row in words', () => {
    const render: Render = { template: 'blog', source: 'og', width: 1200, height: 630, format: 'jpeg', bytes: 48211, charged_to: 'plan' };
    expect(helpers.renderSummary(render, { blog: 'Blog post' })).toEqual({
      template: 'Blog post',
      via: 'Signed URL',
      size: '1200 × 630',
      format: 'JPG',
      bytes: '47 KB',
      counted: 'Plan',
    });
    const inline = helpers.renderSummary({ ...render, template: 'inline', source: 'api', format: 'webp', charged_to: 'topup' });
    expect(inline).toMatchObject({ template: 'Inline HTML', via: 'API', format: 'WEBP', counted: 'Top-up' });
    // A template that was deleted since has no name left: its id is shown.
    expect(helpers.renderSummary({ ...render, template: 't_gone' }, {}).template).toBe('t_gone');
  });

  it('never says a free re-render (charged_to none) counted against the plan (review ECQ-3)', () => {
    // An email image paid for before and rendered again after its stored copy expired: a ledger
    // row that moved no counter. The dashboard listed it under "Counted against: Plan".
    const rerender: Render = { template: 'email-banner', source: 'og', width: 1200, height: 400, format: 'png', bytes: 30000, charged_to: 'none' };
    const counted = helpers.renderSummary(rerender, { 'email-banner': 'Email banner' }).counted;
    expect(counted).not.toBe('Plan');
    expect(counted).not.toBe('Top-up');
    expect(counted).toBe('Not counted (paid before)');
  });
});

describe('usage and billing', () => {
  it('turns the meter up at 90% and to danger only when nothing at all is left', () => {
    expect(helpers.usageView(usage(0, 100))).toEqual({ percent: 0, level: 'ok', exhausted: false });
    expect(helpers.usageView(usage(89, 100))).toMatchObject({ percent: 89, level: 'ok' });
    expect(helpers.usageView(usage(90, 100))).toMatchObject({ percent: 90, level: 'warn', exhausted: false });
    expect(helpers.usageView(usage(100, 100))).toEqual({ percent: 100, level: 'danger', exhausted: true });
    // The monthly allowance is gone but a top-up still pays: a warning, not an outage.
    expect(helpers.usageView(usage(2000, 2000, 400))).toEqual({ percent: 100, level: 'warn', exhausted: false });
    expect(helpers.usageView(usage(2500, 2000))).toMatchObject({ percent: 100, exhausted: true });
  });

  it('shows PDFs apart from images only when /api/me reports them, and stays quiet where PDFs are off', () => {
    const used = usage(14, 100);
    // usage.pdf: PDFs charged this period and the images they counted as.
    expect(helpers.pdfUsageLine({ ...used, pdf: { count: 3, images: 7 } }, { pdf_enabled: true })).toBe('3 PDFs this period, counted as 7 images.');
    expect(helpers.pdfUsageLine({ ...used, pdf: { count: 1, images: 2 } }, { pdf_enabled: true })).toBe('1 PDF this period, counted as 2 images.');
    expect(helpers.pdfUsageLine({ ...usage(1500, 2000), pdf: { count: 1200, images: 1300 } }, null)).toBe('1,200 PDFs this period, counted as 1,300 images.');
    // A PDF that did not fit in the allowance came whole from a top-up, outside usage.used: the
    // line must not claim a share of usage.used.
    expect(helpers.pdfUsageLine({ ...usage(100, 100), pdf: { count: 40, images: 240 } }, { pdf_enabled: true })).toBe('40 PDFs this period, counted as 240 images.');
    expect(helpers.pdfUsageLine({ ...used, pdf: { count: 0, images: 0 } }, { pdf_enabled: true })).toBe('No PDFs made this period.');
    // Production with PDFs switched off: nothing about PDFs at all.
    expect(helpers.pdfUsageLine({ ...used, pdf: { count: 0, images: 0 } }, { pdf_enabled: false })).toBeNull();
    expect(helpers.pdfUsageLine(used, { pdf_enabled: true })).toBeNull();
    expect(helpers.pdfUsageLine({ ...used, pdf: 'three' }, { pdf_enabled: true })).toBeNull();
    expect(helpers.pdfUsageLine({ ...used, pdf: { count: -1, images: 'x' } }, { pdf_enabled: true })).toBe('No PDFs made this period.');
  });

  it('puts the PDF line on the plan card as text', () => {
    const billing = readFileSync(join(ROOT, 'site/public/assets/js/dashboard/billing.js'), 'utf8');
    expect(billing).toContain("const pdfLine = pdfUsageLine(usage, ctx.config);");
    expect(billing).toContain("pdfLine ? h('p', { class: 'usage-pdf' }, pdfLine) : null,");
  });

  // /api/config lists each plan with `top_ups` from src/billing/plans.ts; the buttons follow it.
  const plans = (['free', 'starter', 'pro'] as const).map((id) => ({ id, top_ups: PLANS[id].topUps }));
  const configured = { paddle: { environment: 'sandbox', client_token: 'test_token', prices: { starter: 'pri_s', pro: 'pri_p', topup: 'pri_t' } }, plans };
  const free: User = { id: 'u_1', email: 'a@example.com', plan: 'free', has_billing: false, subscription: null };
  const starter: User = { ...free, plan: 'starter', has_billing: true, subscription: { status: 'active' } };

  it('offers no billing buttons at all when Paddle is not configured', () => {
    // Production while checkout is closed: no "Buy top-up" for anyone, whatever plans.ts allows.
    expect(helpers.billingActions(free, { paddle: null, plans })).toEqual([]);
    expect(helpers.billingActions(starter, { paddle: null, plans })).toEqual([]);
    expect(helpers.billingActions(starter, null)).toEqual([]);
  });

  it('offers a Free account the two upgrades and the top-up, and the portal only if it ever paid', () => {
    // Owner decision of 2026-11-28: the top-up needs no subscription.
    expect(PLANS.free.topUps).toBe(true);
    expect(helpers.billingActions(free, configured)).toEqual([
      { type: 'checkout', item: 'starter' },
      { type: 'checkout', item: 'pro' },
      { type: 'checkout', item: 'topup' },
    ]);
    // A Free account that bought a top-up has a Paddle customer, so it can open the portal for its receipts.
    expect(helpers.billingActions({ ...free, has_billing: true }, configured).at(-1)).toEqual({ type: 'portal' });
  });

  it('takes the top-up button from the plan flag, not from the plan name', () => {
    const paidOnly = { ...configured, plans: plans.map((plan) => ({ ...plan, top_ups: plan.id !== 'free' })) };
    expect(helpers.billingActions(free, paidOnly)).toEqual([
      { type: 'checkout', item: 'starter' },
      { type: 'checkout', item: 'pro' },
    ]);
    expect(helpers.billingActions(starter, paidOnly)[0]).toEqual({ type: 'checkout', item: 'topup' });
    const none = { ...configured, plans: plans.map((plan) => ({ ...plan, top_ups: false })) };
    expect(helpers.billingActions(starter, none)).toEqual([{ type: 'change-plan', plan: 'pro' }, { type: 'portal' }]);
  });

  it('offers a paid account a top-up, the other plan and the portal', () => {
    expect(helpers.billingActions(starter, configured)).toEqual([{ type: 'checkout', item: 'topup' }, { type: 'change-plan', plan: 'pro' }, { type: 'portal' }]);
    expect(helpers.billingActions({ ...starter, plan: 'pro' }, configured)[1]).toEqual({ type: 'change-plan', plan: 'starter' });
    for (const status of ['trialing', 'past_due']) {
      expect(helpers.billingActions({ ...starter, subscription: { status } }, configured).map((action) => action.type)).toContain('change-plan');
    }
    // The API refuses a plan change without a live subscription, so the button is not offered.
    for (const subscription of [null, { status: 'canceled' }, { status: 'paused' }]) {
      expect(helpers.billingActions({ ...starter, subscription }, configured).map((action) => action.type)).toEqual(['checkout', 'portal']);
    }
  });

  it('ends the "nearly used up" warning with what the buttons below it sell', () => {
    expect(helpers.moreImagesHint(helpers.billingActions(free, configured))).toBe(' Upgrade or buy a top-up below to keep them coming.');
    expect(helpers.moreImagesHint(helpers.billingActions(starter, configured))).toBe(' A top-up below adds more.');
    expect(helpers.moreImagesHint([{ type: 'checkout', item: 'starter' }, { type: 'checkout', item: 'pro' }])).toBe(' Upgrade below to keep them coming.');
    // Checkout closed: nothing to buy, so nothing is promised.
    expect(helpers.moreImagesHint(helpers.billingActions(free, { paddle: null, plans }))).toBe('');
    expect(helpers.moreImagesHint([{ type: 'portal' }])).toBe('');
  });

  it('says on the plan card what a top-up does not change, and only where a top-up is in play', () => {
    const billing = readFileSync(join(ROOT, 'site/public/assets/js/dashboard/billing.js'), 'utf8');
    // The Free account's hint under the buttons: the upgrades, then the top-up and that the plan and the mark stay.
    expect(billing).toContain('It does not change your plan: you stay on Free, and cards keep the corner mark.');
    expect(billing).toContain("${canBuyTopUp(config, user.plan) ? ` ${topUp} It does not change your plan");
    // The mark line names a top-up only when its button is offered or the account holds a balance.
    expect(billing).toContain("const topUpInPlay = usage.topup_remaining > 0 || actions.some((action) => action.type === 'checkout' && action.item === 'topup');");
    expect(billing).toContain("Paid plans remove it.${topUpInPlay ? ' A top-up adds images only: the mark stays.' : ''}");
    // Checkout closed: the old notice, which already covers top-ups.
    expect(billing).toContain('Paid plans and top-ups are coming soon, so there is nothing to buy here yet.');
  });

  it('knows when a checkout has reached the account', () => {
    const before = helpers.checkoutSnapshot('pro', { user: { plan: 'free' }, usage: { topup_remaining: 0 } });
    expect(before).toEqual({ item: 'pro', plan: 'free', topup_remaining: 0 });
    expect(helpers.checkoutSettled(before, { user: { plan: 'free' }, usage: { topup_remaining: 0 } })).toBe(false);
    expect(helpers.checkoutSettled(before, { user: { plan: 'pro' }, usage: { topup_remaining: 0 } })).toBe(true);

    const topup = helpers.checkoutSnapshot('topup', { user: { plan: 'starter' }, usage: { topup_remaining: 250 } });
    expect(helpers.checkoutSettled(topup, { user: { plan: 'starter' }, usage: { topup_remaining: 250 } })).toBe(false);
    expect(helpers.checkoutSettled(topup, { user: { plan: 'starter' }, usage: { topup_remaining: 250 + TOPUP.images } })).toBe(true);

    // A Free account's top-up: the plan never changes, so "done" is the images arriving.
    const freeTopUp = helpers.checkoutSnapshot('topup', { user: { plan: 'free' }, usage: { topup_remaining: 0 } });
    expect(freeTopUp).toEqual({ item: 'topup', plan: 'free', topup_remaining: 0 });
    expect(helpers.checkoutSettled(freeTopUp, { user: { plan: 'free' }, usage: { topup_remaining: 0 } })).toBe(false);
    expect(helpers.checkoutSettled(freeTopUp, { user: { plan: 'free' }, usage: { topup_remaining: TOPUP.images } })).toBe(true);
  });

  it('polls until done, waits between attempts and gives up after about 30 seconds', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    let calls = 0;
    const counter = async (): Promise<number> => ++calls;

    expect(await helpers.pollUntil(counter, (value) => value === 3, { sleep })).toEqual({ value: 3, settled: true });
    expect(sleeps).toEqual([2000, 2000]);

    calls = 0;
    sleeps.length = 0;
    expect(await helpers.pollUntil(counter, () => false, { sleep })).toEqual({ value: 15, settled: false });
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(28_000);

    calls = 0;
    sleeps.length = 0;
    expect(await helpers.pollUntil(counter, () => true, { sleep })).toEqual({ value: 1, settled: true });
    expect(sleeps).toEqual([]);
    await expect(helpers.pollUntil(() => Promise.reject(new Error('offline')), () => true, { sleep })).rejects.toThrow('offline');
  });

  it('walks the first-run guide from site to card to done', () => {
    expect(helpers.guideStage({ siteCount: 0, finished: false })).toBe('site');
    expect(helpers.guideStage({ siteCount: 2, finished: false })).toBe('card');
    expect(helpers.guideStage({ siteCount: 0, finished: true })).toBe('done');
  });
});

describe('copyable examples', () => {
  it('writes a curl call whose body is valid for POST /v1/images', () => {
    const curl = helpers.curlExample('https://linktocard.com');
    expect(curl).toContain('curl -X POST https://linktocard.com/v1/images');
    expect(curl).toContain(`-H "Authorization: Bearer ${helpers.KEY_PLACEHOLDER}"`);
    expect(helpers.KEY_PLACEHOLDER.startsWith('ltc_')).toBe(true);
    const body = JSON.parse(/-d '(.*)'$/.exec(curl)?.[1] ?? '') as { template: string; data: Record<string, string>; size: string; format: string };
    expect(STARTER_TEMPLATES.map((template) => template.id)).toContain(body.template);
    expect(Object.keys(SIZES)).toContain(body.size);
    expect(FORMATS).toContain(body.format);
    expect(body.data.title).toBeTruthy();
    expect(helpers.curlExample('http://localhost:8787', 'ltc_secret')).toContain('Bearer ltc_secret');
  });

  it('shows how to use an uploaded font and where to upload it', () => {
    expect(helpers.fontCssExample('Acme Sans', 700)).toBe('.title {\n  font-family: "Acme Sans", sans-serif;\n  font-weight: 700;\n}');
    expect(helpers.fontCssExample('Acme Sans', 400, 'italic')).toContain('  font-style: italic;');
    expect(helpers.fontCssExample('Acme Sans')).toContain('font-weight: 400;');
    const url = new URL(helpers.fontUploadUrl({ family: 'Acme Sans & Co', weight: 700, style: 'italic' }), 'https://linktocard.com');
    expect(url.pathname).toBe('/api/fonts');
    expect(Object.fromEntries(url.searchParams)).toEqual({ family: 'Acme Sans & Co', weight: '700', style: 'italic' });
  });

  it('refuses an oversized font file in a sentence, before any upload', () => {
    const cap = PLANS.starter.fonts.maxBytesPerFile;
    expect(helpers.fontSizeProblem(cap, cap)).toBeNull();
    expect(helpers.fontSizeProblem(cap + 1024 * 1024, cap)).toBe('This file is 3 MB. Your plan allows 2 MB per font file.');
  });
});

describe('shared checkout helper', () => {
  afterEach(() => vi.unstubAllGlobals());

  // As GET /api/config answers: the Paddle values, and each plan with `top_ups` from src/billing/plans.ts.
  const config = {
    paddle: { environment: 'sandbox', client_token: 'test_token', prices: { starter: 'pri_s', pro: 'pri_p', topup: 'pri_t' } },
    plans: (['free', 'starter', 'pro'] as const).map((id) => ({ id, name: PLANS[id].name, top_ups: PLANS[id].topUps })),
  };
  const origin = 'https://linktocard.com';

  it('is the same function on the pricing page and in the dashboard', async () => {
    const pricing = await load<Pick<Checkout, 'checkoutAction'>>('pricing.js');
    const checkout = await load<Checkout>('checkout.js');
    expect(pricing.checkoutAction).toBe(checkout.checkoutAction);
  });

  it('builds the checkout the webhook needs: price, user id as custom data, email, return address', async () => {
    const { checkoutAction } = await load<Checkout>('checkout.js');
    const upgrade = checkoutAction({ item: 'starter', user: { id: 'u_7', email: 'me@example.com', plan: 'free' }, config, origin });
    expect(upgrade.options).toEqual({
      items: [{ priceId: 'pri_s', quantity: 1 }],
      customer: { email: 'me@example.com' },
      customData: { user_id: 'u_7' },
      settings: { displayMode: 'overlay', successUrl: 'https://linktocard.com/dashboard?checkout=success' },
    });
    const topup = checkoutAction({ item: 'topup', user: { id: 'u_7', email: 'me@example.com', plan: 'pro' }, config, origin });
    expect(topup.options).toMatchObject({ items: [{ priceId: 'pri_t', quantity: 1 }], customData: { user_id: 'u_7' } });
    // The same checkout for an account without a subscription (owner decision of 2026-11-28).
    const freeTopup = checkoutAction({ item: 'topup', user: { id: 'u_8', email: 'free@example.com', plan: 'free' }, config, origin });
    expect(freeTopup.options).toMatchObject({ items: [{ priceId: 'pri_t', quantity: 1 }], customer: { email: 'free@example.com' }, customData: { user_id: 'u_8' } });
  });

  it('initializes Paddle once, in the sandbox when configured so, and opens every checkout', async () => {
    const { checkoutAction, openCheckout } = await load<Checkout>('checkout.js');
    const Paddle = { Environment: { set: vi.fn() }, Initialize: vi.fn(), Checkout: { open: vi.fn() } };
    vi.stubGlobal('window', { Paddle });
    const action = checkoutAction({ item: 'pro', user: { id: 'u_7', email: 'me@example.com', plan: 'free' }, config, origin });

    await openCheckout(action);
    await openCheckout(action);
    expect(Paddle.Environment.set.mock.calls).toEqual([['sandbox']]);
    expect(Paddle.Initialize.mock.calls).toEqual([[{ token: 'test_token' }]]);
    expect(Paddle.Checkout.open).toHaveBeenCalledTimes(2);
    expect(Paddle.Checkout.open).toHaveBeenLastCalledWith(action.options);
  });
});

describe('error messages (api.js)', () => {
  type Api = { errorMessage(response: Response): Promise<string> };
  it('shows the API\'s own message, and says what to do when a platform error page has none', async () => {
    const { errorMessage } = await load<Api>('api.js');
    const json = new Response(JSON.stringify({ error: { code: 'conflict', message: 'Revoke a key first.' } }), { status: 409 });
    expect(await errorMessage(json)).toBe('Revoke a key first.');
    const page = (status: number) => new Response('<html><body>Error 1102</body></html>', { status, headers: { 'content-type': 'text/html' } });
    expect(await errorMessage(page(503))).toBe('The server had a problem (HTTP 503). Wait a minute, then try again.');
    expect(await errorMessage(page(429))).toMatch(/Wait a minute, then try again\.$/);
    expect(await errorMessage(page(404))).toMatch(/Reload the page and try again\.$/);
  });
});

describe('dashboard source rules', () => {
  const jsDir = join(ROOT, 'site/public/assets/js');
  const modules = ['dashboard.js', ...readdirSync(join(jsDir, 'dashboard')).map((name) => `dashboard/${name}`)];
  const read = (name: string): string => readFileSync(join(jsDir, name), 'utf8');
  // Comments may name what is banned; only code counts.
  const code = (name: string): string => read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  it('builds the page from DOM nodes: no HTML strings, no eval, no inline handlers', () => {
    const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\('on/;
    for (const name of modules) expect(code(name), name).not.toMatch(banned);
  });

  it('every relative import points at a file that exists, and every tab has its module', () => {
    for (const name of modules) {
      for (const match of read(name).matchAll(/from '(\.[^']+)'/g)) {
        expect(existsSync(join(jsDir, dirname(name), match[1]!)), `${name} imports ${match[1]}`).toBe(true);
      }
    }
    for (const tab of helpers.TABS) expect(modules).toContain(`dashboard/${tab.id}.js`);
  });

  it('the page carries no script, inline style or inline handler of its own (CSP: script-src \'self\')', () => {
    const page = readFileSync(join(ROOT, 'site/pages/dashboard.html'), 'utf8');
    expect(page).not.toMatch(/<script|\son[a-z]+=|\sstyle=/i);
    expect(page).toMatch(/^scripts: dashboard$/m);
    expect(page).toContain('href="/assets/css/dashboard.css"');
    expect(existsSync(join(ROOT, 'site/public/assets/css/dashboard.css'))).toBe(true);
  });
});
