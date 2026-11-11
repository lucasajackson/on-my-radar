-- Who an upload ticket was issued to, so update_blip addAttachments attaches a key only for that
-- user and agent, and only once (the attach deletes the row in its own transaction).
--
-- Rolling-safe: additive. Only the new pods read or write it. A ticket an old pod issued has no row,
-- so a new pod refuses it for addAttachments (400: upload again); create_blip never needs a row.
-- Rows left by unused tickets are inert. Re-runnable. Rollback: DROP TABLE upload_tickets.
CREATE TABLE IF NOT EXISTS upload_tickets (
  object_key text PRIMARY KEY,
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
