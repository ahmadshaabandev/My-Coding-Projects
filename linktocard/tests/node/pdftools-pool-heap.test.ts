// pdf-lib keeps every PDFRef and PDFName it ever made in module-level pools; before
// src/pdftools/pools.ts, four toolkit requests of 250,000 distinct references each left
// 157 MB of heap behind in Node (15 MB before), more than a Worker isolate has (security review
// SEC-1). The work runs in a child process with --expose-gc (tests/node/helpers/pdf-pool-heap.mts),
// so the heap is measured after real collections.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('./helpers/pdf-pool-heap.mts', import.meta.url));
const MB = 1024 * 1024;

function heaps(kind: 'refs' | 'names'): number[] {
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', SCRIPT, kind, '250000', '4'], { cwd: ROOT, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.trim().split('\n').at(-1)!;
  return (JSON.parse(line) as { heaps: number[] }).heaps;
}

describe("pdf-lib's object pools do not keep what earlier requests parsed", () => {
  for (const kind of ['refs', 'names'] as const) {
    it(`four documents of 250,000 distinct ${kind === 'refs' ? 'references' : 'names'} leave the heap flat after the first`, () => {
      const [, first, ...later] = heaps(kind);
      // At most the last request's dead pool entries stay until the next one starts (they are
      // swept then); nothing piles up. Without the fix each round added 28 to 43 MB.
      for (const heap of later) expect((heap - first!) / MB).toBeLessThan(8);
    });
  }
});
