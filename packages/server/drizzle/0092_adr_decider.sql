-- Who decided an ADR, when that was not the person writing it down (charter S3, `decide_adr`).
--
-- An ADR moved onto a radar from a repository's history (or filed after the fact) was decided on
-- a day, by someone. `ratified_at` can already say when (the importer sets it); this says who, as
-- the name the writer gave, kept beside it. NULL is the ordinary case: the ADR was decided when
-- it was written down, by whoever wrote that down, and the audit log names them.
--
-- A nullable column with no default: no table rewrite, and nothing reads or writes an existing row.
-- Rollback: `ALTER TABLE blips DROP COLUMN ratified_by_name`; the previous image ignores it.
ALTER TABLE blips ADD COLUMN ratified_by_name text CHECK (char_length(ratified_by_name) <= 120);
