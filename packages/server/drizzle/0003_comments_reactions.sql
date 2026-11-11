-- On My Radar — comments and reactions on blips.
--
-- Everything here is additive and defaulted, so it applies to a populated
-- database without a backfill.
--
-- The authorization story is deliberately *not* new. Both tables are reached
-- through `requireRadar(..., 'read')` plus a real membership role — see
-- `requireParticipation` in services/access.ts. Nothing here grants the public
-- link a write of any kind: `decide()` in that same file says a public link is
-- read-only, always, and adding anonymous writes to the public surface is a
-- security decision to be argued on its own rather than smuggled in behind a
-- feature.

-- ------------------------------------------------- per-radar participation --

-- Two switches rather than one, because they are genuinely different asks: a
-- decision log wants comments and no reactions; a public microblog may want
-- reactions and no thread underneath every post. Both default to true, which
-- is what an existing radar was implicitly doing before either existed.
ALTER TABLE radars
  ADD COLUMN comments_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN reactions_enabled boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------- comments --

CREATE TABLE blip_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blip_id     uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  -- Denormalised from the blip so a comment can be authorized, scoped and
  -- counted without joining blips on every read. Kept in step by the service
  -- when a blip moves radar, and by the CASCADE when a radar is deleted.
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting an account must not silently rewrite a
  -- conversation other people took part in. The comment survives, unattributed,
  -- exactly like a blip whose author was removed.
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The thread is read oldest-first — a conversation, unlike a stream, reads
-- forwards — and this index serves both that ORDER BY and the per-blip count.
CREATE INDEX blip_comments_blip_idx ON blip_comments (blip_id, created_at, id);
CREATE INDEX blip_comments_radar_idx ON blip_comments (radar_id);
CREATE INDEX blip_comments_author_idx ON blip_comments (author_id);

-- --------------------------------------------------------------- reactions --

-- One row per (blip, person, mark). The primary key IS the rule: reacting twice
-- with the same mark cannot produce two rows, so the toggle is decided by the
-- index rather than by a read-then-write in the application that two clicks
-- could interleave inside.
--
-- `reaction` is deliberately NOT constrained here, for the same reason
-- `blips.status` is not: the closed set lives in contract/src/domain.ts and
-- adding a mark must not require a migration. See docs/DESIGN.md §4.
CREATE TABLE blip_reactions (
  blip_id     uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction    text NOT NULL,
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blip_id, user_id, reaction)
);

-- Counting a blip's marks is `GROUP BY reaction` over one blip's rows, which the
-- primary key already leads with. This one serves the "did *I* react" lookup
-- across a whole page of blips in a single scan.
CREATE INDEX blip_reactions_user_idx ON blip_reactions (user_id, blip_id);
CREATE INDEX blip_reactions_radar_idx ON blip_reactions (radar_id);
