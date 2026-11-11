# ADR-0016: ADRs amend charter pages with anchored markers in the page source, anchored by occurrence

Status: Accepted · Date: 2026-10-29

## Context

An Architecture radar has to show a charter as amended by the decisions in force, and must refuse an amendment whose target text has moved.

## Decision

- A proposal carries anchors (quote, replacement). On proposal the server writes `:amend[quote]{adr=<uuid> with="replacement"}` markers into the charter page bodies in one transaction, locking pages in id order.
- A reader sends the page, the occurrence index and how many matches they saw; if the count differs the proposal is refused as `quote_moved`. Without those, more than one match is `quote_ambiguous`.
- A body with markers cannot be hand-edited to add, alter or remove one (409 `marker_locked`). A second ADR on the same span stacks only if the live layer is the ADR it supersedes.
- Marker text inside code fences or spans is not a marker. A page that would exceed 100,000 characters is refused.
- ADRs are blips in the lanes `proposed`, `accepted`, `rejected` and `repealed`; `ratified_at` is stamped on first acceptance.

## Evidence

- `c065fdc` (2026-10-28, merged to `main` `a0400ac` on 2026-10-29) shipped markers and `ratified_at`; `45aec40` (2026-10-29, merged `2c4905d`) anchored by occurrence and seen count.
- `packages/contract/src/amend.ts`, `packages/server/src/services/architecture.ts`, `packages/server/src/services/architecture-amend.test.ts`, `packages/server/src/services/architecture.test.ts`.

## Consequences

- Good: the history of why a sentence changed travels with the sentence.
- Cost: concurrent proposals contend on the pages they anchor; `architecture.test.ts` covers concurrent proposals keeping both markers.
