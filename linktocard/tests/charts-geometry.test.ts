// Geometry of the chart renderer, without the text engine: the value axis (nice steps and ticks),
// number formatting, text measurement, bars, slices, and the layout as a whole (finite numbers,
// everything inside the image, labels that never overlap).
import { describe, expect, it } from 'vitest';
import { CHARTS } from '../src/config';
import { barThickness } from '../src/charts/bar';
import { extent, layoutCartesian, thinLabels } from '../src/charts/cartesian';
import { byImportance, placeLabels } from '../src/charts/frame';
import { layoutChart } from '../src/charts/layout';
import { segmentCrosses } from '../src/charts/line';
import { fitsInSlice, layoutPie, slicePath, slices } from '../src/charts/pie';
import { markStrip } from '../src/charts/render';
import { decimalsOf, formatter, niceScale, niceStep } from '../src/charts/scale';
import { num, overlaps, shapesToSvg, type Shape, type Text } from '../src/charts/scene';
import { parseChart } from '../src/charts/spec';
import { fitText, isMeasurable, textWidth } from '../src/charts/text';
import { DARK, LIGHT, inkOn, mix, seriesColor, sizesFor } from '../src/charts/theme';
import cases from './fixtures/charts/cases.json';

describe('niceStep', () => {
  it.each([
    [100, 5, 20],
    [7100, 4, 2000],
    [1, 5, 0.2],
    [0.07, 5, 0.02],
    [1_420_000, 6, 250_000],
    [9, 4, 5],
    [3, 10, 0.5],
  ])('range %d in at most %d intervals -> %d', (range, intervals, step) => {
    expect(niceStep(range, intervals)).toBe(step);
  });

  it('never goes below 1 for whole numbers', () => {
    expect(niceStep(3, 10, true)).toBe(1);
    expect(niceStep(40, 4, true)).toBe(10);
  });

  it('uses 2.5 only where it gives whole numbers', () => {
    expect(niceStep(100, 4)).toBe(25);
    expect(niceStep(10, 4)).toBe(5);
  });
});

