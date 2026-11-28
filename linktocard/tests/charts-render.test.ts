// The chart renderer in the Workers runtime: every chart type gives an image of the right pixel
// size, the 12 trial cases draw without an error or a warning, the three formats, the Free corner
// mark, and the safety net (nothing is fetched, time budget, size caps).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHARTS, LIMITS } from '../src/config';
import { layoutChart } from '../src/charts/layout';
import { assertChartFormat, markStrip, markWidth, renderChart } from '../src/charts/render';
import { parseChart, type Chart } from '../src/charts/spec';
import { rasterize } from '../src/render/engine';
import { ApiError } from '../src/lib/errors';
import cases from './fixtures/charts/cases.json';
import { isJpeg, isPng, isWebp, pngDimensions } from './app-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

const chartOf = (input: unknown): Chart => parseChart(input);
const simple = (type: string, extra: Record<string, unknown> = {}): Chart =>
  chartOf({ type, labels: ['A', 'B', 'C'], series: [{ name: 'One', data: [3, 7, 5] }], ...extra });

async function failure(work: Promise<unknown>): Promise<ApiError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('every chart type', () => {
  it.each(CHARTS.types.map((type) => [type]))('%s renders a PNG of width x scale by height x scale', async (type) => {
    const chart = simple(type, { width: 480, height: 320, scale: 2, title: 'Title', options: { values: true } });
    const output = await renderChart(chart, { format: 'png', mark: 'none' });
    expect(isPng(output.bytes)).toBe(true);
    expect(pngDimensions(output.bytes)).toEqual({ width: 960, height: 640 });
    expect(output).toMatchObject({ width: 960, height: 640, contentType: 'image/png', warnings: [] });
    expect(output.timings.totalMs).toBeGreaterThan(0);
  });

  it('uses the default size and scale when the chart has none', async () => {
    const output = await renderChart(simple('bar'), { format: 'png', mark: 'none' });
    expect(pngDimensions(output.bytes)).toEqual({ width: CHARTS.defaultWidth, height: CHARTS.defaultHeight });
  });

  it('draws the same bytes for the same chart', async () => {
    const chart = simple('line', { options: { values: true } });
    const [a, b] = [await renderChart(chart, { format: 'png', mark: 'free' }), await renderChart(chart, { format: 'png', mark: 'free' })];
    expect(a.bytes).toEqual(b.bytes);
  });
});

describe('the 12 trial cases', () => {
  it('are twelve', () => expect(cases).toHaveLength(12));

  it.each(cases.map((entry) => [entry.id, entry.spec] as const))('%s draws without an error or a warning', async (_id, spec) => {
    const chart = chartOf(spec);
    const output = await renderChart(chart, { format: 'png', mark: 'none' });
    expect(pngDimensions(output.bytes)).toEqual({ width: chart.width * chart.scale, height: chart.height * chart.scale });
    expect(output.warnings).toEqual([]);
    // And with the mark: the layout has less height, and must still work.
    const marked = await renderChart(chart, { format: 'png', mark: 'free' });
    expect(pngDimensions(marked.bytes)).toEqual({ width: chart.width * chart.scale, height: chart.height * chart.scale });
    expect(marked.bytes).not.toEqual(output.bytes);
  });
});

describe('formats', () => {
  it('encodes JPEG and WebP through the card encoders', async () => {
    const chart = simple('bar', { width: 300, height: 200 });
    const jpeg = await renderChart(chart, { format: 'jpeg', mark: 'none' });
    const webp = await renderChart(chart, { format: 'webp', mark: 'none' });
    expect(isJpeg(jpeg.bytes)).toBe(true);
    expect(jpeg.contentType).toBe('image/jpeg');
    expect(isWebp(webp.bytes)).toBe(true);
    expect(webp.contentType).toBe('image/webp');
  });

  it('refuses a format it does not have, and a transparent background outside PNG', async () => {
    const chart = simple('bar', { options: { background: 'transparent' } });
    expect((await failure(renderChart(chart, { format: 'gif' as never, mark: 'none' }))).code).toBe('unsupported_format');
    const error = await failure(renderChart(chart, { format: 'jpeg', mark: 'none' }));
    expect(error).toMatchObject({ code: 'invalid_request', status: 400, details: { field: 'options.background' } });
    expect(() => assertChartFormat(chart, 'webp')).toThrow(/transparent/);
    expect(() => assertChartFormat(chart, 'png')).not.toThrow();
    expect(isPng((await renderChart(chart, { format: 'png', mark: 'none' })).bytes)).toBe(true);
  });

  it('refuses an unknown mark instead of drawing without one', async () => {
    expect((await failure(renderChart(simple('bar'), { format: 'png', mark: 'paid' as never }))).code).toBe('invalid_request');
  });
});

