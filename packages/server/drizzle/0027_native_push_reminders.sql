ALTER TABLE blips ADD COLUMN due_at timestamptz,
  ADD COLUMN due_revision integer NOT NULL DEFAULT 0 CHECK (due_revision >= 0);
ALTER TABLE user_notification_settings
  ADD COLUMN preview_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN kind_preferences jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(kind_preferences) = 'object');
ALTER TABLE push_subscriptions
  ADD COLUMN session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  ADD COLUMN registered_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions(session_id);
CREATE TABLE push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform = 'apns'),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  token text NOT NULL CHECK (length(token) BETWEEN 32 AND 512),
  token_hash text NOT NULL,
  installation_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  label text, created_at timestamptz NOT NULL DEFAULT now(),
  registered_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
  CONSTRAINT push_devices_token_key UNIQUE(platform,environment,token_hash),
  CONSTRAINT push_devices_installation_key UNIQUE(platform,environment,installation_id)
);
CREATE INDEX push_devices_user_idx ON push_devices(user_id);
CREATE INDEX push_devices_session_idx ON push_devices(session_id);
CREATE TABLE push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  destination_kind text NOT NULL CHECK (destination_kind IN ('web','apns')),
  destination_id uuid NOT NULL, generation integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','cancelled','failed')),
  expires_at timestamptz NOT NULL, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CONSTRAINT push_deliveries_target_key UNIQUE(notification_id,destination_kind,destination_id,generation)
);
CREATE INDEX push_deliveries_retention_idx ON push_deliveries(expires_at) WHERE state <> 'pending';
CREATE TABLE blip_reminders (
  blip_id uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_minutes integer NOT NULL CHECK (lead_minutes IN (0,60,1440)),
  reminder_at timestamptz, revision integer NOT NULL,
  triggered_at timestamptz, queued_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(blip_id,user_id)
);
CREATE INDEX blip_reminders_due_idx ON blip_reminders(reminder_at,blip_id)
  WHERE queued_at IS NULL AND reminder_at IS NOT NULL;

CREATE INDEX outbox_push_delivery_idx ON outbox ((payload->>'deliveryId')) WHERE kind='push';
