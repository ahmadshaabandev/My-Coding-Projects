-- The daily cleanup reads expired renders in passes of 500, and the sign-in route
-- counts one client's sign-in emails of the last hour. Both scanned their table.
CREATE INDEX idx_renders_expires ON renders (expires_at);
CREATE INDEX idx_login_tokens_ip ON login_tokens (ip, created_at);
