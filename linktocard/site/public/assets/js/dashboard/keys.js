// API keys: create (the secret is shown once), list, revoke, and a curl example.
import { api } from './client.js';
import { alertBox, button, codeBlock, confirmDialog, copyButton, errorSlot, field, h, showError, toast, withBusy } from './dom.js';
import { KEY_PLACEHOLDER, curlExample, formatDate, formatDateTime } from './helpers.js';

function keyTable(ctx, keys, error) {
  async function revoke(key) {
    const confirmed = await confirmDialog({
      title: `Revoke ${key.name}?`,
      body: 'Every program that uses this key gets an error on its next request. A revoked key cannot be restored.',
      confirmLabel: 'Revoke key',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/keys/${encodeURIComponent(key.id)}`);
      toast(`${key.name} was revoked.`);
      ctx.reload();
    } catch (failure) {
      showError(error, failure);
    }
  }
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ['Name', 'Key starts with', 'Created', 'Last used', ''].map((label) => h('th', { scope: 'col' }, label || h('span', { class: 'visually-hidden' }, 'Actions'))))),
      h(
        'tbody',
        {},
        keys.map((key) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, key.name),
            h('td', {}, h('code', {}, `${key.prefix}…`)),
            h('td', { class: 'nowrap' }, formatDate(key.created_at)),
            h('td', { class: 'nowrap' }, key.last_used_at ? formatDateTime(key.last_used_at) : 'Never'),
            h('td', { class: 'cell-action' }, button('Revoke', { small: true, 'aria-label': `Revoke ${key.name}`, onclick: () => revoke(key) })),
          ),
        ),
      ),
    ),
  );
}

export async function mount(ctx, param, { created } = {}) {
  const { keys } = await api.get('/api/keys');
  const error = errorSlot();
  const name = h('input', { class: 'input', type: 'text', required: true, maxlength: 80, autocomplete: 'off', value: keys.length === 0 ? 'My first key' : '', placeholder: 'For example: production server' });
  const submit = button('Create API key', { variant: 'primary', type: 'submit' });
  const form = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        try {
          const result = await withBusy(submit, () => api.post('/api/keys', { name: name.value }));
          ctx.reload({ created: result, focus: '#new-key' });
        } catch (failure) {
          showError(error, failure);
        }
      },
    },
    field('Name the key after where it will be used', name),
    submit,
  );

  const curl = codeBlock(curlExample(location.origin, created?.secret), 'shell');
  const reveal = created
    ? h(
        'section',
        { class: 'card card-pop secret-once', id: 'new-key', tabindex: '-1', 'aria-labelledby': 'new-key-title' },
        h('h3', { id: 'new-key-title', class: 'card-title' }, `Your new key: ${created.key.name}`),
        alertBox('warn', h('strong', {}, 'Copy it now. '), 'You will not see this key again: we only keep a fingerprint of it. If you lose it, revoke it and create a new one.'),
        h('div', { class: 'secret-line' }, h('code', { class: 'secret' }, created.secret), copyButton('Copy key', () => created.secret, { variant: 'primary', small: false })),
      )
    : null;

  const node = h(
    'div',
    { class: 'panel-stack' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, 'API keys'),
      h('p', { class: 'lead-sm' }, 'A key lets your own code render cards with POST /v1/images. For meta tags you do not need one: a signed URL is enough.'),
    ),
    reveal,
    created ? h('p', {}, button('Create another key', { small: true, onclick: () => ctx.reload() })) : h('section', { class: 'card' }, form),
    error,
    keys.length === 0
      ? null
      : h('section', { class: 'stack', 'aria-labelledby': 'keys-title' }, h('h3', { id: 'keys-title', class: 'kicker' }, `Your keys (${keys.length} of ${ctx.me.limits.api_keys})`), keyTable(ctx, keys, error)),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'curl-title' },
      h('h3', { id: 'curl-title', class: 'kicker' }, 'Try it from a terminal'),
      h('p', { class: 'muted' }, created ? 'This example already contains your new key. It renders one card and counts one image.' : `Replace ${KEY_PLACEHOLDER} with your key. The call renders one card and counts one image.`),
      curl.block,
    ),
  );
  return { node };
}
