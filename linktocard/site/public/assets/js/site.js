// Loaded on every page: copy buttons, the Compare menu, and the current nav link.

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
  for (const menu of document.querySelectorAll('.nav-dropdown[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const menu of document.querySelectorAll('.nav-dropdown[open]')) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

for (const link of document.querySelectorAll('.site-nav > a[href]')) {
  const path = new URL(link.href).pathname;
  if (location.pathname === path || location.pathname.startsWith(`${path}/`)) link.setAttribute('aria-current', 'page');
}
