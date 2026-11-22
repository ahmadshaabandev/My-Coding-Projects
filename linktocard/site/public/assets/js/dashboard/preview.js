// The live preview frame, shared by the card builder and the template editor.
// It renders through POST /api/preview: watermarked, never stored, never counted.
import { api } from './client.js';
import { errorSlot, h, showError } from './dom.js';

export function createPreview() {
  const image = h('img', { alt: 'Preview of the card', hidden: true });
  const status = h('p', { class: 'unfurl-status' }, 'Rendering the first preview…');
  const frame = h('div', { class: 'unfurl-frame preview-frame', 'data-size': 'og', 'aria-busy': 'true' }, image, status);
  const error = errorSlot();
  const warnings = h('div', { class: 'alert alert-warn preview-warnings', role: 'status', hidden: true });
  const node = h(
    'div',
    { class: 'preview' },
    h('div', { class: 'unfurl preview-card' }, frame, h('p', { class: 'preview-note' }, 'Live preview. Watermarked, never counted.')),
    error,
    warnings,
  );

  let controller = null;
  let objectUrl = null;

  function showWarnings(list) {
    warnings.replaceChildren(
      h('strong', {}, list.length === 1 ? 'The renderer has one note:' : `The renderer has ${list.length} notes:`),
      h('ul', {}, list.map((warning) => h('li', {}, warning))),
    );
    warnings.hidden = list.length === 0;
  }

  /** Renders `payload` (the body of POST /api/preview). A newer call cancels an older one. */
  async function show(payload) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    frame.setAttribute('aria-busy', 'true');
    try {
      const result = await api.preview(payload, mine.signal);
      if (mine !== controller) return;
      const next = URL.createObjectURL(result.blob);
      image.src = next;
      image.hidden = false;
      status.hidden = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = next;
      frame.dataset.size = payload.size ?? 'og';
      error.hidden = true;
      showWarnings(result.warnings);
    } catch (failure) {
      if (failure?.name === 'AbortError' || mine !== controller) return;
      // The last good image stays (dimmed by nothing): the message says why the new one did not arrive.
      showError(error, failure);
      status.textContent = 'No preview: see the message below.';
      warnings.hidden = true;
    }
    if (mine === controller) frame.removeAttribute('aria-busy');
  }

  function destroy() {
    controller?.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  return { node, frame, show, destroy };
}

/** Calls `run` once things have been quiet for `ms`: one render per pause in typing, not per key. */
export function debounce(run, ms = 500) {
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  schedule.cancel = () => clearTimeout(timer);
  return schedule;
}
