-- The plan an account was on when its PDF render reached the browser: 'free', 'starter' or
-- 'pro'; NULL for the free tools (source 'tool') and for rows written before this migration.
-- The automatic brake on the browser time of Free accounts and the free tools
-- (src/pdf/guard.ts) counts a render by this plan, not by the account's plan today, so an
-- account that moves from a paid plan to Free does not bring its paid renders of the last 24
-- hours into the brake. Rows without it are counted by the account's plan today, as before.
ALTER TABLE browser_usage ADD COLUMN plan TEXT;
