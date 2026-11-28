import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS, TOPUP, formatCount, formatUsd, type PlanId } from '../src/billing/plans';
import {
  contactFormEmail,
  isLocalEnvironment,
  magicLinkEmail,
  quotaWarningEmail,
  sendEmail,
  type EmailMessage,
} from '../src/lib/email';
import type { Env, EnvironmentName, UsageSummary } from '../src/types';

const RESEND_URL = 'https://api.resend.com/emails';

const MESSAGE: EmailMessage = {
  to: 'reader@example.com',
  subject: 'Hello',
  html: '<p>Hello</p>',
  text: 'Hello in plain text',
};

interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

/** Stands in for Resend. The Response is built inside the mock, once per call. */
function mockResend(respond: () => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== RESEND_URL) throw new Error(`unexpected outbound request: ${url}`);
    calls.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return respond();
  });
  return calls;
}

function envWith(overrides: Partial<Env>): Env {
  return { ...env, ...overrides };
}

function quiet(method: 'log' | 'warn' | 'error') {
  return vi.spyOn(console, method).mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendEmail', () => {
  it('posts the message to Resend with the API key and the documented JSON fields', async () => {
    const calls = mockResend(() => Response.json({ id: 'email_123' }));

    const result = await sendEmail(env, MESSAGE);

    expect(result).toEqual({ ok: true, id: 'email_123' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(RESEND_URL);
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('user-agent')).toBeTruthy();
    expect(call.headers.has('idempotency-key')).toBe(false);
    expect(call.body).toEqual({
      from: env.MAIL_FROM,
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello in plain text',
    });
  });

  it('sends reply_to and the Idempotency-Key header only when asked to', async () => {
    const calls = mockResend(() => Response.json({ id: 'email_124' }));

    await sendEmail(env, { ...MESSAGE, replyTo: 'visitor@example.com', idempotencyKey: 'quota-90/u_1/1764547200000' });

    expect(calls[0]!.body.reply_to).toBe('visitor@example.com');
    expect(calls[0]!.headers.get('idempotency-key')).toBe('quota-90/u_1/1764547200000');
  });

  it('reports success with a null id when Resend answers 2xx without one', async () => {
    mockResend(() => new Response('', { status: 200 }));
    expect(await sendEmail(env, MESSAGE)).toEqual({ ok: true, id: null });
  });

  it('returns the Resend error name when the API rejects the message', async () => {
    const errors = quiet('error');
    mockResend(() =>
      Response.json({ statusCode: 422, name: 'validation_error', message: 'Invalid `from` field.' }, { status: 422 }),
    );

    expect(await sendEmail(env, MESSAGE)).toEqual({ ok: false, error: 'validation_error' });
    expect(String(errors.mock.calls[0]?.[0])).toContain('Invalid `from` field.');
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    quiet('error');
    mockResend(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await sendEmail(env, MESSAGE)).toEqual({ ok: false, error: 'http_502' });
  });

  it('never throws: a network failure becomes a result', async () => {
    quiet('error');
    mockResend(() => {
      throw new TypeError('connection reset');
    });
    expect(await sendEmail(env, MESSAGE)).toEqual({ ok: false, error: 'network_error' });
  });

  it('does not call Resend without an API key, and prints the text body in development and test', async () => {
    const calls = mockResend(() => Response.json({ id: 'never' }));
    quiet('warn');
    const logs = quiet('log');

    for (const name of ['development', 'test'] satisfies EnvironmentName[]) {
      logs.mockClear();
      const result = await sendEmail(envWith({ RESEND_API_KEY: undefined, ENVIRONMENT: name }), MESSAGE);
      expect(result).toEqual({ ok: false, error: 'not_configured' });
      expect(logs.mock.calls).toEqual([['Hello in plain text']]);
    }
    expect(calls).toHaveLength(0);
  });

  it('never prints the body in staging or production', async () => {
    const calls = mockResend(() => Response.json({ id: 'never' }));
    const warnings = quiet('warn');
    const logs = quiet('log');

    for (const name of ['staging', 'production'] satisfies EnvironmentName[]) {
      const result = await sendEmail(envWith({ RESEND_API_KEY: '', ENVIRONMENT: name }), MESSAGE);
      expect(result).toEqual({ ok: false, error: 'not_configured' });
    }
    expect(logs).not.toHaveBeenCalled();
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('Hello in plain text');
    expect(calls).toHaveLength(0);
  });
});

describe('isLocalEnvironment', () => {
  it('is true only for development and test', () => {
    expect(isLocalEnvironment({ ENVIRONMENT: 'development' })).toBe(true);
    expect(isLocalEnvironment({ ENVIRONMENT: 'test' })).toBe(true);
    expect(isLocalEnvironment({ ENVIRONMENT: 'staging' })).toBe(false);
    expect(isLocalEnvironment({ ENVIRONMENT: 'production' })).toBe(false);
  });
});

