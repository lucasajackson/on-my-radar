-- The marketing site's waitlist form joins the queue approval already works on.
--
-- Additive only: a new table and nothing rewritten, so it is safe at boot on a
-- rolling deploy.
--
-- ## Why a pending user plus a side table, not a waitlist table of its own
--
-- The queue *is* `users WHERE state = 'pending'`: the admin console lists it,
-- approval (`activateUser`) acts on it, and signing in later finds it. A form
-- entry that lived in a separate table would need all three taught about a
-- second queue — and a person who joined through the form and then signed in
-- would appear twice until something merged them. So the form creates the same
-- pending row a first sign-in would, and approval, the approval email and the
-- first sign-in work on it unchanged.
--
-- What the form adds lives beside the row, not on it. Nobody proved they own
-- the address when the form was filled in, so the name typed there is kept as
-- what the form said rather than written into `users.name` — the account's own
-- display name stays the person's to set. And `confirmation_sent_at` is the
-- per-address throttle on the confirmation email, which is the one thing here
-- that sends mail to an address a stranger chose.
CREATE TABLE IF NOT EXISTS waitlist_requests (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name                  text CHECK (name IS NULL OR length(name) <= 120),
  use_case              text CHECK (use_case IS NULL OR use_case IN ('personal', 'team', 'agent_builder')),
  source                text CHECK (source IS NULL OR length(source) <= 64),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  last_requested_at     timestamptz NOT NULL DEFAULT now(),
  confirmation_sent_at  timestamptz
);
