-- Blip revision, assignee and claim (collaboration slice C2, ADR-0028).
--
-- Two agents could grab and overwrite one card with no warning. `revision` lets a writer say "I
-- read r7, refuse me if it moved" (`update_blip.expectedRevision`); the assignee says who owns the
-- card; the claim is a lease (`claimed_until`) that tells other agents to keep off it. A claim is
-- live while `claimed_until > now()`: nothing sweeps, an expired one simply stops counting.
--
-- Rolling-safe. Every new column is nullable or has a constant default, so an old pod's INSERT and
-- UPDATE statements are valid unchanged, and the trigger bumps `revision` for them too (that is the
-- point of a trigger: no writer path can forget). Adding a constant default rewrites nothing.
-- The foreign keys mirror `blips.agent_id`: SET NULL, deferred, because deleting one person fires
-- several referential actions on the same row (0015).
-- Rollback: DROP TRIGGER z_blips_revision ON blips; DROP FUNCTION blips_bump_revision();
-- ALTER TABLE blips DROP COLUMN revision, DROP COLUMN assignee_user_id, ... ; the previous image
-- ignores all of it.
ALTER TABLE blips
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN assignee_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN claimed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN claimed_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN claimed_until timestamptz;

CREATE FUNCTION blips_bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;

-- Named to fire LAST (BEFORE triggers run in name order): `charter_page_fence_update` (0091) compares
-- the whole row, so a revision bumped before it ran would make it refuse the user-deletion SET NULL
-- on a charter page. Anything that compares NEW to OLD must see the row before the bump.
CREATE TRIGGER z_blips_revision BEFORE UPDATE ON blips
  FOR EACH ROW EXECUTE FUNCTION blips_bump_revision();

-- The charter page fence (0091) lets a deleted user or agent null its reference on a page. The new
-- reference columns are the same kind of reference, so a card with an assignee or claim that later
-- moved onto an Architecture radar must not block deleting that agent. Only the exempt list differs.
CREATE OR REPLACE FUNCTION charter_page_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- An update can change the radar: a blip moved into a migrated radar is fenced as well as one
  -- moved out of it.
  rids uuid[] := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.radar_id]
                            WHEN 'DELETE' THEN ARRAY[OLD.radar_id]
                            ELSE ARRAY[OLD.radar_id, NEW.radar_id] END;
BEGIN
  IF current_setting('omr.charter_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM charter_documents WHERE radar_id = ANY(rids)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM radars WHERE id = rids[1]) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     -- `search` is generated after BEFORE triggers run, so NEW does not carry its new value yet.
     AND (to_jsonb(NEW) - 'author_id' - 'agent_id' - 'supersedes_id' - 'search'
          - 'assignee_user_id' - 'assignee_agent_id' - 'claimed_by_user_id' - 'claimed_by_agent_id')
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'author_id' - 'agent_id' - 'supersedes_id' - 'search'
          - 'assignee_user_id' - 'assignee_agent_id' - 'claimed_by_user_id' - 'claimed_by_agent_id')
     AND (NEW.author_id IS NULL OR NEW.author_id IS NOT DISTINCT FROM OLD.author_id)
     AND (NEW.agent_id IS NULL OR NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id)
     AND (NEW.supersedes_id IS NULL OR NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id)
     AND (NEW.assignee_user_id IS NULL OR NEW.assignee_user_id IS NOT DISTINCT FROM OLD.assignee_user_id)
     AND (NEW.assignee_agent_id IS NULL OR NEW.assignee_agent_id IS NOT DISTINCT FROM OLD.assignee_agent_id)
     AND (NEW.claimed_by_user_id IS NULL OR NEW.claimed_by_user_id IS NOT DISTINCT FROM OLD.claimed_by_user_id)
     AND (NEW.claimed_by_agent_id IS NULL OR NEW.claimed_by_agent_id IS NOT DISTINCT FROM OLD.claimed_by_agent_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'this radar''s charter is one document now; its pages are no longer written'
    USING ERRCODE = '55000', HINT = 'Use write_charter (PUT /radars/:id/charter).';
END $$;
