-- Scrub private-feed credentials out of blips already imported.
--
-- Until 30b8d5e every imported feed entry ended with the attribution line
-- "Imported from RSS feed: <the subscription URL>", written verbatim. Private
-- feeds carry their credential in that URL (`?token=` on GitHub and Patreon
-- feeds, a key in a podcast host's query, occasionally `user:pass@`), so the
-- secret sat in every entry's body, readable by every member of the radar and
-- published by a public one. New imports write origin + path only
-- (`feedAttribution` in services/rss.ts); this brings the existing ones to the
-- same format. The owner asked for it on 2026-09-26.
--
-- ## What is touched, and how it is known to be a feed's line
--
-- Only the attribution line, and only where it provably is one:
--
--   * the URL on the line is exactly the `url` of a feed subscription (the old
--     code wrote `feed.url` verbatim, so an exact match is available and is
--     the proof), and that URL carries a query or user info — nothing else has
--     anything to scrub;
--   * the blip's author is that subscription's creator, which is who every
--     import is authored as, whichever radar the blip has since moved to;
--   * the line sits where the importer put it — the whole body, or after a
--     blank line — and is the last thing in the body apart from the optional
--     "Published: <timestamp>" line the importer appends.
--
-- Whatever a person wrote is untouched: the rewrite keeps every character
-- before the line and after it, and a body somebody has since appended to no
-- longer ends with the line, so it is left alone rather than guessed at.
-- `authored` cannot be used to find these rows — it arrived in 0034 and every
-- earlier row defaulted to true.
--
-- Removed subscriptions are still rows at this point (they are purged thirty
-- days after removal, and the feature is a week old), so their entries are
-- scrubbed too.
--
-- ## The copies
--
-- The body is not the only place the line was copied to. A notification's
-- excerpt, a queued e-mail job and an outbound subscription delivery each hold a
-- snapshot of the text; the same URL is replaced in those. The search vector is
-- generated from the body and follows it. Blips have no revision history, so
-- there is nothing else to rewrite. What cannot be recalled is what has already
-- left: e-mails sent and webhook deliveries made before this ran.
--
-- ## The count
--
-- Recorded in `audit_log` as `maintenance.feed_credentials_scrubbed`, per
-- table, so the deploy leaves evidence of what it did. Re-running the logic is
-- a no-op: a scrubbed URL no longer equals any subscription URL with a query.
--
-- Dry run (before deploying):
--   SELECT count(*) FROM blips b JOIN radar_feeds f ON f.created_by = b.author_id
--    WHERE f.url ~ '[?@]' AND position('Imported from RSS feed: ' || f.url IN b.body) > 0;

CREATE TEMP TABLE feed_scrub ON COMMIT DROP AS
SELECT DISTINCT
  created_by,
  'Imported from RSS feed: ' || url AS old_line,
  'Imported from RSS feed: '
    || regexp_replace(regexp_replace(url, '^(https?://)[^/@]*@', '\1'), '[?#].*$', '') AS new_line
FROM radar_feeds
WHERE url ~ '^https?://[^/]*@' OR url ~ '[?]';

-- The importer's trailing "Published:" line, when there is one.
CREATE TEMP TABLE feed_scrub_blips ON COMMIT DROP AS
SELECT b.id, s.old_line, s.new_line,
       COALESCE(substring(b.body FROM E'(\nPublished: [^\n]*)$'), '') AS suffix
FROM blips b
JOIN feed_scrub s ON s.created_by = b.author_id
WHERE position(s.old_line IN b.body) > 0;

WITH rewritten AS (
  UPDATE blips b
  SET body = left(b.body, length(b.body) - length(t.suffix) - length(t.old_line))
             || t.new_line || t.suffix
  FROM feed_scrub_blips t
  WHERE b.id = t.id
    -- The line is the last thing before the optional Published line…
    AND right(left(b.body, length(b.body) - length(t.suffix)), length(t.old_line)) = t.old_line
    -- …and it starts the body or follows a blank line, as the importer wrote it.
    AND (
      length(b.body) - length(t.suffix) = length(t.old_line)
      OR substring(
           b.body
           FROM length(b.body) - length(t.suffix) - length(t.old_line) - 1
           FOR 2
         ) = E'\n\n'
    )
  RETURNING b.id
),
excerpts AS (
  UPDATE notifications n
  SET excerpt = replace(n.excerpt, s.old_line, s.new_line)
  FROM feed_scrub s
  WHERE position(s.old_line IN n.excerpt) > 0
  RETURNING n.id
),
jobs AS (
  UPDATE outbox o
  SET payload = replace(o.payload::text, s.old_line, s.new_line)::jsonb
  FROM feed_scrub s
  WHERE position(s.old_line IN o.payload::text) > 0
  RETURNING o.id
),
deliveries AS (
  UPDATE subscription_deliveries d
  SET payload = replace(d.payload::text, s.old_line, s.new_line)::jsonb
  FROM feed_scrub s
  WHERE position(s.old_line IN d.payload::text) > 0
  RETURNING d.id
)
INSERT INTO audit_log (actor_kind, action, subject_type, meta)
SELECT 'system', 'maintenance.feed_credentials_scrubbed', 'blip',
       jsonb_build_object(
         'blips', (SELECT count(*) FROM rewritten),
         'notifications', (SELECT count(*) FROM excerpts),
         'outbox', (SELECT count(*) FROM jobs),
         'subscriptionDeliveries', (SELECT count(*) FROM deliveries)
       );
