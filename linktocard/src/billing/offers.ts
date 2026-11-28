/**
 * What an account is told it can buy when its images run out: the tail of every
 * 402 quota_exceeded message and the offer in the quota emails.
 *
 * Two facts decide it. The plan: every plan below the highest can upgrade, and a
 * plan with `topUps` (src/billing/plans.ts) can buy the manual top-up. The
 * deployment: a top-up is offered only while checkout is open here
 * (CHECKOUT_ENABLED and the Paddle values, paddleClientConfig), so a message
 * never sends anyone to buy what is not on sale yet. While checkout is closed
 * the messages read exactly as they did before top-ups were opened to the Free
 * plan (owner decision of 2026-11-28).
 */
import type { Env } from '../types';
import { paddleClientConfig } from './paddle';
import { PLAN_ORDER, type Plan } from './plans';

/** True while this deployment sells: checkout is switched on and Paddle is configured. */
export function checkoutOpen(env: Env): boolean {
  return paddleClientConfig(env) !== null;
}

/** True when an account on this plan can buy a top-up here, now. */
export function topUpOnSale(env: Env, plan: Pick<Plan, 'topUps'>): boolean {
  return plan.topUps && checkoutOpen(env);
}

/**
 * "upgrade at <pricing>", "buy a top-up at <pricing>", both joined by "or", or null when
 * there is nothing to offer (the highest plan while checkout is closed).
 */
export function quotaRemedy(env: Env, plan: Pick<Plan, 'id' | 'topUps'>): string | null {
  const canUpgrade = PLAN_ORDER.indexOf(plan.id) < PLAN_ORDER.length - 1;
  const parts = [canUpgrade ? 'upgrade' : null, topUpOnSale(env, plan) ? 'buy a top-up' : null].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return `${parts.join(' or ')} at ${env.APP_URL.replace(/\/+$/, '')}/pricing`;
}
