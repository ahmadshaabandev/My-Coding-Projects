// The card builder's size picker (review EXP-3, FR-3). The server refuses the five social starter
// templates at the email size (1200 x 400) with 400 size_not_supported on every path that signs or
// previews a card, so the builder must not offer that size for them: it offers a starter only the
// sizes GET /api/templates lists for it, every size for the user's own templates, and falls back to
// og when another template is picked. The real builder.js runs here on a small DOM stand-in, with
// fetch recorded, so the requests it would send are the ones checked.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIZES } from '../../src/config';
import { EMAIL_TEMPLATES, STARTER_TEMPLATES } from '../../src/render/templates';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const JS = join(ROOT, 'site/public/assets/js');
const load = async <T>(name: string): Promise<T> => (await import(pathToFileURL(join(JS, name)).href)) as T;

/* ---- a DOM just large enough for dom.js, preview.js and builder.js ---- */
class FakeElement {
  tagName: string;
  className = '';
  hidden = false;
  checked = false;
  disabled = false;
  value = '';
  type = '';
  src = '';
  href = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Array<FakeElement | string> = [];
  parent: FakeElement | null = null;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  classList = { add: (name: string) => (this.className = `${this.className} ${name}`.trim()) };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'type') this.type = value;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Array<FakeElement | string>): void {
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  get textContent(): string {
    return this.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join('');
  }
  set textContent(text: string) {
    this.children = [String(text)];
  }
  /** Descendants, depth first. */
  *walk(): Generator<FakeElement> {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        yield child;
        yield* child.walk();
      }
    }
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== 'input[type="radio"]') throw new Error(`the stand-in DOM does not know ${selector}`);
    return [...this.walk()].filter((node) => node.tagName === 'INPUT' && node.attributes.get('type') === 'radio');
  }
}

interface Sent {
  path: string;
  body: Record<string, unknown> | null;
}
const sent: Sent[] = [];
const saved: Record<string, unknown> = {};

