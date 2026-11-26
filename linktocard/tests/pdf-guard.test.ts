// Bounds on Browser Run time (src/pdf/guard.ts): the failed-render cap per account (POST
// /v1/pdf) and per site (signed links), reserved before the browser runs; which outcomes count;
// the free brake on Free and free-tool browser time only; HEAD of a signed link. Each test here
// failed on c15216b.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from '../src/billing/plans';
import { DAY_MS, PDF } from '../src/config';
import { all, run } from '../src/db/client';
import { resetFreeBrake } from '../src/pdf/guard';
import { apiKeyFor, call, createSite, createUser, errorOf, setUsed } from './app-helpers';
import { browserErrorResponse, counterOf, limitsOn, mockBrowser, pdfResponse, postPdf, signedPdfPath, utcDay } from './pdf-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

let seq = 0;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const invoice = (): Record<string, unknown> => ({ template: 'invoice', data: { seller_name: 'Fernhill', invoice_number: `INV-${++seq}`, items: [{ description: 'x', amount: '1' }] } });
const accountBucket = (userId: string): string => `pdff:${userId}:${utcDay()}`;
const siteBucket = (siteId: string): string => `pdffs:${siteId}:${utcDay()}`;
const presetCounter = (bucket: string, count: number): Promise<number> =>
  run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3)', bucket, count, (utcDay() + 2) * DAY_MS);

describe('signed links count per site, never against the owner\'s API (G1)', () => {
  it.each([
    ['free', PDF.maxFailedRendersPerDay.free],
    ['starter', PDF.maxFailedRendersPerDay.paid],
  ] as const)('%s: one failing signed link opened %i times renders once and leaves POST /v1/pdf alone', async (plan, views) => {
    const owner = await createUser(plan);
    const key = await apiKeyFor(owner.id);
    const site = await createSite(owner.id);
    const link = await signedPdfPath(site, 'report', { title: `long-${++seq}` });
    const tooLong = mockBrowser(() => pdfResponse('51-pages', 0));
    const statuses = new Set<string>();
    for (let i = 0; i < views; i++) {
      const response = await call(link, {}, limitsOn(tooLong));
      statuses.add(`${response.status}:${(await errorOf(response)).code}`);
    }
    expect([...statuses]).toEqual(['422:template_error']);
    expect(tooLong.calls).toHaveLength(1);
    expect(await counterOf(siteBucket(site.id))).toBe(1);
    expect(await counterOf(accountBucket(owner.id))).toBe(0);

    const healthy = mockBrowser();
    const own = await postPdf(key.secret, invoice(), limitsOn(healthy));
    expect(own.status).toBe(200);
    expect(healthy.calls).toHaveLength(1);
  });

  it('many different failing signed links stop new signed PDFs of that site only, with a 429 that says so and until when', async () => {
    const owner = await createUser('free');
    const key = await apiKeyFor(owner.id);
    const site = await createSite(owner.id);
    const otherSite = await createSite(owner.id);
    const limit = PDF.maxFailedRendersPerDay.free;
    const tooLong = mockBrowser(() => pdfResponse('51-pages', 0));
    for (let i = 0; i < limit; i++) {
      expect((await call(await signedPdfPath(site, 'report', { title: `t-${++seq}` }), {}, limitsOn(tooLong))).status).toBe(422);
    }
    const refused = await call(await signedPdfPath(site, 'report', { title: `t-${++seq}` }), {}, limitsOn(tooLong));
    expect(refused.status).toBe(429);
    const error = await errorOf(refused);
    expect(error).toMatchObject({ code: 'rate_limited', details: { limit, scope: 'site' } });
    expect(error.message).toContain(`The signed PDF links of this site have had ${limit} renders today that produced no PDF`);
    expect(error.message).toContain('needed more images than were left');
    expect(error.message).toMatch(/after 00:00 UTC \(in \d+ (h \d+ )?min\)/);
    expect(error.message).toContain('POST /v1/pdf is not affected');
    // Retry-After: the seconds to the next 00:00 UTC.
    const retryAfter = Number(refused.headers.get('retry-after'));
    const toMidnight = Math.ceil(((utcDay() + 1) * DAY_MS - Date.now()) / 1000);
    expect(Math.abs(retryAfter - toMidnight)).toBeLessThanOrEqual(5);
    expect(tooLong.calls).toHaveLength(limit);

    // The owner's API and the owner's other site are not affected.
    expect((await postPdf(key.secret, invoice(), limitsOn(mockBrowser()))).status).toBe(200);
    expect((await call(await signedPdfPath(otherSite, 'invoice', { n: `${++seq}` }), {}, limitsOn(mockBrowser()))).status).toBe(200);
  });

  it('a signed link that does not fit what is left: 402 to every view after one render; a top-up makes it, and POST still works', async () => {
    // The last POST uses the allowance up: its 100% notice goes to a stubbed mail API.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'em_1' }));
    const owner = await createUser('starter');
    const key = await apiKeyFor(owner.id);
    const site = await createSite(owner.id);
    await setUsed(owner, PLANS.starter.monthlyImages - 2);
    const link = await signedPdfPath(site, 'report', { title: `Quarterly ${++seq}` });
    const twelve = mockBrowser(() => pdfResponse('12-pages', 0));
    const answers = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const response = await call(link, {}, limitsOn(twelve));
      answers.add(`${response.status}:${(await errorOf(response)).code}`);
    }
    expect([...answers]).toEqual(['402:quota_exceeded']);
    expect(twelve.calls).toHaveLength(1);
    expect(await counterOf(siteBucket(site.id))).toBe(1);

    const now = Date.now();
    await run(
      env.DB,
      'INSERT INTO topups (id, user_id, paddle_transaction_id, images, remaining, created_at, expires_at) VALUES (?1, ?2, ?3, 1000, 1000, ?4, ?5)',
      `tu_guard${seq}`,
      owner.id,
      `txn_guard${seq}`,
      now,
      now + 365 * DAY_MS,
    );
    const made = await call(link, {}, limitsOn(twelve));
    expect(made.status).toBe(200);
    expect(twelve.calls).toHaveLength(2);
    expect((await postPdf(key.secret, invoice(), limitsOn(mockBrowser()))).status).toBe(200);
  });
});

