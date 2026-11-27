/**
 * Starter templates: plain data (HTML + CSS strings and field descriptions).
 *
 * This module must stay free of runtime-specific imports: the Worker renders
 * from it, the site build (Node) lists it in the gallery and the docs print it.
 */

import type { SizeId } from '../../config';
import { blog } from './blog';
import { dark } from './dark';
import { docs } from './docs';
import { emailBanner } from './email-banner';
import { emailOffer } from './email-offer';
import { launch } from './launch';
import { quote } from './quote';

export type StarterTemplateId = 'blog' | 'dark' | 'quote' | 'launch' | 'docs' | 'email-banner' | 'email-offer';

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
  /**
   * The size presets (src/config.ts SIZES) the template is laid out for, in SIZES order. Every
   * route that renders or signs a card refuses any other preset for a starter with 400
   * invalid_request (src/lib/images.ts assertTemplateSize); the account's own templates and
   * inline HTML take every preset. The social starters are not laid out for the 1200x400 email
   * preset (owner decision of 2026-11-27); the email starters are laid out for all four.
   */
  sizes: readonly SizeId[];
}

/** The social-card gallery: the site, the docs, the playground and the template lists show these. */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [blog, dark, quote, launch, docs];

export const STARTER_TEMPLATE_IDS: readonly StarterTemplateId[] = STARTER_TEMPLATES.map((template) => template.id);

/**
 * Email image starters (open fields), laid out for the email (1200x400) and og (1200x630) presets.
 * Kept out of the social gallery and out of every template list. They are part of the email images
 * tool: only while EMAIL_FIELDS_ENABLED is "true" can a signed URL, POST /v1/images, /api/sign,
 * the studio preview or a link card name them (getStarterTemplate with `email`); otherwise their ids
 * are unknown like any other. The free playground never offers them.
 */
export const EMAIL_TEMPLATES: readonly StarterTemplate[] = [emailBanner, emailOffer];

/** A starter by id: the social gallery, plus the email starters when `options.email` is true. */
export function getStarterTemplate(id: string, options: { email?: boolean } = {}): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.id === id) ?? (options.email === true ? EMAIL_TEMPLATES.find((template) => template.id === id) : undefined);
}
