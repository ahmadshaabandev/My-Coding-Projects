// A CSV reader for the dashboard's Bulk tab: RFC 4180 as spreadsheet apps export it.
// Pure: no DOM and no fetch, so tests/node/csv.test.ts covers every rule here.
//
// Beyond the RFC's letter, because real exports do it:
//   - a UTF-8 byte order mark (Excel's "CSV UTF-8") is dropped;
//   - records end with CRLF, LF or a lone CR (old Mac exports); a line break inside a quoted
//     value becomes "\n", whatever the file used, so an address prints the same either way;
//   - the delimiter is a comma, a semicolon (Excel where the decimal mark is a comma) or a tab,
//     sniffed from the first records unless given; Excel's "sep=;" first line names it outright;
//   - a quote inside an unquoted value, or text after a closing quote, is kept as written (as
//     spreadsheet apps and Python's csv module do) instead of failing the whole file;
//   - blank records, and records whose values are all empty (",,,": a row deleted in the
//     spreadsheet), are skipped and counted;
//   - a record with fewer values than the header is padded with empty values; extra values are
//     ignored, silently when they are empty (trailing delimiters).
// Refused: a quoted value that never closes, NUL characters (not a text file), and more columns
// than the caller allows.
//
// Row numbers are the spreadsheet's: the header is row 1 and blank rows count, so "row 7" is
// the row a person sees when they open the file again.

export const DELIMITERS = [',', ';', '\t'];

/** How the file summary names a delimiter: "separated by semicolons". */
export const DELIMITER_NAMES = { ',': 'commas', ';': 'semicolons', '\t': 'tabs' };

const SEP_LINE = /^sep=([,;\t])[ ]*(?:\r\n|\r|\n|$)/i;
const NEWLINES = /\r\n|\r|\n/g;
const REPLACEMENT = '�';

