// Owner decision of 2026-11-28: "$8 top-up without a subscription: yes, allow it."
// A Free account can buy the same one-time top-up as Starter and Pro (src/billing/plans.ts,
// `topUps` on the Free plan). These tests drive the real Worker app, as the acceptance list does:
//   - a completed top-up transaction credits a Free account, which stays on Free;
//   - at its monthly limit, a Free account with top-up images keeps rendering and is charged to
//     the top-up, with the Free mark, cache days and plan unchanged; a PDF is paid from it as one
//     block and keeps the Free footer line;
//   - the 402 and the quota email of a Free account offer the top-up, and only while checkout is
//     open on the deployment (src/billing/offers.ts): production runs with CHECKOUT_ENABLED "false",
//     and nothing may send a customer to buy what is not on sale;
//   - /api/config tells the site that every plan can buy one.
// The checkout itself opens in the browser (Paddle.js); its rule for a Free account is tested in
// tests/node/topup-site.test.ts.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, PLAN_ORDER, TOPUP, formatCount, formatUsd } from '../src/billing/plans';
import { DAY_MS, PDF } from '../src/config';
import type { Env } from '../src/types';
import {
  ORIGIN,
  TINY_CSS,
  TINY_HTML,
  apiKeyFor,
  bearer,
  bytesOf,
  call,
  createSite,
  createUser,
  dashboard,
  errorOf,
  isPng,
  paddleSignature,
  postImage,
  postWebhook,
  renderCount,
  requestUrl,
  sessionCookieFor,
  setUsed,
  signedPath,
  usageOf,
  userRow,
} from './app-helpers';
import { footerOf, mockBrowser, pdfEnv, postPdf } from './pdf-helpers';
import adjustmentUpdated from './fixtures/paddle/adjustment.updated.json';
import transactionCompleted from './fixtures/paddle/transaction.completed.json';

interface PaddleFixture {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

interface ImageJson {
  id: string;
  cached: boolean;
  created_at: string;
  expires_at: string;
  usage: { plan: string; used: number; remaining: number; topup_remaining: number; total_remaining: number; cache_days: number; watermark: boolean };
}

/** Checkout closed, as production runs today: every Paddle value in place, the switch off. */
const CHECKOUT_CLOSED: Env = { ...env, CHECKOUT_ENABLED: 'false' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_tuf${String(++sequence).padStart(4, '0')}`;

/** Paddle's official transaction.completed example, made a purchase of one top-up by this account. */
function topUpPurchase(userId: string): { raw: string; transactionId: string; customerId: string } {
  const event = structuredClone(transactionCompleted) as PaddleFixture;
  const transactionId = nextId('txn');
  const customerId = nextId('ctm');
  event.event_id = nextId('evt');
  event.occurred_at = new Date().toISOString();
  // What the checkout sends: the account id as custom data, and no subscription.
  Object.assign(event.data, { id: transactionId, customer_id: customerId, subscription_id: null, custom_data: { user_id: userId } });
  // The example has three items; the third is a one-time price, which becomes the top-up.
  const item = (event.data.items as Array<{ price: { id: string }; quantity: number }>)[2]!;
  item.price.id = env.PADDLE_PRICE_TOPUP ?? '';
  item.quantity = 1;
  return { raw: JSON.stringify(event), transactionId, customerId };
}

async function buyTopUp(userId: string): Promise<{ transactionId: string; customerId: string }> {
  const purchase = topUpPurchase(userId);
  const response = await postWebhook(purchase.raw, await paddleSignature(purchase.raw));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, result: 'ok' });
  return purchase;
}

/** Resend accepts every email; returns what it was asked to send. */
function mockResend(): Array<{ to: string; subject: string; text: string }> {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.href !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url.href}`);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: [body.to].flat().join(','), subject: body.subject, text: body.text });
    return Response.json({ id: 'email_test' });
  });
  return sent;
}

