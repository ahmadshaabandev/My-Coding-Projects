// Paddle overlay checkout, shared by the pricing page and the dashboard.
// Paddle.js is loaded only when
// a signed-in visitor actually starts a checkout.

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/**
 * Decides what a click on a checkout button does. Pure, so the rules are testable:
 *   signed out                      -> sign in first, then come back and open the checkout
 *   already on a paid plan          -> change plan in the dashboard (never a second subscription)
 *   top-up on a plan without them   -> explain (plans.ts decides; today every plan can buy one)
 *   Paddle not configured           -> explain
 *   otherwise                       -> open the overlay checkout
 */
export function checkoutAction({ item, user, config, origin }) {
  if (!user) return { type: 'redirect', url: `/login?next=/pricing${encodeURIComponent(`?checkout=${item}`)}` };
  const paid = Boolean(user.plan) && user.plan !== 'free';
  if (item !== 'topup' && paid) return { type: 'redirect', url: '/dashboard#billing' };
  if (item === 'topup' && !canBuyTopUp(config, user.plan)) return { type: 'message', message: topUpPlansMessage(config) };
  const paddle = config?.paddle;
  const priceId = paddle?.prices?.[item];
  if (!paddle?.client_token || !priceId) return { type: 'message', message: 'Checkout is not configured yet.' };
  return {
    type: 'checkout',
    environment: paddle.environment,
    token: paddle.client_token,
    options: {
      items: [{ priceId, quantity: 1 }],
      customer: { email: user.email },
      customData: { user_id: user.id },
      settings: { displayMode: 'overlay', successUrl: `${origin}/dashboard?checkout=success` },
    },
  };
}

/**
 * Whether an account on this plan can buy a top-up: `top_ups` of its plan in /api/config, which
 * reads src/billing/plans.ts. An account without a plan name counts as Free. A plan the config
 * does not list cannot.
 */
export function canBuyTopUp(config, planId) {
  const id = planId || 'free';
  return (config?.plans ?? []).some((plan) => plan.id === id && plan.top_ups === true);
}

/** Says which plans can buy a top-up, by the names in /api/config. */
function topUpPlansMessage(config) {
  const names = (config?.plans ?? []).filter((plan) => plan.top_ups).map((plan) => plan.name);
  if (names.length === 0) return 'Top-ups are not available.';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Top-ups are available on the ${list} plan${names.length === 1 ? '' : 's'}.`;
}

/* ------------------------------------------------------------------ */
/* What a checkout was for, kept for the page Paddle sends the customer back to */
/* ------------------------------------------------------------------ */

const CHECKOUT_MEMO = 'ltc:checkout';

/** What to remember before a checkout opens, so the return page knows what "done" looks like. */
export function checkoutSnapshot(item, me) {
  return { item, plan: me.user.plan, topup_remaining: me.usage.topup_remaining };
}

/**
 * Stores the snapshot for /dashboard?checkout=success. The pricing page and the dashboard both
 * call it: without it the return page would wait for a plan change after a top-up, which never
 * comes for an account that stays on its plan. `storage` is for tests; the browser's
 * sessionStorage is read inside the try, because touching it can throw where storage is blocked.
 */
export function rememberCheckout(snapshot, storage) {
  try {
    (storage ?? sessionStorage).setItem(CHECKOUT_MEMO, JSON.stringify(snapshot));
  } catch {
    // Without storage the return page falls back to its default (dashboard/billing.js).
  }
}

/** The stored snapshot, read once, or null when there is none. */
export function recallCheckout(storage) {
  try {
    const store = storage ?? sessionStorage;
    const snapshot = JSON.parse(store.getItem(CHECKOUT_MEMO) ?? 'null');
    store.removeItem(CHECKOUT_MEMO);
    if (snapshot && typeof snapshot === 'object') return snapshot;
  } catch {
    // Fall through.
  }
  return null;
}

function loadPaddle() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PADDLE_JS;
    script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new Error('Paddle.js did not load.')));
    script.onerror = () => reject(new Error('Paddle.js could not be loaded. Check your connection or content blocker.'));
    document.head.append(script);
  });
}

let initialized = false;

/**
 * Loads Paddle.js and initializes it once (live is Paddle.js's default; only the
 * sandbox is switched on explicitly). Rejects when Paddle.js cannot be loaded.
 *
 * No pwCustomer: Paddle Retain is not used. On live accounts Paddle.js still tries
 * to load Retain's script (public.profitwell.com); the site's Content-Security-Policy
 * blocks it, so nothing about visitors is sent there.
 */
export async function readyPaddle({ environment, token }) {
  const Paddle = await loadPaddle();
  if (!initialized) {
    if (environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({ token });
    initialized = true;
  }
  return Paddle;
}

/** Opens the overlay for a `checkout` action from checkoutAction(). Rejects when Paddle.js cannot be loaded. */
export async function openCheckout(action) {
  const Paddle = await readyPaddle(action);
  Paddle.Checkout.open(action.options);
}
