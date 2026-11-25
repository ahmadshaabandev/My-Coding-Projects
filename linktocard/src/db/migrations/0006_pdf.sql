-- PDF documents: POST /v1/pdf, signed /v1/pdf/... links and the free PDF tools, rendered by
-- Cloudflare Browser Run.
--
-- A stored PDF has a row in `renders` like an image: format 'pdf', width and height 0, source
-- 'api' or 'signed'. The ledger, the daily cleanup of expired files and account deletion
-- therefore treat both alike, and no column is added to `renders` or `usage_periods`.
-- A PDF counts as pdfUnits(pages) images (src/config.ts) and is charged as one block:
-- usage_periods.used (or one top-up's remaining) moves by that many images at once.

-- PDFs charged per account and billing period, and the images they counted as (GET /api/me
-- usage.pdf). Written in the same batch as the charge, so it agrees with usage_periods.
CREATE TABLE pdf_usage (
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  pdfs         INTEGER NOT NULL DEFAULT 0,
  units        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period_start)
);

-- One row per PDF render attempt that reached the browser, successful or not: what Browser
-- Run time costs, per account and source, and the daily alarm (sum of browser_ms over 24 h).
-- Kept PDF.browserUsageRetentionDays days by the daily cleanup. A deleted account's rows stay
-- for the cost totals but lose the account id.
CREATE TABLE browser_usage (
  id         TEXT PRIMARY KEY,                                  -- 'bu_' + random
  user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,     -- NULL for the free tools
  source     TEXT NOT NULL,                                     -- 'api' | 'signed' | 'tool'
  status     INTEGER NOT NULL,                                  -- the browser's HTTP status; 0 when the call failed
  browser_ms INTEGER,                                           -- X-Browser-Ms-Used; NULL when not reported
  wall_ms    INTEGER,                                           -- measured length of the call (counted when browser_ms is NULL)
  pages      INTEGER,                                           -- pages of the returned PDF; NULL without one
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_browser_usage_created ON browser_usage (created_at);