describe('the cap is reserved before the browser runs (G3)', () => {
  it('counter at limit - 1: 10 concurrent failing renders reach the browser once', async () => {
    const owner = await createUser('free');
    const key = await apiKeyFor(owner.id);
    const limit = PDF.maxFailedRendersPerDay.free;
    await presetCounter(accountBucket(owner.id), limit - 1);
    const slow = mockBrowser(async () => {
      await sleep(200);
      return pdfResponse('51-pages', 0);
    });
    const responses = await Promise.all(Array.from({ length: 10 }, () => postPdf(key.secret, { template: 'report', data: { title: `t${++seq}` } }, limitsOn(slow))));
    const statuses = responses.map((response) => response.status).sort();
    expect(slow.calls.length).toBeLessThanOrEqual(1);
    expect(statuses).toEqual([422, ...Array.from({ length: 9 }, () => 429)]);
    expect(await counterOf(accountBucket(owner.id))).toBe(limit);
  });

  it('a charged PDF gives its slot back: limit - 1 failures and any number of successes', async () => {
    const owner = await createUser('free');
    const key = await apiKeyFor(owner.id);
    await presetCounter(accountBucket(owner.id), PDF.maxFailedRendersPerDay.free - 1);
    for (let i = 0; i < 3; i++) expect((await postPdf(key.secret, invoice(), limitsOn(mockBrowser()))).status).toBe(200);
    expect(await counterOf(accountBucket(owner.id))).toBe(PDF.maxFailedRendersPerDay.free - 1);
  });
});

describe('only the document\'s failures count (G4)', () => {
  it.each([
    ['Browser Run 503', 500, 0, () => browserErrorResponse(503, 'Service unavailable', null)],
    ['Browser Run 500', 500, 0, () => browserErrorResponse(500, 'Internal error', null)],
    ['Browser Run 400', 500, 0, () => browserErrorResponse(400, 'Bad request', 0)],
    ['an unreachable binding', 500, 0, () => Promise.reject(new Error('network connection lost'))],
    ['Browser Run busy (429)', 429, 0, () => browserErrorResponse(429, 'Too many requests', null)],
    ['a browser 422', 422, 1, () => browserErrorResponse(422, 'Printing failed', 0)],
    ['a timeout reported as 500', 504, 1, () => browserErrorResponse(500, 'Navigation timeout of 30000 ms exceeded', null)],
    ['more than 50 pages', 422, 1, () => pdfResponse('51-pages', 0)],
  ] as const)('%s -> HTTP %i, counted %i', async (_label, status, counted, respond) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = await createUser('pro');
    const key = await apiKeyFor(owner.id);
    const response = await postPdf(key.secret, invoice(), limitsOn(mockBrowser(respond as () => Response)));
    expect(response.status).toBe(status);
    expect(await counterOf(accountBucket(owner.id))).toBe(counted);
    expect(await all(env.DB, "SELECT 1 FROM renders WHERE user_id = ?1 AND charged_to = 'pending'", owner.id)).toEqual([]);
  });

  it('a provider outage cannot lock a paid account out: 250 failing calls in a row, then a normal PDF', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = await createUser('starter');
    const key = await apiKeyFor(owner.id);
    const down = mockBrowser(() => browserErrorResponse(503, 'Service unavailable', null));
    for (let i = 0; i < PDF.maxFailedRendersPerDay.paid + 50; i++) expect((await postPdf(key.secret, invoice(), limitsOn(down))).status).toBe(500);
    expect((await postPdf(key.secret, invoice(), limitsOn(mockBrowser()))).status).toBe(200);
  }, 120_000);
});

