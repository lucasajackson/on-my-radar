-- A signed-out support conversation is never an account identity.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('user','agent','system','webhook','integration','guest'));
CREATE TABLE guest_support_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  recovery_hash text NOT NULL UNIQUE CHECK (recovery_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours')
);
CREATE FUNCTION omr_guest_support_capability_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.radar_id <> OLD.radar_id
     OR NEW.owner_id <> OLD.owner_id OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at > OLD.expires_at OR NEW.recovery_hash <> OLD.recovery_hash THEN
    RAISE EXCEPTION 'guest capability scope and terminal revocation are fixed' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_support_capability_fixed BEFORE UPDATE ON guest_support_capabilities
  FOR EACH ROW EXECUTE FUNCTION omr_guest_support_capability_fixed();
ALTER TABLE helpdesk_requests DROP CONSTRAINT helpdesk_requests_origin_check;
ALTER TABLE helpdesk_requests DROP CONSTRAINT helpdesk_native_support_provenance;
ALTER TABLE helpdesk_requests
  ADD COLUMN guest_capability_id uuid REFERENCES guest_support_capabilities(id) ON DELETE SET NULL,
  ADD CONSTRAINT helpdesk_requests_origin_check CHECK (origin IN ('portal','support','guest')),
  ADD CONSTRAINT helpdesk_native_support_provenance CHECK (
    (origin='portal' AND native_requester_user_id IS NULL AND support_category IS NULL AND guest_capability_id IS NULL)
    OR (origin='support' AND integration_id IS NULL AND support_category IS NOT NULL AND guest_capability_id IS NULL)
    OR (origin='guest' AND integration_id IS NULL AND native_requester_user_id IS NULL AND support_category IS NOT NULL)
  );
-- A signed-out requester may have no usable mailbox. Other helpdesk origins
-- retain their existing email constraint; an optional guest email proves no identity.
ALTER TABLE helpdesk_requests DROP CONSTRAINT helpdesk_requests_email_length;
ALTER TABLE helpdesk_requests ADD CONSTRAINT helpdesk_requests_email_length
  CHECK (char_length(requester_email) BETWEEN 3 AND 254
         OR (origin='guest' AND requester_email=''));
CREATE UNIQUE INDEX helpdesk_guest_one_thread_idx ON helpdesk_requests(guest_capability_id)
  WHERE guest_capability_id IS NOT NULL;
CREATE FUNCTION omr_guest_support_requester_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin='guest' AND NEW.guest_capability_id IS NULL THEN
    RAISE EXCEPTION 'guest support requires a conversation capability' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guest_support_requester_required BEFORE INSERT ON helpdesk_requests
  FOR EACH ROW EXECUTE FUNCTION omr_guest_support_requester_required();
CREATE OR REPLACE FUNCTION omr_helpdesk_requests_requester_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.blip_id <> OLD.blip_id OR NEW.requester_ref <> OLD.requester_ref
     OR NEW.requester_account_ref <> OLD.requester_account_ref OR NEW.origin <> OLD.origin
     OR NEW.support_category IS DISTINCT FROM OLD.support_category
     OR (NEW.integration_id IS DISTINCT FROM OLD.integration_id AND NEW.integration_id IS NOT NULL)
     OR (NEW.native_requester_user_id IS DISTINCT FROM OLD.native_requester_user_id
         AND NOT (NEW.native_requester_user_id IS NULL AND pg_trigger_depth() > 1))
     OR (NEW.guest_capability_id IS DISTINCT FROM OLD.guest_capability_id
         AND NOT (NEW.guest_capability_id IS NULL AND pg_trigger_depth() > 1)) THEN
    RAISE EXCEPTION 'a request belongs to the requester, account and integration that filed it'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TABLE guest_support_operations (
  capability_id uuid NOT NULL REFERENCES guest_support_capabilities(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(capability_id, operation_id)
);
CREATE INDEX guest_support_operations_window_idx ON guest_support_operations(capability_id,created_at);
CREATE TABLE guest_support_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1 CHECK (count > 0)
);
