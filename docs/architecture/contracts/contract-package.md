# Contract: Contract package (build and import)

Status: Draft · Version 1.0 · Owner (OMR side): M25 Contract package · Owner (other side): M24 API edge; M26 Web UI; the phone suite · Provider ref verified against: `packages/contract/package.json` and `.gitlab-ci.yml` at `2c4905d`

## 1. Scope

What consumers get from `@onmyradar/contract`: its built `dist`, importable as a workspace package.

## 2. Auth

None.

## 3. Operations

| Operation | Shape                                     | Effect        | Notes                                                                            |
| --------- | ----------------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| Build     | `pnpm --filter @onmyradar/contract build` | writes `dist` | Run after every contract edit; CI runs it before typecheck                       |
| Import    | `import … from '@onmyradar/contract'`     | —             | Server and UI depend on it as `workspace:*`; the phone suite as a dev dependency |

## 4. Errors and refusals

- A missing build fails a server or UI test as an import resolution error, not a type error.

## 5. Idempotency, versioning and limits

- Breaking a shape breaks the build of every consumer in the same pipeline; there is no published version.

## 6. Known gaps and unverified facts

- The email-worker package does not depend on it.
