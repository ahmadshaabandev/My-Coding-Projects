// wrangler.toml and src/config.ts agree on the build v3 settings, in each of the three sections
// (local development at the top level, staging, production):
//  - the bulk-documents queue: one producer (BATCH_QUEUE) and one consumer per section, on a
//    queue of its own, with exactly the BATCH numbers and no other key (wrangler only warns on
//    an unknown key, so a typo would silently fall back to a default);
//  - the kill switches: on for development and staging, off for production.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BATCH, FEATURE_FLAGS } from '../../src/config';

const root = fileURLToPath(new URL('../..', import.meta.url));
const toml = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
const stagingAt = toml.search(/^\[env\.staging\]/m);
const productionAt = toml.search(/^\[env\.production\]/m);
const SECTIONS = {
  development: { text: toml.slice(0, stagingAt), prefix: '', queue: 'linktocard-batch-dev', switches: 'true' },
  staging: { text: toml.slice(stagingAt, productionAt), prefix: 'env.staging.', queue: 'linktocard-batch-staging', switches: 'true' },
  production: { text: toml.slice(productionAt), prefix: 'env.production.', queue: 'linktocard-batch-production', switches: 'false' },
} as const;
type SectionName = keyof typeof SECTIONS;
const NAMES = Object.keys(SECTIONS) as SectionName[];

/** The key = value lines of every [[header]] table in a section (up to the next header or blank line). */
function tables(text: string, header: string): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== `[[${header}]]`) continue;
    const entries: Record<string, string> = {};
    for (let j = i + 1; j < lines.length && lines[j]!.trim() !== '' && !lines[j]!.trim().startsWith('['); j++) {
      const line = lines[j]!.trim();
      if (line.startsWith('#')) continue;
      const match = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
      expect(match, `${header}: ${line}`).not.toBeNull();
      entries[match![1]!] = match![2]!.replace(/^"(.*)"$/, '$1');
    }
    found.push(entries);
  }
  return found;
}

describe('the bulk-documents queue in wrangler.toml', () => {
  it.each(NAMES)('%s has one producer and one consumer on its own queue, with the BATCH numbers', (name) => {
    const section = SECTIONS[name];
    expect(tables(section.text, `${section.prefix}queues.producers`)).toEqual([{ binding: 'BATCH_QUEUE', queue: section.queue }]);
    expect(tables(section.text, `${section.prefix}queues.consumers`)).toEqual([
      {
        queue: section.queue,
        max_batch_size: String(BATCH.queueMaxBatchSize),
        max_batch_timeout: String(BATCH.queueMaxBatchTimeoutSeconds),
        max_retries: String(BATCH.queueMaxRetries),
        max_concurrency: String(BATCH.maxConsumerConcurrency),
        retry_delay: String(BATCH.retryDelaySeconds),
      },
    ]);
    // A queue block of another section's spelling would land in the wrong environment.
    for (const other of NAMES.filter((candidate) => candidate !== name)) {
      expect(section.text, `${name} names ${other}'s queue`).not.toContain(SECTIONS[other].queue);
    }
  });

  it('retries a row inside the queue: the consumer gives up on a row before Queues deletes its message', () => {
    expect(BATCH.queueMaxRetries).toBeGreaterThanOrEqual(BATCH.maxRowAttempts);
    expect(new Set(NAMES.map((name) => SECTIONS[name].queue)).size).toBe(NAMES.length);
  });
});

describe('the build v3 kill switches in wrangler.toml', () => {
  it.each(NAMES)('%s sets each of them, "true" outside production and "false" in production', (name) => {
    const section = SECTIONS[name];
    const header = name === 'development' ? '[vars]' : `[env.${name}.vars]`;
    const at = section.text.indexOf(`\n${header}\n`);
    expect(at, header).toBeGreaterThanOrEqual(0);
    const end = section.text.indexOf('\n[', at + header.length + 1);
    const vars = section.text.slice(at, end < 0 ? undefined : end);
    for (const variable of Object.values(FEATURE_FLAGS)) {
      const values = [...vars.matchAll(new RegExp(`^${variable}\\s*=\\s*"([^"]*)"\\s*$`, 'gm'))].map((match) => match[1]);
      expect(values, `${name} ${variable}`).toEqual([section.switches]);
    }
    // Bulk documents need PDFs too: production keeps both off.
    const pdf = [...vars.matchAll(/^PDF_ENABLED\s*=\s*"([^"]*)"\s*$/gm)].map((match) => match[1]);
    expect(pdf).toEqual([section.switches]);
  });
});
