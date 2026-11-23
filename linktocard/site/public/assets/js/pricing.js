// Pricing page (and the pricing cards on the home page): Starter / Pro / top-up
// buttons open Paddle's overlay checkout. While the deployment has no Paddle
// configuration (live payments not approved yet), they say "Coming soon" instead.
import { errorMessage } from './api.js';
import { checkoutAction, openCheckout, readyPaddle } from './checkout.js';

export { checkoutAction };

const ITEMS = ['starter', 'pro', 'topup'];
export const COMING_SOON = 'Coming soon';

/** Turns every checkout button inside `root` into a disabled "Coming soon"; returns how many. */
export function markComingSoon(root) {
  const buttons = [...root.querySelectorAll('[data-checkout]')];
  for (const button of buttons) {
    button.textContent = COMING_SOON;
    button.removeAttribute('href');
    button.removeAttribute('data-checkout');
    button.setAttribute('aria-disabled', 'true');
  }
  return buttons.length;
}

async function getJson(url) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}

function init() {
  const notice = document.querySelector('#checkout-notice');

  const show = (message) => {
    if (!notice) return;
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
      await openCheckout(action);
    } catch (failure) {
      show(failure.message || 'Checkout could not be started.');
    }
  }

  // /pricing?_ptxn=txn_...: this page is Paddle's "default payment link". The
  // links in Paddle's own emails (pay an invoice, update the card after a failed
  // renewal) lead here, and Paddle.js opens the checkout for that transaction
  // once it is initialized on the page. No sign-in: the transaction already
  // belongs to a customer, who may be reading the email on another device.
  async function resumeTransaction() {
    try {
      const paddle = (await getJson('/api/config'))?.paddle;
      if (!paddle?.client_token) return show('Checkout is not configured yet.');
      await readyPaddle({ environment: paddle.environment, token: paddle.client_token });
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
  const query = new URLSearchParams(location.search);
  const requested = query.get('checkout');
  getJson('/api/config')
    .then((config) => {
      if (config && !config.paddle) {
        markComingSoon(document);
        const soon = document.querySelector('#coming-soon');
        if (soon) soon.hidden = false;
        return;
      }
      if (query.has('_ptxn')) resumeTransaction();
      else if (ITEMS.includes(requested)) start(requested);
    })
    .catch(() => {
      if (ITEMS.includes(requested)) start(requested);
    });
}

if (typeof document !== 'undefined') init();
