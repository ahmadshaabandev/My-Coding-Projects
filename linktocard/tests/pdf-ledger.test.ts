// The PDF ledger row is claimed before the browser runs (src/pdf/service.ts, src/lib/quota.ts
// claimPdf): of several identical requests exactly one renders and the others wait for its
// result. Failures of the document and 402s after rendering are remembered for
// PDF.failedRenderMemoryMs (src/pdf/guard.ts). Each test here failed on c15216b, where every
// identical request rendered for itself.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP } from '../src/billing/plans';
import { DAY_MS, PDF, pdfUnits } from '../src/config';
import { all, first, run } from '../src/db/client';
import { runCleanup } from '../src/lib/cleanup';
import { ApiError } from '../src/lib/errors';
import { creditTopup, currentPeriod, PDF_PENDING_STALE_MS } from '../src/lib/quota';
import { parsePdfRequest } from '../src/pdf/input';
import { getPdf, pdfCacheKey, pdfR2Key, PDF_DUPLICATE_WAIT_MS, type PdfRequest } from '../src/pdf/service';
import type { Env, UserRow } from '../src/types';
import { apiKeyFor, createSite, createUser, errorOf, setUsed, usageOf, userRow } from './app-helpers';
import { browserErrorResponse, counterOf, limitsOn, mockBrowser, pdfEnv, pdfResponse, postPdf, slowDb, utcDay } from './pdf-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const background = (work: Promise<unknown>): void => void work.catch(() => undefined);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;

async function requestFor(user: UserRow, data: Record<string, unknown> = {}): Promise<PdfRequest> {
  const { job } = await parsePdfRequest(env.DB, user, { template: 'report', data: { title: 'Ledger', note: `n${++seq}`, ...data } });
  return { user, job, source: 'api', siteId: null };
}

/** "ok:<credits>[:cached]" or "<status>:<code>". */
async function outcome(work: Promise<{ creditsUsed: number; cached: boolean }>): Promise<string> {
  try {
    const result = await work;
    return `ok:${result.creditsUsed}${result.cached ? ':cached' : ''}`;
  } catch (error) {
    if (error instanceof ApiError) return `${error.status}:${error.code}`;
    throw error;
  }
}

