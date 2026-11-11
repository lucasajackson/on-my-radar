-- Agent briefs, slice 2a (blip 2e15ad9d): renaming and deleting a brief, and
-- both of them in the agent's Activity.
--
-- Additive only: one new table, nothing rewritten, safe at boot on a rolling
-- deploy.
--
-- ## Why a table of its own
--
-- Activity tells a brief's story from `agent_brief_revisions` — one row per
-- write. A rename and a delete are not writes of the brief's content, and
-- neither can live there:
--
-- - A rename changes no word of the brief, so it is not a revision. Recording
--   one would bump the revision and the brief's `updated_at`, and every pinned
--   recipient would be told there is an update to take when there is nothing
--   new to read.
-- - A delete cascades the brief's revisions away. Whatever recorded it there
--   would go with them.
--
-- `audit_log` holds both already, but it deliberately has no read path in the
-- product (services/audit.ts): opening one for Activity is a decision about the
-- audit log, not about briefs. So the two events get the narrow record they
-- need — keyed on the agent, not the brief, so a delete outlives the brief.
--
-- ## Columns
--
-- `name` is the brief's name after the event: the new name of a rename, the
-- name of what was deleted. `previous_name` is set exactly for a rename.
-- `revision` is the revision the brief stood at. Authorship mirrors a revision
-- row — cosigner, source, session, tool — so Activity reads both the same way.
-- Authorship and session FKs are DEFERRABLE, as every other agent authorship
-- FK is.
SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_brief_events (
  id            bigserial PRIMARY KEY,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  op            text NOT NULL,
  name          text NOT NULL,
  previous_name text,
  revision      integer NOT NULL,
  source        text NOT NULL,
  author_id     uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  session_id    uuid REFERENCES agent_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  client_label  text,
  harness       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_brief_events_op_valid CHECK (op IN ('rename','delete')),
  CONSTRAINT agent_brief_events_previous_name
    CHECK ((op = 'rename') = (previous_name IS NOT NULL)),
  CONSTRAINT agent_brief_events_source_valid CHECK (source IN ('human','agent','import')),
  CONSTRAINT agent_brief_events_revision_positive CHECK (revision >= 1)
);

-- Activity pages one agent's timeline newest first.
CREATE INDEX agent_brief_events_agent_idx ON agent_brief_events (agent_id, created_at DESC);
-- `purgeIdleSessions` keeps a session that renamed a brief, as it keeps one
-- that wrote a revision; this is the index its NOT EXISTS probes.
CREATE INDEX agent_brief_events_session_idx
  ON agent_brief_events (session_id) WHERE session_id IS NOT NULL;
