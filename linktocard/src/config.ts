/**
 * Hard limits that apply to every plan. Plan-specific numbers (quota, cache
 * days, fonts) live in src/billing/plans.ts. The docs "Limits" page is built
 * from this file and plans.ts, so the published limits cannot drift from the
 * enforced ones.
 */

import { PLANS, type PlanId } from './billing/plans';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type SizeId = 'og' | 'square' | 'portrait' | 'email';

export interface SizePreset {
  id: SizeId;
  label: string;
  width: number;
  height: number;
}

/** The only output sizes in the MVP. One image = one rendered size. */
export const SIZES: Record<SizeId, SizePreset> = {
  og: { id: 'og', label: 'Open Graph', width: 1200, height: 630 },
  square: { id: 'square', label: 'Square', width: 1080, height: 1080 },
  portrait: { id: 'portrait', label: 'Portrait', width: 1080, height: 1350 },
  /** A 600 x 200 email slot at twice the pixels (the email-banner starter is laid out for it). */
  email: { id: 'email', label: 'Email', width: 1200, height: 400 },
};

export const DEFAULT_SIZE: SizeId = 'og';
export const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp'];
export const DEFAULT_FORMAT: ImageFormat = 'png';

export const CONTENT_TYPES: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** File extension accepted in /v1/og/{site}/{template}.{ext} -> format. */
export const EXTENSION_TO_FORMAT: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  webp: 'webp',
};

export const FORMAT_TO_EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

export const LIMITS = {
  /** Template source limits (bytes of UTF-8). */
  maxHtmlBytes: 32 * 1024,
  maxCssBytes: 32 * 1024,
  /** Structural limits after parsing. */
  maxNodes: 400,
  maxDepth: 32,
  /** Total visible text characters in one card after data substitution. */
  maxTextChars: 4000,
  /** Data map: number of keys, key syntax and per-value length. */
  maxDataKeys: 24,
  maxDataValueChars: 1000,
  dataKeyPattern: /^[a-z][a-z0-9_]{0,31}$/,
  /** Remote images referenced by one template render. */
  maxImagesPerRender: 4,
  maxImageBytes: 2 * 1024 * 1024,
  /** Decoded size cap for a template image (width x height), protects the 128 MB isolate. */
  maxImagePixels: 4_000_000,
  imageFetchTimeoutMs: 4000,
  imageMaxRedirects: 3,
  /** Second line of defence behind the fixed size presets. */
  maxRenderPixels: 1_500_000,
  /**
   * Shadow / blur caps, enforced on the SVG Satori produces (so CSS variables and
   * calc() cannot hide a value). One 60px-blur shadow costs ~2 s of CPU in resvg and
   * 200px crashes it, so these are hard limits, not style advice.
   */
  /**
   * Enforced on the SVG as stdDeviation <= maxBlurRadiusPx / 2. In CSS terms:
   * box-shadow and text-shadow blur up to 24px; filter: blur(), drop-shadow() and
   * backdrop-filter blur up to 12px.
   */
  maxBlurRadiusPx: 24,
  /**
   * Blur/filter effects per image. Counting rule: every text run with a text-shadow
   * is one effect (a headline containing one <b> is three runs), every box-shadow
   * layer is one, every filter/backdrop-filter is one.
   */
  maxFilterEffects: 8,
  /** Intermediate SVG size cap (bytes) before rasterising. */
  maxSvgBytes: 3 * 1024 * 1024,
  /** Wall-clock budget for one render including remote image fetches. */
  renderTimeoutMs: 10_000,
  /** JSON body cap for POST /v1/images and dashboard writes. */
  maxRequestBodyBytes: 96 * 1024,
  /** Longest signed URL (path + query) we accept. */
  maxSignedUrlChars: 4096,
  /** Per-account object caps (same on every plan; abuse limits, not features). */
  maxTemplatesPerUser: 50,
  maxSitesPerUser: 10,
  maxApiKeysPerUser: 10,
  /** Name fields. */
  maxNameChars: 80,
} as const;

/**
 * Rate limits. The numbers here are documentation + the fallback in-memory
 * limiter; the production limiter is the Cloudflare Rate Limiting binding of
 * the same name declared in wrangler.toml (keep the two in sync - checked by
 * tests/node/forbidden-deps.test.ts).
 */
