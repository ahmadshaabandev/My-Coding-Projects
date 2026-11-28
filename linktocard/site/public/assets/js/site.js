// Loaded on every page: copy buttons, the current nav link, and the docs menu.

async function copyFrom(button) {
  const source = button.dataset.copyTarget
    ? document.querySelector(button.dataset.copyTarget)
    : button.parentElement.querySelector('code');
  if (!source) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(source.textContent);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Press Ctrl+C';
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1600);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy], [data-copy-target]');
  if (button) copyFrom(button);
});

for (const link of document.querySelectorAll('.site-nav > a[href]:not(.btn)')) {
  const path = new URL(link.href).pathname;
  if (location.pathname === path || location.pathname.startsWith(`${path}/`)) link.setAttribute('aria-current', 'page');
}

// The docs sidebar is a <details> that ships open, so it works without JavaScript.
// Here it becomes a menu: closed on small screens, always open beside the text on wide ones.
const docsMenu = document.querySelector('.docs-menu');
if (docsMenu) {
  const wide = window.matchMedia('(min-width: 60.01rem)');
  const sync = () => {
    docsMenu.open = wide.matches;
  };
  wide.addEventListener('change', sync);
  sync();
}

// Sentences that say something can be bought end with a note that ships hidden
// (data-checkout-closed, scripts/build-site.ts). Checkout is a switch of the server, so the
// note is shown here while GET /api/config reports no Paddle configuration: the same test the
// pricing page uses for its "Coming soon" buttons. A page without such a note asks nothing.
const closedNotes = document.querySelectorAll('[data-checkout-closed]');
if (closedNotes.length > 0) {
  fetch('/api/config', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      if (config && !config.paddle) {
        for (const note of closedNotes) note.hidden = false;
      }
    })
    .catch(() => {
      // Without an answer the page stays as built.
    });
}
