// While a deployment has no Paddle configuration (production before live Paddle is
// approved), the pricing buttons must say "Coming soon" and lead nowhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

interface Pricing {
  COMING_SOON: string;
  markComingSoon(root: { querySelectorAll(selector: string): Iterable<FakeButton> }): number;
}

class FakeButton {
  textContent: string;
  readonly attributes: Map<string, string>;
  constructor(text: string, attributes: Record<string, string>) {
    this.textContent = text;
    this.attributes = new Map(Object.entries(attributes));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe('pricing buttons while checkout is off', () => {
  it('turns every checkout button into a disabled "Coming soon" with no link', async () => {
    const { COMING_SOON, markComingSoon } = (await import(pathToFileURL(join(ROOT, 'site/public/assets/js/pricing.js')).href)) as Pricing;
    const buttons = ['starter', 'pro', 'topup'].map((item) => new FakeButton(`Choose ${item}`, { href: `/pricing?checkout=${item}`, 'data-checkout': item, class: 'btn' }));
    const root = { querySelectorAll: (selector: string) => (selector === '[data-checkout]' ? buttons : []) };

    expect(markComingSoon(root)).toBe(3);
    for (const button of buttons) {
      expect(button.textContent).toBe(COMING_SOON);
      expect(button.attributes.has('href')).toBe(false);
      expect(button.attributes.has('data-checkout')).toBe(false);
      expect(button.attributes.get('aria-disabled')).toBe('true');
    }
    expect(COMING_SOON).toBe('Coming soon');
  });

  it('only switches when the server reports no Paddle configuration, and the page says the Free plan is open', () => {
    const source = readFileSync(join(ROOT, 'site/public/assets/js/pricing.js'), 'utf8');
    expect(source).toMatch(/if \(config && !config\.paddle\) \{\s*markComingSoon\(document\)/);
    const page = readFileSync(join(ROOT, 'site/pages/pricing.html'), 'utf8');
    // Top-ups are named too: since 2026-11-28 a Free account can buy one, and the Free plan is open while checkout is not.
    expect(page).toContain('<p class="alert alert-info" id="coming-soon" role="note" hidden>Paid plans and top-ups are coming soon. The [[plan.free.name]] plan is open now:');
    // The home page loads pricing.js too (its plan cards), after the playground and before the tool grid's script.
    expect(readFileSync(join(ROOT, 'site/pages/index.html'), 'utf8')).toMatch(/^scripts: playground, pricing, tool-finder$/m);
  });
});
