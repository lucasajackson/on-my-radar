-- On My Radar — agent personas.
--
-- An AI gets an identity of its own, which can never act except on behalf of a
-- human. docs/PERSONA.md is the long version; this file carries the reasons that
-- belong to the DDL.
--
-- Every statement here is additive, nullable, or a constraint *weakening*
-- (`mentions.user_id DROP NOT NULL`). Nothing is rewritten, nothing is
-- backfilled, and code that predates this file continues to work against the
-- schema it produces — which is what makes it safe to apply at boot on a
-- rolling deploy where old and new pods overlap.
--
-- ## Why 0015 and not 0012
--
-- This was drafted as `0012_agent_personas.sql` while `0013_radar_theme.sql` and
-- `0014_token_scopes.sql` were still in flight. Both of those merged and applied
-- first, and `migrate.ts` applies **by lexical filename**: a database that had
-- already run 13 and 14 would have run this one after them, while a database
-- built from cold would have run it before — two different orders, both
-- reporting success, and only the second exercising the ordering anybody
-- reviewed. Renumbering costs nothing here because every statement is additive;
-- it would cost a great deal the first time an ordering actually mattered.
--
-- ===========================================================================
-- 1. The principal
-- ===========================================================================
--
-- ## Why this is not a row in `users`
--
-- `users` is keyed on an email address and carries a waitlist state. The
-- invitations work already rejected provisional `users` rows for reasons that
-- apply identically to a bot row: such a row answers `findUserByEmail`, so the
-- next share takes the "they already have an account" branch; it sits in the
-- admin console's waitlist as somebody who has never heard of this application;
-- and `accessPolicyFor` decides its state before anybody asks for one.
--
-- Two more appear once you try it. `users.email` is NOT NULL under a UNIQUE
-- index, so an agent needs a synthetic address — and that address becomes a real
-- key that `shareRadar`'s deliberate invited/added distinction can be made to
-- speak about. And `users.state` would apply: created `pending`, nothing in the
-- codebase can ever activate it (`activateUser` only touches `pending` for a
-- person an admin vouches for) while it sits in the waitlist; created `active`,
-- it is an account with no proof of control and a permanent green light in the
-- same table as every human.
--
-- A separate table makes roughly thirty lookups correct by doing nothing, rather
-- than by remembering a `kind = 'user'` predicate in each of them.
--
-- ## What is deliberately absent
--
--   * **No `email`.** The whole point. With no address there is nothing for
--     `findUserByEmail` to answer and nothing an invitation can be addressed to.
--     An agent is unreachable by address by construction.
--   * **No `state`.** No waitlist, no approval, no suspension of its own. An
--     agent's liveness is derived: it acts only through a live token held by a
--     live owner, and every one of those already has its own revocation.
--   * **No `is_admin`.** `assertMayInvite`, `mayBypassWaitlist` and
--     `requireUser` already refuse a non-`user` actor; this keeps that true even
--     if somebody later relaxes those checks.

CREATE TABLE agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One human, always. A team-owned persona has no single human whose access
  -- bounds it, so its ceiling would become "whoever connected it this time" —
  -- which is a union wearing the costume of an intersection.
  --
  -- CASCADE rather than SET NULL: an ownerless agent is precisely the ownerless
  -- account this design refuses to create. What it wrote survives anyway, via
  -- ON DELETE SET NULL on `blips.agent_id` and `blip_comments.agent_id` — the
  -- same rule authorship already applies when a person is deleted.
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The @handle, normalised by `mentionKey` before it gets here.
  handle      text NOT NULL,
  name        text NOT NULL,
  -- Retired, not deleted. Revoking a token must retire a persona without
  -- erasing what it wrote; the row stays so the name still renders. A retired
  -- agent resolves no handle, receives no notification, and cannot be attached
  -- to a new token.
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Unique per owner, NOT globally. A global handle namespace is a cross-tenant
-- namespace and therefore a probe for which handles are taken, for no benefit.
-- Two people may both call their agent `claude`: `mentionDirectory` already maps
-- a handle two readers answer to onto nobody, and the owner-qualified handle
-- (`lucas.claude`) never collides. Ambiguity resolving to nothing is a rule this
-- table gets to reuse rather than restate.
CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_handle_key ON agents (owner_id, handle);

-- "Which agents does this person have", which is the read behind the mention
-- directory, the derived member rows and the revocation sweep.
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_id);

