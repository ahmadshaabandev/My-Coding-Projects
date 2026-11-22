// Landing-page playground: renders a preview through GET /playground/card.png
// and keeps the "Copy meta tag" snippet in step with the form.
import { errorMessage } from './api.js';

const FIELDS = ['template', 'title', 'description', 'author', 'theme'];
const DEBOUNCE_MS = 500;

/** Query string for the fields that are filled in, in a stable order. */
function query(values, names) {
  const params = new URLSearchParams();
  for (const name of names) {
    if (values[name]) params.set(name, values[name]);
  }
  return params.toString();
}

/** URL of the unsigned, rate-limited playground render. */
export function playgroundUrl(values) {
  return `/playground/card.png?${query(values, FIELDS)}`;
}

/**
 * The tags a visitor would paste, with placeholders where the site id and the
 * signature go: the playground must never hand out a working signed URL.
 */
export function metaTagSnippet(origin, values) {
  const params = query(values, FIELDS.filter((name) => name !== 'template'));
  const url = `${origin}/v1/og/YOUR_SITE_ID/${values.template}.png?${params}${params ? '&' : ''}sig=YOUR_SIGNATURE`;
  const content = url.replace(/&/g, '&amp;');
  return [
    `<meta property="og:image" content="${content}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${content}">`,
  ].join('\n');
}

function init(root) {
  const form = root.querySelector('#pg-form');
  const frame = root.querySelector('#pg-frame');
  const image = root.querySelector('#pg-image');
  const status = root.querySelector('#pg-status');
  const error = root.querySelector('#pg-error');
  const snippet = document.querySelector('#pg-snippet');
  let timer = 0;
  let request = null;
  let objectUrl = '';

  const values = () => Object.fromEntries(FIELDS.map((name) => [name, String(new FormData(form).get(name) ?? '').trim()]));

  function showText(current) {
    root.querySelector('#pg-meta-title').textContent = current.title || 'Your page title';
    root.querySelector('#pg-meta-desc').textContent = current.description;
    if (snippet) snippet.textContent = metaTagSnippet(root.dataset.origin, current);
  }

  async function render() {
    request?.abort();
    request = new AbortController();
    frame.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(playgroundUrl(values()), { signal: request.signal });
      if (!response.ok) throw new Error(await errorMessage(response));
      const next = URL.createObjectURL(await response.blob());
      image.src = next;
      image.hidden = false;
      status.hidden = true;
      error.hidden = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = next;
    } catch (failure) {
      if (failure.name === 'AbortError') return;
      error.textContent = failure.message || 'The preview could not be loaded.';
      error.hidden = false;
      status.hidden = !image.hidden;
      status.textContent = 'No preview';
    }
    frame.setAttribute('aria-busy', 'false');
  }

  form.addEventListener('input', () => {
    showText(values());
    frame.setAttribute('aria-busy', 'true');
    clearTimeout(timer);
    timer = setTimeout(render, DEBOUNCE_MS);
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  showText(values());
  render();
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#playground');
  if (root) init(root);
}
