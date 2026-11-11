-- Agent briefs, slice 2b (blip 2e15ad9d): a brief bound to a repository path,
-- the "N commits behind" flag, and the optional one-way mirror.
--
-- Additive only: one new table, nothing rewritten, safe at boot on a rolling
-- deploy. Old pods never read it.
--
-- ## One row per bound brief
--
-- Keyed on the brief's id, not its name, so a rename keeps the binding and a
-- delete takes it with it (the cascade). The binding itself — project, path,
-- ref, mirror — is what the owner chose. Everything below it is what the
-- worker last *observed* in GitLab: not derivable from anything in this
-- database, so it is stored, and every reader treats it as an observation
-- with a time (`checked_at`) and the brief revision it was measured against
-- (`checked_revision`). A reader that finds `checked_revision` behind the
-- brief's revision says "not checked" rather than showing a count for a
-- revision that is no longer current: that part is computed, not stored.
--
-- ## The checker's claim
--
-- The worker claims a due row by setting `checked_at = now()` under
-- `FOR UPDATE SKIP LOCKED`, commits, then talks to GitLab outside any
-- transaction. A worker that dies mid-check leaves the row looking freshly
-- checked; it is due again on the hourly sweep. Due-ness compares timestamps
-- in Postgres, never in JS.
SET LOCAL lock_timeout = '5s';

CREATE TABLE agent_brief_bindings (
  brief_id          uuid PRIMARY KEY REFERENCES agent_briefs(id) ON DELETE CASCADE,
  project           text NOT NULL,
  path              text NOT NULL,
  ref               text NOT NULL,
  mirror            boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- The last look at the bound path.
  checked_at        timestamptz,
  checked_revision  integer,
  -- ok: measured. unconfigured: this server cannot check it (no token for the
  -- project, or the agent's owner may not use the server's tokens). failed:
  -- GitLab refused or did not answer.
  check_state       text,
  check_error       text,
  commits_behind    integer,
  behind_capped     boolean NOT NULL DEFAULT false,

  -- The mirrored file as found at `ref`: the newest revision whose mirror has
  -- landed there, and the commit that edited it by hand if one did.
  landed_revision   integer,
  drift_kind        text,
  drift_sha         text,
  drift_title       text,
  drift_at          timestamptz,
  drift_url         text,

  -- The merge request the mirror last opened or updated.
  mirror_revision   integer,
  mirror_state      text,
  mirror_error      text,
  mirror_mr_url     text,

  CONSTRAINT agent_brief_bindings_project_length CHECK (char_length(project) BETWEEN 3 AND 255),
  CONSTRAINT agent_brief_bindings_path_length CHECK (char_length(path) BETWEEN 1 AND 1024),
  CONSTRAINT agent_brief_bindings_ref_length CHECK (char_length(ref) BETWEEN 1 AND 255),
  -- A mirror writes one file.
  CONSTRAINT agent_brief_bindings_mirror_file CHECK (NOT mirror OR right(path, 1) <> '/'),
  CONSTRAINT agent_brief_bindings_check_state_valid
    CHECK (check_state IS NULL OR check_state IN ('ok', 'unconfigured', 'failed')),
  -- Drift is one of two kinds; the commit that caused it is named only when
  -- there is drift to name it for.
  CONSTRAINT agent_brief_bindings_drift_kind_valid
    CHECK (drift_kind IS NULL OR drift_kind IN ('edited', 'deleted')),
  CONSTRAINT agent_brief_bindings_drift_commit_needs_kind
    CHECK (drift_kind IS NOT NULL OR (drift_sha IS NULL AND drift_title IS NULL)),
  CONSTRAINT agent_brief_bindings_mirror_state_valid
    CHECK (mirror_state IS NULL OR mirror_state IN ('opened', 'failed')),
  CONSTRAINT agent_brief_bindings_behind_nonnegative
    CHECK (commits_behind IS NULL OR commits_behind >= 0),
  CONSTRAINT agent_brief_bindings_check_error_length
    CHECK (check_error IS NULL OR char_length(check_error) <= 500),
  CONSTRAINT agent_brief_bindings_mirror_error_length
    CHECK (mirror_error IS NULL OR char_length(mirror_error) <= 500)
);

-- The worker's due scan: never-checked first, then oldest.
CREATE INDEX agent_brief_bindings_due_idx ON agent_brief_bindings (checked_at NULLS FIRST);
