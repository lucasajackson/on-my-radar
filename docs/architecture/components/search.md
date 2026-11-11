# Component: M8 Search

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

One search across every radar the caller can read, with a grammar of twelve fields shared by the browser and the server. It owns the query resolver and the ranking; it owns no table. Dashboards reuse its resolver.

**Depends on:** M3 (`readableRadarIds`, `readersOfRadars`), M5 (`listBlips` filters, the generated column).

**Used by:** M9 (query widgets), M23 (`search_blips`), the UI header search.

**Invariants (and what enforces each):**

- The result set is a subset of `readableRadarIds(actor)`; every filter narrows and none widens. An `in:` or `from:` that cannot be resolved returns an empty page with `unresolved: true`, never an unfiltered one; a readable radar and a non-existent one give the same message (`services/search.ts`; `search.test.ts` for the `unresolved` and identical-message cases, `search-scope.test.ts` for `radarId` scope).
- `from:` resolves only against people who share a radar with the caller.
- Full text is the generated tsvector `blips.search`, weighted title A, tags B, URL C, body and `email_notes` D, GIN-indexed (`blips_search_idx`); comments, attachment names and an email's HTML, JSON payload and original file are not indexed. An email's plain text becomes the blip body and its subject the title, so both are searchable.
- Ranking is `ts_rank_cd` with weights 0.1, 0.3, 0.6, 1.0 when there are words and recency when there are not; the score is carried in the cursor as text to keep the keyset lossless.
- Limits: query 500 characters, filter value 160, 32 tokens per field, cursor 1024 (`LIMITS`). An unknown prefix is a word (`https://x` is not a filter); a known field with an invalid value is reported as a problem.

## 2. Owned data

| Owned                                    | Kind      | Notes                                                       |
| ---------------------------------------- | --------- | ----------------------------------------------------------- |
| `packages/server/src/services/search.ts` | file      | Resolver, execution, suggestions                            |
| `packages/contract/src/search.ts`        | file      | The lexer and field list shared with the browser            |
| `packages/server/src/routes/search.ts`   | file      | Mounted at `/api/search`                                    |
| `blips.search`                           | elsewhere | Generated tsvector column on `blips`, owned with that table |

## 3. Interface

- **Routes:** `GET /api/search`, `GET /api/search/suggest`.
- **MCP tools:** `search_blips` (`preferRadarId` ranks one radar first without restricting).
- **Fields:** in, topic, from, tag, is, has, kind, template, before, after, touched, stale. `status:` is deliberately not in the grammar.

## 4. Failure and degradation

- Search is read-only and has no dependency outside Postgres.

## 5. Known gaps and unverified facts

- `from:` equality against a real database is tested in `services/search.test.ts` (skipped when no database is configured).
- Whether search is plan-gated beyond the MCP admission check was not established.
