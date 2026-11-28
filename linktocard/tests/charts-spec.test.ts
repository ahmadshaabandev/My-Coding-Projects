// Chart JSON validation: strict (unknown fields refused, finite numbers, hex colours only), every
// limit read from CHARTS, 400 invalid_request with a message and details.field that name the field.
import { describe, expect, it } from 'vitest';
import { CHARTS, EMAIL_FIELDS, LIMITS } from '../src/config';
import { canonicalChart, parseChart, parseChartJson, CHART_FIELDS } from '../src/charts/spec';
import { ApiError } from '../src/lib/errors';

const base = { type: 'bar', labels: ['A', 'B'], series: [{ data: [1, 2] }] };

function refused(input: unknown): { field: unknown; message: string } {
  try {
    parseChart(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError).toMatchObject({ code: 'invalid_request', status: 400 });
    return { field: apiError.details?.field, message: apiError.message };
  }
  throw new Error('the chart was accepted');
}

describe('defaults', () => {
  it('fills in every default', () => {
    expect(parseChart(base)).toEqual({
      type: 'bar',
      title: '',
      subtitle: '',
      labels: ['A', 'B'],
      series: [{ name: 'Series 1', data: [1, 2] }],
      horizontal: false,
      stacked: false,
      legend: false,
      values: false,
      xTitle: '',
      yTitle: '',
      format: { prefix: '', suffix: '' },
      theme: 'light',
      width: CHARTS.defaultWidth,
      height: CHARTS.defaultHeight,
      scale: 1,
    });
  });

  it('shows a legend by default for a pie and for more than one series', () => {
    expect(parseChart({ ...base, type: 'pie' }).legend).toBe(true);
    expect(parseChart({ ...base, series: [{ data: [1, 2] }, { data: [3, 4] }] }).legend).toBe(true);
    expect(parseChart({ ...base, type: 'pie', options: { legend: false } }).legend).toBe(false);
  });

  it('checks "horizontal" and "stacked" on every type and applies them where they belong', () => {
    expect(parseChart({ ...base, type: 'line', options: { horizontal: true, stacked: true } })).toMatchObject({ horizontal: false, stacked: false });
    expect(parseChart({ ...base, type: 'area', options: { horizontal: true, stacked: true } })).toMatchObject({ horizontal: false, stacked: true });
    expect(parseChart({ ...base, options: { horizontal: true, stacked: true } })).toMatchObject({ horizontal: true, stacked: true });
    expect(refused({ ...base, type: 'line', options: { stacked: 'yes' } }).field).toBe('options.stacked');
  });

  it('accepts numbers as labels and writes them as text', () => {
    expect(parseChart({ ...base, labels: [2025, 2026] }).labels).toEqual(['2025', '2026']);
  });

  it('makes one line of every text and keeps the spaces of an affix', () => {
    const chart = parseChart({ ...base, title: '  Two\nlines\t ', labels: [`a${String.fromCharCode(0x2028)}b`, 'c'], options: { suffix: ' kg' } });
    expect(chart.title).toBe('Two lines');
    expect(chart.labels[0]).toBe('a b');
    expect(chart.format.suffix).toBe(' kg');
  });
});

