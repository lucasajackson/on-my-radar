-- Keep history; returning quota never deletes the physical-key identity.
ALTER TABLE storage_objects DROP CONSTRAINT storage_objects_state_check;
ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_state_check CHECK
  (state IN ('reserved','live','unknown','delete_pending','released','quarantined','migration_source'));
ALTER TABLE storage_objects ADD COLUMN protocol_generation uuid;
ALTER TABLE storage_objects ADD COLUMN tombstone_nonce uuid;
ALTER TABLE storage_objects ADD COLUMN released_at timestamptz;
ALTER TABLE storage_objects ADD COLUMN migrated_to text;
ALTER TABLE storage_objects ADD COLUMN migration_source_etag text;
ALTER TABLE storage_objects ADD COLUMN retired_at timestamptz;
ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_release_check CHECK
  (state <> 'released' OR (protocol_generation IS NOT NULL AND tombstone_nonce IS NOT NULL
   AND released_at IS NOT NULL AND bytes IS NOT NULL));
ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_quarantine_check CHECK
  (state <> 'quarantined' OR (protocol_generation IS NULL AND (migrated_to IS NOT NULL OR retired_at IS NOT NULL)));
CREATE TABLE storage_protocols (
  bucket text NOT NULL,
  generation uuid NOT NULL,
  endpoint_fingerprint text NOT NULL,
  provider_verified_at timestamptz,
  provider_report jsonb,
  baseline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket,generation),
  CHECK (provider_verified_at IS NULL OR provider_report IS NOT NULL),
  CHECK (baseline_at IS NULL OR provider_verified_at IS NOT NULL)
);
CREATE INDEX storage_objects_protocol_idx ON storage_objects(bucket,protocol_generation,state);
-- Once released, ordinary code cannot resurrect a key or erase closure history.
CREATE FUNCTION omr_storage_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage identity is permanent'; END IF;
  IF NEW.bucket IS DISTINCT FROM OLD.bucket OR NEW.object_key IS DISTINCT FROM OLD.object_key THEN
    RAISE EXCEPTION 'storage physical identity is immutable';
  END IF;
  IF OLD.migrated_to IS NOT NULL AND (NEW.migrated_to IS DISTINCT FROM OLD.migrated_to OR NEW.migration_source_etag IS DISTINCT FROM OLD.migration_source_etag) THEN
    RAISE EXCEPTION 'storage migration identity is immutable';
  END IF;
  IF OLD.state='released' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'released storage identity is immutable';
  END IF;
  IF OLD.protocol_generation IS NOT NULL AND NEW.protocol_generation IS DISTINCT FROM OLD.protocol_generation THEN
    RAISE EXCEPTION 'storage writer generation is immutable';
  END IF;
  IF OLD.tombstone_nonce IS NOT NULL AND NEW.tombstone_nonce IS DISTINCT FROM OLD.tombstone_nonce THEN
    RAISE EXCEPTION 'storage closure identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_objects_terminal BEFORE UPDATE OR DELETE ON storage_objects
FOR EACH ROW EXECUTE FUNCTION omr_storage_terminal();

CREATE TABLE storage_inventory_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket text NOT NULL, generation uuid NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','observed','failed')),
  cursor text, error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  CHECK (state <> 'observed' OR (cursor IS NULL AND completed_at IS NOT NULL))
);
CREATE TABLE storage_inventory_objects (
  run_id uuid NOT NULL REFERENCES storage_inventory_runs(id) ON DELETE CASCADE,
  object_key text NOT NULL, bytes bigint NOT NULL CHECK (bytes >= 0 AND bytes <= 9007199254740991),
  etag text NOT NULL, content_type text NOT NULL, closure_nonce text,
  PRIMARY KEY (run_id,object_key)
);

