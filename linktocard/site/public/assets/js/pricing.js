// Pricing page: Starter / Pro / top-up buttons open Paddle's overlay checkout.
// Paddle.js is the only third-party script on the site and is loaded only when
// a signed-in visitor actually starts a checkout.
import { errorMessage } from './api.js';

const ITEMS = ['starter', 'pro', 'topup'];
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

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

function init() {
  const notice = document.querySelector('#checkout-notice');
  let initialized = false;

  const show = (message) => {
    notice.textContent = message;
    notice.hidden = false;
    notice.scrollIntoView({ block: 'nearest' });
  };

  async function start(item) {
    notice.hidden = true;
    try {
      const [me, config] = await Promise.all([getJson('/api/me'), getJson('/api/config')]);
      const action = checkoutAction({ item, user: me?.user ?? null, config, origin: location.origin });
      if (action.type === 'redirect') return location.assign(action.url);
      if (action.type === 'message') return show(action.message);
      const Paddle = await loadPaddle();
      if (!initialized) {
        if (action.environment === 'sandbox') Paddle.Environment.set('sandbox');
        Paddle.Initialize({ token: action.token });
        initialized = true;
      }
      Paddle.Checkout.open(action.options);
    } catch (failure) {
      show(failure.message || 'Checkout could not be started.');
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-checkout]');
    if (!button) return;
    event.preventDefault();
    start(button.dataset.checkout);
  });

  // /pricing?checkout=starter: where sign-in sends a visitor back to.
  const requested = new URLSearchParams(location.search).get('checkout');
  if (ITEMS.includes(requested)) start(requested);
}

if (typeof document !== 'undefined') init();
