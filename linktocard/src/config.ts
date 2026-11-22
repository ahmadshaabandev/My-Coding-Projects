/**
 * Hard limits that apply to every plan. Plan-specific numbers (quota, cache
 * days, fonts) live in src/billing/plans.ts. The docs "Limits" page is built
 * from this file and plans.ts, so the published limits cannot drift from the
 * enforced ones.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type SizeId = 'og' | 'square' | 'portrait';

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
  RL_IP: { limit: 300, periodSeconds: 60, scope: 'per IP address, all /v1 endpoints (edge-cache hits are not limited)' },
  RL_KEY: { limit: 120, periodSeconds: 60, scope: 'per API key (POST /v1/images) and per site (uncached signed-URL renders)' },
  RL_AUTH: { limit: 5, periodSeconds: 60, scope: 'per IP address: sign-in link requests, sign-in verification and the contact form (counted separately)' },
  RL_PLAYGROUND: { limit: 30, periodSeconds: 60, scope: 'per IP address, homepage playground' },
  RL_PREVIEW: { limit: 60, periodSeconds: 60, scope: 'per account, dashboard live preview' },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Auth lifetimes. */
export const AUTH = {
  magicLinkTtlMs: 15 * 60 * 1000,
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  sessionCookie: 'ltc_session',
  /** Max sign-in emails to one address per hour (anti mail-bombing). */
  maxMagicLinksPerEmailPerHour: 5,
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
export const WORKER_PATHS: readonly string[] = ['/v1/', '/api/', '/auth/', '/webhooks/', '/i/', '/playground/', '/healthz'];

export const API_KEY_PREFIX = 'ltc_';
export const SITE_SECRET_PREFIX = 'ltcs_';

export const DAY_MS = 24 * 60 * 60 * 1000;