describe('the Free corner mark', () => {
  it('is drawn for a canvas at least CHARTS.markMinWidth wide, in steps', () => {
    expect(markWidth(200)).toBe(CHARTS.markMinWidth);
    expect(markWidth(CHARTS.markMinWidth + CHARTS.markWidthStep - 1)).toBe(CHARTS.markMinWidth);
    expect(markWidth(CHARTS.markMinWidth + CHARTS.markWidthStep)).toBe(CHARTS.markMinWidth + CHARTS.markWidthStep);
    expect(markWidth(CHARTS.maxWidth)).toBe(CHARTS.markMaxWidth);
    const steps = new Set<number>();
    for (let width = CHARTS.minWidth; width <= CHARTS.maxWidth; width++) steps.add(markWidth(width));
    // A handful of badge sizes however many chart sizes an isolate draws.
    expect(steps.size).toBe((CHARTS.markMaxWidth - CHARTS.markMinWidth) / CHARTS.markWidthStep + 1);
  });

  it('sits in a strip that the chart leaves empty', () => {
    for (const entry of cases) {
      const chart = chartOf(entry.spec);
      const strip = markStrip(chart.width);
      expect(strip).toBeGreaterThan(0);
      const scene = layoutChart(chart, { footer: strip });
      const limit = chart.height - strip;
      for (const text of scene.texts) expect(text.y + text.h, `${entry.id}: "${text.text}"`).toBeLessThanOrEqual(limit + 0.5);
    }
  });

  it('changes the image, and only when asked for', async () => {
    const chart = simple('pie', { width: 400, height: 300 });
    const plain = await renderChart(chart, { format: 'png', mark: 'none' });
    const marked = await renderChart(chart, { format: 'png', mark: 'free' });
    expect(marked.bytes).not.toEqual(plain.bytes);
    expect(pngDimensions(marked.bytes)).toEqual(pngDimensions(plain.bytes));
  });
});

describe('the safety net', () => {
  it('never fetches, whatever the text says', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const chart = chartOf({
      type: 'bar',
      title: 'https://example.com/logo.png',
      subtitle: 'url(https://example.com/a.png) <img src="https://example.com/b.png">',
      labels: ['https://example.com/1', 'javascript:alert(1)', '<svg onload=alert(1)>'],
      series: [{ name: 'data:image/svg+xml,<svg/>', data: [1, 2, 3] }],
      options: { x_title: 'http://169.254.169.254/', y_title: '//example.com', prefix: 'url(', suffix: ')', values: true, legend: true },
    });
    const output = await renderChart(chart, { format: 'png', mark: 'free' });
    expect(isPng(output.bytes)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('draws text outside the bundled fonts as boxes, with a warning and without a fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const output = await renderChart(simple('bar', { title: '売上高' }), { format: 'png', mark: 'none' });
    expect(output.warnings.join(' ')).toMatch(/No bundled font covers/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks the emoji loader for an emoji and leaves it blank without one', async () => {
    const asked: string[] = [];
    const chart = simple('bar', { title: 'Fruit 🍎' });
    const withLoader = await renderChart(chart, { format: 'png', mark: 'none' }, { loadEmoji: async (emoji) => (asked.push(emoji), undefined) });
    expect(asked).toEqual(['🍎']);
    expect(withLoader.warnings.join(' ')).toMatch(/not available/);
    expect(isPng((await renderChart(chart, { format: 'png', mark: 'none' })).bytes)).toBe(true);
  });

  it('draws the largest chart the limits allow, with every option on, inside the time budget', async () => {
    const labels = Array.from({ length: CHARTS.maxPoints }, (_, i) => `Label ${i} ${'x'.repeat(CHARTS.maxLabelChars - 12)}`);
    const series = Array.from({ length: CHARTS.maxSeries }, (_, s) => ({ name: `Series ${s} ${'y'.repeat(60)}`, data: labels.map((_, i) => Math.round(1000 * Math.sin(i / 7 + s) * (s + 1))) }));
    for (const type of ['bar', 'line', 'area'] as const) {
      const chart = chartOf({
        type,
        title: 'T'.repeat(CHARTS.maxTitleChars),
        subtitle: 'S'.repeat(CHARTS.maxSubtitleChars),
        labels,
        series,
        options: { values: true, legend: true, stacked: type !== 'line', x_title: 'X'.repeat(CHARTS.maxAxisTitleChars), y_title: 'Y'.repeat(CHARTS.maxAxisTitleChars), prefix: '$'.repeat(CHARTS.maxAffixChars), suffix: '%'.repeat(CHARTS.maxAffixChars) },
        width: CHARTS.maxWidth,
        height: CHARTS.maxHeight,
      });
      const started = Date.now();
      const output = await renderChart(chart, { format: 'png', mark: 'free' });
      expect(Date.now() - started, type).toBeLessThan(LIMITS.renderTimeoutMs);
      expect(pngDimensions(output.bytes)).toEqual({ width: CHARTS.maxWidth, height: CHARTS.maxHeight });
    }
  });

  it('keeps value labels within CHARTS.maxValueLabels', () => {
    const labels = Array.from({ length: 60 }, (_, i) => String(i));
    const series = Array.from({ length: CHARTS.maxSeries }, () => ({ data: labels.map(() => 5) }));
    const chart = chartOf({ type: 'bar', labels, series, options: { values: true, stacked: true, legend: false }, width: CHARTS.maxWidth, height: CHARTS.maxHeight });
    const scene = layoutChart(chart);
    const axisTexts = layoutChart({ ...chart, values: false }).texts.length;
    expect(scene.texts.length - axisTexts).toBeGreaterThan(0);
    expect(scene.texts.length - axisTexts).toBeLessThanOrEqual(CHARTS.maxValueLabels);
  });

  it('paints a transparent background as transparent pixels and a colour as that colour', async () => {
    const corner = async (background: string | undefined): Promise<number[]> => {
      const chart = simple('bar', { width: 200, height: 200, options: background === undefined ? {} : { background } });
      const scene = layoutChart(chart);
      const raster = await rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"></svg>`, 200, scene.background);
      return [...raster.pixels.subarray(0, 4)];
    };
    expect(await corner(undefined)).toEqual([255, 255, 255, 255]);
    expect(await corner('#123')).toEqual([0x11, 0x22, 0x33, 255]);
    expect(await corner('transparent')).toEqual([0, 0, 0, 0]);
  });
});
