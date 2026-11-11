-- On My Radar — the Agent Repo.
--
-- An agent's system prompt and memory, held here and checked out anywhere
-- through MCP. docs/AGENT_REPO.md is the long version; this file carries the
-- reasons that belong to the DDL.
--
-- Every statement is additive. Nothing existing is rewritten or backfilled, so
-- this is safe to apply at boot on a rolling deploy where old and new pods
-- overlap: an old pod simply never reads these tables.
--
-- ## Why these are not radars and blips
--
-- A memory stored as a blip would inherit capture inference (a `#` in a code
-- sample becomes a tag; a bare URL triggers the unfurler — the one outbound
-- request to a user-chosen address — on agent-authored text), @mention fan-out
-- (an agent's private note naming @ada would notify Ada), and every cross-radar
-- surface (search, smart radars, dashboards, tags, webhooks, subscriptions)
-- would need an "unless it is a memory" predicate. An incomplete list there is
-- the bug. So these are their own tables, and nothing in the radar world can
-- see them by accident.
--
-- ## Why `repo_agents` is not the `agents` (persona) table
--
-- A persona is an identity for authorship, owned by one human, bound to a
-- credential. A repo agent is a definition — prompt and memory — which can be
-- shared, created over MCP, and outnumbers the persona bound (12) on the first
-- import. The two are linked, optionally and only by a person, through
-- `persona_id`.

-- ===========================================================================
-- 1. The definition
-- ===========================================================================

CREATE TABLE repo_agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Unique per owner, never globally: a global namespace is a probe for which
  -- names are taken. A shared agent is addressed by id.
  slug            text NOT NULL,
  name            text NOT NULL,
  description     text NOT NULL DEFAULT '',
  -- One identity speaks for at most one definition, so "which agent is this
  -- persona" always has one answer. Set only by a person (assertHumanDecision).
  persona_id      uuid UNIQUE REFERENCES agents(id) ON DELETE SET NULL,
  -- The live prompt version, 0 when there is none yet. Allocated under a row
  -- lock on this row, so two editors cannot both become version N.
  prompt_version  integer NOT NULL DEFAULT 0,
  prompt_edits    text NOT NULL DEFAULT 'propose',
  harness_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  accent          text,
  -- Radars the agent works from. Not foreign keys: a stale id is filtered out
  -- at read time through the caller's readable set, which is the only filter
  -- that can be right about who may see which radar anyway.
  home_radar_ids  uuid[] NOT NULL DEFAULT '{}',
  revision        integer NOT NULL DEFAULT 0,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_agents_slug_valid CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT repo_agents_prompt_edits_valid CHECK (prompt_edits IN ('propose','direct')),
  CONSTRAINT repo_agents_harness_config_object CHECK (jsonb_typeof(harness_config) = 'object')
);
CREATE UNIQUE INDEX repo_agents_owner_slug_key ON repo_agents (owner_id, slug);

-- Direct shares. Never `owner`: handing the agent over is not a share, for the
-- reason CASCADE_GRANTS has no owner in its range.
CREATE TABLE repo_agent_members (
  agent_id    uuid NOT NULL REFERENCES repo_agents(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'viewer',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id),
  CONSTRAINT repo_agent_members_role_valid CHECK (role IN ('viewer','editor'))
);
CREATE INDEX repo_agent_members_user_idx ON repo_agent_members (user_id);

-- ===========================================================================
-- 2. Sessions — a row, not a transport session
-- ===========================================================================
--
-- The MCP transport stays stateless. `load_agent` creates one of these and
-- memory writes name it. It binds to the *connection*: a PAT id, or an OAuth
-- client id — never the OAuth access-token row, which rotates on every refresh.

CREATE TABLE repo_agent_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES repo_agents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_kind text NOT NULL,
  connection_id   text NOT NULL,
  persona_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  prompt_version  integer NOT NULL,
  client_label    text,
  harness         text,
  workspace       text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_agent_sessions_kind_valid CHECK (connection_kind IN ('pat','oauth','session'))
);
CREATE INDEX repo_agent_sessions_agent_idx ON repo_agent_sessions (agent_id, started_at DESC);

