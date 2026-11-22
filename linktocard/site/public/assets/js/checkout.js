// Paddle overlay checkout, shared by the pricing page and the dashboard.
// Paddle.js is the only third-party script on the site and is loaded only when
// a signed-in visitor actually starts a checkout.

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/**
 * Decides what a click on a checkout button does. Pure, so the rules are testable:
 *   signed out                      -> sign in first, then come back and open the checkout
 *   already on a paid plan          -> change plan in the dashboard (never a second subscription)
 *   top-up without a paid plan      -> explain
 *   Paddle not configured           -> explain
 *   otherwise                       -> open the overlay checkout
 */
export function checkoutAction({ item, user, config, origin }) {
  if (!user) return { type: 'redirect', url: `/login?next=/pricing${encodeURIComponent(`?checkout=${item}`)}` };
  const paid = Boolean(user.plan) && user.plan !== 'free';
  if (item !== 'topup' && paid) return { type: 'redirect', url: '/dashboard#billing' };
  if (item === 'topup' && !paid) return { type: 'message', message: 'Top-ups are available on the Starter and Pro plans.' };
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

/** Opens the overlay for a `checkout` action from checkoutAction(). Rejects when Paddle.js cannot be loaded. */
export async function openCheckout(action) {
  const Paddle = await loadPaddle();
  if (!initialized) {
    if (action.environment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({ token: action.token });
    initialized = true;
  }
  Paddle.Checkout.open(action.options);
}