/** The ApiError a request ends with; fails the test when it produced a PDF. */
async function failureOf(work: Promise<unknown>): Promise<ApiError> {
  const result = await work.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(result instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(result)}`);
  return result;
}

const tally = (results: string[]): Record<string, number> => results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {});
const rowsOf = (userId: string) => all<{ cache_key: string; charged_to: string; expires_at: number }>(env.DB, 'SELECT cache_key, charged_to, expires_at FROM renders WHERE user_id = ?1', userId);

async function pendingRow(user: UserRow, cacheKey: string, createdAt: number): Promise<void> {
  const period = currentPeriod(user, createdAt);
  await run(
    env.DB,
    `INSERT INTO renders (cache_key, user_id, site_id, source, template, width, height, format, bytes, r2_key, charged_to, period_start, created_at, expires_at)
     VALUES (?1, ?2, NULL, 'api', 'report', 0, 0, 'pdf', 0, ?3, 'pending', ?4, ?5, ?6)`,
    cacheKey,
    user.id,
    pdfR2Key(user.id, cacheKey),
    period.start,
    createdAt,
    createdAt + 7 * DAY_MS,
  );
}

describe('identical requests: one render', () => {
  it('10 identical concurrent POST /v1/pdf: 1 browser call, 1 charge, all 200 (G2)', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const browser = mockBrowser(async () => {
      await sleep(300);
      return pdfResponse('1-page', 0);
    });
    const body = { template: 'invoice', data: { seller_name: 'Fernhill', invoice_number: `G2-${++seq}`, items: [{ description: 'x', amount: '1' }] } };
    const responses = await Promise.all(Array.from({ length: 10 }, () => postPdf(key.secret, body, limitsOn(browser))));
    const json = (await Promise.all(responses.map((response) => response.json()))) as Array<{ credits_used: number; id: string }>;
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 10 }, () => 200));
    expect(json.map((entry) => entry.credits_used).sort()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, pdfUnits(1)]);
    expect(new Set(json.map((entry) => entry.id)).size).toBe(1);
    expect(browser.calls).toHaveLength(1);
    expect((await usageOf(user.id)).used).toBe(pdfUnits(1));
    expect(await all(env.DB, 'SELECT id FROM browser_usage WHERE user_id = ?1', user.id)).toHaveLength(1);
    expect(await rowsOf(user.id)).toMatchObject([{ charged_to: 'plan' }]);
    // Every slot reserved for the render went back: a charged PDF is not a failed render.
    expect(await counterOf(`pdff:${user.id}:${utcDay()}`)).toBe(0);
  });

  it.each([100, 150])(
    'D1 round trips of %i ms: 8 identical requests that do not fit all get 402, after 1 browser call (LEDGER-1)',
    async (latency) => {
      const user = await createUser('starter');
      const now = Date.now();
      await setUsed(user, PLANS.starter.monthlyImages - 2, now);
      const browser = mockBrowser(() => pdfResponse('12-pages'));
      const bindings: Env = { ...pdfEnv(browser), DB: slowDb(env.DB, latency) };
      const request = await requestFor(user, { title: `Latency ${latency}` });
      const results = await Promise.all(Array.from({ length: 8 }, () => outcome(getPdf(bindings, background, request, { now, withBody: false }))));
      expect(tally(results)).toEqual({ '402:quota_exceeded': 8 });
      expect(browser.calls).toHaveLength(1);
      expect((await usageOf(user.id)).used).toBe(PLANS.starter.monthlyImages - 2);
      expect(await rowsOf(user.id)).toEqual([]);
    },
    60_000,
  );

  it('8 identical requests that fit, D1 round trips of 100 ms: one charge, seven served the stored PDF free', async () => {
    const user = await createUser('starter');
    const now = Date.now();
    const browser = mockBrowser(() => pdfResponse('12-pages'));
    const bindings: Env = { ...pdfEnv(browser), DB: slowDb(env.DB, 100) };
    const request = await requestFor(user);
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(getPdf(bindings, background, request, { now, withBody: false }))));
    expect(tally(results)).toEqual({ 'ok:3': 1, 'ok:0:cached': 7 });
    expect(browser.calls).toHaveLength(1);
    expect((await usageOf(user.id)).used).toBe(3);
  });
});

describe('waiting for an identical request that holds the claim', () => {
  it('is served the PDF that request pays for and stores, without rendering', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser();
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - 1000);
    const waiting = outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }));
    await sleep(600);
    // What the holder does when its charge succeeds: label the row paid, then store the object.
    await run(env.DB, "UPDATE renders SET charged_to = 'plan' WHERE cache_key = ?1", cacheKey);
    await env.BUCKET.put(pdfR2Key(user.id, cacheKey), new Uint8Array([37, 80, 68, 70]), {
      customMetadata: { expiresAt: String(now + DAY_MS), createdAt: String(now - 1000), pages: '1', units: '2', filename: 'report.pdf', template: 'report' },
    });
    expect(await waiting).toBe('ok:0:cached');
    expect(browser.calls).toEqual([]);
  });

  it('renders once itself when that request releases the row without a remembered failure', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser();
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - 1000);
    const waiting = outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }));
    await sleep(600);
    await run(env.DB, 'DELETE FROM renders WHERE cache_key = ?1', cacheKey);
    expect(await waiting).toBe(`ok:${pdfUnits(1)}`);
    expect(browser.calls).toHaveLength(1);
  });

  it('when the wait runs out: 429 saying what is happening, Retry-After until the claim can be taken over, nothing rendered or stored', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser();
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - 10_000);
    const error = await failureOf(getPdf(pdfEnv(browser), background, request, { now, withBody: false, maxWaitMs: 800 }));
    expect(error).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(error.message).toMatch(/^An identical request started making this PDF 1\d s ago and has not finished; this request waited 1 s for it and charged nothing\./);
    const retryAfter = Number(error.headers?.['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(PDF_PENDING_STALE_MS / 1000 - 12);
    expect(retryAfter).toBeLessThanOrEqual(PDF_PENDING_STALE_MS / 1000 - 10);
    expect(browser.calls).toEqual([]);
    expect((await env.BUCKET.list({ prefix: `r/${user.id}/` })).objects).toEqual([]);
  });

  it('when the wait runs out and no PDF can fit any more: 402', async () => {
    const user = await createUser('starter');
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - 1000);
    const waiting = outcome(getPdf(pdfEnv(mockBrowser()), background, request, { now, withBody: false, maxWaitMs: 1500 }));
    await sleep(300);
    await setUsed(user, PLANS.starter.monthlyImages, now);
    expect(await waiting).toBe('402:quota_exceeded');
  });

  it('waits about as long as one browser call may take, plus 15 s; a claimant is taken over only well after that', () => {
    const callDeadline = 2 * PDF.renderTimeoutMs + 15_000;
    expect(PDF_DUPLICATE_WAIT_MS).toBe(callDeadline + 15_000);
    // Up to 30 remote images (4 at a time, 4 s each) and the browser call happen between a claim and its charge.
    expect(PDF_PENDING_STALE_MS).toBeGreaterThanOrEqual(callDeadline + 60_000);
  });

  it('renders a paid PDF again, free, when its object never reached R2', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser();
    const request = await requestFor(user);
    const now = Date.now();
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }))).toBe(`ok:${pdfUnits(1)}`);
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await env.BUCKET.delete(pdfR2Key(user.id, cacheKey));
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now: now + 1000, withBody: false }))).toBe('ok:0');
    expect(browser.calls).toHaveLength(2);
    expect((await usageOf(user.id)).used).toBe(pdfUnits(1));
    expect(await env.BUCKET.head(pdfR2Key(user.id, cacheKey))).not.toBeNull();
  });
});

describe('a request that waited', () => {
  it('claims with the time of its claim, so an identical request cannot take it over as if it had run all its wait too (V-LG-5)', async () => {
    const user = await createUser('starter');
    const request = await requestFor(user);
    const T = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, T - 10_000);
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const browser = mockBrowser(async () => {
      await gate;
      return pdfResponse('1-page', 0);
    });
    const b = outcome(getPdf(pdfEnv(browser), background, request, { now: T, withBody: false }));
    await sleep(600);
    // The request B waited for ends without a remembered failure: B claims and renders.
    await run(env.DB, 'DELETE FROM renders WHERE cache_key = ?1', cacheKey);
    for (let i = 0; i < 100 && browser.calls.length < 1; i++) await sleep(20);
    expect(browser.calls).toHaveLength(1);
    const claimed = await first<{ created_at: number }>(env.DB, 'SELECT created_at FROM renders WHERE cache_key = ?1', cacheKey);
    expect(claimed!.created_at - T).toBeGreaterThanOrEqual(500);
    // PDF_PENDING_STALE_MS after B's request time, but not after its claim: C waits instead of rendering.
    const c = await outcome(getPdf(pdfEnv(browser), background, request, { now: T + PDF_PENDING_STALE_MS + 1, withBody: false, maxWaitMs: 200 }));
    expect(c).toBe('429:rate_limited');
    open();
    expect(await b).toBe(`ok:${pdfUnits(1)}`);
    expect(browser.calls).toHaveLength(1);
  });

  it('looks at the ledger read-only and sends the claim only when it can be taken (V-LG-7)', async () => {
    const user = await createUser('starter');
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - 1000);
    let claims = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'batch') {
          return (statements: D1PreparedStatement[]) => {
            if (statements.length === 3) claims++;
            return target.batch(statements);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    expect(await outcome(getPdf({ ...pdfEnv(mockBrowser()), DB: db }, background, request, { now, withBody: false, maxWaitMs: 2_000 }))).toBe('429:rate_limited');
    expect(claims).toBe(1);
  });

  it('of a signed link is limited by the site\'s render rate limit before it waits (V-LG-7)', async () => {
    const owner = await createUser('starter');
    const site = await createSite(owner.id);
    const { job } = await parsePdfRequest(env.DB, owner, { template: 'report', data: { title: `rl-${++seq}` } });
    const request: PdfRequest = { user: owner, job, source: 'signed', siteId: site.id, renderRateLimitKey: site.id };
    const now = Date.now();
    await pendingRow(owner, await pdfCacheKey(owner.id, job), now - 1000);
    let consulted = 0;
    const deny = { limit: () => ((consulted += 1), Promise.resolve({ success: false })) };
    const started = Date.now();
    const error = await failureOf(getPdf(limitsOn(mockBrowser(), { RL_KEY: deny }), background, request, { now, withBody: false }));
    expect(error).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(error.message).toContain('Too many requests');
    expect(consulted).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('renders a paid PDF whose object is missing once, however many identical requests find it (V-LG-6)', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser(async () => {
      await sleep(300);
      return pdfResponse('1-page', 0);
    });
    const request = await requestFor(user);
    const now = Date.now();
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }))).toBe(`ok:${pdfUnits(1)}`);
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await env.BUCKET.delete(pdfR2Key(user.id, cacheKey));
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(getPdf(pdfEnv(browser), background, request, { now: now + 1000, withBody: false }))));
    expect(browser.calls).toHaveLength(2);
    expect(tally(results)).toEqual({ 'ok:0': 1, 'ok:0:cached': 7 });
    expect((await usageOf(user.id)).used).toBe(pdfUnits(1));
    expect(await first(env.DB, "SELECT bucket FROM tool_usage WHERE bucket = ?1", `pdfr:${cacheKey}`)).toBeNull();
  });
});

describe('failures are remembered by cache key', () => {
  it('a document the browser cannot render: the identical request gets the same answer without rendering, until the memory ends', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser(() => browserErrorResponse(422, 'Protocol error (Page.printToPDF): Printing failed'));
    const request = await requestFor(user);
    const now = Date.now();
    const first = await failureOf(getPdf(pdfEnv(browser), background, request, { now, withBody: false }));
    const again = await failureOf(getPdf(pdfEnv(browser), background, request, { now: now + 1000, withBody: false }));
    expect(first).toMatchObject({ code: 'template_error' });
    expect(again).toMatchObject({ code: 'template_error' });
    expect(again.message.startsWith(first.message)).toBe(true);
    expect(again.message).toContain('without being rendered again');
    expect(browser.calls).toHaveLength(1);
    // After PDF.failedRenderMemoryMs it is tried again.
    await outcome(getPdf(pdfEnv(browser), background, request, { now: now + PDF.failedRenderMemoryMs + 1, withBody: false }));
    expect(browser.calls).toHaveLength(2);
  });

  it('a document with too many pages keeps its details', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser(() => pdfResponse('51-pages'));
    const request = await requestFor(user);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const error = await failureOf(getPdf(pdfEnv(browser), background, request, { now: now + i, withBody: false }));
      expect(error).toMatchObject({ code: 'template_error', details: { max_pages: PDF.maxPages, pages_rendered: 51 } });
    }
    expect(browser.calls).toHaveLength(1);
  });

  it.each([
    ['Browser Run 503', () => browserErrorResponse(503, 'Service unavailable', null)],
    ['Browser Run 500', () => browserErrorResponse(500, 'Internal error', null)],
    ['Browser Run busy (429)', () => browserErrorResponse(429, 'Too many requests', null)],
    [
      'an unreachable binding',
      () => {
        throw new Error('network connection lost');
      },
    ],
  ])('%s is never remembered: the next identical request renders again', async (_label, respond) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = await createUser('starter');
    const browser = mockBrowser(respond as () => Response);
    const request = await requestFor(user);
    const now = Date.now();
    await outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }));
    await outcome(getPdf(pdfEnv(browser), background, request, { now: now + 1, withBody: false }));
    expect(browser.calls).toHaveLength(2);
    expect(await rowsOf(user.id)).toEqual([]);
  });

  it('a 402 after rendering: answered again with the images now left, without rendering; after a top-up the PDF is made', async () => {
    const user = await createUser('starter');
    const now = Date.now();
    await setUsed(user, PLANS.starter.monthlyImages - 2, now);
    const browser = mockBrowser(() => pdfResponse('12-pages'));
    const request = await requestFor(user);
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false }))).toBe('402:quota_exceeded');
    const again = await failureOf(getPdf(pdfEnv(browser), background, request, { now: now + 1, withBody: false }));
    expect(again).toMatchObject({ code: 'quota_exceeded', details: { units_needed: 3, usage: { remaining: 2 } } });
    expect(browser.calls).toHaveLength(1);

    await creditTopup(env.DB, { userId: user.id, transactionId: `txn_ledger_${++seq}`, images: TOPUP.images, now });
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now: now + 2, withBody: false }))).toBe('ok:3');
    expect(browser.calls).toHaveLength(2);
    expect(await rowsOf(user.id)).toMatchObject([{ charged_to: 'topup' }]);
  });
});

describe('releasing a claim', () => {
  it('that took over an expired paid PDF leaves no R2 object behind once the cleanup has run (LEDGER-3)', async () => {
    const user = await createUser('free');
    const bindings = pdfEnv(mockBrowser(() => pdfResponse('12-pages')));
    const request = await requestFor(user);
    const cacheKey = await pdfCacheKey(user.id, request.job);
    const t0 = Date.UTC(2026, 10, 2, 12);
    expect(await outcome(getPdf(bindings, background, request, { now: t0, withBody: false }))).toBe('ok:3');
    expect(await env.BUCKET.head(pdfR2Key(user.id, cacheKey))).not.toBeNull();

    // 8 days later (Free keeps PDFs 7 days) 2 images are left; the 12-page PDF needs 3.
    const t1 = t0 + 8 * DAY_MS;
    await setUsed(await userRow(user.id), PLANS.free.monthlyImages - 2, t1);
    expect(await outcome(getPdf(bindings, background, request, { now: t1, withBody: false }))).toBe('402:quota_exceeded');
    // The row is kept, expired, so that the cleanup finds the object through it.
    expect(await rowsOf(user.id)).toMatchObject([{ cache_key: cacheKey, expires_at: 0 }]);

    await runCleanup(env, t1 + DAY_MS);
    expect(await env.BUCKET.head(pdfR2Key(user.id, cacheKey))).toBeNull();
    expect(await rowsOf(user.id)).toEqual([]);
  });

  it('a fresh claim that ends without a PDF leaves no row at all', async () => {
    const user = await createUser('starter');
    const request = await requestFor(user);
    await outcome(getPdf(pdfEnv(mockBrowser(() => pdfResponse('51-pages'))), background, request, { now: Date.now(), withBody: false }));
    expect(await rowsOf(user.id)).toEqual([]);
  });

  it('a charge that throws (D1 error): the claim and the failed-render slot are given back, and the next request charges normally (G7)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    const browser = mockBrowser();
    let fail = true;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            // The first charging batch is the one with five statements (allowance).
            if (fail && statements.length === 5) {
              fail = false;
              throw new Error('D1_ERROR: simulated');
            }
            return target.batch(statements);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const body = { template: 'invoice', data: { seller_name: 'Fernhill', invoice_number: `G7-${++seq}` } };
    const failed = await postPdf(key.secret, body, limitsOn(browser, { DB: db }));
    expect(failed.status).toBe(500);
    expect(await rowsOf(user.id)).toEqual([]);
    expect(await counterOf(`pdff:${user.id}:${utcDay()}`)).toBe(0);

    const ok = await postPdf(key.secret, body, limitsOn(browser));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { credits_used: number }).credits_used).toBe(pdfUnits(1));
    expect(browser.calls).toHaveLength(2);
  });

  it('a render the rate limiter refuses after the claim leaves neither a pending row nor a used slot (G7)', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const browser = mockBrowser();
    const deny = { limit: () => Promise.resolve({ success: false }) };
    const refused = await postPdf(key.secret, { template: 'invoice', data: { invoice_number: `RL-${++seq}` } }, limitsOn(browser, { RL_PDF_FREE: deny }));
    expect(refused.status).toBe(429);
    expect((await errorOf(refused)).code).toBe('rate_limited');
    expect(browser.calls).toEqual([]);
    expect(await rowsOf(user.id)).toEqual([]);
    expect(await counterOf(`pdff:${user.id}:${utcDay()}`)).toBe(0);
  });

  it('a pending row left by a request that died is taken over only after PDF_PENDING_STALE_MS', async () => {
    const user = await createUser('starter');
    const browser = mockBrowser();
    const request = await requestFor(user);
    const now = Date.now();
    const cacheKey = await pdfCacheKey(user.id, request.job);
    await pendingRow(user, cacheKey, now - PDF_PENDING_STALE_MS + 5_000);
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now, withBody: false, maxWaitMs: 300 }))).toBe('429:rate_limited');
    expect(browser.calls).toEqual([]);
    expect(await outcome(getPdf(pdfEnv(browser), background, request, { now: now + 5_001, withBody: false }))).toBe(`ok:${pdfUnits(1)}`);
    expect(browser.calls).toHaveLength(1);
    expect(await first(env.DB, 'SELECT charged_to FROM renders WHERE cache_key = ?1', cacheKey)).toEqual({ charged_to: 'plan' });
  });
});
