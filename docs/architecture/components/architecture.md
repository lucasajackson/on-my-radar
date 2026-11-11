# Component: M6 Architecture radar

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

The Architecture template: a charter (one versioned document) amended by ADRs through anchors that point at quotes in it, boundaries and contracts as elements with seams between them, and a trace across all three. It is the surface this folder is imported into. Its blips are ordinary rows of `blips` (M5) in the lanes `charter`, `proposed`, `accepted`, `rejected`, `repealed`, `boundary` and `contract`; this component owns the element attributes and the relations between them.

**Depends on:** M4 (template lock and registry), M5 (`createBlip` hooks: `afterInsert`, `requireTemplate`, `ratifiedAt`, `element`; lane guards), M3.

**Used by:** M23 (six tools), the UI (Map, Matrix, Seams, Charter views), `scripts/import-architecture.ts`.

**Invariants (and what enforces each):**

- An Architecture radar is one whose template declares a `ratifiedStatus`; only `architecture` does (`architectureRadar` in `services/architecture.ts`).
- ADR lane moves are `proposed` to `accepted` or `rejected`, and `accepted` to `repealed`; any other move is 409 `lane_move_refused`. The `boundary` and `contract` lanes accept no capture and no manual move (409 `element_lane`) (`transitions` and `elementLanes` in the template; `architecture.test.ts`).
- `blips.ratified_at` is stamped on first entry into `accepted` and never changes; the importer may supply a historical date (`services/blips.ts`, migration 0085).
- The charter is one row of `charter_documents` per radar (migration 0091); `write_charter` replaces it whole against `baseRevision` (409 `stale`) and `edit_charter` applies exact-text edits to the head (409 `charter_conflict`, all or none; one save path in `saveCharter`, `charter-ops.ts` for the verbs), under `charter_documents ... FOR UPDATE`, and seals a full version into `charter_versions` (immutable by trigger; each distinct text stored once per radar in `charter_texts`). Charter-lane blips are closed (410 `charter_is_one_document`). Radars with pages are moved in by `migrateRadar` (lazily, at boot under `MIGRATE_ON_BOOT`, or `scripts/charter-one-document.ts`); it is idempotent, refuses a radar whose pages have comments or whose markers it cannot place, and deletes no page (`services/charter.ts`, `charter.test.ts`).
- An amendment is a row of `charter_anchors` written by `anchorAdr` inside the proposal's transaction under the document lock; a failed anchor rolls back the whole proposal. Limits: quote 400 characters, replacement 600, 10 anchors per ADR, 2,000 anchors per radar (`AMEND_LIMITS`, `CHARTER_LIMITS`).
- Anchors are resolved over a plain-text projection of the markdown (`packages/contract/src/anchor.ts`): on every save an anchor is kept, moved or orphaned, never refused; when in doubt it orphans, and saving the words back heals it. An ADR with an orphaned amendment cannot be accepted (409 `adr_orphaned`, checked under the document lock on every accepting path) or deleted (409 `anchored`) (`assertAdrAcceptable`, `assertUnanchored`).
- A link (`kind='link'` in `charter_anchors`, subject a boundary or contract) is written by `linkCharter` (`services/charter-links.ts`) under the document lock and seals a version (`cause='anchor'`); it may span blocks (4,000 characters), orphans by the same rules as an amendment, and flags its element (`charter` on the element in `read_architecture`). An element with an anchored link cannot be deleted (409 `anchored`); once its links are orphaned it can (`assertUnanchored`).
- Versions are read by `services/charter-versions.ts` and `charter-version-view.ts`: `list_charter_versions`, `diff_charter` (the anchors' word diff, `diffText`) and `read_architecture({version})`, which draws a past version from its own text, anchor positions and ADR lanes. A restore (`write_charter` with `restoreVersion`) is the same save with `cause='restore'`: a new version, history untouched.
- History (`list_charter_versions`, `diff_charter`, `read_architecture({version})`) is members-only: a public-link reader gets 404 (`architectureRadar` with `members: true`). Restore reads its version inside the save's transaction, under the document lock, after `baseRevision` is checked. A version's `agent_id` is cleared when its agent is deleted, and sealing a working text whose agent is gone records no agent. A public-link reader of the current charter gets the state and cause of an orphaned anchor but not its words (`load(…, publicReader)` blanks `quote`, `with`, `excerpt`, `highlight.quote`). A ratified ADR cannot be deleted (or moved once it amended the charter): sealed versions render its replacement text from its anchor rows, so `delete_blip` answers 409 `ratified` and the way out is repeal.
- Element titles are unique per lane and case-insensitive: unique index `blips_element_title_key` on `(radar_id, lane, title_key)`, filled by triggers `blip_elements_fill` and `blip_elements_retitle`; a concurrent duplicate is 409 `title_taken`.
- A contract has exactly two `seam_side` relations (sides `a` and `b`) to different boundaries, at least one internal; `to_blip_id` is NO ACTION so the service answers 409 `boundary_in_use` for a boundary that still has seams, with the foreign key as the backstop. Relation kinds are `seam_side` and `amends` (CHECK `blip_relations_kind_check`).
- A radar leaves the template only if it has no elements, relations or anchors; creating an element or proposing an ADR takes the per-radar settings lock shared so a template change cannot interleave (ADR-0015); updating an existing element, deciding an ADR and the import's marker writes do not.
- The import is a command-line path only (no route, no tool), refuses a radar that already has boundaries or contracts, and runs as the radar's owner (`services/architecture-import.ts`).

## 2. Owned data

| Owned                                                                                                | Kind      | Notes                                          |
| ---------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------- |
| `blip_elements`                                                                                      | table     |                                                |
| `blip_relations`                                                                                     | table     |                                                |
| `packages/server/src/services/architecture.ts`                                                       | file      | Read, propose, decide, upsert elements, trace  |
| `packages/server/src/services/architecture-import.ts`                                                | file      | Folder import                                  |
| `packages/server/scripts/import-architecture.ts`                                                     | file      | Command line for the import                    |
| `packages/server/src/services/charter.ts`                                                            | file      | Charter document, migration, anchors, versions |
| `packages/server/src/services/charter-model.ts`                                                      | file      | Views and migration plan (pure)                |
| `charter_documents`, `charter_texts`, `charter_versions`, `charter_anchors`, `charter_anchor_events` | tables    | Migration 0091                                 |
| `packages/contract/src/anchor.ts`                                                                    | file      | Projection and anchor resolver                 |
| `packages/contract/src/amend.ts`                                                                     | file      | Legacy marker grammar (kept for older clients) |
| `blips.ratified_at`                                                                                  | elsewhere | Column on `blips`, written by this component   |

## 3. Interface

- **Routes:** `GET /api/radars/:id/architecture`, `POST /api/radars/:id/adrs`, `PUT /api/radars/:id/charter`, `POST /api/radars/:id/charter/links`, `GET /api/radars/:id/charter/versions`, `GET /api/radars/:id/charter/diff`, `POST /api/radars/:id/charter/versions/:version/restore`, `POST /api/radars/:id/boundaries`, `POST /api/radars/:id/contracts`, `GET /api/blips/:id/trace`, `POST /api/blips/:id/decide`.
- **MCP tools:** `read_architecture`, `propose_adr`, `decide_adr`, `write_charter`, `link_charter`, `list_charter_versions`, `diff_charter`, `upsert_boundary`, `upsert_contract`, `trace`. A `radars:read` connection can read; propose, decide and upsert need write access.
- **Import:** `DATABASE_URL=… SESSION_SECRET=… pnpm --filter @onmyradar/server exec tsx scripts/import-architecture.ts <dir> <radarId>`.

## 4. Failure and degradation

- A charter over 400,000 characters is refused 422; a proposal whose quote has moved is refused, not applied. A boot-time migration that fails for one radar logs it and leaves that radar to the lazy path (retryable `charter_not_ready`).

## 5. Known gaps and unverified facts

- `upsertBoundary` and `upsertContract` do not take the shared settings lock when updating an existing element; the template lock still holds because the rows already exist.
- `docs/TEMPLATES.md` was not compared line by line with the template.
