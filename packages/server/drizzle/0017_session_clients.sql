-- Sessions learn which client holds them, so a session token can be a bearer
-- credential instead of a cookie.
--
-- The cookie was never the authority model; it was the browser's container for
-- the authority. A client that is not a browser needs a different container --
-- a keychain, an EncryptedSharedPreferences -- and the credential inside it is
-- the same session row it always was. That is why this is two columns rather
-- than a new table: `assertHumanDecision` distinguishes a person from a
-- delegate, and somebody signed into a first-party client is a person. A
-- separate credential family would have had to argue its way back to exactly
-- that conclusion.
--
-- `client` defaults to 'web' so every row that already exists is what it always
-- was, and nothing has to be backfilled.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'web';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS label text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_client_valid'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT sessions_client_valid
      CHECK (client IN ('web', 'ios', 'android', 'cli'));
  END IF;
END $$;

-- The device list is "my sessions, newest first", and it is the only query
-- these columns add.
CREATE INDEX IF NOT EXISTS sessions_user_created_idx
  ON sessions (user_id, created_at DESC);
