// The site after the owner's decision of 2026-11-28: "$8 top-up without a subscription: yes, allow it."
//   - Every page that explains top-ups says who can buy one from `topUps` in src/billing/plans.ts
//     (the [[topup.plans]] token), not from plan names typed into the page, and says plainly that a
//     top-up does not change the plan: on Free the watermark stays.
//   - No page keeps the old rule ("No top-ups: a hard stop", "on paid plans", ...).
//   - Checkout is a switch of the Worker, so the pages cannot know at build time whether a top-up
//     is on sale. Production runs with checkout closed and has Free accounts, so each sentence
//     that says a top-up can be bought carries a hidden note, which site.js shows while
//     GET /api/config reports no Paddle configuration.
//   - The checkout rule in the browser lets a Free account start the purchase, and the page the
//     customer comes back to waits for top-up images, not for a plan change.
// Builds are rendered in memory, so site/dist is left alone.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER, TOPUP, formatCount, formatUsd } from '../../src/billing/plans';
import { CLOSED_NOTE_ATTR, TOPUP_CLOSED_NOTE, listTokens, renderSite, type RenderedSite } from '../../scripts/build-site';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = new Date('2026-11-28T12:00:00Z');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

/** The variables a deploy script sets in front of `npm run build:site` (as tests/node/production-site.test.ts reads them). */
function buildEnv(script: string): Record<string, string> {
  const step = (pkg.scripts[script] ?? '').split('&&').map((part) => part.trim()).find((part) => part.endsWith('npm run build:site'));
  if (!step) throw new Error(`${script} does not run npm run build:site`);
  const env: Record<string, string> = {};
  for (const assignment of step.slice(0, -'npm run build:site'.length).trim().split(/\s+/).filter(Boolean)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(assignment);
    if (!match) throw new Error(`${script}: "${assignment}" is not NAME=value`);
    env[match[1]!] = match[2]!;
  }
  return env;
}

