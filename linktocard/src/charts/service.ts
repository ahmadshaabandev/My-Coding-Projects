// Chart images behind the signed URL (/v1/chart) and POST /v1/charts: stored, charged and served
// by the card pipeline (src/lib/images.ts getImage), with the charts' own renderer.
//
// The charging rule (owner's decision, 2026-11-28: "1 credit per new chart, repeat views free"):
//
//   A chart is one account + one chart (its canonical form, src/charts/spec.ts canonicalChart)
//   + one output format. It is charged 1 image the first time it is drawn. While its stored copy
//   exists, requests are answered from the edge cache or R2. When the copy's period (the plan's
//   cache days) has ended, the next request draws and stores it again WITHOUT a new charge, for
//   as long as the charge is remembered (CHARTS.chargeMemoryDays from the charge).
//
// This is the "charge once" of email images, reused: the record that the chart was charged is a
// tool_usage row written inside the D1 batch that takes the image (src/lib/quota.ts
// CHARGE_RECORD_*), read by hasChargeRecord. Two keys, both a sha256 that holds the account:
//
//   charge key   account + chart + format. Names the charge record. The plan's mark is NOT in
//                it, so a chart that was charged is not charged again when the account moves
//                between Free (marked) and a paid plan (unmarked).
//   cache key    the same plus the mark. Names the stored copy and its ledger row, and is the
//                id in /i/{account}/{id}.{ext}.
//
// A refused or failed render is never charged, and the free chart maker's endpoint
// (src/routes/charts.ts) uses none of this: it draws and returns, nothing else.
import { CHARTS, DAY_MS, type ImageFormat } from '../config'
import { sha256Hex } from '../lib/crypto'
import type { Background } from '../lib/http'
import { getImage, planWatermark, type Card, type ImageJob } from '../lib/images'
import { hasChargeRecord } from '../lib/quota'
import { createEmojiLoader } from '../render/emoji'
import type { Env, UserRow } from '../types'
import { assertChartFormat, renderChart, type ChartMark, type ChartRenderDeps } from './render'
import { canonicalChart, type Chart } from './spec'

/** Bump only on purpose: a new charge-key version charges every chart again, a new cache-key version redraws every stored one. */
const CHARGE_KEY_VERSION = 'ltc-chart-paid-v1'
const CACHE_KEY_VERSION = 'ltc-chart-v1'
/** What the ledger (renders.template) and the stored copy call a chart. */
export const CHART_LABEL = 'chart'

export interface ChartRequest {
  user: UserRow
  chart: Chart
  format: ImageFormat
  source: 'og' | 'api'
  siteId: string | null
  /** RL_KEY bucket applied only when a render is really needed (signed URLs: the site id). */
  renderRateLimitKey?: string
}

export interface ChartKeys {
  cacheKey: string
  chargeKey: string
}

/** Free plan: the corner mark, like every Free render. Paid plans: none. */
export function chartMark(user: Pick<UserRow, 'plan'>): ChartMark {
  return planWatermark(user) === 'none' ? 'none' : 'free'
}

export async function chartKeys(request: Pick<ChartRequest, 'user' | 'chart' | 'format'>): Promise<ChartKeys> {
  const chart = canonicalChart(request.chart)
  const [chargeKey, cacheKey] = await Promise.all([
    sha256Hex(JSON.stringify([CHARGE_KEY_VERSION, request.user.id, chart, request.format])),
    sha256Hex(JSON.stringify([CACHE_KEY_VERSION, request.user.id, chart, request.format, chartMark(request.user)])),
  ])
  return { cacheKey, chargeKey }
}

/** True while the account's charge for this chart is remembered: drawing it again now is free. */
export function chartIsPaid(db: D1Database, userId: string, keys: ChartKeys, now: number): Promise<boolean> {
  return hasChargeRecord(db, userId, keys.chargeKey, now)
}

export function chartRenderDeps(env: Pick<Env, 'ASSETS'>): ChartRenderDeps {
  return { loadEmoji: createEmojiLoader(env.ASSETS) }
}

/** The chart as a job of the card pipeline: charged once, drawn by renderChart. */
export function chartJob(env: Env, request: ChartRequest, keys: ChartKeys): ImageJob {
  const { user, chart, format } = request
  return {
    user,
    format,
    source: request.source,
    siteId: request.siteId,
    ...(request.renderRateLimitKey ? { renderRateLimitKey: request.renderRateLimitKey } : {}),
    label: CHART_LABEL,
    chargeOnce: { key: keys.chargeKey, memoryMs: CHARTS.chargeMemoryDays * DAY_MS },
    render: () => renderChart(chart, { format, mark: chartMark(user) }, chartRenderDeps(env)),
  }
}

/**
 * The chart for a request: from R2 when it is stored, otherwise drawn, charged (once) and stored.
 * Throws ApiError (400 for a format the chart cannot have, 402 quota_exceeded, render errors).
 */
export async function getChart(env: Env, background: Background, request: ChartRequest, options: { now: number; withBody: boolean; keys?: ChartKeys }): Promise<Card> {
  assertChartFormat(request.chart, request.format)
  const keys = options.keys ?? (await chartKeys(request))
  return getImage(env, background, chartJob(env, request, keys), { now: options.now, withBody: options.withBody, cacheKey: keys.cacheKey })
}
