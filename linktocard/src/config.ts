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

/** Kill switches of the v3 tools (env var names). */
export const FEATURE_FLAGS = {
  batch: 'BATCH_ENABLED',
  toolkit: 'PDF_TOOLKIT_ENABLED',
  linkcards: 'LINK_CARDS_ENABLED',
  emailfields: 'EMAIL_FIELDS_ENABLED',
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
