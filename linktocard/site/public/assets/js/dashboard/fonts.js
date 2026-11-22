// Fonts: upload, list and delete custom fonts (paid plans), and how to use one.
import { api } from './client.js';
import { button, codeBlock, confirmDialog, errorSlot, field, h, segmented, showError, toast, withBusy } from './dom.js';
import { fontCssExample, fontSizeProblem, formatBytes, formatDate } from './helpers.js';

const WEIGHTS = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
];
const BUNDLED = 'Inter, Source Serif 4 and JetBrains Mono';

const head = () =>
  h(
    'header',
    { class: 'panel-head' },
    h('h2', {}, 'Fonts'),
    h('p', { class: 'lead-sm' }, `Every template can use the built-in fonts: ${BUNDLED}. Upload your own to match your brand.`),
  );

function upgradeNote(ctx) {
  const caps = ctx.config.plans
    .filter((plan) => plan.fonts.max_files > 0)
    .map((plan) => `${plan.name}: ${plan.fonts.max_files} font files, up to ${formatBytes(plan.fonts.max_bytes_per_file)} each`)
    .join('. ');
  return h(
    'div',
    { class: 'empty' },
    h('h3', {}, 'Custom fonts need a paid plan'),
    h('p', {}, `On the Free plan your cards use the built-in fonts. ${caps}.`),
    h('a', { class: 'btn btn-primary', href: '#billing' }, 'See upgrade options'),
  );
}

function fontTable(ctx, fonts, error) {
  async function remove(font) {
    const label = `${font.family} ${font.weight}${font.style === 'italic' ? ' italic' : ''}`;
    const confirmed = await confirmDialog({
      title: `Delete ${label}?`,
      body: 'Templates that use this font are drawn with a fallback font from their next render on. Cards that are already cached do not change.',
      confirmLabel: 'Delete font',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/fonts/${encodeURIComponent(font.id)}`);
      toast(`${label} was deleted.`);
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
      h('thead', {}, h('tr', {}, ['Family', 'Weight', 'Style', 'File', 'Added', ''].map((label) => h('th', { scope: 'col' }, label || h('span', { class: 'visually-hidden' }, 'Actions'))))),
      h(
        'tbody',
        {},
        fonts.map((font) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, font.family),
            h('td', {}, String(font.weight)),
            h('td', {}, font.style),
            h('td', { class: 'nowrap' }, `${font.format.toUpperCase()}, ${formatBytes(font.bytes)}`),
            h('td', { class: 'nowrap' }, formatDate(font.created_at)),
            h('td', { class: 'cell-action' }, button('Delete', { small: true, 'aria-label': `Delete ${font.family} ${font.weight} ${font.style}`, onclick: () => remove(font) })),
          ),
        ),
      ),
    ),
  );
}

export async function mount(ctx) {
  if (ctx.me.limits.fonts.max_files === 0) return { node: h('div', { class: 'panel-stack' }, head(), upgradeNote(ctx)) };

  const { fonts, limits } = await api.get('/api/fonts');
  const error = errorSlot();
  const state = { style: 'normal' };
  const family = h('input', { class: 'input', type: 'text', required: true, maxlength: 64, autocomplete: 'off', placeholder: 'For example: Acme Sans' });
  const weight = h('select', { class: 'select' }, WEIGHTS.map(([value, label]) => h('option', { value, selected: value === 400 }, `${value} ${label}`)));
  const file = h('input', { class: 'input', type: 'file', required: true, accept: '.ttf,.otf,.woff,font/ttf,font/otf,font/woff' });
  const submit = button('Upload font', { variant: 'primary', type: 'submit' });
  const full = fonts.length >= limits.max_files;

  const form = h(
    'form',
    {
      class: 'font-form',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        const chosen = file.files[0];
        const problem = chosen ? fontSizeProblem(chosen.size, limits.max_bytes_per_file) : 'Choose a font file.';
        if (problem) return showError(error, { message: problem });
        try {
          const { font } = await withBusy(submit, () => api.uploadFont({ family: family.value.trim(), weight: Number(weight.value), style: state.style }, chosen));
          toast(`${font.family} ${font.weight} is ready to use.`);
          ctx.reload();
        } catch (failure) {
          showError(error, failure);
        }
      },
    },
    field('Family name', family, 'The name you will write in CSS. Letters, digits, spaces, hyphens and underscores.'),
    field('Weight', weight),
    segmented(
      'font-style',
      'Style',
      [
        { value: 'normal', label: 'Normal' },
        { value: 'italic', label: 'Italic' },
      ],
      state.style,
      (value) => {
        state.style = value;
      },
    ),
    field('Font file', file, `TTF, OTF or WOFF, up to ${formatBytes(limits.max_bytes_per_file)}. WOFF2 is not accepted: convert it to one of these first.`),
    submit,
  );

  const example = fonts[0] ?? { family: 'Acme Sans', weight: 700, style: 'normal' };
  const node = h(
    'div',
    { class: 'panel-stack' },
    head(),
    h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'upload-title' },
      h('div', { class: 'card-head' }, h('h3', { id: 'upload-title', class: 'card-title' }, 'Upload a font'), h('p', { class: 'muted' }, `Your plan holds ${limits.max_files} font files; you have used ${fonts.length}. Upload one file per weight and style.`)),
      full ? h('p', { class: 'alert alert-warn' }, 'You have reached your plan\'s number of font files. Delete one to upload another.') : form,
      error,
    ),
    fonts.length === 0
      ? null
      : h('section', { class: 'stack', 'aria-labelledby': 'fonts-title' }, h('h3', { id: 'fonts-title', class: 'kicker' }, `Your fonts (${fonts.length} of ${limits.max_files})`), fontTable(ctx, fonts, error)),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'font-css-title' },
      h('h3', { id: 'font-css-title', class: 'kicker' }, 'Use it in a template'),
      h('p', { class: 'muted' }, 'Write the family name in your template\'s CSS. Uploaded fonts are used in renders while the account is on a paid plan.'),
      codeBlock(fontCssExample(example.family, example.weight, example.style), 'css').block,
    ),
  );
  return { node };
}
