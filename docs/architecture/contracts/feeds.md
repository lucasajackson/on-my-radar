# Contract: Feed publishers (RSS and Atom)

Status: Draft · Version 1.0 · Owner (OMR side): M15 RSS feeds · Owner (other side): Feed publishers (any public website serving RSS or Atom) · Provider ref verified against: `services/rss.ts` and `services/rss-parser.ts` at `2c4905d`

## 1. Scope

The worker polls each enabled feed every 15 minutes while it succeeds and turns new items into unauthored blips on the radar.

## 2. Auth

None toward the publisher. The fetch uses `publicRequest`: DNS resolved once and pinned, private ranges refused, up to 3 redirect hops each re-vetted, 20 second deadline, 2 MiB cap, uncompressed only.

## 3. Operations

| Operation | Shape              | Effect  | Notes                                                                      |
| --------- | ------------------ | ------- | -------------------------------------------------------------------------- |
| Fetch     | `GET <feed url>`   | read    | Conditional state kept per feed                                            |
| Capture   | items become blips | creates | Attribution is `Imported from RSS feed: <origin+path>`, never the full URL |

## 4. Errors and refusals

- A feed that fails backs off exponentially from 15 minutes, capped at 24 hours; an unsafe URL is refused when saved and when fetched; XML with a DTD or custom entity is refused.

## 5. Idempotency, versioning and limits

- Dedupe is `feed_items (feed_id, item_hash)`, claimed in the capture transaction. 50 active feeds per account, 10 per radar, 20,000 entries per document.

## 6. Known gaps and unverified facts

- Migration 0036 rewrote earlier attribution lines that had embedded credentials, only where the line was provably the importer's own; blips edited since keep what they hold.
