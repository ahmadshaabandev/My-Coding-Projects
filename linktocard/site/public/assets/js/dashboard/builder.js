// The card builder: pick a template, fill in its fields, watch the preview and
// get the signed URL with its meta tags. The first-run guide and the Sites tab
// both use it. Signing renders nothing and counts nothing, so the output simply
// follows the form.
import { api } from './client.js';
import { button, clear, codeBlock, copyButton, errorSlot, field, h, memory, segmented, showError, withBusy } from './dom.js';
import { cardData, customTemplateFields, fieldLabel, initialValues, sampleValue, sizeOption } from './helpers.js';
import { createPreview, debounce } from './preview.js';

/** Where the template editor keeps the sample data typed for a custom template. */
export const sampleKey = (templateId) => `ltc:sample:${templateId}`;

let builders = 0;

/** One input for one template field. `theme` is a switch; everything else is text. */
export function fieldControl(spec, value, { name, lightValue, onchange }) {
  if (spec.name === 'theme') {
    const options = [
      { value: lightValue, label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ];
    return segmented(name, 'Theme', options, value === 'dark' ? 'dark' : lightValue, onchange);
  }
  const input = h('input', {
    class: 'input',
    type: 'text',
    value,
    placeholder: spec.example || undefined,
    required: spec.required,
    autocomplete: 'off',
    oninput: () => onchange(input.value),
  });
  const control = field(spec.required ? fieldLabel(spec.name) : `${fieldLabel(spec.name)} (optional)`, input, spec.description);
  if (spec.name === 'title' || spec.name === 'description') control.classList.add('field-wide');
  return control;
}

/**
 * @param ctx        the dashboard context (config for sizes, formats and cache days)
 * @param sites      the account's sites (at least one)
 * @param templates  GET /api/templates
 * @param options    compact: tuck size and format away; oncopied: after the meta tags were copied
 * @returns { form, output, destroy }: two nodes, so a caller can lay them out as two steps
 */
export function createBuilder(ctx, { sites, templates, compact = false, oncopied }) {
  const uid = `builder-${++builders}`;
  const everyTemplate = [...templates.starter, ...templates.custom];
  const state = { siteId: sites[0].id, templateId: everyTemplate[0].id, size: 'og', format: 'png', values: {} };
  const preview = createPreview();

  /* ---- output: meta tags, the URL, the plain rule about counting ---- */
  const meta = codeBlock('', 'html');
  const url = codeBlock('', 'url');
  const canonical = codeBlock('', 'signed string');
  const open = h('a', { class: 'btn btn-secondary btn-sm', target: '_blank', rel: 'noopener' }, 'Open the image');
  const signError = errorSlot();
  const cacheDays = ctx.me.usage.cache_days;
  const result = h(
    'div',
    { class: 'stack', hidden: true },
    meta.block,
    h(
      'div',
      { class: 'cluster' },
      copyButton('Copy meta tags', () => meta.code.textContent, { variant: 'primary', small: false, oncopied }),
      h('span', { class: 'hint' }, 'Paste them into the <head> of your page.'),
    ),
    h(
      'p',
      { class: 'alert alert-info' },
      h('strong', {}, 'Nothing has been rendered or counted yet. '),
      `The first time anyone opens the image URL, the card is rendered and counts as one image. After that it is served from the cache for ${cacheDays} days without counting again.`,
    ),
    h(
      'details',
      { class: 'more' },
      h('summary', {}, 'The image URL on its own'),
      h('div', { class: 'stack more-body' }, url.block, h('div', { class: 'cluster' }, open, h('span', { class: 'hint' }, 'Opening it renders the card and counts one image the first time.'))),
    ),
    compact
      ? null
      : h(
          'details',
          { class: 'more' },
          h('summary', {}, 'Signing URLs in your own code'),
          h(
            'div',
            { class: 'stack more-body' },
            h('p', { class: 'hint' }, 'To make a card for every page, sign URLs on your server with the site\'s signing secret. This is the exact string that was signed for the URL above (HMAC-SHA256, hex), so you can compare it with your own signer\'s. '),
            canonical.block,
            h('p', { class: 'hint' }, h('a', { href: '/docs' }, 'Read the signing guide in the docs')),
          ),
        ),
  );
  const pending = h('p', { class: 'hint' }, 'Preparing your meta tags…');
  const output = h('div', { class: 'builder-output stack' }, pending, signError, result);

  let signRun = 0;
  async function refresh() {
    const data = cardData(state.values[state.templateId] ?? {});
    preview.show({ template: state.templateId, data, size: state.size, format: state.format });
    const run = ++signRun;
    try {
      const signed = await api.post('/api/sign', { site_id: state.siteId, template: state.templateId, format: state.format, size: state.size, data });
      if (run !== signRun) return;
      meta.code.textContent = signed.meta_tags;
      url.code.textContent = signed.url;
      canonical.code.textContent = signed.canonical;
      open.href = signed.url;
      signError.hidden = true;
      result.hidden = false;
    } catch (failure) {
      if (run !== signRun) return;
      showError(signError, failure);
      result.hidden = true;
    }
    pending.hidden = true;
  }
  const refreshSoon = debounce(refresh);

  /* ---- form: site, template, fields, size, format ---- */
  const fields = h('div', { class: 'builder-fields' });
  const fieldsError = errorSlot();

  async function fieldSpecs(templateId) {
    const starter = templates.starter.find((template) => template.id === templateId);
    if (starter) return { specs: starter.fields, values: initialValues(starter.fields, starter.sample), lightValue: '' };
    // A custom template is read fresh: it may have been edited since the list was loaded.
    const { template } = await api.get(`/api/templates/${encodeURIComponent(templateId)}`);
    const specs = customTemplateFields(template.html, template.css);
    return { specs, values: initialValues(specs, memory.get(sampleKey(templateId)) ?? {}, sampleValue), lightValue: 'light' };
  }

  async function selectTemplate(templateId) {
    state.templateId = templateId;
    fieldsError.hidden = true;
    try {
      const { specs, values, lightValue } = await fieldSpecs(templateId);
      if (state.templateId !== templateId) return;
      state.values[templateId] ??= values;
      clear(fields).append(
        ...specs.map((spec) =>
          fieldControl(spec, state.values[templateId][spec.name] ?? '', {
            name: `${uid}-${spec.name}`,
            lightValue,
            onchange: (value) => {
              state.values[templateId][spec.name] = value;
              refreshSoon();
            },
          }),
        ),
      );
      if (specs.length === 0) fields.append(h('p', { class: 'hint' }, 'This template has no {{placeholders}}, so there is nothing to fill in.'));
      refresh();
    } catch (failure) {
      showError(fieldsError, failure);
    }
  }

  const sitePicker =
    sites.length > 1
      ? field(
          'Site',
          h(
            'select',
            {
              class: 'select',
              onchange: (event) => {
                state.siteId = event.target.value;
                refresh();
              },
            },
            sites.map((site) => h('option', { value: site.id }, site.name)),
          ),
          'The URL is signed with this site\'s secret.',
        )
      : null;

  const templatePicker = h(
    'fieldset',
    { class: 'builder-templates' },
    h('legend', { class: 'label' }, 'Template'),
    h(
      'div',
      { class: 'thumbs' },
      everyTemplate.map((template) =>
        h(
          'label',
          { class: 'thumb' },
          h('input', { type: 'radio', name: `${uid}-template`, value: template.id, checked: template.id === state.templateId, onchange: () => selectTemplate(template.id) }),
          templates.starter.includes(template)
            ? h('img', { src: `/assets/img/samples/${template.id}.png`, alt: '', width: 1200, height: 630 })
            : h('span', { class: 'thumb-blank' }),
          h('span', {}, template.name),
        ),
      ),
    ),
  );

  const shape = h(
    'div',
    { class: 'builder-shape' },
    segmented(
      `${uid}-size`,
      'Size',
      ctx.config.sizes.map(sizeOption),
      state.size,
      (value) => {
        state.size = value;
        refresh();
      },
    ),
    segmented(
      `${uid}-format`,
      'Format',
      ctx.config.formats.map((format) => ({ value: format, label: format === 'jpeg' ? 'JPG' : format.toUpperCase() })),
      state.format,
      (value) => {
        state.format = value;
        refresh();
      },
    ),
  );

  const form = h(
    'div',
    { class: 'builder' },
    h(
      'div',
      { class: 'builder-inputs stack' },
      sitePicker,
      templatePicker,
      fields,
      fieldsError,
      compact ? h('details', { class: 'more' }, h('summary', {}, 'Size and format'), h('div', { class: 'more-body' }, shape)) : shape,
    ),
    preview.node,
  );

  selectTemplate(state.templateId);

  return {
    form,
    output,
    destroy() {
      refreshSoon.cancel();
      preview.destroy();
    },
  };
}

/** The small "name it, create it" form used wherever a first site is needed. */
export function siteForm({ label, hint, value = '', submitLabel, variant = 'primary', oncreated }) {
  const input = h('input', { class: 'input', type: 'text', value, required: true, maxlength: 80, autocomplete: 'off' });
  const error = errorSlot();
  const submit = button(submitLabel, { variant, type: 'submit' });
  return h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        try {
          oncreated(await withBusy(submit, () => api.post('/api/sites', { name: input.value })));
        } catch (failure) {
          showError(error, failure);
        }
      },
    },
    field(label, input, hint),
    submit,
    error,
  );
}
