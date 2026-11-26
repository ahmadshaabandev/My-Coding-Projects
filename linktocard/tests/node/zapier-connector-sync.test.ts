// integrations/zapier is uploaded to Zapier on its own, so it cannot import src/config.ts or the
// PDF templates and keeps copies of the API's fixed choices (lib/constants.js). This test fails
// when the service and the Zapier app drift apart, checks that the samples Zapier shows in the
// Zap editor tell the truth about plans and counting, and keeps the app's lock file free of the
// packages the service never ships. It only loads files of the app without dependencies, so it
// runs without `npm install` in integrations/zapier.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLANS, PLAN_ORDER } from '../../src/billing/plans';
import { DAY_MS, DEFAULT_FORMAT, DEFAULT_SIZE, FORMATS, LINK_CARDS, PDF, SIZES, pdfUnits } from '../../src/config';
import { PDF_TEMPLATES } from '../../src/pdf/templates';

const packageDir = fileURLToPath(new URL('../../integrations/zapier/', import.meta.url));
const require = createRequire(path.join(packageDir, 'index.js'));

interface Choice {
  id: string;
  label: string;
}
interface ZapierConstants {
  DEFAULT_BASE_URL: string;
  CARD_SIZES: Array<Choice & { width: number; height: number }>;
  DEFAULT_CARD_SIZE: string;
  IMAGE_FORMATS: Choice[];
  DEFAULT_IMAGE_FORMAT: string;
  PDF_PAGE_FORMATS: Choice[];
  DEFAULT_PDF_PAGE_FORMAT: string;
  DEFAULT_LINK_CARD_TEMPLATE: string;
  PDF_STARTER_TEMPLATES: Array<{ id: string; name: string; fields: unknown[] }>;
  VERIFY_KEYS: string[];
}
interface Usage {
  plan: string;
  limit: number;
  used: number;
  remaining: number;
  topup_remaining: number;
  total_remaining: number;
  cache_days: number;
  watermark: boolean;
}
interface ZapierOutputs {
  SAMPLE_USAGE: Usage;
  SAMPLE_IMAGE: { created_at: string; expires_at: string; usage: Usage };
  SAMPLE_PDF: { pages: number; credits_used: number; created_at: string; expires_at: string };
  SAMPLE_BATCH: { rows: Array<{ pages: number; credits_used: number }> };
}

const constants = require('./lib/constants.js') as ZapierConstants;
const outputs = require('./lib/outputs.js') as ZapierOutputs;
const { connectionLabelFor } = require('./lib/authentication.js') as { connectionLabelFor: (usage: Record<string, unknown>, base: string) => string };

/** Keys a batch fills in for every row (contract T1); the Zapier forms never offer them as PDF fields. */
const BATCH_FILLED_KEYS = new Set(['verify_url', 'verify_qr']);

describe('integrations/zapier lists the choices src/config.ts defines', () => {
  it('card sizes, in order, with their labels and pixel sizes', () => {
    expect(constants.CARD_SIZES).toEqual(Object.values(SIZES).map(({ id, label, width, height }) => ({ id, label, width, height })));
    expect(constants.DEFAULT_CARD_SIZE).toBe(DEFAULT_SIZE);
  });

  it('image formats and the default', () => {
    expect(constants.IMAGE_FORMATS.map((format) => format.id)).toEqual([...FORMATS]);
    expect(constants.DEFAULT_IMAGE_FORMAT).toBe(DEFAULT_FORMAT);
  });

  it('PDF page formats and the default', () => {
    expect(constants.PDF_PAGE_FORMATS.map((format) => format.id)).toEqual([...PDF.formats]);
    expect(constants.DEFAULT_PDF_PAGE_FORMAT).toBe(PDF.defaultFormat);
  });

  it("the link cards' default template", () => {
    expect(constants.DEFAULT_LINK_CARD_TEMPLATE).toBe(LINK_CARDS.defaultTemplate);
  });

  it('the PDF starter templates with their fields (no endpoint lists them)', () => {
    const expected = PDF_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      fields: template.fields.filter((field) => !BATCH_FILLED_KEYS.has(field.key)).map((field) => ({ ...field, ...(field.itemFields ? { itemFields: [...field.itemFields] } : {}) })),
    }));
    expect(constants.PDF_STARTER_TEMPLATES).toEqual(expected);
  });

  it('the production origin', () => {
    expect(constants.DEFAULT_BASE_URL).toBe('https://linktocard.com');
    expect(readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8')).toContain(`APP_URL = "${constants.DEFAULT_BASE_URL}"`);
  });
});

describe('integrations/zapier samples tell the truth', () => {
  it("the usage block is a real plan's", () => {
    const usage = outputs.SAMPLE_USAGE;
    const plan = PLANS[usage.plan as keyof typeof PLANS];
    expect(plan).toBeDefined();
    expect(usage.limit).toBe(plan.monthlyImages);
    expect(usage.cache_days).toBe(plan.cacheDays);
    expect(usage.watermark).toBe(plan.watermark);
    expect(usage.remaining).toBe(usage.limit - usage.used);
    expect(usage.total_remaining).toBe(usage.remaining + usage.topup_remaining);
  });

  it("images and PDFs expire after that plan's storage days", () => {
    for (const sample of [outputs.SAMPLE_IMAGE, outputs.SAMPLE_PDF]) {
      expect(Date.parse(sample.expires_at) - Date.parse(sample.created_at)).toBe(outputs.SAMPLE_USAGE.cache_days * DAY_MS);
    }
  });

  it('PDFs and batch rows count what their pages count', () => {
    expect(outputs.SAMPLE_PDF.credits_used).toBe(pdfUnits(outputs.SAMPLE_PDF.pages));
    for (const row of outputs.SAMPLE_BATCH.rows) expect(row.credits_used).toBe(pdfUnits(row.pages));
  });

  it("the connection label names each plan as the pricing page does", () => {
    for (const id of PLAN_ORDER) expect(connectionLabelFor({ plan: id }, constants.DEFAULT_BASE_URL)).toBe(`${PLANS[id].name} plan`);
  });
});

describe('integrations/zapier package', () => {
  const FORBIDDEN = /stripe|lemon[\s_.-]?squeezy|puppeteer|playwright|chrome-aws-lambda|@sparticuz\/chromium/i;
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('depends on exactly one runtime package, zapier-platform-core, at an exact version', () => {
    expect(Object.keys(manifest.dependencies)).toEqual(['zapier-platform-core']);
    expect(manifest.dependencies['zapier-platform-core']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('package.json and package-lock.json name no forbidden package', () => {
    const named = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(named.filter((name) => FORBIDDEN.test(name))).toEqual([]);

    const lockPath = path.join(packageDir, 'package-lock.json');
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, { dependencies?: object; devDependencies?: object; optionalDependencies?: object }>;
    };
    const installed = Object.keys(lock.packages)
      .filter((key) => key !== '')
      .map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(installed.length).toBeGreaterThan(50);
    expect(installed.filter((name) => FORBIDDEN.test(name))).toEqual([]);
    const declared = Object.values(lock.packages).flatMap((entry) =>
      Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }),
    );
    expect(declared.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});