export const RATE_LIMITS = {
  RL_IP: { limit: 300, periodSeconds: 60, scope: 'per IP address (IPv6: per /64 network), all /v1 endpoints (edge-cache hits are not limited)' },
  RL_KEY: { limit: 120, periodSeconds: 60, scope: 'per API key (POST /v1/images) and per site (uncached signed-URL renders)' },
  RL_AUTH: { limit: 5, periodSeconds: 60, scope: 'per IP address (IPv6: per /64 network): sign-in link requests, sign-in verification and the contact form (counted separately); also at most 20 sign-in emails per hour, and at most 5 to one address' },
  RL_PLAYGROUND: { limit: 30, periodSeconds: 60, scope: 'per IP address (IPv6: per /64 network), homepage playground' },
  RL_PREVIEW: { limit: 60, periodSeconds: 60, scope: 'per account, dashboard live preview' },
  RL_PDF_KEY: { limit: 20, periodSeconds: 10, scope: 'per API key, POST /v1/pdf' },
  RL_PDF_FREE: { limit: 10, periodSeconds: 60, scope: 'per Free account, PDF renders (POST /v1/pdf and uncached signed PDF links)' },
  RL_TOOLS_PDF: { limit: 3, periodSeconds: 60, scope: 'per IP address (IPv6: per /64 network), free PDF tools' },
  RL_PDF_TOOLS: { limit: 30, periodSeconds: 60, scope: 'per API key, PDF toolkit (POST /v1/pdf-tools/{op})' },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * The free OG checker (/tools/og-checker, GET /api/tools/og-check) and its API twin
 * GET /v1/inspect. One page fetch per request, never a crawl; see src/inspect/*.
 */
export const INSPECT = {
  /** Longest URL accepted, in characters. */
  maxUrlChars: 2048,
  /** Page fetch: one budget for DNS, every redirect hop and the body. */
  pageTimeoutMs: 5000,
  /** Bytes of HTML read; the rest is not downloaded. */
  pageMaxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  /** Image probe (HEAD then GET): its own budget and byte cap. */
  imageTimeoutMs: 5000,
  imageMaxBytes: 8 * 1024 * 1024,
  /** robots.txt: same rules, read once, informational only. */
  robotsTimeoutMs: 5000,
  robotsMaxBytes: 512 * 1024,
  /** GET /api/tools/og-check/{id}/image|favicon: what the image proxy streams at most. */
  proxyMaxBytes: 5 * 1024 * 1024,
  proxyTimeoutMs: 5000,
  /**
   * Image/favicon proxy fetches per client (IPv4 address or IPv6 /64) per clock hour. A
   * check shows at most two (browsers keep them 10 minutes), so 20 checks need 40.
   */
  proxyFetchesPerHour: 120,
  /** A result (and its image proxy URLs) lives this long. */
  cacheTtlMs: 10 * 60 * 1000,
  /** Checklist thresholds. */
  imageWarnBytes: 5 * 1024 * 1024,
  minImageSidePx: 200,
  targetAspectRatio: 1.91,
  aspectRatioTolerance: 0.03,
  maxTitleChars: 70,
  maxDescriptionChars: 200,
  slowResponseMs: 3000,
  /** Public checker: uncached checks per client (IPv4 address or IPv6 /64) per clock hour. */
  publicChecksPerHour: 20,
  /** Uncached checks per client and hour after which Turnstile is required (only when TURNSTILE_SECRET_KEY is set). */
  turnstileAfterChecks: 5,
  turnstileTimeoutMs: 3000,
  /**
   * GET /v1/inspect: uncached checks per API key per UTC day. The owner set Free; Starter
   * and Pro are our own assumption. Inspections never count as images.
   */
  dailyInspectionsByPlan: { free: 100, starter: 1000, pro: 5000 },
  userAgent: 'LinkToCardBot/1.0 (+https://linktocard.com/bot)',
} as const;

/**
 * PDF documents (POST /v1/pdf, signed GET /v1/pdf/..., the free PDF tools), rendered by
 * Cloudflare Browser Run's `pdf` quick action. Images are still rendered without a browser.
 * The pricing page, /docs/pdf and the tests read every number from here.
 */
export const PDF = {
  /** Pages per PDF. Rendered with pageRanges "1-<maxPages + 1>"; one page more is refused, not charged. */
  maxPages: 50,
  /** Quota: a PDF of up to `basePages` pages counts as `baseUnits` images ... */
  basePages: 10,
  baseUnits: 2,
  /** ... plus one image for each further started block of `extraPagesPerUnit` pages. */
  extraPagesPerUnit: 10,
  /** Customer HTML after placeholder substitution, CSS, and all inlined images together. */
  maxHtmlBytes: 1024 * 1024,
  maxCssBytes: 256 * 1024,
  maxAssetBytes: 10 * 1024 * 1024,
  /** POST /v1/pdf and POST /api/tools/pdf request bodies. */
  maxRequestBodyBytes: 1.5 * 1024 * 1024,
  /** Browser budgets (navigation and PDF printing each). */
  renderTimeoutMs: 30_000,
  /** Page margins: CSS lengths, each at most this many millimetres. */
  maxMarginMm: 60,
  /** Data for PDF templates. */
  maxDataKeys: 40,
  maxDataValueChars: 2000,
  maxItems: 200,
  maxItemFields: 16,
  maxItemValueChars: 500,
  /** Free plan and free tools: a footer line on every page, with at least this bottom margin. */
  freeMark: 'Made with Link To Card',
  freeMarkMinBottomMm: 14,
  /** Free PDF tools (no account): PDFs per client (IPv4 address or IPv6 /64) per clock hour. */
  toolPdfsPerHour: 5,
  /** Daily alarm: browser time over the last 24 h above this sends one email per day (PDF_DAILY_BROWSER_MS_BUDGET overrides). */
  dailyBrowserMsBudget: 20 * 60 * 1000,
  /** browser_usage rows are kept this long. */
  browserUsageRetentionDays: 90,
  formats: ['a4', 'letter', 'a5'] as const,
  defaultFormat: 'a4' as const,
  /** Page margin on every side when neither the request nor the template sets one. */
  defaultMarginMm: 15,
  /** A customer header or footer template (pdf.header / pdf.footer), before placeholders are filled in. */
  maxHeaderFooterBytes: 32 * 1024,
  /** Elements in the document after {{#items}} sections are expanded, and how deeply they may nest. */
  maxElements: 50_000,
  maxDepth: 64,
  /** Distinct remote images (<img src>, CSS url()) fetched and inlined for one PDF. */
  maxRemoteAssets: 30,
  /** Download name of a PDF (Content-Disposition), in characters including ".pdf". */
  maxFilenameChars: 120,
  /** Free PDF tools: PDFs per client and hour after which Turnstile is required (only when TURNSTILE_SECRET_KEY is set). */
  toolTurnstileAfterPdfs: 2,
  /**
   * Renders per UTC day, by the owner's plan, that reach the browser and fail because of the
   * document (too many pages, over maxPdfBytes, a timeout, a browser 422, an unreadable page
   * count) or need more images than are left (402 after rendering). Counted per account for
   * POST /v1/pdf and per site for signed links; Browser Run's own failures never count. Past
   * it, new renders in that scope answer 429 until the day ends; stored PDFs are still served
   * (src/pdf/guard.ts).
   */
  maxFailedRendersPerDay: { free: 20, paid: 200 },
  /**
   * The signed links of all of an account's sites together: failed renders (as above) per UTC
   * day, by the owner's plan, on top of each site's own maxFailedRendersPerDay. One site's links
   * can use at most half of it, so they never stop the owner's other sites alone; a site deleted
   * and created again starts no new count here.
   */
  maxFailedSignedRendersPerDay: { free: 40, paid: 400 },
  /**
   * Automatic brake: while the PDF renders of Free accounts and the free tools in the last 24
   * hours used more than this many daily budgets of browser time (PDF_DAILY_BROWSER_MS_BUDGET
   * or dailyBrowserMsBudget), Free-plan renders and the free tools answer 429. Paid plans keep
   * rendering, and their browser time does not count here (src/pdf/guard.ts).
   */
  freeBrakeBudgetMultiple: 5,
  /**
   * Largest PDF the browser may return. A small document can make Chrome write a very large
   * file (an image that compresses well as PNG is stored almost raw in the PDF); a PDF over this
   * is refused as a document error and never stored.
   */
  maxPdfBytes: 20 * 1024 * 1024,
  /**
   * How long a document that failed in the browser (too many pages, a browser 422 or timeout,
   * over maxPdfBytes, or a 402 after rendering) is remembered by its cache key, so the identical
   * request is answered without rendering it again.
   */
  failedRenderMemoryMs: 10 * 60 * 1000,
} as const;

export type PdfFormat = (typeof PDF.formats)[number];

/**
 * Images a PDF counts as: `baseUnits` for 1 to `basePages` pages, then one more for each
 * further started block of `extraPagesPerUnit` pages (1-10 pages = 2, 11-20 = 3, ..., 41-50 = 6).
 */
export function pdfUnits(pages: number): number {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError(`pdfUnits: pages must be a positive integer, got ${pages}`);
  if (pages <= PDF.basePages) return PDF.baseUnits;
  return PDF.baseUnits + Math.ceil((pages - PDF.basePages) / PDF.extraPagesPerUnit);
}

/** Auth lifetimes. */
export const AUTH = {
  magicLinkTtlMs: 15 * 60 * 1000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  sessionCookie: 'ltc_session',
  /** Max sign-in emails to one address per hour (anti mail-bombing). */
  maxMagicLinksPerEmailPerHour: 5,
  /**
   * Max sign-in emails one client (IPv4 address or IPv6 /64) may request per hour,
   * over all addresses together. Without it the per-minute limiter would let one
   * visitor have 300 emails an hour sent to strangers from our domain.
   */
  maxMagicLinksPerClientPerHour: 20,
} as const;

/** HTTP caching of rendered images (browser + edge). The durable cache is R2. */
export const HTTP_CACHE = {
  imageMaxAgeSeconds: 86_400,
  playgroundMaxAgeSeconds: 3_600,
} as const;

/**
 * Paths the Worker answers; everything else is a static asset. Must mirror
 * run_worker_first in wrangler.toml (checked by tests/node/forbidden-deps.test.ts).
 * A trailing slash means "everything below".
 */
export const WORKER_PATHS: readonly string[] = ['/v1/', '/api/', '/auth/', '/webhooks/', '/i/', '/playground/', '/v/', '/healthz'];

export const API_KEY_PREFIX = 'ltc_';
export const SITE_SECRET_PREFIX = 'ltcs_';

export const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Build v3 tools (owner decision 2026-11-26). Each spends the existing image units; no new Paddle
 * product. Each has its own kill switch (src/lib/features.ts): "true" turns it on.
 */

/** Bulk documents from a spreadsheet: POST /v1/batches, rendered row by row through a Queue. */
export const BATCH = {
  /** Rows one batch may hold, by plan. */
  maxRows: { free: 25, starter: 500, pro: 2000 },
  /** Queued or running batches per account at once. */
  maxActivePerAccount: 2,
  /** Rows a queue message carries; the consumer renders them one after another. */
  rowsPerMessage: 1,
  /** Queue consumer concurrency, kept well under Browser Run's 30 quick actions per second. */
  maxConsumerConcurrency: 5,
  /** Attempts for a row whose failure was the provider's or a busy browser, never the document's. */
  maxRowAttempts: 3,
  /** Largest JSON body of POST /v1/batches. */
  maxRequestBodyBytes: 4 * 1024 * 1024,
  /** Certificate verification records stay this long after they are revoked. */
  revokedRetentionDays: 90,
  /** Messages per consumer invocation (wrangler.toml max_batch_size): CPU per invocation stays well under limits.cpu_ms. */
  queueMaxBatchSize: 5,
  /** Seconds a consumer waits to fill a batch (wrangler.toml max_batch_timeout). */
  queueMaxBatchTimeoutSeconds: 2,
  /** wrangler.toml max_retries; at least maxRowAttempts, so the consumer gives up on a row before Queues deletes it. */
  queueMaxRetries: 5,
  /** Base delay of a retried row (wrangler.toml retry_delay); attempt n waits n times this. */
  retryDelaySeconds: 30,
  /** Least wall time per rendered row: maxConsumerConcurrency rows per second, under Browser Run's 30 quick actions/s. */
  minRowMs: 1000,
  /** A row claim older than this is dead: a consumer invocation lasts at most 15 minutes. */
  claimTimeoutMinutes: 15,
  /** Messages per sendBatch call (the Queues limit is 100). */
  sendBatchChunk: 100,
  /** Rows still unfinished this many days after their batch was made are failed by the daily cleanup (queue retention 4 days + margin). */
  staleAfterDays: 5,
  /** Most CSV columns the dashboard Bulk tab reads. */
  maxCsvColumns: 200,
  /**
   * ZIP downloads come in parts (GET /v1/batches/{id}/zip?part=N): the finished PDFs in row
   * order, packed greedily into parts of at most this many files (each file is one R2 read of
   * the download request) ...
   */
  zipPartMaxEntries: 500,
  /** ... and at most this many archive bytes (2 GiB; a ZIP without ZIP64 holds less than 4 GiB). */
  zipPartMaxBytes: 2 * 1024 * 1024 * 1024,
  /** Batches per page of GET /v1/batches, when the request does not say, and at most. */
  listDefaultLimit: 20,
  listMaxLimit: 100,
} as const;

/** PDF toolkit without a browser: POST /v1/pdf-tools/{op}. */
export const PDF_TOOLKIT = {
  ops: ['merge', 'split', 'stamp', 'fill', 'fields', 'from-images', 'protect'] as const,
  maxInputBytes: 20 * 1024 * 1024,
  maxFiles: 20,
  maxPages: 500,
  maxImageBytes: 10 * 1024 * 1024,
  /** One image unit per started block of this many output pages (minimum one); "fields" is free. */
  pagesPerUnit: 10,
  maxRequestBodyBytes: 28 * 1024 * 1024,
  /** Structure tokens a PDF may hold before pdf-lib parses it (src/pdftools/budget.ts): about 48 B of heap each, so about 50 MB. */
  maxStructureTokens: 1_000_000,
  /**
   * Bytes of one request's results together (every file of a split; the one file of the other
   * operations). A split copies resources its pages share (a background image, fonts) into every
   * file, so without this 20 files of an 18.9 MB input came to 377 MB, all held in memory at once
   * (security review SEC-4). The input limit plus 5 MB for the structure pdf-lib writes: merging
   * files that use object streams, or re-compressing PNGs, makes a result a little larger than its inputs.
   */
  maxOutputBytes: 25 * 1024 * 1024,
  /**
   * Nodes of a form's field tree (every field and every widget), walked before pdf-lib reads the
   * form (src/pdftools/document.ts). Large real forms have a few hundred to a few thousand.
   */
  maxFormFields: 5_000,
  /**
   * Structural JSON tokens ("[", "{", ",", ":" outside strings) a JSON request body may hold,
   * counted before JSON.parse (src/routes/pdf-toolkit.ts). The files are base64 strings, which
   * hold none; a fill with values for every field of the largest form allowed needs about 2 x maxFormFields.
   */
  maxJsonTokens: 50_000,
} as const;
export type PdfToolkitOp = (typeof PDF_TOOLKIT.ops)[number];

export function pdfToolkitUnits(op: PdfToolkitOp, outputPages: number): number {
  if (op === 'fields') return 0;
  if (!Number.isInteger(outputPages) || outputPages < 1) throw new RangeError(`pdfToolkitUnits: pages must be a positive integer, got ${outputPages}`);
  return Math.ceil(outputPages / PDF_TOOLKIT.pagesPerUnit);
}

/** Link in, card out: a card built from a page's own metadata (POST /v1/cards/from-url, /v1/link/...). */
export const LINK_CARDS = {
  defaultTemplate: 'blog',
  /** Page text is cut to this many characters (code points) per field: the playground's limits. */
  maxChars: { title: 120, description: 200, site: 60 },
  /** A signed link card reads its page again once its last check is this old; until then its stored card answers. */
  refreshAfterMs: DAY_MS,
} as const;

/**
 * Unique open-field renders a site may make per UTC day: a quarter of the plan's monthly images.
 * Open values are unsigned, so anyone holding one email image URL can ask for new values, each
 * costing the owner an image; the cap slows such a drain to a quarter of the allowance a day. At
 * the earlier 200 / 2,000 / 10,000 it equalled or exceeded the whole month (review BQ-1).
 */
const openRendersPerDay = (plan: PlanId): number => Math.floor(PLANS[plan].monthlyImages / 4);

/** Personalized email images: signed card URLs whose "open" fields an email platform fills in. */
export const EMAIL_FIELDS = {
  maxOpenFields: 3,
  maxValueChars: 40,
  /** Unique renders with open fields per site per UTC day, by plan: openRendersPerDay above. */
  maxUniqueRendersPerDay: { free: openRendersPerDay('free'), starter: openRendersPerDay('starter'), pro: openRendersPerDay('pro') },
  /** Cache lifetime sent to email clients' image proxies. */
  maxAgeSeconds: 30 * 24 * 60 * 60,
  /**
   * Charge once: how long the record that an email image was charged is kept, from that charge.
   * While it is kept, a copy whose stored period (the plan's cache days) ended is rendered and
   * stored again without a new charge. The record is written in the batch that takes the image
   * (src/lib/quota.ts CHARGE_RECORD_*) and read by src/lib/open-fields.ts hasEmailCharge.
   */
  chargeMemoryDays: 400,
} as const;

/**
 * Chart images: a chart described as JSON, drawn as an image (src/charts, src/routes/charts.ts).
 * Every limit of the chart JSON and of the three ways in (signed URL, POST /v1/charts, the free
 * chart maker's endpoint) is here; validation, docs and tests read them from this object.
 */
export const CHARTS = {
  types: ['bar', 'line', 'area', 'pie', 'doughnut'],
  /** Width and height in CSS pixels (whole numbers); the defaults apply when the JSON has none. */
  minWidth: 200,
  maxWidth: 1200,
  minHeight: 200,
  maxHeight: 1200,
  defaultWidth: 600,
  defaultHeight: 400,
  /** Output pixels are width x scale by height x scale. */
  scales: [1, 2],
  /** Total output pixels of one chart: the renderer's own cap. */
  maxPixels: LIMITS.maxRenderPixels,
  maxSeries: 12,
  /** Labels, which is also the number of points in every series. */
  maxPoints: 200,
  /** Labels of a pie or doughnut chart. */
  maxSlices: 24,
  /** Characters (code points). */
  maxTitleChars: 200,
  maxSubtitleChars: 200,
  maxAxisTitleChars: 100,
  maxLabelChars: 100,
  maxSeriesNameChars: 100,
  /** options.prefix and options.suffix, each. */
  maxAffixChars: 12,
  /** options.decimals: 0 to this. */
  maxDecimals: 4,
  /** A number in the chart is 0, or at least minAbsValue and at most maxAbsValue in size. */
  maxAbsValue: 1e15,
  minAbsValue: 1e-6,
  /** The chart JSON in bytes of UTF-8: the body of POST /v1/charts and of the free endpoint, and the "c" parameter. */
  maxJsonBytes: 64 * 1024,
  /** Longest signed chart URL (path and query) that is accepted. */
  maxSignedUrlChars: 8192,
  /** Value labels drawn on one chart; the less important ones are left out beyond this. */
  maxValueLabels: 400,
  /**
   * Charge once: how long the record that a chart was charged is kept, from that charge. While it
   * is kept, a copy whose stored period (the plan's cache days) ended is drawn and stored again
   * without a new charge. The same number of days as EMAIL_FIELDS.chargeMemoryDays, by decision;
   * the record is the same kind of row (src/lib/quota.ts "Charge once").
   */
  chargeMemoryDays: 400,
  /** Cache lifetime sent with a signed chart URL's image (email clients' image proxies), never past the stored copy's expiry. */
  maxAgeSeconds: 30 * 24 * 60 * 60,
  /**
   * The corner mark of a Free chart is drawn as for a canvas at least this wide, so that it stays
   * readable on a small chart, in steps of markWidthStep up to the card width it was designed for.
   */
  markMinWidth: 720,
  markWidthStep: 120,
  markMaxWidth: 1200,
  /**
   * What chart requests count against, for the published rate-limit table. RATE_LIMITS' own scope
   * texts are printed on every build of the site, so they do not name the chart routes; the site
   * adds these while its "charts" feature is on.
   */
  rateLimitScopes: {
    RL_KEY: 'POST /v1/charts (per API key) and uncached signed chart URLs (per site)',
    RL_PLAYGROUND: 'the free chart maker (POST /api/tools/chart), counted apart from the playground',
  },
} as const;

/** Kill switches of the v3 tools and of chart images (env var names). */
export const FEATURE_FLAGS = {
  batch: 'BATCH_ENABLED',
  toolkit: 'PDF_TOOLKIT_ENABLED',
  linkcards: 'LINK_CARDS_ENABLED',
  emailfields: 'EMAIL_FIELDS_ENABLED',
  charts: 'CHARTS_ENABLED',
  ai: 'AI_ENABLED',
} as const;
export type FeatureName = keyof typeof FEATURE_FLAGS;

/**
 * The free in-browser PDF tools, /tools/merge-pdf and /tools/image-to-pdf. They run in the
 * visitor's browser (site/src-browser/pdf-local.ts): no request carries the files and nothing is
 * charged or counted, so these are not cost limits. They keep a phone's browser tab within its
 * memory, and the pages print them.
 */
export const LOCAL_PDF = {
  /** Files in one list. */
  maxFiles: 50,
  /** All files of one list together. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** Pages of one PDF, and of the merged PDF. */
  maxPages: 1000,
  /**
   * Pixels of a PNG, WebP or GIF: these are decoded in memory (4 bytes a pixel, held several
   * times over while pdf-lib compresses them again). JPEGs are embedded without decoding.
   */
  maxImagePixels: 30_000_000,
} as const;

/*
 * AI images (src/ai): "Fix my preview" covers (Tool 1) and scan-safe QR codes on an AI background
 * (Tool 3). One model, Cloudflare Workers AI's FLUX.2 [klein] 4B. Owner's rules (BUILD REQUEST v3,
 * 2026-11-28): staging only until approved (AI_ENABLED), no free-text prompt (the prompt is made of
 * the enums below and validated hex colours only), and every generated image is checked before
 * anyone sees it. Measured figures are from the trial of 2026-11-28 (AI-SPEC.md section 0).
 */

/** A model of the Workers AI provider. Only `selectable` models can be configured (AI.model). */
export interface AiModel {
  /** Workers AI model name. */
  id: string;
  /** How the binding takes input: a multipart form (FLUX.2) or a JSON object (FLUX.1). */
  input: 'multipart' | 'json';
  selectable: boolean;
  /** Width and height the model accepts (klein-4b: 256-1920). Sizes asked for are multiples of sizeStep. */
  minSide: number;
  maxSide: number;
  sizeStep: number;
  /** Reference images per request, and the largest side of each (klein-4b: "smaller than 512x512"). */
  maxRefs: number;
  maxRefSide: number;
  /**
   * Neuron estimate for the daily budget only (the measured cost comes from Cloudflare's analytics):
   * neuronsPerOutputMegapixel per started megapixel of output (1,000,000 pixels; the trial saw a
   * 1216 x 640 and a 512 x 272 image each billed as one), plus neuronsPerInputTile per 512 x 512
   * tile of reference input, pro rata (a 448 x 448 input added about 4.1).
   */
  neuronsPerOutputMegapixel: number;
  neuronsPerInputTile: number;
}

export const AI_MODELS = {
  'flux-2-klein-4b': {
    id: '@cf/black-forest-labs/flux-2-klein-4b',
    input: 'multipart',
    selectable: true,
    minSide: 256,
    maxSide: 1920,
    sizeStep: 16,
    maxRefs: 4,
    maxRefSide: 511,
    neuronsPerOutputMegapixel: 104.2,
    neuronsPerInputTile: 5.37,
  },
  // For comparison only (trial: 172.8 neurons for its fixed 1024 x 1024 output). Not selectable.
  'flux-1-schnell': {
    id: '@cf/black-forest-labs/flux-1-schnell',
    input: 'json',
    selectable: false,
    minSide: 1024,
    maxSide: 1024,
    sizeStep: 1024,
    maxRefs: 0,
    maxRefSide: 0,
    neuronsPerOutputMegapixel: 172.8,
    neuronsPerInputTile: 0,
  },
} as const satisfies Record<string, AiModel>;
export type AiModelId = keyof typeof AI_MODELS;

export const AI_STYLES = ['soft-gradient', 'geometric', 'paper-cut', 'watercolor', 'neon-night', 'bold-flat', 'grain-minimal', 'photo-texture'] as const;
export type AiStyle = (typeof AI_STYLES)[number];

export const AI_MOTIFS = [
  'abstract-shapes',
  'waves',
  'leaves',
  'flowers',
  'citrus',
  'coffee-beans',
  'mountains',
  'desert-dunes',
  'forest',
  'city-lines',
  'circuits',
  'clouds',
  'paper-stack',
  'stars',
  'tiles',
  'bubbles',
  'ribbons',
  'prisms',
  'sun-rays',
  'snowflakes',
] as const;
export type AiMotif = (typeof AI_MOTIFS)[number];

export const AI_LAYOUTS = ['left', 'center'] as const;
export type AiLayout = (typeof AI_LAYOUTS)[number];

/** The two cover sizes: the image delivered, and the size asked of the model (multiples of 16, cropped to fit). */
export const AI_COVER_SIZES = {
  cover: { width: 1200, height: 630, generate: { width: 1216, height: 640 } },
  header: { width: 1200, height: 400, generate: { width: 1216, height: 400 } },
} as const;
export type AiCoverSize = keyof typeof AI_COVER_SIZES;

export const AI = {
  /** The provider and model in production use; AI_PROVIDER ("workers-ai" or "mock") picks the provider. */
  provider: 'workers-ai:flux-2-klein-4b',
  model: 'flux-2-klein-4b' satisfies AiModelId,
  /** One model call (generation or check); a call still running after this answers 504 ai_timeout, never charged. */
  timeoutMs: 30_000,

  /* Sizes */
  coverSizes: AI_COVER_SIZES,
  /** Free cover preview: the cover drawn at this width, with the preview mark. */
  previewCover: { width: 600, height: 315 },
  /** QR backgrounds are square; the free QR preview and the paid QR image. */
  qrBackground: { width: 1024, height: 1024 },
  qrPreviewSide: 600,
  qrPaidSide: 2048,

  /* Credits: 1 per final cover, regenerated cover or paid QR code. */
  creditsPerImage: 1,
  /**
   * Whether the Free plan's monthly allowance pays for AI images. false: only top-up credits do on
   * the Free plan (each image costs real money and Free accounts cost nothing to make); Starter and
   * Pro pay from their monthly allowance, then from top-ups. The owner's choice to confirm.
   */
  freePlanAllowance: false,

  /* Free previews (no account): Turnstile, and these per client (IPv4 address or IPv6 /64) per UTC day. */
  freePreviewsPerIpPerDay: 3,
  /** Previews of one page (the checked page's URL, or the QR code's URL) per client per UTC day. */
  freePreviewsPerPagePerIpPerDay: 1,
  /** Free previews and the backgrounds behind them (so buying reuses that exact background) are kept this long. */
  freePreviewTtlMs: DAY_MS,
  /** An account's generated backgrounds (reusable with background_id) and its uploads are kept this long. */
  backgroundTtlMs: DAY_MS,
  uploadTtlMs: DAY_MS,

  /* Spend cap (estimated neurons per UTC day, D1). AI_DAILY_NEURON_BUDGET and AI_FREE_DAILY_NEURON_BUDGET override. */
  dailyNeuronBudget: 200_000,
  freeDailyNeuronBudget: 20_000,
  /** SUPPORT_EMAIL is told when a budget reaches these percentages, once per budget, percentage and UTC day. */
  budgetAlertPercents: [80, 100],
  /** Images generated per account per UTC day (covers, QR backgrounds, retries included). */
  maxImagesPerAccountPerDay: 500,

  /* Prompt words. Nothing else reaches the model: no title, description, URL or file name. */
  styles: {
    'soft-gradient': 'soft smooth colour gradients with gentle blurred light, calm and airy',
    geometric: 'clean geometric shapes, circles, triangles and bands with crisp edges',
    'paper-cut': 'layered paper-cut craft style with soft drop shadows between the layers',
    watercolor: 'loose watercolour washes on textured paper, soft edges and light bleeding colour',
    'neon-night': 'glowing neon light lines on a dark night background, soft glow',
    'bold-flat': 'bold flat vector illustration with large simple shapes and no gradients',
    'grain-minimal': 'minimal composition with fine film grain, lots of calm empty space',
    'photo-texture': 'close-up photographic texture with shallow depth of field',
  } satisfies Record<AiStyle, string>,
  motifs: {
    'abstract-shapes': 'soft abstract shapes',
    waves: 'gentle ocean waves',
    leaves: 'green leaves and stems',
    flowers: 'simple flowers and petals',
    citrus: 'slices of citrus fruit',
    'coffee-beans': 'roasted coffee beans',
    mountains: 'layered mountain ridges',
    'desert-dunes': 'rolling sand dunes',
    forest: 'tall forest trees',
    'city-lines': 'abstract city skyline lines',
    circuits: 'abstract circuit board traces and nodes',
    clouds: 'soft clouds in the sky',
    'paper-stack': 'stacked sheets of plain coloured paper without any writing',
    stars: 'scattered stars and small planets',
    tiles: 'patterned ceramic tiles',
    bubbles: 'floating translucent bubbles',
    ribbons: 'flowing silk ribbons',
    prisms: 'glass prisms and light refractions',
    'sun-rays': 'warm sun rays',
    snowflakes: 'delicate snowflakes',
  } satisfies Record<AiMotif, string>,
  /** motif "auto": the first motif, in this order, with a word of the title that starts with one of its stems. */
  motifKeywords: {
    circuits: ['tech', 'software', 'code', 'coding', 'developer', 'api', 'data', 'program', 'engineer', 'javascript', 'python', 'web', 'app', 'startup', 'saas', 'ai'],
    waves: ['ocean', 'sea', 'beach', 'surf', 'water', 'swim', 'sail', 'boat', 'wave'],
    leaves: ['garden', 'plant', 'eco', 'sustainab', 'nature', 'leaf', 'leaves', 'green'],
    flowers: ['flower', 'bloom', 'floral', 'spring', 'rose'],
    citrus: ['lemon', 'orange', 'lime', 'fruit', 'juice', 'fresh', 'summer'],
    'coffee-beans': ['coffee', 'cafe', 'espresso', 'latte', 'breakfast'],
    mountains: ['mountain', 'hike', 'hiking', 'travel', 'adventure', 'outdoor', 'climb', 'ski'],
    'desert-dunes': ['desert', 'sand', 'dune'],
    forest: ['forest', 'wood', 'tree', 'camp'],
    'city-lines': ['city', 'urban', 'architect', 'building', 'estate', 'property'],
    clouds: ['cloud', 'weather', 'sky', 'dream'],
    'paper-stack': ['writing', 'blog', 'newsletter', 'note', 'essay', 'story', 'journal'],
    stars: ['night', 'star', 'space', 'astronom', 'launch', 'rocket'],
    tiles: ['design', 'pattern', 'home', 'interior', 'kitchen'],
    bubbles: ['clean', 'soap', 'bath', 'fizz'],
    ribbons: ['event', 'gift', 'party', 'celebrat', 'anniversar'],
    prisms: ['light', 'glass', 'crystal', 'physics', 'science'],
    'sun-rays': ['sun', 'morning', 'energy', 'solar'],
    snowflakes: ['winter', 'snow', 'christmas', 'frost'],
  } satisfies Partial<Record<AiMotif, readonly string[]>>,
  /** motif "auto" with no keyword in the title. */
  defaultMotif: 'abstract-shapes' satisfies AiMotif,
  layouts: {
    left: 'wide composition: the left half is calm, plain and empty, the motif sits on the right side',
    center: 'wide composition: a calm, plain, empty area in the centre, the motif around the edges',
  } satisfies Record<AiLayout, string>,
  qrLayout: 'square composition: a decorative frame of the motif around the edges and a large plain, empty, light centre',
  /** Appended to every prompt. */
  negativeSuffix:
    'No text, no letters, no words, no numbers, no logos, no watermarks, no signatures, no people, no faces, no hands, no bodies, no documents, no forms, no screens, no user interfaces.',
  /** Palette: up to this many colours, #rrggbb only. */
  maxPaletteColours: 3,

  /* Text drawn on a cover by Satori (never by the model): characters (code points). */
  maxChars: { title: 120, description: 200, siteName: 60, alt: 300 },

  /* Checks on images */
  outputCheck: {
    /** Every generated background is checked before it is used; off only for an operator's experiment. */
    enabled: true,
    model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    /** Model calls per image: the first generation and this many retries with a new seed. */
    retries: 1,
    maxTokens: 200,
    question:
      'Inspect this image. Answer with JSON only, no prose: {"readable_text": true|false, "human_face": true|false, "person_or_body": true|false, "brand_logo": true|false, "document_or_form": true|false, "nudity": true|false}. readable_text is true if any readable letters, words or numbers appear.',
    /** A generated background is refused when any of these is true (an answer that does not parse is a refusal too). */
    rejectWhen: ['readable_text', 'document_or_form', 'human_face', 'person_or_body', 'brand_logo', 'nudity'],
    /** Uploads: a reference image is checked like a background, without text; a logo may show its own name and mark. */
    rejectUploadWhen: {
      reference: ['document_or_form', 'human_face', 'person_or_body', 'brand_logo', 'nudity'],
      logo: ['document_or_form', 'human_face', 'person_or_body', 'nudity'],
    },
    /**
     * Neurons counted against the daily budget per check. NOT MEASURED: an upper estimate from
     * Cloudflare's published price for this model and an image of about 1,500 input tokens.
     * Replace with the staging measurement (aiInferenceAdaptiveGroups).
     */
    estimatedNeurons: 100,
  },
  /** Reference images are experimental (the trial showed weak style steering): off until switched on here. */
  referencesEnabled: false,
  uploads: {
    types: ['image/png', 'image/jpeg'],
    maxReferenceBytes: 300 * 1024,
    maxReferenceSide: 512,
    maxReferences: 3,
    maxLogoBytes: 300 * 1024,
    maxLogoSide: 1024,
    /** Largest multipart body of POST /api/ai/uploads. */
    maxRequestBytes: 320 * 1024,
  },
  /** JSON body of every AI route. */
  maxRequestBodyBytes: 16 * 1024,

  /* Tool 3: QR codes */
  qr: {
    maxUrlChars: 512,
    /** Error correction Q (25% of the code may be damaged), a quiet zone of 4 modules on a solid light plate. */
    ecc: 'Q',
    quietZoneModules: 4,
    /** Dark modules against the plate, WCAG contrast ratio. */
    minContrast: 7,
    /** The code's modules take at least this share of the image width. */
    minWidthFraction: 0.42,
    /** Scans at full size and at this fraction of it must decode to exactly the encoded URL. */
    verifyScale: 1 / 3,
  },
  /** URL shorteners refused as QR targets (the host or a parent domain). Fixed list. */
  shorteners: [
    'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'v.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly',
    'shorturl.at', 'tiny.cc', 'rb.gy', 'bl.ink', 't.ly', 's.id', 'lnkd.in', 'qrco.de', 'qr.net', 'qrs.ly', 'shorte.st',
    'adf.ly', 'bc.vc', 'clck.ru', 'u.to', 'x.co', 'tr.im', 'soo.gd', 'trib.al', 'db.tt', 'youtu.be', 'amzn.to', 'fb.me',
    'shorturl.com', 'urlz.fr', 'git.io', 'surl.li', 'tiny.one', 'short.gy',
  ],
  urlSafety: {
    /** Cloudflare's security resolver (DNS over HTTPS): blocked domains answer 0.0.0.0 with EDE 16 "Censored". */
    resolverUrl: 'https://security.cloudflare-dns.com/dns-query',
    resolverTimeoutMs: 3000,
    /** Google Web Risk Lookup API, used only when WEB_RISK_API_KEY is set. */
    webRiskUrl: 'https://webrisk.googleapis.com/v1/uris:search',
    webRiskThreatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
    webRiskTimeoutMs: 3000,
  },
  abuse: {
    maxReasonChars: 1000,
    maxTargetChars: 600,
    /** Reports per client per UTC day. */
    reportsPerIpPerDay: 10,
    /** Refusal and report rows are kept this long. */
    retentionDays: 365,
  },
} as const;
