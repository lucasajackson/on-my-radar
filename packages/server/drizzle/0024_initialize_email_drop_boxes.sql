-- Reserving a username originally left its bare-address Drop Box unconfigured.
-- Repair missing configuration only. An existing disabled row is a deliberate
-- owner choice and must never be enabled by this migration or a repeated run.
DO $$
DECLARE
  identity_owner uuid;
  inbox_id uuid;
  source_id uuid;
  candidate_slug text;
  attempt integer;
BEGIN
  FOR identity_owner IN SELECT user_id FROM email_capture_identities LOOP
    -- Match the service's user -> radar -> source aggregate lock order.
    PERFORM id FROM users WHERE id = identity_owner FOR UPDATE;
    SELECT id INTO inbox_id FROM radars WHERE owner_id = identity_owner AND is_drop_box;
    IF inbox_id IS NULL THEN
      FOR attempt IN 0..63 LOOP
        candidate_slug := CASE WHEN attempt = 0 THEN 'drop-box'
          WHEN attempt < 50 THEN 'drop-box-' || (attempt + 1)::text
          ELSE 'drop-box-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) END;
        INSERT INTO radars(owner_id, slug, name, tagline, description, accent, glyph, template, is_drop_box)
        VALUES(identity_owner, candidate_slug, 'Drop Box',
          'Anything with no home yet — an agent can sort it later',
          'Freeform capture. Drop appointments, reminders and half-thoughts here, then ask an agent to file them: it can read this radar over MCP and move each blip where it belongs.',
          'slate', 'compass', 'stream', true)
        ON CONFLICT DO NOTHING RETURNING id INTO inbox_id;
        IF inbox_id IS NULL THEN
          SELECT id INTO inbox_id FROM radars WHERE owner_id = identity_owner AND is_drop_box;
        END IF;
        EXIT WHEN inbox_id IS NOT NULL;
      END LOOP;
      IF inbox_id IS NULL THEN RAISE EXCEPTION 'Could not initialize email Drop Box'; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM radar_email_capture WHERE radar_id = inbox_id) THEN CONTINUE; END IF;
    FOR attempt IN 0..63 LOOP
      INSERT INTO radar_email_capture(radar_id, owner_id, alias, enabled, allowed_senders)
      VALUES(inbox_id, identity_owner, 'inbox-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), true, '[]'::jsonb)
      ON CONFLICT DO NOTHING RETURNING radar_id INTO source_id;
      EXIT WHEN source_id IS NOT NULL OR EXISTS (SELECT 1 FROM radar_email_capture WHERE radar_id = inbox_id);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM radar_email_capture WHERE radar_id = inbox_id) THEN
      RAISE EXCEPTION 'Could not initialize email Drop Box source';
    END IF;
  END LOOP;
END $$;
