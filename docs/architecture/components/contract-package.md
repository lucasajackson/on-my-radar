# Component: M25 Contract package

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d

## 1. Responsibility

`@onmyradar/contract`: the one vocabulary every client compiles against. Zod request schemas, DTO types, `LIMITS`, scopes, the template registry (with M4), lane and theme rules, the search lexer, the amendment grammar, notification kinds, billing and plan shapes, agent-repo caps, and the pure text functions for tags, mentions and bylines. It also emits a deterministic snapshot of its registries and behaviour vectors for the iOS client.

**Depends on:** zod 3.25.76 (its only runtime dependency).

**Used by:** M24, every service, M23, M26 (workspace dependencies); the phone suite (dev dependency); M27 (via the snapshot).

**Invariants (and what enforces each):**

- The package imports nothing from this repository (`packages/contract/package.json`).
- Consumers import its built `dist`: CI runs `pnpm --filter @onmyradar/contract build` before `pnpm -r typecheck`, and the Dockerfile builds contract, then server, then UI. A missing build fails as an import error, not a type error.
- `pnpm --filter @onmyradar/contract snapshot` runs `tsc && node dist/snapshot-cli.js`; the output is the registries plus behaviour vectors, sorted and deterministic (`src/snapshot.ts`). `packages/contract/test/snapshot.test.mjs` checks that the snapshot runs; the comparison with the iOS copy is the iOS repository's Swift test.
- The same schemas validate an HTTP body and shape an MCP tool's input.

## 2. Owned data

| Owned                                   | Kind | Notes                                                                              |
| --------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `packages/contract/src/index.ts`        | file | Re-exports about 25 modules                                                        |
| `packages/contract/src/domain.ts`       | file | `LIMITS`, scopes, voices, session clients, `API_V1`, notification kinds, inference |
| `packages/contract/src/schemas.ts`      | file | Zod request schemas                                                                |
| `packages/contract/src/dto.ts`          | file | DTO types                                                                          |
| `packages/contract/src/snapshot.ts`     | file | Snapshot builder                                                                   |
| `packages/contract/src/snapshot-cli.ts` | file | Snapshot command                                                                   |
| `packages/contract/src/own.ts`          | file | Own-property registry lookups (refuses `constructor` and `__proto__` as keys)      |
| `packages/contract/src/prose.ts`        | file | Internal list-to-sentence helper                                                   |
| `packages/contract/src/requests.ts`     | file | Request body types as a client writes them (`z.input`)                             |
| `packages/contract/src/actions.ts`      | file | What a person may do to a blip, declared once for every client                     |
| `packages/contract/src/triage.ts`       | file | What "move it along" and "put it off" mean per template                            |
| `packages/contract/src/map.ts`          | file | The architecture map's deterministic layout, shared by web and native              |
| `packages/contract/src/archive.ts`      | file | Archive window constants                                                           |
| `packages/contract/src/email.ts`        | file | Email DTOs                                                                         |
| `packages/contract/src/feeds.ts`        | file | Feed DTOs                                                                          |
| `packages/contract/package.json`        | file | Package manifest                                                                   |

## 3. Interface

- **Commands:** `pnpm --filter @onmyradar/contract build`, `… snapshot`, `node --test test/*.test.mjs` (5 files).
- Template, lane and theme modules are owned by M4; agent-repo modules by M21 and M22; helpdesk, support and subscription modules by M18, M19 and M16.

## 4. Failure and degradation

- A consumer on a stale build sees old behaviour until rebuilt.

## 5. Known gaps and unverified facts

- `docs/UI-CONTRACT.md` calls `triage.ts` and `actions.ts` the first two modules of a shared UI contract; the rest of that document is described there as designed, not built.
