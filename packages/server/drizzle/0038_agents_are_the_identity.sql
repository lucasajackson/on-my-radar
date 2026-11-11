-- On My Radar — Agent Repo v2: agents are the identity.
--
-- docs/AGENT_REPO.md Part I is the long version. What this file does, in order:
--
--   1. Personas become agents, ids preserved.
--   2. The persona table goes; the repo_agent* tables take the plain names.
--   3. Every authorship and credential foreign key is re-aimed at the one
--      agents table, with the actions 0015 chose.
--   4. Memory review and prompt proposals are removed (agents are autonomous).
--   5. Home radars go; tool profiles, shares, recipients, transfers and the
--      model catalog arrive.
--
-- It runs in one transaction (migrate.ts), so a failure anywhere leaves the
-- database exactly as it was. Nothing that holds an agent's writing — prompt
-- versions, memories, memory revisions, sessions — is rewritten: those tables
-- are renamed in place, rows and ids untouched.
--
-- ## Why persona ids are preserved
--
-- blips, blip_comments, mentions, notifications, audit_log, api_tokens,
-- oauth_codes and oauth_tokens all carry an `agent_id` that points at a
-- persona. Inserting each persona into the agents table *with its own id* means
-- every one of those rows already points at the right agent once the foreign
-- keys are re-aimed — no row of authorship is touched. A persona that was
-- linked to a repo agent (v1's `persona_id`) folds into that agent instead,
-- and only then are authorship rows re-pointed, from the persona's id to the
-- agent's. Production held no personas when this was written; dev, test and
-- phone-suite databases do, which is why the general case is here.

-- ===========================================================================
-- 1. Personas become agents
-- ===========================================================================

-- The foreign keys to the persona table go first. Re-pointing a linked
-- persona's authorship at its repo agent's id while they still stand is a
-- violation for every non-deferrable one (api_tokens, oauth_*, mentions,
-- notifications) — found by running this against a seeded database. They come
-- back in section 3, aimed at the merged table, and nothing in between can
-- write an agent_id: this is one transaction.
ALTER TABLE blips DROP CONSTRAINT blips_agent_id_fkey;
ALTER TABLE blip_comments DROP CONSTRAINT blip_comments_agent_id_fkey;
ALTER TABLE mentions DROP CONSTRAINT mentions_agent_id_fkey;
ALTER TABLE notifications DROP CONSTRAINT notifications_agent_id_fkey;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_agent_id_fkey;
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_agent_id_fkey;
ALTER TABLE oauth_codes DROP CONSTRAINT oauth_codes_agent_id_fkey;
ALTER TABLE oauth_tokens DROP CONSTRAINT oauth_tokens_agent_id_fkey;

-- A linked persona folds into its repo agent: re-point authorship.
UPDATE blips b SET agent_id = r.id FROM repo_agents r WHERE b.agent_id = r.persona_id;
UPDATE blip_comments c SET agent_id = r.id FROM repo_agents r WHERE c.agent_id = r.persona_id;
UPDATE mentions m SET agent_id = r.id FROM repo_agents r WHERE m.agent_id = r.persona_id;
UPDATE notifications n SET agent_id = r.id FROM repo_agents r WHERE n.agent_id = r.persona_id;
UPDATE audit_log a SET agent_id = r.id FROM repo_agents r WHERE a.agent_id = r.persona_id;
UPDATE api_tokens t SET agent_id = r.id FROM repo_agents r WHERE t.agent_id = r.persona_id;
UPDATE oauth_codes o SET agent_id = r.id FROM repo_agents r WHERE o.agent_id = r.persona_id;
UPDATE oauth_tokens o SET agent_id = r.id FROM repo_agents r WHERE o.agent_id = r.persona_id;

-- Every other persona becomes an agent with its own id. Handles are
-- mentionKey-normalised and may hold non-ASCII letters; a slug is
-- [a-z0-9-], so non-ASCII is dropped, and a collision with a slug the same
-- person already has gets -persona, then -2, -3, ….
DO $$
DECLARE
  p record;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR p IN
    SELECT a.* FROM agents a
    WHERE NOT EXISTS (SELECT 1 FROM repo_agents r WHERE r.persona_id = a.id)
    ORDER BY a.created_at, a.id
  LOOP
    base := trim(both '-' from regexp_replace(lower(p.handle), '[^a-z0-9]+', '-', 'g'));
    base := trim(both '-' from left(base, 55));
    IF base = '' THEN base := 'agent'; END IF;
    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM repo_agents r WHERE r.owner_id = p.owner_id AND r.slug = candidate) LOOP
      n := n + 1;
      candidate := CASE WHEN n = 2 THEN base || '-persona' ELSE base || '-' || n END;
    END LOOP;
    INSERT INTO repo_agents (id, owner_id, slug, name, description, archived_at, created_at, updated_at)
    VALUES (p.id, p.owner_id, candidate, p.name, '', p.retired_at, p.created_at, p.updated_at);
  END LOOP;
