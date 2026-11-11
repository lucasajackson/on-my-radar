-- On My Radar — notifications.
--
-- Everything here is additive and defaulted, so it applies to a populated
-- database without a backfill. No existing account gets a row in either
-- settings table: absence *is* the default, which is what makes this safe to
-- deploy without touching a single existing user.
--
-- The design question that had to be answered before the schema, not after, is
-- coalescing: ten reactions on one blip must be one notification, not ten. The
-- answer is a **group key plus a partial unique index**, so the folding is
-- decided by the database rather than by a read-then-write in the service that
-- two concurrent events could interleave inside. Same argument as the
-- `(blip_id, user_id, reaction)` primary key in 0003.

-- ---------------------------------------------------------- notifications --

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The recipient. Everything here is per-person: two people looking at the
  -- same comment get two rows, because they may read them at different times.
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Unconstrained on purpose, like `blips.status` and `blip_reactions.reaction`:
  -- the closed set lives in contract/src/domain.ts, so adding a kind is one line
  -- and no migration. A stored kind the registry no longer knows degrades to a
  -- neutral line rather than breaking the list.
  kind        text NOT NULL,

  -- Which radar this happened on. CASCADE because a deleted radar's activity is
  -- not something anybody can still act on.
  radar_id    uuid REFERENCES radars(id) ON DELETE CASCADE,

  -- SET NULL, not CASCADE. A `blip` notification carries a whole *group* of
  -- blips (see the group key below), so cascading one deleted blip would take
  -- the other eleven with it. Null simply means the line stops being a link;
  -- `subject` still says what happened.
  blip_id     uuid REFERENCES blips(id) ON DELETE SET NULL,

  -- What folds together. Deterministic and built by the service:
  --   comment:<blipId>   reaction:<blipId>   share:<radarId>   blip:<radarId>
  -- Two events with the same key land on one row for one recipient.
  group_key   text NOT NULL,

  -- How many events folded in. Never decremented: a reaction taken back does
  -- not un-happen, and a notification is a record of a moment rather than a
  -- live tally of the thing it points at.
  count       integer NOT NULL DEFAULT 1,

  -- Distinct people, most recent first, capped by the service at
  -- NOTIFICATIONS.maxActors. Denormalised rather than a join table because the
  -- only question ever asked of it is "whose names go in this sentence".
  actor_ids   uuid[] NOT NULL DEFAULT '{}',

  -- Snapshots, deliberately. The blip title and the comment body as they were
  -- when this happened, so the line still reads correctly after the blip is
  -- edited or deleted. Re-joining live would make a notification about a
  -- since-rewritten blip quote words nobody ever reacted to.
  subject     text,
  excerpt     text,

  -- Two states, and they are genuinely different questions.
  --   seen_at  — has this been *displayed*. Bulk-set when the list is opened.
  --              Drives the ping, never the badge.
  --   read_at  — has this been *dealt with*. Drives the badge, and closes the
  --              coalescing window below.
  seen_at     timestamptz,
  read_at     timestamptz,

  -- Transport bookkeeping, so a redelivery is impossible and a failure is
  -- visible. Both are set fire-and-forget: a notification that could not be
  -- emailed is still a notification.
  emailed_at  timestamptz,
  pushed_at   timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  -- When the most recent event folded into this one landed.
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- THE COALESCING RULE. One open notification per (person, group key); once it
-- has been read the window closes and the next event starts a fresh row, which
-- is exactly the semantics a person expects — "you already dealt with that one,
-- this is new". The service upserts against this index with
-- `ON CONFLICT (user_id, group_key) WHERE read_at IS NULL`, so folding is one
-- atomic statement with no gap between deciding and writing.
CREATE UNIQUE INDEX notifications_open_group_key
  ON notifications (user_id, group_key)
  WHERE read_at IS NULL;

-- The stream, newest first. Keyset-paginated on `(created_at, id)` with a
-- row-value comparison matching the ORDER BY exactly — the same total-cursor
-- rule as the blip stream (the "a cursor must be total" rule in
-- docs/DESIGN.md — cited by name, because a section number in a file that can
-- never be edited again is a reference that rots). Note this sorts by created_at
-- and NOT by updated_at: `updated_at` moves when a row folds, and a mutable
-- sort key makes the keyset non-total, which would let a notification be
-- duplicated or skipped mid-scroll. A folded event therefore grows the count in
-- place rather than resurfacing the row, which is the conservative trade.
CREATE INDEX notifications_user_idx
  ON notifications (user_id, created_at DESC, id DESC);

-- The sidebar badges: unread counts grouped by radar, for one person. Partial,
-- because read notifications are the overwhelming majority over time and none
-- of them can ever answer this query.
CREATE INDEX notifications_unread_idx
  ON notifications (user_id, radar_id)
  WHERE read_at IS NULL;

-- The retention sweep at boot deletes read rows older than
-- NOTIFICATIONS.retentionDays.
CREATE INDEX notifications_read_at_idx
  ON notifications (read_at)
  WHERE read_at IS NOT NULL;

-- ------------------------------------------------ per-account preferences --

-- Absence is the default: no row means email on, push on. Written only when
-- somebody actually changes something, so this table stays roughly the size of
-- "people who have opinions" rather than "people".
CREATE TABLE user_notification_settings (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled  boolean NOT NULL DEFAULT true,
  -- The master switch for push. A device's *subscription* is the other half:
  -- this being true still sends nothing if no browser has subscribed.
  push_enabled   boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------- per-radar, per-person ---

-- This is NOT a column on `radars`, and the distinction is the whole reason the
-- table exists. `comments_enabled` and `reactions_enabled` are properties of the
-- radar — the owner decides for everybody. How loud a radar is, is a property of
-- one person's relationship to it: a noisy shared radar has to be muteable by
-- the one person it is drowning, without going silent for everyone else.
--
-- `level` is unconstrained here for the same reason `kind` above is.
CREATE TABLE radar_notification_prefs (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  level       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, radar_id)
);

-- Fan-out asks "what has everybody chosen for THIS radar" once per event, which
-- the primary key leads the wrong way for.
CREATE INDEX radar_notification_prefs_radar_idx
  ON radar_notification_prefs (radar_id);

-- ------------------------------------------------------ push subscriptions --

-- One row per browser that has granted permission. `p256dh` and `auth` are the
-- device's own keys and are stored as given rather than hashed — unlike every
-- other secret in this application — because they are the inputs to the
-- encryption, not credentials we verify. Losing this table costs nothing worse
-- than everybody re-granting permission.
CREATE TABLE push_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint       text NOT NULL,
  -- A push endpoint can exceed the 2704-byte btree index limit, so uniqueness is
  -- enforced on a hash of it rather than the value. Re-subscribing the same
  -- browser must update the existing row, not accumulate one per page load.
  endpoint_hash  text NOT NULL,
  p256dh         text NOT NULL,
  auth           text NOT NULL,
  label          text,
  -- Consecutive delivery failures. A push service answering 404/410 means the
  -- subscription is gone and the row is deleted immediately; anything else is
  -- counted, and NOTIFICATIONS.pushFailureLimit in a row drops it.
  failure_count  integer NOT NULL DEFAULT 0,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON push_subscriptions (endpoint_hash);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
