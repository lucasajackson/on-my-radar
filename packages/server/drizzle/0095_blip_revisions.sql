-- Blip edit history, and a creator that cannot be overwritten (collaboration slice C3, ADR-0028).
--
-- A person editing an agent's card used to erase the agent's authorship and leave no record. Now the
-- creator is fixed for good and each change to the words or the lane is logged with who made it.
--
-- `blip_revisions` gets one row per UPDATE that changes title, body, status or radar (a claim
-- renewal, a pin or a tag change writes nothing). `revision` is the number the change produced,
-- so rows join the `blips.revision` counter (0094). The prior body is kept only when the body
-- changed (and not on a move); the prior title likewise. A radar change deletes the blip's earlier rows, so the log restarts at the move. The editor comes from the transaction-local settings
-- `omr.actor_user` / `omr.actor_agent` that the service sets; a writer that sets neither records no
-- editor, which is blank rather than wrong. Retention: the newest 25 rows per blip, plus the newest
-- row that edited the words and the newest that moved the card, so "edited by" and "moved by"
-- survive a busy card.
--
-- Rolling-safe: nothing here is read by the previous image. Its UPDATE that still re-stamps
-- author, agent and voice is kept to the original by `blips_keep_author` without being refused, so
-- an old pod keeps working and simply loses that side effect.
-- Rollback: DROP TRIGGER blips_keep_author / blips_record_revision ON blips; DROP the two functions
-- and the table.
CREATE TABLE blip_revisions (
  blip_id uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  -- SET NULL and deferred, like every authorship FK (deleting one person fires several actions).
  editor_user_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  editor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  changed text[] NOT NULL,
  prior_title text,
  prior_body text,
  PRIMARY KEY (blip_id, revision)
);
CREATE INDEX blip_revisions_editor_user_idx ON blip_revisions (editor_user_id) WHERE editor_user_id IS NOT NULL;
CREATE INDEX blip_revisions_editor_agent_idx ON blip_revisions (editor_agent_id) WHERE editor_agent_id IS NOT NULL;

CREATE FUNCTION blips_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fields text[] := ARRAY[]::text[]; moved boolean;
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN fields := array_append(fields, 'title'); END IF;
  IF NEW.body IS DISTINCT FROM OLD.body THEN fields := array_append(fields, 'body'); END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN fields := array_append(fields, 'status'); END IF;
  IF NEW.radar_id IS DISTINCT FROM OLD.radar_id THEN fields := array_append(fields, 'radar'); END IF;
  IF cardinality(fields) = 0 THEN RETURN NULL; END IF;
  -- History never crosses a radar boundary: what the card said and who edited it belong to the
  -- radar it left. A move deletes the earlier rows, and its own row records only who moved it.
  moved := 'radar' = ANY (fields);
  IF moved THEN DELETE FROM blip_revisions WHERE blip_id = NEW.id; END IF;
  INSERT INTO blip_revisions (blip_id, revision, editor_user_id, editor_agent_id, changed, prior_title, prior_body)
  VALUES (
    NEW.id, NEW.revision,
    NULLIF(current_setting('omr.actor_user', true), '')::uuid,
    NULLIF(current_setting('omr.actor_agent', true), '')::uuid,
    fields, CASE WHEN NOT moved THEN OLD.title END,
    CASE WHEN 'body' = ANY (fields) AND NOT moved THEN OLD.body END
  );
  DELETE FROM blip_revisions
  WHERE blip_id = NEW.id AND revision NOT IN (
    (SELECT revision FROM blip_revisions WHERE blip_id = NEW.id ORDER BY revision DESC LIMIT 25)
    UNION (SELECT revision FROM blip_revisions WHERE blip_id = NEW.id AND changed && ARRAY['title', 'body']
           ORDER BY revision DESC LIMIT 1)
    UNION (SELECT revision FROM blip_revisions WHERE blip_id = NEW.id AND changed && ARRAY['status', 'radar']
           ORDER BY revision DESC LIMIT 1)
  );
  RETURN NULL;
END $$;

CREATE TRIGGER blips_record_revision AFTER UPDATE ON blips
  FOR EACH ROW EXECUTE FUNCTION blips_record_revision();

-- The creator never changes. Named to sort before `charter_page_fence_update` (0091), which compares
-- author and agent with the old row: it must see them already restored. It does not refuse (an
-- old pod's edit still succeeds). A referential action nulling a deleted user or agent runs one
-- trigger level down, and may still null a column; `omr.blip_reauthor` is the escape for a test or
-- a repair that really means to re-seat a card.
CREATE FUNCTION blips_keep_author() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('omr.blip_reauthor', true) = 'on' THEN RETURN NEW; END IF;
  NEW.author_id := CASE WHEN NEW.author_id IS NULL AND pg_trigger_depth() > 1 THEN NULL ELSE OLD.author_id END;
  NEW.agent_id := CASE WHEN NEW.agent_id IS NULL AND pg_trigger_depth() > 1 THEN NULL ELSE OLD.agent_id END;
  NEW.agent_voice := OLD.agent_voice;
  RETURN NEW;
END $$;

CREATE TRIGGER blips_keep_author BEFORE UPDATE ON blips
  FOR EACH ROW EXECUTE FUNCTION blips_keep_author();