END $$;

-- ===========================================================================
-- 2. One agents table
-- ===========================================================================

ALTER TABLE repo_agents DROP COLUMN persona_id;
-- A session's persona was the *connection's* identity; the session's agent is
-- the identity now, and the connection is recorded as the cosigner.
ALTER TABLE repo_agent_sessions DROP COLUMN persona_id;
DROP TABLE agents;

ALTER TABLE repo_agents RENAME TO agents;
ALTER TABLE repo_agent_sessions RENAME TO agent_sessions;
ALTER TABLE repo_agent_prompts RENAME TO agent_prompts;
ALTER TABLE repo_agent_memories RENAME TO agent_memories;
ALTER TABLE repo_agent_memory_revisions RENAME TO agent_memory_revisions;

ALTER INDEX repo_agents_pkey RENAME TO agents_pkey;
ALTER INDEX repo_agents_owner_slug_key RENAME TO agents_owner_slug_key;
ALTER INDEX repo_agent_sessions_pkey RENAME TO agent_sessions_pkey;
ALTER INDEX repo_agent_sessions_agent_idx RENAME TO agent_sessions_agent_idx;
ALTER INDEX repo_agent_prompts_pkey RENAME TO agent_prompts_pkey;
ALTER INDEX repo_agent_prompts_one_live RENAME TO agent_prompts_one_live;
ALTER INDEX repo_agent_memories_pkey RENAME TO agent_memories_pkey;
ALTER INDEX repo_agent_memories_live_name RENAME TO agent_memories_live_name;
ALTER INDEX repo_agent_memories_agent_idx RENAME TO agent_memories_agent_idx;
ALTER INDEX repo_agent_memories_search_idx RENAME TO agent_memories_search_idx;
ALTER INDEX repo_agent_memory_revisions_pkey RENAME TO agent_memory_revisions_pkey;
ALTER INDEX repo_agent_memory_revisions_session_idx RENAME TO agent_memory_revisions_session_idx;

CREATE INDEX agents_owner_idx ON agents (owner_id);

-- ===========================================================================
-- 3. Re-aim authorship and credentials at the one table
-- ===========================================================================
--
-- The actions are 0015's, and the deferrability is load-bearing: author_id and
-- agent_id both point at the same human on an agent-borne row, and a
-- non-deferrable check can land on a tuple version naming a row Postgres has
-- already removed (docs/PERSONA.md §3).

ALTER TABLE blips ADD CONSTRAINT blips_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE blip_comments ADD CONSTRAINT blip_comments_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE mentions ADD CONSTRAINT mentions_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE oauth_codes ADD CONSTRAINT oauth_codes_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_agent_id_fkey FOREIGN KEY (agent_id)
  REFERENCES agents(id) ON DELETE SET NULL;

-- ===========================================================================
-- 4. Autonomy: no memory review, no prompt proposals
-- ===========================================================================

