/**
 * API keys for the /v1 API. The secret is shown exactly once, at creation;
 * D1 keeps only its SHA-256 plus a short prefix for display.
 */
import { API_KEY_PREFIX, LIMITS } from '../config';
import { all, first, getUserById, run } from '../db/client';
import { randomId, randomSecret, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import type { ApiKeyRow, UserRow } from '../types';

const SECRET_CHARS = 40;
const DISPLAY_PREFIX_CHARS = 12;
/** last_used_at is informational; one write per minute per key is plenty. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const KEY_RE = new RegExp(`^${API_KEY_PREFIX}[0-9A-Za-z]{${SECRET_CHARS}}$`);

/** What the dashboard may show: no hash, no owner. */
export type ApiKeySummary = Pick<ApiKeyRow, 'id' | 'name' | 'prefix' | 'created_at' | 'last_used_at'>;

function cleanName(name: string): string {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) throw new ApiError('invalid_request', 'Give the API key a name.');
  if (cleaned.length > LIMITS.maxNameChars) {
    throw new ApiError('invalid_request', `An API key name can be at most ${LIMITS.maxNameChars} characters.`);
  }
  return cleaned;
}

/** Creates a key. `secret` is the only copy of the full key that will ever exist. */
export async function createApiKey(
  db: D1Database,
  userId: string,
  name: string,
  now: number,
): Promise<{ row: ApiKeyRow; secret: string }> {
  const secret = API_KEY_PREFIX + randomSecret(SECRET_CHARS);
  const row: ApiKeyRow = {
    id: randomId('k'),
    user_id: userId,
    name: cleanName(name),
    prefix: secret.slice(0, DISPLAY_PREFIX_CHARS),
    key_hash: await sha256Hex(secret),
    created_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  // The cap is checked inside the INSERT so concurrent requests cannot overshoot it.
  const inserted = await run(
    db,
    `INSERT INTO api_keys (id, user_id, name, prefix, key_hash, created_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL) < ?`,
    row.id,
    row.user_id,
    row.name,
    row.prefix,
    row.key_hash,
    row.created_at,
    userId,
    LIMITS.maxApiKeysPerUser,
  );
  if (inserted !== 1) {
    throw new ApiError(
      'conflict',
      `You can have at most ${LIMITS.maxApiKeysPerUser} active API keys. Revoke one to create another.`,
    );
  }
  return { row, secret };
}

/** Active (not revoked) keys, newest first. */
export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKeySummary[]> {
  return all<ApiKeySummary>(
    db,
    `SELECT id, name, prefix, created_at, last_used_at FROM api_keys
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id`,
    userId,
  );
}

/** Returns false when the key does not exist, belongs to someone else or was already revoked. */
export async function revokeApiKey(db: D1Database, userId: string, keyId: string, now: number): Promise<boolean> {
  const changed = await run(
    db,
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    now,
    keyId,
    userId,
  );
  return changed === 1;
}

/**
 * Resolves a presented key to its owner. Strings that cannot be a key are
 * rejected before any database work, so junk Authorization headers cost nothing.
 */
export async function authenticateApiKey(
  db: D1Database,
  presented: string,
  now: number,
): Promise<{ user: UserRow; key: ApiKeyRow } | null> {
  if (!KEY_RE.test(presented)) return null;
  const key = await first<ApiKeyRow>(
    db,
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    await sha256Hex(presented),
  );
  if (!key) return null;
  const user = await getUserById(db, key.user_id);
  if (!user) return null;
  if (key.last_used_at === null || now - key.last_used_at >= LAST_USED_WRITE_INTERVAL_MS) {
    await run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, key.id);
    key.last_used_at = now;
  }
  return { user, key };
}
