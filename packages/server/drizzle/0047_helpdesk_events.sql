-- Helpdesk slice 4: events to the portal (docs/HELPDESK.md §5.4, T6, T11).
--
-- Additive, so it is safe at boot on a rolling deploy: an old pod reads none of
-- these tables or columns, and the triggers only append to tables it never
-- reads.
--
-- ## What an event is
--
-- A row in `integration_events`: which integration it is for, what happened
-- (one of five words), and the ids of the request, radar and reply. Nothing
-- else, by construction: there is no column for a requester, an account, a
-- status, a title or an external ref, so a forged, misrouted or leaked event
-- discloses nothing. The portal fetches what changed through the projection
-- (§5.2), which is where its account scope is enforced.
--
-- ## Why triggers append them
--
-- Every event is appended in the same transaction as the change it reports
-- (§5.4), and the changes that matter are written by many paths: a lane moves
-- through `updateBlip`, the state repair, a lane removal, the client-reply
-- repair; a reply becomes client-visible by the owner's own post or by a
-- release; a request leaves scope by deletion, an unenrolment, a template or
-- owner change (already a trigger, 0045) or the radar's deletion. A trigger on
-- each table is the one place none of them can forget, and it sees the row as
-- written. The xid8 column then records exactly the writing transaction.
--
-- Echo suppression falls out of what is watched: the portal's own writes are a
-- new request (an INSERT on `blips`, which emits nothing) and a client's reply
-- (a `client` comment with an `external_author`, which emits nothing). The one
-- exception §5.4 asks for, the status repair a client's reply causes, is a lane
-- UPDATE like any other and is reported.
--
-- Nothing is emitted for an integration that is revoked or gone: a revoked
-- credential cannot read the log and nothing is delivered to it, and during an
-- account deletion the integration may already be deleted in the same
-- statement.
--
-- ## The reconcile cursor
--
-- `(xid, seq)`, read only below `pg_snapshot_xmin(pg_current_snapshot())`
-- (§5.4's table of three options). `seq` is allocated at INSERT, not at COMMIT,
-- so it alone can be passed by a reader while an earlier row's transaction is
-- still open; every row below the snapshot's xmin belongs to a finished
-- transaction, and every transaction still open or not yet begun has an xid at
-- or above it, so the set below the watermark is final.
--
-- ## Delivery
--
-- `integration_deliveries` is one row per event while an integration has a
-- receiver. Exhausting the retries pauses delivery and **keeps** the rows
-- (generic subscriptions discard them); resuming sends them oldest first.

-- ------------------------------------------------- the receiver, per integration --

ALTER TABLE integrations
  ADD COLUMN delivery_url               text,
  ADD COLUMN delivery_secret_ciphertext text,
  ADD COLUMN delivery_paused_at         timestamptz,
  ADD COLUMN delivery_last_error        text,
  ADD CONSTRAINT integrations_delivery_pair
    CHECK ((delivery_url IS NULL) = (delivery_secret_ciphertext IS NULL)),
  ADD CONSTRAINT integrations_delivery_https
    CHECK (delivery_url IS NULL OR (delivery_url LIKE 'https://%' AND char_length(delivery_url) <= 2048));

-- A radar's deletion is one more way an enrolment ends (§5.4 "leaving scope").
ALTER TABLE integration_radars DROP CONSTRAINT integration_radars_reason_valid;
ALTER TABLE integration_radars
  ADD CONSTRAINT integration_radars_reason_valid
    CHECK (revoked_reason IS NULL OR revoked_reason IN
      ('unenrolled', 'template_changed', 'owner_changed', 'integration_revoked', 'radar_deleted'));

-- ---------------------------------------------------------------- the log --

CREATE TABLE integration_events (
  -- Tie-breaker only: allocated at INSERT, so NOT a safe cursor on its own.
  seq             bigserial PRIMARY KEY,
  -- The writing transaction. The cursor's first key.
  xid             xid8 NOT NULL DEFAULT pg_current_xact_id(),
  -- The durable event id the portal dedupes on (also X-OMR-Event-Id).
  id              text NOT NULL DEFAULT ('evt_' || gen_random_uuid()),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event           text NOT NULL,
  -- No foreign keys: an event outlives the request it reports (request.removed).
  request_id      uuid,
  radar_id        uuid,
  reply_id        uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_events_id_key UNIQUE (id),
  CONSTRAINT integration_events_event_valid CHECK (event IN (
    'request.status_changed', 'request.reply', 'request.reply_retracted',
    'request.removed', 'integration.test')),
  -- The ids each event carries, and only those.
  CONSTRAINT integration_events_shape CHECK (
    ((event = 'integration.test') = (request_id IS NULL))
    AND ((request_id IS NULL) = (radar_id IS NULL))
    AND ((event IN ('request.reply', 'request.reply_retracted')) = (reply_id IS NOT NULL)))
);

CREATE INDEX integration_events_cursor_idx ON integration_events (integration_id, xid, seq);
CREATE INDEX integration_events_retention_idx ON integration_events (occurred_at);

-- An event is a fact about the past: never rewritten. The retention sweep and
-- an account deletion remove rows; nothing changes one.
CREATE FUNCTION omr_integration_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'an integration event is never rewritten'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER integration_events_immutable
  BEFORE UPDATE ON integration_events
  FOR EACH ROW EXECUTE FUNCTION omr_integration_events_immutable();

CREATE TABLE integration_deliveries (
  event_seq       bigint PRIMARY KEY REFERENCES integration_events(seq) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  attempts        integer NOT NULL DEFAULT 0,
  run_after       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX integration_deliveries_due_idx ON integration_deliveries (run_after);
CREATE INDEX integration_deliveries_integration_idx
  ON integration_deliveries (integration_id, event_seq);

CREATE TABLE integration_delivery_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  event           text NOT NULL,
  attempt         integer NOT NULL,
  status          integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX integration_delivery_attempts_history_idx
  ON integration_delivery_attempts (integration_id, created_at DESC, id DESC);

-- ------------------------------------------------- the client status in SQL --

-- The fixed status a helpdesk lane shows its client, as `clientStatusOf` in
-- `services/helpdesk-projection.ts` computes it: the radar's own lanes when it
-- has custom ones, else the registry's helpdesk lanes, and `received` for a
-- lane neither knows. SQL cannot read the registry, so the default lanes are
-- literal here; a test asserts this function and `clientStatusOf` agree on
-- every registry lane, on custom lanes and on an unknown one.
CREATE FUNCTION omr_helpdesk_client_status(config jsonb, status text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    CASE
      WHEN jsonb_typeof(config -> 'lanes') = 'array' AND jsonb_array_length(config -> 'lanes') > 0
        THEN (SELECT lane ->> 'clientStatus'
                FROM jsonb_array_elements(config -> 'lanes') AS lane
               WHERE lane ->> 'id' = status
               LIMIT 1)
      ELSE CASE status
        WHEN 'new' THEN 'received'
        WHEN 'scheduled' THEN 'scheduled'
        WHEN 'in-progress' THEN 'in_progress'
        WHEN 'waiting-on-client' THEN 'waiting_on_you'
        WHEN 'resolved' THEN 'resolved'
        WHEN 'declined' THEN 'declined'
      END
    END,
    'received')
$$;

-- ------------------------------------------------------------- emitting --

-- Append one event, and queue it for push when the integration has a
-- receiver. Nothing for a revoked integration, or one already deleted by the
-- account cascade this runs inside.
CREATE FUNCTION omr_integration_emit(
  p_integration uuid, p_event text, p_request uuid, p_radar uuid, p_reply uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_url text;
  v_seq bigint;
BEGIN
  SELECT delivery_url INTO v_url
    FROM integrations WHERE id = p_integration AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO integration_events (integration_id, event, request_id, radar_id, reply_id)
  VALUES (p_integration, p_event, p_request, p_radar, p_reply)
  RETURNING seq INTO v_seq;
  IF v_url IS NOT NULL THEN
    INSERT INTO integration_deliveries (event_seq, integration_id) VALUES (v_seq, p_integration);
  END IF;
END;
$$;

-- The integration a request on this radar is reported to: the one that filed
-- it, while it holds a live enrolment on the radar. NULL when it is not a
-- portal request or that integration no longer reaches the radar.
CREATE FUNCTION omr_request_integration(p_blip uuid, p_radar uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT h.integration_id
    FROM helpdesk_requests h
    JOIN integration_radars e
      ON e.integration_id = h.integration_id
     AND e.radar_id = p_radar
     AND e.revoked_at IS NULL
   WHERE h.blip_id = p_blip
$$;

-- A lane move the client can see, or a request leaving its radar.
CREATE FUNCTION omr_blips_integration_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_integration uuid;
  v_config jsonb;
BEGIN
  IF NEW.radar_id IS DISTINCT FROM OLD.radar_id THEN
    v_integration := omr_request_integration(OLD.id, OLD.radar_id);
    IF v_integration IS NOT NULL THEN
      PERFORM omr_integration_emit(v_integration, 'request.removed', OLD.id, OLD.radar_id, NULL);
    END IF;
    RETURN NULL;
  END IF;
  v_integration := omr_request_integration(NEW.id, NEW.radar_id);
  IF v_integration IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT template_config INTO v_config FROM radars WHERE id = NEW.radar_id;
  -- Two lanes with the same client status: nothing the client can see moved.
  IF omr_helpdesk_client_status(v_config, OLD.status)
     IS DISTINCT FROM omr_helpdesk_client_status(v_config, NEW.status) THEN
    PERFORM omr_integration_emit(v_integration, 'request.status_changed', NEW.id, NEW.radar_id, NULL);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER blips_integration_events
  AFTER UPDATE OF status, radar_id ON blips
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.radar_id IS DISTINCT FROM NEW.radar_id)
  EXECUTE FUNCTION omr_blips_integration_events();

-- A request deleted. BEFORE, while its request row and enrolment are visible.
-- Inside a radar's deletion the enrolment is already revoked (below), which
-- reported every request on the radar once, so this finds nothing.
CREATE FUNCTION omr_blips_removed_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_integration uuid;
BEGIN
  v_integration := omr_request_integration(OLD.id, OLD.radar_id);
  IF v_integration IS NOT NULL THEN
    PERFORM omr_integration_emit(v_integration, 'request.removed', OLD.id, OLD.radar_id, NULL);
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER blips_removed_event
  BEFORE DELETE ON blips
  FOR EACH ROW EXECUTE FUNCTION omr_blips_removed_event();

-- A reply the client can now see (the owner's own, or a release), or one that
-- was taken back. A client's own words are the portal's write and report
-- nothing.
CREATE FUNCTION omr_comments_integration_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_integration uuid;
  v_radar uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.visibility <> 'client' THEN
      RETURN NULL;
    END IF;
    -- While the blip itself is being deleted it is already gone here, so the
    -- radar is NULL, which matches no enrolment: request.removed says it once.
    SELECT radar_id INTO v_radar FROM blips WHERE id = OLD.blip_id;
    v_integration := omr_request_integration(OLD.blip_id, v_radar);
    IF v_integration IS NOT NULL THEN
      PERFORM omr_integration_emit(
        v_integration, 'request.reply_retracted', OLD.blip_id, v_radar, OLD.id);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.visibility <> 'client' OR NEW.external_author IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.visibility = 'client' THEN
    RETURN NULL;
  END IF;
  SELECT radar_id INTO v_radar FROM blips WHERE id = NEW.blip_id;
  v_integration := omr_request_integration(NEW.blip_id, v_radar);
  IF v_integration IS NOT NULL THEN
    PERFORM omr_integration_emit(v_integration, 'request.reply', NEW.blip_id, v_radar, NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER blip_comments_integration_events
  AFTER INSERT OR UPDATE OF visibility OR DELETE ON blip_comments
  FOR EACH ROW EXECUTE FUNCTION omr_comments_integration_events();

-- An enrolment ended, for any reason: every request that integration filed on
-- the radar has left its scope.
CREATE FUNCTION omr_integration_radars_removed_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_request uuid;
BEGIN
  FOR v_request IN
    SELECT h.blip_id
      FROM helpdesk_requests h
      JOIN blips b ON b.id = h.blip_id
     WHERE h.integration_id = NEW.integration_id AND b.radar_id = NEW.radar_id
     ORDER BY b.created_at, b.id
  LOOP
    PERFORM omr_integration_emit(NEW.integration_id, 'request.removed', v_request, NEW.radar_id, NULL);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER integration_radars_removed_events
  AFTER UPDATE OF revoked_at ON integration_radars
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION omr_integration_radars_removed_events();

-- A radar deleted: end its enrolments first, as any other loss of scope, so
-- the portal hears request.removed for each request once. Not inside a
-- cascade (`pg_trigger_depth() > 1`): that is an account deletion, which
-- takes the integration, its enrolments and its log with it, and whose own
-- `ON DELETE SET NULL` on `enrolled_by` must not meet a just-revoked row.
CREATE FUNCTION omr_radars_deleted_enrolments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  UPDATE integration_radars
     SET revoked_at = now(), revoked_reason = 'radar_deleted'
   WHERE radar_id = OLD.id AND revoked_at IS NULL;
  RETURN OLD;
END;
$$;

CREATE TRIGGER radars_deleted_enrolments
  BEFORE DELETE ON radars
  FOR EACH ROW EXECUTE FUNCTION omr_radars_deleted_enrolments();

-- A helpdesk's lanes edited so a lane now shows its clients a different
-- status: every request in that lane changed status without moving.
CREATE FUNCTION omr_radars_lane_status_events() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_row record;
BEGIN
  FOR v_row IN
    SELECT b.id, b.status, h.integration_id
      FROM blips b
      JOIN helpdesk_requests h ON h.blip_id = b.id
      JOIN integration_radars e
        ON e.integration_id = h.integration_id AND e.radar_id = b.radar_id AND e.revoked_at IS NULL
     WHERE b.radar_id = NEW.id
     ORDER BY b.created_at, b.id
  LOOP
    IF omr_helpdesk_client_status(OLD.template_config, v_row.status)
       IS DISTINCT FROM omr_helpdesk_client_status(NEW.template_config, v_row.status) THEN
      PERFORM omr_integration_emit(
        v_row.integration_id, 'request.status_changed', v_row.id, NEW.id, NULL);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER radars_lane_status_events
  AFTER UPDATE OF template_config ON radars
  FOR EACH ROW
  WHEN (OLD.template = 'helpdesk' AND NEW.template = 'helpdesk'
        AND OLD.template_config IS DISTINCT FROM NEW.template_config)
  EXECUTE FUNCTION omr_radars_lane_status_events();
