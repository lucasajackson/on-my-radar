-- On My Radar — an index for the radar stream's own sort, and whose words a
-- blip's body is.
--
-- The `captured` stream (every stream, board, microblog, smart radar and public
-- page) orders by `pinned DESC, created_at DESC, id DESC` and pages with the
-- row-value comparison `(pinned, created_at, id) < (…)`. The only index it had
-- was `blips_radar_created_idx (radar_id, created_at DESC, id DESC)`, which
-- cannot serve a sort that `pinned` leads — so every page, first or fiftieth,
-- read every live row of the radar and top-N sorted them. On a 270 000-blip
-- radar that was 213 ms a page; with this index it is an index scan that stops
-- after one page (0.07 ms), and the cursor becomes an index condition.
--
-- `blips_radar_created_idx` stays: it serves `max(created_at)` per radar (the
-- sidebar's "last blip") and the `after:`/`before:` date filters.
--
-- ## Why not CONCURRENTLY
--
-- The migrator runs each file in one transaction, and `CREATE INDEX
-- CONCURRENTLY` refuses to run inside one. Teaching it a non-transactional mode
-- is not worth it for this: a plain CREATE INDEX holds a SHARE lock on `blips`
-- for its duration, which blocks captures and edits (not reads) while it
-- builds. It built in 0.2 s over 300 000 rows locally; production holds a small
-- fraction of that, so the block is milliseconds, inside a rolling deploy.
--
-- ## Not dropped: `blip_reactions_user_idx`
--
-- It was flagged as redundant with the primary key `(blip_id, user_id,
-- reaction)` for the "did I react" lookup, which it is. But it is also the only
-- index leading on `user_id`, and `blip_reactions.user_id` is ON DELETE CASCADE
-- to `users` — so it is what keeps deleting an account from scanning the whole
-- reactions table. It stays.

CREATE INDEX IF NOT EXISTS blips_radar_stream_idx
  ON blips (radar_id, pinned DESC, created_at DESC, id DESC);

-- ===========================================================================
-- Whose words a blip's body is
-- ===========================================================================
--
-- A feed item, an inbound email and a webhook payload are captured through the
-- same `createBlip` a person uses, but their text is somebody else's. Such text
-- addresses nobody (its `@handles` do not resolve into mentions) and its
-- `#hashtags` past the per-blip limit are left in the body rather than refused.
-- Capture knew that; nothing afterwards did, so moving a feed item to another
-- radar re-resolved its handles as if the owner had written them. `authored`
-- records it. A person or agent rewriting the body makes it theirs, and sets it
-- back to true.
--
-- A constant default: a catalogue-only change on PG 11+, no table rewrite.
-- Existing rows are true, which is what they were treated as until now.

ALTER TABLE blips ADD COLUMN IF NOT EXISTS authored boolean NOT NULL DEFAULT true;
