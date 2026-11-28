/**
 * The home page's tool grid as static HTML, made from site/tools.catalog.ts at build time.
 * scripts/build-site.ts publishes the results as generated partials:
 *
 *   [[> tool-chips]]          the filter chips, with the number of tiles each one keeps
 *   [[> tool-grid]]           one column per category that has a tile, one tile per tool
 *   [[> tool-label-<id>]]     a label exactly as a tile prints it, for the legend (free, credits, both)
 *
 * A tile is printed only for a tool this build publishes (publishedTools()); columns, chips and
 * counts follow from the tiles. The browser script (site/public/assets/js/tool-finder.js) only
 * hides and shows what is printed here, so without JavaScript every tile is on the page.
 */
import { TOOL_ICONS } from '../site/tool-icons';
import { TOOLS, TOOL_CATEGORIES, TOOL_CHIPS, TOOL_LABELS, type Tool, type ToolLabelId } from '../site/tools.catalog';

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page behind a tile's href: "/docs/api" for "/docs/api#errors", "/" for "/#playground". */
export const toolPagePath = (href: string): string => href.replace(/[?#].*$/, '') || '/';

/**
 * The tools this build lists: every site feature of the entry is on, and the page its tile goes to
 * is published as launched. `launched` holds the URL of each page whose own feature is on; a docs
 * page built only through "apidocs", under its "not switched on yet" notice, is not in it.
 */
export function publishedTools(features: Readonly<Record<string, boolean>>, launched: ReadonlySet<string>): Tool[] {
  return TOOLS.filter((tool) => tool.features.every((feature) => features[feature] === true) && launched.has(toolPagePath(tool.href)));
}

const categoryOf = (tool: Tool): (typeof TOOL_CATEGORIES)[number] => {
  const category = TOOL_CATEGORIES.find((entry) => entry.id === tool.category);
  if (!category) throw new Error(`site/tools.catalog.ts: tool "${tool.id}" names the unknown category "${tool.category}"`);
  return category;
};

/** One spelling of a label. "Free + credits" is drawn in two halves: free on marker yellow, credits on ink. */
function labelParts(id: ToolLabelId, text: string): string {
  if (id !== 'both') return `<span class="tl-${id === 'free' ? 'f' : 'c'}">${escapeHtml(text)}</span>`;
  const plus = text.indexOf('+');
  const cut = text[plus - 1] === ' ' ? plus - 1 : plus;
  return `<span class="tl-f">${escapeHtml(text.slice(0, cut))}</span><span class="tl-c">${escapeHtml(text.slice(cut))}</span>`;
}

/** A label with both spellings: the words for wide screens and screen readers, the letters for phones. */
export function toolLabelHtml(id: ToolLabelId): string {
  const label = TOOL_LABELS[id];
  return `<span class="tool-label" data-label="${id}"><span class="tl-full">${labelParts(id, label.text)}</span><span class="tl-short" aria-hidden="true">${labelParts(id, label.short)}</span></span>`;
}

/** What the search box looks through: lower case, one space between words, straight apostrophes. */
function searchText(tool: Tool): string {
  return [tool.name, tool.short ?? '', tool.description, tool.keywords, TOOL_LABELS[tool.label].text, categoryOf(tool).title]
    .join(' ')
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}'+:_-]+/gu, ' ')
    .trim();
}

function tileHtml(tool: Tool): string {
  const icon = TOOL_ICONS[tool.icon];
  if (icon === undefined) throw new Error(`site/tools.catalog.ts: tool "${tool.id}" names the unknown icon "${tool.icon}"`);
  if (!/^[a-z][a-z0-9-]*$/.test(tool.id)) throw new Error(`site/tools.catalog.ts: tool id "${tool.id}" must be lower case letters, digits and dashes`);
  const name =
    tool.short === undefined
      ? escapeHtml(tool.name)
      : `<span class="tn-full">${escapeHtml(tool.name)}</span><span class="tn-short" aria-hidden="true">${escapeHtml(tool.short)}</span>`;
  const attributes = [
    'class="tool-tile"',
    `href="${escapeHtml(tool.href)}"`,
    `data-tool="${tool.id}"`,
    `data-chip="${categoryOf(tool).chip}"`,
    ...(TOOL_LABELS[tool.label].free ? ['data-free'] : []),
    `data-search="${escapeHtml(searchText(tool))}"`,
  ];
  return (
    `<a ${attributes.join(' ')}>` +
    `<svg class="tool-ico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">${icon}</svg> ` +
    `<span class="tool-name">${name}</span> <span class="tool-desc">${escapeHtml(tool.description)}</span> ${toolLabelHtml(tool.label)}</a>`
  );
}

const countHtml = (count: number): string => `${count}<span class="visually-hidden"> ${count === 1 ? 'tool' : 'tools'}</span>`;

/** The grid: a column for each category with at least one tile. The class says how many columns there are. */
export function toolGridHtml(tools: readonly Tool[]): string {
  const ids = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) throw new Error(`site/tools.catalog.ts: two tools share the id "${tool.id}"`);
    ids.add(tool.id);
  }
  const columns = TOOL_CATEGORIES.map((category) => ({ category, tiles: tools.filter((tool) => categoryOf(tool).id === category.id) })).filter(
    (column) => column.tiles.length > 0,
  );
  const html = columns.map(({ category, tiles }) =>
    [
      `<section class="tool-col" data-col="${category.id}" data-chip="${category.chip}" aria-labelledby="tools-${category.id}">`,
      `<h2 class="tool-col-head" id="tools-${category.id}"><span class="tool-col-name">${escapeHtml(category.title)}</span> <span class="tool-col-count">${countHtml(tiles.length)}</span></h2>`,
      ...tiles.map(tileHtml),
      '</section>',
    ].join('\n'),
  );
  return `<div class="tool-grid tool-grid-${columns.length}" id="tool-grid">\n${html.join('\n')}\n</div>`;
}

/**
 * The filter chips: All, one per chip of TOOL_CHIPS that has a tile, and "Free only" when a listed
 * tool has a free page. They are printed disabled; tool-finder.js switches them on.
 */
export function toolChipsHtml(tools: readonly Tool[]): string {
  const chip = (filter: string, title: string, count: number, pressed: boolean): string =>
    `<button class="tool-chip" type="button" data-filter="${filter}" aria-pressed="${pressed}" disabled>${escapeHtml(title)} <span class="tool-chip-n">${countHtml(count)}</span></button>`;
  const chips = [chip('all', 'All', tools.length, true)];
  for (const entry of TOOL_CHIPS) {
    const count = tools.filter((tool) => categoryOf(tool).chip === entry.id).length;
    if (count > 0) chips.push(chip(entry.id, entry.title, count, false));
  }
  const free = tools.filter((tool) => TOOL_LABELS[tool.label].free).length;
  if (free > 0) chips.push(chip('free', 'Free only', free, false));
  return `<div class="tool-chips" role="group" aria-label="Filter the tools">\n${chips.join('\n')}\n</div>`;
}

/** The generated partials of the home page's tool grid, for this build's published tools. */
export function toolPartials(features: Readonly<Record<string, boolean>>, launched: ReadonlySet<string>): Record<string, string> {
  const tools = publishedTools(features, launched);
  return {
    'tool-grid': toolGridHtml(tools),
    'tool-chips': toolChipsHtml(tools),
    ...Object.fromEntries((Object.keys(TOOL_LABELS) as ToolLabelId[]).map((id) => [`tool-label-${id}`, toolLabelHtml(id)])),
  };
}
