-- A comment's creator is fixed, like a blip's (collaboration follow-up to C3, ADR-0028; blip f55770d2).
--
-- Editing a comment used to re-stamp its author, agent and voice with the editor, so a person fixing
-- an agent's comment erased the agent's mark. Now the creator never changes and the last editor is
-- recorded beside it, when the words change.
--
-- `blip_comments_keep_author` keeps author_id, agent_id and agent_voice as they were on every UPDATE,
-- silently, so the previous image that still re-stamps them (`authorshipOf` in its `updateComment`) is
-- harmless: its edit succeeds and simply loses that side effect. A referential action nulling a deleted
-- user or agent runs one trigger level down (pg_trigger_depth() > 1) and may still null a column.
-- The editor comes from the transaction-local settings `omr.actor_user` / `omr.actor_agent` that
-- the service sets, as `blips_record_revision` (0095) reads them. A writer that sets neither, the
-- previous image, records no editor: blank, never somebody else's name, and a stale editor is cleared.
--
-- Rolling-safe: the two new columns are nullable and unread by the previous image; the one trigger
-- only restores values the previous image should not have changed. `blip_comments` has no other
-- BEFORE UPDATE trigger that reads author_id or agent_id except `account_closure_writer` (0057),
-- which compares only changed user columns, so the order against it is immaterial.
-- Rollback: DROP TRIGGER blip_comments_keep_author ON blip_comments; DROP FUNCTION
-- blip_comments_keep_author(); then drop the two columns.
ALTER TABLE blip_comments
  ADD COLUMN edited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN edited_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION blip_comments_keep_author() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.author_id := CASE WHEN NEW.author_id IS NULL AND pg_trigger_depth() > 1 THEN NULL ELSE OLD.author_id END;
  NEW.agent_id := CASE WHEN NEW.agent_id IS NULL AND pg_trigger_depth() > 1 THEN NULL ELSE OLD.agent_id END;
  NEW.agent_voice := OLD.agent_voice;
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.edited_by_user_id := NULLIF(current_setting('omr.actor_user', true), '')::uuid;
    NEW.edited_by_agent_id := NULLIF(current_setting('omr.actor_agent', true), '')::uuid;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER blip_comments_keep_author BEFORE UPDATE ON blip_comments
  FOR EACH ROW EXECUTE FUNCTION blip_comments_keep_author();