describe('strictness', () => {
  it('refuses unknown fields at every level and names them', () => {
    expect(refused({ ...base, titel: 'x' })).toMatchObject({ field: 'titel', message: expect.stringContaining(CHART_FIELDS.join(', ')) });
    expect(refused({ ...base, options: { stack: true } }).field).toBe('options.stack');
    expect(refused({ ...base, series: [{ data: [1, 2], colour: '#fff' }] }).field).toBe('series[0].colour');
    // "format" belongs to POST /v1/charts, which says so; the chart JSON itself has no such field.
    expect(refused({ ...base, format: 'png' }).field).toBe('format');
    expect(parseChart({ ...base, format: 'png' }, ['format']).type).toBe('bar');
  });

  it('refuses what is not an object', () => {
    for (const input of [null, [], 'bar', 7, undefined]) expect(refused(input).field).toBe('chart');
    expect(refused({ ...base, options: [] }).field).toBe('options');
    expect(refused({ ...base, series: ['x'] }).field).toBe('series[0]');
  });

  it('refuses an unknown type and lists the types', () => {
    expect(refused({ ...base, type: 'radar' })).toMatchObject({ field: 'type', message: expect.stringContaining(CHARTS.types.join(', ')) });
    expect(refused({ labels: ['A'], series: [{ data: [1] }] }).field).toBe('type');
  });

  it.each([NaN, Infinity, -Infinity, '5', null, true, [1], {}])('refuses %s as a value', (value) => {
    expect(refused({ ...base, series: [{ data: [1, value] }] })).toMatchObject({ field: 'series[0].data[1]', message: expect.stringContaining('finite number') });
  });

  it('refuses numbers out of range, and tiny ones that could not be drawn', () => {
    expect(refused({ ...base, series: [{ data: [1, CHARTS.maxAbsValue * 10] }] }).field).toBe('series[0].data[1]');
    expect(refused({ ...base, series: [{ data: [-CHARTS.maxAbsValue * 10, 1] }] }).field).toBe('series[0].data[0]');
    expect(refused({ ...base, series: [{ data: [CHARTS.minAbsValue / 10, 1] }] }).field).toBe('series[0].data[0]');
    expect(refused({ ...base, options: { min: 1e300 } }).field).toBe('options.min');
    expect(parseChart({ ...base, series: [{ data: [CHARTS.maxAbsValue, -CHARTS.minAbsValue] }] }).series[0]!.data).toEqual([CHARTS.maxAbsValue, -CHARTS.minAbsValue]);
    expect(Object.is(parseChart({ ...base, series: [{ data: [-0, 1] }] }).series[0]!.data[0], 0)).toBe(true);
  });

  it('takes colours as "#rgb" or "#rrggbb" only', () => {
    expect(parseChart({ ...base, series: [{ data: [1, 2], color: '#AbC' }], options: { background: '#0F0F0F' } })).toMatchObject({
      series: [{ color: '#aabbcc' }],
      background: '#0f0f0f',
    });
    expect(parseChart({ ...base, options: { background: 'transparent' } }).background).toBe('transparent');
    for (const color of ['red', 'rgb(0,0,0)', '#12', '#12345', '#1234567', 'url(https://example.com/x)', '#fff;fill:url(x)', '', 0x123456, null]) {
      expect(refused({ ...base, series: [{ data: [1, 2], color }] }).field, String(color)).toBe('series[0].color');
      expect(refused({ ...base, options: { background: color } }).field, String(color)).toBe('options.background');
    }
  });

  it('refuses wrong kinds of text and switches', () => {
    expect(refused({ ...base, title: 5 }).field).toBe('title');
    expect(refused({ ...base, subtitle: null }).field).toBe('subtitle');
    expect(refused({ ...base, labels: ['A', null] }).field).toBe('labels[1]');
    expect(refused({ ...base, labels: ['A', { text: 'B' }] }).field).toBe('labels[1]');
    expect(refused({ ...base, series: [{ name: 1, data: [1, 2] }] }).field).toBe('series[0].name');
    expect(refused({ ...base, options: { values: 1 } }).field).toBe('options.values');
    expect(refused({ ...base, options: { legend: 'true' } }).field).toBe('options.legend');
    expect(refused({ ...base, options: { theme: 'blue' } }).field).toBe('options.theme');
    expect(refused({ ...base, options: { x_title: [] } }).field).toBe('options.x_title');
  });

  it('wants one value per label in every series', () => {
    expect(refused({ ...base, series: [{ data: [1] }] })).toMatchObject({ field: 'series[0].data', message: expect.stringContaining('1 values but there are 2 labels') });
    expect(refused({ ...base, series: [{ data: [1, 2] }, { data: '1,2' }] }).field).toBe('series[1].data');
    expect(refused({ ...base, series: [] }).field).toBe('series');
    expect(refused({ ...base, labels: [] }).field).toBe('labels');
    expect(refused({ type: 'bar', series: [{ data: [] }] }).field).toBe('labels');
  });

  it('keeps a pie to one series without negative values', () => {
    expect(refused({ ...base, type: 'pie', series: [{ data: [1, 2] }, { data: [1, 2] }] }).field).toBe('series');
    expect(refused({ ...base, type: 'doughnut', series: [{ data: [1, -2] }] }).field).toBe('series[0].data[1]');
  });

  it('checks the ends of the value axis', () => {
    expect(refused({ ...base, options: { min: 5, max: 5 } }).field).toBe('options.max');
    expect(refused({ ...base, options: { min: 5, max: 1 } }).field).toBe('options.max');
    expect(refused({ ...base, options: { min: 1e12, max: 1e12 + 1e-3 } })).toMatchObject({ field: 'options.max', message: expect.stringContaining('too close') });
    expect(parseChart({ ...base, options: { min: -5, max: 10 } })).toMatchObject({ min: -5, max: 10 });
  });
});