/** Every href in an HTML body. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
}

function expectPlain(html: string): void {
  expect(html).not.toMatch(/<img|<script|<link|<iframe|url\(/i);
}

describe('magicLinkEmail', () => {
  const link = 'https://linktocard.test/login/verify?token=abc_DEF-123&next=%2Fdashboard';
  const email = magicLinkEmail({ link, ttlMinutes: 15 });

  it('carries the link, copyable, in the text body', () => {
    expect(email.subject).toBe('Your Link To Card sign-in link');
    expect(email.text.split('\n')).toContain(link);
    expect(email.text).toContain('expires in 15 minutes');
    expect(email.text).toContain('works once');
  });

  it('links only to the sign-in page, HTML-escaped, with no images or trackers', () => {
    expect(hrefs(email.html)).toEqual([link.replace('&', '&amp;')]);
    expect(email.html).toContain('expires in 15 minutes');
    expectPlain(email.html);
  });
});

describe('quotaWarningEmail', () => {
  const APP_URL = 'https://linktocard.test';
  const PERIOD_END = Date.UTC(2026, 11, 1);

  function usage(plan: PlanId, used: number, topupRemaining = 0): UsageSummary {
    const limit = PLANS[plan].monthlyImages;
    const remaining = Math.max(0, limit - used);
    return {
      plan,
      period_start: Date.UTC(2026, 10, 1),
      period_end: PERIOD_END,
      limit,
      used,
      remaining,
      topup_remaining: topupRemaining,
      total_remaining: remaining + topupRemaining,
      cache_days: PLANS[plan].cacheDays,
      watermark: PLANS[plan].watermark,
    };
  }

  const topUpPrice = `${formatCount(TOPUP.images)} images for ${formatUsd(TOPUP.priceUsd)}`;
  const NO_AUTO_BILLING = 'We never charge for extra usage automatically.';
  const STAYS_FREE = 'A top-up adds images only. You stay on the Free plan, so what you make still carries the small Link To Card mark.';

  // The emails as they were before 2026-11-28, word for word: what a Free account gets while this
  // deployment's checkout is closed (topUpOnSale false), so nothing is offered that cannot be bought.
  it('90% on Free while top-ups are not on sale: the stop is lifted by a reset or an upgrade, no top-up is named', () => {
    const email = quotaWarningEmail({ percent: 90, usage: usage('free', 90), appUrl: APP_URL, topUpOnSale: false });
    expect(email.subject).toBe('You have used 90% of your Link To Card images for this period');
    expect(email.text).toContain('On your Free plan, this billing period has 100 images. You have used 90 of them.');
    expect(email.text).toContain('resets on 1 December 2026 (UTC)');
    expect(email.text).toContain('When the allowance is used up, new images stop rendering until it resets or you upgrade to a paid plan.');
    expect(email.text.toLowerCase()).not.toContain('top-up');
  });

  it('100% on Free while top-ups are not on sale: a stop until the reset or an upgrade, no top-up is named', () => {
    const email = quotaWarningEmail({ percent: 100, usage: usage('free', 100), appUrl: APP_URL, topUpOnSale: false });
    expect(email.subject).toBe('You have used all 100 images of your Link To Card Free plan');
    expect(email.text).toContain('New images will not render until the allowance resets or you upgrade to a paid plan.');
    expect(email.text).toContain('1 December 2026 (UTC)');
    expect(email.text.toLowerCase()).not.toContain('top-up');
  });

  // Owner decision of 2026-11-28: a Free account can buy the top-up too.
  it('90% on Free: offers the manual top-up, keeps the upgrade, and says the Free mark stays', () => {
    const email = quotaWarningEmail({ percent: 90, usage: usage('free', 90), appUrl: APP_URL, topUpOnSale: true });
    expect(email.text).toContain('On your Free plan, this billing period has 100 images. You have used 90 of them.');
    expect(email.text).toContain(
      'When the allowance is used up, new images are taken from your top-up balance. Without a top-up balance, new images stop rendering until the allowance resets or you upgrade to a paid plan. Your top-up balance is 0 images.',
    );
    expect(email.text).toContain(`You can buy a top-up of ${topUpPrice} (plus tax where it applies) in the dashboard.`);
    expect(email.text).toContain('one-time purchase that you make yourself');
    expect(email.text).toContain(NO_AUTO_BILLING);
    expect(email.text).toContain(STAYS_FREE);
  });

  it('100% on Free without a balance: a stop, the manual top-up or an upgrade, and the Free mark stays', () => {
    const email = quotaWarningEmail({ percent: 100, usage: usage('free', 100), appUrl: APP_URL, topUpOnSale: true });
    expect(email.subject).toBe('You have used all 100 images of your Link To Card Free plan');
    expect(email.text).toContain('You have no top-up balance, so new images will not render until the allowance resets or you upgrade to a paid plan.');
    expect(email.text).toContain(topUpPrice);
    expect(email.text).toContain(NO_AUTO_BILLING);
    expect(email.text).toContain(STAYS_FREE);
  });

  it('100% on Free with a top-up balance: rendering continues from the balance, on the Free plan', () => {
    const email = quotaWarningEmail({ percent: 100, usage: usage('free', 100, 640), appUrl: APP_URL, topUpOnSale: true });
    expect(email.text).toContain('New images are now taken from your top-up balance. Your top-up balance is 640 images.');
    expect(email.text).toContain('When it runs out, new images stop rendering until the allowance resets or you upgrade to a paid plan.');
    expect(email.text).toContain(STAYS_FREE);
    // A balance is explained even where no further top-up can be bought.
    const closed = quotaWarningEmail({ percent: 100, usage: usage('free', 100, 640), appUrl: APP_URL, topUpOnSale: false });
    expect(closed.text).toContain('New images are now taken from your top-up balance. Your top-up balance is 640 images.');
    expect(closed.text).not.toContain('You can buy a top-up');
  });

  it('90% on a paid plan: explains the top-up balance and the manual top-up', () => {
    const email = quotaWarningEmail({ percent: 90, usage: usage('starter', 1800, 250), appUrl: APP_URL, topUpOnSale: true });
    expect(email.text).toContain('On your Starter plan, this billing period has 2,000 images. You have used 1,800 of them.');
    expect(email.text).toContain(
      'When the allowance is used up, new images are taken from your top-up balance. Without a top-up balance, new images stop rendering until the allowance resets. Your top-up balance is 250 images.',
    );
    expect(email.text).toContain(topUpPrice);
    expect(email.text).toContain(NO_AUTO_BILLING);
    // Paid plans carry no mark, so there is nothing to say about it.
    expect(email.text).not.toContain('mark');
  });

  it('100% on a paid plan with a top-up balance: rendering continues from the balance', () => {
    const email = quotaWarningEmail({ percent: 100, usage: usage('pro', 10_000, 1), appUrl: APP_URL, topUpOnSale: true });
    expect(email.subject).toBe('You have used all 10,000 images of your Link To Card Pro plan');
    expect(email.text).toContain('New images are now taken from your top-up balance. Your top-up balance is 1 image.');
    expect(email.text).toContain('When it runs out, new images stop rendering until the allowance resets.');
    expect(email.text).toContain(NO_AUTO_BILLING);
  });

  it('100% on a paid plan without a balance: a stop, plus the manual top-up and never automatic billing', () => {
    const email = quotaWarningEmail({ percent: 100, usage: usage('starter', 2000), appUrl: APP_URL, topUpOnSale: true });
    expect(email.text).toContain('You have no top-up balance, so new images will not render until the allowance resets.');
    expect(email.text).toContain(topUpPrice);
    expect(email.text).toContain('one-time purchase that you make yourself');
    expect(email.text).toContain(NO_AUTO_BILLING);
    expect(email.text).not.toContain('mark');
  });

  it('a paid plan while top-ups are not on sale: no offer, and no sentence left half empty', () => {
    const at90 = quotaWarningEmail({ percent: 90, usage: usage('pro', 9000), appUrl: APP_URL, topUpOnSale: false });
    expect(at90.text).toContain('When the allowance is used up, new images stop rendering until it resets.');
    const at100 = quotaWarningEmail({ percent: 100, usage: usage('pro', 10_000), appUrl: APP_URL, topUpOnSale: false });
    expect(at100.text).toContain('New images will not render until the allowance resets.');
    for (const email of [at90, at100]) expect(email.text.toLowerCase()).not.toContain('top-up');
  });

  it('links only to the dashboard and keeps HTML and text in step', () => {
    for (const percent of [90, 100] as const) {
      for (const plan of ['free', 'starter', 'pro'] as const) {
        for (const topUpOnSale of [true, false]) {
          const email = quotaWarningEmail({ percent, usage: usage(plan, PLANS[plan].monthlyImages), appUrl: `${APP_URL}/`, topUpOnSale });
          expect(hrefs(email.html)).toEqual([`${APP_URL}/dashboard`]);
          expect(email.text).toContain(`${APP_URL}/dashboard`);
          expect(email.html).toContain('1 December 2026 (UTC)');
          expect(email.subject).not.toMatch(/[\r\n]/);
          expect(email.text).not.toMatch(/ {2}|\.\./);
          expectPlain(email.html);
        }
      }
    }
  });
});

describe('contactFormEmail', () => {
  it('escapes the visitor message in HTML and keeps it verbatim in text', () => {
    const message = 'Hi <script>alert("x")</script>\nSecond line & more';
    const email = contactFormEmail({ fromEmail: 'visitor@example.com', message });

    expect(email.subject).toBe('Contact form: visitor@example.com');
    expect(email.text).toContain('From: visitor@example.com');
    expect(email.text).toContain(message);
    expect(email.html).toContain('Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\nSecond line &amp; more');
    expect(email.html).not.toContain('<script>');
    expect(hrefs(email.html)).toEqual([]);
  });

  it('keeps the subject on one line whatever the sender field contains', () => {
    const email = contactFormEmail({ fromEmail: 'a@example.com\r\nBcc: victim@example.com', message: 'x' });
    expect(email.subject).toBe('Contact form: a@example.com Bcc: victim@example.com');
  });
});
