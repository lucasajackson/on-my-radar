-- Comment visibility on helpdesk radars (docs/HELPDESK.md §7, slice 2).
--
-- A helpdesk comment is either an internal note (the default, and every row
-- that existed before this migration), a reply waiting for the radar owner's
-- review, or a reply the client may see. Clients cannot see anything yet: the
-- integration that reads the client side arrives in slice 3, so `client` is a
-- label until then. Every rule it has is enforced now anyway, so slice 3 adds a
-- reader and no new guarantees.
--
-- ## The three CHECKs, and why each one keys only on values on the row
--
-- 1. `client` exactly when something put it there: a hash-matched release
--    (`released_at`) or, from slice 3, a client's own words through the portal
--    (`external_author`). Nothing else can make a comment client-visible, and a
--    pending or internal comment can carry neither.
-- 2. A release always records the hash of the text that was approved.
-- 3. **A released body always hashes to what was approved.** This is the
--    content binding (§7.2) held by the database rather than by a service rule:
--    `sha256()` is a pure function of the row, so an edit to a released
--    comment's body — by `updateComment`, by a future code path, or by hand in
--    psql — violates the constraint and aborts. The service refuses first with a
--    sentence; this is what stands behind it.
--
-- None of them reads a foreign-key column. `released_by` is `ON DELETE SET
-- NULL`, so a CHECK keyed on it would abort the deletion of the person who
-- released a reply (§7.1, qa-reviewer's finding on rev 2). `released_at`,
-- `released_body_sha256` and `external_author` are values, and no cascade can
-- falsify them.
--
-- ## Why `released_by` is DEFERRABLE INITIALLY DEFERRED
--
-- The authorship-FK trap recorded in 0015: deleting one person fires `SET NULL`
-- on `author_id` and on `released_by` against the same comment row whenever they
-- released a reply they also wrote, or one their own agent drafted. Two
-- referential actions on one tuple need the check queued to COMMIT.
--
-- ## What is deliberately not here
--
-- `integration_id` (§7.1) references `integrations`, which slice 3 creates. It
-- is added there, with the table. `external_author` is added now, unwritten, so
-- that CHECK 1 has its final shape and slice 3 does not have to drop and
-- recreate it.
--
-- Every existing row backfills to `internal`, which is correct: no client has
-- ever seen any of them.

ALTER TABLE blip_comments
  ADD COLUMN visibility           text NOT NULL DEFAULT 'internal',
  ADD COLUMN released_by          uuid REFERENCES users(id)
                                       ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN released_at          timestamptz,
  ADD COLUMN released_body_sha256 text,
  ADD COLUMN external_author      jsonb;

ALTER TABLE blip_comments
  ADD CONSTRAINT blip_comments_visibility_valid
    CHECK (visibility IN ('internal', 'client_pending', 'client')),
  ADD CONSTRAINT blip_comments_client_was_released
    CHECK ((visibility = 'client') = (released_at IS NOT NULL OR external_author IS NOT NULL)),
  ADD CONSTRAINT blip_comments_release_records_hash
    CHECK (released_at IS NULL OR released_body_sha256 IS NOT NULL),
  ADD CONSTRAINT blip_comments_released_body_unchanged
    CHECK (
      released_body_sha256 IS NULL
      OR released_body_sha256 = encode(sha256(convert_to(body, 'UTF8')), 'hex')
    );

-- The owner's review queue: replies waiting for a release, per radar.
CREATE INDEX blip_comments_pending_idx ON blip_comments (radar_id, created_at)
  WHERE visibility = 'client_pending';
