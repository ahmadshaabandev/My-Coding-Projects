-- Bulk documents from a spreadsheet (POST /v1/batches) and certificate verification (GET /v/{id}).
--
-- A batch is one template and up to BATCH.maxRows[plan] rows of data; each row becomes one PDF,
-- rendered and charged exactly like POST /v1/pdf by the queue consumer (src/batch/consumer.ts).
-- The PDFs themselves are ordinary stored PDFs (`renders` ledger rows, R2 objects under r/), so
-- the daily cleanup and account deletion already remove them; a batch row only points at one by
-- its cache key. Nothing here depends on migration 0006 or later changes to `browser_usage`.
--
-- All three tables cascade from users, so deleting an account removes its batches, their rows
-- and its certificate records. Certificates do not cascade from batches: a record outlives the
-- batch that made it (kept until revoked + BATCH.revokedRetentionDays, src/batch/certificates.ts).

-- One row per batch. `status` moves queued -> running -> done | partial | failed, or to
-- cancelled from queued or running; finished_at is set once no row is queued or running.
CREATE TABLE batches (
  id               TEXT PRIMARY KEY,                                -- 'bat_' + random
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'partial', 'failed', 'cancelled')),
  template         TEXT NOT NULL,                                   -- PDF starter id or the account's template id
  template_version INTEGER,                                         -- the custom template's version when accepted; NULL for starters
  pdf_options      TEXT NOT NULL DEFAULT '{}',                      -- JSON {"format", "landscape"} as requested (null = template default)
  verify           INTEGER NOT NULL DEFAULT 0,                      -- 1: every row has a certificate record
  total            INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,                                         -- first row claimed
  finished_at      INTEGER,
  cancelled_at     INTEGER,
  -- When the newest PDF of the batch expires (raised as rows finish); a finished batch is
  -- deleted by the daily cleanup after it, when none of its download links work any more.
  expires_at       INTEGER NOT NULL
);
-- GET /v1/batches (newest first per account).
CREATE INDEX idx_batches_user ON batches (user_id, created_at);
-- The active-batch cap (queued and running batches are always unfinished) and the daily sweep
-- of batches whose rows were never all processed: only unfinished batches are in this index,
-- a handful per account.
CREATE INDEX idx_batches_unfinished ON batches (user_id, created_at) WHERE finished_at IS NULL;
-- The daily cleanup of finished batches.
CREATE INDEX idx_batches_expires ON batches (expires_at) WHERE finished_at IS NOT NULL;

-- One row per document of a batch. `idx` is the row's position in the request (0-based); the
-- ZIP and every listing are ordered by it, never by queue delivery order (best effort only).
-- `attempts` counts claims: each claim adds one, and only the consumer holding the claim with
-- that number may finish the row, so a redelivered queue message never renders a row twice
-- while it is being worked on, and never again once it is done.
CREATE TABLE batch_rows (
  batch_id       TEXT NOT NULL REFERENCES batches (id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  data           TEXT NOT NULL,                                     -- JSON of the validated row (without the verification fields)
  filename       TEXT NOT NULL,                                     -- download and ZIP entry name, ASCII, ends in .pdf
  certificate_id TEXT,                                              -- 'crt_...' when the batch verifies
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_at     INTEGER,                                           -- set while running
  cache_key      TEXT,                                              -- the stored PDF (renders.cache_key) once done
  pages          INTEGER,
  credits_used   INTEGER,                                           -- images charged for this row (0 when an identical PDF was stored already)
  bytes          INTEGER,
  pdf_expires_at INTEGER,
  error_code     TEXT,                                              -- the last failure (an API error code), also while queued for a retry
  error_message  TEXT,
  finished_at    INTEGER,
  PRIMARY KEY (batch_id, idx)
);
-- Counts per status and "is anything still queued or running" for one batch.
CREATE INDEX idx_batch_rows_status ON batch_rows (batch_id, status);

-- Certificate verification records; the shape src/batch/certificates.ts expects. A batch row's
-- record is written when its PDF is made (src/batch/store.ts completeRow), never for a row that
-- failed or was cancelled.
CREATE TABLE certificates (
  id             TEXT PRIMARY KEY,                                  -- 'crt_' + 20 base32
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  batch_id       TEXT,                                              -- no cascade: records outlive batches
  row_index      INTEGER,
  recipient_name TEXT,
  title          TEXT,
  achievement    TEXT,
  issuer_name    TEXT,
  document_date  TEXT,                                              -- the row's "date", as written
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX idx_certificates_user ON certificates (user_id, created_at);
CREATE INDEX idx_certificates_batch ON certificates (batch_id);
CREATE INDEX idx_certificates_revoked ON certificates (revoked_at) WHERE revoked_at IS NOT NULL;
