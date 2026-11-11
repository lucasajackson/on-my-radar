-- Bounded worker sweeps must find expired credentials without scanning live grants.
CREATE INDEX login_code_limits_window_idx ON login_code_limits (window_started_at);
CREATE INDEX oauth_tokens_expiry_idx ON oauth_tokens (expires_at);
CREATE INDEX oauth_tokens_revoked_idx ON oauth_tokens (revoked_at) WHERE revoked_at IS NOT NULL;