const ENTITIES: Record<string, string> = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', nbsp: ' ' };
/** Visible text: tags dropped without leaving a space, so a note inside a sentence reads as it does on the page. */
const text = (html: string): string =>
  html
    .replace(/<\/(p|li|dd|dt|h[1-6]|td|th|tr|div|article|section|summary)>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(ldquo|rdquo|lsquo|rsquo|ndash|mdash|hellip|nbsp);/g, (_match, name: string) => ENTITIES[name] ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const page = (site: RenderedSite, outPath: string): string => {
  const found = site.pages.find((candidate) => candidate.outPath === outPath);
  if (!found) throw new Error(`no page ${outPath}`);
  return found.html;
};
const mainOf = (html: string): string => html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const main = (site: RenderedSite, outPath: string): string => text(mainOf(page(site, outPath)));

const price = formatUsd(TOPUP.priceUsd);
const images = formatCount(TOPUP.images);
const NOTE = 'Top-ups are not on sale yet.';
/** What the tokens must say for the plans as they are: every plan can buy one, and Free keeps its watermark. */
const EVERY_PLAN = `every plan, ${PLANS.free.name} included`;
const KEEPS_PLAN = `A top-up adds images and nothing else: it is not a subscription and it does not change your plan. On ${PLANS.free.name}, what you make with top-up images still carries the watermark, and the plan's cache time, fonts and other limits stay the same.`;
/** The top-up line of a plan card: the price, the note that shows only while checkout is closed, and on a marked plan that the mark stays. */
const cardLine = (plan: { watermark: boolean }): string =>
  `<li>Top-ups: ${price} per ${images} images<span ${CLOSED_NOTE_ATTR} hidden> (coming soon)</span>${plan.watermark ? '; the watermark stays' : ''}</li>`;
const KEEPS_PLAN_SHORT = `A top-up adds images only: it does not change your plan, and on ${PLANS.free.name} the watermark stays.`;

let builds: Array<[string, RenderedSite]>;
beforeAll(() => {
  builds = [
    ['production', renderSite({ env: buildEnv('deploy:production'), now: NOW })],
    ['staging', renderSite({ env: buildEnv('deploy:staging'), now: NOW })],
    ['every feature off', renderSite({ env: {}, now: NOW })],
  ];
});

describe('plans.ts decides who can buy the top-up, and the site says so', () => {
  it('the tokens are computed from topUps and watermark of each plan', () => {
    expect(PLAN_ORDER.map((id) => PLANS[id].topUps)).toEqual([true, true, true]);
    expect(PLANS.free.watermark).toBe(true);
    const { tokens, partials } = listTokens({ env: {}, now: NOW });
    expect(tokens['topup.plans']).toBe(EVERY_PLAN);
    expect(tokens['topup.keepsPlan']).toBe(KEEPS_PLAN);
    expect(tokens['topup.keepsPlanShort']).toBe(KEEPS_PLAN_SHORT);
    expect(partials).toContain('topup-closed-note');
    expect(TOPUP_CLOSED_NOTE).toBe(`<span ${CLOSED_NOTE_ATTR} hidden>${NOTE}</span>`);
  });

  it('no page names the plans that can buy a top-up by hand', () => {
    // The sentences read [[topup.plans]]; a plan name next to "top-up" in a source file would drift again.
    for (const file of ['site/pages/pricing.html', 'site/pages/index.html', 'site/partials/counting-rules.html', 'site/content/docs/limits.md', 'site/content/terms.md']) {
      const source = read(file);
      expect(source, file).toContain('[[topup.plans]]');
      for (const line of source.split('\n').filter((candidate) => /top-up/i.test(candidate))) {
        expect(line, file).not.toMatch(/\[\[plan\.(starter|pro)\.name\]\] and \[\[plan\.(starter|pro)\.name\]\]|Starter and Pro|paid plans/);
      }
    }
    // The browser reads the same flag from /api/config instead of testing for the Free plan.
    expect(read('site/public/assets/js/checkout.js')).toContain("if (item === 'topup' && !canBuyTopUp(config, user.plan))");
    expect(read('site/public/assets/js/checkout.js')).not.toContain("item === 'topup' && !paid");
    expect(read('site/public/assets/js/dashboard/helpers.js')).toContain("const topUp = canBuyTopUp(config, user.plan) ? [{ type: 'checkout', item: 'topup' }] : [];");
    expect(read('src/routes/dashboard.ts')).toContain('top_ups: plan.topUps,');
  });

  it('the pricing page: every plan card offers the top-up, the Free card says the watermark stays, and the top-up box says who can buy and what does not change', () => {
    for (const [name, site] of builds) {
      const html = page(site, 'pricing.html');
      for (const id of PLAN_ORDER) {
        const plan = PLANS[id];
        const card = html.slice(html.indexOf(`data-plan="${id}"`), html.indexOf('</article>', html.indexOf(`data-plan="${id}"`)));
        expect(card, `${name} ${id}`).toContain(cardLine(plan));
        expect(card, `${name} ${id}`).not.toContain('No top-ups');
        expect(card, `${name} ${id}`).not.toContain('hard stop');
      }
      // Free keeps what makes it Free.
      const free = html.slice(html.indexOf('data-plan="free"'), html.indexOf('</article>', html.indexOf('data-plan="free"')));
      expect(free, name).toContain('<li>Small watermark in one corner</li>');
      expect(free, name).toContain(`<li>Rendered images cached for ${PLANS.free.cacheDays} days</li>`);
      expect(free, name).toContain('<li>Bundled fonts only</li>');

      const box = html.slice(html.indexOf('<div class="topup" id="top-up">'), html.indexOf('data-checkout="topup"'));
      expect(text(box), name).toContain(
        `For accounts on ${EVERY_PLAN}. Top-up images are used only after the month's allowance is used up and stay valid for ${TOPUP.validDays} days from purchase. A top-up is a one-time payment that you start yourself. It is never bought or billed automatically.`,
      );
      expect(text(box), name).toContain(KEEPS_PLAN);
      expect(box, name).toContain(`Billed by Paddle as &ldquo;${TOPUP.paddleProductName}&rdquo;.`);
      // The same row for every plan in the limits table.
      expect(html, name).toContain(`<tr><th scope="row">Top-up</th>${PLAN_ORDER.map(() => `<td>${price} per ${images} images</td>`).join('')}</tr>`);
    }
  });

  it('the home page: the pricing cards, the line under them and the FAQ say that every plan can buy one', () => {
    for (const [name, site] of builds) {
      const html = page(site, 'index.html');
      const free = html.slice(html.indexOf('data-plan="free"'), html.indexOf('</article>', html.indexOf('data-plan="free"')));
      expect(free, name).toContain(cardLine(PLANS.free));
      expect(text(cardLine(PLANS.free))).toBe(`Top-ups: ${price} per ${images} images (coming soon); the watermark stays `);
      const visible = main(site, 'index.html');
      expect(visible, name).toContain(
        `Busy month? On ${EVERY_PLAN}, a ${price} top-up adds ${images} images. You buy it yourself; nothing is ever billed automatically. ${KEEPS_PLAN_SHORT} ${NOTE}`,
      );
      expect(visible, name).toContain(
        `On ${EVERY_PLAN}, you can buy a top-up of ${images} images for ${price}, or change plan. ${KEEPS_PLAN_SHORT} Nothing is ever charged automatically beyond your subscription. ${NOTE}`,
      );
    }
  });

  it('the counting rules, wherever they are printed, and the limits page say the same', () => {
    const rule = `Top-ups are manual On ${EVERY_PLAN}, you can buy ${images} extra images for ${price} whenever you choose. A top-up is never bought or billed automatically. ${KEEPS_PLAN_SHORT} ${NOTE}`;
    const stop = 'The limit is a hard stop When the allowance and any top-up images are used up, new renders answer HTTP 402 until the next period. There is no overage billing on any plan.';
    for (const [name, site] of builds) {
      for (const outPath of ['pricing.html', 'index.html', 'docs/api.html', 'docs/limits.html']) {
        expect(main(site, outPath), `${name} ${outPath}`).toContain(rule);
        expect(main(site, outPath), `${name} ${outPath}`).toContain(stop);
      }
      const limits = main(site, 'docs/limits.html');
      expect(limits, name).toContain(`On ${EVERY_PLAN}, you can buy a top-up of ${images} images for ${price} in the dashboard. ${NOTE}`);
      expect(limits, name).toContain(KEEPS_PLAN);
      expect(limits, name).toContain(`They are valid for ${TOPUP.validDays} days from the purchase`);
      // The 402 example is the message of a Free account while top-ups are not on sale; the page says what changes.
      expect(limits, name).toContain('to render new ones now, upgrade at https://linktocard.com/pricing.');
      expect(limits, name).toContain('The message ends with what you can do at that moment: upgrade, buy a top-up, or both. It names a top-up only while top-ups are on sale.');
    }
  });

  it('the Terms say that every plan can buy a top-up, that it changes nothing else, and when the Free plan stops', () => {
    for (const [name, site] of builds) {
      const terms = main(site, 'terms.html');
      expect(terms, name).toContain(
        `Free: ${formatCount(PLANS.free.monthlyImages)} images per month. Free-plan images carry a small mark in one corner. When the monthly allowance and any top-up you bought are used up, new images are not rendered until the next month: it is a hard stop, and nothing is charged automatically.`,
      );
      expect(terms, name).toContain(
        `Top-up (optional): ${price} for ${images} extra images, available on ${EVERY_PLAN}. A top-up is only ever bought by you, by hand. It is never billed automatically. Top-up images are used after your monthly allowance runs out and stay valid for ${TOPUP.validDays} days from purchase. A top-up adds images only: it does not change your plan, and Free-plan images keep their mark.`,
      );
    }
  });

  it('no page of any build keeps the old rule', () => {
    const OLD = [
      'No top-ups',
      'Top-ups are not available',
      'available on paid plans',
      'On paid plans you can buy',
      'Starter and Pro accounts',
      'that is the end of it',
      'that is a hard stop',
      'Top-up Not available',
    ];
    for (const [name, site] of builds) {
      for (const built of site.pages) {
        const visible = text(built.html);
        for (const phrase of OLD) expect(visible.includes(phrase), `${name} ${built.outPath}: "${phrase}"`).toBe(false);
      }
    }
  });
});

describe('while checkout is closed, no page promises a top-up that cannot be bought', () => {
  /** The blocks (paragraph, list item, definition) of a page that say a top-up can be bought. */
  const offers = (html: string): string[] =>
    [...mainOf(html).matchAll(/<(p|li|dd)\b[^>]*>([\s\S]*?)<\/\1>/g)]
      .map((match) => match[0])
      .filter((block) => /you can buy|top-up adds [\d,]+ images|Top-ups: \$/.test(text(block)));

  it('every sentence that offers a top-up carries the note, and every note ships hidden', () => {
    for (const [name, site] of builds) {
      const found = new Map<string, number>();
      for (const built of site.pages) {
        const blocks = offers(built.html);
        if (blocks.length > 0) found.set(built.outPath, blocks.length);
        for (const block of blocks) expect(block, `${name} ${built.outPath}`).toContain(`<span ${CLOSED_NOTE_ATTR} hidden>`);
        // Shown only by site.js: in the built page every note has the hidden attribute.
        const notes = built.html.match(new RegExp(`<[a-z]+[^>]*\\b${CLOSED_NOTE_ATTR}\\b[^>]*>`, 'g')) ?? [];
        for (const note of notes) expect(note, `${name} ${built.outPath}`).toMatch(/\shidden(\s|>)/);
        // site.js is on the page, so the note can be shown.
        if (notes.length > 0) expect(built.html, `${name} ${built.outPath}`).toContain('<script type="module" src="/assets/js/site.js"></script>');
      }
      // Three cards and three sentences on the home page, three cards and one rule on the pricing page, the rule in the docs.
      expect(Object.fromEntries(found), name).toEqual({ 'index.html': 6, 'pricing.html': 4, 'docs/api.html': 1, 'docs/limits.html': 2 });
    }
  });

  it('the pricing page turns the top-up button into "Coming soon" and its notice names top-ups', () => {
    for (const [name, site] of builds) {
      const html = page(site, 'pricing.html');
      expect(html, name).toContain(
        `<p class="alert alert-info" id="coming-soon" role="note" hidden>Paid plans and top-ups are coming soon. The ${PLANS.free.name} plan is open now: ${PLANS.free.monthlyImages} images a month, no card required.</p>`,
      );
      // The button is a checkout button like the two plans', so markComingSoon() (tests/node/coming-soon.test.ts) disables it too.
      expect(html, name).toContain('<a class="btn btn-secondary" href="/pricing?checkout=topup" data-checkout="topup">Buy a top-up</a>');
    }
    expect(read('site/public/assets/js/pricing.js')).toMatch(/if \(config && !config\.paddle\) \{\s*markComingSoon\(document\);\s*const soon = document\.querySelector\('#coming-soon'\);\s*if \(soon\) soon\.hidden = false;/);
  });

  /** Runs site.js against a page with these notes; resolves once its fetch, if any, has settled. */
  async function runSiteJs(notes: Array<{ hidden: boolean }>, respond: (() => Promise<unknown>) | null): Promise<string[]> {
    const fetched: string[] = [];
    const settled: Array<Promise<unknown>> = [];
    const document = {
      addEventListener: () => undefined,
      querySelectorAll: (selector: string) => (selector === `[${CLOSED_NOTE_ATTR}]` ? notes : []),
      querySelector: () => null,
    };
    const fetchStub = (url: string): Promise<unknown> => {
      fetched.push(url);
      const answer = respond ? respond() : Promise.reject(new Error('no network'));
      settled.push(answer.catch(() => undefined));
      return answer;
    };
    const source = read('site/public/assets/js/site.js');
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    new Function('document', 'location', 'window', 'navigator', 'fetch', source)(document, { pathname: '/pricing' }, {}, {}, fetchStub);
    await Promise.all(settled);
    // The handlers attached to the fetch run after it settles.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    return fetched;
  }
  const json = (body: unknown, ok = true) => (): Promise<unknown> => Promise.resolve({ ok, json: () => Promise.resolve(body) });

  it('site.js shows the notes only when /api/config reports no Paddle configuration', async () => {
    const closed = [{ hidden: true }, { hidden: true }];
    expect(await runSiteJs(closed, json({ paddle: null, plans: [] }))).toEqual(['/api/config']);
    expect(closed.map((note) => note.hidden)).toEqual([false, false]);

    const open = [{ hidden: true }];
    await runSiteJs(open, json({ paddle: { environment: 'production', client_token: 'live_x', prices: {} } }));
    expect(open[0]!.hidden).toBe(true);

    // No answer, an error answer or an unreadable one: the page stays as built.
    for (const respond of [null, json({ error: { code: 'internal_error' } }, false), () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('not JSON')) }), json(null)]) {
      const unknown = [{ hidden: true }];
      await runSiteJs(unknown, respond);
      expect(unknown[0]!.hidden).toBe(true);
    }
  });

  it('site.js asks nothing on a page without a note', async () => {
    expect(await runSiteJs([], json({ paddle: null }))).toEqual([]);
  });
});

