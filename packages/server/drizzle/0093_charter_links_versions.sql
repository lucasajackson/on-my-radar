-- Charter links and a readable history (plan e715ea20, slices S5 and S6).
--
-- A version remembers the agent that wrote it (`agent_id`), so "who" is a person, or an agent
-- working for one. Versions already sealed keep a null agent. The agent's deletion clears the
-- column (ON DELETE SET NULL), which is an UPDATE of an immutable row: the trigger below allows
-- exactly that, as it already does for `author_id` and `cause_blip_id`.
--
-- Nothing here reads or rewrites an existing row. Rollback: `ALTER TABLE charter_versions DROP
-- COLUMN agent_id;` plus restoring the 0091 function.

ALTER TABLE charter_versions ADD COLUMN agent_id uuid REFERENCES agents (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION charter_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A radar's deletion cascades; nothing else deletes a version.
    IF EXISTS (SELECT 1 FROM radars WHERE id = OLD.radar_id) THEN
      RAISE EXCEPTION 'charter versions are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'cause_blip_id' - 'author_id' - 'agent_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'cause_blip_id' - 'author_id' - 'agent_id')
     OR (NEW.cause_blip_id IS NOT NULL AND NEW.cause_blip_id IS DISTINCT FROM OLD.cause_blip_id)
     OR (NEW.author_id IS NOT NULL AND NEW.author_id IS DISTINCT FROM OLD.author_id)
     OR (NEW.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id) THEN
    RAISE EXCEPTION 'charter versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
