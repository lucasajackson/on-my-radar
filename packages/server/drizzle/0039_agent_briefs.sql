-- Agent briefs, slice 1 (blip 2e15ad9d): the third layer of an agent, beside
-- its prompt (who it is) and its memory (what it learned) — the *facts* about
-- the product it works on: how to run, test and deploy it, its invariants and
-- gotchas. On My Radar is the source of truth (Lucas, 2026-10-01); a repo copy
-- in docs/AGENT-BRIEF.md is only ever a one-way mirror (slice 2).
--
-- Additive only: two new tables and nothing rewritten, so it is safe at boot on
-- a rolling deploy.
--
-- ## Shape: a current row plus an append-only revision table
--
-- The memory shape (agent_memories + agent_memory_revisions), not the prompt
-- shape, because an agent holds several briefs, each with its own name and its
-- own revision counter. `agent_briefs` is what is current — the index
-- `load_agent` returns reads it alone, with no join and no body. Every write
-- also appends the full snapshot to `agent_brief_revisions`, which is the
-- history and what a recipient pinned to an earlier acceptance reads.
--
-- `updated_at` on the brief is written with `now()` in the same transaction as
-- the revision row, so the two are the same instant to the microsecond; "has
-- this changed since the recipient accepted?" compares it with
-- `agent_recipients.accepted_at` inside Postgres, never through a JS Date.
--
-- ## Bounds live in the database too
--
-- The name pattern and the length caps match `AGENT_REPO` in the contract. The
-- body cap is the point of a brief — 16 KB of UTF-8, counted in bytes so it
-- means the same in any script, so it cannot grow into a second prompt — and a
-- CHECK keeps a path that skips the zod schema (an import script, a future
-- route) from writing past it.
--
-- ## Locks
--
-- The foreign keys take a brief SHARE ROW EXCLUSIVE lock on `agents`, `users`
-- and `agent_sessions`. The migrator runs each file in its own transaction, so
-- a bounded wait here fails the boot cleanly rather than queueing every request
-- that touches those tables behind a long-running transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_briefs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL,
  body         text NOT NULL,
  revision     integer NOT NULL DEFAULT 1,
  source       text NOT NULL,
  -- Who cosigned the current revision; the revision table keeps the history.
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_briefs_agent_name_key UNIQUE (agent_id, name),
  CONSTRAINT agent_briefs_name_valid
    CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT agent_briefs_description_length CHECK (char_length(description) <= 200),
  CONSTRAINT agent_briefs_body_bytes CHECK (octet_length(body) <= 16384),
  CONSTRAINT agent_briefs_revision_positive CHECK (revision >= 1),
  CONSTRAINT agent_briefs_source_valid CHECK (source IN ('human','agent','import'))
);

CREATE TABLE agent_brief_revisions (
  brief_id     uuid NOT NULL REFERENCES agent_briefs(id) ON DELETE CASCADE,
  revision     integer NOT NULL,
  description  text NOT NULL,
  body         text NOT NULL,
  -- Why this revision was written, as a prompt version carries one.
  note         text NOT NULL DEFAULT '',
  source       text NOT NULL,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  session_id   uuid REFERENCES agent_sessions(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  client_label text,
  harness      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brief_id, revision),
  CONSTRAINT agent_brief_revisions_source_valid CHECK (source IN ('human','agent','import')),
  CONSTRAINT agent_brief_revisions_note_length CHECK (char_length(note) <= 500)
);

-- `purgeIdleSessions` keeps any session that wrote a brief revision; this is
-- the index its NOT EXISTS probes.
CREATE INDEX agent_brief_revisions_session_idx
  ON agent_brief_revisions (session_id) WHERE session_id IS NOT NULL;
