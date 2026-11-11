-- On My Radar — radar templates, smart radars, the drop box, and webhooks.
--
-- Everything here is additive and defaulted, so it applies to a populated
-- database without a backfill: existing radars become 'standard' radars on the
-- 'stream' template, which is exactly what they already were.

-- ------------------------------------------------------------- radar kinds --

-- 'standard' owns its blips. 'smart' owns none — it is a saved tag query that is
-- resolved at read time against *the caller's* readable radars, never the
-- owner's. See services/radars.ts:resolveRadarScope.
ALTER TABLE radars
  ADD COLUMN kind text NOT NULL DEFAULT 'standard'
    CHECK (kind IN ('standard', 'smart')),
  -- The saved query. Shaped by SmartFilter in @onmyradar/contract; opaque to SQL.
  ADD COLUMN filter jsonb,
  -- Registry id from contract/src/templates.ts. Deliberately NOT constrained
  -- here: adding a template must not require a migration, so the registry
  -- validates it and an unrecognised value degrades to the stream.
  ADD COLUMN template text NOT NULL DEFAULT 'stream',
  ADD COLUMN template_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The account's one freeform capture radar. A real radar the user owns, not a
  -- system object — so it can be renamed, recoloured, shared and deleted like
  -- any other, and the app re-creates it on demand.
  ADD COLUMN is_drop_box boolean NOT NULL DEFAULT false;

-- A smart radar without a query would resolve to "everything you can read",
-- which is both meaningless as a radar and the most expensive query in the app.
ALTER TABLE radars
  ADD CONSTRAINT radars_smart_needs_filter
    CHECK (kind <> 'smart' OR filter IS NOT NULL);

-- Backstop for the disclosure the service already refuses: a public reader has
-- no readable radars, so a public smart radar could only ever be resolved
-- against somebody else's — which would leak private radars through a link.
ALTER TABLE radars
  ADD CONSTRAINT radars_smart_is_never_public
    CHECK (NOT (kind = 'smart' AND visibility = 'public'));

-- At most one drop box per person. Enforced here rather than in the service so
-- two concurrent first-captures cannot both create one.
CREATE UNIQUE INDEX radars_owner_drop_box_key ON radars (owner_id) WHERE is_drop_box = true;

-- ---------------------------------------------------------- blip statuses --

-- The template's own lane, alongside (not instead of) the universal `state`.
-- No CHECK: the set of valid values depends on the radar's template, which is
-- declared in contract/src/templates.ts and validated there.
ALTER TABLE blips ADD COLUMN status text;

CREATE INDEX blips_radar_status_idx ON blips (radar_id, status) WHERE status IS NOT NULL;

-- ------------------------------------------------------------- webhooks --

-- An inbound, unauthenticated ingress. The only one in the application.
CREATE TABLE radar_webhooks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id          uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  -- Deliveries are authored by, and authorized as, this user. If they lose write
  -- access to the radar the webhook stops working, which is the correct
  -- behaviour and falls out of reusing requireRadar() rather than being a
  -- separate rule that could drift.
  created_by        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- Only the HMAC, keyed by SESSION_SECRET, exactly like a personal access
  -- token. The URL containing the secret exists in plaintext once.
  token_hash        text NOT NULL,
  token_prefix      text NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  format            text NOT NULL DEFAULT 'auto'
                      CHECK (format IN ('auto', 'template')),
  body_template     text,
  title_template    text,
  tags              text[] NOT NULL DEFAULT '{}',
  state             text NOT NULL DEFAULT 'inbox'
                      CHECK (state IN ('inbox', 'active', 'later', 'done', 'dropped')),
  -- Fixed-window rate limit, kept on the row. One atomic UPDATE ... RETURNING
  -- per delivery both rolls the window and counts the request, so there is no
  -- gap between checking and incrementing and no second table to sweep.
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_count      integer NOT NULL DEFAULT 0,
  delivery_count    bigint NOT NULL DEFAULT 0,
  last_delivery_at  timestamptz,
  last_error_at     timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX radar_webhooks_token_hash_key ON radar_webhooks (token_hash);
CREATE INDEX radar_webhooks_radar_idx ON radar_webhooks (radar_id);
CREATE INDEX radar_webhooks_creator_idx ON radar_webhooks (created_by);

-- ---------------------------------------------------------------- audit --

-- A webhook delivery is not a user acting and not an agent acting; the audit log
-- should say which it was rather than flattening it into one of the two.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_kind_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check
    CHECK (actor_kind IN ('user', 'agent', 'system', 'webhook'));
