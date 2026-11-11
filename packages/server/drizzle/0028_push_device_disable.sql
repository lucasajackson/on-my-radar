-- A remote Disconnect must survive an app's next automatic token refresh.
ALTER TABLE push_devices ADD COLUMN disabled_at timestamptz;
ALTER TABLE push_subscriptions ADD COLUMN disabled_at timestamptz;
