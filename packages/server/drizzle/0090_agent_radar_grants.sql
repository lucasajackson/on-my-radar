-- Per-radar least privilege for agents (plan 161d7453, T4).
--
-- An agent has always reached everything its owner reaches, capped by the scope of the
-- token it runs on. `radar_scope = 'selected'` adds one more cap: the agent reaches only the
-- radars listed in `agent_radar_grants`, each at no more than its ceiling. The default is
-- `all`, which is today's behaviour, so applying this changes what no existing agent can do.
--
-- Additive and re-runnable. The column has a constant default, so Postgres adds it without
-- rewriting `agents` or firing its row triggers (`account_closure_writer`, 0057).
--
-- Nothing here grants anything: the clamp in access.ts only ever takes access away, and a
-- grant on a radar its owner cannot read reaches nothing, exactly as a shared radar does.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS radar_scope text NOT NULL DEFAULT 'all'
  CHECK (radar_scope IN ('all', 'selected'));

CREATE TABLE IF NOT EXISTS agent_radar_grants (
  agent_id   uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  radar_id   uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  -- The strongest role the agent may hold on the radar: viewer, editor or owner, in the
  -- vocabulary of token scopes (radars:read, radars:write, radars:manage).
  ceiling    text NOT NULL CHECK (ceiling IN ('read', 'write', 'manage')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, radar_id)
);
-- The other direction: what a deleted or unshared radar takes with it, and the join the
-- admin inventory counts by.
CREATE INDEX IF NOT EXISTS agent_radar_grants_radar_idx ON agent_radar_grants (radar_id);

-- A closing account admits no new writes (0057). The guard walks the foreign keys to the
-- owner of the agent and the radar, so it needs no column list.
DROP TRIGGER IF EXISTS account_closure_writer ON agent_radar_grants;
CREATE TRIGGER account_closure_writer BEFORE INSERT OR UPDATE ON agent_radar_grants
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard();

-- A limited agent that a connection has loaded narrows that connection for as long as the
-- credential lives: a person's own sign-in (agent-setup login) is not minted for the agent, so
-- the agent's limit has to follow the credential, and it must not lapse with the load session
-- (which idles out and is deleted when an agent is revoked). One row per credential and agent;
-- the agent's `radar_scope` is read live, so the limit lifts only when its owner sets `all`.
-- `connection_id` is a PAT's id, or an OAuth connected app's client id (with `user_id`, the grant).
--
-- Deleting the agent does NOT delete the row: `agent_id` goes to NULL, which means "this
-- credential was limited by an agent that is gone". Such a credential is refused, never
-- treated as unrestricted (the same rule as `agent_bound`, 0087). Deleting the agent revokes
-- its carriers as well, so this is the backstop for one that slips through.
CREATE TABLE IF NOT EXISTS connection_agent_fences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connection_kind text NOT NULL CHECK (connection_kind IN ('pat', 'oauth')),
  connection_id   text NOT NULL,
  agent_id        uuid REFERENCES agents (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connection_agent_fences_key
  ON connection_agent_fences (user_id, connection_kind, connection_id, agent_id);
CREATE INDEX IF NOT EXISTS connection_agent_fences_agent_idx ON connection_agent_fences (agent_id);
CREATE INDEX IF NOT EXISTS connection_agent_fences_credential_idx
  ON connection_agent_fences (user_id, connection_kind, connection_id);

-- Off while it is filled, so a closed account's history does not trip the closure guard (0057).
DROP TRIGGER IF EXISTS account_closure_writer ON connection_agent_fences;

-- Every credential that has already loaded an agent before this ran carries that agent's limit
-- from the moment the owner sets one. Without this, such a connection would stay unrestricted.
INSERT INTO connection_agent_fences (user_id, connection_kind, connection_id, agent_id)
SELECT DISTINCT s.user_id, s.connection_kind, s.connection_id, s.agent_id
  FROM agent_sessions s
 WHERE s.connection_kind IN ('pat', 'oauth')
ON CONFLICT DO NOTHING;

CREATE TRIGGER account_closure_writer BEFORE INSERT OR UPDATE ON connection_agent_fences
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard('user_id');
