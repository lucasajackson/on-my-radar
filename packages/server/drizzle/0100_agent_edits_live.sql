-- Prompt gate (ADR-0031): another agent's prompt edit goes live only on an agent whose owner opted in.
--
-- One row here is the owner's opt-in for that TARGET agent; no row (the default) means another
-- agent's edit to its prompt or tool profile is a proposal the owner accepts, as the lock made it.
-- The owner sets it in a signed-in browser session; no agent tool or token can.
--
-- A new table rather than a column on `agents`, so it rolls out safely: the previous image's
-- account-export collector fails closed on any unclassified column of a table it knows, but skips a
-- table created by a migration it has never seen (`imageMigrationTables`), so exports keep working
-- while this rolls out and after an image-only rollback. Nothing in the previous image reads it;
-- until it is replaced it still lets a sibling's edit go live, the behaviour being tightened.
-- Rollback: DROP TABLE agent_live_edit_optins.
CREATE TABLE IF NOT EXISTS agent_live_edit_optins (
  agent_id   uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A closing account admits no new writes (0057); the guard walks the foreign key to the agent's owner.
DROP TRIGGER IF EXISTS account_closure_writer ON agent_live_edit_optins;
CREATE TRIGGER account_closure_writer BEFORE INSERT OR UPDATE ON agent_live_edit_optins
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard();
