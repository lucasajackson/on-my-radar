-- The name an integration replies to clients as no longer defaults to one operator's brand: a new
-- integration that does not name its staff is signed "Support". Existing rows keep what they hold.
--
-- Rolling-safe: a default change only, no row is touched, and the previous image never names the
-- column on insert unless the owner supplied one. Re-runnable.
-- Rollback: ALTER TABLE integrations ALTER COLUMN staff_display_name SET DEFAULT with the value 0045 set.
ALTER TABLE integrations ALTER COLUMN staff_display_name SET DEFAULT 'Support';