-- A physical key's reference creation and retirement serialize across all writers,
-- including an older application binary. Owner locks always precede key locks.
CREATE FUNCTION omr_storage_reference_lock(object_key text) RETURNS void LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('storage-key:' || object_key,0));
$$;
CREATE FUNCTION omr_storage_assert_reference(object_key text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF object_key IS NULL THEN RETURN; END IF;
  PERFORM omr_storage_reference_lock(object_key);
  IF EXISTS(SELECT 1 FROM storage_objects s WHERE s.object_key=omr_storage_assert_reference.object_key
      AND s.state IN ('released','quarantined','migration_source')) THEN
    RAISE EXCEPTION 'retired storage cannot acquire a new reference';
  END IF;
END $$;
CREATE FUNCTION omr_storage_reference_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF TG_TABLE_NAME='attachments' THEN
    IF TG_OP='INSERT' THEN
      PERFORM omr_storage_assert_reference(NEW.object_key);
    ELSIF NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.blip_id IS DISTINCT FROM OLD.blip_id OR NEW.radar_id IS DISTINCT FROM OLD.radar_id THEN
      PERFORM omr_storage_assert_reference(NEW.object_key);
    END IF;
  ELSIF TG_TABLE_NAME='blip_emails' THEN
    IF TG_OP='INSERT' THEN
      FOR k IN SELECT key FROM (VALUES(NEW.original_key),(NEW.payload_key)) refs(key) WHERE key IS NOT NULL ORDER BY key LOOP
        PERFORM omr_storage_assert_reference(k);
      END LOOP;
    ELSE
      FOR k IN SELECT key FROM (VALUES
        (NEW.original_key,NEW.original_key IS DISTINCT FROM OLD.original_key OR NEW.blip_id IS DISTINCT FROM OLD.blip_id),
        (NEW.payload_key,NEW.payload_key IS DISTINCT FROM OLD.payload_key OR NEW.blip_id IS DISTINCT FROM OLD.blip_id)
      ) refs(key,added) WHERE key IS NOT NULL AND added ORDER BY key LOOP
        PERFORM omr_storage_assert_reference(k);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME='email_capture_receipts' AND NEW.completed_at IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.completed_at IS NULL AND NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.radar_id IS NOT DISTINCT FROM OLD.radar_id THEN
      -- Compare physical active keys, not filename/order or unrelated receipt metadata.
      FOR k IN SELECT key FROM (
        SELECT file->>'key' AS key FROM jsonb_array_elements(NEW.files) file
        UNION SELECT NEW.email->>'originalKey' UNION SELECT NEW.email->>'payloadKey'
        EXCEPT (
          SELECT file->>'key' FROM jsonb_array_elements(OLD.files) file
          UNION SELECT OLD.email->>'originalKey' UNION SELECT OLD.email->>'payloadKey'
        )
      ) added WHERE key IS NOT NULL ORDER BY key LOOP
        PERFORM omr_storage_assert_reference(k);
      END LOOP;
    ELSE
      -- INSERT, reopening a completed receipt, or moving its identity is new authority.
      FOR k IN SELECT DISTINCT key FROM (
        SELECT file->>'key' AS key FROM jsonb_array_elements(NEW.files) file
        UNION SELECT NEW.email->>'originalKey' UNION SELECT NEW.email->>'payloadKey'
      ) refs WHERE key IS NOT NULL ORDER BY key LOOP
        PERFORM omr_storage_assert_reference(k);
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_storage_reference BEFORE INSERT OR UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION omr_storage_reference_fence();
CREATE TRIGGER blip_emails_storage_reference BEFORE INSERT OR UPDATE ON blip_emails
  FOR EACH ROW EXECUTE FUNCTION omr_storage_reference_fence();
CREATE TRIGGER email_receipts_storage_reference BEFORE INSERT OR UPDATE ON email_capture_receipts
  FOR EACH ROW EXECUTE FUNCTION omr_storage_reference_fence();
CREATE FUNCTION omr_storage_retirement_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state NOT IN ('released','quarantined') THEN RETURN NEW; END IF;
  PERFORM omr_storage_reference_lock(NEW.object_key);
  IF EXISTS(SELECT 1 FROM attachments WHERE object_key=NEW.object_key)
    OR EXISTS(SELECT 1 FROM blip_emails WHERE original_key=NEW.object_key OR payload_key=NEW.object_key)
    OR EXISTS(SELECT 1 FROM email_capture_receipts WHERE completed_at IS NULL AND
      (email->>'originalKey'=NEW.object_key OR email->>'payloadKey'=NEW.object_key
       OR files @> jsonb_build_array(jsonb_build_object('key',NEW.object_key)))) THEN
    RAISE EXCEPTION 'referenced storage cannot retire';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_objects_reference_fence BEFORE INSERT OR UPDATE ON storage_objects
  FOR EACH ROW EXECUTE FUNCTION omr_storage_retirement_fence();

-- One durable attempt per retained blip/reference; legacy physical keys may be reused.
CREATE TABLE storage_migration_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL, source_key text NOT NULL, blip_id uuid NOT NULL, generation uuid NOT NULL,
  owner_id uuid NOT NULL, radar_id uuid NOT NULL, destination_key text NOT NULL,
  source_etag text NOT NULL, source_bytes bigint NOT NULL CHECK(source_bytes>=0 AND source_bytes<=9007199254740991),
  source_content_type text NOT NULL,
  state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','completed','abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(bucket,destination_key),
  CHECK((state='staged')=(completed_at IS NULL))
);
CREATE UNIQUE INDEX storage_migration_binding_active ON storage_migration_bindings(bucket,source_key,blip_id,generation) WHERE state='staged';
CREATE FUNCTION omr_storage_binding_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'storage migration history is permanent'; END IF;
  IF OLD.state<>'staged' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'completed storage migration history is immutable'; END IF;
  IF (NEW.id,NEW.bucket,NEW.source_key,NEW.blip_id,NEW.generation,NEW.owner_id,NEW.radar_id,NEW.destination_key,NEW.source_etag,NEW.source_bytes,NEW.source_content_type,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.bucket,OLD.source_key,OLD.blip_id,OLD.generation,OLD.owner_id,OLD.radar_id,OLD.destination_key,OLD.source_etag,OLD.source_bytes,OLD.source_content_type,OLD.created_at) THEN
    RAISE EXCEPTION 'storage migration attempt identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_migration_history BEFORE UPDATE OR DELETE ON storage_migration_bindings
  FOR EACH ROW EXECUTE FUNCTION omr_storage_binding_history();
