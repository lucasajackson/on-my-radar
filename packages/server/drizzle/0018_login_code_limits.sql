-- The login-code rate limit becomes a row, which is what makes it exact.
--
-- It was a count over login_codes -- read, compare, insert -- which is a
-- check-then-act however tightly the statements are packed, and a46e030 could
-- only narrow it. The webhook window (radar_webhooks.window_*, 0002) is the
-- established answer: a self-rolling fixed window charged by one
-- INSERT ... ON CONFLICT DO UPDATE whose CASE arms read the pre-update row, so
-- the reset and the increment cannot disagree and two concurrent requests
-- cannot both see a fresh window. Exact under READ COMMITTED, no transaction,
-- no lock held longer than the statement itself.
--
-- One row per address ever asked for a code. That is attacker-growable in the
-- same way login_codes already is, bounded the same way (six charges roll one
-- row, not six), and a row is three columns; accepted, as it was there.
--
-- The window becomes fixed rather than sliding: six in the hour measured from
-- the first request, worst case ~2x across a boundary. Webhooks accepted the
-- same trade for the same reason -- the limit exists to stop a mailbomb, not
-- to meter fairly.

CREATE TABLE IF NOT EXISTS login_code_limits (
  email              text PRIMARY KEY,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  window_count       integer NOT NULL DEFAULT 1
);
