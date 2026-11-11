CREATE TABLE radar_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL,
  secret_ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_subscriptions_radar_idx ON radar_subscriptions(radar_id);
CREATE TABLE subscription_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES radar_subscriptions(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_deliveries_due_idx ON subscription_deliveries(run_after);
CREATE TABLE subscription_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES radar_subscriptions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event text NOT NULL,
  attempt integer NOT NULL,
  status integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_attempts_history_idx ON subscription_attempts(subscription_id, created_at DESC, id DESC);
CREATE INDEX blips_radar_updated_idx ON blips(radar_id, updated_at, id);
