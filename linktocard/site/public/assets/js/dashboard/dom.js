// DOM building blocks for the dashboard. Everything is made of nodes and
// textContent; there is no innerHTML anywhere, so data can never become markup.

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'required', 'readOnly']);

/**
 * h('a', { class: 'btn', href: '/x', onclick: fn }, 'Text', child) -> element.
 * `on...` keys are listeners, a few form states are set as properties, the
 * rest become attributes. null, undefined and false children and props are skipped.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (PROPERTIES.has(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter((child) => child !== undefined && child !== null && child !== false));
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** A button from the design system. `variant`: primary | secondary | ghost | danger. */
export function button(label, { variant = 'secondary', small = false, type = 'button', onclick, ...attrs } = {}) {
  return h('button', { class: `btn btn-${variant}${small ? ' btn-sm' : ''}`, type, onclick, ...attrs }, label);
}

/** Runs an async action with the button busy and disabled, so a double click cannot send twice. */
export async function withBusy(control, action) {
  control.setAttribute('aria-busy', 'true');
  control.disabled = true;
  try {
    return await action();
  } finally {
    control.removeAttribute('aria-busy');
    control.disabled = false;
  }
}

/** <label class="field"><span class="label">…</span>control<span class="hint">…</span></label> */
export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

/** A radio group in one outline. `options`: [{ value, label, detail? }]. Calls onchange(value). */
export function segmented(name, legend, options, selected, onchange) {
  return h(
    'fieldset',
    { class: 'seg-field' },
    h('legend', { class: 'label' }, legend),
    h(
      'div',
      { class: 'segmented' },
      options.map((option) =>
        h(
          'label',
          {},
          h('input', { type: 'radio', name, value: option.value, checked: option.value === selected, onchange: () => onchange(option.value) }),
          h('span', {}, option.label, option.detail ? h('small', {}, option.detail) : null),
        ),
      ),
    ),
  );
}

/** An inline notice. Errors interrupt (role=alert); everything else is announced politely. */
export function alertBox(kind, ...content) {
  return h('div', { class: `alert alert-${kind}`, role: kind === 'danger' ? 'alert' : 'status' }, ...content);
}

/** Puts a failure's message into a (normally hidden) alert element next to the control that failed. */
export function showError(target, failure) {
  target.textContent = failure?.message || 'Something went wrong. Try again.';
  target.hidden = false;
}

export function errorSlot() {
  return h('p', { class: 'alert alert-danger', role: 'alert', hidden: true });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A code block with the site's Copy button (site.js copies on [data-copy]). */
export function codeBlock(text, lang) {
  const code = h('code', {}, text);
  const block = h('div', { class: 'code-block', 'data-lang': lang }, h('button', { class: 'copy-btn', type: 'button', 'data-copy': true }, 'Copy'), h('pre', {}, code));
  return { block, code };
}

/** A button that copies whatever getText() returns at click time and confirms on its own label. */
export function copyButton(label, getText, { variant = 'secondary', small = true, oncopied } = {}) {
  const control = button(label, {
    variant,
    small,
    onclick: async () => {
      // getText may have to ask the server (a signing secret); a failure there is a failed copy.
      const copied = await Promise.resolve()
        .then(getText)
        .then(copyText, () => false);
      control.textContent = copied ? 'Copied' : 'Copy failed';
      if (copied) oncopied?.();
      setTimeout(() => {
        control.textContent = label;
      }, 1600);
    },
  });
  return control;
}

let toastRegion;

/** A short confirmation in the corner. It lives in a polite live region, so screen readers hear it too. */
export function toast(message, kind = 'ok') {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = h('div', { class: `toast toast-${kind}` }, message);
  toastRegion.append(item);
  setTimeout(() => item.remove(), 4000);
}

/**
 * Asks once, in a sentence, before something that cannot be undone. Resolves
 * true only for the confirm button; Escape and Cancel resolve false. Focus
 * starts on Cancel, the safe answer.
 */
export function confirmDialog({ title, body, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    const dialog = h(
      'dialog',
      { class: 'modal', 'aria-labelledby': 'confirm-title' },
      h(
        'form',
        { method: 'dialog' },
        h('div', { class: 'modal-header' }, h('h2', { id: 'confirm-title' }, title)),
        h('div', { class: 'modal-body' }, h('p', {}, body)),
        h(
          'div',
          { class: 'modal-footer' },
          button('Cancel', { type: 'submit', value: 'cancel', autofocus: true }),
          button(confirmLabel, { variant: danger ? 'danger' : 'primary', type: 'submit', value: 'confirm' }),
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'confirm');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Per-browser memory (guide progress, sample data). Storage can be blocked; the dashboard works without it. */
export const memory = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode or blocked storage: nothing to remember, nothing breaks.
    }
  },
};
