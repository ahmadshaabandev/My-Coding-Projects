// Page ranges of the PDF toolkit (src/pdftools/pages.ts): split's "ranges", merge's and stamp's "pages".
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import { parsePageRanges, rangeIndexes, selectPages } from '../src/pdftools/pages';

function failure(spec: string, pages: number): ApiError {
  try {
    parsePageRanges(spec, pages);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error(`"${spec}" was accepted`);
}

describe('parsePageRanges', () => {
  it('reads single pages, closed and open ranges, ignoring spaces', () => {
    expect(parsePageRanges('1-3, 5 ,8-', 10)).toEqual([
      { from: 1, to: 3, label: '1-3' },
      { from: 5, to: 5, label: '5' },
      { from: 8, to: 10, label: '8-10' },
    ]);
    expect(parsePageRanges('4-4', 4)).toEqual([{ from: 4, to: 4, label: '4' }]);
  });

  it('keeps the order and repeats the caller wrote (split makes one file per item)', () => {
    expect(parsePageRanges('5,1-2,5', 5).map((r) => r.label)).toEqual(['5', '1-2', '5']);
  });

  it('refuses what is not a range, with the field name and the item in the message', () => {
    for (const spec of ['', ' ', 'a', '1--2', '-3', '1-2-3', '1.5', '1;2', '2-a']) {
      const error = failure(spec, 10);
      expect(error.code).toBe('invalid_request');
      expect(error.message.startsWith('pages:')).toBe(true);
    }
    expect(failure('x', 10).message).toContain('"x"');
  });

  it('refuses page 0, backwards ranges and pages the document does not have', () => {
    expect(failure('0', 10).message).toMatch(/numbered from 1/);
    expect(failure('5-3', 10).message).toMatch(/backwards/);
    expect(failure('1-12', 10).message).toMatch(/page 12, but the document has 10 pages/);
    expect(failure('2', 1).message).toMatch(/has 1 page\./);
    expect(failure('11-', 10).message).toMatch(/page 11/);
  });

  it('refuses specs longer than any operation could use, before splitting them', () => {
    expect(failure('1,'.repeat(501).slice(0, -1), 1).message).toMatch(/501 items; at most 500/);
    expect(failure('1,'.repeat(1_000_000), 1).message).toMatch(/too long/);
    expect(parsePageRanges(Array.from({ length: 500 }, () => '1').join(','), 1)).toHaveLength(500);
    expect(() => parsePageRanges(42 as unknown as string, 3)).toThrow(/must be a string/);
  });

  it('uses the caller\'s field name', () => {
    expect(() => parsePageRanges('z', 3, 'ranges')).toThrow(/^ranges: /);
  });
});

describe('selectPages', () => {
  it('means every page when absent or "all"', () => {
    expect(selectPages(undefined, 3)).toEqual([0, 1, 2]);
    expect(selectPages(' ALL ', 2)).toEqual([0, 1]);
  });

  it('gives sorted 0-based indexes without repeats', () => {
    expect(selectPages('3,1-2,2', 5)).toEqual([0, 1, 2]);
    expect(selectPages('5-', 6)).toEqual([4, 5]);
  });

  it('turns a range into its indexes', () => {
    expect(rangeIndexes({ from: 3, to: 5, label: '3-5' })).toEqual([2, 3, 4]);
  });
});
