// Guard rails that are about the project as a whole rather than one module:
//  - the stack stays what was promised (Paddle only, no headless browser);
//  - wrangler.toml and src/config.ts agree on routing, rate limits and the cron.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS, WORKER_PATHS } from '../../src/config';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');

/** Other payment providers and every way of shipping a headless browser. */
const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['stripe', /stripe/i],
  ['lemonsqueezy / lemon-squeezy', /lemon[\s_.-]?squeezy/i],
  ['puppeteer', /puppeteer/i],
  ['playwright', /playwright/i],
  ['chrome-aws-lambda', /chrome-aws-lambda/i],
  ['@sparticuz/chromium', /@sparticuz\/chromium/i],
];

const forbiddenIn = (text: string): string[] => FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

interface LockFile {
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
}

describe('forbidden dependencies', () => {
  it('package.json names none of them', () => {
    expect(forbiddenIn(read('package.json'))).toEqual([]);
  });

  it('package-lock.json installs none of them', () => {
    const lock = JSON.parse(read('package-lock.json')) as LockFile;
    // Installed packages are the keys ("node_modules/<name>"). A name that only appears as an
    // optional peer of a tool (vitest lists browser providers that way) is not installed.
    const installed = Object.keys(lock.packages)
      .filter((key) => key !== '')
      .map((key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
    expect(installed.length).toBeGreaterThan(50);
    expect(installed.filter((name) => forbiddenIn(name).length > 0)).toEqual([]);

    const declared = Object.values(lock.packages).flatMap((entry) =>
      Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }),
    );
    expect(declared.filter((name) => forbiddenIn(name).length > 0)).toEqual([]);
  });

  it('nothing under src/ mentions them', () => {
    const textFiles = filesUnder(path.join(root, 'src')).filter((file) => /\.(ts|js|mjs|json|sql|md|txt|html|css)$/.test(file));
    expect(textFiles.length).toBeGreaterThan(30);
    const offenders = textFiles
      .map((file) => ({ file: path.relative(root, file), names: forbiddenIn(readFileSync(file, 'utf8')) }))
      .filter((entry) => entry.names.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the check itself recognises each name', () => {
    for (const sample of ['stripe', '@stripe/stripe-js', 'lemonsqueezy', '@lemonsqueezy/lemonsqueezy.js', 'lemon-squeezy', 'puppeteer-core', 'playwright', '@playwright/test', 'chrome-aws-lambda', '@sparticuz/chromium']) {
      expect(forbiddenIn(sample), sample).not.toEqual([]);
    }
    expect(forbiddenIn('hono satori @resvg/resvg-wasm paddle')).toEqual([]);
  });
});

describe('wrangler.toml agrees with src/config.ts', () => {
  const toml = read('wrangler.toml');
  /** The file's three parts: local development (top level), staging, production. */
  const stagingAt = toml.search(/^\[env\.staging\]/m);
  const productionAt = toml.search(/^\[env\.production\]/m);
  const sections = {
    development: toml.slice(0, stagingAt),
    staging: toml.slice(stagingAt, productionAt),
    production: toml.slice(productionAt),
  };

  it('has the three sections in the expected order', () => {
    expect(stagingAt).toBeGreaterThan(0);
    expect(productionAt).toBeGreaterThan(stagingAt);
  });

  it('routes exactly the Worker paths to the Worker first', () => {
    const match = /^run_worker_first\s*=\s*\[([^\]]*)\]/m.exec(toml);
    expect(match).not.toBeNull();
    const patterns = [...match![1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
    // "/v1/*" in wrangler.toml is "/v1/" (everything below) in WORKER_PATHS.
    expect(patterns.map((pattern) => pattern.replace(/\*$/, ''))).toEqual([...WORKER_PATHS]);
  });

  it.each(Object.keys(sections) as Array<keyof typeof sections>)('%s declares every rate limiter with the documented numbers', (name) => {
    // RL_[A-Z_]+: limiter names may have several parts (RL_PDF_KEY, RL_TOOLS_PDF).
    const declared = [...sections[name].matchAll(/name = "(RL_[A-Z_]+)"\s*\nnamespace_id = "\d+"\s*\nsimple = \{ limit = (\d+), period = (\d+) \}/g)].map(
      (entry) => [entry[1], { limit: Number(entry[2]), periodSeconds: Number(entry[3]) }] as const,
    );
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(Object.entries(RATE_LIMITS).map(([limiter, rule]) => [limiter, { limit: rule.limit, periodSeconds: rule.periodSeconds }])),
    );
  });

  it.each(Object.keys(sections) as Array<keyof typeof sections>)('%s runs the cleanup once a day', (name) => {
    const header = name === 'development' ? '[triggers]' : `[env.${name}.triggers]`;
    const at = sections[name].indexOf(header);
    expect(at, header).toBeGreaterThanOrEqual(0);
    const crons = /^crons\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(sections[name].slice(at));
    expect(crons?.[1]).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});
