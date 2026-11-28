/**
 * Transactional email through Resend's REST API, called with fetch (no SDK).
 *
 * Request shape checked against the resend npm package (6.39.0) source:
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <key>, Content-Type: application/json, optional Idempotency-Key
 *   { from, to, subject, html, text, reply_to }  ->  200 { id }
 *   failure -> non-2xx with { statusCode, name, message }
 *
 * Every message here is plain and transactional: no marketing, no tracking
 * pixels, no remote images.
 */
import { PLANS, TOPUP, formatCount, formatUsd, type Plan } from '../billing/plans';
import type { Env, UsageSummary } from '../types';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** A hung mail API must not hang the sign-in request that triggered the send. */
const SEND_TIMEOUT_MS = 10_000;
const PRODUCT = 'Link To Card';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailMessage extends EmailContent {
  to: string;
  replyTo?: string;
  /** Resend de-duplicates sends that carry the same key (safe retries). */
  idempotencyKey?: string;
}

export type SendEmailResult = { ok: true; id: string | null } | { ok: false; error: string };

/** Local development and the test suite: the only places a sign-in link may be shown instead of mailed. */
export function isLocalEnvironment(env: Pick<Env, 'ENVIRONMENT'>): boolean {
  return env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Never throws: callers decide whether a failed send matters. */
export async function sendEmail(env: Env, message: EmailMessage): Promise<SendEmailResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`Email not sent, RESEND_API_KEY is not set: "${message.subject}"`);
    // So a developer can copy the sign-in link from the terminal.
    if (isLocalEnvironment(env)) console.log(message.text);
    return { ok: false, error: 'not_configured' };
  }
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Workers send no User-Agent by default; the official SDK always sends one.
        'User-Agent': 'linktocard-worker',
        ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const name = isRecord(body) && typeof body.name === 'string' ? body.name : `http_${response.status}`;
      const detail = isRecord(body) && typeof body.message === 'string' ? body.message : '';
      console.error(`Email send failed (${response.status} ${name}): ${detail}`);
      return { ok: false, error: name };
    }
    return { ok: true, id: isRecord(body) && typeof body.id === 'string' ? body.id : null };
  } catch (error) {
    console.error('Email send failed (network):', error);
    return { ok: false, error: 'network_error' };
  }
}

/* ------------------------------------------------------------------ */
/* Layout: one content model rendered to both HTML and plain text, so  */
/* the two versions of a message cannot drift apart.                   */
/* ------------------------------------------------------------------ */

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'link'; label: string; url: string }
  | { kind: 'quote'; text: string }
  | { kind: 'note'; text: string };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p style="margin:0 0 16px">${escapeHtml(block.text)}</p>`;
    case 'link':
      return (
        `<p style="margin:0 0 8px"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(block.label)}</a></p>` +
        `<p style="margin:0 0 16px;font-size:13px;color:#6b7280;word-break:break-all">${escapeHtml(block.url)}</p>`
      );
    case 'quote':
      return `<p style="margin:0 0 16px;padding:12px 14px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap">${escapeHtml(block.text)}</p>`;
    case 'note':
      return `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${escapeHtml(block.text)}</p>`;
  }
}

function blockText(block: Block): string {
  return block.kind === 'link' ? `${block.label}:\n${block.url}` : block.text;
}

function renderHtml(heading: string, blocks: Block[]): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"></head>' +
    '<body style="margin:0;padding:24px;background:#ffffff;color:#111827;font-family:-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5">' +
    '<div style="max-width:520px;margin:0 auto">' +
    `<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>` +
    blocks.map(blockHtml).join('') +
    '</div></body></html>'
  );
}

function renderText(heading: string, blocks: Block[]): string {
  return [heading, ...blocks.map(blockText)].join('\n\n') + '\n';
}

function compose(subject: string, heading: string, blocks: Block[]): EmailContent {
  // A subject is a header: keep user-supplied text from breaking it across lines.
  return { subject: subject.replace(/[\r\n]+/g, ' '), html: renderHtml(heading, blocks), text: renderText(heading, blocks) };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

export function magicLinkEmail(input: { link: string; ttlMinutes: number }): EmailContent {
  return compose(`Your ${PRODUCT} sign-in link`, `Sign in to ${PRODUCT}`, [
    { kind: 'paragraph', text: 'Use the link below to sign in. If you do not have an account yet, signing in creates one.' },
    { kind: 'link', label: 'Sign in', url: input.link },
    {
      kind: 'note',
      text: `The link works once and expires in ${input.ttlMinutes} minutes. If you did not ask for it, ignore this email: nothing happens unless the link is opened.`,
    },
  ]);
}

function utcDate(epochMs: number): string {
  const date = new Date(epochMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `${date} (UTC)`;
}

/**
 * Top-ups are bought by hand; the copy must never read as if extra usage were billed automatically.
 * On a plan whose images carry the mark it also says that a top-up does not take the mark away,
 * so nobody buys one expecting that.
 */
function topUpOffer(plan: Plan): string {
  const offer =
    `You can buy a top-up of ${formatCount(TOPUP.images)} images for ${formatUsd(TOPUP.priceUsd)} (plus tax where it applies) in the dashboard. ` +
    'A top-up is a one-time purchase that you make yourself. We never charge for extra usage automatically.';
  if (!plan.watermark) return offer;
  return `${offer} A top-up adds images only. You stay on the ${plan.name} plan, so what you make still carries the small ${PRODUCT} mark.`;
}

function images(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'image' : 'images'}`;
}

