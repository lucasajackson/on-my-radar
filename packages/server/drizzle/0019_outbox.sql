-- The outbox: asynchronous work becomes a row before it becomes an attempt.
--
-- Unfurl, notification delivery, quiet email, and object cleanup were unowned
-- in-process promises -- `void (async () => ...)()` -- which a pod death takes
-- with it, silently and permanently: a blip captured near a deploy never gets
-- its preview, a share email is never sent, deleted attachments leak their
-- objects forever. DESIGN.md 28 argues the shape; the mechanics are a lease
-- queue in the one arbiter this codebase already trusts.
--
-- Claiming is UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) pushing
-- run_after forward by a lease, so a claim is invisible to other drainers for
-- the lease's duration and NO lock or transaction outlives the claim
-- statement itself. A worker that dies mid-job holds nothing: the row
-- resurfaces when its lease lapses and is simply tried again. Completion is
-- DELETE; failure reschedules with backoff and its error; attempts are capped,
-- and a row that exhausts them is deleted loudly rather than left to rot.
--
-- Rows are small on purpose: a job carries ids and addresses, never rendered
-- state that could go stale between enqueue and run.

CREATE TABLE IF NOT EXISTS outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  run_after   timestamptz NOT NULL DEFAULT now(),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The drain's whole question is "what is due", in due order.
CREATE INDEX IF NOT EXISTS outbox_run_after_idx ON outbox (run_after);
