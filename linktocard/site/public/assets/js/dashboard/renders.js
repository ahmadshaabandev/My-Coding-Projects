// Recent renders: the latest images that were rendered and counted.
import { api } from './client.js';
import { h } from './dom.js';
import { formatDateTime, renderSummary } from './helpers.js';

const COLUMNS = ['Template', 'Made with', 'Size', 'Format', 'File size', 'Rendered', 'Counted against', 'Image'];

export async function mount() {
  const [{ renders }, templates] = await Promise.all([api.get('/api/renders'), api.get('/api/templates')]);
  const names = Object.fromEntries([...templates.starter, ...templates.custom].map((template) => [template.id, template.name]));
  const head = h(
    'header',
    { class: 'panel-head' },
    h('h2', {}, 'Recent renders'),
    h('p', { class: 'lead-sm' }, 'The latest 50 cards that were rendered and counted. Cached and failed requests are never counted, so they are not listed.'),
  );

  if (renders.length === 0) {
    return {
      node: h(
        'div',
        { class: 'panel-stack' },
        head,
        h(
          'div',
          { class: 'empty' },
          h('h3', {}, 'Nothing rendered yet'),
          h('p', {}, 'A card shows up here the first time its signed URL is opened, or when you render one through the API.'),
          h('a', { class: 'btn btn-primary', href: '#sites' }, 'Build a signed URL'),
        ),
      ),
    };
  }

  const now = Date.now();
  const rows = renders.map((render) => {
    const row = renderSummary(render, names);
    const expired = Date.parse(render.expires_at) <= now;
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, row.template),
      h('td', {}, row.via),
      h('td', { class: 'nowrap' }, row.size),
      h('td', {}, row.format),
      h('td', { class: 'nowrap' }, row.bytes),
      h('td', { class: 'nowrap' }, formatDateTime(render.created_at)),
      h('td', {}, h('span', { class: `badge${render.charged_to === 'topup' ? ' badge-accent' : ''}` }, row.counted)),
      h('td', {}, expired ? h('span', { class: 'muted' }, 'Expired') : h('a', { href: render.url, target: '_blank', rel: 'noopener', 'aria-label': `Open the ${row.template} image rendered ${formatDateTime(render.created_at)}` }, 'Open')),
    );
  });

  return {
    node: h(
      'div',
      { class: 'panel-stack' },
      head,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, COLUMNS.map((label) => h('th', { scope: 'col' }, label)))), h('tbody', {}, rows))),
      h('p', { class: 'hint' }, 'Opening a stored image here is free: it is served from the cache.'),
    ),
  };
}
