-- Agent identity is distinct from the human cosigner; never infer historical
-- voices from actor_ids. Older writers remain valid during rolling releases:
-- they increment count but not attributed_event_count, including when they fold
-- into a row created by the new writer. The difference counts unknown events,
-- not participants. Defaults classify all existing and old-inserted rows as unknown.
CREATE FUNCTION omr_notification_actor_keys_valid(keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE key text; seen text[] := ARRAY[]::text[];
BEGIN
  IF cardinality(keys) > 8 OR COALESCE(array_ndims(keys), 1) <> 1 THEN RETURN false; END IF;
  FOREACH key IN ARRAY keys LOOP
    IF key IS NULL OR key !~ '^(human|agent):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR key = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, key);
  END LOOP;
  RETURN true;
END $$;

ALTER TABLE notifications
  ADD COLUMN actor_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN attributed_event_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT notifications_principals_valid CHECK (
    omr_notification_actor_keys_valid(actor_keys)
    AND attributed_event_count >= 0 AND attributed_event_count <= count
    AND ((attributed_event_count = 0 AND cardinality(actor_keys) = 0)
      OR (attributed_event_count > 0 AND cardinality(actor_keys) > 0))
  );
