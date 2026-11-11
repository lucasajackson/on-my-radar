# ADR-0001: PostgreSQL is the only store, and its schema is forward-only checksummed SQL

Status: Accepted · Date: 2026-08-26

## Context

On My Radar needed uniqueness, single use, coalescing, rate limits and a job queue that stay correct under concurrent API pods, without introducing a broker or a second datastore.

## Decision

- PostgreSQL is the only relational store and the system of record for metadata; attachment bytes and stored email originals live in S3-compatible object storage, so a restore needs both. The schema is hand-written SQL in `packages/server/drizzle/NNNN_*.sql`; Drizzle (`packages/server/src/db/schema.ts`) mirrors it for typed queries and never generates DDL.
- The migrator applies files in order, records a checksum in `schema_migrations`, and refuses to start if an applied file was edited or a new file is numbered below one already applied. Two migrators booting together serialise rather than race.
- Invariants that must hold under concurrency are expressed in the database: unique and partial unique indexes, CHECK constraints, triggers and single atomic statements (principle P7).
- `ALL_TABLE_NAMES` in `schema.ts` lists every table; a test fails when a migration creates a table that is not listed or the list names a table no migration creates.

## Evidence

- First commit `0ca3520` (2026-08-26) carried `0001_init.sql`, `schema.ts` and the migrator. `5678d34` (2026-08-26) fixed the two-migrators race.
- `packages/server/src/db/migrate.ts` (the numbering and checksum refusals), `packages/server/src/db/migrate.test.ts` (both directions of the `ALL_TABLE_NAMES` check).
- Numbering has gaps (0007, 0009, 0012, 0059 to 0077 and 0079 to 0084 are absent on `main`) because the migrator requires only increasing order, not contiguity.

## Consequences

- Good: the arbiter of every race is one system, and a new invariant is a migration plus a test.
- Cost: a wrong migration cannot be edited, only followed by a corrective one. `schema.ts` can drift from the SQL; the table-list test catches tables, not columns.
