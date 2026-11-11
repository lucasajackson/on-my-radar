-- Organizations and memberships: the tables, the backfill and the invariants, and nothing
-- that reads them. No authorization changes here (T2 owns the term in access.ts): every
-- existing grant, share and token behaves exactly as before. Additive only, and written to
-- be re-runnable: every statement is a no-op the second time.
--
-- ## Shape
--
-- Every user has exactly ONE home organization. Today that is a personal org of their own
-- (kind 'personal', role 'owner'); a team or install org is added later as a further
-- membership or, for an install org, by the runtime policy of the edition, never by
-- inferring from data here. The containers a person owns (radars, topics, dashboards,
-- agents, and the PATs and OAuth grants they hold) carry the organization they live in.
-- Blips are NOT touched: they inherit their radar's organization by join, and rewriting
-- the biggest table to say so would buy nothing.
--
-- ## Why a trigger fills organization_id, and why it runs eagerly
--
-- The app deploys as a rolling restart, so for a while the previous release is still
-- inserting radars and agents without an `organization_id` against the new schema. A
-- BEFORE INSERT trigger fills it from the owner's home org, so the NOT NULL below holds
-- for old and new code alike.
--
-- A new user's home org must exist by the time their first container is inserted, and
-- sign-up can create a user and a container in ONE transaction. A trigger that only ran
-- at commit would be too late for that insert. So `omr_ensure_home_org` is idempotent and
-- is called eagerly by the container trigger; the deferred constraint trigger on `users`
-- is the backstop for a user who never owns a container.
--
-- ## Locks and the statement timeout
--
-- The migrator runs with `statement_timeout = 0` (db/migrate.ts), so the pool's 5 s limit
-- cannot cancel the backfill. What matters is how long the ACCESS EXCLUSIVE locks below
-- are held, since a request queued behind them runs under that 5 s limit. The backfill is
-- one UPDATE per table over rows that number in the hundreds, so that is milliseconds.
-- No SET LOCAL is needed or used.

CREATE TABLE IF NOT EXISTS organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('personal', 'install', 'team')),
  -- Never a person's name: this row outlives the account that caused it.
  name       text NOT NULL,
  slug       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_key ON organizations (slug);
-- An install has at most one install org. (A personal org per user and, in the Enterprise
-- edition, any number of team orgs are unaffected.)
CREATE UNIQUE INDEX IF NOT EXISTS organizations_one_install ON organizations ((true))
  WHERE kind = 'install';

CREATE TABLE IF NOT EXISTS memberships (
  org_id         uuid NOT NULL REFERENCES organizations (id),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  is_home        boolean NOT NULL DEFAULT false,
  -- Set by org administration (T3); nothing in T1 writes it.
  deactivated_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
-- One home per user, whatever races to create it.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_home ON memberships (user_id) WHERE is_home;
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- The user's home org, created (with its owner membership) the first time it is needed.
-- Idempotent and safe to call from concurrent transactions: the per-user advisory lock
-- serialises them, and `memberships_one_home` is the backstop if anything ever bypasses it.
CREATE OR REPLACE FUNCTION omr_ensure_home_org(p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_org uuid;
BEGIN
  SELECT org_id INTO v_org FROM memberships WHERE user_id = p_user AND is_home;
  IF v_org IS NOT NULL THEN RETURN v_org; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omr-home-org:' || p_user::text, 0));
  SELECT org_id INTO v_org FROM memberships WHERE user_id = p_user AND is_home;
  IF v_org IS NOT NULL THEN RETURN v_org; END IF;
  INSERT INTO organizations (kind, name, slug)
    VALUES ('personal', 'Personal', 'personal-' || p_user::text)
    RETURNING id INTO v_org;
  INSERT INTO memberships (org_id, user_id, role, is_home)
    VALUES (v_org, p_user, 'owner', true);
  RETURN v_org;
END $$;

-- Every user gets a home org even if they never own anything. Deferred: it runs at commit,
-- after any in-transaction code that inserted its own home membership (which it then finds).
CREATE OR REPLACE FUNCTION omr_users_home_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.id) THEN
    PERFORM omr_ensure_home_org(NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS users_home_org ON users;
CREATE CONSTRAINT TRIGGER users_home_org AFTER INSERT ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION omr_users_home_org();

-- Fills, and guards, a container's organization. TG_ARGV[0] names the column holding its
-- owner (`owner_id`, or `user_id` for a token).
--   * No organization given: the owner's home org.
--   * One given (or changed): the owner must be a member of it, or the write is refused.
--     This is what stops a container landing in an org its owner is not in.
--   * The owner changed and the container stays: if the new owner is not a member of its
--     org (an agent handed to somebody outside it), it moves to the new owner's home org.
CREATE OR REPLACE FUNCTION omr_container_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_owner     uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  v_old_owner uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN v_old_owner := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid; END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := omr_ensure_home_org(v_owner);
  ELSIF TG_OP = 'INSERT' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    IF NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = NEW.organization_id AND user_id = v_owner) THEN
      RAISE EXCEPTION 'The owner is not a member of that organization' USING ERRCODE = '23514';
    END IF;
  ELSIF v_owner IS DISTINCT FROM v_old_owner THEN
    IF NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = NEW.organization_id AND user_id = v_owner) THEN
      NEW.organization_id := omr_ensure_home_org(v_owner);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ## Backfill
