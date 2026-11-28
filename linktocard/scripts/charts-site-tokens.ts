/**
 * The [[tokens]] of the chart pages (site/content/docs/charts.md, the four chart maker pages under
 * site/pages/tools/ and their partial site/partials/chart-maker.html): every number those pages
 * print about charts, read from CHARTS in src/config.ts, so a page never types a limit itself
 * (tests/node/charts-site.test.ts fails when one does).
 *
 * scripts/build-site.ts merges them into its own tokens, like the other *-site-tokens.ts files.
 * Formatting follows build-site.ts: counts through formatCount ("1,500,000").
 */
import { PLANS, formatCount } from '../src/billing/plans';
import { CHARTS, DAY_MS } from '../src/config';
import { rateLimitText } from './v3-site-tokens';

const KB = 1024;
/** When the example chart of /docs/charts was drawn. */
const EXAMPLE_CREATED_AT = '2026-11-28T10:15:00.000Z';

/** A decimal number written out in full, never in exponent form: 1e-6 is "0.000001", 1e15 "1,000,000,000,000,000". */
function plainNumber(value: number): string {
  if (value >= 1) return formatCount(value);
  const text = value.toFixed(20).replace(/0+$/, '');
  if (Number(text) !== value) throw new Error(`charts tokens: ${value} cannot be printed exactly`);
  return text;
}

export function chartsSiteTokens(): Record<string, string> {
  // Cache-Control carries seconds; the docs speak in days, so the setting must be whole days.
  const maxAgeDays = (CHARTS.maxAgeSeconds * 1000) / DAY_MS;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) throw new Error(`CHARTS.maxAgeSeconds must be whole days for the docs, got ${CHARTS.maxAgeSeconds} s`);
  if (CHARTS.maxJsonBytes % KB !== 0) throw new Error(`CHARTS.maxJsonBytes must be whole KB for the docs, got ${CHARTS.maxJsonBytes}`);
  return {
    'charts.types': CHARTS.types.map((type) => `\`${type}\``).join(', '),
    'charts.typeCount': String(CHARTS.types.length),
    'charts.minWidth': String(CHARTS.minWidth),
    'charts.maxWidth': String(CHARTS.maxWidth),
    'charts.minHeight': String(CHARTS.minHeight),
    'charts.maxHeight': String(CHARTS.maxHeight),
    'charts.defaultWidth': String(CHARTS.defaultWidth),
    'charts.defaultHeight': String(CHARTS.defaultHeight),
    'charts.scales': CHARTS.scales.map(String).join(' or '),
    'charts.maxPixels': formatCount(CHARTS.maxPixels),
    'charts.maxSeries': String(CHARTS.maxSeries),
    'charts.maxPoints': formatCount(CHARTS.maxPoints),
    'charts.maxSlices': String(CHARTS.maxSlices),
    'charts.maxTitleChars': formatCount(CHARTS.maxTitleChars),
    'charts.maxSubtitleChars': formatCount(CHARTS.maxSubtitleChars),
    'charts.maxAxisTitleChars': formatCount(CHARTS.maxAxisTitleChars),
    'charts.maxLabelChars': formatCount(CHARTS.maxLabelChars),
    'charts.maxSeriesNameChars': formatCount(CHARTS.maxSeriesNameChars),
    'charts.maxAffixChars': String(CHARTS.maxAffixChars),
    'charts.maxDecimals': String(CHARTS.maxDecimals),
    'charts.maxAbsValue': plainNumber(CHARTS.maxAbsValue),
    'charts.minAbsValue': plainNumber(CHARTS.minAbsValue),
    'charts.maxJsonKb': String(CHARTS.maxJsonBytes / KB),
    'charts.maxSignedUrlChars': formatCount(CHARTS.maxSignedUrlChars),
    'charts.maxValueLabels': formatCount(CHARTS.maxValueLabels),
    'charts.chargeMemoryDays': String(CHARTS.chargeMemoryDays),
    'charts.maxAgeDays': String(maxAgeDays),
    // The free chart maker's endpoint counts against RL_PLAYGROUND (its own counter), POST /v1/charts against RL_KEY.
    'charts.toolRateLimit': rateLimitText('RL_PLAYGROUND'),
    'charts.apiRateLimit': rateLimitText('RL_KEY'),
    // The answer of the POST /v1/charts example in /docs/charts: a first chart on the Free plan.
    'charts.example.limit': String(PLANS.free.monthlyImages),
    'charts.example.remaining': String(PLANS.free.monthlyImages - 1),
    'charts.example.cacheDays': String(PLANS.free.cacheDays),
    'charts.example.expiresAt': new Date(Date.parse(EXAMPLE_CREATED_AT) + PLANS.free.cacheDays * DAY_MS).toISOString(),
    'charts.example.createdAt': EXAMPLE_CREATED_AT,
    // Unformatted, for the maxlength="..." and data-max-* attributes the chart maker reads.
    'charts.raw.maxSeries': String(CHARTS.maxSeries),
    'charts.raw.maxPoints': String(CHARTS.maxPoints),
    'charts.raw.maxSlices': String(CHARTS.maxSlices),
    'charts.raw.maxTitleChars': String(CHARTS.maxTitleChars),
    'charts.raw.maxLabelChars': String(CHARTS.maxLabelChars),
    'charts.raw.maxSeriesNameChars': String(CHARTS.maxSeriesNameChars),
    'charts.raw.maxAffixChars': String(CHARTS.maxAffixChars),
  };
}
