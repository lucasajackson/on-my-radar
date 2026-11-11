-- Bound authenticated registration churn without storing device token history.
ALTER TABLE sessions ADD COLUMN push_registration_window timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN push_registration_count integer NOT NULL DEFAULT 0;