DELETE FROM agent_memory_revisions WHERE op = 'review';
ALTER TABLE agent_memory_revisions DROP CONSTRAINT repo_agent_memory_revisions_op_valid;
ALTER TABLE agent_memory_revisions ADD CONSTRAINT agent_memory_revisions_op_valid
  CHECK (op IN ('create','update','append','forget','restore'));
ALTER TABLE agent_memories DROP COLUMN reviewed_at;

-- A proposal nobody accepted is not made live by a migration.
UPDATE agent_prompts
   SET status = 'declined',
       note = CASE WHEN note = '' THEN 'withdrawn when proposals were removed (v2)'
                   ELSE note || ' — withdrawn when proposals were removed (v2)' END
 WHERE status = 'proposed';
ALTER TABLE agent_prompts DROP CONSTRAINT repo_agent_prompts_status_valid;
ALTER TABLE agent_prompts ADD CONSTRAINT agent_prompts_status_valid
  CHECK (status IN ('live','superseded','declined'));
-- The tool the agent was running in when it wrote this version.
ALTER TABLE agent_prompts ADD COLUMN harness text;

ALTER TABLE agents DROP CONSTRAINT repo_agents_prompt_edits_valid;
ALTER TABLE agents DROP COLUMN prompt_edits;
-- Agents cannot change a locked prompt; people with edit access still can.
ALTER TABLE agents ADD COLUMN lock_prompt boolean NOT NULL DEFAULT false;

-- ===========================================================================
-- 5. Profiles, shares, recipients, transfers, the model catalog
-- ===========================================================================

ALTER TABLE agents DROP COLUMN home_radar_ids;
ALTER TABLE agents ADD COLUMN primary_harness text;
ALTER TABLE agents ADD CONSTRAINT agents_primary_harness_valid CHECK (
  primary_harness IS NULL OR primary_harness IN
    ('claude-code','codex','cursor','claude-ai','copilot','gemini-cli','windsurf','zed','other'));

-- One row per tool an agent has settings for, plus 'default'. `settings` is
-- validated per tool in the service against packages/contract harnesses.ts;
-- the CHECK only keeps it an object.
CREATE TABLE agent_profiles (
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  harness     text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  addendum    text NOT NULL DEFAULT '',
  revision    integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, harness),
  CONSTRAINT agent_profiles_harness_valid CHECK (harness IN
    ('claude-code','codex','cursor','claude-ai','copilot','gemini-cli','windsurf','zed','other','default')),
  CONSTRAINT agent_profiles_settings_object CHECK (jsonb_typeof(settings) = 'object')
);

-- v1's harness_config held only Claude Code frontmatter (model, effort, color,
-- tools), whose keys are the claude-code profile's field keys unchanged.
INSERT INTO agent_profiles (agent_id, harness, settings, updated_at)
SELECT a.id, kv.key, kv.value, a.updated_at
  FROM agents a, jsonb_each(a.harness_config) kv
 WHERE kv.key IN ('claude-code','codex','cursor','copilot','gemini-cli','zed')
   AND jsonb_typeof(kv.value) = 'object';
UPDATE agents SET primary_harness = 'claude-code' WHERE harness_config ? 'claude-code';
ALTER TABLE agents DROP CONSTRAINT repo_agents_harness_config_object;
ALTER TABLE agents DROP COLUMN harness_config;

-- Shares grant; recipients pin. A share names a person or a topic and carries
-- two levels. Topic grants are computed at access time from topic membership
-- and never written per person (the topic-cascade argument, DESIGN §17).
CREATE TABLE agent_shares (
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  prompt_access text NOT NULL DEFAULT 'view',
  memory_access text NOT NULL DEFAULT 'none',
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, subject_type, subject_id),
  CONSTRAINT agent_shares_subject_valid CHECK (subject_type IN ('user','topic')),
  CONSTRAINT agent_shares_prompt_valid CHECK (prompt_access IN ('view','edit')),
  CONSTRAINT agent_shares_memory_valid CHECK (memory_access IN ('none','view','edit'))
);
CREATE INDEX agent_shares_subject_idx ON agent_shares (subject_type, subject_id);

