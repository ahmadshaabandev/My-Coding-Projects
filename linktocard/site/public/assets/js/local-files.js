// The file list shared by the in-browser PDF tools, /tools/merge-pdf and /tools/image-to-pdf:
// a drop zone (the whole page takes dropped files), a list that can be reordered by dragging or
// with buttons, the size limits, and the download of the result.
//
// Privacy, which the pages state: files are read with File.arrayBuffer() and handed to the
// engine, ./vendor/pdf-local.js (site/src-browser/pdf-local.ts, bundled with pdf-lib), which
// only turns bytes into bytes. Nothing here, and nothing in the engine, makes a network request:
// no fetch, XMLHttpRequest, sendBeacon, WebSocket or form submission. Previews and the download
// are blob: URLs, which point at memory in this tab. tests/node/client-pdf.test.ts checks the
// sources for those APIs; a browser check records every request the pages make.
//
// File names are only ever set with textContent or as attribute values, never parsed as HTML.

/** The engine, loaded on first use so the page itself stays small. Relative to this module. */
export const ENGINE_URL = './vendor/pdf-local.js';

let engine = null;
/** The engine module (cached); a failed load is retried on the next call. */
export function loadEngine() {
  engine ??= import(ENGINE_URL).catch((error) => {
    engine = null;
    throw error;
  });
  return engine;
}

/* ------------------------------------------------------------------ pure helpers */

/** "48 KB", "1.2 MB", "512 bytes" */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1 page", "3 pages" */
export function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The limits of a tool, from its form's data attributes (the page prints them from LOCAL_PDF in
 * src/config.ts at build time). A missing or broken attribute counts as 0, which refuses every
 * file: better than an unlimited tool.
 */
export function readLimits(dataset) {
  const number = (value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    maxFiles: number(dataset?.maxFiles),
    maxTotalBytes: number(dataset?.maxBytes),
    maxPages: number(dataset?.maxPages),
    maxImagePixels: number(dataset?.maxPixels),
  };
}

/**
 * Which of the files just chosen fit beside the ones already in the list (`current`, with a
 * `size` each), in the order chosen: { accept: File[], refuse: [{ name, message }] }. A file that
 * would pass the file count or the total size is refused with the reason; later, smaller files
 * may still fit.
 */
export function planAdd(current, incoming, limits, noun = 'file') {
  const accept = [];
  const refuse = [];
  let count = current.length;
  let total = totalSize(current);
  for (const file of incoming) {
    if (file.size === 0) {
      refuse.push({ name: file.name, message: `“${file.name}” is empty.` });
    } else if (count + 1 > limits.maxFiles) {
      refuse.push({ name: file.name, message: `“${file.name}” was not added: this page takes up to ${plural(limits.maxFiles, noun)} at a time.` });
    } else if (total + file.size > limits.maxTotalBytes) {
      refuse.push({
        name: file.name,
        message: `“${file.name}” (${formatSize(file.size)}) was not added: the files may be ${formatSize(limits.maxTotalBytes)} together, and the list already has ${formatSize(total)}.`,
      });
    } else {
      accept.push(file);
      count += 1;
      total += file.size;
    }
  }
  return { accept, refuse };
}

/** A copy of `items` with the item at `from` moved to index `to` (both clamped to the list). */
export function moveItem(items, from, to) {
  const list = [...items];
  if (from < 0 || from >= list.length) return list;
  const [item] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, item);
  return list;
}

/** Sorted by file name the way people number files: "page 2" before "page 10". */
export function sortByName(items) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => collator.compare(a.name, b.name));
}

/** Bytes the list holds. */
export function totalSize(items) {
  return items.reduce((sum, item) => sum + item.size, 0);
}

/** An error whose message is meant for the visitor (the engine's LocalPdfError is one too). */
export function refusal(message) {
  const error = new Error(message);
  error.name = 'LocalFileError';
  return error;
}

/** The message for an error thrown while reading or making a file; `fallback` for anything unexpected. */
export function errorMessage(error, fallback) {
  const ours = error && typeof error === 'object' && (error.name === 'LocalPdfError' || error.name === 'LocalFileError');
  return ours && typeof error.message === 'string' && error.message !== '' ? error.message : fallback;
}

/* ------------------------------------------------------------------ DOM */

