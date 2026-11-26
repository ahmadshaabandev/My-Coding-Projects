// The email starter templates are plain data, like every starter (src/render/templates/index.ts):
// the site build and the docs import them in plain Node, without the Worker runtime.
import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES } from '../../src/render/templates';
import { emailBanner } from '../../src/render/templates/email-banner';
import { emailOffer } from '../../src/render/templates/email-offer';

describe('email starter templates in plain Node', () => {
  it.each([emailBanner, emailOffer])('$id imports without the Worker runtime and survives a JSON round trip', (template) => {
    expect(JSON.parse(JSON.stringify(template))).toEqual(template);
    expect(Object.keys(template).sort()).toEqual(['css', 'description', 'fields', 'html', 'id', 'name', 'sample']);
    for (const field of template.fields) expect(Object.keys(field).every((key) => ['name', 'description', 'example', 'required'].includes(key))).toBe(true);
  });

  it('lists its fields like the other starters: the required title first, theme last', () => {
    for (const template of [emailBanner, emailOffer]) {
      expect(template.fields[0]).toMatchObject({ name: 'title', required: true });
      expect(template.fields.at(-1)?.name).toBe('theme');
      expect(template.fields.at(-1)?.description).toBe(STARTER_TEMPLATES[0]!.fields.find((field) => field.name === 'theme')?.description);
    }
  });

  // The size is the docs' business: a description must stay true whichever presets exist.
  it('promises no size in its description, which the gallery and docs show', () => {
    for (const template of [emailBanner, emailOffer]) {
      expect(template.description).toMatch(/^[A-Z][^.]+\.$/);
      expect(template.description).not.toMatch(/\d+\s*x\s*\d+/);
    }
  });
});
