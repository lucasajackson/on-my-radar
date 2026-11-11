-- On My Radar — token scopes become a thing the database records.
--
-- Until now `resolveBearerToken` computed a scope for every bearer token and
-- `attachActor` threw it away. `Actor` had no scope field and no service read
-- one, so the scope on an OAuth grant was decoration: every connected agent
-- acted at the full breadth of its human's access no matter what the grant said.
-- This migration gives the two token families somewhere to keep an answer that
-- is now enforced, and — more importantly — a way to say *"there is no answer
-- here"* for the tokens that are already live.
--
-- ## Why two different shapes for two token tables
--
-- They are asymmetric because their histories are.
--
-- **`api_tokens` never had a scope at all.** `resolveApiToken` returned the
-- literal string 'radars:read radars:write' for every PAT ever minted. Nobody
-- was ever shown that string, no UI ever offered a choice, and nothing ever read
-- it — a PAT could delete radars and manage webhooks, which that string does not
-- describe. So there is no consent record to preserve here, only a behaviour,
-- and the honest column default is the behaviour: the full set. Backfilling
-- every existing PAT to the full set is not rewriting anybody's decision,
-- because no decision was ever recorded.
--
-- **`oauth_tokens.scope` has held a real string since the OAuth server shipped**
-- — whatever the client asked for, or 'radars:read radars:write' when it asked
-- for nothing. That string was *never enforced and never displayed*: the consent
-- screen showed three fixed sentences describing full access and offered no way
-- to narrow anything. Enforcing those strings retroactively would silently
-- withdraw `radars:manage` from every live grant — the five manage-level MCP
-- tools would start failing on connections nobody touched — on the strength of a
-- number the user never saw. Rewriting them to the full set instead would
-- destroy the only record of what each client asked for.
--
-- So neither. A new flag records the thing that actually distinguishes them:
--
--   scope_consented = false  →  these scopes were never put in front of a human.
--                               Unenforceable. The token keeps the access it has
--                               today, which is its owner's full access.
--   scope_consented = true   →  a human saw these scopes named on the consent
--                               screen and approved them. The ceiling is real.
--
-- Existing rows take the default `false` and are untouched. Every grant minted
-- from here on sets `true`, and refresh-token rotation carries the flag forward
-- from the row it replaces rather than re-deriving it — otherwise a legacy grant
-- would silently become enforced the first time it refreshed, an hour later,
-- which is the same regression by a slower route.
--
-- The flag is on `oauth_tokens` and not on `oauth_codes` on purpose: an
-- authorization code lives five minutes, so the only codes that can outlive this
-- migration are ones minted minutes before it. Those are treated as consented,
-- at whatever scope the client requested. The exposure is one deploy window
-- wide, and its worst outcome is that somebody who connected an agent seconds
-- before the deploy has to connect it again.
--
-- ## Why not a nullable scope column on both
--
-- Considered and rejected. NULL-means-legacy reads well on `api_tokens`, where
-- the column is new, but on `oauth_tokens` it would mean nulling out strings
-- that are already there — deleting the record of what each client asked for in
-- order to express "we are not enforcing it". A boolean beside the string says
-- the same thing and keeps the string.

ALTER TABLE api_tokens
  ADD COLUMN scope text NOT NULL DEFAULT 'radars:read radars:write radars:manage';

ALTER TABLE oauth_tokens
  ADD COLUMN scope_consented boolean NOT NULL DEFAULT false;

-- Documented above; repeated here because the next person to read this file may
-- well be reading only the DDL.
COMMENT ON COLUMN api_tokens.scope IS
  'Space-separated token scopes. Backfilled to the full set: a PAT has always acted at its owner''s full access.';
COMMENT ON COLUMN oauth_tokens.scope_consented IS
  'True when `scope` was named on the consent screen and is therefore enforceable. False on grants predating scope enforcement, which keep their owner''s full access.';
