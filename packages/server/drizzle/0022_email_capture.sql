-- Email usernames remain reserved for the account lifetime: stale addresses
-- cannot silently begin capturing into a different account.
CREATE TABLE IF NOT EXISTS email_capture_identities (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(username) BETWEEN 3 AND 32)
);
CREATE TABLE IF NOT EXISTS radar_email_capture (
  radar_id uuid PRIMARY KEY REFERENCES radars(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(alias) <= 31),
  enabled boolean NOT NULL DEFAULT false,
  allowed_senders jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_received_at timestamptz,
  last_error text,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 0,
  UNIQUE(owner_id,alias),
  CHECK (jsonb_typeof(allowed_senders) = 'array' AND jsonb_array_length(allowed_senders) <= 25)
);
CREATE TABLE IF NOT EXISTS email_capture_receipts (
  id text PRIMARY KEY,
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  sender text NOT NULL,
  body text NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  blip_id uuid REFERENCES blips(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_capture_receipts_radar_idx ON email_capture_receipts(radar_id,created_at);

CREATE INDEX IF NOT EXISTS email_capture_receipts_pending_idx ON email_capture_receipts(created_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS email_capture_receipts_completed_idx ON email_capture_receipts(completed_at) WHERE completed_at IS NOT NULL;
