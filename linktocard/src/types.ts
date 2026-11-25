/**
 * Shared types: Worker bindings, database rows and the contracts between
 * modules. Modules import types from here instead of from each other so the
 * dependency graph stays a tree:
 *
 *   routes/*  ->  lib/images.ts  ->  render/*        (pure rendering, no DB)
 *                               ->  lib/quota.ts    (D1 counters)
 *             ->  auth/*, billing/*                 (D1 + outbound HTTP)
 */
import type { PlanId } from './billing/plans';
import type { ImageFormat, RateLimitName } from './config';

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

/** Cloudflare Rate Limiting binding (declared in wrangler.toml). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type EnvironmentName = 'development' | 'test' | 'staging' | 'production';

export interface Env extends Partial<Record<RateLimitName, RateLimitBinding>> {
  /* Storage */
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;

  /* Plain vars (wrangler.toml [vars]) */
  ENVIRONMENT: EnvironmentName;
  /** Public origin, no trailing slash, e.g. https://linktocard.com */
  APP_URL: string;
  SUPPORT_EMAIL: string;
  /** RFC 5322 From value, e.g. "Link To Card <login@linktocard.com>" */
  MAIL_FROM: string;
  /** 'sandbox' | 'production' */
  PADDLE_ENV: string;
  /** "true" opens checkout when the Paddle values are set; anything else shows "Coming soon". */
  CHECKOUT_ENABLED?: string;
  /** Client-side token for Paddle.js (test_... / live_...). Public by design. */
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_PRICE_STARTER?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_TOPUP?: string;

  /* Secrets (wrangler secret put / .dev.vars) - never committed */
  /** Master key from which per-site signing secrets are derived. */
  SIGNING_MASTER_SECRET: string;
  RESEND_API_KEY?: string;
  PADDLE_API_KEY?: string;
  /** One secret, or several separated by commas while rotating. */
  PADDLE_WEBHOOK_SECRET?: string;

  /** Cloudflare Turnstile for the public OG checker. Unset: no challenge, the hourly limit alone applies. */
  TURNSTILE_SECRET_KEY?: string;
  /** Public widget key published by /api/config (plain var). */
  TURNSTILE_SITE_KEY?: string;

  /**
   * Cloudflare Browser Run, the renderer of PDF documents. Declared for staging and production
   * only, so the test pool and `wrangler dev` start offline; tests inject a mock.
   */
  BROWSER?: BrowserRun;
  /** "true" turns the PDF endpoints on (they also need BROWSER); anything else answers 503. */
  PDF_ENABLED?: string;
  /** Daily alarm threshold in browser milliseconds over 24 h; unset means PDF.dailyBrowserMsBudget. */
  PDF_DAILY_BROWSER_MS_BUDGET?: string;

  /** Test-only switch, honoured only when ENVIRONMENT === 'test'. */
  RATE_LIMITS_DISABLED?: string;
}

/** Hono generics used by every router. */
export interface AppVariables {
  user: UserRow;
  apiKey?: ApiKeyRow;
  requestId: string;
}
export type AppEnv = { Bindings: Env; Variables: AppVariables };

/* ------------------------------------------------------------------ */
/* Database rows (mirror src/db/migrations/0001_init.sql)              */
/* ------------------------------------------------------------------ */

