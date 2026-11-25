-- The free OG checker (/tools/og-checker) and GET /v1/inspect.
--
-- og_checks: one row per uncached check, kept 10 minutes. It is the result cache (looked
-- up by url_key) and the only source of the URLs the image proxy
-- (/api/tools/og-check/{id}/image|favicon) may fetch, so that route never takes a URL.
-- result holds parsed fields and checks only, never the fetched HTML.
CREATE TABLE og_checks (
  id TEXT PRIMARY KEY,
  url_key TEXT NOT NULL,
  result TEXT NOT NULL,
  image_url TEXT,
  favicon_url TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_og_checks_url ON og_checks (url_key, expires_at);
CREATE INDEX idx_og_checks_expires ON og_checks (expires_at);

-- Fixed-window counters: uncached checks per client per hour, inspections per API key
-- per UTC day. bucket names the counter and its window; the daily cleanup removes
-- windows that have ended.
CREATE TABLE tool_usage (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_tool_usage_expires ON tool_usage (expires_at);
