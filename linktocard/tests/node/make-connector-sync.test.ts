// integrations/make is a Make custom app: JSON files that Make reads as they are, so it cannot
// import src/config.ts or the PDF templates and keeps copies of the API's fixed choices (sizes,
// formats, PDF page sizes, the PDF starter templates and their fields). This test fails when the
// service and the app drift apart: the copies against the Worker's own definitions, the requests in
// integrations/make/test/api-contract.json against openapi.yaml and the Worker's field lists, and
// the samples Make shows before a run against the plans and counting rules. It only reads files,
// so it runs without `npm install` in integrations/make.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLANS } from '../../src/billing/plans';
import { API_KEY_PREFIX, DAY_MS, DEFAULT_FORMAT, DEFAULT_SIZE, FORMATS, LIMITS, LINK_CARDS, PDF, SIZES, pdfUnits } from '../../src/config';
import { PDF_TEMPLATES } from '../../src/pdf/templates';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = path.join(ROOT, 'integrations/make/app');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const readApp = <T>(rel: string): T => JSON.parse(readFileSync(path.join(APP, rel), 'utf8')) as T;

interface Param {
  name: string;
  type: string;
  label?: string;
  help?: string;
  required?: boolean;
  options?: string | Array<{ label: string; value: string; nested?: Param[] }>;
  spec?: Param[] | Param;
  validate?: { pattern?: string };
  [key: string]: unknown;
}
interface Contract {
  baseUrl: string;
  operations: Record<string, { method: string; path: string; body?: string[]; page?: string[] }>;
}

const moduleFile = (dir: string, code: string): string => `modules/${dir}/${dir}.${code}.iml.json`;
const mappable = (dir: string): Param[] => readApp<Param[]>(moduleFile(dir, 'mappable-params'));
const samples = <T>(dir: string): T => readApp<T>(moduleFile(dir, 'samples'));
const byName = (list: Param[], name: string): Param => {
  const found = list.find((param) => param.name === name);
  if (!found) throw new Error(`no parameter ${name}`);
  return found;
};
const optionList = (param: Param): Array<{ label: string; value: string; nested?: Param[] }> => {
  if (!Array.isArray(param.options)) throw new Error(`${param.name} has no static options`);
  return param.options;
};
const contract = JSON.parse(read('integrations/make/test/api-contract.json')) as Contract;

