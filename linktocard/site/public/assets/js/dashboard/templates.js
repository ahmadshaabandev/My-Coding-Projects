// Templates: the starter gallery, the account's own templates, and the editor
// with its live preview.
import { api } from './client.js';
import { fieldControl, sampleKey } from './builder.js';
import { button, clear, confirmDialog, copyButton, errorSlot, field, h, memory, segmented, showError, toast, withBusy } from './dom.js';
import { BLANK_TEMPLATE, cardData, customTemplateFields, formatDateTime, initialValues, insertIndent, sampleValue, sizeOption } from './helpers.js';
import { createPreview, debounce } from './preview.js';

const editorHash = (id) => `#templates/${id}`;

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

async function listView(ctx) {
  const templates = await api.get('/api/templates');
  const error = errorSlot();

  async function create(source, sample, control) {
    error.hidden = true;
    try {
      const { template } = await withBusy(control, () => api.post('/api/templates', source));
      // The editor's sample data starts as the starter's own sample, so the copy previews like the original.
      if (sample) memory.set(sampleKey(template.id), sample);
      location.hash = editorHash(template.id);
    } catch (failure) {
      showError(error, failure);
    }
  }
  const duplicate = (starter, control) => create({ name: `${starter.name} (copy)`, html: starter.html, css: starter.css }, starter.sample, control);
  const blank = (control) => create(BLANK_TEMPLATE, null, control);

  const first = templates.starter[0];
  const mine =
    templates.custom.length === 0
      ? h(
          'div',
          { class: 'empty' },
          h('h3', {}, 'No templates of your own yet'),
          h('p', {}, 'The quickest start is a copy of a starter template: change its HTML and CSS until it is yours.'),
          h(
            'div',
            { class: 'cluster center' },
            button(`Duplicate “${first.name}” to edit`, { variant: 'primary', onclick: (event) => duplicate(first, event.currentTarget) }),
            button('Start from a blank template', { variant: 'ghost', onclick: (event) => blank(event.currentTarget) }),
          ),
        )
      : h(
          'ul',
          { class: 'row-list' },
          templates.custom.map((template) =>
            h(
              'li',
              { class: 'row-card row-inline' },
              h('div', {}, h('h4', {}, h('a', { href: editorHash(template.id) }, template.name)), h('p', { class: 'hint' }, `Version ${template.version}, saved ${formatDateTime(template.updated_at)}. ID `, h('code', {}, template.id))),
              h('a', { class: 'btn btn-secondary btn-sm', href: editorHash(template.id), 'aria-label': `Edit ${template.name}` }, 'Edit'),
            ),
          ),
        );

  const node = h(
    'div',
    { class: 'panel-stack' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', {}, 'Templates'),
      h('p', { class: 'lead-sm' }, 'A template is HTML and CSS with {{placeholders}}. Use a starter as it is, or duplicate one and make it yours.'),
    ),
    error,
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'mine-title' },
      h(
        'div',
        { class: 'section-row' },
        h('h3', { id: 'mine-title', class: 'kicker' }, `Your templates (${templates.custom.length} of ${ctx.me.limits.templates})`),
        templates.custom.length > 0 ? button('New blank template', { small: true, onclick: (event) => blank(event.currentTarget) }) : null,
      ),
      mine,
    ),
    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'starter-title' },
      h('h3', { id: 'starter-title', class: 'kicker' }, 'Starter templates'),
      h(
        'ul',
        { class: 'starter-grid' },
        templates.starter.map((starter) =>
          h(
            'li',
            { class: 'starter' },
            h('img', { src: `/assets/img/samples/${starter.id}.png`, alt: `The ${starter.name} starter template`, width: 1200, height: 630, loading: 'lazy' }),
            h(
              'div',
              { class: 'starter-body' },
              h('h4', {}, starter.name, ' ', h('code', {}, starter.id)),
              h('p', { class: 'hint' }, starter.description),
              button('Duplicate to edit', { small: true, 'aria-label': `Duplicate ${starter.name} to edit`, onclick: (event) => duplicate(starter, event.currentTarget) }),
            ),
          ),
        ),
      ),
    ),
  );
  return { node };
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

/** A code textarea in which Tab indents. Esc, then Tab, moves on: the keyboard is never trapped. */
function codeArea(value, rows) {
  const area = h('textarea', { class: 'textarea code-input', rows, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
  area.value = value;
  let released = false;
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      released = true;
      return;
    }
    if (event.key === 'Tab' && !released && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const next = insertIndent(area.value, area.selectionStart, area.selectionEnd);
      area.value = next.value;
      area.selectionStart = area.selectionEnd = next.caret;
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
    released = false;
  });
  area.addEventListener('blur', () => {
    released = false;
  });
  return area;
}