describe('the checkout in the browser', () => {
  type Config = { paddle: unknown; plans?: Array<{ id: string; name: string; top_ups: boolean }> } | null;
  interface Checkout {
    canBuyTopUp(config: Config, planId: string | null | undefined): boolean;
    checkoutAction(input: { item: string; user: unknown; config: Config; origin: string }): { type: string; message?: string; options?: { items: Array<{ priceId: string }>; customData: unknown } };
    checkoutSnapshot(item: string, me: { user: { plan: string }; usage: { topup_remaining: number } }): { item: string; plan: string; topup_remaining: number };
    rememberCheckout(snapshot: unknown, storage?: unknown): void;
    recallCheckout(storage?: unknown): unknown;
  }
  const load = async (): Promise<Checkout> => (await import(pathToFileURL(join(ROOT, 'site/public/assets/js/checkout.js')).href)) as Checkout;
  /** The plans as GET /api/config lists them (src/routes/dashboard.ts). */
  const plans = PLAN_ORDER.map((id) => ({ id, name: PLANS[id].name, top_ups: PLANS[id].topUps }));
  const config = { paddle: { environment: 'sandbox', client_token: 'test_token', prices: { starter: 'pri_s', pro: 'pri_p', topup: 'pri_t' } }, plans };
  const free = { id: 'u_free', email: 'free@example.com', plan: 'free' };

  it('lets a Free account start the top-up purchase, with the top-up price and its account id', async () => {
    const { checkoutAction, canBuyTopUp } = await load();
    for (const id of PLAN_ORDER) expect(canBuyTopUp(config, id), id).toBe(PLANS[id].topUps);
    const action = checkoutAction({ item: 'topup', user: free, config, origin: 'https://linktocard.com' });
    expect(action.type).toBe('checkout');
    expect(action.options?.items).toEqual([{ priceId: 'pri_t', quantity: 1 }]);
    expect(action.options?.customData).toEqual({ user_id: 'u_free' });
    // An account whose plan name is missing counts as Free; a plan the config does not list cannot buy.
    expect(canBuyTopUp(config, undefined)).toBe(true);
    expect(canBuyTopUp(config, 'enterprise')).toBe(false);
    expect(canBuyTopUp(null, 'free')).toBe(false);
  });

  it('opens no checkout while checkout is closed', async () => {
    const { checkoutAction } = await load();
    expect(checkoutAction({ item: 'topup', user: free, config: { paddle: null, plans }, origin: 'https://linktocard.com' })).toEqual({
      type: 'message',
      message: 'Checkout is not configured yet.',
    });
  });

  it('remembers what a checkout was for, so the dashboard waits for top-up images and not for a plan change', async () => {
    const { checkoutSnapshot, rememberCheckout, recallCheckout } = await load();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
    const snapshot = checkoutSnapshot('topup', { user: { plan: 'free' }, usage: { topup_remaining: 0 } });
    rememberCheckout(snapshot, storage);
    expect(recallCheckout(storage)).toEqual({ item: 'topup', plan: 'free', topup_remaining: 0 });
    // Read once.
    expect(recallCheckout(storage)).toBeNull();
    // Storage that throws or holds rubbish is survived.
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(() => rememberCheckout(snapshot, broken)).not.toThrow();
    expect(recallCheckout(broken)).toBeNull();
    store.set('ltc:checkout', '{not json');
    expect(recallCheckout(storage)).toBeNull();

    // Both pages that open a checkout take the snapshot first: the pricing page did not before 2026-11-28.
    expect(read('site/public/assets/js/pricing.js')).toMatch(/rememberCheckout\(checkoutSnapshot\(item, me\)\);\s*await openCheckout\(action\);/);
    expect(read('site/public/assets/js/dashboard/billing.js')).toMatch(/rememberCheckout\(checkoutSnapshot\(item, ctx\.me\)\);/);
    expect(read('site/public/assets/js/dashboard/billing.js')).toContain('const before = recallCheckout() ?? UNKNOWN_CHECKOUT;');
  });
});