INSERT INTO agent_shares (agent_id, subject_type, subject_id, prompt_access, memory_access, created_at)
SELECT agent_id, 'user', user_id,
       CASE role WHEN 'editor' THEN 'edit' ELSE 'view' END,
       CASE role WHEN 'editor' THEN 'edit' ELSE 'view' END,
       created_at
  FROM repo_agent_members;
DROP TABLE repo_agent_members;

-- A recipient's own state for an agent shared with them, however it reached
-- them: the version they accepted (and so run), and whether they follow
-- updates. No row = not accepted yet. The grant is never here.
CREATE TABLE agent_recipients (
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_version integer NOT NULL,
  follow_updates   boolean NOT NULL DEFAULT false,
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id)
);
-- v1 members had accepted by being members: pin them to the live version.
INSERT INTO agent_recipients (agent_id, user_id, accepted_version)
SELECT s.agent_id, s.subject_id, a.prompt_version
  FROM agent_shares s JOIN agents a ON a.id = s.agent_id
 WHERE s.subject_type = 'user';

-- At most one ownership transfer waiting per agent; the recipient accepts.
CREATE TABLE agent_transfers (
  agent_id    uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  to_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The models each tool offers in a profile, kept current in /admin so a new
-- model needs no deploy. Profiles also accept any id through Custom….
CREATE TABLE model_catalog (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  harness       text NOT NULL,
  model_id      text NOT NULL,
  display_name  text NOT NULL,
  family        text NOT NULL DEFAULT '',
  hidden        boolean NOT NULL DEFAULT false,
  deprecated    boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_catalog_harness_valid CHECK (harness IN
    ('claude-code','codex','cursor','claude-ai','copilot','gemini-cli','windsurf','zed','other'))
);
CREATE UNIQUE INDEX model_catalog_harness_model_key ON model_catalog (harness, model_id);

-- The seed is packages/contract harnesses.ts MODEL_CATALOG_SEED, as of 2026-09-26.
INSERT INTO model_catalog (harness, model_id, display_name, family, sort_order) VALUES
  ('claude-code', 'opus', 'Opus (latest)', 'Claude', 10),
  ('claude-code', 'sonnet', 'Sonnet (latest)', 'Claude', 20),
  ('claude-code', 'haiku', 'Haiku (latest)', 'Claude', 30),
  ('claude-code', 'fable', 'Fable (latest)', 'Claude', 40),
  ('claude-code', 'inherit', 'Same as the session', 'Any', 90),
  ('codex', 'gpt-5-codex', 'gpt-5-codex', 'GPT', 10),
  ('codex', 'gpt-5', 'gpt-5', 'GPT', 20),
  ('cursor', 'inherit', 'Same as Cursor', 'Any', 90),
  ('copilot', 'Claude Opus 4.5', 'Claude Opus 4.5', 'Claude', 10),
  ('copilot', 'GPT-5', 'GPT-5', 'GPT', 20),
  ('gemini-cli', 'gemini-2.5-pro', 'gemini-2.5-pro', 'Gemini', 10),
  ('gemini-cli', 'gemini-2.5-flash', 'gemini-2.5-flash', 'Gemini', 20),
  ('zed', 'anthropic/claude-opus', 'Anthropic · Claude Opus', 'Claude', 10);

-- A table rename carries its constraints and sequences under their old names.
-- Finish the rename so nothing on these tables still says repo_agent_*: an
-- error naming a constraint should name the table it is on.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
      FROM pg_constraint c
     WHERE c.conrelid IN ('agents'::regclass, 'agent_sessions'::regclass, 'agent_prompts'::regclass,
                          'agent_memories'::regclass, 'agent_memory_revisions'::regclass)
       AND c.conname LIKE 'repo\_agent%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname,
                   regexp_replace(r.conname, '^repo_agent', 'agent'));
  END LOOP;
END $$;
ALTER SEQUENCE IF EXISTS repo_agent_memory_revisions_seq_seq RENAME TO agent_memory_revisions_seq_seq;
