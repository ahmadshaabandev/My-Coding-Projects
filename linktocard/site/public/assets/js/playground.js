// Landing-page playground: a share preview that follows the form. It opens on a
// pre-rendered sample; GET /playground/card.png is called only after the visitor
// edits something. The "Copy" snippet stays in step with the form.
import { errorMessage } from './api.js';

const FIELDS = ['template', 'title', 'description', 'author', 'theme'];
const TEXT_FIELDS = ['title', 'description', 'author'];
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

/** The page address shown in the mock chat: the title as a URL slug. */
export function linkSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'your-page';
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
  // Until the visitor edits a field, each template shows its own pre-rendered sample.
  let pristine = true;

  const values = () => Object.fromEntries(FIELDS.map((name) => [name, String(new FormData(form).get(name) ?? '').trim()]));

  function showText(current) {
    root.querySelector('#pg-meta-title').textContent = current.title || 'Your page title';
    root.querySelector('#pg-meta-desc').textContent = current.description;
    for (const slug of root.querySelectorAll('[data-slug]')) slug.textContent = linkSlug(current.title);
    if (snippet) snippet.textContent = metaTagSnippet(root.dataset.origin, current);
  }

  function showImage(src) {
    image.src = src;
    image.hidden = false;
    status.hidden = true;
    error.hidden = true;
    // Restart the pop-in animation: the class has to leave and come back across a reflow.
    image.classList.remove('is-fresh');
    void image.offsetWidth;
    image.classList.add('is-fresh');
  }

  async function render() {
    request?.abort();
    request = new AbortController();
    frame.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(playgroundUrl(values()), { signal: request.signal });
      if (!response.ok) throw new Error(await errorMessage(response));
      const next = URL.createObjectURL(await response.blob());
      showImage(next);
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

  /** Fills the form with a template's sample text and shows its pre-rendered image. False when it has none. */
  function showSample(option) {
    const thumbnail = option.parentElement.querySelector('img');
    if (!thumbnail) return false;
    for (const name of TEXT_FIELDS) form.elements[name].value = option.dataset[name] ?? '';
    form.elements.theme.value = option.dataset.theme || 'light';
    showImage(thumbnail.getAttribute('src'));
    return true;
  }

  form.addEventListener('input', (event) => {
    const picked = event.target.name === 'template';
    if (!picked) pristine = false;
    const sampled = picked && pristine && showSample(event.target);
    showText(values());
    if (sampled) return;
    frame.setAttribute('aria-busy', 'true');
    clearTimeout(timer);
    timer = setTimeout(render, DEBOUNCE_MS);
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  // No pre-rendered sample in this build: the first image comes from the API.
  if (image.hidden) {
    status.hidden = false;
    render();
  }
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#playground');
  if (root) init(root);
}
