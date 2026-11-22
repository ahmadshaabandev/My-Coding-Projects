-- Set by the operator when a customer asks for their account to be deleted (see
-- GO-LIVE.md "Deleting an account"). The daily cleanup then removes the account's
-- stored images and fonts from R2 and its rows from D1.
ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER;