describe('the free brake counts Free and free-tool browser time only (G5)', () => {
  const budget = 1000;
  const over = budget * PDF.freeBrakeBudgetMultiple + 1;
  const withBudget = { PDF_DAILY_BROWSER_MS_BUDGET: String(budget) };

  // Storage is per test file: the brake tests start from no browser time at all.
  beforeEach(async () => {
    await run(env.DB, 'DELETE FROM browser_usage');
    resetFreeBrake();
  });

  async function usageRow(id: string, userId: string | null, source: 'api' | 'signed' | 'tool', wallMs: number): Promise<void> {
    await run(
      env.DB,
      'INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at) VALUES (?1, ?2, ?3, 422, 0, ?4, NULL, ?5)',
      id,
      userId,
      source,
      wallMs,
      Date.now() - 60_000,
    );
  }

  it('heavy use by paid accounts never engages it', async () => {
    resetFreeBrake();
    const paid = await createUser('starter');
    const pro = await createUser('pro');
    await usageRow('bu_g5_paid1', paid.id, 'api', over);
    await usageRow('bu_g5_paid2', pro.id, 'signed', over);
    try {
      const free = await apiKeyFor((await createUser('free')).id);
      const response = await postPdf(free.secret, invoice(), limitsOn(mockBrowser(), withBudget));
      expect(response.status).toBe(200);
    } finally {
      await run(env.DB, "DELETE FROM browser_usage WHERE id IN ('bu_g5_paid1', 'bu_g5_paid2')");
      resetFreeBrake();
    }
  });

  it.each([
    ['a Free account', 'free-account'],
    ['the free tools', 'tool'],
  ] as const)('heavy use by %s engages it: 429 with Retry-After 3600 and an honest message', async (_label, who) => {
    resetFreeBrake();
    const heavy = await createUser('free');
    await usageRow(`bu_g5_${who}`, who === 'tool' ? null : heavy.id, who === 'tool' ? 'tool' : 'api', over);
    try {
      const free = await apiKeyFor((await createUser('free')).id);
      const browser = mockBrowser();
      const braked = await postPdf(free.secret, invoice(), limitsOn(browser, withBudget));
      expect(braked.status).toBe(429);
      expect(braked.headers.get('retry-after')).toBe('3600');
      const { message } = await errorOf(braked);
      expect(message).toContain('as that use ages out of the 24-hour window, at the latest 24 hours after it stopped');
      expect(message).toContain('Starter and Pro are not affected');
      expect(browser.calls).toEqual([]);
      const starter = await apiKeyFor((await createUser('starter')).id);
      expect((await postPdf(starter.secret, invoice(), limitsOn(browser, withBudget))).status).toBe(200);
    } finally {
      await run(env.DB, 'DELETE FROM browser_usage WHERE id = ?1', `bu_g5_${who}`);
      resetFreeBrake();
    }
  });
});

describe('HEAD of a signed link says what a GET would (G8)', () => {
  it('429 when the site used its failed renders today; nothing is counted', async () => {
    const owner = await createUser('free');
    const site = await createSite(owner.id);
    await presetCounter(siteBucket(site.id), PDF.maxFailedRendersPerDay.free);
    const link = await signedPdfPath(site, 'invoice', { n: `${++seq}` });
    const browser = mockBrowser();
    const head = await call(link, { method: 'HEAD' }, limitsOn(browser));
    const get = await call(link, {}, limitsOn(browser));
    expect(head.status).toBe(429);
    expect(get.status).toBe(429);
    expect(Number(head.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await counterOf(siteBucket(site.id))).toBe(PDF.maxFailedRendersPerDay.free);
    expect(browser.calls).toEqual([]);
  });

  it('429 on Free while the free brake is on; Starter still 200', async () => {
    await run(env.DB, 'DELETE FROM browser_usage');
    resetFreeBrake();
    await run(
      env.DB,
      "INSERT INTO browser_usage (id, user_id, source, status, browser_ms, wall_ms, pages, created_at) VALUES ('bu_g8', NULL, 'tool', 422, 0, ?1, NULL, ?2)",
      1000 * PDF.freeBrakeBudgetMultiple + 1,
      Date.now() - 60_000,
    );
    try {
      const overrides = { PDF_DAILY_BROWSER_MS_BUDGET: '1000' };
      const free = await createSite((await createUser('free')).id);
      const head = await call(await signedPdfPath(free, 'invoice', { n: `${++seq}` }), { method: 'HEAD' }, limitsOn(mockBrowser(), overrides));
      expect(head.status).toBe(429);
      expect(head.headers.get('retry-after')).toBe('3600');
      const paid = await createSite((await createUser('starter')).id);
      expect((await call(await signedPdfPath(paid, 'invoice', { n: `${++seq}` }), { method: 'HEAD' }, limitsOn(mockBrowser(), overrides))).status).toBe(200);
    } finally {
      await run(env.DB, "DELETE FROM browser_usage WHERE id = 'bu_g8'");
      resetFreeBrake();
    }
  });

  it('answers a remembered failure like the GET, without rendering', async () => {
    const owner = await createUser('starter');
    const site = await createSite(owner.id);
    const link = await signedPdfPath(site, 'report', { title: `long-${++seq}` });
    const tooLong = mockBrowser(() => pdfResponse('51-pages', 0));
    expect((await call(link, {}, limitsOn(tooLong))).status).toBe(422);
    expect((await call(link, { method: 'HEAD' }, limitsOn(tooLong))).status).toBe(422);
    expect(tooLong.calls).toHaveLength(1);
  });
});
