-- The original email belongs to the blip, not its temporary ingestion receipt.
ALTER TABLE blips ADD COLUMN email_notes text NOT NULL DEFAULT '' CHECK (length(email_notes) <= 10000);
ALTER TABLE blips DROP COLUMN search;
ALTER TABLE blips ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', omr_tags_text(tags)), 'B') ||
  setweight(to_tsvector('english', coalesce(url, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(body, '') || ' ' || email_notes), 'D')
) STORED;
CREATE INDEX blips_search_idx ON blips USING gin (search);

CREATE TABLE blip_emails (
  blip_id uuid PRIMARY KEY REFERENCES blips(id) ON DELETE CASCADE,
  subject text,
  sender_name text,
  sender_address text,
  sent_at timestamptz,
  received_at timestamptz NOT NULL,
  preview text NOT NULL DEFAULT '',
  has_html boolean NOT NULL DEFAULT false,
  legacy boolean NOT NULL DEFAULT false,
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count BETWEEN 0 AND 12),
  payload_key text,
  original_key text
);
ALTER TABLE email_capture_receipts ADD COLUMN email jsonb;

-- Only retained receipts prove email provenance. Do not guess from titles/tags.
-- Original HTML/headers were not retained before this migration.
INSERT INTO blip_emails(blip_id, subject, sender_address, received_at, preview, legacy, attachment_count)
SELECT r.blip_id, b.title, r.sender, r.created_at, left(b.body, 220), true,
  (SELECT count(*) FROM attachments a WHERE a.blip_id = b.id)
FROM email_capture_receipts r JOIN blips b ON b.id = r.blip_id
WHERE r.completed_at IS NOT NULL
ON CONFLICT DO NOTHING;
