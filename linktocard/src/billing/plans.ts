/**
 * Single source of truth for plans, quotas, prices and plan-bound limits.
 *
 * Everything that states a number about a plan reads it from here: the quota
 * enforcer, the pricing page and docs (via scripts/build-site.ts), the Paddle
 * catalog instructions (scripts/seed-paddle-sandbox.md is checked against this
 * file by tests/plans.test.ts) and the tests. Change a number here and nowhere
 * else, then update the Paddle catalog to match.
 */

export type PlanId = 'free' | 'starter' | 'pro';

export interface Plan {
  id: PlanId;
  /** Short display name used on the pricing page and in the dashboard. */
  name: string;
  /**
   * Exact product name in the Paddle catalog (null for the internal Free plan,
   * which has no Paddle product). The pricing page prints this string so the
   * site and the catalog match word for word.
   */
  paddleProductName: string | null;
  /** Monthly price in whole US dollars, exclusive of tax. Paddle adds tax. */
  priceUsd: number;
  /** Images included per billing period. One image = one rendered size. */
  monthlyImages: number;
  /** How long a rendered image is kept and served without counting again. */
  cacheDays: number;
  /** Free renders carry a small corner mark drawn into the image. */
  watermark: boolean;
  /** Custom font upload allowance (0 files = not available on this plan). */
  fonts: { maxFiles: number; maxBytesPerFile: number };
  /** Support promise, printed verbatim. */
  support: string;
  /** Whether the manual 1,000-image top-up can be bought on this plan. */
  topUps: boolean;
  /** Env var that holds this plan's Paddle price id (pri_...). */
  paddlePriceEnv: 'PADDLE_PRICE_STARTER' | 'PADDLE_PRICE_PRO' | null;
}

const MB = 1024 * 1024;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    paddleProductName: null,
    priceUsd: 0,
    monthlyImages: 100,
    cacheDays: 7,
    watermark: true,
    fonts: { maxFiles: 0, maxBytesPerFile: 0 },
    support: 'Docs and best-effort email',
    topUps: false,
    paddlePriceEnv: null,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    paddleProductName: 'Link To Card Starter',
    priceUsd: 9,
    monthlyImages: 2000,
    cacheDays: 30,
    watermark: false,
    fonts: { maxFiles: 3, maxBytesPerFile: 2 * MB },
    support: 'Email support',
    topUps: true,
    paddlePriceEnv: 'PADDLE_PRICE_STARTER',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    paddleProductName: 'Link To Card Pro',
    priceUsd: 29,
    monthlyImages: 10000,
    cacheDays: 90,
    watermark: false,
    fonts: { maxFiles: 20, maxBytesPerFile: 5 * MB },
    support: 'Priority email support',
    topUps: true,
    paddlePriceEnv: 'PADDLE_PRICE_PRO',
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro'];

/**
 * Manual, one-time top-up. Never auto-billed: it is only ever bought by the
 * customer clicking "Buy top-up" and completing a Paddle checkout.
 */
export const TOPUP = {
  name: 'Top-up',
  paddleProductName: 'Link To Card Top-up (1,000 images)',
  priceUsd: 8,
  images: 1000,
  /**
   * ASSUMPTION (flagged in README): the build request says monthly quota does
   * not roll over but is silent on purchased top-ups. Top-up images are used
   * only after the monthly allowance is exhausted and stay valid for this many
   * days from purchase.
   */
  validDays: 365,
  paddlePriceEnv: 'PADDLE_PRICE_TOPUP',
} as const;

export const CURRENCY = 'USD';

export function isPlanId(value: unknown): value is PlanId {
  return value === 'free' || value === 'starter' || value === 'pro';
}

export function getPlan(id: string | null | undefined): Plan {
  return isPlanId(id) ? PLANS[id] : PLANS.free;
}

/** "$9" / "$0" - whole dollars only, which is all the catalog uses. */
export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