/** createElement with attributes and children. Strings become text nodes; nothing is parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === '') continue;
    node.append(child);
  }
  return node;
}

const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Lets the browser paint a status line before a long piece of work blocks the page. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wires one tool page. `tool`:
 *   noun          'PDF' or 'image', for messages
 *   minFiles      files needed before the button works
 *   outputName    download name of the result
 *   prepare(file, bytes, engine, limits) -> { bytes, detail, thumb? }   checks one file as it is added (throws to refuse it)
 *   run(items, engine, limits, form)     -> { bytes, pages }            makes the result
 *   summary(items)                       -> text under the list
 * Elements (by id): local-form, file-input, drop-zone, file-list, file-summary, local-submit,
 * local-error, local-result, local-result-text, local-download, local-status.
 */
export function setupFileTool(tool) {
  const $ = (id) => document.getElementById(id);
  const form = $('local-form');
  if (!form) return null;
  const input = $('file-input');
  const zone = $('drop-zone');
  const list = $('file-list');
  const summary = $('file-summary');
  const submit = $('local-submit');
  const errorBox = $('local-error');
  const result = $('local-result');
  const resultText = $('local-result-text');
  const download = $('local-download');
  const status = $('local-status');
  const sortButton = form.querySelector('[data-sort]');
  const clearButton = form.querySelector('[data-clear]');
  const limits = readLimits(form.dataset);

  let items = [];
  let nextId = 1;
  let busy = false;
  let queue = Promise.resolve();
  let resultUrl = null;
  let dragged = null;

  function say(text) {
    status.textContent = text;
  }

  function showErrors(messages) {
    errorBox.replaceChildren();
    if (messages.length === 0) {
      errorBox.hidden = true;
      return;
    }
    if (messages.length === 1) errorBox.append(el('p', {}, messages[0]));
    else errorBox.append(el('p', {}, 'Some files were not added:'), el('ul', {}, messages.map((message) => el('li', {}, message))));
    errorBox.hidden = false;
  }

  function clearResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    result.hidden = true;
    download.removeAttribute('href');
  }

  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    submit.setAttribute('aria-busy', String(value));
    render();
  }

  function render() {
    list.replaceChildren(
      ...items.map((item, index) => {
        const name = item.name;
        const buttons = [
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-move': '-1', 'aria-label': `Move ${name} up`, disabled: busy || index === 0 }, 'Up'),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-move': '1', 'aria-label': `Move ${name} down`, disabled: busy || index === items.length - 1 }, 'Down'),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-remove': '', 'aria-label': `Remove ${name}`, disabled: busy }, 'Remove'),
        ];
        return el(
          'li',
          { class: 'file-item', draggable: busy ? 'false' : 'true', 'data-id': item.id },
          el('span', { class: 'file-position', 'aria-hidden': 'true' }, String(index + 1)),
          item.thumb ? el('img', { class: 'file-thumb', src: item.thumb, alt: '', width: 48, height: 48, loading: 'lazy', decoding: 'async' }) : null,
          el('span', { class: 'file-meta' }, el('span', { class: 'file-name' }, name), el('span', { class: 'file-detail' }, `${item.detail} · ${formatSize(item.size)}`)),
          el('span', { class: 'file-buttons' }, buttons),
        );
      }),
    );
    list.hidden = items.length === 0;
    summary.textContent = items.length === 0 ? `No ${tool.noun}s yet.` : tool.summary(items);
    submit.disabled = busy || items.length < tool.minFiles;
    if (sortButton) sortButton.disabled = busy || items.length < 2;
    if (clearButton) clearButton.disabled = busy || items.length === 0;
    input.disabled = busy;
  }

  function changed() {
    clearResult();
    render();
  }

  function forget(item) {
    if (item.thumb) URL.revokeObjectURL(item.thumb);
  }

  async function addFiles(files) {
    const { accept, refuse } = planAdd(items, files, limits, tool.noun);
    const problems = refuse.map((entry) => entry.message);
    if (accept.length === 0) {
      showErrors(problems);
      if (problems.length > 0) say(problems[0]);
      return;
    }
    setBusy(true);
    let added = 0;
    try {
      say(`Reading ${plural(accept.length, tool.noun)}…`);
      await nextFrame();
      const lib = await loadEngine();
      for (const file of accept) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const prepared = await tool.prepare(file, bytes, lib, limits);
          items.push({ id: nextId++, name: file.name, size: prepared.bytes.byteLength, ...prepared });
          added += 1;
        } catch (error) {
          problems.push(errorMessage(error, `“${file.name}” could not be read.`));
        }
      }
    } catch {
      problems.push('The PDF code could not be loaded. Check your connection and reload the page.');
    }
    clearResult();
    setBusy(false);
    showErrors(problems);
    say(`${plural(added, tool.noun)} added. ${tool.summary(items) || ''}`.trim());
  }

  function enqueue(files) {
    const chosen = Array.from(files ?? []);
    if (chosen.length === 0) return;
    queue = queue.then(() => addFiles(chosen));
  }

  input.addEventListener('change', () => {
    enqueue(input.files);
    input.value = '';
  });

  // Files dropped anywhere on the page are added (and the browser does not open them instead).
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
    zone.classList.add('is-dragging');
  });
  document.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) zone.classList.remove('is-dragging');
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.remove('is-dragging');
    // While a PDF is being made the list must not change under it.
    if (busy) say('The page is still working. Drop the files again when it is done.');
    else enqueue(event.dataTransfer.files);
  });

  // Reordering: drag a row onto another (it lands before or after, by which half it is dropped on).
  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.file-item');
    if (!row || busy) return;
    dragged = Number(row.dataset.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', row.querySelector('.file-name')?.textContent ?? '');
    row.classList.add('is-dragged');
  });
  list.addEventListener('dragend', () => {
    dragged = null;
    for (const row of list.querySelectorAll('.is-dragged, .drop-before, .drop-after')) row.classList.remove('is-dragged', 'drop-before', 'drop-after');
  });
  list.addEventListener('dragover', (event) => {
    if (dragged === null || hasFiles(event)) return;
    const row = event.target.closest?.('.file-item');
    if (!row) return;
    event.preventDefault();
    const box = row.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    for (const other of list.querySelectorAll('.drop-before, .drop-after')) other.classList.remove('drop-before', 'drop-after');
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (event) => {
    if (dragged === null || hasFiles(event)) return;
    const row = event.target.closest?.('.file-item');
    event.preventDefault();
    const from = items.findIndex((item) => item.id === dragged);
    if (!row || from < 0) return;
    const target = items.findIndex((item) => item.id === Number(row.dataset.id));
    const after = row.classList.contains('drop-after');
    const to = target + (after ? 1 : 0) - (from < target ? 1 : 0);
    const id = dragged;
    const { name } = items[from];
    items = moveItem(items, from, to);
    changed();
    say(`${name} moved to position ${items.findIndex((item) => item.id === id) + 1} of ${items.length}.`);
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    const row = button?.closest('.file-item');
    if (!button || !row || busy) return;
    const index = items.findIndex((item) => item.id === Number(row.dataset.id));
    if (index < 0) return;
    const item = items[index];
    if (button.hasAttribute('data-remove')) {
      forget(item);
      items = items.filter((other) => other !== item);
      changed();
      say(`${item.name} removed. ${items.length === 0 ? `No ${tool.noun}s left.` : tool.summary(items)}`);
      (list.querySelectorAll('[data-remove]')[Math.min(index, items.length - 1)] ?? input).focus();
      return;
    }
    const to = index + Number(button.dataset.move);
    items = moveItem(items, index, to);
    changed();
    say(`${item.name} moved to position ${to + 1} of ${items.length}.`);
    // Keep the focus on the same button of the moved row, so it can be pressed again.
    const moved = list.querySelector(`[data-id="${item.id}"] [data-move="${button.dataset.move}"]`);
    (moved && !moved.disabled ? moved : list.querySelector(`[data-id="${item.id}"] [data-remove]`))?.focus();
  });

  sortButton?.addEventListener('click', () => {
    items = sortByName(items);
    changed();
    say(`Sorted by name. First: ${items[0]?.name ?? ''}.`);
  });

  clearButton?.addEventListener('click', () => {
    for (const item of items) forget(item);
    items = [];
    changed();
    showErrors([]);
    say(`Every ${tool.noun} was removed.`);
  });

  form.addEventListener('change', (event) => {
    // An option changed (paper, fit, ...): an earlier result no longer matches it.
    if (event.target !== input) clearResult();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || items.length < tool.minFiles) return;
    showErrors([]);
    clearResult();
    setBusy(true);
    say(tool.working(items));
    await nextFrame();
    try {
      const lib = await loadEngine();
      const made = await tool.run(items, lib, limits, form);
      resultUrl = URL.createObjectURL(new Blob([made.bytes], { type: 'application/pdf' }));
      download.href = resultUrl;
      download.download = tool.outputName;
      download.textContent = `Download ${tool.outputName}`;
      resultText.textContent = `Your PDF is ready: ${plural(made.pages, 'page')}, ${formatSize(made.bytes.byteLength)}. It was made on this device.`;
      result.hidden = false;
      setBusy(false);
      say(resultText.textContent);
      download.click();
      download.focus();
    } catch (error) {
      setBusy(false);
      showErrors([errorMessage(error, 'The PDF could not be made. Reload the page and try again.')]);
      say(errorBox.textContent);
      errorBox.focus();
    }
  });

  render();
  return { form, add: enqueue };
}
