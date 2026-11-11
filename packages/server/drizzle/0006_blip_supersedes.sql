-- On My Radar — one blip may replace another.
--
-- Additive and nullable, so it applies to a populated database with no backfill.
--
-- ## Why this is a column and not a lane
--
-- A decision log's lanes already say *what happened* to an entry: proposed,
-- accepted, rejected, superseded. What they cannot say is **what replaced it**,
-- and that is the whole difference between a log and a list. Without the link,
-- "superseded" is a word in a dropdown and the reader is left to work out which
-- of the other forty entries did the superseding.
--
-- ## Why it is on every blip rather than gated to one template
--
-- "This replaced that" is a fact about two blips, not about a template. The
-- column is therefore universal and the *affordance* is registry-gated — the
-- decision log declares `facets: ['supersession']` and gets the control; the
-- stream declares nothing and stays the null template it is meant to be. Gating
-- the storage instead would mean a radar switched off the decisions template
-- silently losing the links, which is data loss dressed up as a setting.
--
-- ## ON DELETE SET NULL, not CASCADE
--
-- Deleting the decision that replaced an older one must not delete the older
-- one. The pointer goes; the record stays. That is the opposite of the rule for
-- attachments and comments, which are *parts of* a blip rather than references
-- to one — see the aggregate rule in 0001_init.sql.

ALTER TABLE blips ADD COLUMN supersedes_id uuid REFERENCES blips(id) ON DELETE SET NULL;

-- Partial, like `blips_radar_status_idx`: almost no blip supersedes anything, and
-- the read this serves is the reverse lookup — "what replaced this one" — done
-- once per page of blips rather than once per blip.
CREATE INDEX blips_supersedes_idx ON blips (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- A blip cannot replace itself. Cheap to state here, and it removes the one
-- degenerate case the reverse lookup would otherwise have to think about.
ALTER TABLE blips ADD CONSTRAINT blips_supersedes_not_self CHECK (supersedes_id <> id);
