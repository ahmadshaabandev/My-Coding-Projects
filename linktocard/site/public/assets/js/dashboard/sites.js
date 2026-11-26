// Sites & URLs: each site's id and signing secret, and the signed-URL builder.
import { api } from './client.js';
import { createBuilder, siteForm } from './builder.js';
import { button, confirmDialog, copyButton, errorSlot, h, showError, toast } from './dom.js';
import { formatDate } from './helpers.js';

const MASK = '•'.repeat(32);

function siteRow(ctx, site) {
  let secret = null;
  const loadSecret = async () => {
    secret ??= (await api.get(`/api/sites/${encodeURIComponent(site.id)}/secret`)).secret;
    return secret;
  };
  const error = errorSlot();
  const secretText = h('code', { class: 'secret' }, MASK);
  const reveal = button('Show', {
    small: true,
    'aria-pressed': 'false',
    onclick: async () => {
      error.hidden = true;
      const show = reveal.getAttribute('aria-pressed') !== 'true';
      try {
        secretText.textContent = show ? await loadSecret() : MASK;
        reveal.setAttribute('aria-pressed', String(show));
        reveal.textContent = show ? 'Hide' : 'Show';
      } catch (failure) {
        showError(error, failure);
      }
    },
  });

  async function rotate() {
    const confirmed = await confirmDialog({
      title: `Rotate the signing secret of ${site.name}?`,
      body: 'Every signed URL that already exists for this site stops working. Copies that are already cached can stay visible for up to a day; after that, pages that use an old URL show no card until you sign their URLs again with the new secret.',
      confirmLabel: 'Rotate secret',
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/sites/${encodeURIComponent(site.id)}/rotate`);
      toast(`${site.name} has a new signing secret.`);
      ctx.reload();
    } catch (failure) {
      showError(error, failure);
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({
      title: `Delete ${site.name}?`,
      body: 'Every signed URL of this site stops working; copies that are already cached can stay visible for up to a day. A deleted site cannot be restored.',
      confirmLabel: 'Delete site',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/sites/${encodeURIComponent(site.id)}`);
      toast(`${site.name} was deleted.`);
      ctx.reload();
    } catch (failure) {
      showError(error, failure);
    }
  }

  return h(
    'li',
    { class: 'row-card' },
    h('div', { class: 'row-head' }, h('h3', {}, site.name), h('span', { class: 'hint' }, `Created ${formatDate(site.created_at)}`)),
    h(
      'dl',
      { class: 'kv' },
      h('div', {}, h('dt', {}, 'Site ID'), h('dd', {}, h('code', {}, site.id), copyButton('Copy', () => site.id))),
      h('div', {}, h('dt', {}, 'Signing secret'), h('dd', {}, secretText, reveal, copyButton('Copy', loadSecret))),
    ),
    error,
    h(
      'details',
      { class: 'more' },
      h('summary', {}, 'Rotate secret or delete site'),
      h(
        'div',
        { class: 'more-body danger-zone' },
        h('p', { class: 'hint' }, 'Rotating gives the site a new signing secret, for when the old one may have leaked. Both actions stop every existing signed URL of this site.'),
        h('div', { class: 'cluster' }, button('Rotate secret', { small: true, onclick: rotate }), button('Delete site', { small: true, variant: 'danger', onclick: remove })),
      ),
    ),
  );
}

export async function mount(ctx) {
  const [{ sites }, templates] = await Promise.all([api.get('/api/sites'), api.get('/api/templates')]);
  const head = h(
    'header',
    { class: 'panel-head' },
    h('h2', {}, 'Sites and signed URLs'),
    h('p', { class: 'lead-sm' }, 'A site is one website that shows your cards. Its signing secret proves that an image URL was made by you.'),
  );
  const created = () => {
    toast('Site created.');
    ctx.reload();
  };

  if (sites.length === 0) {
    const empty = h(
      'div',
      { class: 'empty' },
      h('h3', {}, 'No site yet'),
      h('p', {}, 'Create one to get its signing secret and build your first signed URL.'),
      siteForm({ label: 'What is your website called?', value: 'My website', submitLabel: 'Create site', oncreated: created }),
    );
    return { node: h('div', { class: 'panel-stack' }, head, empty) };
  }

  // The builder renames it while open fields turn its output into an email image tag.
  const outputTitle = h('h4', { class: 'kicker' }, 'Your meta tags');
  const builder = createBuilder(ctx, { sites, templates, outputTitle, oncopied: () => toast('Meta tags copied.') });
  const cap = ctx.me.limits.sites;
  const node = h(
    'div',
    { class: 'panel-stack' },
    head,
    h(
      'section',
      { 'aria-labelledby': 'sites-title', class: 'stack' },
      h('div', { class: 'section-row' }, h('h3', { id: 'sites-title', class: 'kicker' }, `Your sites (${sites.length} of ${cap})`)),
      h('ul', { class: 'row-list' }, sites.map((site) => siteRow(ctx, site))),
      h(
        'details',
        { class: 'more' },
        h('summary', {}, 'Add another site'),
        h('div', { class: 'more-body' }, siteForm({ label: 'Site name', hint: 'For example a second website, or a staging copy with its own secret.', submitLabel: 'Add site', variant: 'secondary', oncreated: created })),
      ),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'builder-title' },
      h('div', { class: 'card-head' }, h('h3', { id: 'builder-title', class: 'card-title' }, 'Build a signed URL'), h('p', { class: 'muted' }, 'Pick a template, fill it in and copy the meta tags. The preview is free; nothing is counted here.')),
      builder.form,
      h('hr', { class: 'rule' }),
      outputTitle,
      builder.output,
    ),
  );
  return { node, destroy: builder.destroy };
}
