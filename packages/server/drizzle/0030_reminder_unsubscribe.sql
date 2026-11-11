-- Keep the due-revision fence after unsubscribe; otherwise retrying Enable can
-- recreate a reminder that already fired. Disabled rows follow blip/user FKs.
ALTER TABLE blip_reminders ADD COLUMN enabled boolean NOT NULL DEFAULT true;
