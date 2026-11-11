CREATE TABLE radar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radar_id uuid NOT NULL REFERENCES radars(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) <= 2048),
  title text,
  lookback text NOT NULL CHECK (lookback IN ('forever','year','month','week','day')),
  import_after timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 0,
  removed_at timestamptz,
  etag text,
  last_modified text,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  last_polled_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  failures integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(radar_id,url)
);
CREATE INDEX radar_feeds_due_idx ON radar_feeds(next_poll_at) WHERE enabled;
CREATE INDEX radar_feeds_creator_idx ON radar_feeds(created_by);
-- Compact tombstones survive blip deletion, so a deleted article never reappears.
-- No feed body, title, URL, or second copy of the blip is retained here.
CREATE TABLE feed_items (
  feed_id uuid NOT NULL REFERENCES radar_feeds(id) ON DELETE CASCADE,
  item_hash varchar(64) NOT NULL,
  PRIMARY KEY(feed_id,item_hash)
);
