-- Security audit hardening (blip 4406251d). Four independent additions, one file.

-- 1. SSO identities are keyed by (provider, issuer, subject), not by email.
--    Every provider='oidc' row written so far came from the one configured IdP,
--    whose issuer (OIDC_ISSUER_URL in infra-app-configs blue-kube/onmyradar and
--    docs/DEPLOY.md) is the value below. SQL cannot read the environment, so the
--    backfill names it; the application keys on the same configured value.
ALTER TABLE identities ADD COLUMN issuer text;
UPDATE identities
   SET issuer = 'https://sso.stealthcloud.net/webman/sso'
 WHERE provider = 'oidc' AND issuer IS NULL;
ALTER TABLE identities
  ADD CONSTRAINT identities_oidc_issuer_check CHECK (provider <> 'oidc' OR issuer IS NOT NULL);
DROP INDEX identities_provider_subject_key;
CREATE UNIQUE INDEX identities_provider_issuer_subject_key ON identities (provider, issuer, subject);

-- 2. Refresh-token reuse detection: the hash a rotation retired stays on the old
--    row, so presenting it again is recognisable and the whole grant can be revoked.
ALTER TABLE oauth_tokens ADD COLUMN previous_refresh_hash text;
CREATE INDEX oauth_tokens_previous_refresh_idx ON oauth_tokens (previous_refresh_hash)
  WHERE previous_refresh_hash IS NOT NULL;

-- 3. Permission-widening values on an agent profile are stored only with a record
--    of the owner's browser decision: {settings key: approved value}. Existing
--    profiles have none, so checkout strips any widening value they already hold
--    until the owner re-saves it from a browser session.
ALTER TABLE agent_profiles ADD COLUMN approved_widening jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 4. Verify-side limiter for sign-in codes: per address and per network, a fixed
--    window of failed/attempted verifications and a lockout once the daily cap is hit.
CREATE TABLE login_verify_limits (
  key               text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count      integer NOT NULL DEFAULT 1,
  locked_until      timestamptz
);
CREATE INDEX login_verify_limits_window_idx ON login_verify_limits (window_started_at);

-- 5. A token minted for an agent stays restricted for life. agent_id is SET NULL
--    when the agent is deleted, which used to hand the token back the owner's full
--    ceiling; agent_bound is the durable fact that survives that.
ALTER TABLE api_tokens ADD COLUMN agent_bound boolean NOT NULL DEFAULT false;
UPDATE api_tokens SET agent_bound = true WHERE agent_id IS NOT NULL;
ALTER TABLE oauth_codes ADD COLUMN agent_bound boolean NOT NULL DEFAULT false;
UPDATE oauth_codes SET agent_bound = true WHERE agent_id IS NOT NULL;
ALTER TABLE oauth_tokens ADD COLUMN agent_bound boolean NOT NULL DEFAULT false;
UPDATE oauth_tokens SET agent_bound = true WHERE agent_id IS NOT NULL;

-- 6. Refresh-token lineage. Reuse revokes the family the replayed token belongs
--    to, not every token the user holds for the client. Rows that predate this
--    share one family per (user, client), which is the old behaviour for them.
ALTER TABLE oauth_tokens ADD COLUMN family_id uuid;
UPDATE oauth_tokens SET family_id = md5(user_id::text || ':' || client_id)::uuid;
ALTER TABLE oauth_tokens
  ALTER COLUMN family_id SET NOT NULL,
  ALTER COLUMN family_id SET DEFAULT gen_random_uuid();
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
