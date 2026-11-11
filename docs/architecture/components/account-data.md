# Component: M20 Account data

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

A person's right to take their data and the permanent closure fence. The export streams a self-service archive; the fence is a set of database functions and triggers that every auth, access, mail and write path consults. The closure request flow that would insert into the fence tables was removed, so the fence is enforced but nothing in the application closes an account.

**Depends on:** M3, M1, M12 (signed URLs for files), every table (the export classifies each).

**Used by:** M1, M2, M3, M10, M16 (they consult `omr_account_open`).

**Invariants (and what enforces each):**

- The export is human-only: the owner is the session user, and `accountExportOwnerId` throws unless the actor is a `user` with a session and no agent or connection (`services/account-export-policy.ts`).
- The export fails closed on any unclassified table or column: the collector reads every public column from `pg_attribute` and `assertAccountExportSchema` throws if a table has no policy, a policy has no table, or a column is in neither `include` nor `exclude`; `account-export-collector.test.ts` checks the same from the other side (`db/migrate.test.ts` checks migrations against `schema.ts`, not the export policy).
- The export reads in a `REPEATABLE READ READ ONLY` transaction, holds `pg_try_advisory_xact_lock('account-export:<id>')` (a second request is 409 `export_in_progress`), rechecks the live session on every page, and ends with a `complete` record carrying hashes. Limits: 200,000 rows, 64 GiB, 30 minutes.
- File bytes do not pass the pod: the export hands out signed URLs after ownership or read-access checks (`requireAccountExportObject`).
- `omr_account_open(uuid)` is true when no closure row exists; `omr_closure_writer_guard` is attached to about 50 tables as `account_closure_writer`; `omr_closure_request_guard` makes closure rows insert-only (migration 0057).

## 2. Owned data

| Owned                                                      | Kind  | Notes                                                                |
| ---------------------------------------------------------- | ----- | -------------------------------------------------------------------- |
| `account_closure_requests`                                 | table |                                                                      |
| `account_closure_challenges`                               | table |                                                                      |
| `account_lifecycle_fences`                                 | table |                                                                      |
| `packages/server/src/services/account-lifecycle.ts`        | file  | `accountOpen`, `assertAccountOpen`, `emailOpen`, `withOpenRecipient` |
| `packages/server/src/services/account-export.ts`           | file  | Export stream                                                        |
| `packages/server/src/services/account-export-collector.ts` | file  | Collector and schema assertion                                       |
| `packages/server/src/services/account-export-tables.ts`    | file  | Per-table classification                                             |
| `packages/server/src/services/account-export-schema.ts`    | file  | Schema assertion rules                                               |
| `packages/server/src/services/account-export-policy.ts`    | file  | Owner and policy rules                                               |
| `packages/server/src/services/account-export-archive.ts`   | file  | Archive records                                                      |
| `packages/server/src/services/account-export-layout.ts`    | file  | Readable ZIP layout                                                  |
| `packages/server/src/routes/account-export.ts`             | file  | Mounted at `/api/account`                                            |

## 3. Interface

- **Routes:** `GET /api/account/export` (NDJSON, `Cache-Control: private, no-store`), `POST /api/account/export/object`. No MCP tool.
- **Configuration:** limits are constants in `ACCOUNT_EXPORT_LIMITS`; `S3_BUCKET` for the storage lookup.

## 4. Failure and degradation

- A partial migration fails closed: some column classifications are conditional on the schema generation.

## 5. Known gaps and unverified facts

- No application code inserts into `account_closure_requests` or `account_closure_challenges`; there is no closure route, UI or tool (ADR-0019). The `phase` CHECK allows only `access_closed`, and no erasure phase exists.
- `docs/DESIGN.md` notes the closure read-barrier for attachment image reads is not present.
- Whether any operator script inserts a closure was not found in `scripts/`.
