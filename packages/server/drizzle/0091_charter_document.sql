-- The architecture charter becomes one versioned document (plan e715ea20, slice S2).
--
-- Until now a charter was a few `charter`-lane blips, and an ADR amendment was a
-- `:amend[quote]{adr=… with="…"}` marker written into a page's source. Markers did not survive
-- an editor (Milkdown escapes `[` in table cells) and they made every page edit a question of
-- whether it touched one. Now the charter is plain text in `charter_documents`, an amendment (or,
-- later, an element link) is a row in `charter_anchors` that points at a quote in it, and every
-- save re-resolves the anchors: an anchor whose words were changed is `orphaned`, never a refusal.
--
-- DDL only. Nothing here reads or rewrites a single existing row, so it holds no lock beyond the
-- brief ones CREATE TABLE ... REFERENCES takes on radars, blips and users (and CREATE TRIGGER on
-- blips, a SHARE ROW EXCLUSIVE lock for the instant it takes) (queued behind a long
-- transaction at worst, and bounded by the migrator's per-migration lock_timeout with retries).
-- Existing radars are moved into the new shape by `scripts/charter-one-document.ts` (dry run by
-- default) or lazily on first architecture read or write; both run `services/charter.ts`
-- `migrateRadar`, one radar per transaction, and neither deletes a page.
--
-- Rollback: the previous image ignores these tables, and the old pages are left in place.
-- `DROP TRIGGER charter_page_fence_insert/_update/_delete ON blips; DROP FUNCTION
-- charter_page_fence(); DROP TABLE charter_anchor_events, charter_anchors, charter_versions,
-- charter_texts, charter_documents` undoes this file.

-- One row per architecture radar: the head text. `revision` counts every write (the
-- `baseRevision` a full save is checked against); `sealed_version` is the last row of
-- charter_versions.
CREATE TABLE charter_documents (
  radar_id        uuid PRIMARY KEY REFERENCES radars (id) ON DELETE CASCADE,
  body            text NOT NULL DEFAULT '' CHECK (char_length(body) <= 400000),
  revision        integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  sealed_version  integer NOT NULL DEFAULT 0 CHECK (sealed_version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_session uuid,
  -- Who wrote the head: user, connection (a PAT's or OAuth client's id, or the browser session) and
  -- agent. Text written without a seal belongs to this writer until it is sealed, so two
  -- connections of one user are two writers.
  updated_writer  text,
  updated_label   text
);

-- Every distinct text a radar's charter has had, stored once per radar (never across radars, so a
-- hash cannot be used to ask whether some text exists on someone else's). `sha256` is lowercase hex.
CREATE TABLE charter_texts (
  radar_id uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  sha256   text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  body     text NOT NULL CHECK (char_length(body) <= 400000),
  PRIMARY KEY (radar_id, sha256)
);

-- Sealed versions: the full text (by hash), where every anchor stood, and each ADR's lane at the
-- time, so "as of v12" can be drawn exactly as it was. Immutable (see the trigger below).
CREATE TABLE charter_versions (
  radar_id      uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version >= 1),
  sha256        text NOT NULL,
  cause         text NOT NULL CHECK (cause IN ('edit', 'adr', 'anchor', 'migration', 'restore')),
  cause_blip_id uuid REFERENCES blips (id) ON DELETE SET NULL,
  note          text CHECK (char_length(note) <= 500),
  author_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id    uuid,
  harness       text,
  client_label  text,
  -- { "<anchor id>": [start, end] | null }, positions in the projection of that version's text.
  anchors       jsonb NOT NULL DEFAULT '{}',
  -- { "<adr id>": "<lane>" } for every ADR that has an anchor.
  adr_lanes     jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (radar_id, version),
  FOREIGN KEY (radar_id, sha256) REFERENCES charter_texts (radar_id, sha256) ON DELETE CASCADE
);

-- A version is history. The only change the database allows to one is a foreign key being cleared
-- when the blip or the user it names is deleted (ON DELETE SET NULL is an UPDATE).
CREATE FUNCTION charter_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A radar's deletion cascades; nothing else deletes a version.
    IF EXISTS (SELECT 1 FROM radars WHERE id = OLD.radar_id) THEN
      RAISE EXCEPTION 'charter versions are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'cause_blip_id' - 'author_id') IS DISTINCT FROM
     (to_jsonb(OLD) - 'cause_blip_id' - 'author_id')
     OR (NEW.cause_blip_id IS NOT NULL AND NEW.cause_blip_id IS DISTINCT FROM OLD.cause_blip_id)
     OR (NEW.author_id IS NOT NULL AND NEW.author_id IS DISTINCT FROM OLD.author_id) THEN
    RAISE EXCEPTION 'charter versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER charter_versions_immutable BEFORE UPDATE OR DELETE ON charter_versions
FOR EACH ROW EXECUTE FUNCTION charter_versions_immutable();

-- Stand-off anchors. `amend`: an ADR's replacement for a quote (`subject_id` the ADR, `with_text`
-- the replacement). `link`: a charter passage tied to a boundary or contract (built in a later
-- slice; the table carries it now so there is one anchor model). `pos_start`/`pos_end` cache where
-- the quote is in the projection of the head text; `resolved_version` is the last sealed version
-- where it resolved and `orphaned_version` the one that lost it.
CREATE TABLE charter_anchors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id         uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('amend', 'link')),
  subject_id       uuid NOT NULL REFERENCES blips (id) ON DELETE CASCADE,
  with_text        text CHECK (char_length(with_text) <= 600),
  quote            text NOT NULL CHECK (char_length(quote) BETWEEN 1 AND 4000),
  prefix           text NOT NULL DEFAULT '' CHECK (char_length(prefix) <= 64),
  suffix           text NOT NULL DEFAULT '' CHECK (char_length(suffix) <= 64),
  pos_start        integer,
  pos_end          integer,
  state            text NOT NULL CHECK (state IN ('anchored', 'orphaned', 'dismissed')),
  orphan_cause     text CHECK (orphan_cause IN ('text_changed', 'ambiguous', 'diff_not_exact')),
  resolved_version integer NOT NULL CHECK (resolved_version >= 1),
  orphaned_version integer,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'amend') = (with_text IS NOT NULL)),
  CHECK (state <> 'anchored' OR (pos_start IS NOT NULL AND pos_end > pos_start AND pos_start >= 0)),
  CHECK ((state = 'orphaned') = (orphan_cause IS NOT NULL))
);
CREATE INDEX charter_anchors_radar_state_idx ON charter_anchors (radar_id, state);
CREATE INDEX charter_anchors_subject_idx ON charter_anchors (subject_id);