describe('limits (all from CHARTS)', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => `L${i}`);
  const series = (points: number, count = 1) => Array.from({ length: count }, () => ({ data: new Array<number>(points).fill(1) }));

  it('series and points', () => {
    expect(parseChart({ type: 'line', labels: many(CHARTS.maxPoints), series: series(CHARTS.maxPoints, CHARTS.maxSeries) }).series).toHaveLength(CHARTS.maxSeries);
    expect(refused({ type: 'line', labels: many(CHARTS.maxPoints + 1), series: series(CHARTS.maxPoints + 1) })).toMatchObject({ field: 'labels', message: expect.stringContaining(String(CHARTS.maxPoints)) });
    expect(refused({ type: 'line', labels: many(2), series: series(2, CHARTS.maxSeries + 1) })).toMatchObject({ field: 'series', message: expect.stringContaining(String(CHARTS.maxSeries)) });
    expect(parseChart({ type: 'pie', labels: many(CHARTS.maxSlices), series: series(CHARTS.maxSlices) }).labels).toHaveLength(CHARTS.maxSlices);
    expect(refused({ type: 'pie', labels: many(CHARTS.maxSlices + 1), series: series(CHARTS.maxSlices + 1) }).field).toBe('labels');
  });

  it.each([
    ['title', CHARTS.maxTitleChars, (text: string) => ({ ...base, title: text })],
    ['subtitle', CHARTS.maxSubtitleChars, (text: string) => ({ ...base, subtitle: text })],
    ['labels[0]', CHARTS.maxLabelChars, (text: string) => ({ ...base, labels: [text, 'B'] })],
    ['series[0].name', CHARTS.maxSeriesNameChars, (text: string) => ({ ...base, series: [{ name: text, data: [1, 2] }] })],
    ['options.x_title', CHARTS.maxAxisTitleChars, (text: string) => ({ ...base, options: { x_title: text } })],
    ['options.y_title', CHARTS.maxAxisTitleChars, (text: string) => ({ ...base, options: { y_title: text } })],
    ['options.prefix', CHARTS.maxAffixChars, (text: string) => ({ ...base, options: { prefix: text } })],
    ['options.suffix', CHARTS.maxAffixChars, (text: string) => ({ ...base, options: { suffix: text } })],
  ] as const)('%s: at most %i characters, counted as code points', (field, max, build) => {
    expect(() => parseChart(build('é'.repeat(max)))).not.toThrow();
    // An emoji is one character (two UTF-16 units).
    expect(() => parseChart(build('😀'.repeat(max)))).not.toThrow();
    expect(refused(build('x'.repeat(max + 1)))).toMatchObject({ field, message: expect.stringContaining(String(max)) });
  });

  it('width, height, scale and total pixels', () => {
    expect(parseChart({ ...base, width: CHARTS.minWidth, height: CHARTS.minHeight })).toMatchObject({ width: CHARTS.minWidth, height: CHARTS.minHeight });
    expect(parseChart({ ...base, width: CHARTS.maxWidth, height: CHARTS.maxHeight })).toMatchObject({ width: CHARTS.maxWidth, height: CHARTS.maxHeight });
    expect(refused({ ...base, width: CHARTS.minWidth - 1 }).field).toBe('width');
    expect(refused({ ...base, width: CHARTS.maxWidth + 1 }).field).toBe('width');
    expect(refused({ ...base, height: CHARTS.minHeight - 1 }).field).toBe('height');
    expect(refused({ ...base, height: CHARTS.maxHeight + 1 }).field).toBe('height');
    expect(refused({ ...base, width: 600.5 }).field).toBe('width');
    expect(refused({ ...base, height: '400' }).field).toBe('height');
    for (const scale of [0, 3, 1.5, '2', null]) expect(refused({ ...base, scale }).field).toBe('scale');
    expect(CHARTS.scales).toEqual([1, 2]);
    // 750 x 500 at scale 2 is exactly the cap; one pixel wider is over it.
    expect(parseChart({ ...base, width: 750, height: 500, scale: 2 }).scale).toBe(2);
    expect(refused({ ...base, width: 751, height: 500, scale: 2 })).toMatchObject({ field: 'scale', message: expect.stringContaining(String(CHARTS.maxPixels)) });
    expect(CHARTS.maxPixels).toBeLessThanOrEqual(LIMITS.maxRenderPixels);
    expect(CHARTS.maxWidth * CHARTS.maxHeight).toBeLessThanOrEqual(CHARTS.maxPixels);
  });

  it('decimals', () => {
    expect(parseChart({ ...base, options: { decimals: CHARTS.maxDecimals } }).format.decimals).toBe(CHARTS.maxDecimals);
    for (const decimals of [-1, CHARTS.maxDecimals + 1, 1.5, '2']) expect(refused({ ...base, options: { decimals } }).field).toBe('options.decimals');
  });

  it('JSON text: size and syntax', () => {
    expect(parseChartJson(JSON.stringify(base)).type).toBe('bar');
    expect(() => parseChartJson('{"type":')).toThrowError(expect.objectContaining({ code: 'invalid_request', details: { field: 'chart' } }));
    const padded = JSON.stringify({ ...base, title: 'x' }).replace('"x"', `"${' '.repeat(CHARTS.maxJsonBytes)}"`);
    expect(() => parseChartJson(padded)).toThrowError(expect.objectContaining({ code: 'payload_too_large', status: 413 }));
    expect(CHARTS.maxJsonBytes).toBeLessThanOrEqual(LIMITS.maxRequestBodyBytes);
  });

  it('remembers a charge as long as an email image is remembered', () => {
    expect(CHARTS.chargeMemoryDays).toBe(EMAIL_FIELDS.chargeMemoryDays);
  });
});

