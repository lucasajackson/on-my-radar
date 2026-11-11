-- Physical objects are independent of Stripe mode and survive source/account deletion.
-- Snapshot UUIDs deliberately have no cascading FK: cleanup must survive its source.
CREATE TABLE storage_objects (
  bucket text NOT NULL,
  object_key text NOT NULL,
  owner_id uuid NOT NULL,
  radar_id uuid NOT NULL,
  blip_id uuid,
  receipt_id text,
  kind text NOT NULL CHECK (kind IN ('browser', 'email', 'legacy')),
  state text NOT NULL CHECK (state IN ('reserved', 'live', 'unknown', 'delete_pending')),
  bytes bigint CHECK (bytes >= 0 AND bytes <= 9007199254740991),
  content_type text,
  digest text,
  writer_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleanup_after timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (bucket, object_key),
  CHECK (state <> 'reserved' OR (bytes IS NOT NULL AND writer_expires_at IS NOT NULL)),
  CHECK (state <> 'live' OR blip_id IS NOT NULL)
);
CREATE INDEX storage_objects_owner_idx ON storage_objects(owner_id);
CREATE INDEX storage_objects_cleanup_idx ON storage_objects(cleanup_after) WHERE state = 'delete_pending';
CREATE INDEX storage_objects_blip_idx ON storage_objects(blip_id);
-- Bucket is a runtime property. Backfill is performed by the application under
-- the same owner lock as new reservations, never by assuming a deployment name.