async function editorView(ctx, id) {
  const { template } = await api.get(`/api/templates/${encodeURIComponent(id)}`);
  let saved = { name: template.name, html: template.html, css: template.css };
  const state = { size: 'og', sample: memory.get(sampleKey(id)) ?? {}, fieldNames: null };

  const name = h('input', { class: 'input', type: 'text', value: template.name, required: true, maxlength: 80, autocomplete: 'off' });
  const html = codeArea(template.html, 16);
  const css = codeArea(template.css, 16);
  const preview = createPreview();
  const error = errorSlot();
  const saveNotes = h('div', { class: 'alert alert-warn', role: 'status', hidden: true });
  const unsaved = h('span', { class: 'badge badge-warn', hidden: true }, 'Unsaved changes');
  const version = h('span', { class: 'hint' });
  const save = button('Save template', { variant: 'primary' });
  const sampleFields = h('div', { class: 'builder-fields' });

  const isDirty = () => name.value !== saved.name || html.value !== saved.html || css.value !== saved.css;
  const showVersion = (row) => {
    version.textContent = `Version ${row.version}, saved ${formatDateTime(row.updated_at)}`;
  };
  showVersion(template);

  const refresh = () => preview.show({ html: html.value, css: css.value, data: cardData(state.sample), size: state.size });
  const refreshSoon = debounce(refresh);

  /** One sample input per placeholder; rebuilt only when the set of placeholders changes, so typing keeps focus. */
  function syncSampleFields() {
    const specs = customTemplateFields(html.value, css.value);
    const names = specs.map((spec) => spec.name).join(',');
    if (names === state.fieldNames) return;
    state.fieldNames = names;
    state.sample = initialValues(specs, state.sample, sampleValue);
    clear(sampleFields).append(
      ...specs.map((spec) =>
        fieldControl(spec, state.sample[spec.name], {
          name: `sample-${spec.name}`,
          lightValue: 'light',
          onchange: (value) => {
            state.sample[spec.name] = value;
            memory.set(sampleKey(id), state.sample);
            refreshSoon();
          },
        }),
      ),
    );
    if (specs.length === 0) sampleFields.append(h('p', { class: 'hint' }, 'No placeholders yet. Write {{title}} in the HTML and an input for it appears here.'));
  }

  const edited = () => {
    unsaved.hidden = !isDirty();
    syncSampleFields();
    refreshSoon();
  };
  html.addEventListener('input', edited);
  css.addEventListener('input', edited);
  name.addEventListener('input', () => {
    unsaved.hidden = !isDirty();
  });

  save.addEventListener('click', async () => {
    error.hidden = true;
    saveNotes.hidden = true;
    try {
      const sent = { name: name.value, html: html.value, css: css.value };
      const result = await withBusy(save, () => api.put(`/api/templates/${encodeURIComponent(id)}`, sent));
      saved = { name: result.template.name, html: sent.html, css: sent.css };
      name.value = result.template.name;
      unsaved.hidden = !isDirty();
      showVersion(result.template);
      if (result.warnings.length > 0) {
        saveNotes.replaceChildren(h('strong', {}, 'Saved, with notes from the renderer:'), h('ul', {}, result.warnings.map((warning) => h('li', {}, warning))));
        saveNotes.hidden = false;
      }
      toast('Template saved.');
    } catch (failure) {
      showError(error, failure);
    }
  });

  async function remove() {
    const confirmed = await confirmDialog({
      title: `Delete ${saved.name}?`,
      body: 'Signed URLs and API calls that use this template fail from now on. Cards that are already cached keep working until they expire. This cannot be undone.',
      confirmLabel: 'Delete template',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/templates/${encodeURIComponent(id)}`);
      // Nothing left to lose: do not ask about unsaved changes on the way out.
      saved = { name: name.value, html: html.value, css: css.value };
      toast('Template deleted.');
      location.hash = '#templates';
    } catch (failure) {
      showError(error, failure);
    }
  }

  syncSampleFields();
  refresh();

  const node = h(
    'div',
    { class: 'panel-stack' },
    h(
      'header',
      { class: 'editor-bar' },
      h('div', {}, h('a', { class: 'back-link', href: '#templates' }, 'All templates'), h('h2', {}, 'Edit template')),
      h('div', { class: 'editor-save' }, unsaved, version, save),
    ),
    error,
    saveNotes,
    h(
      'div',
      { class: 'editor' },
      h(
        'div',
        { class: 'editor-code stack' },
        field('Name', name),
        field('HTML', html, 'Write {{title}} where the title should go. Tab indents; press Esc, then Tab, to move to the next field.'),
        field('CSS', css),
        h('p', { class: 'hint id-line' }, 'Template ID ', h('code', {}, id), copyButton('Copy', () => id), ' Use it as the template in signed URLs and API calls.'),
        h('details', { class: 'more' }, h('summary', {}, 'Delete this template'), h('div', { class: 'more-body' }, button('Delete template', { variant: 'danger', small: true, onclick: remove }))),
      ),
      h(
        'div',
        { class: 'editor-side stack' },
        segmented(
          'editor-size',
          'Preview size',
          ctx.config.sizes.map(sizeOption),
          state.size,
          (value) => {
            state.size = value;
            refresh();
          },
        ),
        preview.node,
        h('fieldset', { class: 'stack' }, h('legend', { class: 'kicker' }, 'Sample data for the preview'), sampleFields),
      ),
    ),
  );

  return {
    node,
    isDirty,
    destroy() {
      refreshSoon.cancel();
      preview.destroy();
    },
  };
}

export function mount(ctx, param) {
  return param ? editorView(ctx, param) : listView(ctx);
}
