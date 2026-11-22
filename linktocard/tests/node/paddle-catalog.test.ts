// scripts/seed-paddle-sandbox.md is typed into the Paddle dashboard by hand, so
// it must state exactly what src/billing/plans.ts charges and list exactly the
// webhook events src/billing/paddle.ts acts on. This test fails when they drift.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CURRENCY, PLANS, TOPUP, formatCount } from '../../src/billing/plans';

const doc = readFileSync(fileURLToPath(new URL('../../scripts/seed-paddle-sandbox.md', import.meta.url)), 'utf8');

// Loaded through a computed path on purpose: a static import would pull Worker
// source (D1 types) into the Node tsconfig.
const paddlePath = fileURLToPath(new URL('../../src/billing/paddle.ts', import.meta.url));
const { HANDLED_EVENT_TYPES } = (await import(paddlePath)) as { HANDLED_EVENT_TYPES: readonly string[] };

const amount = (usd: number): string => `${usd.toFixed(2)} ${CURRENCY}`;

describe('scripts/seed-paddle-sandbox.md', () => {
  it.each([PLANS.starter, PLANS.pro])('lists $paddleProductName as a monthly price with its amount', (plan) => {
    expect(plan.paddleProductName).not.toBeNull();
    expect(doc).toContain(`| \`${plan.paddleProductName}\` | SaaS | Recurring | Monthly | ${amount(plan.priceUsd)} | added on top |`);
    expect(doc).toContain(`${formatCount(plan.monthlyImages)} images`);
    expect(doc).toContain(String(plan.paddlePriceEnv));
  });

  it('lists the top-up as a one-time price with its amount, image count and validity', () => {
    expect(doc).toContain(`| \`${TOPUP.paddleProductName}\` | SaaS | One-time | none | ${amount(TOPUP.priceUsd)} | added on top |`);
    expect(doc).toContain(`each unit credits ${formatCount(TOPUP.images)} images`);
    expect(doc).toContain(`${TOPUP.validDays} days`);
    expect(doc).toContain(TOPUP.paddlePriceEnv);
  });

  it('has no catalog rows beyond the three products', () => {
    const rows = doc.split('\n').filter((line) => line.startsWith('| `'));
    expect(rows).toHaveLength(3);
  });

  it('tells Ahmad to subscribe the destination to exactly the events the code handles', () => {
    const section = doc.slice(doc.indexOf('<!-- events:start -->'), doc.indexOf('<!-- events:end -->'));
    const listed = [...section.matchAll(/^- `([a-z_.]+)`$/gm)].map((match) => match[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...HANDLED_EVENT_TYPES].sort());
    expect(doc).toContain('{APP_URL}/webhooks/paddle');
  });

  it('names both secrets and how to store them, and contains no secret itself', () => {
    for (const environment of ['staging', 'production']) {
      expect(doc).toContain(`npx wrangler secret put PADDLE_API_KEY --env ${environment}`);
      expect(doc).toContain(`npx wrangler secret put PADDLE_WEBHOOK_SECRET --env ${environment}`);
    }
    // Shapes of real Paddle credentials: API key, webhook secret, client-side token.
    expect(doc).not.toMatch(/pdl_(live|sdbx)_apikey_[a-z0-9]{10,}/i);
    expect(doc).not.toMatch(/pdl_ntfset_[a-z0-9]{10,}/i);
    expect(doc).not.toMatch(/\b(test|live)_[0-9a-f]{20,}\b/);
    expect(doc).not.toMatch(/\bpri_[a-z0-9]{20,}\b/);
  });
});
