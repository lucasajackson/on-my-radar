-- Helpdesk slice 3: the integration credential and the client projection
-- (docs/HELPDESK.md §3, §5, §7.6; decision 6 in Company Decisions a4f16ccc).
--
-- Additive only, so it is safe at boot on a rolling deploy: an old pod reads
-- none of these tables, and the two columns and one constraint it adds to
-- existing tables accept every row that exists today.
--
-- ## What each table is for
--
-- - `integrations`: one `omr_int_` credential per outside system (the W&W
--   portal). It acts as its owner, narrowed to the client projection of the
--   radars enrolled below. **Revoked, never deleted**: the rows that name it
--   (requests, client replies, audit) keep a valid reference.
-- - `integration_radars`: the enrolment, which is the whole of the scope. Only
--   a person creates one; nothing revives a revoked one.
-- - `helpdesk_requests`: the side row that makes a blip a client's request,
--   with the requester the portal asserted.
-- - `integration_idempotency`, `integration_scope_windows`: replay safety and
--   the per-client write limit.
--
-- ## Rules held by the database, not only by the service
--
-- Each of these is a promise the service also keeps with a sentence. The
-- database stands behind it so a path written later cannot forget it.
--
-- 1. **Expiry is at most 90 days from mint or rotation** (decision 6), and a
--    rotation's overlap is **at most 24 hours** (§3.4). A CHECK cannot read
--    `now()`, so both are written against `rotated_at` / `created_at`, values on
--    the row that the service sets in the same statement.
-- 2. **Revocation is terminal**, for a credential and for an enrolment. A
--    trigger refuses clearing `revoked_at` once set.
-- 3. **An integration is never deleted by a statement aimed at it.** A BEFORE
--    DELETE trigger refuses unless it fires inside a cascade
--    (`pg_trigger_depth() >= 2`): deleting the owning account still removes it,
--    which is the one hard delete §3.4 allows. Measured on PostgreSQL 16: a
--    direct DELETE runs the trigger at depth 1, an `ON DELETE CASCADE` from
--    `users` at depth 2.
-- 4. **Exposure only shrinks without a person** (§3.2). Switching a radar off
--    the helpdesk template, or changing its owner, revokes every live
--    enrolment on it in the same statement, by trigger, because three code
--    paths can write `radars.template` today (`createRadar`, `updateRadar`, and
--    the topic path through `setRadarTopic`). Switching it back exposes nothing:
--    revoked rows stay revoked. The template id is literal for the reason 0042
--    gives (SQL cannot read the registry); a test asserts it covers every
--    client-facing template.
-- 5. **A request's requester never changes** (T1 defence 4). Changing which
--    account a request belongs to would move one client's conversation in
--    front of another.
-- 6. **A client's words have no OMR author.** `external_author` and
--    `author_id` are never both set. Keyed on `author_id` only in the direction
--    a `SET NULL` cannot violate.
--
-- ## The audit log
--
-- `actor_kind` gains `'integration'`. Without it every portal write would fail
-- its audit insert, which `recordAudit` swallows: the record of who did what
-- would silently have a hole for every client action (§3.3).

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check
    CHECK (actor_kind IN ('user', 'agent', 'system', 'webhook', 'integration'));

-- ------------------------------------------------------------ integrations --

CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose               text NOT NULL DEFAULT 'helpdesk',
  name                  text NOT NULL,
  token_hash            text NOT NULL,
  token_prefix          text NOT NULL,
  token_last_used_at    timestamptz,
  previous_hash         text,
  previous_expires_at   timestamptz,
  previous_last_used_at timestamptz,
  rotated_at            timestamptz,
  expires_at            timestamptz NOT NULL,
  -- v1 has no 'direct' (decision 3). Adding it is a migration and Lucas's call.
  agent_reply_policy    text NOT NULL DEFAULT 'review',
  staff_display_name    text NOT NULL DEFAULT 'Workshop & Web Support',
  window_started_at     timestamptz NOT NULL DEFAULT now(),
  window_count          integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CONSTRAINT integrations_purpose_valid CHECK (purpose IN ('helpdesk')),
  CONSTRAINT integrations_reply_policy_valid CHECK (agent_reply_policy IN ('review')),
  CONSTRAINT integrations_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT integrations_staff_name_length
    CHECK (char_length(staff_display_name) BETWEEN 1 AND 80),
  CONSTRAINT integrations_previous_pair
    CHECK ((previous_hash IS NULL) = (previous_expires_at IS NULL)),
  CONSTRAINT integrations_overlap_at_most_24h
    CHECK (
      previous_expires_at IS NULL
      OR (rotated_at IS NOT NULL AND previous_expires_at <= rotated_at + interval '24 hours')
    ),
  CONSTRAINT integrations_expiry_at_most_90d
    CHECK (expires_at <= COALESCE(rotated_at, created_at) + interval '90 days')
);

CREATE UNIQUE INDEX integrations_token_hash_key ON integrations (token_hash);
CREATE UNIQUE INDEX integrations_previous_hash_key ON integrations (previous_hash)
  WHERE previous_hash IS NOT NULL;
CREATE INDEX integrations_owner_idx ON integrations (owner_id, created_at);