-- A home org for every existing user. `omr_ensure_home_org` finds the one that exists, so a
-- re-run creates nothing.
SELECT count(omr_ensure_home_org(id)) FROM users;

-- ## Containers
-- Per table: add the column, give every existing row its owner's home org, install the
-- trigger, then make the column NOT NULL. `account_closure_writer` (0057) refuses ANY write
-- to a closed account's rows, including this one; filing a row under an organization is not
-- a write by that account, so it is switched off for the UPDATE and back on, inside the
-- migration's own transaction (a failure rolls both back). Without this, one closed
-- account in production would fail the whole migration.

ALTER TABLE radars ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE radars DISABLE TRIGGER account_closure_writer;
UPDATE radars t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.owner_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE radars ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON radars;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF owner_id, organization_id ON radars
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('owner_id');
ALTER TABLE radars ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE topics ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE topics DISABLE TRIGGER account_closure_writer;
UPDATE topics t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.owner_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE topics ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON topics;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF owner_id, organization_id ON topics
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('owner_id');
ALTER TABLE topics ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE dashboards DISABLE TRIGGER account_closure_writer;
UPDATE dashboards t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.owner_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE dashboards ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON dashboards;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF owner_id, organization_id ON dashboards
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('owner_id');
ALTER TABLE dashboards ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE agents DISABLE TRIGGER account_closure_writer;
UPDATE agents t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.owner_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE agents ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON agents;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF owner_id, organization_id ON agents
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('owner_id');
ALTER TABLE agents ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE api_tokens DISABLE TRIGGER account_closure_writer;
UPDATE api_tokens t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.user_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE api_tokens ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON api_tokens;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF user_id, organization_id ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('user_id');
ALTER TABLE api_tokens ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
ALTER TABLE oauth_tokens DISABLE TRIGGER account_closure_writer;
UPDATE oauth_tokens t SET organization_id = m.org_id
  FROM memberships m WHERE m.user_id = t.user_id AND m.is_home AND t.organization_id IS NULL;
ALTER TABLE oauth_tokens ENABLE TRIGGER account_closure_writer;
DROP TRIGGER IF EXISTS container_organization ON oauth_tokens;
CREATE TRIGGER container_organization BEFORE INSERT OR UPDATE OF user_id, organization_id ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION omr_container_organization('user_id');
ALTER TABLE oauth_tokens ALTER COLUMN organization_id SET NOT NULL;

-- The audit log is append-only and the largest of these; its column stays nullable and is
-- not backfilled (metadata-only). Rows written before this migration are the pre-org
-- history, and the org-scoped viewer (T7) decides what to do with them.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations (id);