/** 0 -> "A", 25 -> "Z", 26 -> "AA": the spreadsheet's column letters. */
export function columnLetter(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const isLineEnd = (char) => char === '\n' || char === '\r';

/**
 * Reads records from `text` and hands each to onRecord(fields); onRecord returning false stops
 * the scan. Returns { unterminated }: the 1-based index of the record whose quoted value never
 * closes, or 0.
 */
function scan(text, delimiter, onRecord) {
  const length = text.length;
  let fields = [];
  let record = 1;
  let i = 0;
  for (;;) {
    let value;
    if (text[i] === '"') {
      let out = '';
      let from = i + 1;
      for (;;) {
        const quote = text.indexOf('"', from);
        if (quote === -1) return { unterminated: record };
        out += text.slice(from, quote);
        if (text[quote + 1] === '"') {
          out += '"';
          from = quote + 2;
          continue;
        }
        from = quote + 1;
        break;
      }
      let end = from;
      while (end < length && text[end] !== delimiter && !isLineEnd(text[end])) end++;
      // Text after the closing quote is kept, as spreadsheet apps keep it.
      value = out.replace(NEWLINES, '\n') + text.slice(from, end);
      i = end;
    } else {
      let end = i;
      while (end < length && text[end] !== delimiter && !isLineEnd(text[end])) end++;
      value = text.slice(i, end);
      i = end;
    }
    fields.push(value);
    if (i >= length) {
      onRecord(fields);
      return { unterminated: 0 };
    }
    if (text[i] === delimiter) {
      i++;
      continue;
    }
    i += text[i] === '\r' && text[i + 1] === '\n' ? 2 : 1;
    if (onRecord(fields) === false) return { unterminated: 0 };
    fields = [];
    record++;
    // A final line break ends the last record; it does not start an empty one.
    if (i >= length) return { unterminated: 0 };
  }
}

const isBlank = (fields) => fields.every((value) => value.trim() === '');

/**
 * The delimiter a file most likely uses: the candidate whose first records split into the
 * same number of values (two or more) most consistently, the wider split winning a tie, and
 * the comma when nothing splits at all. Delimiters inside quoted values do not count.
 */
export function sniffDelimiter(input, { sampleChars = 64 * 1024, sampleRecords = 20 } = {}) {
  const text = stripBom(String(input ?? ''));
  const sep = SEP_LINE.exec(text);
  if (sep) return sep[1];
  const sample = text.slice(0, sampleChars);
  const cut = sample.length < text.length;
  let best = { delimiter: DELIMITERS[0], score: 0 };
  for (const delimiter of DELIMITERS) {
    const widths = [];
    let enough = false;
    const { unterminated } = scan(sample, delimiter, (fields) => {
      if (!isBlank(fields)) widths.push(fields.length);
      enough = widths.length > sampleRecords;
      return !enough;
    });
    // A sample cut mid-file ends in a partial record, which says nothing about the delimiter.
    // (A scan that stopped early, or inside an open quote, never handed that record over.)
    if (cut && !enough && !unterminated) widths.pop();
    const head = widths[0] ?? 0;
    if (head < 2) continue;
    const share = widths.filter((width) => width === head).length / widths.length;
    const score = share * 1000 + Math.min(head, 999);
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/**
 * Parses a whole file.
 * @param input     the file's text
 * @param options   delimiter: skip sniffing; maxRows: data rows to keep (all are still counted);
 *                  maxColumns: the most columns accepted
 * @returns {
 *   delimiter, headers: string[] (trimmed), rows: string[][] (as wide as headers),
 *   rowNumbers: number[] (each kept row's spreadsheet row), total (data rows in the file),
 *   skipped (blank rows), overLimit (total > maxRows),
 *   problems: string[] (the file cannot be used), warnings: string[] (it can, but look)
 * }
 */
export function parseCsv(input, { delimiter, maxRows = Infinity, maxColumns = Infinity } = {}) {
  let text = stripBom(String(input ?? ''));
  const result = { delimiter: DELIMITERS[0], headers: [], rows: [], rowNumbers: [], total: 0, skipped: 0, overLimit: false, problems: [], warnings: [] };
  if (text.includes('\u0000')) {
    result.problems.push('This file is not plain text. Export the spreadsheet as CSV and choose that file.');
    return result;
  }

  let record = 0;
  const sep = SEP_LINE.exec(text);
  if (sep) {
    text = text.slice(sep[0].length);
    record = 1;
  }
  result.delimiter = delimiter ?? (sep ? sep[1] : sniffDelimiter(text));

  let header = null;
  const short = { count: 0, first: 0 };
  const long = { count: 0, first: 0 };
  let tooWide = false;
  const { unterminated } = scan(text, result.delimiter, (fields) => {
    record++;
    if (header === null) {
      if (isBlank(fields)) return true;
      if (fields.length > maxColumns) {
        tooWide = true;
        return false;
      }
      header = fields.map((name) => name.trim());
      return true;
    }
    if (isBlank(fields)) {
      result.skipped++;
      return true;
    }
    result.total++;
    if (result.rows.length >= maxRows) return true;
    const width = header.length;
    let row = fields;
    if (fields.length < width) {
      row = [...fields, ...Array(width - fields.length).fill('')];
      short.count++;
      short.first ||= record;
    } else if (fields.length > width) {
      if (!isBlank(fields.slice(width))) {
        long.count++;
        long.first ||= record;
      }
      row = fields.slice(0, width);
    }
    result.rows.push(row);
    result.rowNumbers.push(record);
    return true;
  });

  // scan() counts the records after the "sep=" line, which is row 1 of the spreadsheet.
  if (unterminated) {
    const row = unterminated + (sep ? 1 : 0);
    result.problems.push(`A quoted value that starts in row ${row} is never closed. Check that row for a missing closing quote (").`);
  }
  if (tooWide) {
    result.problems.push(`This file has more than ${maxColumns} columns. Remove the columns you do not need, or check that it is a CSV file.`);
    return result;
  }
  if (header === null) {
    if (!unterminated) result.problems.push('The file is empty.');
    return result;
  }
  result.headers = header;
  if (result.total === 0 && !unterminated) result.problems.push('The file has a header row but no rows below it.');
  result.overLimit = result.total > maxRows;

  if (short.count > 0) {
    result.warnings.push(`${plural(short.count, 'row has', 'rows have')} fewer values than there are columns (first: row ${short.first}). The missing values are left empty.`);
  }
  if (long.count > 0) {
    result.warnings.push(
      `${plural(long.count, 'row has', 'rows have')} more values than there are columns (first: row ${long.first}). The extra values are ignored: check that the file uses one separator throughout.`,
    );
  }
  const seen = new Map();
  header.forEach((name, index) => {
    const key = name.toLowerCase();
    if (key === '') return;
    if (seen.has(key)) result.warnings.push(`Columns ${columnLetter(seen.get(key))} and ${columnLetter(index)} are both named "${name}". Only one of them is matched automatically.`);
    else seen.set(key, index);
  });
  if (header.some((name) => name.includes(REPLACEMENT)) || result.rows.some((row) => row.some((value) => value.includes(REPLACEMENT)))) {
    result.warnings.push('Some characters could not be read and show as �. Save the spreadsheet as "CSV UTF-8" and choose the new file.');
  }
  return result;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}
