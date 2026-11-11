# ADR-0003: Authorization is one function; a radar you cannot read is a 404; credentials clamp, they never widen

Status: Accepted · Date: 2026-08-26

## Context

Radar access has several sources (owner, direct member, a topic cascade, a public link) and several kinds of caller (a person, an agent with a ceiling, an integration). Spread across routes, the rules would disagree.

## Decision

- `services/access.ts` is the only door to a radar: `getRadarAccess`, `requireRadar`, `requireParticipation`, `readableRadarIds`.
- A caller who may not read a radar gets a 404, never a 403, because a 403 confirms the id exists. The single deliberate exception is the member list for a caller who already holds a working public link.
- Effective role is the union of the person's grants (owner, direct member, cascading topic role), then one `min` against the credential's ceiling at the tail. A cascade confers viewer or editor, never owner.
- A public link grants read only when it is the identifier used, and never on a client-facing radar.

## Evidence

- `0ca3520` (2026-08-26) introduced `access.ts`; `26ce1ce` (2026-08-27) made token scopes enforced as the ceiling rather than merely recorded; topics and the cascade landed in `c15f257` (2026-08-26).
- `services/scopes.test.ts`, `services/topic-visibility.test.ts`, `services/agent-boundary.test.ts`, `services/co-owners.test.ts`.

## Consequences

- Good: one place to audit; search, dashboards and mentions inherit it by calling `readableRadarIds`.
- Cost: every new feature must route its reads through `access.ts`; there is no row-level security in the database to catch a missed check.
