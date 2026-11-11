-- Native intake is distinct from a portal whose integration was deleted.
ALTER TABLE helpdesk_requests
  ADD COLUMN origin text NOT NULL DEFAULT 'portal' CHECK (origin IN ('portal', 'support')),
  ADD COLUMN native_requester_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN support_category text CHECK (support_category IN ('account', 'billing', 'bug', 'feature', 'privacy')),
  ADD CONSTRAINT helpdesk_native_support_provenance CHECK (
    (origin = 'portal' AND native_requester_user_id IS NULL AND support_category IS NULL)
    OR (origin = 'support' AND integration_id IS NULL AND support_category IS NOT NULL)
  );
CREATE INDEX helpdesk_native_requester_idx ON helpdesk_requests(native_requester_user_id);

CREATE FUNCTION omr_native_support_requester_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin = 'support' AND NEW.native_requester_user_id IS NULL THEN
    RAISE EXCEPTION 'native support requires its signed-in requester' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER native_support_requester_required BEFORE INSERT ON helpdesk_requests
  FOR EACH ROW EXECUTE FUNCTION omr_native_support_requester_required();

CREATE OR REPLACE FUNCTION omr_helpdesk_requests_requester_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.blip_id <> OLD.blip_id
     OR NEW.requester_ref <> OLD.requester_ref
     OR NEW.requester_account_ref <> OLD.requester_account_ref
     OR NEW.origin <> OLD.origin
     OR NEW.support_category IS DISTINCT FROM OLD.support_category
     OR (NEW.integration_id IS DISTINCT FROM OLD.integration_id AND NEW.integration_id IS NOT NULL)
     OR (NEW.native_requester_user_id IS DISTINCT FROM OLD.native_requester_user_id
         AND NOT (NEW.native_requester_user_id IS NULL AND pg_trigger_depth() > 1)) THEN
    RAISE EXCEPTION 'a request belongs to the requester, account and integration that filed it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE support_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  payload_hash text NOT NULL,
  request_id uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, operation_id)
);
CREATE INDEX support_operations_window_idx ON support_operations(user_id, created_at);
