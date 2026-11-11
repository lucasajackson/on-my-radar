-- On My Radar — topics: a container for radars, with its own sharing.
--
-- The ask, in the two blips this implements:
--
--   "I want to be able to create groups of Radars. So, maybe a group is a
--    topic, and a topic has its own RBAC for sharing."
--
--   "I want to ensure that radar permissions don't need to follow topic
--    permissions. Meaning, maybe a topic is shared to a group, but one radar in
--    the topic is only shared to certain members of the group. I think we can
--    have a topic sharing option that forces cascaded permissions to all
--    radars, but that's an option."
--
-- Read the second one carefully, because it decides the whole schema: **sharing
-- a topic does not share the radars in it.** Cascading is an opt-in property of
-- the topic, and even then it is a *computed overlay* — see `cascade` below.
--
-- Everything here is additive and defaulted except one rename, so it applies to
-- a populated database with no backfill: every existing radar gets
-- `topic_id = NULL` and behaves exactly as it did.

-- ------------------------------------------------------------------ topics --

CREATE TABLE topics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  -- The one-line subtitle. Same role as `radars.tagline` below, same name, so
  -- the two entities read the same way.
  tagline       text,
  description   text,
  accent        text NOT NULL DEFAULT 'cobalt',
  glyph         text NOT NULL DEFAULT 'radar',

  -- THE SWITCH. When true, a grant on this topic also grants access to every
  -- radar in it; when false — the default — a topic grant conveys no radar
  -- access whatsoever and the topic is purely an organising device.
  --
  -- This flag is read at authorization time and NEVER materialised into
  -- `radar_members`. That is the single most important decision in this
  -- migration, and it is what makes the switch safe in both directions:
  --
  --   * Turning it ON writes no membership rows, so it cannot overwrite or
  --     clobber a radar's own member list. Effective access becomes the union
  --     of the direct grant and the topic grant — nobody loses anything, and
  --     radars added to the topic later are covered automatically with no
  --     stale state to reconcile.
  --   * Turning it OFF deletes no membership rows, so every direct grant
  --     survives untouched while the cascaded access disappears completely and
  --     immediately. There is nothing left behind to leak.
  --
  -- Materialising the cascade was the obvious alternative and it is worse in
  -- both directions at once: on, it has to choose between overwriting a
  -- radar's member list and merging into it irreversibly; off, it cannot tell
  -- the rows it created from the rows a person added in between, so it either
  -- strips access somebody meant to keep or leaves access somebody meant to
  -- revoke. Same argument as `blips.search` being GENERATED rather than
  -- trigger-maintained: a derived value that is computed cannot drift from
  -- what it is derived from.
  cascade       boolean NOT NULL DEFAULT false,

  position      integer NOT NULL DEFAULT 0,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Owner-scoped, exactly like `radars_owner_slug_key`: two people may both have
-- a topic called "Foundation".
CREATE UNIQUE INDEX topics_owner_slug_key ON topics (owner_id, slug);
CREATE INDEX topics_owner_idx ON topics (owner_id, position) WHERE archived = false;

-- A grant on the topic itself.
--
-- Only 'viewer' and 'editor', unlike `radar_members`. A topic 'owner' grant
-- would let a second person flip `cascade`, which is the widest access change
-- in the application; widening this set later is easy, and narrowing it would
-- mean taking access away from somebody who already had it.
CREATE TABLE topic_members (
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, user_id)
);

-- Leads with user_id: the hot query is "which topics does this person reach",
-- asked on every radar authorization, which the primary key leads the wrong
-- way for.
CREATE INDEX topic_members_user_idx ON topic_members (user_id);

-- A topic share addressed to somebody with no account yet, claimed on first
-- sign-in. Mirrors `radar_invites` exactly.
CREATE TABLE topic_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('viewer', 'editor')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX topic_invites_topic_email_key ON topic_invites (topic_id, email)
  WHERE accepted_at IS NULL;
CREATE INDEX topic_invites_email_idx ON topic_invites (email) WHERE accepted_at IS NULL;

-- ------------------------------------------------------ radars join topics --

-- `topic` was a radar's one-line subtitle long before a topic was a thing you
-- could create. Leaving both would put one word on two meanings inside the most
-- access-sensitive object in the application — "is `topic` the group or the
-- string?" is not a question anybody should have to ask while reading an
-- authorization path. Renamed rather than duplicated.
ALTER TABLE radars RENAME COLUMN topic TO tagline;

-- ON DELETE SET NULL, emphatically not CASCADE. Deleting a topic must never
-- delete the radars inside it, and must never touch their own member lists:
-- the radars simply become topicless and keep working, which is the state every
-- radar in this database is already in.
ALTER TABLE radars
  ADD COLUMN topic_id uuid REFERENCES topics(id) ON DELETE SET NULL;

CREATE INDEX radars_topic_idx ON radars (topic_id) WHERE topic_id IS NOT NULL;

-- Two kinds of radar are never in a topic. Both are enforced here rather than in
-- the service, for the same reason `radars_smart_is_never_public` is: an agent
-- over MCP will try it, and a constraint cannot be forgotten by a new code path.
--
-- The drop box is never in a topic.
--
-- It is the per-account holding bay for things with no home yet — appointments,
-- reminders, "call the plumber" — so filing it under a topic is a category
-- error, and a cascading topic would hand every member of that topic somebody's
-- entire unsorted personal pile from a switch two screens away. That is a
-- privacy failure arriving as a side effect, which is exactly the class of thing
-- the cascade design above exists to avoid.
ALTER TABLE radars
  ADD CONSTRAINT radars_drop_box_is_never_in_a_topic
    CHECK (NOT (is_drop_box = true AND topic_id IS NOT NULL));

-- A smart radar is never in a topic either.
--
-- A smart radar is a saved query, not a container: it owns no blips, and what it
-- resolves to is decided by the *reader's* access to each matching blip's home
-- radar (0002, and `resolveRadarScope`). Putting one in a topic would imply a
-- membership it does not have, and would leave "what does a topic grant mean
-- over a result set spanning radars the grantee cannot read?" as a question with
-- no good answer. The honest answer is that a topic grant must not change what a
-- smart radar resolves at all — so it does not belong in one.
ALTER TABLE radars
  ADD CONSTRAINT radars_smart_is_never_in_a_topic
    CHECK (NOT (kind = 'smart' AND topic_id IS NOT NULL));

-- ------------------------------------------------------------ notifications --

-- The topic kinds ('topic_share', 'topic_cascade') have no radar, so the line
-- needs somewhere to point. CASCADE for the same reason `radar_id` cascades: a
-- deleted topic's access changes are not something anybody can still act on.
ALTER TABLE notifications
  ADD COLUMN topic_id uuid REFERENCES topics(id) ON DELETE CASCADE;

-- Revoking a topic grant deletes that person's notifications for the topic, the
-- same disclosure rule `dropRadarNotifications` already applies: a notification
-- carries a snapshot, so leaving it would hand somebody a readable copy of
-- something they can no longer open.
CREATE INDEX notifications_topic_idx ON notifications (user_id, topic_id)
  WHERE topic_id IS NOT NULL;
