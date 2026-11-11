-- An agent cannot rewrite its own prompt without its owner accepting (slice S1, ADR-0029).
--
-- A self-edit, an edit from an unidentified connection, and any agent edit while the owner has the
-- prompt locked are stored here as a PROPOSAL; the live prompt (`agents.prompt_version`) does not
-- move until the owner accepts it, which writes the next `agent_prompts` version. `agent_prompts`
-- gains `editor_agent_id`: the agent that made a live edit to ANOTHER agent's prompt.
--
-- Every user, agent and session reference is SET NULL and DEFERRED (deleting one person fires
-- several actions) and stays out of the CHECKs, so a deleted reference never fails the row.
--
-- Rolling-safe: additive. The previous image does not read either and keeps editing live until it
-- is replaced; the sweep of idle sessions it runs only nulls a proposal's `session_id`.
-- Rollback: DROP TABLE agent_prompt_proposals; ALTER TABLE agent_prompts DROP COLUMN editor_agent_id.
CREATE TABLE agent_prompt_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  based_on integer NOT NULL CHECK (based_on >= 0),
  body text NOT NULL,
  note text NOT NULL DEFAULT '',
  editor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  harness text,
  client_label text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  decided_at timestamptz,
  version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (status <> 'accepted' OR version IS NOT NULL)
);
CREATE INDEX agent_prompt_proposals_agent_idx ON agent_prompt_proposals (agent_id, created_at DESC);
CREATE INDEX agent_prompt_proposals_session_idx ON agent_prompt_proposals (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX agent_prompt_proposals_editor_idx ON agent_prompt_proposals (editor_agent_id) WHERE editor_agent_id IS NOT NULL;
CREATE INDEX agent_prompt_proposals_author_idx ON agent_prompt_proposals (author_id) WHERE author_id IS NOT NULL;
CREATE INDEX agent_prompt_proposals_decided_by_idx ON agent_prompt_proposals (decided_by) WHERE decided_by IS NOT NULL;

ALTER TABLE agent_prompts
  ADD COLUMN editor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
