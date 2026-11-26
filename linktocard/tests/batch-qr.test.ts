// QR codes for certificates (src/lib/qr.ts): the data: URI is decoded back to its SVG, the path
// is turned back into a module grid by a parser written here, and the grid is checked against the
// QR standard's fixed patterns (finders, timing, format information with its BCH code) as well as
// against uqr's matrix. resvg then draws the SVG to prove a real renderer paints exactly those
// modules, and the PDF sanitiser must pass the URI through unchanged.
import { isTag, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { PDF } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { qrPathData, qrSvgDataUri, type QrEcc } from '../src/lib/qr';
import { preparePdfDocument, validatePdfData, type PdfData } from '../src/pdf/template';
import { rasterize } from '../src/render/engine';

const PREFIX = 'data:image/svg+xml,';

interface DecodedQr {
  svg: string;
  root: Element;
  side: number;
  background: Element | undefined;
  modules: Element;
  grid: boolean[][];
}

/** Turns "M4,4h7m2,0h1..." back into dark cells; throws on anything but integer M/m/h steps. */
function rasterizePath(d: string, side: number): boolean[][] {
  const grid = Array.from({ length: side }, () => new Array<boolean>(side).fill(false));
  const commands = d.match(/[A-Za-z][^A-Za-z]*/g) ?? [];
  expect(commands.join('')).toBe(d);
  let x = 0;
  let y = 0;
  for (const command of commands) {
    const letter = command[0]!;
    const numbers = (command.slice(1).match(/-?\d+/g) ?? []).map(Number);
    expect(command.slice(1).replace(/-?\d+/g, '').replace(/,/g, ''), command).toBe('');
    if (letter === 'M' || letter === 'm') {
      expect(numbers, command).toHaveLength(2);
      x = letter === 'M' ? numbers[0]! : x + numbers[0]!;
      y = letter === 'M' ? numbers[1]! : y + numbers[1]!;
    } else if (letter === 'h') {
      expect(numbers, command).toHaveLength(1);
      const length = numbers[0]!;
      expect(length, command).toBeGreaterThan(0);
      for (let column = x; column < x + length; column++) {
        expect(grid[y]![column], `cell ${column},${y} drawn twice`).toBe(false);
        grid[y]![column] = true;
      }
      x += length;
    } else {
      throw new Error(`unexpected path command ${command}`);
    }
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(side);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(side);
  }
  return grid;
}

function decode(uri: string): DecodedQr {
  expect(uri.startsWith(PREFIX)).toBe(true);
  const body = uri.slice(PREFIX.length);
  // Only characters that need no escaping in a URL or a double-quoted HTML attribute.
  expect(body).toMatch(/^[A-Za-z0-9%'=/:.,-]+$/);
  const svg = decodeURIComponent(body);
  const document = parseDocument(svg, { xmlMode: true });
  const roots = document.children.filter(isTag);
  expect(roots).toHaveLength(1);
  const root = roots[0]!;
  expect(root.name).toBe('svg');
  expect(root.attribs.xmlns).toBe('http://www.w3.org/2000/svg');
  expect(root.attribs['shape-rendering']).toBe('crispEdges');
  expect(root.attribs.width).toBeUndefined();
  const viewBox = /^0 -\.5 (\d+) \1$/.exec(root.attribs.viewBox ?? '');
  expect(viewBox, root.attribs.viewBox).not.toBeNull();
  const side = Number(viewBox![1]);
  const paths = root.children.filter(isTag);
  expect(paths.every((path) => path.name === 'path' && path.children.length === 0)).toBe(true);
  const modules = paths.filter((path) => path.attribs.stroke !== undefined);
  expect(modules).toHaveLength(1); // every dark module in one path
  const background = paths.find((path) => path.attribs.fill !== undefined);
  expect(paths).toHaveLength(background ? 2 : 1);
  if (background) expect(background.attribs.d).toBe(`M0-.5h${side}v${side}H0z`);
  return { svg, root, side, background, modules: modules[0]!, grid: rasterizePath(modules[0]!.attribs.d!, side) };
}

const darkCount = (grid: readonly (readonly boolean[])[]): number => grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

/** The code without its quiet zone, checking that the zone is entirely light. */
function code(decoded: DecodedQr, margin: number): boolean[][] {
  decoded.grid.forEach((row, y) =>
    row.forEach((dark, x) => {
      const inZone = x < margin || y < margin || x >= decoded.side - margin || y >= decoded.side - margin;
      if (inZone) expect(dark, `quiet zone ${x},${y}`).toBe(false);
    }),
  );
  return decoded.grid.slice(margin, decoded.side - margin).map((row) => row.slice(margin, decoded.side - margin));
}

const ECC_BITS: Record<number, QrEcc> = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

/**
 * Reads the 15-bit format information from both of its copies (ISO/IEC 18004: next to the
 * top-left finder, and split between the other two), checks they agree and that the BCH(15,5)
 * code is valid, and returns the error correction level and mask it states.
 */
function formatInformation(grid: boolean[][]): { ecc: QrEcc; mask: number } {
  const size = grid.length;
  const bit = (x: number, y: number): number => (grid[y]![x] ? 1 : 0);
  let first = 0;
  for (let i = 0; i <= 5; i++) first |= bit(8, i) << i;
  first |= bit(8, 7) << 6;
  first |= bit(8, 8) << 7;
  first |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i++) first |= bit(14 - i, 8) << i;
  let second = 0;
  for (let i = 0; i < 8; i++) second |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) second |= bit(8, size - 15 + i) << i;
  expect(second).toBe(first);
  expect(bit(8, size - 8)).toBe(1); // the module that is always dark
  const unmasked = first ^ 0x5412;
  const data = unmasked >>> 10;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  expect(unmasked & 0x3ff).toBe(remainder & 0x3ff);
  return { ecc: ECC_BITS[data >>> 3]!, mask: data & 7 };
}

/** The three 7x7 finder patterns with their light separators, and both timing patterns. */
function expectFixedPatterns(grid: boolean[][]): void {
  const size = grid.length;
  for (const [left, top] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = left + dx;
        const y = top + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        expect(grid[y]![x], `finder at ${left},${top}: ${dx},${dy}`).toBe(ring !== 2 && ring !== 4);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    expect(grid[6]![i], `timing row ${i}`).toBe(i % 2 === 0);
    expect(grid[i]![6], `timing column ${i}`).toBe(i % 2 === 0);
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function certificateId(seed: number): string {
  let x = seed >>> 0 || 1;
  let id = 'crt_';
  for (let i = 0; i < 20; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    id += B32[(x >>> 0) % 32];
  }
  return id;
}
const PRODUCTION_VERIFY_URL = `https://linktocard.com/v/${certificateId(1)}`;

describe('qrSvgDataUri: sizes and error correction for known inputs', () => {
  it.each([
    // text, ecc asked, modules per side, ecc in the code (raised when the same size has room)
    ['HELLO WORLD', 'Q', 21, 'Q'],
    ['HELLO WORLD', 'L', 21, 'Q'],
    ['HELLO WORLD', 'H', 25, 'H'],
    ['01234567', 'L', 21, 'H'],
    ['شهادة', 'L', 21, 'Q'],
    [PRODUCTION_VERIFY_URL, 'L', 29, 'L'],
    [PRODUCTION_VERIFY_URL, 'M', 33, 'M'],
    ['a'.repeat(2953), 'L', 177, 'L'],
  ] as const)('%#: %s… at %s -> %i modules, level %s', (text, ecc, modules, stated) => {
    const decoded = decode(qrSvgDataUri(text, { ecc }));
    expect(decoded.side).toBe(modules + 8); // default quiet zone: 4 modules each side
    const grid = code(decoded, 4);
    expect(grid).toHaveLength(modules);
    expectFixedPatterns(grid);
    const format = formatInformation(grid);
    expect(format.ecc).toBe(stated);
    const reference = encode(text, { ecc, boostEcc: true, border: 0 });
    expect(reference.version).toBe((modules - 17) / 4);
    expect(format.mask).toBe(reference.maskPattern);
    expect(darkCount(grid)).toBe(darkCount(reference.data));
    expect(grid).toEqual(reference.data);
  });

  it('defaults to level L with a 4-module quiet zone, black on white', () => {
    const uri = qrSvgDataUri(PRODUCTION_VERIFY_URL);
    expect(uri).toBe(qrSvgDataUri(PRODUCTION_VERIFY_URL, { ecc: 'L', margin: 4, dark: '#000', light: '#fff' }));
    const decoded = decode(uri);
    expect(decoded.modules.attribs.stroke).toBe('#000');
    expect(decoded.background?.attribs.fill).toBe('#fff');
  });

  it('honours margin, colours and light "none"', () => {
    for (const margin of [0, 1, 2, 10]) {
      const decoded = decode(qrSvgDataUri('HELLO WORLD', { ecc: 'Q', margin }));
      expect(decoded.side).toBe(21 + 2 * margin);
      expect(code(decoded, margin)).toEqual(encode('HELLO WORLD', { ecc: 'Q', boostEcc: true, border: 0 }).data);
    }
    const coloured = decode(qrSvgDataUri('HELLO WORLD', { dark: '#1A2B3C', light: '#FFF8E7' }));
    expect(coloured.modules.attribs.stroke).toBe('#1a2b3c');
    expect(coloured.background?.attribs.fill).toBe('#fff8e7');
    const transparent = decode(qrSvgDataUri('HELLO WORLD', { light: 'none' }));
    expect(transparent.background).toBeUndefined();
  });

  it('encodes text with a lone surrogate (as U+FFFD) instead of throwing', () => {
    const decoded = decode(qrSvgDataUri('x\uD800y'));
    expect(code(decoded, 4)).toEqual(encode('x\uFFFDy', { ecc: 'L', boostEcc: true, border: 0 }).data);
  });

  it('qrPathData draws runs with the shorter of absolute and relative moves', () => {
    const rows = [
      [true, true, false, true],
      [false, false, false, false],
      [true, false, false, true],
    ];
    // Same length: absolute. With two-digit coordinates the relative move is shorter.
    expect(qrPathData(rows, 0)).toBe('M0,0h2M3,0h1M0,2h1M3,2h1');
    expect(qrPathData(rows, 10)).toBe('M10,10h2m1,0h1m-4,2h1m2,0h1');
    expect(qrPathData([[false]], 0)).toBe('');
  });
});

describe('qrSvgDataUri: refused input', () => {
  const refuse = (run: () => unknown): ApiError => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('invalid_request');
      return error as ApiError;
    }
    throw new Error('expected an ApiError');
  };

  it('empty or too long text', () => {
    expect(refuse(() => qrSvgDataUri('')).message).toMatch(/needs some text/);
    expect(refuse(() => qrSvgDataUri('a'.repeat(2954))).message).toMatch(/too long/);
    expect(refuse(() => qrSvgDataUri('a'.repeat(1300), { ecc: 'H' })).message).toMatch(/too long/);
  });

  it('bad margin, level or colours, and codes that would be inverted', () => {
    for (const margin of [-1, 1.5, Number.NaN]) refuse(() => qrSvgDataUri('x', { margin }));
    refuse(() => qrSvgDataUri('x', { ecc: 'X' as QrEcc }));
    for (const dark of ['red', '#12', '#12345g', "#000' onload='x", 'url(#a)', 'none']) refuse(() => qrSvgDataUri('x', { dark }));
    for (const light of ['white', '#ffff', 'transparent']) refuse(() => qrSvgDataUri('x', { light }));
    expect(refuse(() => qrSvgDataUri('x', { dark: '#fff', light: '#000' })).message).toMatch(/darker/);
    refuse(() => qrSvgDataUri('x', { dark: '#777', light: '#777' }));
  });
});

describe('a real renderer paints exactly the modules', () => {
  it.each([
    ['HELLO WORLD', {}],
    [PRODUCTION_VERIFY_URL, {}],
    [PRODUCTION_VERIFY_URL, { margin: 1, dark: '#173a5e' }],
  ] as const)('resvg draws %s with every module solid', async (text, opts) => {
    const decoded = decode(qrSvgDataUri(text, opts));
    const scale = 6;
    const raster = await rasterize(decoded.svg, decoded.side * scale);
    expect(raster.width).toBe(decoded.side * scale);
    expect(raster.height).toBe(decoded.side * scale);
    const dark = 'dark' in opts ? [0x17, 0x3a, 0x5e] : [0, 0, 0];
    let mismatches = 0;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const expected = decoded.grid[Math.floor(y / scale)]![Math.floor(x / scale)] ? dark : [255, 255, 255];
        const at = (y * raster.width + x) * 4;
        if (raster.pixels[at] !== expected[0] || raster.pixels[at + 1] !== expected[1] || raster.pixels[at + 2] !== expected[2]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });
});

describe('the PDF sanitiser keeps the URI unchanged', () => {
  it('as a {{placeholder}} in <img src> and written into the template', () => {
    const uri = qrSvgDataUri(PRODUCTION_VERIFY_URL);
    const inputs: { html: string; data: PdfData }[] = [
      { html: '<img class="qr" src="{{verify_qr}}" alt="">', data: { verify_qr: uri } },
      { html: `<img class="qr" src="${uri}" alt="">`, data: {} },
    ];
    for (const input of inputs) {
      const prepared = preparePdfDocument({ ...input, css: '' });
      expect(prepared.warnings).toEqual([]);
      expect(prepared.remoteUrls).toEqual([]);
      // The serialiser writes an empty attribute bare (alt); the src value is byte for byte the URI.
      expect(prepared.render(() => undefined)).toContain(`<body><img class="qr" src="${uri}" alt></body>`);
    }
  });

  it('an optional QR (empty value) leaves the <img> out, like an optional logo', () => {
    const html = preparePdfDocument({ html: '<p>x</p><img class="qr" src="{{verify_qr}}" alt="">', css: '', data: {} }).render(() => undefined);
    expect(html).toContain('<body><p>x</p></body>');
  });

  it('fits in one PDF data value for linktocard.com verification links', () => {
    let longest = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const uri = qrSvgDataUri(`https://linktocard.com/v/${certificateId(seed)}`);
      longest = Math.max(longest, uri.length);
      expect(validatePdfData({ verify_qr: uri }).verify_qr).toBe(uri);
    }
    expect(longest).toBeLessThanOrEqual(PDF.maxDataValueChars);
  });
});