/** Keys a batch fills in itself (contract T1), never offered as PDF fields. */
const BATCH_FILLED_KEYS = new Set(['verify_url', 'verify_qr']);
/** A batch row may not bring these either while verification is on, so rows never offer them. */
const BATCH_ROW_EXCLUDED = new Set([...BATCH_FILLED_KEYS, 'certificate_id']);
/** The app's long text fields (a text box rather than one line). */
const LONG_TEXT = /(address|notes|summary|terms|achievement|body)$/;
const humanize = (key: string): string => {
  const words = key.replace(/_+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the app must offer for one PDF template field (src/pdf/templates PdfTemplateField). */
function expectedField(field: (typeof PDF_TEMPLATES)[number]['fields'][number]): Param {
  if (field.kind === 'items') {
    return {
      name: field.key,
      type: 'array',
      label: field.label,
      ...(field.required ? { required: true } : {}),
      spec: (field.itemFields ?? []).map((item) => ({ name: item, type: 'text', label: humanize(item) })),
    };
  }
  return { name: field.key, type: 'text', label: field.label, ...(field.required ? { required: true } : {}), ...(LONG_TEXT.test(field.key) ? { multiline: true } : {}) };
}

/* ------------------------------------------------------------------ */
/* Source text helpers (modules that pull Worker-only code are read)   */
/* ------------------------------------------------------------------ */

/** The quoted strings of `const NAME ... = [ ... ]` in a source file. */
function constList(file: string, name: string): string[] {
  const match = new RegExp(`const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(read(file));
  expect(match, `${name} in ${file}`).not.toBeNull();
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
}

/** openapi.yaml plus the build v3 fragment next to the repository while it has not been merged. */
function openApiText(): string {
  const fragment = path.join(ROOT, '../openapi-v3.yaml');
  return `${read('openapi.yaml')}\n${existsSync(fragment) ? readFileSync(fragment, 'utf8') : ''}`;
}

/** operationId -> method and path, from the "paths" sections. */
function openApiOperations(text: string): Map<string, { method: string; path: string }> {
  const operations = new Map<string, { method: string; path: string }>();
  let currentPath = '';
  let currentMethod = '';
  for (const line of text.split('\n')) {
    const pathMatch = /^ {2}(\/\S+):$/.exec(line);
    if (pathMatch) currentPath = pathMatch[1]!;
    const methodMatch = /^ {4}(get|post|put|patch|delete):$/.exec(line);
    if (methodMatch) currentMethod = methodMatch[1]!.toUpperCase();
    const idMatch = /^ {6}operationId: (\S+)$/.exec(line);
    if (idMatch) operations.set(idMatch[1]!, { method: currentMethod, path: currentPath });
  }
  return operations;
}

/** The property names of a component schema (and of one of its object properties). */
function schemaProperties(text: string, schema: string, nested?: string): string[] {
  const start = text.search(new RegExp(`^ {4}${schema}:$`, 'm'));
  expect(start, `schema ${schema}`).toBeGreaterThan(-1);
  const rest = text.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^ {4}\S/.test(line) || /^\S/.test(line));
  const block = rest.slice(0, end === -1 ? undefined : end);
  if (!nested) return block.filter((line) => /^ {8}[a-z_]+:$/.test(line)).map((line) => line.trim().slice(0, -1));
  const from = block.findIndex((line) => line === `        ${nested}:`);
  const after = block.slice(from + 1);
  const to = after.findIndex((line) => /^ {8}[a-z_]+:$/.test(line));
  return after.slice(0, to === -1 ? undefined : to).filter((line) => /^ {12}[a-z_]+:$/.test(line)).map((line) => line.trim().slice(0, -1));
}

/* ------------------------------------------------------------------ */

describe('integrations/make lists the choices src/config.ts defines', () => {
  it('card sizes, in order, labelled with their pixel sizes, and the default in the help', () => {
    for (const dir of ['create-card-image', 'card-from-link']) {
      const size = byName(mappable(dir), 'size');
      expect(optionList(size)).toEqual(Object.values(SIZES).map((preset) => ({ label: `${preset.label} (${preset.width} x ${preset.height})`, value: preset.id })));
      const preset = SIZES[DEFAULT_SIZE];
      expect(size.help).toBe(`Leave empty for ${preset.label} (${preset.width} x ${preset.height}).`);
    }
  });

  it('image formats, in order, and the default in the help', () => {
    for (const dir of ['create-card-image', 'card-from-link']) {
      const format = byName(mappable(dir), 'format');
      expect(optionList(format).map((option) => option.value)).toEqual([...FORMATS]);
      const label = optionList(format).find((option) => option.value === DEFAULT_FORMAT)!.label;
      expect(format.help).toBe(`Leave empty for ${label}.`);
    }
  });

  it('PDF page sizes, in order', () => {
    for (const dir of ['create-pdf', 'start-bulk-pdfs']) {
      expect(optionList(byName(mappable(dir), 'pageFormat')).map((option) => option.value)).toEqual([...PDF.formats]);
    }
  });

  it("the link cards' default template is the one the help names", () => {
    expect(byName(mappable('card-from-link'), 'template').help).toContain(`Leave empty for the "${LINK_CARDS.defaultTemplate}" starter template.`);
  });

  it('template field names are checked with the API\'s own key rule', () => {
    const lists = [
      [mappable('create-card-image'), 'data'],
      [mappable('card-from-link'), 'overrides'],
    ] as const;
    for (const [params, name] of lists) {
      const key = (byName(params, name).spec as Param[]).find((field) => field.name === 'key')!;
      expect(key.validate?.pattern).toBe(LIMITS.dataKeyPattern.source);
    }
    const own = optionList(byName(mappable('create-pdf'), 'template')).find((option) => option.value === 'own')!;
    const fields = own.nested!.find((param) => param.name === 'fields')!;
    expect((fields.spec as Param[])[0]!.validate?.pattern).toBe(LIMITS.dataKeyPattern.source);
  });

  it('the connection only takes keys with the API key prefix', () => {
    const params = readApp<Param[]>('connections/api-key/api-key.params.iml.json');
    expect(byName(params, 'apiKey').validate?.pattern).toBe(`^${API_KEY_PREFIX}`);
  });
});

describe('integrations/make offers the PDF starter templates with their fields (no endpoint lists them)', () => {
  it('Create a PDF: every starter in order, its fields, then your own templates', () => {
    const options = optionList(byName(mappable('create-pdf'), 'template'));
    expect(options.map((option) => option.value)).toEqual([...PDF_TEMPLATES.map((template) => template.id), 'own']);
    for (const template of PDF_TEMPLATES) {
      const option = options.find((candidate) => candidate.value === template.id)!;
      expect(option.label).toBe(template.name);
      expect(option.nested).toEqual([
        { name: 'data', type: 'collection', label: 'Document fields', spec: template.fields.filter((field) => !BATCH_FILLED_KEYS.has(field.key)).map(expectedField) },
      ]);
    }
  });

  it('Start bulk PDFs: the same starters; a row offers every field a batch row may bring', () => {
    const options = optionList(byName(mappable('start-bulk-pdfs'), 'template'));
    expect(options.map((option) => option.value)).toEqual([...PDF_TEMPLATES.map((template) => template.id), 'own']);
    for (const template of PDF_TEMPLATES) {
      const rows = options.find((candidate) => candidate.value === template.id)!.nested!.find((param) => param.name === 'rows')!;
      expect(rows.spec).toEqual(template.fields.filter((field) => !BATCH_ROW_EXCLUDED.has(field.key)).map(expectedField));
    }
  });
});

describe('integrations/make sends only requests the API answers', () => {
  const text = openApiText();
  const operations = openApiOperations(text);

  it('every operation it uses exists in openapi.yaml with that method and path', () => {
    for (const [id, operation] of Object.entries(contract.operations)) {
      expect(operations.get(id), id).toEqual({ method: operation.method, path: operation.path });
    }
  });

  it('the body keys it may send are the ones the Worker accepts', () => {
    expect(read('src/routes/api.ts')).toContain("const IMAGE_FIELDS: readonly string[] = [...CARD_FIELDS, 'response'];");
    expect(contract.operations.createImage!.body).toEqual([...constList('src/lib/images.ts', 'CARD_FIELDS'), 'response']);
    expect(contract.operations.createPdf!.body).toEqual(constList('src/pdf/input.ts', 'PDF_FIELDS'));
    expect(contract.operations.createPdf!.page).toEqual(constList('src/pdf/input.ts', 'PAGE_FIELDS'));
    expect(contract.operations.createCardFromUrl!.body).toEqual(constList('src/cards/handlers.ts', 'FROM_URL_FIELDS'));
    // POST /v1/batches: the documented request until the route exists (contract T1).
    expect(contract.operations.createBatch!.body).toEqual(schemaProperties(text, 'BatchRequest'));
    expect(contract.operations.createBatch!.page).toEqual(schemaProperties(text, 'BatchRequest', 'pdf'));
  });

  it('it talks to the production origin unless a connection names a test server', () => {
    const production = /^\[env\.production\.vars\][\s\S]*?^APP_URL = "([^"]+)"/m.exec(read('wrangler.toml'))?.[1];
    expect(contract.baseUrl).toBe(production);
    expect(readApp<{ baseUrl: string }>('general/base.iml.json').baseUrl).toBe(`{{ifempty(connection.apiUrl, '${production}')}}`);
    expect(readApp<{ url: string }>('connections/api-key/api-key.communication.iml.json').url).toBe(`{{ifempty(parameters.apiUrl, '${production}')}}/v1/usage`);
  });

  it('every docs link in its help texts and readme points at a published page and heading', () => {
    // Pages with a "feature:" line are left out of the production site until that feature is
    // approved, so the app links only to pages without one.
    const appText = ['README.md', ...readdirSync(path.join(APP, 'modules'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.json')).map((file) => `modules/${file}`)]
      .map((rel) => readFileSync(path.join(APP, rel), 'utf8'))
      .join('\n');
    const links = [...new Set([...appText.matchAll(/https:\/\/linktocard\.com\/docs\/([a-z-]+)(?:#([a-z0-9-]+))?/g)].map((match) => match[0]))];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) {
      const [, page, anchor] = /\/docs\/([a-z-]+)(?:#([a-z0-9-]+))?/.exec(link)!;
      const file = `site/content/docs/${page}.md`;
      expect(existsSync(path.join(ROOT, file)), link).toBe(true);
      const source = read(file);
      expect(source.split('\n---')[0], `${link}: not behind a site feature`).not.toMatch(/^feature:/m);
      if (anchor) {
        const slugs = [...source.matchAll(/^#{2,3} (.+)$/gm)].map((match) => match[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-'));
        expect(slugs, link).toContain(anchor);
      }
    }
  });
});

describe('integrations/make samples tell the truth', () => {
  interface Usage {
    plan: keyof typeof PLANS;
    limit: number;
    used: number;
    remaining: number;
    topup_remaining: number;
    total_remaining: number;
    cache_days: number;
    watermark: boolean;
  }
  interface Stored {
    created_at: string;
    expires_at: string;
    usage: Usage;
  }

  it("each usage block is a real plan's", () => {
    for (const dir of ['create-card-image', 'create-pdf', 'card-from-link']) {
      const usage = samples<Stored>(dir).usage;
      const plan = PLANS[usage.plan];
      expect(plan, dir).toBeDefined();
      expect(usage.limit).toBe(plan.monthlyImages);
      expect(usage.cache_days).toBe(plan.cacheDays);
      expect(usage.watermark).toBe(plan.watermark);
      expect(usage.remaining).toBe(usage.limit - usage.used);
      expect(usage.total_remaining).toBe(usage.remaining + usage.topup_remaining);
    }
  });

  it("stored files expire after that plan's storage days", () => {
    for (const dir of ['create-card-image', 'create-pdf', 'card-from-link']) {
      const sample = samples<Stored>(dir);
      expect(Date.parse(sample.expires_at) - Date.parse(sample.created_at), dir).toBe(sample.usage.cache_days * DAY_MS);
    }
  });

  it('PDFs and batch documents count what their pages count', () => {
    const pdf = samples<{ pages: number; credits_used: number }>('create-pdf');
    expect(pdf.credits_used).toBe(pdfUnits(pdf.pages));
    const batch = samples<{ rows: Array<{ pages: number; credits_used: number; certificate_id: string; verify_url: string }> }>('get-batch');
    for (const row of batch.rows) {
      expect(row.credits_used).toBe(pdfUnits(row.pages));
      // contract T1: "crt_" + 20 base32 characters, verified at APP_URL/v/{id}.
      expect(row.certificate_id).toMatch(/^crt_[a-z0-9]{20}$/);
      expect(row.verify_url).toBe(`${contract.baseUrl}/v/${row.certificate_id}`);
    }
  });
});

describe('integrations/make package', () => {
  const FORBIDDEN = /stripe|lemon[\s_.-]?squeezy|puppeteer|playwright|chrome-aws-lambda|@sparticuz\/chromium/i;
  const packageDir = path.join(ROOT, 'integrations/make');

  it('has no runtime dependencies (Make runs the JSON files, nothing from npm)', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies as object).filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });

  it('package-lock.json installs no forbidden package', () => {
    const lock = JSON.parse(readFileSync(path.join(packageDir, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dependencies?: object; devDependencies?: object; optionalDependencies?: object }>;
    };
    const installed = Object.keys(lock.packages)
      .filter((key) => key !== '')
      .map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(installed.length).toBeGreaterThan(20);
    expect(installed.filter((name) => FORBIDDEN.test(name))).toEqual([]);
    const declared = Object.values(lock.packages).flatMap((entry) => Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }));
    expect(declared.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});
