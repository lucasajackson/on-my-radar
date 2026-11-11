-- Blip archiving: how long finished work stays on a radar before it ages out.
--
-- ## One column, and nothing on `blips`
--
-- There is deliberately no `blips.archived_at`. Archived-ness is **computed**
-- from the row's own activity against this window, the way `blips.search` is
-- GENERATED and `lastActivityAt` is a subquery: a derived value that is computed
-- cannot drift from its source, and "commenting on, editing or moving an
-- archived blip brings it back" then needs no event handler at all — the clock
-- *is* the activity. See `packages/contract/src/archive.ts` and DESIGN.md §25.
--
-- That also means this migration writes no blip rows, sweeps nothing, and can be
-- undone with a single `ALTER TABLE radars DROP COLUMN archive_after_days`.
--
-- ## What happens to rows that already exist
--
-- Every radar gets NULL, which means "no opinion — take the default of 30 days".
-- It is not backfilled to 30, because NULL and 30 are different facts: one is
-- the absence of a decision and the other is a decision, and only the first may
-- follow the default if it ever moves.
--
-- The visible consequence, stated rather than discovered: on a **kanban** or
-- **reading list** radar, blips that are `done` or `dropped` and have had
-- nothing happen to them for 30 days stop being loaded and stop being counted.
-- Nothing is deleted, the lane header says how many went, and the count links
-- into the search that shows them. Every other template is untouched, because
-- archiving is opt-in per template in the registry.
--
-- ## Why not jsonb on `template_config`
--
-- `template_config` carries how a radar is *drawn* (day rules, furled lanes).
-- This is a rule about which rows are read at all, it is evaluated inside a
-- WHERE clause on every board read, and it has an invariant worth stating to the
-- database. `(template_config->>'archiveAfterDays')::int` would put a cast that
-- can raise inside the hot path, on a blob nothing constrains.

ALTER TABLE radars
  ADD COLUMN archive_after_days integer;

-- NULL is explicitly legal here and means "take the default"; 0 means never.
-- Stated as `IS NULL OR ...` rather than left to the fact that a CHECK passes on
-- NULL, so the intent is in the schema and not only in whoever wrote it.
ALTER TABLE radars
  ADD CONSTRAINT radars_archive_after_days_range
  CHECK (archive_after_days IS NULL OR (archive_after_days >= 0 AND archive_after_days <= 3650));

-- The archive predicate is `state IN ('done','dropped') AND <clock> + window <= now()`,
-- so the rows it can ever touch are exactly the terminal ones. A partial index on
-- them keeps the check off every live row on a board read.
CREATE INDEX blips_terminal_activity_idx
  ON blips (radar_id, updated_at)
  WHERE state IN ('done', 'dropped');
