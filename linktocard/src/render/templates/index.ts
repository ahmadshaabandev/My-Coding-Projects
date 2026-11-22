/**
 * Starter templates: plain data (HTML + CSS strings and field descriptions).
 *
 * This module must stay free of runtime-specific imports: the Worker renders
 * from it, the site build (Node) lists it in the gallery and the docs print it.
 */

export type StarterTemplateId = 'blog' | 'dark' | 'quote' | 'launch' | 'docs';

export interface StarterField {
  /** Data key, used as {{name}} in the template and as a URL / JSON parameter. */
  name: string;
  description: string;
  example: string;
  required?: boolean;
}

export interface StarterTemplate {
  id: StarterTemplateId;
  /** Short human name, e.g. "Blog post". */
  name: string;
  /** One sentence: what the card is for. */
  description: string;
  html: string;
  css: string;
  fields: readonly StarterField[];
  /** Example data that makes a good-looking card (used for gallery samples and docs). */
  sample: Readonly<Record<string, string>>;
}

const PLACEHOLDER_HTML = `<div class="card"><div class="tag">{{tag}}</div><h1>{{title}}</h1><p>{{description}}</p><div class="by">{{author}}</div></div>`;
const PLACEHOLDER_CSS = `.card { display: flex; flex-direction: column; justify-content: center; width: 100%; height: 100%; padding: 72px; }
h1 { font-size: 64px; line-height: 1.1; margin: 0 0 24px; font-weight: 800; }
p { font-size: 30px; margin: 0; color: #4b5563; }
.tag, .by { font-size: 24px; color: #6b7280; margin: 0 0 16px; }
.theme-dark .card { background: #0b1020; color: #f9fafb; }`;

const COMMON_FIELDS: readonly StarterField[] = [
  { name: 'title', description: 'Main headline.', example: 'Turn every link into a beautiful share card', required: true },
  { name: 'description', description: 'Supporting line under the headline.', example: 'One signed URL in your meta tags.' },
  { name: 'author', description: 'Author or site name.', example: 'Link To Card' },
  { name: 'tag', description: 'Small label above the headline.', example: 'Guide' },
  { name: 'theme', description: 'light (default) or dark.', example: 'light' },
];

const placeholder = (id: StarterTemplateId, name: string, description: string): StarterTemplate => ({
  id,
  name,
  description,
  html: PLACEHOLDER_HTML,
  css: PLACEHOLDER_CSS,
  fields: COMMON_FIELDS,
  sample: { title: 'Turn every link into a beautiful share card', description: 'One signed URL in your meta tags.', author: 'Link To Card' },
});

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  placeholder('blog', 'Blog post', 'Title card for articles and blog posts.'),
  placeholder('dark', 'Dark', 'High-contrast dark card.'),
  placeholder('quote', 'Quote', 'A quotation with its author.'),
  placeholder('launch', 'Launch', 'Product or feature announcement.'),
  placeholder('docs', 'Documentation', 'Documentation page card.'),
];

export const STARTER_TEMPLATE_IDS: readonly StarterTemplateId[] = STARTER_TEMPLATES.map((template) => template.id);

export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
