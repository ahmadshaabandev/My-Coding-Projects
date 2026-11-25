// Overview: the first-run guide (site -> card -> meta tags) and the plan card.
import { api } from './client.js';
import { planCard, checkoutReturnNotice } from './billing.js';
import { createBuilder, siteForm } from './builder.js';
import { alertBox, button, h, memory, toast } from './dom.js';
import { guideStage, prefillFromQuery, usageView } from './helpers.js';

const guideKey = (userId) => `ltc:guide:${userId}`;

function step(number, title, state, ...body) {
  return h(
    'li',
    { class: `guide-step is-${state}`, 'aria-current': state === 'open' ? 'step' : undefined },
    h('span', { class: 'guide-num', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(number)),
    h('div', { class: 'guide-main' }, h('h3', { id: `guide-step-${number}`, tabindex: '-1' }, title), ...body),
  );
}

function guide(ctx, { sites, templates, stage, rerender }) {
  const userId = ctx.me.user.id;
  const head = h(
    'div',
    { class: 'guide-head' },
    h('div', {}, h('p', { class: 'eyebrow' }, 'Start here'), h('h2', { id: 'guide-title' }, 'Three steps to your first card.')),
    button('Skip the guide', {
      variant: 'ghost',
      small: true,
      onclick: () => {
        memory.set(guideKey(userId), true);
        rerender();
      },
    }),
  );

  if (stage === 'site') {
    const node = h(
      'section',
      { class: 'card card-pop guide', 'aria-labelledby': 'guide-title' },
      head,
      h(
        'ol',
        { class: 'guide-steps' },
        step(
          1,
          'Create a site',
          'open',
          siteForm({
            label: 'What is your website called?',
            hint: 'A site is one website that shows your cards. The name is only a label for you.',
            value: 'My website',
            submitLabel: 'Create site',
            oncreated: () => rerender({ focus: '#guide-step-2' }),
          }),
        ),
        step(2, 'Pick a template and fill it in', 'todo', h('p', { class: 'hint' }, 'Five starter templates, with a live preview.')),
        step(3, 'Copy the meta tags', 'todo', h('p', { class: 'hint' }, 'Paste them into your page and its link gets a card.')),
      ),
    );
    return { node };
  }

  const site = sites[0];
  const done = alertBox(
    'ok',
    h('strong', {}, 'Copied. '),
    'Paste the tags into the <head> of your page and publish it. From now on you can build cards any time under ',
    h('a', { href: '#sites' }, 'Sites & URLs'),
    '. ',
    button('Close the guide', { small: true, onclick: () => rerender() }),
  );
  done.hidden = true;
  const builder = createBuilder(ctx, {
    sites: [site],
    templates,
    compact: true,
    prefill: prefillFromQuery(location.search),
    oncopied: () => {
      memory.set(guideKey(userId), true);
      done.hidden = false;
      toast('Meta tags copied.');
    },
  });
  const node = h(
    'section',
    { class: 'card card-pop guide', 'aria-labelledby': 'guide-title' },
    head,
    h(
      'ol',
      { class: 'guide-steps' },
      step(1, 'Create a site', 'done', h('p', { class: 'guide-summary' }, h('strong', {}, site.name), ' is ready. ', h('code', {}, site.id))),
      step(2, 'Pick a template and fill it in', 'open', builder.form),
      step(3, 'Copy the meta tags', 'open', builder.output, done),
    ),
  );
  return { node, destroy: builder.destroy };
}

function guideDone(ctx, { sites, primary, rerender }) {
  const userId = ctx.me.user.id;
  return h(
    'section',
    { class: 'card guide-done', 'aria-labelledby': 'next-title' },
    h(
      'div',
      {},
      h('h2', { id: 'next-title' }, 'Make another card.'),
      h('p', { class: 'muted' }, sites.length === 0 ? 'Create a site, pick a template and copy the meta tags.' : 'Pick a template, fill it in and copy the meta tags. It takes a minute.'),
    ),
    h(
      'div',
      { class: 'cluster' },
      h('a', { class: `btn ${primary ? 'btn-primary' : 'btn-secondary'}`, href: '#sites' }, 'Build a signed URL'),
      button('Show the guide', {
        variant: 'ghost',
        small: true,
        onclick: () => {
          memory.set(guideKey(userId), false);
          rerender();
        },
      }),
    ),
  );
}

export async function mount(ctx, param, { notice } = {}) {
  const { user, usage } = ctx.me;
  const node = h('div', { class: 'panel-stack' });
  let destroy;

  if (notice) node.append(notice);
  if (ctx.takeCheckoutReturn()) node.append(checkoutReturnNotice(ctx));

  // A suspended account can still see its plan; everything else answers 403, so the guide stays away.
  if (user.suspended) {
    node.append(planCard(ctx, { primary: false }));
    return { node };
  }

  const [{ sites }, templates] = await Promise.all([api.get('/api/sites'), api.get('/api/templates')]);
  // Remembered per browser; an account that already rendered through a site has clearly finished on its own.
  const remembered = memory.get(guideKey(user.id));
  const finished = typeof remembered === 'boolean' ? remembered : sites.length > 0 && usage.used > 0;
  const stage = guideStage({ siteCount: sites.length, finished });
  const exhausted = usageView(usage).exhausted;
  const rerender = (options) => ctx.reload(options);

  if (stage === 'done') {
    node.append(planCard(ctx, { primary: exhausted }), guideDone(ctx, { sites, primary: !exhausted, rerender }));
  } else {
    const section = guide(ctx, { sites, templates, stage, rerender });
    destroy = section.destroy;
    node.append(section.node, planCard(ctx, { primary: false }));
  }

  return { node, destroy, focus: param === 'billing' ? '#billing' : undefined };
}