beforeAll(() => {
  for (const key of ['document', 'fetch', 'localStorage', 'location']) saved[key] = (globalThis as Record<string, unknown>)[key];
  Object.assign(globalThis, {
    document: { createElement: (tag: string) => new FakeElement(tag), body: new FakeElement('body') },
    localStorage: { getItem: () => null, setItem: () => undefined },
    location: { assign: () => undefined },
    fetch: async (path: string, init: { body?: string } = {}) => {
      sent.push({ path, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
      if (path === '/api/sign') return Response.json({ url: 'https://example.test/v1/og/s_1/x.png?sig=a', canonical: 'c', meta_tags: '<meta>' });
      if (path === '/api/preview') return new Response(new Blob([new Uint8Array([137, 80, 78, 71])]), { headers: { 'content-type': 'image/png' } });
      if (path.startsWith('/api/templates/')) return Response.json({ template: { id: 't_own', name: 'Mine', html: '<div>{{title}}</div>', css: '' } });
      return new Response('{}', { status: 404 });
    },
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value;
});

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n++) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Builder {
  form: FakeElement;
  output: FakeElement;
  destroy(): void;
}
interface BuilderModule {
  createBuilder(ctx: unknown, options: unknown): Builder;
}
interface Helpers {
  allowedSizes(template: { sizes?: readonly string[] } | undefined, sizes: Array<{ id: string }>): string[];
  sizeForTemplate(current: string, allowed: string[]): string;
  sizeNote(template: { name: string; sizes?: readonly string[] }, sizes: Array<{ id: string; width: number; height: number }>): string | null;
}

const configSizes = Object.entries(SIZES).map(([id, size]) => ({ id, width: size.width, height: size.height }));
/** GET /api/templates as the studio route sends it: each starter with its `sizes`. */
const starters = STARTER_TEMPLATES.map((template) => ({ id: template.id, name: template.name, fields: template.fields, sample: template.sample, sizes: [...template.sizes] as string[] }));

function sizeInputs(form: FakeElement): FakeElement[] {
  return form.querySelectorAll('input[type="radio"]').filter((input) => configSizes.some((size) => size.id === input.value) && input.attributes.get('name')?.endsWith('-size'));
}
function templateInput(form: FakeElement, id: string): FakeElement {
  const input = form.querySelectorAll('input[type="radio"]').find((candidate) => candidate.attributes.get('name')?.endsWith('-template') && candidate.value === id);
  if (!input) throw new Error(`no template ${id}`);
  return input;
}
/** What a click on an enabled radio does in a browser: it is checked, the rest of its group is not, and it fires change. */
const pick = async (input: FakeElement): Promise<void> => {
  if (input.disabled) throw new Error(`${input.value} cannot be picked: it is disabled`);
  const root = (() => {
    let node: FakeElement = input;
    while (node.parent) node = node.parent;
    return node;
  })();
  for (const other of root.querySelectorAll('input[type="radio"]')) if (other.attributes.get('name') === input.attributes.get('name')) other.checked = false;
  input.checked = true;
  input.dispatch('change');
  await settle();
};
const sizesSentFor = (template: string): unknown[] =>
  sent.filter((request) => (request.path === '/api/sign' || request.path === '/api/preview') && request.body?.template === template).map((request) => request.body?.size);

describe('the size presets the starters are laid out for', () => {
  it('none of the five social starters takes the email size, and both email starters do', () => {
    expect(STARTER_TEMPLATES.map((template) => template.id)).toEqual(['blog', 'dark', 'quote', 'launch', 'docs']);
    for (const template of STARTER_TEMPLATES) expect(template.sizes, template.id).not.toContain('email');
    for (const template of EMAIL_TEMPLATES) expect(template.sizes, template.id).toContain('email');
  });
});

describe('size helpers', async () => {
  const helpers = await load<Helpers>('dashboard/helpers.js');

  it('offers a starter only its own sizes, and the user\'s own templates every size', () => {
    for (const starter of starters) expect(helpers.allowedSizes(starter, configSizes), starter.id).toEqual(configSizes.map((size) => size.id).filter((id) => starter.sizes.includes(id)));
    expect(helpers.allowedSizes(starters[0], configSizes)).not.toContain('email');
    expect(helpers.allowedSizes(undefined, configSizes)).toEqual(configSizes.map((size) => size.id));
    expect(helpers.allowedSizes({}, configSizes)).toEqual(configSizes.map((size) => size.id));
  });

  it('falls back to og when the new template does not take the current size', () => {
    expect(helpers.sizeForTemplate('email', ['og', 'square', 'portrait'])).toBe('og');
    expect(helpers.sizeForTemplate('square', ['og', 'square', 'portrait'])).toBe('square');
    expect(helpers.sizeForTemplate('email', ['og', 'square', 'portrait', 'email'])).toBe('email');
    expect(helpers.sizeForTemplate('og', ['square'])).toBe('square');
  });

  it('says in words why a size cannot be picked', () => {
    expect(helpers.sizeNote(starters[0]!, configSizes)).toBe(`The ${starters[0]!.name} starter is not laid out for the Email size. Your own templates take every size.`);
    expect(helpers.sizeNote({ name: 'Mine' }, configSizes)).toBeNull();
  });
});

describe('builder.js', async () => {
  const { createBuilder } = await load<BuilderModule>('dashboard/builder.js');
  const ctx = {
    config: { sizes: configSizes, formats: ['png', 'jpeg', 'webp'] },
    me: { usage: { cache_days: 7 }, user: { plan: 'free' } },
  };

  it('never offers Email for a starter, and never signs or previews one at the email size', async () => {
    sent.length = 0;
    const builder = createBuilder(ctx, { sites: [{ id: 's_1', name: 'Site' }], templates: { starter: starters, custom: [{ id: 't_own', name: 'Mine' }] } });
    await settle();
    const inputs = () => sizeInputs(builder.form);
    expect(inputs().map((input) => input.value)).toEqual(configSizes.map((size) => size.id));
    const email = () => inputs().find((input) => input.value === 'email')!;
    const checked = () => inputs().filter((input) => input.checked).map((input) => input.value);

    // blog, the starter picked first: Email cannot be chosen, og is.
    expect(email().disabled).toBe(true);
    expect(inputs().filter((input) => input.disabled).map((input) => input.value)).toEqual(['email']);
    expect(checked()).toEqual(['og']);
    expect(builder.form.textContent).toContain('starter is not laid out for the Email size');

    // The user's own template takes every size, Email included.
    await pick(templateInput(builder.form, 't_own'));
    expect(inputs().filter((input) => input.disabled)).toEqual([]);
    expect(builder.form.textContent).not.toContain('not laid out for');
    await pick(email());
    expect(sizesSentFor('t_own')).toContain('email');

    // Switching to each social starter from Email falls back to og before anything is sent.
    for (const starter of starters) {
      await pick(templateInput(builder.form, 't_own'));
      await pick(email());
      await pick(templateInput(builder.form, starter.id));
      expect(email().disabled, starter.id).toBe(true);
      expect(checked(), starter.id).toEqual(['og']);
      expect(sizesSentFor(starter.id), starter.id).not.toContain('email');
      expect(sizesSentFor(starter.id).length, starter.id).toBeGreaterThan(0);
    }
    for (const starter of starters) expect(sizesSentFor(starter.id), starter.id).toEqual(sizesSentFor(starter.id).filter((size) => size !== 'email'));
    builder.destroy();
  });

  it('keeps a size the next template also takes', async () => {
    sent.length = 0;
    const builder = createBuilder(ctx, { sites: [{ id: 's_1', name: 'Site' }], templates: { starter: starters, custom: [] } });
    await settle();
    await pick(sizeInputs(builder.form).find((input) => input.value === 'square')!);
    await pick(templateInput(builder.form, 'quote'));
    expect(sizeInputs(builder.form).filter((input) => input.checked).map((input) => input.value)).toEqual(['square']);
    expect(sizesSentFor('quote').at(-1)).toBe('square');
    builder.destroy();
  });
});
