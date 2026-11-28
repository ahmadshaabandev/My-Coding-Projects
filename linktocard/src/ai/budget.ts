/**
 * The AI spend cap (AI-SPEC.md section 7). Cloudflare has no hard spending cap for Workers AI, so
 * this is ours: estimated neurons per UTC day, counted in D1 (tool_usage rows, the fixed-window
 * counter pattern of src/inspect/limits.ts), in two counters:
 *
 *   all    every generation and check (budget AI_DAILY_NEURON_BUDGET, else AI.dailyNeuronBudget)
 *   free   the free previews only     (budget AI_FREE_DAILY_NEURON_BUDGET, else AI.freeDailyNeuronBudget)
 *
 * A model call is checked against the budgets BEFORE it is made (assertBudget: the estimate of the
 * call must still fit) and recorded after it (recordSpend). Above the free budget the free previews
 * answer 503 ai_busy until 00:00 UTC; above the total, every generation does. Nothing is charged
 * then. SUPPORT_EMAIL gets one email per budget and percentage (AI.budgetAlertPercents) per UTC
 * day, claimed atomically like the PDF budget alarm (src/pdf/alarm.ts); a failed send releases the
 * claim so a later call retries. The estimates are for this cap only; the cost comes from
 * Cloudflare's analytics.
 *
 * Per account: at most AI.maxImagesPerAccountPerDay generated images per UTC day (retries count).
 */
import { AI, DAY_MS } from '../config';
import { first, run } from '../db/client';
import { sendEmail } from '../lib/email';
import { ApiError } from '../lib/errors';
import type { Background } from '../lib/http';
import type { Env } from '../types';

export type SpendScope = 'free' | 'account';
type Counter = 'all' | 'free';

const utcDay = (now: number): number => Math.floor(now / DAY_MS);
const neuronBucket = (counter: Counter, day: number): string => `ai-neurons:${counter}:${day}`;
const imagesBucket = (userId: string, day: number): string => `ai-images:${userId}:${day}`;
const alarmBucket = (counter: Counter, percent: number, day: number): string => `ai-budget-alarm:${counter}:${percent}:${day}`;
/** Counter rows outlive their day by one, so a request just after midnight never reads a missing row as a reset by mistake. */
const expiry = (day: number): number => (day + 2) * DAY_MS;

function positiveInteger(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  return /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
}

export function neuronBudgets(env: Pick<Env, 'AI_DAILY_NEURON_BUDGET' | 'AI_FREE_DAILY_NEURON_BUDGET'>): { all: number; free: number } {
  return {
    all: positiveInteger(env.AI_DAILY_NEURON_BUDGET) ?? AI.dailyNeuronBudget,
    free: positiveInteger(env.AI_FREE_DAILY_NEURON_BUDGET) ?? AI.freeDailyNeuronBudget,
  };
}

async function count(db: D1Database, bucket: string): Promise<number> {
  return (await first<{ count: number }>(db, 'SELECT count FROM tool_usage WHERE bucket = ?1', bucket))?.count ?? 0;
}

async function add(db: D1Database, bucket: string, amount: number, expiresAt: number): Promise<number> {
  const row = await db
    .prepare('INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (bucket) DO UPDATE SET count = count + ?2 RETURNING count')
    .bind(bucket, amount, expiresAt)
    .first<{ count: number }>();
  return row?.count ?? amount;
}

/** Estimated neurons used today (UTC), per counter. */
export async function neuronsToday(db: D1Database, now: number): Promise<{ all: number; free: number }> {
  const day = utcDay(now);
  const [all, free] = await Promise.all([count(db, neuronBucket('all', day)), count(db, neuronBucket('free', day))]);
  return { all, free };
}

function secondsToMidnight(now: number): number {
  return Math.max(1, Math.ceil(((utcDay(now) + 1) * DAY_MS - now) / 1000));
}

export function busyError(now: number): ApiError {
  return new ApiError('ai_busy', 'AI images have reached their limit for today. Try again after 00:00 UTC. Nothing was charged.', {
    headers: { 'retry-after': String(secondsToMidnight(now)) },
  });
}

