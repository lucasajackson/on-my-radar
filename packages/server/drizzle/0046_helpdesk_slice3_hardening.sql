-- Helpdesk slice 3 hardening: two of qa-reviewer's minors that live in the
-- database (docs/HELPDESK.md §3.5, §5.1).
--
-- ## 1. The 90-day bound is absolute, not calendar
--
-- 0045 wrote `expires_at <= COALESCE(rotated_at, created_at) + interval '90 days'`.
-- Adding a day-interval to a timestamptz is calendar arithmetic in the
-- *session's* TimeZone: across a daylight-saving change in America/New_York,
-- "90 days" is 2161 hours in the autumn and 2159 in the spring. So the bound
-- moved with whoever's session evaluated it, and a CHECK is re-evaluated on
-- every UPDATE of the row: an integration minted in a UTC session (exactly
-- 2160 h) and then touched from a New York session across a spring change
-- (a revoke, or the last-used stamp on every call, which swallows its error)
-- was refused by its own constraint. Hours are absolute, so the bound is now
-- 2160 hours whatever the session's zone, and the service writes the same.
--
-- A row written under the old reading in an autumn-crossing zone could be up
-- to an hour over the new bound; it is brought back to it first, which only
-- ever shortens a credential's life.
--
-- ## 2. A request belongs to the integration that filed it
--
-- Requests are now scoped by integration as well as by account (a staging and
-- a production portal enrolled on one radar are separate namespaces). The
-- trigger that keeps a request's requester fixed now keeps its integration
-- fixed too, except for the `ON DELETE SET NULL` an account deletion performs.
-- The account index leads with the integration, which every lookup now names.

UPDATE integrations
   SET expires_at = COALESCE(rotated_at, created_at) + interval '2160 hours'
 WHERE expires_at > COALESCE(rotated_at, created_at) + interval '2160 hours';

ALTER TABLE integrations DROP CONSTRAINT integrations_expiry_at_most_90d;
ALTER TABLE integrations
  ADD CONSTRAINT integrations_expiry_at_most_90d
    CHECK (expires_at <= COALESCE(rotated_at, created_at) + interval '2160 hours');

CREATE OR REPLACE FUNCTION omr_helpdesk_requests_requester_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.blip_id <> OLD.blip_id
     OR NEW.requester_ref <> OLD.requester_ref
     OR NEW.requester_account_ref <> OLD.requester_account_ref
     OR (NEW.integration_id IS DISTINCT FROM OLD.integration_id
         AND NEW.integration_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a request belongs to the requester, account and integration that filed it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX helpdesk_requests_account_idx;
CREATE INDEX helpdesk_requests_account_idx
  ON helpdesk_requests (integration_id, requester_account_ref);
