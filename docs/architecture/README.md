# On My Radar architecture

Status: Draft · Version 0.1 · As built at `origin/main` 2c4905d (2026-10-29)

This folder describes On My Radar **as it is built**, not as it should be. Every statement was read from the code, the migrations or the repo history; the file, constraint or test that enforces it is named next to it. Where a document and the code disagree, the code is what this folder follows and the disagreement is listed under the component's known gaps.

It is imported into an Architecture radar on onmyradar.io (the template's own dogfood) with `packages/server/scripts/import-architecture.ts`, so that changes to OMR's architecture are tracked as ADRs on that radar. The folder is shaped for that importer, in the same way as Commander's `docs/architecture`.

## Layout

| Path                   | Holds                                                                                   | Changes by           |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------- |
| `01-principles.md`     | The rules the code enforces, each with the thing that enforces it                       | An ADR first         |
| `02-system-context.md` | Actors, external systems, trust boundaries, the system of record for each fact          | PR + review          |
| `03-components.md`     | The 27 boundaries, the dependency rules and the layers                                  | PR + review          |
| `04-domain-model.md`   | Entities and the state machines, with who may cause each transition                     | PR + review          |
| `adr/NNNN-*.md`        | One decision each, already taken, dated from when it reached `main`                     | A new ADR supersedes |
| `components/*.md`      | One file per boundary: what it owns (tables, modules, routes) and what it must never do | PR + review          |
| `contracts/*.md`       | One file per seam between two boundaries, or between a boundary and an external system  | Versioned            |

## Rules for editing (the importer and the test depend on these)

1. File names under `components/` and `contracts/` are lower-case letters and hyphens only. A digit in the name makes the importer skip the file without an error.
2. The H1 is the first line of every file. Components: `# Component: M<n> <name>`. Contracts: `# Contract: <name> (<detail>)`. ADRs: `# ADR-NNNN: <title>`. Charter pages: `# 0n · <title>`.
3. A component's `## 2. Owned data` table lists one owned thing per row; the first backticked cell is the item and the second cell is its kind (`table`, `file` or `elsewhere`). Only sections 1 and 2 reach the radar; keep the invariants that matter in section 1.
4. A contract's `Status:` line is one physical line and names `Owner (OMR side): M<n> …` and `Owner (other side): …`. An external system has no `M<n>` on its side and takes its name from the contract's title up to the first `(`, so every contract with the same system uses the same prefix.
5. An ADR's `Status:` line is `Status: Accepted · Date: YYYY-MM-DD`, where the date is the day the decision reached `main`. Amendments are recorded with `Amends:` only when an ADR really changes a component or contract file.
6. Charter pages and components carry no `@handle` and at most 24 `#hashtags`; write identifiers in backticks.
7. A new table should get an owner here. `packages/server/src/services/architecture-docs.test.ts` does not require one; it fails if a component claims a table that does not exist or is claimed twice, a file that does not exist, or a contract side that has no component.

`packages/server/src/services/architecture-docs.test.ts` parses this folder with the importer's own parsers, so it cannot drift into a shape the importer refuses.
