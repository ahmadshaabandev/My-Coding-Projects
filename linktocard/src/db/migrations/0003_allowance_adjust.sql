-- A plan change inside one billing period changes the allowance by an amount that
-- follows the money: an upgrade adds the new plan's images only for the part of the
-- period that is left (Paddle prorates the price the same way), and a downgrade
-- keeps the allowance already paid for until the period ends (no credit is given).
-- The period's allowance is the plan's monthly images plus this adjustment.
ALTER TABLE usage_periods ADD COLUMN allowance_adjust INTEGER NOT NULL DEFAULT 0;