describe('niceScale', () => {
  it('covers the data and ends on multiples of the step', () => {
    const scale = niceScale(0, 7100, { maxIntervals: 4 });
    expect(scale).toEqual({ min: 0, max: 8000, step: 2000, ticks: [0, 2000, 4000, 6000, 8000] });
  });

  it('handles negative and positive data', () => {
    const scale = niceScale(-42000, 48000, { maxIntervals: 6 });
    expect(scale.min).toBeLessThanOrEqual(-42000);
    expect(scale.max).toBeGreaterThanOrEqual(48000);
    expect(scale.ticks).toContain(0);
    expect(scale.ticks.length - 1).toBeLessThanOrEqual(6);
    for (const tick of scale.ticks) expect(Math.abs(tick / scale.step - Math.round(tick / scale.step))).toBeLessThan(1e-9);
  });

  it('keeps decimals free of binary noise', () => {
    expect(niceScale(0, 0.3, { maxIntervals: 3 }).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('widens a flat range so that the axis still has two ends', () => {
    expect(niceScale(0, 0, { maxIntervals: 4 })).toMatchObject({ min: 0, max: 1 });
    expect(niceScale(5, 5, { maxIntervals: 4 })).toMatchObject({ min: 0 });
    expect(niceScale(5, 5, { maxIntervals: 4 }).max).toBeGreaterThanOrEqual(5);
    expect(niceScale(-5, -5, { maxIntervals: 4 })).toMatchObject({ max: 0 });
    expect(niceScale(7, 7, { maxIntervals: 4, min: 7 }).max).toBeGreaterThan(7);
    expect(niceScale(7, 7, { maxIntervals: 4, max: 7 }).min).toBeLessThan(7);
  });

  it('uses fixed ends exactly', () => {
    const scale = niceScale(3, 97, { maxIntervals: 5, min: 0, max: 100 });
    expect(scale).toMatchObject({ min: 0, max: 100 });
    expect(niceScale(3, 97, { maxIntervals: 5, min: 1.5, max: 98.5 })).toMatchObject({ min: 1.5, max: 98.5 });
  });

  it('never loops or divides by zero on ends too close to tell apart', () => {
    for (const [low, high] of [
      [1e15, 1e15 + 0.25],
      [1e15 - 1, 1e15],
      [-1e15, -1e15 + 0.5],
      [1_000_000.0000001, 1_000_000.0000002],
      [CHARTS.minAbsValue, CHARTS.minAbsValue],
    ] as const) {
      for (const options of [{}, { min: low }, { max: high }]) {
        const scale = niceScale(low, high, { maxIntervals: 6, ...options });
        expect(scale.max).toBeGreaterThan(scale.min);
        expect(scale.ticks.length).toBeGreaterThanOrEqual(1);
        expect(scale.ticks.length).toBeLessThanOrEqual(50);
        expect(scale.ticks.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it('keeps to the number of intervals asked for, for any data', () => {
    for (const [low, high] of [[0, 1], [0, 999], [-3, 17], [0.001, 0.009], [12, 13], [-1e12, 3e14], [0, CHARTS.maxAbsValue]] as const) {
      for (let maxIntervals = 1; maxIntervals <= 10; maxIntervals++) {
        const scale = niceScale(low, high, { maxIntervals });
        expect(scale.ticks.length - 1, `${low}..${high} in ${maxIntervals}`).toBeLessThanOrEqual(Math.max(maxIntervals, 4));
        expect(scale.min).toBeLessThanOrEqual(low);
        expect(scale.max).toBeGreaterThanOrEqual(high);
      }
    }
  });
});

describe('number format', () => {
  const plain = { prefix: '', suffix: '' };

  it('counts the decimals a number needs', () => {
    expect([1, 0.5, 0.25, 0.125, 1e-6].map(decimalsOf)).toEqual([0, 1, 2, 3, 6]);
  });

  it('writes numbers below 10,000 in full, with thousands separators', () => {
    const format = formatter(plain, 8000, 2000);
    expect([0, 2000, 4200, 8000].map(format.tick)).toEqual(['0', '2,000', '4,200', '8,000']);
  });

  it('writes large axes compactly', () => {
    const format = formatter(plain, 1_500_000, 250_000);
    expect([0, 250_000, 1_000_000, 1_250_000, 1_500_000].map(format.tick)).toEqual(['0', '250k', '1M', '1.25M', '1.5M']);
    expect(format.value(1_420_000)).toBe('1.42M');
    expect(format.value(812_000)).toBe('812k');
    // 999,950 must not become "1,000k".
    expect(format.value(999_950)).toBe('1M');
    expect(formatter(plain, 3e12, 1e12).tick(3e12)).toBe('3T');
    expect(formatter(plain, 5e9, 1e9).tick(5e9)).toBe('5B');
  });

  it('puts the prefix and suffix around the number and the minus sign in front', () => {
    const format = formatter({ prefix: '$', suffix: ' net' }, 50_000, 10_000);
    expect(format.tick(-42_000)).toBe('−$42k net');
    expect(format.value(6500)).toBe('$6.5k net');
    expect(formatter({ prefix: '', suffix: '%' }, 60, 20).tick(40)).toBe('40%');
  });

  it('takes decimals from the step, one more for values, or exactly as fixed', () => {
    const auto = formatter(plain, 1, 0.2);
    expect(auto.tick(0.4)).toBe('0.4');
    expect(auto.value(0.45)).toBe('0.45');
    const fixed = formatter({ ...plain, decimals: 2 }, 10, 2);
    expect(fixed.tick(4)).toBe('4.00');
    expect(fixed.value(4.567)).toBe('4.57');
    expect(formatter({ ...plain, decimals: 1 }, 1_500_000, 250_000).tick(1_250_000)).toBe('1.3M');
  });

  it('never writes "-0"', () => {
    expect(formatter(plain, 10, 2).tick(-0.0001)).toBe('0');
    expect(formatter({ ...plain, decimals: 1 }, 10, 2).value(-0.04)).toBe('0.0');
  });
});

describe('text measurement', () => {
  it('measures with the widths of the bundled Inter', () => {
    expect(textWidth('', 10)).toBe(0);
    expect(textWidth('ii', 10)).toBeLessThan(textWidth('WW', 10));
    expect(textWidth('Revenue', 20)).toBeCloseTo(2 * textWidth('Revenue', 10), 6);
    expect(textWidth('Revenue', 10, 600)).toBeGreaterThan(textWidth('Revenue', 10, 400));
  });

  it('knows which text it can measure', () => {
    expect(isMeasurable('Ünïcödé Конверсия Μετατροπή 1,234.5 €')).toBe(true);
    expect(isMeasurable('売上高')).toBe(false);
    expect(isMeasurable('🍎')).toBe(false);
  });

  it('cuts text to a width with an ellipsis', () => {
    const text = 'A very long chart title that cannot fit';
    expect(fitText(text, 1000, 10)).toBe(text);
    const cut = fitText(text, 80, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, 10)).toBeLessThanOrEqual(80);
    expect(fitText(text, 2, 10)).toBe('');
  });
});

describe('theme', () => {
  it('has eight palette colours per theme, then a neutral, then tints', () => {
    for (const theme of [LIGHT, DARK]) {
      expect(theme.palette).toHaveLength(8);
      expect(new Set(theme.palette).size).toBe(8);
      expect(seriesColor(theme, 8)).toBe(theme.neutral);
      const colours = Array.from({ length: CHARTS.maxSlices }, (_, i) => seriesColor(theme, i));
      expect(colours.every((colour) => /^#[0-9a-f]{6}$/.test(colour))).toBe(true);
      expect(new Set(colours).size).toBe(CHARTS.maxSlices);
    }
  });

  it('mixes colours and picks a readable ink', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(inkOn('#f2a600')).toBe('#0b0b0b');
    expect(inkOn('#257de0')).toBe('#ffffff');
  });

  it('scales type with the area of the chart, within bounds', () => {
    expect(sizesFor(CHARTS.minWidth, CHARTS.minHeight).font).toBe(9);
    expect(sizesFor(600, 400).font).toBe(11);
    expect(sizesFor(CHARTS.maxWidth, CHARTS.maxHeight).font).toBe(15);
  });
});

describe('marks', () => {
  it('bars: whole pixels, never thinner than one', () => {
    expect(barThickness(100, 600, 1)).toEqual({ thickness: 64, gap: 0 });
    expect(barThickness(60, 600, 3)).toEqual({ thickness: 13, gap: 2 });
    expect(barThickness(2, 600, 12).thickness).toBe(1);
  });

  it('the value axis of bars and areas includes zero; a line with little variation follows its data', () => {
    const chart = (type: string, data: number[], options = {}) => parseChart({ type, labels: data.map(String), series: [{ data }], options });
    expect(extent(chart('bar', [980, 1020]))).toEqual({ low: 0, high: 1020 });
    expect(extent(chart('line', [980, 1020]))).toEqual({ low: 976, high: 1024 });
    expect(extent(chart('line', [100, 1020]))).toEqual({ low: 0, high: 1020 });
    expect(extent(chart('bar', [-5, 3]))).toEqual({ low: -5, high: 3 });
  });

  it('stacks positive values up and negative values down', () => {
    const chart = parseChart({ type: 'bar', labels: ['a'], series: [{ data: [5] }, { data: [-2] }, { data: [4] }], options: { stacked: true } });
    expect(extent(chart)).toEqual({ low: -2, high: 9 });
  });

  it('category labels: all of them when they fit, every n-th when they do not', () => {
    const sizes = sizesFor(600, 400);
    const short = ['Jan', 'Feb', 'Mar'];
    expect(thinLabels(short, 100, sizes).map((label) => label.text)).toEqual(short);
    const days = Array.from({ length: 30 }, (_, i) => `Day ${i + 1}`);
    const shown = thinLabels(days, 18, sizes);
    expect(shown.length).toBeLessThan(30);
    expect(shown[0]!.index).toBe(0);
    const stride = shown[1]!.index - shown[0]!.index;
    expect(stride * 18).toBeGreaterThanOrEqual(shown[0]!.width);
  });

  it('value labels: the largest and the smallest first, never overlapping, never outside', () => {
    expect(byImportance([3, 9, 1, 5])).toEqual([1, 2, 3, 0]);
    const box = (x: number, y: number): Text => ({ x, y, w: 20, h: 10, text: 't', size: 9, weight: 400, color: '#000000', align: 'center' });
    const placed = placeLabels([[box(0, 0)], [box(5, 5), box(40, 0)], [box(95, 0)], [box(41, 1)]], { x: 0, y: 0, w: 100, h: 50 });
    expect(placed.map((label) => label.x)).toEqual([0, 40]);
  });

  it('a line segment crosses a box or it does not', () => {
    const box = { x: 10, y: 10, w: 10, h: 10 };
    expect(segmentCrosses({ x: 0, y: 0 }, { x: 30, y: 30 }, box)).toBe(true);
    expect(segmentCrosses({ x: 0, y: 0 }, { x: 30, y: 5 }, box)).toBe(false);
    expect(segmentCrosses({ x: 15, y: 0 }, { x: 15, y: 40 }, box)).toBe(true);
    expect(segmentCrosses({ x: 0, y: 25 }, { x: 40, y: 25 }, box)).toBe(false);
  });

  it('slices: clockwise from 12 o\'clock, in proportion, zero values left out', () => {
    const parts = slices([1, 0, 1, 2]);
    expect(parts.map((slice) => slice.index)).toEqual([0, 2, 3]);
    expect(parts[0]!.start).toBeCloseTo(-Math.PI / 2);
    expect(parts[0]!.end - parts[0]!.start).toBeCloseTo(Math.PI / 2);
    expect(parts[2]!.end).toBeCloseTo(Math.PI * 1.5);
    expect(slices([0, 0])).toEqual([]);
  });

  it('a slice path is closed and has no number that is not a number', () => {
    for (const inner of [0, 30]) {
      for (const values of [[1], [1, 1], [1, 1e-6], [5, 1, 1, 1], [1e15, 1]]) {
        for (const slice of slices(values)) {
          const path = slicePath(100, 100, 50, inner, slice, 2);
          expect(path.endsWith('Z')).toBe(true);
          expect(path).not.toMatch(/NaN|Infinity|undefined/);
        }
      }
    }
  });

  it('a label fits in its slice or it does not', () => {
    const [half] = slices([1, 1]);
    expect(fitsInSlice({ x: 110, y: 95, w: 20, h: 10 }, 100, 100, 50, 0, half!, 2)).toBe(true);
    expect(fitsInSlice({ x: 70, y: 95, w: 20, h: 10 }, 100, 100, 50, 0, half!, 2)).toBe(false);
    expect(fitsInSlice({ x: 140, y: 95, w: 20, h: 10 }, 100, 100, 50, 0, half!, 2)).toBe(false);
  });
});

describe('shapes as SVG', () => {
  it('writes numbers with two decimals at most and refuses what is not a number', () => {
    expect(num(1.23456)).toBe('1.23');
    expect(num(-0.004)).toBe('0');
    expect(() => num(NaN)).toThrow();
    expect(() => num(Infinity)).toThrow();
  });

  it('writes each kind of shape, and nothing for an empty rectangle', () => {
    const shapes: Shape[] = [
      { kind: 'rect', x: 1, y: 2, w: 3, h: 4, fill: '#112233' },
      { kind: 'rect', x: 1, y: 2, w: 0, h: 4, fill: '#112233' },
      { kind: 'rect', x: 0, y: 0, w: 10, h: 20, fill: '#112233', round: 'top', r: 3 },
      { kind: 'path', d: 'M0 0L1 1', stroke: '#445566', strokeWidth: 2 },
      { kind: 'circle', cx: 5, cy: 5, r: 2, fill: '#778899' },
      { kind: 'clip', rect: { x: 0, y: 0, w: 9, h: 9 }, shapes: [{ kind: 'circle', cx: 1, cy: 1, r: 1, fill: '#000000' }] },
    ];
    const svg = shapesToSvg(shapes);
    expect(svg).toContain('<rect x="1" y="2" width="3" height="4" fill="#112233"/>');
    expect(svg.match(/<rect /g)).toHaveLength(2);
    expect(svg).toContain('<path d="M0 20V3Q0 0 3 0H7Q10 0 10 3V20Z" fill="#112233"/>');
    expect(svg).toContain('stroke="#445566" stroke-width="2"');
    expect(svg).toContain('<clipPath id="chart-clip-0">');
    expect(svg).toContain('clip-path="url(#chart-clip-0)"');
    // The only url() in the markup is the reference to the chart's own clip path.
    expect(svg.match(/url\(/g)).toHaveLength(1);
  });

  it('rectangles overlap or they do not', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 5, h: 5 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }, 1)).toBe(true);
  });
});

describe('the whole layout', () => {
  const awkward: Array<[string, unknown]> = [
    ['one point', { type: 'line', labels: ['a'], series: [{ data: [0] }] }],
    ['all zero pie', { type: 'pie', labels: ['a', 'b'], series: [{ data: [0, 0] }] }],
    ['one slice doughnut', { type: 'doughnut', labels: ['a'], series: [{ data: [5] }], options: { values: true } }],
    ['largest numbers', { type: 'bar', labels: ['a', 'b'], series: [{ data: [CHARTS.maxAbsValue, -CHARTS.maxAbsValue] }], options: { values: true } }],
    ['smallest numbers', { type: 'area', labels: ['a', 'b'], series: [{ data: [CHARTS.minAbsValue, 2 * CHARTS.minAbsValue] }], options: { values: true } }],
    ['nearly equal large numbers', { type: 'line', labels: ['a', 'b'], series: [{ data: [1e15, 1e15 - 1] }], options: { values: true } }],
    ['fixed axis beside the data', { type: 'bar', labels: ['a', 'b'], series: [{ data: [5, 9] }], options: { min: 100, max: 200, values: true } }],
    ['smallest size, everything on', { type: 'bar', title: 'T'.repeat(200), subtitle: 'S'.repeat(200), labels: Array.from({ length: 40 }, (_, i) => `Label ${i}`), series: Array.from({ length: 12 }, (_, s) => ({ name: `Series ${s}`, data: Array.from({ length: 40 }, (_, i) => i - s) })), options: { values: true, x_title: 'X', y_title: 'Y', horizontal: true }, width: CHARTS.minWidth, height: CHARTS.minHeight }],
    ['long affixes, horizontal, small', { type: 'bar', labels: ['a', 'b', 'c'], series: [{ data: [1200, 3400, 560] }], options: { horizontal: true, values: true, prefix: 'P'.repeat(CHARTS.maxAffixChars), suffix: 'S'.repeat(CHARTS.maxAffixChars) }, width: CHARTS.minWidth, height: CHARTS.minHeight }],
    ['long affixes, pie with legend, small', { type: 'pie', labels: ['a'.repeat(100), 'b', 'c'], series: [{ data: [1200, 3400, 1] }], options: { values: true, prefix: 'P'.repeat(CHARTS.maxAffixChars), suffix: 'S'.repeat(CHARTS.maxAffixChars) }, width: 300, height: CHARTS.minHeight }],
    ['smallest size, vertical, everything on', { type: 'line', title: 'T'.repeat(200), subtitle: 'S'.repeat(200), labels: Array.from({ length: 40 }, (_, i) => `Label ${i}`), series: Array.from({ length: 12 }, (_, s) => ({ name: `Series number ${s}`, data: Array.from({ length: 40 }, (_, i) => i * s) })), options: { values: true, x_title: 'X', y_title: 'Y', prefix: 'P'.repeat(CHARTS.maxAffixChars) }, width: CHARTS.minWidth, height: CHARTS.minHeight }],
    ['many slices, small', { type: 'pie', labels: Array.from({ length: CHARTS.maxSlices }, (_, i) => `Slice ${i}`), series: [{ data: Array.from({ length: CHARTS.maxSlices }, (_, i) => i) }], options: { values: true }, width: CHARTS.minWidth, height: CHARTS.minHeight }],
  ];
  const all: Array<[string, unknown]> = [...cases.map((entry): [string, unknown] => [entry.id, entry.spec]), ...awkward];

  it.each(all)('%s: every coordinate is a number, every text box is in the image', (_name, input) => {
    const chart = parseChart(input);
    for (const footer of [0, 40]) {
      const scene = layoutChart(chart, { footer });
      // num() throws for a coordinate that is not a number.
      const svg = shapesToSvg(scene.shapes);
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
      for (const text of scene.texts) {
        for (const value of [text.x, text.y, text.w, text.h, text.size]) expect(Number.isFinite(value), `"${text.text}"`).toBe(true);
        if (text.text === '' || text.rotate) continue;
        expect(text.x, `"${text.text}" left`).toBeGreaterThanOrEqual(-0.5);
        expect(text.x + text.w, `"${text.text}" right`).toBeLessThanOrEqual(chart.width + 0.5);
        expect(text.y, `"${text.text}" top`).toBeGreaterThanOrEqual(-0.5);
        expect(text.y + text.h, `"${text.text}" bottom`).toBeLessThanOrEqual(chart.height - footer + 0.5);
      }
      expect(scene).toMatchObject({ width: chart.width, height: chart.height });
    }
  });

  it('leaves nothing out of the 12 trial cases: the last line of defence has nothing to do', () => {
    for (const entry of cases) {
      const chart = parseChart(entry.spec);
      const sizes = sizesFor(chart.width, chart.height);
      const theme = chart.theme === 'dark' ? DARK : LIGHT;
      for (const footer of [0, markStrip(chart.width)]) {
        const body = { ...chart, height: chart.height - footer };
        const raw = chart.type === 'pie' || chart.type === 'doughnut' ? layoutPie(body, theme, sizes) : layoutCartesian(body, theme, sizes);
        expect(layoutChart(chart, { footer }).texts.length, `${entry.id} with a footer of ${footer}`).toBe(raw.texts.length);
      }
    }
  });

  it('paints the background of the theme, or the chart\'s own', () => {
    const base = { type: 'bar', labels: ['a'], series: [{ data: [1] }] };
    expect(layoutChart(parseChart(base)).background).toBe(LIGHT.surface);
    expect(layoutChart(parseChart({ ...base, options: { theme: 'dark' } })).background).toBe(DARK.surface);
    expect(layoutChart(parseChart({ ...base, options: { background: '#abc' } })).background).toBe('#aabbcc');
    expect(layoutChart(parseChart({ ...base, options: { background: 'transparent' } })).background).toBe('transparent');
  });
});