/** 503 ai_busy unless a call estimated at `estimate` neurons still fits today's budgets for this scope. */
export async function assertBudget(env: Env, scope: SpendScope, estimate: number, now: number): Promise<void> {
  const budgets = neuronBudgets(env);
  const used = await neuronsToday(env.DB, now);
  if (used.all + estimate > budgets.all) throw busyError(now);
  if (scope === 'free' && used.free + estimate > budgets.free) throw busyError(now);
}

function alertEmail(counter: Counter, percent: number, used: number, budget: number, now: number, environment: string): { subject: string; text: string; html: string } {
  const which = counter === 'free' ? 'free previews' : 'all AI images';
  const paragraphs = [
    `On ${new Date(now).toISOString().slice(0, 10)} (UTC), ${which} on ${environment} used an estimated ${used} neurons: ${percent}% of the daily budget of ${budget}.`,
    percent >= 100
      ? `${counter === 'free' ? 'Free previews' : 'Every AI generation'} now answers 503 ai_busy until 00:00 UTC. Nothing is charged for those requests.`
      : 'Nothing has been switched off yet.',
    'These are estimates from AI.models in src/config.ts; the billed neurons are in the Cloudflare dashboard (Workers AI analytics). The budgets are the Worker variables AI_DAILY_NEURON_BUDGET and AI_FREE_DAILY_NEURON_BUDGET. Cloudflare has no hard spending cap for Workers AI. This alert is sent once per budget, percentage and UTC day.',
  ];
  return {
    subject: `Link To Card: ${which} at ${percent}% of the daily AI budget`,
    text: `${paragraphs.join('\n\n')}\n`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#111827">${paragraphs.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('')}</body></html>`,
  };
}

async function alertIfCrossed(env: Env, counter: Counter, used: number, budget: number, now: number): Promise<void> {
  const day = utcDay(now);
  for (const percent of AI.budgetAlertPercents) {
    if (used * 100 < budget * percent) continue;
    const bucket = alarmBucket(counter, percent, day);
    const claimed = await run(env.DB, 'INSERT INTO tool_usage (bucket, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT (bucket) DO NOTHING', bucket, expiry(day));
    if (claimed !== 1) continue;
    const environment = env.ENVIRONMENT || 'unknown';
    const result = await sendEmail(env, { to: env.SUPPORT_EMAIL, ...alertEmail(counter, percent, used, budget, now, environment), idempotencyKey: `ai-budget-${environment}-${counter}-${percent}-${day}` });
    if (!result.ok) {
      console.error(`AI budget alert (${counter} ${percent}%) was not sent: ${result.error}`);
      await run(env.DB, 'DELETE FROM tool_usage WHERE bucket = ?1', bucket);
    }
  }
}

/**
 * Records what a call cost (estimated neurons, rounded up) and sends the alerts it crossed, in the
 * background. Called for every call that reached the model, also when its image was refused.
 */
export async function recordSpend(env: Env, background: Background, scope: SpendScope, neurons: number, now: number): Promise<void> {
  if (!(neurons > 0)) return;
  const amount = Math.ceil(neurons);
  const day = utcDay(now);
  const budgets = neuronBudgets(env);
  const all = await add(env.DB, neuronBucket('all', day), amount, expiry(day));
  const free = scope === 'free' ? await add(env.DB, neuronBucket('free', day), amount, expiry(day)) : null;
  background(
    (async () => {
      await alertIfCrossed(env, 'all', all, budgets.all, now);
      if (free !== null) await alertIfCrossed(env, 'free', free, budgets.free, now);
    })().catch((error: unknown) => console.error('AI budget alert failed:', error)),
  );
}

/** 429 rate_limited once the account generated AI.maxImagesPerAccountPerDay images today (UTC). */
export async function assertAccountImages(db: D1Database, userId: string, images: number, now: number): Promise<void> {
  const used = await count(db, imagesBucket(userId, utcDay(now)));
  if (used + images > AI.maxImagesPerAccountPerDay) {
    throw new ApiError('rate_limited', `This account has generated ${AI.maxImagesPerAccountPerDay} AI images today, the daily limit. Try again after 00:00 UTC.`, {
      headers: { 'retry-after': String(secondsToMidnight(now)) },
      details: { limit: AI.maxImagesPerAccountPerDay, period_seconds: DAY_MS / 1000 },
    });
  }
}

export async function countAccountImages(db: D1Database, userId: string, images: number, now: number): Promise<void> {
  const day = utcDay(now);
  await add(db, imagesBucket(userId, day), images, expiry(day));
}
