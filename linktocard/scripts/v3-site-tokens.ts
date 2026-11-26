/**
 * The [[tokens]] of the build v3 docs pages (site/content/docs/bulk.md, pdf-tools.md,
 * link-cards.md, integrations.md): every number those pages print, read from src/config.ts
 * and src/billing/plans.ts, so a page never types a limit itself (tests/node/v3-docs-draft.test.ts
 * fails when one does).
 *
 * scripts/build-site.ts merges them into its own tokens: `Object.assign(tokens, v3SiteTokens())`
 * in buildTokens(). They are kept in this file only because build v3 was prepared in parallel and
 * build-site.ts belonged to another step; folding them into build-site.ts later changes nothing.
 *
 * Formatting follows build-site.ts: counts through formatCount ("2,000"), sizes through the same
 * KB / MB rounding as inUnits() there ("1.5", "20").
 */
import { formatCount } from '../src/billing/plans';
import { BATCH, INSPECT, LIMITS, LINK_CARDS, PDF, PDF_TOOLKIT, pdfToolkitUnits } from '../src/config';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HOUR_MS = 60 * 60 * 1000;

/** A byte limit in MB as the site prints it: "28", "1.5" (the same rule as inUnits() in build-site.ts). */
const megabytes = (bytes: number): string => String(Math.round((bytes / MB) * 100) / 100);
/** The same in GB (1024 MB, as the site's MB are 1024 KB): "2". */
const gigabytes = (bytes: number): string => String(Math.round((bytes / GB) * 100) / 100);

/**
 * Tokens that need a config value which does not exist yet, and the value each one needs.
 * v3SiteTokens() defines a token here as soon as its value is in src/config.ts. Empty: every
 * value the v3 pages print is in config.
 */
export const PENDING_CONFIG_TOKENS: Readonly<Record<string, string>> = {};

/** Documents made in the "partial" batch example of /docs/bulk (one page each). */
const BATCH_EXAMPLE_DONE = 2;

/** The page count of the "what counts" example of /docs/pdf-tools: two blocks and a few pages more. */
const TOOLKIT_EXAMPLE_PAGES = PDF_TOOLKIT.pagesPerUnit * 2 + 3;

export function v3SiteTokens(): Record<string, string> {
  const tokens: Record<string, string> = {
    // Bulk documents (BATCH).
    'batch.maxRowsFree': formatCount(BATCH.maxRows.free),
    'batch.maxRowsStarter': formatCount(BATCH.maxRows.starter),
    'batch.maxRowsPro': formatCount(BATCH.maxRows.pro),
    'batch.maxActive': String(BATCH.maxActivePerAccount),
    'batch.maxRequestBodyMb': megabytes(BATCH.maxRequestBodyBytes),
    'batch.maxRowAttempts': String(BATCH.maxRowAttempts),
    'batch.revokedRetentionDays': String(BATCH.revokedRetentionDays),
    'batch.staleAfterDays': String(BATCH.staleAfterDays),
    'batch.maxCsvColumns': formatCount(BATCH.maxCsvColumns),
    // ZIP downloads come in parts (decision D9) and GET /v1/batches pages (src/routes/batches.ts).
    'batch.zipPartMaxEntries': formatCount(BATCH.zipPartMaxEntries),
    'batch.zipPartMaxGb': gigabytes(BATCH.zipPartMaxBytes),
    'batch.listDefaultLimit': String(BATCH.listDefaultLimit),
    'batch.listMaxLimit': String(BATCH.listMaxLimit),
    // The "partial" example of /docs/bulk: two one-page documents made, one failed.
    'batch.exampleCredits': String(BATCH_EXAMPLE_DONE * PDF.baseUnits),

    // PDF toolkit (PDF_TOOLKIT, pdfToolkitUnits()).
    'toolkit.ops': PDF_TOOLKIT.ops.join(', '),
    'toolkit.maxInputMb': megabytes(PDF_TOOLKIT.maxInputBytes),
    'toolkit.maxFiles': String(PDF_TOOLKIT.maxFiles),
    'toolkit.maxPages': formatCount(PDF_TOOLKIT.maxPages),
    'toolkit.maxImageMb': megabytes(PDF_TOOLKIT.maxImageBytes),
    'toolkit.maxRequestBodyMb': megabytes(PDF_TOOLKIT.maxRequestBodyBytes),
    'toolkit.maxOutputMb': megabytes(PDF_TOOLKIT.maxOutputBytes),
    'toolkit.maxFormFields': formatCount(PDF_TOOLKIT.maxFormFields),
    'toolkit.maxJsonElements': formatCount(PDF_TOOLKIT.maxJsonTokens),
    'toolkit.pagesPerUnit': String(PDF_TOOLKIT.pagesPerUnit),
    'toolkit.maxUnits': formatCount(pdfToolkitUnits('merge', PDF_TOOLKIT.maxPages)),
    'toolkit.examplePages': String(TOOLKIT_EXAMPLE_PAGES),
    'toolkit.exampleUnits': String(pdfToolkitUnits('merge', TOOLKIT_EXAMPLE_PAGES)),
    // A "url" file is downloaded under the image fetcher's limits (src/routes/pdf-toolkit.ts).
    'toolkit.fetchTimeoutSeconds': String(LIMITS.imageFetchTimeoutMs / 1000),
    'toolkit.fetchMaxRedirects': String(LIMITS.imageMaxRedirects),

    // The OG checker's fetcher, which link cards use to read a page (INSPECT).
    'inspect.maxUrlChars': formatCount(INSPECT.maxUrlChars),
    'inspect.pageTimeoutSeconds': String(INSPECT.pageTimeoutMs / 1000),
    'inspect.pageMaxMb': megabytes(INSPECT.pageMaxBytes),
    'inspect.maxRedirects': String(INSPECT.maxRedirects),
    'inspect.cacheMinutes': String(INSPECT.cacheTtlMs / 60_000),
    'inspect.dailyFree': formatCount(INSPECT.dailyInspectionsByPlan.free),
    'inspect.dailyStarter': formatCount(INSPECT.dailyInspectionsByPlan.starter),
    'inspect.dailyPro': formatCount(INSPECT.dailyInspectionsByPlan.pro),

    // Link cards (LINK_CARDS).
    'linkCards.defaultTemplate': LINK_CARDS.defaultTemplate,
  };
  const hours = LINK_CARDS.refreshAfterMs / HOUR_MS;
  if (!Number.isInteger(hours) || hours < 1) throw new Error(`LINK_CARDS.refreshAfterMs must be whole hours for the docs, got ${LINK_CARDS.refreshAfterMs} ms`);
  tokens['linkCards.refreshHours'] = String(hours);
  return tokens;
}
