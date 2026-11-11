# ADR-0014: A radar template is a registry entry of capabilities, not a label

Status: Accepted · Date: 2026-08-26

## Context

Kanban, reading list, decision log and the rest differ in lanes, ordering and what they allow. If each were a branch on an id in the services, adding one would touch everything.

## Decision

- `packages/contract/src/templates.ts` holds `RADAR_TEMPLATES`, eight entries. Each declares its lanes, ordering, whether it has an inbox, whether it archives, whether it is themeable or lane-customisable, whether it is client-facing, and, for the Architecture template, its ratified lane, element lanes and permitted lane moves.
- Most behaviour is read from those declarations (for example `ratifiedLane`, `laneMoveAllowed`, `statusesFor`); a few services and SQL CHECKs name `architecture` or `helpdesk` directly. `radars.template` has no SQL constraint; the registry is the vocabulary.
- Custom lanes are 2 to 8 per radar, validated in `contract/src/lanes.ts`, and a lane edit cannot strand a blip.

## Evidence

- `bb602ab` (2026-08-26): "a template earns its place by what it does, not its label".
- `packages/server/src/templates.test.ts`, `packages/server/src/services/lanes.test.ts`, `docs/TEMPLATES.md`.
- No test forbids a new branch on a template id; the discipline is review.

## Consequences

- Good: a new template is mostly a registry entry.
- Cost: the plan-sellable template ids are enumerated twice (`ORDINARY_PLAN_TEMPLATES` and migration 0078), so a sellable template needs both.
