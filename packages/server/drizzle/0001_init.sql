-- On My Radar — initial schema.
--
-- Conventions used throughout:
--   * uuid primary keys via gen_random_uuid() (pgcrypto ships in the server
--     since PG13; the CREATE EXTENSION below is a no-op on managed instances
--     that already have it).
--   * every timestamp is timestamptz; the app never stores naive time.
--   * deletes cascade from the owning aggregate (radar -> blips -> attachments)
--     so that removing a radar cannot leave orphaned rows behind.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- `array_to_string` is only STABLE (its behaviour depends on the element type's
-- output function in the general case), so Postgres refuses it inside a
-- generated column. For text[] it is genuinely deterministic, and this wrapper
-- says so — which is what lets a blip's tags be part of its full-text document.
CREATE OR REPLACE FUNCTION omr_tags_text(text[])
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$ SELECT array_to_string(coalesce($1, '{}'::text[]), ' ') $$;

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  avatar_url    text,
  -- 'pending' is the waitlist. Nothing but the waiting-room screen is reachable
  -- until an admin approves; 'suspended' revokes access without deleting data.
  state         text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'active', 'suspended')),
  is_admin      boolean NOT NULL DEFAULT false,
  theme         text NOT NULL DEFAULT 'system'
                  CHECK (theme IN ('system', 'light', 'dark')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

-- Email is stored already normalized (trimmed + lower-cased by the app), so a
-- plain unique index is enough and we avoid depending on citext.
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_state_idx ON users (state) WHERE state = 'pending';

-- Federated logins. One row per (provider, subject); a user may link several.
CREATE TABLE identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identities_provider_subject_key ON identities (provider, subject);
CREATE INDEX identities_user_idx ON identities (user_id);

-- One-time codes for magic-link sign-in. Only the hash is stored; a database
-- leak must not be enough to sign in as somebody.
CREATE TABLE login_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  code_hash    text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  request_ip   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email_idx ON login_codes (email, created_at DESC);
CREATE INDEX login_codes_expiry_idx ON login_codes (expires_at);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  user_agent    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- Personal access tokens: how a local coding agent authenticates to /mcp
-- without an OAuth dance. `prefix` is the visible, non-secret first characters
-- so the UI can show which token is which after the secret is gone.
CREATE TABLE api_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  token_hash    text NOT NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_tokens_hash_key ON api_tokens (token_hash);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------ radars --

CREATE TABLE radars (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  topic         text,
  description   text,
  accent        text NOT NULL DEFAULT 'cobalt',
  glyph         text NOT NULL DEFAULT 'radar',
  visibility    text NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('private', 'public')),
  -- Unguessable and stable: renaming a radar must not break a shared link, and
  -- a link must not be discoverable by guessing the name.
  public_slug   text,
  allow_index   boolean NOT NULL DEFAULT false,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX radars_owner_slug_key ON radars (owner_id, slug);
CREATE UNIQUE INDEX radars_public_slug_key ON radars (public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX radars_owner_idx ON radars (owner_id) WHERE archived = false;

CREATE TABLE radar_members (
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (radar_id, user_id)
);
CREATE INDEX radar_members_user_idx ON radar_members (user_id);

-- A share addressed to somebody who has not signed up yet. Claimed into
-- radar_members the first time that address authenticates.
CREATE TABLE radar_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX radar_invites_radar_email_key ON radar_invites (radar_id, email)
  WHERE accepted_at IS NULL;
CREATE INDEX radar_invites_email_idx ON radar_invites (email) WHERE accepted_at IS NULL;

-- ------------------------------------------------------------------- blips --

CREATE TABLE blips (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id    uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'note'
                CHECK (kind IN ('note', 'link', 'image', 'file', 'essay', 'quote', 'task')),
  state       text NOT NULL DEFAULT 'inbox'
                CHECK (state IN ('inbox', 'active', 'later', 'done', 'dropped')),
  title       text,
  body        text NOT NULL DEFAULT '',
  url         text,
  -- Cached open-graph unfurl for `url`. Opaque to SQL; shaped by LinkPreviewDto.
  preview     jsonb,
  tags        text[] NOT NULL DEFAULT '{}',
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Full-text search over everything a human would think of as "the blip".
  -- Generated (not trigger-maintained) so it can never drift from the columns.
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('english', omr_tags_text(tags)), 'B') ||
                setweight(to_tsvector('english', coalesce(url, '')), 'C') ||
                setweight(to_tsvector('english', coalesce(body, '')), 'D')
              ) STORED
);

-- The stream is "newest first within a radar", and the id tiebreak makes the
-- keyset cursor total, so this index serves the primary read path outright.
CREATE INDEX blips_radar_created_idx ON blips (radar_id, created_at DESC, id DESC);
CREATE INDEX blips_radar_pinned_idx ON blips (radar_id, pinned) WHERE pinned = true;
CREATE INDEX blips_search_idx ON blips USING gin (search);
CREATE INDEX blips_tags_idx ON blips USING gin (tags);
CREATE INDEX blips_state_idx ON blips (radar_id, state);

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blip_id       uuid NOT NULL REFERENCES blips(id) ON DELETE CASCADE,
  radar_id      uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  object_key    text NOT NULL,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size          bigint NOT NULL,
  width         integer,
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_blip_idx ON attachments (blip_id);
CREATE UNIQUE INDEX attachments_object_key_key ON attachments (object_key);

-- -------------------------------------------------------------- dashboards --

CREATE TABLE dashboards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboards_owner_idx ON dashboards (owner_id, position);

CREATE TABLE dashboard_widgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  radar_id      uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  x             integer NOT NULL DEFAULT 0,
  y             integer NOT NULL DEFAULT 0,
  w             integer NOT NULL DEFAULT 4,
  h             integer NOT NULL DEFAULT 8,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_widgets_dashboard_idx ON dashboard_widgets (dashboard_id);
CREATE INDEX dashboard_widgets_radar_idx ON dashboard_widgets (radar_id);

-- --------------------------------------------------------- MCP OAuth server --
-- On My Radar is its own authorization server for MCP clients, which register
-- dynamically (RFC 7591) and use PKCE. Kept deliberately minimal: no refresh
-- rotation family tracking, no client secrets for public clients.

CREATE TABLE oauth_clients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text NOT NULL,
  client_name       text,
  redirect_uris     text[] NOT NULL DEFAULT '{}',
  /* Null for public (PKCE-only) clients. */
  client_secret_hash text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oauth_clients_client_id_key ON oauth_clients (client_id);

CREATE TABLE oauth_codes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             text NOT NULL,
  client_id             text NOT NULL,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scope                 text NOT NULL DEFAULT '',
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oauth_codes_hash_key ON oauth_codes (code_hash);
CREATE INDEX oauth_codes_expiry_idx ON oauth_codes (expires_at);

CREATE TABLE oauth_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash  text NOT NULL,
  refresh_token_hash text,
  client_id          text NOT NULL,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope              text NOT NULL DEFAULT '',
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX oauth_tokens_access_hash_key ON oauth_tokens (access_token_hash);
CREATE UNIQUE INDEX oauth_tokens_refresh_hash_key ON oauth_tokens (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX oauth_tokens_user_idx ON oauth_tokens (user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------------- audit --

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_kind    text NOT NULL DEFAULT 'user'
                  CHECK (actor_kind IN ('user', 'agent', 'system')),
  action        text NOT NULL,
  subject_type  text,
  subject_id    text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_subject_idx ON audit_log (subject_type, subject_id, created_at DESC);
