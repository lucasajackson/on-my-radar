-- An agent's reaction is the agent's, beside the person's (eval S4).
--
-- Until now a reaction was keyed (blip, user, reaction), so an agent's mark landed as its owner's and
-- could not coexist with theirs. `agent_id` NULL is the person; set, it is that agent. The key
-- becomes a unique index that treats NULL as a value, so one person and each of their agents hold one
-- mark apiece. Deleting an agent deletes its marks (SET NULL would collide with the person's own).
--
-- Rolling-safe: the previous image inserts with a targetless ON CONFLICT DO NOTHING, which any unique
-- index satisfies, and writes agent_id NULL, as a person. Its DELETE of a mark by (blip, user,
-- reaction) can also take that person's agents' marks for the same reaction: a mark lost during the
-- rollout window, never a duplicate. The index is built before the primary key goes, in one
-- transaction, so uniqueness is never absent. Every statement is re-runnable.
-- Rollback: DROP INDEX blip_reactions_mark_key; DELETE the agent rows; ADD PRIMARY KEY (blip_id,
-- user_id, reaction); DROP COLUMN agent_id.
ALTER TABLE blip_reactions
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS blip_reactions_mark_key
  ON blip_reactions (blip_id, user_id, reaction, agent_id) NULLS NOT DISTINCT;

ALTER TABLE blip_reactions DROP CONSTRAINT IF EXISTS blip_reactions_pkey;