-- ===========================================================================
-- 2. Authorship: the agent is an additional author, never an alternative one
-- ===========================================================================
--
-- The decision this implements is that an agent can never act except on behalf
-- of a human. So every agent-borne write already has a human behind it, and
-- `author_id` is never null-because-an-agent-wrote-it. `agent_id` sits *beside*
-- it and both are written every time, in both voices.
--
-- That is what makes impersonation in the agent→human direction unrepresentable
-- rather than merely forbidden: there is no column to forge. A mis-granted token
-- can put the wrong name in the larger type on a card; it cannot produce a row
-- indistinguishable from one the human typed. Wave's worst failure was not that
-- words appeared under the wrong name, it was that the result was unrecoverable.
--
-- It also means every existing query that joins `users` on `author_id` keeps
-- working untouched — `canDelete`, the comment edit rule, the notification
-- audience, the "already involved in this thread" set.
--
-- `agent_voice` is the stored rendering choice, and it has to be stored: a
-- reader opening this radar next year has no token to consult, so a row that
-- does not remember which voice was asked for cannot reproduce it.
--
-- ## The CHECK is one-directional, and that is a correction, not a compromise
--
-- The obvious constraint is bidirectional — a voice implies an agent and an
-- agent implies a voice — which would make "a voice with no agent"
-- unrepresentable. It was written that way first and it is WRONG, which running
-- the DDL is the only way to find out.
--
-- `ON DELETE SET NULL` nulls `agent_id` and leaves `agent_voice` behind, because
-- a referential action can only touch the referencing columns. So the moment a
-- persona goes away — its owner's account deleted, which cascades the agent —
-- Postgres would produce a row violating its own CHECK and abort the whole
-- DELETE. Account deletion would fail, and only for accounts whose agent wrote
-- something that survives on somebody else's radar: a data-dependent failure on
-- exactly the path `ON DELETE SET NULL` exists to make safe.
--
-- So the CHECK guards the enum and nothing else. A row with a voice and a null
-- agent is not corrupt, it is informative: an agent wrote this and its principal
-- is gone. That is the same sentence `author_id` already tells when a person is
-- deleted, and this application already prefers it to erasing what was written.
-- `persona.test.ts` asserts the service half — no write path ever produces a
-- voice without an agent — because the schema deliberately no longer can.
--
-- ## …and the FK has to be DEFERRABLE, which only a real Postgres will tell you
--
-- Fixing the CHECK is not enough. `ON DELETE SET NULL` on `agent_id` and
-- `ON DELETE SET NULL` on `author_id` both fire when one person is deleted, and
-- **on an agent-borne row they fire on the same row**: `author_id` is the
-- agent's owner on every write an agent makes, by construction. So deleting that
-- person runs two referential actions against one tuple, plus a CASCADE that
-- removes the `agents` row in between, and a non-deferrable FK check fires
-- against a tuple version that still names an agent Postgres has just deleted:
--
--   ERROR: insert or update on table "blips" violates foreign key constraint
--          "blips_agent_id_fkey"
--   DETAIL: Key (agent_id)=(…) is not present in table "agents".
--
-- The whole DELETE aborts. It is worth being precise about the shape, because
-- the obvious test **passes**: a blip whose author is somebody *else* and whose
-- agent belongs to the deleted person deletes cleanly, since only one action
-- touches the row. The failing case is the one the feature actually produces —
-- author and agent owner are the same human — which is every agent-borne row
-- there is.
--
-- `DEFERRABLE INITIALLY DEFERRED` is what fixes it, and for the reason deferrable
-- constraints exist: the check is queued rather than run inline, and a queued
-- check skips a tuple version that has since been superseded (`SnapshotSelf`
-- liveness in `RI_FKey_check`).
--
-- `INITIALLY IMMEDIATE` was tried first and is **not** enough, which is worth
-- recording because it looks like it is. On a minimal fixture — one user, one
-- radar, one agent, one blip — the end-of-statement check happens to land after
-- the row has been settled and it passes. Add the rest of what a real account
-- owns (a membership row, a comment, an audit row, a token, a notification, a
-- mention) and the same DELETE fails again: the queue is longer, and the check
-- lands on a tuple version that still names the deleted agent. A guarantee that
-- holds only on small fixtures is not a guarantee, so the check goes all the way
-- out to COMMIT.
--
-- The cost is that a dangling `agent_id` written by a bug is reported at COMMIT
-- rather than by the INSERT. That is tolerable here because there is exactly one
-- source for the value — `actor.agent.agentId`, read from a live token row whose
-- own FK already guarantees the agent exists — and because `createBlip`'s
-- transaction commits inside the request either way.

