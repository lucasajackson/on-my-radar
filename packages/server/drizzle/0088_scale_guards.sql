-- Scale guards for many agents on many replicas. Additive only: three new tables and
-- nothing touched in the existing ones, so an old pod keeps working beside a new one.
--
-- ## 1. rate_limit_buckets: token buckets shared by every replica
--
-- One row per key (`tok:<user>:<connection>` for a bearer credential, `usr:<user>`
-- for the person behind it). `tokens` is the balance at `refilled_at`; a charge
-- refills by elapsed time, clamps to the burst and subtracts in one statement
-- (services/rate-limit.ts), so two replicas cannot both spend the same token.
-- `granted` is how many the last charge actually handed out, kept on the row so
-- the same statement can report it (RETURNING sees only the new row).
--
-- UNLOGGED: no WAL for a table written on nearly every request. A crash empties it,
-- and an empty bucket is a full one, which is the right failure for a limiter.
-- fillfactor leaves room for HOT updates, and autovacuum is told to look at this
-- small, hot table long before the 20% default would.
CREATE UNLOGGED TABLE rate_limit_buckets (
  key         text PRIMARY KEY,
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT now(),
  granted     integer NOT NULL DEFAULT 0
) WITH (fillfactor = 50, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 200);

-- Swept by the worker once a bucket has sat untouched long enough to be full anyway.
CREATE INDEX rate_limit_buckets_refilled_at ON rate_limit_buckets (refilled_at);

-- ## 2. request_idempotency: Idempotency-Key for blip and comment creation
--
-- Keyed by who is calling (the person and, for a bearer credential, the connection:
-- a PAT id, or an OAuth client id, never the access-token row that rotates on
-- refresh) and the key they chose. `request_sha256` binds the key to one request so
-- reusing it for a different one is a 409 instead of a silent replay. Written in the
-- same transaction as the blip or comment, so there is never a key without its
-- resource or a resource without its key. Entries expire after 24 hours
-- (the worker deletes them; a lookup also ignores an expired one).
CREATE TABLE request_idempotency (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  actor_key      text NOT NULL,
  key            text NOT NULL,
  scope          text NOT NULL,
  request_sha256 text NOT NULL,
  resource_id    uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, actor_key, key)
);

CREATE INDEX request_idempotency_created_at ON request_idempotency (created_at);

-- ## 3. email_relay_nonces: the inbound-email replay cache, out of process memory
--
-- The relay mints a fresh nonce per attempt, so a nonce seen twice inside its signature
-- window is a replay. With more than one API replica an in-memory set cannot know what
-- another pod saw. `INSERT ... ON CONFLICT` makes the database the arbiter.
CREATE TABLE email_relay_nonces (
  nonce      text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE INDEX email_relay_nonces_expires_at ON email_relay_nonces (expires_at);