export interface UserRow {
  id: string;
  email: string;
  created_at: number;
  plan: PlanId;
  suspended_at: number | null;
  suspended_reason: string | null;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  subscription_status: string | null;
  subscription_price_id: string | null;
  period_start: number | null;
  period_end: number | null;
  cancel_at: number | null;
  subscription_event_at: number | null;
  /** Set by the operator on a deletion request; the daily cleanup then purges the account. */
  deletion_requested_at: number | null;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface SiteRow {
  id: string;
  user_id: string;
  name: string;
  secret_version: number;
  created_at: number;
  deleted_at: number | null;
}

export interface TemplateRow {
  id: string;
  user_id: string;
  name: string;
  html: string;
  css: string;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface FontRow {
  id: string;
  user_id: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  format: 'ttf' | 'otf' | 'woff';
  bytes: number;
  sha256: string;
  r2_key: string;
  created_at: number;
  deleted_at: number | null;
}

export interface UsagePeriodRow {
  user_id: string;
  period_start: number;
  period_end: number;
  used: number;
  topup_used: number;
  notified_90: number;
  notified_100: number;
}

export interface TopupRow {
  id: string;
  user_id: string;
  paddle_transaction_id: string;
  images: number;
  remaining: number;
  created_at: number;
  expires_at: number;
  refunded_at: number | null;
}

/**
 * One ledger row. A stored PDF has one too: format 'pdf', width and height 0, source 'api'
 * (POST /v1/pdf) or 'signed' (signed PDF link); see src/db/migrations/0006_pdf.sql.
 */
export interface RenderRow {
  cache_key: string;
  user_id: string;
  site_id: string | null;
  source: 'og' | 'api' | 'signed';
  template: string;
  width: number;
  height: number;
  format: ImageFormat | 'pdf';
  bytes: number;
  r2_key: string;
  /** 'pending' only for a PDF row whose charge is in progress (src/lib/quota.ts chargePdf). */
  charged_to: 'plan' | 'topup' | 'pending';
  period_start: number;
  created_at: number;
  expires_at: number;
}

/** One OG checker result (src/db/migrations/0005_og_checks.sql). Times are epoch ms. */
export interface OgCheckRow {
  id: string;
  /** The normalised URL that was checked; the cache key. */
  url_key: string;
  /** CheckResult JSON (src/inspect/types.ts) as stored, cached = false. */
  result: string;
  image_url: string | null;
  favicon_url: string | null;
  created_at: number;
  expires_at: number;
}

/** PDFs charged in one billing period and the images they counted as (0006_pdf.sql). */
export interface PdfUsageRow {
  user_id: string;
  period_start: number;
  pdfs: number;
  units: number;
}

/** One PDF render attempt that reached the browser: cost tracking and the daily alarm (0006_pdf.sql). */
export interface BrowserUsageRow {
  id: string;
  /** Null for the free tools, and once the account has been deleted. */
  user_id: string | null;
  source: 'api' | 'signed' | 'tool';
  /** HTTP status of the browser's answer; 0 when the call itself failed. */
  status: number;
  /** X-Browser-Ms-Used; null when the browser did not report it. Browser Run sends 0 for PDF quick actions. */
  browser_ms: number | null;
  /** How long the call took, measured by the Worker; the alarm and the brake count the larger of the two. */
  wall_ms: number | null;
  /** Pages of the PDF it returned; null without a readable PDF. */
  pages: number | null;
  created_at: number;
}

/** A fixed-window counter: per-IP hourly checks, per-key daily inspections. */
export interface ToolUsageRow {
  bucket: string;
  count: number;
  expires_at: number;
}

/* ------------------------------------------------------------------ */
/* Rendering contract (src/render/*)                                   */
/* ------------------------------------------------------------------ */

/** Template data: flat string map. Keys match LIMITS.dataKeyPattern. */
export type TemplateData = Record<string, string>;

export type WatermarkMode = 'none' | 'free' | 'preview';

/** A font ready for Satori. */
export interface LoadedFont {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  data: ArrayBuffer;
}

export interface RenderInput {
  html: string;
  css: string;
  data: TemplateData;
  width: number;
  height: number;
  format: ImageFormat;
  watermark: WatermarkMode;
}

/**
 * Side effects the renderer needs, injected so that rendering stays pure and
 * testable. Every remote resource goes through one of these - the renderer
 * itself never calls fetch().
 */
export interface RenderDeps {
  /**
   * Fetch a remote image through the SSRF-guarded proxy; resolve to a data: URI.
   * The URI must be base64 PNG, JPEG or GIF, or SVG with a viewBox or width + height.
   * WebP must be transcoded (src/render/proxy.ts does) or rejected by the fetcher.
   */
  fetchImage: (url: string) => Promise<{ dataUri: string }>;
  /** Resolve an emoji grapheme to an SVG data: URI, or undefined to drop it. */
  loadEmoji?: (emoji: string) => Promise<string | undefined>;
  /**
   * Load customer fonts for the given CSS font-family names (paid plans). Return the
   * same ArrayBuffer instances across calls so the font list is not re-parsed.
   */
  loadFonts?: (families: string[]) => Promise<LoadedFont[]>;
}

export interface RenderTimings {
  compileMs: number;
  imagesMs: number;
  layoutMs: number;
  rasterMs: number;
  encodeMs: number;
  totalMs: number;
}

export interface RenderOutput {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
  /** Human-readable notes about ignored/unsupported template features. */
  warnings: string[];
  timings: RenderTimings;
}

/* ------------------------------------------------------------------ */
/* Usage / quota contract (src/lib/quota.ts)                           */
/* ------------------------------------------------------------------ */

export interface UsageSummary {
  plan: PlanId;
  /** Billing period the counter belongs to (epoch ms, UTC). */
  period_start: number;
  period_end: number;
  /** Monthly allowance of the plan. */
  limit: number;
  used: number;
  /** max(0, limit - used) */
  remaining: number;
  /** Unexpired purchased top-up images still available. */
  topup_remaining: number;
  /** remaining + topup_remaining */
  total_remaining: number;
  cache_days: number;
  watermark: boolean;
}

