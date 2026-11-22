// Recent renders: the latest images that were rendered and counted.
import { api } from './client.js';
import { dataTable, h } from './dom.js';
import { formatDateTime, renderSummary } from './helpers.js';

const COLUMNS = [
  { label: 'Template' },
  { label: 'Made with' },
  { label: 'Size', class: 'nowrap' },
  { label: 'Format' },
  { label: 'File size', class: 'nowrap' },
  { label: 'Rendered', class: 'nowrap' },
  { label: 'Counted against' },
  { label: 'Image' },
];

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
    return [
      row.template,
      row.via,
      row.size,
      row.format,
      row.bytes,
      formatDateTime(render.created_at),
      h('span', { class: `badge${render.charged_to === 'topup' ? ' badge-accent' : ''}` }, row.counted),
      expired ? h('span', { class: 'muted' }, 'Expired') : h('a', { href: render.url, target: '_blank', rel: 'noopener', 'aria-label': `Open the ${row.template} image rendered ${formatDateTime(render.created_at)}` }, 'Open'),
    ];
  });

  return {
    node: h(
      'div',
      { class: 'panel-stack' },
      head,
      dataTable(COLUMNS, rows),
      h('p', { class: 'hint' }, 'Opening a stored image here is free: it is served from the cache.'),
    ),
  };
}
