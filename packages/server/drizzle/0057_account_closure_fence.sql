-- Access closure is permanent and distinct from suspension or completed erasure.
-- No account cascade may destroy the only billing/cleanup reconciliation link.
CREATE TABLE account_closure_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  confirmed_session_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  phase text NOT NULL DEFAULT 'access_closed' CHECK (phase = 'access_closed'),
  billing_snapshot jsonb NOT NULL CHECK (jsonb_typeof(billing_snapshot) = 'object')
);
CREATE TABLE account_closure_challenges (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count integer NOT NULL DEFAULT 1 CHECK (window_count BETWEEN 1 AND 6)
);
CREATE TABLE account_lifecycle_fences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO account_lifecycle_fences (user_id) SELECT id FROM users;
CREATE FUNCTION omr_initialize_account_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_lifecycle_fences (user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER initialize_account_fence AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION omr_initialize_account_fence();
CREATE FUNCTION omr_account_open(account_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM account_closure_requests WHERE user_id = account_id)
$$;
CREATE FUNCTION omr_email_open(address text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM users u JOIN account_closure_requests c ON c.user_id=u.id
                     WHERE u.email=lower(btrim(address)))
$$;

-- Writers hold SHARE on an independent admission row until commit. Closure
-- exclusively locks that row, never a user/content row a writer might hold.
CREATE FUNCTION omr_assert_account_open(account_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF account_id IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM account_lifecycle_fences WHERE user_id=account_id FOR SHARE;
  IF NOT FOUND AND EXISTS (SELECT 1 FROM users WHERE id=account_id) THEN
    RAISE EXCEPTION 'Account admission fence is missing' USING ERRCODE='55000';
  END IF;
  IF NOT omr_account_open(account_id) THEN
    RAISE EXCEPTION 'Account access is closed' USING ERRCODE='55000';
  END IF;
END $$;

-- Resolve container ownership through a closed set of parent tables. Authorship
-- on somebody else's container is checked only when newly assigned, preserving
-- existing shared words without granting the closed author access.
CREATE FUNCTION omr_closure_container_owners(table_name text, row_data jsonb) RETURNS uuid[]
LANGUAGE plpgsql AS $$
DECLARE owners uuid[] := '{}'; parent record; parent_data jsonb;
BEGIN
  IF table_name IN ('radars','topics','agents','dashboards','integrations') THEN
    owners := array_append(owners, (row_data->>'owner_id')::uuid);
  END IF;
  FOR parent IN
    SELECT a.attname AS column_name, p.relname AS parent_table
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=c.confkey[1]
    WHERE c.contype='f' AND n.nspname='public' AND t.relname=table_name
      AND cardinality(c.conkey)=1 AND b.attname='id'
      AND p.relname IN ('radars','topics','agents','dashboards','blips','agent_memories',
        'agent_briefs','integrations','helpdesk_requests','notifications',
        'radar_subscriptions','radar_feeds','radar_webhooks')
  LOOP
    IF row_data->>parent.column_name IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT to_jsonb(p) FROM public.%I p WHERE id=$1', parent.parent_table)
      INTO parent_data USING (row_data->>parent.column_name)::uuid;
    IF parent_data IS NOT NULL THEN
      owners := owners || omr_closure_container_owners(parent.parent_table, parent_data);
    END IF;
  END LOOP;
  RETURN owners;
END $$;
CREATE FUNCTION omr_closure_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb := to_jsonb(NEW); old_data jsonb; affected uuid[]; column_name text; account_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); END IF;
  affected := omr_closure_container_owners(TG_TABLE_NAME, data);
  IF TG_OP='UPDATE' THEN
    affected := affected || omr_closure_container_owners(TG_TABLE_NAME, old_data);
  END IF;
  FOREACH column_name IN ARRAY coalesce(TG_ARGV, ARRAY[]::text[]) LOOP
    IF TG_OP='INSERT' OR column_name='owner_id' OR data->>column_name IS DISTINCT FROM old_data->>column_name THEN
      affected := array_append(affected, (data->>column_name)::uuid);
    END IF;
  END LOOP;
  FOR account_id IN SELECT DISTINCT x FROM unnest(affected) x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM omr_assert_account_open(account_id);
  END LOOP;
  RETURN NEW;
END $$;
-- Generate guards only for concrete account/content/credential tables in this
-- migration generation; financial and cleanup audit transitions stay operable.
DO $$
DECLARE t text; arguments text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'identities','sessions','api_tokens','oauth_codes','oauth_tokens','agent_sessions',
    'radars','topics','agents','dashboards','dashboard_widgets','radar_members','radar_invites',
    'topic_members','topic_invites','blips','blip_comments','blip_reactions','mentions',
    'attachments','blip_emails','blip_reminders','email_capture_identities','radar_email_capture',
    'email_capture_receipts','radar_webhooks','radar_feeds','radar_subscriptions',
    'agent_prompts','agent_profiles','agent_memories','agent_memory_revisions','agent_briefs',
    'agent_brief_revisions','agent_brief_bindings','agent_shares','agent_recipients','agent_transfers',
    'integrations','integration_radars','helpdesk_requests','notifications','push_devices',
    'push_subscriptions','user_notification_settings','radar_notification_prefs','support_operations'
  ] LOOP
    SELECT coalesce(string_agg(quote_literal(a.attname), ',' ORDER BY a.attname), '') INTO arguments
    FROM pg_constraint c
    JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    WHERE n.nspname='public' AND r.relname=t AND c.contype='f'
      AND p.relname='users' AND cardinality(c.conkey)=1;
    EXECUTE format('CREATE TRIGGER account_closure_writer BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard(%s)', t, arguments);
  END LOOP;
END $$;
CREATE FUNCTION omr_closure_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM omr_assert_account_open(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
  IF TG_OP='INSERT' AND NOT omr_email_open(NEW.email) THEN
    RAISE EXCEPTION 'Account access is closed' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_closure_identity BEFORE INSERT OR UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION omr_closure_identity_guard();
CREATE FUNCTION omr_closure_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Account closure evidence is permanent' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM account_lifecycle_fences WHERE user_id=NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_closure_request_permanent BEFORE INSERT OR UPDATE OR DELETE ON account_closure_requests
FOR EACH ROW EXECUTE FUNCTION omr_closure_request_guard();
-- A request-code race retains the generic response and stores no redeemable code.
CREATE FUNCTION omr_closure_email_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_id uuid;
BEGIN
  SELECT id INTO account_id FROM users WHERE email=NEW.email;
  IF account_id IS NOT NULL THEN
    PERFORM 1 FROM account_lifecycle_fences WHERE user_id=account_id FOR SHARE;
  END IF;
  IF NOT omr_account_open(account_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_closure_login_code BEFORE INSERT ON login_codes
FOR EACH ROW EXECUTE FUNCTION omr_closure_email_guard();
-- Cleanup transitions remain available; new signed-writer reservations do not.
CREATE FUNCTION omr_closure_storage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (NEW.state IN ('reserved','live') AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)) THEN
    PERFORM omr_assert_account_open(NEW.owner_id);
    IF TG_OP='UPDATE' THEN PERFORM omr_assert_account_open(OLD.owner_id); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_closure_storage BEFORE INSERT OR UPDATE ON storage_objects
FOR EACH ROW EXECUTE FUNCTION omr_closure_storage_guard();
CREATE TRIGGER account_closure_migration BEFORE INSERT ON storage_migration_bindings
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard('owner_id');
CREATE TRIGGER account_closure_contract BEFORE INSERT ON billing_contracts
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard('user_id');
