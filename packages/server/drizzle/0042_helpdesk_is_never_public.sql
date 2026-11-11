-- A helpdesk radar is never public (docs/HELPDESK.md §6.1).
--
-- It is the one template whose comments include internal notes about an
-- outside client, so a public link would hand those notes to anybody holding
-- the URL. `setVisibility` refuses to publish one, `updateRadar` refuses to turn
-- a public radar into one, `getRadarAccess` never honours a public link on one,
-- and the public routes refuse to serve one. This constraint is what stands
-- behind all four, for the same reason `radars_smart_is_never_public` (0002)
-- stands behind the smart-radar refusal: an agent over MCP or REST will try
-- every path, and a path nobody has written yet has no refusal in it.
--
-- The template id is written here literally. The registry, not SQL, owns the
-- template vocabulary (`blips.status` and `radars.template` are deliberately
-- unconstrained), and a constraint is the one place that cannot read it — so a
-- second client-facing template would add its own line here. No existing row
-- can violate this: the `helpdesk` template ships in the same release.
ALTER TABLE radars
  ADD CONSTRAINT radars_helpdesk_is_never_public
    CHECK (NOT (template = 'helpdesk' AND visibility = 'public'));
