// The home page's tool grid: search box, filter chips, "/" and Escape. The tiles are static HTML
// (scripts/tools-site.ts); this only hides and shows them, so without it every tile is visible.
// searchWords spells a query like the tiles' data-search text; matches says whether a tile stays.

export const searchWords = (text) =>
  text
    .toLowerCase()
    .replace(/’/g, "'")
    .split(/[^\p{L}\p{N}'+:_-]+/u)
    .filter(Boolean);

export const matches = (tile, state) =>
  (state.chip === 'all' || tile.chip === state.chip) && (!state.free || tile.free) && state.words.every((word) => tile.search.includes(word));

export const statusText = (shown, total) => (shown === 0 ? 'No tool matches.' : `${shown === total ? 'All' : `${shown} of`} ${total} tools shown.`);

function start(doc) {
  const grid = doc.getElementById('tool-grid');
  const input = doc.getElementById('tool-q');
  if (!grid || !input) return;
  const tiles = [...grid.querySelectorAll('.tool-tile')];
  const columns = [...grid.querySelectorAll('.tool-col')];
  const chips = [...doc.querySelectorAll('.tool-chip')];
  const status = doc.getElementById('tool-status');
  const empty = doc.getElementById('tool-empty');
  const state = { chip: 'all', free: false, words: [] };
  const everything = { chip: 'all', free: false };

  const apply = (announce = true) => {
    state.words = searchWords(input.value);
    let shown = 0;
    for (const tile of tiles) {
      const keep = matches({ chip: tile.dataset.chip, free: tile.hasAttribute('data-free'), search: tile.dataset.search || '' }, state);
      tile.hidden = !keep;
      if (keep) shown += 1;
    }
    for (const column of columns) column.hidden = !column.querySelector('.tool-tile:not([hidden])');
    for (const chip of chips) {
      const filter = chip.dataset.filter;
      chip.setAttribute('aria-pressed', String(filter === 'free' ? state.free : filter === state.chip && !(filter === 'all' && state.free)));
    }
    if (empty) empty.hidden = shown > 0;
    if (status && announce) status.textContent = statusText(shown, tiles.length);
  };

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;
      if (filter === 'free') state.free = !state.free;
      else if (filter === 'all') Object.assign(state, everything);
      else state.chip = state.chip === filter ? 'all' : filter;
      apply();
    });
    chip.disabled = false;
  }
  input.addEventListener('input', () => apply());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !input.value) return;
    input.value = '';
    apply();
  });
  doc.addEventListener('keydown', (event) => {
    const target = event.target;
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    event.preventDefault();
    input.focus();
    input.select();
  });
  doc.getElementById('tool-reset')?.addEventListener('click', () => {
    input.value = '';
    Object.assign(state, everything);
    apply();
    input.focus();
  });
  input.disabled = false;
  if (input.value) apply(false); // a browser may restore what was typed before a reload
}

if (typeof document !== 'undefined') start(document);
