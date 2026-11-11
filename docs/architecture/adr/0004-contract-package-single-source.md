# ADR-0004: The contract package is the single source of truth for the API vocabulary

Status: Accepted · Date: 2026-08-26

## Context

The web app, the MCP tools, the phone test suite and the iOS app all need to agree on what a valid blip, scope, limit or template is.

## Decision

- `packages/contract` (`@onmyradar/contract`) holds the zod request schemas, the DTO types, `LIMITS`, scopes, the template registry, the lane rules, the search grammar and the pure text functions (tags, mentions, bylines). Its only runtime dependency is `zod`.
- The server and the UI depend on it as a workspace package and import its built `dist`; CI builds it before typechecking.
- The same schemas validate an HTTP body and shape an MCP tool's input.
- For the iOS app, which cannot import TypeScript, `snapshot.ts` emits the registries and behaviour vectors as deterministic JSON that the iOS repository vendors and tests against.

## Evidence

- `0ca3520` (2026-08-26) created the package. `9d66e68` (2026-09-03) added the snapshot for the Swift mirror.
- `.gitlab-ci.yml` runs `pnpm --filter @onmyradar/contract build` before `pnpm -r typecheck`; the Dockerfile builds contract, then server, then UI.
- `packages/contract/test/snapshot.test.mjs` checks that the snapshot runs; it does not compare against the iOS copy. That comparison lives in the iOS repository's Swift tests.

## Consequences

- Good: "what counts as valid" is defined once, and a client cannot compile against a stale shape without the build failing.
- Cost: a contract edit needs a rebuild before server or UI tests resolve it; a missing build shows up as an import error, not a type error.
