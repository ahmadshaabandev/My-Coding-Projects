// The plan card on the overview: usage meter, what the plan includes, and the
// billing actions. New subscriptions and top-ups go through Paddle's overlay
// checkout; plan changes and the customer portal go through the API.
import { checkoutAction, openCheckout } from '../checkout.js';
import { api } from './client.js';
import { alertBox, button, confirmDialog, errorSlot, h, showError, withBusy } from './dom.js';
import { billingActions, checkoutSettled, checkoutSnapshot, formatCount, formatDate, pollUntil, usageView } from './helpers.js';

const CHECKOUT_MEMO = 'ltc:checkout';

const planOf = (config, id) => config.plans.find((plan) => plan.id === id);
const priceLine = (plan) => `$${plan.price_usd} a month, ${formatCount(plan.monthly_images)} images`;

function rememberCheckout(snapshot) {
  try {
    sessionStorage.setItem(CHECKOUT_MEMO, JSON.stringify(snapshot));
  } catch {
    // Without storage the return page falls back to "the plan is no longer Free".
  }
}

function recallCheckout() {
  try {
    const snapshot = JSON.parse(sessionStorage.getItem(CHECKOUT_MEMO) ?? 'null');
    sessionStorage.removeItem(CHECKOUT_MEMO);
    if (snapshot) return snapshot;
  } catch {
    // Fall through to the default.
  }
  return { item: 'starter', plan: 'free', topup_remaining: 0 };
}

/**
 * After Paddle sends the customer back (/dashboard?checkout=success): waits
 * for the webhook to change the account, for about 30 s, and says what
 * happened either way.
 */
export function checkoutReturnNotice(ctx) {
  const before = recallCheckout();
  const notice = alertBox('info', 'Thanks! Paddle confirmed the checkout. Updating your account…');
  pollUntil(
    () => api.get('/api/me'),
    (me) => checkoutSettled(before, me),
  ).then(
    async ({ value: me, settled }) => {
      if (!settled) {
        notice.className = 'alert alert-warn';
        notice.textContent = `Paddle confirmed the checkout, but your account has not been updated yet. It usually takes a few seconds: reload this page in a minute. If nothing has changed by then, email ${ctx.config.support_email}.`;
        return;
      }
      const message =
        before.item === 'topup'
          ? `Your top-up arrived: ${formatCount(me.usage.topup_remaining)} top-up images are ready.`
          : `You are now on the ${planOf(ctx.config, me.user.plan)?.name ?? me.user.plan} plan.`;
      ctx.setMe(me);
      ctx.reload({ notice: alertBox('ok', message) });
    },
    (failure) => {
      notice.className = 'alert alert-danger';
      notice.textContent = failure.message;
    },
  );
  return notice;
}

function usageBlock(ctx) {
  const { usage, topups } = ctx.me;
  const view = usageView(usage);
  const reset = formatDate(usage.period_end);
  const meter = h('progress', {
    class: `meter${view.level === 'ok' ? '' : ` meter-${view.level}`}`,
    max: usage.limit,
    value: Math.min(usage.used, usage.limit),
    'aria-label': `${formatCount(usage.used)} of ${formatCount(usage.limit)} images used this period`,
  });
  return h(
    'div',
    { class: 'usage-body' },
    h('p', { class: 'usage-figure' }, h('strong', {}, formatCount(usage.remaining)), h('span', {}, usage.remaining === 1 ? 'image left this period' : 'images left this period')),
    meter,
    h('p', { class: 'usage-line' }, h('span', {}, `${formatCount(usage.used)} of ${formatCount(usage.limit)} used`), h('span', {}, `Resets ${reset}`)),
    usage.topup_remaining > 0
      ? h(
          'p',
          { class: 'usage-topups' },
          h('strong', {}, `+ ${formatCount(usage.topup_remaining)} top-up images`),
          ' in reserve, used only after the monthly allowance. ',
          topups.map((topup) => `${formatCount(topup.remaining)} valid until ${formatDate(topup.expires_at)}`).join('; '),
          '.',
        )
      : null,
    view.exhausted
      ? alertBox('danger', h('strong', {}, 'This period\'s images are used up. '), `New cards answer with an error until ${reset}. Cards that were already rendered keep working.`)
      : view.level === 'warn'
        ? alertBox('warn', `You have used ${view.percent}% of this period's images. When they run out, new cards answer with an error until ${reset}.${billingActions(ctx.me.user, ctx.config).length > 0 ? (ctx.me.user.plan === 'free' ? ' Upgrade below to keep them coming.' : ' A top-up below adds more.') : ''}`)
        : null,
    usage.watermark ? h('p', { class: 'hint' }, 'Cards made on the Free plan carry a small Link To Card mark in the corner. Paid plans remove it.') : null,
  );
}

