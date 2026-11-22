// The customer dashboard: a small hash-routed app. Each tab is a module under
// ./dashboard/ whose mount(ctx, param, options) resolves to
// { node, focus?, isDirty?, destroy? }.
import { LOGIN_URL, api } from './dashboard/client.js';
import { alertBox, button, confirmDialog, h } from './dashboard/dom.js';
import { TABS, routeFromHash } from './dashboard/helpers.js';
import * as fonts from './dashboard/fonts.js';
import * as keys from './dashboard/keys.js';
import * as overview from './dashboard/overview.js';
import * as renders from './dashboard/renders.js';
import * as sites from './dashboard/sites.js';
import * as templates from './dashboard/templates.js';

const VIEWS = { overview, sites, templates, keys, fonts, renders };
const baseTitle = document.title;

async function signOut(control) {
  control.setAttribute('aria-busy', 'true');
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    location.assign('/');
  }
}

/** The site's header and footer offer "Sign in" and "Start free"; signed in, the header offers the way out instead. */
function adaptChrome() {
  for (const link of document.querySelectorAll('.site-header a[href="/login"], .site-footer a[href="/login"]')) {
    (link.closest('li') ?? link).remove();
  }
  document.querySelector('.site-nav')?.append(button('Sign out', { small: true, onclick: (event) => signOut(event.currentTarget) }));
}

function start(app, me, config) {
  let checkoutReturn = new URLSearchParams(location.search).get('checkout') === 'success';
  // The query has done its job; keeping it would repeat the "thanks" notice on every reload.
  if (checkoutReturn) history.replaceState(null, '', `${location.pathname}#overview`);

  const panel = h('div', { class: 'dash-panel', id: 'panel' });
  const tabs = h(
    'nav',
    { class: 'tabs dash-tabs', 'aria-label': 'Dashboard sections' },
    TABS.map((tab) => h('a', { class: 'tab', href: `#${tab.id}`, 'data-tab': tab.id }, tab.label)),
  );
  const planBadge = h('span', { class: 'badge badge-accent' });
  const suspended = alertBox(
    'danger',
    h('strong', {}, 'This account is suspended. '),
    `Card URLs and API calls are refused until it is restored. Email ${config.support_email} and we will sort it out.`,
  );

  let current = { route: null, view: null };
  let run = 0;

  const ctx = {
    me,
    config,
    /** Replaces the account snapshot (after a plan change or a top-up). */
    setMe(next) {
      ctx.me = next;
      syncAccount();
    },
    /** Mounts the current tab again, for example after something was created or deleted. */
    reload: (options) => show(current.route, options),
    /** True once, right after Paddle sent the customer back from a checkout. */
    takeCheckoutReturn() {
      const value = checkoutReturn;
      checkoutReturn = false;
      return value;
    },
  };

  function syncAccount() {
    planBadge.textContent = `${config.plans.find((plan) => plan.id === ctx.me.user.plan)?.name ?? ctx.me.user.plan} plan`;
    suspended.hidden = !ctx.me.user.suspended;
  }

  async function show(route, { focus, ...options } = {}) {
    const mine = ++run;
    current.view?.destroy?.();
    for (const tab of tabs.children) {
      if (tab.dataset.tab !== route.tab) {
        tab.removeAttribute('aria-current');
        continue;
      }
      tab.setAttribute('aria-current', 'page');
      // On a phone the tab strip scrolls sideways: keep the open tab in view without moving the page.
      tabs.scrollLeft = tab.offsetLeft - tabs.offsetLeft - 16;
    }
    document.title = `${TABS.find((tab) => tab.id === route.tab).label} · ${baseTitle}`;
    panel.setAttribute('aria-busy', 'true');
    let view = null;
    try {
      view = await VIEWS[route.tab].mount(ctx, route.param, options);
      if (mine !== run) return view.destroy?.();
      panel.replaceChildren(view.node);
    } catch (failure) {
      if (mine !== run || failure.status === 401) return;
      panel.replaceChildren(
        alertBox('danger', h('strong', {}, 'This page could not be loaded. '), failure.message || 'Something went wrong.', ' ', button('Try again', { small: true, onclick: () => show(route) })),
      );
    }
    current = { route, view };
    panel.removeAttribute('aria-busy');
    // After a tab change, focus lands on the new panel's heading so keyboard and screen-reader users start there.
    const selector = typeof focus === 'string' ? focus : (view?.focus ?? (focus ? 'h2' : null));
    const target = selector ? panel.querySelector(selector) : null;
    if (target) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
    }
  }

  let restoring = false;
  window.addEventListener('hashchange', async (event) => {
    if (restoring) {
      restoring = false;
      return;
    }
    if (current.view?.isDirty?.()) {
      const leave = await confirmDialog({
        title: 'Leave without saving?',
        body: 'Your changes to this template have not been saved and will be lost.',
        confirmLabel: 'Discard changes',
      });
      if (!leave) {
        restoring = true;
        location.replace(event.oldURL);
        return;
      }
    }
    show(routeFromHash(location.hash), { focus: true });
  });
  window.addEventListener('beforeunload', (event) => {
    if (current.view?.isDirty?.()) event.preventDefault();
  });

  syncAccount();
  adaptChrome();
  app.replaceChildren(
    h(
      'header',
      { class: 'dash-head' },
      h('h1', {}, 'Dashboard'),
      h('p', { class: 'dash-account' }, h('span', { class: 'dash-email' }, me.user.email), planBadge),
    ),
    suspended,
    tabs,
    panel,
  );
  show(routeFromHash(location.hash));
}

async function boot() {
  const app = document.querySelector('#app');
  app.replaceChildren(h('p', { class: 'dash-loading', role: 'status' }, 'Opening your dashboard…'));
  try {
    const [me, config] = await Promise.all([api.get('/api/me'), api.get('/api/config')]);
    start(app, me, config);
  } catch (failure) {
    // Signed out: client.js is already on its way to the sign-in page.
    if (failure.status === 401) return;
    app.replaceChildren(
      alertBox('danger', h('strong', {}, 'The dashboard could not be opened. '), failure.message || 'Something went wrong.', ' ', button('Try again', { small: true, onclick: () => location.reload() })),
      h('p', { class: 'hint' }, h('a', { href: LOGIN_URL }, 'Sign in again')),
    );
  }
}

boot();
