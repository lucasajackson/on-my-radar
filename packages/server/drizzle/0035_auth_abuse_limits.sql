-- Two unbounded surfaces on the unauthenticated edge get a bound.
--
-- Every statement is additive or a backfill of a new column, so this is safe
-- to apply at boot on a rolling deploy: an old pod never reads either.
--
-- ## 1. oauth_clients.last_used_at, so registrations can be swept
--
-- Dynamic client registration (RFC 7591) is open by design — an MCP client
-- registers itself before anybody has signed in — so anyone can add a row,
-- and nothing ever removed one. `last_used_at` is bumped whenever the client
-- redeems a code or rotates a refresh token (`routes/oauth.ts`), and the
-- worker's auth sweep deletes a client only when BOTH hold:
--
--   * it is idle: never used and registered more than 30 days ago, or last
--     used more than 180 days ago; and
--   * it holds nothing live: no unrevoked access token inside its lifetime, no
--     refresh token inside its window, no unredeemed code.
--
-- The 180 days is what keeps a legitimate client working when it comes back
-- with a cached client_id after an idle stretch. Its refresh token dies after
-- 30 days, so a returning client re-authorizes with the id it registered —
-- deleting that id would turn "sign in again" into "Unknown client". Six
-- months covers a connector installed and forgotten over a long break.
--
-- The backfill is deliberately generous. A client's history before this column
-- existed is only partly recoverable (token rows are swept 37 days after they
-- die), and a client with no surviving token is indistinguishable from one
-- that was never used. Treating those as never-used would delete connectors in
-- real use on the first sweep, so every existing row is counted as used at
-- migration time: the pre-existing population gets the full 180-day window,
-- and only registrations from here on can meet the 30-day never-used rule.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

UPDATE oauth_clients SET last_used_at = now() WHERE last_used_at IS NULL;

-- The sweep's NOT EXISTS probes, which had no index on client_id.
CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx ON oauth_tokens (client_id);
CREATE INDEX IF NOT EXISTS oauth_codes_client_idx ON oauth_codes (client_id);
CREATE INDEX IF NOT EXISTS oauth_clients_idle_idx ON oauth_clients (COALESCE(last_used_at, created_at));

-- ## 2. login_code_network_limits, a per-network ceiling on code requests
--
-- The per-address ceiling (0018) stops a mailbomb of one address. It does not
-- stop one caller asking for codes for many addresses — spraying invitations
-- to sign in, or burning other people's hourly allowance so they are locked
-- out of their own account. This is the same self-rolling fixed window keyed
-- by the caller's network instead: an IPv4 address, or an IPv6 /64 (one
-- subscriber's allocation, which a single host can rotate through freely).
--
-- The network comes only from CF-Connecting-IP, the header Cloudflare sets
-- and overwrites; see `clientIp` in http.ts. Where it is absent there is no
-- network to key on and only the per-address ceiling applies.
CREATE TABLE IF NOT EXISTS login_code_network_limits (
  network            text PRIMARY KEY,
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  window_count       integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS login_code_network_limits_window_idx
  ON login_code_network_limits (window_started_at);