const card = (title: string): Record<string, unknown> => ({ html: TINY_HTML, css: TINY_CSS, data: { title, n: '1' } });
const TOP_UP_OFFER = `You can buy a top-up of ${formatCount(TOPUP.images)} images for ${formatUsd(TOPUP.priceUsd)} (plus tax where it applies) in the dashboard.`;
const STAYS_FREE = 'A top-up adds images only. You stay on the Free plan, so what you make still carries the small Link To Card mark.';

describe('the top-up without a subscription (owner decision of 2026-11-28)', () => {
  it('plans.ts lets every plan buy the top-up and leaves the Free plan as it was', () => {
    expect(PLAN_ORDER.map((id) => PLANS[id].topUps)).toEqual([true, true, true]);
    // The top-up itself is unchanged, and so is everything else about Free.
    expect(TOPUP).toMatchObject({ priceUsd: 8, images: 1000, validDays: 365, paddlePriceEnv: 'PADDLE_PRICE_TOPUP' });
    expect(PLANS.free).toMatchObject({ priceUsd: 0, monthlyImages: 100, cacheDays: 7, watermark: true, fonts: { maxFiles: 0, maxBytesPerFile: 0 }, paddlePriceEnv: null });
  });

  it('/api/config tells the site that a Free account can buy the top-up, with the price id the checkout needs', async () => {
    const config = (await (await call('/api/config')).json()) as {
      paddle: { prices: Record<string, string> } | null;
      plans: Array<{ id: string; top_ups: boolean; watermark: boolean }>;
      topup: Record<string, number>;
    };
    expect(config.plans.find((plan) => plan.id === 'free')).toMatchObject({ top_ups: true, watermark: true });
    expect(config.plans.map((plan) => plan.top_ups)).toEqual([true, true, true]);
    expect(config.paddle?.prices.topup).toBe(env.PADDLE_PRICE_TOPUP);
    expect(config.topup).toEqual({ price_usd: TOPUP.priceUsd, images: TOPUP.images, valid_days: TOPUP.validDays });

    // Checkout closed: the plans still say what they allow, and there is nothing to open a checkout with.
    const closed = (await (await call('/api/config', {}, CHECKOUT_CLOSED)).json()) as { paddle: unknown; plans: Array<{ id: string; top_ups: boolean }> };
    expect(closed.paddle).toBeNull();
    expect(closed.plans.find((plan) => plan.id === 'free')?.top_ups).toBe(true);
  });

  it('a completed top-up transaction credits a Free account, which stays on the Free plan', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const cookie = await sessionCookieFor(user.id);
    const { transactionId, customerId } = await buyTopUp(user.id);

    const stored = await userRow(user.id);
    expect(stored).toMatchObject({ plan: 'free', paddle_customer_id: customerId, paddle_subscription_id: null, subscription_status: null });

    const usage = (await (await call('/v1/usage', { headers: bearer(key.secret) })).json()) as ImageJson['usage'] & { limit: number };
    expect(usage).toMatchObject({
      plan: 'free',
      limit: PLANS.free.monthlyImages,
      used: 0,
      topup_remaining: TOPUP.images,
      total_remaining: PLANS.free.monthlyImages + TOPUP.images,
      cache_days: PLANS.free.cacheDays,
      watermark: true,
    });

    // The dashboard shows the balance and, now that a Paddle customer exists, the billing portal.
    const me = (await (await dashboard(cookie, 'GET', '/api/me')).json()) as {
      user: { plan: string; subscription: unknown; has_billing: boolean };
      usage: { topup_remaining: number };
      topups: Array<{ images: number; remaining: number; expires_at: string }>;
      limits: { fonts: { max_files: number } };
    };
    expect(me.user).toMatchObject({ plan: 'free', subscription: null, has_billing: true });
    expect(me.usage.topup_remaining).toBe(TOPUP.images);
    expect(me.topups).toHaveLength(1);
    expect(me.topups[0]).toMatchObject({ images: TOPUP.images, remaining: TOPUP.images });
    const validFor = Date.parse(me.topups[0]!.expires_at) - Date.now();
    expect(validFor).toBeGreaterThan((TOPUP.validDays - 1) * DAY_MS);
    expect(validFor).toBeLessThanOrEqual(TOPUP.validDays * DAY_MS);
    // Still no custom fonts: a top-up is not a paid plan.
    expect(me.limits.fonts.max_files).toBe(0);

    // The same transaction under another event id does not credit twice.
    const again = topUpPurchase(user.id);
    const replay = JSON.stringify({ ...(JSON.parse(again.raw) as PaddleFixture), data: { ...(JSON.parse(again.raw) as PaddleFixture).data, id: transactionId } });
    expect(await (await postWebhook(replay, await paddleSignature(replay))).json()).toEqual({ ok: true, result: 'ignored:already_credited' });
    expect((await usageOf(user.id)).topup_remaining).toBe(TOPUP.images);
  });

  it('a Free account at its monthly limit keeps rendering from its top-up and is charged to it; the Free mark and cache days stay', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const cookie = await sessionCookieFor(user.id);
    await setUsed(user, PLANS.free.monthlyImages);

    // Without a top-up: the hard stop.
    const refused = await postImage(key.secret, card('At the limit'));
    expect(refused.status).toBe(402);
    expect((await errorOf(refused)).code).toBe('quota_exceeded');
    expect(await renderCount(user.id)).toBe(0);

    await buyTopUp(user.id);

    // The same request now renders, paid by the top-up. The monthly counter does not move.
    const rendered = await postImage(key.secret, card('At the limit'));
    expect(rendered.status).toBe(200);
    const image = (await rendered.json()) as ImageJson;
    expect(image.cached).toBe(false);
    expect(image.usage).toMatchObject({
      plan: 'free',
      used: PLANS.free.monthlyImages,
      remaining: 0,
      topup_remaining: TOPUP.images - 1,
      total_remaining: TOPUP.images - 1,
      cache_days: PLANS.free.cacheDays,
      watermark: true,
    });
    // Kept for the Free plan's cache days, not a paid plan's.
    expect(Date.parse(image.expires_at) - Date.parse(image.created_at)).toBe(PLANS.free.cacheDays * DAY_MS);

    const renders = (await (await dashboard(cookie, 'GET', '/api/renders')).json()) as { renders: Array<{ id: string; charged_to: string }> };
    expect(renders.renders).toEqual([expect.objectContaining({ id: image.id, charged_to: 'topup' })]);

    // Asking again is free, as for any cached image.
    const cached = (await (await postImage(key.secret, card('At the limit'))).json()) as ImageJson;
    expect(cached).toMatchObject({ id: image.id, cached: true });
    expect((await usageOf(user.id)).topup_remaining).toBe(TOPUP.images - 1);

    // Signed URLs are paid the same way.
    const site = await createSite(user.id);
    const signed = await call(await signedPath(site, 'blog', { title: 'Paid by the top-up' }));
    expect(signed.status).toBe(200);
    expect(signed.headers.get('x-ltc-cache')).toBe('miss');
    expect(await usageOf(user.id)).toMatchObject({ plan: 'free', used: PLANS.free.monthlyImages, topup_remaining: TOPUP.images - 2, watermark: true });
    expect((await userRow(user.id)).plan).toBe('free');
  });

  it('an image paid by a top-up on Free is the Free image, mark included: the same bytes as from the allowance, not those of a paid plan', async () => {
    const body = { ...card('Same card, three accounts'), response: 'binary' };
    const fromAllowance = await createUser('free');
    const fromTopUp = await createUser('free');
    const paid = await createUser('starter');
    await setUsed(fromTopUp, PLANS.free.monthlyImages);
    await buyTopUp(fromTopUp.id);

    const bytes: Record<string, Uint8Array> = {};
    for (const [name, user] of Object.entries({ fromAllowance, fromTopUp, paid })) {
      const response = await postImage((await apiKeyFor(user.id)).secret, body);
      expect(response.status, name).toBe(200);
      bytes[name] = await bytesOf(response);
      expect(isPng(bytes[name]!), name).toBe(true);
    }
    expect((await usageOf(fromTopUp.id)).topup_remaining).toBe(TOPUP.images - 1);
    expect(bytes.fromTopUp).toEqual(bytes.fromAllowance);
    expect(bytes.fromTopUp).not.toEqual(bytes.paid);
  });

  it('the 402 of a Free account offers the top-up while checkout is open, and reads as before while it is closed', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const site = await createSite(user.id);
    await setUsed(user, PLANS.free.monthlyImages);
    const request = { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify(card('No images left')) };
    const signed = await signedPath(site, 'blog', { title: 'No images left' });

    for (const response of [await call('/v1/images', request), await call(signed)]) {
      expect(response.status).toBe(402);
      const error = await errorOf(response);
      expect(error.code).toBe('quota_exceeded');
      expect(error.message.endsWith(`Images that are already cached keep working; to render new ones now, upgrade or buy a top-up at ${ORIGIN}/pricing.`)).toBe(true);
    }
    for (const response of [await call('/v1/images', request, CHECKOUT_CLOSED), await call(signed, {}, CHECKOUT_CLOSED)]) {
      expect(response.status).toBe(402);
      const error = await errorOf(response);
      // Word for word the message from before 2026-11-28.
      expect(error.message).toMatch(
        /^The monthly allowance of 100 images on the Free plan is used up\. It resets on \S+\. Images that are already cached keep working; to render new ones now, upgrade at https:\/\/linktocard\.test\/pricing\.$/,
      );
      expect(error.message).not.toContain('top-up');
    }
    expect(await renderCount(user.id)).toBe(0);
  });

  it('the highest plan is offered a top-up only while checkout is open, and the sentence stays whole when it is not', async () => {
    const user = await createUser('pro');
    const key = await apiKeyFor(user.id);
    await setUsed(user, PLANS.pro.monthlyImages);
    const request = { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify(card('Pro at the limit')) };
    expect((await errorOf(await call('/v1/images', request))).message.endsWith(`to render new ones now, buy a top-up at ${ORIGIN}/pricing.`)).toBe(true);
    const closed = (await errorOf(await call('/v1/images', request, CHECKOUT_CLOSED))).message;
    expect(closed.endsWith('Images that are already cached keep working.')).toBe(true);
    expect(closed).not.toContain('top-up');
  });

  it('a PDF on Free is paid from the top-up as one block and keeps the Free footer line; its 402 names the top-up only while one is on sale', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    await setUsed(user, PLANS.free.monthlyImages);
    const browser = mockBrowser();
    const request = { html: '<p>{{title}}</p>', data: { title: 'A PDF on Free' } };

    // Nothing left: the message says where a block can come from, and offers what can be bought here.
    const refused = await postPdf(key.secret, request, pdfEnv(browser));
    expect(refused.status).toBe(402);
    const open = (await errorOf(refused)).message;
    expect(open).toContain(`A PDF counts as at least ${PDF.baseUnits} images and is charged as one block, from the monthly allowance or from a single top-up; not enough is left (0 of the 100 images on the Free plan this period).`);
    expect(open.endsWith(`Stored PDFs and images keep working; to render new ones now, upgrade or buy a top-up at ${ORIGIN}/pricing.`)).toBe(true);
    const closed = (await errorOf(await postPdf(key.secret, request, pdfEnv(browser, { CHECKOUT_ENABLED: 'false' })))).message;
    expect(closed.endsWith(`Stored PDFs and images keep working; to render new ones now, upgrade at ${ORIGIN}/pricing.`)).toBe(true);
    expect(browser.calls).toHaveLength(0);

    await buyTopUp(user.id);
    const made = await postPdf(key.secret, request, pdfEnv(browser));
    expect(made.status).toBe(200);
    // One block from the top-up; the monthly counter does not move and the plan is still Free.
    expect(await usageOf(user.id)).toMatchObject({ plan: 'free', used: PLANS.free.monthlyImages, remaining: 0, topup_remaining: TOPUP.images - PDF.baseUnits, watermark: true });
    expect(browser.calls).toHaveLength(1);
    expect(footerOf(browser.calls[0]!.options)).toContain(PDF.freeMark);
  });

  it('the quota emails of a Free account offer the top-up and say that the Free mark stays', async () => {
    const sent = mockResend();
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);

    await setUsed(user, PLANS.free.monthlyImages * 0.9 - 1);
    expect((await postImage(key.secret, card('Crossing 90%'))).status).toBe(200);
    await setUsed(user, PLANS.free.monthlyImages - 1);
    expect((await postImage(key.secret, card('Crossing 100%'))).status).toBe(200);

    expect(sent.map((email) => email.to)).toEqual([user.email, user.email]);
    const [at90, at100] = sent;
    expect(at90!.subject).toBe('You have used 90% of your Link To Card images for this period');
    expect(at90!.text).toContain('Without a top-up balance, new images stop rendering until the allowance resets or you upgrade to a paid plan. Your top-up balance is 0 images.');
    expect(at100!.subject).toBe('You have used all 100 images of your Link To Card Free plan');
    expect(at100!.text).toContain('You have no top-up balance, so new images will not render until the allowance resets or you upgrade to a paid plan.');
    for (const email of sent) {
      expect(email.text).toContain(TOP_UP_OFFER);
      expect(email.text).toContain('A top-up is a one-time purchase that you make yourself. We never charge for extra usage automatically.');
      expect(email.text).toContain(STAYS_FREE);
    }
  });

  it('while checkout is closed the quota emails of a Free account offer no top-up: they read as before', async () => {
    const sent = mockResend();
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    const post = (title: string): Promise<Response> =>
      call('/v1/images', { method: 'POST', headers: { ...bearer(key.secret), 'content-type': 'application/json' }, body: JSON.stringify(card(title)) }, CHECKOUT_CLOSED);

    await setUsed(user, PLANS.free.monthlyImages * 0.9 - 1);
    expect((await post('Crossing 90%, closed')).status).toBe(200);
    await setUsed(user, PLANS.free.monthlyImages - 1);
    expect((await post('Crossing 100%, closed')).status).toBe(200);

    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain('When the allowance is used up, new images stop rendering until it resets or you upgrade to a paid plan.');
    expect(sent[1]!.text).toContain('New images will not render until the allowance resets or you upgrade to a paid plan.');
    for (const email of sent) expect(email.text.toLowerCase()).not.toContain('top-up');
  });

  it('a fully refunded top-up stops paying: the Free account is back at its hard stop', async () => {
    const user = await createUser('free');
    const key = await apiKeyFor(user.id);
    await setUsed(user, PLANS.free.monthlyImages);
    const { transactionId } = await buyTopUp(user.id);
    expect((await postImage(key.secret, card('Before the refund'))).status).toBe(200);

    const refund = structuredClone(adjustmentUpdated) as PaddleFixture;
    refund.event_id = nextId('evt');
    refund.occurred_at = new Date().toISOString();
    Object.assign(refund.data, { id: nextId('adj'), action: 'refund', type: 'full', status: 'approved', transaction_id: transactionId, subscription_id: null });
    const raw = JSON.stringify(refund);
    expect(await (await postWebhook(raw, await paddleSignature(raw))).json()).toEqual({ ok: true, result: 'ok' });

    expect(await usageOf(user.id)).toMatchObject({ plan: 'free', topup_remaining: 0, total_remaining: 0 });
    expect((await postImage(key.secret, card('After the refund'))).status).toBe(402);
    // The image made before the refund is still served from the cache.
    expect(((await (await postImage(key.secret, card('Before the refund'))).json()) as ImageJson).cached).toBe(true);
  });
});
