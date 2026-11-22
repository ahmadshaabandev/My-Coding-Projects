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
  PADDLE_WEBHOOK_SECRET?: string;

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

export interface RenderRow {
  cache_key: string;
  user_id: string;
  site_id: string | null;
  source: 'og' | 'api';
  template: string;
  width: number;
  height: number;
  format: ImageFormat;
  bytes: number;
  r2_key: string;
  charged_to: 'plan' | 'topup';
  period_start: number;
  created_at: number;
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
  /** Fetch a remote image through the SSRF-guarded proxy; resolve to a data: URI. */
  fetchImage: (url: string) => Promise<{ dataUri: string }>;
  /** Resolve an emoji grapheme to an SVG data: URI, or undefined to drop it. */
  loadEmoji?: (emoji: string) => Promise<string | undefined>;
  /** Load customer fonts for the given CSS font-family names (paid plans). */
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

export type ConsumeResult =
  | {
      ok: true;
      chargedTo: 'plan' | 'topup';
      periodStart: number;
      usage: UsageSummary;
      /** Thresholds crossed by THIS image (each fires once per period). */
      crossed90: boolean;
      crossed100: boolean;
    }
  | { ok: false; usage: UsageSummary };