-- ===========================================================================
-- 3. Prompts — append-only
-- ===========================================================================
--
-- Rows are never updated except `status`; rollback is a new version copying an
-- old body. The partial unique index is the guarantee there is exactly one live
-- prompt, so "which prompt did this session load" is never ambiguous.
--
-- ## Why the authorship FKs are DEFERRABLE
--
-- `author_id` and (through the session) `session_id` both point at the same
-- human. Deleting that person runs two ON DELETE SET NULL actions plus a
-- CASCADE against one tuple; a non-deferrable check can land on a tuple version
-- naming a row Postgres has already removed and abort the whole DELETE.
-- docs/PERSONA.md §3 found that the hard way; this does not wait to.

CREATE TABLE repo_agent_prompts (
  agent_id     uuid NOT NULL REFERENCES repo_agents(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL,
  based_on     integer,
  note         text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'human',
  client_label text,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  session_id   uuid REFERENCES repo_agent_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, version),
  CONSTRAINT repo_agent_prompts_status_valid
    CHECK (status IN ('live','proposed','declined','superseded')),
  CONSTRAINT repo_agent_prompts_source_valid CHECK (source IN ('human','agent','import'))
);
CREATE UNIQUE INDEX repo_agent_prompts_one_live
  ON repo_agent_prompts (agent_id) WHERE status = 'live';

-- ===========================================================================
-- 4. Memories
-- ===========================================================================
--
-- `search` is GENERATED, like blips.search, so it cannot drift from the row, and
-- it is absent from schema.ts for the same reason. `to_tsvector` with a literal
-- regconfig and `replace` are both immutable, so the generated column is legal;
-- migrate.test runs this against a real Postgres because `array_to_string` is
-- how that lesson was learned.
--
-- The unique index is partial on `forgotten_at IS NULL`: forgetting a name and
-- writing it again is a new row, and the tombstone keeps its history.

CREATE TABLE repo_agent_memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid NOT NULL REFERENCES repo_agents(id) ON DELETE CASCADE,
  name          text NOT NULL,
  type          text NOT NULL,
  description   text NOT NULL,
  body          text NOT NULL,
  pinned        boolean NOT NULL DEFAULT false,
  revision      integer NOT NULL DEFAULT 1,
  -- Who wrote the *current* revision. Written in the same statement as `body`,
  -- so it is a fact about this row rather than a copy that could drift; the
  -- revision table keeps the history. The index ranks and labels by it.
  source        text NOT NULL DEFAULT 'agent',
  author_id     uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  -- A person read *this* revision. Any agent write clears it.
  reviewed_at   timestamptz,
  forgotten_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search        tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english'::regconfig, replace(name, '-', ' ')), 'A') ||
                  setweight(to_tsvector('english'::regconfig, description), 'B') ||
                  setweight(to_tsvector('english'::regconfig, body), 'C')
                ) STORED,
  CONSTRAINT repo_agent_memories_name_valid CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT repo_agent_memories_type_valid
    CHECK (type IN ('feedback','user','project','reference')),
  CONSTRAINT repo_agent_memories_source_valid CHECK (source IN ('human','agent','import'))
);
CREATE UNIQUE INDEX repo_agent_memories_live_name
  ON repo_agent_memories (agent_id, name) WHERE forgotten_at IS NULL;
CREATE INDEX repo_agent_memories_agent_idx ON repo_agent_memories (agent_id, updated_at DESC);
CREATE INDEX repo_agent_memories_search_idx ON repo_agent_memories USING gin (search);

-- The content audit. Provenance here is a historical fact, not derived state,
-- so it is stored — like a notification's excerpt — and survives the session
-- row being purged. The Agent Repo's history view reads this table; audit_log
-- still gets a row for every write but has no read path in the product.
CREATE TABLE repo_agent_memory_revisions (
  memory_id    uuid NOT NULL REFERENCES repo_agent_memories(id) ON DELETE CASCADE,
  revision     integer NOT NULL,
  op           text NOT NULL,
  type         text NOT NULL,
  description  text NOT NULL,
  body         text NOT NULL,
  source       text NOT NULL,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  session_id   uuid REFERENCES repo_agent_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  client_label text,
  harness      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Revision numbers are per memory; a review adds a row without moving the
  -- memory's revision, so the key carries a sequence as well.
  seq          bigserial,
  PRIMARY KEY (memory_id, seq),
  CONSTRAINT repo_agent_memory_revisions_op_valid
    CHECK (op IN ('create','update','append','forget','restore','review')),
  CONSTRAINT repo_agent_memory_revisions_source_valid CHECK (source IN ('human','agent','import'))
);
CREATE INDEX repo_agent_memory_revisions_session_idx
  ON repo_agent_memory_revisions (session_id, created_at);
