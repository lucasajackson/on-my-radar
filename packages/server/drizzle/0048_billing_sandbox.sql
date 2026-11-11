-- Separate provider environments; checkout defaults off until the quota slice is complete.
CREATE TABLE billing_accounts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('sandbox', 'live')),
  PRIMARY KEY (user_id, mode),
  legacy boolean NOT NULL DEFAULT false,
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  subscription_status text,
  paid_through timestamptz,
  cancel_at timestamptz,
  checkout_key uuid NOT NULL DEFAULT gen_random_uuid(),
  checkout_session_id text,
  checkout_url text,
  checkout_expires_at timestamptz,
  last_synced_at timestamptz,
  sync_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  CHECK (customer_id IS NULL OR customer_id ~ '^cus_[A-Za-z0-9]+$'),
  CHECK (subscription_id IS NULL OR subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  CHECK (subscription_id IS NULL OR customer_id IS NOT NULL),
  CHECK ((checkout_url IS NULL) = (checkout_expires_at IS NULL))
);

INSERT INTO billing_accounts(user_id, mode, legacy)
SELECT id, mode, true FROM users CROSS JOIN (VALUES ('sandbox'), ('live')) AS modes(mode)
WHERE state = 'active';

CREATE TABLE billing_events (
  id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('sandbox', 'live')),
  PRIMARY KEY(id, mode),
  type text NOT NULL,
  customer_id text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failed boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id ~ '^evt_[A-Za-z0-9]+$')
);
CREATE INDEX billing_events_due_idx ON billing_events(run_after)
WHERE processed_at IS NULL AND NOT failed;
