# Component: M15 RSS feeds

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

Subscribed RSS and Atom feeds polled into radars. The worker, never the API, fetches; each new item becomes an unauthored blip with a credential-free attribution line.

**Depends on:** M5 (`createBlip`), M3, M11 (backlog check), M24 (`publicRequest`).

**Used by:** M23 (four tools), the UI.

**Invariants (and what enforces each):**

- Every fetch goes through the shared SSRF transport, re-vetting each of up to 3 redirect hops; a 20 second deadline, 2 MiB cap and uncompressed responses only (`services/rss.ts`; `rss.test.ts`).
- The parser is `saxes` strict XML with no DTD or custom entities, nesting at most 48 and 20,000 entries; content is converted to plain text and images are skipped (`services/rss-parser.ts`).
- The dedupe claim and the blip insert share one transaction (`feed_items (feed_id, item_hash)`); the capture rechecks that the feed is still enabled at the same `revision`, and the user and radar state under share locks (`rss.test.ts`).
- The attribution line is origin plus path only; migration 0036 scrubbed credentials from earlier attributions in blips, notifications, queued mail and subscription deliveries (`db/scrub-feed-credentials.test.ts`).
- Limits: 50 active feeds per account, 10 per radar, 100 retained; removed feeds are kept 30 days. Polling is every 15 minutes, one feed per worker iteration, and pauses when 1000 or more outbox jobs are due.
- Feeds are not plan-gated.

## 2. Owned data

| Owned                                        | Kind  | Notes                              |
| -------------------------------------------- | ----- | ---------------------------------- |
| `radar_feeds`                                | table |                                    |
| `feed_items`                                 | table |                                    |
| `packages/server/src/services/rss.ts`        | file  | Polling, capture, limits           |
| `packages/server/src/services/rss-parser.ts` | file  | Feed parser                        |
| `packages/server/src/routes/rss.ts`          | file  | Mounted at `/api/radars/:id/feeds` |

## 3. Interface

- **Routes:** `GET|POST /api/radars/:id/feeds`, `PATCH|DELETE /api/radars/:id/feeds/:feedId`.
- **MCP tools:** `list_feeds`, `set_feed`, `delete_feed`.

## 4. Failure and degradation

- A feed that fails stays and is retried on its schedule; an unsafe URL is refused at save and at fetch.

## 5. Known gaps and unverified facts

- None beyond those listed in the contract `contracts/feeds.md`.
