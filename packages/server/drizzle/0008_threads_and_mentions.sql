-- On My Radar — threaded replies, and @mentions.
--
-- Two additive changes, both nullable or new, so this applies to a populated
-- database with no backfill and no rewrite of an existing row.
--
-- ===========================================================================
-- 1. A comment may answer another comment
-- ===========================================================================
--
-- The discussion template makes a blip a *thread* and its comments the replies.
-- A flat list of replies is a chat log; what makes a discussion legible is being
-- able to see that Ben answered Ada rather than answering the thread.
--
-- ## Exactly one level of nesting, and why not more
--
-- Google Wave — which is the thing Lucas asked this template to take a cue
-- from — let a reply be inserted at any point inside any other reply, to
-- arbitrary depth. It is the single most cited reason Wave was incomprehensible:
-- a wave with forty blips in it had no reading order at all, and no two people
-- who opened it saw the same conversation. The cue this design takes from Wave
-- is that a conversation and a document can be the same object. The cue it
-- refuses is arbitrary insertion depth.
--
-- So: **a reply is either on the thread, or on one reply.** `parent_id` is null
-- or points at a comment whose own `parent_id` is null. The service enforces the
-- second half by re-parenting — replying to a reply attaches you to the same
-- sub-thread and names the person you are answering with an @mention, which is
-- exactly what the mention half of this migration is for. The two features are
-- one design: mentions carry the addressing that a third level of indent would
-- otherwise have to carry, and they survive a 390px viewport, which indentation
-- does not.
--
-- The invariant is not expressible as a CHECK (it needs a lookup on the same
-- table), so it lives in `services/comments.ts` and is asserted in
-- `discussion.test.ts`. `ON DELETE SET NULL` below is what keeps it true for
-- free afterwards: a deleted parent promotes its replies to the top level, and
-- a top-level comment trivially satisfies the rule.
--
-- ## ON DELETE SET NULL, not CASCADE
--
-- Deleting a comment must not delete somebody else's answer to it. An owner's
-- moderation power already stops short of the edit ("putting words in somebody's
-- mouth is worse than removing them"); deleting a remark and silently taking
-- three other people's replies with it is the same failure at a larger blast
-- radius. The reply is promoted to the top level of the thread and keeps its own
-- timestamp, so it stays where it was in the reading order.
--
-- This is the same rule as `blips.supersedes_id`, and for the same reason: a
-- reply *references* the comment it answers rather than being a part of it. The
-- aggregate rule in 0001_init.sql — attachments and comments cascade from their
-- blip — still holds one level up.

ALTER TABLE blip_comments
  ADD COLUMN parent_id uuid REFERENCES blip_comments(id) ON DELETE SET NULL;

-- A comment cannot answer itself. The same degenerate case
-- `blips_supersedes_not_self` removes, stated in the same place.
ALTER TABLE blip_comments
  ADD CONSTRAINT blip_comments_parent_not_self CHECK (parent_id <> id);

-- Serves the thread ordering. A thread reads
-- `(root_created_at, root_id, created_at, id)` ascending — the parent's position
-- first, then the reply's own — which is what keeps a nested thread's keyset
-- total: every key runs the same direction and `id` cannot tie. This index is
-- the join side of that, resolving a reply to its parent.
CREATE INDEX blip_comments_parent_idx
  ON blip_comments (parent_id, created_at, id)
  WHERE parent_id IS NOT NULL;

-- ===========================================================================
-- 2. Mentions
-- ===========================================================================
--
-- ## Resolved and stored at write time, not parsed at render time
--
-- The body is stored verbatim — `@ada` stays `@ada`, because the body is the
-- person's own words and it round-trips through `update_blip` over MCP. What is
-- stored *alongside* it is the resolution: which account each token turned out
-- to mean. Three cases decide this, and render-time parsing loses all three:
--
--   * **A user is renamed.** A stored id renders as whatever they are called
--     now. Stored text would print the old name forever.
--   * **An account is deleted.** The row goes with it (ON DELETE CASCADE) and
--     the token degrades to plain text. A render-time parse would keep printing
--     a name that resolves to nobody.
--   * **A comment is edited to add or remove a mention.** With rows there is a
--     diff, so a newly added mention notifies and a mention that was already
--     there does not notify twice. Without rows there is no record of who has
--     already been told, so an edit must either re-notify everybody or nobody.
--
-- ## Resolution can never widen access, by construction
--
-- A token is resolved against **the people who can already read the radar** —
-- its owner, its members, and the members of its topic when that topic cascades.
-- A token naming anybody else does not resolve, and an unresolved token is just
-- text. So there is no code path in which mentioning somebody hands them
-- anything: the set the parser draws from is the set `requireRadar` would let in
-- anyway. Pulling in somebody who cannot read the radar is a *share*, and the
-- composer says so rather than doing it quietly.
--
-- ## One table, not two
--
-- A mention hangs off a blip body or off a comment body, never both, and the
-- CHECK makes that real rather than conventional. One table means one index for
-- "everything that has ever addressed me" and one sweep when access is revoked.
--
-- `radar_id` is denormalised for the same reason `blip_comments.radar_id` and
-- `blip_reactions.radar_id` are: it is the column that scopes and authorizes the
-- row, and re-deriving it through two joins on every read is how a mention ends
-- up stranded on a radar its blip has left.

CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  blip_id uuid REFERENCES blips(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES blip_comments(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a mention of a deleted account means nothing, and a
  -- null here would leave a row that can never be matched to anybody. The words
  -- in the body survive either way — this table is the resolution, not the text.
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mentions_one_source CHECK ((blip_id IS NULL) <> (comment_id IS NULL))
);

-- One row per (source, person), so re-saving a body that mentions Ada twice
-- cannot produce two rows and cannot notify her twice. Partial because the CHECK
-- guarantees exactly one of the two columns is set, so a plain composite unique
-- index over both would be defeated by the null.
CREATE UNIQUE INDEX mentions_blip_user_idx
  ON mentions (blip_id, user_id) WHERE blip_id IS NOT NULL;
CREATE UNIQUE INDEX mentions_comment_user_idx
  ON mentions (comment_id, user_id) WHERE comment_id IS NOT NULL;

-- "What has addressed me lately", and the sweep that runs when somebody's access
-- to a radar is revoked.
CREATE INDEX mentions_user_idx ON mentions (user_id, created_at DESC);
CREATE INDEX mentions_radar_idx ON mentions (radar_id);