function billingBlock(ctx, { primary }) {
  const { user } = ctx.me;
  const { config } = ctx;
  const actions = billingActions(user, config);
  if (actions.length === 0) {
    return h('p', { class: 'alert alert-info', role: 'note' }, `Paid plans and top-ups are coming soon, so there is nothing to buy here yet. Need more images? Email ${config.support_email}.`);
  }
  const error = errorSlot();
  const status = h('p', { class: 'alert alert-info', role: 'status', hidden: true });
  const starter = planOf(config, 'starter');
  const pro = planOf(config, 'pro');

  async function checkout(item, control) {
    error.hidden = true;
    const action = checkoutAction({ item, user, config, origin: location.origin });
    if (action.type === 'message') return showError(error, action);
    if (action.type === 'redirect') return location.assign(action.url);
    rememberCheckout(checkoutSnapshot(item, ctx.me));
    try {
      await withBusy(control, () => openCheckout(action));
    } catch (failure) {
      showError(error, failure);
    }
  }

  async function changePlan(target, control) {
    const plan = planOf(config, target);
    const current = planOf(config, user.plan);
    const upgrade = plan.price_usd > (current?.price_usd ?? 0);
    // Same rule as upgradeAddsImages on the server: switching back up after a
    // downgrade that kept this period's images adds nothing and is not billed.
    const { usage } = ctx.me;
    const start = Date.parse(usage.period_start);
    const end = Date.parse(usage.period_end);
    const now = Date.now();
    const prorated =
      current && end > start && now >= start && now < end
        ? plan.monthly_images - Math.trunc(((plan.monthly_images - current.monthly_images) * (now - start)) / (end - start))
        : Infinity;
    const charged = upgrade && prorated > usage.limit;
    const confirmed = await confirmDialog({
      title: `Switch to ${plan.name}?`,
      body: charged
        ? `Your subscription changes to ${plan.name} (${priceLine(plan)}) right away. Paddle charges the difference for the rest of this billing period now, and this period's images grow in proportion to the time that is left.`
        : upgrade
          ? `Your subscription changes to ${plan.name} (${priceLine(plan)}) right away. Nothing is charged for the change: this billing period already has ${formatCount(usage.limit)} images, and the ${plan.name} price applies from your next renewal.`
          : `Your subscription changes to ${plan.name} (${priceLine(plan)}) at once. Nothing is charged or refunded for the change: you keep the images of this billing period, and the ${plan.name} price applies from your next renewal.`,
      confirmLabel: `Switch to ${plan.name}`,
      danger: false,
    });
    if (!confirmed) return;
    error.hidden = true;
    try {
      await withBusy(control, async () => {
        await api.post('/api/billing/change-plan', { plan: target });
        status.textContent = `Switching to ${plan.name}…`;
        status.hidden = false;
        const { value: me, settled } = await pollUntil(
          () => api.get('/api/me'),
          (next) => next.user.plan === target,
        );
        if (!settled) {
          status.textContent = `Paddle accepted the change to ${plan.name}, but your account has not been updated yet. Reload this page in a minute.`;
          return;
        }
        ctx.setMe(me);
        ctx.reload({ notice: alertBox('ok', `You are now on the ${plan.name} plan.`) });
      });
    } catch (failure) {
      status.hidden = true;
      showError(error, failure);
    }
  }

  async function portal(control) {
    error.hidden = true;
    try {
      const { url } = await withBusy(control, () => api.post('/api/billing/portal'));
      location.assign(url);
    } catch (failure) {
      showError(error, failure);
    }
  }

  const controls = actions.map((action, index) => {
    const variant = primary && index === 0 ? 'primary' : 'secondary';
    if (action.type === 'portal') return button('Manage billing', { variant, onclick: (event) => portal(event.currentTarget) });
    if (action.type === 'change-plan') {
      return button(`Switch to ${planOf(config, action.plan).name}`, { variant, onclick: (event) => changePlan(action.plan, event.currentTarget) });
    }
    const label = action.item === 'topup' ? 'Buy top-up' : `Upgrade to ${planOf(config, action.item).name}`;
    return button(label, { variant, 'data-checkout': action.item, onclick: (event) => checkout(action.item, event.currentTarget) });
  });

  const explain =
    user.plan === 'free'
      ? `${starter.name}: ${priceLine(starter)}. ${pro.name}: ${priceLine(pro)}. No watermark on either.`
      : `A top-up is ${formatCount(config.topup.images)} extra images for $${config.topup.price_usd}, valid for ${config.topup.valid_days} days and used only after the monthly allowance. It is a one-time payment that you start yourself.`;

  return h(
    'div',
    { class: 'billing stack' },
    h('div', { class: 'cluster' }, controls),
    h('p', { class: 'hint' }, `${explain} Payments are handled by Paddle, which adds any tax at checkout. `, h('a', { href: '/pricing' }, 'Compare plans')),
    status,
    error,
  );
}

function subscriptionBadges(user) {
  const subscription = user.subscription;
  if (!subscription) return [];
  const badges = [];
  if (subscription.status === 'past_due') badges.push(h('span', { class: 'badge badge-danger' }, 'Payment past due'));
  if (subscription.status === 'trialing') badges.push(h('span', { class: 'badge badge-ok' }, 'Trial'));
  if (subscription.cancel_at) badges.push(h('span', { class: 'badge badge-warn' }, `Ends ${formatDate(subscription.cancel_at)}`));
  else if (subscription.period_end && user.plan !== 'free') badges.push(h('span', { class: 'badge' }, `Renews ${formatDate(subscription.period_end)}`));
  return badges;
}

/** The plan card. `primary`: whether its first billing button is the screen's primary action. */
export function planCard(ctx, { primary }) {
  const { user } = ctx.me;
  const plan = planOf(ctx.config, user.plan);
  return h(
    'section',
    { class: 'card usage', id: 'billing', 'aria-labelledby': 'usage-title', tabindex: '-1' },
    h(
      'div',
      { class: 'usage-head' },
      h('div', {}, h('p', { class: 'kicker' }, 'Your plan'), h('h2', { id: 'usage-title' }, plan?.name ?? user.plan)),
      h('div', { class: 'usage-badges' }, subscriptionBadges(user)),
    ),
    usageBlock(ctx),
    h('hr', { class: 'rule' }),
    billingBlock(ctx, { primary }),
  );
}