-- Every change of an anchor's standing, for the audit trail and the history of an orphan.
CREATE TABLE charter_anchor_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id   uuid NOT NULL REFERENCES radars (id) ON DELETE CASCADE,
  anchor_id  uuid NOT NULL REFERENCES charter_anchors (id) ON DELETE CASCADE,
  kind       text NOT NULL
             CHECK (kind IN ('created', 'moved', 'orphaned', 'healed', 'reanchored', 'dismissed')),
  version    integer NOT NULL,
  actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
  session_id uuid,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charter_anchor_events_anchor_idx ON charter_anchor_events (anchor_id, created_at);
CREATE INDEX charter_anchor_events_radar_idx ON charter_anchor_events (radar_id);

-- A closing account admits no new writes (0057): refuse a save of its radar's charter. UPDATE only,
-- so the one-time move of an existing radar into this shape (an INSERT) still works for a reader
-- of a radar whose owner is closing.
CREATE TRIGGER account_closure_writer BEFORE UPDATE ON charter_documents
FOR EACH ROW EXECUTE FUNCTION omr_closure_writer_guard('updated_by');

-- The fence for a rolling deploy. Once a radar has a charter document its pages are history: an
-- older pod that still writes them (a page save, a proposal that rewrites a marker) would have its
-- write silently lost, because every read now comes from the document. The database refuses it
-- instead, so the old pod gets an error rather than a success that vanishes. `omr.charter_purge`
-- is set, for one transaction, by `purgeMigratedPages` alone. A radar's own deletion cascades;
-- and a deleted user or agent only ever nulls its reference on a page, which is allowed.
CREATE FUNCTION charter_page_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- An update can change the radar: a blip moved into a migrated radar is fenced as well as one
  -- moved out of it.
  rids uuid[] := CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.radar_id]
                            WHEN 'DELETE' THEN ARRAY[OLD.radar_id]
                            ELSE ARRAY[OLD.radar_id, NEW.radar_id] END;
BEGIN
  IF current_setting('omr.charter_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM charter_documents WHERE radar_id = ANY(rids)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM radars WHERE id = rids[1]) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     -- `search` is generated after BEFORE triggers run, so NEW does not carry its new value yet.
     AND (to_jsonb(NEW) - 'author_id' - 'agent_id' - 'supersedes_id' - 'search') IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'author_id' - 'agent_id' - 'supersedes_id' - 'search')
     AND (NEW.author_id IS NULL OR NEW.author_id IS NOT DISTINCT FROM OLD.author_id)
     AND (NEW.agent_id IS NULL OR NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id)
     AND (NEW.supersedes_id IS NULL OR NEW.supersedes_id IS NOT DISTINCT FROM OLD.supersedes_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'this radar''s charter is one document now; its pages are no longer written'
    USING ERRCODE = '55000', HINT = 'Use write_charter (PUT /radars/:id/charter).';
END $$;
-- Three triggers so each WHEN names only the row it has, and the many blips that are not pages
-- never call the function.
CREATE TRIGGER charter_page_fence_insert BEFORE INSERT ON blips
FOR EACH ROW WHEN (NEW.status = 'charter') EXECUTE FUNCTION charter_page_fence();
CREATE TRIGGER charter_page_fence_update BEFORE UPDATE ON blips
FOR EACH ROW WHEN (OLD.status = 'charter' OR NEW.status = 'charter')
EXECUTE FUNCTION charter_page_fence();
CREATE TRIGGER charter_page_fence_delete BEFORE DELETE ON blips
FOR EACH ROW WHEN (OLD.status = 'charter') EXECUTE FUNCTION charter_page_fence();
