-- On My Radar — the drop box is never public, and it is a stream or a board.
--
-- Two rules, and they are enforced in deliberately different places. The split
-- is the interesting part of this migration, so it is written down rather than
-- left to be inferred from what is here and what is not.
--
-- ## 1. A drop box has no public address. Enforced here.
--
-- The drop box is the per-account holding bay for things with no home yet —
-- appointments, reminders, "call the plumber", the half-thought you had in the
-- car. It is a *private inbox*, and it is the one radar in the application
-- whose contents nobody chose to put anywhere. Publishing it is not a sharing
-- decision that happens to be unwise; it is a category error, in the same way
-- that filing it under a topic is (`radars_drop_box_is_never_in_a_topic`, 0005).
--
-- Both halves of "public" are refused, not just the flag:
--
--   * `visibility = 'public'` is what the public routes read, and
--   * `public_slug` is the identifier those routes are reached by.
--
-- Constraining only the flag would leave a drop box able to carry a minted
-- slug — a dormant public address on a private inbox, one UPDATE away from
-- working. `setVisibility` mints a slug on the way out and *keeps* it on the way
-- back in, precisely so that re-publishing restores the same URL, so a slug
-- outliving the flag is the normal case for every other radar. Here it must
-- never exist at all, and saying so in SQL makes "a drop box has no public
-- address" a fact about the database rather than a property of the code paths
-- that happen to exist today.
--
-- Backed by refusals in `setVisibility` and `rotatePublicSlug` so the caller
-- gets a sentence rather than a constraint violation. The constraint is what
-- makes it true; the service refusal is what makes it legible.
--
-- ## 2. A drop box is a stream or a board. Deliberately NOT enforced here.
--
-- The set of templates a drop box may take is decided by the registry in
-- `packages/contract/src/templates.ts`, where each template declares whether it
-- can serve as an undifferentiated inbox (`inbox: true`). That is the same
-- arrangement `blips.status` already has and for the same stated reason: the
-- template vocabulary lives in one TypeScript file so that shipping a new
-- template is one declaration and no migration. A CHECK naming 'stream' and
-- 'kanban' would quietly revoke that — the day a sixth template is a good inbox,
-- adding it would need a schema change, and the constraint would be a second
-- place for the answer to live and therefore a second place for it to be wrong.
--
-- What this migration does instead is the one thing a registry cannot: repair
-- the rows that already exist. Anything else is the service layer's job, and it
-- refuses on every entry path (`createRadar`, `updateRadar`) exactly as if a
-- constraint were behind it.

-- ---------------------------------------------------------------- repair --

-- Any drop box that was published loses its public address. Recorded as a
-- distinct statement from the constraint below so that a database where this
-- actually changes rows is visible in the migration output rather than silent.
--
-- As of 2026-08-26 production holds exactly one drop box: private, no slug, no
-- members, no webhooks, template 'stream'. This revokes nothing there. It is
-- written for the installs where that is not true.
UPDATE radars
   SET visibility = 'private',
       allow_index = false,
       public_slug = NULL,
       updated_at = now()
 WHERE is_drop_box = true
   AND (visibility <> 'private' OR public_slug IS NOT NULL OR allow_index = true);

-- A drop box on a template that cannot serve as an inbox is moved to the stream
-- rather than left to render through a layout that frames every appointment as a
-- decision or every reminder as a thread. Non-destructive, like every other
-- template switch: `blips.status` values the stream does not know are kept and
-- simply not shown, so moving the radar back restores the board exactly.
--
-- The pair is spelled out here because a migration cannot import the registry.
-- It is a snapshot of `RADAR_TEMPLATES[…].inbox` at the time this shipped, not a
-- second source of truth: nothing reads this list afterwards.
UPDATE radars
   SET template = 'stream',
       updated_at = now()
 WHERE is_drop_box = true
   AND template NOT IN ('stream', 'kanban');

-- ------------------------------------------------------------ constraints --

ALTER TABLE radars
  ADD CONSTRAINT radars_drop_box_is_never_public
    CHECK (NOT (is_drop_box = true AND visibility = 'public'));

ALTER TABLE radars
  ADD CONSTRAINT radars_drop_box_has_no_public_slug
    CHECK (NOT (is_drop_box = true AND public_slug IS NOT NULL));
