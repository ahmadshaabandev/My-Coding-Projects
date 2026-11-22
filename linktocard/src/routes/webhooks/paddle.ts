/**
 * POST /webhooks/paddle - the only way billing state enters the database.
 *
 * Contract with Paddle: any 2xx within 5 seconds marks the notification as
 * delivered; everything else is retried. So:
 *   200  applied, a duplicate, or understood and deliberately ignored
 *   400  signed by Paddle but not an event envelope
 *   401  missing or wrong signature
 *   500  processing failed - Paddle retries and the event is applied then
 *   503  the signing secret is not configured - Paddle retries until it is
 *
 * Responses are built here instead of thrown so the router answers the same
 * way no matter what error handler the app it is mounted on has.
 */
import { Hono } from 'hono';
import {
  applyPaddleEvent,
  parsePaddleEvent,
  parseTimestamp,
  verifyPaddleSignature,
  webhookSecrets,
  type PaddleEvent,
} from '../../billing/paddle';
import { first, run } from '../../db/client';
import { ApiError, errorResponse, type ErrorCode } from '../../lib/errors';
import type { AppEnv } from '../../types';

export const paddleWebhookRouter = new Hono<AppEnv>();

const RESULT_MAX_CHARS = 300;

/**
 * Claims the event id. Returns false only when the event was already applied:
 * a row without processed_at belongs to an attempt that died (or failed) and
 * must be processed again.
 */
async function claimEvent(db: D1Database, event: PaddleEvent, now: number): Promise<boolean> {
  const inserted = await run(
    db,
    `INSERT INTO webhook_events (event_id, event_type, occurred_at, received_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (event_id) DO NOTHING`,
    event.event_id,
    event.event_type,
    parseTimestamp(event.occurred_at),
    now,
  );
  if (inserted === 1) return true;
  const existing = await first<{ processed_at: number | null }>(
    db,
    'SELECT processed_at FROM webhook_events WHERE event_id = ?1',
    event.event_id,
  );
  return existing === null || existing.processed_at === null;
}

paddleWebhookRouter.post('/paddle', async (c) => {
  const fail = (code: ErrorCode, message: string): Response => errorResponse(new ApiError(code, message), c.env.APP_URL);

  const secrets = webhookSecrets(c.env);
  if (secrets.length === 0) return fail('not_configured', 'Paddle webhooks are not configured.');

  // The signature covers the exact bytes Paddle sent, so verify the raw text before parsing it.
  const rawBody = await c.req.text();
  const now = Date.now();
  const verdict = await verifyPaddleSignature(rawBody, c.req.header('paddle-signature'), secrets, now);
  if (verdict !== 'valid') return fail('unauthorized', 'Invalid Paddle signature.');

  const event = parsePaddleEvent(rawBody);
  if (!event) return fail('invalid_request', 'The request body is not a Paddle event.');

  const db = c.env.DB;
  try {
    if (!(await claimEvent(db, event, now))) return c.json({ ok: true, duplicate: true });
    const outcome = await applyPaddleEvent(c.env, db, event, now);
    await run(
      db,
      'UPDATE webhook_events SET processed_at = ?1, user_id = ?2, result = ?3 WHERE event_id = ?4',
      now,
      outcome.userId ?? null,
      outcome.result,
      event.event_id,
    );
    return c.json({ ok: true, result: outcome.result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`paddle webhook ${event.event_id} (${event.event_type}) failed: ${message}`);
    // Best effort: the audit note must not hide the failure from Paddle.
    await run(
      db,
      'UPDATE webhook_events SET result = ?1 WHERE event_id = ?2 AND processed_at IS NULL',
      `error:${message}`.slice(0, RESULT_MAX_CHARS),
      event.event_id,
    ).catch(() => 0);
    return fail('internal_error', 'The event could not be processed. Paddle will retry it.');
  }
});