describe('the canonical form', () => {
  const canonical = (input: unknown): string => canonicalChart(parseChart(input));
  const chart = {
    type: 'bar',
    title: 'Revenue',
    labels: ['Jan', 'Feb'],
    series: [{ name: 'A', data: [1, 2.5], color: '#aabbcc' }],
    options: { values: true, prefix: '$' },
    width: 600,
    height: 400,
  };

  it('does not depend on key order, white space, number spelling or colour spelling', () => {
    const reordered = '{ "height": 400, "width": 600,\n "options": {"prefix": "$", "values": true}, "series": [{"color": "#ABC", "data": [1.0, 25e-1], "name": "A"}],\n "labels": ["Jan", "Feb"], "title": "Revenue", "type": "bar" }';
    expect(canonicalChart(parseChartJson(reordered))).toBe(canonical(chart));
  });

  it('is the same with a default written out or left out', () => {
    const { width: _w, height: _h, ...withoutSize } = chart;
    expect(canonical({ ...withoutSize, scale: 1, subtitle: '', options: { ...chart.options, legend: false, theme: 'light', stacked: false } })).toBe(canonical(chart));
  });

  it('changes with everything that changes the picture', () => {
    const variants: unknown[] = [
      { ...chart, type: 'line' },
      { ...chart, title: 'Revenue ' + '2' },
      { ...chart, subtitle: 's' },
      { ...chart, labels: ['Jan', 'Mar'] },
      { ...chart, series: [{ ...chart.series[0], data: [1, 2.6] }] },
      { ...chart, series: [{ ...chart.series[0], name: 'B' }] },
      { ...chart, series: [{ ...chart.series[0], color: '#aabbcd' }] },
      { ...chart, width: 601 },
      { ...chart, height: 401 },
      { ...chart, scale: 2 },
      ...[{ horizontal: true }, { stacked: true }, { legend: true }, { values: false }, { x_title: 'x' }, { y_title: 'y' }, { prefix: '€' }, { suffix: '%' }, { decimals: 1 }, { min: 0 }, { max: 9 }, { theme: 'dark' }, { background: '#fff' }, { background: 'transparent' }].map(
        (option) => ({ ...chart, options: { ...chart.options, ...option } }),
      ),
    ];
    const all = new Set([canonical(chart), ...variants.map(canonical)]);
    expect(all.size).toBe(variants.length + 1);
  });
});
