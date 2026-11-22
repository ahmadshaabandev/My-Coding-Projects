-- Link To Card - initial schema (Cloudflare D1 / SQLite).
-- All timestamps are Unix epoch MILLISECONDS (INTEGER). All ids are opaque TEXT.
-- Apply with: wrangler d1 migrations apply DB --local | --remote

-- One account per email. No teams/orgs in the MVP.
CREATE TABLE users (
  id                     TEXT PRIMARY KEY,            -- 'u_' + random
  email                  TEXT NOT NULL UNIQUE,        -- lower-cased, trimmed
  created_at             INTEGER NOT NULL,
  -- Entitlement currently in force: 'free' | 'starter' | 'pro'.
  plan                   TEXT NOT NULL DEFAULT 'free',
  suspended_at           INTEGER,                     -- set by the operator to block an abusive account
  suspended_reason       TEXT,
  -- Paddle Billing mirror (written only by the webhook handler).
  paddle_customer_id     TEXT,                        -- ctm_...
  paddle_subscription_id TEXT,                        -- sub_...
  subscription_status    TEXT,                        -- active | trialing | past_due | paused | canceled
  subscription_price_id  TEXT,                        -- pri_...
  period_start           INTEGER,                     -- current paid billing period
  period_end             INTEGER,
  cancel_at              INTEGER,                     -- scheduled cancellation takes effect at (if any)
  subscription_event_at  INTEGER                      -- occurred_at of the newest subscription event applied (ordering guard)
);
CREATE INDEX idx_users_paddle_customer ON users (paddle_customer_id);
CREATE INDEX idx_users_paddle_subscription ON users (paddle_subscription_id);

-- Single-use sign-in links. Only the SHA-256 of the token is stored.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  ip         TEXT
);
CREATE INDEX idx_login_tokens_email ON login_tokens (email, created_at);

-- Browser sessions. Only the SHA-256 of the session id is stored.
CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- API keys for POST /v1/images and GET /v1/usage. Secret shown once; only its SHA-256 is stored.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,                      -- 'k_' + random
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,                         -- first characters of the key, for display
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys (user_id);

-- A "site" is the unit that owns a signing secret for /v1/og signed URLs.
-- The secret is derived (HMAC of SIGNING_MASTER_SECRET, site id, version), never stored.
CREATE TABLE sites (
  id             TEXT PRIMARY KEY,                    -- 's_' + random, appears in public URLs
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  secret_version INTEGER NOT NULL DEFAULT 1,          -- bump to rotate (invalidates every signed URL of the site)
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE INDEX idx_sites_user ON sites (user_id);

-- Customer-authored HTML/CSS templates.
CREATE TABLE templates (
  id         TEXT PRIMARY KEY,                        -- 't_' + random
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  html       TEXT NOT NULL,
  css        TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,              -- bumped on every save; part of the render cache key
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_templates_user ON templates (user_id);

-- Uploaded fonts (paid plans). Bytes live in R2 under r2_key.
CREATE TABLE fonts (
  id         TEXT PRIMARY KEY,                        -- 'f_' + random
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family     TEXT NOT NULL,                           -- name used in CSS font-family
  weight     INTEGER NOT NULL DEFAULT 400,
  style      TEXT NOT NULL DEFAULT 'normal',          -- normal | italic
  format     TEXT NOT NULL,                           -- ttf | otf | woff
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_fonts_user ON fonts (user_id);

-- Usage counter per account per billing period.
-- Free accounts: calendar month (UTC). Paid accounts: the Paddle billing period.
CREATE TABLE usage_periods (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  period_end   INTEGER NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0,            -- images charged to the monthly allowance
  topup_used   INTEGER NOT NULL DEFAULT 0,            -- images charged to top-ups in this period (informational)
  notified_90  INTEGER NOT NULL DEFAULT 0,
  notified_100 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period_start)
);

-- Purchased top-ups (one row per completed Paddle transaction line).
CREATE TABLE topups (
  id                    TEXT PRIMARY KEY,             -- 'tu_' + random
  user_id               TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  paddle_transaction_id TEXT NOT NULL UNIQUE,         -- txn_... (second idempotency guard besides webhook_events)
  images                INTEGER NOT NULL,
  remaining             INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  refunded_at           INTEGER
);
CREATE INDEX idx_topups_user ON topups (user_id, expires_at);

-- Ledger of counted renders. One row per cached image; also de-duplicates
-- concurrent identical requests so the same image is never charged twice
-- while it is cached.
CREATE TABLE renders (
  cache_key    TEXT PRIMARY KEY,                      -- sha256 hex of the canonical render input
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id      TEXT,
  source       TEXT NOT NULL,                         -- 'og' | 'api'
  template     TEXT NOT NULL,                         -- starter id, custom template id, or 'inline'
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  format       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  charged_to   TEXT NOT NULL,                         -- 'plan' | 'topup'
  period_start INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_renders_user ON renders (user_id, created_at);

-- Paddle webhook idempotency + audit trail.
CREATE TABLE webhook_events (
  event_id     TEXT PRIMARY KEY,                      -- evt_...
  event_type   TEXT NOT NULL,
  occurred_at  INTEGER,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  user_id      TEXT,
  result       TEXT                                   -- 'ok' | 'ignored:<reason>' | 'error:<message>'
);
