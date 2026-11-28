-- AI images (src/ai): covers (Tool 1), bulk covers (Tool 2) and QR codes on an AI background (Tool 3).
-- Additive only: new tables, nothing existing is changed. The spend counters (estimated neurons per
-- UTC day), the per-client and per-account daily counts and the once-a-day budget alerts are
-- tool_usage rows (0005_og_checks.sql), like the other fixed-window counters.
--
-- Charges are the existing ledger: a final cover or paid QR code is one `renders` row (cache_key =
-- the asset id, r2_key under ai/, template 'ai-cover' or 'ai-qr') charged by src/lib/quota.ts like
-- any image. The R2 object of an AI image belongs to its ai_assets row, not to that ledger row: the
-- daily cleanup deletes ai/ objects only through ai_assets (src/lib/cleanup.ts).

-- Every AI file in R2 (keys under ai/). owner_id is NULL for the free previews (no account) and the
-- backgrounds behind them. expires_at NULL: kept until the owner deletes it or the account goes
-- (final covers and QR codes, which pages link to). Uploads, backgrounds and free previews expire
-- (AI.uploadTtlMs, AI.backgroundTtlMs, AI.freePreviewTtlMs) and the daily cleanup deletes the row
-- and the object. Only 'preview', 'cover', 'qr' and 'qr_svg' are served (/i/ai/{id}.{ext}); the id
-- (64 hex characters, random) is the capability, as the cache key is for /i/{user}/{key}.
CREATE TABLE ai_assets (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('logo', 'reference', 'background', 'preview', 'cover', 'qr', 'qr_svg')),
  r2_key       TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/svg+xml')),
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  -- The background a preview, cover or QR image was drawn on; for 'qr_svg' the 'qr' image it belongs to.
  parent_id    TEXT,
  -- What made it (JSON): tool, style, motif, layout, palette, size, model, attempts, estimated neurons,
  -- the QR attempt that verified. Never the title, description or URL of a page.
  meta         TEXT NOT NULL DEFAULT '{}',
  credits_used INTEGER NOT NULL DEFAULT 0,
  charged_to   TEXT CHECK (charged_to IN ('plan', 'topup')),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER
);
CREATE INDEX idx_ai_assets_owner ON ai_assets (owner_id, created_at);
CREATE INDEX idx_ai_assets_expires ON ai_assets (expires_at) WHERE expires_at IS NOT NULL;

-- Brand presets (Tool 2), at most 20 per account. Filled in by the next build step; final covers
-- already read one by preset_id (its fields fill in what the request leaves out).
CREATE TABLE ai_presets (
  id            TEXT PRIMARY KEY,                                   -- 'aip_' + random
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  style         TEXT NOT NULL,
  palette       TEXT NOT NULL DEFAULT '[]',                         -- JSON array of #rrggbb
  motif         TEXT NOT NULL DEFAULT 'auto',                       -- a motif id, or 'auto'
  layout        TEXT NOT NULL DEFAULT 'left' CHECK (layout IN ('left', 'center')),
  size          TEXT NOT NULL DEFAULT 'cover' CHECK (size IN ('cover', 'header')),
  logo_id       TEXT REFERENCES ai_assets (id) ON DELETE SET NULL,
  reference_ids TEXT NOT NULL DEFAULT '[]',                         -- JSON array of ai_assets ids (kind 'reference')
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_ai_presets_user ON ai_presets (user_id, created_at);

-- Bulk covers (Tool 2): one job per feed, CSV or JSON list, one cover per item through the existing
-- bulk-documents queue. Created now, filled in by the next build step.
CREATE TABLE ai_batches (
  id            TEXT PRIMARY KEY,                                   -- 'aib_' + random
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  preset_id     TEXT REFERENCES ai_presets (id) ON DELETE SET NULL,
  preset        TEXT NOT NULL,                                      -- JSON copy of the preset when accepted
  source        TEXT NOT NULL CHECK (source IN ('rss', 'csv', 'items')),
  source_url    TEXT,                                               -- the feed URL for 'rss'
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'done', 'partial', 'failed', 'cancelled')),
  paused_reason TEXT,                                               -- an error code, e.g. ai_credits_required
  total         INTEGER NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  credits_used  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  notified_at   INTEGER                                             -- the "finished" email was sent
);
CREATE INDEX idx_ai_batches_user ON ai_batches (user_id, created_at);
CREATE INDEX idx_ai_batches_unfinished ON ai_batches (user_id, created_at) WHERE finished_at IS NULL;

CREATE TABLE ai_batch_items (
  batch_id     TEXT NOT NULL REFERENCES ai_batches (id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,                                    -- position in the source, 0-based
  status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  title        TEXT NOT NULL,
  description  TEXT,
  url          TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   INTEGER,
  asset_id     TEXT REFERENCES ai_assets (id) ON DELETE SET NULL,  -- the finished cover
  credits_used INTEGER,
  error_code   TEXT,
  updated_at   INTEGER,
  PRIMARY KEY (batch_id, idx)
);

-- Our own blocklist of QR targets: a listed host also blocks every subdomain of it. Filled by the
-- operator (npx wrangler d1 execute ... "INSERT INTO ai_url_blocklist ...").
CREATE TABLE ai_url_blocklist (
  host       TEXT PRIMARY KEY,                                      -- lower case, no trailing dot
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Refused QR targets (kind 'refusal', reason = the url_refused reason) and public abuse reports
-- (kind 'report'). No IP address is stored. Kept AI.abuse.retentionDays.
CREATE TABLE ai_abuse_log (
  id         TEXT PRIMARY KEY,                                      -- 'abu_' + random
  kind       TEXT NOT NULL CHECK (kind IN ('refusal', 'report')),
  target     TEXT NOT NULL,                                         -- the URL, or an asset id or image URL
  reason     TEXT NOT NULL,
  email      TEXT,                                                  -- a reporter's address, when given
  user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_abuse_log_created ON ai_abuse_log (created_at);