CREATE FUNCTION omr_integrations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'integrations are revoked, never deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked integration stays revoked'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integrations_guard
  BEFORE UPDATE OR DELETE ON integrations
  FOR EACH ROW EXECUTE FUNCTION omr_integrations_guard();

-- ------------------------------------------------------ integration_radars --

CREATE TABLE integration_radars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  radar_id        uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  -- The portal's website id. A label and an echo, never an authorisation (§4).
  external_ref    text,
  enrolled_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_reason  text,
  CONSTRAINT integration_radars_external_ref_length
    CHECK (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 64),
  CONSTRAINT integration_radars_reason_valid
    CHECK (revoked_reason IS NULL OR revoked_reason IN
      ('unenrolled', 'template_changed', 'owner_changed', 'integration_revoked')),
  CONSTRAINT integration_radars_revoked_has_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX integration_radars_live_key ON integration_radars (integration_id, radar_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX integration_radars_live_ref_key
  ON integration_radars (integration_id, external_ref)
  WHERE revoked_at IS NULL AND external_ref IS NOT NULL;
CREATE INDEX integration_radars_radar_idx ON integration_radars (radar_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION omr_integration_radars_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked enrolment is never revived'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.integration_id <> OLD.integration_id OR NEW.radar_id <> OLD.radar_id THEN
    RAISE EXCEPTION 'an enrolment names one integration and one radar for life'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER integration_radars_terminal
  BEFORE UPDATE ON integration_radars
  FOR EACH ROW EXECUTE FUNCTION omr_integration_radars_terminal();

-- Exposure is monotonic (§3.2). AFTER, so it sees the row as written by
-- whichever path wrote it.
CREATE FUNCTION omr_radars_revoke_enrolments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    UPDATE integration_radars
       SET revoked_at = now(), revoked_reason = 'owner_changed'
     WHERE radar_id = NEW.id AND revoked_at IS NULL;
  ELSIF NEW.template IS DISTINCT FROM OLD.template AND NEW.template <> 'helpdesk' THEN
    UPDATE integration_radars
       SET revoked_at = now(), revoked_reason = 'template_changed'
     WHERE radar_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER radars_revoke_enrolments
  AFTER UPDATE OF template, owner_id ON radars
  FOR EACH ROW EXECUTE FUNCTION omr_radars_revoke_enrolments();

-- ------------------------------------------------------- helpdesk_requests --

CREATE TABLE helpdesk_requests (
  blip_id               uuid PRIMARY KEY REFERENCES blips(id) ON DELETE CASCADE,
  -- SET NULL only on account deletion (integrations are otherwise never
  -- deleted). DEFERRABLE for the authorship-FK reason in 0015.
  integration_id        uuid REFERENCES integrations(id)
                             ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  requester_ref         text NOT NULL,
  requester_account_ref text NOT NULL,
  requester_name        text NOT NULL,
  requester_email       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT helpdesk_requests_ref_length CHECK (char_length(requester_ref) BETWEEN 1 AND 64),
  CONSTRAINT helpdesk_requests_account_length
    CHECK (char_length(requester_account_ref) BETWEEN 1 AND 64),
  CONSTRAINT helpdesk_requests_name_length CHECK (char_length(requester_name) BETWEEN 1 AND 120),
  CONSTRAINT helpdesk_requests_email_length
    CHECK (char_length(requester_email) BETWEEN 3 AND 254)
);

CREATE INDEX helpdesk_requests_account_idx ON helpdesk_requests (requester_account_ref);

CREATE FUNCTION omr_helpdesk_requests_requester_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.blip_id <> OLD.blip_id
     OR NEW.requester_ref <> OLD.requester_ref
     OR NEW.requester_account_ref <> OLD.requester_account_ref THEN
    RAISE EXCEPTION 'a request belongs to the requester and account that filed it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER helpdesk_requests_requester_fixed
  BEFORE UPDATE ON helpdesk_requests
  FOR EACH ROW EXECUTE FUNCTION omr_helpdesk_requests_requester_fixed();

-- ----------------------------------------------------------- blip_comments --

-- Which integration carried a client's reply (§7.1). DEFERRABLE: deleting an
-- account can fire several SET NULL actions against one comment row.
ALTER TABLE blip_comments
  ADD COLUMN integration_id uuid REFERENCES integrations(id)
                                 ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE blip_comments
  ADD CONSTRAINT blip_comments_external_has_no_author
    CHECK (external_author IS NULL OR author_id IS NULL);

-- ------------------------------------------------- idempotency, rate limits --

CREATE TABLE integration_idempotency (
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  key             text NOT NULL,
  -- sha256 of the route and the parsed body, so a key reused for a different
  -- write is a 409, not a silent replay of the first.
  request_sha256  text NOT NULL,
  resource_id     uuid NOT NULL,
  status          integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, key),
  CONSTRAINT integration_idempotency_key_length CHECK (char_length(key) BETWEEN 1 AND 128)
);

CREATE INDEX integration_idempotency_created_idx ON integration_idempotency (created_at);

CREATE TABLE integration_scope_windows (
  integration_id    uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  scope             text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (integration_id, scope)
);