/**
 * `topUpOnSale`: this plan can buy a top-up and checkout is open on this deployment
 * (src/billing/offers.ts). Without it the email offers none. A balance the account already
 * holds is always explained, on any plan.
 */
function quotaBlocks(percent: 90 | 100, usage: UsageSummary, topUpOnSale: boolean): Block[] {
  const plan = PLANS[usage.plan];
  const reset = utcDate(usage.period_end);
  // usage.limit is this period's allowance, which a plan change inside the period can adjust.
  const allowance = `On your ${plan.name} plan, this billing period has ${images(usage.limit)}.`;
  const balance = `Your top-up balance is ${images(usage.topup_remaining)}.`;
  const hasBalance = usage.topup_remaining > 0;
  const offer: Block[] = topUpOnSale ? [{ kind: 'paragraph', text: topUpOffer(plan) }] : [];
  // A plan that costs nothing has a second way past the limit.
  const orUpgrade = plan.priceUsd === 0 ? ' or you upgrade to a paid plan' : '';

  if (percent === 90) {
    const status = `${allowance} You have used ${formatCount(usage.used)} of them. The allowance resets on ${reset}.`;
    const next =
      hasBalance || topUpOnSale
        ? `When the allowance is used up, new images are taken from your top-up balance. Without a top-up balance, new images stop rendering until the allowance resets${orUpgrade}. ${balance}`
        : `When the allowance is used up, new images stop rendering until it resets${orUpgrade}.`;
    return [{ kind: 'paragraph', text: status }, { kind: 'paragraph', text: next }, ...offer];
  }

  const status = `${allowance} All of them are used. The allowance resets on ${reset}.`;
  const consequence = hasBalance
    ? `New images are now taken from your top-up balance. ${balance} When it runs out, new images stop rendering until the allowance resets${orUpgrade}.`
    : topUpOnSale
      ? `You have no top-up balance, so new images will not render until the allowance resets${orUpgrade}.`
      : `New images will not render until the allowance resets${orUpgrade}.`;
  return [{ kind: 'paragraph', text: status }, { kind: 'paragraph', text: consequence }, ...offer];
}

export function quotaWarningEmail(input: { percent: 90 | 100; usage: UsageSummary; appUrl: string; topUpOnSale: boolean }): EmailContent {
  const { percent, usage } = input;
  const plan = PLANS[usage.plan];
  const subject =
    percent === 90
      ? `You have used 90% of your ${PRODUCT} images for this period`
      : `You have used all ${images(usage.limit)} of your ${PRODUCT} ${plan.name} plan`;
  const heading = percent === 90 ? 'You are close to your image allowance' : 'Your image allowance is used up';
  return compose(subject, heading, [
    ...quotaBlocks(percent, usage, input.topUpOnSale),
    { kind: 'link', label: 'Open the dashboard', url: `${input.appUrl.replace(/\/+$/, '')}/dashboard` },
    { kind: 'note', text: `This notice is sent once per billing period, when usage reaches ${percent}%.` },
  ]);
}

export function contactFormEmail(input: { fromEmail: string; message: string }): EmailContent {
  return compose(`Contact form: ${input.fromEmail}`, 'Contact form message', [
    { kind: 'paragraph', text: `From: ${input.fromEmail}` },
    { kind: 'quote', text: input.message },
  ]);
}
