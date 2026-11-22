/**
 * Starter templates: plain data (HTML + CSS strings and field descriptions).
 *
 * This module must stay free of runtime-specific imports: the Worker renders
 * from it, the site build (Node) lists it in the gallery and the docs print it.
 */

import { blog } from './blog';
import { dark } from './dark';
import { docs } from './docs';
import { launch } from './launch';
import { quote } from './quote';

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

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [blog, dark, quote, launch, docs];

export const STARTER_TEMPLATE_IDS: readonly StarterTemplateId[] = STARTER_TEMPLATES.map((template) => template.id);

export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id);
}