ALTER TABLE blips
  ADD COLUMN agent_id    uuid REFERENCES agents(id)
                              ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN agent_voice text;

ALTER TABLE blips
  ADD CONSTRAINT blips_agent_voice_valid
    CHECK (agent_voice IS NULL OR agent_voice IN ('persona', 'principal'));

ALTER TABLE blip_comments
  ADD COLUMN agent_id    uuid REFERENCES agents(id)
                              ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN agent_voice text;

ALTER TABLE blip_comments
  ADD CONSTRAINT blip_comments_agent_voice_valid
    CHECK (agent_voice IS NULL OR agent_voice IN ('persona', 'principal'));

CREATE INDEX IF NOT EXISTS blips_agent_idx
  ON blips (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS blip_comments_agent_idx
  ON blip_comments (agent_id) WHERE agent_id IS NOT NULL;

-- `blip_reactions` deliberately gets NOTHING.
--
-- Its primary key is (blip_id, user_id, reaction), and that composite is what
-- makes the toggle idempotent with no read-then-write. Adding `agent_id` to the
-- key would let one human's three agents each land the same mark and turn a
-- count of 1 into 3; adding it outside the key breaks the toggle the other way.
-- The interface never shows *who* reacted, so there is nothing an agent column
-- would render. A reaction stays the human's; the audit log records which agent
-- put it there.

-- ===========================================================================
-- 3. Mentions
-- ===========================================================================
--
-- An agent can be addressed by name, and resolution still cannot widen access:
-- candidates are drawn from `radarReaders`, so an agent is a candidate only when
-- its owner can already read the radar — and the agent's ceiling is bounded by
-- that same access. The mention is proof the access exists, never a grant of it.
--
-- `user_id` becomes nullable and `agent_id` joins it under a CHECK, the same
-- idiom `mentions_one_source` already uses for (blip_id, comment_id), so the
-- table keeps one shape and one sweep.

ALTER TABLE mentions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE mentions
  -- CASCADE, matching `user_id`: a mention of a deleted principal means nothing,
  -- and the words in the body survive regardless — this table is the resolution,
  -- not the text.
  ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE mentions
  ADD CONSTRAINT mentions_one_target CHECK ((user_id IS NULL) <> (agent_id IS NULL));

-- These two are load-bearing and are the easiest thing in this file to omit.
--
-- The existing uniqueness is `(blip_id, user_id) WHERE blip_id IS NOT NULL`.
-- Now that `user_id` is nullable, an agent mention carries NULL there — and
-- NULLs do not conflict in a unique index. Without these, re-saving a body that
-- names `@claude` produces a second row every time and notifies the agent again,
-- and `reconcileMentions`'s `onConflictDoNothing` silently does nothing to stop
-- it. The predicate must name `agent_id IS NOT NULL` for the same reason the
-- existing pair names `blip_id IS NOT NULL`.
CREATE UNIQUE INDEX IF NOT EXISTS mentions_blip_agent_idx
  ON mentions (blip_id, agent_id) WHERE agent_id IS NOT NULL AND blip_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mentions_comment_agent_idx
  ON mentions (comment_id, agent_id) WHERE agent_id IS NOT NULL AND comment_id IS NOT NULL;

-- "What has addressed this agent lately", and the revocation sweep's index.
CREATE INDEX IF NOT EXISTS mentions_agent_idx
  ON mentions (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;

-- ===========================================================================
-- 4. Notifications
-- ===========================================================================
--
-- Notifying an agent is not email and not push — it is an unread queue drained
-- on connect, which `list_notifications` already provides.
--
-- **`user_id` stays NOT NULL and stays the agent's OWNER.** This is the detail
-- most likely to be got wrong. The coalescing rule in this application is the
-- partial unique index `(user_id, group_key) WHERE read_at IS NULL` from
-- 0004 — it lives in the database precisely so two events arriving at once
-- cannot produce two rows. Making `user_id` nullable to hold an agent's queue
-- would mean agent rows never conflict (NULL against NULL), so coalescing would
-- silently stop working for agents while continuing to work for humans: the
-- index still present, still looking correct, and doing nothing.
--
-- Instead the row is stored against the owner with `agent_id` set, and the
-- *group key* is namespaced by the service — `agent:<id>:mention:comment:<id>`
-- against a human's `mention:comment:<id>`. No index change, no new conflict
-- arbiter, and the two key spaces can never meet.

ALTER TABLE notifications
  ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE CASCADE;

-- The persona's queue, and the sweep that runs when its owner loses a radar.
CREATE INDEX IF NOT EXISTS notifications_agent_idx
  ON notifications (agent_id, created_at DESC, id) WHERE agent_id IS NOT NULL;

-- ===========================================================================
-- 5. Audit
-- ===========================================================================
--
-- `actor_kind` already records that an agent did something. With personas it can
-- record *which*, which is the difference between "an agent" and "the connection
-- Lucas named Claude on 27 August". Historical rows stay NULL: no agent existed
-- when they were written, and inventing one to attribute them to would put a
-- name in a record that was never chosen.

-- DEFERRABLE for exactly the reason `blips.agent_id` is: `audit_log.actor_id` is
-- also `ON DELETE SET NULL`, so an audit row written by an agent has both of its
-- principal columns pointing at the same human, and deleting that human runs two
-- referential actions plus a CASCADE against one tuple.
ALTER TABLE audit_log
  ADD COLUMN agent_id uuid REFERENCES agents(id)
                           ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

-- ===========================================================================
-- 6. The voice grant on tokens
-- ===========================================================================
--
-- The token grants which voices are permitted; the call picks among them. Same
-- shape as the scopes 0014 introduced — the human grants a range and the agent
-- exercises within it — so a token minted persona-only can never speak as the
-- human, whatever it is asked to do.
--
-- OAuth tokens carry this in `scope` (`voice:persona`, `voice:principal`),
-- because `scope` is already their grant channel, is already enforced as of
-- 0014, and the consent screen already renders it and is never auto-approved.
-- Personal access tokens have a `scope` column as of 0014 but no screen that
-- offers a choice on it, and voices are not a *ceiling on access* — they are a
-- rendering grant — so folding them into that same string would conflate two
-- different questions in one column. They get columns.
--
-- ## Nothing live changes behaviour, and no row is rewritten
--
-- The default for anything minted *after* this ships is `persona`: speaking as
-- the human is the more consequential mode and should be the one somebody chose.
-- But flipping it under a token already in use would change whose name appears
-- on live content, so:
--
--   * the column DEFAULTs below are today's behaviour, which is what the ALTER
--     writes into every pre-existing row — no UPDATE, and no pretence that a
--     human consented to something they did not;
--   * `createToken` applies the new default only when it mints a new one;
--   * for OAuth, the *absence* of any `voice:` scope is read in code as "this
--     token predates the model": both voices permitted, default `principal`. No
--     data migration at all, and the same shape as `scope_consented` in 0014.

ALTER TABLE api_tokens
  -- SET NULL, not CASCADE: retiring or deleting a persona must not silently
  -- revoke a working connection. The token drops to principal-only, which is
  -- exactly what a token with no persona means — `bearer.ts` collapses the
  -- grants when it resolves a row whose agent has gone.
  ADD COLUMN agent_id      uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN voice_grants  text[] NOT NULL DEFAULT ARRAY['principal']::text[],
  ADD COLUMN default_voice text   NOT NULL DEFAULT 'principal';

-- `cardinality`, not `array_length`. `array_length(ARRAY[]::text[], 1)` is NULL,
-- not 0, so `>= 1` evaluates to NULL — and a CHECK that evaluates to NULL
-- PASSES. Written that way the empty array slips through this constraint
-- entirely and is only caught by its sibling below, which is a constraint
-- holding by luck rather than by saying what it means. `cardinality` returns 0.
ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_voice_grants_valid CHECK (
    voice_grants <@ ARRAY['persona', 'principal']::text[]
    AND cardinality(voice_grants) >= 1
  );

-- Row-local and immutable, so this is a real CHECK rather than a service-layer
-- convention: a token cannot default to a voice it was not granted, and the
-- database is what says so.
ALTER TABLE api_tokens
  ADD CONSTRAINT api_tokens_default_voice_granted CHECK (default_voice = ANY (voice_grants));

-- The persona is chosen at the moment the connection is authorized — on the
-- consent screen, which already names the client and is never auto-approved.
-- The decision endpoint stamps the code; the token endpoint copies it forward
-- exactly as it already copies `scope` and `scope_consented`.
ALTER TABLE oauth_codes
  ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE oauth_tokens
  ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS api_tokens_agent_idx
  ON api_tokens (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_tokens_agent_idx
  ON oauth_tokens (agent_id) WHERE agent_id IS NOT NULL;
