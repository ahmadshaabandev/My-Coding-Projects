// Cross-language proof for signed URLs: the Node, PHP and Python reference
// signers in examples/signing must print exactly the URL the TypeScript
// implementation (the one the Worker verifies with) produces.
//
// Regenerate the vector's expected fields after an intentional change with:
//   UPDATE_SIGNING_VECTOR=1 npx vitest run -c vitest.node.config.ts tests/node/signing-vectors.test.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

interface SigningInput {
  secret: string;
  base_url: string;
  site_id: string;
  template: string;
  ext: string;
  params: Record<string, string>;
}

/** The part of src/lib/signed-url.ts this file uses. */
interface WorkerSigner {
  canonicalString(pathname: string, params: Iterable<[string, string]>): string;
  signCanonical(secret: string, canonical: string): Promise<string>;
  buildSignedUrl(input: {
    baseUrl: string;
    siteId: string;
    template: string;
    ext: string;
    params: Record<string, string>;
    secret: string;
  }): Promise<string>;
}

interface Expected {
  canonical: string;
  signature: string;
  url: string;
}

type Vector = { description: string } & SigningInput & Expected;

interface Signer {
  name: string;
  command: string;
  file: string;
}

const examplesDir = fileURLToPath(new URL('../../examples/signing/', import.meta.url));
const vectorPath = join(examplesDir, 'vector.json');
const vector = JSON.parse(readFileSync(vectorPath, 'utf8')) as Vector;
const scratchDir = mkdtempSync(join(tmpdir(), 'ltc-signing-'));

// The Worker's implementation is loaded through a computed path on purpose: a
// static import would pull Worker source into the Node tsconfig (DOM lib),
// where src/lib/crypto.ts does not type-check.
const workerSignerPath = fileURLToPath(new URL('../../src/lib/signed-url.ts', import.meta.url));
const worker = (await import(workerSignerPath)) as WorkerSigner;

const SIGNERS: Signer[] = [
  { name: 'node', command: process.execPath, file: 'sign.mjs' },
  { name: 'php', command: 'php', file: 'sign.php' },
  { name: 'python3', command: 'python3', file: 'sign.py' },
];

/** What the reference signers do to control characters before signing. */
const cleanValue = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ');

const cleanParams = (params: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(params).map(([name, value]) => [name, cleanValue(value)]));

/** The TypeScript implementation's answer for an input. */
async function expectedFor(input: SigningInput): Promise<Expected> {
  const canonical = worker.canonicalString(`/v1/og/${input.site_id}/${input.template}.${input.ext}`, Object.entries(input.params));
  return {
    canonical,
    signature: await worker.signCanonical(input.secret, canonical),
    url: await worker.buildSignedUrl({
      baseUrl: input.base_url,
      siteId: input.site_id,
      template: input.template,
      ext: input.ext,
      params: input.params,
      secret: input.secret,
    }),
  };
}

function isInstalled(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

/** Runs a reference signer from an unrelated working directory and returns its stdout. */
function runSigner(signer: Signer, inputFile?: string): string {
  const args = [join(examplesDir, signer.file), ...(inputFile ? [inputFile] : [])];
  const result = spawnSync(signer.command, args, { encoding: 'utf8', cwd: scratchDir });
  if (result.error || result.status !== 0) {
    throw new Error(`${signer.file} failed (status ${result.status}): ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function writeInput(name: string, input: SigningInput): string {
  const file = join(scratchDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(input));
  return file;
}

const BASE: Omit<SigningInput, 'params'> = {
  secret: 'ltcs_another_example_secret_for_tests_only_0000',
  base_url: 'https://cards.example',
  site_id: 's_0a1b2c3d4e5f6g7h',
  template: 't_custom-card_01',
  ext: 'webp',
};

/** Inputs beyond the published vector, chosen where languages and encoders tend to disagree. */
const EXTRA_CASES: Record<string, SigningInput> = {
  'name ordering is by byte value': { ...BASE, params: { b: '5', ab: '4', a_b: '3', a1: '2', a: '1' } },
  'reserved and awkward ASCII': {
    ...BASE,
    ext: 'jpg',
    params: { title: '100% "quoted" <b>bold</b> #hash ?query=1', literal: '%41+%2B %zz', path: 'C:\\temp\\file', empty: '' },
  },
  'non-Latin scripts and astral characters': {
    ...BASE,
    ext: 'jpeg',
    params: { arabic: 'مرحبا بالعالم', cjk: '日本語のタイトル', math: '𝒜 ≠ ℬ', family: '👩🏽‍🚀 + 👨‍👩‍👧‍👦' },
  },
  'no parameters at all': { ...BASE, ext: 'png', params: {} },
  'control characters are replaced, never signed': {
    ...BASE,
    params: { title: 'line one\nv=2', tabbed: 'a\tb', crlf: 'x\r\ny', nul: 'p\u0000q\u007fr' },
  },
};

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

describe('examples/signing/vector.json', () => {
  it('is exactly what the TypeScript implementation produces', async () => {
    const expected = await expectedFor(vector);
    if (process.env.UPDATE_SIGNING_VECTOR === '1') {
      writeFileSync(vectorPath, `${JSON.stringify({ ...vector, ...expected }, null, 2)}\n`);
      return;
    }
    expect({ canonical: vector.canonical, signature: vector.signature, url: vector.url }).toEqual(expected);
  });

  it('covers the characters URL encoders disagree on', () => {
    const text = Object.values(vector.params).join('');
    for (const char of [' ', '&', '/', '~', "'", '*', '(', ')', '!', '+', '=']) {
      expect(text, `vector params should contain ${JSON.stringify(char)}`).toContain(char);
    }
    expect(text).toMatch(/[\u00c0-\u024f]/);
    expect(text).toMatch(/\p{Extended_Pictographic}/u);
  });

  it('lists the query in a different order than the canonical string, with sig last', () => {
    const names = [...new URL(vector.url).searchParams.keys()];
    expect(names).toEqual([...Object.keys(vector.params), 'sig']);
    expect(names.slice(0, -1)).not.toEqual([...names.slice(0, -1)].sort());
    const sortedNames = Object.keys(vector.params).sort();
    const lines = vector.canonical.split('\n');
    expect(lines[1]).toBe(sortedNames.join(','));
    expect(lines.slice(2).map((line) => line.split('=')[0])).toEqual(sortedNames);
  });
});

describe.each(SIGNERS)('reference signer: $name ($file)', (signer) => {
  // A missing interpreter shows up as a skipped test with this name, never as a pass.
  const maybe = it.skipIf(!isInstalled(signer.command));

  maybe(`${signer.name}: prints the vector URL (default input)`, () => {
    expect(runSigner(signer)).toBe(`${vector.url}\n`);
  });

  maybe(`${signer.name}: prints the vector URL (input file argument)`, () => {
    expect(runSigner(signer, vectorPath)).toBe(`${vector.url}\n`);
  });

  for (const [title, input] of Object.entries(EXTRA_CASES)) {
    maybe(`${signer.name}: matches TypeScript - ${title}`, async () => {
      const expected = await expectedFor({ ...input, params: cleanParams(input.params) });
      expect(runSigner(signer, writeInput(`${signer.name}-${title.replace(/\W+/g, '-')}`, input))).toBe(`${expected.url}\n`);
    });
  }
});
