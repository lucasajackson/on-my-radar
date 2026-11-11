-- Once a helpdesk, never public (docs/HELPDESK.md §6.1; qa-reviewer, slice 2).
--
-- 0042 refuses a public helpdesk. It keys on the *current* template, so it had
-- a hole: switch a helpdesk to a kanban, then publish it, and every internal
-- note and every draft reply on it is served to anybody with the URL. A
-- template switch is a manage act, so a co-owner or an owner's agent could do
-- it in two calls.
--
-- The rule is therefore about the radar's history, not its template: a radar
-- that has ever been client-facing is never public again, whatever it is now.
--
-- ## Why a trigger sets the flag, not the service
--
-- Everything else in this schema is written by the service, and the service
-- also refuses (`setVisibility`, `rotatePublicSlug`, `getRadarAccess`, the
-- public route all read `was_client_facing`). But "the flag was set on every
-- path that can put a radar on the template" is exactly the kind of promise a
-- path written later forgets: `createRadar`, `updateRadar`, and the topic path
-- that applies `updateRadar`'s patch through `setRadarTopic` can all write
-- `template` today. A BEFORE trigger makes the flag a property of the row:
-- it is set whenever `template` is a client-facing id and it can never be
-- cleared, by any statement, psql included. The CHECK below then stands behind
-- every refusal, as 0042 does for the current template.
--
-- The template id is written literally for the reason 0042 gives: SQL cannot
-- read the registry. A test asserts this trigger covers every client-facing
-- template.
--
-- Backfill: every radar on the template now, plus any radar holding a comment
-- that is not internal (only a helpdesk can have one), is marked. No marked
-- radar is public today — 0042 already refused that — so the CHECK validates.

ALTER TABLE radars ADD COLUMN was_client_facing boolean NOT NULL DEFAULT false;

UPDATE radars r
   SET was_client_facing = true
 WHERE r.template = 'helpdesk'
    OR EXISTS (
         SELECT 1 FROM blip_comments c
          WHERE c.radar_id = r.id AND c.visibility <> 'internal'
       );

CREATE FUNCTION omr_radars_once_client_facing() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.template = 'helpdesk' THEN
    NEW.was_client_facing := true;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.was_client_facing THEN
    NEW.was_client_facing := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER radars_once_client_facing
  BEFORE INSERT OR UPDATE ON radars
  FOR EACH ROW EXECUTE FUNCTION omr_radars_once_client_facing();

ALTER TABLE radars
  ADD CONSTRAINT radars_once_client_facing_never_public
    CHECK (NOT (was_client_facing AND visibility = 'public'));
