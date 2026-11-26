// The Bulk tab's CSV reader (site/public/assets/js/dashboard/csv.js): RFC 4180 plus what real
// spreadsheet exports do (BOM, CR line ends, semicolons, "sep=" lines, ragged rows).
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Parsed {
  delimiter: string;
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
  total: number;
  skipped: number;
  overLimit: boolean;
  problems: string[];
  warnings: string[];
}
interface Csv {
  DELIMITERS: string[];
  DELIMITER_NAMES: Record<string, string>;
  columnLetter(index: number): string;
  stripBom(text: string): string;
  sniffDelimiter(text: string, options?: { sampleChars?: number; sampleRecords?: number }): string;
  parseCsv(text: string, options?: { delimiter?: string; maxRows?: number; maxColumns?: number }): Parsed;
}

const csv = (await import(pathToFileURL(join(ROOT, 'site/public/assets/js/dashboard/csv.js')).href)) as Csv;
const { parseCsv, sniffDelimiter, columnLetter } = csv;

describe('parseCsv: RFC 4180', () => {
  it('reads a header and rows', () => {
    const parsed = parseCsv('name,city\nAmara,Lagos\nDaniel,Austin\n');
    expect(parsed.headers).toEqual(['name', 'city']);
    expect(parsed.rows).toEqual([
      ['Amara', 'Lagos'],
      ['Daniel', 'Austin'],
    ]);
    expect(parsed).toMatchObject({ delimiter: ',', total: 2, skipped: 0, overLimit: false, problems: [], warnings: [] });
    // The header is row 1, as in the spreadsheet.
    expect(parsed.rowNumbers).toEqual([2, 3]);
  });

  it('keeps delimiters, line breaks and doubled quotes inside quoted values', () => {
    const parsed = parseCsv('name,note\n"Lund, Okafor","He said ""hi""\nthen left"\n"","x"\n');
    expect(parsed.rows).toEqual([
      ['Lund, Okafor', 'He said "hi"\nthen left'],
      ['', 'x'],
    ]);
    expect(parsed.rowNumbers).toEqual([2, 3]);
  });

  it('accepts CRLF, LF and lone CR record ends, and turns line breaks inside values into \\n', () => {
    const expected = [
      ['1', 'a\nb'],
      ['2', 'c'],
    ];
    expect(parseCsv('n,v\r\n1,"a\r\nb"\r\n2,c\r\n').rows).toEqual(expected);
    expect(parseCsv('n,v\n1,"a\nb"\n2,c').rows).toEqual(expected);
    expect(parseCsv('n,v\r1,"a\rb"\r2,c\r').rows).toEqual(expected);
  });

  it('drops a UTF-8 byte order mark, so the first column is matched by its real name', () => {
    const parsed = parseCsv('﻿recipient_name,date\nAmara,2026-11-25\n');
    expect(parsed.headers[0]).toBe('recipient_name');
    expect(csv.stripBom('﻿x')).toBe('x');
    expect(csv.stripBom('x﻿')).toBe('x﻿');
  });

  it('reads a last record without a final line break, and a trailing line break adds no row', () => {
    expect(parseCsv('a,b\n1,2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([['1', '2']]);
    expect(parseCsv('a,b\n1,2\r\n').total).toBe(1);
  });

  it('keeps empty values, including a trailing empty one', () => {
    expect(parseCsv('a,b,c\n1,,\n,2,\n').rows).toEqual([
      ['1', '', ''],
      ['', '2', ''],
    ]);
  });

  it('keeps stray quotes in unquoted values and text after a closing quote, as spreadsheet apps do', () => {
    expect(parseCsv('a,b\n5" screen,"x"y\n').rows).toEqual([['5" screen', 'xy']]);
  });

  it('trims header names but never values (rowData trims what it sends)', () => {
    const parsed = parseCsv(' Name , City \n  Amara , Lagos \n');
    expect(parsed.headers).toEqual(['Name', 'City']);
    expect(parsed.rows).toEqual([['  Amara ', ' Lagos ']]);
  });

  it('reads non-ASCII text as it is', () => {
    expect(parseCsv('name\nZoë Ångström\n李雷\n').rows).toEqual([['Zoë Ångström'], ['李雷']]);
  });
});

describe('parseCsv: blank and ragged rows', () => {
  it('skips blank rows and rows of empty values, counts them, and keeps spreadsheet row numbers', () => {
    const parsed = parseCsv('name,city\n\nAmara,Lagos\n,\n  ,  \nDaniel,Austin\n');
    expect(parsed.rows).toEqual([
      ['Amara', 'Lagos'],
      ['Daniel', 'Austin'],
    ]);
    expect(parsed.skipped).toBe(3);
    expect(parsed.total).toBe(2);
    expect(parsed.rowNumbers).toEqual([3, 6]);
  });

  it('starts at the first row that is not blank', () => {
    const parsed = parseCsv('\n\nname\nAmara\n');
    expect(parsed.headers).toEqual(['name']);
    expect(parsed.rowNumbers).toEqual([4]);
    expect(parsed.skipped).toBe(0);
  });

  it('pads short rows and says so once, naming the first', () => {
    const parsed = parseCsv('a,b,c\n1,2,3\n4\n5,6\n');
    expect(parsed.rows).toEqual([
      ['1', '2', '3'],
      ['4', '', ''],
      ['5', '6', ''],
    ]);
    expect(parsed.warnings).toEqual(['2 rows have fewer values than there are columns (first: row 3). The missing values are left empty.']);
  });

  it('ignores extra values: silently when they are empty, with a warning when they are not', () => {
    expect(parseCsv('a,b\n1,2,,\n').warnings).toEqual([]);
    const parsed = parseCsv('a,b\n1,2\n3,4,5\n');
    expect(parsed.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parsed.warnings).toEqual(['1 row has more values than there are columns (first: row 3). The extra values are ignored: check that the file uses one separator throughout.']);
  });

  it('warns about two columns of the same name, ignoring case', () => {
    const parsed = parseCsv('Email,name,email\nx,y,z\n');
    expect(parsed.warnings).toEqual(['Columns A and C are both named "email". Only one of them is matched automatically.']);
    expect(parseCsv(',\n1,2\n').warnings).toEqual([]);
  });

  it('warns when characters could not be decoded (a file that is not UTF-8)', () => {
    const parsed = parseCsv('name\nZo�\n');
    expect(parsed.problems).toEqual([]);
    expect(parsed.warnings).toEqual(['Some characters could not be read and show as �. Save the spreadsheet as "CSV UTF-8" and choose the new file.']);
  });
});

describe('parseCsv: limits and refusals', () => {
  it('keeps at most maxRows rows but counts them all, so the page can say how many there are', () => {
    const text = `n\n${Array.from({ length: 30 }, (_, index) => String(index + 1)).join('\n')}\n`;
    const parsed = parseCsv(text, { maxRows: 25 });
    expect(parsed.rows).toHaveLength(25);
    expect(parsed.rowNumbers).toHaveLength(25);
    expect(parsed.total).toBe(30);
    expect(parsed.overLimit).toBe(true);
    expect(parseCsv(text, { maxRows: 30 }).overLimit).toBe(false);
  });

  it('refuses a quoted value that never closes, naming the row it starts in', () => {
    const parsed = parseCsv('name,note\nAmara,"ok"\nDaniel,"never closed\nBo,x\n');
    expect(parsed.problems).toEqual(['A quoted value that starts in row 3 is never closed. Check that row for a missing closing quote (").']);
    expect(parseCsv('"name\nx').problems[0]).toMatch(/starts in row 1 /);
  });

  it('refuses binary files, empty files and files without data rows', () => {
    expect(parseCsv('PK\u0003\u0004\u0000\u0000').problems).toEqual(['This file is not plain text. Export the spreadsheet as CSV and choose that file.']);
    expect(parseCsv('').problems).toEqual(['The file is empty.']);
    expect(parseCsv('\n\n , \n').problems).toEqual(['The file is empty.']);
    expect(parseCsv('name,city\n').problems).toEqual(['The file has a header row but no rows below it.']);
    expect(parseCsv('name,city\n\n,\n').problems).toEqual(['The file has a header row but no rows below it.']);
  });

  it('refuses more columns than allowed (a file that is not really a CSV), and none by default', () => {
    const wide = `${Array.from({ length: 12 }, (_, index) => `c${index}`).join(',')}\n${'x,'.repeat(11)}x\n`;
    expect(parseCsv(wide, { maxColumns: 10 }).problems).toEqual(['This file has more than 10 columns. Remove the columns you do not need, or check that it is a CSV file.']);
    expect(parseCsv(wide).problems).toEqual([]);
    expect(parseCsv(wide, { maxColumns: 12 }).headers).toHaveLength(12);
  });

  it('reads a 2,000-row file quickly', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => `Person ${index},"Course, part ${index}","Line one\nline two",2026-11-${String((index % 28) + 1).padStart(2, '0')}`);
    const text = `recipient_name,achievement,note,date\r\n${rows.join('\r\n')}\r\n`;
    const started = performance.now();
    const parsed = parseCsv(text, { maxRows: 2000 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(parsed.total).toBe(2000);
    expect(parsed.rows[1999]).toEqual(['Person 1999', 'Course, part 1999', 'Line one\nline two', '2026-11-12']);
    expect(parsed.rowNumbers[1999]).toBe(2001);
  });
});

describe('delimiters', () => {
  it('sniffs commas, semicolons and tabs', () => {
    expect(sniffDelimiter('name,city\nAmara,Lagos\n')).toBe(',');
    expect(sniffDelimiter('name;amount\nAmara;1,50\nDaniel;2,00\n')).toBe(';');
    expect(sniffDelimiter('name\tcity\nAmara\tLagos\n')).toBe('\t');
    expect(parseCsv('name;amount\nAmara;1,50\n').rows).toEqual([['Amara', '1,50']]);
    expect(parseCsv('name\tnote\nAmara\ta, b; c\n').rows).toEqual([['Amara', 'a, b; c']]);
  });

  it('ignores delimiters inside quoted values', () => {
    expect(sniffDelimiter('"a;b;c;d";x\n"1;2;3;4";y\n')).toBe(';');
    expect(sniffDelimiter('name,note\n"Amara","x;y;z;w"\n"Bo","p;q;r;s"\n')).toBe(',');
  });

  it('prefers the delimiter that splits every row the same way', () => {
    // Both split the header in two; only semicolons split every row in two (commas: 2, 2, 3).
    const text = 'name,id;city\nAmara,1;Lagos\nLund, Okafor, Ltd;Oslo\n';
    expect(sniffDelimiter(text)).toBe(';');
    // The same widths everywhere: the wider split wins, and the comma wins a full tie.
    expect(sniffDelimiter('a;b,c,d\n1;2,3,4\n')).toBe(',');
    expect(sniffDelimiter('a;b,c\n1;2,3\n')).toBe(',');
  });

  it('falls back to the comma for a single column', () => {
    expect(sniffDelimiter('name\nAmara\nDaniel\n')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });

  it('reads Excel\'s "sep=" line, which names the delimiter and is not the header', () => {
    const parsed = parseCsv('sep=;\r\nname,x;city\r\nAmara,1;Lagos\r\n');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.headers).toEqual(['name,x', 'city']);
    expect(parsed.rowNumbers).toEqual([3]);
    expect(sniffDelimiter('SEP=\t\nname\tcity\n')).toBe('\t');
    expect(parseCsv('sep=,\nname\n"open').problems[0]).toMatch(/starts in row 3 /);
  });

  it('uses a given delimiter instead of sniffing', () => {
    expect(parseCsv('a;b\n1;2\n', { delimiter: ',' }).rows).toEqual([['1;2']]);
  });

  it('sniffs from the first records of a long file, even when the sample ends mid-record', () => {
    const long = `name;note\n${'Amara;"a, b, c"\n'.repeat(5000)}`;
    expect(sniffDelimiter(long, { sampleChars: 1000 })).toBe(';');
    expect(sniffDelimiter(`name;note\n"${'x,'.repeat(2000)}";y\n`, { sampleChars: 200 })).toBe(';');
  });

  it('names each delimiter for the file summary', () => {
    expect(csv.DELIMITERS).toEqual([',', ';', '\t']);
    for (const delimiter of csv.DELIMITERS) expect(csv.DELIMITER_NAMES[delimiter]).toMatch(/^[a-z]+s$/);
  });
});

describe('columnLetter', () => {
  it('counts like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});
