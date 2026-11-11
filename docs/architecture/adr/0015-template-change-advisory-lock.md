# ADR-0015: Changing a radar's template serialises with writes to it through a per-radar advisory lock

Status: Accepted · Date: 2026-09-26

## Context

Moving a radar off the Architecture template while a boundary or ADR is being written would strand elements in lanes the new template does not know.

## Decision

- `updateRadar` takes `pg_advisory_xact_lock(hashtextextended('radar-settings:<id>', 0))` exclusively (after the plan-quota lock), then the radar row `FOR UPDATE` unless the call is only moving the radar between topics, before it checks the template lock and the plan.
- Writes to an Architecture radar that must not race a template change (`upsert_*`, `propose_adr`, the import) take the same key shared in `createBlip` when `requireTemplate` is set. The import's element creation takes it; its page, ADR and marker writes, and updates to existing elements, do not.
- A radar leaves the `architecture` template only if it has no elements, no relations and no amendment markers (409 `template_locked` otherwise).
- Ordinary blip capture serialises with lane edits through `FOR KEY SHARE` on the radar row versus `FOR UPDATE` in the lane edit.

## Evidence

- The exclusive side landed in `cb846a2` (2026-09-26, merged `05e4194`); the shared side for architecture writes in `f201ba0` and `ae8adf1` (2026-10-29, merged `2c4905d`).
- `packages/server/src/services/radars.ts` (`updateRadar`), `packages/server/src/services/blips.ts` (`createBlip`), `packages/server/src/services/architecture.test.ts` (a race of a mid-flight boundary insert against a template switch).

## Consequences

- Good: a template change and a content write cannot both succeed against stale assumptions.
- Cost: `upsertBoundary` and `upsertContract` do not take the shared lock when they update an existing element (the existing rows keep the template lock true).
