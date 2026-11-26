// The card builder: pick a template, fill in its fields, watch the preview and
// get the signed URL with its meta tags. The first-run guide and the Sites tab
// both use it. Signing renders nothing and counts nothing, so the output simply
// follows the form.
//
// While GET /api/config switches open fields on (email_fields), the Sites tab's builder also
// offers them: chosen fields are left out of the signature for an email platform to fill in,
// and the output is an <img> tag for an email instead of meta tags.
import { api } from './client.js';
import { button, clear, codeBlock, copyButton, errorSlot, field, h, memory, segmented, showError, withBusy } from './dom.js';
import {
  cardData,
  customTemplateFields,
  emailImageTag,
  fieldLabel,
  formatCount,
  initialValues,
  openFieldCandidates,
  openFieldsSettings,
  sampleValue,
  signRequest,
  sizeOption,
  starterValues,
} from './helpers.js';
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
 * @param options    compact: tuck size and format away; oncopied: after the meta tags were copied;
 *                   prefill: starting values for fields the template has, e.g. { title } from the OG checker;
 *                   outputTitle: the caller's heading over the output, renamed while open fields are chosen
 * @returns { form, output, destroy }: two nodes, so a caller can lay them out as two steps
 */
export function createBuilder(ctx, { sites, templates, compact = false, oncopied, prefill = {}, outputTitle = null }) {
  const uid = `builder-${++builders}`;
  const everyTemplate = [...templates.starter, ...templates.custom];
  // open: per template, the fields left for an email platform to fill in (empty: an ordinary card URL).
  const state = { siteId: sites[0].id, templateId: everyTemplate[0].id, size: 'og', format: 'png', values: {}, open: {} };
  const preview = createPreview();
  // Open fields belong to the Sites tab's full builder, and only while the server switches them on.
  const openSettings = compact ? null : openFieldsSettings(ctx.config);
  const openNow = () => state.open[state.templateId] ?? [];

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
            h('p', { class: 'hint' }, h('a', { href: '/docs/signed-urls' }, 'Read the signing guide, with code for JavaScript, PHP and Python')),
          ),
        ),
  );
  /* ---- output for an email: the <img> tag, with the open fields left empty at the end ---- */
  const emailTag = codeBlock('', 'html');
  const emailUrl = codeBlock('', 'url');
  const emailSlots = h('p', { class: 'hint' });
  const emailOpen = h('a', { class: 'btn btn-secondary btn-sm', target: '_blank', rel: 'noopener' }, 'Open the image with the defaults');
  const perDay = openSettings?.maxUniqueRendersPerDay?.[ctx.me.user.plan];
  const emailResult = openSettings
    ? h(
        'div',
        { class: 'stack', hidden: true },
        h('p', { class: 'hint' }, 'Put this tag into the HTML of your email. It shows the image at half its size, so it stays sharp on high-density screens.'),
        emailTag.block,
        h('div', { class: 'cluster' }, copyButton('Copy the image tag', () => emailTag.code.textContent, { variant: 'primary', small: false }), emailSlots),
        h(
          'p',
          { class: 'alert alert-info' },
          h('strong', {}, 'Nothing has been rendered or counted yet. '),
          'Each different set of values is rendered the first time an email app loads the image, and counts as one image; the same values again come from the cache.',
          Number.isInteger(perDay)
            ? ` Each site renders up to ${formatCount(perDay)} new sets of values a day on your plan. After that, a new value gets the defaults until 00:00 UTC.`
            : '',
        ),
        h(
          'details',
          { class: 'more' },
          h('summary', {}, 'The image URL on its own'),
          h('div', { class: 'stack more-body' }, emailUrl.block, h('div', { class: 'cluster' }, emailOpen, h('span', { class: 'hint' }, 'Opening it renders the defaults and counts one image the first time.'))),
        ),
      )
    : null;

  const pending = h('p', { class: 'hint' }, 'Preparing your meta tags…');
  const output = h('div', { class: 'builder-output stack' }, pending, signError, result, emailResult);

  let signRun = 0;
  async function refresh() {
    const values = state.values[state.templateId] ?? {};
    const data = cardData(values);
    // The preview shows what a reader whose value is missing sees: every open field at its default.
    preview.show({ template: state.templateId, data, size: state.size, format: state.format });
    const openFields = openSettings ? openNow() : [];
    const run = ++signRun;
    try {
      const signed = await api.post('/api/sign', signRequest({ siteId: state.siteId, template: state.templateId, format: state.format, size: state.size, values, open: openFields }));
      if (run !== signRun) return;
      if (openFields.length > 0) {
        const size = ctx.config.sizes.find((candidate) => candidate.id === state.size) ?? ctx.config.sizes[0];
        emailTag.code.textContent = emailImageTag(signed.url, size, data.title ?? '');
        emailUrl.code.textContent = signed.url;
        emailOpen.href = signed.url;
        emailSlots.replaceChildren(
          'In your email platform, put the merge tag for ',
          ...openFields.flatMap((name, index) => [index === 0 ? '' : index === openFields.length - 1 ? ' and ' : ', ', h('code', {}, name), ' right after ', h('code', {}, `&${name}=`)]),
          ' at the end of the URL.',
        );
        result.hidden = true;
        emailResult.hidden = false;
        if (outputTitle) outputTitle.textContent = 'Your email image';
      } else {
        meta.code.textContent = signed.meta_tags;
        url.code.textContent = signed.url;
        canonical.code.textContent = signed.canonical;
        open.href = signed.url;
        if (emailResult) emailResult.hidden = true;
        result.hidden = false;
        if (outputTitle) outputTitle.textContent = 'Your meta tags';
      }
      signError.hidden = true;
    } catch (failure) {
      if (run !== signRun) return;
      showError(signError, failure);
      result.hidden = true;
      if (emailResult) emailResult.hidden = true;
    }
    pending.hidden = true;
  }
  const refreshSoon = debounce(refresh);

  /* ---- form: site, template, fields, open fields, size, format ---- */
  const fields = h('div', { class: 'builder-fields' });
  const fieldsError = errorSlot();
  const openChoices = h('div', { class: 'open-fields-list' });
  const openNote = h('p', { class: 'hint' });
  const openBox = openSettings
    ? h(
        'details',
        { class: 'more open-fields' },
        h('summary', {}, 'Personalize for email: open fields'),
        h(
          'div',
          { class: 'stack more-body' },
          h(
            'p',
            { class: 'hint' },
            'An open field is left out of the signature, so your email platform can fill in each reader\'s own value, such as a first name, when it sends. What you typed in that field above becomes its default: the image shows it when a reader\'s value is missing or cannot be used.',
          ),
          openChoices,
          openNote,
        ),
      )
    : null;

  /** The open-field checkboxes for the template's fields; at most maxOpenFields can be ticked. */
  function renderOpenChoices(specs) {
    if (!openSettings) return;
    const candidates = openFieldCandidates(specs);
    const chosen = (state.open[state.templateId] ??= []).filter((name) => candidates.includes(name));
    state.open[state.templateId] = chosen;
    const max = openSettings.maxOpenFields;
    const boxes = candidates.map((name) => {
      const box = h('input', {
        type: 'checkbox',
        checked: chosen.includes(name),
        onchange: () => {
          const list = state.open[state.templateId];
          if (box.checked && !list.includes(name)) list.push(name);
          if (!box.checked) list.splice(list.indexOf(name), 1);
          limit();
          refresh();
        },
      });
      return { name, box, node: h('label', { class: 'check' }, box, h('span', {}, fieldLabel(name), ' ', h('code', {}, name))) };
    });
    const limit = () => {
      const full = max !== null && state.open[state.templateId].length >= max;
      for (const { box } of boxes) box.disabled = full && !box.checked;
    };
    clear(openChoices).append(...boxes.map(({ node }) => node));
    if (boxes.length === 0) openChoices.append(h('p', { class: 'hint' }, 'This template has no text field that can be open.'));
    const limits = [];
    if (max !== null) limits.push(`Choose up to ${formatCount(max)}.`);
    if (openSettings.maxValueChars !== null) {
      limits.push(`A reader's value can have up to ${formatCount(openSettings.maxValueChars)} characters: letters, digits, spaces and . , ' - ! ? & @ #. Anything else shows the default.`);
    }
    openNote.textContent = limits.join(' ');
    limit();
  }

  async function fieldSpecs(templateId) {
    const starter = templates.starter.find((template) => template.id === templateId);
    if (starter) return { specs: starter.fields, values: starterValues(starter.fields, starter.sample), lightValue: '' };
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
      state.values[templateId] ??= { ...values, ...Object.fromEntries(specs.filter((spec) => prefill[spec.name]).map((spec) => [spec.name, prefill[spec.name]])) };
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
      renderOpenChoices(specs);
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
            : h('span', { class: 'thumb-blank thumb-own', 'aria-hidden': 'true' }, '{{ }}'),
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
      openBox,
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
