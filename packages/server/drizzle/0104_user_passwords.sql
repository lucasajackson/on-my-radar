-- Password sign-in for self-hosted instances (PASSWORD_LOGIN_ENABLED). One scrypt hash per user, in
-- its own table so the hash never rides in a users row, an actor or a DTO.
--
-- Rolling-safe: additive. The previous image never reads or writes it, and with the flag off nothing
-- does. Re-runnable. Rollback: DROP TABLE user_passwords.
CREATE TABLE IF NOT EXISTS user_passwords (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
